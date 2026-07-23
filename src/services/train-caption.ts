// LLM captioning for dataset images — one vision turn per image through the
// user's OWN Claude subscription (the same Agent SDK the panel agent uses),
// NOT a paid API. Deliberately a direct `query()` call, not the panel's
// ClaudeBackend: the panel persona/session machinery would bleed chat-flavored
// prose into what must be a bare caption string.
//
// Images come from readTrainingFile (contained to the training root, ≤2MB) so
// dataset files never touch the /view channel.

import { assertDatasetEditable, getDataset, updateDataset } from "./training-datasets.js";
import { buildAgentSpawnEnv } from "./panel-secrets.js";
import { trainingRoot } from "./training-jobs.js";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { extname, resolve, sep } from "node:path";

/** Captioning reads staged TRAINING images, not phone-bound display thumbs —
 *  the 2MB train_file cap is a display budget, not a property of the data
 *  (codex finding: a valid 8MP training PNG must still caption). 10MB keeps
 *  the vision context sane without rejecting real sets. Contained + image-only
 *  like readTrainingFile. */
const MAX_CAPTION_BYTES = 10 * 1024 * 1024;
const CAPTION_IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp"]);

function readCaptionFile(absPath: string): { data: string; mimeType: string } {
  let p: string;
  try {
    p = realpathSync(absPath);
  } catch {
    p = resolve(absPath);
  }
  const root = realpathSync(trainingRoot());
  const norm = (x: string) => (process.platform === "win32" ? x.toLowerCase() : x);
  if (norm(p) !== norm(root) && !norm(p).startsWith(norm(root) + sep)) {
    throw new Error("path escapes the training root");
  }
  const ext = extname(p).toLowerCase();
  if (!CAPTION_IMAGE_EXTS.has(ext)) {
    throw new Error(`only image files can be captioned (${[...CAPTION_IMAGE_EXTS].join("/")})`);
  }
  const st = statSync(p);
  if (st.size > MAX_CAPTION_BYTES) {
    throw new Error(`image too large to caption (${(st.size / 1024 / 1024).toFixed(1)} MB > 10 MB)`);
  }
  const mimeType = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
  return { data: readFileSync(p).toString("base64"), mimeType };
}

// Lazy SDK import (same pattern as claude-backend — the SDK is a heavy optional
// dependency that must not load at MCP boot).
let queryFn: typeof import("@anthropic-ai/claude-agent-sdk").query | null = null;
async function getQuery() {
  if (!queryFn) {
    const mod = await import("@anthropic-ai/claude-agent-sdk");
    queryFn = mod.query;
  }
  return queryFn;
}

/** Model used for captioning — cheap and fast by default (this is a bulk
 *  utility call on the user's subscription). Override via COMFYUI_MCP_CAPTION_MODEL. */
const CAPTION_MODEL = process.env.COMFYUI_MCP_CAPTION_MODEL?.trim() || "claude-haiku-4-5";

function captionPrompt(opts: { guide?: string; trigger?: string }): string {
  const lines = [
    "Write ONE caption for this image for LoRA training. Rules:",
    "- Describe what CHANGES between training images: pose, clothing, background, lighting, expression, framing — NOT the subject's identity (the model learns that from the set, not the captions).",
    "- One or two short comma-separated phrases. No prefix, no quotes, no commentary.",
  ];
  if (opts.trigger) lines.push(`- Start the caption EXACTLY with "${opts.trigger}, " (the set's trigger word).`);
  if (opts.guide) lines.push(`- User guidance: ${opts.guide}`);
  lines.push("Reply with ONLY the caption.");
  return lines.join("\n");
}

/** Caption ONE image (path under the training root). Returns the bare caption. */
export async function captionImage(opts: {
  imagePath: string;
  guide?: string;
  trigger?: string;
}): Promise<string> {
  const { data, mimeType } = readCaptionFile(opts.imagePath);
  const query = await getQuery();
  const userContent = [
    {
      type: "image" as const,
      source: {
        type: "base64" as const,
        media_type: mimeType as "image/png" | "image/jpeg" | "image/webp" | "image/gif",
        data,
      },
    },
    { type: "text" as const, text: captionPrompt(opts) },
  ];
  async function* turns() {
    yield {
      type: "user" as const,
      message: { role: "user" as const, content: userContent },
      parent_tool_use_id: null,
    };
  }
  // No tools, single turn — a utility call, not an agent session. The spawn
  // env is SCRUBBED of tool-only secrets (RunPod/CivitAI/HF keys) — the
  // caption subprocess has no business seeing them (codex finding; same
  // invariant as ClaudeBackend/ai-proposer).
  const q = query({
    prompt: turns(),
    options: { model: CAPTION_MODEL, maxTurns: 1, tools: [], env: buildAgentSpawnEnv() } as never,
  });
  let text = "";
  for await (const msg of q) {
    const m = msg as { type: string; message?: { content?: Array<{ type: string; text?: string }> } };
    if (m.type === "assistant" && m.message?.content) {
      text += m.message.content
        .filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("");
    }
  }
  const caption = text.trim().replace(/^["']|["']$/g, "");
  if (!caption) throw new Error("the model returned an empty caption");
  return caption;
}

export interface CaptionDatasetResult {
  captioned: number;
  failed: Array<{ file: string; error: string }>;
}

/** Caption a whole staged dataset (or a subset) and WRITE the captions into
 *  its .txt files. Sequential on purpose — a subscription isn't a rate pool. */
export async function captionDataset(
  name: string,
  opts: { guide?: string; trigger?: string; only?: string[] } = {},
): Promise<CaptionDatasetResult> {
  const detail = getDataset(name);
  // In-use check BEFORE spending subscription turns: a dataset a running job
  // trains from would reject every write anyway (codex finding — the loop
  // used to spend one vision turn per image and write zero captions).
  await assertDatasetEditable(detail.datasetPath, "captioning");
  const only = opts.only?.length ? new Set(opts.only) : null;
  const targets = detail.items.filter((it) => !only || only.has(it.file));
  if (!targets.length) throw new Error(only ? "none of the requested files are in this dataset" : "dataset has no images");
  const failed: CaptionDatasetResult["failed"] = [];
  let captioned = 0;
  for (const it of targets) {
    try {
      const caption = await captionImage({
        imagePath: `${detail.datasetPath}/${it.file}`,
        guide: opts.guide,
        trigger: opts.trigger,
      });
      await updateDataset(name, { setCaptions: { [it.file]: caption } });
      captioned++;
    } catch (err) {
      failed.push({ file: it.file, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { captioned, failed };
}
