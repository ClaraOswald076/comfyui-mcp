import { describe, expect, it } from "vitest";
import { flattenUiWorkflow, isUeSender } from "../../services/flatten-workflow.js";
import type { UiWorkflow } from "../../comfyui/types.js";

// Helpers — litegraph link: [id, origin, oslot, target, tslot, type]
function node(
  id: number,
  type: string,
  extra: Partial<UiWorkflow["nodes"][number]> = {},
): UiWorkflow["nodes"][number] {
  return {
    id,
    type,
    pos: [id * 100, id * 50],
    inputs: [],
    outputs: [],
    widgets_values: [],
    ...extra,
  } as UiWorkflow["nodes"][number];
}

describe("flattenUiWorkflow — Get/Set + Reroute", () => {
  // Loader(1) → Set"model"(2) … Get"model"(3) → Sampler(4).model, via bus.
  function getSetGraph(): UiWorkflow {
    return {
      nodes: [
        node(1, "CheckpointLoaderSimple", {
          outputs: [{ name: "MODEL", type: "MODEL", links: [10] }],
        }),
        node(2, "SetNode", {
          widgets_values: ["model"],
          inputs: [{ name: "MODEL", type: "MODEL", link: 10 }],
          outputs: [{ name: "*", type: "*", links: [] }],
        }),
        node(3, "GetNode", {
          widgets_values: ["model"],
          outputs: [{ name: "MODEL", type: "MODEL", links: [11] }],
        }),
        node(4, "KSampler", {
          inputs: [{ name: "model", type: "MODEL", link: 11 }],
        }),
      ],
      links: [
        [10, 1, 0, 2, 0, "MODEL"],
        [11, 3, 0, 4, 0, "MODEL"],
      ],
      last_link_id: 11,
      groups: [{ title: "Loaders", bounding: [0, 0, 400, 300], color: "#A88" }],
    };
  }

  it("rewires the consumer straight to the real producer and deletes the bus", () => {
    const { graph, report } = flattenUiWorkflow(getSetGraph());
    expect(report.removed.getset).toBe(2);
    expect(graph.nodes.map((n) => n.type).sort()).toEqual(["CheckpointLoaderSimple", "KSampler"]);
    const sampler = graph.nodes.find((n) => n.type === "KSampler")!;
    const linkId = sampler.inputs![0].link!;
    const link = graph.links.find((l) => l[0] === linkId)!;
    expect([link[1], link[2], link[3], link[4]]).toEqual([1, 0, 4, 0]);
    // producer's output list carries the fresh link, and no stale ids survive
    const loader = graph.nodes.find((n) => n.type === "CheckpointLoaderSimple")!;
    expect(loader.outputs![0].links).toContain(linkId);
    const ids = new Set(graph.links.map((l) => l[0]));
    for (const n of graph.nodes) {
      for (const i of n.inputs ?? []) if (i.link != null) expect(ids.has(i.link)).toBe(true);
      for (const o of n.outputs ?? []) for (const id of o.links ?? []) expect(ids.has(id)).toBe(true);
    }
  });

  it("preserves positions, groups, widgets, and mode of kept nodes exactly", () => {
    const src = getSetGraph();
    src.nodes[3].mode = 4; // author's bypass toggle must survive
    src.nodes[3].widgets_values = [123, "euler"];
    const { graph } = flattenUiWorkflow(src);
    const sampler = graph.nodes.find((n) => n.type === "KSampler")!;
    expect(sampler.pos).toEqual([400, 200]);
    expect(sampler.mode).toBe(4);
    expect(sampler.widgets_values).toEqual([123, "euler"]);
    expect(graph.groups).toEqual(src.groups);
  });

  it("dangling Get (no matching Set) leaves the input unconnected with a warning", () => {
    const g = getSetGraph();
    (g.nodes[2].widgets_values as unknown[])[0] = "other_bus";
    const { graph, report } = flattenUiWorkflow(g);
    const sampler = graph.nodes.find((n) => n.type === "KSampler")!;
    expect(sampler.inputs![0].link).toBeNull();
    expect(report.warnings.some((w) => w.includes("dangling"))).toBe(true);
  });

  it("resolves Reroute chains", () => {
    const g: UiWorkflow = {
      nodes: [
        node(1, "CheckpointLoaderSimple", { outputs: [{ name: "MODEL", type: "MODEL", links: [1] }] }),
        node(2, "Reroute", {
          inputs: [{ name: "", type: "*", link: 1 }],
          outputs: [{ name: "", type: "MODEL", links: [2] }],
        }),
        node(3, "KSampler", { inputs: [{ name: "model", type: "MODEL", link: 2 }] }),
      ],
      links: [
        [1, 1, 0, 2, 0, "MODEL"],
        [2, 2, 0, 3, 0, "MODEL"],
      ],
      last_link_id: 2,
    };
    const { graph, report } = flattenUiWorkflow(g);
    expect(report.removed.reroute).toBe(1);
    const link = graph.links.find((l) => l[3] === 3)!;
    expect(link[1]).toBe(1);
  });
});

describe("flattenUiWorkflow — Use-Everywhere", () => {
  // Loader(1) → AE(2).anything (link 5); CLIP(3) has an unconnected model input;
  // ue_links (the pack's own analysis) says upstream 1.0 → downstream 3.0.
  function ueGraph(withUeLinks: boolean): UiWorkflow {
    return {
      nodes: [
        node(1, "CheckpointLoaderSimple", { outputs: [{ name: "MODEL", type: "MODEL", links: [5] }] }),
        node(2, "Anything Everywhere", { inputs: [{ name: "anything", type: "*", link: 5 }] }),
        node(3, "SomeConsumer", { inputs: [{ name: "model", type: "MODEL", link: null }] }),
      ],
      links: [[5, 1, 0, 2, 0, "MODEL"]],
      last_link_id: 5,
      extra: withUeLinks
        ? {
            ue_links: [
              { downstream: 3, downstream_slot: 0, upstream: 1, upstream_slot: 0, controller: 2, type: "MODEL" },
            ],
          }
        : {},
    };
  }

  it("materializes ue_links as direct links and deletes the sender", () => {
    const { graph, report } = flattenUiWorkflow(ueGraph(true));
    expect(report.removed.ue).toBe(1);
    expect(graph.nodes.some((n) => n.type === "Anything Everywhere")).toBe(false);
    const consumer = graph.nodes.find((n) => n.type === "SomeConsumer")!;
    const link = graph.links.find((l) => l[0] === consumer.inputs![0].link)!;
    expect([link[1], link[2]]).toEqual([1, 0]);
    // stale UE bookkeeping is scrubbed once all senders are gone
    expect(graph.extra?.ue_links).toBeUndefined();
  });

  it("keeps Seed Everywhere — it is its own real producer", () => {
    const g: UiWorkflow = {
      nodes: [
        node(1, "Seed Everywhere", {
          widgets_values: [42],
          outputs: [{ name: "int", type: "INT", links: [] }],
        }),
        node(2, "KSampler", { inputs: [{ name: "seed", type: "INT", link: null }] }),
      ],
      links: [],
      last_link_id: 0,
      extra: {
        ue_links: [{ downstream: 2, downstream_slot: 0, upstream: 1, upstream_slot: 0, controller: 1, type: "INT" }],
      },
    };
    const { graph, report } = flattenUiWorkflow(g);
    expect(report.removed.ue).toBe(0);
    expect(graph.nodes.some((n) => n.type === "Seed Everywhere")).toBe(true);
    const link = graph.links.find((l) => l[3] === 2)!;
    expect(link[1]).toBe(1);
  });

  it("UE senders without ue_links are left in place with a loud warning", () => {
    const { graph, report } = flattenUiWorkflow(ueGraph(false));
    expect(report.removed.ue).toBe(0);
    expect(graph.nodes.some((n) => n.type === "Anything Everywhere")).toBe(true);
    expect(report.warnings.some((w) => w.includes("ue_links is empty"))).toBe(true);
  });

  it("skips a ue_link whose receiver input got a real link since analysis", () => {
    const g = ueGraph(true);
    // give the consumer a real direct link already
    g.nodes[2].inputs![0].link = 7;
    g.links.push([7, 1, 0, 3, 0, "MODEL"]);
    const { graph } = flattenUiWorkflow(g);
    const consumer = graph.nodes.find((n) => n.type === "SomeConsumer")!;
    expect(consumer.inputs![0].link).toBe(7); // untouched
  });

  it("detects all sender variants", () => {
    for (const t of [
      "Anything Everywhere",
      "Anything Everywhere?",
      "Anything Everywhere3",
      "Prompts Everywhere",
      "Prompts Everywhere?",
      "Seed Everywhere",
      // The pack registers this one, but the predicate used to compare the
      // "Seed Everywhere" family with equality, so it went unrecognized — and an
      // unrecognized sender means its broadcasts are dropped with nothing said.
      "Seed Everywhere?",
    ]) {
      expect(isUeSender(t)).toBe(true);
    }
    expect(isUeSender("KSampler")).toBe(false);
    expect(isUeSender("SaveImage")).toBe(false);
  });
});

describe("flattenUiWorkflow — mixed + toggles", () => {
  it("include_getset=false leaves buses alone while UE still materializes", () => {
    const g: UiWorkflow = {
      nodes: [
        node(1, "CheckpointLoaderSimple", { outputs: [{ name: "MODEL", type: "MODEL", links: [5] }] }),
        node(2, "Anything Everywhere", { inputs: [{ name: "anything", type: "*", link: 5 }] }),
        node(3, "SomeConsumer", { inputs: [{ name: "model", type: "MODEL", link: null }] }),
        node(4, "GetNode", { widgets_values: ["x"], outputs: [{ name: "*", type: "*", links: [] }] }),
      ],
      links: [[5, 1, 0, 2, 0, "MODEL"]],
      last_link_id: 5,
      extra: {
        ue_links: [{ downstream: 3, downstream_slot: 0, upstream: 1, upstream_slot: 0, controller: 2, type: "MODEL" }],
      },
    };
    const { graph, report } = flattenUiWorkflow(g, { includeGetSet: false });
    expect(report.removed.getset).toBe(0);
    expect(graph.nodes.some((n) => n.type === "GetNode")).toBe(true);
    expect(report.removed.ue).toBe(1);
  });
});
