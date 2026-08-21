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
} = {}) {
  const calls: Array<Record<string, unknown>> = [];
  let enters = 0;
  const b = {
    send: async (cmd: Record<string, unknown>) => {
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

describe("panel_set_widget unpromoted control_after_generate persist (panel#1558)", () => {
  it("the reporter's case: parent write succeeds, then enter → pin inner fixed → exit", async () => {
    const { text, isError, calls } = await setWidget(
      { node_id: 320, widget: "value_2", value: 1920 },
      { warning: REPORTER_WARNING },
    );

    expect(isError).toBe(false);
    expect(calls.map((c) => c.cmd)).toEqual([
      "graph_set_widget",
      "graph_enter_subgraph",
      "graph_set_widget",
      "graph_exit_subgraph",
    ]);
    expect(calls[0]).toMatchObject({ node_id: 320, widget: "value_2", value: 1920 });
    expect(calls[1]).toMatchObject({ cmd: "graph_enter_subgraph", node_id: "320" });
    expect(calls[2]).toMatchObject({
      node_id: "312",
      widget: "control_after_generate",
      value: "fixed",
    });
    expect(text).toMatch(/"value": 1920/);
    expect(text).toMatch(/control_after_generate_pinned/);
    expect(text).not.toMatch(/will NOT persist/);
    expect(text).not.toMatch(/Enter the owning subgraph/);
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
    const { isError, calls } = await setWidget(
      { node_id: 70, widget: "seed", value: 7 },
      { warning: NESTED_WARNING },
    );
    expect(isError).toBe(false);
    expect(calls.map((c) => c.cmd)).toEqual([
      "graph_set_widget",
      "graph_enter_subgraph",
      "graph_enter_subgraph",
      "graph_set_widget",
      "graph_exit_subgraph",
      "graph_exit_subgraph",
    ]);
    expect(calls[1]).toMatchObject({ node_id: "70" });
    expect(calls[2]).toMatchObject({ node_id: "80" });
    expect(calls[3]).toMatchObject({
      node_id: "90",
      widget: "control_after_generate",
      value: "fixed",
    });
  });

  it("keeps the original success + warning when enter fails, and does not pin", async () => {
    const { text, isError, calls } = await setWidget(
      { node_id: 320, widget: "value_2", value: 1920 },
      { warning: REPORTER_WARNING, enterFailsAt: 1 },
    );
    expect(isError).toBe(false);
    expect(calls.map((c) => c.cmd)).toEqual(["graph_set_widget", "graph_enter_subgraph"]);
    expect(text).toMatch(/will NOT persist/);
    expect(text).toMatch(/panel_enter_subgraph\(node_id=320\) FAILED/);
    expect(text).not.toMatch(/control_after_generate_pinned/);
    expect(calls.filter((c) => c.widget === "control_after_generate")).toHaveLength(0);
  });

  it("exits even when the pin write fails, and keeps the original warning", async () => {
    const { text, isError, calls } = await setWidget(
      { node_id: 320, widget: "value_2", value: 1920 },
      { warning: REPORTER_WARNING, pinFails: true },
    );
    expect(isError).toBe(false);
    expect(calls.map((c) => c.cmd)).toEqual([
      "graph_set_widget",
      "graph_enter_subgraph",
      "graph_set_widget",
      "graph_exit_subgraph",
    ]);
    expect(text).toMatch(/will NOT persist/);
    expect(text).toMatch(/pin rejected/);
    expect(text).not.toMatch(/control_after_generate_pinned/);
  });

  it("discloses an exit failure after a successful pin so the canvas is not silently left inside", async () => {
    const { text, isError, calls } = await setWidget(
      { node_id: 320, widget: "value_2", value: 1920 },
      { warning: REPORTER_WARNING, exitFails: true },
    );
    expect(isError).toBe(false);
    expect(calls.map((c) => c.cmd)).toContain("graph_exit_subgraph");
    expect(text).toMatch(/control_after_generate_pinned/);
    expect(text).toMatch(/panel_exit_subgraph then FAILED/);
    expect(text).toMatch(/Call panel_exit_subgraph/);
    expect(text).not.toMatch(/will NOT persist/);
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
