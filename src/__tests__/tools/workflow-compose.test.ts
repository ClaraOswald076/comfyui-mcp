import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { DEAD_NAMES, TOOL_NAMES } from "../../tools/vocabulary.js";

/**
 * The consolidated `create_workflow` tool (0.50.0 slice 14): the four
 * workflow-authoring tools folded into one action-parameterized tool. Proves the
 * consolidation did not change behaviour — every action calls the identical
 * service the old tool called, with the same arguments and the same content
 * block — and that the flat-enum shape actually EXPOSES its parameters (the
 * discriminated-union trap renders zero params).
 */

const mocks = vi.hoisted(() => ({
  createWorkflow: vi.fn(),
  modifyWorkflow: vi.fn(),
  validateWorkflow: vi.fn(),
  getObjectInfo: vi.fn(),
  backfillObjectInfo: vi.fn(),
  resetObjectInfoCache: vi.fn(),
}));

vi.mock("../../services/workflow-composer.js", () => ({
  createWorkflow: (...args: unknown[]) => mocks.createWorkflow(...args),
  modifyWorkflow: (...args: unknown[]) => mocks.modifyWorkflow(...args),
  TEMPLATE_NAMES: ["txt2img", "img2img", "upscale", "inpaint"],
}));
vi.mock("../../services/workflow-validator.js", () => ({
  validateWorkflow: (...args: unknown[]) => mocks.validateWorkflow(...args),
}));
vi.mock("../../comfyui/client.js", () => ({
  getObjectInfo: (...args: unknown[]) => mocks.getObjectInfo(...args),
  backfillObjectInfo: (...args: unknown[]) => mocks.backfillObjectInfo(...args),
  resetObjectInfoCache: (...args: unknown[]) => mocks.resetObjectInfoCache(...args),
}));

import { registerWorkflowComposeTools } from "../../tools/workflow-compose.js";

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
  registerWorkflowComposeTools(server as never);
  return tools;
}

function handler(): Handler {
  const tools = registered();
  expect(tools).toHaveLength(1);
  expect(tools[0].name).toBe("create_workflow");
  return tools[0].handler;
}

const text = (res: Awaited<ReturnType<Handler>>) => res.content.map((c) => c.text).join(" ");

const GRAPH = { "1": { class_type: "SaveImage", inputs: {} } };

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.getObjectInfo.mockResolvedValue({});
  mocks.backfillObjectInfo.mockImplementation(async (info: unknown) => info);
});

describe("create_workflow registration", () => {
  it("registers exactly one tool named `create_workflow` (4→1)", () => {
    const tools = registered();
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("create_workflow");
  });

  // The whole reason for the flat-enum shape rule: a z.discriminatedUnion renders
  // as ZERO parameters, hiding every input from the model.
  it("exposes a visible flat `action` enum with every per-action parameter", () => {
    const [{ shape }] = registered();
    const json = z.toJSONSchema(z.object(shape), { reused: "inline", io: "input" }) as {
      properties?: Record<string, { enum?: string[] }>;
      required?: string[];
    };
    expect(Object.keys(json.properties ?? {}).sort()).toEqual([
      "action",
      "health",
      "node_type",
      "operations",
      "params",
      "refresh",
      "template",
      "verbose",
      "workflow",
    ]);
    expect(json.properties?.action.enum?.sort()).toEqual([
      "create",
      "modify",
      "node_info",
      "validate",
    ]);
    // Only `action` can be required — the rest are per-action, enforced in the handler.
    expect(json.required).toEqual(["action"]);
  });

  it("keeps `template`'s value constraint at the zod layer", () => {
    const [{ shape }] = registered();
    const json = z.toJSONSchema(z.object(shape), { reused: "inline", io: "input" }) as {
      properties?: Record<string, { enum?: string[] }>;
    };
    expect(json.properties?.template.enum?.sort()).toEqual([
      "img2img",
      "inpaint",
      "txt2img",
      "upscale",
    ]);
  });

  it("an unknown action returns a clear error result", async () => {
    const res = await handler()({ action: "bogus" });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/unknown create_workflow action/i);
    expect(text(res)).toMatch(/node_info/);
  });
});

describe("create_workflow actions call the same services with the same arguments", () => {
  it('action:"create" passes template + params to createWorkflow and returns the JSON', async () => {
    mocks.createWorkflow.mockReturnValueOnce(GRAPH);
    const res = await handler()({ action: "create", template: "txt2img", params: { steps: 25 } });
    expect(mocks.createWorkflow).toHaveBeenCalledWith("txt2img", { steps: 25 });
    expect(JSON.parse(text(res))).toEqual(GRAPH);
  });

  it('action:"modify" parses the workflow and forwards the operations array unchanged', async () => {
    const ops = [{ op: "set_input", node_id: "1", input_name: "steps", value: 40 }];
    mocks.modifyWorkflow.mockReturnValueOnce({ workflow: GRAPH, added_ids: ["9"] });
    const res = await handler()({ action: "modify", workflow: GRAPH, operations: ops });
    expect(mocks.modifyWorkflow).toHaveBeenCalledWith(GRAPH, ops);
    expect(JSON.parse(text(res))).toEqual({ workflow: GRAPH, added_node_ids: ["9"] });
  });

  it('action:"modify" accepts the workflow as a JSON STRING, exactly as before', async () => {
    mocks.modifyWorkflow.mockReturnValueOnce({ workflow: GRAPH, added_ids: [] });
    await handler()({ action: "modify", workflow: JSON.stringify(GRAPH), operations: [] });
    expect(mocks.modifyWorkflow).toHaveBeenCalledWith(GRAPH, []);
  });

  it('action:"validate" forwards `health` to the validator and renders its report', async () => {
    mocks.validateWorkflow.mockResolvedValueOnce({
      valid: true,
      summary: "Workflow is valid",
      issues: [],
    });
    const res = await handler()({ action: "validate", workflow: GRAPH, health: false });
    expect(mocks.validateWorkflow).toHaveBeenCalledWith(GRAPH, { health: false });
    expect(text(res)).toContain("Workflow is valid");
    expect(text(res)).toContain("ready to execute");
  });

  it('action:"node_info" filters by node_type and returns the structural summary', async () => {
    mocks.getObjectInfo.mockResolvedValueOnce({
      KSampler: {
        input: { required: { steps: ["INT", {}] } },
        output: ["LATENT"],
        output_name: ["LATENT"],
        display_name: "KSampler",
        category: "sampling",
        description: "",
      },
      SaveImage: { input: {}, output: [], output_name: [] },
    });
    const res = await handler()({ action: "node_info", node_type: "ksampler" });
    const parsed = JSON.parse(text(res));
    expect(parsed.count).toBe(1);
    expect(parsed.nodes[0].name).toBe("KSampler");
    // No refresh requested → the memoized snapshot is NOT dropped.
    expect(mocks.resetObjectInfoCache).not.toHaveBeenCalled();
  });

  it('action:"node_info" with refresh:true drops the cache before fetching (#499)', async () => {
    mocks.getObjectInfo.mockResolvedValueOnce({});
    await handler()({ action: "node_info", refresh: true });
    expect(mocks.resetObjectInfoCache).toHaveBeenCalledTimes(1);
  });
});

describe("create_workflow per-action requiredness NAMES the missing field", () => {
  it('action:"create" without `template` says so and never calls the composer', async () => {
    const res = await handler()({ action: "create" });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('action:"create" requires `template`');
    expect(mocks.createWorkflow).not.toHaveBeenCalled();
  });

  it('action:"modify" without `workflow` says so and never calls the composer', async () => {
    const res = await handler()({ action: "modify", operations: [] });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('action:"modify" requires `workflow`');
    expect(mocks.modifyWorkflow).not.toHaveBeenCalled();
  });

  it('action:"modify" without `operations` names `operations`, not `workflow`', async () => {
    const res = await handler()({ action: "modify", workflow: GRAPH });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('action:"modify" requires `operations`');
    expect(mocks.modifyWorkflow).not.toHaveBeenCalled();
  });

  it('action:"validate" without `workflow` says so and never calls the validator', async () => {
    const res = await handler()({ action: "validate" });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('action:"validate" requires `workflow`');
    expect(mocks.validateWorkflow).not.toHaveBeenCalled();
  });

  it('action:"node_info" requires nothing and reaches /object_info', async () => {
    mocks.getObjectInfo.mockResolvedValueOnce({});
    const res = await handler()({ action: "node_info" });
    expect(res.isError).toBeUndefined();
    expect(mocks.getObjectInfo).toHaveBeenCalled();
  });

  // The guard tests ABSENCE, not falsiness: an empty-string workflow passed
  // z.union([z.string(), …]) before this consolidation and reached parseWorkflow,
  // which answers with its own "Invalid JSON string" error. A `!workflow` guard
  // would swallow that path and substitute the generic missing-field text.
  it("an explicitly empty `workflow` reaches the PARSER, not the missing-field guard", async () => {
    const res = await handler()({ action: "validate", workflow: "" });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("Invalid JSON string");
    expect(text(res)).not.toContain("requires `workflow`");
  });

  // Same shape for the node_info side: node_type:"" is a real (empty) filter that
  // the old tool forwarded, and `if (node_type)` skipping it is the PRE-EXISTING
  // behaviour — an empty filter lists everything rather than matching nothing.
  it("an explicitly empty `node_type` lists everything, as it always did", async () => {
    mocks.getObjectInfo.mockResolvedValueOnce({
      A: { input: {}, output: [], output_name: [] },
      B: { input: {}, output: [], output_name: [] },
    });
    const res = await handler()({ action: "node_info", node_type: "" });
    expect(JSON.parse(text(res)).count).toBe(2);
  });
});

describe("the three retired authoring names", () => {
  const old = ["modify_workflow", "validate_workflow", "get_node_info"];

  it("each old name is in DEAD_NAMES with a `create_workflow` replacement", () => {
    for (const name of old) {
      const entry = DEAD_NAMES.find((d) => d.name === name);
      expect(entry, `${name} must be declared dead`).toBeDefined();
      expect(entry!.since).toBe("0.50.0");
      expect(entry!.replacement).toContain("create_workflow");
    }
  });

  it("no old name is still in the live ledger, and `create_workflow` is", () => {
    for (const name of old) expect(TOOL_NAMES as readonly string[]).not.toContain(name);
    expect(TOOL_NAMES as readonly string[]).toContain("create_workflow");
  });
});
