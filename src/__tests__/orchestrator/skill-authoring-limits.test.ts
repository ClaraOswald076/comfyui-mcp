// #1620 — every bundled skill must stay inside the limits the Agent Skills authoring
// guide states, because nothing else in this repo can notice when one drifts past them.
//
// A SKILL.md is inert data: no module imports it, so a `description` can grow past the
// documented 1,024-character MAXIMUM and every one of the ~390 test files stays green
// while the skill ships in a state the loader is entitled to reject or truncate. That is
// exactly how `report-bug` reached 1,524 characters unnoticed.
//
// The `description` cap is the load-bearing one and it is a MAXIMUM, not a guideline:
//   https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices
//   "`description`: Maximum 1,024 characters, non-empty, no XML tags"
// It also costs us at rest — ALL skill descriptions are pre-loaded into the system prompt
// at startup, before any of them trigger, so an over-long one is a standing tax paid by
// every session whether or not the skill ever fires.
//
// The body/table-of-contents caps are the guide's stated guidelines ("Keep SKILL.md body
// under 500 lines", "For reference files longer than 100 lines, include a table of
// contents"). They are asserted here at the same strength deliberately: a guideline with
// no enforcement is how all three video skills drifted over at once.
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const SKILLS_DIR = fileURLToPath(new URL("../../../plugin/skills", import.meta.url));

/** Documented maximum for the frontmatter `description` field. */
const DESCRIPTION_MAX = 1024;
/** Documented maximum for the frontmatter `name` field. */
const NAME_MAX = 64;
/** Guideline: keep the SKILL.md body under this many lines. */
const BODY_MAX_LINES = 500;
/** Guideline: reference files longer than this need a table of contents. */
const TOC_REQUIRED_OVER_LINES = 100;

// Normalize exactly the way the LOADER normalizes — `splitFrontmatter` in
// tools/skills-access.ts strips the BOM and folds CRLF before it matches the fence, so
// the bytes on disk are not what any consumer sees. Asserting on raw bytes instead is
// what made an earlier skill test fail on every Windows checkout with `core.autocrlf=true`
// (#1617) for a reason that said nothing about the thing being tested.
function readNormalized(file: string): string {
  return readFileSync(file, "utf-8").replace(/^﻿/, "").replace(/\r\n/g, "\n");
}

function splitFrontmatter(text: string): { frontmatter: Record<string, unknown>; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!m) return { frontmatter: {}, body: text };
  let fm: Record<string, unknown> = {};
  try {
    const parsed = parseYaml(m[1]);
    if (parsed && typeof parsed === "object") fm = parsed as Record<string, unknown>;
  } catch {
    // malformed frontmatter — mirror the loader and keep the body
  }
  return { frontmatter: fm, body: text.slice(m[0].length) };
}

/** Lines in a chunk of text, not counting a single trailing newline. */
function lineCount(text: string): number {
  return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

function listSkills(): string[] {
  if (!existsSync(SKILLS_DIR)) return [];
  return readdirSync(SKILLS_DIR)
    .filter((e) => statSync(join(SKILLS_DIR, e)).isDirectory())
    .filter((e) => existsSync(join(SKILLS_DIR, e, "SKILL.md")))
    .sort();
}

/** Every bundled .md that is NOT a SKILL.md — i.e. progressive-disclosure material. */
function listReferenceDocs(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (entry.endsWith(".md") && entry !== "SKILL.md") out.push(p);
    }
  };
  for (const skill of listSkills()) walk(join(SKILLS_DIR, skill));
  return out.sort();
}

const SKILLS = listSkills();

describe("bundled skills stay inside the documented Agent Skills limits (#1620)", () => {
  it("finds the bundled skills at all", () => {
    // Guards the whole file: if the glob silently resolved to nothing, every `it.each`
    // below would vacuously pass and the suite would report green on zero coverage.
    expect(SKILLS.length).toBeGreaterThan(30);
  });

  it.each(SKILLS)("%s: frontmatter is valid YAML the loader can actually read", (skill) => {
    // The defect this file was written for. `splitFrontmatter` wraps parseYaml in a
    // try/catch and falls back to `{}` on error, and `enumerateSkills` then substitutes
    // the DIRECTORY name and an EMPTY description — so a skill whose frontmatter does not
    // parse still enumerates, silently, with no description at all. Both `report-bug` and
    // `triton-sageattention` shipped in exactly that state.
    //
    // The cause is a YAML plain scalar containing ": " (colon-space), which YAML reads as
    // a nested mapping and rejects with BLOCK_AS_IMPLICIT_KEY:
    //     description: Report it the right way: our intake Worker ...
    //                                        ^^ starts a nested mapping
    // Keep descriptions as single-line plain scalars with no ": " in them. That form is
    // also what scripts/sync-agents.mjs re-emits (it parses frontmatter line-by-line and
    // writes `description: <text>` back out unquoted), so a block scalar or a quoted
    // string that hides a colon here would survive this test and break there instead.
    const text = readNormalized(join(SKILLS_DIR, skill, "SKILL.md"));
    const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
    expect(m, `${skill}/SKILL.md has no frontmatter fence`).not.toBeNull();
    expect(() => parseYaml(m![1])).not.toThrow();
    const parsed = parseYaml(m![1]);
    expect(parsed).toBeTypeOf("object");
    // ...and the two fields must actually be there once parsed, which is the thing the
    // try/catch fallback hides.
    expect(typeof (parsed as Record<string, unknown>).name).toBe("string");
    expect(typeof (parsed as Record<string, unknown>).description).toBe("string");
  });

  it.each(SKILLS)("%s: description survives the sync-agents line parser too", (skill) => {
    // scripts/sync-agents.mjs generates .agents/skills/<n>/SKILL.md with a naive
    // line-based frontmatter reader, then re-emits `description: ${description}` on one
    // unquoted line. Anything that needs quoting or spans lines is destroyed there even
    // when the real YAML parser copes, so assert the round-trip that generator performs.
    const text = readNormalized(join(SKILLS_DIR, skill, "SKILL.md"));
    const fmText = /^---\n([\s\S]*?)\n---\n?/.exec(text)![1];
    const line = fmText.split("\n").find((l) => l.startsWith("description:"));
    expect(line, `${skill} has no single-line description:`).toBeDefined();
    const naive = line!.slice("description:".length).trim().replace(/^['"]|['"]$/g, "");
    // Re-emitted unquoted, it has to parse back to the same string.
    const reparsed = parseYaml(`description: ${naive}\n`) as { description?: unknown };
    expect(typeof reparsed.description).toBe("string");
    expect(reparsed.description).toBe(naive);
  });

  it.each(SKILLS)("%s: description is non-empty and within the 1,024-char MAXIMUM", (skill) => {
    const { frontmatter } = splitFrontmatter(readNormalized(join(SKILLS_DIR, skill, "SKILL.md")));
    const description = frontmatter.description;
    expect(typeof description).toBe("string");
    const text = String(description);
    expect(text.trim()).not.toBe("");
    // Not `toBeLessThanOrEqual` on its own: when this trips, the failure needs to say
    // which skill and by how much, or the next author has to go re-measure by hand.
    expect({ skill, chars: text.length, max: DESCRIPTION_MAX }).toEqual({
      skill,
      chars: Math.min(text.length, DESCRIPTION_MAX),
      max: DESCRIPTION_MAX,
    });
  });

  it.each(SKILLS)("%s: description carries no XML tags", (skill) => {
    // Also a stated frontmatter requirement ("no XML tags"). Cheap to check, and an
    // angle-bracketed placeholder is an easy thing to paste in from body prose.
    const { frontmatter } = splitFrontmatter(readNormalized(join(SKILLS_DIR, skill, "SKILL.md")));
    expect(String(frontmatter.description ?? "")).not.toMatch(/<\/?[a-zA-Z][^>]*>/);
  });

  it.each(SKILLS)("%s: name is a loadable slug matching its directory", (skill) => {
    const { frontmatter } = splitFrontmatter(readNormalized(join(SKILLS_DIR, skill, "SKILL.md")));
    const name = String(frontmatter.name ?? "");
    // list_packs(action:"skill_read", name:<n>) resolves plugin/skills/<n>/SKILL.md, so a
    // frontmatter name that disagrees with the directory is a skill nobody can load by
    // the name the agent is told to use.
    expect(name).toBe(skill);
    expect(name.length).toBeLessThanOrEqual(NAME_MAX);
    expect(name).toMatch(/^[a-z0-9-]+$/);
    // Reserved words per the frontmatter requirements.
    expect(name).not.toMatch(/anthropic|claude/);
  });

  it.each(SKILLS)("%s: body stays under the 500-line guideline", (skill) => {
    const { body } = splitFrontmatter(readNormalized(join(SKILLS_DIR, skill, "SKILL.md")));
    const lines = lineCount(body);
    expect({ skill, lines, max: BODY_MAX_LINES }).toEqual({
      skill,
      lines: Math.min(lines, BODY_MAX_LINES),
      max: BODY_MAX_LINES,
    });
  });
});

describe("the .agents generator can read a CRLF checkout (#1620)", () => {
  // scripts/sync-agents.mjs runs everything at module scope (it mkdirs and writes on
  // import), so it cannot be imported and exercised here. Assert at the SOURCE instead —
  // this is a one-line normalization whose absence is invisible to every behavioural test
  // and whose failure is silent: `^---\n` does not match `---\r\n`, so on any checkout
  // with core.autocrlf=true (the Windows default) extractFrontmatter took its
  // no-frontmatter branch and emitted all 39 skills with an EMPTY description and the
  // original frontmatter duplicated into the body. Nothing was red; the output was just
  // wrong. Same root cause as #1617, in the generator rather than in a test.
  const SRC = readFileSync(
    fileURLToPath(new URL("../../../scripts/sync-agents.mjs", import.meta.url)),
    "utf-8",
  );

  it("folds CRLF before matching the frontmatter fence", () => {
    const fn = SRC.slice(SRC.indexOf("function extractFrontmatter"));
    // Strip `//` comment lines first. The explanatory comment above the fix quotes both
    // `\r\n` and `^---`, so an ordering check over the raw text finds the prose rather
    // than the code and reports backwards.
    const body = fn
      .slice(0, fn.indexOf("\n}"))
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    // The normalization must happen BEFORE the fence match, not after.
    const normAt = body.indexOf("\\r\\n");
    const matchAt = body.indexOf("^---");
    expect(normAt, "sync-agents.mjs no longer folds CRLF").toBeGreaterThan(-1);
    expect(matchAt, "sync-agents.mjs no longer matches a frontmatter fence").toBeGreaterThan(-1);
    expect(normAt).toBeLessThan(matchAt);
  });

  it("falls back to the NORMALIZED text, not the raw bytes", () => {
    // The no-frontmatter branch has to return normalized content too, or a file that
    // genuinely has no frontmatter still carries CRLF into the generated copy.
    expect(SRC).toMatch(/return \{ frontmatter: \{\}, body: normalized \}/);
  });
});

describe("long reference files open with a table of contents (#1620)", () => {
  const docs = listReferenceDocs();

  it("finds the reference docs the split-out skills depend on", () => {
    // Same vacuous-pass guard as above: `it.each([])` reports green.
    expect(docs.length).toBeGreaterThan(0);
  });

  it.each(docs.map((d) => [d.slice(SKILLS_DIR.length + 1).replace(/\\/g, "/"), d] as const))(
    "%s",
    (rel, file) => {
      const text = readNormalized(file);
      const lines = lineCount(text);
      if (lines <= TOC_REQUIRED_OVER_LINES) return;
      // The guide's reason is specific: a partial read (Claude previewing with `head`)
      // still has to show the reader the full scope of what the file covers. A heading
      // named "Contents" near the top is what does that.
      const head = text.split("\n").slice(0, 40).join("\n");
      expect(
        { rel, hasContents: /^#{1,3}\s+Contents\b/m.test(head) },
        `${rel} is ${lines} lines and needs a "## Contents" list at the top`,
      ).toEqual({ rel, hasContents: true });
    },
  );
});
