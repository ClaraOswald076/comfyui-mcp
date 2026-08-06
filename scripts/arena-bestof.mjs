#!/usr/bin/env node
// Fold extra arena run dirs into the main results as BEST-OF-N per model.
//
//   node scripts/arena-bestof.mjs arena-results arena-results/bo3-run2 arena-results/bo3-run3
//
// For every model present in an extra dir, the better run (score, then fewer
// nudges → rounds → seconds) replaces the main entry, and runs.totals records
// every observed total so reports can show the range (e.g. "best of 3, 19–20").
// Regenerates arena-report.md afterward.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildArenaReport, mergeRunAxes } from "./arena-report.mjs";

const [baseDir, ...runDirs] = process.argv.slice(2);
if (!baseDir) {
  console.error("usage: arena-bestof.mjs <base-results-dir> [extra-run-dir...]  (no dirs = re-sort + rebuild only)");
  process.exit(1);
}

const nudgesOf = (m) => m.results.reduce((s, r) => s + (r.nudges ?? 0), 0);
const roundsOf = (m) => m.results.reduce((s, r) => s + (r.rounds ?? 0), 0);
const secondsOf = (m) => m.results.reduce((s, r) => s + (r.seconds ?? 0), 0);
const better = (a, b) =>
  b.total - a.total || nudgesOf(a) - nudgesOf(b) || roundsOf(a) - roundsOf(b) || secondsOf(a) - secondsOf(b);

const basePath = join(baseDir, "arena-results.json");
const base = JSON.parse(readFileSync(basePath, "utf8"));

for (const dir of runDirs) {
  const p = join(dir, "arena-results.json");
  if (!existsSync(p)) {
    console.warn(`skip ${p} (missing)`);
    continue;
  }
  const extra = JSON.parse(readFileSync(p, "utf8"));
  for (const candidate of extra.leaderboard ?? []) {
    const i = base.leaderboard.findIndex((m) => m.model === candidate.model);
    if (i < 0) continue;
    const current = base.leaderboard[i];
    // #792 — never best-of-merge runs recorded by DIFFERENT comfyui-mcp
    // versions: absolute scores move with the tool surface, so a best-of range
    // spanning versions would read as comparable numbers. The known versions
    // accumulate on the entry (mcpVersions), on BOTH sides — a candidate that
    // is itself an unversioned merged range still carries its mcpVersions, and
    // the union must hold at most ONE known version for the merge to be honest.
    const knownVersions = [
      ...new Set([
        ...(current.mcpVersions ?? (current.mcpVersion ? [current.mcpVersion] : [])),
        ...(candidate.mcpVersions ?? (candidate.mcpVersion ? [candidate.mcpVersion] : [])),
      ]),
    ];
    if (knownVersions.length > 1) {
      console.warn(
        `skip ${candidate.model} from ${dir}: the merge would mix comfyui-mcp ${knownVersions.map((v) => `v${v}`).join(" + ")} — scores across versions are not directly comparable`,
      );
      continue;
    }
    // …and never merge two DIFFERENT quantizations of the same tag. `ollama
    // pull` replaces the weights under the same name, so `gemma4:e4b` at Q4_K_M
    // and at Q8_0 are two different models wearing one id — a best-of range
    // across them is the same "scores from two conditions read as one" error the
    // version guard above refuses, and the Quant column would name only one of
    // them. Unknown on either side is NOT a mismatch (see mergeRunAxes: it comes
    // out as `mixed` rather than a claim).
    if (current.quant && candidate.quant && current.quant !== candidate.quant) {
      console.warn(
        `skip ${candidate.model} from ${dir}: the merge would mix quantizations ${current.quant} + ${candidate.quant} — those are different models under one tag`,
      );
      continue;
    }
    const totals = [...(current.runs?.totals ?? [current.total]), candidate.total];
    const winner = better(current, candidate) > 0 ? candidate : current;
    // If either side predates version stamping, the merged range mixes a
    // stamped and an unstamped run — the entry must NOT keep claiming the
    // version (the report flags unversioned entries as not comparable).
    const mergedVersion = current.mcpVersion && candidate.mcpVersion ? winner.mcpVersion : undefined;
    // The condition axes belong to a RUN, not to the winner: keeping the
    // winner's Params/Quant/VRAM would state that the whole best-of range was
    // recorded under that one condition. mergeRunAxes keeps only what both runs
    // agree on and marks the rest `mixed`.
    base.leaderboard[i] = {
      ...winner,
      tier: current.tier,
      runs: { totals },
      mcpVersion: mergedVersion,
      mcpVersions: knownVersions,
      params: undefined,
      quant: undefined,
      vramResidentBytes: undefined,
      vramResidentBytesRange: undefined,
      mixedAxes: undefined,
      ...mergeRunAxes(current, candidate),
    };
    console.log(`${candidate.model}: run=${candidate.total} → keeping ${winner.total} (all: ${totals.join(", ")})`);
  }
}

// Rank: best total, then CONSISTENCY (worst run across best-of-N — a model
// that is perfect every time outranks one that peaked once), then efficiency.
const worstRun = (m) => Math.min(...(m.runs?.totals ?? [m.total]));
base.leaderboard.sort(
  (a, b) =>
    b.total - a.total ||
    worstRun(b) - worstRun(a) ||
    nudgesOf(a) - nudgesOf(b) ||
    roundsOf(a) - roundsOf(b) ||
    secondsOf(a) - secondsOf(b),
);
writeFileSync(basePath, JSON.stringify(base, null, 2));

// rebuild the share-ready markdown from the SHARED builder (#792) — the
// report shape (Quant/VRAM columns, version note, suspect scenarios) lives in
// arena-report.mjs so this file and llm-arena.mjs can never drift apart again.
writeFileSync(join(baseDir, "arena-report.md"), buildArenaReport(base));
console.log("report regenerated");
