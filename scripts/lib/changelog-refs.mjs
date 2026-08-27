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

/** References in a conventional-commit subject, including a numeric issue scope. */
export function commitReferences(subject) {
  const text = String(subject ?? "");
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

  const parent = new Map();
  const ensure = (ref) => {
    if (!parent.has(ref)) parent.set(ref, ref);
  };
  const find = (ref) => {
    ensure(ref);
    let root = ref;
    while (parent.get(root) !== root) root = parent.get(root);
    while (parent.get(ref) !== ref) {
      const next = parent.get(ref);
      parent.set(ref, root);
      ref = next;
    }
    return root;
  };
  const union = (a, b) => {
    const left = find(a);
    const right = find(b);
    if (left !== right) parent.set(right, left);
  };

  for (const [issue, prs] of candidates) {
    if (prs.size !== 1) continue;
    const [pr] = prs;
    ensure(issue);
    ensure(pr);
    union(issue, pr);
  }

  const aliases = new Map();
  for (const ref of parent.keys()) aliases.set(ref, find(ref));
  return aliases;
}

export function canonicalReference(ref, aliases = new Map()) {
  return aliases.get(ref) ?? ref;
}
