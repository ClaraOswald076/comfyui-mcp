import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { DEAD_NAMES, TOOL_NAMES } from "../../tools/vocabulary.js";

/**
 * The consolidated `list_api_nodes` tool (0.50.0 slice 7): the three API-node
 * tools folded into one action-parameterized tool. Proves the consolidation did
 * not change behaviour — every action calls the identical api-nodes service the
 * old tool called, with the same arguments and the same content block — and that
 * the flat-enum shape actually EXPOSES its parameters (the discriminated-union
 * trap renders zero params).
 */

const mocks = vi.hoisted(() => ({
  listApiNodes: vi.fn(),
  getApiNodeSchema: vi.fn(),
  generateWithApiNode: vi.fn(),
}));

vi.mock("../../services/api-nodes.js", () => ({
  listApiNodes: (...args: unknown[]) => mocks.listApiNodes(...args),
  getApiNodeSchema: (...args: unknown[]) => mocks.getApiNodeSchema(...args),
  generateWithApiNode: (...args: unknown[]) => mocks.generateWithApiNode(...args),
}));

import { registerApiNodesTools } from "../../tools/api-nodes.js";

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
  registerApiNodesTools(server as never);
  return tools;
}

/** The whole API-node surface is now ONE tool (0.50.0 slice 7). */
function handler(): Handler {
  const tools = registered();
  expect(tools).toHaveLength(1);
  expect(tools[0].name).toBe("list_api_nodes");
  return tools[0].handler;
}

const text = (res: Awaited<ReturnType<Handler>>) => res.content.map((c) => c.text).join(" ");

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
});

describe("list_api_nodes registration", () => {
  it("registers exactly one tool named `list_api_nodes` (3→1)", () => {
    const tools = registered();
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("list_api_nodes");
  });

  // The whole reason for the flat-enum shape rule: a z.discriminatedUnion renders
  // as ZERO parameters, hiding every input from the model.
  it("exposes a visible flat `action` enum with every per-action parameter", () => {
    const [{ shape }] = registered();
    // io: "input" — the conversion options the MCP SDK itself uses
    // (sdk/server/zod-json-schema-compat.js, asserted by docs-schema-parity.test.ts),
    // so this is the schema a client is actually given.
    const json = z.toJSONSchema(z.object(shape), { reused: "inline", io: "input" }) as {
      properties?: Record<string, { enum?: string[] }>;
      required?: string[];
    };
    expect(Object.keys(json.properties ?? {}).sort()).toEqual([
      "action",
      "class_type",
      "disable_random_seed",
      "filter",
      "inputs",
    ]);
    expect(json.properties?.action.enum?.slice().sort()).toEqual(["generate", "list", "schema"]);
    // Only `action` can be required — the rest are per-action, enforced in the handler.
    expect(json.required).toEqual(["action"]);
  });

  it("an unknown action returns a clear error result", async () => {
    const res = await handler()({ action: "bogus" });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/unknown list_api_nodes action/i);
    expect(text(res)).toMatch(/list, schema, generate/);
    for (const mock of Object.values(mocks)) expect(mock).not.toHaveBeenCalled();
  });
});

describe("list_api_nodes actions call the same services with the same arguments", () => {
  it('action:"list" passes filter through and returns the count+nodes JSON', async () => {
    mocks.listApiNodes.mockResolvedValueOnce([{ class_type: "FluxProImageNode" }]);
    const res = await handler()({ action: "list", filter: "flux" });
    expect(mocks.listApiNodes).toHaveBeenCalledWith("flux");
    expect(JSON.parse(text(res))).toEqual({
      count: 1,
      nodes: [{ class_type: "FluxProImageNode" }],
    });

    mocks.listApiNodes.mockResolvedValueOnce([]);
    await handler()({ action: "list" });
    expect(mocks.listApiNodes).toHaveBeenCalledWith(undefined);
  });

  // The empty-list branch carries its own explanatory note — an empty array and
  // "there are none, here is why" are different answers to the caller.
  it('action:"list" keeps the empty-result note verbatim', async () => {
    mocks.listApiNodes.mockResolvedValueOnce([]);
    const res = await handler()({ action: "list" });
    const payload = JSON.parse(text(res));
    expect(payload.count).toBe(0);
    expect(payload.nodes).toEqual([]);
    expect(payload.note).toMatch(/--disable-api-nodes/);
  });

  it('action:"schema" returns the node schema JSON for the class_type', async () => {
    mocks.getApiNodeSchema.mockResolvedValueOnce({ class_type: "FluxProImageNode", inputs: {} });
    const res = await handler()({ action: "schema", class_type: "FluxProImageNode" });
    expect(mocks.getApiNodeSchema).toHaveBeenCalledWith("FluxProImageNode");
    expect(JSON.parse(text(res))).toEqual({ class_type: "FluxProImageNode", inputs: {} });
  });

  it('action:"generate" forwards class_type/inputs/disable_random_seed exactly as before', async () => {
    mocks.generateWithApiNode.mockResolvedValueOnce({
      prompt_id: "p1",
      queue_remaining: 2,
      notes: ["n"],
      workflow: { "1": { class_type: "FluxProImageNode", inputs: {} } },
    });
    const res = await handler()({
      action: "generate",
      class_type: "FluxProImageNode",
      inputs: { prompt: "a cat" },
      disable_random_seed: true,
    });
    expect(mocks.generateWithApiNode).toHaveBeenCalledWith({
      class_type: "FluxProImageNode",
      inputs: { prompt: "a cat" },
      disable_random_seed: true,
    });
    expect(JSON.parse(text(res))).toEqual({
      status: "enqueued",
      prompt_id: "p1",
      queue_remaining: 2,
      notes: ["n"],
      workflow: { "1": { class_type: "FluxProImageNode", inputs: {} } },
    });
  });
});

describe("per-action presence guards (the flat shape cannot schema-require these)", () => {
  it("schema/generate without a class_type name the missing field and call nothing", async () => {
    for (const action of ["schema", "generate"]) {
      const res = await handler()({ action });
      expect(res.isError).toBe(true);
      expect(text(res)).toContain(`action:"${action}" requires \`class_type\``);
    }
    for (const mock of Object.values(mocks)) expect(mock).not.toHaveBeenCalled();
  });

  it('action:"generate" without `inputs` names it and calls nothing', async () => {
    const res = await handler()({ action: "generate", class_type: "FluxProImageNode" });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('action:"generate" requires `inputs`');
    expect(mocks.generateWithApiNode).not.toHaveBeenCalled();
  });

  // The guards test ABSENCE, not falsiness. An empty class_type passed z.string()
  // and an empty inputs map passed z.record() before this consolidation, and both
  // reached the service, which answers with its own not-found/validation error.
  // A `!class_type` / `!inputs` guard would swallow those paths.
  it("an explicitly empty class_type still reaches the service, as before", async () => {
    mocks.getApiNodeSchema.mockResolvedValueOnce({ error: "not found" });
    await handler()({ action: "schema", class_type: "" });
    expect(mocks.getApiNodeSchema).toHaveBeenCalledWith("");
  });

  // `inputs` gets the same `=== undefined` treatment for consistency, but note
  // the honest difference: an empty OBJECT is truthy in JS, so `!args.inputs`
  // would behave identically for `{}`, and compact.ts zod-validates before the
  // handler so `null` never arrives. The guard style is a convention here rather
  // than a behavioural fix — unlike `class_type`, where `""` is both legal and
  // falsy. The assertion still pins that `{}` is forwarded verbatim rather than
  // being normalised or rejected.
  it("an explicitly empty inputs map still reaches the service, as before", async () => {
    mocks.generateWithApiNode.mockResolvedValueOnce({ prompt_id: "p1" });
    await handler()({ action: "generate", class_type: "FluxProImageNode", inputs: {} });
    expect(mocks.generateWithApiNode).toHaveBeenCalledWith({
      class_type: "FluxProImageNode",
      inputs: {},
      disable_random_seed: undefined,
    });
  });
});

describe("the two API-node names are retired", () => {
  const old = ["get_api_node_schema", "generate_with_api_node"];

  it("each old name is in DEAD_NAMES with a `list_api_nodes` action replacement", () => {
    for (const name of old) {
      const entry = DEAD_NAMES.find((d) => d.name === name);
      expect(entry, `${name} must be declared dead`).toBeDefined();
      expect(entry!.since).toBe("0.50.0");
      expect(entry!.replacement).toContain("list_api_nodes");
    }
    expect(DEAD_NAMES.find((d) => d.name === "get_api_node_schema")!.replacement).toContain(
      '"schema"',
    );
    expect(DEAD_NAMES.find((d) => d.name === "generate_with_api_node")!.replacement).toContain(
      '"generate"',
    );
  });

  it("no old name is still in the live ledger, and `list_api_nodes` is", () => {
    for (const name of old) expect(TOOL_NAMES as readonly string[]).not.toContain(name);
    expect(TOOL_NAMES as readonly string[]).toContain("list_api_nodes");
  });
});
