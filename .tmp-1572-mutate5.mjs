// Round-5 mutations: the three-tier routing resolution.
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const PT = "src/orchestrator/panel-tools.ts";

const M = [
  {
    id: "MS1-judge-the-address",
    what: "judge ctx.tabId directly instead of what it resolves to (the round-4 P1)",
    from: `          let judgeId: string | undefined;
          if (typeof b?.liveTabIdFor === "function") {
            judgeId = b.liveTabIdFor(ctx.tabId);
          } else if (typeof b?.canReach === "function") {
            judgeId = b.canReach(ctx.tabId) ? ctx.tabId : undefined;
          } else {
            judgeId = ctx.tabId;
          }`,
    to: `          const judgeId: string | undefined = ctx.tabId;`,
  },
  {
    id: "MS2-drop-liveTabIdFor-tier",
    what: "drop the routing tier, leaving reachability only",
    from: `          if (typeof b?.liveTabIdFor === "function") {
            judgeId = b.liveTabIdFor(ctx.tabId);
          } else if (typeof b?.canReach === "function") {`,
    to: `          if (typeof b?.canReach === "function") {`,
  },
  {
    id: "MS3-drop-canReach-tier",
    what: "drop the reachability tier (lightweight bridges lose the offline-phone allowance)",
    from: `          } else if (typeof b?.canReach === "function") {
            judgeId = b.canReach(ctx.tabId) ? ctx.tabId : undefined;
          } else {`,
    to: `          } else {`,
  },
  {
    id: "MS4-unroutable-refuses",
    what: "treat an unroutable address as headless (refuse when nothing resolves)",
    from: `          if (
            judgeId != null &&
            typeof b?.isHeadless === "function" &&
            b.isHeadless(judgeId)
          ) {`,
    to: `          if (
            typeof b?.isHeadless === "function" &&
            b.isHeadless(judgeId ?? ctx.tabId)
          ) {`,
  },
  {
    id: "MS5-verdict-off",
    what: "delete the verdict entirely",
    from: `            return fail(headlessAudioRefusal(audioTargets));`,
    to: ``,
  },
];

const TESTS = [
  "src/__tests__/orchestrator/panel-show-media-audio-headless.test.ts",
  "src/__tests__/orchestrator/panel-show-media-audio-viewref.test.ts",
  "src/__tests__/orchestrator/panel-show-media-audio-ext.test.ts",
  "src/__tests__/orchestrator/panel-show-media-oversized.test.ts",
  "src/__tests__/orchestrator/panel-show-media-video-ext.test.ts",
];

const restore = () => execSync(`git checkout -- ${PT}`, { stdio: "pipe" });
const norm = (s) => s.replace(/\r\n/g, "\n");
const out = [];

for (const m of M) {
  restore();
  const raw = readFileSync(PT, "utf8");
  const crlf = raw.includes("\r\n");
  const src = norm(raw);
  if (!src.includes(m.from)) { out.push({ id: m.id, verdict: "NOT-APPLIED (anchor)" }); continue; }
  const mutated = src.replace(m.from, m.to);
  if (mutated === src) { out.push({ id: m.id, verdict: "NOT-APPLIED (identity)" }); continue; }
  writeFileSync(PT, crlf ? mutated.replace(/\n/g, "\r\n") : mutated);
  let res = "", failed = false;
  try {
    res = execSync(`npx vitest run ${TESTS.join(" ")} --reporter=verbose`, {
      stdio: "pipe", encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) { failed = true; res = (e.stdout ?? "") + (e.stderr ?? ""); }
  const names = [...res.matchAll(/^\s*×\s+(.+?)(?:\s+\d+ms)?$/gm)].map((x) => x[1].trim());
  out.push({
    id: m.id, what: m.what,
    verdict: failed ? "KILLED" : "SURVIVED  <-- PROBLEM",
    tests: /Tests\s+(.+)$/m.exec(res)?.[1] ?? "(none)",
    sample: [...new Set(names)].map((n) => n.split(" > ").pop()).slice(0, 3),
  });
}
restore();
console.log(JSON.stringify(out, null, 1));
