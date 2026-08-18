#!/usr/bin/env node
/**
 * Reject MDX that will not build.
 *
 *   node scripts/check-docs-mdx.mjs
 *
 * Measured: `<pod>` in prose is parsed as a JSX component named `pod`. Mintlify
 * then omits THAT page (404 shell) and still publishes the rest of the site.
 * Every locale `docs/<lang>/panel.mdx` and `docs/changelog/2026-07-21.mdx` 404'd
 * for this; their siblings, and the older English `panel` (which had not yet
 * gained the RunPod sentence), served. Size was the wrong hypothesis.
 *
 * Capitalised MDX components (`<Note>`, `<Warning>`, `<CardGroup>`) are legal.
 * Tags inside fenced or inline code are legal. A lowercase tag in prose is not.
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const DOCS = path.join(ROOT, "docs");

const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!/^(node_modules|images|logo|videos|\.)/.test(e.name)) walk(full);
      continue;
    }
    if (/\.mdx$/.test(e.name)) files.push(full);
  }
})(DOCS);

/** Strip fenced blocks and inline code so we only see prose. */
function prose(src) {
  return src
    .replace(/^```[\s\S]*?^```/gm, "")
    .replace(/`[^`]*`/g, "");
}

const TAG = /<([a-z][a-z0-9-]*)\b/g;
// Real HTML that Mintlify pages already use. Invented names (`pod`, `remote-url`)
// are what 404 a page.
const HTML = new Set([
  "a", "br", "hr", "img", "video", "source", "iframe", "span", "div", "p",
  "em", "strong", "code", "pre", "ul", "ol", "li", "table", "thead", "tbody",
  "tr", "td", "th", "blockquote", "details", "summary", "sup", "sub",
]);
const hits = [];
for (const file of files) {
  const src = fs.readFileSync(file, "utf8");
  const lines = prose(src).split(/\n/);
  lines.forEach((line, i) => {
    TAG.lastIndex = 0;
    let m;
    while ((m = TAG.exec(line))) {
      if (/^https?:$/.test(m[1])) continue;
      if (HTML.has(m[1])) continue;
      hits.push(`${path.relative(DOCS, file)}:${i + 1}  <${m[1]}>`);
    }
  });
}

if (hits.length) {
  console.error(
    `✗ ${hits.length} unescaped lowercase MDX tag(s) in prose — these 404 the page:`,
  );
  for (const h of hits) console.error(`    ${h}`);
  process.exit(1);
}
console.log(`docs mdx OK  (${files.length} file(s))`);
