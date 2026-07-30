import { getObjectInfo } from "../comfyui/client.js";
import type { ComfyUINodeDef, ObjectInfo } from "../comfyui/types.js";

// ---------------------------------------------------------------------------
// Live /object_info node search — the fallback for comfy_cli_search_nodes when
// comfy-cli is not installed/on PATH (issue #354). The official `comfy nodes
// search` fuzzy-matches installed node CLASSES over name/display/description/
// inputs/outputs; this reproduces that search directly against the connected
// ComfyUI's /object_info so installed-node discovery keeps working in a
// standalone/embedded-Python setup with no separate CLI dependency.
// ---------------------------------------------------------------------------

export interface ObjectInfoNodeHit {
  class_type: string;
  display_name: string;
  category: string;
  description: string;
  inputs: string[];
  outputs: string[];
  /** Relevance score (higher is better). */
  score: number;
}

function collectInputNames(def: ComfyUINodeDef): string[] {
  const names: string[] = [];
  for (const group of [def.input?.required, def.input?.optional]) {
    if (group && typeof group === "object") names.push(...Object.keys(group));
  }
  return names;
}

function collectOutputNames(def: ComfyUINodeDef): string[] {
  const out = new Set<string>();
  for (const name of def.output_name ?? []) if (typeof name === "string") out.add(name);
  for (const type of def.output ?? []) if (typeof type === "string") out.add(type);
  return [...out];
}

/**
 * Fuzzy-search node class definitions over class name, display name, category,
 * description, and input/output names. ALL whitespace-separated query terms must
 * appear somewhere in a node's searchable text (AND); scoring prefers matches on
 * the class/display name, then description, then inputs/outputs. An empty query
 * lists everything (bounded by `limit`).
 */
export function searchObjectInfo(
  objectInfo: ObjectInfo,
  query: string,
  limit = 20,
): ObjectInfoNodeHit[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const hits: ObjectInfoNodeHit[] = [];

  for (const [classType, def] of Object.entries(objectInfo)) {
    if (!def || typeof def !== "object") continue;
    const inputs = collectInputNames(def);
    const outputs = collectOutputNames(def);
    const name = classType.toLowerCase();
    const disp = (def.display_name ?? "").toLowerCase();
    const desc = (def.description ?? "").toLowerCase();
    const category = (def.category ?? "").toLowerCase();
    const inputHay = inputs.join(" ").toLowerCase();
    const outputHay = outputs.join(" ").toLowerCase();
    const haystack = [name, disp, category, desc, inputHay, outputHay].join(" ");

    if (terms.length && !terms.every((t) => haystack.includes(t))) continue;

    let score = terms.length ? 0 : 1;
    for (const t of terms) {
      if (name === t || disp === t) score += 100;
      else if (name.includes(t)) score += 40;
      else if (disp.includes(t)) score += 30;
      else if (category.includes(t)) score += 15;
      else if (desc.includes(t)) score += 10;
      else score += 5; // matched only on input/output names
    }

    hits.push({
      class_type: classType,
      display_name: def.display_name ?? classType,
      category: def.category ?? "",
      description: (def.description ?? "").slice(0, 200),
      inputs,
      outputs,
      score,
    });
  }

  hits.sort((a, b) => b.score - a.score || a.class_type.localeCompare(b.class_type));
  return hits.slice(0, Math.max(1, limit));
}

/** Fetch the connected server's /object_info and fuzzy-search it. */
export async function searchLiveObjectInfo(
  query: string,
  limit = 20,
): Promise<ObjectInfoNodeHit[]> {
  const objectInfo = await getObjectInfo();
  return searchObjectInfo(objectInfo, query, limit);
}
