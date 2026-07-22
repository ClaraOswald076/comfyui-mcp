import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  searchHuggingFaceModels,
  listLocalModels,
  MODEL_SUBDIRS,
} from "../services/model-resolver.js";
import {
  startDownloadJob,
  getDownloadJob,
  listDownloadJobs,
  type DownloadJob,
} from "../services/download-jobs.js";
import { readDownloadProgress } from "../services/download-progress.js";
import { errorToToolResult, ModelError } from "../utils/errors.js";

/**
 * How long download_model waits before handing back a handle instead of a path.
 * Long enough that ordinary files (LoRAs, VAEs, cache hits) still return a path
 * as they always did; short enough that a big checkpoint never pins the turn.
 */
function downloadGraceMs(): number {
  const raw = Number(process.env.COMFYUI_MCP_DOWNLOAD_GRACE_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 20_000;
}

const modelTypeEnum = z.enum(MODEL_SUBDIRS);

// Download target subfolder: accept ANY relative subfolder under models/ (not
// just the standard MODEL_SUBDIRS), since custom nodes expect models in arbitrary
// or nested dirs (e.g. 'loras/<subdir>', a brand-new model type). The service
// (resolveModelSubfolder) guards against absolute paths and traversal escapes.
const downloadTargetSchema = z
  .string()
  .min(1)
  .describe(
    `Target subfolder under ComfyUI models/. Standard names: ${MODEL_SUBDIRS.join(", ")}. ` +
      `Any other relative subfolder (incl. nested like 'loras/<subdir>') is allowed; ` +
      `absolute paths and '..' escapes are rejected.`,
  );

const downloadAuthSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("bearer"),
    token: z.string().min(1).describe("Bearer token value"),
  }),
  z.object({
    type: z.literal("basic"),
    username: z.string().describe("Basic auth username"),
    password: z.string().describe("Basic auth password"),
  }),
  z.object({
    type: z.literal("header"),
    header_name: z.string().min(1).describe("HTTP header name"),
    header_value: z.string().describe("HTTP header value"),
  }),
  z.object({
    type: z.literal("query"),
    query_param: z.string().min(1).describe("Query parameter name"),
    query_value: z.string().describe("Query parameter value"),
  }),
  z.object({
    type: z.literal("s3"),
    access_key_id: z.string().min(1).describe("AWS/S3-compatible access key id"),
    secret_access_key: z.string().min(1).describe("AWS/S3-compatible secret access key"),
    session_token: z.string().optional().describe("Optional temporary session token"),
    region: z.string().optional().describe("Optional AWS region override"),
    endpoint: z.string().url().optional().describe("Optional S3-compatible endpoint for R2-style storage"),
  }),
]);

export function registerModelManagementTools(server: McpServer): void {
  server.tool(
    "search_models",
    "Search HuggingFace Hub for models usable in ComfyUI (checkpoints, LoRAs, VAEs, ControlNets, etc.). Read-only and network-only: queries HuggingFace over HTTP, does NOT require a running ComfyUI or COMFYUI_PATH and does not download anything. Returns a ranked list with modelId, author, downloads, likes, and tags. Pick a result's download URL and pass it to download_model to install it locally. For CIVITAI searches ('find a Flux LoRA on Civitai') use search_civitai_models instead — it filters by type + base model and returns ids for download_civitai_model. For packs of custom nodes (not models) use search_custom_nodes.",
    {
      query: z.string().describe("Search query (e.g. 'SDXL', 'flux', 'controlnet')"),
      filter: z
        .string()
        .optional()
        .describe("Optional HuggingFace pipeline/library tag to narrow results, e.g. 'diffusers' or 'text-to-image'"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe("Max results to return (default 10)"),
    },
    async (args) => {
      try {
        const results = await searchHuggingFaceModels(args.query, {
          filter: args.filter,
          limit: args.limit,
        });

        const text = results.length === 0
          ? `No models found for "${args.query}".`
          : results
              .map(
                (m, i) =>
                  `${i + 1}. **${m.modelId}** by ${m.author || "unknown"}\n` +
                  `   Downloads: ${m.downloads.toLocaleString()} | Likes: ${m.likes}\n` +
                  `   Tags: ${m.tags.slice(0, 5).join(", ") || "none"}`,
              )
              .join("\n\n");

        return { content: [{ type: "text", text }] };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "download_model",
    "Download a model file to the connected ComfyUI's models directory from a URL (HuggingFace, direct HTTP(S), s3://, or Azure Blob). PREFER this over a raw shell download (curl/wget) for model weights: it lands the file in the right models/ subfolder. LOCAL ComfyUI: streams to disk and surfaces live progress in the panel download tray. REMOTE ComfyUI: dispatches the fetch to the ComfyUI host via the ComfyUI-Manager install-model HTTP API (downloaded server-side; a per-request `auth` header can't be forwarded). This requires the host's Manager to run with network_mode=personal_cloud (or loopback) and a permissive security level — a stricter gate silently rejects the download, and Manager reports the queue task 'done' even on failure, so a remote dispatch does not guarantee the file landed. target_subfolder accepts any relative subfolder (incl. nested, e.g. 'loras/<subdir>').",
    {
      url: z.string().url().describe("Direct download URL for the model file"),
      target_subfolder: downloadTargetSchema,
      filename: z
        .string()
        .optional()
        .describe("Override filename (auto-detected from URL if omitted)"),
      auth: downloadAuthSchema
        .optional()
        .describe(
          "Optional per-request authentication for private/gated model URLs. " +
            "When provided it overrides built-in HuggingFace/CivitAI token handling.",
        ),
    },
    async (args) => {
      try {
        // Start it, then wait only a GRACE WINDOW rather than the whole
        // transfer. Small files (a VAE, a LoRA, a cache hit) still finish
        // inside the window and return a path exactly as before, so the common
        // case is unchanged. A multi-GB checkpoint hands back a handle instead
        // of pinning the turn for ten minutes — which is what made the agent
        // look stuck and then wrongly disclaim a download that was running.
        const { job, settled } = startDownloadJob(
          args.url,
          args.target_subfolder,
          args.filename,
          args.auth,
        );

        let timer: NodeJS.Timeout | undefined;
        await Promise.race([
          settled,
          new Promise<void>((r) => {
            timer = setTimeout(r, downloadGraceMs());
          }),
        ]);
        if (timer) clearTimeout(timer);

        if (job.status === "done") {
          return {
            content: [{ type: "text", text: `Model downloaded successfully to:\n${job.path}` }],
          };
        }
        if (job.status === "error") {
          return errorToToolResult(new ModelError(job.error ?? "Download failed", { url: args.url }));
        }

        const p = readDownloadProgress(job.id);
        const pct =
          p && p.total > 0 ? ` (${Math.floor((p.downloaded / p.total) * 100)}%)` : "";
        return {
          content: [
            {
              type: "text",
              text:
                `Download STARTED and is still running${pct} — id \`${job.id}\`.\n\n` +
                `This is NOT a failure and you must not describe it as one. The file is ` +
                `streaming to disk in the background and will land on its own.\n\n` +
                `Tell the user it is downloading, then check \`download_status\` with this id ` +
                `when they ask. Do NOT call download_model again for this URL — a repeat ` +
                `request adopts the same job rather than starting a second copy, but saying ` +
                `"I'll leave it to you" or reporting it as incomplete would be wrong.`,
            },
          ],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "download_status",
    "Check on model downloads started by download_model. Reports each download's state (downloading / done / error), its destination path once it lands, and byte progress when the panel progress channel is enabled. " +
      "Use this after download_model reports a download is still running — that means the transfer is in flight, NOT that it failed. Read-only.",
    {
      id: z
        .string()
        .optional()
        .describe("Download id from download_model. Omit to list every download this session."),
    },
    async (args) => {
      try {
        const list = args.id
          ? [getDownloadJob(args.id)].filter((j): j is DownloadJob => !!j)
          : listDownloadJobs();

        if (list.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: args.id
                  ? `No download with id \`${args.id}\`. Downloads are tracked per server session, so an id from a previous session won't resolve — check the panel download tray instead.`
                  : "No downloads have been started this session.",
              },
            ],
          };
        }

        const lines = list.map((j) => {
          const p = readDownloadProgress(j.id);
          const bytes =
            p && p.total > 0
              ? `  ${(p.downloaded / 1024 ** 3).toFixed(2)}/${(p.total / 1024 ** 3).toFixed(2)} GB (${Math.floor((p.downloaded / p.total) * 100)}%)`
              : p && p.downloaded > 0
                ? `  ${(p.downloaded / 1024 ** 3).toFixed(2)} GB so far`
                : "";
          const head = `- \`${j.id}\` **${j.status}**${bytes}`;
          const detail =
            j.status === "done"
              ? `\n    landed at: ${j.path}`
              : j.status === "error"
                ? `\n    failed: ${j.error}`
                : `\n    still streaming — started ${Math.round((Date.now() - j.started_at) / 1000)}s ago`;
          return `${head}${detail}\n    from: ${j.url}`;
        });

        return { content: [{ type: "text", text: `## Downloads\n\n${lines.join("\n")}` }] };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "list_local_models",
    "List model files available to the connected ComfyUI, grouped by type. Read-only. Queries ComfyUI's /models REST endpoint first (works with remote ComfyUI and respects extra_model_paths.yaml — symlinked / mounted dirs the install-path filesystem scan would miss), then falls back to a filesystem scan of COMFYUI_PATH/models/ when the REST endpoint is unavailable. Size and modified time are only available on the filesystem fallback path. Use to see which models are already available before generating or downloading; use search_models to discover new models on HuggingFace, then download_model to fetch them. For models fetched via download_civitai_model, any CivitAI trigger/activation words and base model are shown inline (read from the `<file>.civitai.json` sidecar) — apply those trigger words in your prompt when generating with that model. A `civitai:` line under an entry is that model's CivitAI page URL (modelId + INSTALLED modelVersionId, from the same sidecar) — use it to reference the source or check for newer versions.",
    {
      model_type: modelTypeEnum
        .optional()
        .describe(
          "Filter by model type (e.g. 'checkpoints', 'loras'). Lists all types if omitted.",
        ),
    },
    async (args) => {
      try {
        const models = await listLocalModels(args.model_type);

        if (models.length === 0) {
          const scope = args.model_type
            ? `No ${args.model_type} models found.`
            : "No local models found.";
          return { content: [{ type: "text", text: scope }] };
        }

        // Group by type
        const grouped = new Map<string, typeof models>();
        for (const m of models) {
          const list = grouped.get(m.type) ?? [];
          list.push(m);
          grouped.set(m.type, list);
        }

        const lines: string[] = [];
        for (const [type, list] of grouped) {
          lines.push(`## ${type} (${list.length})`);
          for (const m of list) {
            // Size/modified are only populated on the filesystem-scan path.
            // The HTTP /models endpoint just returns filenames, so we render
            // a bare name in that case.
            if (m.size > 0) {
              const sizeMB = (m.size / 1024 / 1024).toFixed(1);
              lines.push(`- ${m.name} (${sizeMB} MB) — modified ${m.modified}`);
            } else {
              lines.push(`- ${m.name}`);
            }
            // Surface CivitAI sidecar hints so the agent applies the trigger
            // words (and picks the right base model) when it builds a workflow.
            if (m.triggerWords && m.triggerWords.length > 0) {
              lines.push(
                `    trigger words: ${m.triggerWords.join(", ")}` +
                  (m.baseModel ? `  ·  base: ${m.baseModel}` : ""),
              );
            } else if (m.baseModel) {
              lines.push(`    base: ${m.baseModel}`);
            }
            // Provenance: the sidecar's CivitAI page URL carries the modelId
            // and the INSTALLED modelVersionId — link back to the source, and
            // let clients check whether a newer version exists on CivitAI.
            if (m.civitaiUrl) {
              lines.push(`    civitai: ${m.civitaiUrl}`);
            }
          }
          lines.push("");
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}
