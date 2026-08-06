import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listRegisteredTools } from "../../tools/introspect.js";
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

/**
 * The WHOLE surface, both halves of it.
 *
 * Core comes from listRegisteredTools() — the real registration pass read back
 * through a real MCP client — rather than from the two register* functions that
 * happen to hold today's suspects. Scoping the scan to a hand-picked pair of
 * modules is the same mistake as scoping it to a hand-picked list of tools: it
 * cannot see the tool nobody thought of, which is the only kind this catches.
 */
const panel = new Map(buildPanelToolDefs().map((d) => [d.name, d.description]));
const core = new Map<string, string>();

const describeTool = (name: string): string => core.get(name) ?? panel.get(name) ?? "";

const savedEnv: Record<string, string | undefined> = {};
let workflowsDir: string | undefined;

beforeAll(async () => {
  // Same isolation as registry-surface.test.ts: registerAllTools() ends by
  // registering one tool per saved workflow file, and `compact` tool mode swaps
  // the surface for 3 meta-tools. Either would make this a function of the
  // developer's machine.
  for (const key of ["COMFYUI_WORKFLOWS_DIR", "COMFYUI_MCP_TOOL_MODE"]) {
    savedEnv[key] = process.env[key];
  }
  workflowsDir = await mkdtemp(join(tmpdir(), "comfyui-mcp-desc-"));
  process.env.COMFYUI_WORKFLOWS_DIR = workflowsDir;
  delete process.env.COMFYUI_MCP_TOOL_MODE;
  for (const t of await listRegisteredTools()) core.set(t.name, t.description);
});

afterAll(async () => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (workflowsDir) await rm(workflowsDir, { recursive: true, force: true });
});

/** The tools a model might reach for when asked to "look at the workflow". */
const FAMILY = [
  "panel_graph_outline",
  "panel_query_graph",
  "panel_find_nodes",
  "panel_view_nodes_in_viewport",
  "panel_screenshot",
  // 0.50.0 slice 14: the hierarchical renderer, the saved-file query and the
  // saved-file summary are now actions on these two, so the family is the two
  // TOOL names a model chooses between — which is the level #557 is about.
  "visualize_workflow",
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
    for (const name of ["visualize_workflow", "get_workflow"]) {
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
   * Any tool whose OPENING both names the canvas and offers to show or read it is
   * claiming the question panel_graph_outline exists to answer, and must therefore
   * hand the model back to panel_graph_outline somewhere in its description. Only
   * panel_graph_outline itself is exempt.
   */
  const NAMES_THE_CANVAS = /\bcanvas\b|currently viewing|\bopen graph\b|\blive graph\b/i;
  const OFFERS_TO_SHOW_IT =
    /\b(read|reads|show|shows|see|view|views|render|renders|display|describe|outline|dump|screenshot|look)\b/i;
  // Wide enough to cover an opening PARAGRAPH, not an opening sentence. The window is
  // the whole ballgame for a scan like this and it has been wrong twice: at 140 it
  // selected a single tool while claiming whole-surface coverage, and at 260 it dropped
  // panel_canvas the moment that description was reworded. Both times the test stayed
  // GREEN, which is the failure mode — hence the non-vacuity guard below, which names
  // the tools the window must still reach so shrinking it fails loudly instead.
  const OPENING = 420;

  const claimants = (): string[] =>
    [...core, ...panel]
      .filter(([, d]) => NAMES_THE_CANVAS.test(d.slice(0, OPENING)) && OFFERS_TO_SHOW_IT.test(d.slice(0, OPENING)))
      .map(([n]) => n);

  /**
   * The EXACT set the selector reaches, written down.
   *
   * A "must contain these N" guard was the previous version and it was not enough:
   * it pinned 7 of 18, so any of the other 11 could be reworded out of scope with
   * every test still green — the same silent-shrink failure twice removed. An exact
   * set means a tool ENTERING scope must be classified (exempt with a reason, or made
   * to point at panel_graph_outline) and a tool LEAVING scope must be noticed.
   *
   * Yes, this fails when an unrelated description is reworded near these words. That
   * is the intended cost: the failure is one line to re-sort, and the alternative is a
   * scan that quietly stops scanning.
   */
  const EXPECTED_CLAIMANTS = [
    "diagnose_run",
    // 0.50.0 slice 14: get_workflow's opening now covers the whole saved-file
    // read surface, so it names the canvas to rule it OUT — and it hands the
    // model back to panel_graph_outline in the same clause, which is what the
    // last test in this file requires of a claimant.
    "get_workflow",
    "panel_canvas",
    "panel_enter_subgraph",
    "panel_find_nodes",
    "panel_get_subgraph",
    "panel_get_workflow_target",
    "panel_graph_outline",
    "panel_list_subgraphs",
    "panel_load_workflow",
    "panel_open_workflow",
    "panel_query_graph",
    "panel_run",
    "panel_screenshot",
    "panel_strip_workflow",
    "panel_view_nodes_in_viewport",
    "visualize_workflow",
  ];

  it("reaches exactly the tools it is documented to reach (the ratchet is not vacuous)", () => {
    expect(
      [...claimants()].sort(),
      "the set of descriptions that mention looking at the canvas changed. If a tool " +
        "ENTERED, decide whether it competes for 'show me the canvas' — point it at " +
        "panel_graph_outline, or exempt it in NOT_A_CANVAS_READ with a reason. If one LEFT, " +
        "check it did not simply drift out of the window while still competing.",
    ).toEqual([...EXPECTED_CLAIMANTS].sort());
  });

  /**
   * Tools the selector reaches that are NOT competing to answer "what is on the
   * canvas". Per-tool with a stated reason, never a widened regex: narrowing the
   * selector to make these disappear would take real claimants with them, and the
   * only cheap way to keep a scan honest is to make every exemption something a
   * human had to write down and a reviewer had to read.
   */
  const NOT_A_CANVAS_READ = new Map<string, string>([
    ["diagnose_run", "explains a FAILED RUN and says so — 'without needing a canvas' is why it matches"],
    ["panel_strip_workflow", "TRANSFORMS a graph into a resolved form; the result is a conversion, not a view"],
    ["panel_load_workflow", "WRITES the canvas (replaces the open graph); nothing about it answers a read"],
    ["panel_run", "QUEUES the open workflow — the canvas is the input, not the output"],
    ["panel_get_workflow_target", "reads the agent's BINDING (current vs pinned), not the graph's contents"],
    ["panel_list_subgraphs", "lists library BLUEPRINTS; the canvas is only where you would drop one"],
    ["panel_open_workflow", "SWITCHES the active tab; it mentions the canvas only to warn the tab may be stale"],
  ]);

  it("has no stale exemption (each exempted tool is still one the selector reaches)", () => {
    // An exemption for a tool the selector no longer selects is a permission nobody
    // re-reviewed, sitting there to pre-approve whatever that name becomes next.
    const inspected = new Set(claimants());
    const stale = [...NOT_A_CANVAS_READ.keys()].filter((n) => !inspected.has(n));
    expect(stale, "delete these exemptions — they no longer suppress anything").toEqual([]);
  });

  it("lets no other tool on the surface open by claiming to show the live canvas", () => {
    const offenders = claimants().filter(
      (name) =>
        name !== "panel_graph_outline" &&
        !NOT_A_CANVAS_READ.has(name) &&
        !describeTool(name).includes("panel_graph_outline"),
    );

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
