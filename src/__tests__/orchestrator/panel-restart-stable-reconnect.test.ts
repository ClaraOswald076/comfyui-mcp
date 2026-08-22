// #2067 — after panel_restart_comfyui returned ready:true / graph_tools_ready:true /
// panel_tab_reconnected:true, the next panel_get_errors failed with Connected: none.
//
// The restart readiness path accepted the first newer original-tab hello immediately.
// A ComfyUI restart can hello and drop that socket a moment later, so the first
// generation bump is not durable graph-tool readiness. awaitPostRestartReachable now
// requires that identity to remain present for a stability window (same check after
// conservative rebind).
//
// These tests drive the shipped function via makePanelToolCtx, and the restart
// handler that reports graph_tools_ready from it.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const resetClient = vi.fn();
const resetObjectInfoCache = vi.fn();
vi.mock("../../comfyui/client.js", () => ({
  getObjectInfo: vi.fn(),
  backfillObjectInfo: vi.fn(),
  resetClient: () => resetClient(),
  resetObjectInfoCache: () => resetObjectInfoCache(),
}));

const { buildPanelToolDefs, makePanelToolCtx, __panelToolsTestHooks } = await import(
  "../../orchestrator/panel-tools.js"
);
import { getBootLocalComfyUIBaseUrl } from "../../config.js";
import { WorkflowTargetStore } from "../../services/workflow-target-store.js";
import type { PanelToolCtx, ToolResult } from "../../orchestrator/panel-tools.js";

const BOOT_BASE = (getBootLocalComfyUIBaseUrl() ?? "http://127.0.0.1:8188").replace(/\/+$/, "");
const TAB = "bound-tab";
const SESSION = "browser-tab-a";

const parse = (res: ToolResult): Record<string, unknown> =>
  JSON.parse(res.content.find((c) => c.type === "text")!.text as string);

function restartHandler() {
  const def = buildPanelToolDefs().find((d) => d.name === "panel_restart_comfyui");
  if (!def) throw new Error("panel_restart_comfyui not found");
  return def.handler;
}

/** Mutable original-tab identity the test can flap mid-wait. */
function originalTabState() {
  const live = new Set<string>([TAB]);
  const ident = { generation: 1, tabSessionId: SESSION };
  const bridge = {
    send: async (cmd: Record<string, unknown>) => {
      if (cmd.cmd === "comfy_reboot") return { rebooting: true };
      const id = TAB;
      if (!live.has(id)) throw new Error(`no connected tab with id "${id}". Connected: none`);
      return { ok: true };
    },
    push: () => 1,
    canReach: (id: string) => live.has(id),
    tabs: () => [...live].map((t) => ({ tab_id: t, title: t, connected_at: 0 })),
    resolveActiveTabId: () => {
      if (live.size === 1) return [...live][0]!;
      if (live.size === 0) throw new Error("Panel not reachable: no panel connected");
      throw new Error("Multiple panel tabs are connected and none is last active — pass tab_id.");
    },
    tabOrigin: () => BOOT_BASE,
    tabServerOrigin: () => BOOT_BASE,
    tabIsLocal: () => true,
    tabConnectionIdentity: (id: string) => (live.has(id) ? { ...ident } : undefined),
    tabCanMutateGraph: () => true,
  } as unknown as PanelToolCtx["bridge"];
  return { live, ident, bridge };
}

beforeEach(() => {
  resetClient.mockClear();
  resetObjectInfoCache.mockClear();
  __panelToolsTestHooks.setLocalRestartPreflight(async () => ({ ok: true }));
  __panelToolsTestHooks.setReconnectWaitTiming({ budgetMs: 250, intervalMs: 10, stableMs: 80 });
  __panelToolsTestHooks.setPanelRebootTiming({
    settleMs: 0,
    budgetMs: 80,
    intervalMs: 5,
    probeTimeoutMs: 10,
  });
});

afterEach(() => {
  __panelToolsTestHooks.setReconnectWaitTiming(null);
  __panelToolsTestHooks.setPanelRebootTiming(null);
  __panelToolsTestHooks.setHealthProbe(null);
  __panelToolsTestHooks.setLocalRestartPreflight(null);
});

describe("#2067 awaitPostRestartReachable requires a stable original-tab hello", () => {
  it("returns false when the first fresh hello drops before the stability window", async () => {
    const { live, ident, bridge } = originalTabState();
    const ctx = makePanelToolCtx(bridge, TAB, new WorkflowTargetStore());
    const before = ctx.panelConnectionIdentity!();
    ident.generation = 2;
    setTimeout(() => live.delete(TAB), 20);

    await expect(ctx.awaitPostRestartReachable!(before)).resolves.toBe(false);
  });

  it("returns true when the same fresh hello stays through the window", async () => {
    const { ident, bridge } = originalTabState();
    const ctx = makePanelToolCtx(bridge, TAB, new WorkflowTargetStore());
    const before = ctx.panelConnectionIdentity!();
    ident.generation = 2;

    await expect(ctx.awaitPostRestartReachable!(before)).resolves.toBe(true);
  });
});

describe("#2067 panel_restart_comfyui does not report graph tools ready on a flap", () => {
  it("the reporter: first fresh hello then drop ⇒ graph_tools_ready:false", async () => {
    const seq: Array<"down" | "healthy"> = ["down", "healthy"];
    let i = 0;
    __panelToolsTestHooks.setHealthProbe(async () => seq[Math.min(i++, seq.length - 1)]!);

    const { live, ident, bridge } = originalTabState();
    const origSend = bridge.send;
    bridge.send = async (cmd: Record<string, unknown>, opts?: { tabId?: string }) => {
      if (cmd.cmd === "comfy_reboot") {
        live.delete(TAB);
        setTimeout(() => {
          ident.generation = 2;
          live.add(TAB);
          setTimeout(() => live.delete(TAB), 20);
        }, 30);
        return { rebooting: true };
      }
      return origSend!(cmd, opts);
    };
    const ctx = makePanelToolCtx(bridge, TAB, new WorkflowTargetStore());
    ctx.confirm = async () => "yes" as const;

    const out = parse(await restartHandler()({ force: false }, ctx));
    expect(out.server_ready).toBe(true);
    expect(out.panel_tab_reconnected).toBe(false);
    expect(out.graph_tools_ready).toBe(false);
    expect(out.ready).toBe(false);
  });

  it("a hello that stays is graph_tools_ready:true", async () => {
    const seq: Array<"down" | "healthy"> = ["down", "healthy"];
    let i = 0;
    __panelToolsTestHooks.setHealthProbe(async () => seq[Math.min(i++, seq.length - 1)]!);

    const { live, ident, bridge } = originalTabState();
    const origSend = bridge.send;
    bridge.send = async (cmd: Record<string, unknown>, opts?: { tabId?: string }) => {
      if (cmd.cmd === "comfy_reboot") {
        live.delete(TAB);
        setTimeout(() => {
          ident.generation = 2;
          live.add(TAB);
        }, 30);
        return { rebooting: true };
      }
      return origSend!(cmd, opts);
    };
    const ctx = makePanelToolCtx(bridge, TAB, new WorkflowTargetStore());
    ctx.confirm = async () => "yes" as const;

    const out = parse(await restartHandler()({ force: false }, ctx));
    expect(out.server_ready).toBe(true);
    expect(out.panel_tab_reconnected).toBe(true);
    expect(out.graph_tools_ready).toBe(true);
    expect(out.ready).toBe(true);
  });

  it("the same window applies after conservative rebind onto a new routing tab id", async () => {
    const seq: Array<"down" | "healthy"> = ["down", "healthy"];
    let i = 0;
    __panelToolsTestHooks.setHealthProbe(async () => seq[Math.min(i++, seq.length - 1)]!);

    const live = new Set<string>([TAB]);
    const bridge = {
      send: async (cmd: Record<string, unknown>) => {
        if (cmd.cmd === "comfy_reboot") {
          live.delete(TAB);
          setTimeout(() => {
            live.add("reconnected-tab");
            setTimeout(() => live.delete("reconnected-tab"), 20);
          }, 30);
          return { rebooting: true };
        }
        return { ok: true };
      },
      push: () => 1,
      canReach: (id: string) => live.has(id),
      tabs: () => [...live].map((t) => ({ tab_id: t, title: t, connected_at: 0 })),
      resolveActiveTabId: () => {
        if (live.size === 1) return [...live][0]!;
        if (live.size === 0) throw new Error("Panel not reachable: no panel connected");
        throw new Error("Multiple panel tabs are connected and none is last active — pass tab_id.");
      },
      tabOrigin: () => BOOT_BASE,
      tabServerOrigin: () => BOOT_BASE,
      tabIsLocal: () => true,
      tabConnectionIdentity: (id: string) =>
        live.has(id)
          ? { generation: id === "reconnected-tab" ? 2 : 1, tabSessionId: SESSION }
          : undefined,
      tabCanMutateGraph: () => true,
    } as unknown as PanelToolCtx["bridge"];
    const ctx = makePanelToolCtx(bridge, TAB, new WorkflowTargetStore());
    ctx.confirm = async () => "yes" as const;

    const out = parse(await restartHandler()({ force: false }, ctx));
    expect(out.server_ready).toBe(true);
    expect(out.panel_tab_reconnected).toBe(false);
    expect(out.graph_tools_ready).toBe(false);
    expect(out.ready).toBe(false);
  });
});
