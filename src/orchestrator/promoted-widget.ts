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

const CONTRADICTORY_RE =
  /Cannot set widget on subgraph node (\S+): "([^"]+)" is not a promoted widget on this subgraph \(promoted: ([^)]+)\)/i;

/** Exact name first; a unique case-insensitive hit is accepted so a listed
 *  `width` still matches a caller who sent `Width`. Several CI hits refuse. */
export function matchListedName(wanted: string, listed: readonly string[]): string | null {
  if (listed.includes(wanted)) return wanted;
  const ci = listed.filter((n) => n.toLowerCase() === wanted.toLowerCase());
  return ci.length === 1 ? ci[0] : null;
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

// ---- #1940: empty combo on a subgraph UUID --------------------------------
//
// panel_set_widget on a subgraph instance's promoted COMBO is refused:
//
//   panel_set_widget refused "choice" on node 816 (<uuid>) after refreshing
//   combo options: Combo widget "choice" has an EMPTY option list; the
//   server's option list may simply be stale — refreshing it before deciding.
//
// The subgraph node's type is a UUID, which is never in /object_info. Combo
// validation keys that UUID and gets []. The legal values live on the INNER
// node (CustomCombo / UNETLoader / CLIPLoader). Refreshing cannot help.
// Entering the subgraph and writing the inner widget is NOT equivalent: the
// inner widget is link-driven from the parent rail, so the parent value still
// wins at queue time.

export type EmptyPromotedComboRefusal = {
  nodeId: string;
  widget: string;
  type: string;
};

export type InnerComboOptionSource = "object_info" | "serialized" | "none";

export type InnerComboOptions = {
  innerNodeId: number | string;
  widget: string;
  innerType: string | null;
  options: unknown[] | null;
  source: InnerComboOptionSource;
};

const EMPTY_COMBO_RE =
  /panel_set_widget refused "([^"]+)" on node (\S+) \(([^)]+)\)(?: after refreshing combo options)?: Combo widget "([^"]+)" has an EMPTY option list/i;

const SUBGRAPH_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isSubgraphUuidType(type: string): boolean {
  return SUBGRAPH_UUID_RE.test(type.trim());
}

/**
 * Parse the empty-combo refusal that names a subgraph UUID type. Returns null
 * unless the refused widget matches (when supplied) and the type is a UUID —
 * a genuine empty list on a backend type (nothing installed) is left alone.
 */
export function parseEmptyPromotedComboRefusal(
  text: string,
  requestedWidget?: string,
): EmptyPromotedComboRefusal | null {
  const m = EMPTY_COMBO_RE.exec(text);
  if (!m) return null;
  const widget = m[1];
  const comboWidget = m[4];
  if (widget !== comboWidget) return null;
  if (requestedWidget != null && requestedWidget !== widget && requestedWidget.toLowerCase() !== widget.toLowerCase()) {
    return null;
  }
  const type = m[3].trim();
  if (!isSubgraphUuidType(type)) return null;
  return { nodeId: m[2].replace(/[,:]$/, ""), widget, type };
}

/** Combo option list from an /object_info input spec, or null when it is not a combo. */
export function comboOptionsFromInputSpec(spec: unknown): unknown[] | null {
  if (!Array.isArray(spec) || spec.length === 0) return null;
  const type = spec[0];
  if (Array.isArray(type)) return type;
  if (typeof type !== "string") return null;
  const cfg = spec[1];
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) return null;
  const opts = (cfg as { options?: unknown }).options;
  if (!Array.isArray(opts)) return null;
  return opts.map((o) =>
    o && typeof o === "object" && !Array.isArray(o) && "key" in (o as Record<string, unknown>)
      ? (o as { key: unknown }).key
      : o,
  );
}

function inputSpecsOf(def: unknown): Record<string, unknown> | null {
  if (!def || typeof def !== "object" || Array.isArray(def)) return null;
  const input = (def as { input?: unknown }).input;
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const rec = input as { required?: unknown; optional?: unknown };
  const required =
    rec.required && typeof rec.required === "object" && !Array.isArray(rec.required)
      ? (rec.required as Record<string, unknown>)
      : {};
  const optional =
    rec.optional && typeof rec.optional === "object" && !Array.isArray(rec.optional)
      ? (rec.optional as Record<string, unknown>)
      : {};
  return { ...required, ...optional };
}

export function comboOptionsFromObjectInfo(
  objectInfo: unknown,
  classType: string,
  widgetName: string,
): unknown[] | null {
  if (!objectInfo || typeof objectInfo !== "object" || Array.isArray(objectInfo)) return null;
  const def = (objectInfo as Record<string, unknown>)[classType];
  const specs = inputSpecsOf(def);
  if (!specs) return null;
  const matched = matchListedName(widgetName, Object.keys(specs));
  if (!matched) return null;
  return comboOptionsFromInputSpec(specs[matched]);
}

function asOptionList(raw: unknown): unknown[] | null {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const values = (raw as { values?: unknown }).values;
    if (Array.isArray(values)) return values;
    const options = (raw as { options?: unknown }).options;
    if (Array.isArray(options)) return options;
  }
  return null;
}

/**
 * Combo options carried on a serialized inner node. graph_get_subgraph's usual
 * summary is name→value only; when a payload DOES include an options array
 * (widget_options, a widget object, or a widgets[] row) that is the fallback
 * for a frontend-only inner type with no /object_info entry.
 */
export function comboOptionsFromSerializedNode(
  node: Record<string, unknown>,
  widgetName: string,
): unknown[] | null {
  const named = (bag: unknown): unknown[] | null => {
    if (!bag || typeof bag !== "object" || Array.isArray(bag)) return null;
    const rec = bag as Record<string, unknown>;
    const matched = matchListedName(widgetName, Object.keys(rec));
    return matched ? asOptionList(rec[matched]) : null;
  };

  const fromNamed = named(node.widget_options) ?? named(node.widgets);
  if (fromNamed) return fromNamed;

  const widgets = node.widgets;
  if (Array.isArray(widgets)) {
    for (const raw of widgets) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const row = raw as Record<string, unknown>;
      if (typeof row.name !== "string" || matchListedName(widgetName, [row.name]) == null) continue;
      return asOptionList(row.options) ?? asOptionList(row);
    }
  }
  return null;
}

export function comboValueIsListed(value: unknown, options: readonly unknown[]): boolean {
  if (options.includes(value as never)) return true;
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
    return false;
  }
  const label = String(value);
  return options.some(
    (o) =>
      (typeof o === "string" || typeof o === "number" || typeof o === "boolean") &&
      String(o) === label,
  );
}

function innerTypeOf(node: Record<string, unknown>): string | null {
  const t = node.type ?? node.class_type;
  return typeof t === "string" && t.trim() !== "" ? t : null;
}

function uniqueInnerNode(
  subgraph: Record<string, unknown> | null | undefined,
  displayedWidget: string,
): { innerNodeId: number | string; widget: string; node: Record<string, unknown> } | null {
  if (!subgraph || typeof subgraph !== "object") return null;
  if (subgraph.truncated === true) return null;
  const nodes = subgraph.nodes;
  if (!Array.isArray(nodes)) return null;

  const hits: { innerNodeId: number | string; widget: string; node: Record<string, unknown> }[] =
    [];
  for (const raw of nodes) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const node = raw as Record<string, unknown>;
    const id = innerNodeId(node);
    if (id == null) continue;
    const names = [
      ...widgetNamesOnInner(node),
      ...(node.widget_options && typeof node.widget_options === "object" && !Array.isArray(node.widget_options)
        ? Object.keys(node.widget_options as Record<string, unknown>).filter((n) => n.length > 0)
        : []),
      ...(Array.isArray(node.widgets)
        ? (node.widgets as unknown[])
            .map((w) =>
              w && typeof w === "object" && !Array.isArray(w) && typeof (w as { name?: unknown }).name === "string"
                ? (w as { name: string }).name
                : "",
            )
            .filter((n) => n.length > 0)
        : []),
    ];
    const matched = matchListedName(displayedWidget, names);
    if (matched) hits.push({ innerNodeId: id, widget: matched, node });
  }
  return hits.length === 1 ? hits[0] : null;
}

/**
 * Resolve a promoted combo's option list from the unique inner node.
 * Prefer /object_info of that inner type; if the type is absent (frontend-only),
 * fall back to the serialized node's own options array.
 */
export function resolveInnerComboOptions(
  subgraph: Record<string, unknown> | null | undefined,
  displayedWidget: string,
  objectInfo: unknown,
): InnerComboOptions | null {
  const hit = uniqueInnerNode(subgraph, displayedWidget);
  if (!hit) return null;
  const innerType = innerTypeOf(hit.node);
  const fromInfo =
    innerType != null ? comboOptionsFromObjectInfo(objectInfo, innerType, hit.widget) : null;
  // A returned array — including [] — is the server's list for this input. []
  // means nothing is installed, not "we could not look it up".
  if (fromInfo != null) {
    return {
      innerNodeId: hit.innerNodeId,
      widget: hit.widget,
      innerType,
      options: fromInfo,
      source: "object_info",
    };
  }
  const serialized = comboOptionsFromSerializedNode(hit.node, hit.widget);
  if (serialized != null) {
    return {
      innerNodeId: hit.innerNodeId,
      widget: hit.widget,
      innerType,
      options: serialized,
      source: "serialized",
    };
  }
  return {
    innerNodeId: hit.innerNodeId,
    widget: hit.widget,
    innerType,
    options: null,
    source: "none",
  };
}

export function formatComboOptionsPreview(options: readonly unknown[], limit = 40): string {
  const preview = options.slice(0, limit).map((o) => JSON.stringify(o)).join(", ");
  return options.length > limit ? `${preview}, …` : preview;
}
