// panel#1262: with COMFYUI_RESTART_COMMAND set (an externally-managed install —
// a local container, a systemd unit, a launcher — whose bare `main.py` argv can
// never anchor from here), panel_restart_comfyui used to REFUSE at the
// refuse-safe preflight and leave a wedged server with no recovery. Now the
// restart runs through the configured command (headless restartComfyUI honors
// it) instead of the tab's Manager reboot — which a wedged server could never
// answer anyway.
//
// The busy guard the server-side reboot would have enforced is re-implemented
// against a VERIFIED queue read: a busy queue refuses without force:true, and
// an UNREADABLE queue (the wedge itself) refuses without force too — "cannot
// check" is not "idle".

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  remoteMode: { value: false },
  restart: vi.fn(async () => ({ stopped: true, started: true, ready: true, message: "restarted" })),
  getQueueVerified: vi.fn(async () => ({ queue_running: [], queue_pending: [] })),
}));

// isRemoteMode() gates the configured-command branch; keep the rest of config real
// (config.comfyuiRestartCommand is set directly on the real object in beforeEach).
vi.mock("../../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config.js")>();
  return { ...actual, isRemoteMode: () => hoisted.remoteMode.value };
});

// The headless managed restart is the mechanism the configured command runs
// through — stub it so no real process/port is touched, and so we can assert
// whether it was invoked.
vi.mock("../../services/process-control.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/process-control.js")>();
  return { ...actual, restartComfyUI: hoisted.restart };
});

// The busy guard's queue read — driven per test (idle / busy / unreadable).
vi.mock("../../comfyui/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../comfyui/client.js")>();
  return { ...actual, getQueueVerified: hoisted.getQueueVerified };
});

// #1263 live-probe gate: nothing here may open a REAL WebSocket. The branch
// under test stubs restartComfyUI itself, so the witness is never reached —
// pin that by stubbing the acquisition outright.
vi.mock("../../services/instance-witness.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../services/instance-witness.js")>()),
  acquireInstanceWitness: async () => undefined,
}));

import {
  buildPanelToolDefs,
  __panelToolsTestHooks,
  type PanelToolCtx,
  type ToolResult,
} from "../../orchestrator/panel-tools.js";
import { config, getBootLocalComfyUIBaseUrl } from "../../config.js";

// The headless restart takes our OWN boot instance DOWN then UP, so the
// boot-endpoint DOWN→UP observation confirms the cycle. Point the tab at the
// boot origin.
const BOOT_BASE = (getBootLocalComfyUIBaseUrl() ?? "http://127.0.0.1:8188").replace(/\/+$/, "");

/** ctx whose comfy_reboot dispatch (bridge.send) records the call — the
 *  configured-command branch must NEVER reach it. */
function makeCtx(frontsBoot = true): { ctx: PanelToolCtx; calls: string[] } {
  const calls: string[] = [];
  const ctx = {
    call: async () => {
      throw new Error("ctx.call must not be used for reboot dispatch");
    },
    confirm: async () => "yes" as const,
    ensureReachable: () => {},
    bridge: {
      send: async (cmd: { cmd: string }) => {
        calls.push(cmd.cmd);
        return { rebooting: true };
      },
      tabOrigin: () => (frontsBoot ? BOOT_BASE : "http://127.0.0.1:9191"),
      tabServerOrigin: () => (frontsBoot ? BOOT_BASE : "http://127.0.0.1:9191"),
      tabIsLocal: () => frontsBoot,
    } as unknown as PanelToolCtx["bridge"],
    tabId: "t",
    panelConnectionIdentity: () => ({ generation: 1, tabSessionId: "browser-tab-a" }),
    awaitPostRestartReachable: async () => true,
    tabCanMutateGraph: () => true,
  } as unknown as PanelToolCtx;
  return { ctx, calls };
}

function restartTool() {
  const def = buildPanelToolDefs().find((d) => d.name === "panel_restart_comfyui");
  if (!def) throw new Error("panel_restart_comfyui not found");
  return def;
}

function out(res: ToolResult): Record<string, unknown> {
  return JSON.parse(res.content.find((c) => c.type === "text")!.text as string);
}

beforeEach(() => {
  hoisted.remoteMode.value = false;
  hoisted.restart.mockClear();
  hoisted.restart.mockResolvedValue({ stopped: true, started: true, ready: true, message: "restarted" });
  hoisted.getQueueVerified.mockReset();
  hoisted.getQueueVerified.mockResolvedValue({ queue_running: [], queue_pending: [] });
  config.comfyuiRestartCommand = "docker restart comfyui";
  // The issue's exact shape: the #742 refuse-safe preflight FAILS (a bare
  // `main.py` that anchors nowhere from here). The configured-command branch
  // must run BEFORE this refusal.
  __panelToolsTestHooks.setLocalRestartPreflight(async () => ({
    ok: false,
    reason: "Resolved ComfyUI script does not exist on disk: main.py",
  }));
  __panelToolsTestHooks.setPanelRebootTiming({
    settleMs: 0,
    budgetMs: 50,
    intervalMs: 1,
    probeTimeoutMs: 5,
  });
  // OUR independent boot-endpoint observation: a real cycle (down then healthy).
  const seq: Array<"healthy" | "down"> = ["down", "down", "healthy"];
  let i = 0;
  __panelToolsTestHooks.setHealthProbe(async () => seq[Math.min(i++, seq.length - 1)]);
});

afterEach(() => {
  config.comfyuiRestartCommand = undefined;
  __panelToolsTestHooks.setPanelRebootTiming(null);
  __panelToolsTestHooks.setHealthProbe(null);
  __panelToolsTestHooks.setLocalRestartPreflight(null);
});

describe("panel_restart_comfyui with COMFYUI_RESTART_COMMAND set (panel#1262)", () => {
  it("the issue's wedge: preflight FAILS (bare main.py) yet the restart runs through the configured command — the tab reboot is never dispatched", async () => {
    const { ctx, calls } = makeCtx();
    const res = (await restartTool().handler({}, ctx)) as ToolResult;
    expect(hoisted.restart).toHaveBeenCalledTimes(1);
    expect(calls).not.toContain("comfy_reboot");
    const o = out(res);
    expect(o.ready).toBe(true);
    expect(o.confirmed_cycle).toBe(true);
    expect(String(o.note)).toMatch(/COMFYUI_RESTART_COMMAND/);
    expect(res.isError).toBeFalsy();
  });

  it("BUSY GUARD: a verified busy queue refuses without force — nothing was stopped", async () => {
    hoisted.getQueueVerified.mockResolvedValue({
      queue_running: [{}],
      queue_pending: [],
    } as never);
    const { ctx, calls } = makeCtx();
    const res = (await restartTool().handler({}, ctx)) as ToolResult;
    expect(hoisted.restart).not.toHaveBeenCalled();
    expect(calls).not.toContain("comfy_reboot");
    const o = out(res);
    expect(o.refused).toBe(true);
    expect(String(o.note)).toMatch(/in progress or queued/);
    expect(String(o.note)).toMatch(/force:true/);
  });

  it("an UNREADABLE queue (the wedge itself) refuses without force — cannot-check is not idle", async () => {
    hoisted.getQueueVerified.mockRejectedValue(new Error("fetch failed"));
    const { ctx, calls } = makeCtx();
    const res = (await restartTool().handler({}, ctx)) as ToolResult;
    expect(hoisted.restart).not.toHaveBeenCalled();
    expect(calls).not.toContain("comfy_reboot");
    const o = out(res);
    expect(o.refused).toBe(true);
    expect(String(o.note)).toMatch(/could not be read/);
    expect(String(o.note)).toMatch(/force:true/);
  });

  it("force:true restarts even when the queue cannot be read — the documented wedge escape", async () => {
    hoisted.getQueueVerified.mockRejectedValue(new Error("fetch failed"));
    const { ctx, calls } = makeCtx();
    const res = (await restartTool().handler({ force: true }, ctx)) as ToolResult;
    expect(hoisted.restart).toHaveBeenCalledTimes(1);
    expect(calls).not.toContain("comfy_reboot");
    const o = out(res);
    expect(o.ready).toBe(true);
  });

  it("unbound tab (cannot prove it fronts the configured target) → the normal refusal, command NOT run", async () => {
    const { ctx, calls } = makeCtx(/* frontsBoot */ false);
    const res = (await restartTool().handler({}, ctx)) as ToolResult;
    expect(hoisted.restart).not.toHaveBeenCalled();
    expect(calls).not.toContain("comfy_reboot");
    expect(res.content[0].text).toMatch(/cannot tell which server the restart would stop/i);
  });

  it("REMOTE mode: the configured command is ignored and the tab reboot goes out as before", async () => {
    hoisted.remoteMode.value = true;
    const { ctx, calls } = makeCtx();
    await restartTool().handler({}, ctx);
    expect(hoisted.restart).not.toHaveBeenCalled();
    expect(calls).toContain("comfy_reboot");
  });
});
