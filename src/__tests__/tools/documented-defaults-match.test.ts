// A documented default that the code does not use is a number users plan around.
//
// `docs/configuration.mdx` advertised `COMFYUI_STARTUP_CHECK_MAX_TRIES` default
// 20. The code uses 60 — and was raised FROM 20 precisely because a 20-probe
// budget reported a startup as unconfirmed moments before a healthy ComfyUI
// became ready (#367). So the docs kept advertising the value that caused the
// bug, long after the fix shipped.
//
// This is the same family as #1055's stated-but-unenforced ceiling and the inert
// `COMFYUI_MCP_NO_AUTOSPAWN`: prose that describes behaviour the code does not
// have. A default is the worst of the three to get wrong, because it reads as a
// fact rather than an instruction — nobody tries it and discovers it does
// nothing, they just believe it.
//
// SCOPE. Only NUMERIC defaults, and only where the code's default can be read
// unambiguously next to the variable's name. A string default like
// "Bearer for Authorization, else none" is prose, not a value, and matching it
// would be guesswork. Narrow and certain beats broad and noisy: a gate that
// cries wolf gets deleted.

import { readFileSync } from "node:fs";
import { globSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..", "..");

/** `<ParamField path="NAME" … default="V">` — the structured form our docs use. */
const PARAM_FIELD = /<ParamField path="([A-Z][A-Z0-9_]+)"[^>]*default="([^"]*)"/g;

function sourceText(): string {
  return globSync("src/**/*.ts", { cwd: ROOT })
    .filter((p) => !p.includes("__tests__") && !p.endsWith(".test.ts"))
    .map((p) => readFileSync(join(ROOT, p), "utf-8"))
    .join("\n");
}

/**
 * Defaults the code states right beside the variable name — the two shapes this
 * codebase uses:
 *   parseXEnv("NAME", 60)        a helper taking the name and its fallback
 *   env.NAME ?? 60 / || 60       a direct read with a fallback
 * Anything else yields no reading, and the variable is skipped rather than
 * guessed at.
 */
function codeDefaults(src: string, name: string): Set<string> {
  const found = new Set<string>();
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const re of [
    new RegExp(`${esc}["']?\\s*,\\s*([0-9][0-9_]*(?:\\.[0-9]+)?)`, "g"),
    new RegExp(`${esc}[^\\n]{0,80}?(?:\\|\\||\\?\\?)\\s*([0-9][0-9_]*(?:\\.[0-9]+)?)`, "g"),
  ]) {
    for (const m of src.matchAll(re)) found.add(m[1].replace(/_/g, ""));
  }
  return found;
}

function documentedNumericDefaults(): Array<{ name: string; value: string; at: string }> {
  const out: Array<{ name: string; value: string; at: string }> = [];
  for (const rel of globSync("docs/**/*.mdx", { cwd: ROOT })) {
    const text = readFileSync(join(ROOT, rel), "utf-8");
    for (const m of text.matchAll(PARAM_FIELD)) {
      if (!/^[0-9]+(\.[0-9]+)?$/.test(m[2].trim())) continue; // prose default — not checkable
      out.push({
        name: m[1],
        value: m[2].trim(),
        at: `${rel}:${text.slice(0, m.index!).split("\n").length}`,
      });
    }
  }
  return out;
}

describe("a documented numeric default matches the code", () => {
  it("every checkable default agrees", () => {
    const src = sourceText();
    const wrong: string[] = [];
    for (const { name, value, at } of documentedNumericDefaults()) {
      const inCode = codeDefaults(src, name);
      // No readable default in code → skipped, not guessed at.
      if (inCode.size === 0) continue;
      if (!inCode.has(value)) {
        wrong.push(`${name}: docs say ${value} (${at}), code uses ${[...inCode].join(" / ")}`);
      }
    }
    expect(wrong, `documented default(s) the code does not use:\n  ${wrong.join("\n  ")}`).toEqual([]);
  });

  // A gate that inspects nothing passes forever — the assertion that caught my
  // process-probe scanner globbing an empty directory.
  it("actually finds documented defaults to check", () => {
    const src = sourceText();
    const checkable = documentedNumericDefaults().filter((d) => codeDefaults(src, d.name).size > 0);
    expect(documentedNumericDefaults().length).toBeGreaterThan(5);
    expect(checkable.length).toBeGreaterThan(3);
  });
});
