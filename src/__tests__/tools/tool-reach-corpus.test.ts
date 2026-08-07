// The tool-reach corpus is only useful if it cannot silently rot against a rename.
// A benchmark whose expected answers name tools that no longer exist scores a model
// against a surface nobody ships — worse than having no benchmark, because the number
// still looks meaningful.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { TOOL_NAMES } from "../../tools/vocabulary.js";

const rows = readFileSync(new URL("../../../benchmarks/tool-reach.jsonl", import.meta.url), "utf8")
  .trim()
  .split(/\r?\n/)
  .map((line, i) => {
    try {
      return JSON.parse(line) as { id: number; request: string; expect: string; alt?: string[] };
    } catch (err) {
      throw new Error(`benchmarks/tool-reach.jsonl line ${i + 1} is not valid JSON: ${String(err)}`);
    }
  });

describe("tool-reach corpus stays valid against the shipped surface", () => {
  const live = new Set<string>(TOOL_NAMES as readonly string[]);

  it("every expected tool still exists", () => {
    const dead = rows.filter((r) => !live.has(r.expect)).map((r) => `#${r.id} → ${r.expect}`);
    expect(dead, "rename a tool and this fails loudly instead of scoring against a ghost").toEqual([]);
  });

  it("every alternative tool still exists", () => {
    const dead = rows.flatMap((r) => (r.alt ?? []).filter((a) => !live.has(a)).map((a) => `#${r.id} → ${a}`));
    expect(dead).toEqual([]);
  });

  it("exercises EVERY tool at least once — a blind spot is a benchmark that cannot fail", () => {
    const covered = new Set(rows.map((r) => r.expect));
    const missing = [...live].filter((t) => !covered.has(t));
    expect(missing, "add a request for these before trusting any score").toEqual([]);
  });

  it("has unique ids and non-empty requests", () => {
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
    expect(rows.every((r) => typeof r.request === "string" && r.request.trim().length > 0)).toBe(true);
  });

  it("is the advertised size", () => {
    expect(rows.length).toBe(100);
  });
});
