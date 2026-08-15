// #1585 — the gate that ties a pack's `vram:`/`description:` prose to the UNet its
// own manifest fetches.
//
// Eight wan packs shipped a headline contradicting their manifest; four overstated
// (a 12GB card was told "24GB+" and skipped a pack that fetches Q4_K_S) and four
// understated into an OOM (the -96gb variants said "24GB+ (Q8_0)" while fetching
// 26.6GB-per-UNet fp16). `scripts/check-pack-models.mjs` could not see it: it
// compares workflow.json to manifest.yaml and never reads `vram` at all.
//
// Most of what follows is the NEGATIVE half — proof the legal shapes stay quiet.
// A gate that fires on `vram: "12GB+"` (no precision named at all — most packs)
// would be switched off within a week.

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = join(process.cwd(), "scripts", "check-pack-vram.mjs");
const REAL_PACKS = join(process.cwd(), "packs");

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "packvram-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** A manifest model entry. A bare string is the common `local_path` shape, with the
 *  url defaulted to match it. The object form expresses the OTHER shapes
 *  `manifestSchema` accepts (src/services/manifest.ts:110) — `url` is the only
 *  required field, so `model_type`/`filename` and url-only entries are legal too. */
type Entry = string | { url?: string; local_path?: string; model_type?: string; filename?: string };

function entryYaml(e: Entry): string {
  if (typeof e === "string") {
    return `  - url: https://example.invalid/${e.split("/").pop()}\n    local_path: ${e}\n`;
  }
  const url = e.url ?? `https://example.invalid/${(e.local_path ?? e.filename ?? "m.safetensors").split("/").pop()}`;
  return (
    `  - url: ${url}\n` +
    (e.local_path ? `    local_path: ${e.local_path}\n` : "") +
    (e.model_type ? `    model_type: ${e.model_type}\n` : "") +
    (e.filename ? `    filename: ${e.filename}\n` : "")
  );
}

/** Write one pack fixture. `unets` are manifest entries. */
function pack(
  name: string,
  opts: { vram?: string; description?: string; unets: Entry[]; extraModels?: Entry[] },
) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const yaml =
    `name: ${name}\n` +
    (opts.description === undefined ? "" : `description: ${JSON.stringify(opts.description)}\n`) +
    (opts.vram === undefined ? "" : `vram: ${JSON.stringify(opts.vram)}\n`);
  writeFileSync(join(dir, "pack.yaml"), yaml, "utf8");
  const models = [...opts.unets, ...(opts.extraModels ?? [])].map(entryYaml).join("");
  writeFileSync(join(dir, "manifest.yaml"), `models:\n${models}`, "utf8");
}

function run(packsDir = root) {
  try {
    const out = execFileSync(process.execPath, [SCRIPT, "--packs", packsDir], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string };
    return { code: err.status, out: (err.stdout ?? "") + (err.stderr ?? "") };
  }
}

describe("#1585 what the gate FLAGS", () => {
  it("a vram headline naming a quant the manifest does not fetch (the overstating half)", () => {
    pack("wanlike", {
      vram: "24GB+ (Q8_0); 12-24GB with Q5_K_S, <12GB with Q4_K_S",
      unets: ["unet/Wan2.2-I2V-A14B-HighNoise-Q4_K_S.gguf"],
    });
    const r = run();
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/wanlike — vram: says "Q8_0", manifest fetches Q4_K_S/);
  });

  it("a vram headline naming a quant when the manifest fetches full fp16 (the OOM half)", () => {
    // The regression that matters. `_` is a word character, so the gate's first
    // regex used `\b` and never matched `..._14B_fp16.safetensors` — it passed all
    // four -96gb packs while reporting a clean run. This test fails if that
    // boundary ever goes back to `\b`.
    pack("bigtier", {
      vram: "24GB+ (Q8_0); 12-24GB with Q5_K_S, <12GB with Q4_K_S",
      unets: ["diffusion_models/wan2.2_i2v_high_noise_14B_fp16.safetensors"],
    });
    const r = run();
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/bigtier — vram: says "Q8_0", manifest fetches fp16/);
  });

  it("a description headline that contradicts the manifest, even when vram is clean", () => {
    pack("descdrift", {
      vram: "<12GB (Q4_K_S)",
      description: "Ships the Q8_0 quant by default.",
      unets: ["unet/thing-Q4_K_S.gguf"],
    });
    const r = run();
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/descdrift — description: says "Q8_0"/);
    expect(r.out).not.toMatch(/descdrift — vram:/);
  });

  it("names the offending pack, both precisions, and the actual UNet file", () => {
    pack("named", {
      vram: "24GB+ (Q8_0)",
      unets: ["diffusion_models/wan2.2_t2v_low_noise_14B_fp16.safetensors"],
    });
    const out = run().out;
    // The message is part of the contract: a developer who cannot see WHICH file
    // disagrees will "fix" the wrong half.
    expect(out).toMatch(/wan2\.2_t2v_low_noise_14B_fp16\.safetensors/);
    expect(out).toMatch(/OOM/);
  });
});

// ---------------------------------------------------------------------------
// The gate's own FALSE-NEGATIVE direction. A pre-merge review ran `checkPack`
// against the two cases below and both returned an EMPTY finding list: the first
// version inspected only a precision-tagged `local_path`, so a Q8 headline backed
// by an fp16 URL passed, and a manifest written in the `model_type`/`filename`
// shape was never examined at all.
//
// This is the SECOND false negative in this script (the `\b` boundary was the
// first). Both were invisible in its own output. These tests exist so the gate is
// pinned at every place the precision can actually appear, not just the one place
// the shipped packs happen to put it today.
// ---------------------------------------------------------------------------
describe("#1585 the gate reads the precision wherever it appears", () => {
  it("a local_path RENAMED to drop the precision, contradicted by the url it fetches", () => {
    // `WanModel.safetensors` says nothing; the URL it is fetched from says fp8.
    // This is not hypothetical — `packs/wan-animate-ofm` ships exactly this shape.
    pack("renamed", {
      vram: "24GB+ (Q8_0)",
      unets: [
        {
          url: "https://example.invalid/model_fp16.safetensors",
          local_path: "diffusion_models/model.safetensors",
        },
      ],
    });
    const r = run();
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/renamed — vram: says "Q8_0", manifest fetches fp16/);
  });

  it("the model_type/filename manifest shape, which has no local_path at all", () => {
    // `manifestSchema` requires only `url`; local_path is optional and the target
    // is `model_type`/`filename` when it is absent. A gate keyed on local_path
    // does not examine such an entry at all.
    pack("schemaform", {
      vram: "24GB+ (Q8_0)",
      unets: [
        {
          url: "https://example.invalid/model_fp16.safetensors",
          model_type: "diffusion_models",
          filename: "model_fp16.safetensors",
        },
      ],
    });
    const r = run();
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/schemaform — vram: says "Q8_0", manifest fetches fp16/);
  });

  it("a url-only entry, whose target defaults to checkpoints/<url basename>", () => {
    // The most minimal legal entry: neither local_path nor filename nor model_type.
    pack("urlonly", {
      vram: "24GB+ (Q8_0)",
      unets: [{ url: "https://example.invalid/some_model_fp16.safetensors" }],
    });
    const r = run();
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/urlonly — vram: says "Q8_0", manifest fetches fp16/);
  });

  it("a stated tier the manifest cannot corroborate anywhere is a FAILURE, not a pass", () => {
    // The hole both false negatives went through: "no precision found" was treated
    // as "consistent". It is not — it is UNVERIFIABLE, and silently passing it is
    // what let a renamed local_path through. Fail, so the headline is either
    // dropped or made checkable.
    pack("unverifiable", {
      vram: "16GB+ (Q8_0)",
      unets: [{ url: "https://example.invalid/ltx-2.3-22b-dev.safetensors", local_path: "unet/ltx-2.3-22b-dev.safetensors" }],
    });
    const r = run();
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/unverifiable — vram: states "Q8_0", which nothing in the manifest corroborates/);
  });
});

describe("#1585 what the gate must stay QUIET about", () => {
  it("a vram string naming no precision at all — most packs", () => {
    pack("plain", { vram: "12GB+", unets: ["unet/thing-Q8_0.gguf"] });
    expect(run().code).toBe(0);
  });

  it("alternative tiers listed AFTER a correct headline", () => {
    pack("tiers", {
      vram: "<12GB (Q4_K_S); 12-24GB with Q5_K_S, 24GB+ with Q8_0",
      unets: ["unet/thing-Q4_K_S.gguf"],
    });
    expect(run().code).toBe(0);
  });

  it("a manifest that fetches SEVERAL quants, headline naming one of them", () => {
    pack("multi", {
      vram: "8GB+ (Q4_K_S <12GB, Q5_K_S 12-16GB, Q8_0 24GB+)",
      unets: ["unet/x-Q4_K_S.gguf", "unet/x-Q5_K_S.gguf", "unet/x-Q8_0.gguf"],
    });
    expect(run().code).toBe(0);
  });

  it("a UNet naming no precision, under a headline that claims none either", () => {
    // Neither side states a precision, so there is nothing to contradict. Six
    // shipped packs are this shape (the four `anima-*` and both `ltx-2.3-*`), and
    // firing on them would switch the gate off.
    //
    // Note the narrow scope: this stays quiet because the PACK claims nothing. If
    // it claimed a tier, the same manifest would FAIL as unverifiable — see
    // "a stated tier the manifest cannot corroborate anywhere".
    pack("noprec", { vram: "16GB+", unets: ["unet/ltx-2.3-22b-dev.safetensors"] });
    expect(run().code).toBe(0);
  });

  it("a pack that fetches no diffusion model at all — its tier is not about a weight here", () => {
    // An upscaler/LoRA-only pack may legitimately state a tier for a base model it
    // does not download. No shipped pack is in this state today (all 56 fetch at
    // least one diffusion model), but failing here would be a false positive on a
    // legal shape, so the gate declines to judge.
    pack("nounet", {
      vram: "24GB+ (fp16)",
      unets: [],
      extraModels: ["loras/detail-tweaker.safetensors", "vae/ae.safetensors"],
    });
    expect(run().code).toBe(0);
  });

  it("an fp8 headline about an fp8_scaled UNet — same family, not a contradiction", () => {
    pack("scaled", {
      vram: "16GB+ (fp8_scaled turbo; krea2_raw_bf16 wants 24GB+)",
      unets: ["diffusion_models/krea2_turbo_fp8_scaled.safetensors"],
    });
    expect(run().code).toBe(0);
  });

  it("a precision named only by a NON-diffusion model (text encoder / VAE)", () => {
    // The tier is set by the UNet. A Q5_K_S text encoder alongside an fp16 UNet
    // must not be mistaken for the pack's tier in either direction.
    pack("encoder", {
      vram: "96GB (fp16)",
      unets: ["diffusion_models/big_14B_fp16.safetensors"],
      extraModels: ["text_encoders/umt5-xxl-encoder-Q5_K_S.gguf", "vae/wan_2.1_vae.safetensors"],
    });
    expect(run().code).toBe(0);
  });

  it("a pack with no manifest is not a pack — skipped, not failed", () => {
    const dir = join(root, "bare");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "pack.yaml"), 'name: bare\nvram: "24GB+ (Q8_0)"\n', "utf8");
    expect(run().code).toBe(0);
  });
});

describe("#1585 the SHIPPED packs", () => {
  it("every pack in packs/ agrees with its own manifest", () => {
    // This is the assertion that makes the gate REACH production data: it runs the
    // real tree, in `npm test`, on every CI leg. A fixture-only suite would prove
    // the script works and nothing about what ships.
    const r = run(REAL_PACKS);
    expect(r.out).toMatch(/no vram\/manifest contradictions/);
    expect(r.code).toBe(0);
  });

  it("the real packs/ tree is actually being read (guard against an empty sweep)", () => {
    // A gate pointed at the wrong directory is green for the worst possible reason.
    const packCount = readdirSync(REAL_PACKS).length;
    expect(packCount).toBeGreaterThan(40);
    expect(run(REAL_PACKS).out).toMatch(/(\d+) pack\(s\) checked/);
    const checked = Number(/(\d+) pack\(s\) checked/.exec(run(REAL_PACKS).out)?.[1] ?? 0);
    expect(checked).toBeGreaterThan(40);
  });
});
