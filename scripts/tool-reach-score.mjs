// Scoring for the tool-reach benchmark.
//
// Deliberately pure: it takes recorded episodes and a surface, and returns
// numbers. Nothing in here talks to a model, a server, or the filesystem, so
// `src/__tests__/scripts/tool-reach-score.test.ts` can mutation-verify every
// metric by handing it a known-correct reach and a known-wrong one.
//
// THE FAILURE MODE THIS FILE IS SHAPED AROUND
//
// Matching on the tool NAME alone is a false-acceptance machine on the
// consolidated arm, and an ASYMMETRIC one. `regenerate` folds into
// `generate_image action:"regenerate"`; so does a plain render, as
// `generate_image action:"image"`. A name-only comparison scores the plain
// render as a correct reach for "run it again" — and the baseline arm, where
// `regenerate` is its own name, has no action to get wrong and so cannot
// benefit from the same leniency. The consolidation would look better than it
// is, purely as a scoring artefact. (This is not hypothetical: the same bug was
// live in `arena-scenarios.mjs`'s `c.tool === "regenerate"` check.)
//
// So: `exact` compares (tool, action) whenever the surface HAS an action to get
// wrong, and `toolOnly` is reported as a separate, clearly-labelled column —
// never as the headline.

import { resolveExpectation } from "./tool-reach-foldmap.mjs";

/** How many substantive calls "reach-within-N" allows. */
export const REACH_WINDOW = 3;

/**
 * Resolve a request's expected and acceptable (tool, action) pairs on one
 * surface.
 *
 * @param {{target: string|null, accept?: string[]}} request
 * @param {Set<string>|string[]} surfaceNames
 */
export function expectationsFor(request, surfaceNames) {
  if (request.target === null) return { expected: null, acceptable: [] };
  const expected = resolveExpectation(request.target, surfaceNames);
  const acceptable = (request.accept ?? []).map((a) => resolveExpectation(a, surfaceNames));
  return { expected, acceptable };
}

/**
 * Does a recorded reach satisfy one expectation?
 *
 * `expected.action === null` means the surface exposes this capability as its
 * own flat tool — there is no action to get right, so whatever the model put in
 * an `action` argument is irrelevant and MUST be ignored. Comparing it would
 * penalise the flat arms for a field they do not have.
 */
function matchesExact(reach, expectation) {
  if (!reach || !expectation) return false;
  if (reach.tool !== expectation.tool) return false;
  if (expectation.action === null) return true;
  return reach.action === expectation.action;
}

function matchesTool(reach, expectation) {
  return Boolean(reach && expectation && reach.tool === expectation.tool);
}

/**
 * Score one episode.
 *
 * @param {object} request  a row from REQUESTS
 * @param {{substantive: {tool:string, action:string|null}[], navigation?: number,
 *          navBeforeFirst?: number, error?: string|null}} episode
 * @param {Set<string>|string[]} surfaceNames
 */
export function scoreEpisode(request, episode, surfaceNames) {
  const { expected, acceptable } = expectationsFor(request, surfaceNames);
  const targets = expected ? [expected, ...acceptable] : [];
  const reaches = episode.substantive ?? [];
  const first = reaches[0] ?? null;

  // Negative rows invert the question: the correct behaviour is to reach for
  // nothing. Scored on its own axis and NEVER folded into first-reach accuracy,
  // because "correctly declined" and "correctly reached" are different claims
  // and averaging them together hides both.
  if (request.target === null) {
    const abstained = reaches.length === 0;
    return {
      id: request.id,
      tier: request.tier,
      hypothesis: request.hypothesis ?? null,
      expected: null,
      first,
      firstExact: null,
      firstToolOnly: null,
      abstained,
      withinWindowExact: null,
      navBeforeFirst: episode.navBeforeFirst ?? 0,
      navigation: episode.navigation ?? 0,
      substantiveCount: reaches.length,
      error: episode.error ?? null,
      verdict: abstained ? "abstained" : "over-reached",
    };
  }

  const firstExact = targets.some((t) => matchesExact(first, t));
  const firstToolOnly = targets.some((t) => matchesTool(first, t));
  const withinWindowExact = reaches
    .slice(0, REACH_WINDOW)
    .some((r) => targets.some((t) => matchesExact(r, t)));

  return {
    id: request.id,
    tier: request.tier,
    hypothesis: request.hypothesis ?? null,
    expected,
    acceptable,
    first,
    firstExact,
    firstToolOnly,
    abstained: null,
    withinWindowExact,
    navBeforeFirst: episode.navBeforeFirst ?? 0,
    navigation: episode.navigation ?? 0,
    substantiveCount: reaches.length,
    error: episode.error ?? null,
    verdict: firstExact
      ? "hit"
      : firstToolOnly
        ? "right-tool-wrong-action"
        : first
          ? "miss"
          : "no-reach",
  };
}

const pct = (n, d) => (d === 0 ? null : (100 * n) / d);

/**
 * Aggregate a set of scored episodes for one (arm, model).
 *
 * Positive rows and negative rows are counted on separate denominators on
 * purpose. Rolling abstentions into the accuracy numerator would let a model
 * that never calls anything score 4% "accuracy" for free.
 */
export function summarize(scored) {
  // An errored episode measured the PROVIDER, not the model. A timeout or an
  // HTTP 500 before any response would otherwise land in the positive
  // denominator as a "no reach", so a flaky provider reads as a model that
  // failed to reach — and a flaky provider on one arm only would move the A/B.
  // Counted and reported, never averaged in.
  const errored = scored.filter((s) => s.error);
  const evaluated = scored.filter((s) => !s.error);
  const positive = evaluated.filter((s) => s.expected !== null);
  const negative = evaluated.filter((s) => s.expected === null);

  return {
    n: scored.length,
    nEvaluated: evaluated.length,
    nPositive: positive.length,
    nNegative: negative.length,
    errors: errored.length,
    firstReachExactPct: pct(positive.filter((s) => s.firstExact).length, positive.length),
    firstReachToolOnlyPct: pct(positive.filter((s) => s.firstToolOnly).length, positive.length),
    withinWindowPct: pct(positive.filter((s) => s.withinWindowExact).length, positive.length),
    noReachPct: pct(positive.filter((s) => s.substantiveCount === 0).length, positive.length),
    abstainPct: pct(negative.filter((s) => s.abstained).length, negative.length),
    navPerRequest:
      evaluated.length === 0
        ? null
        : evaluated.reduce((a, s) => a + (s.navBeforeFirst ?? 0), 0) / evaluated.length,
    navTotal: evaluated.reduce((a, s) => a + (s.navigation ?? 0), 0),
    byTier: Object.fromEntries(
      [...new Set(positive.map((s) => s.tier))].map((tier) => {
        const rows = positive.filter((s) => s.tier === tier);
        return [
          tier,
          {
            n: rows.length,
            exactPct: pct(rows.filter((s) => s.firstExact).length, rows.length),
            toolOnlyPct: pct(rows.filter((s) => s.firstToolOnly).length, rows.length),
          },
        ];
      }),
    ),
    byHypothesis: Object.fromEntries(
      [...new Set(positive.map((s) => s.hypothesis).filter(Boolean))].sort().map((h) => {
        const rows = positive.filter((s) => s.hypothesis === h);
        return [
          h,
          {
            n: rows.length,
            hits: rows.filter((s) => s.firstExact).length,
            exactPct: pct(rows.filter((s) => s.firstExact).length, rows.length),
          },
        ];
      }),
    ),
  };
}

/**
 * The confusion matrix — what it reached for INSTEAD.
 *
 * This is the actionable output: it names which tool is stealing which
 * request, which is what turns a percentage into "rename X".
 * `expected`/`reached` are rendered in the arm's own vocabulary
 * (`tool` or `tool(action)`), so a wrong ACTION on the right tool shows up as a
 * distinct row rather than disappearing.
 */
export function confusion(scored) {
  const rows = new Map();
  for (const s of scored) {
    if (s.expected === null) {
      if (s.abstained) continue;
      const key = "∅ (should not have reached)";
      const label = s.first ? fmt(s.first) : "(none)";
      bump(rows, key, label, s.id);
      continue;
    }
    if (s.firstExact) continue;
    const key = fmt(s.expected);
    const label = s.first ? fmt(s.first) : "(no reach)";
    bump(rows, key, label, s.id);
  }
  return [...rows.entries()]
    .map(([expected, m]) => ({
      expected,
      total: [...m.values()].reduce((a, v) => a + v.count, 0),
      reached: [...m.entries()]
        .map(([reached, v]) => ({ reached, count: v.count, examples: [...v.ids].slice(0, 4) }))
        .sort((a, b) => b.count - a.count),
    }))
    .sort((a, b) => b.total - a.total);
}

function bump(rows, key, label, id) {
  if (!rows.has(key)) rows.set(key, new Map());
  const m = rows.get(key);
  if (!m.has(label)) m.set(label, { count: 0, ids: new Set() });
  const cell = m.get(label);
  cell.count++;
  cell.ids.add(id);
}

/** `tool` on a flat surface, `tool(action)` where an action exists. */
export function fmt(pair) {
  if (!pair) return "(none)";
  return pair.action ? `${pair.tool}(${pair.action})` : pair.tool;
}

const cell = (v, digits = 1) => (v === null || v === undefined ? "—" : v.toFixed(digits));

/** Markdown comparison table across (arm, model). */
export function renderComparison(entries) {
  const head = [
    "Arm",
    "Surface",
    "Model",
    "First-reach (tool+action)",
    "First-reach (tool only)",
    `Reach-within-${REACH_WINDOW}`,
    "Nav calls / request",
    "No reach",
    "Abstained on distractors",
    "Errors",
  ];
  const md = [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`];
  for (const e of entries) {
    const s = e.summary;
    md.push(
      `| \`${e.arm}\` | ${e.surfaceSize} | \`${e.model}\` | ${cell(s.firstReachExactPct)}% | ` +
        `${cell(s.firstReachToolOnlyPct)}% | ${cell(s.withinWindowPct)}% | ` +
        `${cell(s.navPerRequest, 2)} | ${cell(s.noReachPct)}% | ${cell(s.abstainPct)}% | ${s.errors} |`,
    );
  }
  return md.join("\n");
}

/** Markdown confusion matrix, most-confused first. */
export function renderConfusion(rows, limit = 25) {
  const md = ["| Wanted | Reached instead | n | e.g. |", "|---|---|---|---|"];
  let shown = 0;
  for (const r of rows) {
    for (const c of r.reached) {
      if (shown++ >= limit) return `${md.join("\n")}\n\n_(truncated at ${limit} rows)_`;
      md.push(`| \`${r.expected}\` | \`${c.reached}\` | ${c.count} | ${c.examples.join(", ")} |`);
    }
  }
  return md.join("\n");
}
