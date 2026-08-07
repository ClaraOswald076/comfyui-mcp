// #935 — a supplied-but-unapplied filter answered with a plausible result set.
//
// `panel_civitai_search` already guards ONE parameter. #374 fixed `creator`
// being silently dropped: the tool echoed `creator:null` with zero results and
// no explanation, so "filter never applied" and "this creator has no content"
// were indistinguishable. The guard added there warns on divergence.
//
// It covers `creator` and nothing else. `modelSort`, `baseModels` and `period`
// could be supplied, ignored, and answered with a full, ordinary-looking list —
// which is what a reporter saw: download counts in no order at all
// (48, 53, 53, 64, 1468) for a "Most Downloaded" sort. An agent asked for
// "most-downloaded Flux LoRAs" presents that confidently, and nothing in the
// reply says the sort never happened.
//
// The panel's own CivitAI client documents that an unrecognised `baseModels`
// value "silently returns nothing", so an EMPTY result here is ambiguous in
// exactly the way #374 existed to remove. That ambiguity is the part worth
// closing permanently, independently of wherever the filters actually stop
// taking effect — which is panel-side and not fixed here.

/** What the caller asked for. Shape mirrors the tool's `filters` argument. */
export type CivitaiFilters = Record<string, unknown> | undefined;

/** Compare loosely: the panel may echo a scalar where an array was sent, or
 *  differ only in case/whitespace. Only a REAL divergence should warn — a
 *  false alarm on every search would train the reader to skip the warning,
 *  which is how a guard stops working. */
function sameValue(want: unknown, got: unknown): boolean {
  if (want === got) return true;
  const norm = (v: unknown): string =>
    Array.isArray(v)
      ? v.map((x) => String(x).trim().toLowerCase()).sort().join("|")
      : String(v ?? "").trim().toLowerCase();
  return norm(want) === norm(got);
}

/**
 * The warning for filters the panel did not apply, or "" when there is nothing
 * to say.
 *
 * Deliberately conservative about what it CLAIMS. The panel echoes back an
 * `filters`/`applied_filters` object on newer builds; on an older one it echoes
 * nothing, and absence is NOT evidence the filters were dropped. So:
 *
 *   - echoed and equal      → silent. Nothing happened worth reporting.
 *   - echoed and different  → name each one, with asked-vs-applied.
 *   - not echoed at all     → say the application could not be VERIFIED, and
 *                             say plainly that this is not the same as knowing
 *                             it failed. A reader who is told "unverified"
 *                             re-checks; one told "failed" goes and fixes
 *                             something that may not be broken.
 */
export function describeUnappliedFilters(filters: unknown, reply: unknown): string {
  const supplied: CivitaiFilters =
    filters && typeof filters === "object" && !Array.isArray(filters)
      ? (filters as Record<string, unknown>)
      : undefined;
  const asked = Object.entries(supplied ?? {}).filter(
    ([, v]) => v !== undefined && v !== null && !(Array.isArray(v) && v.length === 0),
  );
  if (asked.length === 0) return "";
  if (!reply || typeof reply !== "object") return "";

  const r = reply as Record<string, unknown>;
  const echoed = (r.applied_filters ?? r.filters) as Record<string, unknown> | undefined;

  if (!echoed || typeof echoed !== "object") {
    return (
      `This panel build did not echo back which filters it applied, so whether ` +
      `${asked.map(([k]) => `\`${k}\``).join(", ")} took effect is UNVERIFIED — which is not the same as ` +
      `knowing they were ignored. Judge the results before trusting the ordering or the narrowing: if a ` +
      `sort was requested, check that the list is actually in that order. An unrecognised \`baseModels\` ` +
      `value makes CivitAI return nothing at all, so an empty result here is not evidence that no such ` +
      `model exists.`
    );
  }

  const dropped = asked.filter(([k, v]) => !sameValue(v, echoed[k]));
  if (dropped.length === 0) return "";

  const lines = dropped
    .map(([k, v]) => {
      const got = echoed[k];
      const gotStr =
        got === undefined || got === null
          ? "not applied"
          : JSON.stringify(got);
      return `  - ${k}: asked ${JSON.stringify(v)}, applied ${gotStr}`;
    })
    .join("\n");

  return (
    `${dropped.length} of the ${asked.length} filter(s) you supplied were NOT applied by the CivitAI ` +
    `browser:\n${lines}\n` +
    `The results below were produced WITHOUT them, so do not describe them as sorted or narrowed the way ` +
    `you asked. Re-run with values the browser accepts (an out-of-enum sort/period is rejected outright, ` +
    `and an unrecognised baseModels silently returns nothing), or read the list on its own terms.`
  );
}
