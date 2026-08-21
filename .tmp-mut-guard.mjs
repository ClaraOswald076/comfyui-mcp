import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
const PT = "src/orchestrator/panel-tools.ts";
const M = [
  {
    id: "G1-guard-off",
    what: "delete the headless regression guard (reinstates the false success)",
    from: `              if (
                typeof ctx.bridge?.isHeadless === "function" &&
                ctx.bridge.isHeadless(ctx.tabId)
              ) {`,
    to: `              if (false) {`,
  },
  {
    id: "G2-drop-typeof",
    what: "drop the typeof guard so a lightweight bridge throws",
    from: `                typeof ctx.bridge?.isHeadless === "function" &&
                ctx.bridge.isHeadless(ctx.tabId)`,
    to: `                ctx.bridge.isHeadless(ctx.tabId)`,
  },
  {
    id: "G3-invert",
    what: "invert the guard so it refuses the BROWSER panel instead",
    from: `                ctx.bridge.isHeadless(ctx.tabId)
              ) {`,
    to: `                !ctx.bridge.isHeadless(ctx.tabId)
              ) {`,
  },
  {
    id: "G4-guard-everything",
    what: "widen the guard past audio (would refuse images/video to a phone)",
    from: `            } else if (AUDIO_EXTS.has(ext)) {
              // REGRESSION GUARD`,
    to: `            } else if (true) {
              // REGRESSION GUARD`,
  },
];
const TESTS = [
  "src/__tests__/orchestrator/panel-show-media-audio-ext.test.ts",
  "src/__tests__/orchestrator/panel-show-media-oversized.test.ts",
  "src/__tests__/orchestrator/panel-show-media-video-ext.test.ts",
  "src/__tests__/services/comfy-view-ref.test.ts",
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
  try { res = execSync(`npx vitest run ${TESTS.join(" ")} --reporter=verbose`, { stdio: "pipe", encoding: "utf8", maxBuffer: 64*1024*1024 }); }
  catch (e) { failed = true; res = (e.stdout ?? "") + (e.stderr ?? ""); }
  const names = [...res.matchAll(/^\s*×\s+(.+?)(?:\s+\d+ms)?$/gm)].map((x) => x[1].trim());
  out.push({ id: m.id, what: m.what, verdict: failed ? "KILLED" : "SURVIVED  <-- PROBLEM",
    tests: /Tests\s+(.+)$/m.exec(res)?.[1] ?? "(none)",
    sample: [...new Set(names)].map((n) => n.split(" > ").pop()).slice(0, 3) });
}
restore();
console.log(JSON.stringify(out, null, 1));
