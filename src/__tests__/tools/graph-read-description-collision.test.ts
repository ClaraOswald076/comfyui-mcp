import { describe, expect, it } from "vitest";
import { registerWorkflowVisualizeTools } from "../../tools/workflow-visualize.js";
import { registerWorkflowLibraryTools } from "../../tools/workflow-library.js";
import { buildPanelToolDefs } from "../../orchestrator/panel-tools.js";

/**
 * #557 — "Show me what is on the canvas right now" was the ONE task 3 of 7 local
 * models got wrong, and they all got it wrong the same way: they dispatched a
 * REAL, semantically adjacent tool (visualize_workflow or panel_query_graph)
 * instead of panel_graph_outline. A valid name means the host dispatches it, so
 * nothing errors — the user just gets something else entirely.
 *
 * Small models weight the OPENING of a description far more than the body, so the
 * property that has to hold is about the first clause, not the paragraph:
 *
 *  1. Every tool in the read-a-graph family opens on a DIFFERENT verb phrase, so
 *     none of them can be picked by matching the same leading words.
 *  2. Exactly one of them — panel_graph_outline — claims the live canvas up front.
 *  3. Every other member explicitly disclaims it BY NAME, so a model that starts
 *     down the wrong path is told where to go instead.
 *
 * Asserting on the leading phrase is deliberate. A test that only checked "the
 * word canvas appears somewhere" passes on the exact wording that shipped the bug.
 */

/** Capture (name, description) from server.tool(name, description, …) registrations. */
function captureToolDescriptions(
  register: (server: { tool: (...args: unknown[]) => void }) => void,
): Map<string, string> {
  const descriptions = new Map<string, string>();
  register({
    tool: (...args: unknown[]) => {
      const [name, description] = args;
      if (typeof name === "string" && typeof description === "string") {
        descriptions.set(name, description);
      }
    },
  });
  return descriptions;
}

const core = new Map<string, string>([
  ...captureToolDescriptions(registerWorkflowVisualizeTools as never),
  ...captureToolDescriptions(registerWorkflowLibraryTools as never),
]);
const panel = new Map(buildPanelToolDefs().map((d) => [d.name, d.description]));

const describeTool = (name: string): string => core.get(name) ?? panel.get(name) ?? "";

/** The tools a model might reach for when asked to "look at the workflow". */
const FAMILY = [
  "panel_graph_outline",
  "panel_query_graph",
  "panel_find_nodes",
  "panel_view_nodes_in_viewport",
  "panel_screenshot",
  "visualize_workflow",
  "visualize_workflow_hierarchical",
  "query_workflow",
  "analyze_workflow",
  "get_workflow",
] as const;

/**
 * What a small model actually reads first. Normalised so that a difference in
 * punctuation or casing cannot masquerade as a difference in meaning.
 */
function leadingPhrase(description: string, chars = 48): string {
  return description
    .slice(0, chars)
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

describe("graph-reading tool descriptions are distinguishable (#557)", () => {
  it("registers every tool in the family with a description", () => {
    for (const name of FAMILY) {
      expect(describeTool(name).length, `${name} has no description`).toBeGreaterThan(0);
    }
  });

  it("gives every tool in the family a DISTINCT leading phrase", () => {
    const byLead = new Map<string, string[]>();
    for (const name of FAMILY) {
      const lead = leadingPhrase(describeTool(name));
      byLead.set(lead, [...(byLead.get(lead) ?? []), name]);
    }
    const collisions = [...byLead.entries()].filter(([, names]) => names.length > 1);
    expect(collisions, "tools opening on the same words are picked by coin flip").toEqual([]);
  });

  it("gives every tool in the family a distinct FIRST WORD-PAIR", () => {
    // Stricter than the phrase check and the one that actually bit: two
    // descriptions can differ by character 40 and still both open "QUERY the
    // workflow …", which is all a 4B model weights.
    const opens = FAMILY.map((name) => leadingPhrase(describeTool(name)).split(" ").slice(0, 2).join(" "));
    expect(new Set(opens).size, `duplicate openings in ${JSON.stringify(opens)}`).toBe(FAMILY.length);
  });

  describe("panel_graph_outline is the single live-canvas reader", () => {
    const desc = describeTool("panel_graph_outline");

    it("claims the LIVE CANVAS in its opening clause", () => {
      expect(leadingPhrase(desc)).toContain("live canvas");
    });

    it("quotes the phrasing that mis-dispatched, so the match is lexical", () => {
      expect(desc.toLowerCase()).toContain("show me what's on the canvas");
    });

    it("names both tools it was confused with, as NOT-this", () => {
      // Naming them is the whole mechanism: the model has already surfaced those
      // two candidates, and the description rules them out where it is looking.
      expect(desc).toContain("visualize_workflow");
      expect(desc).toContain("panel_query_graph");
      expect(desc).toMatch(/NOT visualize_workflow/);
      expect(desc).toMatch(/NOT panel_query_graph/);
    });
  });

  describe("every other family member disclaims the live canvas by name", () => {
    // panel_view_selected is excluded on purpose: "what the user has SELECTED" is
    // a different question, not a competing answer to the same one.
    const OTHERS = FAMILY.filter((n) => n !== "panel_graph_outline");

    for (const name of OTHERS) {
      it(`${name} points at panel_graph_outline instead`, () => {
        expect(describeTool(name)).toContain("panel_graph_outline");
      });
    }
  });

  describe("the file-based readers say FILE, the panel ones say canvas", () => {
    for (const name of ["visualize_workflow", "query_workflow", "analyze_workflow", "get_workflow"]) {
      it(`${name} states up front that its input is passed in / on disk`, () => {
        const lead = leadingPhrase(describeTool(name), 90);
        expect(lead).toMatch(/pass in|saved|file|json/);
      });
    }
  });

  /**
   * The ratchet, and the only part of this file that can catch a tool NOBODY has
   * thought about yet. Everything above asserts over a hand-written FAMILY list,
   * so a new tool that opens by offering to show the user their canvas is invisible
   * to it — which is how panel_screenshot sat there as an untested competitor for
   * the exact failing prompt while the list-based checks were all green.
   *
   * So: scan the WHOLE surface. Any tool whose OPENING both names the live canvas
   * and offers to show/read it is claiming the query panel_graph_outline exists to
   * answer, and must therefore hand the model back to panel_graph_outline somewhere
   * in its description. Only panel_graph_outline itself is exempt.
   */
  it("lets no other tool on the surface open by claiming to show the live canvas", () => {
    const NAMES_THE_CANVAS = /live canvas|on the canvas|currently viewing|current(ly)? open graph|the canvas the user/i;
    const OFFERS_TO_SHOW_IT = /\b(read|reads|show|shows|see|view|render|renders|display|describe|outline|dump)\b/i;

    const offenders: string[] = [];
    for (const [name, description] of [...core, ...panel]) {
      if (name === "panel_graph_outline") continue;
      const opening = description.slice(0, 140);
      if (!NAMES_THE_CANVAS.test(opening) || !OFFERS_TO_SHOW_IT.test(opening)) continue;
      if (!description.includes("panel_graph_outline")) offenders.push(name);
    }

    expect(
      offenders,
      "these open by offering to show the live canvas but never point at panel_graph_outline, " +
        "so a small model asked 'show me what's on the canvas' can land on them and nothing errors",
    ).toEqual([]);
  });

  it("keeps the descriptions short enough for a small model to read", () => {
    // Not a style rule: these compete for attention inside a 178-tool prompt, and
    // the failing models degrade as the block grows. The bound is a ratchet
    // against the paragraph creeping back, not a target.
    for (const name of ["panel_graph_outline", "visualize_workflow"]) {
      expect(describeTool(name).length, `${name} description is growing again`).toBeLessThan(1200);
    }
  });
});
