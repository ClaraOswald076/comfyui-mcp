// Result merging for the tool-reach benchmark.
//
// Small enough to look obviously right, and separate enough to be tested —
// which it needs to be, because both of its failure modes are SILENT. Merging
// wrongly does not crash; it produces a results file that still parses, still
// renders a table, and reports a number nobody can tell is wrong:
//
//  - Merge by MODEL and a targeted `--only h6-01` re-run wipes that model's
//    other 99 episodes, leaving a one-row score sitting under a full-looking
//    arm.
//  - Fail to drop the superseded rows at all (a filter predicate that is always
//    true) and every per-episode checkpoint re-appends the whole run, so a
//    100-episode arm ends up with thousands of duplicate rows and an accuracy
//    figure weighted by however many times each row happened to be written.
//
// Both of those have been in this file. Hence the key: (model, requestId).

/**
 * Combine previously-saved episodes with the ones just recorded.
 *
 * A new episode SUPERSEDES a saved one with the same (model, requestId); saved
 * rows for any other pair are kept. Order is stable: kept rows first in their
 * original order, then the new ones.
 *
 * @param {Array<{model: string, requestId: string}>} prior
 * @param {Array<{model: string, requestId: string}>} fresh
 */
export function mergeEpisodes(prior, fresh) {
  const key = (e) => `${e.model} ${e.requestId}`;
  const superseded = new Set(fresh.map(key));
  return [...prior.filter((e) => !superseded.has(key(e))), ...fresh];
}

/**
 * Requests a (model, arm) pair is MISSING relative to the full set.
 *
 * A partial arm is not wrong, but publishing it as if it were complete is. The
 * report calls this so an incomplete row is labelled rather than averaged in
 * silently at whatever denominator it happens to have.
 *
 * @param {Array<{model: string, requestId: string}>} episodes
 * @param {string[]} allRequestIds
 * @returns {Map<string, string[]>} model → missing request ids
 */
export function missingCoverage(episodes, allRequestIds) {
  const byModel = new Map();
  for (const e of episodes) {
    if (!byModel.has(e.model)) byModel.set(e.model, new Set());
    byModel.get(e.model).add(e.requestId);
  }
  const out = new Map();
  for (const [model, seen] of byModel) {
    const missing = allRequestIds.filter((id) => !seen.has(id));
    if (missing.length) out.set(model, missing);
  }
  return out;
}
