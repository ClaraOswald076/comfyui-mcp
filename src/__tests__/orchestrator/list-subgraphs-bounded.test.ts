// panel#690(5) — panel_list_subgraphs was the one panel READ tool with no token
// bound: an install with the bundled globals returned all 90 blueprints with full
// descriptions in a single reply.
//
// The panel now bounds it. This pins the ORCHESTRATOR half: the parameters have to
// exist and actually reach the panel, and the description has to warn that a
// truncated list is not evidence of absence — a bounded read whose caller cannot
// tell it was bounded is a silent-omission bug, which is worse than the token cost.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const src = (): string =>
  readFileSync(new URL("../../orchestrator/panel-tools.ts", import.meta.url), "utf8");

/** The panel_list_subgraphs def block, isolated so an assertion cannot be satisfied
 *  by an unrelated tool that happens to use the same parameter names. */
function listSubgraphsDef(): string {
  const s = src();
  const start = s.indexOf('"panel_list_subgraphs"');
  expect(start).toBeGreaterThan(-1);
  return s.slice(start, s.indexOf('def(', start + 10));
}

describe("panel_list_subgraphs is bounded end to end (panel#690(5))", () => {
  it("declares the filter and limit parameters", () => {
    const def = listSubgraphsDef();
    expect(def).toContain("filter: z");
    expect(def).toContain("limit: z");
  });

  it("FORWARDS them to the panel — a declared-but-dropped param is the worst case", () => {
    // Declaring the parameters without passing them would advertise a bound the
    // panel never receives, so every call would silently use the default while the
    // caller believed their filter applied.
    expect(listSubgraphsDef()).toContain(
      'ctx.call({ cmd: "graph_list_subgraphs", filter: args.filter, limit: args.limit }, 15000)',
    );
  });

  it("warns that a truncated list is not evidence a blueprint is absent", () => {
    // The load-bearing sentence. Without it an agent reads a bounded list as the
    // whole library and rebuilds a blueprint that already exists.
    const def = listSubgraphsDef();
    expect(def).toMatch(/NOT evidence the blueprint does not exist/i);
    expect(def).toMatch(/truncated/);
  });

  it("explains matched vs count, so an empty filter result is not read as an empty library", () => {
    const def = listSubgraphsDef();
    expect(def).toMatch(/matched field reports how many the filter selected/);
    expect(def).toMatch(/means the filter missed, not that the library is empty/);
  });
});
