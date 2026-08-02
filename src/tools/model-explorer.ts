// Model Explorer metadata-curation tools, on the SHARED comfyui MCP surface so
// EVERY backend (Claude, Kimi, Codex, Gemini, Grok, Ollama…) can call them — not
// just the panel/Claude in-process path. They HTTP-proxy the ComfyUI
// `comfyui-model-explorer` node's routes (the node is the single source of truth
// for embedded safetensors metadata). "read" + "propose" only — the human Confirms
// the write in the diff-review window, so there is intentionally no write tool here.
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { open, readFile } from "node:fs/promises";
import { errorToToolResult } from "../utils/errors.js";
import { isRemoteMode } from "../config.js";
import { resolveExistingModelFile } from "../services/model-resolver.js";

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

// #541: model_metadata action:"fetch_civitai" proxies the OPTIONAL `comfyui-model-explorer`
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
    `model_metadata action:"fetch_civitai": CivitAI enrichment is unavailable. This is an OPTIONAL ` +
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

// ---------------------------------------------------------------------------
// #363 (reopen): local metadata fallback when the optional node is absent. A
// 404 from /model_explorer/detail used to surface as a raw isError even for
// models that exist locally — with no metadata at all. When the file is
// reachable on the LOCAL filesystem, degrade instead: return a structured
// missing-capability result carrying what comfyui-mcp can read WITHOUT the
// node (file stat, the CivitAI sidecar, the safetensors embedded __metadata__).
// ---------------------------------------------------------------------------

/** Cap on the safetensors JSON header we'll buffer — far beyond any real
 *  checkpoint/LoRA header (KBs–low MBs); guards against a corrupt/ hostile
 *  length prefix making us allocate the file's whole size. */
export const SAFETENSORS_HEADER_MAX_BYTES = 64 * 1024 * 1024;

/**
 * Extract the embedded `__metadata__` map from a safetensors file prefix
 * (8-byte little-endian header length + that many bytes of header JSON).
 * Returns null for anything that isn't a well-formed, capped header — the
 * fallback is best-effort and never throws.
 */
export function parseSafetensorsEmbeddedMetadata(buf: Buffer): Record<string, string> | null {
  if (buf.length < 8) return null;
  const headerLen = Number(buf.readBigUInt64LE(0));
  if (!Number.isSafeInteger(headerLen) || headerLen <= 0 || headerLen > SAFETENSORS_HEADER_MAX_BYTES) {
    return null;
  }
  if (buf.length < 8 + headerLen) return null;
  try {
    const header = JSON.parse(buf.toString("utf8", 8, 8 + headerLen)) as Record<string, unknown>;
    const meta = header["__metadata__"];
    if (!meta || typeof meta !== "object" || Array.isArray(meta)) return null;
    return meta as Record<string, string>;
  } catch {
    return null;
  }
}

/**
 * Read JUST the safetensors header of a local file and return its embedded
 * `__metadata__` (modelspec, ss_*, model_card/prompt_director blobs, …) — the
 * same raw evidence the Model Explorer node namespaces into its curated view.
 * Only the header bytes are touched, never the multi-GB tensor payload.
 * Non-safetensors formats (.ckpt/.pt/.bin) have no such header → null.
 */
export async function readSafetensorsEmbeddedMetadata(
  filePath: string,
): Promise<Record<string, string> | null> {
  if (!/\.safetensors$/i.test(filePath)) return null;
  let fh: Awaited<ReturnType<typeof open>> | undefined;
  try {
    fh = await open(filePath, "r");
    const lenBuf = Buffer.alloc(8);
    if ((await fh.read(lenBuf, 0, 8, 0)).bytesRead < 8) return null;
    const headerLen = Number(lenBuf.readBigUInt64LE(0));
    if (!Number.isSafeInteger(headerLen) || headerLen <= 0 || headerLen > SAFETENSORS_HEADER_MAX_BYTES) {
      return null;
    }
    const headerBuf = Buffer.alloc(headerLen);
    if ((await fh.read(headerBuf, 0, headerLen, 8)).bytesRead < headerLen) return null;
    return parseSafetensorsEmbeddedMetadata(Buffer.concat([lenBuf, headerBuf]));
  } catch {
    return null;
  } finally {
    await fh?.close().catch(() => undefined);
  }
}

/** Best-effort read of the `<file>.civitai.json` sidecar written next to each
 *  download_civitai_model install (trainedWords, baseModel, sourceUrl, …). */
async function readCivitaiSidecar(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed = JSON.parse(await readFile(`${filePath}.civitai.json`, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Build optional local evidence for a 404'd model_metadata action:"read".
 * Returns null whenever a local answer would be the WRONG answer. The caller
 * still returns a structured unavailable result without that evidence:
 *  - REMOTE mode: the model lives on the remote server's filesystem. An
 *    explicit COMFYUI_PATH on this MCP host still resolves (config.ts warns
 *    but honors it), so without this gate the fallback would return metadata
 *    from the HOST's unrelated file tree — wrong-machine data presented as
 *    the answer. The fallback is only meaningful when server and MCP host
 *    share a file tree.
 *  - The resolver matched a DIRECTORY, not a regular file — it returns dir
 *    hits so callers can craft a precise "not a file" error, and a directory
 *    has no metadata evidence to fall back on.
 *  - No local file is reachable at all: do not claim any file metadata.
 */
async function localMetadataFallback(category: string, name: string) {
  try {
    if (isRemoteMode()) return null;
    const { path, info } = await resolveExistingModelFile(`${category}/${name}`);
    if (!info.isFile()) return null;
    return {
      file: { path, size_bytes: info.size, modified: info.mtime.toISOString() },
      embedded_metadata: await readSafetensorsEmbeddedMetadata(path),
      civitai_sidecar: await readCivitaiSidecar(path),
    };
  } catch {
    return null;
  }
}

/**
 * The three Model Explorer metadata-curation tools collapsed into one
 * action-parameterized `model_metadata` tool (0.49.0 surface consolidation,
 * slice 5).
 *
 * SHAPE: a FLAT object with an `action` enum — deliberately NOT a
 * z.discriminatedUnion, which the MCP SDK renders as a schema with ZERO visible
 * parameters, hiding every input from the model.
 *
 * REQUIREDNESS: only `action` can be schema-required — `category`+`name` are
 * required by all three actions and `fields` by propose, while `note` and
 * `version_id` stay optional. Every VALUE constraint the old tools had is
 * unchanged at the zod layer; the handler enforces per-action presence and
 * names the missing field — the one deliberate behavioural difference a flat
 * enum permits. Each branch runs the identical logic the old tool ran: the same
 * fetches against the same /model_explorer/* routes, the same 404 degradations
 * (local-metadata fallback for read, CivitAI public-API fallback for
 * fetch_civitai), and the identical content blocks.
 */
export function registerModelExplorerTools(server: McpServer): void {
  server.tool(
    "model_metadata",
    "Curate a model file's embedded .safetensors metadata (Model Explorer). Driven by the `action` parameter:\n" +
      '- action:"read" — Read a model file\'s CURRENT embedded metadata + evidence, for curating it. ' +
      "Returns classify (asset_type/base/precision/rank), the current model_card and prompt_director namespaces, " +
      "read-only modelspec, top training tags (ss_tag_frequency), the Civitai description, and example prompts. " +
      "Call this FIRST when the user wants to improve/curate a model's embedded .safetensors metadata, so you " +
      "propose from real data. NOTE: this is the embedded-in-the-tensor metadata (model_card/prompt_director/" +
      "modelspec/ss_*) — NOT the separate lora_catalog. `category` = ComfyUI model folder ('loras','checkpoints'," +
      "'vae',…); `name` = filename incl. .safetensors — BOTH required for read/propose, e.g. " +
      '{action:"read", category:"loras", name:"my_model.safetensors"}. DEPENDENCY: the curated read proxies the OPTIONAL ' +
      "'comfyui-model-explorer' custom node. When that node is absent but the model file is reachable on the " +
      "LOCAL filesystem, the tool does NOT hard-fail — it degrades to a structured 'model_explorer: unavailable' " +
      "result with local evidence (file stat, the download_civitai_model sidecar, and the raw embedded " +
       "safetensors metadata). Without local filesystem access, it still returns the same structured " +
       "unavailable result, but without file evidence.\n" +
      '- action:"propose" — PROPOSE cleaned embedded metadata into the user\'s diff-review window. This does NOT write ' +
      "the file — the user sees your proposed fields vs current, edits/discusses, and their Confirm does the write. " +
      "Call whenever you have a proposal OR the user asks you to revise one; each call REPLACES the live proposal, " +
      "so send the FULL field set you're proposing. Include only fields you're confident about. Keys: display_name, " +
      "description_clean, semantic_intent, prompt_guidance, preservation_guidance, trigger_tokens[] (EXACT tokens — " +
      "never invent), activation_phrases[], negative_tokens[], tags[], compatible_families[], default_strength_model, " +
      "default_strength_clip, strength_min, strength_max. NEVER write metadata directly.\n" +
      '- action:"fetch_civitai" — READ-ONLY: pull this model\'s data from Civitai (civitai.com) — the rich description, ' +
      "trainedWords, example prompts (with the prompt text used in the sample images), tags, nsfw flag, " +
      "and source_url — WITHOUT writing anything. Call this when the embedded metadata is thin (empty " +
      "model_card/prompt_director, no ss_tag_frequency) or to flesh out details before proposing. Treat the " +
      "result as RAW input: distill the (often marketing-heavy) description, and MINE THE EXAMPLE PROMPTS for " +
      "the real trigger — the trigger is frequently ONLY in the sample prompts even when trainedWords is EMPTY " +
      "(e.g. every prompt starting with 'photo in the style of X' means X is the trigger). Adult models (civitai.red) " +
      'resolve through this same API. Then clean it up and call action:"propose". ' +
      "DEPENDENCY: automatic by-hash lookup uses the OPTIONAL 'comfyui-model-explorer' custom node. If that node " +
      "isn't installed, pass 'version_id' (the CivitAI modelVersionId) and this action degrades to CivitAI's public " +
      "REST API directly — no node, no auth. Without both the node AND a version_id it returns a clear " +
      "'optional feature unavailable' message rather than enriching.",
    {
      action: z
        .enum(["read", "propose", "fetch_civitai"])
        .describe(
          'Which metadata operation to perform. All three actions require `category` + `name`; "propose" also ' +
            'requires `fields` (optional `note`); "fetch_civitai" takes an optional `version_id`.',
        ),
      category: z
        .string()
        .optional()
        .describe("ComfyUI model folder, e.g. 'loras'. REQUIRED for all three actions."),
      name: z
        .string()
        .optional()
        .describe("model filename incl. .safetensors. REQUIRED for all three actions."),
      fields: z
        .record(z.string(), z.any())
        .optional()
        .describe('action:"propose" — REQUIRED proposed field map (see description).'),
      note: z
        .string()
        .optional()
        .describe('action:"propose" — optional one-line note about this revision.'),
      version_id: z
        .number()
        .int()
        .optional()
        .describe(
          'action:"fetch_civitai" — force a specific Civitai modelVersionId if hash lookup misses.',
        ),
    },
    async (args) => {
      try {
        // category/name/fields cannot be schema-required in a flat shape, so the
        // handler enforces per-action presence and names the missing field — the
        // same information the old per-tool schemas gave a caller.
        //
        // ABSENCE only, never falsiness: `category: ""` passed z.string() before
        // this consolidation and reached the upstream route's own error path. A
        // `!category` guard would swallow that path and answer with generic text
        // instead.
        const requireCategoryName = (action: string): { category: string; name: string } => {
          if (args.category === undefined) {
            throw new Error(
              `model_metadata action:"${action}" requires \`category\` — the ComfyUI model folder (e.g. 'loras').`,
            );
          }
          if (args.name === undefined) {
            throw new Error(
              `model_metadata action:"${action}" requires \`name\` — the model filename incl. .safetensors.`,
            );
          }
          return { category: args.category, name: args.name };
        };

        switch (args.action) {
          case "read": {
            const { category, name } = requireCategoryName("read");
            const COMFY = comfyBase();
            const q = `category=${encodeURIComponent(category)}&name=${encodeURIComponent(name)}`;
            const dr = await fetch(`${COMFY}/model_explorer/detail?${q}`);
            if (!dr.ok) {
              const body = await readBodyText(dr);
              // #363: make an absent optional route a structured unavailable
              // result; include local evidence only when it is safe to resolve.
              if (dr.status === 404) {
                const local = await localMetadataFallback(category, name);
                return okText({
                    model_explorer: "unavailable",
                    reason:
                      "GET /model_explorer/detail returned HTTP 404 — most likely the optional " +
                      "'comfyui-model-explorer' custom node is not installed on the connected ComfyUI. " +
                      "If local evidence is unavailable, this does not confirm whether the node or requested file is absent.",
                    install:
                      "Install the node via ComfyUI-Manager or install_custom_node, restart ComfyUI, " +
                      'then re-call model_metadata action:"read" for the full curated view (classify, model_card, ' +
                      "prompt_director, modelspec, tag_frequency).",
                    source: local ? "local-fallback" : "unavailable",
                    ...(local ?? {}),
                });
              }
              return errorToToolResult(explorerHttpError("detail", dr.status, body));
            }
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
          }
          case "propose": {
            const { category, name } = requireCategoryName("propose");
            if (args.fields === undefined) {
              throw new Error(
                'model_metadata action:"propose" requires `fields` — the proposed field map (see description).',
              );
            }
            const COMFY = comfyBase();
            const r = await fetch(`${COMFY}/model_explorer/proposal`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ category, name, fields: args.fields, note: args.note }),
            });
            const d = (await r.json()) as any;
            if (!r.ok || !d.ok) return errorToToolResult(new Error(d.error || `proposal HTTP ${r.status}`));
            return okText({
              pushed: true,
              seq: d.seq,
              note: "Proposal is now in the user's review window. Wait for their feedback; revise by calling this again with the full field set.",
            });
          }
          case "fetch_civitai": {
            const { category, name } = requireCategoryName("fetch_civitai");
            const COMFY = comfyBase();
            // A CivitAI modelVersionId is always a positive integer; treat anything
            // else (incl. 0) as "not supplied" so the node query and the fallback
            // agree on when we actually have an id.
            const hasVersionId = typeof args.version_id === "number" && args.version_id > 0;
            const q =
              `category=${encodeURIComponent(category)}&name=${encodeURIComponent(name)}` +
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
          }
          default: {
            // Unreachable given the zod enum, but a clear runtime guard beats a
            // silent undefined if the schema and switch ever drift apart.
            const exhaustive: never = args.action;
            throw new Error(
              `Unknown model_metadata action "${String(exhaustive)}". Expected one of: read, propose, fetch_civitai.`,
            );
          }
        }
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}
