// Round-6 mutations: the mailbox-aware verdict.
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const PT = "src/orchestrator/panel-tools.ts";
const VR = "src/services/comfy-view-ref.ts";

const M = [
  {
    id: "MB1-unroutable-is-safe",
    f: PT,
    what: "treat an unroutable address as safe again (the round-5 P1 exactly)",
    from: `          if (resolvable) {
            verdictId = routed ?? ctx.tabId;
          } else if (isScopeAddress(ctx.tabId)) {
            mailboxedToUnknown = true;
          } else {
            verdictId = ctx.tabId;
          }`,
    to: `          if (resolvable) {
            verdictId = routed ?? ctx.tabId;
          }`,
  },
  {
    id: "MB2-scope-mailbox-allowed",
    f: PT,
    what: "let an unroutable SCOPE address queue audio for whoever hellos next",
    from: `          } else if (isScopeAddress(ctx.tabId)) {
            mailboxedToUnknown = true;
          } else {`,
    to: `          } else if (false) {
            mailboxedToUnknown = true;
          } else {`,
  },
  {
    id: "MB3-concrete-mailbox-allowed",
    f: PT,
    what: "let an unroutable CONCRETE phone id queue audio for itself",
    from: `          } else {
            verdictId = ctx.tabId;
          }
          const headlessTarget =`,
    to: `          } else {
          }
          const headlessTarget =`,
  },
  {
    id: "MB4-no-heal",
    f: PT,
    what: "skip the production heal, so a healable session is judged before it is rebound",
    from: `          try {
            await ctx.awaitReachable?.(0);
          } catch {`,
    to: `          try {
            void 0;
          } catch {`,
  },
  {
    id: "MB5-merge-the-two-refusals",
    f: VR,
    what: "tell an unknown-recipient caller their session is on a phone",
    from: `  if (opts.mailboxedToUnknown) {`,
    to: `  if (false) {`,
  },
  {
    id: "MB6-verdict-off",
    f: PT,
    what: "delete the verdict entirely",
    from: `          if (headlessTarget || mailboxedToUnknown) {`,
    to: `          if (false) {`,
  },
];

const TESTS = [
  "src/__tests__/orchestrator/panel-show-media-audio-headless.test.ts",
  "src/__tests__/orchestrator/panel-show-media-audio-viewref.test.ts",
  "src/__tests__/orchestrator/panel-show-media-audio-ext.test.ts",
  "src/__tests__/orchestrator/panel-show-media-oversized.test.ts",
  "src/__tests__/orchestrator/panel-show-media-video-ext.test.ts",
];

const restore = () => execSync(`git checkout -- ${PT} ${VR}`, { stdio: "pipe" });
const norm = (s) => s.replace(/\r\n/g, "\n");
const out = [];

for (const m of M) {
  restore();
  const raw = readFileSync(m.f, "utf8");
  const crlf = raw.includes("\r\n");
  const src = norm(raw);
  if (!src.includes(m.from)) { out.push({ id: m.id, verdict: "NOT-APPLIED (anchor)" }); continue; }
  const mutated = src.replace(m.from, m.to);
  if (mutated === src) { out.push({ id: m.id, verdict: "NOT-APPLIED (identity)" }); continue; }
  writeFileSync(m.f, crlf ? mutated.replace(/\n/g, "\r\n") : mutated);
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
