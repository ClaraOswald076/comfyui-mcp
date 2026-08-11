// The cross-repo seam that #683 exposed, and the handshake that closes it.
//
// The panel calls tool names as bare string literals and vendors a generated copy
// of the vocabulary to validate them. Nothing compared that copy against the
// server it was actually talking to: `vocab:export --check` proves the artefact
// matches THIS repo's ledger, and the panel's gate proves its vendored file
// matches its own contents. Both are self-consistency; neither sees across the
// boundary. The skew then surfaces at CALL time as "unknown tool".

import { describe, expect, it } from "vitest";
import {
  computeVocabularyHash,
  describeVocabularySkew,
  DEAD_NAMES,
  TOOL_NAMES,
} from "../../tools/vocabulary.js";

const HASH = "6db51618f0bbe344e7ef3dad330da7971f19299db1a390cfd08672a04dda05fa";

describe("computeVocabularyHash", () => {
  it("is stable for the same names regardless of the array identity", () => {
    const a = computeVocabularyHash({ core: ["x", "y"], panel: ["p"], dead: ["d"] });
    const b = computeVocabularyHash({ core: [...["x", "y"]], panel: ["p"], dead: ["d"] });
    expect(a).toBe(b);
  });

  it("changes when ANY of the three lists changes", () => {
    const base = computeVocabularyHash({ core: ["x"], panel: ["p"], dead: ["d"] });
    expect(computeVocabularyHash({ core: ["x", "z"], panel: ["p"], dead: ["d"] })).not.toBe(base);
    expect(computeVocabularyHash({ core: ["x"], panel: ["p", "q"], dead: ["d"] })).not.toBe(base);
    expect(computeVocabularyHash({ core: ["x"], panel: ["p"], dead: ["d", "e"] })).not.toBe(base);
  });

  it("distinguishes order, because registration order is part of the core surface", () => {
    expect(computeVocabularyHash({ core: ["a", "b"], panel: [], dead: [] })).not.toBe(
      computeVocabularyHash({ core: ["b", "a"], panel: [], dead: [] }),
    );
  });

  // The whole handshake is worthless if this function and the export script
  // disagree: a drifted hash reports a mismatch that is not real, which is worse
  // than no check. This pins that they are the same rule over the same inputs.
  it("reproduces the committed artefact's hash from the live ledger", async () => {
    const { buildPanelToolDefs } = await import("../../orchestrator/panel-tools.js");
    const live = computeVocabularyHash({
      core: [...TOOL_NAMES],
      panel: buildPanelToolDefs()
        .map((d) => d.name)
        .sort(),
      dead: DEAD_NAMES.map((d) => d.name),
    });
    expect(live).toBe(HASH);
  });
});

describe("describeVocabularySkew", () => {
  it("reports a match when the two agree", () => {
    expect(describeVocabularySkew(HASH, HASH).status).toBe("match");
  });

  // THE load-bearing case. An older panel advertises nothing, and silence must
  // never be read as disagreement — that is the exact defect class this handshake
  // exists to catch, and committing it here would be self-refuting.
  it("treats a MISSING panel hash as unknown, never as a mismatch", () => {
    const r = describeVocabularySkew(HASH, undefined);
    expect(r.status).toBe("unknown");
    expect(r.status === "unknown" && r.reason).toMatch(/UNVERIFIED/);
  });

  it("treats an empty-string hash as unknown too, not as a differing value", () => {
    expect(describeVocabularySkew(HASH, "").status).toBe("unknown");
  });

  it("reports a mismatch when the two genuinely differ", () => {
    const r = describeVocabularySkew(HASH, "ffffffff".repeat(8));
    expect(r.status).toBe("mismatch");
  });

  it("does NOT claim which side is stale — it cannot know, and a guess sends half of users the wrong way", () => {
    const r = describeVocabularySkew(HASH, "ffffffff".repeat(8), "0.11.42");
    expect(r.status).toBe("mismatch");
    const msg = r.status === "mismatch" ? r.message : "";
    // It must name BOTH digests and prescribe updating both...
    // Derived from HASH rather than written as a literal: a literal is a second place the
    // digest has to be updated whenever the surface changes, and the one that gets missed
    // — this test failed on a new panel tool for no reason connected to what it checks.
    expect(msg).toContain(HASH.slice(0, 8));
    expect(msg).toContain("ffffffff");
    expect(msg).toMatch(/update BOTH/i);
    // ...and must not assert a direction it has no basis for.
    expect(msg).not.toMatch(/panel is (out of date|stale|older)/i);
    expect(msg).not.toMatch(/server is (out of date|stale|older)/i);
  });

  it("names the panel version when it has one, so the report is actionable", () => {
    const r = describeVocabularySkew(HASH, "ab".repeat(32), "0.11.40");
    expect(r.status === "mismatch" && r.message).toContain("panel 0.11.40");
  });

  it("explains that a resulting 'unknown tool' is the skew, not a broken panel", () => {
    const r = describeVocabularySkew(HASH, "ab".repeat(32));
    expect(r.status === "mismatch" && r.message).toMatch(/unknown tool/i);
  });
});
