import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WorkflowJSON } from "../comfyui/types.js";
import { convertToMermaid } from "../services/mermaid-converter.js";
import { parseMermaid, resolveWorkflow } from "../services/mermaid-parser.js";
import { getObjectInfo } from "../comfyui/client.js";
import { errorToToolResult, ValidationError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { detectSections } from "../services/workflow-sections.js";
import {
  generateOverview,
  generateSectionDetail,
  listSections,
  generateSummary,
} from "../services/hierarchical-mermaid.js";
import { isUiFormat, convertUiToApi } from "../services/workflow-converter.js";
import { workflowToDslAction, dslToWorkflowAction } from "./workflow-dsl.js";

function parseWorkflow(input: unknown): WorkflowJSON {
  if (typeof input === "string") {
    try {
      const parsed = JSON.parse(input);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new ValidationError("Workflow JSON must be an object with node IDs as keys");
      }
      return parsed as WorkflowJSON;
    } catch (err) {
      if (err instanceof ValidationError) throw err;
      throw new ValidationError(`Invalid JSON string: ${(err as Error).message}`);
    }
  }
  if (typeof input === "object" && input !== null && !Array.isArray(input)) {
    return input as WorkflowJSON;
  }
  throw new ValidationError("Workflow must be a JSON string or object");
}

/**
 * The five workflow-RENDERING tools collapsed into one action-parameterized
 * `visualize_workflow` tool (0.50.0 surface consolidation, slice 14): render,
 * render_hierarchical, mermaid, to_dsl and from_dsl. `visualize_workflow` is
 * the survivor and keeps its registration slot; the four retired names and
 * their replacements are the ledger's business (DEAD_NAMES in
 * src/tools/vocabulary.ts).
 *
 * One work-domain: converting BETWEEN workflow JSON and a human/LLM-legible
 * rendering of it. The two inbound directions (mermaid, from_dsl) live here
 * rather than under `create_workflow` because they are the inverse of the
 * outbound ones and share their vocabulary — the round trip is the feature.
 *
 * SHAPE: a FLAT object with an `action` enum — deliberately NOT a
 * z.discriminatedUnion, which the MCP SDK renders as a schema with ZERO visible
 * parameters, hiding every input from the model.
 *
 * REQUIREDNESS: only `action` can be schema-required — `workflow` is required
 * for render/render_hierarchical/to_dsl, `mermaid` for mermaid, `dsl` for
 * from_dsl. Presence is enforced in the handler, which NAMES the missing field,
 * and the guards test ABSENCE, not falsiness: `mermaid: ""` passed z.string()
 * before and reached parseMermaid's own answer for an empty diagram, and still
 * does.
 *
 * ONE DEFAULT MOVED, deliberately: `direction` shipped with a zod
 * `.default("LR")` on the flat renderer and NO default on the hierarchical one,
 * whose overview view falls back to "TB". A single shared field cannot carry
 * both, so the zod default is dropped and each branch applies its own —
 * `?? "LR"` for render and detail, `?? "TB"` for overview — which is byte for
 * byte what the two tools did. Keeping `.default("LR")` would have silently
 * turned every hierarchical overview left-to-right.
 */
export function registerWorkflowVisualizeTools(server: McpServer): void {
  server.tool(
    "visualize_workflow",
    "DRAW a diagram of, or convert, workflow JSON you PASS IN (a JSON string or object) — it does NOT read the user's live canvas, so for 'show me what's on the canvas' / the CURRENTLY-OPEN graph use panel_graph_outline instead. Driven by the `action` parameter:\n" +
      // Kept tight on purpose: graph-read-description-collision.test.ts bounds
      // this description, because it competes with panel_graph_outline for the
      // "look at the workflow" request and the failing models degrade as the
      // block grows (#557). One line per action, identifying verb first.
      '- action:"render" — Mermaid flowchart of the whole graph: nodes grouped by category, connections labeled by data type.\n' +
      '- action:"render_hierarchical" — the same graph SECTIONED rather than flat, which is what you want past ~20 nodes. `view` picks a compact overview, one section in detail, a text listing, or an AI-oriented structured summary.\n' +
      '- action:"mermaid" — the INVERSE of render: a Mermaid flowchart back into executable API-format workflow JSON, wired from /object_info schemas.\n' +
      '- action:"to_dsl" — API-format JSON into the compact, human/LLM-readable authoring DSL: `key <- nodeId.outputIndex` for connections, `key = <JSON>` for literals. Round-trips losslessly. (Experimental.)\n' +
      '- action:"from_dsl" — that DSL back into executable JSON, plus advisory wiring warnings when ComfyUI is reachable (the conversion succeeds either way). (Experimental.)',
    {
      action: z
        .enum(["render", "render_hierarchical", "mermaid", "to_dsl", "from_dsl"])
        .describe(
          'Which rendering/conversion to perform. "render", "render_hierarchical" and "to_dsl" require `workflow`; ' +
            '"mermaid" requires `mermaid`; "from_dsl" requires `dsl`.',
        ),
      workflow: z
        .union([z.string(), z.record(z.string(), z.any())])
        .optional()
        .describe(
          'ComfyUI workflow JSON (as a JSON string or object; API or UI format is auto-detected). REQUIRED for action:"render", action:"render_hierarchical" and action:"to_dsl" — "to_dsl" expects API format (node ID -> {class_type, inputs}).',
        ),
      show_values: z
        .boolean()
        .optional()
        .default(true)
        .describe(
          'action:"render" / action:"render_hierarchical" — Include widget values (seed, steps, cfg, etc.) in node labels (detail view only, for the hierarchical action).',
        ),
      direction: z
        .enum(["LR", "TB"])
        .optional()
        .describe(
          'action:"render" / action:"render_hierarchical" — Flowchart direction: LR (left-to-right) or TB (top-to-bottom). Default LR for "render" and for the hierarchical detail view, TB for the hierarchical overview.',
        ),
      view: z
        .enum(["overview", "detail", "list", "summary"])
        .optional()
        .default("overview")
        .describe(
          'action:"render_hierarchical" — overview: compact diagram with sections as summary nodes; ' +
            "detail: full diagram for one section; " +
            "list: text summary of all sections; " +
            "summary: structured text optimized for AI ingestion with node IDs, key settings, virtual wires, and full connection graph",
        ),
      section: z
        .string()
        .optional()
        .describe(
          'action:"render_hierarchical" — Section name to show in detail view (required when view=detail). ' +
            "Use view=list to see available section names.",
        ),
      mermaid: z
        .string()
        .optional()
        .describe(
          'action:"mermaid" (REQUIRED) — Mermaid flowchart text (with or without ```mermaid code fence). ' +
            "Nodes should use ComfyUI class_type names as labels. " +
            "Connections should be labeled with data types (e.g., -->|MODEL|).",
        ),
      dsl: z.string().optional().describe('action:"from_dsl" (REQUIRED) — Workflow DSL text'),
    },
    async (args) => {
      try {
        // `workflow`/`mermaid`/`dsl` cannot be schema-required in a flat shape, so
        // the handler enforces per-action presence and NAMES the missing field.
        //
        // ABSENCE only, never falsiness: `dsl: ""` and `mermaid: ""` passed
        // z.string() before this consolidation and reached their parsers, which
        // answer for an empty document themselves. A `!dsl` guard would swallow
        // that path and substitute generic text.
        const requireWorkflow = (action: string): unknown => {
          if (args.workflow === undefined) {
            throw new Error(
              `visualize_workflow action:"${action}" requires \`workflow\` — the workflow JSON to render.`,
            );
          }
          return args.workflow;
        };

        switch (args.action) {
          case "render": {
            logger.info("Visualizing workflow");
            let parsed = parseWorkflow(requireWorkflow("render"));

            // Auto-detect and convert UI format
            if (isUiFormat(parsed)) {
              const objectInfo = await getObjectInfo();
              const converted = convertUiToApi(parsed as never, objectInfo);
              parsed = converted.workflow;
            }

            const nodeCount = Object.keys(parsed).length;
            if (nodeCount === 0) {
              throw new ValidationError("Workflow contains no nodes");
            }

            const mermaid = convertToMermaid(parsed, {
              showValues: args.show_values,
              direction: args.direction ?? "LR",
            });

            return {
              content: [
                {
                  type: "text",
                  text: `\`\`\`mermaid\n${mermaid}\n\`\`\``,
                },
              ],
            };
          }
          case "render_hierarchical":
            return await renderHierarchicalAction({
              view: args.view,
              section: args.section,
              workflow: requireWorkflow("render_hierarchical"),
              show_values: args.show_values,
              direction: args.direction,
            });
          case "mermaid": {
            if (args.mermaid === undefined) {
              throw new Error(
                'visualize_workflow action:"mermaid" requires `mermaid` — the flowchart text to convert back into workflow JSON.',
              );
            }
            return await mermaidToWorkflowAction(args.mermaid);
          }
          case "to_dsl":
            // parseWorkflow is a NO-OP for the object form the retired to-DSL
            // tool accepted — it returns a non-array object unchanged — so that
            // path calls workflowToDsl with the identical argument it always did.
            //
            // It additionally lets a JSON STRING through, which that tool's
            // record-only schema rejected. That is deliberate, and the reason is
            // the shared field: `workflow` MUST accept the string form for the
            // render actions, so refusing it here would refuse, for one action,
            // exactly the value the schema advertises for the field — a false
            // refusal, which is a defect, where accepting it can only produce the
            // same DSL the equivalent object produces. The equivalence is pinned
            // in workflow-visualize.test.ts rather than asserted here.
            return workflowToDslAction(parseWorkflow(requireWorkflow("to_dsl")));
          case "from_dsl": {
            if (args.dsl === undefined) {
              throw new Error(
                'visualize_workflow action:"from_dsl" requires `dsl` — the DSL text to convert into workflow JSON.',
              );
            }
            return await dslToWorkflowAction(args.dsl);
          }
          default: {
            // Unreachable given the zod enum, but a clear runtime guard beats a
            // silent undefined if the schema and switch ever drift apart.
            const exhaustive: never = args.action;
            throw new Error(
              `Unknown visualize_workflow action "${String(exhaustive)}". Expected one of: render, render_hierarchical, mermaid, to_dsl, from_dsl.`,
            );
          }
        }
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}

/**
 * `visualize_workflow (action:"mermaid")` — the body of the retired
 * mermaid-to-JSON tool, verbatim.
 */
async function mermaidToWorkflowAction(
  mermaid: string,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  logger.info("Converting mermaid to workflow");

  // Parse the mermaid text into nodes and edges
  const parsed = parseMermaid(mermaid);
  logger.info(`Parsed ${parsed.nodes.size} nodes and ${parsed.edges.length} edges`);

  // Fetch node definitions from ComfyUI for schema resolution
  const objectInfo = await getObjectInfo();

  // Resolve into a valid workflow
  const { workflow, warnings } = resolveWorkflow(parsed, objectInfo);

  const nodeCount = Object.keys(workflow).length;
  const connectionCount = Object.values(workflow).reduce(
    (count, node) =>
      count +
      Object.values(node.inputs).filter(
        (v) =>
          Array.isArray(v) &&
          v.length === 2 &&
          typeof v[0] === "string" &&
          typeof v[1] === "number",
      ).length,
    0,
  );

  const content: Array<{ type: "text"; text: string }> = [];

  // Summary
  let summary = `Converted mermaid to workflow: ${nodeCount} nodes, ${connectionCount} connections.`;
  if (warnings.length > 0) {
    summary += `\n\n**Warnings (${warnings.length}):**\n${warnings.map((w) => `- ${w}`).join("\n")}`;
  }
  content.push({ type: "text", text: summary });

  // The workflow JSON
  content.push({
    type: "text",
    text: JSON.stringify(workflow, null, 2),
  });

  return { content };
}

/**
 * `visualize_workflow (action:"render_hierarchical")` — the body of the retired
 * sectioned-diagram tool, verbatim, including the per-view `direction`
 * fallbacks ("LR" for detail, "TB" for overview) that the shared schema field
 * can no longer carry.
 */
async function renderHierarchicalAction(args: {
  view: "overview" | "detail" | "list" | "summary";
  section?: string;
  workflow: unknown;
  show_values?: boolean;
  direction?: "LR" | "TB";
}): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const { view, section, show_values, direction } = args;
  logger.info(`Hierarchical visualization: view=${view}`);
  let parsed = parseWorkflow(args.workflow);

  // Fetch object_info for category-based section detection
  const objectInfo = await getObjectInfo();

  // Auto-detect and convert UI format
  if (isUiFormat(parsed)) {
    const converted = convertUiToApi(parsed as never, objectInfo);
    parsed = converted.workflow;
  }

  const nodeCount = Object.keys(parsed).length;
  if (nodeCount === 0) {
    throw new ValidationError("Workflow contains no nodes");
  }
  const detection = detectSections(parsed, objectInfo);
  const { sections, virtualEdges, nodeToSection, getSetNodeIds } = detection;

  if (view === "summary") {
    const text = generateSummary(
      parsed,
      sections,
      objectInfo,
      virtualEdges,
      nodeToSection,
      getSetNodeIds,
    );
    return {
      content: [{ type: "text" as const, text }],
    };
  }

  if (view === "list") {
    const text = listSections(parsed, sections);
    return {
      content: [{ type: "text" as const, text }],
    };
  }

  if (view === "detail") {
    if (!section) {
      const available = [...sections.keys()].join(", ");
      throw new ValidationError(
        `section parameter is required for detail view. Available sections: ${available}`,
      );
    }
    const mermaid = generateSectionDetail(parsed, sections, section, {
      showValues: show_values,
      direction: direction ?? "LR",
    });
    return {
      content: [
        {
          type: "text" as const,
          text: `\`\`\`mermaid\n${mermaid}\n\`\`\``,
        },
      ],
    };
  }

  // Default: overview
  const mermaid = generateOverview(parsed, sections, {
    direction: direction ?? "TB",
  });
  return {
    content: [
      {
        type: "text" as const,
        text: `\`\`\`mermaid\n${mermaid}\n\`\`\``,
      },
    ],
  };
}
