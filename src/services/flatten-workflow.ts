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
 * cg-use-everywhere sender detection — the registered classes, by name.
 *
 * This was briefly a PREFIX match, to avoid missing a variant like the registered
 * "Seed Everywhere?" that the pack's own is_UEnode() overlooks. That traded one
 * failure for a worse one: a foreign class merely NAMED "Seed Everywhere Helper"
 * was classified as a sender, and a stale record naming it then satisfied the
 * feed check and FABRICATED an edge. Membership cannot be inferred from a name,
 * and no feed check can rescue a wrong classification.
 *
 * A closed set is now safe because an unrecognized class no longer disappears
 * quietly: records present with no recognized sender are REPORTED by both tools.
 * So a future variant degrades to a disclosed unknown, which is the failure we
 * can live with, while a name-alike foreign class can no longer invent wiring.
 */
const UE_SENDER_CLASSES = new Set([
  "Anything Everywhere",
  "Anything Everywhere?",
  "Anything Everywhere3",
  "Prompts Everywhere",
  "Seed Everywhere",
  "Seed Everywhere?",
]);
export const isUeSender = (t: string): boolean => UE_SENDER_CLASSES.has(t);

/**
 * The UE senders that OWN the value they broadcast instead of relaying an input —
 * the Seed Everywhere family holds its seed in a widget and IS its own producer.
 * Every other sender relays whatever is wired into it.
 *
 * This gates the one path that accepts a record WITHOUT verifying the sender's
 * incoming feed, so it stays the narrower of the two sets. A future
 * self-producing variant that is not listed here simply takes
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

  /** Walk from a NODE + output slot past any virtual wiring to the real producer.
   *  A GetNode has no input to follow — its value arrives over the bus — so this
   *  mirrors resolveReal's Get handling instead of looking for an incoming link. */
  const resolveRealFromNode = (
    nodeId: number,
    slot: number,
  ): { id: number; slot: number } | null => {
    const n = nodesById.get(nodeId);
    if (!n) return { id: nodeId, slot };
    if (includeGetSet && isGetType(n.type)) {
      const bus = n.widgets_values?.[0];
      const setLink = bus != null ? busSource.get(String(bus)) : undefined;
      const r = setLink != null ? resolveReal(setLink) : null;
      return r ? { id: r.id, slot: r.slot } : null;
    }
    if (includeGetSet && (isSetType(n.type) || isRerouteType(n.type))) {
      const inp = (n.inputs ?? []).find((i) => i.link != null);
      const r = inp?.link != null ? resolveReal(inp.link) : null;
      return r ? { id: r.id, slot: r.slot } : null;
    }
    return { id: nodeId, slot };
  };

  // Take the MAXIMUM of the header and the ids actually present. `last_link_id`
  // is only a header: a graph edited by tooling that did not maintain it can
  // carry links above it, and a fresh id equal to an existing one yields two
  // links with the same id — an ambiguous graph, produced silently.
  let nextLinkId = Math.max(ui.last_link_id ?? 0, 0, ...linkMap.keys()) + 1;
  const freshLinks: UiLink[] = [];
  let rewired = 0;
  /** node id → how many of its inputs pass 1 disconnected because their virtual
   *  chain could not be resolved. Pass 2 needs this: it runs AFTER pass 1, so a
   *  sender whose second channel came through a dead chain would otherwise look
   *  single-fed and lose its channel caveat — while the converter, which
   *  validates before de-virtualizing, still sees two. Same graph, same answer. */
  const clearedInputs = new Map<number, number>();
  const noteCleared = (nodeId: number) =>
    clearedInputs.set(nodeId, (clearedInputs.get(nodeId) ?? 0) + 1);

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
    const link: UiLink = [id, srcId, srcSlot, dstId, dstSlot, type];
    freshLinks.push(link);
    dstInput.link = id;
    srcOutput.links = [...(srcOutput.links ?? []), id];
    // Index it: pass 1 REPLACES a virtual-fed input with a fresh direct link, and
    // pass 2's staleness check resolves the sender's feed through this same map.
    // Leaving fresh links out of it made a rewired feed look UNRESOLVABLE, which
    // would refuse a perfectly live broadcast.
    linkMap.set(id, link);
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
          noteCleared(node.id);
          warnings.push(
            `${node.type} #${node.id} input "${inp.name ?? slot}" fed by a dangling ${origin.type} chain — left unconnected`,
          );
          continue;
        }
        const added = addDirectLink(resolved.id, resolved.slot, node.id, slot, resolved.type ?? link[5]);
        if (added == null) {
          // The chain resolved, but the edge could not be built — that producer or
          // output slot is not in the graph. Discarding the null left the virtual
          // deleted, no replacement link, and the final scrub quietly clearing the
          // consumer: a real connection gone with nothing said.
          inp.link = null;
          noteCleared(node.id);
          const producer = nodesById.get(resolved.id);
          warnings.push(
            `${node.type} #${node.id} input "${inp.name ?? slot}" resolves through ${origin.type} #${origin.id} to node #${resolved.id}${
              producer ? ` (${producer.type}) output slot ${resolved.slot}` : ""
            }, which this graph does not have — left unconnected`,
          );
          continue;
        }
        rewired++;
      }
    }
  }

  // ── Pass 2: materialize UE broadcasts from the pack's own computed list ───
  const ueSenders = nodes.filter((n) => isUeSender(n.type));
  const ueDeletable = new Set<number>();
  const allUeLinks = (ui.extra?.ue_links as UeLink[] | undefined) ?? null;
  if (includeUe && ueSenders.length === 0 && Array.isArray(allUeLinks) && allUeLinks.length > 0) {
    // Records but no recognized sender. Skipping UE processing in silence is the
    // worst outcome available: a real broadcast dropped with nothing said, and
    // exactly what an unrecognized sender CLASS produces. A deleted sender
    // (records genuinely stale) and an unknown class (records live) cannot be told
    // apart here, so it is reported as the could-not-determine it is. The
    // converter has the same backstop — a graph must not be disclosed by one tool
    // and passed over in silence by the other.
    warnings.push(
      `${allUeLinks.length} Use-Everywhere broadcast record(s) present but no node in this graph is recognized as a Use-Everywhere sender — either those senders were deleted (records stale) or they are a class this flattener does not know, so NOTHING was materialized from them and the inputs they name are left unconnected`,
    );
  }
  if (includeUe && ueSenders.length) {
    const ueLinks = allUeLinks;
    // An EMPTY computed list is an ANSWER — the pack analysed the graph and
    // recorded no broadcast — so there is nothing to materialize and nothing to
    // report. Only an ABSENT (or non-array) list is an unknown. Folding the two
    // together warned on a faithful graph, and disagreed with the converter.
    // Either way the senders stay: an empty list is not a licence to delete them.
    if (!Array.isArray(ueLinks)) {
      warnings.push(
        `${ueSenders.length} Use-Everywhere sender(s) present but extra.ue_links is missing — ` +
          `UE broadcasts NOT materialized (open the graph with cg-use-everywhere active and save/queue once, then retry); senders left in place`,
      );
    } else if (ueLinks.length > 0) {
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
      /** Set when a refused record names NO sender, so we cannot tell WHICH one
       *  has to survive. Deleting any of them would erase the evidence of the
       *  broadcast we declined to materialize, so none is deleted. */
      let blockSenderDeletion = false;
      /** Senders whose channel could not be verified (several distinct producers,
       *  and a record does not name the input it came through). Disclosed once. */
      const multiFeed = new Map<
        number,
        { type: string; confirmed: number; unresolved: number }
      >();
      /**
       * THE single "is this producer real" question — the same one addDirectLink
       * asks before it will build an edge. Counting a producer as confirmed here
       * that the materializer would refuse is how the channel caveat came to
       * claim confirmation it did not have.
       */
      const producerConfirmed = (nodeId: number, slot: number): boolean => {
        const nd = nodesById.get(nodeId);
        if (!nd) return true; // outside this graph — nothing to judge here
        if (!Array.isArray(nd.outputs)) return false;
        return slot < nd.outputs.length;
      };
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
        // Inputs pass 1 already disconnected count as unknown producers, not as
        // absent ones — the record may well have belonged to one of them.
        let unresolved = clearedInputs.get(ctrl.id) ?? 0;
        let matched = false;
        const distinct = new Set<string>();
        for (const f of feeds) {
          const r = resolveReal(f.link as number);
          // An UNRESOLVED input is not "no producer" — it is an unknown one, and
          // so is one whose producer this flattener would REFUSE to wire from.
          // Both count toward the channel ambiguity; letting them contribute
          // nothing made a sender with one known and one unknown producer read as
          // "one producer, nothing to confuse", silencing the caveat exactly
          // where the risk is highest.
          if (!r || !producerConfirmed(r.id, r.slot)) {
            unresolved++;
            continue;
          }
          distinct.add(`${r.id}:${r.slot}`);
          if (r.id === srcId && r.slot === srcSlot) matched = true;
        }
        if (matched) {
          if (distinct.size + unresolved > 1) {
            multiFeed.set(ctrl.id, {
              type: ctrl.type,
              confirmed: distinct.size,
              unresolved,
            });
          }
          return null;
        }
        return unresolved > 0
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
          const resolved = resolveRealFromNode(srcId, srcSlot);
          if (!resolved) {
            warnings.push(
              `ue_link upstream #${srcId} (${up.type}) is virtual wiring that could not be resolved to a real producer — ${dst.type} #${dst.id} input "${dstInput.name ?? uel.downstream_slot}" is left unconnected`,
            );
            if (uel.controller != null) unconfirmed.add(uel.controller);
            else blockSenderDeletion = true;
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
          else blockSenderDeletion = true;
          continue;
        }
        const added = addDirectLink(srcId, srcSlot, uel.downstream, uel.downstream_slot, uel.type ?? dstInput.type ?? "*");
        if (added == null) {
          // Confirmed, but the edge could not be built — the producer node or that
          // output slot is not in the graph. Swallowing the null returned a
          // FLATTENED graph missing a broadcast it claimed to resolve, and let the
          // sender be deleted on top of it.
          const srcNode = nodesById.get(srcId);
          warnings.push(
            `ue_link → ${dst.type} #${dst.id} input "${dstInput.name ?? uel.downstream_slot}" names producer #${srcId}${
              srcNode ? ` (${srcNode.type}) output slot ${srcSlot}` : ""
            }, which this graph does not have — left unconnected, and the sender is kept in place`,
          );
          if (uel.controller != null) unconfirmed.add(uel.controller);
          else blockSenderDeletion = true;
          continue;
        }
        rewired++;
      }
      for (const [id, info] of multiFeed) {
        // Say only what is true: this fires both for several CONFIRMED producers
        // and for a channel that could not be resolved at all, and claiming every
        // producer was confirmed in the second case would be a false statement in
        // a disclosure.
        const carries =
          info.unresolved > 0
            ? `${info.confirmed} confirmed producer(s) plus ${info.unresolved} input(s) whose own source could NOT be resolved`
            : `${info.confirmed} different confirmed producers`;
        warnings.push(
          `${info.type} #${id}: a broadcast could not be matched to a specific sender input — this sender carries ${carries}, and a ue_link record does not name the input a broadcast came through, so a saved list that went stale by SWAPPING its channels would look identical; re-save with cg-use-everywhere active if this sender's routing matters`,
        );
      }
      // A sender is deletable only when it is not the real producer of any
      // surviving link (Seed Everywhere IS its own upstream — it must stay), and
      // never when one of its records could not be confirmed: deleting it would
      // destroy the only evidence of a broadcast we declined to materialize.
      const liveOrigins = new Set<number>();
      for (const l of freshLinks) liveOrigins.add(l[1]);
      // A non-empty list is not proof that it accounts for EVERY sender: one that
      // predates a sender has no row for it. Deleting such a sender would remove a
      // node whose broadcasts were never materialized — a silent, unrecoverable
      // edit. A sender that reaches nothing also has no row, and the two cannot be
      // told apart, so it is kept and reported.
      const attributed = new Set<number>();
      for (const r of ueLinks) {
        if (r?.controller != null) attributed.add(r.controller);
        // A controllerless record still accounts for its sender when the producer
        // IS that sender (the self-producing shape accepted above).
        else if (isSelfProducingUeSender(nodesById.get(r?.upstream)?.type ?? "")) {
          attributed.add(r.upstream);
        }
      }
      for (const s of ueSenders) {
        if (attributed.has(s.id)) continue;
        warnings.push(
          `${s.type} #${s.id} is a Use-Everywhere sender, but no record in extra.ue_links names it — either it currently broadcasts to nothing or the saved list predates it, so nothing was wired from it and it is kept in place`,
        );
      }
      for (const s of ueSenders) {
        if (blockSenderDeletion) break;
        if (!attributed.has(s.id)) continue; // unaccounted for — never delete it
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
  // Two links sharing an id make the graph ambiguous: every consumer input and
  // producer output list keyed by that id could mean either. The fresh-id
  // allocator can no longer create one, but a graph edited by tooling that did
  // not maintain link ids can arrive with one already — and returning it
  // unchanged propagates the ambiguity from a pass whose whole job is to leave
  // the wiring unambiguous. Repair it (re-point exactly the one consumer input
  // and producer output slot involved) and say so; never fix it silently.
  const seenLinkIds = new Set<number>();
  const repairedIds: number[] = [];
  for (const l of survivingLinks) {
    if (!seenLinkIds.has(l[0])) {
      seenLinkIds.add(l[0]);
      continue;
    }
    const clashing = l[0];
    const fresh = nextLinkId++;
    const tgtInput = nodesById.get(l[3])?.inputs?.[l[4]];
    if (tgtInput?.link === clashing) tgtInput.link = fresh;
    const srcOut = nodesById.get(l[1])?.outputs?.[l[2]];
    if (srcOut?.links) {
      const at = srcOut.links.indexOf(clashing);
      if (at >= 0) srcOut.links[at] = fresh;
    }
    l[0] = fresh;
    seenLinkIds.add(fresh);
    repairedIds.push(clashing);
  }
  if (repairedIds.length > 0) {
    warnings.push(
      `${repairedIds.length} link(s) in the source graph shared an id already used by another link (${[
        ...new Set(repairedIds),
      ].join(", ")}) — each duplicate was given a fresh id so the flattened graph is unambiguous, but the original file is malformed and anything else reading it by link id may disagree`,
    );
  }

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
