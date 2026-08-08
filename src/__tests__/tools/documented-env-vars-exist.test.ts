// A documented env var that nothing reads is a knob that does nothing.
//
// `docs/panel.mdx` told users to set `COMFYUI_MCP_NO_AUTOSPAWN=1` to run their
// own orchestrator. That name appears NOWHERE — not in this repo, not in the
// panel's Python, not in its browser JS. It could not have worked even in
// principle: the spawn decision is made in the BROWSER, which cannot read
// process env at all, and the panel's Python passes no such value through.
//
// A user following that instruction would launch their own orchestrator, click
// Connect, and get a second one spawned anyway — with nothing to indicate the
// setting they were told to use had no effect. The real control was a Settings
// toggle, documented eleven lines further down for the adjacent remote-ComfyUI
// case.
//
// This is the inverse of #1055's enforced-but-hidden cap: documented but inert.
// Both leave the caller acting on a lever that is not connected to anything.
//
// SCOPE, and why this is narrow on purpose. It checks only that a documented
// name appears SOMEWHERE in the source — not that it is read correctly, and not
// that undocumented vars get documented (196 are read; documenting every
// internal tuning knob is not the goal). Presence is the cheap half, and it is
// the half that would have caught this.

import { readFileSync } from "node:fs";
import { globSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..", "..");

/** Env-var-shaped names our docs hand to users. */
const DOCUMENTED = /\b(COMFYUI_[A-Z0-9_]{2,}|HF_[A-Z0-9_]{2,}|HUGGINGFACE_[A-Z0-9_]{2,}|CIVITAI_[A-Z0-9_]{2,})\b/g;

/**
 * Names that are PREFIXES, expanded at runtime rather than read literally —
 * `COMFYUI_DEFAULT_CHECKPOINT` is served by `ENV_PREFIX = "COMFYUI_DEFAULT_"`,
 * and `COMFYUI_AUTH_*` likewise. Matching them literally would report a working
 * knob as broken, which is the same false-negative this test exists to prevent.
 */
const PREFIXES = ["COMFYUI_DEFAULT_", "COMFYUI_AUTH_"];

/**
 * Read by the PANEL (a separate repo): its Python serves these. Listed
 * explicitly rather than skipped silently, so the exemption is visible and has
 * to be justified when it grows.
 */
const READ_BY_PANEL = new Set(["COMFYUI_MCP_APPS_DIR", "COMFYUI_MCP_DATA_DIR", "COMFYUI_MCP_TRAINING_DIR"]);

function sourceText(): string {
  return globSync("src/**/*.ts", { cwd: ROOT })
    .filter((p) => !p.includes("__tests__") && !p.endsWith(".test.ts"))
    .map((p) => readFileSync(join(ROOT, p), "utf-8"))
    .join("\n");
}

function documentedNames(): Map<string, string> {
  const out = new Map<string, string>();
  for (const rel of globSync("docs/**/*.mdx", { cwd: ROOT })) {
    const text = readFileSync(join(ROOT, rel), "utf-8");
    for (const m of text.matchAll(DOCUMENTED)) {
      if (!out.has(m[1])) out.set(m[1], `${rel}:${text.slice(0, m.index!).split("\n").length}`);
    }
  }
  return out;
}

describe("a documented env var is read by something", () => {
  it("every env var our docs name appears in the source", () => {
    const src = sourceText();
    const inert: string[] = [];
    for (const [name, where] of documentedNames()) {
      if (READ_BY_PANEL.has(name)) continue;
      if (PREFIXES.some((p) => name.startsWith(p))) continue;
      // Property access OR a bare string literal — many are passed by NAME to a
      // helper (`parsePositiveNumberEnv("COMFYUI_…", 0.4)`), which a property
      // scan alone misses. That omission made 8 working vars look inert on the
      // first pass of this audit.
      if (src.includes(name)) continue;
      inert.push(`${name}   documented at ${where}`);
    }
    expect(inert, `documented but read by nothing:\n  ${inert.join("\n  ")}`).toEqual([]);
  });

  it("actually reads the docs it claims to", () => {
    const names = documentedNames();
    expect(names.size).toBeGreaterThan(40);
    expect(sourceText().length).toBeGreaterThan(100_000);
  });

  // A gate that cannot fail protects nothing.
  it("would flag a name nothing reads", () => {
    const src = sourceText();
    expect(src.includes("COMFYUI_MCP_DEFINITELY_NOT_READ")).toBe(false);
  });
});
