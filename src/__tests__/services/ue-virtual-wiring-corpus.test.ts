// SHARED ADVERSARIAL CORPUS — one table of virtual-wiring graph shapes, run
// against BOTH tools that resolve them:
//
//   • strip_workflow / panel_strip_workflow  → convertUiToApi
//   • panel_flatten_workflow                 → flattenUiWorkflow
//
// The two keep SEPARATE implementations of the same policy on purpose: they walk
// different link representations, and their invariants genuinely differ — the
// converter may DROP a connection (its output is a fresh executable graph), while
// the flattener edits the user's graph in place and may only DECLINE TO ADD. A
// shared helper serving both would need a mode flag on every decision, and a
// safety check parameterised by "am I allowed to delete" is subtly wrong for at
// least one caller.
//
// Duplicated implementations are not what makes this defect family recur —
// DIVERGENCE is. So the coupling lives here instead: same inputs, both tools,
// per-tool expectations stated separately wherever they legitimately differ. When
// the next cg-use-everywhere class or record shape shows up, it is added once and
// both tools are immediately held to it.
//
// Each case states the OBSERVABLE outcome — which consumer input ends up fed by
// which producer, which nodes survive, and what the caller is told — never how
// either tool got there.
import { describe, expect, it } from "vitest";
import { convertUiToApi } from "../../services/workflow-converter.js";
import { flattenUiWorkflow } from "../../services/flatten-workflow.js";
import type { UiNode, UiWorkflow } from "../../comfyui/types.js";

const OBJECT_INFO = {
  ProducerA: { input: { required: {} }, output: ["IMAGE"], output_name: ["IMAGE"] },
  ProducerB: { input: { required: {} }, output: ["IMAGE"], output_name: ["IMAGE"] },
  Consumer: { input: { required: { image: ["IMAGE"] } } },
  Consumer2: { input: { required: { image: ["IMAGE"] } } },
  "Anything Everywhere": { input: { required: {}, optional: { anything: ["*"] } } },
  "Anything Everywhere3": {
    input: { required: {}, optional: { anything: ["*"], anything2: ["*"] } },
  },
  "Prompts Everywhere": {
    input: { required: {}, optional: { anything: ["*"], anything2: ["*"] } },
  },
  "Seed Everywhere": { input: { required: {} }, output: ["IMAGE"], output_name: ["IMAGE"] },
  "Seed Everywhere?": { input: { required: {} }, output: ["IMAGE"], output_name: ["IMAGE"] },
  // Deliberately NOT name-alike with any cg-use-everywhere family: stands in for
  // a broadcast class neither tool recognizes.
  "Broadcast Anything": { input: { required: {}, optional: { anything: ["*"] } } },
  // Name-alike with a real sender family but NOT one of its classes.
  "Seed Everywhere Helper": { input: { required: {}, optional: { anything: ["*"] } } },
} as never;

// ── graph-building helpers ──────────────────────────────────────────────────

function n(id: number, type: string, extra: Partial<UiNode> = {}): UiNode {
  return {
    id,
    type,
    pos: [id * 100, 0],
    mode: 0,
    inputs: [],
    outputs: [],
    widgets_values: [],
    properties: {},
    ...extra,
  } as UiNode;
}
const producer = (id: number, type = "ProducerA", links: number[] = []) =>
  n(id, type, { outputs: [{ name: "IMAGE", type: "IMAGE", links }] });
const consumer = (id: number, type = "Consumer", link: number | null = null) =>
  n(id, type, { inputs: [{ name: "image", type: "IMAGE", link }] });
const sender = (id: number, type: string, links: (number | null)[] = [null]) =>
  n(id, type, {
    inputs: links.map((l, i) => ({
      name: i === 0 ? "anything" : `anything${i + 1}`,
      type: "*",
      link: l,
    })),
  });

interface UeRecord {
  downstream: number;
  downstream_slot: number;
  upstream: number;
  upstream_slot: number;
  controller?: number;
  type?: string;
}
const rec = (
  downstream: number,
  upstream: number,
  controller?: number,
): UeRecord => ({
  downstream,
  downstream_slot: 0,
  upstream,
  upstream_slot: 0,
  ...(controller == null ? {} : { controller }),
  type: "IMAGE",
});

function graph(
  nodes: UiNode[],
  links: UiWorkflow["links"],
  extra?: Record<string, unknown>,
): UiWorkflow {
  return {
    nodes,
    links,
    last_link_id: Math.max(0, ...links.map((l) => l[0])),
    extra: extra ?? {},
  } as UiWorkflow;
}

// ── uniform outcome adapters ────────────────────────────────────────────────
// Both return the same shape so ONE assertion routine covers both tools.

interface Outcome {
  warnings: string[];
  /** Class/type of the producer feeding <consumer>.<input>, null if unconnected,
   *  "<absent>" when the consumer itself is not in the result. */
  producerOf(consumerType: string, input: string): string | null;
  survives(type: string): boolean;
}

function apiOutcome(g: UiWorkflow): Outcome {
  const { workflow, warnings } = convertUiToApi(structuredClone(g), OBJECT_INFO);
  const entriesOf = (t: string) =>
    Object.entries(workflow).filter(([, node]) => node.class_type === t);
  return {
    warnings,
    producerOf(consumerType, input) {
      const entries = entriesOf(consumerType);
      if (entries.length === 0) return "<absent>";
      const value = (entries[0][1].inputs as Record<string, unknown>)[input];
      if (!Array.isArray(value)) return null;
      return workflow[String(value[0])]?.class_type ?? "<dangling>";
    },
    survives: (t) => entriesOf(t).length > 0,
  };
}

function flatOutcome(g: UiWorkflow): Outcome {
  const { graph: out, report } = flattenUiWorkflow(structuredClone(g));
  const linkById = new Map(
    (out.links ?? []).filter((l) => Array.isArray(l)).map((l) => [l[0], l]),
  );
  return {
    warnings: report.warnings,
    producerOf(consumerType, input) {
      const node = out.nodes.find((x) => x.type === consumerType);
      if (!node) return "<absent>";
      const inp = (node.inputs ?? []).find((i) => i.name === input);
      if (!inp || inp.link == null) return null;
      const link = linkById.get(inp.link);
      if (!link) return "<dangling>";
      return out.nodes.find((x) => x.id === link[1])?.type ?? "<dangling>";
    },
    survives: (t) => out.nodes.some((x) => x.type === t),
  };
}

// ── the corpus ──────────────────────────────────────────────────────────────

interface Expect {
  /** "ConsumerType.inputName" → producer type, or null for unconnected. */
  wiring: Record<string, string | null>;
  /** Each pattern must appear somewhere in this tool's warnings. */
  discloses?: RegExp[];
  /** This tool must say nothing at all. */
  silent?: boolean;
  /** Node types that must still be present in the result. */
  keeps?: string[];
  /** Node types that must be gone from the result. */
  removes?: string[];
}

interface Case {
  name: string;
  /** Why this shape is dangerous — the failure it guards. */
  why: string;
  graph: () => UiWorkflow;
  api: Expect;
  flat: Expect;
  /** Set when the two tools' outcomes differ, with the justification. */
  divergence?: string;
  /** The resulting WIRING differs between the tools. Requires `divergence` to
   *  say why — a wiring difference may never be waved through undocumented. */
  wiringDiverges?: boolean;
}

const CORPUS: Case[] = [
  {
    name: "resolvable Get/Set bus",
    why: "the baseline: a healthy bus must resolve to the real producer, with nothing reported. Guards against the disclosure firing on a graph that loses nothing.",
    graph: () =>
      graph(
        [
          producer(1, "ProducerA", [10]),
          n(4, "SetNode", {
            widgets_values: ["bus"],
            inputs: [{ name: "value", type: "IMAGE", link: 10 }],
            outputs: [{ name: "*", type: "*", links: [] }],
          }),
          n(5, "GetNode", {
            widgets_values: ["bus"],
            outputs: [{ name: "IMAGE", type: "IMAGE", links: [11] }],
          }),
          consumer(3, "Consumer", 11),
        ],
        [
          [10, 1, 0, 4, 0, "IMAGE"],
          [11, 5, 0, 3, 0, "IMAGE"],
        ],
      ),
    api: { wiring: { "Consumer.image": "ProducerA" }, silent: true, removes: ["GetNode", "SetNode"] },
    flat: { wiring: { "Consumer.image": "ProducerA" }, silent: true, removes: ["GetNode", "SetNode"] },
  },
  {
    name: "orphan Get bus (no Set writes it)",
    why: "issue #361's reported symptom: the connection cannot be recovered, so it MUST be named rather than quietly dropped.",
    graph: () =>
      graph(
        [
          n(5, "GetNode", {
            widgets_values: ["missing"],
            outputs: [{ name: "IMAGE", type: "IMAGE", links: [11] }],
          }),
          consumer(3, "Consumer", 11),
        ],
        [[11, 5, 0, 3, 0, "IMAGE"]],
      ),
    api: { wiring: { "Consumer.image": null }, discloses: [/missing/, /Consumer/] },
    flat: { wiring: { "Consumer.image": null }, discloses: [/dangling GetNode chain/] },
    divergence:
      "wording only — both leave the input unconnected and both name the consumer.",
  },
  {
    name: "Reroute with no incoming connection",
    why: "same class as the orphan bus, via the other virtual node type.",
    graph: () =>
      graph(
        [
          n(9, "Reroute", {
            inputs: [{ name: "", type: "IMAGE", link: null }],
            outputs: [{ name: "", type: "IMAGE", links: [30] }],
          }),
          consumer(3, "Consumer", 30),
        ],
        [[30, 9, 0, 3, 0, "IMAGE"]],
      ),
    api: { wiring: { "Consumer.image": null }, discloses: [/Reroute #9 has no incoming connection/] },
    flat: { wiring: { "Consumer.image": null }, discloses: [/dangling Reroute chain/] },
  },
  {
    name: "two Set nodes writing one bus",
    why: "the graph's meaning is genuinely ambiguous; whichever producer wins, the other is unreachable and the caller should know.",
    graph: () =>
      graph(
        [
          producer(1, "ProducerA", [10]),
          producer(2, "ProducerB", [12]),
          n(4, "SetNode", {
            widgets_values: ["bus"],
            inputs: [{ name: "value", type: "IMAGE", link: 10 }],
            outputs: [{ name: "*", type: "*", links: [] }],
          }),
          n(6, "SetNode", {
            widgets_values: ["bus"],
            inputs: [{ name: "value", type: "IMAGE", link: 12 }],
            outputs: [{ name: "*", type: "*", links: [] }],
          }),
          n(5, "GetNode", {
            widgets_values: ["bus"],
            outputs: [{ name: "IMAGE", type: "IMAGE", links: [11] }],
          }),
          consumer(3, "Consumer", 11),
        ],
        [
          [10, 1, 0, 4, 0, "IMAGE"],
          [12, 2, 0, 6, 0, "IMAGE"],
          [11, 5, 0, 3, 0, "IMAGE"],
        ],
      ),
    api: { wiring: { "Consumer.image": "ProducerB" }, discloses: [/more than one Set node/] },
    flat: { wiring: { "Consumer.image": "ProducerB" }, discloses: [/multiple Set nodes write bus/] },
  },
  {
    name: "UE broadcast, current record",
    why: "the healthy UE path. Must produce a real connection and say nothing.",
    graph: () =>
      graph(
        [
          producer(1, "ProducerA", [20]),
          sender(7, "Anything Everywhere", [20]),
          consumer(3, "Consumer", null),
        ],
        [[20, 1, 0, 7, 0, "IMAGE"]],
        { ue_links: [rec(3, 1, 7)] },
      ),
    api: { wiring: { "Consumer.image": "ProducerA" }, silent: true, keeps: ["Anything Everywhere"] },
    flat: { wiring: { "Consumer.image": "ProducerA" }, silent: true, removes: ["Anything Everywhere"] },
    divergence:
      "the converter emits the sender as an ordinary (no-output) node in the prompt; the flattener removes it once its broadcast is materialized, which is its whole purpose. Both produce the same wiring.",
  },
  {
    name: "UE record whose sender was REWIRED",
    why: "the fabrication case: honoring it would emit an edge the live graph does not have, which renders as a plausible graph that is silently wrong.",
    graph: () =>
      graph(
        [
          producer(1, "ProducerA", []),
          producer(2, "ProducerB", [21]),
          sender(7, "Anything Everywhere", [21]),
          consumer(3, "Consumer", null),
        ],
        [[21, 2, 0, 7, 0, "IMAGE"]],
        { ue_links: [rec(3, 1, 7)] },
      ),
    api: { wiring: { "Consumer.image": null }, discloses: [/fed by a different producer/] },
    flat: {
      wiring: { "Consumer.image": null },
      discloses: [/fed by a different producer/],
      keeps: ["Anything Everywhere"],
    },
  },
  {
    name: "UE record whose sender was DISCONNECTED",
    why: "a sender with no feed broadcasts nothing; the record is left over.",
    graph: () =>
      graph(
        [
          producer(1, "ProducerA", []),
          sender(7, "Anything Everywhere", [null]),
          consumer(3, "Consumer", null),
        ],
        [],
        { ue_links: [rec(3, 1, 7)] },
      ),
    api: { wiring: { "Consumer.image": null }, discloses: [/no longer has any incoming connection/] },
    flat: {
      wiring: { "Consumer.image": null },
      discloses: [/no longer has any incoming connection/],
      keeps: ["Anything Everywhere"],
    },
  },
  {
    name: "UE record naming a controller that is no longer a sender",
    why: "the id survived but was reused by an ordinary node; existence alone is not evidence.",
    graph: () =>
      graph(
        [
          producer(1, "ProducerA", [22]),
          sender(7, "Anything Everywhere", [22]),
          consumer(3, "Consumer", null),
        ],
        [[22, 1, 0, 7, 0, "IMAGE"]],
        { ue_links: [rec(3, 1, 1)] }, // controller 1 is a ProducerA
      ),
    api: { wiring: { "Consumer.image": null }, discloses: [/no longer a broadcast node/] },
    flat: { wiring: { "Consumer.image": null }, discloses: [/no longer a broadcast node/] },
  },
  {
    name: "CONTROLLERLESS record (older list), producer is not a sender",
    why: "unattributable — an unrelated sender sharing the producer proves nothing about THIS target.",
    graph: () =>
      graph(
        [
          producer(1, "ProducerA", [23]),
          sender(7, "Anything Everywhere", [23]),
          consumer(3, "Consumer", null),
        ],
        [[23, 1, 0, 7, 0, "IMAGE"]],
        { ue_links: [rec(3, 1)] },
      ),
    api: { wiring: { "Consumer.image": null }, discloses: [/cannot be attributed to any sender/] },
    flat: {
      wiring: { "Consumer.image": null },
      discloses: [/cannot be attributed to any sender/],
      keeps: ["Anything Everywhere"],
    },
  },
  {
    name: "CONTROLLERLESS record whose producer IS a self-producing sender",
    why: "self-attributing: a Seed Everywhere owns its value and has one channel, so there is nothing left to guess. Refusing it would drop a live broadcast.",
    graph: () =>
      graph([n(9, "Seed Everywhere", { outputs: [{ name: "IMAGE", type: "IMAGE", links: [] }] }), consumer(3, "Consumer", null)], [], {
        ue_links: [rec(3, 9)],
      }),
    api: { wiring: { "Consumer.image": "Seed Everywhere" }, silent: true },
    flat: { wiring: { "Consumer.image": "Seed Everywhere" }, silent: true, keeps: ["Seed Everywhere"] },
    divergence:
      "the flattener keeps a Seed Everywhere because it IS the real producer of the link it just created.",
  },
  {
    name: "'Seed Everywhere?' — a registered class the predicate used to miss",
    why: "an unrecognized sender made both tools conclude there were no broadcasts at all: a real one dropped with nothing said.",
    graph: () =>
      graph(
        [n(9, "Seed Everywhere?", { outputs: [{ name: "IMAGE", type: "IMAGE", links: [] }] }), consumer(3, "Consumer", null)],
        [],
        { ue_links: [rec(3, 9, 9)] },
      ),
    api: { wiring: { "Consumer.image": "Seed Everywhere?" }, silent: true },
    flat: { wiring: { "Consumer.image": "Seed Everywhere?" }, silent: true },
  },
  {
    name: "FOREIGN class sharing a sender name prefix, and genuinely FED",
    why: "the fabrication direction. #9 really is fed by ProducerA, so a feed check alone confirms this record and emits the edge. Membership cannot be inferred from a name shape, and no feed check rescues a wrong classification — a prefix match here invented wiring in BOTH tools.",
    graph: () =>
      graph(
        [
          producer(1, "ProducerA", [40]),
          n(9, "Seed Everywhere Helper", { inputs: [{ name: "anything", type: "*", link: 40 }] }),
          consumer(3, "Consumer", null),
        ],
        [[40, 1, 0, 9, 0, "IMAGE"]],
        { ue_links: [rec(3, 1, 9)] },
      ),
    api: {
      wiring: { "Consumer.image": null },
      discloses: [/no node in it is recognized as a cg-use-everywhere broadcast node/],
      keeps: ["Seed Everywhere Helper"],
    },
    flat: {
      wiring: { "Consumer.image": null },
      discloses: [/no node in this graph is recognized as a Use-Everywhere sender/],
      keeps: ["Seed Everywhere Helper"],
    },
  },
  {
    name: "records present, NO recognized sender class",
    why: "the backstop for the NEXT unknown class: a deleted sender and an unrecognized one are indistinguishable, so it degrades to a disclosed unknown instead of a silent drop. A closed recognition set is only safe BECAUSE this exists, so both tools must have it.",
    graph: () =>
      graph(
        [
          producer(1, "ProducerA", [24]),
          n(7, "Broadcast Anything", { inputs: [{ name: "anything", type: "*", link: 24 }] }),
          consumer(3, "Consumer", null),
        ],
        [[24, 1, 0, 7, 0, "IMAGE"]],
        { ue_links: [rec(3, 1, 7)] },
      ),
    api: { wiring: { "Consumer.image": null }, discloses: [/no node in it is recognized as a cg-use-everywhere broadcast node/] },
    flat: { wiring: { "Consumer.image": null }, discloses: [/no node in this graph is recognized as a Use-Everywhere sender/] },
  },
  {
    name: "self-producing sender recorded THROUGH a Reroute",
    why: "the pack records the virtual in front of a producer as readily as the producer. Testing the raw upstream against the controller called this a mismatch, fell through to the feed check, found a Seed has no feed, and DROPPED a live broadcast — while the other tool normalized first and kept it.",
    graph: () =>
      graph(
        [
          n(1, "Seed Everywhere", { outputs: [{ name: "IMAGE", type: "IMAGE", links: [41] }] }),
          n(2, "Reroute", {
            inputs: [{ name: "", type: "IMAGE", link: 41 }],
            outputs: [{ name: "", type: "IMAGE", links: [] }],
          }),
          consumer(3, "Consumer", null),
        ],
        [[41, 1, 0, 2, 0, "IMAGE"]],
        { ue_links: [{ downstream: 3, downstream_slot: 0, upstream: 2, upstream_slot: 0, controller: 1, type: "IMAGE" }] },
      ),
    api: { wiring: { "Consumer.image": "Seed Everywhere" }, silent: true },
    flat: { wiring: { "Consumer.image": "Seed Everywhere" }, silent: true },
  },
  {
    name: "recorded producer serializes NO outputs array",
    why: "an absent outputs array is could-not-determine, not a definite yes. Trusting it emitted an executable edge to a slot nothing proves exists; refusing silently would hide a loss. Unknown gets its own outcome: refuse AND say so.",
    graph: () => {
      const seed = n(9, "Seed Everywhere", {});
      delete (seed as { outputs?: unknown }).outputs; // no outputs key at all
      return graph([seed, consumer(3, "Consumer", null)], [], { ue_links: [rec(3, 9, 9)] });
    },
    api: { wiring: { "Consumer.image": null }, discloses: [/serializes no outputs at all/] },
    flat: { wiring: { "Consumer.image": null }, discloses: [/which this graph does not have/] },
    divergence: "wording only — both refuse the record and both say why.",
  },
  {
    name: "multi-input sender with one KNOWN and one UNRESOLVABLE producer",
    why: "the channel caveat is keyed on distinct producers, and an unresolved input contributed nothing to that set — so a sender with one known and one unknown producer read as 'one producer, nothing to confuse', silencing the caveat exactly where a stale channel swap is most likely.",
    graph: () => {
      // Input B is fed by a Get whose bus no Set writes: a real input, genuinely
      // unresolvable, so its producer is UNKNOWN rather than absent.
      const g = graph(
        [
          producer(1, "ProducerA", [42]),
          n(5, "GetNode", {
            widgets_values: ["nobody-writes-this"],
            outputs: [{ name: "IMAGE", type: "IMAGE", links: [43] }],
          }),
          sender(7, "Anything Everywhere3", [42, 43]),
          consumer(3, "Consumer", null),
        ],
        [
          [42, 1, 0, 7, 0, "IMAGE"],
          [43, 5, 0, 7, 1, "IMAGE"],
        ],
        { ue_links: [rec(3, 1, 7)] },
      );
      return g;
    },
    api: {
      wiring: { "Consumer.image": "ProducerA" },
      // The caveat must say what is TRUE of THIS shape: one confirmed producer
      // and one input whose source could not be resolved. Claiming "every
      // producer was confirmed" here would be a false statement inside a
      // disclosure, which is how disclosures get ignored.
      discloses: [/could not be matched to a specific sender input/, /could NOT be resolved/],
    },
    flat: {
      wiring: { "Consumer.image": "ProducerA" },
      discloses: [/could not be matched to a specific sender input/, /could NOT be resolved/],
    },
  },
  {
    name: "PARTIAL ue_links (a live sender the list does not mention)",
    why: "a non-empty list is not proof it accounts for every sender; the flattener used to DELETE the one it omitted.",
    graph: () =>
      graph(
        [
          producer(1, "ProducerA", [25]),
          sender(7, "Anything Everywhere", [25]),
          sender(8, "Anything Everywhere", [null]),
          consumer(3, "Consumer", null),
        ],
        [[25, 1, 0, 7, 0, "IMAGE"]],
        { ue_links: [rec(3, 1, 7)] },
      ),
    api: {
      wiring: { "Consumer.image": "ProducerA" },
      discloses: [/no record in extra\.ue_links names it/],
    },
    flat: {
      wiring: { "Consumer.image": "ProducerA" },
      discloses: [/no record in extra\.ue_links names it/],
      keeps: ["Anything Everywhere"],
    },
  },
  {
    name: "multi-input sender, DISTINCT producers per channel",
    why: "a record does not name the sender input it came through, so a stale list that only SWAPPED channels is indistinguishable from a current one. Materialized, but the residual is disclosed.",
    graph: () =>
      graph(
        [
          producer(1, "ProducerA", [26]),
          producer(2, "ProducerB", [27]),
          sender(7, "Anything Everywhere3", [26, 27]),
          consumer(3, "Consumer", null),
          consumer(4, "Consumer2", null),
        ],
        [
          [26, 1, 0, 7, 0, "IMAGE"],
          [27, 2, 0, 7, 1, "IMAGE"],
        ],
        { ue_links: [rec(3, 1, 7), rec(4, 2, 7)] },
      ),
    api: {
      wiring: { "Consumer.image": "ProducerA", "Consumer2.image": "ProducerB" },
      // Here every producer really WAS confirmed — the wording must distinguish
      // this from the one-known-one-unresolved shape above.
      discloses: [/could not be matched to a specific sender input/, /2 different confirmed producers/],
    },
    flat: {
      wiring: { "Consumer.image": "ProducerA", "Consumer2.image": "ProducerB" },
      discloses: [/could not be matched to a specific sender input/, /2 different confirmed producers/],
    },
  },
  {
    name: "multi-input sender whose second producer CANNOT be confirmed",
    why: "the caveat must count what the materializer would actually accept. ProducerB's output slot is unconfirmable under the absent-outputs rule, so calling it a confirmed producer states something the same code would refuse — a false fact inside a disclosure.",
    graph: () => {
      const pb = producer(2, "ProducerB", [27]);
      delete (pb as { outputs?: unknown }).outputs;
      return graph(
        [
          producer(1, "ProducerA", [26]),
          pb,
          sender(7, "Anything Everywhere3", [26, 27]),
          consumer(3, "Consumer", null),
        ],
        [
          [26, 1, 0, 7, 0, "IMAGE"],
          [27, 2, 0, 7, 1, "IMAGE"],
        ],
        { ue_links: [rec(3, 1, 7)] },
      );
    },
    api: {
      wiring: { "Consumer.image": "ProducerA" },
      discloses: [
        /could not be matched to a specific sender input/,
        /1 confirmed producer\(s\) plus 1 input\(s\)/,
      ],
    },
    flat: {
      wiring: { "Consumer.image": "ProducerA" },
      discloses: [
        /could not be matched to a specific sender input/,
        /1 confirmed producer\(s\) plus 1 input\(s\)/,
      ],
    },
  },
  {
    name: "multi-input sender, ONE producer on every channel",
    why: "no channel to confuse — the caveat must NOT fire, or it becomes noise on every multi-input graph and gets ignored.",
    graph: () =>
      graph(
        [
          producer(1, "ProducerA", [28, 29]),
          sender(7, "Anything Everywhere3", [28, 29]),
          consumer(3, "Consumer", null),
        ],
        [
          [28, 1, 0, 7, 0, "IMAGE"],
          [29, 1, 0, 7, 1, "IMAGE"],
        ],
        { ue_links: [rec(3, 1, 7)] },
      ),
    api: { wiring: { "Consumer.image": "ProducerA" }, silent: true },
    flat: { wiring: { "Consumer.image": "ProducerA" }, silent: true },
  },
  {
    name: "UE sender fed THROUGH a Get/Set bus",
    why: "the producer sits behind virtual wiring; both tools must resolve it, and the staleness check must not read the rewired feed as unresolvable and refuse a live broadcast.",
    graph: () =>
      graph(
        [
          producer(1, "ProducerA", [30]),
          n(4, "SetNode", {
            widgets_values: ["bus"],
            inputs: [{ name: "value", type: "IMAGE", link: 30 }],
            outputs: [{ name: "*", type: "*", links: [] }],
          }),
          n(5, "GetNode", {
            widgets_values: ["bus"],
            outputs: [{ name: "IMAGE", type: "IMAGE", links: [31] }],
          }),
          sender(7, "Anything Everywhere", [31]),
          consumer(3, "Consumer", null),
        ],
        [
          [30, 1, 0, 4, 0, "IMAGE"],
          [31, 5, 0, 7, 0, "IMAGE"],
        ],
        { ue_links: [rec(3, 1, 7)] },
      ),
    api: { wiring: { "Consumer.image": "ProducerA" }, silent: true },
    flat: { wiring: { "Consumer.image": "ProducerA" }, silent: true },
  },
  {
    name: "UE record whose upstream IS the bus node",
    why: "the pack records the virtual in front of the producer as often as the producer; a GetNode has no incoming link and must be followed over its bus.",
    graph: () =>
      graph(
        [
          producer(1, "ProducerA", [32]),
          n(4, "SetNode", {
            widgets_values: ["bus"],
            inputs: [{ name: "value", type: "IMAGE", link: 32 }],
            outputs: [{ name: "*", type: "*", links: [] }],
          }),
          n(5, "GetNode", {
            widgets_values: ["bus"],
            outputs: [{ name: "IMAGE", type: "IMAGE", links: [33] }],
          }),
          sender(7, "Anything Everywhere", [33]),
          consumer(3, "Consumer", null),
        ],
        [
          [32, 1, 0, 4, 0, "IMAGE"],
          [33, 5, 0, 7, 0, "IMAGE"],
        ],
        { ue_links: [rec(3, 5, 7)] },
      ),
    api: { wiring: { "Consumer.image": "ProducerA" }, silent: true },
    flat: { wiring: { "Consumer.image": "ProducerA" }, silent: true },
  },
  {
    name: "EMPTY computed ue_links list",
    why: "an ANSWER, not an unknown — the pack analysed the graph and recorded no broadcast. Reporting it invents a loss, and it is not a licence to delete the senders either.",
    graph: () =>
      graph(
        [
          producer(1, "ProducerA", [34]),
          sender(7, "Anything Everywhere", [34]),
          consumer(3, "Consumer", null),
        ],
        [[34, 1, 0, 7, 0, "IMAGE"]],
        { ue_links: [] },
      ),
    api: { wiring: { "Consumer.image": null }, silent: true, keeps: ["Anything Everywhere"] },
    flat: { wiring: { "Consumer.image": null }, silent: true, keeps: ["Anything Everywhere"] },
  },
  {
    name: "one subgraph definition instantiated TWICE, with a bus inside it",
    why: "each instance must get its OWN expanded copy with its own resolved wiring; sharing or cross-wiring them would silently hand two consumers the same node.",
    graph: () => {
      const SG = "subgraph:Doubler";
      const g = graph(
        [
          n(706, SG, {
            inputs: [],
            outputs: [{ name: "IMAGE", type: "IMAGE", links: [50] }],
          }),
          n(707, SG, {
            inputs: [],
            outputs: [{ name: "IMAGE", type: "IMAGE", links: [51] }],
          }),
          consumer(3, "Consumer", 50),
          consumer(4, "Consumer2", 51),
        ],
        [
          [50, 706, 0, 3, 0, "IMAGE"],
          [51, 707, 0, 4, 0, "IMAGE"],
        ],
      );
      (g as UiWorkflow).definitions = {
        subgraphs: [
          {
            id: SG,
            name: "Doubler",
            inputNode: { id: -10 },
            outputNode: { id: -20 },
            inputs: [],
            outputs: [{ id: "o1", name: "IMAGE", type: "IMAGE", linkIds: [102] }],
            widgets: [],
            nodes: [
              producer(50, "ProducerA", [101]),
              n(51, "SetNode", {
                widgets_values: ["inner"],
                inputs: [{ name: "value", type: "IMAGE", link: 101 }],
                outputs: [{ name: "*", type: "*", links: [] }],
              }),
              n(52, "GetNode", {
                widgets_values: ["inner"],
                outputs: [{ name: "IMAGE", type: "IMAGE", links: [102] }],
              }),
            ],
            links: [
              { id: 101, origin_id: 50, origin_slot: 0, target_id: 51, target_slot: 0, type: "IMAGE" },
              { id: 102, origin_id: 52, origin_slot: 0, target_id: -20, target_slot: 0, type: "IMAGE" },
            ],
          },
        ],
      };
      return g;
    },
    api: {
      wiring: { "Consumer.image": "ProducerA", "Consumer2.image": "ProducerA" },
      silent: true,
      removes: ["GetNode", "SetNode"],
    },
    flat: {
      wiring: { "Consumer.image": "subgraph:Doubler", "Consumer2.image": "subgraph:Doubler" },
      silent: true,
      keeps: ["subgraph:Doubler"],
    },
    wiringDiverges: true,
    divergence:
      "the flattener does NOT expand subgraph definitions — it flattens virtual wiring in the graph it is given and keeps every real node in place, so the consumers stay wired to the instances. The converter emits an executable prompt, which requires expanding them. Both are correct for their contract, and neither loses a connection.",
  },
  {
    name: "record names a virtual that serializes NO outputs key",
    why: "the absent-outputs rule is right but must be applied to the REAL producer. Judging the Reroute — which has no outputs of its own — refused a live edge in one tool while the other resolved past it and kept it.",
    graph: () => {
      const reroute = n(2, "Reroute", { inputs: [{ name: "", type: "IMAGE", link: 41 }] });
      delete (reroute as { outputs?: unknown }).outputs;
      return graph(
        [
          n(1, "Seed Everywhere", { outputs: [{ name: "IMAGE", type: "IMAGE", links: [41] }] }),
          reroute,
          consumer(3, "Consumer", null),
        ],
        [[41, 1, 0, 2, 0, "IMAGE"]],
        { ue_links: [{ downstream: 3, downstream_slot: 0, upstream: 2, upstream_slot: 0, controller: 1, type: "IMAGE" }] },
      );
    },
    api: { wiring: { "Consumer.image": "Seed Everywhere" }, silent: true },
    flat: { wiring: { "Consumer.image": "Seed Everywhere" }, silent: true },
  },
  {
    name: "record resolves through a CHAIN of two virtuals (Reroute → Get/Set bus)",
    why: "normalization has to be transitive, not one hop. A single-hop resolver reaches the SetNode and stops there.",
    graph: () =>
      graph(
        [
          producer(1, "ProducerA", [60]),
          n(4, "SetNode", {
            widgets_values: ["bus"],
            inputs: [{ name: "value", type: "IMAGE", link: 60 }],
            outputs: [{ name: "*", type: "*", links: [] }],
          }),
          n(5, "GetNode", {
            widgets_values: ["bus"],
            outputs: [{ name: "IMAGE", type: "IMAGE", links: [61] }],
          }),
          n(6, "Reroute", {
            inputs: [{ name: "", type: "IMAGE", link: 61 }],
            outputs: [{ name: "", type: "IMAGE", links: [62] }],
          }),
          sender(7, "Anything Everywhere", [62]),
          consumer(3, "Consumer", null),
        ],
        [
          [60, 1, 0, 4, 0, "IMAGE"],
          [61, 5, 0, 6, 0, "IMAGE"],
          [62, 6, 0, 7, 0, "IMAGE"],
        ],
        { ue_links: [{ downstream: 3, downstream_slot: 0, upstream: 6, upstream_slot: 0, controller: 7, type: "IMAGE" }] },
      ),
    api: { wiring: { "Consumer.image": "ProducerA" }, silent: true },
    flat: { wiring: { "Consumer.image": "ProducerA" }, silent: true },
  },
  {
    name: "record whose producer chain is a CYCLE",
    why: "a malformed graph must terminate and disclose, not hang and not quietly wire something.",
    graph: () =>
      graph(
        [
          n(2, "Reroute", {
            inputs: [{ name: "", type: "IMAGE", link: 71 }],
            outputs: [{ name: "", type: "IMAGE", links: [70] }],
          }),
          n(3, "Reroute", {
            inputs: [{ name: "", type: "IMAGE", link: 70 }],
            outputs: [{ name: "", type: "IMAGE", links: [71] }],
          }),
          sender(7, "Anything Everywhere", [70]),
          consumer(4, "Consumer", null),
        ],
        [
          [70, 2, 0, 3, 0, "IMAGE"],
          [71, 3, 0, 2, 0, "IMAGE"],
        ],
        { ue_links: [{ downstream: 4, downstream_slot: 0, upstream: 2, upstream_slot: 0, controller: 7, type: "IMAGE" }] },
      ),
    api: { wiring: { "Consumer.image": null }, discloses: [/could not be resolved|cycle/i] },
    flat: { wiring: { "Consumer.image": null }, discloses: [/could not be resolved|dangling/i] },
  },
  {
    name: "subgraph boundary feed THROUGH a virtual, definition instantiated twice",
    why: "the hardest shape here: boundary + virtual wiring + UE + two instances at once. The boundary test compared a raw virtual id, so the materialized edge was never registered on the boundary and BOTH instances lost it — and a wrong fix would cross-wire instance A's consumer to instance B's producer.",
    graph: () => {
      const SG = "subgraph:Bus";
      const g = graph(
        [
          producer(1, "ProducerA", [50]),
          producer(9, "ProducerB", [51]),
          n(706, SG, { inputs: [{ name: "image", type: "IMAGE", link: 50 }] }),
          n(707, SG, { inputs: [{ name: "image", type: "IMAGE", link: 51 }] }),
        ],
        [
          [50, 1, 0, 706, 0, "IMAGE"],
          [51, 9, 0, 707, 0, "IMAGE"],
        ],
      );
      (g as UiWorkflow).definitions = {
        subgraphs: [
          {
            id: SG,
            name: "Bus",
            inputNode: { id: -10 },
            outputNode: { id: -20 },
            inputs: [{ id: "i1", name: "image", type: "IMAGE", linkIds: [11] }],
            outputs: [],
            widgets: [],
            extra: {
              ue_links: [
                { downstream: 3, downstream_slot: 0, upstream: 2, upstream_slot: 0, controller: 7, type: "IMAGE" },
              ],
            },
            nodes: [
              n(2, "Reroute", {
                inputs: [{ name: "", type: "IMAGE", link: 11 }],
                outputs: [{ name: "", type: "IMAGE", links: [12] }],
              }),
              sender(7, "Anything Everywhere", [12]),
              consumer(3, "Consumer", null),
            ],
            links: [
              { id: 11, origin_id: -10, origin_slot: 0, target_id: 2, target_slot: 0, type: "IMAGE" },
              { id: 12, origin_id: 2, origin_slot: 0, target_id: 7, target_slot: 0, type: "IMAGE" },
            ],
          },
        ],
      };
      return g;
    },
    // Both instances resolve to their OWN outer producer. `producerOf` reads the
    // first match, so the cross-instance check is the dedicated test below.
    api: { wiring: { "Consumer.image": "ProducerA" }, silent: true },
    flat: { wiring: { "Consumer.image": "<absent>" }, silent: true, keeps: ["subgraph:Bus"] },
    wiringDiverges: true,
    divergence:
      "the flattener does not expand subgraph definitions, so the inner Consumer never appears in the graph it returns at all (hence <absent>) and the instances stay in place untouched. The converter must expand them, once per instance. Neither loses a connection from the graph it is contracted to produce.",
  },
  {
    name: "SELF-PRODUCING sender inside a subgraph instantiated twice",
    why: "each instance must broadcast from its OWN expanded Seed. Sharing one would hand both consumers the same node and look perfectly plausible.",
    graph: () => {
      const SG = "subgraph:Seeded";
      const g = graph(
        [n(706, SG, { inputs: [] }), n(707, SG, { inputs: [] })],
        [],
      );
      (g as UiWorkflow).definitions = {
        subgraphs: [
          {
            id: SG,
            name: "Seeded",
            inputNode: { id: -10 },
            outputNode: { id: -20 },
            inputs: [],
            outputs: [],
            widgets: [],
            extra: { ue_links: [rec(3, 9, 9)] },
            nodes: [
              n(9, "Seed Everywhere", { outputs: [{ name: "IMAGE", type: "IMAGE", links: [] }] }),
              consumer(3, "Consumer", null),
            ],
            links: [],
          },
        ],
      };
      return g;
    },
    api: { wiring: { "Consumer.image": "Seed Everywhere" }, silent: true },
    flat: { wiring: { "Consumer.image": "<absent>" }, silent: true, keeps: ["subgraph:Seeded"] },
    wiringDiverges: true,
    divergence:
      "same expansion asymmetry: the inner Consumer is not in the flattened graph at all, so there is nothing there to materialize and nothing lost from what the flattener returns.",
  },
  {
    name: "MISSING ue_links list with senders present",
    why: "an unknown, not an answer: the broadcasts are unrecoverable from the file and the caller needs the remedy.",
    graph: () =>
      graph(
        [
          producer(1, "ProducerA", [35]),
          sender(7, "Anything Everywhere", [35]),
          consumer(3, "Consumer", null),
        ],
        [[35, 1, 0, 7, 0, "IMAGE"]],
        {},
      ),
    api: { wiring: { "Consumer.image": null }, discloses: [/CANNOT be recovered/], keeps: ["Anything Everywhere"] },
    flat: { wiring: { "Consumer.image": null }, discloses: [/ue_links is missing/], keeps: ["Anything Everywhere"] },
  },
];

// ── the shared assertion routine ────────────────────────────────────────────

function check(outcome: Outcome, expected: Expect) {
  for (const [target, want] of Object.entries(expected.wiring)) {
    const [consumerType, input] = target.split(".");
    expect(outcome.producerOf(consumerType, input), `${target}`).toBe(want);
  }
  for (const type of expected.keeps ?? []) {
    expect(outcome.survives(type), `${type} must survive`).toBe(true);
  }
  for (const type of expected.removes ?? []) {
    expect(outcome.survives(type), `${type} must be gone`).toBe(false);
  }
  const text = outcome.warnings.join("\n");
  for (const pattern of expected.discloses ?? []) {
    expect(text, `must disclose ${pattern}`).toMatch(pattern);
  }
  if (expected.silent) {
    expect(outcome.warnings, "must report nothing").toEqual([]);
  }
}

describe("virtual-wiring corpus — strip_workflow (convertUiToApi)", () => {
  for (const c of CORPUS) {
    it(c.name, () => check(apiOutcome(c.graph()), c.api));
  }
});

describe("virtual-wiring corpus — panel_flatten_workflow (flattenUiWorkflow)", () => {
  for (const c of CORPUS) {
    it(c.name, () => check(flatOutcome(c.graph()), c.flat));
  }
});

describe("virtual-wiring corpus — cross-tool invariants", () => {
  // The wiring a caller ends up with is the thing that must NOT diverge. Node
  // survival and warning wording legitimately do (the converter emits an
  // executable prompt, the flattener edits the canvas graph), so those are
  // asserted per tool above, not here.
  for (const c of CORPUS) {
    const shared = Object.keys(c.api.wiring).filter((k) => k in c.flat.wiring);
    if (shared.length === 0) continue;
    it(`${c.name} — both tools agree on the resulting wiring`, () => {
      if (c.wiringDiverges) {
        // A wiring difference is allowed only WITH a written justification, so a
        // divergence can never be waved through by flipping a flag.
        expect(c.divergence ?? "", `${c.name} must justify its wiring divergence`)
          .not.toBe("");
        return;
      }
      for (const target of shared) {
        expect(c.flat.wiring[target], `${target} expectation`).toBe(c.api.wiring[target]);
      }
    });
  }

  it("the flattener never returns two links sharing an id, for ANY corpus shape", () => {
    // A duplicate id makes every consumer input and producer output list keyed by
    // it ambiguous. Asserted across the whole table rather than per row, because
    // it is a property of the output, not of any one input shape.
    for (const c of CORPUS) {
      const { graph: out } = flattenUiWorkflow(structuredClone(c.graph()));
      const ids = (out.links ?? []).filter((l) => Array.isArray(l)).map((l) => l[0]);
      expect(new Set(ids).size, `${c.name} produced duplicate link ids`).toBe(ids.length);
    }
  });

  it("two instances of one definition never share or cross-wire a broadcast", () => {
    // `producerOf` reads the first matching consumer, so a table row cannot say
    // "instance A got A's producer and B got B's". A cross-wire here would look
    // entirely plausible in the result: every consumer connected, to the wrong
    // producer. Asserted directly.
    const c = CORPUS.find(
      (x) => x.name === "subgraph boundary feed THROUGH a virtual, definition instantiated twice",
    )!;
    const { workflow } = convertUiToApi(structuredClone(c.graph()), OBJECT_INFO);
    const feeders = Object.values(workflow)
      .filter((node) => node.class_type === "Consumer")
      .map((node) => {
        const v = (node.inputs as Record<string, unknown>).image;
        return Array.isArray(v) ? workflow[String(v[0])]?.class_type : null;
      });
    expect(feeders).toHaveLength(2);
    expect([...feeders].sort()).toEqual(["ProducerA", "ProducerB"]);
  });

  it("every case that loses a connection says so in BOTH tools", () => {
    const gaps: string[] = [];
    for (const c of CORPUS) {
      for (const [target, want] of Object.entries(c.api.wiring)) {
        if (want !== null) continue;
        const apiSays = !c.api.silent && (c.api.discloses ?? []).length > 0;
        const flatSays = !c.flat.silent && (c.flat.discloses ?? []).length > 0;
        // An intentionally-unconnected outcome (an empty computed list) is not a
        // loss, so silence is correct there; it is opted out via `silent`.
        if (c.api.silent && c.flat.silent) continue;
        if (!apiSays || !flatSays) {
          gaps.push(`${c.name} → ${target} (api discloses: ${apiSays}, flatten discloses: ${flatSays})`);
        }
      }
    }
    // No known gaps. A new entry here means one tool has started losing a
    // connection the other still reports — the exact divergence this corpus
    // exists to catch — so it must be justified in the case's `divergence`
    // field and added deliberately, never absorbed by relaxing this list.
    expect(gaps).toEqual([]);
  });
});
