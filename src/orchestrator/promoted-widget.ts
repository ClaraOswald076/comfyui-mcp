/**
 * #1655 — a widget the panel LISTS as promoted must be settable.
 *
 * `graph_set_widget` on a subgraph wrapper can refuse with:
 *
 *   Cannot set widget on subgraph node 78: "width" is not a promoted widget
 *   on this subgraph (promoted: width, height, seed, …)
 *
 * The listing is `node.widgets[].name`. The write looks up host INPUT names /
 * `_subgraphSlot` aliases. Those two sets disagree for proxyWidgets promotions
 * (krea2-txt2img-manual node 78: width/height exist as widgets, not as inputs),
 * so the refusal names the requested widget in its own "promoted:" list.
 *
 * Detection matches that contradiction only. A genuine miss ("foo" against
 * `promoted: width, height`) is left alone. Resolution maps the displayed name
 * to a UNIQUE inner node+widget from `graph_get_subgraph` — never by guessing
 * among several inners that share the name, and never from a truncated read.
 */

export type ContradictoryPromotedWidgetRefusal = {
  nodeId: string;
  widget: string;
  listed: string[];
};

export type InnerPromotedTarget = {
  innerNodeId: number | string;
  widget: string;
};

export type AmbiguousPromotedWidgetRefusal = {
  nodeId: string;
  widget: string;
  matches: number;
};

export type SubgraphScopeRefusal = {
  nodeId: string;
  enterPath: string[];
};

const CONTRADICTORY_RE =
  /Cannot set widget on subgraph node (\S+): "([^"]+)" is not a promoted widget on this subgraph \(promoted: ([^)]+)\)/i;

const AMBIGUOUS_RE =
  /(?:panel_set_widget refused "([^"]+)" on node (\S+)[\s\S]*?)?promoted widget "([^"]+)" is ambiguous\s*[—-]\s*(\d+)\s+promoted inputs? match/i;

const SCOPED_NODE_RE = /No node with id (\S+) in the current graph[\s\S]*?lives INSIDE a subgraph/i;
const ENTER_PATH_RE = /panel_enter_subgraph\((?:node_id=)?\s*([^)]+)\)/gi;

/** Exact name first; a unique case-insensitive hit is accepted so a listed
 *  `width` still matches a caller who sent `Width`. Several CI hits refuse. */
export function matchListedName(wanted: string, listed: readonly string[]): string | null {
  if (listed.includes(wanted)) return wanted;
  const ci = listed.filter((n) => n.toLowerCase() === wanted.toLowerCase());
  return ci.length === 1 ? ci[0] : null;
}

/**
 * Parse the panel's promoted-name/label ambiguity refusal. This is deliberately
 * diagnostic-only: the refusal proves that a blind second write could target the
 * wrong promoted rail, so callers must not turn the count into a guessed target.
 */
export function parseAmbiguousPromotedWidgetRefusal(
  text: string,
  requestedWidget?: string,
  requestedNodeId?: number | string,
): AmbiguousPromotedWidgetRefusal | null {
  const m = AMBIGUOUS_RE.exec(text);
  if (!m) return null;
  const widget = m[3] ?? m[1];
  if (!widget) return null;
  if (requestedWidget != null && requestedWidget.toLowerCase() !== widget.toLowerCase()) {
    return null;
  }
  const nodeId = m[2] ?? (requestedNodeId == null ? undefined : String(requestedNodeId));
  if (!nodeId) return null;
  const matches = Number(m[4]);
  if (!Number.isSafeInteger(matches) || matches < 2) return null;
  return { nodeId: nodeId.replace(/[,:]$/, ""), widget, matches };
}

/**
 * Parse the panel's pre-executor scope diagnosis. The enter path is taken only
 * from the panel's own `panel_enter_subgraph(...)` remedy, never inferred from a
 * node id or from a generic missing-node error.
 */
export function parseSubgraphScopeRefusal(
  text: string,
  requestedNodeId?: number | string,
): SubgraphScopeRefusal | null {
  const missing = SCOPED_NODE_RE.exec(text);
  if (!missing) return null;
  const nodeId = missing[1].replace(/[,:]$/, "");
  if (
    requestedNodeId != null &&
    String(requestedNodeId).replace(/[,:]$/, "") !== nodeId
  ) {
    return null;
  }

  const enterPath: string[] = [];
  ENTER_PATH_RE.lastIndex = 0;
  for (let m = ENTER_PATH_RE.exec(text); m; m = ENTER_PATH_RE.exec(text)) {
    const id = m[1].trim().replace(/[,:]$/, "");
    if (id) enterPath.push(id);
  }
  return enterPath.length > 0 ? { nodeId, enterPath } : null;
}

function parseListed(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed || /^none$/i.test(trimmed)) return [];
  return trimmed
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Parse the contradictory refusal. Returns null unless the requested widget
 * actually appears in the diagnostic's own promoted list — that is the bug.
 */
export function parseContradictoryPromotedWidgetRefusal(
  text: string,
  requestedWidget?: string,
): ContradictoryPromotedWidgetRefusal | null {
  const m = CONTRADICTORY_RE.exec(text);
  if (!m) return null;
  const listed = parseListed(m[3]);
  const fromError = matchListedName(m[2], listed);
  if (!fromError) return null;
  if (requestedWidget != null && matchListedName(requestedWidget, listed) == null) {
    return null;
  }
  const widget =
    requestedWidget != null ? (matchListedName(requestedWidget, listed) ?? fromError) : fromError;
  return { nodeId: m[1].replace(/[,:]$/, ""), widget, listed };
}

function widgetNamesOnInner(node: Record<string, unknown>): string[] {
  const widgets = node.widgets;
  if (!widgets || typeof widgets !== "object" || Array.isArray(widgets)) return [];
  return Object.keys(widgets as Record<string, unknown>).filter((n) => n.length > 0);
}

function innerNodeId(node: Record<string, unknown>): number | string | null {
  const id = node.id;
  if (typeof id === "number" && Number.isFinite(id)) return id;
  if (typeof id === "string" && id.trim() !== "") return id;
  return null;
}

/**
 * Map a displayed promoted name to the unique inner node that owns a widget
 * of that name. `graph_get_subgraph` does not ship a reliable promotion
 * pairing across frontend versions, so uniqueness is the only attribution
 * we will act on. A truncated inner list cannot prove uniqueness.
 */
export function resolveInnerPromotedTarget(
  subgraph: Record<string, unknown> | null | undefined,
  displayedWidget: string,
): InnerPromotedTarget | null {
  if (!subgraph || typeof subgraph !== "object") return null;
  if (subgraph.truncated === true) return null;
  const nodes = subgraph.nodes;
  if (!Array.isArray(nodes)) return null;

  const hits: InnerPromotedTarget[] = [];
  for (const raw of nodes) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const node = raw as Record<string, unknown>;
    const id = innerNodeId(node);
    if (id == null) continue;
    const matched = matchListedName(displayedWidget, widgetNamesOnInner(node));
    if (matched) hits.push({ innerNodeId: id, widget: matched });
  }
  return hits.length === 1 ? hits[0] : null;
}

/** True when the refusal listed `requestedWidget` as promoted. */
export function isContradictoryPromotedWidgetRefusal(
  text: string,
  requestedWidget: string,
): boolean {
  return parseContradictoryPromotedWidgetRefusal(text, requestedWidget) != null;
}

/**
 * panel#1558 — a successful promoted write can still be ephemeral: the inner
 * widget is governed by control_after_generate='randomize', and that control
 * is NOT promoted onto the subgraph node the caller addressed. The panel
 * warns and names an enter → set-inner-fixed → exit sequence the caller
 * cannot follow without hidden inner ids.
 *
 * Only this unpromoted-inner shape is parsed. A DIRECT seed warning (control
 * already on the addressed node) is left alone — randomize there is often
 * intentional. A "promoted as" outer-node remedy is also left alone: that
 * write is already parent-scope.
 */
export type UnpromotedControlPersistRemedy = {
  outerNodeId: string;
  enterPath: string[];
  innerNodeId: string;
  controlWidget: string;
  exitCount: number;
  mode: string;
};

const WILL_NOT_PERSIST_RE = /will NOT persist/i;
const NOT_PROMOTED_RE = /is NOT promoted onto subgraph node (\S+)/i;
const ENTER_RE = /panel_enter_subgraph\(node_id=([^)]+)\)/gi;
const SET_FIXED_RE =
  /panel_set_widget\(node_id=([^,]+),\s*widget='([^']+)',\s*value='fixed'\)/i;
const EXIT_TIMES_RE = /panel_exit_subgraph\(\)\s+(\d+)\s+times/i;
const MODE_RE = /control_after_generate='([^']+)'/i;

function stripNodeId(raw: string): string {
  return raw.trim().replace(/[,:]$/, "");
}

function sameNodeId(a: unknown, b: unknown): boolean {
  return stripNodeId(String(a)) === stripNodeId(String(b));
}

/** Parse the panel#650 unpromoted-control persist warning. Null unless the
 *  value will not persist AND the control is only reachable by entering. */
export function parseUnpromotedControlPersistRemedy(
  text: string,
): UnpromotedControlPersistRemedy | null {
  if (!WILL_NOT_PERSIST_RE.test(text)) return null;
  const notPromoted = NOT_PROMOTED_RE.exec(text);
  if (!notPromoted) return null;
  const outerNodeId = stripNodeId(notPromoted[1]);
  if (!outerNodeId) return null;

  const enterPath: string[] = [];
  ENTER_RE.lastIndex = 0;
  for (let m = ENTER_RE.exec(text); m; m = ENTER_RE.exec(text)) {
    const id = stripNodeId(m[1]);
    if (id) enterPath.push(id);
  }
  if (enterPath.length === 0) return null;

  const setFixed = SET_FIXED_RE.exec(text);
  if (!setFixed) return null;
  const innerNodeId = stripNodeId(setFixed[1]);
  const controlWidget = setFixed[2];
  if (!innerNodeId || !controlWidget) return null;
  if (sameNodeId(innerNodeId, outerNodeId)) return null;

  const times = EXIT_TIMES_RE.exec(text);
  const parsedTimes = times ? Number(times[1]) : NaN;
  const exitCount =
    Number.isFinite(parsedTimes) && parsedTimes > 0 ? parsedTimes : enterPath.length;

  const modeMatch = MODE_RE.exec(text);
  const mode = modeMatch?.[1] && modeMatch[1] !== "fixed" ? modeMatch[1] : "randomize";

  return { outerNodeId, enterPath, innerNodeId, controlWidget, exitCount, mode };
}

export function addressedNodeMatchesPersistRemedy(
  addressedNodeId: unknown,
  remedy: UnpromotedControlPersistRemedy,
): boolean {
  return (
    sameNodeId(addressedNodeId, remedy.outerNodeId) ||
    sameNodeId(addressedNodeId, remedy.enterPath[0])
  );
}
