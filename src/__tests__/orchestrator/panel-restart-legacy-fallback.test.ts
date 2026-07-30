// #425 / panel #253/#266: panel_restart_comfyui must not dead-end when the
// built-in Manager exposes NO reboot endpoint (legacy Manager 3.x: the v2 route
// 405s, the legacy route 404s). For a LOCAL, process-controllable target it now
// falls back to the headless managed restart (kill + relaunch). A busy-guard or
// security refusal must NOT trigger that fallback (it would abort a running
// render / defeat Manager security), and a REMOTE target has no local process to
// restart — both return the refusal verbatim.

import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  remoteMode: { value: false },
  restart: vi.fn(async () => ({ stopped: true, started: true, ready: true, message: "restarted" })),
}));

// isRemoteMode() gates the fallback; keep the rest of config real.
vi.mock("../../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config.js")>();
  return { ...actual, isRemoteMode: () => hoisted.remoteMode.value };
});

// The headless managed restart is the fallback mechanism — stub it so no real
// process/port is touched, and so we can assert whether it was invoked.
vi.mock("../../services/process-control.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/process-control.js")>();
  return { ...actual, restartComfyUI: hoisted.restart };
});

import {
  buildPanelToolDefs,
  rebootNoEndpoint,
  __panelToolsTestHooks,
  type PanelToolCtx,
  type ToolResult,
} from "../../orchestrator/panel-tools.js";

const NO_ENDPOINT_TEXT =
  "Could not reach any ComfyUI-Manager reboot endpoint — ComfyUI was NOT restarted " +
  "(is the built-in Manager enabled?). Tried: POST /v2/manager/reboot → HTTP 405; " +
  "GET /manager/reboot → HTTP 404";

function nonError(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

/** ctx whose comfy_reboot reply is caller-supplied; nodes_queue_status probes
 *  (readiness) always succeed so recovery resolves ready quickly. */
function makeCtx(rebootReply: ToolResult): { ctx: PanelToolCtx; calls: string[] } {
  const calls: string[] = [];
  const ctx = {
    call: async (cmd: { cmd: string }) => {
      calls.push(cmd.cmd);
      if (cmd.cmd === "comfy_reboot") return rebootReply;
      return { content: [{ type: "text", text: "{}" }] }; // nodes_queue_status ok
    },
    confirm: async () => true,
    bridge: {} as unknown,
    tabId: "t",
  } as unknown as PanelToolCtx;
  return { ctx, calls };
}

function restartTool() {
  const def = buildPanelToolDefs().find((d) => d.name === "panel_restart_comfyui");
  if (!def) throw new Error("panel_restart_comfyui not found");
  return def;
}

beforeEach(() => {
  hoisted.remoteMode.value = false;
  hoisted.restart.mockClear();
  hoisted.restart.mockResolvedValue({ stopped: true, started: true, ready: true, message: "restarted" });
  __panelToolsTestHooks.setPanelRebootTiming({
    settleMs: 0,
    budgetMs: 50,
    intervalMs: 1,
    probeTimeoutMs: 5,
  });
});

describe("rebootNoEndpoint classifier", () => {
  it("matches a genuine no-endpoint refusal", () => {
    expect(rebootNoEndpoint(nonError(NO_ENDPOINT_TEXT))).toBe(true);
  });
  it("does NOT match a busy-guard refusal", () => {
    expect(
      rebootNoEndpoint(nonError("Refused: a generation is in progress; restart aborted.")),
    ).toBe(false);
  });
  it("does NOT match a Manager-security refusal", () => {
    expect(
      rebootNoEndpoint(nonError("Reboot refused (HTTP 403) — Manager security forbids it.")),
    ).toBe(false);
  });
  it("does NOT match an error ToolResult (in-flight drop)", () => {
    expect(rebootNoEndpoint({ isError: true, content: [{ type: "text", text: NO_ENDPOINT_TEXT }] })).toBe(false);
  });
});

describe("panel_restart_comfyui — legacy no-endpoint fallback", () => {
  it("LOCAL + no-endpoint → falls back to the headless managed restart and reports success", async () => {
    const { ctx } = makeCtx(nonError(NO_ENDPOINT_TEXT));
    const res = (await restartTool().handler({}, ctx)) as ToolResult;
    expect(hoisted.restart).toHaveBeenCalledTimes(1);
    const text = res.content.find((c) => c.type === "text")?.text ?? "";
    expect(text).toMatch(/headless-managed-restart|managed restart/i);
    expect(res.isError).toBeFalsy();
  });

  it("LOCAL + no-endpoint but the managed restart can't start → actionable error", async () => {
    hoisted.restart.mockResolvedValue({ stopped: false, started: false, message: "no process found" });
    const { ctx } = makeCtx(nonError(NO_ENDPOINT_TEXT));
    const res = (await restartTool().handler({}, ctx)) as ToolResult;
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/no reboot endpoint|no process found/i);
  });

  it("REMOTE + no-endpoint → does NOT kill+relaunch; returns the refusal verbatim", async () => {
    hoisted.remoteMode.value = true;
    const { ctx } = makeCtx(nonError(NO_ENDPOINT_TEXT));
    const res = (await restartTool().handler({}, ctx)) as ToolResult;
    expect(hoisted.restart).not.toHaveBeenCalled();
    expect(res.content[0].text).toContain("was NOT restarted");
  });

  it("busy-guard refusal → NEVER falls back (does not abort a running render)", async () => {
    const { ctx } = makeCtx(nonError("Refused: a generation is in progress."));
    const res = (await restartTool().handler({}, ctx)) as ToolResult;
    expect(hoisted.restart).not.toHaveBeenCalled();
    expect(res.content[0].text).toContain("in progress");
  });
});
