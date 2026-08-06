import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { DEAD_NAMES, TOOL_NAMES } from "../../tools/vocabulary.js";

/**
 * The consolidated `visualize_workflow` tool (0.50.0 slice 14): the five
 * render/convert tools folded into one action-parameterized tool. Proves every
 * action calls the identical service the old tool called, with the same
 * arguments and the same content block, and that the flat-enum shape actually
 * EXPOSES its parameters.
 *
 * The `direction` case is the one behavioural trap this fold had: the flat
 * renderer shipped a zod `.default("LR")` and the hierarchical one had NO
 * default (its overview falls back to "TB"). One shared field cannot carry both,
 * so the default moved into the handler — and a regression there silently turns
 * every hierarchical overview left-to-right.
 */

const mocks = vi.hoisted(() => ({
  convertToMermaid: vi.fn(),
  parseMermaid: vi.fn(),
  resolveWorkflow: vi.fn(),
  getObjectInfo: vi.fn(),
  isUiFormat: vi.fn(),
  convertUiToApi: vi.fn(),
  detectSections: vi.fn(),
  generateOverview: vi.fn(),
  generateSectionDetail: vi.fn(),
  listSections: vi.fn(),
  generateSummary: vi.fn(),
  workflowToDsl: vi.fn(),
  dslToWorkflow: vi.fn(),
}));

vi.mock("../../services/mermaid-converter.js", () => ({
  convertToMermaid: (...a: unknown[]) => mocks.convertToMermaid(...a),
}));
vi.mock("../../services/mermaid-parser.js", () => ({
  parseMermaid: (...a: unknown[]) => mocks.parseMermaid(...a),
  resolveWorkflow: (...a: unknown[]) => mocks.resolveWorkflow(...a),
}));
vi.mock("../../comfyui/client.js", () => ({
  getObjectInfo: (...a: unknown[]) => mocks.getObjectInfo(...a),
}));
vi.mock("../../services/workflow-converter.js", () => ({
  isUiFormat: (...a: unknown[]) => mocks.isUiFormat(...a),
  convertUiToApi: (...a: unknown[]) => mocks.convertUiToApi(...a),
}));
vi.mock("../../services/workflow-sections.js", () => ({
  detectSections: (...a: unknown[]) => mocks.detectSections(...a),
}));
vi.mock("../../services/hierarchical-mermaid.js", () => ({
  generateOverview: (...a: unknown[]) => mocks.generateOverview(...a),
  generateSectionDetail: (...a: unknown[]) => mocks.generateSectionDetail(...a),
  listSections: (...a: unknown[]) => mocks.listSections(...a),
  generateSummary: (...a: unknown[]) => mocks.generateSummary(...a),
}));
vi.mock("../../services/workflow-dsl.js", () => ({
  workflowToDsl: (...a: unknown[]) => mocks.workflowToDsl(...a),
  dslToWorkflow: (...a: unknown[]) => mocks.dslToWorkflow(...a),
}));

import { registerWorkflowVisualizeTools } from "../../tools/workflow-visualize.js";

type Handler = (args: Record<string, any>) => Promise<{
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
}>;

interface Registered {
  name: string;
  shape: z.ZodRawShape;
  handler: Handler;
}

function registered(): Registered[] {
  const tools: Registered[] = [];
  const server = {
    tool: (name: string, _desc: string, shape: z.ZodRawShape, handler: Handler) => {
      tools.push({ name, shape, handler });
    },
  };
  registerWorkflowVisualizeTools(server as never);
  return tools;
}

function handler(): Handler {
  const tools = registered();
  expect(tools).toHaveLength(1);
  expect(tools[0].name).toBe("visualize_workflow");
  return tools[0].handler;
}

const text = (res: Awaited<ReturnType<Handler>>) => res.content.map((c) => c.text).join(" ");

const GRAPH = { "1": { class_type: "SaveImage", inputs: {} } };

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.getObjectInfo.mockResolvedValue({});
  mocks.isUiFormat.mockReturnValue(false);
  mocks.convertToMermaid.mockReturnValue("flowchart LR");
  mocks.detectSections.mockReturnValue({
    sections: new Map([["Sampling", []]]),
    virtualEdges: [],
    nodeToSection: new Map(),
    getSetNodeIds: new Set(),
  });
  mocks.generateOverview.mockReturnValue("overview");
  mocks.generateSectionDetail.mockReturnValue("detail");
  mocks.listSections.mockReturnValue("list");
  mocks.generateSummary.mockReturnValue("summary");
});

describe("visualize_workflow registration", () => {
  it("registers exactly one tool named `visualize_workflow` (5→1)", () => {
    const tools = registered();
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("visualize_workflow");
  });

  it("exposes a visible flat `action` enum with every per-action parameter", () => {
    const [{ shape }] = registered();
    const json = z.toJSONSchema(z.object(shape), { reused: "inline", io: "input" }) as {
      properties?: Record<string, { enum?: string[]; default?: unknown }>;
      required?: string[];
    };
    expect(Object.keys(json.properties ?? {}).sort()).toEqual([
      "action",
      "direction",
      "dsl",
      "mermaid",
      "section",
      "show_values",
      "view",
      "workflow",
    ]);
    expect(json.properties?.action.enum?.sort()).toEqual([
      "from_dsl",
      "mermaid",
      "render",
      "render_hierarchical",
      "to_dsl",
    ]);
    expect(json.required).toEqual(["action"]);
  });

  // The trap: a schema-level default here would silently rewrite the
  // hierarchical overview's "TB" to "LR" on every call that omits `direction`.
  it("`direction` carries NO schema default — the per-action fallback owns it", () => {
    const [{ shape }] = registered();
    const json = z.toJSONSchema(z.object(shape), { reused: "inline", io: "input" }) as {
      properties?: Record<string, { default?: unknown }>;
    };
    expect(json.properties?.direction).not.toHaveProperty("default");
    // …while the defaults that were the SAME on both tools are kept at the zod layer.
    expect(json.properties?.show_values?.default).toBe(true);
    expect(json.properties?.view?.default).toBe("overview");
  });

  it("an unknown action returns a clear error result", async () => {
    const res = await handler()({ action: "bogus" });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/unknown visualize_workflow action/i);
    expect(text(res)).toMatch(/render_hierarchical/);
  });
});

describe("visualize_workflow actions call the same services with the same arguments", () => {
  it('action:"render" defaults direction to LR and fences the mermaid output', async () => {
    const res = await handler()({ action: "render", workflow: GRAPH, show_values: true });
    expect(mocks.convertToMermaid).toHaveBeenCalledWith(GRAPH, {
      showValues: true,
      direction: "LR",
    });
    expect(text(res)).toBe("```mermaid\nflowchart LR\n```");
  });

  it('action:"render" honours an explicit direction', async () => {
    await handler()({ action: "render", workflow: GRAPH, direction: "TB" });
    expect(mocks.convertToMermaid).toHaveBeenCalledWith(GRAPH, {
      showValues: undefined,
      direction: "TB",
    });
  });

  it('action:"render_hierarchical" overview defaults to TB, NOT to render\'s LR', async () => {
    const res = await handler()({ action: "render_hierarchical", workflow: GRAPH, view: "overview" });
    expect(mocks.generateOverview).toHaveBeenCalledWith(GRAPH, expect.anything(), {
      direction: "TB",
    });
    expect(text(res)).toContain("overview");
  });

  it('action:"render_hierarchical" detail defaults to LR and passes the section through', async () => {
    await handler()({
      action: "render_hierarchical",
      workflow: GRAPH,
      view: "detail",
      section: "Sampling",
      show_values: false,
    });
    expect(mocks.generateSectionDetail).toHaveBeenCalledWith(
      GRAPH,
      expect.anything(),
      "Sampling",
      { showValues: false, direction: "LR" },
    );
  });

  it('action:"render_hierarchical" view:"summary"/"list" return bare text, not a fence', async () => {
    const summary = await handler()({ action: "render_hierarchical", workflow: GRAPH, view: "summary" });
    expect(text(summary)).toBe("summary");
    const list = await handler()({ action: "render_hierarchical", workflow: GRAPH, view: "list" });
    expect(text(list)).toBe("list");
  });

  it('action:"mermaid" parses the diagram and returns summary + workflow JSON', async () => {
    mocks.parseMermaid.mockReturnValueOnce({ nodes: new Map([["a", {}]]), edges: [] });
    mocks.resolveWorkflow.mockReturnValueOnce({ workflow: GRAPH, warnings: [] });
    const res = await handler()({ action: "mermaid", mermaid: "flowchart LR\nA-->B" });
    expect(mocks.parseMermaid).toHaveBeenCalledWith("flowchart LR\nA-->B");
    expect(res.content).toHaveLength(2);
    expect(res.content[0].text).toContain("Converted mermaid to workflow: 1 nodes");
    expect(JSON.parse(res.content[1].text)).toEqual(GRAPH);
  });

  it('action:"to_dsl" hands the graph object straight to workflowToDsl', async () => {
    mocks.workflowToDsl.mockReturnValueOnce("1 SaveImage");
    const res = await handler()({ action: "to_dsl", workflow: GRAPH });
    expect(mocks.workflowToDsl).toHaveBeenCalledWith(GRAPH);
    expect(text(res)).toBe("1 SaveImage");
  });

  // The retired to-DSL tool took a record ONLY, so the shared `workflow` field
  // widens this action to the JSON-string form the render actions need. That is a
  // widening rather than a behaviour change only if the two forms reach the
  // service IDENTICALLY — which is what this asserts, rather than blessing the
  // widening on its own say-so (codex gate round 1).
  it('action:"to_dsl" reaches the service IDENTICALLY for the object and string forms', async () => {
    mocks.workflowToDsl.mockReturnValue("1 SaveImage");
    const fromObject = await handler()({ action: "to_dsl", workflow: GRAPH });
    const fromString = await handler()({ action: "to_dsl", workflow: JSON.stringify(GRAPH) });
    expect(mocks.workflowToDsl.mock.calls).toEqual([[GRAPH], [GRAPH]]);
    expect(text(fromString)).toBe(text(fromObject));
  });

  it('action:"to_dsl" still rejects a `workflow` string that is not a JSON object', async () => {
    const res = await handler()({ action: "to_dsl", workflow: "not json" });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("Invalid JSON string");
    expect(mocks.workflowToDsl).not.toHaveBeenCalled();
  });

  it('action:"from_dsl" returns the JSON first and appends advisory warnings', async () => {
    mocks.dslToWorkflow.mockReturnValueOnce(GRAPH);
    mocks.getObjectInfo.mockRejectedValueOnce(new Error("offline"));
    const res = await handler()({ action: "from_dsl", dsl: "1 SaveImage" });
    expect(mocks.dslToWorkflow).toHaveBeenCalledWith("1 SaveImage");
    // ComfyUI unreachable → conversion still succeeds, with no warnings block.
    expect(res.content).toHaveLength(1);
    expect(JSON.parse(res.content[0].text)).toEqual(GRAPH);
  });
});

describe("visualize_workflow per-action requiredness NAMES the missing field", () => {
  it('action:"render" without `workflow` says so and never renders', async () => {
    const res = await handler()({ action: "render" });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('action:"render" requires `workflow`');
    expect(mocks.convertToMermaid).not.toHaveBeenCalled();
  });

  it('action:"render_hierarchical" without `workflow` names `workflow`', async () => {
    const res = await handler()({ action: "render_hierarchical", view: "overview" });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('action:"render_hierarchical" requires `workflow`');
    expect(mocks.generateOverview).not.toHaveBeenCalled();
  });

  it('action:"to_dsl" without `workflow` names `workflow`', async () => {
    const res = await handler()({ action: "to_dsl" });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('action:"to_dsl" requires `workflow`');
    expect(mocks.workflowToDsl).not.toHaveBeenCalled();
  });

  it('action:"mermaid" without `mermaid` names `mermaid`, not `workflow`', async () => {
    const res = await handler()({ action: "mermaid" });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('action:"mermaid" requires `mermaid`');
    expect(mocks.parseMermaid).not.toHaveBeenCalled();
  });

  it('action:"from_dsl" without `dsl` names `dsl`', async () => {
    const res = await handler()({ action: "from_dsl" });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('action:"from_dsl" requires `dsl`');
    expect(mocks.dslToWorkflow).not.toHaveBeenCalled();
  });

  // ABSENCE, not falsiness. `dsl: ""` and `mermaid: ""` passed z.string() before
  // this consolidation and reached their parsers, which answer for an empty
  // document themselves. A `!dsl` guard would swallow that and substitute the
  // generic missing-field text.
  it("an explicitly empty `dsl` still reaches the parser", async () => {
    mocks.dslToWorkflow.mockReturnValueOnce({});
    mocks.getObjectInfo.mockRejectedValueOnce(new Error("offline"));
    const res = await handler()({ action: "from_dsl", dsl: "" });
    expect(mocks.dslToWorkflow).toHaveBeenCalledWith("");
    expect(text(res)).not.toContain("requires `dsl`");
  });

  it("an explicitly empty `mermaid` still reaches the parser", async () => {
    mocks.parseMermaid.mockReturnValueOnce({ nodes: new Map(), edges: [] });
    mocks.resolveWorkflow.mockReturnValueOnce({ workflow: {}, warnings: [] });
    const res = await handler()({ action: "mermaid", mermaid: "" });
    expect(mocks.parseMermaid).toHaveBeenCalledWith("");
    expect(text(res)).not.toContain("requires `mermaid`");
  });
});

describe("the four retired render/convert names", () => {
  const old = [
    "visualize_workflow_hierarchical",
    "mermaid_to_workflow",
    "workflow_to_dsl",
    "dsl_to_workflow",
  ];

  it("each old name is in DEAD_NAMES with a `visualize_workflow` replacement", () => {
    for (const name of old) {
      const entry = DEAD_NAMES.find((d) => d.name === name);
      expect(entry, `${name} must be declared dead`).toBeDefined();
      expect(entry!.since).toBe("0.50.0");
      expect(entry!.replacement).toContain("visualize_workflow");
    }
  });

  it("no old name is still in the live ledger, and `visualize_workflow` is", () => {
    for (const name of old) expect(TOOL_NAMES as readonly string[]).not.toContain(name);
    expect(TOOL_NAMES as readonly string[]).toContain("visualize_workflow");
  });
});
