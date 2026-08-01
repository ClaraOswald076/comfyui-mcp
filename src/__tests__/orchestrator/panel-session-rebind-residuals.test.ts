// Residuals of the panel session/tab-binding cluster left after PR #587
// (tab-id migration + stable resume). These cover the "Connected: none" window a
// full ComfyUI restart / soft-reload opens, in which the browser's own socket has
// not re-hello'd yet — the defining condition of:
//   - mcp-panel #400: graph tools "no connected tab … Connected: none" right after
//     a restart-completion event (the single ~400ms retry always loses the race);
//   - mcp-panel #402: panel_open_workflow / panel_save_workflow fire into a dead
//     binding and return OUTCOME UNKNOWN / "Failed to fetch";
//   - mcp #474: panel_set_workflow_target({mode:"current"}) — the documented
//     recovery signal — hard-fails when zero tabs are connected instead of clearing
//     the stale binding and following the tab once one reconnects.
// The shared fix is a bounded pre-send `ctx.awaitReachable()` that waits out that
// window and rebinds a current-mode session onto the reconnected tab.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const resetClient = vi.fn();
const resetObjectInfoCache = vi.fn();
vi.mock("../../comfyui/client.js", () => ({
  getObjectInfo: vi.fn(),
  backfillObjectInfo: vi.fn(),
  resetClient: () => resetClient(),
  resetObjectInfoCache: () => resetObjectInfoCache(),
}));

const { buildPanelToolDefs, makePanelToolCtx, __panelToolsTestHooks, __openWorkflowTestHooks } =
  await import("../../orchestrator/panel-tools.js");
import { getBootLocalComfyUIBaseUrl } from "../../config.js";
import { WorkflowTargetStore } from "../../services/workflow-target-store.js";
import type { PanelToolCtx, ToolResult } from "../../orchestrator/panel-tools.js";

const BOOT_BASE = (getBootLocalComfyUIBaseUrl() ?? "http://127.0.0.1:8188").replace(/\/+$/, "");
const defByName = (name: string) => {
  const def = buildPanelToolDefs().find((d) => d.name === name);
  if (!def) throw new Error(`${name} not found`);
  return def;
};
const parse = (res: ToolResult): Record<string, unknown> =>
  JSON.parse(res.content.find((c) => c.type === "text")!.text as string);
const textOf = (res: ToolResult): string => (res.content[0] as { text: string }).text;

/**
 * A bridge modelling the ONE fact that matters here: which tab ids are live, as a
 * MUTABLE set the test can flip mid-flight (a tab reconnecting after a restart).
 * `tabs()` + `canReach` + `resolveActiveTabId` mirror the real UiBridge helpers, so
 * `awaitReachable`/`ensureReachable` behave exactly as in production.
 */
function reconnectingBridge(initial: string[] = []) {
  const live = new Set(initial);
  const headless = new Set<string>(); // tab ids that are canvas-less viewers
  const sent: Array<{ cmd: Record<string, unknown>; tabId?: string }> = [];
  const bridge = {
    send: async (cmd: Record<string, unknown>, opts?: { tabId?: string }) => {
      const id = opts?.tabId;
      if (id && !live.has(id)) throw new Error(`no connected tab with id "${id}". Connected: none`);
      sent.push({ cmd, tabId: id });
      // workflow_list answers the open-verify probe with `active` = the routed tab.
      if (cmd.cmd === "workflow_list") {
        return { workflows: [...live].map((t) => ({ key: t, active: true })), active: { key: id } };
      }
      return { ok: true, routedTo: id };
    },
    push: () => 1,
    canReach: (id: string) => live.has(id),
    isHeadless: (id: string) => headless.has(id),
    tabs: () => [...live].map((t) => ({ tab_id: t, title: t, connected_at: 0 })),
    resolveActiveTabId: () => {
      if (live.size === 1) return [...live][0];
      if (live.size === 0) throw new Error("Panel not reachable: no panel connected");
      throw new Error("Multiple panel tabs are connected and none is last active — pass tab_id.");
    },
  } as unknown as PanelToolCtx["bridge"];
  return { bridge, live, headless, sent };
}

beforeEach(() => {
  // Keep the reconnect wait fast so tests don't sit through the real ~20s budget.
  __panelToolsTestHooks.setReconnectWaitTiming({ budgetMs: 500, intervalMs: 5 });
});
afterEach(() => {
  __panelToolsTestHooks.setReconnectWaitTiming(null);
  __panelToolsTestHooks.setRetrySettleMs(null);
  __openWorkflowTestHooks.setOpenVerifyTiming(null);
  resetClient.mockClear();
  resetObjectInfoCache.mockClear();
});

describe("awaitReachable primitive (#400/#402)", () => {
  it("returns immediately (no wait) for a HEALTHY session", async () => {
    const { bridge } = reconnectingBridge(["live-tab"]);
    const ctx = makePanelToolCtx(bridge, "live-tab", new WorkflowTargetStore());
    const t0 = Date.now();
    await expect(ctx.awaitReachable!()).resolves.toBe(true);
    expect(Date.now() - t0).toBeLessThan(200);
  });

  it("WAITS out the 0-tab window, then rebinds onto the reconnected tab", async () => {
    const { bridge, live } = reconnectingBridge([]); // Connected: none
    const ctx = makePanelToolCtx(bridge, "stale-tmp-tab", new WorkflowTargetStore());
    setTimeout(() => live.add("reconnected-tab"), 40); // the browser re-hellos
    const ok = await ctx.awaitReachable!();
    expect(ok).toBe(true);
    expect(ctx.tabId).toBe("reconnected-tab"); // rebound onto the live tab
  });

  it("gives up (false) if nothing reconnects within budget — never hangs", async () => {
    const { bridge } = reconnectingBridge([]);
    const ctx = makePanelToolCtx(bridge, "stale-tmp-tab", new WorkflowTargetStore());
    const ok = await ctx.awaitReachable!(60);
    expect(ok).toBe(false);
    expect(ctx.tabId).toBe("stale-tmp-tab"); // never guessed a tab
  });

  it("does NOT rebind onto an AMBIGUOUS multi-tab reconnect (strict-single)", async () => {
    const { bridge, live } = reconnectingBridge([]);
    const ctx = makePanelToolCtx(bridge, "stale-tmp-tab", new WorkflowTargetStore());
    setTimeout(() => {
      live.add("a-tab");
      live.add("b-tab");
    }, 20);
    const ok = await ctx.awaitReachable!();
    expect(ok).toBe(false); // refuses to guess among 2 tabs
    expect(ctx.tabId).toBe("stale-tmp-tab");
  });

  it("returns FAST (does not spin the budget) when interactive tabs exist but can't bind — stale multi-tab", async () => {
    __panelToolsTestHooks.setReconnectWaitTiming({ budgetMs: 5000, intervalMs: 50 });
    const { bridge } = reconnectingBridge(["a-tab", "b-tab"]); // 2 interactive, none is ours
    const ctx = makePanelToolCtx(bridge, "stale-tmp-tab", new WorkflowTargetStore());
    const t0 = Date.now();
    const ok = await ctx.awaitReachable!();
    expect(ok).toBe(false);
    expect(Date.now() - t0).toBeLessThan(1000); // did NOT wait the 5s budget
  });

  it("returns FAST for a stale PINNED session with a sole reconnected canvas (no stall)", async () => {
    __panelToolsTestHooks.setReconnectWaitTiming({ budgetMs: 5000, intervalMs: 50 });
    const { bridge } = reconnectingBridge(["desktop-canvas"]);
    const store = new WorkflowTargetStore();
    store.set("stale-pinned-tab", { mode: "pinned", path: "workflows/p.json" });
    const ctx = makePanelToolCtx(bridge, "stale-pinned-tab", store);
    const t0 = Date.now();
    const ok = await ctx.awaitReachable!();
    expect(ok).toBe(false); // pinned stays strict — not silently rebound
    expect(Date.now() - t0).toBeLessThan(1000); // and does not stall the budget
  });

  it("does NOT bind onto a lone HEADLESS (canvas-less) reconnect — returns false", async () => {
    const { bridge, live, headless } = reconnectingBridge([]);
    const ctx = makePanelToolCtx(bridge, "stale-tmp-tab", new WorkflowTargetStore());
    // Only a mobile mirror / remote viewer reconnects — it has no canvas.
    setTimeout(() => {
      live.add("headless-viewer");
      headless.add("headless-viewer");
    }, 30);
    const ok = await ctx.awaitReachable!(150);
    expect(ok).toBe(false); // canvas-less → not a usable graph binding
    expect(ctx.tabId).toBe("stale-tmp-tab"); // never bound onto the headless viewer
  });

  it("binds onto the DESKTOP canvas tab when it reconnects (ignoring a headless viewer alongside)", async () => {
    const { bridge, live, headless } = reconnectingBridge([]);
    const ctx = makePanelToolCtx(bridge, "stale-tmp-tab", new WorkflowTargetStore());
    // The canvas tab comes back; no headless viewer present → sole interactive tab.
    setTimeout(() => live.add("desktop-canvas"), 30);
    void headless; // (documents intent: no headless entry added here)
    const ok = await ctx.awaitReachable!();
    expect(ok).toBe(true);
    expect(ctx.tabId).toBe("desktop-canvas");
  });
});

describe("#402 panel_save_workflow awaits a stable binding before dispatch", () => {
  it("waits out the restart window, then saves against the reconnected tab", async () => {
    const { bridge, live, sent } = reconnectingBridge([]);
    const ctx = makePanelToolCtx(bridge, "stale-tmp-tab", new WorkflowTargetStore());
    setTimeout(() => live.add("reconnected-tab"), 40);
    const res = await defByName("panel_save_workflow").handler({}, ctx);
    expect(res.isError).toBeFalsy();
    expect(sent.at(-1)?.cmd).toMatchObject({ cmd: "workflow_save" });
    expect(sent.at(-1)?.tabId).toBe("reconnected-tab"); // never fired into the dead binding
  });

  it("REFUSES (zero sends) when no tab reconnects within budget — never dispatches into a dead binding", async () => {
    const { bridge, sent } = reconnectingBridge([]); // stays Connected: none
    const ctx = makePanelToolCtx(bridge, "stale-tmp-tab", new WorkflowTargetStore());
    const res = await defByName("panel_save_workflow").handler({ name: "new" }, ctx);
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/no reachable panel tab|Nothing was\s+sent/i);
    expect(sent.length).toBe(0); // the mutating save was never dispatched
  });

  it("panel_open_workflow also REFUSES (zero sends) when nothing reconnects", async () => {
    const { bridge, sent } = reconnectingBridge([]);
    const ctx = makePanelToolCtx(bridge, "stale-tmp-tab", new WorkflowTargetStore());
    const res = await defByName("panel_open_workflow").handler({ path: "workflows/x.json" }, ctx);
    expect(res.isError).toBe(true);
    expect(sent.length).toBe(0);
  });
});

describe("#402 panel_open_workflow verifies a mid-command reconnect DROP (OUTCOME UNKNOWN)", () => {
  it("turns an OUTCOME-UNKNOWN drop into a confirmed open via workflow_list", async () => {
    __openWorkflowTestHooks.setOpenVerifyTiming({ budgetMs: 200, intervalMs: 5, probeTimeoutMs: 50 });
    const live = new Set(["live-tab"]);
    let dropped = false;
    const bridge = {
      send: async (cmd: Record<string, unknown>, opts?: { tabId?: string }) => {
        if (cmd.cmd === "workflow_open") {
          if (!dropped) {
            dropped = true;
            // The write landed but the socket died before a reply — the bridge's
            // canonical POST-write mutating drop.
            throw new Error(
              'panel tab live-tab disconnected mid-command ("workflow_open") — OUTCOME UNKNOWN: the command was already sent',
            );
          }
        }
        if (cmd.cmd === "workflow_list") {
          // After the drop, the switch is confirmed active by the authoritative list.
          return { workflows: [{ key: "wf:workflows/x.json", active: true }], active: { path: "workflows/x.json" } };
        }
        return { ok: true, routedTo: opts?.tabId };
      },
      push: () => 1,
      canReach: (id: string) => live.has(id),
      tabs: () => [...live].map((t) => ({ tab_id: t, title: t, connected_at: 0 })),
      resolveActiveTabId: () => [...live][0],
    } as unknown as PanelToolCtx["bridge"];
    const ctx = makePanelToolCtx(bridge, "live-tab", new WorkflowTargetStore());

    const res = await defByName("panel_open_workflow").handler({ path: "workflows/x.json" }, ctx);
    expect(res.isError).toBeFalsy();
    const out = parse(res);
    expect(out.recovered).toBe(true);
    expect(out.opened).toMatchObject({ path: "workflows/x.json" });
  });

  it("a PRE-write 'NOT dispatched' failure is NOT re-verified (surfaced as-is)", async () => {
    __openWorkflowTestHooks.setOpenVerifyTiming({ budgetMs: 200, intervalMs: 5, probeTimeoutMs: 50 });
    const bridge = {
      send: async (cmd: Record<string, unknown>) => {
        if (cmd.cmd === "workflow_open") {
          throw new Error('failed to send "workflow_open" — the command was NOT dispatched (socket write failed)');
        }
        return { ok: true };
      },
      push: () => 1,
      canReach: () => true,
      tabs: () => [{ tab_id: "live-tab", title: "t", connected_at: 0 }],
      resolveActiveTabId: () => "live-tab",
    } as unknown as PanelToolCtx["bridge"];
    const ctx = makePanelToolCtx(bridge, "live-tab", new WorkflowTargetStore());
    const res = await defByName("panel_open_workflow").handler({ path: "workflows/x.json" }, ctx);
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/NOT dispatched/i);
  });
});

describe("#474 panel_set_workflow_target({mode:'current'}) recovery", () => {
  it("DEFERS (does not hard-fail) when zero tabs are connected, clearing the stale binding", async () => {
    const { bridge } = reconnectingBridge([]); // Connected: none — nothing to bind yet
    const store = new WorkflowTargetStore();
    store.set("stale-tmp-tab", { mode: "pinned", path: "workflows/old.json" });
    const ctx = makePanelToolCtx(bridge, "stale-tmp-tab", store);

    const res = await defByName("panel_set_workflow_target").handler({ mode: "current" }, ctx);
    expect(res.isError).toBeFalsy();
    const out = parse(res);
    expect(out.deferred).toBe(true);
    expect(out.mode).toBe("current"); // stale pin released
    expect(textOf(res)).toMatch(/reconnect/i);
  });

  it("binds immediately when a tab reconnects during the recovery call", async () => {
    const { bridge, live } = reconnectingBridge([]);
    const ctx = makePanelToolCtx(bridge, "stale-tmp-tab", new WorkflowTargetStore());
    setTimeout(() => live.add("reconnected-tab"), 40);
    const res = await defByName("panel_set_workflow_target").handler({ mode: "current" }, ctx);
    expect(res.isError).toBeFalsy();
    expect(ctx.tabId).toBe("reconnected-tab");
    expect(textOf(res)).toContain("Rebound this session");
  });

  it("still FAILS (no defer) when the rebind is AMBIGUOUS among multiple live tabs", async () => {
    const { bridge } = reconnectingBridge(["a-tab", "b-tab"]);
    const ctx = makePanelToolCtx(bridge, "dead-tab", new WorkflowTargetStore());
    const res = await defByName("panel_set_workflow_target").handler({ mode: "current" }, ctx);
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/Multiple panel tabs/);
    expect(ctx.tabId).toBe("dead-tab");
  });

  it("DEFERS (never binds headless) when the only connected client is a headless viewer", async () => {
    const { bridge, live, headless } = reconnectingBridge([]);
    live.add("headless-viewer");
    headless.add("headless-viewer"); // sole connection is canvas-less
    const ctx = makePanelToolCtx(bridge, "stale-tmp-tab", new WorkflowTargetStore());
    const res = await defByName("panel_set_workflow_target").handler({ mode: "current" }, ctx);
    expect(res.isError).toBeFalsy();
    expect(parse(res).deferred).toBe(true); // treated as "nothing bindable yet"
    expect(ctx.tabId).toBe("stale-tmp-tab"); // NEVER bound onto the headless viewer
  });

  it("binds the DESKTOP canvas tab when a headless viewer is also connected", async () => {
    const { bridge, live, headless } = reconnectingBridge([]);
    live.add("desktop-canvas");
    live.add("phone-mirror");
    headless.add("phone-mirror"); // one canvas tab + one headless viewer
    const ctx = makePanelToolCtx(bridge, "dead-tab", new WorkflowTargetStore());
    const res = await defByName("panel_set_workflow_target").handler({ mode: "current" }, ctx);
    expect(res.isError).toBeFalsy();
    expect(ctx.tabId).toBe("desktop-canvas"); // bound the sole interactive tab, not the mirror
  });

});

describe("headless-aware reconnect recovery (#400/#402)", () => {
  it("panel_reload of a STALE session binds the sole desktop tab when a headless viewer is also open (not 'multiple tabs')", async () => {
    const { bridge, live, headless } = reconnectingBridge([]);
    live.add("desktop-canvas");
    live.add("phone-mirror");
    headless.add("phone-mirror");
    const ctx = makePanelToolCtx(bridge, "dead-tab", new WorkflowTargetStore());
    const res = await defByName("panel_reload").handler({}, ctx);
    // The ambiguity guard counts only interactive tabs, so desktop+headless is NOT
    // ambiguous — it rebinds onto the sole canvas tab and dispatches.
    expect(textOf(res)).not.toMatch(/multiple tabs/i);
    expect(ctx.tabId).toBe("desktop-canvas");
  });
});

describe("#400 panel_restart_comfyui awaits the tab reconnect before returning", () => {
  beforeEach(() => {
    __panelToolsTestHooks.setPanelRebootTiming({ settleMs: 0, budgetMs: 200, intervalMs: 5, probeTimeoutMs: 20 });
  });
  afterEach(() => {
    __panelToolsTestHooks.setPanelRebootTiming(null);
    __panelToolsTestHooks.setHealthProbe(null);
  });

  it("certified ready:true only after the panel tab re-registers, rebinding onto it", async () => {
    // Boot endpoint goes DOWN then HEALTHY → certified observed-cycle.
    const seq = ["down", "healthy"];
    let i = 0;
    __panelToolsTestHooks.setHealthProbe(async () => seq[Math.min(i++, seq.length - 1)] as "down" | "healthy");

    const live = new Set<string>(["bound-tab"]);
    const bridge = {
      send: async (cmd: Record<string, unknown>, opts?: { tabId?: string }) => {
        if (cmd.cmd === "comfy_reboot") {
          // The reboot drops the tab's socket; the browser re-registers a moment later.
          live.delete("bound-tab");
          setTimeout(() => live.add("reconnected-tab"), 40);
          return { rebooting: true };
        }
        const id = opts?.tabId;
        if (id && !live.has(id)) throw new Error(`no connected tab with id "${id}". Connected: none`);
        return { ok: true, routedTo: id };
      },
      push: () => 1,
      canReach: (id: string) => live.has(id),
      tabs: () => [...live].map((t) => ({ tab_id: t, title: t, connected_at: 0 })),
      resolveActiveTabId: () => {
        if (live.size === 1) return [...live][0];
        if (live.size === 0) throw new Error("Panel not reachable: no panel connected");
        throw new Error("Multiple panel tabs are connected and none is last active — pass tab_id.");
      },
      tabOrigin: () => BOOT_BASE,
      tabServerOrigin: () => BOOT_BASE,
      tabIsLocal: () => true,
    } as unknown as PanelToolCtx["bridge"];
    const ctx = makePanelToolCtx(bridge, "bound-tab", new WorkflowTargetStore());
    ctx.confirm = async () => "yes" as const; // skip the human confirm card

    const out = parse(await defByName("panel_restart_comfyui").handler({ force: false }, ctx));
    expect(out.ready).toBe(true);
    expect(out.server_ready).toBe(true);
    expect(out.confirmed_cycle).toBe(true);
    expect(out.panel_tab_reconnected).toBe(true); // did not hand back a tabless window
    expect(ctx.tabId).toBe("reconnected-tab"); // rebound onto the reconnected tab
  });

  it("returns ready:false (server_ready:true) when the panel tab NEVER reconnects", async () => {
    // Keep the reconnect wait short so the test doesn't sit through the budget.
    __panelToolsTestHooks.setReconnectWaitTiming({ budgetMs: 60, intervalMs: 5 });
    const seq = ["down", "healthy"];
    let i = 0;
    __panelToolsTestHooks.setHealthProbe(async () => seq[Math.min(i++, seq.length - 1)] as "down" | "healthy");

    const live = new Set<string>(["bound-tab"]);
    const bridge = {
      send: async (cmd: Record<string, unknown>, opts?: { tabId?: string }) => {
        if (cmd.cmd === "comfy_reboot") {
          live.delete("bound-tab"); // tab drops and never comes back
          return { rebooting: true };
        }
        const id = opts?.tabId;
        if (id && !live.has(id)) throw new Error(`no connected tab with id "${id}". Connected: none`);
        return { ok: true, routedTo: id };
      },
      push: () => 1,
      canReach: (id: string) => live.has(id),
      tabs: () => [...live].map((t) => ({ tab_id: t, title: t, connected_at: 0 })),
      resolveActiveTabId: () => {
        if (live.size === 1) return [...live][0];
        throw new Error("Panel not reachable: no panel connected");
      },
      tabOrigin: () => BOOT_BASE,
      tabServerOrigin: () => BOOT_BASE,
      tabIsLocal: () => true,
    } as unknown as PanelToolCtx["bridge"];
    const ctx = makePanelToolCtx(bridge, "bound-tab", new WorkflowTargetStore());
    ctx.confirm = async () => "yes" as const;

    const out = parse(await defByName("panel_restart_comfyui").handler({ force: false }, ctx));
    expect(out.server_ready).toBe(true); // ComfyUI really did cycle
    expect(out.ready).toBe(false); // but graph tools are NOT usable — honest, not a false green
    expect(out.panel_tab_reconnected).toBe(false);
    expect(String(out.note)).toMatch(/has NOT reconnected|rebind/i);
  });
});

// #436 — the flap: after a restart a READ (panel_graph_outline) succeeds while the
// very next WRITE (panel_add_node) fails "no connected tab … Connected: none". Root
// cause: reads survive the "Connected: none" window (parked mid-command + retry-once)
// but the live graph MUTATION tools dispatched via ctx.call with NO pre-send wait, so
// they fired straight into the momentarily-empty tab registry. The fix gates every
// mutating graph edit behind the same bounded awaitReachable() that open/save use —
// centralized in ctx.call so no mutating tool can miss it — while leaving the read
// path untouched.
describe("#436 a MUTATING graph edit awaits the reconnect before dispatch", () => {
  it("waits out the post-restart 0-tab window, then dispatches to the reconnected tab (no flap)", async () => {
    const { bridge, live, sent } = reconnectingBridge([]); // Connected: none
    const ctx = makePanelToolCtx(bridge, "wf:workflows/x.json", new WorkflowTargetStore());
    setTimeout(() => live.add("reconnected-tab"), 40); // the browser re-hellos
    const res = await defByName("panel_add_node").handler({ class_type: "KSampler" }, ctx);
    expect(res.isError).toBeFalsy();
    // The mutating edit was dispatched — and to the RECONNECTED tab, never fired into
    // the dead "Connected: none" binding that produced the flap.
    expect(sent.at(-1)?.cmd).toMatchObject({ cmd: "graph_add_node", class_type: "KSampler" });
    expect(sent.at(-1)?.tabId).toBe("reconnected-tab");
    expect(ctx.tabId).toBe("reconnected-tab"); // rebound onto the live tab
  });

  it("REFUSES with ZERO dispatch when nothing reconnects — never fires into the dead binding", async () => {
    const { bridge, sent } = reconnectingBridge([]); // stays Connected: none
    const ctx = makePanelToolCtx(bridge, "wf:workflows/x.json", new WorkflowTargetStore());
    const res = await defByName("panel_add_node").handler({ class_type: "KSampler" }, ctx);
    expect(res.isError).toBe(true);
    expect(sent.length).toBe(0); // the mutating edit was NEVER dispatched
  });

  it("a HEALTHY session dispatches the edit immediately — no added latency", async () => {
    __panelToolsTestHooks.setReconnectWaitTiming({ budgetMs: 5000, intervalMs: 50 });
    const { bridge, sent } = reconnectingBridge(["live-tab"]);
    const ctx = makePanelToolCtx(bridge, "live-tab", new WorkflowTargetStore());
    const t0 = Date.now();
    const res = await defByName("panel_add_node").handler({ class_type: "KSampler" }, ctx);
    expect(res.isError).toBeFalsy();
    expect(Date.now() - t0).toBeLessThan(1000); // did NOT wait the 5s budget
    expect(sent.at(-1)?.tabId).toBe("live-tab");
  });

  it("panel_set_widget (also mutating) is gated too — waits then dispatches to the reconnected tab", async () => {
    const { bridge, live, sent } = reconnectingBridge([]);
    const ctx = makePanelToolCtx(bridge, "wf:workflows/x.json", new WorkflowTargetStore());
    setTimeout(() => live.add("reconnected-tab"), 40);
    const res = await defByName("panel_set_widget").handler(
      { node_id: 3, widget: "seed", value: 42 },
      ctx,
    );
    expect(res.isError).toBeFalsy();
    expect(sent.at(-1)?.tabId).toBe("reconnected-tab");
  });

  it("does NOT gate an idempotent READ — graph_outline keeps its existing (non-waiting) path", async () => {
    // A read is NOT a mutating graph edit, so the pre-wait must not apply; with a live
    // tab it simply dispatches through its normal path.
    const { bridge, sent } = reconnectingBridge(["live-tab"]);
    const ctx = makePanelToolCtx(bridge, "live-tab", new WorkflowTargetStore());
    const res = await defByName("panel_graph_outline").handler({}, ctx);
    expect(res.isError).toBeFalsy();
    expect(sent.at(-1)?.cmd).toMatchObject({ cmd: "graph_outline" });
  });

  // Codex-flagged: reads that are NOT in BRIDGE_READONLY_CMDS (so an exclusion rule
  // would have wrongly gated them) must NOT wait out the reconnect budget. With a
  // reconnect that never happens, a gated command would spin the whole budget; these
  // reads must return promptly instead (their existing non-waiting behavior).
  it("does NOT gate graph_list_subgraphs (a read absent from BRIDGE_READONLY_CMDS)", async () => {
    __panelToolsTestHooks.setReconnectWaitTiming({ budgetMs: 5000, intervalMs: 50 });
    const { bridge } = reconnectingBridge([]); // Connected: none, nothing reconnects
    const ctx = makePanelToolCtx(bridge, "stale-tab", new WorkflowTargetStore());
    const t0 = Date.now();
    const res = await defByName("panel_list_subgraphs").handler({}, ctx);
    // It fails (no tab) — but it must FAIL FAST, never spend the 5s budget waiting.
    expect(res.isError).toBe(true);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it("does NOT gate training_get_state (a read absent from BRIDGE_READONLY_CMDS)", async () => {
    __panelToolsTestHooks.setReconnectWaitTiming({ budgetMs: 5000, intervalMs: 50 });
    const { bridge } = reconnectingBridge([]);
    const ctx = makePanelToolCtx(bridge, "stale-tab", new WorkflowTargetStore());
    const t0 = Date.now();
    const res = await defByName("panel_training_get_state").handler({}, ctx);
    expect(res.isError).toBe(true);
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});
