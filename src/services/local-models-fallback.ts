import { listLocalModels, MODEL_SUBDIRS } from "./model-resolver.js";
import { getSystemStats } from "../comfyui/client.js";
import { config } from "../config.js";

// ---------------------------------------------------------------------------
// Local-model discovery fallback for comfy_cli_models (issue #460). The
// read-only listing actions (list-folders, list-folder, search, show) don't
// actually need the separate comfy-cli executable: the connected ComfyUI
// already exposes what's installed via its /models REST endpoint (with a
// COMFYUI_PATH filesystem scan behind it). This reproduces those actions
// directly through the existing listLocalModels() path so model discovery
// keeps working on a plain local install with no comfy-cli on PATH — mirroring
// the live /object_info fallback for comfy_cli_search_nodes (#354).
// ---------------------------------------------------------------------------

/** Read-only comfy_cli_models actions that can be served without comfy-cli. */
export type LocalModelsListAction = "list-folders" | "list-folder" | "search" | "show";

export function isLocalModelsListAction(action: string): action is LocalModelsListAction {
  return action === "list-folders" || action === "list-folder" || action === "search" || action === "show";
}

export interface LocalModelsFallbackResult {
  command: string;
  data: unknown;
}

/**
 * When listLocalModels() yields nothing it may be an empty (but reachable)
 * server, OR it may mean we have no usable local source at all. The latter must
 * be a clear error rather than a silent empty list, so callers know to install
 * comfy-cli or point at a reachable ComfyUI. A local COMFYUI_PATH always counts
 * as a source; otherwise we probe the connected server cheaply via system_stats.
 */
async function assertLocalSourceAvailable(): Promise<void> {
  if (config.comfyuiPath) return;
  try {
    await getSystemStats();
    return; // server reachable — an empty result is a legitimate answer
  } catch {
    throw new Error(
      "comfy-cli was not found and no local model source is available: COMFYUI_PATH is unset and the connected ComfyUI server is unreachable. " +
        "Install comfy-cli>=1.11.1 (or set COMFY_CLI_PATH), set COMFYUI_PATH, or connect to a running ComfyUI server.",
    );
  }
}

/**
 * Serve a read-only comfy_cli_models listing action from the connected
 * ComfyUI's local models (via listLocalModels), for use when comfy-cli is
 * absent. Throws when a required argument is missing (mirrors the CLI path).
 */
export async function listLocalModelsFallback(args: {
  action: LocalModelsListAction;
  folder?: string;
  text?: string;
  type?: string;
  name?: string;
  limit?: number;
}): Promise<LocalModelsFallbackResult> {
  switch (args.action) {
    case "list-folders": {
      // comfy `models list-folders` reports the model folder names. We list
      // the folders that actually contain at least one model, keeping the
      // canonical ordering of MODEL_SUBDIRS.
      const models = await listLocalModels();
      if (models.length === 0) await assertLocalSourceAvailable();
      const present = new Set(models.map((m) => m.type));
      const folders = MODEL_SUBDIRS.filter((f) => present.has(f));
      return { command: "models list-folders", data: { folders } };
    }
    case "list-folder": {
      if (!args.folder) throw new Error("folder is required for list-folder");
      const models = await listLocalModels(args.folder);
      if (models.length === 0) await assertLocalSourceAvailable();
      const files = models.map((m) => m.name);
      return { command: `models list-folder ${args.folder}`, data: { folder: args.folder, count: files.length, files } };
    }
    case "search": {
      const models = await listLocalModels(args.type);
      if (models.length === 0) await assertLocalSourceAvailable();
      const needle = (args.text ?? "").trim().toLowerCase();
      let hits = needle ? models.filter((m) => m.name.toLowerCase().includes(needle)) : models;
      if (args.limit && args.limit > 0) hits = hits.slice(0, args.limit);
      const results = hits.map((m) => ({ name: m.name, type: m.type, path: m.path }));
      return { command: "models search", data: { count: results.length, results } };
    }
    case "show": {
      if (!args.name) throw new Error("name is required for show");
      const models = await listLocalModels();
      if (models.length === 0) await assertLocalSourceAvailable();
      const needle = args.name.toLowerCase();
      const match =
        models.find((m) => m.name.toLowerCase() === needle) ??
        models.find((m) => m.name.toLowerCase().includes(needle));
      if (!match) throw new Error(`Model '${args.name}' was not found among the connected ComfyUI's local models.`);
      return {
        command: `models show ${args.name}`,
        data: {
          name: match.name,
          type: match.type,
          path: match.path,
          size: match.size,
          modified: match.modified,
          ...(match.baseModel ? { baseModel: match.baseModel } : {}),
          ...(match.triggerWords?.length ? { triggerWords: match.triggerWords } : {}),
          ...(match.civitaiUrl ? { civitaiUrl: match.civitaiUrl } : {}),
        },
      };
    }
  }
}
