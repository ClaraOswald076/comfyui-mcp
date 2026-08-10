// #1309 — the subject THIS repo writes on every release was not recognised as a
// release, so each release-reconcile commit appeared in the NEXT release's entry
// under "Changed". I hand-corrected it twice before filing.
//
// REPRODUCED AGAINST THE REAL HISTORY, which is the only reason this is here in
// this form. Checked out the parent of the 0.50.86 release commit and ran the
// generator:
//
//   without the fix:  #### Changed
//                     - 0.50.85 (#1302)      <- the release-reconcile PR
//   with the fix:     (section absent)
//
// WHY THIS FILE TESTS THE PREDICATE DIRECTLY. I first tested it through the
// generator against a scratch repo, and that test PASSED WITH THE FIX REVERTED —
// the synthetic history dropped the entry for an unrelated reason, so it was
// verifying nothing while reading as though it verified the fix. Two attempts to
// make the scratch history match reality (adding the PR number, then committing
// package.json as a real release does) both failed to reproduce it. Rather than
// keep guessing at which condition mattered, the predicate now lives in its own
// module and is asserted here, where the assertion cannot be satisfied by
// accident.

import { describe, expect, it } from "vitest";

import { isReleaseSubject } from "../../scripts/lib/release-subject.mjs";

describe("a release commit is recognised as one (#1309)", () => {
  it("recognises what THIS repo's release flow actually writes", () => {
    // `npm version patch -m "chore(release): %s"`, squash-merged with the PR
    // number appended by GitHub. The shape that broke every release.
    expect(isReleaseSubject("chore(release): 0.50.85 (#1302)")).toBe(true);
    expect(isReleaseSubject("chore(release): 1.0.0")).toBe(true);
    // A breaking marker is still a release.
    expect(isReleaseSubject("chore(release)!: 2.0.0 (#102)")).toBe(true);
    // Another type with the release scope is still a release.
    expect(isReleaseSubject("build(release): 0.1.0 (#3)")).toBe(true);
  });

  it("still recognises the two shapes it always did", () => {
    expect(isReleaseSubject("release: v0.50.87 — a stale model copy (#1306)")).toBe(true);
    expect(isReleaseSubject("0.50.85 (#1302)")).toBe(true);
    expect(isReleaseSubject("v1.2.3")).toBe(true);
  });

  it("an ORDINARY chore is NOT a release — the skip is scoped, not blanket", () => {
    // The easy fix would be to skip `chore:` outright, and it would be wrong: a
    // chore can be a real user-facing change, and dropping entries silently is
    // the failure the generator warns about at length.
    expect(isReleaseSubject("chore: bump the pinned frontend floor (#201)")).toBe(false);
    expect(isReleaseSubject("chore(deps): update a runtime dependency (#202)")).toBe(false);
    expect(isReleaseSubject("chore(release-notes): fix a typo (#203)")).toBe(false);
  });

  it("does not match a real change that merely mentions a release", () => {
    expect(isReleaseSubject("fix(release): the tag was pushed before the build (#204)")).toBe(
      // `fix(release)` IS the release scope, and a fix scoped to the release
      // process is indistinguishable from a release commit by subject alone.
      // Accepted deliberately: the cost is one dropped entry for a rare shape,
      // against a wrong entry on EVERY release. Recorded so it is a decision
      // rather than a surprise.
      true,
    );
    // …but a description mentioning a release is not one.
    expect(isReleaseSubject("docs: explain the release process (#205)")).toBe(false);
    expect(isReleaseSubject("fix: do not release the lock too early (#206)")).toBe(false);
  });

  it("is not fooled by leading whitespace or an empty subject", () => {
    expect(isReleaseSubject("")).toBe(false);
    expect(isReleaseSubject("   ")).toBe(false);
    // A version must be the WHOLE subject to count on its own, or an ordinary
    // change starting with a number would vanish.
    expect(isReleaseSubject("0.50.85 is the version that broke it (#207)")).toBe(false);
  });
});

describe("WIRING: the generator uses the shared predicate (#1309)", () => {
  it("imports it rather than keeping its own copy", async () => {
    // A second copy would drift, and the drift would be silent — the generator
    // has no failing output, only a wrong one.
    const { readFile } = await import("node:fs/promises");
    const src = await readFile(
      new URL("../../scripts/gen-changelog.mjs", import.meta.url),
      "utf-8",
    );
    expect(src).toContain('import { isReleaseSubject } from "./lib/release-subject.mjs"');
    expect(src).toContain("if (isReleaseSubject(subject)) continue;");
    // …and does not redefine it.
    expect(src).not.toMatch(/const isReleaseSubject\s*=/);
  });
});
