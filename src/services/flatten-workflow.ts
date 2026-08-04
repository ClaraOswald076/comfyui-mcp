// In-place workflow flattener: resolve virtual wiring — rgthree/KJ Get/Set
// buses, Reroutes, and cg-use-everywhere (UE) broadcast links — into direct
// real links on the ORIGINAL UI graph, deleting the now-dead virtual nodes.
//
// This deliberately does NOT round-trip through the API converter
// (convertUiToApi → convertApiToUi): that regenerates the layout and throws
// away everything the author arranged. Litegraph groups are geometric (a
// titled bounding box — no node membership), so by never moving a kept node,
// positions/sizes/colors/groups/titles are preserved for free; the only
// visible change is the deleted virtual nodes leaving empty space.
//
// UE resolution strategy (see docs in the panel_flatten_workflow tool):
//   1. `extra.ue_links` — cg-use-everywhere writes its computed broadcast
//      links there on every graph analysis, as objects
//      { downstream, downstream_slot, upstream, upstream_slot, controller, type }
//      where `upstream` is already the REAL producer (for Seed Everywhere the
//      controller IS the producer — it owns the seed widget). Materializing
//      these is the pack's own ground truth: zero re-implementation.
//   2. If UE sender nodes exist but ue_links is absent/stale → warn and leave
//      those senders in place (never guess a broadcast match).
//
// Unlike the API converter, the resolver here stops at ANY real node
// regardless of mode: muted/bypassed toggle branches are the author's state
// and a wiring-only flatten must not collapse or drop them.

import type { UiLink, UiNode, UiWorkflow } from "../comfyui/types.js";

const GET_SET_TYPES = new Set([
  "GetNode", "SetNode", "PRO_GetNode", "PRO_SetNode",
  "SetNode_GetNode", "SetNode_SetNode",
]);
const isGetType = (t: string) => GET_SET_TYPES.has(t) && /get/i.test(t);
const isSetType = (t: string) => GET_SET_TYPES.has(t) && /set/i.test(t) && !/get/i.test(t);
const isRerouteType = (t: string) => t === "Reroute";
/** Wiring-only virtual node: exists purely to carry a connection. */
const isWiringVirtual = (t: string) => isRerouteType(t) || GET_SET_TYPES.has(t);

/**
 * cg-use-everywhere sender detection. The pack's own is_UEnode() prefix-matches
 * "Anything Everywhere" (so the "?" and "3" variants are covered) but compares
 * the other two families with EQUALITY — which misses the registered
 * "Seed Everywhere?" class. That asymmetry is an oversight, and here it is a
 * silent-loss bug: an unrecognized sender makes the materializer conclude there
 * are no broadcasts at all, dropping real ones with nothing said. Under-matching
 * costs a dropped connection; over-matching at worst asks the user to re-save.
 * All three families are therefore prefix-matched.
 */
export const isUeSender = (t: string): boolean =>
  t.startsWith("Anything Everywhere") ||
  t.startsWith("Seed Everywhere") ||
  t.startsWith("Prompts Everywhere");

/**
 * The UE senders that OWN the value they broadcast instead of relaying an input —
 * the Seed Everywhere family holds its seed in a widget and IS its own producer.
 * Every other sender relays whatever is wired into it.
 *
 * Deliberately a CLOSED set, unlike isUeSender's prefix match. Recognition should
 * be generous (an unrecognized sender silently loses its broadcasts), but this
 * predicate gates the one path that accepts a record WITHOUT verifying the
 * sender's incoming feed, and an exception that skips verification has to be
 * narrow. A future self-producing variant that is not listed here simply takes
 * the ordinary feed check and is refused with a warning — disclosed, not silent.
 */
export const isSelfProducingUeSender = (t: string): boolean =>
  t === "Seed Everywhere" || t === "Seed Everywhere?";

/** Shape cg-use-everywhere writes into graph.extra.ue_links. */
interface UeLink {
  downstream: number;
  downstream_slot: number;
  upstream: number;
  upstream_slot: number;
  /** The sender that produced this broadcast (absent in older lists). */
  controller?: number;
  type?: string;
}

export interface FlattenOptions {
  /** Resolve Get/Set buses + Reroutes (default true). */
  includeGetSet?: boolean;
  /** Materialize cg-use-everywhere broadcasts + remove senders (default true). */
  includeUe?: boolean;
}

export interface FlattenReport {
  removed: { getset: number; reroute: number; ue: number };
  added_links: number;
  rewired_inputs: number;
  kept_nodes: number;
  warnings: string[];
}

/**
 * Flatten a UI workflow in place (on a deep copy): every consumer input fed
 * through virtual wiring gets a fresh direct link to its real producer, UE
 * broadcasts become real links, and the virtual nodes are deleted. Kept nodes
 * are NEVER moved or otherwise altered (widgets, mode, size, color, title all
 * untouched), so the author's formatting survives exactly.
 */
export function flattenUiWorkflow(
  input: UiWorkflow,
  opts: FlattenOptions = {},
): { graph: UiWorkflow; report: FlattenReport } {
  const includeGetSet = opts.includeGetSet !== false;
  const includeUe = opts.includeUe !== false;
  const ui = JSON.parse(JSON.stringify(input)) as UiWorkflow;
  const warnings: string[] = [];

  const nodes = ui.nodes ?? [];
  const nodesById = new Map<number, UiNode>(nodes.map((n) => [n.id, n]));
  const linkMap = new Map<number, UiLink>();
  for (const l of ui.links ?? []) if (Array.isArray(l)) linkMap.set(l[0], l);

  // bus name (Set node's first widget) -> the link id feeding that Set's input.
  // Multiple Sets writing the same key: LAST one wins (matches litegraph's
  // iteration order at prompt time) — warn so the author knows.
  const busSource = new Map<string, number>();
  if (includeGetSet) {
    for (const n of nodes) {
      if (!isSetType(n.type)) continue;
      const bus = n.widgets_values?.[0];
      const inp = (n.inputs ?? []).find((i) => i.link != null);
      if (bus == null || inp?.link == null) continue;
      if (busSource.has(String(bus))) {
        warnings.push(`multiple Set nodes write bus "${String(bus)}" — the last one wins`);
      }
      busSource.set(String(bus), inp.link);
    }
  }

  /** Walk upstream past Get/Set/Reroute to the first REAL node (any mode). */
  const resolveReal = (
    linkId: number,
    depth = 0,
  ): { id: number; slot: number; type: string } | null => {
    if (depth > 100) return null;
    const link = linkMap.get(linkId);
    if (!link) return null;
    const src = nodesById.get(link[1]);
    if (!src) return { id: link[1], slot: link[2], type: link[5] };
    if (includeGetSet && isGetType(src.type)) {
      const bus = src.widgets_values?.[0];
      const setLink = bus != null ? busSource.get(String(bus)) : undefined;
      return setLink != null ? resolveReal(setLink, depth + 1) : null;
    }
    if (includeGetSet && (isSetType(src.type) || isRerouteType(src.type))) {
      const inp = (src.inputs ?? []).find((i) => i.link != null);
      return inp?.link != null ? resolveReal(inp.link, depth + 1) : null;
    }
    return { id: link[1], slot: link[2], type: link[5] };
  };

  let nextLinkId = (ui.last_link_id ?? Math.max(0, ...linkMap.keys())) + 1;
  const freshLinks: UiLink[] = [];
  let rewired = 0;

  const addDirectLink = (
    srcId: number,
    srcSlot: number,
    dstId: number,
    dstSlot: number,
    type: string,
  ): number | null => {
    const src = nodesById.get(srcId);
    const dst = nodesById.get(dstId);
    const dstInput = dst?.inputs?.[dstSlot];
    const srcOutput = src?.outputs?.[srcSlot];
    if (!src || !dst || !dstInput || !srcOutput) return null;
    const id = nextLinkId++;
    freshLinks.push([id, srcId, srcSlot, dstId, dstSlot, type]);
    dstInput.link = id;
    srcOutput.links = [...(srcOutput.links ?? []), id];
    return id;
  };

  // ── Pass 1: rewire consumer inputs fed through Get/Set/Reroute chains ─────
  if (includeGetSet) {
    for (const node of nodes) {
      if (isWiringVirtual(node.type)) continue;
      for (let slot = 0; slot < (node.inputs?.length ?? 0); slot++) {
        const inp = node.inputs?.[slot];
        if (inp?.link == null) continue;
        const link = linkMap.get(inp.link);
        if (!link) continue;
        const origin = nodesById.get(link[1]);
        if (!origin || !isWiringVirtual(origin.type)) continue; // already direct
        const resolved = resolveReal(inp.link);
        if (!resolved) {
          inp.link = null;
          warnings.push(
            `${node.type} #${node.id} input "${inp.name ?? slot}" fed by a dangling ${origin.type} chain — left unconnected`,
          );
          continue;
        }
        addDirectLink(resolved.id, resolved.slot, node.id, slot, resolved.type ?? link[5]);
        rewired++;
      }
    }
  }

  // ── Pass 2: materialize UE broadcasts from the pack's own computed list ───
  const ueSenders = nodes.filter((n) => isUeSender(n.type));
  const ueDeletable = new Set<number>();
  if (includeUe && ueSenders.length) {
    const ueLinks = (ui.extra?.ue_links as UeLink[] | undefined) ?? null;
    if (!Array.isArray(ueLinks) || ueLinks.length === 0) {
      warnings.push(
        `${ueSenders.length} Use-Everywhere sender(s) present but extra.ue_links is empty — ` +
          `UE broadcasts NOT materialized (open the graph with cg-use-everywhere active and save/queue once, then retry); senders left in place`,
      );
    } else {
      // A ue_links record is only as current as the last time the pack analysed
      // the graph. Materializing one without checking it against the LIVE wiring
      // invents a connection the graph does not have — which reads as a plausible
      // graph that is silently wrong, worse than an obviously missing link. Same
      // policy as convertUiToApi's materializer (issue #361); kept as a separate
      // implementation because this one walks a different link representation and
      // its failure action differs — it must never delete or disconnect anything,
      // only decline to add.
      const ueSenderIds = new Set(ueSenders.map((s) => s.id));
      /** Senders with at least one record we could not confirm — kept in place so
       *  the user can re-save and recover the real broadcast. */
      const unconfirmed = new Set<number>();
      /** Senders whose channel could not be verified (several distinct producers,
       *  and a record does not name the input it came through). Disclosed once. */
      const multiFeed = new Map<number, string>();
      /** null = confirmed against the live graph; otherwise the reason it is not. */
      const unconfirmedReason = (uel: UeLink, srcId: number, srcSlot: number): string | null => {
        const ctrlId = uel.controller;
        if (ctrlId == null) {
          // Unattributable: an unrelated sender sharing the producer proves
          // nothing about THIS target. Only a self-producing sender names its own
          // single channel unambiguously.
          const up = nodesById.get(srcId);
          return up && isSelfProducingUeSender(up.type)
            ? null
            : "the record names no broadcast node of its own (an older cg-use-everywhere list), so it cannot be attributed to any sender here";
        }
        const ctrl = nodesById.get(ctrlId);
        if (!ctrl || !ueSenderIds.has(ctrlId)) {
          return `broadcast node #${ctrlId} is no longer a broadcast node in this graph`;
        }
        // The Seed Everywhere family owns its value, so it has no feed to compare.
        // Restricted to that closed set: recognition is deliberately generous, and
        // a merely name-alike class must not inherit an exemption from checking.
        if (srcId === ctrlId && isSelfProducingUeSender(ctrl.type)) return null;
        const feeds = (ctrl.inputs ?? []).filter((i) => i.link != null);
        if (feeds.length === 0) {
          return `${ctrl.type} #${ctrl.id} no longer has any incoming connection, so it broadcasts nothing`;
        }
        let unresolved = false;
        let matched = false;
        const distinct = new Set<string>();
        for (const f of feeds) {
          const r = resolveReal(f.link as number);
          if (!r) {
            unresolved = true;
            continue;
          }
          distinct.add(`${r.id}:${r.slot}`);
          if (r.id === srcId && r.slot === srcSlot) matched = true;
        }
        if (matched) {
          if (distinct.size > 1) multiFeed.set(ctrl.id, ctrl.type);
          return null;
        }
        return unresolved
          ? `${ctrl.type} #${ctrl.id}'s own incoming connection could not be resolved, so the recorded producer node ${srcId} could not be confirmed`
          : `${ctrl.type} #${ctrl.id} is now fed by a different producer than the recorded node ${srcId}`;
      };

      for (const uel of ueLinks) {
        const dst = nodesById.get(uel.downstream);
        const dstInput = dst?.inputs?.[uel.downstream_slot];
        if (!dst || !dstInput) {
          warnings.push(`ue_link → node #${uel.downstream} slot ${uel.downstream_slot} no longer exists — skipped`);
          continue;
        }
        if (dstInput.link != null) continue; // got a real link since analysis — UE wouldn't fire
        // upstream is the real producer per the pack's analysis; if it is itself
        // virtual wiring (producer behind a Get/Set), normalize through pass-1 logic.
        let srcId = uel.upstream;
        let srcSlot = uel.upstream_slot;
        const up = nodesById.get(srcId);
        if (up && isWiringVirtual(up.type)) {
          const viaInp = (up.inputs ?? []).find((i) => i.link != null);
          const resolved = viaInp?.link != null ? resolveReal(viaInp.link) : null;
          if (!resolved) {
            warnings.push(`ue_link upstream #${srcId} is an unresolvable virtual node — skipped`);
            continue;
          }
          srcId = resolved.id;
          srcSlot = resolved.slot;
        }
        const why = unconfirmedReason(uel, srcId, srcSlot);
        if (why) {
          warnings.push(
            `ue_link → ${dst.type} #${dst.id} input "${dstInput.name ?? uel.downstream_slot}" could not be confirmed against the live graph: ${why} — left unconnected, and the sender is kept in place so a re-save can recover it`,
          );
          if (uel.controller != null) unconfirmed.add(uel.controller);
          continue;
        }
        const added = addDirectLink(srcId, srcSlot, uel.downstream, uel.downstream_slot, uel.type ?? dstInput.type ?? "*");
        if (added != null) rewired++;
      }
      for (const [id, type] of multiFeed) {
        warnings.push(
          `${type} #${id} broadcasts from more than one producer, and a ue_link record does not say which of its inputs a broadcast came through — each producer was confirmed to still feed it, but a saved list that went stale by SWAPPING its channels would look identical, so re-save with cg-use-everywhere active if this sender's routing matters`,
        );
      }
      // A sender is deletable only when it is not the real producer of any
      // surviving link (Seed Everywhere IS its own upstream — it must stay), and
      // never when one of its records could not be confirmed: deleting it would
      // destroy the only evidence of a broadcast we declined to materialize.
      const liveOrigins = new Set<number>();
      for (const l of freshLinks) liveOrigins.add(l[1]);
      for (const s of ueSenders) {
        if (!liveOrigins.has(s.id) && !unconfirmed.has(s.id)) ueDeletable.add(s.id);
      }
    }
  }

  // ── Deletion + purge ───────────────────────────────────────────────────────
  const removedIds = new Set<number>();
  let getset = 0;
  let reroute = 0;
  let ue = 0;
  for (const n of nodes) {
    if (includeGetSet && GET_SET_TYPES.has(n.type)) {
      removedIds.add(n.id);
      getset++;
    } else if (includeGetSet && isRerouteType(n.type)) {
      removedIds.add(n.id);
      reroute++;
    } else if (ueDeletable.has(n.id)) {
      removedIds.add(n.id);
      ue++;
    }
  }

  ui.nodes = nodes.filter((n) => !removedIds.has(n.id));
  const survivingLinks = [...(ui.links ?? []), ...freshLinks].filter(
    (l) => Array.isArray(l) && !removedIds.has(l[1]) && !removedIds.has(l[3]),
  );
  const survivingIds = new Set(survivingLinks.map((l) => l[0]));
  ui.links = survivingLinks;
  ui.last_link_id = nextLinkId - 1;

  // Scrub dangling link references on kept nodes (inputs fed by a deleted
  // virtual node that pass-1 already rewired keep their fresh id; anything
  // still pointing at a purged link gets cleared).
  for (const n of ui.nodes) {
    for (const inp of n.inputs ?? []) {
      if (inp.link != null && !survivingIds.has(inp.link)) inp.link = null;
    }
    for (const out of n.outputs ?? []) {
      if (out.links) out.links = out.links.filter((id) => survivingIds.has(id));
    }
  }

  // The senders are gone — stale UE bookkeeping would confuse the pack's JS.
  if (ui.extra && includeUe && ueSenders.length && ueDeletable.size === ueSenders.length) {
    delete ui.extra.ue_links;
    delete ui.extra.links_added_by_ue;
  }

  return {
    graph: ui,
    report: {
      removed: { getset, reroute, ue },
      added_links: freshLinks.length,
      rewired_inputs: rewired,
      kept_nodes: ui.nodes.length,
      warnings,
    },
  };
}
