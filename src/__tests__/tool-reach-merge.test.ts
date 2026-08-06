/**
 * Result merging — both of whose failure modes are SILENT.
 *
 * Neither crashes. Both produce a results file that parses, renders a table,
 * and reports a number nobody can tell is wrong. Both have been live in this
 * benchmark:
 *
 *  - keyed by MODEL, a targeted `--only h6-01` re-run wiped that model's other
 *    99 episodes and left a one-row score under a full-looking arm;
 *  - with an always-true filter predicate (`!justRan.has()` — the argument was
 *    lost to shell escape mangling, so it compiled and ran), every per-episode
 *    checkpoint re-appended the entire run, weighting each row by how many times
 *    it happened to be written.
 *
 * So each test below asserts the COUNT as well as the content: a duplicate is
 * the whole bug.
 */
import { describe, expect, it } from "vitest";
// @ts-expect-error — plain-JS benchmark module, deliberately untyped
import { mergeEpisodes, missingCoverage } from "../../scripts/tool-reach-merge.mjs";

const ep = (model: string, requestId: string, tag = "") => ({ model, requestId, tag });

describe("mergeEpisodes", () => {
  it("supersedes by (model, requestId) and keeps everything else", () => {
    const prior = [ep("a", "gen-01", "old"), ep("a", "h6-01", "old"), ep("b", "gen-01", "old")];
    const fresh = [ep("a", "h6-01", "new")];
    const out = mergeEpisodes(prior, fresh);
    expect(out).toHaveLength(3);
    expect(out.find((e: { model: string; requestId: string }) => e.model === "a" && e.requestId === "h6-01").tag).toBe("new");
    expect(out.find((e: { model: string; requestId: string }) => e.model === "b" && e.requestId === "gen-01").tag).toBe("old");
    // the OTHER request for model "a" survives — the wipe bug
    expect(out.find((e: { model: string; requestId: string }) => e.model === "a" && e.requestId === "gen-01").tag).toBe("old");
  });

  it("does not duplicate when the same rows are written repeatedly (the checkpoint bug)", () => {
    // Simulate per-episode checkpointing: write [1], then [1,2], then [1,2,3],
    // each time merging against what the previous write left on disk.
    let onDisk: { model: string; requestId: string }[] = [];
    const run = [ep("a", "gen-01"), ep("a", "gen-02"), ep("a", "gen-03")];
    for (let i = 1; i <= run.length; i++) onDisk = mergeEpisodes(onDisk, run.slice(0, i));
    expect(onDisk).toHaveLength(3);
    expect(onDisk.map((e) => e.requestId)).toEqual(["gen-01", "gen-02", "gen-03"]);
  });

  it("keeps a different model's rows for the same request", () => {
    const out = mergeEpisodes([ep("a", "gen-01", "old"), ep("b", "gen-01", "old")], [ep("a", "gen-01", "new")]);
    expect(out).toHaveLength(2);
    expect(out.map((e: { tag: string }) => e.tag).sort()).toEqual(["new", "old"]);
  });

  it("is a no-op on an empty fresh set", () => {
    const prior = [ep("a", "gen-01")];
    expect(mergeEpisodes(prior, [])).toEqual(prior);
  });
});

describe("missingCoverage", () => {
  it("names the requests a model has not run, so a partial arm cannot pass as complete", () => {
    const all = ["gen-01", "gen-02", "gen-03"];
    const gaps = missingCoverage([ep("a", "gen-01"), ep("b", "gen-01"), ep("b", "gen-02")], all);
    expect(gaps.get("a")).toEqual(["gen-02", "gen-03"]);
    expect(gaps.get("b")).toEqual(["gen-03"]);
  });

  it("reports nothing when coverage is complete", () => {
    const all = ["gen-01", "gen-02"];
    expect(missingCoverage([ep("a", "gen-01"), ep("a", "gen-02")], all).size).toBe(0);
  });
});
