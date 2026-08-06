import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { DEAD_NAMES, TOOL_NAMES } from "../../tools/vocabulary.js";

/**
 * The consolidated `search_custom_nodes` tool (0.50.0 slice 12): the two
 * public-registry discovery tools folded into one action-parameterized tool.
 * `search_custom_nodes` SURVIVES as a name — only `get_node_pack_details`
 * retires, as action:"details".
 *
 * This is the tool the owner ruled should stay separate from
 * `install_custom_node`: read-only, network-only registry lookups do not belong
 * behind the same name as actions that execute third-party pack code. The
 * separation tests are therefore about REACHABILITY as much as dispatch — see
 * the admission and discovery-counter cases at the bottom.
 */

const mocks = vi.hoisted(() => ({
  searchNodes: vi.fn(),
  getNodePackDetails: vi.fn(),
}));

vi.mock("../../services/registry-client.js", () => ({
  searchNodes: (...a: unknown[]) => mocks.searchNodes(...a),
  getNodePackDetails: (...a: unknown[]) => mocks.getNodePackDetails(...a),
}));

import { registerRegistrySearchTools } from "../../tools/registry-search.js";

type Handler = (args: Record<string, any>) => Promise<{
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
}>;

interface Registered {
  name: string;
  description: string;
  shape: z.ZodRawShape;
  handler: Handler;
}

function registered(): Registered[] {
  const tools: Registered[] = [];
  const server = {
    tool: (name: string, description: string, shape: z.ZodRawShape, handler: Handler) => {
      tools.push({ name, description, shape, handler });
    },
  };
  registerRegistrySearchTools(server as never);
  return tools;
}

function handler(): Handler {
  const tools = registered();
  expect(tools).toHaveLength(1);
  expect(tools[0].name).toBe("search_custom_nodes");
  return tools[0].handler;
}

const text = (res: Awaited<ReturnType<Handler>>) => res.content.map((c) => c.text).join(" ");

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.searchNodes.mockResolvedValue([]);
  mocks.getNodePackDetails.mockResolvedValue({ name: "Pack", author: "someone" });
});

describe("search_custom_nodes registration", () => {
  it("registers exactly one tool named `search_custom_nodes` (2→1)", () => {
    const tools = registered();
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("search_custom_nodes");
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
      "id",
      "limit",
      "page",
      "query",
    ]);
    expect(json.properties?.action.enum?.sort()).toEqual(["details", "search"]);
    // Only `action` can be required — the rest are per-action, in the handler.
    expect(json.required).toEqual(["action"]);
  });

  // The point of the split, stated where a future editor will see it: this tool
  // must not grow a way to change what is installed.
  it("stays read-only — no action mutates anything", () => {
    const [{ description, shape }] = registered();
    const json = z.toJSONSchema(z.object(shape), { reused: "inline", io: "input" }) as {
      properties?: Record<string, { enum?: string[] }>;
    };
    expect(json.properties?.action.enum).toEqual(["search", "details"]);
    expect(description).toMatch(/Read-only and network-only/);
    expect(description).toMatch(/install_custom_node/);
  });

  it("an unknown action returns a clear error result", async () => {
    const res = await handler()({ action: "install" });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/unknown search_custom_nodes action/i);
    expect(text(res)).toMatch(/details/);
  });
});

describe("search_custom_nodes actions call the same services with the same arguments", () => {
  it('action:"search" passes limit/page and renders the registry list', async () => {
    mocks.searchNodes.mockResolvedValueOnce([
      { id: "comfyui-impact-pack", name: "Impact Pack", author: "ltdrdata", total_install: 9 },
    ]);
    const res = await handler()({ action: "search", query: "impact", limit: 5, page: 2 });
    expect(mocks.searchNodes).toHaveBeenCalledWith("impact", { limit: 5, page: 2 });
    expect(text(res)).toContain("1. **Impact Pack** (comfyui-impact-pack)");
    expect(text(res)).toContain("Author: ltdrdata");
    expect(mocks.getNodePackDetails).not.toHaveBeenCalled();
  });

  it('action:"search" keeps the no-results sentence', async () => {
    mocks.searchNodes.mockResolvedValueOnce([]);
    expect(text(await handler()({ action: "search", query: "nope" }))).toBe(
      'No custom nodes found for "nope".',
    );
  });

  it('action:"details" renders the pack markdown, including the dropped-versions note', async () => {
    mocks.getNodePackDetails.mockResolvedValueOnce({
      name: "Impact Pack",
      author: "ltdrdata",
      nodes: ["ImpactDetailer"],
      versions: Array.from({ length: 7 }, (_, i) => ({ version: `1.0.${i}` })),
    });
    const res = await handler()({ action: "details", id: "comfyui-impact-pack" });
    expect(mocks.getNodePackDetails).toHaveBeenCalledWith("comfyui-impact-pack");
    expect(text(res)).toContain("# Impact Pack");
    expect(text(res)).toContain("- ImpactDetailer");
    expect(text(res)).toContain("…and 2 older version(s) not shown");
    expect(mocks.searchNodes).not.toHaveBeenCalled();
  });

  it("turns a service throw into an isError result rather than crashing", async () => {
    mocks.searchNodes.mockRejectedValueOnce(new Error("registry HTTP 503"));
    const res = await handler()({ action: "search", query: "impact" });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("registry HTTP 503");
  });
});

describe("search_custom_nodes per-action requiredness", () => {
  it('action:"search" names the missing `query`', async () => {
    const res = await handler()({ action: "search" });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('search_custom_nodes action:"search" requires `query`');
    expect(mocks.searchNodes).not.toHaveBeenCalled();
  });

  it('action:"details" names the missing `id`', async () => {
    const res = await handler()({ action: "details" });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('search_custom_nodes action:"details" requires `id`');
    expect(mocks.getNodePackDetails).not.toHaveBeenCalled();
  });
});

/**
 * ABSENCE, not falsiness. `query: ""` and `id: ""` passed z.string() before the
 * consolidation and reached the registry client, which answers for them (the
 * "no matches" path, then the exact-id retry). A `!query` guard would replace
 * that live answer with the handler's generic missing-field text.
 */
describe("search_custom_nodes guards on absence, never falsiness", () => {
  it('query:"" still reaches searchNodes', async () => {
    mocks.searchNodes.mockResolvedValueOnce([]);
    const res = await handler()({ action: "search", query: "" });
    expect(mocks.searchNodes).toHaveBeenCalledWith("", { limit: undefined, page: undefined });
    expect(text(res)).toBe('No custom nodes found for "".');
  });

  it('id:"" still reaches getNodePackDetails', async () => {
    const res = await handler()({ action: "details", id: "" });
    expect(mocks.getNodePackDetails).toHaveBeenCalledWith("");
    expect(text(res)).not.toContain("requires `id`");
  });
});

describe("the registry-discovery surface after the split", () => {
  it("`search_custom_nodes` SURVIVES — it is in the live ledger and not in DEAD_NAMES", () => {
    expect(TOOL_NAMES as readonly string[]).toContain("search_custom_nodes");
    expect(DEAD_NAMES.find((d) => d.name === "search_custom_nodes")).toBeUndefined();
  });

  it("`get_node_pack_details` retires INTO it, not into install_custom_node", () => {
    const entry = DEAD_NAMES.find((d) => d.name === "get_node_pack_details");
    expect(entry, "get_node_pack_details must be declared dead").toBeDefined();
    expect(entry!.since).toBe("0.50.0");
    expect(entry!.replacement).toBe('search_custom_nodes (action:"details")');
    expect(TOOL_NAMES as readonly string[]).not.toContain("get_node_pack_details");
  });
});
