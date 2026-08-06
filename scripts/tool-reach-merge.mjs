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
//
// And a third, subtler one: two episodes can share (model, requestId) and STILL
// not be comparable, because the conditions changed underneath them. Raising the
// tool-result cap from 12,000 to 200,000 characters changed what the model was
// shown; rewording four requests changed what it was asked. Merging on the id
// alone would have blended pre-fix and post-fix episodes into one arm that looks
// complete and passes the coverage check — measurements taken under two
// different setups, averaged, with nothing on the page to say so. Hence the
// FINGERPRINT: an episode is only reusable if the exact conditions that produced
// it still hold.

import { createHash } from "node:crypto";

/**
 * A stable digest of everything that changes what an episode MEANS.
 *
 * Deliberately covers the request as asked (task text, and the target/accept
 * sets that decide how it is scored) and the run conditions the model can
 * perceive (system prompt, reach window, result cap, round cap, and for local
 * models the context window and whether extended reasoning was on). It
 * deliberately does NOT cover the arm's git ref or the model name — those are
 * already the merge key and the file identity.
 *
 * @param {{task: string, target: string|null, accept?: string[]}} request
 * @param {object} config
 */
export function episodeFingerprint(request, config) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        task: request.task,
        target: request.target,
        accept: request.accept ?? [],
        systemPrompt: config.systemPrompt,
        reachWindow: config.reachWindow,
        toolResultCap: config.toolResultCap,
        maxRounds: config.maxRounds,
        mode: config.mode,
        adapter: config.adapter,
        // Only meaningful for local models; null everywhere else so a change to
        // the Ollama setup does not invalidate hosted episodes.
        numCtx: config.numCtx ?? null,
        think: config.think ?? null,
      }),
    )
    .digest("hex")
    .slice(0, 16);
}

/**
 * Combine previously-saved episodes with the ones just recorded.
 *
 * A new episode SUPERSEDES a saved one with the same (model, requestId). A saved
 * row for any other pair is kept ONLY if its fingerprint still matches what the
 * current setup would produce for that request — otherwise it was measured under
 * conditions that no longer hold and is dropped, which makes it show up as
 * missing coverage rather than as a silently stale number.
 *
 * A saved row with NO fingerprint predates this check and is likewise dropped:
 * "we cannot tell whether this is comparable" must resolve to re-run, never to
 * keep.
 *
 * @param {Array<{model: string, requestId: string, fingerprint?: string}>} prior
 * @param {Array<{model: string, requestId: string, fingerprint?: string}>} fresh
 * @param {Map<string, string>|Record<string, string>} [expected]
 *   `"<model>|<requestId>"` → the fingerprint the current setup produces for
 *   that model's adapter. Keyed by model as well as request because the
 *   conditions are adapter-specific: changing the local context window must not
 *   invalidate the (far more expensive) hosted episodes, which cannot see it.
 *   Omit to skip the comparability check — only sensible in a pure re-render,
 *   where nothing about the setup can have changed.
 */
export function mergeEpisodes(prior, fresh, expected) {
  const key = (e) => `${e.model} ${e.requestId}`;
  const superseded = new Set(fresh.map(key));
  const want =
    expected instanceof Map ? expected : expected ? new Map(Object.entries(expected)) : null;

  const kept = prior.filter((e) => {
    if (superseded.has(key(e))) return false;
    if (!want) return true;
    const target = want.get(`${e.model}|${e.requestId}`);
    // A pair the current run knows nothing about — a model not in this field, or
    // a request id since removed — is not stale, it is out of scope. Keep it
    // rather than silently deleting somebody else's data.
    if (target === undefined) return true;
    return e.fingerprint === target;
  });
  return [...kept, ...fresh];
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
