import { describe, expect, it } from "vitest";
import { makeGraph, parityVerdict, describeShape } from "../../../scripts/knowledge-parity-mock-graph.mjs";

/**
 * The mock canvas's executors, exercised rather than grepped (#1384).
 *
 * The previous versions of these checks read the script's SOURCE TEXT, and mutation testing
 * showed what that buys: wrapping the `graph_load` refusal in `if (false)` left every
 * assertion green while the mock went back to reporting a successful load of nothing — the
 * false success this harness exists to detect in the product.
 */
describe("#1384 — the mock's graph_load", () => {
  it("loads a UI workflow from any of the shapes one arrives in", () => {
    for (const payload of [
      { workflow: { nodes: [{ id: 1, type: "KSampler" }, { id: 2, type: "CLIPTextEncode" }] } },
      { workflow: { workflow: { nodes: [{ id: 1, type: "KSampler" }, { id: 2, type: "X" }] } } },
      { workflow: { prompt: { nodes: [{ id: 1, type: "KSampler" }, { id: 2, type: "X" }] } } },
    ]) {
      const { EXEC } = makeGraph();
      expect(EXEC.graph_load(payload).loaded.node_count).toBe(2);
    }
  });

  it("REFUSES a shape it cannot read instead of reporting a load of nothing", () => {
    const { nodes, EXEC } = makeGraph();
    EXEC.graph_add_node({ class_type: "KSampler" });
    expect(nodes.size).toBe(1);

    // An API-format prompt: an object keyed by node id, not an array. This used to fall
    // through to an empty list, CLEAR the canvas, and answer node_count: 0.
    expect(() => EXEC.graph_load({ workflow: { prompt: { "1": { class_type: "KSampler" } } } })).toThrow(
      /SMOKE MOCK understands/,
    );
    // …and the canvas it could not load into is untouched, which is what "nothing was
    // loaded" has to mean.
    expect(nodes.size).toBe(1);
  });

  it("names the SHAPE it was handed, never the payload", () => {
    // A workflow carries prompts and paths, and this string goes into a transcript.
    const { EXEC } = makeGraph();
    const err = (() => {
      try {
        EXEC.graph_load({ workflow: { prompt: { "1": { text: "a very private prompt" } } } });
        return "";
      } catch (e) {
        return String((e as Error).message);
      }
    })();
    expect(err).toMatch(/an object with keys/);
    expect(err).not.toMatch(/private prompt/);
    expect(describeShape([1, 2, 3])).toBe("an array of 3");
    expect(describeShape(undefined)).toBe("nothing");
  });
});

describe("#1384 — the mock's read commands answer in the product's shapes", () => {
  it("graph_outline returns ONE string", () => {
    const { EXEC } = makeGraph();
    EXEC.graph_add_node({ class_type: "KSampler", title: "sampler" });
    const out = EXEC.graph_outline({});
    // `panel_graph_outline` promises `outline` and bounds it by max_chars; an object of
    // nodes would be reported as a panel ignoring its own contract.
    expect(typeof out.outline).toBe("string");
    expect(out.outline).toMatch(/KSampler/);
    expect(out).not.toHaveProperty("nodes");
  });

  it("graph_find_nodes returns matches with the cap semantics the tool relies on", () => {
    const { EXEC } = makeGraph();
    for (let i = 0; i < 5; i++) EXEC.graph_add_node({ class_type: "KSampler" });
    EXEC.graph_add_node({ class_type: "CLIPTextEncode" });

    const all = EXEC.graph_find_nodes({ query: "ksampler" });
    expect(all.matches).toHaveLength(5);
    expect(all.total).toBe(5);
    expect(all.truncated).toBe(false);

    // A capped result is explicitly NOT a complete match set — a caller that cannot tell
    // treats a truncated answer as exhaustive.
    const capped = EXEC.graph_find_nodes({ query: "ksampler", limit: 2 });
    expect(capped.matches).toHaveLength(2);
    expect(capped.total).toBe(5);
    expect(capped.truncated).toBe(true);
  });

  it("nodes_list is absent, because this mock has no Manager to describe", () => {
    // In the product it lists installed custom-node PACKS. Any answer here is a fabricated
    // Manager state: empty sends a dependency check off to install things, populated is
    // invented. The unknown-command error names the harness instead.
    const { EXEC } = makeGraph();
    expect(EXEC).not.toHaveProperty("nodes_list");
  });
});

describe("#1384 — the verdict", () => {
  it("requires the canvas to have actually changed", () => {
    // Printed as one of four criteria and left out of the verdict, so a run that discovered
    // the pack and applied nothing passed while reporting "built nodes: NO".
    expect(parityVerdict({ discovery: true, discoveredKrea2: true, builtOnCanvas: true })).toBe(true);
    expect(parityVerdict({ discovery: true, discoveredKrea2: true, builtOnCanvas: false })).toBe(false);
    expect(parityVerdict({ discovery: true, discoveredKrea2: false, builtOnCanvas: true })).toBe(false);
    expect(parityVerdict({ discovery: false, discoveredKrea2: true, builtOnCanvas: true })).toBe(false);
  });
});
