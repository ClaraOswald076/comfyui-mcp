// Round-3 mutation harness: the probe's family-match test.
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const PT = "src/orchestrator/panel-tools.ts";

const MUTATIONS = [
  {
    id: "MP1-drop-family-check",
    what: "drop the family comparison — back to the previous head's 'any media body is fine'",
    from: `                } else if (expected && !mime.startsWith(\`\${expected}/\`)) {`,
    to: `                } else if (false) {`,
  },
  {
    id: "MP2-ignore-filename",
    what: "always treat the filename as unclassifiable (expected = null)",
    from: `                const expected = IMAGE_EXTS.has(refExt)`,
    to: `                const expected = false ? "image" : IMAGE_EXTS.has(refExt)`,
  },
  {
    id: "MP3-drop-audio-from-expected",
    what: "stop predicting audio from the filename",
    from: `                    : AUDIO_EXTS.has(refExt)
                      ? "audio"
                      : null;`,
    to: `                    : null;`,
  },
  {
    id: "MP4-non-media-check-off",
    what: "stop reporting a genuinely non-media body (text/html)",
    from: `                if (!isMediaBody) {`,
    to: `                if (false) {`,
  },
  {
    id: "MP5-overbroad-flag-everything",
    what: "flag every probed ref as a mismatch",
    from: `                } else if (expected && !mime.startsWith(\`\${expected}/\`)) {`,
    to: `                } else if (true) {`,
  },
];

const TESTS = [
  "src/__tests__/orchestrator/panel-show-media-audio-viewref.test.ts",
  "src/__tests__/orchestrator/panel-show-media-audio-headless.test.ts",
  "src/__tests__/orchestrator/panel-show-media-audio-ext.test.ts",
  "src/__tests__/orchestrator/panel-show-media-oversized.test.ts",
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
  let out = "", failed = false;
  try {
    out = execSync(`npx vitest run ${TESTS.join(" ")} --reporter=verbose`, {
      stdio: "pipe", encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) { failed = true; out = (e.stdout ?? "") + (e.stderr ?? ""); }
  const names = [...out.matchAll(/^\s*×\s+(.+?)(?:\s+\d+ms)?$/gm)].map((x) => x[1].trim());
  results.push({
    id: m.id, what: m.what, applied: true,
    verdict: failed ? "KILLED" : "SURVIVED  <-- PROBLEM",
    tests: /Tests\s+(.+)$/m.exec(out)?.[1] ?? "(none)",
    sample: [...new Set(names)].map((n) => n.split(" > ").pop()).slice(0, 4),
  });
}
restore();
console.log(JSON.stringify(results, null, 1));
