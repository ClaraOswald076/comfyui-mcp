import { getObjectInfo } from "../comfyui/client.js";
import type { ComfyUINodeDef, ObjectInfo } from "../comfyui/types.js";

// ---------------------------------------------------------------------------
// Live /object_info node search — the fallback for comfy_cli
// action:"search_nodes" when comfy-cli is not installed/on PATH (issue #354).
// The official `comfy nodes
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

/** True when `needle` appears in `hay` in order but not necessarily contiguous
 *  (a classic fuzzy subsequence match, e.g. "ksamplr" ⊂ "ksampler"). */
function isSubsequence(needle: string, hay: string): boolean {
  if (!needle) return true;
  let i = 0;
  for (let j = 0; j < hay.length && i < needle.length; j++) {
    if (hay[j] === needle[i]) i++;
  }
  return i === needle.length;
}

interface Fields {
  name: string;
  disp: string;
  desc: string;
  category: string;
  haystack: string;
}

/** Score a node against the query terms; returns null when it doesn't match.
 *  `fuzzy` allows subsequence matches on the class/display name (typo tolerance);
 *  strict mode requires a substring match somewhere. */
function scoreNode(terms: string[], f: Fields, fuzzy: boolean): number | null {
  if (terms.length === 0) return 1;
  let score = 0;
  for (const t of terms) {
    if (f.name === t || f.disp === t) score += 100;
    else if (f.name.includes(t)) score += 40;
    else if (f.disp.includes(t)) score += 30;
    else if (f.category.includes(t)) score += 15;
    else if (f.desc.includes(t)) score += 10;
    else if (f.haystack.includes(t)) score += 5; // input/output names only
    else if (fuzzy && (isSubsequence(t, f.name) || isSubsequence(t, f.disp)))
      score += 2; // fuzzy/typo match on an identifier
    else return null; // this term matched nowhere → node excluded (AND semantics)
  }
  return score;
}

/**
 * Fuzzy-search node class definitions over class name, display name, category,
 * description, and input/output names. ALL whitespace-separated query terms must
 * match (AND). Two-tier for precision: an exact/substring pass runs first, and
 * only if it finds nothing does a fuzzy (subsequence) pass run — so a typo like
 * "ksamplr" still finds "KSampler" without a substring pass flooding results with
 * loose subsequence hits. Scoring prefers class/display-name matches, then
 * category/description, then input/output names, then fuzzy identifier matches.
 * An empty query lists everything (bounded by `limit`).
 */
export function searchObjectInfo(
  objectInfo: ObjectInfo,
  query: string,
  limit = 20,
): ObjectInfoNodeHit[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);

  const run = (fuzzy: boolean): ObjectInfoNodeHit[] => {
    const hits: ObjectInfoNodeHit[] = [];
    for (const [classType, def] of Object.entries(objectInfo)) {
      if (!def || typeof def !== "object") continue;
      const inputs = collectInputNames(def);
      const outputs = collectOutputNames(def);
      const name = classType.toLowerCase();
      const disp = (def.display_name ?? "").toLowerCase();
      const desc = (def.description ?? "").toLowerCase();
      const category = (def.category ?? "").toLowerCase();
      const haystack = [name, disp, category, desc, inputs.join(" "), outputs.join(" ")]
        .join(" ")
        .toLowerCase();
      const score = scoreNode(terms, { name, disp, desc, category, haystack }, fuzzy);
      if (score === null) continue;
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
  };

  const strict = run(false);
  if (strict.length > 0 || terms.length === 0) return strict;
  return run(true);
}

/** Fetch the connected server's /object_info and fuzzy-search it. */
export async function searchLiveObjectInfo(
  query: string,
  limit = 20,
): Promise<ObjectInfoNodeHit[]> {
  const objectInfo = await getObjectInfo();
  return searchObjectInfo(objectInfo, query, limit);
}
