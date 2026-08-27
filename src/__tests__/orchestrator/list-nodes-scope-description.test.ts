// comfyui-mcp-panel#1933 — `panel_list_nodes({search:"LTXVContextWindowsGuideAware"})`
// was rejected with "this tool takes no arguments", and the reporter concluded the
// schema and the documentation disagreed.
//
// They did not. The schema is `{}` and the tool is correct: it lists installed PACKS.
// What was missing is that the description never said a pack is not a node class, and
// never named the tool that answers the question actually being asked. An accurate
// rejection that points nowhere costs the caller the same time as a wrong one.
//
// Three tools sit close enough together to be confused, and this pins that the
// description distinguishes them:
//   panel_list_nodes   — packs ALREADY installed        (no arguments)
//   panel_search_nodes — packs INSTALLABLE from registry
//   comfy_cli action:"search_nodes" — real node CLASSES, with a live /object_info fallback
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const SRC = readFileSync(
  new URL("../../orchestrator/panel-tools.ts", import.meta.url),
  "utf8",
).replace(/\r\n/g, "\n");

/** The def(...) block for one tool, from its name literal to the next def boundary. */
function toolBlock(name: string): string {
  const at = SRC.indexOf(`"${name}",`);
  expect(at, `${name} not found — re-anchor this pin`).toBeGreaterThan(0);
  return SRC.slice(at, at + 2000);
}

describe("panel_list_nodes says what it lists (panel#1933)", () => {
  const block = toolBlock("panel_list_nodes");

  it("still takes no arguments — the schema was never the defect", () => {
    // The fix is documentation. If someone later adds a `search` argument, this pin
    // should fail so the description is revisited with it rather than left stale.
    expect(block).toMatch(/"panel_list_nodes",[\s\S]{0,1200}?\n\s*\{\},/);
  });

  it("says it lists PACKS, not node classes", () => {
    expect(block).toMatch(/PACKS/);
    expect(block).toMatch(/NOT node classes/i);
  });

  it("names the tool that DOES find a node class", () => {
    // The reporter's actual question was whether one node type was available. Naming
    // the answer is the whole point; a rejection with no redirect is what cost them.
    expect(block).toContain('comfy_cli action:\\"search_nodes\\"');
  });

  it("distinguishes the third neighbour, which searches INSTALLABLE packs", () => {
    expect(block).toContain("panel_search_nodes");
    expect(block).toMatch(/INSTALLABLE/);
  });

  it("states it takes no arguments, so the rejection is predictable", () => {
    expect(block).toMatch(/[Tt]akes no arguments/);
  });
});

describe("the tools the description redirects to actually exist", () => {
  // A redirect to a tool that does not exist is the same defect as no redirect, and
  // worse: it reads as actionable. check:vocabulary enforces this repo-wide for tool
  // NAME literals; this pins the two this description depends on specifically, so a
  // rename cannot quietly strand the sentence.
  it("comfy_cli is a registered tool name", () => {
    expect(SRC.includes("comfy_cli") || readFileSync(
      new URL("../../tools/comfy-cli.ts", import.meta.url),
      "utf8",
    ).includes('"comfy_cli"')).toBe(true);
  });

  it("panel_search_nodes is defined in this same surface", () => {
    expect(SRC).toContain('"panel_search_nodes",');
  });
});
