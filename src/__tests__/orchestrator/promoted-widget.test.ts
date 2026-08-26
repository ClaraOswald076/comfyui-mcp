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
// A first-write success stays successful for safe or unprovable mappings. A genuine
// miss (name not in the listed set) is never retried. An ambiguous or truncated inner
// mapping is never guessed.

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
  validatePromotedSubgraphEnvelope,
} from "../../orchestrator/promoted-widget.js";
import { WorkflowTargetStore } from "../../services/workflow-target-store.js";

const TAB = "wf:krea2";

const CONTRADICTORY =
  `Cannot set widget on subgraph node 78: "width" is not a promoted widget on this subgraph ` +
  `(promoted: width, height, seed, control_after_generate, steps, cfg, sampler_name, scheduler, denoise, batch_size).`;

const STACK_DATA_CONTRADICTORY =
  `Cannot set widget on subgraph node 78: "stack_data" is not a promoted widget on this subgraph ` +
  `(promoted: stack_data).`;

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
  stackDataIdentity?: Record<string, unknown>;
  stackDataInnerIdentity?: Record<string, unknown> | null;
  /** #2299: graph_query detail keyed by the id the call asked for, so the outer
   *  probe (which cannot prove the dynamic-combo shape) and the post-enter inner
   *  probe (which can) return different rows. */
  detailById?: Record<string, unknown>;
  /** #2305: the contradictory refusal the FIRST write throws, for a promoted
   *  widget that is not #2299's `model.prompt`. Wins over the default above so
   *  the recovery resolves the name under test. */
  firstWriteError?: string;
  /** #2314: make the first subgraph read unavailable so a recovery test can
   *  continue into the existing post-refusal retry branch. */
  preflightSubgraph?: Record<string, unknown> | Error;
  recoveryPreflightSubgraph?: Record<string, unknown> | Error;
  subgraphAfterEnter?: Record<string, unknown> | Error;
  objectInfoRefusal?: boolean;
  refreshNodes?: Record<string, unknown>;
  remappedWriteError?: string;
  reconnectBeforeWrite?: boolean;
  tabRebindBeforeWrite?: boolean;
}) {
  const calls: Array<Record<string, unknown>> = [];
  let writes = 0;
  let subgraphReads = 0;
  let inSubgraph = false;
  let connectionIdentity = { generation: 1, tabSessionId: "browser-tab-a" };
  const beforeWrite = { mutate: undefined as (() => void) | undefined };
  const b = {
    send: async (
      cmd: Record<string, unknown>,
      sendOpts?: { beforeDispatch?: () => void },
    ) => {
      if (cmd.cmd === "graph_set_widget" && sendOpts?.beforeDispatch) {
        const mutation = beforeWrite.mutate;
        beforeWrite.mutate = undefined;
        mutation?.();
        sendOpts.beforeDispatch();
      }
      calls.push({ ...cmd });
      if (cmd.cmd === "graph_set_widget") {
        writes += 1;
        if (writes === 1 && opts.ambiguous) throw new Error(AMBIGUOUS);
        if (writes === 1 && opts.scopeLost) throw new Error(SCOPE_REFUSAL);
        if (writes === 1 && opts.stackDataIdentity && opts.firstWrite !== "ok") {
          throw new Error(STACK_DATA_CONTRADICTORY);
        }
        if (writes === 1 && opts.objectInfoRefusal) {
          throw new Error("no usable /object_info was available for this widget write");
        }
        if (writes === 1 && opts.firstWriteError) throw new Error(opts.firstWriteError);
        if (writes === 2 && opts.remappedWriteError) throw new Error(opts.remappedWriteError);
        if (
          writes === 1 &&
          opts.detailById &&
          opts.firstWrite !== "ok" &&
          !opts.firstWriteError
        ) {
          throw new Error(DYNAMIC_CHILD_CONTRADICTORY);
        }
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
        subgraphReads += 1;
        if (subgraphReads === 1 && opts.preflightSubgraph !== undefined) {
          if (opts.preflightSubgraph instanceof Error) throw opts.preflightSubgraph;
          return opts.preflightSubgraph;
        }
        if (subgraphReads === 2 && opts.recoveryPreflightSubgraph !== undefined) {
          if (opts.recoveryPreflightSubgraph instanceof Error) throw opts.recoveryPreflightSubgraph;
          return opts.recoveryPreflightSubgraph;
        }
        if (inSubgraph && opts.subgraphAfterEnter !== undefined) {
          if (opts.subgraphAfterEnter instanceof Error) throw opts.subgraphAfterEnter;
          return opts.subgraphAfterEnter;
        }
        if (opts.subgraph instanceof Error) throw opts.subgraph;
        return opts.subgraph ?? SUBGRAPH;
      }
      if (cmd.cmd === "graph_enter_subgraph") {
        if (opts.enterFails) throw new Error("could not enter subgraph 78");
        inSubgraph = true;
        return { scope: "subgraph", node_id: cmd.node_id };
      }
      if (cmd.cmd === "graph_exit_subgraph") {
        if (opts.exitFails) throw new Error("could not confirm exit");
        inSubgraph = false;
        return { scope: "root" };
      }
      if (cmd.cmd === "graph_query") {
        const wantId = Array.isArray(cmd.ids) && cmd.ids.length ? String(cmd.ids[0]) : null;
        if (opts.detailById && wantId && opts.detailById[wantId] !== undefined) {
          return opts.detailById[wantId];
        }
        if (opts.stackDataIdentity && !inSubgraph) return opts.stackDataIdentity;
        if (opts.stackDataIdentity && inSubgraph) {
          return opts.stackDataInnerIdentity ?? { nodes: [{ id: 76, type: "OtherLoraLoader" }] };
        }
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
      if (cmd.cmd === "refresh_nodes") return opts.refreshNodes ?? { refreshed: true };
      return { ok: true };
    },
    push: () => 1,
    canReach: () => true,
    isHeadless: () => false,
    tabs: () => [{ tab_id: TAB, title: "wf", connected_at: 0 }],
    resolveActiveTabId: () => TAB,
    tabCanMutateGraph: () => true,
    tabConnectionIdentity: () => connectionIdentity,
    tabExpectedNodeTypeFenceCapability: () => true,
    tabGraphMutationCapability: () => ({ known: true, canMutate: true }),
  } as unknown as PanelToolCtx["bridge"];
  if (opts.reconnectBeforeWrite) {
    beforeWrite.mutate = () => {
      // The same browser tab returns after a reconnect: its session id is
      // stable, but the connection generation advances.
      connectionIdentity = { generation: 2, tabSessionId: "browser-tab-a" };
    };
  } else if (opts.tabRebindBeforeWrite) {
    beforeWrite.mutate = () => {
      // A second browser tab for the same workflow keeps the workflow route
      // but has a different receiver session.
      connectionIdentity = { generation: 1, tabSessionId: "browser-tab-b" };
    };
  }
  return { b, calls, beforeWrite };
}

async function setWidget(
  args: { node_id: number | string; widget: string; value: number | string },
  opts: Parameters<typeof bridge>[0] = {},
) {
  const { b, calls, beforeWrite } = bridge(opts);
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

// #2299 — a COMFY_DYNAMICCOMBO_V3 child promoted out of a subgraph. The write is
// refused as "not promoted", recovery enters the subgraph and retries on the INNER
// node — a node no pre-write guard ever probed.
const DYNAMIC_CHILD_CONTRADICTORY =
  `Cannot set widget on subgraph node 78: "model.prompt" is not a promoted widget on this subgraph ` +
  `(promoted: model.prompt).`;

const DYNAMIC_SUBGRAPH = {
  subgraph_of: { node_id: 78, title: "H3" },
  instance_widgets: { "model.prompt": "" },
  node_count: 1,
  nodes: [
    {
      id: 76,
      type: "MinimaxHailuo03TextToVideoNode",
      widgets: { model: "text-to-video", "model.prompt": "" },
      inputs: [
        { name: "model", type: "COMFY_DYNAMICCOMBO_V3" },
        { name: "model.prompt", type: "STRING" },
      ],
    },
  ],
};

// Only the INNER node carries both halves of the shape. The container exposes the
// promoted child but not the `model` parent, so id 190 here stands in for an outer
// probe that cannot prove it and must fall open.
const DYNAMIC_DETAIL_BY_ID = {
  "78": { nodes: [{ id: 190, inputs: [{ slot: 0, name: "model.prompt" }] }] },
  "76": {
    nodes: [
      {
        id: 76,
        type: "MinimaxHailuo03TextToVideoNode",
        widgets: { model: "text-to-video", "model.prompt": "" },
        inputs: [
          { name: "model", type: "COMFY_DYNAMICCOMBO_V3" },
          { name: "model.prompt", type: "STRING" },
        ],
      },
    ],
  },
};

describe("panel_set_widget promoted inner dynamic-combo child (#2299)", () => {
  it("refuses the inner write instead of reporting a false success", async () => {
    const { text, isError, calls } = await setWidget(
      { node_id: 78, widget: "model.prompt", value: "a long prompt" },
      {
        firstWrite: "contradict",
        firstWriteError: DYNAMIC_CHILD_CONTRADICTORY,
        subgraph: DYNAMIC_SUBGRAPH,
        detailById: DYNAMIC_DETAIL_BY_ID,
        preflightSubgraph: new Error("preflight unavailable"),
      },
    );
    expect(isError).toBe(true);
    expect(text).toContain("dynamic-combo");
    expect(text).toContain("No inner graph_set_widget was dispatched");
    // The recovery entered the subgraph and left it again...
    expect(calls.some((c) => c.cmd === "graph_enter_subgraph")).toBe(true);
    expect(calls.some((c) => c.cmd === "graph_exit_subgraph")).toBe(true);
    // ...and the INNER node was never written. Only the outer attempt happened.
    const writes = calls.filter((c) => c.cmd === "graph_set_widget");
    expect(writes.every((c) => String(c.node_id) !== "76")).toBe(true);
  });

  it("still applies a promoted inner write when the inner node is NOT a dynamic combo", async () => {
    const { isError, calls } = await setWidget(
      { node_id: 78, widget: "model.prompt", value: "a long prompt" },
      {
        firstWrite: "contradict",
        firstWriteError: DYNAMIC_CHILD_CONTRADICTORY,
        innerWrite: "ok",
        preflightSubgraph: new Error("preflight unavailable"),
        subgraph: {
          ...DYNAMIC_SUBGRAPH,
          nodes: [
            {
              id: 76,
              type: "OrdinaryNode",
              widgets: { "model.prompt": "" },
              inputs: [
                { name: "model", type: "STRING" },
                { name: "model.prompt", type: "STRING" },
              ],
            },
          ],
        },
        detailById: {
          "78": DYNAMIC_DETAIL_BY_ID["78"],
          // Same dotted name, ordinary STRING parent — not the #2299 shape.
          "76": {
            nodes: [
              {
                id: 76,
                type: "OrdinaryNode",
                widgets: { "model.prompt": "" },
                inputs: [
                  { name: "model", type: "STRING" },
                  { name: "model.prompt", type: "STRING" },
                ],
              },
            ],
          },
        },
      },
    );
    expect(isError).toBe(false);
    const writes = calls.filter((c) => c.cmd === "graph_set_widget");
    expect(writes.some((c) => String(c.node_id) === "76")).toBe(true);
  });
});

// #2305 — an LC123 regional-canvas prompt widget promoted out of a subgraph. The
// outer #1658 guard probed the CONTAINER, which is never one of the regional-canvas
// types, so it fell open; the write is refused as "not promoted", and recovery
// retries on the INNER node — the node whose custom JS owns the prompt.
const ANIMA_CONTRADICTORY =
  `Cannot set widget on subgraph node 78: "quality_prompt" is not a promoted widget on this ` +
  `subgraph (promoted: quality_prompt, scene_prompt).`;

const ANIMA_SUBGRAPH = {
  subgraph_of: { node_id: 78, title: "Regional" },
  instance_widgets: { quality_prompt: "", scene_prompt: "" },
  node_count: 1,
  nodes: [
    {
      id: 76,
      type: "AnimaRegionalCanvasInline",
      widgets: { quality_prompt: "", scene_prompt: "" },
    },
  ],
};

/** The outer probe sees the container's own type and must fall open; only the
 *  inner row names a regional-canvas node. */
const ANIMA_IDENTITY_BY_ID = {
  "78": { nodes: [{ id: 78, type: "SubgraphNode" }] },
  "76": { nodes: [{ id: 76, type: "AnimaRegionalCanvasInline" }] },
};

describe("panel_set_widget promoted inner LC123 regional prompt (#2305)", () => {
  it("refuses the inner write instead of reporting a false success", async () => {
    const { text, isError, calls } = await setWidget(
      { node_id: 78, widget: "quality_prompt", value: "masterpiece, best quality" },
      {
        firstWrite: "contradict",
        firstWriteError: ANIMA_CONTRADICTORY,
        subgraph: ANIMA_SUBGRAPH,
        detailById: ANIMA_IDENTITY_BY_ID,
        preflightSubgraph: new Error("preflight unavailable"),
      },
    );
    expect(isError).toBe(true);
    expect(text).toContain("LC123 regional-canvas prompt");
    // The real #1658 refusal body, not a lookalike message.
    expect(text).toContain("AnimaRegionalCanvasInline");
    expect(text).toContain("animaPrompts");
    expect(text).toContain("No inner graph_set_widget was dispatched");
    // The recovery entered the subgraph and left it again...
    expect(calls.some((c) => c.cmd === "graph_enter_subgraph")).toBe(true);
    expect(calls.some((c) => c.cmd === "graph_exit_subgraph")).toBe(true);
    // ...the guard was re-probed against the INNER id, not the container...
    expect(
      calls.some(
        (c) =>
          c.cmd === "graph_query" &&
          Array.isArray(c.ids) &&
          String((c.ids as unknown[])[0]) === "76",
      ),
    ).toBe(true);
    // ...and the INNER node was never written. Only the outer attempt happened.
    const writes = calls.filter((c) => c.cmd === "graph_set_widget");
    expect(writes.every((c) => String(c.node_id) !== "76")).toBe(true);
  });

  it("still applies a promoted inner write when the inner node is NOT a regional canvas", async () => {
    const { isError, calls } = await setWidget(
      { node_id: 78, widget: "quality_prompt", value: "masterpiece, best quality" },
      {
        firstWrite: "contradict",
        firstWriteError: ANIMA_CONTRADICTORY,
        innerWrite: "ok",
        preflightSubgraph: new Error("preflight unavailable"),
        subgraph: {
          ...ANIMA_SUBGRAPH,
          nodes: [
            { id: 76, type: "PrimitiveStringMultiline", widgets: { quality_prompt: "" } },
          ],
        },
        detailById: {
          "78": ANIMA_IDENTITY_BY_ID["78"],
          // Same widget name, ordinary node — not the #1658 shape.
          "76": { nodes: [{ id: 76, type: "PrimitiveStringMultiline" }] },
        },
      },
    );
    expect(isError).toBe(false);
    const writes = calls.filter((c) => c.cmd === "graph_set_widget");
    expect(writes.some((c) => String(c.node_id) === "76")).toBe(true);
  });
});

const SAFE_ANIMA_SUBGRAPH = {
  subgraph_of: { node_id: 78, title: "Container" },
  node_count: 1,
  nodes: [{ id: 76, type: "PrimitiveStringMultiline", widgets: { quality_prompt: "old" } }],
};

const SAFE_ANIMA_IDENTITY_BY_ID = {
  "78": ANIMA_IDENTITY_BY_ID["78"],
  "76": { nodes: [{ id: 76, type: "PrimitiveStringMultiline" }] },
};

describe("panel_set_widget promoted container success guards (#2314)", () => {
  it.each([
    [
      "Anima regional prompt",
      "quality_prompt",
      "masterpiece",
      ANIMA_SUBGRAPH,
      ANIMA_IDENTITY_BY_ID,
      undefined,
      /animaPrompts/,
    ],
    [
      "dynamic-combo STRING child",
      "model.prompt",
      "a long prompt",
      DYNAMIC_SUBGRAPH,
      DYNAMIC_DETAIL_BY_ID,
      undefined,
      /dynamic-combo (?:sub-widget|child)/,
    ],
    [
      "DaSiWa stack",
      "stack_data",
      "NEW",
      {
        subgraph_of: { node_id: 78, title: "Container" },
        node_count: 1,
        nodes: [{ id: 76, type: "DaSiWa_LTX2LoraLoader", widgets: { stack_data: "old" } }],
      },
      undefined,
      {
        stackDataIdentity: { nodes: [{ id: 78, type: "OtherLoraLoader" }] },
        stackDataInnerIdentity: { nodes: [{ id: 76, type: "DaSiWa_LTX2LoraLoader" }] },
      },
      /DaSiWa_LTX2LoraLoader/,
    ],
  ] as const)("refuses %s before a successful container write", async (
    _name,
    widget,
    value,
    subgraph,
    probe,
    stack,
    message,
  ) => {
    const { text, isError, calls } = await setWidget(
      { node_id: 78, widget, value },
      {
        firstWrite: "ok",
        subgraph,
        ...(probe ? { detailById: probe } : {}),
        ...(stack ?? {}),
      },
    );
    expect(isError).toBe(true);
    expect(text).toMatch(message);
    expect(calls.map((c) => c.cmd)).toContain("graph_get_subgraph");
    if (widget === "stack_data") {
      expect(calls.map((c) => c.cmd)).toContain("graph_enter_subgraph");
      expect(calls.map((c) => c.cmd)).toContain("graph_exit_subgraph");
    }
    expect(calls.filter((c) => c.cmd === "graph_set_widget")).toHaveLength(0);
  });

  it.each([
    ["Anima regional prompt", "quality_prompt", SAFE_ANIMA_SUBGRAPH, SAFE_ANIMA_IDENTITY_BY_ID],
    [
      "dynamic-combo STRING child",
      "model.prompt",
      {
        ...DYNAMIC_SUBGRAPH,
        nodes: [
          {
            id: 76,
            type: "OrdinaryNode",
            widgets: { "model.prompt": "old" },
            inputs: [
              { name: "model", type: "STRING" },
              { name: "model.prompt", type: "STRING" },
            ],
          },
        ],
      },
      {
        "78": DYNAMIC_DETAIL_BY_ID["78"],
        "76": {
          nodes: [
            {
              id: 76,
              type: "OrdinaryNode",
              widgets: { "model.prompt": "old" },
              inputs: [
                { name: "model", type: "STRING" },
                { name: "model.prompt", type: "STRING" },
              ],
            },
          ],
        },
      },
    ],
    [
      "DaSiWa stack",
      "stack_data",
      {
        subgraph_of: { node_id: 78, title: "Container" },
        node_count: 1,
        nodes: [{ id: 76, type: "OtherLoraLoader", widgets: { stack_data: "old" } }],
      },
      undefined,
    ],
  ] as const)("keeps a safe %s promoted write successful via the inner node", async (
    _name,
    widget,
    subgraph,
    probe,
  ) => {
    const stack = widget === "stack_data"
      ? {
          stackDataIdentity: { nodes: [{ id: 78, type: "OtherLoraLoader" }] },
          stackDataInnerIdentity: { nodes: [{ id: 76, type: "OtherLoraLoader" }] },
        }
      : {};
    const { isError, calls } = await setWidget(
      { node_id: 78, widget, value: "NEW" },
      {
        firstWrite: "ok",
        subgraph,
        ...(probe ? { detailById: probe } : {}),
        ...stack,
      },
    );
    expect(isError).toBe(false);
    expect(calls.some((c) => c.cmd === "graph_get_subgraph")).toBe(true);
    expect(calls.map((c) => c.cmd)).toContain("graph_enter_subgraph");
    expect(calls.map((c) => c.cmd)).toContain("graph_exit_subgraph");
    const writes = calls.filter((c) => c.cmd === "graph_set_widget");
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ node_id: 76, widget });
  });

  it("keeps a successful container write when promotion preflight is unavailable", async () => {
    const { isError, calls } = await setWidget(
      { node_id: 78, widget: "quality_prompt", value: "masterpiece" },
      {
        firstWrite: "ok",
        subgraph: new Error("graph_get_subgraph unavailable"),
      },
    );

    expect(isError).toBe(false);
    expect(calls.map((c) => c.cmd)).toEqual([
      "graph_query",
      "graph_get_subgraph",
      "graph_set_widget",
    ]);
  });

  it("refuses when the promotion relinks after classification", async () => {
    const { text, isError, calls } = await setWidget(
      { node_id: 78, widget: "quality_prompt", value: "masterpiece" },
      {
        firstWrite: "ok",
        // The first read classified a safe inner node; the confirmation read
        // observes a relink to the known-bad regional-canvas node.
        preflightSubgraph: SAFE_ANIMA_SUBGRAPH,
        subgraph: ANIMA_SUBGRAPH,
        detailById: ANIMA_IDENTITY_BY_ID,
      },
    );

    expect(isError).toBe(true);
    expect(text).toMatch(/mapping changed or became unverifiable|inner node type changed/);
    expect(calls.filter((c) => c.cmd === "graph_get_subgraph")).toHaveLength(2);
    expect(calls.filter((c) => c.cmd === "graph_set_widget")).toHaveLength(0);
    expect(calls.map((c) => c.cmd)).not.toContain("graph_enter_subgraph");
  });

  it.each([
    ["stale owner", { ...SAFE_ANIMA_SUBGRAPH, subgraph_of: { node_id: 79 } }],
    ["wrong node count", { ...SAFE_ANIMA_SUBGRAPH, node_count: 2 }],
  ])("refuses a %s envelope before writing the container", async (_name, subgraph) => {
    const { text, isError, calls } = await setWidget(
      { node_id: 78, widget: "quality_prompt", value: "masterpiece" },
      { firstWrite: "ok", subgraph },
    );

    expect(isError).toBe(true);
    expect(text).toMatch(/malformed, stale, or incomplete ownership envelope/);
    expect(calls.filter((c) => c.cmd === "graph_set_widget")).toHaveLength(0);
  });

  it("refuses when the bound panel reconnects before the inner dispatch", async () => {
    const { text, isError, calls } = await setWidget(
      { node_id: 78, widget: "quality_prompt", value: "masterpiece" },
      {
        firstWrite: "ok",
        subgraph: SAFE_ANIMA_SUBGRAPH,
        detailById: SAFE_ANIMA_IDENTITY_BY_ID,
        reconnectBeforeWrite: true,
      },
    );

    expect(isError).toBe(true);
    expect(text).toMatch(/session or connection changed|No graph_set_widget was dispatched/);
    expect(calls.filter((c) => c.cmd === "graph_set_widget")).toHaveLength(0);
    expect(calls).toEqual(expect.arrayContaining([{ cmd: "graph_exit_subgraph" }]));
  });

  it("refuses when the same-workflow panel tab is rebound before the inner dispatch", async () => {
    const { text, isError, calls } = await setWidget(
      { node_id: 78, widget: "quality_prompt", value: "masterpiece" },
      {
        firstWrite: "ok",
        subgraph: SAFE_ANIMA_SUBGRAPH,
        detailById: SAFE_ANIMA_IDENTITY_BY_ID,
        tabRebindBeforeWrite: true,
      },
    );

    expect(isError).toBe(true);
    expect(text).toMatch(/session or connection changed|No graph_set_widget was dispatched/);
    expect(calls.filter((c) => c.cmd === "graph_set_widget")).toHaveLength(0);
    expect(calls).toEqual(expect.arrayContaining([{ cmd: "graph_exit_subgraph" }]));
  });

  it("re-runs the guards for a case-only remapped container widget", async () => {
    const { text, isError, calls } = await setWidget(
      { node_id: 78, widget: "Quality_Prompt", value: "masterpiece" },
      {
        firstWrite: "contradict",
        firstWriteError: ANIMA_CONTRADICTORY,
        remappedWriteError: ANIMA_CONTRADICTORY,
        subgraph: ANIMA_SUBGRAPH,
        detailById: ANIMA_IDENTITY_BY_ID,
        preflightSubgraph: new Error("preflight unavailable"),
      },
    );

    expect(isError).toBe(true);
    expect(text).toContain("animaPrompts");
    const writes = calls.filter((c) => c.cmd === "graph_set_widget");
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ node_id: 78, widget: "Quality_Prompt" });
  });

  it("routes a successful case-only remapped retry through the inner plan", async () => {
    const { text, isError, calls } = await setWidget(
      { node_id: 78, widget: "Quality_Prompt", value: "masterpiece" },
      {
        firstWrite: "contradict",
        firstWriteError: ANIMA_CONTRADICTORY,
        preflightSubgraph: new Error("preflight unavailable"),
        subgraph: SAFE_ANIMA_SUBGRAPH,
        detailById: SAFE_ANIMA_IDENTITY_BY_ID,
      },
    );

    expect(isError).toBe(false);
    expect(text).toMatch(/validated promoted inner widget/);
    const writes = calls.filter((c) => c.cmd === "graph_set_widget");
    expect(writes).toHaveLength(2);
    expect(writes[0]).toMatchObject({ node_id: 78, widget: "Quality_Prompt" });
    expect(writes[1]).toMatchObject({ node_id: 76, widget: "quality_prompt" });
    expect(calls.filter((c) => c.cmd === "graph_set_widget" && c.node_id === 78)).toHaveLength(1);
  });

  it("routes a successful scope retry through the promoted inner guards", async () => {
    const { isError, calls } = await setWidget(
      { node_id: 188, widget: "quality_prompt", value: "masterpiece" },
      {
        scopeLost: true,
        preflightSubgraph: new Error("preflight unavailable"),
        subgraph: {
          ...SAFE_ANIMA_SUBGRAPH,
          subgraph_of: { node_id: 188, title: "Container" },
        },
        detailById: {
          "188": { nodes: [{ id: 188, type: "SubgraphNode" }] },
          "76": SAFE_ANIMA_IDENTITY_BY_ID["76"],
        },
      },
    );

    expect(isError).toBe(false);
    const writes = calls.filter((c) => c.cmd === "graph_set_widget");
    expect(writes).toHaveLength(2);
    expect(writes[0]).toMatchObject({ node_id: 188, widget: "quality_prompt" });
    expect(writes[1]).toMatchObject({ node_id: 76, widget: "quality_prompt" });
  });

  it("routes a successful object-info retry through the promoted inner guards", async () => {
    const { isError, calls } = await setWidget(
      { node_id: 78, widget: "quality_prompt", value: "masterpiece" },
      {
        firstWriteError: "no usable /object_info was available for this widget write",
        preflightSubgraph: new Error("preflight unavailable"),
        subgraph: SAFE_ANIMA_SUBGRAPH,
        detailById: SAFE_ANIMA_IDENTITY_BY_ID,
        refreshNodes: { refreshed: true },
      },
    );

    expect(isError).toBe(false);
    const writes = calls.filter((c) => c.cmd === "graph_set_widget");
    expect(writes).toHaveLength(2);
    expect(writes[0]).toMatchObject({ node_id: 78, widget: "quality_prompt" });
    expect(writes[1]).toMatchObject({ node_id: 76, widget: "quality_prompt" });
  });

  it("refuses a known-bad Anima write on an object-info retry", async () => {
    const { text, isError, calls } = await setWidget(
      { node_id: 78, widget: "quality_prompt", value: "masterpiece" },
      {
        firstWriteError: "no usable /object_info was available for this widget write",
        preflightSubgraph: new Error("preflight unavailable"),
        subgraph: ANIMA_SUBGRAPH,
        detailById: ANIMA_IDENTITY_BY_ID,
        refreshNodes: { refreshed: true },
      },
    );

    expect(isError).toBe(true);
    expect(text).toMatch(/animaPrompts/);
    expect(calls.filter((c) => c.cmd === "graph_set_widget")).toHaveLength(1);
  });

  it("refuses a known-bad dynamic child on a scope retry", async () => {
    const { text, isError, calls } = await setWidget(
      { node_id: 188, widget: "model.prompt", value: "a long prompt" },
      {
        scopeLost: true,
        preflightSubgraph: new Error("preflight unavailable"),
        subgraph: {
          ...DYNAMIC_SUBGRAPH,
          subgraph_of: { node_id: 188, title: "Container" },
        },
        detailById: {
          "188": { nodes: [{ id: 188, type: "SubgraphNode" }] },
          "76": DYNAMIC_DETAIL_BY_ID["76"],
        },
      },
    );

    expect(isError).toBe(true);
    expect(text).toMatch(/dynamic-combo/);
    expect(calls.filter((c) => c.cmd === "graph_set_widget")).toHaveLength(1);
  });

  it("refuses a known-bad DaSiWa write on a case-remap retry", async () => {
    const { text, isError, calls } = await setWidget(
      { node_id: 78, widget: "Stack_Data", value: "NEW" },
      {
        firstWriteError: STACK_DATA_CONTRADICTORY,
        preflightSubgraph: new Error("preflight unavailable"),
        subgraph: {
          subgraph_of: { node_id: 78, title: "Container" },
          node_count: 1,
          nodes: [{ id: 76, type: "DaSiWa_LTX2LoraLoader", widgets: { stack_data: "old" } }],
        },
        stackDataIdentity: { nodes: [{ id: 78, type: "OtherLoraLoader" }] },
        stackDataInnerIdentity: { nodes: [{ id: 76, type: "DaSiWa_LTX2LoraLoader" }] },
      },
    );

    expect(isError).toBe(true);
    expect(text).toMatch(/DaSiWa_LTX2LoraLoader/);
    expect(calls.filter((c) => c.cmd === "graph_set_widget")).toHaveLength(1);
  });

  it("refuses a promoted retry when the mapping relinks after enter", async () => {
    const { text, isError, calls } = await setWidget(
      { node_id: 78, widget: "quality_prompt", value: "masterpiece" },
      {
        firstWriteError: ANIMA_CONTRADICTORY,
        preflightSubgraph: new Error("preflight unavailable"),
        subgraph: SAFE_ANIMA_SUBGRAPH,
        subgraphAfterEnter: ANIMA_SUBGRAPH,
        detailById: SAFE_ANIMA_IDENTITY_BY_ID,
      },
    );

    expect(isError).toBe(true);
    expect(text).toMatch(/mapping changed or became unverifiable|type changed after entering/);
    expect(calls.filter((c) => c.cmd === "graph_set_widget")).toHaveLength(1);
  });

  it("refuses the legacy recovery when its post-enter mapping relinks", async () => {
    const { text, isError, calls } = await setWidget(
      { node_id: 78, widget: "quality_prompt", value: "masterpiece" },
      {
        firstWriteError: ANIMA_CONTRADICTORY,
        preflightSubgraph: new Error("preflight unavailable"),
        recoveryPreflightSubgraph: new Error("recovery preflight unavailable"),
        subgraph: SAFE_ANIMA_SUBGRAPH,
        subgraphAfterEnter: ANIMA_SUBGRAPH,
        detailById: SAFE_ANIMA_IDENTITY_BY_ID,
      },
    );

    expect(isError).toBe(true);
    expect(text).toMatch(/mapping changed or became unverifiable|type changed after entering/);
    expect(calls.filter((c) => c.cmd === "graph_set_widget")).toHaveLength(1);
  });

});

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
    expect(resolveInnerPromotedTarget(SUBGRAPH, "width", 78)).toEqual({
      innerNodeId: 76,
      widget: "width",
    });
  });

  it("maps seed to the unique KSampler inner node", () => {
    expect(resolveInnerPromotedTarget(SUBGRAPH, "seed", 78)).toEqual({
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
    expect(resolveInnerPromotedTarget(ambiguous, "width", 78)).toBeNull();
  });

  it("refuses to guess from a truncated inner list", () => {
    expect(resolveInnerPromotedTarget({ ...SUBGRAPH, truncated: true }, "width", 78)).toBeNull();
  });

  it("returns null when no inner node owns the widget", () => {
    expect(resolveInnerPromotedTarget(SUBGRAPH, "denoise", 78)).toBeNull();
  });

  it("rejects an envelope owned by a different outer node", () => {
    expect(
      validatePromotedSubgraphEnvelope(
        { ...SUBGRAPH, subgraph_of: { node_id: 79, title: "stale" } },
        78,
      ),
    ).toBeNull();
    expect(
      resolveInnerPromotedTarget(
        { ...SUBGRAPH, subgraph_of: { node_id: 79, title: "stale" } },
        "width",
        78,
      ),
    ).toBeNull();
  });

  it.each([
    ["missing subgraph_of", { ...SUBGRAPH, subgraph_of: undefined }],
    ["wrong node_count", { ...SUBGRAPH, node_count: 1 }],
    ["non-integer node_count", { ...SUBGRAPH, node_count: "2" }],
    ["truncated envelope", { ...SUBGRAPH, truncated: true }],
    ["malformed inner node id", { ...SUBGRAPH, nodes: [{ ...SUBGRAPH.nodes[0], id: "not-a-node" }, SUBGRAPH.nodes[1]] }],
  ])("rejects a %s instead of trusting its inner mapping", (_name, malformed) => {
    expect(validatePromotedSubgraphEnvelope(malformed, 78)).toBeNull();
    expect(resolveInnerPromotedTarget(malformed, "width", 78)).toBeNull();
  });
});

describe("panel_set_widget promoted-subgraph recovery (#1655)", () => {
  it("does not carry the outer node-type fence into a promoted inner retry (#2107)", async () => {
    const { text, isError, calls } = await setWidget(
      { node_id: 78, widget: "stack_data", value: "NEW" },
      {
        stackDataIdentity: { nodes: [{ id: 78, type: "OtherLoraLoader" }] },
        subgraph: {
          subgraph_of: { node_id: 78, title: "OtherLoraLoader" },
          node_count: 1,
          nodes: [{ id: 76, type: "OtherLoraLoader", widgets: { stack_data: "old" } }],
        },
        preflightSubgraph: new Error("preflight unavailable"),
      },
    );

    expect(isError).toBe(false);
    expect(calls.map((c) => c.cmd)).toEqual([
      "graph_query",
      "graph_get_subgraph",
      "graph_query",
      "graph_set_widget",
      "graph_get_subgraph",
      "graph_get_subgraph",
      "graph_enter_subgraph",
      "graph_get_subgraph",
      "graph_query",
      "graph_get_subgraph",
      "graph_set_widget",
      "graph_exit_subgraph",
    ]);
    expect(calls[3]).toMatchObject({ expected_node_type: "OtherLoraLoader" });
    expect(calls[10]).toMatchObject({ expected_node_type: "OtherLoraLoader" });
    expect(text).toMatch(/validated promoted inner widget/);
  });

  it("refuses a promoted inner retry when the post-enter identity is stale", async () => {
    const { text, isError, calls } = await setWidget(
      { node_id: 78, widget: "stack_data", value: "NEW" },
      {
        stackDataIdentity: { nodes: [{ id: 78, type: "OtherLoraLoader" }] },
        stackDataInnerIdentity: { nodes: [{ id: 99, type: "OtherLoraLoader" }] },
        subgraph: {
          subgraph_of: { node_id: 78, title: "OtherLoraLoader" },
          node_count: 1,
          nodes: [{ id: 76, type: "OtherLoraLoader", widgets: { stack_data: "old" } }],
        },
        preflightSubgraph: new Error("preflight unavailable"),
      },
    );

    expect(isError).toBe(true);
    expect(calls.map((c) => c.cmd)).toEqual([
      "graph_query",
      "graph_get_subgraph",
      "graph_query",
      "graph_set_widget",
      "graph_get_subgraph",
      "graph_get_subgraph",
      "graph_enter_subgraph",
      "graph_get_subgraph",
      "graph_query",
      "graph_exit_subgraph",
    ]);
    expect(calls.filter((c) => c.cmd === "graph_set_widget")).toHaveLength(1);
    expect(text).toMatch(/different node_id|No inner graph_set_widget/);
  });

  it("refuses a promoted inner DaSiWa stack write without a second mutation", async () => {
    const { text, isError, calls } = await setWidget(
      { node_id: 78, widget: "stack_data", value: "NEW" },
      {
        stackDataIdentity: { nodes: [{ id: 78, type: "OtherLoraLoader" }] },
        stackDataInnerIdentity: { nodes: [{ id: 76, type: "DaSiWa_LTX2LoraLoader" }] },
        subgraph: {
          subgraph_of: { node_id: 78, title: "OtherLoraLoader" },
          node_count: 1,
          nodes: [{ id: 76, type: "DaSiWa_LTX2LoraLoader", widgets: { stack_data: "old" } }],
        },
        preflightSubgraph: new Error("preflight unavailable"),
      },
    );

    expect(isError).toBe(true);
    expect(calls.map((c) => c.cmd)).toEqual([
      "graph_query",
      "graph_get_subgraph",
      "graph_query",
      "graph_set_widget",
      "graph_get_subgraph",
      "graph_get_subgraph",
      "graph_enter_subgraph",
      "graph_get_subgraph",
      "graph_query",
      "graph_exit_subgraph",
    ]);
    expect(calls.filter((c) => c.cmd === "graph_set_widget")).toHaveLength(1);
    expect(text).toMatch(/cannot set "stack_data" on DaSiWa_LTX2LoraLoader/);
    expect(text).toMatch(/No inner graph_set_widget was dispatched/);
  });

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
      "graph_get_subgraph",
      "graph_get_subgraph",
      "graph_set_widget",
      "graph_exit_subgraph",
    ]);
    expect(calls[0]).toMatchObject({ node_id: 78, widget: "width", value: 1024 });
    expect(calls[5]).toMatchObject({ node_id: 76, widget: "width", value: 1024 });
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
          subgraph_of: { node_id: 78, title: "Container" },
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
    expect(text).toMatch(/malformed, stale, or incomplete ownership envelope/);
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
      "graph_get_subgraph",
      "graph_get_subgraph",
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
