#!/usr/bin/env node
/**
 * A post that describes a pack must be re-checked when that pack changes.
 *
 *   node scripts/check-blog-staleness.mjs          # report
 *   node scripts/check-blog-staleness.mjs --check  # exit 1 if anything is stale
 *
 * ## Why not a version stamp
 *
 * The obvious design is `verified: 0.51.49` in frontmatter plus "fail if the current release
 * is more than N ahead". That gate fires on every release, for every post, whether or not
 * anything the post describes actually moved. A gate that cries every week is a gate people
 * turn off, and a gate people turn off is worse than none — it also *looks* like coverage.
 *
 * So this keys on the thing that actually goes wrong. Every finding in this audit that came
 * from staleness had the same shape: the post described a pack, the pack moved, the post
 * didn't. wan-2.2 said Q4_K_S after the pack repinned to Q8_0. video-extend-pusa said "no
 * dedicated pack yet" after wan-pusa-extend shipped. ernie said the pack excludes Z-Image
 * after combo groups were added.
 *
 * A post is stale here when git says a pack it documents was modified AFTER the post was last
 * verified. Nothing else. Releases alone never trip it.
 *
 * ## The stamp
 *
 * Frontmatter `verified: YYYY-MM-DD` — the day someone last read the post against source.
 * Bump it when you re-verify, not when you fix a typo. Posts with no stamp are reported as
 * unverified rather than assumed fine, because "nobody has ever checked this" and "this was
 * checked and is current" must not look identical.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const BLOG = path.join(ROOT, 'docs', 'blog');
const PACKS = path.join(ROOT, 'packs');
const CHECK = process.argv.includes('--check');

const packNames = fs.existsSync(PACKS)
  ? new Set(fs.readdirSync(PACKS).filter((d) => fs.statSync(path.join(PACKS, d)).isDirectory()))
  : new Set();

/**
 * A shallow clone cannot answer the only question this gate asks.
 *
 * `actions/checkout` defaults to `fetch-depth: 1`. In that repo there is exactly ONE commit, so
 * `git log -1 -- packs/<name>` returns the tip for EVERY path — every pack looks like it changed
 * today. The comparison below then reports every stamped post as stale, for a reason that has
 * nothing to do with the packs.
 *
 * This is not hypothetical: it is how this gate first ran red. It passed its first CI run only
 * because that run happened before UTC midnight, when "the tip commit's date" still equalled the
 * stamp; the next run, four hours later, failed all five stamped posts. With real history those
 * same packs last moved 2026-07-30.
 *
 * So: refuse to answer rather than answer wrong. A false stale is worse than no reading — it
 * trains people to bump stamps they did not earn, which is the exact failure the stamp exists to
 * prevent. CI fetches full history (see .github/workflows/ci.yml) so the gate stays live there.
 */
function isShallowClone() {
  try {
    return (
      execFileSync('git', ['rev-parse', '--is-shallow-repository'], {
        cwd: ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim() === 'true'
    );
  } catch {
    return false;
  }
}

/** Last commit date touching a path, as YYYY-MM-DD. Null when git can't say. */
function lastChanged(rel) {
  try {
    const out = execFileSync('git', ['log', '-1', '--format=%cs', '--', rel], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

if (isShallowClone()) {
  console.log(
    'skipped: shallow clone — git cannot say when a pack last changed, and guessing here ' +
      'reports every stamped post as stale. Re-run with full history (`git fetch --unshallow`).',
  );
  process.exit(0);
}

const stale = [];
const unverified = [];
let ok = 0;

for (const file of fs.readdirSync(BLOG).filter((f) => f.endsWith('.mdx'))) {
  if (file === 'index.mdx') continue;
  const src = fs.readFileSync(path.join(BLOG, file), 'utf8');

  const named = new Set();
  for (const m of src.matchAll(/packs\/([a-z0-9][a-z0-9-]*)/gi)) {
    if (packNames.has(m[1])) named.add(m[1]);
  }
  for (const m of src.matchAll(/`([a-z0-9][a-z0-9-]*)`\s+pack/gi)) {
    if (packNames.has(m[1])) named.add(m[1]);
  }
  if (!named.size) continue; // nothing pack-shaped to go stale against

  const stamp = src.match(/^verified:\s*(\d{4}-\d{2}-\d{2})\s*$/m)?.[1];
  if (!stamp) {
    unverified.push([file, [...named]]);
    continue;
  }

  const moved = [];
  for (const p of named) {
    const when = lastChanged(`packs/${p}`);
    if (when && when > stamp) moved.push(`${p} (${when})`);
  }
  if (moved.length) stale.push([file, stamp, moved]);
  else ok++;
}

for (const [file, stamp, moved] of stale) {
  console.error(`  ✗ blog/${file}: verified ${stamp}, but since then: ${moved.join(', ')}`);
}
for (const [file, named] of unverified) {
  console.error(`  ? blog/${file}: no \`verified:\` stamp (documents ${named.join(', ')})`);
}

console.log(
  `${ok} post(s) current · ${stale.length} stale · ${unverified.length} unstamped ` +
    `(of ${ok + stale.length + unverified.length} pack-documenting posts)`,
);

/**
 * --check fails on STALE only, never on unstamped.
 *
 * Stale is a regression: someone earned a stamp, then the pack moved out from under it. That
 * should stop a build.
 *
 * Unstamped is a backlog. Failing on it would mean either blocking every build until all
 * eleven posts are re-read, or — far more likely — stamping them in bulk to get green, which
 * manufactures exactly the false assurance the stamp exists to prevent. So it stays loud and
 * non-blocking, and shrinks as posts are genuinely verified.
 */
if (CHECK && stale.length) {
  console.error(
    `\nRe-read the post against the pack, fix what moved, then bump \`verified:\` to today. ` +
      `Bump it only after actually checking — a stamp nobody earned is worse than no stamp.`,
  );
  process.exit(1);
}
