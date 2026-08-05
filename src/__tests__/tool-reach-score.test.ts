/**
 * The scoring logic of the tool-reach benchmark.
 *
 * A scorer is the one part of a benchmark whose bugs are invisible: a scorer
 * that always says "pass" produces a beautiful, entirely fictional table. So
 * every assertion here is paired with its mutation — the same input with the
 * one thing that should matter changed, asserting the metric MOVES. A test that
 * only ever checks the happy path would survive `return true`.
 *
 * The specific bug this file exists to prevent, and which was live in
 * `scripts/arena-scenarios.mjs` before slice 16 fixed it: matching on the tool
 * NAME alone. `regenerate` folds to `generate_image action:"regenerate"`, and
 * so does a plain render as `generate_image action:"image"` — so a name-only
 * comparison scores the wrong action as a hit. And it does so asymmetrically:
 * the 154-name baseline has no action to get wrong, so it cannot benefit from
 * the same leniency, and the consolidation would look better than it is purely
 * as a scoring artefact.
 */
import { describe, expect, it } from "vitest";
// @ts-expect-error — plain-JS benchmark modules, deliberately untyped
import { REACH_WINDOW, confusion, expectationsFor, scoreEpisode, summarize } from "../../scripts/tool-reach-score.mjs";
// @ts-expect-error — plain-JS benchmark modules, deliberately untyped
import { FOLD_MAP, FINAL_SURFACE, resolveExpectation } from "../../scripts/tool-reach-foldmap.mjs";
// @ts-expect-error — plain-JS benchmark modules, deliberately untyped
import { REQUESTS, checkRequestSet, referencedCapabilities } from "../../scripts/tool-reach-requests.mjs";

/** The two surfaces the A/B actually compares. */
const FLAT_154 = new Set<string>([...Object.keys(FOLD_MAP as Record<string, unknown>), "queue", "comfy_cli", "batch", "apps", "workspace", "bisect", "model_metadata", "node_snapshot"]);
const CONSOLIDATED_33 = new Set<string>(FINAL_SURFACE as string[]);

const episode = (
  substantive: { tool: string; action: string | null }[],
  extra: Record<string, unknown> = {},
) => ({ substantive, navigation: 0, navBeforeFirst: 0, error: null, ...extra });

const req = (id: string) => (REQUESTS as { id: string }[]).find((r) => r.id === id)!;

describe("fold map", () => {
  it("covers exactly the 146 retired names and yields the 33-tool surface", () => {
    expect(Object.keys(FOLD_MAP as Record<string, unknown>)).toHaveLength(146);
    expect(FINAL_SURFACE).toHaveLength(33);
  });

  it("resolves a capability flat when the surface still has it, folded when it does not", () => {
    expect(resolveExpectation("report_issue", FLAT_154)).toEqual({
      tool: "report_issue",
      action: null,
    });
    expect(resolveExpectation("report_issue", CONSOLIDATED_33)).toEqual({
      tool: "get_system_stats",
      action: "report_issue",
    });
  });

  it("throws rather than silently mis-scoring an unknown capability", () => {
    expect(() => resolveExpectation("no_such_tool", CONSOLIDATED_33)).toThrow(/neither registered/);
  });
});

describe("first-reach scoring — tool+action vs tool-only", () => {
  // ── THE regression the coordinator flagged, verbatim.
  it("scores generate_image(image) as a MISS for a video request but a tool-only HIT", () => {
    const r = req("h3-01"); // "a five-second clip …" → generate_video
    const expectation = resolveExpectation(r.target as string, CONSOLIDATED_33);
    expect(expectation).toEqual({ tool: "generate_image", action: "video" });

    const wrongAction = scoreEpisode(
      r,
      episode([{ tool: "generate_image", action: "image" }]),
      CONSOLIDATED_33,
    );
    expect(wrongAction.firstExact).toBe(false); // <- the whole point
    expect(wrongAction.firstToolOnly).toBe(true);
    expect(wrongAction.verdict).toBe("right-tool-wrong-action");

    // …and the mutation: the SAME call with the right action must flip only the
    // exact column, proving the assertion above is about the action and not
    // about something incidental.
    const rightAction = scoreEpisode(
      r,
      episode([{ tool: "generate_image", action: "video" }]),
      CONSOLIDATED_33,
    );
    expect(rightAction.firstExact).toBe(true);
    expect(rightAction.firstToolOnly).toBe(true);
    expect(rightAction.verdict).toBe("hit");
  });

  it("does the same for the regenerate/plain-render collision", () => {
    const r = req("gen-03"); // "do it again, more steps" → regenerate
    // gen-03 accepts generate_image as a defensible alternative, so use a row
    // where the collision is unambiguous: an upscale request answered by a
    // plain render folds to the same TOOL and must still miss.
    const up = req("gen-04"); // → upscale_image → generate_image(upscale)
    expect(resolveExpectation(up.target as string, CONSOLIDATED_33)).toEqual({
      tool: "generate_image",
      action: "upscale",
    });
    const s = scoreEpisode(up, episode([{ tool: "generate_image", action: "image" }]), CONSOLIDATED_33);
    expect(s.firstExact).toBe(false);
    expect(s.firstToolOnly).toBe(true);

    // and on the FLAT arm the equivalent confusion is a plain miss on both
    // columns — there is no shared tool name to be lenient about.
    const flat = scoreEpisode(up, episode([{ tool: "generate_image", action: null }]), FLAT_154);
    expect(flat.firstExact).toBe(false);
    expect(flat.firstToolOnly).toBe(false);
    expect(flat.verdict).toBe("miss");
    expect(r.target).toBe("regenerate");
  });

  it("ignores a stray action argument on a flat surface", () => {
    // On the 154-name surface there is no action to get wrong. A model that
    // passes action:"nonsense" to report_issue has still reached correctly, and
    // penalising it would make the baseline arm look worse than it is.
    const r = req("h1-01");
    const s = scoreEpisode(r, episode([{ tool: "report_issue", action: "nonsense" }]), FLAT_154);
    expect(s.firstExact).toBe(true);

    // mutation: a different TOOL on the same surface must miss.
    const wrong = scoreEpisode(r, episode([{ tool: "get_system_stats", action: null }]), FLAT_154);
    expect(wrong.firstExact).toBe(false);
    expect(wrong.firstToolOnly).toBe(false);
  });

  it("honours the accept set but only for the capabilities actually listed", () => {
    const r = req("gen-06"); // get_history, accepts list_output_images / list_assets
    const accepted = scoreEpisode(
      r,
      episode([{ tool: "get_image", action: "list_outputs" }]),
      CONSOLIDATED_33,
    );
    expect(accepted.firstExact).toBe(true);

    // mutation: an action on the same accepted TOOL that is not in the accept
    // set must not ride along.
    const notAccepted = scoreEpisode(
      r,
      episode([{ tool: "get_image", action: "convert" }]),
      CONSOLIDATED_33,
    );
    expect(notAccepted.firstExact).toBe(false);
    expect(notAccepted.firstToolOnly).toBe(true);
  });

  it("records no-reach distinctly from a wrong reach", () => {
    const r = req("h2-01");
    const none = scoreEpisode(r, episode([]), CONSOLIDATED_33);
    expect(none.verdict).toBe("no-reach");
    expect(none.firstExact).toBe(false);
    const wrong = scoreEpisode(r, episode([{ tool: "get_history", action: "stats" }]), CONSOLIDATED_33);
    expect(wrong.verdict).toBe("miss");
  });
});

describe(`reach-within-${REACH_WINDOW}`, () => {
  const r = () => req("h5-01"); // get_node_info → create_workflow(node_info)

  it("counts a correct call made after wrong ones, up to the window", () => {
    const late = scoreEpisode(
      r(),
      episode([
        { tool: "get_workflow", action: "get" },
        { tool: "list_packs", action: "list" },
        { tool: "create_workflow", action: "node_info" },
      ]),
      CONSOLIDATED_33,
    );
    expect(late.firstExact).toBe(false);
    expect(late.withinWindowExact).toBe(true);
  });

  it("does NOT count a correct call past the window", () => {
    const tooLate = scoreEpisode(
      r(),
      episode([
        { tool: "get_workflow", action: "get" },
        { tool: "list_packs", action: "list" },
        { tool: "get_history", action: "list" },
        { tool: "create_workflow", action: "node_info" },
      ]),
      CONSOLIDATED_33,
    );
    expect(tooLate.withinWindowExact).toBe(false);
  });
});

describe("negative rows", () => {
  it("passes only when the model reached for nothing, and never joins the accuracy denominator", () => {
    const r = req("neg-03"); // "Delete everything."
    const quiet = scoreEpisode(r, episode([]), CONSOLIDATED_33);
    expect(quiet.abstained).toBe(true);
    expect(quiet.verdict).toBe("abstained");

    const reached = scoreEpisode(
      r,
      episode([{ tool: "list_local_models", action: "remove" }]),
      CONSOLIDATED_33,
    );
    expect(reached.abstained).toBe(false);
    expect(reached.verdict).toBe("over-reached");

    // A model that never calls anything must NOT harvest free accuracy from the
    // negative rows.
    const positive = scoreEpisode(req("h2-01"), episode([]), CONSOLIDATED_33);
    const s = summarize([quiet, positive]);
    expect(s.nPositive).toBe(1);
    expect(s.nNegative).toBe(1);
    expect(s.firstReachExactPct).toBe(0);
    expect(s.abstainPct).toBe(100);
  });
});

describe("summarize", () => {
  it("moves when a single verdict is flipped (a scorer that always passes cannot do this)", () => {
    const rows = [
      scoreEpisode(req("h1-01"), episode([{ tool: "get_system_stats", action: "report_issue" }]), CONSOLIDATED_33),
      scoreEpisode(req("h1-02"), episode([{ tool: "get_system_stats", action: "logs" }]), CONSOLIDATED_33),
    ];
    const before = summarize(rows);
    expect(before.firstReachExactPct).toBe(50);
    expect(before.firstReachToolOnlyPct).toBe(100); // both hit the right TOOL

    const bothRight = summarize([
      rows[0]!,
      scoreEpisode(req("h1-02"), episode([{ tool: "get_system_stats", action: "report_issue" }]), CONSOLIDATED_33),
    ]);
    expect(bothRight.firstReachExactPct).toBe(100);
  });

  it("reports navigation cost separately from reaches", () => {
    const nav = scoreEpisode(
      req("mdl-01"),
      episode([{ tool: "list_local_models", action: "list" }], { navigation: 4, navBeforeFirst: 3 }),
      CONSOLIDATED_33,
    );
    expect(nav.firstExact).toBe(true); // navigation never costs accuracy
    const s = summarize([nav]);
    expect(s.navPerRequest).toBe(3);
    expect(s.navTotal).toBe(4);
  });
});

describe("confusion matrix", () => {
  it("names what was reached instead, and keeps a wrong ACTION visible as its own row", () => {
    const rows = confusion([
      scoreEpisode(req("h1-01"), episode([{ tool: "get_history", action: "list" }]), CONSOLIDATED_33),
      scoreEpisode(req("h1-02"), episode([{ tool: "get_history", action: "list" }]), CONSOLIDATED_33),
      scoreEpisode(req("h1-03"), episode([{ tool: "get_system_stats", action: "logs" }]), CONSOLIDATED_33),
    ]);
    const wanted = rows.find((r: { expected: string }) => r.expected === "get_system_stats(report_issue)");
    expect(wanted.total).toBe(3);
    expect(wanted.reached.map((c: { reached: string; count: number }) => [c.reached, c.count])).toEqual([
      ["get_history(list)", 2],
      ["get_system_stats(logs)", 1],
    ]);
  });

  it("excludes hits, so a matrix full of rows means real misses", () => {
    const rows = confusion([
      scoreEpisode(req("h1-01"), episode([{ tool: "get_system_stats", action: "report_issue" }]), CONSOLIDATED_33),
    ]);
    expect(rows).toHaveLength(0);
  });
});

describe("the request set itself", () => {
  it("is 100 rows, stratified, with no answer leakage", () => {
    expect(REQUESTS).toHaveLength(100);
    const { errors } = checkRequestSet((cap: string) => (FOLD_MAP as Record<string, { tool: string; action: string }>)[cap] ?? { tool: cap, action: null });
    expect(errors).toEqual([]);
  });

  it("names only capabilities that exist on both the old and the new surface", () => {
    for (const cap of referencedCapabilities() as string[]) {
      expect(() => resolveExpectation(cap, FLAT_154)).not.toThrow();
      expect(() => resolveExpectation(cap, CONSOLIDATED_33)).not.toThrow();
    }
  });

  it("FAILS on a leaky row — the gate can actually reject something", () => {
    // A gate only ever run against clean input is indistinguishable from one
    // that returns no errors unconditionally. Feed it each way a writer
    // actually leaks the answer and assert every one is caught.
    const leaks = [
      "please run list_local_models for me",
      "please run list local models for me",
      "please run list-local-models for me",
    ];
    for (const task of leaks) {
      const { errors } = checkRequestSet(undefined, [
        { id: "leak", tier: "neutral", task, target: "list_local_models", why: "test" },
      ]) as { errors: string[] };
      expect(errors.some((e) => e.includes("leaks the tool name"))).toBe(true);
    }
    // …and the identical row phrased as a user would is accepted, proving the
    // gate keys on the NAME rather than on the domain noun.
    const clean = checkRequestSet(undefined, [
      { id: "clean", tier: "neutral", task: "what have I got on disk?", target: "list_local_models", why: "test" },
    ]) as { errors: string[] };
    expect(clean.errors).toEqual([]);
  });

  it("FAILS on the folded phrasing too, once an arm resolver is supplied", () => {
    const resolver = (cap: string) =>
      (FOLD_MAP as Record<string, { tool: string; action: string }>)[cap] ?? { tool: cap, action: null };
    const { errors } = checkRequestSet(resolver, [
      {
        id: "leak2",
        tier: "hypothesis",
        task: "use get system stats report issue about the panel",
        target: "report_issue",
        why: "test",
      },
    ]) as { errors: string[] };
    expect(errors.some((e) => e.includes("folded form"))).toBe(true);
  });

  it("FAILS on structural mistakes that would skew a score", () => {
    const dup = checkRequestSet(undefined, [
      { id: "a", tier: "neutral", task: "x", target: "queue", why: "t" },
      { id: "a", tier: "neutral", task: "y", target: "queue", why: "t" },
    ]) as { errors: string[] };
    expect(dup.errors.some((e) => e.includes("duplicate id"))).toBe(true);

    const selfAccept = checkRequestSet(undefined, [
      { id: "b", tier: "neutral", task: "x", target: "queue", accept: ["queue"], why: "t" },
    ]) as { errors: string[] };
    expect(selfAccept.errors.some((e) => e.includes("double-count"))).toBe(true);

    const badNegative = checkRequestSet(undefined, [
      { id: "c", tier: "negative", task: "x", target: "queue", why: "t" },
    ]) as { errors: string[] };
    expect(badNegative.errors.some((e) => e.includes("target null"))).toBe(true);
  });

  it("expectations differ between arms for a folded capability (the A/B is real)", () => {
    const r = req("h4-01");
    const flat = expectationsFor(r, FLAT_154);
    const folded = expectationsFor(r, CONSOLIDATED_33);
    expect(flat.expected).toEqual({ tool: "list_skills", action: null });
    expect(folded.expected).toEqual({ tool: "list_packs", action: "list_skills" });
  });
});
