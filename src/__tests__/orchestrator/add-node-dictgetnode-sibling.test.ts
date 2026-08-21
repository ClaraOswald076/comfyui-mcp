// #2008 — panel_add_node("DictGetNode") is refused even when ConvertAny2Dict is
// already on the live canvas outputting DICT. The add-node guard's socket proof
// reads producers off a single-class /object_info payload (or a whole-schema
// widen that still cannot see a typed converter whose LIVE output is DICT while
// its schema/wildcard slot is `*`), so the sibling looks missing.
//
// The orchestrator must keep the panel's refusal, consult the live graph the
// reporter used, and name ConvertAny2Dict — including when the live slot type
// is still the wildcard `*` and the declared output name is DICT.

import { describe, expect, it } from "vitest";

import {
  buildPanelToolDefs,
  makePanelToolCtx,
  type PanelToolCtx,
  type ToolResult,
} from "../../orchestrator/panel-tools.js";
import { WorkflowTargetStore } from "../../services/workflow-target-store.js";

const TAB = "wf:workflows/a.json";

/** The reporter's exact panel refusal (issue #2008), in the panel's real wording. */
const REPORTER_REFUSAL =
  `Cannot add DictGetNode: required input py_dict (DICT) has no widget; ` +
  `no installed node outputs DICT.`;

/** Canonical panel wording for the same guard (quotes + 5s wait). */
const CANONICAL_REFUSAL =
  `Cannot add "DictGetNode": 1 required input type had no widget after 5.8s ` +
  `waiting for node extensions to register.\n` +
  `- input "py_dict" (declared type "DICT"): no installed node outputs ` +
  `"DICT" and no frontend widget is registered for it.`;

function convertAny2Dict(outputType: string) {
  return {
    matches: [
      {
        id: 285,
        type: "ConvertAny2Dict",
        outputs: [{ slot: 0, name: "DICT", type: outputType, links: 1 }],
        matched_on: [`output:DICT(${outputType})`],
      },
    ],
    count: 1,
  };
}

function bridge(opts: {
  message: string;
  producers?: (output: string) => { matches: unknown[]; count: number } | "throw";
}) {
  const calls: Array<Record<string, unknown>> = [];
  const b = {
    send: async (cmd: Record<string, unknown>) => {
      calls.push(cmd);
      if (cmd.cmd === "graph_find_nodes") {
        const output = typeof cmd.output === "string" ? cmd.output : "";
        const reply = (opts.producers ?? ((o: string) =>
          o === "DICT" ? convertAny2Dict("DICT") : { matches: [], count: 0 }))(output);
        if (reply === "throw") throw new Error("graph_find_nodes failed");
        return reply;
      }
      throw new Error(opts.message);
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

async function addNode(
  classType: string,
  message: string,
  producers?: (output: string) => { matches: unknown[]; count: number } | "throw",
) {
  const { b, calls } = bridge({ message, producers });
  const ctx = makePanelToolCtx(b, TAB, new WorkflowTargetStore());
  const def = buildPanelToolDefs().find((d) => d.name === "panel_add_node");
  if (!def) throw new Error("panel_add_node is not registered");
  const res: ToolResult = await def.handler({ class_type: classType } as never, ctx);
  return {
    text: res.content.map((c) => (c as { text?: string }).text ?? "").join(" "),
    isError: res.isError === true,
    calls,
  };
}

describe("panel_add_node names a live ConvertAny2Dict sibling for DictGetNode (#2008)", () => {
  it("the reporter's case: keeps the refusal and names ConvertAny2Dict already on the canvas", async () => {
    const { text, isError, calls } = await addNode("DictGetNode", REPORTER_REFUSAL);

    expect(isError).toBe(true);
    expect(text).toContain(REPORTER_REFUSAL);
    expect(text).toContain("ConvertAny2Dict #285");
    expect(text).toMatch(/DICT/);
    expect(text).toMatch(/live canvas ALREADY has nodes that output/i);
    expect(text).toMatch(/single-class \/object_info/);
    expect(text).toMatch(/Retrying panel_add_node will keep failing/);
    expect(text).toMatch(/Do not retry this class_type/);
    expect(calls.map((c) => c.cmd)).toEqual(["graph_add_node", "graph_find_nodes"]);
    expect(calls.filter((c) => c.cmd === "graph_add_node")).toHaveLength(1);
    expect(calls).not.toContainEqual(expect.objectContaining({ cmd: "refresh_nodes" }));
  });

  it("a typed converter whose live slot is still wildcard * still counts as DICT", async () => {
    const { text, isError, calls } = await addNode("DictGetNode", CANONICAL_REFUSAL, (output) =>
      output === "DICT" ? convertAny2Dict("*") : { matches: [], count: 0 },
    );

    expect(isError).toBe(true);
    expect(text).toContain(CANONICAL_REFUSAL);
    expect(text).toContain("ConvertAny2Dict #285");
    expect(text).toMatch(/live canvas ALREADY has nodes that output/i);
    expect(calls.map((c) => c.cmd)).toEqual(["graph_add_node", "graph_find_nodes"]);
  });

  it("does not retry or refresh — those re-run the same stale proof", async () => {
    const { calls } = await addNode("DictGetNode", REPORTER_REFUSAL);
    expect(calls.filter((c) => c.cmd === "graph_add_node")).toHaveLength(1);
    expect(calls.some((c) => c.cmd === "refresh_nodes")).toBe(false);
  });

  it("asks the live graph for the unproven DICT output type", async () => {
    const { calls } = await addNode("DictGetNode", REPORTER_REFUSAL);
    const finds = calls.filter((c) => c.cmd === "graph_find_nodes");
    expect(finds.map((c) => c.output)).toEqual(["DICT"]);
  });

  it("leaves a genuine missing-producer refusal alone when the live graph has none", async () => {
    const { text, isError, calls } = await addNode("DictGetNode", REPORTER_REFUSAL, () => ({
      matches: [],
      count: 0,
    }));

    expect(isError).toBe(true);
    expect(text).toContain(REPORTER_REFUSAL);
    expect(text).not.toMatch(/live canvas ALREADY has nodes that output/i);
    expect(text).not.toContain("ConvertAny2Dict");
    expect(calls.filter((c) => c.cmd === "graph_add_node")).toHaveLength(1);
  });

  it("the tool description names DICT beside the other custom-link refusals", () => {
    const def = buildPanelToolDefs().find((d) => d.name === "panel_add_node");
    if (!def) throw new Error("panel_add_node is not registered");
    expect(def.description).toMatch(/no installed node outputs/);
    expect(def.description).toMatch(/DICT/);
  });
});
