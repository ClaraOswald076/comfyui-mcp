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
  comboOptionsFromObjectInfo,
  comboValueIsListed,
  isContradictoryPromotedWidgetRefusal,
  isSubgraphUuidType,
  matchListedName,
  parseContradictoryPromotedWidgetRefusal,
  parseEmptyPromotedComboRefusal,
  resolveInnerComboOptions,
  resolveInnerPromotedTarget,
} from "../../orchestrator/promoted-widget.js";
import { WorkflowTargetStore } from "../../services/workflow-target-store.js";

const TAB = "wf:krea2";

const CONTRADICTORY =
  `Cannot set widget on subgraph node 78: "width" is not a promoted widget on this subgraph ` +
  `(promoted: width, height, seed, control_after_generate, steps, cfg, sampler_name, scheduler, denoise, batch_size).`;

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
}) {
  const calls: Array<Record<string, unknown>> = [];
  let writes = 0;
  const b = {
    send: async (cmd: Record<string, unknown>) => {
      calls.push({ ...cmd });
      if (cmd.cmd === "graph_set_widget") {
        writes += 1;
        const which =
          writes === 1
            ? (opts.firstWrite ?? "contradict")
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

// #1940 — promoted COMBO on a subgraph UUID: empty option list is not stale.
const SUBGRAPH_UUID = "6c697765-ebd7-4e1e-8af0-d84d620be471";
const EMPTY_COMBO =
  `panel_set_widget refused "choice" on node 816 (${SUBGRAPH_UUID}) after refreshing combo options: ` +
  `Combo widget "choice" has an EMPTY option list; the server's option list may simply be stale — ` +
  `refreshing it before deciding.`;

const COMBO_SUBGRAPH = {
  subgraph_of: { node_id: 816, title: "Ideogram 4" },
  node_count: 3,
  nodes: [
    {
      id: 795,
      type: "KSampler",
      widgets: { seed: 1, noise_seed: 1, steps: 20 },
    },
    {
      id: 801,
      type: "CustomCombo",
      widgets: { choice: "Quality" },
      widget_options: { choice: ["Quality", "Default", "Turbo"] },
    },
    {
      id: 810,
      type: "UNETLoader",
      widgets: { unet_name: "model.fp8.safetensors", weight_dtype: "fp8" },
    },
  ],
};

const OBJECT_INFO = {
  UNETLoader: {
    input: {
      required: {
        unet_name: [["model.fp8.safetensors", "model.nvfp4.safetensors"], {}],
        weight_dtype: ["COMBO", { options: ["default", "fp8", "fp16"] }],
      },
    },
  },
  KSampler: {
    input: {
      required: {
        seed: ["INT", {}],
        steps: ["INT", {}],
      },
    },
  },
};

function emptyComboBridge(opts: {
  subgraph?: Record<string, unknown> | Error;
  objectInfo?: Record<string, unknown> | Error;
  firstWrite?: "empty" | "ok" | "other";
}) {
  const calls: Array<Record<string, unknown>> = [];
  const b = {
    send: async (cmd: Record<string, unknown>) => {
      calls.push({ ...cmd });
      if (cmd.cmd === "graph_set_widget") {
        const which = opts.firstWrite ?? "empty";
        if (which === "ok") {
          return { set: { node_id: cmd.node_id, widget: cmd.widget, value: cmd.value } };
        }
        if (which === "other") throw new Error("No node with id 816 in the current graph");
        throw new Error(EMPTY_COMBO);
      }
      if (cmd.cmd === "graph_get_subgraph") {
        if (opts.subgraph instanceof Error) throw opts.subgraph;
        return opts.subgraph ?? COMBO_SUBGRAPH;
      }
      if (cmd.cmd === "graph_get_object_info") {
        if (opts.objectInfo instanceof Error) throw opts.objectInfo;
        return { ok: true, object_info: opts.objectInfo ?? OBJECT_INFO };
      }
      if (cmd.cmd === "graph_enter_subgraph" || cmd.cmd === "graph_exit_subgraph") {
        throw new Error("must not enter the subgraph for a link-driven promoted combo");
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

async function setEmptyComboWidget(
  args: { node_id: number | string; widget: string; value: number | string },
  opts: Parameters<typeof emptyComboBridge>[0] = {},
) {
  const { b, calls } = emptyComboBridge(opts);
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

describe("parseEmptyPromotedComboRefusal", () => {
  it("the reporter's error is an empty combo on a subgraph UUID", () => {
    expect(parseEmptyPromotedComboRefusal(EMPTY_COMBO, "choice")).toEqual({
      nodeId: "816",
      widget: "choice",
      type: SUBGRAPH_UUID,
    });
    expect(isSubgraphUuidType(SUBGRAPH_UUID)).toBe(true);
  });

  it("a genuine empty list on a backend type is not this bug", () => {
    const text =
      `panel_set_widget refused "unet_name" on node 12 (UNETLoader) after refreshing combo options: ` +
      `Combo widget "unet_name" has an EMPTY option list; the server's option list may simply be stale — ` +
      `refreshing it before deciding.`;
    expect(parseEmptyPromotedComboRefusal(text, "unet_name")).toBeNull();
  });

  it("an unrelated failure is never this bug", () => {
    expect(parseEmptyPromotedComboRefusal("No node with id 816 in the current graph", "choice")).toBeNull();
    expect(parseEmptyPromotedComboRefusal(CONTRADICTORY, "width")).toBeNull();
  });
});

describe("resolveInnerComboOptions", () => {
  it("takes UNETLoader options from /object_info, not the subgraph UUID", () => {
    const resolved = resolveInnerComboOptions(COMBO_SUBGRAPH, "unet_name", OBJECT_INFO);
    expect(resolved).toMatchObject({
      innerNodeId: 810,
      widget: "unet_name",
      innerType: "UNETLoader",
      source: "object_info",
    });
    expect(resolved?.options).toEqual(["model.fp8.safetensors", "model.nvfp4.safetensors"]);
    expect(comboValueIsListed("model.nvfp4.safetensors", resolved?.options ?? [])).toBe(true);
    expect(comboValueIsListed("missing.safetensors", resolved?.options ?? [])).toBe(false);
  });

  it("falls back to the serialized options when the inner type is absent from /object_info", () => {
    const resolved = resolveInnerComboOptions(COMBO_SUBGRAPH, "choice", OBJECT_INFO);
    expect(resolved).toMatchObject({
      innerNodeId: 801,
      widget: "choice",
      innerType: "CustomCombo",
      source: "serialized",
      options: ["Quality", "Default", "Turbo"],
    });
  });

  it("does not guess when two inners share the widget name", () => {
    expect(
      resolveInnerComboOptions(
        {
          nodes: [
            { id: 1, type: "UNETLoader", widgets: { unet_name: "a" } },
            { id: 2, type: "UNETLoader", widgets: { unet_name: "b" } },
          ],
        },
        "unet_name",
        OBJECT_INFO,
      ),
    ).toBeNull();
  });

  it("V2 COMBO {options} specs are readable", () => {
    expect(comboOptionsFromObjectInfo(OBJECT_INFO, "UNETLoader", "weight_dtype")).toEqual([
      "default",
      "fp8",
      "fp16",
    ]);
  });
});

describe("panel_set_widget empty promoted combo (#1940)", () => {
  it("the reporter's case: Default is a valid CustomCombo option, and the refusal is not 'stale'", async () => {
    const { text, isError, calls } = await setEmptyComboWidget({
      node_id: 816,
      widget: "choice",
      value: "Default",
    });

    expect(isError).toBe(true);
    expect(text).toMatch(/subgraph UUID/i);
    expect(text).toMatch(/CustomCombo node 801 "choice"/);
    expect(text).toMatch(/IS a valid option/);
    expect(text).not.toMatch(/may simply be stale/i);
    expect(text).toMatch(/panel_refresh_nodes cannot fill it/);
    expect(text).toMatch(/Do not panel_enter_subgraph/);
    expect(calls.map((c) => c.cmd)).toEqual([
      "graph_set_widget",
      "graph_get_subgraph",
      "graph_get_object_info",
    ]);
    expect(calls.map((c) => c.cmd)).not.toContain("graph_enter_subgraph");
  });

  it("a promoted unet_name swap is validated against the inner UNETLoader list", async () => {
    const unetEmpty =
      `panel_set_widget refused "unet_name" on node 816 (${SUBGRAPH_UUID}) after refreshing combo options: ` +
      `Combo widget "unet_name" has an EMPTY option list; the server's option list may simply be stale — ` +
      `refreshing it before deciding.`;
    const { b, calls } = emptyComboBridge({});
    const failing = {
      ...(b as object),
      send: async (cmd: Record<string, unknown>) => {
        calls.push({ ...cmd });
        if (cmd.cmd === "graph_set_widget") throw new Error(unetEmpty);
        if (cmd.cmd === "graph_get_subgraph") return COMBO_SUBGRAPH;
        if (cmd.cmd === "graph_get_object_info") return { ok: true, object_info: OBJECT_INFO };
        throw new Error("must not enter the subgraph for a link-driven promoted combo");
      },
    } as unknown as PanelToolCtx["bridge"];
    const ctx = makePanelToolCtx(failing, TAB, new WorkflowTargetStore());
    const def = buildPanelToolDefs().find((d) => d.name === "panel_set_widget");
    if (!def) throw new Error("panel_set_widget is not registered");
    const res = await def.handler(
      { node_id: 816, widget: "unet_name", value: "model.nvfp4.safetensors" } as never,
      ctx,
    );
    const text = res.content.map((c) => (c as { text?: string }).text ?? "").join(" ");

    expect(res.isError).toBe(true);
    expect(text).toMatch(/UNETLoader node 810 "unet_name"/);
    expect(text).toMatch(/IS a valid option/);
    expect(text).not.toMatch(/may simply be stale/i);
    expect(calls.map((c) => c.cmd)).not.toContain("graph_enter_subgraph");
  });

  it("an off-list value is refused against the inner options, not as a stale list", async () => {
    const { text, isError, calls } = await setEmptyComboWidget({
      node_id: 816,
      widget: "choice",
      value: "NotAMode",
    });
    expect(isError).toBe(true);
    expect(text).toMatch(/not a valid option for the inner CustomCombo/);
    expect(text).toMatch(/"Quality"/);
    expect(text).toMatch(/"Default"/);
    expect(text).toMatch(/"Turbo"/);
    expect(text).not.toMatch(/may simply be stale/i);
    expect(calls.map((c) => c.cmd)).not.toContain("graph_enter_subgraph");
  });

  it("a healthy write is untouched", async () => {
    const { isError, calls } = await setEmptyComboWidget(
      { node_id: 3, widget: "steps", value: 20 },
      { firstWrite: "ok" },
    );
    expect(isError).toBe(false);
    expect(calls.map((c) => c.cmd)).toEqual(["graph_set_widget"]);
  });

  it("a non-UUID empty combo is never recovered as this bug", async () => {
    const backendEmpty =
      `panel_set_widget refused "unet_name" on node 12 (UNETLoader) after refreshing combo options: ` +
      `Combo widget "unet_name" has an EMPTY option list; the server's option list may simply be stale — ` +
      `refreshing it before deciding.`;
    const calls: Array<Record<string, unknown>> = [];
    const failing = {
      send: async (cmd: Record<string, unknown>) => {
        calls.push({ ...cmd });
        throw new Error(backendEmpty);
      },
      push: () => 1,
      canReach: () => true,
      isHeadless: () => false,
      tabs: () => [{ tab_id: TAB, title: "wf", connected_at: 0 }],
      resolveActiveTabId: () => TAB,
      tabCanMutateGraph: () => true,
      tabGraphMutationCapability: () => ({ known: true, canMutate: true }),
    } as unknown as PanelToolCtx["bridge"];
    const ctx = makePanelToolCtx(failing, TAB, new WorkflowTargetStore());
    const def = buildPanelToolDefs().find((d) => d.name === "panel_set_widget");
    if (!def) throw new Error("panel_set_widget is not registered");
    const res = await def.handler(
      { node_id: 12, widget: "unet_name", value: "model.nvfp4.safetensors" } as never,
      ctx,
    );
    expect(res.isError).toBe(true);
    expect(calls.map((c) => c.cmd)).toEqual(["graph_set_widget"]);
  });

  it("an unrelated failure is never recovered", async () => {
    const { isError, calls } = await setEmptyComboWidget(
      { node_id: 816, widget: "choice", value: "Default" },
      { firstWrite: "other" },
    );
    expect(isError).toBe(true);
    expect(calls.map((c) => c.cmd)).toEqual(["graph_set_widget"]);
  });

  it("a truncated subgraph read is not treated as unique", async () => {
    const { text, isError, calls } = await setEmptyComboWidget(
      { node_id: 816, widget: "choice", value: "Default" },
      { subgraph: { ...COMBO_SUBGRAPH, truncated: true } },
    );
    expect(isError).toBe(true);
    expect(text).toMatch(/did not uniquely identify/);
    expect(calls.map((c) => c.cmd)).not.toContain("graph_enter_subgraph");
  });
});
