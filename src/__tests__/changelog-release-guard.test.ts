// #2407 — mcp had a changelog GENERATOR and no verifier, and it cost three
// releases in one evening:
//
//   0.52.133  shipped #2378 and did not list it        (hand-corrected by #2384)
//   0.52.134  cut to carry a fix that had ALREADY shipped — no code changes at all
//   0.52.138  shipped #2400 and did not list it        (hand-corrected by #2406)
//
// One race produced all three: a PR merges between the release branch being cut
// and the release PR merging. Ancestry then resolves itself — the branch merges
// into main, so the tag gets the code — which is why nobody notices. Only the
// changelog gaps, and it gaps silently.
//
// WHY THE SCRATCH REPO. The guard's natural test subject is this repo's own
// CHANGELOG.md, and testing it that way is worthless twice over: the assertions
// move whenever a release lands, and a defect can only be exercised by breaking a
// real release. Every behaviour below is asserted against a synthetic history
// whose gap is deliberate, or against the pure audit with its git calls injected.
//
// MUTATION-CHECKED. Each coverage case was re-run with the `rangeCommits` block in
// scripts/check-changelog.mjs deleted, and with the fourth `isReleaseSubject`
// shape reverted; the named test fails in both cases. See the PR body.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  auditReleaseSection,
  parseCommitSubjects,
  parseReleaseSections,
} from "../../scripts/check-changelog.mjs";

const ROOT = join(import.meta.dirname, "..", "..");
const GUARD = join(ROOT, "scripts", "check-changelog.mjs");

// ── the pure audit ───────────────────────────────────────────────────────────

/** A commit as the guard sees it, with its issue/PR references already parsed. */
function commitOf(sha: string, subject: string) {
  return parseCommitSubjects(`${sha}\x1f${subject}\x1e`)[0];
}

function section(...body: string[]) {
  return ["# Changelog", "", "## Unreleased", "", "## [1.1.0] - 2026-08-26", "", ...body, ""].join("\n");
}

describe("#2407 half B: everything REACHABLE must be CITED", () => {
  it("reports a PR that shipped in the range and is named nowhere in the section", () => {
    const shipped = commitOf("aaa", "fix(900): the entry that was never written (#901)");
    const violations = auditReleaseSection({
      markdown: section("### Fixed", "- something else (#801)"),
      version: "1.1.0",
      commits: [shipped, commitOf("bbb", "fix: something else (#801)")],
      rangeCommits: [shipped],
      targetRef: "v1.1.0",
      previousRef: "v1.0.0",
      isAncestor: () => true,
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("does not mention PR #901");
    expect(violations[0]).toContain("v1.0.0");
  });

  it("accepts the ISSUE spelling, because a squash subject links the two", () => {
    // `fix(900): … (#901)` is one shipped change under two numbers. An entry that
    // cites #900 has documented #901, and demanding the PR spelling would report a
    // release as gapped when the entry is sitting right there.
    const shipped = commitOf("aaa", "fix(900): one change, two numbers (#901)");
    expect(
      auditReleaseSection({
        markdown: section("### Fixed", "- one change, two numbers (#900)"),
        version: "1.1.0",
        commits: [shipped],
        rangeCommits: [shipped],
        targetRef: "v1.1.0",
        previousRef: "v1.0.0",
      }),
    ).toEqual([]);
  });

  it("accepts a BARE #N written in prose, not just the generator's (#N)", () => {
    // 0.52.135 documents its predecessor's misattribution as "credit #2378 to
    // 0.52.133, where it shipped". That is an entry. Requiring parentheses here
    // would fail a release for the hand-written note that fixed a previous one.
    const shipped = commitOf("aaa", "fix: hand-written note (#901)");
    expect(
      auditReleaseSection({
        markdown: section("### Changed", "- credit #901 to the release where it shipped"),
        version: "1.1.0",
        commits: [shipped],
        rangeCommits: [shipped],
        targetRef: "v1.1.0",
        previousRef: "v1.0.0",
      }),
    ).toEqual([]);
  });

  it("ignores the release commit — `v<prev>..vX` always contains X's own", () => {
    // The shape protected main actually writes. Without the fourth
    // isReleaseSubject regex this reports EVERY release as missing an entry for
    // itself, which would make the guard useless on its first run.
    const release = commitOf("ccc", "chore: release v1.1.0 (#999)");
    expect(
      auditReleaseSection({
        markdown: section("### Fixed", "- a real change (#801)"),
        version: "1.1.0",
        commits: [commitOf("bbb", "fix: a real change (#801)"), release],
        rangeCommits: [commitOf("bbb", "fix: a real change (#801)"), release],
        targetRef: "v1.1.0",
        previousRef: "v1.0.0",
      }),
    ).toEqual([]);
  });

  it("ignores a commit with no PR number — the generator drops those too", () => {
    // A local commit a squash superseded. The guard and the generator have to
    // agree on what counts as shipped, or the guard fights its own generator.
    expect(
      auditReleaseSection({
        markdown: section("### Fixed", "- a real change (#801)"),
        version: "1.1.0",
        commits: [commitOf("bbb", "fix: a real change (#801)")],
        rangeCommits: [
          commitOf("bbb", "fix: a real change (#801)"),
          commitOf("ddd", "wip: local work in progress"),
        ],
        targetRef: "v1.1.0",
        previousRef: "v1.0.0",
      }),
    ).toEqual([]);
  });

  it("says nothing about coverage when the range could not be resolved", () => {
    // A shallow clone or a repo with no previous tag cannot answer "what shipped
    // since the last release" — it can only answer it wrong, by reporting every
    // PR as missing. `null` is not an empty range.
    expect(
      auditReleaseSection({
        markdown: section("### Fixed", "- a real change (#801)"),
        version: "1.1.0",
        commits: [commitOf("bbb", "fix: a real change (#801)")],
        rangeCommits: null,
        targetRef: "v1.1.0",
        previousRef: null,
      }),
    ).toEqual([]);
  });
});

describe("#2407 half A: everything CITED must be REACHABLE", () => {
  it("reports an entry credited to a release that does not contain it", () => {
    const violations = auditReleaseSection({
      markdown: section("### Fixed", "- shipped somewhere else (#801)"),
      version: "1.1.0",
      commits: [commitOf("bbb", "fix: shipped somewhere else (#801)")],
      rangeCommits: [],
      targetRef: "v1.1.0",
      previousRef: "v1.0.0",
      isAncestor: () => false,
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("is an ancestor of v1.1.0");
  });

  it("checks an entry that closes TWO PRs in one comma list", () => {
    // 0.52.136 writes `… (#2382, #2387)`. The panel's single-reference regex
    // returns nothing for that, which does not fail — it makes this whole half
    // skip the entry in silence, exempting it from the check meant to catch a
    // wrong credit. Coverage still passed it (that half reads bare #N), so the
    // release looked fully audited while half of the audit saw nothing.
    const violations = auditReleaseSection({
      markdown: section("### Fixed", "- one entry, two PRs (#2382, #2387)"),
      version: "1.1.0",
      commits: [
        commitOf("aaa", "fix: the first half (#2382)"),
        commitOf("bbb", "fix: the second half (#2387)"),
      ],
      rangeCommits: [],
      targetRef: "v1.1.0",
      previousRef: "v1.0.0",
      isAncestor: (sha: string) => sha !== "bbb",
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("#2387");
  });

  it("reports an entry naming a number no commit carries", () => {
    // This is the 0.52.134 shape: the section cited #2378, no commit anywhere
    // carried it, and reading that gap as "not shipped yet" produced a whole
    // no-op version.
    const violations = auditReleaseSection({
      markdown: section("### Changed", "- no code changes; this already shipped (#2378)"),
      version: "1.1.0",
      commits: [commitOf("bbb", "fix(codex): the real subject (#2379)")],
      rangeCommits: [],
      targetRef: "v1.1.0",
      previousRef: "v1.0.0",
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("no commit reachable from v1.1.0 carries that reference");
  });
});

describe("#2407 structure: a hand-edited section stays well formed", () => {
  const markdown = [
    "# Changelog",
    "",
    "## [1.1.0] - 2026-08-26",
    "",
    "### Fixed",
    "- one thing (#801)",
    "",
    "### Fixed",
    "- one thing again (#801)",
    "",
    "## [1.1.0] - 2026-08-25",
    "",
    "### Fixed",
    "- a duplicate section",
    "",
  ].join("\n");

  it("catches a repeated version, a repeated heading and a twice-credited PR", () => {
    const violations = auditReleaseSection({
      markdown,
      version: "1.1.0",
      commits: [commitOf("bbb", "fix: one thing (#801)")],
      rangeCommits: [],
      targetRef: "v1.1.0",
      previousRef: "v1.0.0",
    });
    expect(violations.some((v) => v.includes("repeats the [1.1.0] release section"))).toBe(true);
    expect(violations.some((v) => v.includes('repeats the heading "Fixed"'))).toBe(true);
    expect(violations.some((v) => v.includes("credits issue/PR identity #801 twice"))).toBe(true);
  });

  it("reports a missing or empty section rather than passing it", () => {
    expect(
      auditReleaseSection({ markdown: "# Changelog\n", version: "1.1.0", targetRef: "v1.1.0" }).join(),
    ).toContain("has no [1.1.0] release section");
    expect(
      auditReleaseSection({
        markdown: "# Changelog\n\n## [1.1.0] - 2026-08-26\n\n",
        version: "1.1.0",
        targetRef: "v1.1.0",
      }).join(),
    ).toContain("[1.1.0] release section is empty");
  });

  it("parses CRLF, which is the line ending mcp's CHANGELOG.md actually uses", () => {
    // The panel's file is LF and mcp's is CRLF. A heading regex that survives one
    // and not the other reads as a clean run while seeing nothing at all.
    const parsed = parseReleaseSections("# Changelog\r\n\r\n## [1.1.0] - 2026-08-26\r\n\r\n- x (#1)\r\n");
    expect(parsed).toHaveLength(1);
    expect(parsed[0].version).toBe("1.1.0");
    expect(parsed[0].lines.some((l: string) => l.includes("(#1)"))).toBe(true);
  });
});

// ── the real CLI, against a real (tiny) repository ───────────────────────────

describe("#2407 end to end: the guard blocks the cut that shipped 0.52.138", () => {
  let dir: string;

  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();

  const commit = (subject: string) => {
    writeFileSync(join(dir, "f.txt"), subject);
    git("add", "-A");
    git("commit", "-q", "-m", subject);
  };

  const writeChangelog = (...body: string[]) =>
    // CRLF deliberately: this repo's CHANGELOG.md is CRLF, and the guard reads the
    // file rather than a normalised copy.
    writeFileSync(join(dir, "CHANGELOG.md"), body.join("\r\n") + "\r\n");

  const runGuard = (...args: string[]) =>
    spawnSync(process.execPath, [GUARD, ...args], {
      cwd: dir,
      encoding: "utf-8",
      env: { ...process.env, COMFYUI_MCP_CHANGELOG_ROOT: dir },
    });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "clguard-"));
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "t");
    writeChangelog("# Changelog", "", "## Unreleased", "", "## [1.0.0] - 2026-08-26", "", "### Fixed", "- the first thing (#801)", "");
    commit("fix: the first thing (#801)");
    git("tag", "v1.0.0");
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("fails, and names the PR, when a release ships a fix it does not list", () => {
    // Exactly the 0.52.138 shape: #901 merges into the release, ancestry is fine,
    // and only the notes gap.
    commit("fix(900): the one that got away (#901)");
    writeChangelog(
      "# Changelog",
      "",
      "## Unreleased",
      "",
      "## [1.1.0] - 2026-08-27",
      "",
      "### Fixed",
      "- an unrelated tidy-up (#902)",
      "",
      "## [1.0.0] - 2026-08-26",
      "",
      "### Fixed",
      "- the first thing (#801)",
      "",
    );
    commit("fix: an unrelated tidy-up (#902)");
    commit("chore: release v1.1.0 (#903)");
    git("tag", "v1.1.0");

    const result = runGuard();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("does not mention PR #901");
    // The release commit itself must NOT be reported; that noise would bury the
    // one line that matters.
    expect(result.stderr).not.toContain("#903");
  });

  it("passes once the missing entry is added — nothing else about the cut changed", () => {
    commit("fix(900): the one that got away (#901)");
    writeChangelog(
      "# Changelog",
      "",
      "## Unreleased",
      "",
      "## [1.1.0] - 2026-08-27",
      "",
      "### Fixed",
      "- the one that got away (#901)",
      "",
      "## [1.0.0] - 2026-08-26",
      "",
      "### Fixed",
      "- the first thing (#801)",
      "",
    );
    commit("chore: release v1.1.0 (#903)");
    git("tag", "v1.1.0");

    const result = runGuard();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("lists every PR since v1.0.0");
  });

  it("audits the cut BEFORE the tag exists, which is when a release can still be fixed", () => {
    // `npm version` and the release PR both run before the tag is pushed. If the
    // guard only worked against a tag it would report the mistake after publish.
    commit("fix(900): the one that got away (#901)");
    writeChangelog(
      "# Changelog",
      "",
      "## Unreleased",
      "",
      "## [1.1.0] - 2026-08-27",
      "",
      "### Fixed",
      "- an unrelated tidy-up (#902)",
      "",
      "## [1.0.0] - 2026-08-26",
      "",
      "### Fixed",
      "- the first thing (#801)",
      "",
    );
    commit("fix: an unrelated tidy-up (#902)");

    const result = runGuard();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("does not mention PR #901");
    expect(result.stderr).toContain("reachable from HEAD");
  });

  it("refuses a malformed version argument instead of auditing a different section", () => {
    for (const malformed of ["1.1", "1.1.0; touch pwned", "--bad-version"]) {
      const result = runGuard(malformed);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("invalid release version");
      expect(result.stderr).not.toContain("has no [");
    }
  });

  it("skips coverage LOUDLY when there is no previous tag, rather than reporting every PR", () => {
    rmSync(join(dir, ".git", "refs", "tags", "v1.0.0"));
    const result = runGuard("1.0.0");
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("coverage");
    expect(result.stderr).toContain("was NOT checked");
    // A skip must never read like a clean pass.
    expect(result.stdout).not.toContain("lists every PR since");
  });
});

// ── wiring ───────────────────────────────────────────────────────────────────

describe("#2407 WIRING: the guard actually runs on the paths that matter", () => {
  // A guard nothing invokes is a green dormant mechanism. These assert the whole
  // chain by PATH, because every link in it is a place the wiring can be dropped
  // without a single test going red.
  const read = (...parts: string[]) => readFileSync(join(ROOT, ...parts), "utf-8");

  it("npm test runs it", () => {
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    expect(pkg.scripts.test).toContain("scripts/run-checks.mjs");
    const checks = read("scripts", "run-checks.mjs");
    expect(checks).toContain("scripts/check-changelog.mjs");
  });

  it("and npm test is what ci.yml and release.yml both run", () => {
    // release.yml enforcing less than ci.yml is a documented past failure in this
    // repo — three gates were CI-only and a tag could publish what a pull request
    // would have blocked. Wiring into `npm test` is what keeps the two in step.
    expect(read(".github", "workflows", "ci.yml")).toMatch(/^\s*-\s*run:\s*npm test\s*$/m);
    expect(read(".github", "workflows", "release.yml")).toMatch(/^\s*-\s*run:\s*npm test\s*$/m);
  });

  it("and the guard shares ONE release-commit predicate with the generator", () => {
    // A second copy would drift silently: the generator has no failing output,
    // only a wrong one, and the guard would start disagreeing with it about what
    // counts as shipped.
    expect(read("scripts", "check-changelog.mjs")).toContain(
      'import { isReleaseSubject } from "./lib/release-subject.mjs"',
    );
    expect(read("scripts", "check-changelog.mjs")).not.toMatch(/const isReleaseSubject\s*=/);
  });
});
