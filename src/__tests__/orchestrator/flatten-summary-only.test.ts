// panel#690(5) — `panel_flatten_workflow` with `apply:false` returned the entire
// flattened graph JSON and offered no way to ask for less, so a caller who only
// wanted to know WHAT flattening did paid tens of thousands of tokens to find out.
//
// The graph is deliberately NOT clipped when it IS returned: a truncated JSON
// document is not a smaller answer, it is an invalid one — unparseable, unloadable,
// undiffable. So the choice is whole-or-not-at-all, and `summary_only` is how the
// caller makes it.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const src = (): string =>
  readFileSync(new URL("../../orchestrator/panel-tools.ts", import.meta.url), "utf8");

/** The panel_flatten_workflow def block, isolated so an assertion cannot be met by
 *  an unrelated tool that happens to share a parameter name. */
function flattenDef(): string {
  const s = src();
  const start = s.indexOf('"panel_flatten_workflow"');
  expect(start).toBeGreaterThan(-1);
  return s.slice(start, s.indexOf('def(', start + 10));
}

describe("flatten can return the report without the graph (panel#690(5))", () => {
  it("declares summary_only", () => {
    expect(flattenDef()).toContain("summary_only: z");
  });

  it("only omits the graph on the apply:false path", () => {
    // Applying to the canvas returns a load result, not JSON, so the flag has
    // nothing to suppress there — claiming otherwise in the description would send a
    // caller looking for an effect that does not exist.
    const def = flattenDef();
    const applyFalse = def.slice(def.indexOf("if (args.apply === false)"));
    expect(applyFalse).toContain("if (args.summary_only)");
    expect(flattenDef()).toMatch(/Ignored when the graph is being applied/);
  });

  it("reports the SIZE it withheld, so 'summary only' is never read as 'that is all'", () => {
    // The rule the bounded reads follow: an omission that does not announce itself is
    // a silent-omission bug wearing a smaller token count.
    const def = flattenDef();
    expect(def).toContain("Graph JSON omitted (summary_only)");
    expect(def).toMatch(/node\(s\), \$\{links\} link\(s\)/);
    expect(def).toMatch(/KB/);
    expect(def).toMatch(/Re-run without summary_only to get it/);
  });

  it("NEVER clips the JSON when it does return it", () => {
    // The load-bearing negative. Clipping would turn a large correct result into a
    // small useless one, which is worse than the token cost being fixed.
    const def = flattenDef();
    // The whole `json` binding is interpolated into the reply, unsliced.
    expect(def).toContain("const json = JSON.stringify(graph);");
    expect(def).toMatch(/\$\{json\}`\);/);
    expect(def).not.toMatch(/json\.slice\(/);
    expect(def).not.toMatch(/json\.substring\(/);
    expect(def).not.toMatch(/json\.substr\(/);
  });

  it("still defaults to returning the whole graph — apply:false's contract is unchanged", () => {
    // summary_only is opt-in. Flipping the default would break every caller that
    // uses apply:false precisely to consume the JSON.
    const def = flattenDef();
    const applyFalse = def.slice(def.indexOf("if (args.apply === false)"));
    const summaryBranch = applyFalse.indexOf("if (args.summary_only)");
    const wholeReturn = applyFalse.search(/\$\{json\}`\);/);
    expect(summaryBranch).toBeGreaterThan(-1);
    expect(wholeReturn).toBeGreaterThan(summaryBranch);
  });
});
