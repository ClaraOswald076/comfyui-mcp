// #742: panel_restart_comfyui must NEVER report "Cancelled — ComfyUI was not
// restarted" while the server is actually DOWN (a stop already happened — e.g. a
// reboot accepted moments earlier in the same turn stopped ComfyUI, the panel tab
// died with it, and the confirm card then failed into a catch-all "no"). And on a
// Pinokio-style install (externally supervised; no main.py/interpreter resolvable
// from here, so NO provable relaunch) the restart must be REFUSED before anything
// is stopped — a plain Manager restart kills the process and the supervisor does
// not re-launch it, which is exactly the #742 lost-server.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
import { getBootLocalComfyUIBaseUrl } from "../../config.js";
import type { PanelToolCtx, ToolResult } from "../../orchestrator/panel-tools.js";

// The orchestrator's immutable boot endpoint — what the decline-probe and the
// refuse-safe preflight bind to when the tab provably fronts our boot instance.
const BOOT_BASE = (getBootLocalComfyUIBaseUrl() ?? "http://127.0.0.1:8188").replace(/\/+$/, "");

const text = (res: ToolResult): string =>
  res.content.find((c) => c.type === "text")!.text as string;
const parse = (res: ToolResult): Record<string, unknown> => JSON.parse(text(res));

function makeCtx(opts: {
  confirm: "yes" | "no";
  /** Whether the bound tab provably fronts our local boot instance (the gate
   *  for both the boot-endpoint probe and the #742 preflight). */
  frontsBoot?: boolean;
}): { ctx: PanelToolCtx; sends: Array<Record<string, unknown>> } {
  const sends: Array<Record<string, unknown>> = [];
  const frontsBoot = opts.frontsBoot ?? true;
  const bridge = {
    send: async (cmd: Record<string, unknown>) => {
      sends.push(cmd);
      if (cmd.cmd === "comfy_reboot") return { rebooting: true };
      return {};
    },
    tabOrigin: () => (frontsBoot ? BOOT_BASE : undefined),
    // The gate reads the SERVER-OBSERVED handshake origin, not the spoofable hello URL.
    tabServerOrigin: () => (frontsBoot ? BOOT_BASE : undefined),
    tabIsLocal: () => frontsBoot,
    canReach: () => true,
  } as unknown as PanelToolCtx["bridge"];
  const ctx = {
    call: async () => {
      throw new Error("ctx.call must not be used by the restart handler");
    },
    confirm: async () => opts.confirm,
    ensureReachable: () => {},
    bridge,
    tabId: "bound-tab",
    panelConnectionIdentity: () => ({ generation: 1, tabSessionId: "browser-tab-a" }),
    awaitPostRestartReachable: async () => true,
    tabCanMutateGraph: () => true,
  } as unknown as PanelToolCtx;
  return { ctx, sends };
}

function restartTool() {
  const def = buildPanelToolDefs().find((d) => d.name === "panel_restart_comfyui");
  if (!def) throw new Error("panel_restart_comfyui not found");
  return def;
}

beforeEach(() => {
  resetClient.mockClear();
  resetObjectInfoCache.mockClear();
  __panelToolsTestHooks.setPanelRebootTiming({
    settleMs: 0,
    budgetMs: 60,
    intervalMs: 5,
    probeTimeoutMs: 10,
  });
  // Default: the local relaunch preflight PASSES (the live preflightLocalRestart
  // would probe real processes/ports). The refusal tests override it.
  __panelToolsTestHooks.setLocalRestartPreflight(async () => ({ ok: true }));
});

afterEach(() => {
  __panelToolsTestHooks.setPanelRebootTiming(null);
  __panelToolsTestHooks.setHealthProbe(null);
  __panelToolsTestHooks.setLocalRestartPreflight(null);
});

describe("panel_restart_comfyui — decline truthfulness (#742)", () => {
  it("a decline while the server is PROVEN DOWN reports the lost server — never 'Cancelled'", async () => {
    // The confirm resolved "no" (a decline, OR the card failed into the catch-all
    // "no" because the tab died with the server). The endpoint probe PROVES the
    // server is down (ECONNREFUSED): the old "Cancelled — ComfyUI was not
    // restarted." would be a lie — a stop already happened.
    __panelToolsTestHooks.setHealthProbe(async () => "down");
    const { ctx, sends } = makeCtx({ confirm: "no" });

    const res = await restartTool().handler({}, ctx);
    const t = text(res);

    expect(res.isError).toBeFalsy();
    expect(t).not.toMatch(/^Cancelled/);
    expect(t).not.toMatch(/was not restarted/i);
    expect(t).toMatch(/ComfyUI is DOWN/i);
    expect(t).toMatch(/STOPPED and did not come back/i);
    expect(t).toMatch(/start ComfyUI manually/i);
    expect(t).toMatch(/Pinokio/i);
    // Nothing was dispatched after the decline — the report is about PRIOR state.
    expect(sends.some((c) => c.cmd === "comfy_reboot")).toBe(false);
  });

  it("a decline with a HEALTHY server keeps the plain cancel line", async () => {
    __panelToolsTestHooks.setHealthProbe(async () => "healthy");
    const { ctx, sends } = makeCtx({ confirm: "no" });

    const res = await restartTool().handler({}, ctx);

    expect(text(res)).toBe("Cancelled — ComfyUI was not restarted.");
    expect(sends.some((c) => c.cmd === "comfy_reboot")).toBe(false);
  });

  it("a decline with an UNVERIFIABLE server keeps the plain cancel line (never alarmist)", async () => {
    // "unknown" (a transient 5xx / timeout / ambiguous error) is NOT a proven
    // down — only ECONNREFUSED flips the report.
    __panelToolsTestHooks.setHealthProbe(async () => "unknown");
    const { ctx, sends } = makeCtx({ confirm: "no" });

    const res = await restartTool().handler({}, ctx);

    expect(text(res)).toBe("Cancelled — ComfyUI was not restarted.");
    expect(sends.some((c) => c.cmd === "comfy_reboot")).toBe(false);
  });
});

describe("panel_restart_comfyui — Pinokio-style refuse-safe preflight (#742)", () => {
  it("REFUSES before any stop when the relaunch is not provable (Pinokio-shaped install)", async () => {
    // The running local ComfyUI is externally supervised and its main.py /
    // interpreter cannot be resolved from here — a Manager restart would kill it
    // and NOTHING would bring it back (the #742 report).
    __panelToolsTestHooks.setLocalRestartPreflight(async () => ({
      ok: false,
      reason:
        "Resolved ComfyUI script does not exist on disk: main.py — could not " +
        "locate the ComfyUI install.",
    }));
    const { ctx, sends } = makeCtx({ confirm: "yes" });

    const res = await restartTool().handler({}, ctx);
    const out = parse(res);

    expect(res.isError).toBeFalsy();
    expect(out.rebooting).toBe(false);
    expect(out.refused).toBe(true);
    expect(String(out.note)).toMatch(/refusing to restart/i);
    expect(String(out.note)).toMatch(/still running/i);
    expect(String(out.note)).toMatch(/Pinokio/i);
    // CRITICAL: the reboot was NEVER dispatched — no stop can have happened.
    expect(sends.some((c) => c.cmd === "comfy_reboot")).toBe(false);
    // And the reboot caches were not dropped (no restart is in flight).
    expect(resetClient).not.toHaveBeenCalled();
    expect(resetObjectInfoCache).not.toHaveBeenCalled();
  });

  it("does NOT consult the preflight when the tab doesn't provably front our boot instance", async () => {
    // The preflight guards OUR local boot instance only. A reboot bound for a
    // different/remote instance proceeds exactly as before (dispatched +
    // accepted, honestly unconfirmable from here).
    const preflight = vi.fn(async () => ({ ok: false, reason: "would refuse" }));
    __panelToolsTestHooks.setLocalRestartPreflight(preflight);
    const { ctx, sends } = makeCtx({ confirm: "yes", frontsBoot: false });

    const out = parse(await restartTool().handler({}, ctx));

    expect(out.rebooting).toBe(true);
    expect(preflight).not.toHaveBeenCalled();
    expect(sends.some((c) => c.cmd === "comfy_reboot")).toBe(true);
  });

  it("a normal local restart still proceeds when the preflight passes", async () => {
    const seq: Array<"down" | "healthy"> = ["down", "healthy"];
    let i = 0;
    __panelToolsTestHooks.setHealthProbe(async () => seq[Math.min(i++, seq.length - 1)]);
    const { ctx, sends } = makeCtx({ confirm: "yes" });

    const out = parse(await restartTool().handler({}, ctx));

    expect(out.rebooting).toBe(true);
    expect(out.ready).toBe(true);
    expect(out.confirmed_cycle).toBe(true);
    expect(sends.some((c) => c.cmd === "comfy_reboot")).toBe(true);
  });
});
