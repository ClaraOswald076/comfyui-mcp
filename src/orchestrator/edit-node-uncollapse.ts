/**
 * #2004 — panel_edit_node(collapsed:false) can reject a collapsed node's own
 * stored height 0 ("size must be two positive numbers within a reasonable
 * canvas range"). LiteGraph serializes a title-chip as size[1]===0; the panel
 * then validates that stored pair when expanding if a size is supplied, and
 * the verified workaround is to pass an explicit positive size.
 *
 * These helpers restore a usable [width, height] from the live query BEFORE
 * graph_edit_node, so the caller does not have to re-supply geometry they
 * never asked to change. Fail-open: an unreadable probe leaves the original
 * command untouched.
 *
 * Fallback extents match create-group-membership / the panel's finiteExtent
 * defaults (DEFAULT_NODE_WIDTH / DEFAULT_NODE_BODY_HEIGHT). full_height on a
 * collapsed node is the 30px chip, not the pre-collapse body — do not use it.
 */

import {
  DEFAULT_NODE_BODY_HEIGHT,
  DEFAULT_NODE_WIDTH,
  parseDetailNodesFromQueryText,
} from "./create-group-membership.js";

type ToolResultLike = {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
};

type Call = (
  cmd: Record<string, unknown>,
  timeoutMs?: number,
) => Promise<ToolResultLike>;

export function pairSize(size: unknown): [number, number] | null {
  if (!Array.isArray(size) || size.length < 2) return null;
  const w = Number(size[0]);
  const h = Number(size[1]);
  return Number.isFinite(w) && Number.isFinite(h) ? [w, h] : null;
}

/** True when the stored pair would fail the panel's sizeSane (both > 0). */
export function needsUncollapseSizeRestore(size: unknown): boolean {
  const p = pairSize(size);
  return !p || !(p[0] > 0 && p[1] > 0);
}

export function restoredUncollapseSize(size: unknown): [number, number] {
  const p = pairSize(size);
  const w = p && p[0] > 0 ? p[0] : DEFAULT_NODE_WIDTH;
  const h = p && p[1] > 0 ? p[1] : DEFAULT_NODE_BODY_HEIGHT;
  return [w, h];
}

function parseToolJson(res: ToolResultLike): Record<string, unknown> | null {
  if (!res || res.isError) return null;
  const text = res.content.find((c) => c.type === "text")?.text;
  if (typeof text !== "string") return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * When uncollapsing a SINGLE node without an explicit size, query the live
 * geometry and restore a positive size if the stored height is 0 (or otherwise
 * not sizeSane). Bulk node_ids keep one shared size, so they are left alone.
 * Never throws.
 */
export async function sizeForUncollapse(
  args: {
    node_id?: unknown;
    node_ids?: unknown;
    collapsed?: unknown;
    size?: unknown;
  },
  call: Call,
): Promise<[number, number] | undefined> {
  if (args.collapsed !== false) return undefined;
  if (args.size !== undefined) return undefined;
  if (args.node_ids !== undefined) return undefined;
  if (args.node_id === undefined) return undefined;
  try {
    const query = await call(
      {
        cmd: "graph_query",
        ids: [args.node_id],
        fields: "detail",
        limit: 1,
      },
      8000,
    );
    if (query.isError) return undefined;
    const nodes = parseDetailNodesFromQueryText(parseToolJson(query)?.text);
    const wanted = String(args.node_id);
    const node = nodes.find((n) => String(n.id) === wanted) ?? nodes[0];
    if (!node || !needsUncollapseSizeRestore(node.size)) return undefined;
    return restoredUncollapseSize(node.size);
  } catch {
    return undefined;
  }
}
