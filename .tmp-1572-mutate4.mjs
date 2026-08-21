// Round-4 mutation harness: every part of the round-2/3 corrections, plus the
// two mutations that survived round 3 (one of which was a BAD mutation —
// semantically inert — and is redone properly here).
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const PT = "src/orchestrator/panel-tools.ts";

const M = [
  {
    id: "MP1-drop-family-check",
    what: "probe: drop the family comparison (back to 'any media body is fine')",
    from: `          } else if (expected && !mime.startsWith(\`\${expected}/\`)) {`,
    to: `          } else if (false) {`,
  },
  {
    id: "MP2-expected-always-null",
    what: "probe: never predict a family from the filename (REDONE — round 3's version was semantically inert)",
    from: `                const expected = IMAGE_EXTS.has(refExt)
                  ? "image"
                  : VIDEO_EXTS.has(refExt)
                    ? "video"
                    : AUDIO_EXTS.has(refExt)
                      ? "audio"
                      : null;`,
    to: `                const expected = null as "image" | "video" | "audio" | null;`,
  },
  {
    id: "MP3-drop-audio-from-expected",
    what: "probe: stop predicting audio from the filename",
    from: `                    : AUDIO_EXTS.has(refExt)
                      ? "audio"
                      : null;`,
    to: `                    : null;`,
  },
  {
    id: "MP4-non-media-check-off",
    what: "probe: stop reporting a genuinely non-media body",
    from: `                if (!isMediaBody) {`,
    to: `                if (false) {`,
  },
  {
    id: "MH-record-path-off",
    what: "headless: stop recording {path} audio, so the verdict never sees it",
    from: `              audioTargets.push({ what: p, via: "path" });`,
    to: ``,
  },
  {
    id: "MH-record-ref-off",
    what: "headless: stop recording /view-ref audio",
    from: `            if (AUDIO_EXTS.has(refExt)) {
              audioTargets.push({ what: src.filename, via: "ref" });
            }`,
    to: ``,
  },
  {
    id: "MH-verdict-off",
    what: "headless: delete the verdict entirely",
    from: `          if (headlessNow && reachableNow) {
            return fail(headlessAudioRefusal(audioTargets));
          }`,
    to: ``,
  },
  {
    id: "MH-drop-reachability",
    what: "headless: refuse on stickiness alone — the FALSE REFUSAL the gate reported",
    from: `          if (headlessNow && reachableNow) {`,
    to: `          if (headlessNow) {`,
  },
  {
    id: "MH-drop-headless",
    what: "headless: refuse on reachability alone (would refuse the browser panel)",
    from: `          if (headlessNow && reachableNow) {`,
    to: `          if (reachableNow) {`,
  },
  {
    id: "MH-canReach-default-false",
    what: "headless: treat a bridge with no canReach as unreachable",
    from: `          const reachableNow = typeof b?.canReach === "function" ? b.canReach(ctx.tabId) : true;`,
    to: `          const reachableNow = typeof b?.canReach === "function" ? b.canReach(ctx.tabId) : false;`,
  },
];

const TESTS = [
  "src/__tests__/orchestrator/panel-show-media-audio-viewref.test.ts",
  "src/__tests__/orchestrator/panel-show-media-audio-headless.test.ts",
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
  if (!src.includes(m.from)) {
    out.push({ id: m.id, verdict: "NOT-APPLIED (anchor not found)" });
    continue;
  }
  const mutated = src.replace(m.from, m.to);
  if (mutated === src) {
    out.push({ id: m.id, verdict: "NOT-APPLIED (no change)" });
    continue;
  }
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
