import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  addExtraPath,
  EXTRA_PATH_TARGETS,
  listExtraPaths,
  removeExtraPath,
} from "../services/extra-paths.js";
import { errorToToolResult } from "../utils/errors.js";

const targetSchema = z.enum(EXTRA_PATH_TARGETS);

const targetArgs = {
  target: targetSchema
    .optional()
    .describe(
      "Config target. auto (default) is LIVE-FIRST: the running ComfyUI's own " +
        "--extra-model-paths-config, else the extra_model_paths.yaml next to its main.py. " +
        "When no server is reachable, auto shows the Desktop config if one exists, otherwise " +
        "standalone. When a reachable LOCAL server does not expose main.py, listing degrades to " +
        "the server-named config (if it exists here) or the local auto-selected one, explicitly " +
        "marked as an unconfirmed display fallback; mutations refuse instead. " +
        "standalone forces <ComfyUI root>/extra_model_paths.yaml, " +
        "where the root is COMFYUI_PATH (or an auto-detected install) and falls back to the " +
        "saved default workspace; desktop forces the OS app-data extra_models_config.yaml. " +
        "Use standalone/desktop (or config_path) to deliberately target a file the running " +
        "server does not read.",
    ),
  config_path: z
    .string()
    .optional()
    .describe("Explicit YAML config path override, mainly for advanced/manual installs."),
};

const mutationArgs = {
  ...targetArgs,
  group: z
    .string()
    .optional()
    .describe("Top-level YAML group to edit. Defaults to comfyui_mcp."),
  category: z
    .string()
    .min(1)
    .describe(
      "ComfyUI search-path category, e.g. checkpoints, loras, vae, diffusion_models, unet_gguf, or custom_nodes.",
    ),
  path: z
    .string()
    .min(1)
    .describe(
      "Directory path to add/remove for that category. Absolute paths are safest; relative paths are resolved by ComfyUI.",
    ),
};

export function registerExtraPathsTools(server: McpServer): void {
  server.tool(
    "list_extra_paths",
    "View ComfyUI extra search-path config for standalone/manual installs and ComfyUI Desktop. " +
      "Resolves LIVE-FIRST: the file the running ComfyUI actually reads (its " +
      "--extra-model-paths-config, else the extra_model_paths.yaml beside its main.py), falling " +
      "back to the local heuristic only when no server is reachable — <ComfyUI root>/" +
      "extra_model_paths.yaml (COMFYUI_PATH, else the saved default workspace from " +
      "workspace action:\"set_default\") or the Desktop app-data extra_models_config.yaml. Reports generic " +
      "categories, so model categories and custom_nodes entries are both visible when present. " +
      "Read-only. Because it is read-only it never refuses a reachable LOCAL server just " +
      "because its argv does not prove which file it reads: it shows the server-named config " +
      "when that file exists here, else the local auto-selected one, always labelled as " +
      "unconfirmed rather than presented as the live server's. add_extra_path/remove_extra_path " +
      "still refuse in that state — a write to an unproven file would be a silent no-op.",
    targetArgs,
    async (args) => {
      try {
        const result = await listExtraPaths({
          target: args.target,
          configPath: args.config_path,
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "add_extra_path",
    "Add a directory to a ComfyUI extra search-path YAML config. Use this for " +
      "model categories such as checkpoints/loras/vae and, on ComfyUI builds that " +
      "support it, custom_nodes. Writes the config file and returns the updated view; restart ComfyUI to apply.",
    {
      ...mutationArgs,
      is_default: z
        .boolean()
        .optional()
        .describe("Set is_default on a newly-created group. Existing groups are not overwritten."),
    },
    async (args) => {
      try {
        const result = await addExtraPath({
          target: args.target,
          configPath: args.config_path,
          group: args.group,
          category: args.category,
          path: args.path,
          isDefault: args.is_default,
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "remove_extra_path",
    "Remove a directory from a ComfyUI extra search-path YAML config. Matches the stored path exactly. " +
      "Restart ComfyUI after removing an active path.",
    mutationArgs,
    async (args) => {
      try {
        const result = await removeExtraPath({
          target: args.target,
          configPath: args.config_path,
          group: args.group,
          category: args.category,
          path: args.path,
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}
