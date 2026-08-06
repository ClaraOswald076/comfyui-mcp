/**
 * txt2img capability probing for checkpoint auto-select (issue #892).
 *
 * `generate_image`'s auto-select used to take the alphabetically-first entry
 * of the checkpoints listing — which fails 100% of the time when that entry
 * is a video model (LTX, Wan, HunyuanVideo), because the txt2img graph wires
 * CheckpointLoaderSimple's CLIP output into CLIPTextEncode and a video
 * checkpoint contains no text encoder weights (clip arrives as None).
 *
 * ComfyUI exposes no "does this checkpoint contain a CLIP" endpoint, so the
 * probe reads the safetensors header (first bytes only, never the multi-GB
 * tensor payload) and looks for known text-encoder tensor prefixes. The probe
 * is three-valued on purpose: "unknown" is NOT folded into "incapable" —
 * remote servers, non-safetensors formats and unreadable files all mean we
 * could not determine capability, and treating that as a definite negative
 * would refuse checkpoints that actually work. Selection prefers known-capable,
 * falls back to unknown, and refuses only when EVERY candidate is known
 * incapable (where enqueueing would be a guaranteed CLIPTextEncode failure).
 */
import { open, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { isRemoteMode } from "../config.js";
import {
  resolveExistingModelFile,
  type LocalModel,
} from "./model-resolver.js";
import { logger } from "../utils/logger.js";

export type Txt2ImgCapability = "capable" | "incapable" | "unknown";

/** Same cap as model-explorer's header reader: far beyond any real checkpoint
 *  header (KBs–low MBs); guards against a corrupt length prefix making us
 *  allocate the file's whole size. */
const SAFETENSORS_HEADER_MAX_BYTES = 64 * 1024 * 1024;

/**
 * Tensor-key prefixes that mark embedded text-encoder weights. Covers the
 * single-file image checkpoint families CheckpointLoaderSimple can serve CLIP
 * from: SD1.x/SD2.x ("cond_stage_model."), SDXL ("conditioner."), SD3/Flux
 * ("text_encoders."), PixArt/Hunyuan-DiT ("text_encoder."). Video checkpoints
 * (LTX, Wan, HunyuanVideo) carry transformer+VAE only and match none of these.
 */
const TEXT_ENCODER_KEY_PREFIXES = [
  "cond_stage_model.",
  "conditioner.",
  "text_encoders.",
  "text_encoder.",
] as const;

export function headerKeysHaveTextEncoder(keys: Iterable<string>): boolean {
  for (const key of keys) {
    for (const prefix of TEXT_ENCODER_KEY_PREFIXES) {
      if (key.startsWith(prefix)) return true;
    }
  }
  return false;
}

/**
 * Read just a safetensors file's header (8-byte little-endian length + that
 * many bytes of JSON) and return its top-level keys. Returns null for
 * anything that isn't a well-formed, capped header — the probe is
 * best-effort and never throws.
 */
async function readSafetensorsHeaderKeys(
  filePath: string,
): Promise<string[] | null> {
  let fh: Awaited<ReturnType<typeof open>> | undefined;
  try {
    fh = await open(filePath, "r");
    const lenBuf = Buffer.alloc(8);
    if ((await fh.read(lenBuf, 0, 8, 0)).bytesRead < 8) return null;
    const headerLen = Number(lenBuf.readBigUInt64LE(0));
    if (
      !Number.isSafeInteger(headerLen) ||
      headerLen <= 0 ||
      headerLen > SAFETENSORS_HEADER_MAX_BYTES
    ) {
      return null;
    }
    const headerBuf = Buffer.alloc(headerLen);
    if ((await fh.read(headerBuf, 0, headerLen, 8)).bytesRead < headerLen) {
      return null;
    }
    const header = JSON.parse(headerBuf.toString("utf8")) as unknown;
    if (!header || typeof header !== "object" || Array.isArray(header)) {
      return null;
    }
    return Object.keys(header as Record<string, unknown>);
  } catch {
    return null;
  } finally {
    await fh?.close().catch(() => undefined);
  }
}

interface ProbeCacheEntry {
  mtimeMs: number;
  size: number;
  capability: Txt2ImgCapability;
}

/** Header reads are cheap but not free; invalidated by mtime+size change. */
const probeCache = new Map<string, ProbeCacheEntry>();

/** Test hook: drop all cached probe results. */
export function resetCheckpointCapabilityCache(): void {
  probeCache.clear();
}

/**
 * Probe one listed checkpoint for txt2img capability. Never throws: any
 * observation failure resolves to "unknown", never to a definite negative.
 */
async function probeCheckpoint(model: LocalModel): Promise<Txt2ImgCapability> {
  const lower = model.name.toLowerCase();
  // CheckpointLoaderSimple cannot load GGUF at all (needs UnetLoaderGGUF).
  if (lower.endsWith(".gguf")) return "incapable";
  // .ckpt/.pt/.bin have no cheap metadata header to inspect.
  if (!lower.endsWith(".safetensors")) return "unknown";
  // The header lives on the server's filesystem; in remote mode that is not
  // ours to read (config.ts warns when COMFYUI_PATH points elsewhere).
  if (isRemoteMode()) return "unknown";

  let filePath: string;
  let mtimeMs: number;
  let size: number;
  try {
    if (isAbsolute(model.path)) {
      const info = await stat(model.path);
      if (!info.isFile()) return "unknown";
      filePath = model.path;
      mtimeMs = info.mtimeMs;
      size = info.size;
    } else {
      // HTTP listing: path is "<dir>/<name>" relative to models/. Resolve via
      // the shared resolver so extra_model_paths.yaml roots are honoured.
      const resolved = await resolveExistingModelFile(
        `checkpoints/${model.name}`,
      );
      if (!resolved.info.isFile()) return "unknown";
      filePath = resolved.path;
      mtimeMs = resolved.info.mtimeMs;
      size = resolved.info.size;
    }
  } catch {
    return "unknown";
  }

  const cached = probeCache.get(filePath);
  if (cached && cached.mtimeMs === mtimeMs && cached.size === size) {
    return cached.capability;
  }
  const keys = await readSafetensorsHeaderKeys(filePath);
  const capability =
    keys === null
      ? "unknown"
      : headerKeysHaveTextEncoder(keys)
        ? "capable"
        : "incapable";
  probeCache.set(filePath, { mtimeMs, size, capability });
  return capability;
}

export interface Txt2ImgCheckpointChoice {
  /** Checkpoint name as listed (what CheckpointLoaderSimple's ckpt_name takes). */
  name: string;
  capability: Txt2ImgCapability;
  /** Names skipped because they are known NOT to drive a txt2img graph. */
  skippedIncapable: string[];
}

/**
 * Pick a checkpoint that can drive the txt2img graph: the first known-capable
 * candidate in listing order, else the first whose capability could not be
 * determined (status-quo behaviour — the graph may still work). Returns null
 * only when every candidate is known incapable, where enqueueing would be a
 * guaranteed failure.
 */
export async function selectTxt2ImgCheckpoint(
  models: readonly LocalModel[],
): Promise<Txt2ImgCheckpointChoice | null> {
  // Sequential with early exit on the first known-capable candidate: the
  // common case (first checkpoint is a normal image model) costs one header
  // read. An unknown candidate is only a fallback — a LATER known-capable
  // entry still beats an earlier unknown one.
  const incapable: string[] = [];
  let firstUnknown: LocalModel | undefined;
  for (const model of models) {
    const capability = await probeCheckpoint(model);
    if (capability === "capable") {
      if (incapable.length > 0) {
        logger.debug("checkpoint auto-select skipped non-txt2img checkpoints", {
          picked: model.name,
          skipped: incapable,
        });
      }
      return { name: model.name, capability, skippedIncapable: incapable };
    }
    if (capability === "incapable") incapable.push(model.name);
    else if (!firstUnknown) firstUnknown = model;
  }
  if (firstUnknown) {
    return {
      name: firstUnknown.name,
      capability: "unknown",
      skippedIncapable: incapable,
    };
  }
  return null;
}
