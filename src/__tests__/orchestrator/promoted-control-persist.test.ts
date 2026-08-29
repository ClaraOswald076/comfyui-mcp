// panel#1558 — a successful promoted subgraph write still will not persist when
// the inner widget is governed by control_after_generate='randomize' and that
// control is NOT promoted onto the parent. The panel warns and names an
// enter → set-inner-fixed → exit sequence. panel_set_widget must follow that
// remedy itself so the value the caller just set holds, without hidden inner ids.
//
// These tests drive the SHIPPED handler. A write with no persist warning is
// untouched. A DIRECT seed warning (control already on the addressed node) is
// not auto-pinned — randomize there is often intentional.

import { describe, expect, it } from "vitest";

import {
  buildPanelToolDefs,
  makePanelToolCtx,
  type PanelToolCtx,
  type ToolResult,
} from "../../orchestrator/panel-tools.js";
import {
  addressedNodeMatchesPersistRemedy,
  parseUnpromotedControlPersistRemedy,
} from "../../orchestrator/promoted-widget.js";
import { WorkflowTargetStore } from "../../services/workflow-target-store.js";

const TAB = "wf:ltx-img2vid";

/** The panel's #650 wording for the reporter's LTX-2.3 node 320 / inner 312. */
const REPORTER_WARNING =
  `control_after_generate='randomize' governs widget "value" on node 312: ` +
  `ComfyUI automatically CHANGES this value on subsequent runs (a new random value each run), ` +
  `so the value you set will NOT persist. Set "control_after_generate" to 'fixed' to hold it — ` +
  `"control_after_generate" is NOT promoted onto subgraph node 320, so it is not settable from this ` +
  `scope — node 312 does not exist in the graph you are addressing. Enter the owning ` +
  `subgraph first: panel_enter_subgraph(node_id=320), then ` +
  `panel_set_widget(node_id=312, widget='control_after_generate', value='fixed'), then ` +
  `panel_exit_subgraph().`;

const NESTED_WARNING =
  `control_after_generate='randomize' governs widget "seed" on node 90: ` +
  `ComfyUI automatically CHANGES this value on subsequent runs (a new random value each run), ` +
  `so the value you set will NOT persist. Set "control_after_generate" to 'fixed' to hold it — ` +
  `"control_after_generate" is NOT promoted onto subgraph node 70, so it is not settable from this ` +
  `scope — node 90 does not exist in the graph you are addressing. Enter the owning ` +
  `subgraph first: panel_enter_subgraph(node_id=70), then panel_enter_subgraph(node_id=80), then ` +
  `panel_set_widget(node_id=90, widget='control_after_generate', value='fixed'), then ` +
  `panel_exit_subgraph() 2 times.`;

const DIRECT_WARNING =
  `control_after_generate='randomize' governs widget "seed" on node 3: ` +
  `ComfyUI automatically CHANGES this value on subsequent runs (a new random value each run), ` +
  `so the value you set will NOT persist. Set "control_after_generate" to 'fixed' to hold it — ` +
  `panel_set_widget(node_id=3, widget='control_after_generate', value='fixed').`;

const PROMOTED_REPORTER_SUBGRAPH = {
  subgraph_of: { node_id: 320, title: "LTX" },
  instance_widgets: { value_2: 1280 },
  node_count: 1,
  nodes: [
    {
      id: 312,
      type: "LTXInner",
      widgets: { value_2: 1280, control_after_generate: "randomize" },
    },
  ],
};

describe("parseUnpromotedControlPersistRemedy", () => {
  it("parses the reporter's unpromoted LTX warning", () => {
    const parsed = parseUnpromotedControlPersistRemedy(REPORTER_WARNING);
    expect(parsed).toEqual({
      outerNodeId: "320",
      enterPath: ["320"],
      innerNodeId: "312",
      controlWidget: "control_after_generate",
      exitCount: 1,
      mode: "randomize",
    });
    expect(addressedNodeMatchesPersistRemedy(320, parsed!)).toBe(true);
    expect(addressedNodeMatchesPersistRemedy("320", parsed!)).toBe(true);
    expect(addressedNodeMatchesPersistRemedy(78, parsed!)).toBe(false);
  });

  it("parses a nested enter path and the 'N times' exit", () => {
    expect(parseUnpromotedControlPersistRemedy(NESTED_WARNING)).toEqual({
      outerNodeId: "70",
      enterPath: ["70", "80"],
      innerNodeId: "90",
      controlWidget: "control_after_generate",
      exitCount: 2,
      mode: "randomize",
    });
  });

  it("ignores a DIRECT seed warning — no enter, not this bug", () => {
    expect(parseUnpromotedControlPersistRemedy(DIRECT_WARNING)).toBeNull();
  });

  it("ignores a warning whose control IS promoted onto the outer node", () => {
    const text =
      `control_after_generate='randomize' governs widget "seed" on node 75: ` +
      `the value you set will NOT persist. Set "control_after_generate" to 'fixed' to hold it — ` +
      `"control_after_generate" is promoted onto subgraph node 78 as "control_after_generate", so set it ` +
      `from here: panel_set_widget(node_id=78, widget='control_after_generate', value='fixed').`;
    expect(parseUnpromotedControlPersistRemedy(text)).toBeNull();
  });

  it("ignores an unrelated success", () => {
    expect(parseUnpromotedControlPersistRemedy(JSON.stringify({ set: { value: 1920 } }))).toBeNull();
  });
});

function bridge(opts: {
  warning?: string;
  pinFails?: boolean;
  enterFailsAt?: number;
  exitFails?: boolean;
  missingConnectionIdentity?: boolean;
  connectionRebindBeforePin?: boolean;
  anonymousRebindBeforePin?: boolean;
} = {}) {
  const calls: Array<Record<string, unknown>> = [];
  let enters = 0;
  let connectionIdentity = { generation: 1, tabSessionId: "browser-tab-a" };
  let anonymousIncarnation = "anon:1";
  const b = {
    send: async (
      cmd: Record<string, unknown>,
      sendOpts?: { beforeDispatch?: () => void },
    ) => {
      if (cmd.cmd === "graph_set_widget" && sendOpts?.beforeDispatch) {
        if (cmd.widget === "control_after_generate") {
          if (opts.connectionRebindBeforePin) {
            connectionIdentity = { generation: 2, tabSessionId: "browser-tab-a" };
          }
          if (opts.anonymousRebindBeforePin) {
            anonymousIncarnation = "anon:2";
          }
        }
        sendOpts.beforeDispatch();
      }
      calls.push({ ...cmd });
      if (cmd.cmd === "graph_set_widget") {
        if (cmd.widget === "control_after_generate") {
          if (opts.pinFails) throw new Error("pin rejected");
          return { set: { node_id: cmd.node_id, widget: cmd.widget, value: cmd.value } };
        }
        const warning = opts.warning;
        return {
          set: {
            node_id: cmd.node_id,
            widget: cmd.widget,
            previous: 1280,
            value: cmd.value,
            promoted_from: { inner_node_id: 312, widget: "value" },
          },
          ...(warning ? { warning } : {}),
        };
      }
      if (cmd.cmd === "graph_enter_subgraph") {
        enters += 1;
        if (opts.enterFailsAt != null && enters === opts.enterFailsAt) {
          throw new Error(`could not enter subgraph ${cmd.node_id}`);
        }
        return { scope: "subgraph", node_id: cmd.node_id };
      }
      if (cmd.cmd === "graph_exit_subgraph") {
        if (opts.exitFails) throw new Error("could not confirm exit");
        return { scope: "root" };
      }
      return { ok: true };
    },
    push: () => 1,
    canReach: () => true,
    isHeadless: () => false,
    tabs: () => [{ tab_id: TAB, title: "wf", connected_at: 0 }],
    resolveActiveTabId: () => TAB,
    tabCanMutateGraph: () => true,
    tabGraphMutationCapability: () => ({ known: true, canMutate: true }),
    tabConnectionIdentity: () =>
      opts.missingConnectionIdentity || opts.anonymousRebindBeforePin
        ? undefined
        : connectionIdentity,
    tabIncarnation: () => anonymousIncarnation,
  } as unknown as PanelToolCtx["bridge"];
  return { b, calls };
}

async function setWidget(
  args: { node_id: number | string; widget: string; value: number | string },
  opts: Parameters<typeof bridge>[0] = {},
) {
  const { b, calls } = bridge(opts);
  const ctx = makePanelToolCtx(b, TAB, new WorkflowTargetStore());
  const def = buildPanelToolDefs().find((d) => d.name === "panel_set_widget");
  if (!def) throw new Error("panel_set_widget is not registered");
  const res: ToolResult = await def.handler(args as never, ctx);
  return {
    text: res.content.map((c) => (c as { text?: string }).text ?? "").join(" "),
    isError: res.isError === true,
    calls,
  };
}

/** A small receiver model for the actual promoted-write path. The older bridge
 * above intentionally exercises the legacy direct helper seam; this one also
 * supplies the graph/scope/type capabilities that production uses to create a
 * trustworthy follow-up binding. Its replacement options mutate the receiver
 * only after MCP's synchronous callback, before the panel applies the frame. */
function witnessedBridge(opts: {
  replacement?: "graph" | "type" | "connection" | "anonymous";
  anonymous?: boolean;
  pinFails?: boolean;
  persistExitFails?: boolean;
  enterFailsAt?: number;
} = {}) {
  const calls: Array<Record<string, unknown>> = [];
  let inSubgraph = false;
  let graphIdentity = "graph:ltx-container-a";
  let nodeType = "LTXInner";
  let connectionIdentity = { generation: 1, tabSessionId: "browser-tab-a" };
  let anonymousIncarnation = "anon:1";
  let enters = 0;
  let exits = 0;
  let mutations = 0;
  const scope = () => ({
    known: true as const,
    scope: inSubgraph ? ("subgraph" as const) : ("root" as const),
    ownerNodeId: inSubgraph ? "320" : null,
    workflowUuid: "workflow-a",
    graphIdentity: inSubgraph ? graphIdentity : "graph:ltx-root",
  });
  const subgraph = {
    ...PROMOTED_REPORTER_SUBGRAPH,
    subgraph_of: {
      ...PROMOTED_REPORTER_SUBGRAPH.subgraph_of,
      graph_identity: "graph:ltx-container-a",
    },
    viewing: {
      scope: "root",
      workflow_uuid: "workflow-a",
      graph_identity: "graph:ltx-root",
    },
  };
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- the production bridge is intentionally modeled with only the dispatch and witness surface needed by this receiver test.
  const b = {
    send: async (
      cmd: Record<string, unknown>,
      sendOpts?: { beforeDispatch?: () => void },
    ) => {
      if (cmd.cmd === "graph_set_widget" && sendOpts?.beforeDispatch) {
        if (cmd.widget === "control_after_generate") {
          if (opts.replacement === "connection") {
            connectionIdentity = { generation: 2, tabSessionId: "browser-tab-a" };
          }
          if (opts.replacement === "anonymous") anonymousIncarnation = "anon:2";
        }
        sendOpts.beforeDispatch();
        if (cmd.widget === "control_after_generate") {
          if (opts.replacement === "graph") graphIdentity = "graph:ltx-container-b";
          if (opts.replacement === "type") nodeType = "ReplacementInner";
        }
      }
      calls.push({ ...cmd });

      if (cmd.cmd === "graph_query") {
        const id = Array.isArray(cmd.ids) && cmd.ids.length ? String(cmd.ids[0]) : "";
        if (id === "320") {
          return {
            viewing: {
              scope: "root",
              workflow_uuid: "workflow-a",
              graph_identity: "graph:ltx-root",
            },
            nodes: [{ id: 320, type: "SubgraphNode", is_subgraph: true }],
            truncated: false,
          };
        }
        return {
          viewing: {
            scope: "subgraph",
            owner_node_id: "320",
            workflow_uuid: "workflow-a",
            graph_identity: graphIdentity,
          },
          nodes: [{ id: 312, type: nodeType, is_subgraph: false }],
          truncated: false,
        };
      }
      if (cmd.cmd === "graph_get_subgraph") return subgraph;
      if (cmd.cmd === "graph_enter_subgraph") {
        enters += 1;
        if (opts.enterFailsAt === enters) throw new Error("could not confirm entry");
        inSubgraph = true;
        graphIdentity = "graph:ltx-container-a";
        return { scope: "subgraph", node_id: cmd.node_id };
      }
      if (cmd.cmd === "graph_exit_subgraph") {
        exits += 1;
        if (opts.persistExitFails && exits === 2) throw new Error("could not confirm exit");
        inSubgraph = false;
        return { scope: "root" };
      }
      if (cmd.cmd === "graph_set_widget") {
        const expectedScope = cmd.expected_scope;
        const expectedType = cmd.expected_node_type;
        if (
          !expectedScope ||
          typeof expectedScope !== "object" ||
          Array.isArray(expectedScope) ||
          (expectedScope as Record<string, unknown>).scope !== "subgraph" ||
          String((expectedScope as Record<string, unknown>).owner_node_id) !== "320" ||
          (expectedScope as Record<string, unknown>).graph_identity !== graphIdentity ||
          (expectedScope as Record<string, unknown>).workflow_uuid !== "workflow-a"
        ) {
          throw new Error("graph_set_widget receiver scope changed before dispatch: Nothing was applied.");
        }
        if (expectedType !== nodeType) {
          throw new Error("graph_set_widget receiver node type changed before dispatch: Nothing was applied.");
        }
        if (cmd.widget === "control_after_generate") {
          if (opts.pinFails) throw new Error("pin rejected");
          mutations += 1;
          return { set: { node_id: cmd.node_id, widget: cmd.widget, value: cmd.value } };
        }
        mutations += 1;
        return {
          set: { node_id: cmd.node_id, widget: cmd.widget, value: cmd.value },
          warning: REPORTER_WARNING,
        };
      }
      return { ok: true };
    },
    push: () => 1,
    canReach: () => true,
    isHeadless: () => false,
    tabs: () => [{ tab_id: TAB, title: "wf", connected_at: 0 }],
    resolveActiveTabId: () => TAB,
    tabCanMutateGraph: () => true,
    tabGraphMutationCapability: () => ({ known: true, canMutate: true }),
    tabConnectionIdentity: () => (opts.anonymous ? undefined : connectionIdentity),
    tabIncarnation: () => anonymousIncarnation,
    promotedScopeFor: () => scope(),
    workflowUuidFor: () => ({ known: true, uuid: "workflow-a" }),
    tabExpectedNodeTypeFenceCapability: () => true,
    tabExpectedScopeGraphIdentityFenceCapability: () => true,
    tabPromotedTerminalWitnessCapability: () => false,
    tabPromotedParentRailFenceCapability: () => false,
  } as unknown as PanelToolCtx["bridge"];
  return { b, calls, get mutations() { return mutations; } };
}

async function setWidgetWithWitnessedBridge(
  args: { node_id: number | string; widget: string; value: number | string },
  opts: Parameters<typeof witnessedBridge>[0] = {},
) {
  const harness = witnessedBridge(opts);
  const ctx = makePanelToolCtx(harness.b, TAB, new WorkflowTargetStore());
  const def = buildPanelToolDefs().find((d) => d.name === "panel_set_widget");
  if (!def) throw new Error("panel_set_widget is not registered");
  const res: ToolResult = await def.handler(args as never, ctx);
  return {
    text: res.content.map((c) => (c as { text?: string }).text ?? "").join(" "),
    isError: res.isError === true,
    calls: harness.calls,
    mutations: harness.mutations,
  };
}

describe("panel_set_widget unpromoted control_after_generate persist (panel#1558)", () => {
  it("refuses an unwitnessed legacy success before entering the inner graph", async () => {
    const { text, isError, calls } = await setWidget(
      { node_id: 320, widget: "value_2", value: 1920 },
      { warning: REPORTER_WARNING },
    );

    expect(isError).toBe(false);
    expect(calls.map((c) => c.cmd)).toEqual(["graph_set_widget"]);
    expect(calls[0]).toMatchObject({ node_id: 320, widget: "value_2", value: 1920 });
    expect(text).toMatch(/"value": 1920/);
    expect(text).toMatch(/trustworthy witness/);
    expect(text).toMatch(/persistence write was NOT dispatched/);
    expect(text).toMatch(/will NOT persist/);
    expect(text).not.toMatch(/control_after_generate_pinned/);
  });

  it("fences the secondary pin when the public connection changes", async () => {
    const { text, isError, calls } = await setWidget(
      { node_id: 320, widget: "value_2", value: 1920 },
      { warning: REPORTER_WARNING, connectionRebindBeforePin: true },
    );

    expect(isError).toBe(false);
    expect(calls.map((c) => c.cmd)).toEqual(["graph_set_widget"]);
    expect(text).toMatch(/trustworthy witness/);
    expect(text).toContain("persistence write was NOT dispatched");
    expect(text).not.toMatch(/control_after_generate_pinned/);
  });

  it("allows a stable anonymous connection to pin through the real dispatch options", async () => {
    const { text, isError, calls } = await setWidget(
      { node_id: 320, widget: "value_2", value: 1920 },
      { warning: REPORTER_WARNING, missingConnectionIdentity: true },
    );

    expect(isError).toBe(false);
    expect(calls.map((c) => c.cmd)).toEqual(["graph_set_widget"]);
    expect(text).toMatch(/trustworthy witness/);
    expect(text).toMatch(/persistence write was NOT dispatched/);
    expect(text).not.toMatch(/control_after_generate_pinned/);
  });

  it("refuses an anonymous takeover before the secondary pin", async () => {
    const { text, isError, calls } = await setWidget(
      { node_id: 320, widget: "value_2", value: 1920 },
      { warning: REPORTER_WARNING, anonymousRebindBeforePin: true },
    );

    expect(isError).toBe(false);
    expect(calls.map((c) => c.cmd)).toEqual(["graph_set_widget"]);
    expect(text).toMatch(/trustworthy witness/);
    expect(text).toContain("persistence write was NOT dispatched");
    expect(text).not.toMatch(/control_after_generate_pinned/);
  });

  it("a healthy write with no persist warning is untouched — one call, no enter", async () => {
    const { isError, calls, text } = await setWidget({ node_id: 320, widget: "value_2", value: 1920 });
    expect(isError).toBe(false);
    expect(calls.map((c) => c.cmd)).toEqual(["graph_set_widget"]);
    expect(text).not.toMatch(/control_after_generate_pinned/);
  });

  it("a DIRECT seed warning is not auto-pinned", async () => {
    const { isError, calls, text } = await setWidget(
      { node_id: 3, widget: "seed", value: 42 },
      { warning: DIRECT_WARNING },
    );
    expect(isError).toBe(false);
    expect(calls.map((c) => c.cmd)).toEqual(["graph_set_widget"]);
    expect(calls[0]).toMatchObject({ node_id: 3, widget: "seed", value: 42 });
    expect(text).toMatch(/will NOT persist/);
    expect(text).not.toMatch(/control_after_generate_pinned/);
  });

  it("nested promotions enter every container, then exit the same number of times", async () => {
    const { isError, calls, text } = await setWidget(
      { node_id: 70, widget: "seed", value: 7 },
      { warning: NESTED_WARNING },
    );
    expect(isError).toBe(false);
    expect(calls.map((c) => c.cmd)).toEqual(["graph_set_widget"]);
    expect(text).toMatch(/trustworthy witness/);
    expect(text).not.toMatch(/control_after_generate_pinned/);
  });

  it("keeps the original success + warning when enter fails, and does not pin", async () => {
    const { text, isError, calls } = await setWidget(
      { node_id: 320, widget: "value_2", value: 1920 },
      { warning: REPORTER_WARNING, enterFailsAt: 1 },
    );
    expect(isError).toBe(false);
    expect(calls.map((c) => c.cmd)).toEqual(["graph_set_widget"]);
    expect(text).toMatch(/will NOT persist/);
    expect(text).toMatch(/trustworthy witness/);
    expect(text).not.toMatch(/control_after_generate_pinned/);
    expect(calls.filter((c) => c.widget === "control_after_generate")).toHaveLength(0);
  });

  it("exits even when the pin write fails, and keeps the original warning", async () => {
    const { text, isError, calls } = await setWidget(
      { node_id: 320, widget: "value_2", value: 1920 },
      { warning: REPORTER_WARNING, pinFails: true },
    );
    expect(isError).toBe(false);
    expect(calls.map((c) => c.cmd)).toEqual(["graph_set_widget"]);
    expect(text).toMatch(/will NOT persist/);
    expect(text).toMatch(/trustworthy witness/);
    expect(text).not.toMatch(/control_after_generate_pinned/);
  });

  it("discloses an exit failure after a successful pin so the canvas is not silently left inside", async () => {
    const { text, isError, calls } = await setWidget(
      { node_id: 320, widget: "value_2", value: 1920 },
      { warning: REPORTER_WARNING, exitFails: true },
    );
    expect(isError).toBe(false);
    expect(calls.map((c) => c.cmd)).toEqual(["graph_set_widget"]);
    expect(text).toMatch(/trustworthy witness/);
    expect(text).toMatch(/persistence write was NOT dispatched/);
    expect(text).not.toMatch(/control_after_generate_pinned/);
  });

  it("does not pin a warning about a different subgraph than the node just written", async () => {
    const { isError, calls, text } = await setWidget(
      { node_id: 99, widget: "value_2", value: 1920 },
      { warning: REPORTER_WARNING },
    );
    expect(isError).toBe(false);
    expect(calls.map((c) => c.cmd)).toEqual(["graph_set_widget"]);
    expect(text).toMatch(/will NOT persist/);
    expect(text).not.toMatch(/control_after_generate_pinned/);
  });
});

describe("panel_set_widget promoted control persistence dispatch fences (#1925)", () => {
  it("carries the primary inner type and scope into the secondary pin", async () => {
    const { text, isError, calls, mutations } = await setWidgetWithWitnessedBridge(
      { node_id: 320, widget: "value_2", value: 1920 },
    );

    const writes = calls.filter((call) => call.cmd === "graph_set_widget");
    expect(isError).toBe(false);
    expect(mutations).toBe(2);
    expect(writes).toHaveLength(2);
    expect(writes[0]).toMatchObject({ node_id: 312, widget: "value_2", expected_node_type: "LTXInner" });
    expect(writes[1]).toMatchObject({
      node_id: "312",
      widget: "control_after_generate",
      value: "fixed",
      expected_node_type: "LTXInner",
      expected_scope: {
        scope: "subgraph",
        owner_node_id: "320",
        graph_identity: "graph:ltx-container-a",
        workflow_uuid: "workflow-a",
      },
    });
    expect(text).toMatch(/control_after_generate_pinned/);
  });

  it("refuses a same-connection replacement graph reusing the inner id and type", async () => {
    const { text, isError, calls, mutations } = await setWidgetWithWitnessedBridge(
      { node_id: 320, widget: "value_2", value: 1920 },
      { replacement: "graph" },
    );

    const writes = calls.filter((call) => call.cmd === "graph_set_widget");
    expect(isError).toBe(false);
    expect(mutations).toBe(1);
    expect(writes).toHaveLength(2);
    expect(writes[1]).toMatchObject({
      node_id: "312",
      expected_node_type: "LTXInner",
      expected_scope: expect.objectContaining({ graph_identity: "graph:ltx-container-a" }),
    });
    expect(text).toMatch(/pin rejected|Nothing was applied/);
    expect(text).not.toMatch(/control_after_generate_pinned/);
  });

  it("refuses a same-graph replacement node with a different type", async () => {
    const { text, isError, calls, mutations } = await setWidgetWithWitnessedBridge(
      { node_id: 320, widget: "value_2", value: 1920 },
      { replacement: "type" },
    );

    const writes = calls.filter((call) => call.cmd === "graph_set_widget");
    expect(isError).toBe(false);
    expect(mutations).toBe(1);
    expect(writes).toHaveLength(2);
    expect(writes[1]).toMatchObject({
      node_id: "312",
      expected_node_type: "LTXInner",
      expected_scope: expect.objectContaining({ graph_identity: "graph:ltx-container-a" }),
    });
    expect(text).toMatch(/pin rejected|Nothing was applied/);
    expect(text).not.toMatch(/control_after_generate_pinned/);
  });

  it("uses the private incarnation witness for a stable anonymous socket", async () => {
    const { text, isError, calls, mutations } = await setWidgetWithWitnessedBridge(
      { node_id: 320, widget: "value_2", value: 1920 },
      { anonymous: true },
    );

    expect(isError).toBe(false);
    expect(mutations).toBe(2);
    expect(calls.filter((call) => call.cmd === "graph_set_widget")).toHaveLength(2);
    expect(text).toMatch(/control_after_generate_pinned/);
  });

  it("refuses the secondary write when the public connection changes", async () => {
    const { text, isError, calls, mutations } = await setWidgetWithWitnessedBridge(
      { node_id: 320, widget: "value_2", value: 1920 },
      { replacement: "connection" },
    );

    expect(isError).toBe(false);
    expect(mutations).toBe(1);
    expect(calls.filter((call) => call.cmd === "graph_set_widget")).toHaveLength(1);
    expect(text).toMatch(/session or connection changed/);
    expect(text).toContain("No graph_set_widget was dispatched");
    expect(text).not.toMatch(/control_after_generate_pinned/);
  });

  it("keeps the primary success and exits when the secondary pin fails", async () => {
    const { text, isError, calls, mutations } = await setWidgetWithWitnessedBridge(
      { node_id: 320, widget: "value_2", value: 1920 },
      { pinFails: true },
    );

    expect(isError).toBe(false);
    expect(mutations).toBe(1);
    expect(calls.filter((call) => call.cmd === "graph_set_widget")).toHaveLength(2);
    expect(calls.map((call) => call.cmd)).toContain("graph_exit_subgraph");
    expect(text).toMatch(/pin rejected/);
    expect(text).not.toMatch(/control_after_generate_pinned/);
  });

  it("keeps the primary success when entering the persistence scope fails", async () => {
    const { text, isError, calls, mutations } = await setWidgetWithWitnessedBridge(
      { node_id: 320, widget: "value_2", value: 1920 },
      { enterFailsAt: 2 },
    );

    expect(isError).toBe(false);
    expect(mutations).toBe(1);
    expect(calls.map((call) => call.cmd)).toContain("graph_enter_subgraph");
    expect(text).toMatch(/could not confirm entry/);
    expect(text).not.toMatch(/control_after_generate_pinned/);
  });

  it("discloses a failed secondary exit after the pin succeeds", async () => {
    const { text, isError, calls, mutations } = await setWidgetWithWitnessedBridge(
      { node_id: 320, widget: "value_2", value: 1920 },
      { persistExitFails: true },
    );

    expect(isError).toBe(false);
    expect(mutations).toBe(2);
    expect(calls.filter((call) => call.cmd === "graph_set_widget")).toHaveLength(2);
    expect(text).toMatch(/control_after_generate_pinned/);
    expect(text).toMatch(/panel_exit_subgraph then FAILED/);
    expect(text).toMatch(/Call panel_exit_subgraph/);
  });
});
