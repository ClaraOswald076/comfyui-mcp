// Model Explorer metadata-curation tools, on the SHARED comfyui MCP surface so
// EVERY backend (Claude, Kimi, Codex, Gemini, Grok, Ollama…) can call them — not
// just the panel/Claude in-process path. They HTTP-proxy the ComfyUI
// `comfyui-model-explorer` node's routes (the node is the single source of truth
// for embedded safetensors metadata). "read" + "propose" only — the human Confirms
// the write in the diff-review window, so there is intentionally no write tool here.
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorToToolResult } from "../utils/errors.js";

function comfyBase(): string {
  return (
    process.env.COMFYUI_URL ||
    (process.env.COMFYUI_PORT ? `http://127.0.0.1:${process.env.COMFYUI_PORT}` : "http://127.0.0.1:8188")
  ).replace(/\/$/, "");
}

const okText = (value: unknown) => ({
  content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
});

// A 404 on any /model_explorer/* route means the optional `comfyui-model-explorer`
// custom node isn't installed on the connected ComfyUI (the route simply doesn't
// exist), NOT that the model file is missing. Surface that as an actionable
// missing-capability message rather than leaking the raw upstream 404. Other
// statuses (500, 503, …) are real upstream errors and pass through as before.
export function explorerHttpError(route: string, status: number): Error {
  if (status === 404) {
    return new Error(
      `The optional 'comfyui-model-explorer' custom node is not installed on the connected ComfyUI, ` +
        `so embedded-metadata routes are unavailable (GET /model_explorer/${route} → HTTP 404). ` +
        `Install it via ComfyUI-Manager (search "model explorer") or ` +
        `install_custom_node, then restart ComfyUI. Note: the model file itself may be present — ` +
        `only the metadata-reading node is missing.`,
    );
  }
  return new Error(`model_explorer ${route} HTTP ${status}`);
}

export function registerModelExplorerTools(server: McpServer): void {
  server.tool(
    "model_metadata_read",
    "Read a model file's CURRENT embedded metadata + evidence, for curating it (Model Explorer). " +
      "Returns classify (asset_type/base/precision/rank), the current model_card and prompt_director namespaces, " +
      "read-only modelspec, top training tags (ss_tag_frequency), the Civitai description, and example prompts. " +
      "Call this FIRST when the user wants to improve/curate a model's embedded .safetensors metadata, so you " +
      "propose from real data. NOTE: this is the embedded-in-the-tensor metadata (model_card/prompt_director/" +
      "modelspec/ss_*) — NOT the separate lora_catalog. `category` = ComfyUI model folder ('loras','checkpoints'," +
      "'vae',…); `name` = filename incl. .safetensors.",
    {
      category: z.string().describe("ComfyUI model folder, e.g. 'loras'"),
      name: z.string().describe("model filename incl. .safetensors"),
    },
    async (args) => {
      try {
        const COMFY = comfyBase();
        const q = `category=${encodeURIComponent(args.category)}&name=${encodeURIComponent(args.name)}`;
        const dr = await fetch(`${COMFY}/model_explorer/detail?${q}`);
        if (!dr.ok) return errorToToolResult(explorerHttpError("detail", dr.status));
        const detail = (await dr.json()) as any;
        let tags = null;
        try {
          const tr = await fetch(`${COMFY}/model_explorer/suggest_triggers?${q}`);
          if (tr.ok) tags = ((await tr.json()) as any).candidates;
        } catch { /* optional */ }
        return okText({
          classify: detail.classify,
          model_card: detail.namespaces?.model_card ?? {},
          prompt_director: detail.namespaces?.prompt_director ?? {},
          modelspec: detail.namespaces?.modelspec ?? {},
          description: detail.namespaces?.model_card?.description ?? null,
          example_prompts: detail.namespaces?.prompt_director?.example_prompts ?? [],
          tag_frequency_top: tags,
          compat_suggestions: detail.compat_suggestions ?? [],
        });
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "model_metadata_propose",
    "PROPOSE cleaned embedded metadata into the user's diff-review window (Model Explorer). This does NOT write " +
      "the file — the user sees your proposed fields vs current, edits/discusses, and their Confirm does the write. " +
      "Call whenever you have a proposal OR the user asks you to revise one; each call REPLACES the live proposal, " +
      "so send the FULL field set you're proposing. Include only fields you're confident about. Keys: display_name, " +
      "description_clean, semantic_intent, prompt_guidance, preservation_guidance, trigger_tokens[] (EXACT tokens — " +
      "never invent), activation_phrases[], negative_tokens[], tags[], compatible_families[], default_strength_model, " +
      "default_strength_clip, strength_min, strength_max. NEVER write metadata directly.",
    {
      category: z.string(),
      name: z.string(),
      fields: z.record(z.string(), z.any()).describe("Proposed field map (see description)."),
      note: z.string().optional().describe("Optional one-line note about this revision."),
    },
    async (args) => {
      try {
        const COMFY = comfyBase();
        const r = await fetch(`${COMFY}/model_explorer/proposal`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ category: args.category, name: args.name, fields: args.fields, note: args.note }),
        });
        const d = (await r.json()) as any;
        if (!r.ok || !d.ok) return errorToToolResult(new Error(d.error || `proposal HTTP ${r.status}`));
        return okText({
          pushed: true,
          seq: d.seq,
          note: "Proposal is now in the user's review window. Wait for their feedback; revise by calling this again with the full field set.",
        });
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "model_metadata_fetch_civitai",
    "READ-ONLY: pull this model's data from Civitai (civitai.com) — the rich description, " +
      "trainedWords, example prompts (with the prompt text used in the sample images), tags, nsfw flag, " +
      "and source_url — WITHOUT writing anything. Call this when the embedded metadata is thin (empty " +
      "model_card/prompt_director, no ss_tag_frequency) or to flesh out details before proposing. Treat the " +
      "result as RAW input: distill the (often marketing-heavy) description, and MINE THE EXAMPLE PROMPTS for " +
      "the real trigger — the trigger is frequently ONLY in the sample prompts even when trainedWords is EMPTY " +
      "(e.g. every prompt starting with 'photo in the style of X' means X is the trigger). Adult models (civitai.red) " +
      "resolve through this same API. Then clean it up and call model_metadata_propose.",
    {
      category: z.string().describe("ComfyUI model folder, e.g. 'loras'"),
      name: z.string().describe("model filename incl. .safetensors"),
      version_id: z.number().int().optional().describe("Force a specific Civitai modelVersionId if hash lookup misses."),
    },
    async (args) => {
      try {
        const COMFY = comfyBase();
        const q =
          `category=${encodeURIComponent(args.category)}&name=${encodeURIComponent(args.name)}` +
          (args.version_id ? `&version_id=${args.version_id}` : "");
        const r = await fetch(`${COMFY}/model_explorer/civitai?${q}`);
        if (!r.ok) return errorToToolResult(explorerHttpError("civitai", r.status));
        return okText(await r.json());
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}
