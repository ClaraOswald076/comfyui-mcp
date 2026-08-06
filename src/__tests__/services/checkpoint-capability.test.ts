import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The probe must never read a remote server's filesystem through a local path;
// pin local mode regardless of the dev machine's env.
vi.mock("../../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config.js")>();
  return { ...actual, isRemoteMode: () => false };
});

import {
  headerKeysHaveTextEncoder,
  resetCheckpointCapabilityCache,
  selectTxt2ImgCheckpoint,
} from "../../services/checkpoint-capability.js";
import type { LocalModel } from "../../services/model-resolver.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ckpt-cap-"));
  resetCheckpointCapabilityCache();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Minimal well-formed safetensors file: 8-byte LE header length + header JSON. */
async function writeFakeSafetensors(
  name: string,
  tensorKeys: string[],
): Promise<string> {
  const header = JSON.stringify(
    Object.fromEntries(tensorKeys.map((k) => [k, { dtype: "F16" }])),
  );
  const lenBuf = Buffer.alloc(8);
  lenBuf.writeBigUInt64LE(BigInt(Buffer.byteLength(header)));
  const filePath = join(dir, name);
  await writeFile(filePath, Buffer.concat([lenBuf, Buffer.from(header)]));
  return filePath;
}

function model(name: string, filePath: string): LocalModel {
  return { name, path: filePath, size: 0, modified: "", type: "checkpoints" };
}

const SD15_KEYS = [
  "model.diffusion_model.input_blocks.0.0.weight",
  "cond_stage_model.transformer.text_model.encoder.layers.0.self_attn.weight",
];
const SDXL_KEYS = [
  "model.diffusion_model.input_blocks.0.0.weight",
  "conditioner.embedders.0.transformer.text_model.encoder.layers.0.weight",
];
const LTX_VIDEO_KEYS = [
  "model.diffusion_model.transformer_blocks.0.attn1.weight",
  "vae.encoder.conv_in.weight",
];

describe("headerKeysHaveTextEncoder", () => {
  it("recognizes SD1.x cond_stage_model weights", () => {
    expect(headerKeysHaveTextEncoder(SD15_KEYS)).toBe(true);
  });

  it("recognizes SDXL conditioner weights", () => {
    expect(headerKeysHaveTextEncoder(SDXL_KEYS)).toBe(true);
  });

  it("recognizes SD3/Flux text_encoders weights", () => {
    expect(headerKeysHaveTextEncoder(["text_encoders.clip_l.weight"])).toBe(
      true,
    );
  });

  it("rejects video-model headers (transformer + VAE, no text encoder)", () => {
    expect(headerKeysHaveTextEncoder(LTX_VIDEO_KEYS)).toBe(false);
  });

  it("rejects an empty header", () => {
    expect(headerKeysHaveTextEncoder([])).toBe(false);
  });
});

describe("selectTxt2ImgCheckpoint (#892)", () => {
  it("skips a video checkpoint and picks the txt2img-capable one", async () => {
    const video = model(
      "ltx_video.safetensors",
      await writeFakeSafetensors("ltx_video.safetensors", LTX_VIDEO_KEYS),
    );
    const sd15 = model(
      "sd15.safetensors",
      await writeFakeSafetensors("sd15.safetensors", SD15_KEYS),
    );
    const choice = await selectTxt2ImgCheckpoint([video, sd15]);
    expect(choice?.name).toBe("sd15.safetensors");
    expect(choice?.capability).toBe("capable");
    expect(choice?.skippedIncapable).toEqual(["ltx_video.safetensors"]);
  });

  it("marks GGUF checkpoints incapable (CheckpointLoaderSimple cannot load them)", async () => {
    const gguf = model("flux-q4.gguf", join(dir, "flux-q4.gguf")); // never read
    const sd15 = model(
      "sd15.safetensors",
      await writeFakeSafetensors("sd15.safetensors", SD15_KEYS),
    );
    const choice = await selectTxt2ImgCheckpoint([gguf, sd15]);
    expect(choice?.name).toBe("sd15.safetensors");
    expect(choice?.skippedIncapable).toEqual(["flux-q4.gguf"]);
  });

  it("returns null when every candidate is known incapable", async () => {
    const v1 = model(
      "a_ltx.safetensors",
      await writeFakeSafetensors("a_ltx.safetensors", LTX_VIDEO_KEYS),
    );
    const v2 = model(
      "b_wan.safetensors",
      await writeFakeSafetensors("b_wan.safetensors", LTX_VIDEO_KEYS),
    );
    expect(await selectTxt2ImgCheckpoint([v1, v2])).toBeNull();
  });

  it("returns null for an empty listing", async () => {
    expect(await selectTxt2ImgCheckpoint([])).toBeNull();
  });

  it("falls back to an undeterminable checkpoint rather than refusing it", async () => {
    // .ckpt has no cheap header: capability unknown ≠ incapable.
    const legacy = model("legacy.ckpt", join(dir, "legacy.ckpt"));
    const video = model(
      "ltx_video.safetensors",
      await writeFakeSafetensors("ltx_video.safetensors", LTX_VIDEO_KEYS),
    );
    const choice = await selectTxt2ImgCheckpoint([legacy, video]);
    expect(choice?.name).toBe("legacy.ckpt");
    expect(choice?.capability).toBe("unknown");
  });

  it("prefers a later known-capable checkpoint over an earlier unknown one", async () => {
    const legacy = model("aaa_legacy.ckpt", join(dir, "aaa_legacy.ckpt"));
    const sd15 = model(
      "zzz_sd15.safetensors",
      await writeFakeSafetensors("zzz_sd15.safetensors", SD15_KEYS),
    );
    const choice = await selectTxt2ImgCheckpoint([legacy, sd15]);
    expect(choice?.name).toBe("zzz_sd15.safetensors");
    expect(choice?.capability).toBe("capable");
  });

  it("re-probes when the file on disk changes (cache invalidation)", async () => {
    const filePath = await writeFakeSafetensors("m.safetensors", SD15_KEYS);
    const m = model("m.safetensors", filePath);
    expect((await selectTxt2ImgCheckpoint([m]))?.capability).toBe("capable");
    // Overwrite with a video-model header (different size → stale cache entry).
    await writeFakeSafetensors("m.safetensors", LTX_VIDEO_KEYS);
    expect(await selectTxt2ImgCheckpoint([m])).toBeNull();
  });

  it("treats an unreadable/corrupt header as unknown, not incapable", async () => {
    const filePath = join(dir, "corrupt.safetensors");
    await writeFile(filePath, Buffer.from([1, 2, 3])); // < 8 bytes
    const choice = await selectTxt2ImgCheckpoint([
      model("corrupt.safetensors", filePath),
    ]);
    expect(choice?.capability).toBe("unknown");
  });
});
