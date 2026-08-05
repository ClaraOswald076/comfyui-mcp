import { describe, expect, it } from "vitest";
import { calculateAction } from "../../tools/calculate.js";

/**
 * 0.50.0 slice 13 folded this tool into `get_system_stats (action:"calculate")`.
 * The evaluator behaviour these cases pin is unchanged, so they now exercise the
 * exported action handler directly; the dispatch, the schema and the
 * missing-`spec` guard are covered in system-stats.test.ts.
 */
async function run(args: {
  spec: string | string[];
  variables?: Record<string, number>;
  seed?: number;
}) {
  return (await calculateAction(args)) as {
    isError?: boolean;
    content: Array<{ type: string; text: string }>;
  };
}

describe("the calculator action", () => {
  it("splits a string spec on newlines and semicolons (NOT commas)", async () => {
    const res = await run({ spec: "w = 8\nmin(w, 3); w + 1" });
    const json = JSON.parse(res.content[1].text);
    // min(w, 3) keeps its comma intact => 3 lines, not 4.
    expect(json.results).toEqual([8, 3, 9]);
    expect(json.variables).toEqual({ w: 8 });
  });

  it("accepts an array spec", async () => {
    const res = await run({ spec: ["1 + 1", "2 * 3"] });
    const json = JSON.parse(res.content[1].text);
    expect(json.results).toEqual([2, 6]);
  });

  it("passes variables and seed through; echoes seed", async () => {
    const res = await run({
      spec: "ar * 2",
      variables: { ar: 1.5 },
      seed: 42,
    });
    const json = JSON.parse(res.content[1].text);
    expect(json.results).toEqual([3]);
    expect(json.seed).toBe(42);
  });

  it("surfaces per-line errors without failing the whole call", async () => {
    const res = await run({ spec: "1 + 1\nbad(\n3" });
    expect(res.isError).toBeFalsy();
    const json = JSON.parse(res.content[1].text);
    expect(json.results).toEqual([2, null, 3]);
    expect(json.errors).toHaveLength(1);
    expect(json.errors[0].line).toBe(2);
  });

  it("errors when spec is empty after splitting", async () => {
    await expect(run({ spec: "\n\n  ;  " })).rejects.toThrow(/empty after splitting/);
  });

  it("flags non-finite results in rendered text", async () => {
    const res = await run({ spec: "1 / 0" });
    expect(res.content[0].text).toMatch(/Infinity/);
    expect(res.content[0].text).toMatch(/non-finite/);
  });
});
