// panel_restart_comfyui must NOT report a false timeout/failure on the EXPECTED
// connection drop of a rebooting server. After the reboot fires (a confirmed
// `rebooting:true` ack OR a mid-command "OUTCOME UNKNOWN"/disconnect drop), the
// tool polls readiness (nodes_queue_status round-trips that auto-heal onto the
// reconnected tab) and reports SUCCESS once ComfyUI is reachable again, with how
// long recovery took. It reports a clear FAILURE only when the server genuinely
// never comes back within the bounded budget.
//   #493 (comfyui-mcp) + #222/#263/#266/#306/#307 (comfyui-mcp-panel).

import { beforeEach, describe, expect, it, vi } from "vitest";

const resetClient = vi.fn();
const resetObjectInfoCache = vi.fn();
vi.mock("../../comfyui/client.js", () => ({
  getObjectInfo: vi.fn(),
  backfillObjectInfo: vi.fn(),
  resetClient: () => resetClient(),
  resetObjectInfoCache: () => resetObjectInfoCache(),
}));

const { buildPanelToolDefs, __panelToolsTestHooks } = await import(
  "../../orchestrator/panel-tools.js"
);
import type { PanelToolCtx, ToolResult } from "../../orchestrator/panel-tools.js";

const rr = (obj: unknown): ToolResult =>
  ({ content: [{ type: "text", text: JSON.stringify(obj) }] }) as ToolResult;
const errRes = (text: string): ToolResult =>
  ({ content: [{ type: "text", text }], isError: true }) as ToolResult;

/** A ctx whose `call` returns the reboot reply for cmd:comfy_reboot, and a
 *  scripted sequence of readiness replies for each subsequent nodes_queue_status. */
function ctxScripted(reboot: ToolResult, readiness: ToolResult[]): {
  ctx: PanelToolCtx;
  calls: Array<Record<string, unknown>>;
} {
  const calls: Array<Record<string, unknown>> = [];
  let probe = 0;
  const ctx = {
    call: async (cmd: Record<string, unknown>) => {
      calls.push(cmd);
      if (cmd.cmd === "comfy_reboot") return reboot;
      // nodes_queue_status readiness probe
      const reply = readiness[Math.min(probe, readiness.length - 1)];
      probe++;
      return reply;
    },
    confirm: async () => true,
    bridge: {} as PanelToolCtx["bridge"],
    tabId: "test-tab",
  } as PanelToolCtx;
  return { ctx, calls };
}

function rebootHandler() {
  const def = buildPanelToolDefs().find((d) => d.name === "panel_restart_comfyui");
  if (!def) throw new Error("panel_restart_comfyui not found");
  return def.handler;
}

const parse = (res: ToolResult): Record<string, unknown> =>
  JSON.parse(res.content.find((c) => c.type === "text")!.text as string);

beforeEach(() => {
  resetClient.mockClear();
  resetObjectInfoCache.mockClear();
  // Fast deterministic timing so the poll doesn't wait the real ~120s budget.
  __panelToolsTestHooks.setPanelRebootTiming({
    settleMs: 0,
    budgetMs: 200,
    intervalMs: 5,
    probeTimeoutMs: 50,
  });
});

describe("panel_restart_comfyui readiness poll", () => {
  it("confirmed reboot, health recovers after a delay → SUCCESS with recovery timing", async () => {
    const { ctx, calls } = ctxScripted(rr({ rebooting: true }), [
      errRes("panel tab is not open"),
      errRes("did not reply within 5000 ms"),
      rr({ queue_running: 0, queue_pending: 0 }), // back up
    ]);

    const res = await rebootHandler()({ force: false }, ctx);

    expect(res.isError).toBeFalsy();
    const out = parse(res);
    expect(out.rebooting).toBe(true);
    expect(out.ready).toBe(true);
    expect(out.probes).toBe(3);
    expect(typeof out.recovered_ms).toBe("number");
    // Caches were dropped on the confirmed reboot.
    expect(resetClient).toHaveBeenCalledTimes(1);
    expect(resetObjectInfoCache).toHaveBeenCalledTimes(1);
    // It polled readiness with nodes_queue_status, not a second reboot.
    expect(calls.filter((c) => c.cmd === "nodes_queue_status").length).toBe(3);
  });

  it("EXPECTED connection drop (OUTCOME UNKNOWN) is treated as reboot-fired, not a failure", async () => {
    const { ctx } = ctxScripted(
      errRes(
        'panel tab abc disconnected mid-command ("comfy_reboot") — OUTCOME UNKNOWN: the command was already sent',
      ),
      [rr({ queue_running: 0 })],
    );

    const res = await rebootHandler()({ force: false }, ctx);

    expect(res.isError).toBeFalsy();
    const out = parse(res);
    expect(out.ready).toBe(true);
    expect(String(out.note)).toContain("dropped as expected");
    expect(resetClient).toHaveBeenCalledTimes(1);
  });

  it("reboot fires but health NEVER recovers within the bound → clear FAILURE", async () => {
    const { ctx } = ctxScripted(rr({ rebooting: true }), [
      errRes("panel tab is not open"),
    ]);

    const res = await rebootHandler()({ force: false }, ctx);

    expect(res.isError).toBe(true);
    const text = res.content.find((c) => c.type === "text")!.text as string;
    expect(text).toContain("did not come back within");
  });

  it("a PRE-DISPATCH error (tab already closed, no reboot sent) is returned verbatim — no false success", async () => {
    // "is not open" is emitted BEFORE the reboot is written to a socket, so no
    // reboot occurred. It must NOT be treated as an expected drop (which would
    // then poll readiness and falsely claim a restart once any tab reconnects).
    const { ctx, calls } = ctxScripted(errRes("Panel tab abc12345 is not open"), [
      rr({ queue_running: 0 }),
    ]);

    const res = await rebootHandler()({ force: false }, ctx);

    expect(res.isError).toBe(true);
    expect(calls.some((c) => c.cmd === "nodes_queue_status")).toBe(false);
    expect(resetClient).not.toHaveBeenCalled();
    expect(resetObjectInfoCache).not.toHaveBeenCalled();
  });

  it("a REFUSAL (busy guard, rebooting:false) is returned verbatim — no poll, no cache reset", async () => {
    const { ctx, calls } = ctxScripted(
      rr({ rebooting: false, blocked_busy: true, queue_running: 1 }),
      [rr({ queue_running: 0 })],
    );

    const res = await rebootHandler()({ force: false }, ctx);

    const out = parse(res);
    expect(out.rebooting).toBe(false);
    expect(out.blocked_busy).toBe(true);
    // Never polled readiness, never reset caches.
    expect(calls.some((c) => c.cmd === "nodes_queue_status")).toBe(false);
    expect(resetClient).not.toHaveBeenCalled();
  });
});
