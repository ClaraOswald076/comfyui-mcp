// Round-2 mutation harness for the headless-audio gate (#1572, review P1).
// Each mutation deletes part of the gate; the named tests must then fail.
// Reports NOT-APPLIED when an anchor does not match — a mutation that never
// applied reads as survived.
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const PT = "src/orchestrator/panel-tools.ts";

const MUTATIONS = [
  {
    id: "MH1-path-callsite",
    what: "delete CALL SITE 1 (the {path} branch's headless refusal) only",
    from: `              if (targetIsHeadless) {
                return fail(headlessAudioRefusal({ what: p, via: "path" }));
              }
`,
    to: ``,
  },
  {
    id: "MH2-ref-callsite",
    what: "delete CALL SITE 2 (the /view-ref branch's headless refusal) only",
    from: `            if (targetIsHeadless && AUDIO_EXTS.has(refExt)) {
              return fail(headlessAudioRefusal({ what: src.filename, via: "ref" }));
            }
`,
    to: ``,
  },
  {
    id: "MH3-gate-off",
    what: "the whole gate off — targetIsHeadless always false (this is PRE-FIX behaviour)",
    from: `        const targetIsHeadless =
          typeof ctx.bridge?.isHeadless === "function" && ctx.bridge.isHeadless(ctx.tabId);`,
    to: `        const targetIsHeadless = false;`,
  },
  {
    id: "MH4-gate-overbroad",
    what: "the gate over-broad — targetIsHeadless always true (refuses audio for the browser panel too)",
    from: `        const targetIsHeadless =
          typeof ctx.bridge?.isHeadless === "function" && ctx.bridge.isHeadless(ctx.tabId);`,
    to: `        const targetIsHeadless = true;`,
  },
  {
    id: "MH5-drop-typeof-guard",
    what: "drop the typeof guard, so a lightweight bridge without isHeadless throws",
    from: `          typeof ctx.bridge?.isHeadless === "function" && ctx.bridge.isHeadless(ctx.tabId);`,
    to: `          ctx.bridge.isHeadless(ctx.tabId);`,
  },
];

const TESTS = [
  "src/__tests__/orchestrator/panel-show-media-audio-headless.test.ts",
  "src/__tests__/orchestrator/panel-show-media-audio-ext.test.ts",
  "src/__tests__/orchestrator/panel-show-media-audio-viewref.test.ts",
  "src/__tests__/orchestrator/panel-show-media-oversized.test.ts",
  "src/__tests__/orchestrator/panel-show-media-video-ext.test.ts",
];

const restore = () => execSync(`git checkout -- ${PT}`, { stdio: "pipe" });
const norm = (s) => s.replace(/\r\n/g, "\n");

const results = [];
for (const m of MUTATIONS) {
  restore();
  const raw = readFileSync(PT, "utf8");
  const crlf = raw.includes("\r\n");
  const src = norm(raw);
  if (!src.includes(m.from)) {
    results.push({ id: m.id, applied: false, verdict: "NOT-APPLIED (anchor not found)" });
    continue;
  }
  const mutated = src.replace(m.from, m.to);
  if (mutated === src) {
    results.push({ id: m.id, applied: false, verdict: "NOT-APPLIED (no change)" });
    continue;
  }
  writeFileSync(PT, crlf ? mutated.replace(/\n/g, "\r\n") : mutated);
  let out = "";
  let failed = false;
  try {
    out = execSync(`npx vitest run ${TESTS.join(" ")} --reporter=verbose`, {
      stdio: "pipe", encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    failed = true;
    out = (e.stdout ?? "") + (e.stderr ?? "");
  }
  const names = [...out.matchAll(/^\s*×\s+(.+?)(?:\s+\d+ms)?$/gm)].map((x) => x[1].trim());
  results.push({
    id: m.id,
    what: m.what,
    applied: true,
    verdict: failed ? "KILLED" : "SURVIVED  <-- PROBLEM",
    tests: /Tests\s+(.+)$/m.exec(out)?.[1] ?? "(none)",
    sample: [...new Set(names)].slice(0, 4),
  });
}
restore();
console.log(JSON.stringify(results, null, 1));
