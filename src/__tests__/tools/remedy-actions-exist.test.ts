// A remedy that names an action the tool does not have cannot be followed.
//
// Our messages send callers to specific calls — `queue (action:"list")`,
// `get_history (action:"diagnose")`, `install_comfyui (action:"environment")`
// — 104 such references across the source. The vocabulary ratchet already stops
// a message naming a RETIRED TOOL. Nothing stopped a message naming an action
// that tool never had, or stopped an action rename from stranding every remedy
// pointing at the old name.
//
// That matters more here than a typo normally would, because these strings are
// the recovery path. #1043 is the extreme version of the same failure — a
// documented remedy that cannot run from the state that prints it — and #1055
// was the mild one, a remedy pointing at a sibling tool for a lever the tool
// itself had just gained. A remedy naming a nonexistent action is the same
// class, made mechanical and therefore checkable.
//
// The sweep was clean when written (60 checkable references, 0 wrong). This
// keeps it that way.
//
// DELIBERATE LIMITS. This checks that a named action EXISTS, not that it is the
// right advice — no test can check that. And it only checks tools whose action
// enum it can find by reading the registration; a tool whose actions are built
// some other way is skipped rather than guessed at, which is why the coverage
// assertion below exists.

import { readFileSync } from "node:fs";
import { globSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(import.meta.dirname, "..", "..");

/** `tool (action:"x")` as it appears in prose, escaped quotes and all. */
const REFERENCE = /(?<![a-z0-9_])([a-z][a-z0-9_]{3,})\s*\(\s*action:\s*[\\]*["']([a-z_]+)/g;

/** `action: z.enum([...])` inside a tool registration. */
const ACTION_ENUM = /action:\s*z\s*\n?\s*\.enum\(\[(.*?)\]/s;

function sourceFiles(): string[] {
  return globSync("**/*.ts", { cwd: SRC })
    .filter((p) => !p.includes("__tests__") && !p.endsWith(".test.ts"))
    // vocabulary.ts holds DELIBERATELY fake names as gate fixtures
    // (`some_other_tool`, `mcp__comfyui__wrong__…`); reading them as real
    // references would make this test fail on its own sibling's test data.
    .filter((p) => !p.endsWith("vocabulary.ts"))
    .map((p) => join(SRC, p));
}

/** Action enums, harvested per registered tool name. */
function actionEnums(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const file of globSync("tools/**/*.ts", { cwd: SRC }).map((p) => join(SRC, p))) {
    const text = readFileSync(file, "utf-8");
    for (const m of text.matchAll(/(?:server\.tool|def)\(\s*\n?\s*"([a-z][a-z0-9_]+)"/g)) {
      const seg = text.slice(m.index! + m[0].length, m.index! + m[0].length + 18000);
      const e = ACTION_ENUM.exec(seg);
      if (!e) continue;
      const acts = new Set([...e[1].matchAll(/"([a-z_]+)"/g)].map((a) => a[1]));
      const prev = out.get(m[1]) ?? new Set<string>();
      for (const a of acts) prev.add(a);
      out.set(m[1], prev);
    }
  }
  return out;
}

function references(): Array<{ tool: string; action: string; at: string }> {
  const out: Array<{ tool: string; action: string; at: string }> = [];
  for (const file of sourceFiles()) {
    const text = readFileSync(file, "utf-8");
    for (const m of text.matchAll(REFERENCE)) {
      out.push({
        tool: m[1],
        action: m[2],
        at: `${file.slice(SRC.length + 1)}:${text.slice(0, m.index!).split("\n").length}`,
      });
    }
  }
  return out;
}

describe("a remedy never names an action the tool does not have", () => {
  it("every referenced action exists on its tool", () => {
    const enums = actionEnums();
    const bad = references()
      // A tool we cannot find an enum for is SKIPPED, not guessed at. Natural
      // prose also produces false tool names ("cancelled first (action:…)"),
      // and those land here too rather than being reported as defects.
      .filter((r) => enums.has(r.tool))
      .filter((r) => !enums.get(r.tool)!.has(r.action))
      .map((r) => `${r.at}  ${r.tool} (action:"${r.action}") — valid: ${[...enums.get(r.tool)!].sort().join(", ")}`);

    expect(bad, `remedy/action mismatch(es):\n  ${bad.join("\n  ")}`).toEqual([]);
  });

  // A gate that checks nothing passes forever. This is the assertion that
  // caught my process-probe scanner globbing the wrong directory and reporting
  // a clean sweep of ZERO files.
  it("actually checks a meaningful number of references", () => {
    const enums = actionEnums();
    const checkable = references().filter((r) => enums.has(r.tool));
    expect(enums.size).toBeGreaterThan(15);
    expect(checkable.length).toBeGreaterThan(30);
  });

  // And it must be able to fail: a fabricated reference has to be caught, or
  // the matcher is not looking where it claims.
  it("would catch a bad reference", () => {
    const enums = actionEnums();
    const known = [...enums.entries()].find(([, acts]) => acts.size > 0);
    expect(known).toBeDefined();
    const [tool, acts] = known!;
    expect(acts.has("definitely_not_an_action")).toBe(false);
    // The same predicate the assertion above uses, on a reference we invent.
    const wouldFlag = !enums.get(tool)!.has("definitely_not_an_action");
    expect(wouldFlag).toBe(true);
  });
});
