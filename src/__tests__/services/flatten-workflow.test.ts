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

  // #361: a ue_links record is only as current as the pack's last analysis.
  // Materializing one without checking it against the LIVE wiring invents a
  // connection the graph does not have — which reads as a plausible graph that is
  // silently wrong, and is worse than an obviously missing link.
  it("refuses a record whose sender was REWIRED, and keeps that sender in place", () => {
    const g = ueGraph(true);
    // The sender now takes its value from node 9, not the recorded node 1.
    g.nodes.push(
      node(9, "CheckpointLoaderSimple", { outputs: [{ name: "MODEL", type: "MODEL", links: [6] }] }),
    );
    g.nodes[0].outputs![0].links = [];
    g.nodes[1].inputs![0].link = 6;
    g.links = [[6, 9, 0, 2, 0, "MODEL"]];
    const { graph, report } = flattenUiWorkflow(g);
    const consumer = graph.nodes.find((n) => n.type === "SomeConsumer")!;
    expect(consumer.inputs![0].link).toBeNull(); // no fabricated edge
    expect(graph.nodes.some((n) => n.type === "Anything Everywhere")).toBe(true);
    expect(report.warnings.join("\n")).toContain("could not be confirmed against the live graph");
    expect(report.warnings.join("\n")).toContain("fed by a different producer");
  });

  it("refuses a record naming a sender that is gone", () => {
    const g = ueGraph(true);
    g.nodes = g.nodes.filter((n) => n.type !== "Anything Everywhere");
    // Another sender keeps UE processing alive, but it is not this record's.
    g.nodes.push(node(8, "Anything Everywhere", { inputs: [{ name: "anything", type: "*", link: null }] }));
    const { graph, report } = flattenUiWorkflow(g);
    const consumer = graph.nodes.find((n) => n.type === "SomeConsumer")!;
    expect(consumer.inputs![0].link).toBeNull();
    expect(report.warnings.join("\n")).toContain("no longer a broadcast node");
  });

  it("refuses a controllerless record unless its producer is itself a broadcast node", () => {
    const g = ueGraph(true);
    delete (g.extra!.ue_links as { controller?: number }[])[0].controller;
    const { graph, report } = flattenUiWorkflow(g);
    const consumer = graph.nodes.find((n) => n.type === "SomeConsumer")!;
    expect(consumer.inputs![0].link).toBeNull();
    expect(report.warnings.join("\n")).toContain("cannot be attributed to any sender");
    // The record names no sender, so we cannot tell WHICH one has to survive —
    // deleting any would erase the evidence of the broadcast we declined to
    // materialize, and scrubbing ue_links would erase the record itself.
    expect(graph.nodes.some((n) => n.type === "Anything Everywhere")).toBe(true);
    expect(graph.extra?.ue_links).toBeDefined();
  });

  it("a confirmed record whose producer output does not exist is reported, not dropped in silence", () => {
    // A self-producing sender skips the feed check, so this record passes
    // confirmation and then fails to BUILD (the node serializes no outputs). The
    // return value used to be discarded: no edge, no warning, and the sender then
    // deletable — a could-not-determine folded into a silent loss.
    const g: UiWorkflow = {
      nodes: [
        node(1, "Seed Everywhere", { widgets_values: [42] }), // no outputs array
        node(3, "SomeConsumer", { inputs: [{ name: "seed", type: "INT", link: null }] }),
      ],
      links: [],
      last_link_id: 0,
      extra: {
        ue_links: [
          { downstream: 3, downstream_slot: 0, upstream: 1, upstream_slot: 0, controller: 1, type: "INT" },
        ],
      },
    };
    const { graph, report } = flattenUiWorkflow(g);
    const consumer = graph.nodes.find((n) => n.type === "SomeConsumer")!;
    expect(consumer.inputs![0].link).toBeNull();
    expect(report.warnings.join("\n")).toContain("which this graph does not have");
    expect(graph.nodes.some((n) => n.type === "Seed Everywhere")).toBe(true);
  });

  it("a LIVE broadcast whose sender is fed through a Get/Set bus is still materialized", () => {
    // Pass 1 replaces the sender's bus-fed input with a fresh direct link; the
    // staleness check must see that fresh link, or it reads the feed as
    // unresolvable and refuses a broadcast that is perfectly current.
    const g: UiWorkflow = {
      nodes: [
        node(1, "CheckpointLoaderSimple", { outputs: [{ name: "MODEL", type: "MODEL", links: [10] }] }),
        node(2, "SetNode", {
          widgets_values: ["m"],
          inputs: [{ name: "MODEL", type: "MODEL", link: 10 }],
          outputs: [{ name: "*", type: "*", links: [] }],
        }),
        node(3, "GetNode", {
          widgets_values: ["m"],
          outputs: [{ name: "MODEL", type: "MODEL", links: [11] }],
        }),
        node(4, "Anything Everywhere", { inputs: [{ name: "anything", type: "*", link: 11 }] }),
        node(5, "SomeConsumer", { inputs: [{ name: "model", type: "MODEL", link: null }] }),
      ],
      links: [
        [10, 1, 0, 2, 0, "MODEL"],
        [11, 3, 0, 4, 0, "MODEL"],
      ],
      last_link_id: 11,
      extra: {
        ue_links: [
          { downstream: 5, downstream_slot: 0, upstream: 1, upstream_slot: 0, controller: 4, type: "MODEL" },
        ],
      },
    };
    const { graph, report } = flattenUiWorkflow(g);
    const consumer = graph.nodes.find((n) => n.type === "SomeConsumer")!;
    const link = graph.links.find((l) => l[0] === consumer.inputs![0].link)!;
    expect([link[1], link[2]]).toEqual([1, 0]);
    expect(report.warnings).toEqual([]);
  });

  it("a record whose upstream IS the bus node resolves through it", () => {
    // The pack sometimes records the virtual in front of the producer rather than
    // the producer; a GetNode has no incoming link, so it must be followed over
    // its bus, not by looking for an input.
    const g: UiWorkflow = {
      nodes: [
        node(1, "CheckpointLoaderSimple", { outputs: [{ name: "MODEL", type: "MODEL", links: [10] }] }),
        node(2, "SetNode", {
          widgets_values: ["m"],
          inputs: [{ name: "MODEL", type: "MODEL", link: 10 }],
          outputs: [{ name: "*", type: "*", links: [] }],
        }),
        node(3, "GetNode", {
          widgets_values: ["m"],
          outputs: [{ name: "MODEL", type: "MODEL", links: [11] }],
        }),
        node(4, "Anything Everywhere", { inputs: [{ name: "anything", type: "*", link: 11 }] }),
        node(5, "SomeConsumer", { inputs: [{ name: "model", type: "MODEL", link: null }] }),
      ],
      links: [
        [10, 1, 0, 2, 0, "MODEL"],
        [11, 3, 0, 4, 0, "MODEL"],
      ],
      last_link_id: 11,
      extra: {
        ue_links: [
          { downstream: 5, downstream_slot: 0, upstream: 3, upstream_slot: 0, controller: 4, type: "MODEL" },
        ],
      },
    };
    const { graph, report } = flattenUiWorkflow(g);
    const consumer = graph.nodes.find((n) => n.type === "SomeConsumer")!;
    const link = graph.links.find((l) => l[0] === consumer.inputs![0].link)!;
    expect([link[1], link[2]]).toEqual([1, 0]);
    expect(report.warnings).toEqual([]);
  });

  it("an input claiming a link that does not exist is reported, not silently cleared", () => {
    // The flattener's counterpart of the converter's dangling-reference report.
    // The source graph claims a connection this graph does not contain; clearing
    // it in silence is observation-failed treated as a definite no.
    const g: UiWorkflow = {
      nodes: [
        node(1, "CheckpointLoaderSimple", { outputs: [{ name: "MODEL", type: "MODEL", links: [] }] }),
        node(3, "SomeConsumer", { inputs: [{ name: "model", type: "MODEL", link: 77 }] }),
      ],
      links: [],
      last_link_id: 0,
    };
    const { graph, report } = flattenUiWorkflow(g);
    expect(graph.nodes.find((n) => n.id === 3)!.inputs![0].link).toBeNull();
    expect(report.warnings.join("\n")).toContain('input "model" claims link 77');
  });

  it("a healthy bus, whose original links are purged on purpose, reports nothing", () => {
    // Guards the common path against a spurious dangling-reference report. NOTE:
    // this does NOT exercise the was-a-real-link-but-purged branch of that check
    // — I could not construct a graph where a SURVIVING input still points at a
    // purged id (the nodes holding those references are removed with them). That
    // branch is therefore defensive, and is documented as such in the source
    // rather than pinned by a test that would not fail without it.
    const g: UiWorkflow = {
      nodes: [
        node(1, "CheckpointLoaderSimple", { outputs: [{ name: "MODEL", type: "MODEL", links: [10] }] }),
        node(2, "SetNode", {
          widgets_values: ["m"],
          inputs: [{ name: "MODEL", type: "MODEL", link: 10 }],
          outputs: [{ name: "*", type: "*", links: [] }],
        }),
        node(3, "GetNode", {
          widgets_values: ["m"],
          outputs: [{ name: "MODEL", type: "MODEL", links: [11] }],
        }),
        node(4, "KSampler", { inputs: [{ name: "model", type: "MODEL", link: 11 }] }),
      ],
      links: [
        [10, 1, 0, 2, 0, "MODEL"],
        [11, 3, 0, 4, 0, "MODEL"],
      ],
      last_link_id: 11,
    };
    const { report } = flattenUiWorkflow(g);
    expect(report.warnings).toEqual([]);
  });

  it("duplicate link ids ALREADY in the graph are repaired, and reported", () => {
    // Not something the allocator can produce, but a graph edited by tooling that
    // did not maintain link ids can arrive this way. Returning it unchanged
    // propagates an ambiguous graph out of a pass whose job is to leave the
    // wiring unambiguous — and each consumer must keep ITS OWN producer.
    const g: UiWorkflow = {
      nodes: [
        node(1, "ProducerA", { outputs: [{ name: "MODEL", type: "MODEL", links: [7] }] }),
        node(2, "ProducerB", { outputs: [{ name: "MODEL", type: "MODEL", links: [7] }] }),
        node(3, "SomeConsumer", { inputs: [{ name: "model", type: "MODEL", link: 7 }] }),
        node(4, "OtherConsumer", { inputs: [{ name: "model", type: "MODEL", link: 7 }] }),
      ],
      links: [
        [7, 1, 0, 3, 0, "MODEL"],
        [7, 2, 0, 4, 0, "MODEL"],
      ],
      last_link_id: 7,
    };
    const { graph, report } = flattenUiWorkflow(g);
    const ids = graph.links.map((l) => l[0]);
    expect(new Set(ids).size).toBe(ids.length);
    const byId = new Map(graph.links.map((l) => [l[0], l]));
    const feeder = (type: string) => {
      const c = graph.nodes.find((x) => x.type === type)!;
      const l = byId.get(c.inputs![0].link!)!;
      return graph.nodes.find((x) => x.id === l[1])!.type;
    };
    expect(feeder("SomeConsumer")).toBe("ProducerA");
    expect(feeder("OtherConsumer")).toBe("ProducerB");
    expect(report.warnings.join("\n")).toContain("shared an id already used by another link");
  });

  it("a stale last_link_id cannot make a fresh link collide with an existing one", () => {
    const g = ueGraph(true);
    // An existing link sitting at exactly the id the stale header hands out next.
    // The header is only a header, and tooling that edits a graph does not always
    // maintain it.
    g.nodes.push(node(9, "SomeConsumer", { inputs: [{ name: "model", type: "MODEL", link: 6 }] }));
    g.links.push([6, 1, 0, 9, 0, "MODEL"]);
    g.nodes[0].outputs![0].links = [5, 6];
    g.last_link_id = 5;
    const { graph } = flattenUiWorkflow(g);
    const ids = graph.links.map((l) => l[0]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("a foreign class sharing a sender name prefix FABRICATES nothing, even when fed", () => {
    // The fabrication direction specifically: "Seed Everywhere Helper" IS fed by
    // node 1, so a feed check alone would confirm the stale record and emit
    // 1 → #3. It is not a cg-use-everywhere node, so no edge may appear — and
    // because nothing here is recognized, the backstop reports it.
    const g: UiWorkflow = {
      nodes: [
        node(1, "CheckpointLoaderSimple", { outputs: [{ name: "MODEL", type: "MODEL", links: [5] }] }),
        node(9, "Seed Everywhere Helper", { inputs: [{ name: "anything", type: "*", link: 5 }] }),
        node(3, "SomeConsumer", { inputs: [{ name: "model", type: "MODEL", link: null }] }),
      ],
      links: [[5, 1, 0, 9, 0, "MODEL"]],
      last_link_id: 5,
      extra: {
        ue_links: [
          { downstream: 3, downstream_slot: 0, upstream: 1, upstream_slot: 0, controller: 9, type: "MODEL" },
        ],
      },
    };
    const { graph, report } = flattenUiWorkflow(g);
    const consumer = graph.nodes.find((n) => n.type === "SomeConsumer")!;
    expect(consumer.inputs![0].link).toBeNull();
    expect(graph.nodes.some((n) => n.type === "Seed Everywhere Helper")).toBe(true);
    expect(report.warnings.join("\n")).toContain("no node in this graph is recognized as a Use-Everywhere sender");
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

  it("UE senders with a MISSING ue_links list are left in place with a loud warning", () => {
    const { graph, report } = flattenUiWorkflow(ueGraph(false));
    expect(report.removed.ue).toBe(0);
    expect(graph.nodes.some((n) => n.type === "Anything Everywhere")).toBe(true);
    expect(report.warnings.some((w) => w.includes("ue_links is missing"))).toBe(true);
  });

  it("a PARTIAL ue_links list never deletes the sender it does not mention", () => {
    // A non-empty list is not proof it accounts for every sender. Sender #7 has no
    // row (the list predates it, or it reaches nothing) — deleting it would remove
    // a node whose broadcasts were never materialized, silently and for good.
    const g = ueGraph(true);
    g.nodes.push(
      node(8, "Anything Everywhere", { inputs: [{ name: "anything", type: "*", link: null }] }),
    );
    (g.extra!.ue_links as { controller: number }[])[0].controller = 8; // only #8 is listed
    const { graph, report } = flattenUiWorkflow(g);
    expect(graph.nodes.some((n) => n.id === 2)).toBe(true); // #7-equivalent survives
    expect(report.warnings.join("\n")).toContain("no record in extra.ue_links names it");
    expect(graph.extra?.ue_links).toBeDefined();
  });

  it("an EMPTY computed ue_links list is an answer — no warning, and nothing removed", () => {
    // The pack analysed the graph and recorded no broadcast. Warning there invents
    // a problem on a faithful graph (and disagreed with the converter); an empty
    // list is also not a licence to delete the senders.
    const g = ueGraph(true);
    g.extra!.ue_links = [];
    const { graph, report } = flattenUiWorkflow(g);
    expect(report.removed.ue).toBe(0);
    expect(graph.nodes.some((n) => n.type === "Anything Everywhere")).toBe(true);
    expect(report.warnings).toEqual([]);
  });

  it("a Get/Set chain resolving to a producer the graph lacks is reported, not silently cleared", () => {
    // Pass 1 resolves the bus, but the producer serializes no output slot, so no
    // replacement link can be built. Discarding that left the virtual deleted and
    // the consumer quietly disconnected.
    const g: UiWorkflow = {
      nodes: [
        node(1, "CheckpointLoaderSimple"), // no outputs array at all
        node(2, "SetNode", {
          widgets_values: ["m"],
          inputs: [{ name: "MODEL", type: "MODEL", link: 10 }],
          outputs: [{ name: "*", type: "*", links: [] }],
        }),
        node(3, "GetNode", {
          widgets_values: ["m"],
          outputs: [{ name: "MODEL", type: "MODEL", links: [11] }],
        }),
        node(4, "KSampler", { inputs: [{ name: "model", type: "MODEL", link: 11 }] }),
      ],
      links: [
        [10, 1, 0, 2, 0, "MODEL"],
        [11, 3, 0, 4, 0, "MODEL"],
      ],
      last_link_id: 11,
    };
    const { graph, report } = flattenUiWorkflow(g);
    const sampler = graph.nodes.find((n) => n.type === "KSampler")!;
    expect(sampler.inputs![0].link).toBeNull();
    expect(report.warnings.join("\n")).toContain("which this graph does not have");
    expect(report.warnings.join("\n")).toContain('KSampler #4 input "model"');
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
    // Membership is by NAME, not by name SHAPE. A prefix match briefly stood in
    // for it and let a foreign class be treated as a sender, whose stale record
    // then passed the feed check and fabricated an edge. An unrecognized class is
    // now reported instead (see the no-recognized-sender backstop), so a closed
    // set costs a disclosed unknown rather than a silent drop.
    for (const t of ["Seed Everywhere Helper", "Anything Everywhere Deluxe", "Prompts Everywhere Pro"]) {
      expect(isUeSender(t), `${t} must not be taken for a UE sender`).toBe(false);
    }
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
