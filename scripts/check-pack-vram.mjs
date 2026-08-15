#!/usr/bin/env node
// #1585 — a pack's `vram:` headline must not name a precision its own manifest
// does not fetch.
//
// `enumeratePacks()` (src/tools/skills-access.ts) hands `list_packs` the `vram`
// and `description` strings straight out of pack.yaml. Nothing compared them to
// manifest.yaml, so eight wan packs shipped a headline that contradicted the UNet
// they download — four overstating (a 12GB card was told 24GB+ and skipped a pack
// that fetches Q4_K_S), and four understating in the OOM direction (the -96gb
// variants said "24GB+ (Q8_0)" while fetching 26.6GB-per-UNet fp16).
//
// `scripts/check-pack-models.mjs` could not catch this: it compares workflow.json
// against manifest.yaml and never reads `vram` or `description` at all.
//
// The rule is deliberately narrow, because most packs' vram strings name no
// precision ("12GB+", "<6GB") and that must stay legal:
//
//   IF pack.yaml's `vram:` (or `description:`) states a precision token at all,
//   THEN the FIRST one — the headline, the tier the reader takes away — must be a
//   precision the manifest actually fetches into unet/, diffusion_models/ or
//   checkpoints/, read from the destination filename AND the source URL.
//   If the manifest fetches such a model but NOTHING about it names a precision,
//   the headline is UNVERIFIABLE and that is a failure, not a pass.
//
// Later tokens are alternative tiers ("...; 12-24GB with Q5_K_S") and are ignored:
// a pack may legitimately document quants it does not ship.
//
// "Unverifiable fails" is a deliberate choice over warn-and-exit-0. A warning
// leaves CI green, which is indistinguishable from the false negative it would be
// reporting — and this script has now shipped two of those. Measured against the
// tree: 6 packs fetch a UNet whose precision cannot be read, and all 6 state no
// precision, so none of them trip this. It blocks nothing today and closes the
// hole a renamed local_path went through.
//
//   node scripts/check-pack-vram.mjs                  # all packs
//   node scripts/check-pack-vram.mjs --packs <dir>    # a fixture tree (tests)
//   node scripts/check-pack-vram.mjs wan-longer-videos-i2v   # one pack
//
// Exit non-zero if any pack's stated headline contradicts its manifest.

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Weight-precision tokens: GGUF quants (Q4_K_S, Q8_0, Q6_K …) and float
 *  formats (fp16, fp8, fp8_scaled, bf16, nf4 …). Matched case-insensitively;
 *  normalised so `q4_k_s` and `Q4_K_S` are the same token.
 *
 *  The boundaries are `(?<![a-z0-9])` / `(?![a-z0-9])` and NOT `\b`, because `_`
 *  is a word character: `\b` never fires between the `_` and the `f` in
 *  `wan2.2_i2v_high_noise_14B_fp16.safetensors`. The first version of this gate
 *  used `\b`, and so it silently missed all four `-96gb` packs — the OOM-direction
 *  half of #1585, and the half that matters. It reported a clean run either way.
 *  A gate's false-NEGATIVE direction is invisible in its own output; the only
 *  thing that found this was running it against the KNOWN-BAD `origin/main` data. */
const TOKEN =
  /(?<![a-z0-9])(?:q\d+(?:_(?:k(?:_[sml])?|\d))?|fp8(?:_[a-z0-9]+)*|fp16|fp32|bf16|nf4|int8|int4)(?![a-z0-9])/gi;

/** Manifest destinations that hold the DIFFUSION model — the weight that sets the
 *  VRAM floor. A text encoder's or VAE's precision is not the pack's tier. */
const UNET_DIRS = new Set(["unet", "diffusion_models", "checkpoints"]);

/** The file basename a URL fetches. Only the basename: a repo path can carry a
 *  precision that is not this file's (`Kijai/WanVideo_comfy_fp8_scaled/…` hosts
 *  more than fp8_scaled), and reading the whole URL would import that noise. */
export function urlBasename(url) {
  try {
    return basename(new URL(String(url)).pathname) || "";
  } catch {
    return "";
  }
}

/**
 * Where a manifest entry actually lands, resolved the way `applyManifest` does
 * (src/services/manifest.ts — `local_path` wins; otherwise `model_type` defaults
 * to "checkpoints" and `filename` defaults to the URL's basename).
 *
 * `manifestSchema` marks `url` as the ONLY required field, so all of these are
 * legal and all of them must be read:
 *
 *   { url, local_path }                    ← the shape every shipped pack uses
 *   { url, model_type, filename }
 *   { url, model_type }                    ← filename from the url
 *   { url, filename }                      ← model_type defaults to checkpoints
 *   { url }                                ← both defaulted
 *
 * The first version of this gate keyed on `local_path` alone. A pre-merge review
 * proved by execution that it returned an EMPTY finding list for a Q8 headline
 * over an fp16 URL, and never examined a `model_type`/`filename` entry at all.
 */
export function resolveEntry(model) {
  const localPath = model?.local_path;
  if (localPath) {
    const segments = String(localPath).split(/[/\\]+/).filter(Boolean);
    return {
      // A bare "model.safetensors" lands in the models ROOT, not a category.
      dir: segments.length > 1 ? segments[0].toLowerCase() : "",
      file: segments[segments.length - 1] ?? "",
      url: String(model?.url ?? ""),
    };
  }
  return {
    dir: String(model?.model_type ?? "checkpoints").toLowerCase(),
    file: String(model?.filename ?? urlBasename(model?.url)),
    url: String(model?.url ?? ""),
  };
}

/** `fp8_scaled` and `fp8_e4m3fn` are the same family for tier purposes — a
 *  headline saying "fp8" about an `fp8_scaled` UNet is not a contradiction. The
 *  family is the part before the first underscore; quants keep their full name,
 *  because Q4_K_S and Q8_0 are genuinely different tiers. */
export function normalizeToken(raw) {
  const t = String(raw);
  if (/^q/i.test(t)) return t.toUpperCase();
  return t.toLowerCase().split("_")[0];
}

/** Every precision token in a string, in order, normalised. */
export function precisionTokens(text) {
  const out = [];
  for (const m of String(text ?? "").matchAll(TOKEN)) out.push(normalizeToken(m[0]));
  return out;
}

/**
 * Precisions the manifest actually fetches into a diffusion-model directory.
 *
 * Read from BOTH the resolved destination filename and the source URL's basename,
 * unioned. Either one alone is a blind spot: `packs/wan-animate-ofm` saves
 * `diffusion_models/WanModel.safetensors` — a name that states nothing — from a
 * URL ending `…_fp8_scaled_e4m3fn_KJ_v2.safetensors`. Reading only the filename
 * makes that pack unjudgeable; reading only the URL misses a manifest that renames
 * in the other direction.
 *
 * Unioning is also what keeps `packs/wan-multitalk` quiet: it saves
 * `…_GGUF_Q8.gguf` (token `Q8`) from `…-Q8_0.gguf` (token `Q8_0`). Those are the
 * same quant spelled two ways, and a filename-only reading would flag a correct
 * `Q8_0` headline as a contradiction.
 *
 * `unetCount` is reported separately from `precisions.size`, because "fetches no
 * diffusion model" and "fetches one whose precision cannot be read" are different
 * answers and the second is the one that must not pass silently.
 */
export function manifestUnetPrecisions(manifest) {
  const set = new Set();
  const files = [];
  let unetCount = 0;
  for (const m of manifest?.models ?? []) {
    const { dir, file, url } = resolveEntry(m);
    if (!UNET_DIRS.has(dir)) continue;
    unetCount++;
    const fromUrl = urlBasename(url);
    files.push(file && fromUrl && file !== fromUrl ? `${file} (from ${fromUrl})` : file || fromUrl);
    for (const t of precisionTokens(file)) set.add(t);
    for (const t of precisionTokens(fromUrl)) set.add(t);
  }
  return { precisions: set, files, unetCount };
}

/**
 * Compare one pack's prose against its manifest.
 * Returns a list of findings; empty means the pack is consistent (or states
 * nothing to check, which is legal).
 */
export function checkPack({ name, pack, manifest }) {
  const { precisions, files, unetCount } = manifestUnetPrecisions(manifest);

  // The pack fetches no diffusion model at all. Its `vram:` is then not a claim
  // about a weight THIS manifest downloads (a LoRA- or upscaler-only pack may
  // legitimately state the tier of a base model the user already has), so there
  // is nothing here to contradict. Declining to judge is honest; no shipped pack
  // is in this state today (all 56 fetch at least one).
  if (unetCount === 0) return [];

  const findings = [];
  for (const field of ["vram", "description"]) {
    const stated = precisionTokens(pack?.[field]);
    if (stated.length === 0) continue; // states no tier — legal, and most packs
    const headline = stated[0];
    const common = {
      pack: name,
      field,
      headline,
      manifest: [...precisions].sort(),
      files,
      text: String(pack[field]).replace(/\s+/g, " ").trim().slice(0, 160),
    };

    // The pack names a tier, the manifest downloads a diffusion model, and NOTHING
    // about that model — not the destination filename, not the URL it comes from —
    // names a precision. The claim is unverifiable, and treating unverifiable as
    // consistent is precisely the hole both of this gate's false negatives went
    // through. Fail: either drop the precision from the headline, or name the
    // weight so the claim can be checked.
    if (precisions.size === 0) {
      findings.push({ ...common, kind: "unverifiable" });
      continue;
    }
    if (precisions.has(headline)) continue;
    findings.push({ ...common, kind: "contradiction" });
  }
  return findings;
}

function main() {
  const argv = process.argv.slice(2);
  let packsRoot = join(repoRoot, "packs");
  const only = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--packs") packsRoot = argv[++i];
    else only.push(argv[i]);
  }

  const entries = (only.length ? only : readdirSync(packsRoot))
    .map((n) => ({ name: basename(n), dir: join(packsRoot, basename(n)) }))
    .filter(({ dir }) => {
      try {
        return statSync(dir).isDirectory();
      } catch {
        return false;
      }
    })
    .filter(({ dir }) => existsSync(join(dir, "pack.yaml")) && existsSync(join(dir, "manifest.yaml")));

  const findings = [];
  let checked = 0;
  for (const { name, dir } of entries) {
    const pack = parse(readFileSync(join(dir, "pack.yaml"), "utf8")) || {};
    const manifest = parse(readFileSync(join(dir, "manifest.yaml"), "utf8")) || {};
    checked++;
    findings.push(...checkPack({ name, pack, manifest }));
  }

  if (findings.length === 0) {
    console.log(`#1585 gate: ${checked} pack(s) checked, no vram/manifest contradictions.`);
    process.exit(0);
  }

  console.error(
    `\n#1585 — ${findings.length} pack field(s) state a precision their manifest does not fetch.\n\n` +
      "`list_packs` hands these strings to the agent verbatim. A headline naming a\n" +
      "precision the manifest does not download is read as the pack's VRAM tier, and\n" +
      "it is wrong in one of two user-visible ways: OVERSTATING makes a card that\n" +
      "could run the pack skip it, UNDERSTATING sends the user into an OOM.\n",
  );
  for (const f of findings) {
    console.error(
      (f.kind === "unverifiable"
        ? `  ${f.pack} — ${f.field}: states "${f.headline}", which nothing in the manifest corroborates\n`
        : `  ${f.pack} — ${f.field}: says "${f.headline}", manifest fetches ${f.manifest.join(", ")}\n`) +
        `      ${f.field}: ${f.text}\n` +
        `      UNet(s): ${f.files.join(", ")}\n`,
    );
  }
  console.error(
    "Fix the STRING to match the weight, or change the manifest to fetch the weight\n" +
      "the string promises. Alternative tiers may still be listed after the headline\n" +
      '("<12GB (Q4_K_S); 24GB+ with Q8_0") — only the FIRST token is the claim.\n\n' +
      'For "nothing corroborates it": neither the destination filename nor the URL\n' +
      "names any precision, so the tier cannot be checked. Either drop the precision\n" +
      "from the string, or save the weight under a name that states it.\n",
  );
  process.exit(1);
}

// Only run when executed directly, so the pure helpers above are importable.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
