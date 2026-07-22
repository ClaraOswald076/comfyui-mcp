import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorToToolResult } from "../utils/errors.js";
import { comfyuiFetch } from "../comfyui/fetch.js";


function comfyBase(): string {
  return (
    process.env.COMFYUI_URL ||
    (process.env.COMFYUI_PORT ? `http://127.0.0.1:${process.env.COMFYUI_PORT}` : "http://127.0.0.1:8188")
  ).replace(/\/$/, "");
}


export function registerPromptDirectorTools(server: McpServer): void {
  server.tool(
    "prompt_director_inspect",
    "Read Prompt Director's latest sanitized RUNTIME state after its nodes execute. Returns each node id, node kind, " +
      "resolved Model Explorer model/LoRA context, structured edit plan, source analysis, exact final prompt, warnings, " +
      "or Result Critic verdict. Secrets and image tensors are redacted. Use this with the live panel graph audit: graph " +
      "inspection explains wiring and widget state, while this tool explains what the nodes actually resolved and compiled. " +
      "Read-only: never changes the workflow. Pass node_id to inspect one executed Prompt Director node.",
    {
      node_id: z.string().optional().describe("Optional ComfyUI node id; omit to list all recent Prompt Director runtime states."),
    },
    async (args) => {
      try {
        const query = args.node_id ? `?node_id=${encodeURIComponent(args.node_id)}` : "";
        const response = await comfyuiFetch(`${comfyBase()}/prompt_director/inspection${query}`);
        if (!response.ok) {
          return errorToToolResult(
            new Error(
              `Prompt Director inspection HTTP ${response.status}. Is ComfyUI running with ComfyUI-PromptDirector loaded?`,
            ),
          );
        }
        const payload = await response.json();
        return {
          content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
        };
      } catch (error) {
        return errorToToolResult(error);
      }
    },
  );
}


export default registerPromptDirectorTools;
