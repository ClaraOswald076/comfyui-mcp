// #1655 — a widget the panel lists as promoted must be settable.
//
// The panel's graph_set_widget can refuse:
//
//   Cannot set widget on subgraph node 78: "width" is not a promoted widget
//   on this subgraph (promoted: width, height, seed, …)
//
// That is a listing-vs-lookup contradiction (widgets[] vs host inputs), not a
// genuine miss. panel_set_widget must resolve the displayed name to the unique
// inner widget and write it there, then leave the subgraph.
//
// These tests drive the SHIPPED handler (and the parse/resolve helpers it uses).
// A first-write success is untouched. A genuine miss (name not in the listed
// set) is never retried. An ambiguous or truncated inner mapping is never guessed.

import { describe, expect, it } from "vitest";

import {
  buildPanelToolDefs,
  makePanelToolCtx,
  type PanelToolCtx,
  type ToolResult,
} from "../../orchestrator/panel-tools.js";
import {
  isContradictoryPromotedWidgetRefusal,
  matchListedName,
  parseAmbiguousPromotedWidgetRefusal,
  parseContradictoryPromotedWidgetRefusal,
  parseSubgraphScopeRefusal,
  resolveInnerPromotedTarget,
} from "../../orchestrator/promoted-widget.js";
import { WorkflowTargetStore } from "../../services/workflow-target-store.js";

const TAB = "wf:krea2";

const CONTRADICTORY =
  `Cannot set widget on subgraph node 78: "width" is not a promoted widget on this subgraph ` +
  `(promoted: width, height, seed, control_after_generate, steps, cfg, sampler_name, scheduler, denoise, batch_size).`;

const AMBIGUOUS =
  `promoted widget "text" is ambiguous - 2 promoted inputs match; refusing to guess.`;

const SCOPE_REFUSAL =
  `No node with id 188 in the current graph. Node 188 lives INSIDE a subgraph — ` +
  `"New Subgraph" (node 190) — and the write applies there. ` +
  `Enter it (panel_enter_subgraph(190)), then retry.`;

const SUBGRAPH = {
  subgraph_of: { node_id: 78, title: "Krea2" },
  instance_widgets: { width: 1920, height: 1080, seed: 1, steps: 20 },
  node_count: 2,
  nodes: [
    { id: 76, type: "EmptyLatentImage", widgets: { width: 1920, height: 1080, batch_size: 1 } },
    { id: 75, type: "KSampler", widgets: { seed: 1, steps: 20, cfg: 1, sampler_name: "euler" } },
  ],
};

type Outcome = "contradict" | "ok" | "fail";

function bridge(opts: {
  firstWrite?: Outcome;
  remappedWrite?: Outcome;
  innerWrite?: Outcome;
  subgraph?: Record<string, unknown> | Error;
  enterFails?: boolean;
  exitFails?: boolean;
  ambiguous?: boolean;
  scopeLost?: boolean;
  promotedDetail?: Record<string, unknown>;
}) {
  const calls: Array<Record<string, unknown>> = [];
  let writes = 0;
  const b = {
    send: async (cmd: Record<string, unknown>) => {
      calls.push({ ...cmd });
      if (cmd.cmd === "graph_set_widget") {
        writes += 1;
        if (writes === 1 && opts.ambiguous) throw new Error(AMBIGUOUS);
        if (writes === 1 && opts.scopeLost) throw new Error(SCOPE_REFUSAL);
        const which =
          writes === 1
            ? (opts.firstWrite ?? "contradict")
            : opts.scopeLost
              ? (opts.innerWrite ?? "ok")
            : Number(cmd.node_id) === 76 || cmd.node_id === "76"
              ? (opts.innerWrite ?? "ok")
              : (opts.remappedWrite ?? "contradict");
        if (which === "contradict") throw new Error(CONTRADICTORY);
        if (which === "fail") throw new Error("inner write rejected");
        return { set: { node_id: cmd.node_id, widget: cmd.widget, value: cmd.value } };
      }
      if (cmd.cmd === "graph_get_subgraph") {
        if (opts.subgraph instanceof Error) throw opts.subgraph;
        return opts.subgraph ?? SUBGRAPH;
      }
      if (cmd.cmd === "graph_enter_subgraph") {
        if (opts.enterFails) throw new Error("could not enter subgraph 78");
        return { scope: "subgraph", node_id: cmd.node_id };
      }
      if (cmd.cmd === "graph_exit_subgraph") {
        if (opts.exitFails) throw new Error("could not confirm exit");
        return { scope: "root" };
      }
      if (cmd.cmd === "graph_query") {
        return (
          opts.promotedDetail ?? {
            nodes: [
              {
                id: 190,
                inputs: [
                  { slot: 0, name: "text" },
                  { slot: 1, name: "text_1", label: "text" },
                ],
              },
            ],
          }
        );
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

describe("parseContradictoryPromotedWidgetRefusal", () => {
  it("the reporter's error is contradictory — width is listed as promoted", () => {
    const parsed = parseContradictoryPromotedWidgetRefusal(CONTRADICTORY, "width");
    expect(parsed).toEqual({
      nodeId: "78",
      widget: "width",
      listed: [
        "width",
        "height",
        "seed",
        "control_after_generate",
        "steps",
        "cfg",
        "sampler_name",
        "scheduler",
        "denoise",
        "batch_size",
      ],
    });
    expect(isContradictoryPromotedWidgetRefusal(CONTRADICTORY, "width")).toBe(true);
  });

  it("a genuine miss (name NOT in the listed set) is not contradictory", () => {
    const text =
      `Cannot set widget on subgraph node 78: "foo" is not a promoted widget on this subgraph ` +
      `(promoted: width, height, seed).`;
    expect(parseContradictoryPromotedWidgetRefusal(text, "foo")).toBeNull();
    expect(isContradictoryPromotedWidgetRefusal(text, "foo")).toBe(false);
  });

  it("promoted: none is never contradictory", () => {
    const text =
      `Cannot set widget on subgraph node 78: "width" is not a promoted widget on this subgraph ` +
      `(promoted: none).`;
    expect(parseContradictoryPromotedWidgetRefusal(text, "width")).toBeNull();
  });

  it("an unrelated failure is never contradictory", () => {
    expect(
      parseContradictoryPromotedWidgetRefusal("No node with id 78 in the current graph", "width"),
    ).toBeNull();
  });

  it("a unique case-insensitive listed name still matches", () => {
    expect(matchListedName("Width", ["width", "height"])).toBe("width");
    const parsed = parseContradictoryPromotedWidgetRefusal(CONTRADICTORY, "Width");
    expect(parsed?.widget).toBe("width");
  });

  it("parses the promoted name/label ambiguity without selecting a target", () => {
    expect(parseAmbiguousPromotedWidgetRefusal(AMBIGUOUS, "text", 190)).toEqual({
      nodeId: "190",
      widget: "text",
      matches: 2,
    });
    expect(parseAmbiguousPromotedWidgetRefusal(AMBIGUOUS, "steps")).toBeNull();
  });

  it("parses only the panel-provided enter route from a lost-scope refusal", () => {
    expect(parseSubgraphScopeRefusal(SCOPE_REFUSAL, 188)).toEqual({
      nodeId: "188",
      enterPath: ["190"],
    });
    expect(parseSubgraphScopeRefusal(SCOPE_REFUSAL, 189)).toBeNull();
    expect(parseSubgraphScopeRefusal("No node with id 188 in the current graph", 188)).toBeNull();
  });
});

describe("resolveInnerPromotedTarget", () => {
  it("maps width to the unique EmptyLatentImage inner node", () => {
    expect(resolveInnerPromotedTarget(SUBGRAPH, "width")).toEqual({
      innerNodeId: 76,
      widget: "width",
    });
  });

  it("maps seed to the unique KSampler inner node", () => {
    expect(resolveInnerPromotedTarget(SUBGRAPH, "seed")).toEqual({
      innerNodeId: 75,
      widget: "seed",
    });
  });

  it("refuses to guess when two inners share the widget name", () => {
    const ambiguous = {
      ...SUBGRAPH,
      nodes: [
        { id: 76, widgets: { width: 1920 } },
        { id: 99, widgets: { width: 512 } },
      ],
    };
    expect(resolveInnerPromotedTarget(ambiguous, "width")).toBeNull();
  });

  it("refuses to guess from a truncated inner list", () => {
    expect(resolveInnerPromotedTarget({ ...SUBGRAPH, truncated: true }, "width")).toBeNull();
  });

  it("returns null when no inner node owns the widget", () => {
    expect(resolveInnerPromotedTarget(SUBGRAPH, "denoise")).toBeNull();
  });
});

describe("panel_set_widget promoted-subgraph recovery (#1655)", () => {
  it("reports ambiguous promoted name/label candidates without a second write (#2015)", async () => {
    const { text, isError, calls } = await setWidget(
      { node_id: 190, widget: "text", value: "hello" },
      {
        ambiguous: true,
        promotedDetail: {
          nodes: [
            {
              id: 190,
              inputs: [
                { slot: 1, name: "text" },
                { slot: 2, name: "text_1", label: "text" },
              ],
            },
          ],
        },
      },
    );

    expect(isError).toBe(true);
    expect(calls.map((c) => c.cmd)).toEqual(["graph_set_widget", "graph_query"]);
    expect(text).toMatch(/slot:1, name:"text", label:null/);
    expect(text).toMatch(/slot:2, name:"text_1", label:"text"/);
    expect(text).toMatch(/no second write was attempted/i);
  });

  it("re-enters the panel-provided scope and retries the inner write once (#2015)", async () => {
    const { text, isError, calls } = await setWidget(
      { node_id: 188, widget: "text", value: "hello" },
      { scopeLost: true },
    );

    expect(isError).toBe(false);
    expect(calls.map((c) => c.cmd)).toEqual([
      "graph_set_widget",
      "graph_enter_subgraph",
      "graph_set_widget",
    ]);
    expect(calls[1]).toMatchObject({ node_id: "190" });
    expect(calls[2]).toMatchObject({ node_id: 188, widget: "text", value: "hello" });
    expect(text).toMatch(/route was re-entered and the write was retried once/i);
  });

  it("the reporter's case: refuse → get_subgraph → enter → set inner → exit", async () => {
    const { text, isError, calls } = await setWidget({ node_id: 78, widget: "width", value: 1024 });

    expect(isError).toBe(false);
    expect(calls.map((c) => c.cmd)).toEqual([
      "graph_set_widget",
      "graph_get_subgraph",
      "graph_enter_subgraph",
      "graph_set_widget",
      "graph_exit_subgraph",
    ]);
    expect(calls[0]).toMatchObject({ node_id: 78, widget: "width", value: 1024 });
    expect(calls[3]).toMatchObject({ node_id: 76, widget: "width", value: 1024 });
    expect(text).toMatch(/inner widget this promotion lists: node 76 "width"/);
    expect(text).not.toMatch(/is not a promoted widget/);
  });

  it("a healthy write is untouched — one call, no enter", async () => {
    const { isError, calls } = await setWidget(
      { node_id: 3, widget: "steps", value: 20 },
      { firstWrite: "ok" },
    );
    expect(isError).toBe(false);
    expect(calls.map((c) => c.cmd)).toEqual(["graph_set_widget"]);
  });

  it("a genuine miss is never retried", async () => {
    const { b, calls } = bridge({ firstWrite: "ok" });
    const failing = {
      ...(b as object),
      send: async (cmd: Record<string, unknown>) => {
        calls.push({ ...cmd });
        throw new Error(
          `Cannot set widget on subgraph node 78: "foo" is not a promoted widget on this subgraph ` +
            `(promoted: width, height, seed).`,
        );
      },
    } as unknown as PanelToolCtx["bridge"];
    const ctx = makePanelToolCtx(failing, TAB, new WorkflowTargetStore());
    const def = buildPanelToolDefs().find((d) => d.name === "panel_set_widget");
    if (!def) throw new Error("panel_set_widget is not registered");
    const res = await def.handler({ node_id: 78, widget: "foo", value: 1 } as never, ctx);

    expect(res.isError).toBe(true);
    expect(calls.filter((c) => c.cmd === "graph_set_widget")).toHaveLength(1);
    expect(calls.map((c) => c.cmd)).not.toContain("graph_get_subgraph");
    expect(calls.map((c) => c.cmd)).not.toContain("graph_enter_subgraph");
  });

  it("an UNRELATED failure is never retried", async () => {
    const { isError, calls } = await setWidget(
      { node_id: 78, widget: "width", value: 1024 },
      { firstWrite: "fail" },
    );
    expect(isError).toBe(true);
    expect(calls.map((c) => c.cmd)).toEqual(["graph_set_widget"]);
  });

  it("an ambiguous inner mapping is not guessed", async () => {
    const { text, isError, calls } = await setWidget(
      { node_id: 78, widget: "width", value: 1024 },
      {
        subgraph: {
          node_count: 2,
          nodes: [
            { id: 76, widgets: { width: 1920 } },
            { id: 99, widgets: { width: 512 } },
          ],
        },
      },
    );
    expect(isError).toBe(true);
    expect(text).toMatch(/is not a promoted widget/);
    expect(text).toMatch(/did not uniquely identify/);
    expect(calls.map((c) => c.cmd)).toEqual(["graph_set_widget", "graph_get_subgraph"]);
    expect(calls.map((c) => c.cmd)).not.toContain("graph_enter_subgraph");
  });

  it("a truncated subgraph read is not treated as unique", async () => {
    const { text, isError, calls } = await setWidget(
      { node_id: 78, widget: "width", value: 1024 },
      { subgraph: { ...SUBGRAPH, truncated: true } },
    );
    expect(isError).toBe(true);
    expect(text).toMatch(/did not uniquely identify/);
    expect(calls.map((c) => c.cmd)).not.toContain("graph_enter_subgraph");
  });

  it("a failed subgraph read keeps the original refusal", async () => {
    const { text, isError, calls } = await setWidget(
      { node_id: 78, widget: "width", value: 1024 },
      { subgraph: new Error("Node 78 is not a subgraph") },
    );
    expect(isError).toBe(true);
    expect(text).toMatch(/is not a promoted widget/);
    expect(text).toMatch(/graph_get_subgraph FAILED/);
    expect(calls.map((c) => c.cmd)).toEqual(["graph_set_widget", "graph_get_subgraph"]);
  });

  it("always exits after a successful inner write, and discloses an exit failure", async () => {
    const { text, isError, calls } = await setWidget(
      { node_id: 78, widget: "width", value: 1024 },
      { exitFails: true },
    );
    expect(isError).toBe(false);
    expect(calls.map((c) => c.cmd)).toContain("graph_exit_subgraph");
    expect(text).toMatch(/inner widget this promotion lists/);
    expect(text).toMatch(/panel_exit_subgraph then FAILED/);
    expect(text).toMatch(/Call panel_exit_subgraph/);
  });

  it("exits even when the inner write fails, and keeps the original refusal", async () => {
    const { text, isError, calls } = await setWidget(
      { node_id: 78, widget: "width", value: 1024 },
      { innerWrite: "fail" },
    );
    expect(isError).toBe(true);
    expect(calls.map((c) => c.cmd)).toEqual([
      "graph_set_widget",
      "graph_get_subgraph",
      "graph_enter_subgraph",
      "graph_set_widget",
      "graph_exit_subgraph",
    ]);
    expect(text).toMatch(/is not a promoted widget/);
    expect(text).toMatch(/Tried the inner mapping node 76 "width"/);
    expect(text).toMatch(/inner write rejected/);
  });

  it("retries the listed spelling on the wrapper when only the case differed", async () => {
    const { text, isError, calls } = await setWidget(
      { node_id: 78, widget: "Width", value: 1024 },
      { remappedWrite: "ok" },
    );
    expect(isError).toBe(false);
    expect(calls.map((c) => c.cmd)).toEqual(["graph_set_widget", "graph_set_widget"]);
    expect(calls[0]).toMatchObject({ widget: "Width" });
    expect(calls[1]).toMatchObject({ node_id: 78, widget: "width", value: 1024 });
    expect(text).not.toMatch(/is not a promoted widget/);
  });
});
