/**
 * Issue/PR reference identity, shared by the changelog guard.
 *
 * A squash subject commonly names the tracked issue in its scope and the PR that
 * merged it at the end — `fix(2393): … (#2400)`. Those are two spellings of ONE
 * shipped change, so a changelog entry that cites either has documented it. The
 * guard has to know that, or it reports a release as missing an entry that is
 * sitting right there under the other number.
 *
 * Ported from comfyui-mcp-panel's scripts/lib/changelog-refs.mjs (panel #1894).
 */

/**
 * Parenthesised references — the shape the generator writes, plus the comma list
 * a human writes when one entry closes two PRs: `… (#2382, #2387)` (0.52.136).
 *
 * The single-reference regex this started as (the panel's) returns NOTHING for
 * that spelling, and nothing is not a failure — it makes the reachability half
 * skip the entry in silence, so an entry written that way is exempt from the
 * check built to catch a wrong credit. A guard that quietly checks nothing is the
 * same failure this file exists to close, one level up.
 */
export function referenceNumbers(text) {
  return [...String(text ?? "").matchAll(/\((#\d+(?:\s*,\s*#\d+)*)\)/g)].flatMap((group) =>
    [...group[1].matchAll(/#(\d+)/g)].map((m) => m[1]),
  );
}

/**
 * EVERY number a line mentions, parenthesised or not.
 *
 * Deliberately looser than referenceNumbers, and only used to ask "has this
 * change been written about at all". Hand-written highlights say things like
 * "credit #2378 to 0.52.133, where it shipped" (0.52.135) — that documents
 * #2378, and demanding the generator's `(#N)` spelling there would report a
 * release as silently gapped when a human had just written the entry by hand.
 */
export function mentionedNumbers(text) {
  return [...String(text ?? "").matchAll(/#(\d+)\b/g)].map((m) => m[1]);
}

/**
 * A real merge commit: `Merge pull request #2294 from artokun/fix/2319-slug`.
 *
 * This repo squash-merges most of the time, but not always — four PRs across
 * sixteen releases landed as true merges, and the PR number lives ONLY on the
 * merge subject, in a BARE `#N` that the parenthesised form above never matches.
 * All four (#2294, #2307, #2326, #2340) are cited nowhere in the changelog.
 *
 * The issue is taken from the branch, but only in the repo's `<type>/<issue>-<slug>`
 * shape. `fix/2319-remote-list-local-models` yields 2319; `fix/rate-limit-429`
 * deliberately yields nothing, because a trailing number in a slug is not an issue
 * and a bogus alias would let an unrelated entry vouch for a real change.
 */
export function mergeReferences(subject) {
  const match = /^Merge pull request #(\d+) from (?:[^\s/]+\/)?(.+?)\s*$/.exec(String(subject ?? ""));
  if (!match) return [];
  const issue = /^[^/]+\/(\d+)-/.exec(match[2])?.[1];
  return issue && issue !== match[1] ? [issue, match[1]] : [match[1]];
}

/** True for the merge that lands a release branch — a release, not a change in one. */
export function isReleaseMerge(subject) {
  return /^Merge pull request #\d+ from (?:[^\s/]+\/)?release\//i.test(String(subject ?? ""));
}

/** References in a commit subject: conventional scope, `(#N)` refs, or a merge. */
export function commitReferences(subject) {
  const text = String(subject ?? "");
  const merge = mergeReferences(text);
  if (merge.length) return merge;
  const refs = referenceNumbers(text);
  const match = /^(?:\w+)(?:\(([^)]+)\))?(?:!)?:\s*/.exec(text);
  if (match && /^#?\d+$/.test(match[1] ?? "")) refs.unshift((match[1] ?? "").replace(/^#/, ""));
  return [...new Set(refs)];
}

/**
 * Equivalence classes for issue/PR references that occur together in a commit
 * subject.
 *
 * An issue is only linked when it has exactly ONE pull request in the supplied
 * history. An umbrella issue used by several follow-up PRs stays distinct, so a
 * single entry citing the umbrella cannot silently vouch for every PR under it —
 * which is the direction that would hide a genuinely missing entry.
 */
export function referenceAliases(commits) {
  const candidates = new Map();
  for (const commit of commits ?? []) {
    const refs = commit?.refs ?? commitReferences(commit?.subject);
    if (refs.length < 2) continue;
    const pr = refs.at(-1);
    for (const issue of refs.slice(0, -1)) {
      if (issue === pr) continue;
      if (!candidates.has(issue)) candidates.set(issue, new Set());
      candidates.get(issue).add(pr);
    }
  }

  // A DIRECT issue -> PR map, deliberately not the panel's union-find.
  //
  // Union-find makes the relation transitive, and transitivity is not true here.
  // `fix(100): first (#200)` and `fix(200): second (#300)` are two separate
  // changes that happen to chain, because this project routinely reuses a previous
  // PR number as the next commit's scope -- 62 numeric scopes in recent history
  // are also PR numbers. Unioned, all three collapse into one class, and a section
  // citing only #100 silently vouches for PR #300 as well. That hides a missing
  // entry, which is the precise failure this guard exists to catch.
  //
  // One hop, never chased: an issue stands for its own pull request and for
  // nothing further along the chain.
  const aliases = new Map();
  for (const [issue, prs] of candidates) {
    if (prs.size !== 1) continue;
    const [pr] = prs;
    aliases.set(issue, pr);
  }
  return aliases;
}

/**
 * Issues that have MORE THAN ONE pull request in the supplied history.
 *
 * `referenceAliases` already refuses to alias these, but refusing to alias is not
 * the same as refusing to vouch: an entry citing umbrella issue #2393 would still
 * satisfy coverage for #2400 *and* #2409 by raw reference match, hiding the second
 * fix behind the first. That is a live shape here — #2393 took two PRs, and #2409
 * fixed a sibling exit five lines from the one #2400 fixed.
 *
 * So an ambiguous issue vouches for NOTHING; only its PR number will do.
 */
export function ambiguousReferences(commits) {
  const candidates = new Map();
  for (const commit of commits ?? []) {
    const refs = commit?.refs ?? commitReferences(commit?.subject);
    if (refs.length < 2) continue;
    const pr = refs.at(-1);
    for (const issue of refs.slice(0, -1)) {
      if (issue === pr) continue;
      if (!candidates.has(issue)) candidates.set(issue, new Set());
      candidates.get(issue).add(pr);
    }
  }
  return new Set([...candidates].filter(([, prs]) => prs.size > 1).map(([issue]) => issue));
}

export function canonicalReference(ref, aliases = new Map()) {
  return aliases.get(ref) ?? ref;
}
