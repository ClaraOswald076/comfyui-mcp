#!/usr/bin/env node
/**
 * A blog post may not name a model file its pack does not ship.
 *
 *   node scripts/check-blog-packs.mjs
 *
 * ## Why
 *
 * `wan-2.2-comfyui` told readers the `wan-longer-videos` pack ships **Q4_K_S** GGUFs and fits
 * "under 12 GB". The pack pins **Q8_0**: manifest.yaml downloads the four `-Q8_0.gguf` experts,
 * both installer scripts fetch them, and workflow.json loads them by that exact filename. A
 * reader with a 12 GB card was told the pack fits. It OOMs.
 *
 * The post was right when it was written and the pack moved underneath it. Nothing could notice,
 * because the only copy of "what this pack ships" that a test can read lives in packs/, and the
 * blog restates it in prose.
 *
 * ## What this checks, and why only this
 *
 * Only filenames in MARKDOWN TABLE ROWS and inside FENCED CODE BLOCKS. Those are the two places
 * a post says "here is what you get" — a file table, an installer transcript. Prose is
 * deliberately out of scope, because prose is where the legitimate alternatives live:
 *
 *   "swap the four `Wan2.2-*-Q8_0.gguf` files for the `-Q4_K_S` builds"
 *
 * That sentence names a file the pack does not ship, and it is correct to do so. Gating prose
 * would flag it, the flag would be wrong, and the fix would be to delete true, useful advice. A
 * gate whose failure mode is "make the docs worse" is worse than no gate.
 *
 * Wildcards (`Wan2.2-*-Q8_0.gguf`) are skipped: they name a family, not a file.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const BLOG = path.join(ROOT, 'docs', 'blog');
const PACKS = path.join(ROOT, 'packs');

const MODEL_EXT = /\.(gguf|safetensors|pth|ckpt|pt|onnx)$/i;
const FILENAME = /[A-Za-z0-9][A-Za-z0-9._-]*\.(?:gguf|safetensors|pth|ckpt|pt|onnx)/g;

/** Every pack a post could be talking about, by name -> the text that proves what it ships. */
function loadPacks() {
  const packs = new Map();
  if (!fs.existsSync(PACKS)) return packs;
  for (const dir of fs.readdirSync(PACKS)) {
    const full = path.join(PACKS, dir);
    if (!fs.statSync(full).isDirectory()) continue;
    let blob = '';
    for (const f of fs.readdirSync(full)) {
      // manifest = what gets downloaded; workflow = what gets loaded; install* = the script path.
      if (/^(pack\.yaml|manifest\.yaml|workflow\.json|install-.*)$/.test(f)) {
        blob += fs.readFileSync(path.join(full, f), 'utf8') + '\n';
      }
    }
    packs.set(dir, blob);
  }
  return packs;
}

/**
 * Table rows and fenced code — the "here is what you get" surfaces.
 * Fences are matched indent-tolerantly: a fence indented inside a list item is still a fence,
 * and anchoring to column 0 silently halves what a checker sees.
 */
function claimLines(src) {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let inFence = false;
  let fenceMark = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = line.match(/^\s*(```+|~~~+)/);
    if (fence) {
      if (!inFence) {
        inFence = true;
        fenceMark = fence[1][0];
      } else if (fence[1][0] === fenceMark) {
        inFence = false;
      }
      continue;
    }
    if (inFence) out.push([i + 1, line]);
    else if (/^\s*\|.*\|/.test(line) && !/^\s*\|[\s|:-]*\|?\s*$/.test(line)) out.push([i + 1, line]);
  }
  return out;
}

const packs = loadPacks();
if (!packs.size) {
  console.error('no packs/ directory — cannot verify blog model claims');
  process.exit(1);
}

let failures = 0;
let checked = 0;
for (const file of fs.readdirSync(BLOG).filter((f) => f.endsWith('.mdx'))) {
  const src = fs.readFileSync(path.join(BLOG, file), 'utf8');

  // Which packs does this post document? Only these are consulted, so a post naming a file that
  // some OTHER pack happens to ship is still caught.
  const named = new Set();
  for (const m of src.matchAll(/packs\/([a-z0-9][a-z0-9-]*)/gi)) {
    if (packs.has(m[1])) named.add(m[1]);
  }
  for (const m of src.matchAll(/`([a-z0-9][a-z0-9-]*)`\s+pack/gi)) {
    if (packs.has(m[1])) named.add(m[1]);
  }
  if (!named.size) continue;

  const haystack = [...named].map((n) => packs.get(n)).join('\n');
  const seen = new Set();
  for (const [lineNo, line] of claimLines(src)) {
    for (const raw of line.match(FILENAME) ?? []) {
      if (!MODEL_EXT.test(raw)) continue;
      // A glob names a family, not a file — the post is describing a set, not promising one.
      const ctx = line.slice(Math.max(0, line.indexOf(raw) - 40), line.indexOf(raw) + raw.length);
      if (ctx.includes('*') || ctx.includes('{')) continue;
      const key = `${raw}`;
      if (seen.has(key)) continue;
      seen.add(key);
      checked++;
      if (!haystack.includes(raw)) {
        failures++;
        console.error(
          `  ✗ blog/${file}:${lineNo}: names "${raw}", but no pack it documents ` +
            `(${[...named].join(', ')}) ships that file`,
        );
      }
    }
  }
}

console.log(`checked ${checked} model filename claim(s) against packs/`);
if (failures) {
  console.error(
    `\n${failures} claim(s) do not match the pack. Either the post is stale — check what ` +
      `packs/<name>/manifest.yaml actually downloads — or the filename is a typo. If the post ` +
      `is deliberately naming an ALTERNATIVE file, say so in prose rather than in a table.`,
  );
  process.exit(1);
}
console.log('blog pack claims OK');
