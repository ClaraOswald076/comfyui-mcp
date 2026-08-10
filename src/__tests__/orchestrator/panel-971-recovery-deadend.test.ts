// PROBE for panel#971 — not a fix, and not intended to be merged as-is.
//
// Reporter's wedge: after Save-As, panel_set_workflow_target({mode:"current"})
// reports BOUND, panel_set_widget still fails [root-workflow-uuid-mismatch], and
// the prescribed recovery panel_open_workflow then refuses with
// "this session has no reachable panel tab yet".
//
// The question this probe answers, and nothing more: does the recovery the
// refusal MESSAGE names actually restore reachability for the command that
// refused? awaitReachable's own comment justifies returning early by asserting
// that "panel_set_workflow_target proceeds to its explicit last-active rebind",
// so if that rebind does not move ctx.tabId, the advice is a loop.
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { __resetPanelBaseCache } from "../../services/panel-workspace.js";

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
import { WorkflowTargetStore } from "../../services/workflow-target-store.js";
import { markDispatched } from "../../services/ui-bridge.js";
import type { PanelToolCtx, ToolResult } from "../../orchestrator/panel-tools.js";

const textOf = (res: ToolResult): string =>
  res.content.map((c) => (c as { text?: string }).text ?? "").join(" ");

function reconnectingBridge(initial: string[] = []) {
  const live = new Set(initial);
  const headless = new Set<string>();
  const sent: Array<{ cmd: Record<string, unknown>; tabId?: string }> = [];
  const bridge = {
    send: async (cmd: Record<string, unknown>, opts?: { tabId?: string }) => {
      const id = opts?.tabId;
      if (id && !live.has(id)) {
        const connected = [...live].map((t) => `${t.slice(0, 8)} ("${t}")`).join(", ") || "none";
        throw markDispatched(new Error(`no connected tab with id "${id}". Connected: ${connected}`), false);
      }
      sent.push({ cmd, tabId: id });
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
  __resetPanelBaseCache();
  __panelToolsTestHooks.setReconnectWaitTiming({ budgetMs: 300, intervalMs: 5 });
});
afterEach(() => {
  __panelToolsTestHooks.setReconnectWaitTiming(null);
});

it("#971 the last-active case works — this is the path the design documents", async () => {
  const { bridge } = reconnectingBridge(["tab-a", "tab-b"]);
  (bridge as unknown as { resolveActiveTabId: () => string }).resolveActiveTabId = () => "tab-b";
  const ctx = makePanelToolCtx(bridge, "stale-tab", new WorkflowTargetStore());
  expect(await ctx.awaitReachable!()).toBe(false);

  const target = buildPanelToolDefs().find((d) => d.name === "panel_set_workflow_target")!;
  const res = (await target.handler({ mode: "current" }, ctx)) as ToolResult;
  expect(res.isError).toBeFalsy();
  expect(ctx.tabId).toBe("tab-b"); // the rebind moved the session
  expect(await ctx.awaitReachable!()).toBe(true);

  const open = buildPanelToolDefs().find((d) => d.name === "panel_open_workflow")!;
  expect(((await open.handler({ path: "demo.json" }, ctx)) as ToolResult).isError).toBeFalsy();
});

it("#971 with NO last-active tab, the prescribed recovery is a dead end", async () => {
  // Reporter's wedge. panel_open_workflow refuses and names
  // panel_set_workflow_target({mode:"current"}) as the way out; that tool then
  // fails with the bridge's raw "pass tab_id" — and the tool has NO tab_id
  // parameter, with #754 strict schemas making an unknown key a hard validation
  // error. The agent is told to pass something it cannot pass.
  const { bridge } = reconnectingBridge(["tab-a", "tab-b"]); // resolveActiveTabId throws
  const ctx = makePanelToolCtx(bridge, "stale-tab", new WorkflowTargetStore());

  const open = buildPanelToolDefs().find((d) => d.name === "panel_open_workflow")!;
  const refusal = textOf((await open.handler({ path: "demo.json" }, ctx)) as ToolResult);
  expect(refusal).toMatch(/panel_set_workflow_target\(\{mode:"current"\}\)/);

  const target = buildPanelToolDefs().find((d) => d.name === "panel_set_workflow_target")!;
  const rec2 = (await target.handler({ mode: "current" }, ctx)) as ToolResult;

  // The tool has no tab_id to offer, so an error demanding one cannot be followed.
  expect(Object.keys(target.schema ?? {})).not.toContain("tab_id");
  expect(textOf(rec2)).not.toMatch(/pass tab_id/i);

  // And whatever it says, it must leave the caller somewhere other than where it
  // started: either rebound, or told an action that does not require a parameter
  // this tool does not have.
  const recovered = ctx.tabId !== "stale-tab" || /switch to|focus/i.test(textOf(rec2));
  expect(recovered).toBe(true);
});
