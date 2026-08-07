// Live-canvas widget capture: the authoritative name→value overlay (#959).
//
// `graph_serialize` gives a faithful STRUCTURE (links, groups, properties,
// subgraph definitions) but stores widget values as a bare positional array. The
// converter has to name those positions, and the only order it can reconstruct is
// object_info's input order — which is NOT the frontend's widget order. Custom
// nodes that add, hide, or reorder widgets in JS make the two disagree, and every
// value from the first disagreement onward lands on the wrong widget.
//
// Reported three times against three different node packs before it was read as
// one bug: #961 (Eclipse wildcards — `wildcards` serialized before `seed`, so a
// wildcard STRING was emitted as the seed), #955 (the same node with numeric seeds
// 101/202 swapped out), #361 (a SteadyDancer canvas where five model/LoRA/VAE
// filenames were each replaced by a DIFFERENT model on disk). The last one is the
// severity argument: a shifted asset widget silently renders something the user
// never asked for, with no error anywhere.
//
// `graph_get_state` already reports each node's widgets BY NAME, straight off the
// live litegraph node objects — the frontend's own truth, with no order to
// disagree about. So capture both and hand the converter the named map.
//
// Why the named map can't be LESS complete than the array (the load-bearing
// point — if it could, this fix would trade a wrong value for a missing one):
// both are derived from the SAME list, `node.widgets`. litegraph builds
// `widgets_values` by walking that list and taking each `w.value`; the capture
// walks the same list and takes each `w.name`/`w.value` pair. The array is that
// list with the names thrown away, which is precisely why naming its positions
// requires a guess. Anything absent from the capture was absent from
// `node.widgets`, so it had no serialized value either. (The asymmetry runs the
// other way in some frontend versions, which skip `serialize:false` widgets when
// building the array — one more reason position is not a reliable key.)
//
// This module decides ONLY whether the two captures describe the same nodes. It
// refuses rather than guesses, and every refusal is disclosed to the caller: a
// positional mapping that could not be verified is reported as UNVERIFIED, never
// as correct and never as wrong.

/** A node summary from the panel's `graph_get_state` reply. */
type StateNode = {
  id?: unknown;
  type?: unknown;
  widgets?: unknown;
};

export type WidgetOverlayOutcome = {
  /** Nodes handed an authoritative name-keyed widget map. */
  applied: number;
  /** Graph nodes the capture did not cover; these stay on positional mapping. */
  uncovered: number;
  /** Set when the overlay was refused for the WHOLE graph, with the reason. */
  refused?: string;
  /**
   * Lines the caller should surface to the user. Present only when something was
   * left positional — a fully covered graph says nothing, because there is
   * nothing left to caveat.
   */
  notes: string[];
};

/** The caveat that a positionally-mapped node carries. Deliberately says MAY: we
 *  did not verify the order, which is not the same as having found it wrong. */
const POSITIONAL_CAVEAT =
  "their widget values were mapped by POSITION against the server's input order, " +
  "which is not guaranteed to match the frontend's widget order for custom nodes — " +
  "so a value MAY be attributed to the wrong widget (this is unverified, not known wrong). " +
  "Compare against panel_query_graph {fields:'detail'} before trusting a widget value that looks off.";

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Overlay the panel's name-keyed widget capture onto a serialized live graph,
 * IN PLACE, by setting each node's `capturedWidgetValues`.
 *
 * `widgets_values` is deliberately left untouched — a subgraph node's
 * proxyWidgets, a PrimitiveNode's literal at [0], and a Set/Get node's bus name
 * are all read from that array BY INDEX, and replacing it with an object would
 * silently drop them. The converter prefers `capturedWidgetValues` where it
 * exists and falls back to the array everywhere else.
 */
export function applyCapturedWidgetValues(
  ui: unknown,
  stateReply: unknown,
): WidgetOverlayOutcome {
  const graphNodes = (ui as { nodes?: unknown } | null)?.nodes;
  if (!Array.isArray(graphNodes) || graphNodes.length === 0) {
    return { applied: 0, uncovered: 0, notes: [] };
  }
  const refuse = (why: string): WidgetOverlayOutcome => ({
    applied: 0,
    uncovered: graphNodes.length,
    refused: why,
    notes: [`note: ${why} All ${graphNodes.length} node(s) kept the serialized values, so ${POSITIONAL_CAVEAT}`],
  });

  const state = stateReply as
    | { nodes?: unknown; viewing?: unknown; truncated?: unknown; node_count?: unknown }
    | null;
  if (!isPlainObject(state) || !Array.isArray(state.nodes)) {
    return refuse("The panel returned no live widget capture to cross-check the serialized graph against.");
  }

  // THE catastrophic case, and the reason this refuses instead of best-efforting.
  // `graph_serialize` always serializes the ROOT graph, but `graph_get_state`
  // reports whichever graph the user is currently INSIDE. With a subgraph open,
  // the two id spaces are different graphs' — and node 7 in the subgraph would
  // overwrite node 7 of the root with a completely unrelated node's widget values.
  // That is a worse bug than the one being fixed, so scope must be proven root.
  const scope = isPlainObject(state.viewing) ? state.viewing.scope : undefined;
  if (scope !== "root") {
    return refuse(
      scope === undefined
        ? "The panel's widget capture did not say which graph it describes, so it can't be matched to the serialized root graph."
        : `The panel is currently viewing a ${String(scope)}, so its widget capture describes that graph's nodes rather than the serialized root graph's.`,
    );
  }

  // Build the id→widgets index. A duplicate id can't be attributed to either
  // claimant, so drop BOTH rather than pick one (the same fail-closed rule the
  // converter applies to an ambiguous widget name).
  const widgetsById = new Map<string, Record<string, unknown>>();
  const duplicated = new Set<string>();
  for (const raw of state.nodes) {
    const n = raw as StateNode;
    if (n?.id == null) continue;
    const key = String(n.id);
    if (widgetsById.has(key) || duplicated.has(key)) {
      widgetsById.delete(key);
      duplicated.add(key);
      continue;
    }
    // A node with no widgets at all reports `{}`. Indexing it is correct — it
    // means "this node genuinely has no widget values", which is a fact worth
    // honouring rather than a reason to fall back to a positional array.
    if (isPlainObject(n.widgets)) widgetsById.set(key, n.widgets);
  }

  let applied = 0;
  const uncoveredTypes = new Map<string, number>();
  for (const raw of graphNodes) {
    const node = raw as { id?: unknown; type?: unknown; capturedWidgetValues?: unknown };
    const captured = node?.id == null ? undefined : widgetsById.get(String(node.id));
    if (captured) {
      node.capturedWidgetValues = captured;
      applied++;
    } else {
      const t = typeof node?.type === "string" ? node.type : "?";
      uncoveredTypes.set(t, (uncoveredTypes.get(t) ?? 0) + 1);
    }
  }

  const uncovered = graphNodes.length - applied;
  const notes: string[] = [];
  if (uncovered > 0) {
    // Name the cap explicitly when that is what happened, so the reader knows the
    // remedy (strip a smaller selection) rather than suspecting a broken panel.
    const capped =
      state.truncated === true ||
      (typeof state.node_count === "number" && state.node_count > state.nodes.length);
    const types = [...uncoveredTypes.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([t, c]) => `${c}× ${t}`)
      .join(", ");
    notes.push(
      `note: ${uncovered} of ${graphNodes.length} node(s) (${types}) were not covered by the panel's live widget capture` +
        (capped ? ` (it reports at most ${state.nodes.length} nodes per read)` : "") +
        `, so ${POSITIONAL_CAVEAT}`,
    );
  }
  if (duplicated.size > 0) {
    notes.push(
      `note: the live widget capture reported ${duplicated.size} node id(s) more than once, so those nodes' values could not be attributed and were left as serialized.`,
    );
  }
  return { applied, uncovered, notes };
}
