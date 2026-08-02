import { basename } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  discoverWorkflows,
  buildToolSchema,
  applyParams,
  getWorkflowsDir,
  type DiscoveredWorkflow,
} from "../services/workflow-autoload.js";
import { enqueueWorkflow } from "../services/workflow-executor.js";
import { errorToToolResult } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { DEAD_NAMES, TOOL_NAMES } from "./vocabulary.js";

/**
 * Discover workflow JSON files in COMFYUI_WORKFLOWS_DIR (default
 * `~/.comfyui-mcp/workflows`) and register each as its own MCP tool with a
 * schema derived from its PARAM_* placeholders. Failures are logged and do
 * not abort startup.
 */
export async function registerAutoloadedWorkflows(server: McpServer): Promise<void> {
  const dir = getWorkflowsDir();
  let discovered: DiscoveredWorkflow[];
  try {
    discovered = await discoverWorkflows(dir);
  } catch (err) {
    logger.warn("Workflow autoload discovery failed", {
      dir,
      error: err instanceof Error ? err.message : err,
    });
    return;
  }

  if (discovered.length === 0) {
    logger.info("No autoloaded workflows discovered", { dir });
    return;
  }

  // A tool name here comes from a FILENAME (slugify, src/services/workflow-autoload.ts),
  // so it is user-controlled and can collide. Before this guard, saving a workflow as
  // `get_history.json` made the SDK throw "Tool get_history is already registered" and the
  // MCP server FAILED TO START — a user bricking their own install by naming a file,
  // with an error that names a tool rather than the file to rename.
  //
  // Skip and warn instead. `taken` additionally catches two saved files that
  // slugify to the same name (`My Flow.json` and `my-flow.json` both become
  // `my_flow`).
  //
  // RETIRED names are reserved too, not just live ones. Otherwise the consolidation
  // creates a worse failure than the one it removes: once a name is retired, a
  // pre-existing <name>.json stops being "skipped, name taken" and becomes a
  // REGISTERED tool, so a model still holding the old name silently ENQUEUES the
  // user's workflow instead of calling the replacement. A 404 is recoverable; a wrong
  // action that looks like it worked is not.
  const taken = new Set<string>([...TOOL_NAMES, ...DEAD_NAMES.map((d) => d.name)]);

  for (const wf of discovered) {
    if (taken.has(wf.toolName)) {
      logger.warn("Skipping autoloaded workflow: tool name already taken", {
        file: basename(wf.filePath),
        toolName: wf.toolName,
        hint: `Rename the file so it does not slugify to "${wf.toolName}".`,
      });
      continue;
    }
    taken.add(wf.toolName);

    const shape = buildToolSchema(wf.placeholders);
    const paramSummary = wf.placeholders
      .map((p) => `${p.name}:${p.type}`)
      .filter((s, i, a) => a.indexOf(s) === i)
      .join(", ");
    const description =
      `Enqueue the autoloaded ComfyUI workflow "${wf.toolName}" ` +
      `(loaded from ${basename(wf.filePath)}) for execution and return immediately ` +
      `with its prompt_id and queue position — it does NOT wait for the result; ` +
      `poll queue (action:"status") or get_history afterwards. Requires a running ComfyUI server. ` +
      `Each parameter below substitutes a PARAM_* placeholder in the saved workflow, and ` +
      `all parameters are required. Params: ${paramSummary || "(none)"}`;

    server.tool(wf.toolName, description, shape, async (args) => {
      try {
        const built = applyParams(wf.workflow, wf.placeholders, args as Record<string, unknown>);
        const result = await enqueueWorkflow(built);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  status: "enqueued",
                  tool: wf.toolName,
                  prompt_id: result.prompt_id,
                  queue_remaining: result.queue_remaining,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    });
    logger.info("Registered autoloaded workflow tool", {
      tool: wf.toolName,
      params: wf.placeholders.length,
    });
  }
}
