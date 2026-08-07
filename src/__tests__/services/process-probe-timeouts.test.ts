// A SYNCHRONOUS subprocess that hangs blocks the whole event loop — no bridge
// traffic, no agent turns, nothing. That is strictly worse than a hung fetch,
// which at least only wedges its own caller.
//
// The codebase already knows this: port-owner.ts times out its `lsof` and
// `netstat`, and process-control.ts its `tasklist`. But orchestrator/index.ts
// grew its own copies of all four inspections (netstat / lsof / tasklist / ps)
// with no timeout at all, on the startup-and-takeover path — precisely where
// being stuck is indistinguishable from being broken. `lsof` is the known
// offender, stalling on unreachable network mounts.
//
// Those four are fixed. This test exists so the NEXT ad-hoc copy is caught by
// CI rather than by a user whose orchestrator will not start: the functions in
// question are private to a 5,000-line module that no test boots, so a
// source-level gate is the only thing that can hold this line.
//
// DELIBERATELY NOT COVERED: process KILLS (taskkill /T /F, pkill, kill). Not one
// of them carries a timeout anywhere in the codebase, and that is a consistent
// posture rather than an oversight — a kill is fire-and-forget cleanup, and
// there is no useful thing to do if it stalls. Requiring a timeout there would
// be inventing a convention, not enforcing one.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { globSync } from "node:fs";

/** This file lives at src/__tests__/services, so two levels up IS src/. */
const SRC = join(import.meta.dirname, "..", "..");

/** Commands that INSPECT the machine: they answer a question and can block. */
const INSPECTION = ["netstat", "lsof", "tasklist", "wmic", "Get-NetTCPConnection"];

/** Balanced-paren argument text for a call starting at `from`. */
function argsOf(text: string, from: number): string {
  let depth = 0;
  for (let i = from; i < Math.min(text.length, from + 4000); i++) {
    const ch = text[i];
    if (ch === "(") depth++;
    else if (ch === ")") {
      if (depth === 0) return text.slice(from, i);
      depth--;
    }
  }
  return "";
}

function sourceFiles(): string[] {
  return globSync("**/*.ts", { cwd: SRC })
    .filter((p) => !p.includes("__tests__") && !p.endsWith(".test.ts"))
    .map((p) => join(SRC, p));
}

describe("every synchronous process INSPECTION carries a timeout", () => {
  it("finds no unbounded netstat/lsof/tasklist/wmic call", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const text = readFileSync(file, "utf-8");
      for (const m of text.matchAll(/\b(execSync|execFileSync|spawnSync)\(/g)) {
        const args = argsOf(text, m.index! + m[0].length);
        // `ps` is excluded from the name list on purpose: it appears inside far
        // too many identifiers to match on safely. It is covered by the
        // dedicated assertion below.
        if (!INSPECTION.some((cmd) => args.includes(cmd))) continue;
        if (/\btimeout\s*:/.test(args)) continue;
        const line = text.slice(0, m.index!).split("\n").length;
        offenders.push(`${file.slice(SRC.length + 1)}:${line}`);
      }
    }
    expect(offenders, `unbounded process inspection(s):\n  ${offenders.join("\n  ")}`).toEqual([]);
  });

  // The POSIX sibling of the tasklist probe, matched precisely so the loop above
  // does not have to guess at the two-letter name.
  it("finds no unbounded `ps` process-name lookup", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const text = readFileSync(file, "utf-8");
      for (const m of text.matchAll(/\b(execSync|execFileSync|spawnSync)\(\s*["'`]ps["'`]/g)) {
        const args = argsOf(text, text.indexOf("(", m.index!) + 1);
        if (/\btimeout\s*:/.test(args)) continue;
        offenders.push(`${file.slice(SRC.length + 1)}:${text.slice(0, m.index!).split("\n").length}`);
      }
    }
    expect(offenders, `unbounded ps lookup(s):\n  ${offenders.join("\n  ")}`).toEqual([]);
  });

  // The gate is only worth having if it can actually fail — a scanner that
  // matches nothing would pass forever and protect nothing.
  it("actually inspects the files it claims to", () => {
    const files = sourceFiles();
    expect(files.length).toBeGreaterThan(100);
    const withInspection = files.filter((f) => {
      const t = readFileSync(f, "utf-8");
      return INSPECTION.some((cmd) => t.includes(cmd));
    });
    expect(withInspection.length).toBeGreaterThan(0);
  });
});
