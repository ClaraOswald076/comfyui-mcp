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

/** Write one pack fixture. `unets` are manifest local_paths. */
function pack(
  name: string,
  opts: { vram?: string; description?: string; unets: string[]; extraModels?: string[] },
) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const yaml =
    `name: ${name}\n` +
    (opts.description === undefined ? "" : `description: ${JSON.stringify(opts.description)}\n`) +
    (opts.vram === undefined ? "" : `vram: ${JSON.stringify(opts.vram)}\n`);
  writeFileSync(join(dir, "pack.yaml"), yaml, "utf8");
  const models = [...opts.unets, ...(opts.extraModels ?? [])]
    .map((p) => `  - url: https://example.invalid/${p.split("/").pop()}\n    local_path: ${p}\n`)
    .join("");
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

  it("a UNet filename that names no precision — nothing to compare, so no verdict", () => {
    // Inventing a verdict from an unanswerable comparison is the defect class this
    // repo keeps fixing; the gate must answer "nothing known", not "contradiction".
    pack("noprec", { vram: "16GB+ (Q8_0)", unets: ["unet/ltx-2.3-22b-dev.safetensors"] });
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
