import { describe, expect, it } from "vitest";
import {
  classifyPrecision,
  dedupeCandidates,
  fileStem,
  findMissingModels,
  fitVerdict,
  matchQuality,
  rankCandidates,
  resolveCandidates,
  type ObjectInfoLike,
} from "../../services/missing-models.js";

// A combo spec as ComfyUI publishes it: [[...options], {…meta}]
const combo = (options: string[]) => [options, {}];

const OBJECT_INFO: ObjectInfoLike = {
  CheckpointLoaderSimple: {
    input: { required: { ckpt_name: combo(["have.safetensors", "other.safetensors"]) } },
  },
  LoraLoader: {
    input: {
      required: {
        lora_name: combo(["installed-lora.safetensors"]),
        strength_model: ["FLOAT", {}],
      },
    },
  },
  KSampler: {
    input: {
      required: {
        // a NON-model combo — enum drift here is not a missing model
        sampler_name: combo(["euler", "dpmpp_2m"]),
        steps: ["INT", {}],
      },
    },
  },
};

describe("findMissingModels", () => {
  it("flags a checkpoint the server does not have, with its target directory", () => {
    const wf = {
      "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "absent.safetensors" } },
    };
    expect(findMissingModels(wf, OBJECT_INFO)).toEqual([
      {
        node_id: "1",
        node_type: "CheckpointLoaderSimple",
        widget: "ckpt_name",
        name: "absent.safetensors",
        directory: "checkpoints",
      },
    ]);
  });

  it("ignores models the server already has", () => {
    const wf = {
      "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "have.safetensors" } },
    };
    expect(findMissingModels(wf, OBJECT_INFO)).toEqual([]);
  });

  it("ignores wired connections and non-combo inputs", () => {
    const wf = {
      "2": {
        class_type: "LoraLoader",
        inputs: { lora_name: "installed-lora.safetensors", strength_model: 0.8, model: ["1", 0] },
      },
    };
    expect(findMissingModels(wf, OBJECT_INFO)).toEqual([]);
  });

  it("does NOT report ordinary enum drift as a missing model", () => {
    // sampler_name is a combo, but "res_multistep" is not a weight file — that's
    // a node-version mismatch, not something download_model can fix.
    const wf = { "3": { class_type: "KSampler", inputs: { sampler_name: "res_multistep", steps: 20 } } };
    expect(findMissingModels(wf, OBJECT_INFO)).toEqual([]);
  });

  it("skips unknown node types instead of guessing", () => {
    const wf = { "4": { class_type: "SomeCustomNode", inputs: { ckpt_name: "absent.safetensors" } } };
    expect(findMissingModels(wf, OBJECT_INFO)).toEqual([]);
  });

  it("dedupes the same missing file referenced by several nodes", () => {
    const wf = {
      "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "absent.safetensors" } },
      "2": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "absent.safetensors" } },
    };
    expect(findMissingModels(wf, OBJECT_INFO)).toHaveLength(1);
  });

  it("still reports a missing model when the widget has no known directory", () => {
    const oi: ObjectInfoLike = {
      WeirdPackNode: { input: { required: { mystery_weights: combo(["a.safetensors"]) } } },
    };
    const wf = { "9": { class_type: "WeirdPackNode", inputs: { mystery_weights: "nope.safetensors" } } };
    const out = findMissingModels(wf, oi);
    expect(out).toHaveLength(1);
    expect(out[0]!.directory).toBeUndefined(); // unknown, but NOT dropped
  });
});

describe("classifyPrecision", () => {
  it("reads the common dtypes", () => {
    expect(classifyPrecision("flux1-dev-fp8_e4m3fn.safetensors").precision).toBe("fp8");
    expect(classifyPrecision("model-fp16.safetensors").precision).toBe("fp16");
    expect(classifyPrecision("model-bf16.safetensors").precision).toBe("bf16");
    expect(classifyPrecision("model-fp32.safetensors").precision).toBe("fp32");
    expect(classifyPrecision("flux-nf4.safetensors").precision).toBe("nf4");
    expect(classifyPrecision("plain.safetensors").precision).toBe("unknown");
  });

  it("detects GGUF with its quant tag and flags the loader pack it needs", () => {
    const q = classifyPrecision("flux1-dev-Q4_K_M.gguf");
    expect(q.precision).toBe("gguf");
    expect(q.quant).toBe("Q4_K_M");
    // handing someone a GGUF without saying it needs a loader node is a trap
    expect(q.requiresPack).toBe("ComfyUI-GGUF");
  });

  it("prefers the GGUF container over a dtype token in the same name", () => {
    // container decides whether it loads at all
    expect(classifyPrecision("model-fp16-Q6_K.gguf").precision).toBe("gguf");
  });
});

describe("fitVerdict", () => {
  const VRAM = 16 * 1024 ** 3; // 16 GB

  it("calls a comfortable file a fit and an oversized one too big", () => {
    expect(fitVerdict(7 * 1024 ** 3, VRAM)).toBe("fits");
    expect(fitVerdict(24 * 1024 ** 3, VRAM)).toBe("too_big");
  });

  it("reserves headroom — weights are the floor, not the ceiling", () => {
    // 15 GB of weights on a 16 GB card is not a comfortable "fits"
    expect(fitVerdict(15 * 1024 ** 3, VRAM)).toBe("tight");
  });

  it("is honest about not knowing", () => {
    expect(fitVerdict(undefined, VRAM)).toBe("unknown");
    expect(fitVerdict(7 * 1024 ** 3, undefined)).toBe("unknown");
    expect(fitVerdict(0, VRAM)).toBe("unknown");
  });
});

describe("matchQuality / fileStem", () => {
  it("grades exact, stem and fuzzy matches", () => {
    expect(matchQuality("a.safetensors", "a.safetensors")).toBe("exact");
    expect(matchQuality("a.safetensors", "a.gguf")).toBe("stem");
    expect(matchQuality("a.safetensors", "b.safetensors")).toBe("fuzzy");
  });

  it("compares basenames, ignoring subfolders", () => {
    expect(matchQuality("sub/dir/a.safetensors", "a.safetensors")).toBe("exact");
    expect(fileStem("sub\\dir\\A.SafeTensors")).toBe("a");
  });
});

describe("rankCandidates", () => {
  const VRAM = 16 * 1024 ** 3;
  const GB = 1024 ** 3;

  it("puts the exact name first, then what actually fits the card", () => {
    const wanted = "flux1-dev.safetensors";
    const ranked = rankCandidates(wanted, [
      { filename: "flux1-dev-Q4_K_M.gguf", size_bytes: 7 * GB, fit: fitVerdict(7 * GB, VRAM) },
      { filename: "flux1-dev.safetensors", size_bytes: 24 * GB, fit: fitVerdict(24 * GB, VRAM) },
      { filename: "flux1-dev-fp8_e4m3fn.safetensors", size_bytes: 12 * GB, fit: fitVerdict(12 * GB, VRAM) },
    ]);
    // exact name wins even though it won't fit — the user asked for it, and the
    // alternatives are right behind it, annotated.
    expect(ranked[0]!.filename).toBe("flux1-dev.safetensors");
    expect(ranked[0]!.match).toBe("exact");
    expect(ranked[0]!.fit).toBe("too_big");
    // among the rest, the ones that fit come first
    expect(ranked.slice(1).every((c) => c.fit === "fits")).toBe(true);
  });

  it("prefers the larger (higher quality) file when name and fit are equal", () => {
    const ranked = rankCandidates("m.safetensors", [
      { filename: "m-Q4_K_M.gguf", size_bytes: 4 * GB, fit: "fits" as const },
      { filename: "m-Q6_K.gguf", size_bytes: 9 * GB, fit: "fits" as const },
    ]);
    expect(ranked[0]!.filename).toBe("m-Q6_K.gguf");
  });

  it("is stable for otherwise-equal candidates", () => {
    const ranked = rankCandidates("x.safetensors", [
      { filename: "a.safetensors", fit: "unknown" as const },
      { filename: "b.safetensors", fit: "unknown" as const },
    ]);
    expect(ranked.map((c) => c.filename)).toEqual(["a.safetensors", "b.safetensors"]);
  });
});

describe("resolveCandidates", () => {
  const GB = 1024 ** 3;
  const MISSING = {
    node_id: "1",
    node_type: "CheckpointLoaderSimple",
    widget: "ckpt_name",
    name: "flux1-dev.safetensors",
    directory: "checkpoints",
  };

  const deps = (over: Partial<Parameters<typeof resolveCandidates>[1]> = {}) => ({
    searchCivitai: async () => [
      { name: "flux1-dev.safetensors", model_id: 11, version_id: 22, size_mb: 24 * 1024, base_model: "Flux.1 D" },
    ],
    searchHf: async () => [{ id: "org/flux" }],
    hfRepoFiles: async () => [
      { filename: "flux1-dev-fp8_e4m3fn.safetensors", size_bytes: 12 * GB },
      { filename: "flux1-dev-Q4_K_M.gguf", size_bytes: 7 * GB },
    ],
    vramBytes: async () => 16 * GB,
    ...over,
  });

  it("annotates every candidate with precision, size, source and GPU fit", async () => {
    const out = await resolveCandidates(MISSING, deps());
    const byName = Object.fromEntries(out.map((c) => [c.filename, c]));

    // exact name first, even though it cannot fit — the alternatives follow it
    expect(out[0]!.filename).toBe("flux1-dev.safetensors");
    expect(out[0]!.match).toBe("exact");
    expect(out[0]!.fit).toBe("too_big");
    expect(out[0]!.source).toBe("civitai");
    expect(out[0]!.base_model).toBe("Flux.1 D");

    expect(byName["flux1-dev-fp8_e4m3fn.safetensors"]!.precision).toBe("fp8");
    expect(byName["flux1-dev-fp8_e4m3fn.safetensors"]!.fit).toBe("fits");
    expect(byName["flux1-dev-fp8_e4m3fn.safetensors"]!.source).toBe("huggingface");
    expect(byName["flux1-dev-fp8_e4m3fn.safetensors"]!.url).toContain("huggingface.co/org/flux/resolve/main/");
  });

  it("flags that a GGUF pick needs the loader pack", async () => {
    const out = await resolveCandidates(MISSING, deps());
    const gguf = out.find((c) => c.precision === "gguf")!;
    expect(gguf.quant).toBe("Q4_K_M");
    // handing over a GGUF without saying it needs a loader node is a trap
    expect(gguf.requires_pack).toBe("ComfyUI-GGUF");
  });

  it("degrades to the other provider when one is down, instead of failing", async () => {
    const out = await resolveCandidates(
      MISSING,
      deps({ searchCivitai: async () => { throw new Error("civitai 503"); } }),
    );
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((c) => c.source === "huggingface")).toBe(true);
  });

  it("reports fit as unknown when VRAM can't be read (remote/cloud)", async () => {
    const out = await resolveCandidates(MISSING, deps({ vramBytes: async () => undefined }));
    expect(out.every((c) => c.fit === "unknown")).toBe(true);
  });

  it("type-filters the CivitAI search by the model's directory", async () => {
    let seenTypes: string[] | undefined = ["NOT SET"];
    await resolveCandidates(MISSING, deps({
      searchCivitai: async (_q: string, types: string[] | undefined) => { seenTypes = types; return []; },
    }));
    // a checkpoint hunt must not return LoRAs
    expect(seenTypes).toEqual(["Checkpoint"]);
  });
});

describe("dedupeCandidates", () => {
  const GB = 1024 ** 3;
  it("collapses the same file mirrored across repos, keeping the one that knows its size", () => {
    const out = dedupeCandidates([
      { filename: "flux1-dev.safetensors", source: "huggingface", precision: "unknown" },
      { filename: "org2/flux1-dev.safetensors", source: "huggingface", precision: "unknown", size_bytes: 22 * GB },
    ]);
    expect(out).toHaveLength(1);
    // size drives the fit verdict, so the sized entry must win
    expect(out[0]!.size_bytes).toBe(22 * GB);
  });

  it("keeps genuinely different builds of the same model", () => {
    const out = dedupeCandidates([
      { filename: "flux1-dev.safetensors", source: "huggingface", precision: "fp16" },
      { filename: "flux1-dev.safetensors", source: "huggingface", precision: "fp8" },
      { filename: "flux1-dev-Q4_K_M.gguf", source: "huggingface", precision: "gguf", quant: "Q4_K_M" },
      { filename: "flux1-dev-Q6_K.gguf", source: "huggingface", precision: "gguf", quant: "Q6_K" },
    ]);
    // fp16 / fp8 / two GGUF quants are four real choices, not duplicates
    expect(out).toHaveLength(4);
  });
});
