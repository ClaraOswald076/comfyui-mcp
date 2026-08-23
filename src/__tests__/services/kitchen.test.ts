import { afterEach, describe, expect, it } from "vitest";
import {
  KITCHEN_PROBE_SOURCE,
  applyKitchenRecommendation,
  assessKitchen,
  compareProof,
  extractLoaders,
  findNvfp4Variant,
  formatProofSummary,
  gatherKitchenStatus,
  inferComputeFromGpu,
  kitchenProactiveHint,
  known,
  mergeKitchenStatus,
  parseCliArgsFlagSupport,
  parseKitchenArgv,
  parseKitchenLog,
  parseKitchenProbe,
  quantFromSafetensorsHeader,
  resetKitchenHintSession,
  tritonAtLeast,
  unknown,
  type KitchenStatus,
  type ProofSample,
} from "../../services/kitchen.js";

const LOG = [
  "comfy-kitchen version: 0.2.31",
  "Found comfy_kitchen backend cuda: available",
  "Found comfy_kitchen backend eager: available",
  "Found comfy_kitchen backend hip: unavailable",
  "Found comfy_kitchen backend triton: available",
  "Found triton 3.7.0. Enabling comfy-kitchen triton backend.",
  "Using Comfy Kitchen attention",
].join("\n");

const DICTIONARY_LOG = [
  "comfy-kitchen version: 0.2.31",
  "Found comfy_kitchen backend eager: {'available': True, 'disabled': False, 'reason': None}",
  "Found comfy_kitchen backend triton: {'available': False, 'disabled': True, 'reason': 'not supported'}",
].join("\n");

function status(over: Partial<KitchenStatus> = {}): KitchenStatus {
  const base = mergeKitchenStatus({
    location: "LOCAL",
    log: parseKitchenLog(LOG),
    flags: parseKitchenArgv(["python", "main.py"]),
    gpuName: "NVIDIA GeForce RTX 4090",
    gpuType: "cuda",
    pkgVersion: known("0.2.31"),
    probe: parseKitchenProbe("present True\nversion 0.2.31\nint8 True\n"),
    sageInstalled: known(false),
  });
  return { ...base, ...over, gpu: { ...base.gpu, ...(over.gpu ?? {}) } };
}

const UNET_API = {
  "12": {
    class_type: "UNETLoader",
    inputs: { unet_name: "flux1-dev.safetensors", weight_dtype: "default" },
  },
};

afterEach(() => {
  resetKitchenHintSession();
});

describe("parseKitchenLog", () => {
  it("reads version, backends, INT8 attention, and triton from the startup lines the issue names", () => {
    const parsed = parseKitchenLog(LOG);
    expect(parsed.version).toEqual(known("0.2.31"));
    expect(parsed.backends.cuda).toEqual({ available: true, raw: "available" });
    expect(parsed.backends.eager).toEqual({ available: true, raw: "available" });
    expect(parsed.ckAttentionLog).toEqual(known(true));
    expect(parsed.tritonEnabledLog).toEqual(known(true));
    expect(parsed.tritonVersion).toEqual(known("3.7.0"));
  });

  it("reads availability from dictionary-shaped backend startup lines", () => {
    const parsed = parseKitchenLog(DICTIONARY_LOG);

    expect(parsed.backends.eager).toEqual({
      available: true,
      raw: "{'available': True, 'disabled': False, 'reason': None}",
    });
    expect(parsed.backends.triton).toEqual({
      available: false,
      raw: "{'available': False, 'disabled': True, 'reason': 'not supported'}",
    });
  });

  it("does not treat a missing attention line as a no", () => {
    const parsed = parseKitchenLog("comfy-kitchen version: 0.2.10");
    expect(parsed.ckAttentionLog.status).toBe("unknown");
    expect(parsed.sageLog.status).toBe("unknown");
    expect(parsed.sageMissingLog.status).toBe("unknown");
  });

  it("treats a sageattention import-failure line as known-absent, not silence", () => {
    const parsed = parseKitchenLog("Could not load sageattention: No module named 'sageattention'");
    expect(parsed.sageMissingLog).toEqual(known(true));
  });
});

describe("parseKitchenArgv", () => {
  it("reads kitchen flags with exact tokens, including --fast values", () => {
    const flags = parseKitchenArgv([
      "python",
      "main.py",
      "--use-ck-attention",
      "--fast",
      "fp8_matrix_mult",
      "--enable-triton-backend",
    ]);
    expect(flags.argvKnown).toBe(true);
    expect(flags.useCkAttention).toBe(true);
    expect(flags.useSageAttention).toBe(false);
    expect(flags.fastFp8MatrixMult).toBe(true);
    expect(flags.enableTritonBackend).toBe(true);
  });

  it("does not treat a missing argv as empty flags", () => {
    expect(parseKitchenArgv(undefined).argvKnown).toBe(false);
    expect(parseKitchenArgv(undefined).useCkAttention).toBe(false);
  });
});

describe("inferComputeFromGpu", () => {
  it("maps Ada to fp8-only and Blackwell to fp8+NVFP4+MXFP8", () => {
    const ada = inferComputeFromGpu("cuda:0 NVIDIA GeForce RTX 4090 : cudaMallocAsync", "cuda");
    expect(ada.sm).toEqual(known(8.9));
    expect(ada.fp8).toEqual(known(true));
    expect(ada.nvfp4).toEqual(known(false));
    expect(ada.mxfp8).toEqual(known(false));
    expect(ada.host).toBe("cuda");

    const blackwell = inferComputeFromGpu("NVIDIA GeForce RTX 5090", "cuda");
    expect(blackwell.fp8).toEqual(known(true));
    expect(blackwell.nvfp4).toEqual(known(true));
    expect(blackwell.mxfp8).toEqual(known(true));

    const ampere = inferComputeFromGpu("NVIDIA GeForce RTX 3090", "cuda");
    expect(ampere.fp8).toEqual(known(false));
    expect(ampere.nvfp4).toEqual(known(false));
  });

  it("leaves an unrecognized GPU unknown rather than inventing an SM", () => {
    const mystery = inferComputeFromGpu("Acme Quantum Card", "cuda");
    expect(mystery.sm.status).toBe("unknown");
    expect(mystery.fp8.status).toBe("unknown");
    expect(mystery.nvfp4.status).toBe("unknown");
  });

  it("classifies a Radeon device as ROCm", () => {
    expect(inferComputeFromGpu("AMD Radeon RX 7900 XTX", "hip").host).toBe("rocm");
  });
});

describe("KITCHEN_PROBE_SOURCE", () => {
  it("never imports torch", () => {
    expect(KITCHEN_PROBE_SOURCE).not.toMatch(/\bimport torch\b/);
    expect(KITCHEN_PROBE_SOURCE).toContain("comfy_kitchen");
    expect(KITCHEN_PROBE_SOURCE).toContain("list_backends");
    expect(KITCHEN_PROBE_SOURCE).toContain("int8_attention_is_available");
  });
});

describe("parseKitchenProbe", () => {
  it("reads present/version/int8 from the probe stdout", () => {
    const parsed = parseKitchenProbe(
      ["present True", "version 0.2.31", 'backends {"cuda": {"available": true}}', "int8 True"].join(
        "\n",
      ),
    );
    expect(parsed.present).toEqual(known(true));
    expect(parsed.version).toEqual(known("0.2.31"));
    expect(parsed.int8).toEqual(known(true));
    expect(parsed.backends.cuda).toEqual({ available: true });
  });

  it("empty stdout is unknown, not a no", () => {
    const parsed = parseKitchenProbe("");
    expect(parsed.present.status).toBe("unknown");
    expect(parsed.int8.status).toBe("unknown");
  });
});

describe("extractLoaders", () => {
  it("reads UNETLoader.weight_dtype off an API-format graph", () => {
    const [loader] = extractLoaders(UNET_API);
    expect(loader.node_id).toBe("12");
    expect(loader.weight_dtype).toEqual(known("default"));
    expect(loader.unet_name).toEqual(known("flux1-dev.safetensors"));
  });

  it("reads stock UNETLoader widgets_values as [unet_name, weight_dtype]", () => {
    const graph = {
      nodes: [
        {
          id: 12,
          type: "UNETLoader",
          widgets_values: ["flux1-dev.safetensors", "default"],
        },
      ],
      links: [],
    };
    const [loader] = extractLoaders(graph);
    expect(loader.weight_dtype).toEqual(known("default"));
  });
});

describe("assessKitchen", () => {
  it("recommends fp8_e4m3fn_fast only when kitchen, fp8 GPU, default dtype, and unquantized file are all known", () => {
    const recs = assessKitchen(status(), UNET_API, {
      quantOf: () => known("none"),
    });
    expect(recs.map((r) => r.kind)).toContain("fp8_unet_fast");
    const rec = recs.find((r) => r.kind === "fp8_unet_fast")!;
    expect(rec.change.value).toBe("fp8_e4m3fn_fast");
    expect(rec.restart).toBe(false);
    expect(rec.node_id).toBe("12");
  });

  it("does not recommend fp8 when model.quant is unknown", () => {
    const recs = assessKitchen(status(), UNET_API);
    expect(recs.some((r) => r.kind === "fp8_unet_fast")).toBe(false);
  });

  it("recommends --use-ck-attention when sage is known-absent and kitchen INT8 is available", () => {
    const recs = assessKitchen(status(), {});
    expect(recs.map((r) => r.kind)).toContain("ck_attention");
    expect(recs.find((r) => r.kind === "ck_attention")!.change.flag).toBe("--use-ck-attention");
  });

  it("does not recommend ck_attention when sageattention is unknown", () => {
    const recs = assessKitchen(status({ sageattentionInstalled: unknown("not probed") }), {});
    expect(recs.some((r) => r.kind === "ck_attention")).toBe(false);
  });

  it("recommends an NVFP4 swap only when a sibling file is listed", () => {
    const s = status({
      gpu: {
        ...status().gpu,
        ...inferComputeFromGpu("NVIDIA GeForce RTX 5090", "cuda"),
      },
    });
    const recs = assessKitchen(s, UNET_API, {
      quantOf: () => known("none"),
      localFilenames: ["flux1-dev.safetensors", "flux1-dev-nvfp4.safetensors"],
    });
    expect(recs.map((r) => r.kind)).toContain("nvfp4_swap");
    expect(recs.find((r) => r.kind === "nvfp4_swap")!.change.variant).toBe(
      "flux1-dev-nvfp4.safetensors",
    );
  });

  it("recommends --enable-triton-backend on ROCm when triton ≥ 3.7 and kitchen is present", () => {
    const s = status({
      host: "rocm",
      tritonVersion: known("3.7.0"),
    });
    const recs = assessKitchen(s, {});
    expect(recs.map((r) => r.kind)).toContain("triton_backend");
  });
});

describe("applyKitchenRecommendation", () => {
  it("refuses a restart rec without confirm", async () => {
    const rec = assessKitchen(status(), {})[0]!;
    expect(rec.kind).toBe("ck_attention");
    const out = await applyKitchenRecommendation({ rec, confirm: false });
    expect(out.applied).toBe(false);
    expect(out.needs_confirm).toBe(true);
  });

  it("does not claim a flag was injected — restart replays argv", async () => {
    const rec = assessKitchen(status(), {}).find((r) => r.kind === "ck_attention")!;
    const out = await applyKitchenRecommendation({ rec, confirm: true });
    expect(out.applied).toBe(false);
    expect(out.flag_note).toMatch(/replay/);
    expect(out.flag_note).toMatch(/--use-ck-attention/);
  });

  it("applies a widget rec and reverts when the after-run is slower or black", async () => {
    const rec = assessKitchen(status(), UNET_API, { quantOf: () => known("none") }).find(
      (r) => r.kind === "fp8_unet_fast",
    )!;
    const writes: Array<[string, string, string]> = [];
    const black: ProofSample = {
      seed: 1,
      secondsPerIteration: 2,
      peakVramGb: 10,
      outputBlack: true,
      outputNan: false,
    };
    const before: ProofSample = {
      seed: 1,
      secondsPerIteration: 1.9,
      peakVramGb: 14,
      outputBlack: false,
      outputNan: false,
    };
    const out = await applyKitchenRecommendation({
      rec,
      applyWidget: async (id, w, v) => {
        writes.push([id, w, v]);
      },
      revertWidget: async (id, w, v) => {
        writes.push([id, w, v]);
      },
      runProof: async (phase) => (phase === "before" ? before : black),
    });
    expect(out.reverted).toBe(true);
    expect(out.applied).toBe(false);
    expect(writes).toEqual([
      ["12", "weight_dtype", "fp8_e4m3fn_fast"],
      ["12", "weight_dtype", "default"],
    ]);
  });

  it("proves a faster non-black after-run", async () => {
    const rec = assessKitchen(status(), UNET_API, { quantOf: () => known("none") }).find(
      (r) => r.kind === "fp8_unet_fast",
    )!;
    const before: ProofSample = {
      seed: 7,
      secondsPerIteration: 1.92,
      peakVramGb: 14.1,
      outputBlack: false,
      outputNan: false,
    };
    const after: ProofSample = {
      seed: 7,
      secondsPerIteration: 1.4,
      peakVramGb: 9.8,
      outputBlack: false,
      outputNan: false,
    };
    const out = await applyKitchenRecommendation({
      rec,
      applyWidget: async () => ({ ok: true }),
      runProof: async (phase) => (phase === "before" ? before : after),
    });
    expect(out.applied).toBe(true);
    expect(out.proof.status).toBe("proven");
    expect(out.proof.summary).toBe(formatProofSummary(before, after, rec));
    expect(compareProof(before, after).ok).toBe(true);
  });
});

describe("gatherKitchenStatus", () => {
  it("carries dictionary-shaped backend availability through status aggregation", async () => {
    const remote = await gatherKitchenStatus({
      location: "REMOTE",
      logText: DICTIONARY_LOG,
      stats: {
        system: {
          argv: [],
          comfy_package_versions: [{ name: "comfy-kitchen", installed: "0.2.31" }],
        },
        devices: [],
      },
    });

    expect(remote.backends.eager.available).toEqual(known(true));
    expect(remote.backends.triton.available).toEqual(known(false));
  });

  it("merges log + stats + probe and reports present without guessing on a remote host", async () => {
    const remote = await gatherKitchenStatus({
      location: "REMOTE",
      logText: LOG,
      stats: {
        system: {
          os: "Linux",
          python_version: "3.12",
          embedded_python: false,
          argv: ["python", "main.py", "--use-ck-attention"],
          comfy_package_versions: [{ name: "comfy-kitchen", installed: "0.2.31" }],
        },
        devices: [
          {
            name: "NVIDIA GeForce RTX 4090",
            type: "cuda",
            index: 0,
            vram_total: 0,
            vram_free: 0,
            torch_vram_total: 0,
            torch_vram_free: 0,
          },
        ],
      },
      probeStdout: "present True\nint8 True\n",
    });
    expect(remote.location).toBe("REMOTE");
    expect(remote.present).toEqual(known(true));
    expect(remote.version).toEqual(known("0.2.31"));
    expect(remote.flags.useCkAttention).toBe(true);
    expect(remote.attention.ck).toEqual(known(true));
    // Remote must not have run the import probe even if stdout was supplied —
    // gatherKitchenStatus skips the probe when location is REMOTE.
    expect(remote.sources.probe).toBe(false);
  });

  it("a failed probe is unknown, not a no", async () => {
    const s = await gatherKitchenStatus({
      location: "LOCAL",
      logText: "",
      probeStdout: "",
      pythonExe: "",
      stats: {
        system: { os: "Linux", python_version: "3.12", embedded_python: false, argv: [] },
        devices: [],
      },
    });
    expect(s.present.status).toBe("unknown");
    expect(s.gpu.fp8.status).toBe("unknown");
  });
});

describe("kitchenProactiveHint", () => {
  it("fires once per process when rec 2 is certain", () => {
    const s = status();
    const recs = assessKitchen(s, {});
    const first = kitchenProactiveHint(s, recs);
    expect(first).toMatch(/kitchen/);
    expect(first).toMatch(/ck_attention/);
    expect(kitchenProactiveHint(s, recs)).toBeUndefined();
  });
});

describe("helpers", () => {
  it("reads quant metadata keys and treats a clean header as unquantized", () => {
    expect(quantFromSafetensorsHeader({ _quantization_metadata: { format: "nvfp4" } })).toEqual(
      known("nvfp4"),
    );
    expect(quantFromSafetensorsHeader({ "model.weight": { dtype: "BF16" } })).toEqual(known("none"));
  });

  it("finds an NVFP4 sibling by stem", () => {
    expect(
      findNvfp4Variant("flux1-dev.safetensors", ["flux1-dev.safetensors", "flux1-dev-nvfp4.safetensors"]),
    ).toBe("flux1-dev-nvfp4.safetensors");
  });

  it("parses cli_args.py for flag support", () => {
    const src = parseCliArgsFlagSupport("parser.add_argument('--use-ck-attention')\n--enable-triton-backend");
    expect(src.ckAttention).toEqual(known(true));
    expect(src.tritonBackend).toEqual(known(true));
    expect(parseCliArgsFlagSupport(undefined).ckAttention.status).toBe("unknown");
  });

  it("compares triton 3.7 as the ROCm floor", () => {
    expect(tritonAtLeast("3.7.0", 7)).toBe(true);
    expect(tritonAtLeast("3.6.2", 7)).toBe(false);
    expect(tritonAtLeast("4.0.0", 7)).toBe(true);
  });
});
