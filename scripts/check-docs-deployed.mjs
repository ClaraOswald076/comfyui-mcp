#!/usr/bin/env node
/**
 * Every page in navigation must actually SERVE on the deployed site.
 *
 *   node scripts/check-docs-deployed.mjs                  # all locales
 *   node scripts/check-docs-deployed.mjs ko ja            # just these
 *   node scripts/check-docs-deployed.mjs --base https://…
 *
 * Run it AFTER a deploy. It is deliberately not part of `npm test` — it needs the network and
 * a published site, and a gate that fails on someone's flaky wifi gets ignored.
 *
 * ## Why this exists
 *
 * `docs/ko/panel.mdx` has never served. The file is on main, the nav entry is on main, both
 * landed in the same commit as its four siblings — and those four render while
 * /docs/ko/panel returns the 404 shell. Nothing in the repo could see it: the file is present
 * and structurally valid, so check-docs-links and check-docs-locale both pass it. The failure
 * is in the build, and the only place it is observable is the deployed URL.
 *
 * That is the general shape: a page can be correct in git, correct in navigation, pass every
 * static check, and still not exist for a reader. With 12 locales × 5 pages, one silently
 * missing page is easy to never notice — it was, for the entire Korean pilot.
 *
 * ## Detecting a 404 without trusting the status code
 *
 * Mintlify serves an SPA shell with HTTP 200 for unknown paths, so `%{http_code}` is useless
 * here — every URL "works". The discriminator that does hold: a real page carries a
 * `<title>`, and the 404 shell does not. Verified against three URLs — a real English page, a
 * real localized page, and a deliberately nonsensical path.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DOCS_JSON = path.join(ROOT, 'docs', 'docs.json');
const argv = process.argv.slice(2);
const baseIdx = argv.indexOf('--base');
const BASE = baseIdx >= 0 ? argv[baseIdx + 1] : 'https://comfyui-mcp.artokun.io/docs';
const only = argv.filter((a) => !a.startsWith('--') && a !== BASE);

const cfg = JSON.parse(fs.readFileSync(DOCS_JSON, 'utf8'));
const languages = cfg.navigation?.languages ?? [];

/** Every page slug declared in navigation, per language. */
const pagesFor = (lang) => {
  const out = [];
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node.pages)) {
      for (const p of node.pages) (typeof p === 'string' ? out.push(p) : walk(p));
    }
    if (Array.isArray(node.tabs)) walk(node.tabs);
    if (Array.isArray(node.groups)) walk(node.groups);
  };
  walk(lang.tabs ?? lang.groups ?? []);
  return out;
};

async function serves(url) {
  try {
    const res = await fetch(url, { redirect: 'follow' });
    const body = await res.text();
    // A real page has a <title>. The SPA 404 shell does not — and both are HTTP 200.
    const m = body.match(/<title>([^<]*)<\/title>/i);
    return { ok: Boolean(m && m[1].trim()), title: m?.[1]?.trim() ?? null, bytes: body.length };
  } catch (err) {
    return { ok: false, title: null, bytes: 0, error: String(err.message ?? err) };
  }
}

let checked = 0;
let broken = 0;
for (const lang of languages) {
  const code = lang.language;
  if (only.length && !only.includes(code)) continue;
  for (const page of pagesFor(lang)) {
    const url = `${BASE}/${page}`.replace(/\/index$/, '');
    const r = await serves(url);
    checked++;
    if (!r.ok) {
      broken++;
      console.error(`  ✗ ${url} — no <title>, so the build did not produce this page` +
        (r.error ? ` (${r.error})` : ` (${r.bytes} bytes, the 404 shell)`));
    }
  }
}

console.log(`${checked} navigation page(s) probed on ${BASE} · ${broken} not serving`);
if (broken) {
  console.error(
    `\nThese pages exist in git and in navigation but do not exist for a reader. That is a ` +
      `BUILD failure, not a content one — re-check the deploy log for the named files. Do not ` +
      `"fix" the source: it already passed every static check.`,
  );
  process.exit(1);
}
