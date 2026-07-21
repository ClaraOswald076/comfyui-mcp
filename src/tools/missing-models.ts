import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WorkflowJSON } from "../comfyui/types.js";
import { getObjectInfo, getSystemStats } from "../comfyui/client.js";
import { searchCivitaiModels } from "../services/civitai-resolver.js";
import { searchHuggingFaceModels } from "../services/model-resolver.js";
import {
  findMissingModels,
  resolveCandidates,
  type ModelCandidate,
  type ObjectInfoLike,
  type ResolveDeps,
} from "../services/missing-models.js";
import { errorToToolResult, ValidationError } from "../utils/errors.js";

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

/** Weight files worth offering; skip READMEs, configs, previews. */
const WEIGHT_RE = /\.(safetensors|ckpt|pt|pth|bin|gguf|sft)$/i;

/**
 * List a HuggingFace repo's weight files WITH sizes. HF search returns REPOS,
 * not files, so without this expansion a candidate has no size, no precision and
 * no fit verdict — i.e. none of what makes the list useful on a small GPU.
 *
 * Must be `/tree/main`: the plain `/api/models/{id}` response carries
 * `siblings[].rfilename` but NO size, and `?blobs=true` 400s. Verified live.
 * The repo id is `org/name` — its slash is part of the PATH, so it must not be
 * percent-encoded (encoding the whole id yields a 404).
 */
async function hfRepoFiles(repoId: string): Promise<Array<{ filename: string; size_bytes?: number }>> {
  const path = repoId.split("/").map(encodeURIComponent).join("/");
  const res = await fetch(`https://huggingface.co/api/models/${path}/tree/main`, {
    headers: process.env.HF_TOKEN ? { authorization: `Bearer ${process.env.HF_TOKEN}` } : undefined,
  });
  if (!res.ok) return [];
  const body = (await res.json()) as Array<{ type?: string; path?: string; size?: number }>;
  if (!Array.isArray(body)) return [];
  return body
    .filter((e) => e.type === "file" && typeof e.path === "string" && WEIGHT_RE.test(e.path))
    .map((e) => ({ filename: e.path as string, size_bytes: typeof e.size === "number" ? e.size : undefined }));
}

function liveDeps(): ResolveDeps {
  return {
    searchCivitai: async (query, types) => {
      const res = await searchCivitaiModels(query, { types, limit: 6 });
      return res.hits.map((h) => ({
        name: h.name,
        model_id: h.model_id,
        version_id: h.version_id,
        size_mb: h.size_mb,
        base_model: h.base_model,
      }));
    },
    searchHf: async (query) => (await searchHuggingFaceModels(query, { limit: 4 })).map((m) => ({ id: m.id })),
    hfRepoFiles,
    vramBytes: async () => {
      const stats = await getSystemStats();
      const vram = stats.devices?.[0]?.vram_total;
      return typeof vram === "number" && vram > 0 ? vram : undefined;
    },
  };
}

function human(bytes?: number): string {
  if (!bytes || bytes <= 0) return "?";
  const gb = bytes / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
}

const FIT_ICON: Record<string, string> = { fits: "✓ fits", tight: "~ tight", too_big: "✗ won't fit", unknown: "? unknown" };

function renderCandidate(c: ModelCandidate): string {
  const bits = [
    `- **${c.filename}**`,
    `${human(c.size_bytes)}`,
    c.precision === "unknown" ? "" : c.quant ? `${c.precision.toUpperCase()} ${c.quant}` : c.precision.toUpperCase(),
    c.source,
    FIT_ICON[c.fit ?? "unknown"] ?? "",
    c.base_model ? `base: ${c.base_model}` : "",
    c.match === "exact" ? "**exact name**" : c.match === "stem" ? "same name, different format" : "",
  ].filter(Boolean);
  let line = bits.join("  ·  ");
  if (c.requires_pack) line += `\n    ⚠️ needs the **${c.requires_pack}** node pack — a GGUF will NOT load in CheckpointLoaderSimple.`;
  if (c.url) line += `\n    ${c.url}`;
  else if (c.civitai_model_id) line += `\n    civitai model ${c.civitai_model_id}${c.civitai_version_id ? ` (version ${c.civitai_version_id})` : ""} → download_civitai_model`;
  return line;
}

export function registerMissingModelTools(server: McpServer): void {
  server.tool(
    "resolve_missing_models",
    "Find the model files a workflow needs but this ComfyUI does NOT have, and search CivitAI + HuggingFace for installable candidates. THE tool for 'this Template says a model is missing — go get it'. " +
      "Detects by comparing each model widget against the option list the server actually publishes, so it covers checkpoints, LoRAs, VAEs, ControlNets, UNets, CLIP and custom-pack model types without any per-node mapping. " +
      "Each candidate reports size, source, precision/quantisation (fp16 / fp8 / GGUF Q4_K_M …) and whether it FITS this GPU's VRAM — so when the exact file is too big you can see the quantised variant that isn't. " +
      "Read-only: it downloads nothing. Pass a chosen candidate to download_model (url) or download_civitai_model (id), using the reported directory as target_subfolder. " +
      "For missing custom NODE PACKS (not models) use install_workflow_dependencies instead.",
    {
      workflow: z
        .union([z.string(), z.record(z.string(), z.any())])
        .describe("ComfyUI workflow in API format (JSON string or object)"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .describe("Max candidates per missing model (default 8)."),
    },
    async (args) => {
      try {
        const workflow = parseWorkflow(args.workflow);
        const objectInfo = (await getObjectInfo()) as unknown as ObjectInfoLike;
        const missing = findMissingModels(workflow as Record<string, unknown>, objectInfo);

        if (missing.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: "## No missing models\n\nEvery model this workflow references is present on the connected ComfyUI. (If it still fails to run, check missing custom node packs with extract_workflow_dependencies.)",
              },
            ],
          };
        }

        const deps = liveDeps();
        const lines: string[] = [`## ${missing.length} missing model(s)`, ""];

        for (const m of missing) {
          lines.push(
            `### \`${m.name}\``,
            `needed by node ${m.node_id} (${m.node_type} · ${m.widget})${m.directory ? ` → installs to \`models/${m.directory}/\`` : ""}`,
            "",
          );
          const candidates = await resolveCandidates(m, deps, { limit: args.limit ?? 8 }).catch(() => []);
          if (candidates.length === 0) {
            lines.push("_No candidates found on CivitAI or HuggingFace — try search_models / search_civitai_models with a different query._", "");
            continue;
          }
          lines.push(...candidates.map(renderCandidate), "");
        }

        lines.push(
          "---",
          "Nothing was downloaded. Pick a candidate and call **download_model** (url) or **download_civitai_model** (id)" +
            ", passing the model's directory as `target_subfolder`.",
          "Names can collide across quantisations and base models — prefer an **exact name** match, and check `base:` before taking a fuzzy one.",
        );

        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}
