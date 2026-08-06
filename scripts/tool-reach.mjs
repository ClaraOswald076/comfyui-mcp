#!/usr/bin/env node
/**
 * Tool-reach benchmark — entry point.
 *
 * Answers one question: does folding 154 flat tools into 33
 * action-parameterized ones make models reach for the RIGHT tool more often, or
 * less often? A score on the new surface alone cannot answer that, so the same
 * 100 requests run against three surfaces:
 *
 *   baseline      154 flat tools   pinned at d9e8971 (the last commit before
 *                                  slice 8; the old surface is already gone
 *                                  from main and this is the only way the
 *                                  "before" number stays reproducible)
 *   compact         3 meta-tools   today's default registration
 *   consolidated   33 action tools main, once the slices land
 *
 *   node scripts/tool-reach.mjs --arm baseline
 *   node scripts/tool-reach.mjs --arm compact --models claude/sonnet,ollama/qwen3:4b
 *   node scripts/tool-reach.mjs --arm consolidated --ref origin/main
 *   node scripts/tool-reach.mjs --report            # re-render from saved runs
 *   node scripts/tool-reach.mjs --selfcheck         # request set + fold map only
 *
 * An arm is a (git ref, registration mode) pair, so re-running the
 * `consolidated` arm once the slices finish is one command with a different
 * --ref, not an edit. Running a ref other than the current checkout is handled
 * by preparing a throwaway worktree under .claude/worktrees/ — the benchmark
 * files are copied in, because they do not exist at an old ref.
 *
 * NOTHING THE MODEL PICKS IS EXECUTED — see the header of
 * scripts/tool-reach-bench.mts for why that is load-bearing rather than
 * convenient.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { REQUESTS, checkRequestSet, referencedCapabilities } from "./tool-reach-requests.mjs";
import { missingCoverage, surfaceDigest } from "./tool-reach-merge.mjs";
import { FINAL_SURFACE, FOLD_MAP, resolveExpectation } from "./tool-reach-foldmap.mjs";
import {
  REACH_WINDOW,
  confusion,
  renderComparison,
  renderConfusion,
  scoreEpisode,
  summarize,
} from "./tool-reach-score.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const OUT_DIR = process.env.REACH_OUT ?? join(ROOT, "bench-results");

/**
 * Files the runner needs inside whichever worktree an arm resolves to.
 *
 * DISCOVERED, not listed. A hand-maintained list went stale the moment the
 * interception policy and the merge logic were split into their own modules:
 * the in-place arms kept working and only the `baseline` arm — the one that runs
 * in a worktree at an old ref — died on ERR_MODULE_NOT_FOUND, so the omission
 * surfaced as "one arm is broken" rather than "a file is missing".
 */
const BENCH_FILES = readdirSync(HERE).filter(
  (f) => f.startsWith("tool-reach") && (f.endsWith(".mjs") || f.endsWith(".mts")),
);

const ARMS = {
  baseline: { ref: "d9e8971", mode: "full", blurb: "154 flat tools (pre-slice-8)" },
  compact: { ref: "HEAD", mode: "compact", blurb: "3 meta-tools (today's default)" },
  consolidated: { ref: "HEAD", mode: "full", blurb: "action-parameterized surface" },
};

const DEFAULT_MODELS = [
  "claude/sonnet",
  "moonshot/kimi-k2-0905-preview",
  "ollama/qwen3:4b",
  "ollama/qwen3:8b",
  "ollama/gemma4:e4b",
  "ollama/llama3.1:8b",
].join(",");

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  if (i < 0) return d;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith("--")) {
    console.error(`--${n} needs a value`);
    process.exit(2);
  }
  return v;
};

const git = (...args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();

// ───────────────────────────────────────────────── self-check
/**
 * The gate that keeps the benchmark honest about ITSELF: the request set must
 * not leak its own answers, the fold map must reconcile with the shipped
 * ledger, and every capability a request names must be foldable. Run before
 * every arm, because a leaky request or a stale fold entry does not fail
 * loudly — it just produces a number that means nothing.
 */
function selfcheck() {
  const problems = [];
  const { errors, notes } = checkRequestSet((cap) =>
    FOLD_MAP[cap] ?? { tool: cap, action: null },
  );
  problems.push(...errors);

  const caps = referencedCapabilities();
  for (const cap of caps) {
    if (!FOLD_MAP[cap] && !FINAL_SURFACE.includes(cap)) {
      problems.push(`capability "${cap}" is in neither FOLD_MAP nor the final surface`);
    }
  }
  if (FINAL_SURFACE.length !== 33) {
    problems.push(`final surface should be 33 names, fold map yields ${FINAL_SURFACE.length}`);
  }
  if (Object.keys(FOLD_MAP).length !== 146) {
    problems.push(`fold map should cover 146 retired names, has ${Object.keys(FOLD_MAP).length}`);
  }

  console.log(`[selfcheck] ${REQUESTS.length} requests, ${caps.length} distinct capabilities`);
  for (const n of notes) console.log(`[selfcheck] note: ${n}`);
  for (const p of problems) console.error(`[selfcheck] FAIL: ${p}`);
  if (problems.length) process.exit(1);
  console.log("[selfcheck] OK — no answer leakage, fold map reconciles");
}

// ───────────────────────────────────────────────── worktree prep
function junctionNodeModules(dir) {
  const target = join(ROOT, "node_modules");
  const link = join(dir, "node_modules");
  if (existsSync(link)) return;
  if (process.platform === "win32") {
    // A junction, not a symlink: symlinks need developer mode or elevation on
    // Windows, junctions do not, and node resolves through both.
    spawnSync("cmd", ["/c", "mklink", "/J", link, target], { stdio: "ignore" });
  } else {
    spawnSync("ln", ["-s", target, link], { stdio: "ignore" });
  }
  if (!existsSync(link)) {
    throw new Error(
      `could not link node_modules into ${dir}. Run \`npm ci\` there, or re-run with --ref HEAD.`,
    );
  }
}

/**
 * Where should this arm run? If the ref is the current checkout, right here.
 * Otherwise a detached worktree at that ref, with the benchmark files copied
 * in — they do not exist at an old ref, and that is the point: the SURFACE
 * comes from the ref, the HARNESS comes from this branch, so the two arms are
 * measured by identical code.
 */
function prepareWorktree(ref) {
  const sha = git("rev-parse", ref);
  if (sha === git("rev-parse", "HEAD")) return { dir: ROOT, sha };
  // Anchor on the MAIN checkout, not on ROOT: this file usually runs from a
  // worktree already, and joining onto ROOT would nest arm worktrees inside the
  // benchmark's own — a second copy of the repo per arm, invisible in
  // `git worktree list` until it is 49MB too late.
  const mainRepo = resolve(git("rev-parse", "--path-format=absolute", "--git-common-dir"), "..");
  const dir = join(mainRepo, ".claude", "worktrees", `reach-${sha.slice(0, 7)}`);
  if (!existsSync(dir)) {
    console.log(`[reach] preparing worktree for ${ref} (${sha.slice(0, 7)})`);
    execFileSync("git", ["worktree", "add", "--detach", dir, sha], { cwd: ROOT, stdio: "inherit" });
  }
  junctionNodeModules(dir);
  for (const f of BENCH_FILES) copyFileSync(join(HERE, f), join(dir, "scripts", f));
  return { dir, sha };
}

// ───────────────────────────────────────────────── run one arm
function runArm(armName) {
  const arm = ARMS[armName];
  if (!arm) {
    console.error(`unknown arm "${armName}". Known: ${Object.keys(ARMS).join(", ")}`);
    process.exit(2);
  }
  const ref = opt("ref", arm.ref);
  const models = opt("models", DEFAULT_MODELS);
  const { dir, sha } = prepareWorktree(ref);
  mkdirSync(OUT_DIR, { recursive: true });
  const out = join(OUT_DIR, `run-${armName}.json`);

  // `node --import tsx <script>` rather than `npx tsx …`: npx is a shell shim on
  // Windows, and spawning it needs `shell: true`, which concatenates argv
  // instead of escaping it. Every argument here is ours, but a model-authored
  // request id or ref would not be, and the shape should not invite that.
  const args = [
    "--import",
    "tsx",
    join("scripts", "tool-reach-bench.mts"),
    "--mode", arm.mode,
    "--arm", armName,
    "--ref", sha,
    "--models", models,
    "--out", out,
  ];
  for (const passthrough of ["limit", "only", "max-rounds", "episode-timeout-ms"]) {
    const v = opt(passthrough, null);
    if (v !== null) args.push(`--${passthrough}`, v);
  }

  const res = spawnSync(process.execPath, args, {
    cwd: dir,
    stdio: "inherit",
    env: {
      ...process.env,
      // Keep the surface deterministic and side-effect free: no autoloaded user
      // workflows joining the catalog, no port probe at config import, no panel
      // install, no self-update.
      COMFYUI_WORKFLOWS_DIR: join(OUT_DIR, "empty-workflows"),
      COMFYUI_URL: process.env.COMFYUI_URL ?? "http://127.0.0.1:8188",
      COMFYUI_MCP_PANEL_AUTOINSTALL: "0",
      COMFYUI_MCP_AUTOUPDATE: "0",
      LOG_LEVEL: "error",
    },
  });
  if (res.status !== 0) {
    console.error(`[reach] arm ${armName} exited ${res.status}`);
    process.exit(res.status ?? 1);
  }
  return out;
}

// ───────────────────────────────────────────────── report
function report() {
  if (!existsSync(OUT_DIR)) {
    console.error(`no results in ${OUT_DIR} — run an arm first`);
    process.exit(1);
  }
  // Also one level down: the GPU-bound local field and the network-bound hosted
  // models want separate REACH_OUT directories so they can run concurrently
  // without racing each other's result file. The report merges them.
  const runPaths = [];
  for (const entry of readdirSync(OUT_DIR, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.startsWith("run-") && entry.name.endsWith(".json")) {
      runPaths.push(join(OUT_DIR, entry.name));
    } else if (entry.isDirectory()) {
      for (const sub of readdirSync(join(OUT_DIR, entry.name), { withFileTypes: true })) {
        if (sub.isFile() && sub.name.startsWith("run-") && sub.name.endsWith(".json")) {
          runPaths.push(join(OUT_DIR, entry.name, sub.name));
        }
      }
    }
  }
  const runs = runPaths.map((p) => JSON.parse(readFileSync(p, "utf8")));
  if (!runs.length) {
    console.error(`no run-*.json in ${OUT_DIR}`);
    process.exit(1);
  }

  const byId = new Map(REQUESTS.map((r) => [r.id, r]));
  const entries = [];
  const allScored = [];
  for (const run of runs) {
    const surface = new Set(run.catalogNames);
    for (const model of run.modelsRun) {
      const scored = run.episodes
        .filter((e) => e.model === model)
        .map((e) => ({ ...scoreEpisode(byId.get(e.requestId), e, surface), model, arm: run.arm }));
      if (!scored.length) continue;
      allScored.push(...scored);
      entries.push({
        arm: run.arm,
        ref: run.ref,
        surface: surfaceDigest(run),
        mode: run.mode,
        surfaceSize: run.mode === "compact" ? `3 (+${run.catalogNames.length})` : run.advertisedCount,
        model,
        summary: summarize(scored),
        scored,
      });
    }
  }

  const armOrder = { baseline: 0, compact: 1, consolidated: 2 };
  entries.sort(
    (a, b) => (armOrder[a.arm] ?? 9) - (armOrder[b.arm] ?? 9) || a.model.localeCompare(b.model),
  );

  const md = [];
  md.push("# Tool-reach benchmark — 0.50.0 consolidation");
  md.push("");
  md.push(
    `${REQUESTS.length} user-phrased requests × ${new Set(entries.map((e) => e.arm)).size} tool surfaces. ` +
      "Tool CHOICE is scored; nothing the model picks is executed. " +
      `First-reach = the first substantive call; reach-within-${REACH_WINDOW} allows ${REACH_WINDOW}. ` +
      "Navigation (`list_tools`/`describe_tool`) is counted separately and is never a reach.",
  );
  md.push("");
  md.push("## Arms");
  md.push("");
  md.push("| Arm | Ref | Mode | Tools advertised | Schema bytes | Models run |");
  md.push("|---|---|---|---|---|---|");
  // One row per (arm, ref, mode). Two result files for the same arm are two
  // halves of one field, not two arms.
  // Grouped on the SURFACE, not on the git ref. A harness commit moves HEAD
  // without changing a single tool the model sees, and grouping on the ref
  // rendered one arm as two, with near-identical numbers side by side and
  // nothing to say they were the same measurement.
  const armGroups = new Map();
  for (const run of runs) {
    const key = `${run.arm}|${run.mode}|${surfaceDigest(run)}`;
    if (!armGroups.has(key)) armGroups.set(key, { ...run, modelsRun: [], refs: [] });
    armGroups.get(key).modelsRun.push(...run.modelsRun);
    armGroups.get(key).refs.push(String(run.ref).slice(0, 7));
  }
  for (const run of armGroups.values()) {
    md.push(
      `| \`${run.arm}\` | \`${[...new Set(run.refs)].join(", ")}\` | ${run.mode} | ` +
        `${run.mode === "compact" ? `3 meta (+${run.catalogNames.length} catalog)` : run.advertisedCount} | ` +
        `${(run.surfaceBytes / 1024).toFixed(0)} KB | ${[...new Set(run.modelsRun)].join(", ") || "—"} |`,
    );
  }
  const ranSomewhere = new Set(runs.flatMap((r) => r.modelsRun));
  const skips = runs
    .flatMap((r) => (r.modelsSkipped ?? []).map((s) => ({ arm: r.arm, ...s })))
    .filter((s) => !ranSomewhere.has(s.model));
  if (skips.length) {
    md.push("");
    md.push("**Models that did NOT run** (a silently-skipped field is a misleading table):");
    md.push("");
    for (const s of skips) md.push(`- \`${s.model}\` on \`${s.arm}\` — ${s.reason}`);
  }

  // A partial arm is not wrong; publishing it as though it were complete is. A
  // `--only` or `--limit` re-run leaves a model covering a handful of requests,
  // and its percentage then sits in the same table as a 100-request one with
  // nothing to say so.
  const gaps = [];
  for (const run of runs) {
    for (const [model, missing] of missingCoverage(run.episodes, REQUESTS.map((r) => r.id))) {
      gaps.push({ arm: run.arm, model, missing });
    }
  }
  if (gaps.length) {
    md.push("");
    md.push("**INCOMPLETE COVERAGE** — these rows did not run the full request set:");
    md.push("");
    for (const g of gaps) {
      md.push(
        `- \`${g.model}\` on \`${g.arm}\`: ${REQUESTS.length - g.missing.length}/${REQUESTS.length} requests` +
          ` (missing ${g.missing.slice(0, 6).join(", ")}${g.missing.length > 6 ? `, +${g.missing.length - 6} more` : ""})`,
      );
    }
  }

  md.push("");
  md.push("## Results");
  md.push("");
  md.push(renderComparison(entries));
  md.push("");
  md.push(
    "_tool+action is the headline. tool-only is shown separately because on an action-parameterized " +
      "surface, matching the tool name alone scores a wrong action as a hit — and it does so " +
      "asymmetrically, since the flat arms have no action to get wrong._",
  );

  md.push("");
  md.push("## By hypothesis (first-reach, tool+action)");
  md.push("");
  const hyps = [...new Set(entries.flatMap((e) => Object.keys(e.summary.byHypothesis)))].sort();
  if (hyps.length) {
    md.push(`| Arm | Model | ${hyps.join(" | ")} |`);
    md.push(`|${["---", "---", ...hyps.map(() => "---")].join("|")}|`);
    for (const e of entries) {
      md.push(
        `| \`${e.arm}\` | \`${e.model}\` | ` +
          hyps
            .map((h) => {
              const v = e.summary.byHypothesis[h];
              return v ? `${v.hits}/${v.n}` : "—";
            })
            .join(" | ") +
          " |",
      );
    }
  }

  md.push("");
  md.push("## By tier (first-reach, tool+action)");
  md.push("");
  const tiers = [...new Set(entries.flatMap((e) => Object.keys(e.summary.byTier)))].sort();
  md.push(`| Arm | Model | ${tiers.join(" | ")} |`);
  md.push(`|${["---", "---", ...tiers.map(() => "---")].join("|")}|`);
  for (const e of entries) {
    md.push(
      `| \`${e.arm}\` | \`${e.model}\` | ` +
        tiers
          .map((t) => {
            const v = e.summary.byTier[t];
            return v ? `${v.exactPct.toFixed(0)}% (${v.n})` : "—";
          })
          .join(" | ") +
        " |",
    );
  }

  md.push("");
  md.push("## Wrong-tool confusion matrix");
  md.push("");
  md.push(
    "What it reached for INSTEAD — the most actionable output here, because it names which tool is " +
      "stealing which request.",
  );
  for (const arm of [...new Set(entries.map((e) => e.arm))]) {
    const rows = confusion(allScored.filter((s) => s.arm === arm));
    md.push("");
    md.push(`### \`${arm}\``);
    md.push("");
    md.push(rows.length ? renderConfusion(rows, 30) : "_no misses_");
  }

  const mdPath = join(OUT_DIR, "tool-reach-report.md");
  writeFileSync(mdPath, `${md.join("\n")}\n`);
  writeFileSync(
    join(OUT_DIR, "tool-reach-summary.json"),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        requestCount: REQUESTS.length,
        reachWindow: REACH_WINDOW,
        arms: runs.map((r) => ({
          arm: r.arm,
          ref: r.ref,
          mode: r.mode,
          advertised: r.advertisedCount,
          modelsRun: r.modelsRun,
          modelsSkipped: r.modelsSkipped,
        })),
        entries: entries.map((e) => ({
          arm: e.arm,
          model: e.model,
          summary: e.summary,
        })),
        confusion: Object.fromEntries(
          [...new Set(entries.map((e) => e.arm))].map((arm) => [
            arm,
            confusion(allScored.filter((s) => s.arm === arm)),
          ]),
        ),
      },
      null,
      2,
    ),
  );
  console.log(md.join("\n"));
  console.log(`\n[reach] report: ${mdPath}`);
}

// ───────────────────────────────────────────────── main
selfcheck();
if (flag("selfcheck")) process.exit(0);
if (flag("report")) {
  report();
} else {
  const arms = (opt("arm", "") || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!arms.length) {
    console.error(
      "usage: node scripts/tool-reach.mjs --arm baseline|compact|consolidated [--ref <git-ref>] " +
        "[--models a,b] [--limit N] [--only id-prefix,…]\n" +
        "       node scripts/tool-reach.mjs --report\n" +
        "       node scripts/tool-reach.mjs --selfcheck",
    );
    process.exit(2);
  }
  for (const a of arms) runArm(a);
  report();
}
