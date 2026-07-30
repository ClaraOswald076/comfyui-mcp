// Coverage for the WS-3 panel_restart_comfyui cache invalidation (codex finding
// #2): the shared ComfyUI client + object_info cache must be dropped ONLY on a
// CONFIRMED reboot (`rebooting:true`). A busy-guard / forbidden / no-endpoint
// refusal comes back as a normal ToolResult with `rebooting:false` — resetting
// then would close the shared client mid-generation.

import { beforeEach, describe, expect, it, vi } from "vitest";

const resetClient = vi.fn();
const resetObjectInfoCache = vi.fn();
vi.mock("../../comfyui/client.js", () => ({
  getObjectInfo: vi.fn(),
  backfillObjectInfo: vi.fn(),
  resetClient: () => resetClient(),
  resetObjectInfoCache: () => resetObjectInfoCache(),
}));

const { buildPanelToolDefs, rebootConfirmed } = await import(
  "../../orchestrator/panel-tools.js"
);
import type { PanelToolCtx } from "../../orchestrator/panel-tools.js";
import type { ToolResult } from "../../orchestrator/panel-tools.js";

function ctxReplying(reply: unknown): PanelToolCtx {
  return {
    call: async () => ({
      content: [{ type: "text", text: JSON.stringify(reply) }],
    }),
    confirm: async () => true,
    bridge: {} as PanelToolCtx["bridge"],
    tabId: "test-tab",
  } as PanelToolCtx;
}

function rebootHandler() {
  const def = buildPanelToolDefs().find((d) => d.name === "panel_restart_comfyui");
  if (!def) throw new Error("panel_restart_comfyui not found");
  return def.handler;
}

const rr = (obj: unknown): ToolResult =>
  ({ content: [{ type: "text", text: JSON.stringify(obj) }] }) as ToolResult;

describe("rebootConfirmed", () => {
  it("is true only for a parsed rebooting:true", () => {
    expect(rebootConfirmed(rr({ rebooting: true, endpoint: "/v2/manager/reboot" }))).toBe(true);
  });
  it("is false for an explicit refusal (busy guard)", () => {
    expect(rebootConfirmed(rr({ rebooting: false, blocked_busy: true }))).toBe(false);
  });
  it("is false when the field is absent, on isError, and on unparseable text", () => {
    expect(rebootConfirmed(rr({ ok: 1 }))).toBe(false);
    expect(
      rebootConfirmed({ content: [{ type: "text", text: "not json" }] } as ToolResult),
    ).toBe(false);
    expect(
      rebootConfirmed({ content: [{ type: "text", text: '{"rebooting":true}' }], isError: true } as ToolResult),
    ).toBe(false);
  });
});

describe("panel_restart_comfyui cache invalidation", () => {
  beforeEach(() => {
    resetClient.mockClear();
    resetObjectInfoCache.mockClear();
  });

  it("invalidates the client + object_info caches on a CONFIRMED reboot", async () => {
    await rebootHandler()({ force: false }, ctxReplying({ rebooting: true }));
    expect(resetClient).toHaveBeenCalledTimes(1);
    expect(resetObjectInfoCache).toHaveBeenCalledTimes(1);
  });

  it("does NOT touch the caches when the panel REFUSES (busy/forbidden/no-endpoint)", async () => {
    await rebootHandler()(
      { force: false },
      ctxReplying({ rebooting: false, blocked_busy: true, queue_running: 1 }),
    );
    expect(resetClient).not.toHaveBeenCalled();
    expect(resetObjectInfoCache).not.toHaveBeenCalled();
  });
});
