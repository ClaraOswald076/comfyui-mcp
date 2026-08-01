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

// A 404 on a /model_explorer/* route has two possible causes: (1) the optional
// `comfyui-model-explorer` custom node isn't installed, so the route itself does
// not exist (the common case — the raw 404 that motivated #363); or (2) the node
// IS installed but reports the requested model file as not found. HTTP status
// alone can't distinguish them, so surface an actionable message covering BOTH
// rather than leaking the bare 404 or over-claiming that the node is absent. A
// `detail` string from the upstream body (when present) is appended as a hint.
// Other statuses (500, 503, …) are real upstream errors and pass through.
export function explorerHttpError(route: string, status: number, body?: string): Error {
  if (status === 404) {
    const hint = body && body.trim() ? ` Upstream detail: ${body.trim().slice(0, 200)}.` : "";
    return new Error(
      `GET /model_explorer/${route} returned HTTP 404. Most likely the optional ` +
        `'comfyui-model-explorer' custom node is not installed on the connected ComfyUI ` +
        `(install it via ComfyUI-Manager or install_custom_node, then restart). If that node ` +
        `IS installed, the 404 instead means it could not find the requested model file — ` +
        `check that 'category' (model folder) and 'name' (filename incl. .safetensors) are ` +
        `correct and the file exists.${hint}`,
    );
  }
  return new Error(`model_explorer ${route} HTTP ${status}`);
}

// #541: `model_metadata_fetch_civitai` proxies the OPTIONAL `comfyui-model-explorer`
// node, which does a local SHA256 → CivitAI by-hash lookup. When that node isn't
// installed the route 404s. Rather than hard-failing, degrade: if the caller gave a
// `version_id` we can fetch the SAME data straight from CivitAI's public REST API
// (no auth, no custom node, no hash) and return a normalized shape.
export async function fetchCivitaiVersionDirect(
  versionId: number,
): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(`https://civitai.com/api/v1/model-versions/${versionId}`);
    if (!res || !res.ok) return null;
    const v = (await res.json()) as any;
    const modelId = v?.modelId ?? null;
    const examplePrompts = Array.isArray(v?.images)
      ? v.images
          .map((im: any) => im?.meta?.prompt)
          .filter((p: any) => typeof p === "string" && p.trim().length > 0)
          .slice(0, 20)
      : [];
    return {
      _source: "civitai-public-api",
      _note: "Fetched directly from civitai.com (the optional comfyui-model-explorer node was unavailable). Version-endpoint fields only.",
      source_url: modelId
        ? `https://civitai.com/models/${modelId}?modelVersionId=${versionId}`
        : `https://civitai.com/api/v1/model-versions/${versionId}`,
      model_version_id: versionId,
      model_id: modelId,
      version_name: v?.name ?? null,
      model_name: v?.model?.name ?? null,
      model_type: v?.model?.type ?? null,
      base_model: v?.baseModel ?? null,
      nsfw: v?.model?.nsfw ?? null,
      trainedWords: Array.isArray(v?.trainedWords) ? v.trainedWords : [],
      description: v?.description ?? null,
      example_prompts: examplePrompts,
      download_url: v?.downloadUrl ?? null,
    };
  } catch {
    return null;
  }
}

// Graceful "optional feature unavailable" message for the CivitAI enrichment tool
// when the node route 404s (node absent OR node present but model not found). Points
// at the dependency-free `version_id` path so the caller can recover without the node.
export function civitaiFetchUnavailableError(body?: string, hadVersionId?: boolean): Error {
  const hint = body && body.trim() ? ` Upstream detail: ${body.trim().slice(0, 200)}.` : "";
  const recover = hadVersionId
    ? `A version_id was supplied, but the direct fallback to CivitAI's public API ` +
      `(https://civitai.com/api/v1/model-versions/<id>) also failed — that version may ` +
      `not exist, or civitai.com was unreachable.`
    : `To fetch metadata WITHOUT the node, pass 'version_id' (the CivitAI modelVersionId) — ` +
      `this tool then reads it straight from CivitAI's public API (no node, no auth).`;
  return new Error(
    `model_metadata_fetch_civitai: CivitAI enrichment is unavailable. This is an OPTIONAL ` +
      `feature that proxies the optional 'comfyui-model-explorer' custom node (its ` +
      `/model_explorer/civitai route returned 404). Most likely the node is not installed — ` +
      `install it via ComfyUI-Manager or install_custom_node and restart to enable automatic ` +
      `by-hash lookup. If that node IS installed, the 404 instead means it could not find the ` +
      `requested model file — check 'category' (model folder) and 'name' (filename incl. ` +
      `.safetensors). ${recover}${hint}`,
  );
}

async function readBodyText(res: { text?: () => Promise<string> }): Promise<string | undefined> {
  try {
    return res.text ? await res.text() : undefined;
  } catch {
    return undefined;
  }
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
        if (!dr.ok) return errorToToolResult(explorerHttpError("detail", dr.status, await readBodyText(dr)));
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
      "resolve through this same API. Then clean it up and call model_metadata_propose. " +
      "DEPENDENCY: automatic by-hash lookup uses the OPTIONAL 'comfyui-model-explorer' custom node. If that node " +
      "isn't installed, pass 'version_id' (the CivitAI modelVersionId) and this tool degrades to CivitAI's public " +
      "REST API directly — no node, no auth. Without both the node AND a version_id it returns a clear " +
      "'optional feature unavailable' message rather than enriching.",
    {
      category: z.string().describe("ComfyUI model folder, e.g. 'loras'"),
      name: z.string().describe("model filename incl. .safetensors"),
      version_id: z.number().int().optional().describe("Force a specific Civitai modelVersionId if hash lookup misses."),
    },
    async (args) => {
      try {
        const COMFY = comfyBase();
        // A CivitAI modelVersionId is always a positive integer; treat anything
        // else (incl. 0) as "not supplied" so the node query and the fallback
        // agree on when we actually have an id.
        const hasVersionId = typeof args.version_id === "number" && args.version_id > 0;
        const q =
          `category=${encodeURIComponent(args.category)}&name=${encodeURIComponent(args.name)}` +
          (hasVersionId ? `&version_id=${args.version_id}` : "");
        const r = await fetch(`${COMFY}/model_explorer/civitai?${q}`);
        if (r.ok) return okText(await r.json());
        const body = await readBodyText(r);
        // #541: the node route is unavailable. Degrade instead of hard-failing.
        // With a version_id we can satisfy the request straight from CivitAI's
        // public API (no node, no auth, no hash).
        if (r.status === 404 && hasVersionId) {
          const direct = await fetchCivitaiVersionDirect(args.version_id as number);
          if (direct) return okText(direct);
        }
        if (r.status === 404) {
          return errorToToolResult(civitaiFetchUnavailableError(body, hasVersionId));
        }
        return errorToToolResult(explorerHttpError("civitai", r.status, body));
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}
