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
import { episodeFingerprint, mergeEpisodes, missingCoverage } from "../../scripts/tool-reach-merge.mjs";

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

describe("comparability fingerprints", () => {
  const cfg = {
    systemPrompt: "S",
    reachWindow: 3,
    toolResultCap: 200_000,
    maxRounds: 8,
    mode: "compact",
    adapter: "ollama",
    numCtx: 16384,
    think: false,
  };
  const req = { id: "h6-02", task: "build me the real thing", target: "mermaid_to_workflow" };

  it("changes when the request text changes", () => {
    const a = episodeFingerprint(req, cfg);
    const b = episodeFingerprint({ ...req, task: "build it from my sketch" }, cfg);
    expect(a).not.toBe(b);
  });

  it("changes when a run condition the model can perceive changes", () => {
    const a = episodeFingerprint(req, cfg);
    // The exact change that broke comparability in practice: results were
    // truncated at 12,000 characters, and the compact manifest is ~18,000.
    expect(episodeFingerprint(req, { ...cfg, toolResultCap: 12_000 })).not.toBe(a);
    expect(episodeFingerprint(req, { ...cfg, systemPrompt: "S2" })).not.toBe(a);
    expect(episodeFingerprint(req, { ...cfg, think: true })).not.toBe(a);
    expect(episodeFingerprint(req, { ...cfg, numCtx: 65536 })).not.toBe(a);
  });

  it("changes when the SCORING of the request changes, not just its wording", () => {
    // Tightening an accept set changes what the row means even though the model
    // saw the identical prompt.
    const a = episodeFingerprint({ ...req, accept: ["create_workflow"] }, cfg);
    expect(episodeFingerprint({ ...req, accept: [] }, cfg)).not.toBe(a);
  });

  it("is stable across runs with identical conditions", () => {
    expect(episodeFingerprint(req, cfg)).toBe(episodeFingerprint({ ...req }, { ...cfg }));
  });

  it("does NOT change for a hosted adapter when a local-only setting changes", () => {
    // Otherwise a tweak to the Ollama context window would invalidate — and
    // force a costly re-run of — Claude episodes that cannot see it.
    const hosted = { ...cfg, adapter: "claude", numCtx: null, think: null };
    expect(episodeFingerprint(req, hosted)).toBe(
      episodeFingerprint(req, { ...hosted, numCtx: null, think: null }),
    );
  });
});

describe("mergeEpisodes comparability", () => {
  const fp = (s: string) => s;
  const row = (model: string, requestId: string, fingerprint: string, tag = "") => ({
    model,
    requestId,
    fingerprint,
    tag,
  });
  const expected = new Map([
    ["a|gen-01", fp("F1")],
    ["a|h6-02", fp("F2")],
  ]);

  it("drops a saved row measured under conditions that no longer hold", () => {
    // h6-02's wording changed, so its saved row is stale — it must vanish and
    // reappear as missing coverage, never be averaged in as if comparable.
    const out = mergeEpisodes(
      [row("a", "gen-01", "F1", "keep"), row("a", "h6-02", "OLD", "stale")],
      [],
      expected,
    );
    expect(out).toHaveLength(1);
    expect(out[0].requestId).toBe("gen-01");
  });

  it("drops a saved row with NO fingerprint — 'cannot tell' must mean re-run", () => {
    const out = mergeEpisodes([{ model: "a", requestId: "gen-01" }], [], expected);
    expect(out).toEqual([]);
  });

  it("keeps rows for a model or request the current run knows nothing about", () => {
    // Another model's data, and a request id since removed, are out of scope —
    // not stale. Deleting them would be destroying somebody else's results.
    const out = mergeEpisodes(
      [row("z", "gen-01", "whatever"), row("a", "since-removed", "whatever")],
      [],
      expected,
    );
    expect(out).toHaveLength(2);
  });

  it("skips the check entirely when no expectation is supplied", () => {
    const out = mergeEpisodes([{ model: "a", requestId: "gen-01" }], []);
    expect(out).toHaveLength(1);
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
