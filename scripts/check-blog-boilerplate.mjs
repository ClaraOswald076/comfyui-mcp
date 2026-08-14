#!/usr/bin/env node
/**
 * The shared install step must say the same thing in every blog post.
 *
 *   node scripts/check-blog-boilerplate.mjs
 *
 * ## Why
 *
 * One sentence — "the panel auto-starts a background agent on your Claude subscription" —
 * was copy-pasted into TEN posts. It was true when it was written. When the panel became a
 * pure-frontend pack that cannot spawn a process, it became false in ten places at the same
 * moment, and nothing noticed: no test covers prose, and each copy looked locally fine.
 *
 * `docs/snippets/panel-install.mdx` is now the single source of truth for that sentence. This
 * gate asserts every post that carries the step matches it exactly, so the copies cannot drift
 * apart again — and so fixing the snippet tells you, by name, which posts still need updating.
 *
 * ## Why not just import the snippet?
 *
 * That is the better end state and the snippet is written to support it: Mintlify renders
 * `/snippets/*.mdx` as importable components. The blocker is that the step lives inside a
 * NUMBERED LIST, and a block-level component inside a list item is exactly the kind of MDX
 * construct that renders differently than it reads. Converting ten live posts to it without a
 * local `mint dev` render check is a bet on the docs site, so the conversion is deliberately
 * left as a follow-up for whoever can preview it. Until then, this gate buys the same
 * anti-drift property at no rendering risk.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const BLOG = path.join(ROOT, 'docs', 'blog');
const SNIPPET = path.join(ROOT, 'docs', 'snippets', 'panel-install.mdx');

const eol = (s) => s.replace(/\r\n/g, '\n');
/** Collapse wrapping so a line-broken copy compares equal to a single-line one. */
const flat = (s) => eol(s).replace(/\s+/g, ' ').trim();

if (!fs.existsSync(SNIPPET)) {
  console.error(`missing ${path.relative(ROOT, SNIPPET)} — it is the source of truth for this step`);
  process.exit(1);
}
const canonical = flat(fs.readFileSync(SNIPPET, 'utf8'));

/**
 * How we find posts carrying the SHARED step.
 *
 * Deliberately the sentence's distinctive tail, not its opening clause. Matching on
 * "Install comfyui-mcp and the Panel" caught two posts (train-lora-runpod,
 * video-extend-pusa-comfyui) that open the same way and then continue with their own
 * instructions — setting RUNPOD_API_KEY, applying a specific pack. Those carry a different
 * step, not a drifted copy of this one, and demanding they match would force unrelated
 * rewrites. The retired-claim check below still applies to every post regardless.
 */
const MARKER = /sign in with `claude` once/;
/** Claims this step must never make again, with why. */
const RETIRED = [
  {
    pattern: /auto-starts a background agent/i,
    why: 'the panel is a pure-frontend pack and cannot spawn the orchestrator; the user runs `connect`',
  },
  {
    pattern: /external\/local orchestrator/i,
    why: 'that setting has no UI row and the mode is unconditionally on',
  },
];

let failures = 0;
let carrying = 0;
for (const file of fs.readdirSync(BLOG).filter((f) => f.endsWith('.mdx'))) {
  const src = fs.readFileSync(path.join(BLOG, file), 'utf8');
  const f = flat(src);

  for (const { pattern, why } of RETIRED) {
    if (pattern.test(f)) {
      failures++;
      console.error(`  ✗ blog/${file}: retired claim "${pattern.source}" — ${why}`);
    }
  }

  if (!MARKER.test(f)) continue;
  carrying++;
  if (!f.includes(canonical)) {
    failures++;
    console.error(
      `  ✗ blog/${file}: the install step has drifted from docs/snippets/panel-install.mdx`,
    );
  }
}

console.log(`${carrying} post(s) carry the shared install step`);
if (failures) {
  console.error(
    `\n${failures} problem(s). Edit docs/snippets/panel-install.mdx, then make every post match ` +
      `it — that file is the source of truth precisely so this sentence cannot be wrong in ten ` +
      `places at once again.`,
  );
  process.exit(1);
}
console.log('blog boilerplate OK');
