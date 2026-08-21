// comfyui-mcp-4x5 — the file-size ratchet.
//
// The rule is pstack's: no PR pushes a file from under 1,000 lines to over
// 1,000 without a very strong reason. Forty files in this repo are already past
// it, and every one got there by increments nobody refused. The gate refuses the
// next increment.
//
// What is worth pinning is the DIRECTION. A debt list that can grow is not a
// debt list; so growth fails, shrink-without-regenerating fails, and the reason
// an author wrote for a genuine exception survives the regeneration that a later
// split triggers. Each of those is a behaviour someone could quietly lose while
// "simplifying" the script, and each would turn the gate into a formality.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Located relative to THIS file rather than `process.cwd()`, so the test does not
// depend on where vitest was launched from.
const SCRIPTS_DIR = fileURLToPath(new URL("../../../scripts/", import.meta.url));
const SCRIPT = join(SCRIPTS_DIR, "check-file-size.mjs");
const LIMIT = 1000;

let dir: string;
let src: string;
let baselineFile: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "filesize-"));
  src = join(dir, "src");
  mkdirSync(src, { recursive: true });
  baselineFile = join(dir, "baseline.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A file of exactly `n` newline-terminated lines — what `wc -l` would report. */
function write(name: string, n: number) {
  const p = join(src, name);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, "export {};\n".repeat(n), "utf8");
}

/** Run the gate. Returns the exit code and the combined output — the gate's
 *  MESSAGE is part of its contract, since a developer who cannot tell why it
 *  fired will reach for the baseline instead of the split. */
function spawn(...argv: string[]) {
  try {
    const out = execFileSync(process.execPath, [SCRIPT, ...argv], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string };
    return { code: err.status, out: (err.stdout ?? "") + (err.stderr ?? "") };
  }
}

function run(...extra: string[]) {
  return spawn("--src", src, "--baseline-file", baselineFile, ...extra);
}

function baseline() {
  const r = run("--baseline");
  expect(r.code, r.out).toBe(0);
  return JSON.parse(readFileSync(baselineFile, "utf8")) as {
    limit: number;
    files: Array<{ path: string; lines: number; reason?: string }>;
  };
}

describe("comfyui-mcp-4x5 what the gate FLAGS", () => {
  it("a file that crosses the limit without being named", () => {
    write("big.ts", LIMIT + 1);
    const r = run();
    expect(r.code).toBe(1);
    expect(r.out).toContain("1 file(s) crossed");
    expect(r.out).toContain("big.ts");
    expect(r.out).toContain(`${LIMIT + 1}`);
    // The message sends the author to the split first, and to the baseline
    // only with a reason — the two halves of the rule, in that order.
    expect(r.out.indexOf("Split")).toBeLessThan(r.out.indexOf("--baseline"));
    expect(r.out).toContain('"reason"');
  });

  it("a baselined file that grew by a single line", () => {
    // The increment is the unit of the defect. A gate that tolerated "just one
    // more" would be re-deriving the forty files it exists to stop.
    write("mono.ts", 1500);
    baseline();
    write("mono.ts", 1501);
    const r = run();
    expect(r.code).toBe(1);
    expect(r.out).toContain("1 baselined file(s) grew");
    expect(r.out).toContain("mono.ts  1500 -> 1501  (+1)");
  });

  it("a file in a subdirectory, reported by its src-relative POSIX path", () => {
    write(join("orchestrator", "deep", "thing.ts"), LIMIT + 5);
    const r = run();
    expect(r.code).toBe(1);
    expect(r.out).toContain("orchestrator/deep/thing.ts");
  });
});

describe("comfyui-mcp-4x5 what the gate must stay QUIET about", () => {
  it("a file exactly AT the limit — over means over, not at", () => {
    write("edge.ts", LIMIT);
    const r = run();
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("0 baselined file(s)");
  });

  it("a baselined file that has not moved", () => {
    write("mono.ts", 1500);
    baseline();
    const r = run();
    expect(r.code, r.out).toBe(0);
  });

  it("test files and __tests__ trees, however long", () => {
    // A long test file is a different and smaller problem than a long module,
    // and the suite already has files that would trip this on day one for
    // reasons unrelated to the lesson being encoded.
    write(join("__tests__", "huge.test.ts"), 3000);
    write(join("__tests__", "helpers.ts"), 3000);
    write("also.test.ts", 3000);
    write("also.spec.ts", 3000);
    const r = run();
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("0 baselined file(s)");
  });

  it("declaration files, and files that are not TypeScript", () => {
    write("types.d.ts", 3000);
    writeFileSync(join(src, "data.json"), "[\n" + "  1,\n".repeat(3000) + "]\n", "utf8");
    const r = run();
    expect(r.code, r.out).toBe(0);
  });

  it("a file with no trailing newline is counted by what a reader reads", () => {
    // `wc -l` would say 999 for a 1000-line file missing its last newline; the
    // gate says 1000, because the partial last line is still a line. Pinned so
    // nobody can slip under the limit by deleting a byte.
    writeFileSync(join(src, "noeol.ts"), "export {};\n".repeat(LIMIT) + "export {};", "utf8");
    const r = run();
    expect(r.code, r.out).toBe(1);
  });

  it("CRLF line endings are not double-counted", () => {
    // The CI matrix includes Windows. A checkout with autocrlf must produce the
    // same count as the committed LF file, or the baseline only works on one OS.
    writeFileSync(join(src, "crlf.ts"), "export {};\r\n".repeat(LIMIT), "utf8");
    const r = run();
    expect(r.code, r.out).toBe(0);
  });
});

describe("comfyui-mcp-4x5 the ratchet only pays down", () => {
  it("a SHRUNK file fails until the baseline is regenerated", () => {
    // Otherwise the entry keeps claiming room the file no longer uses, and room
    // nobody is using is room the file can grow back into, pre-approved.
    write("mono.ts", 1500);
    baseline();
    write("mono.ts", 1400);
    const r = run();
    expect(r.code).toBe(1);
    expect(r.out).toContain("no longer match");
    expect(r.out).toContain("mono.ts  1500 -> now 1400");
    expect(r.out).toContain("--baseline");
  });

  it("a file that dropped UNDER the limit is stale, not silently fine", () => {
    write("mono.ts", 1500);
    baseline();
    write("mono.ts", 900);
    const r = run();
    expect(r.code).toBe(1);
    expect(r.out).toContain("mono.ts  1500 -> now under");
    expect(r.out).toContain("--baseline");
  });

  it("a DELETED (or moved) file is stale", () => {
    write("mono.ts", 1500);
    baseline();
    rmSync(join(src, "mono.ts"));
    const r = run();
    expect(r.code).toBe(1);
    expect(r.out).toContain("mono.ts");
    expect(r.out).toContain("--baseline");
  });

  it("regenerating after the shrink clears it, and records the LOWER count", () => {
    write("mono.ts", 1500);
    baseline();
    write("mono.ts", 1400);
    const b = baseline();
    expect(b.files).toEqual([{ path: "mono.ts", lines: 1400 }]);
    const ok = run();
    expect(ok.code, ok.out).toBe(0);
    // ...and the new, lower count is now the ceiling.
    write("mono.ts", 1401);
    const grew = run();
    expect(grew.code).toBe(1);
    expect(grew.out).toContain("1400 -> 1401");
  });

  it("the baseline is sorted by path, so regenerating never reorders it", () => {
    write("zeta.ts", 1100);
    write("alpha.ts", 1100);
    write(join("mid", "x.ts"), 1100);
    const b = baseline();
    expect(b.files.map((f) => f.path)).toEqual(["alpha.ts", "mid/x.ts", "zeta.ts"]);
    expect(b.limit).toBe(LIMIT);
  });
});

describe("comfyui-mcp-4x5 the reason — the deliverable of an exception", () => {
  function setReason(path: string, reason: string) {
    const doc = JSON.parse(readFileSync(baselineFile, "utf8"));
    for (const f of doc.files) if (f.path === path) f.reason = reason;
    writeFileSync(baselineFile, JSON.stringify(doc, null, 2) + "\n", "utf8");
  }

  it("an entry with a reason is accepted and the reason is shown in --list", () => {
    write("vocab.ts", 2000);
    baseline();
    setReason("vocab.ts", "one flat list by design; a split would scatter the lookup");
    const ok = run();
    expect(ok.code, ok.out).toBe(0);
    const r = run("--list");
    expect(r.code).toBe(0);
    expect(r.out).toContain("vocab.ts\t2000\tone flat list by design");
  });

  it("a reason SURVIVES regeneration after the file shrinks", () => {
    // Regenerating is how a count goes down after a split. It must not also be
    // how an explanation someone already wrote disappears.
    write("vocab.ts", 2000);
    baseline();
    setReason("vocab.ts", "one flat list by design; a split would scatter the lookup");
    write("vocab.ts", 1900);
    const b = baseline();
    expect(b.files).toEqual([
      { path: "vocab.ts", lines: 1900, reason: "one flat list by design; a split would scatter the lookup" },
    ]);
  });

  it("a reason does not license GROWTH past the recorded count", () => {
    // The reason explains the number that is there. Growing past it is a new
    // decision, and the diff of the bumped `lines` field is where it is made.
    write("vocab.ts", 2000);
    baseline();
    setReason("vocab.ts", "one flat list by design; a split would scatter the lookup");
    write("vocab.ts", 2001);
    const r = run();
    expect(r.code).toBe(1);
    expect(r.out).toContain("existing reason: one flat list by design");
  });

  it("a hand-bumped entry is accepted when the count is exact", () => {
    // The sanctioned exception path: grow the file, bump `lines` to match, add
    // the reason — all in one PR, all visible in one diff.
    write("vocab.ts", 2000);
    baseline();
    write("vocab.ts", 2010);
    const doc = JSON.parse(readFileSync(baselineFile, "utf8"));
    doc.files[0] = { path: "vocab.ts", lines: 2010, reason: "generated table; regenerated from the registry" };
    writeFileSync(baselineFile, JSON.stringify(doc, null, 2) + "\n", "utf8");
    const r = run();
    expect(r.code, r.out).toBe(0);
  });
});

describe("comfyui-mcp-4x5 the baseline file itself", () => {
  it("absent means nothing is grandfathered — the correct first-run state", () => {
    write("small.ts", 10);
    const ok = run();
    expect(ok.code, ok.out).toBe(0);
    write("big.ts", LIMIT + 1);
    const bad = run();
    expect(bad.code).toBe(1);
  });

  it("a flag with a MISSING value is a usage error, not a silent fallback", () => {
    // `--src --baseline` must not scan the real tree and rewrite the real
    // baseline because a fixture path was mistyped away.
    write("mono.ts", 1500);
    const r = spawn("--src", "--baseline");
    expect(r.code).toBe(2);
    expect(r.out).toContain("--src needs a value");
    expect(r.out).not.toContain("at ");
  });

  it("a MALFORMED baseline fails --baseline with the path and an instruction, not a stack trace", () => {
    // `--baseline` is what the gate tells people to run when the file is stale.
    // If the file is too broken to read, the reasons in it cannot be carried
    // forward, and the author needs to hear that — and the broken file must be
    // left alone rather than silently replaced.
    write("mono.ts", 1500);
    writeFileSync(baselineFile, "{ not json", "utf8");
    const r = run("--baseline");
    expect(r.code).toBe(1);
    expect(r.out).toContain(baselineFile);
    expect(r.out).toContain("Fix or delete it, then run --baseline again");
    expect(r.out).not.toContain("    at ");
    expect(readFileSync(baselineFile, "utf8")).toBe("{ not json");
  });

  it("a baseline written against a DIFFERENT limit is refused", () => {
    // The limit in the file is what the counts were measured against. If it
    // disagrees with the script, one was edited without the other.
    write("mono.ts", 1500);
    writeFileSync(baselineFile, JSON.stringify({ limit: 500, files: [{ path: "mono.ts", lines: 1500 }] }), "utf8");
    const r = run();
    expect(r.code).toBe(2);
    expect(r.out).toContain(`"limit" is 500 but this gate enforces ${LIMIT}`);
  });

  it("MALFORMED throws rather than silently becoming empty", () => {
    // Empty would fail every grandfathered file at once and send someone to
    // rewrite a baseline that was fine. Loud is the honest failure here.
    write("mono.ts", 1500);
    writeFileSync(baselineFile, "{ not json", "utf8");
    const r = run();
    expect(r.code).toBe(2);
    expect(r.out).toContain(`${baselineFile}: not valid JSON`);
    expect(r.out).not.toContain("crossed");
    writeFileSync(baselineFile, JSON.stringify({ files: [{ path: "mono.ts" }] }), "utf8");
    const r2 = run();
    expect(r2.code).toBe(2);
    expect(r2.out).toContain(`${baselineFile}: every entry needs`);
    expect(r2.out).toContain('integer "lines"');
  });
});

describe("comfyui-mcp-4x5 the real repo", () => {
  it("the checked-in baseline matches the checked-in source", () => {
    // Run against the actual defaults rather than a fixture: this is what CI
    // runs, and it is the assertion that catches a baseline someone forgot to
    // rewrite after a split, or a file that grew in a PR that did not notice.
    const r = spawn();
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("none grew, nothing new crossed");
  });

  it("every checked-in entry is over the limit and ordered by path", () => {
    const doc = JSON.parse(readFileSync(join(SCRIPTS_DIR, "file-size-baseline.json"), "utf8")) as {
      limit: number;
      files: Array<{ path: string; lines: number }>;
    };
    expect(doc.limit).toBe(LIMIT);
    const paths = doc.files.map((f) => f.path);
    expect(paths).toEqual([...paths].sort());
    for (const f of doc.files) expect(f.lines, f.path).toBeGreaterThan(LIMIT);
  });
});
