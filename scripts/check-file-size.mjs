#!/usr/bin/env node
/**
 * comfyui-mcp-4x5 — the file-size ratchet.
 *
 * The rule, borrowed from pstack's code-quality review checklist: do not let a
 * PR push a file from under 1,000 lines to over 1,000 lines without a very
 * strong reason. This repo already has forty files past that mark, the largest
 * at ~17,800 lines, and every one of them got there the same way — one more
 * handler, one more branch, one more "it's only twenty lines" on top of a file
 * that was already too big for anyone to hold. Nobody decided to write a
 * 17,000-line file. The decision was made in increments, and no increment was
 * ever the one worth refusing.
 *
 * A review rule that nobody enforces mechanically decays into a review rule that
 * nobody enforces. So this is a CI gate, and it encodes the lesson rather than
 * the reminder: the only way to extend a monolith is to split it.
 *
 * WHAT COUNTS. Raw lines: code, comments, and blanks alike. A "cleverer" count
 * that skips comments invites gaming, and it would also be the wrong measure —
 * the thing the rule protects is what a reader has to scroll through and what a
 * reviewer has to hold in their head, and a comment is part of that. The number
 * is what `wc -l` reports, so it can be checked by hand.
 *
 * THE RULES.
 *
 *   1. A file over 1,000 lines must be named in the baseline, with its count.
 *   2. A baselined file may not grow beyond its baselined count. It may shrink.
 *   3. A file not in the baseline must not cross 1,000 lines.
 *   4. A baselined file that shrank, dropped under 1,000, or was deleted makes
 *      the baseline STALE. That fails too, with the instruction to rewrite it —
 *      otherwise the list stops describing the code, and a file could quietly
 *      grow back up to a number it no longer needs.
 *
 * DIRECTION OF THE RATCHET. Same as #796's unknown-collapse gate: the baseline
 * is the debt that existed when the gate landed, and debt lists only pay down.
 * Rewriting is how the count goes DOWN after a split. It is never how a file
 * is allowed to grow — a reviewer who sees a `lines` field increase in the diff
 * is looking at exactly the thing this gate exists to surface.
 *
 * The exact-count ceiling has a cost worth naming: a PR that shrinks a baselined
 * file must also touch the baseline, and a refactor INSIDE a baselined file that
 * adds a line must first take one out. That is the trade the unknown-collapse
 * ratchet already made, and one shape of ratchet that contributors know beats
 * two that they have to learn — so the same shape is kept here deliberately.
 *
 * THE ESCAPE HATCH IS THE POINT. Sometimes a file genuinely has to cross the
 * line or grow past its mark: a generated table, a vocabulary that is one list
 * by design, a file mid-split where the second half lands in the next PR. Add
 * or bump the entry in the same PR and give the reason in the entry:
 *
 *     { "path": "tools/vocabulary.ts", "lines": 2624,
 *       "reason": "one flat list by design; split would scatter the lookup" }
 *
 * The reason is the deliverable. It is what the reviewer reads instead of
 * re-deriving whether the growth is justified, and writing it is where an
 * author notices that it is not. Unlike `unknown-ok:`, the reason lives in the
 * baseline rather than at a site, because a file's size has no single site —
 * and `--baseline` PRESERVES existing reasons, so rewriting after a split does
 * not erase an explanation someone already wrote.
 *
 * Entries without a reason are the grandfathered forty. They are not wrong;
 * they are debt, and the honest label for debt is no label at all.
 *
 * Usage:
 *   node scripts/check-file-size.mjs            # gate; non-zero on failure
 *   node scripts/check-file-size.mjs --list     # every file over the limit
 *   node scripts/check-file-size.mjs --baseline # rewrite the baseline
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The limit is deliberately not a flag. A limit you can pass on the command
 *  line is a limit CI can be told to ignore; this one is the rule. */
const LIMIT = 1000;

/** A problem with how the gate was INVOKED or with the baseline file itself —
 *  as opposed to a finding about the tree. Reported as a one-line message and a
 *  distinct exit code rather than a stack trace, because the fix is on the
 *  command line or in the JSON, not in the script. */
class UsageError extends Error {}

/** `--src` and `--baseline-file` exist so the gate can be tested against fixture
 *  trees. A gate nobody can test is a gate nobody trusts, and every rule above
 *  — grow, shrink, delete, drop-under, reason survives rewriting — has to be
 *  demonstrable rather than asserted. Both default to the real repo layout. */
function flagValue(args, name, fallback) {
  const i = args.indexOf(name);
  if (i === -1) return fallback;
  const v = args[i + 1];
  // A named flag with no value is a USAGE ERROR, not a fallback. Falling back
  // would point a fixture-shaped invocation at the real tree — and combined
  // with `--baseline` that rewrites the real baseline from a typo.
  if (v === undefined || v.startsWith("--")) throw new UsageError(`${name} needs a value`);
  return v;
}

/** Same exclusions as the unknown-collapse gate. Tests are out of scope: a
 *  long test file is a different (and smaller) problem than a long module, and
 *  the existing suite has files that would trip this on day one for reasons
 *  that have nothing to do with the lesson being encoded. */
const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".git", "__tests__", "coverage"]);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.m?ts$/.test(name) && !/\.d\.ts$/.test(name) && !/\.(test|spec)\.ts$/.test(name)) out.push(p);
  }
  return out;
}

/** What `wc -l` reports for a newline-terminated file, which is every file in
 *  this repo. A file missing its final newline counts the partial last line,
 *  since a reader still has to read it. CRLF is split the same as LF so a
 *  Windows checkout (the CI matrix) does not double-count. */
function countLines(text) {
  if (text === "") return 0;
  const parts = text.split(/\r?\n/);
  return parts[parts.length - 1] === "" ? parts.length - 1 : parts.length;
}

function scan(src) {
  const over = [];
  for (const file of walk(src)) {
    const lines = countLines(readFileSync(file, "utf8"));
    if (lines <= LIMIT) continue;
    const rel = relative(src, file).split(sep).join("/");
    over.push({ path: rel, lines });
  }
  return over.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function readBaseline(baselineFile) {
  let raw;
  try {
    raw = readFileSync(baselineFile, "utf8");
  } catch (e) {
    // Genuinely absent is different from unreadable. An absent baseline means
    // "nothing is grandfathered", which is the correct first-run state; an
    // unreadable or malformed one must FAIL LOUDLY rather than silently become
    // empty, because empty would fail all forty files at once and send someone
    // to rewrite a baseline that was fine.
    if (e && e.code === "ENOENT") return new Map();
    throw e;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new UsageError(`${baselineFile}: not valid JSON — ${e.message}`);
  }
  if (!parsed || !Array.isArray(parsed.files)) {
    throw new UsageError(`${baselineFile}: expected an object with a "files" array`);
  }
  // The limit is written into the file so a reader knows what the counts are
  // measured against. If it disagrees with the script, one of them was edited
  // without the other and every count in the file is suspect.
  if (parsed.limit !== undefined && parsed.limit !== LIMIT) {
    throw new UsageError(`${baselineFile}: "limit" is ${parsed.limit} but this gate enforces ${LIMIT}`);
  }
  const out = new Map();
  for (const entry of parsed.files) {
    if (typeof entry?.path !== "string" || !Number.isInteger(entry.lines)) {
      throw new UsageError(
        `${baselineFile}: every entry needs a string "path" and an integer "lines": ${JSON.stringify(entry)}`,
      );
    }
    out.set(entry.path, { lines: entry.lines, reason: typeof entry.reason === "string" ? entry.reason : undefined });
  }
  return out;
}

function list(over, baseline) {
  for (const f of over) {
    const reason = baseline.get(f.path)?.reason;
    console.log(`${f.path}\t${f.lines}${reason ? `\t${reason}` : ""}`);
  }
  console.log(`\n${over.length} file(s) over ${LIMIT} lines`);
  return 0;
}

function writeBaseline(over, baselineFile) {
  // Carry every existing reason forward. A rewrite is how a count goes down
  // after a split; it must not also be how an explanation disappears.
  let previous;
  try {
    previous = readBaseline(baselineFile);
  } catch (e) {
    // The one place a malformed baseline must NOT simply throw: `--baseline` is
    // the instruction the gate gives for fixing a stale file, and if the file
    // is too broken to read, the author needs to be told that the reasons in
    // it cannot be carried forward — not handed a stack trace.
    if (!(e instanceof UsageError)) throw e;
    console.error(`${e.message}\n\nThe existing baseline cannot be read, so its "reason" fields cannot be preserved.`);
    console.error(`Fix or delete it, then run --baseline again.`);
    return 1;
  }
  const files = over.map((f) => {
    const reason = previous.get(f.path)?.reason;
    return reason ? { path: f.path, lines: f.lines, reason } : { path: f.path, lines: f.lines };
  });
  const doc = {
    "//": [
      `comfyui-mcp-4x5 — non-test files under src/ that exceed ${LIMIT} lines, with their counts.`,
      "A file named here may shrink and never grow; a file not named here may not cross the limit.",
      "The way to extend one of these is to split it. A genuine exception adds or bumps its entry",
      'in the same PR with a one-line "reason" — the reason is what the reviewer reads.',
      "Entries without a reason are grandfathered debt from when the gate landed.",
      "Rewrite deliberately:  node scripts/check-file-size.mjs --baseline  (reasons are preserved)",
    ],
    limit: LIMIT,
    files,
  };
  writeFileSync(baselineFile, JSON.stringify(doc, null, 2) + "\n", "utf8");
  console.log(`baseline written: ${files.length} file(s) over ${LIMIT} lines`);
  return 0;
}

function gate(over, baseline) {
  const seen = new Map(over.map((f) => [f.path, f]));

  // Rule 3 — crossed the line without being named.
  const crossed = over.filter((f) => !baseline.has(f.path));
  // Rule 2 — named, but bigger than the name allows.
  const grew = over
    .filter((f) => baseline.has(f.path) && f.lines > baseline.get(f.path).lines)
    .map((f) => ({ ...f, was: baseline.get(f.path).lines, reason: baseline.get(f.path).reason }));
  // Rule 4 — the baseline describes a file that no longer matches it.
  const stale = [...baseline]
    .filter(([path, b]) => {
      const now = seen.get(path);
      // Shrank (including under the limit, where it vanishes from `seen`), or was
      // deleted or moved. Either way the entry is claiming room the file no
      // longer uses, and room nobody is using is room a file can grow back into.
      return !now || now.lines < b.lines;
    })
    .map(([path, b]) => ({ path, was: b.lines, now: seen.get(path)?.lines ?? null }));

  let failed = false;

  if (crossed.length) {
    failed = true;
    console.error(`\ncomfyui-mcp-4x5 — ${crossed.length} file(s) crossed ${LIMIT} lines without being named in the baseline.\n`);
    for (const f of crossed) console.error(`  ${f.path}  ${f.lines}`);
    console.error(
      "\nNobody decides to write a 17,000-line file; it happens one 'only twenty\n" +
        "lines' at a time, and this is the increment where it gets refused. Split\n" +
        "the file. If it genuinely has to be this big, add it to the baseline in\n" +
        "this PR with a one-line \"reason\" field — that reason is what the reviewer\n" +
        "reads instead of re-deriving whether the exception is warranted:\n\n" +
        "    node scripts/check-file-size.mjs --baseline\n" +
        "    then set \"reason\" on the new entry in scripts/file-size-baseline.json\n",
    );
  }

  if (grew.length) {
    failed = true;
    console.error(`\ncomfyui-mcp-4x5 — ${grew.length} baselined file(s) grew past their baselined count.\n`);
    for (const f of grew) {
      console.error(`  ${f.path}  ${f.was} -> ${f.lines}  (+${f.lines - f.was})`);
      if (f.reason) console.error(`      existing reason: ${f.reason}`);
    }
    console.error(
      "\nThe baseline is a ceiling, not a record. A file on this list is already\n" +
        "too big to hold, and the way to add to it is to move something OUT first\n" +
        "so the net change is not growth. If the growth is genuinely warranted,\n" +
        "bump the entry in this PR and say why in its \"reason\" field.\n",
    );
  }

  if (stale.length) {
    // Not a defect — a paid debt, or a moved file. But the entry has to go, or
    // the list stops meaning anything and the file could grow back pre-approved.
    failed = true;
    console.error(`\ncomfyui-mcp-4x5 — ${stale.length} baseline entr(ies) no longer match the tree. Rewrite it:\n`);
    for (const f of stale) {
      const now = f.now === null ? `now under ${LIMIT} or gone` : `now ${f.now}`;
      console.error(`  ${f.path}  ${f.was} -> ${now}`);
    }
    console.error(`\n  node scripts/check-file-size.mjs --baseline\n`);
  }

  if (!failed) console.log(`file-size gate: ${over.length} baselined file(s) over ${LIMIT} lines, none grew, nothing new crossed.`);
  return failed ? 1 : 0;
}

function main(args) {
  const src = flagValue(args, "--src", join(ROOT, "src"));
  const baselineFile = flagValue(args, "--baseline-file", join(ROOT, "scripts", "file-size-baseline.json"));
  const over = scan(src);
  if (args.includes("--baseline")) return writeBaseline(over, baselineFile);
  const baseline = readBaseline(baselineFile);
  if (args.includes("--list")) return list(over, baseline);
  return gate(over, baseline);
}

// `process.exitCode` rather than `process.exit()`: on Windows, piped stdout and
// stderr are asynchronous, and an explicit exit can cut the message off before
// CI has read it — leaving a red build with no reason attached.
try {
  process.exitCode = main(process.argv.slice(2));
} catch (e) {
  if (!(e instanceof UsageError)) throw e;
  console.error(e.message);
  process.exitCode = 2;
}
