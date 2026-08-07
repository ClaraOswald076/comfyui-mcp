import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  listApiNodes,
  getApiNodeSchema,
  generateWithApiNode,
} from "../services/api-nodes.js";
import { errorToToolResult } from "../utils/errors.js";

/**
 * MCP tool for hosted partner/API nodes (e.g. Flux/BFL, Ideogram, Kling,
 * Stability), mirroring `comfy-cli generate` (list / schema / run). These nodes
 * run on the connected ComfyUI server via its HTTP API, so they work against
 * remote servers too. See ../services/api-nodes.ts for mechanism + auth notes.
 *
 * The three API-node tools collapsed into one action-parameterized
 * `list_api_nodes` tool (0.50.0 surface consolidation, slice 7).
 *
 * SHAPE: a FLAT object with an `action` enum — deliberately NOT a
 * z.discriminatedUnion, which the MCP SDK renders as a schema with ZERO visible
 * parameters, hiding every input from the model.
 *
 * REQUIREDNESS: only `action` can be schema-required — `class_type` is required
 * for schema/generate and meaningless for list, `inputs` is required for
 * generate only, and `filter` applies to list only. Every VALUE constraint the
 * old tools had is unchanged at the zod layer; the handler enforces per-action
 * presence and names the missing field — the one deliberate behavioural
 * difference a flat enum permits. Each branch calls the same service function
 * the old tool called, with the same arguments, and returns the identical
 * content block.
 */
export function registerApiNodesTools(server: McpServer): void {
  server.tool(
    "list_api_nodes",
    "Discover and run hosted partner/API nodes on the connected ComfyUI (e.g. Flux/BFL, Ideogram, Kling, Stability). These call external image/video providers and run server-side, requiring a Comfy account/API key configured on the ComfyUI server — they spend PAID api credits, unlike a local-GPU render. Driven by the `action` parameter:\n" +
      '- action:"list" — List the API/partner nodes available on the connected ComfyUI, optionally narrowed by `filter`. Returns an empty list if the server has no API nodes (or they are disabled). Start here to find a class_type.\n' +
      '- action:"schema" — Return the input schema for one API/partner node (`class_type`) from the connected ComfyUI\'s /object_info. Lists visible inputs (with types/defaults/options), hidden inputs (server-filled auth), and outputs. Use action:"list" first to find a class_type.\n' +
      '- action:"generate" — Build a minimal single-node workflow that runs a chosen API/partner node (`class_type`) with the provided `inputs` and enqueue it. Returns immediately with the prompt_id (use queue (action:"status") / get_history for results). Do NOT pass auth credentials in inputs — the ComfyUI server injects those from its logged-in session. Use action:"schema" to discover valid inputs.',
    {
      action: z
        .enum(["list", "schema", "generate"])
        .describe(
          'Which API-node operation to perform. "list" takes an optional `filter`; "schema" requires `class_type`; "generate" requires `class_type` + `inputs` (optional `disable_random_seed`).',
        ),
      filter: z
        .string()
        .optional()
        .describe(
          'action:"list" — case-insensitive substring to narrow results, matched against class_type, display name, or category (e.g. "image", "video", "kling").',
        ),
      class_type: z
        .string()
        .optional()
        .describe(
          'The node class_type, e.g. "FluxProImageNode". REQUIRED for action:"schema" and action:"generate"; find one with action:"list".',
        ),
      inputs: z
        .record(z.string(), z.any())
        .optional()
        .describe(
          'action:"generate" — REQUIRED. Input values keyed by input name, per the node\'s schema (action:"schema").',
        ),
      disable_random_seed: z
        .boolean()
        .optional()
        .describe('action:"generate" — if true, do not randomize seed/noise_seed inputs.'),
    },
    async (args) => {
      try {
        // class_type/inputs cannot be schema-required in a flat shape, so the
        // handler enforces per-action presence and names the missing field — the
        // same information the old per-tool schemas gave a caller.
        //
        // ABSENCE only, never falsiness: `class_type: ""` passed z.string() and
        // `inputs: {}` passed z.record() before this consolidation, and both
        // reached the service, which answers with its own not-found/validation
        // error. A `!class_type` / `!inputs` guard would swallow those paths and
        // answer with generic text instead.
        const requireClassType = (action: string): string => {
          if (args.class_type === undefined) {
            throw new Error(
              `list_api_nodes action:"${action}" requires \`class_type\` — the API node class, e.g. "FluxProImageNode" (find one with action:"list").`,
            );
          }
          return args.class_type;
        };

        switch (args.action) {
          case "list": {
            const nodes = await listApiNodes(args.filter);
            const text =
              nodes.length === 0
                ? JSON.stringify(
                    {
                      count: 0,
                      nodes: [],
                      note: "No API/partner nodes found on the connected ComfyUI. They may not be installed, may be disabled (--disable-api-nodes), or the filter excluded them.",
                    },
                    null,
                    2,
                  )
                : JSON.stringify({ count: nodes.length, nodes }, null, 2);
            return { content: [{ type: "text" as const, text }] };
          }
          case "schema": {
            const schema = await getApiNodeSchema(requireClassType("schema"));
            return {
              content: [{ type: "text" as const, text: JSON.stringify(schema, null, 2) }],
            };
          }
          case "generate": {
            const classType = requireClassType("generate");
            if (args.inputs === undefined) {
              throw new Error(
                'list_api_nodes action:"generate" requires `inputs` — the input values keyed by input name, per the node\'s schema (action:"schema").',
              );
            }
            const result = await generateWithApiNode({
              class_type: classType,
              inputs: args.inputs,
              disable_random_seed: args.disable_random_seed,
            });
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify(
                    {
                      status: "enqueued",
                      prompt_id: result.prompt_id,
                      queue_remaining: result.queue_remaining,
                      // #1037 — a 200 from /prompt does not mean every output was accepted;
                      // ComfyUI queues the branches that validate and reports the rest.
                      ...(result.rejectedOutputs
                        ? { rejected_outputs: result.rejectedOutputs }
                        : {}),
                      notes: result.notes,
                      workflow: result.workflow,
                    },
                    null,
                    2,
                  ),
                },
              ],
            };
          }
          default: {
            // Unreachable given the zod enum, but a clear runtime guard beats a
            // silent undefined if the schema and switch ever drift apart.
            const exhaustive: never = args.action;
            throw new Error(
              `Unknown list_api_nodes action "${String(exhaustive)}". Expected one of: list, schema, generate.`,
            );
          }
        }
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}
