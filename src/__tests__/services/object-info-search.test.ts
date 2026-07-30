import { describe, expect, it } from "vitest";
import { searchObjectInfo } from "../../services/object-info-search.js";
import type { ObjectInfo } from "../../comfyui/types.js";

function def(over: Partial<ObjectInfo[string]>): ObjectInfo[string] {
  return {
    input: { required: {}, optional: {} },
    output: [],
    output_is_list: [],
    output_name: [],
    name: "",
    display_name: "",
    description: "",
    category: "",
    output_node: false,
    ...over,
  };
}

const objectInfo: ObjectInfo = {
  UltralyticsDetectorProvider: def({
    display_name: "Ultralytics Detector Provider",
    category: "ImpactPack/Detector",
    description: "Loads a YOLO face/hand detector model.",
    output: ["BBOX_DETECTOR", "SEGM_DETECTOR"],
    output_name: ["bbox_detector", "segm_detector"],
    input: { required: { model_name: [["face_yolov8m.pt"], {}] } },
  }),
  KSampler: def({
    display_name: "KSampler",
    category: "sampling",
    description: "Samples latents.",
    input: { required: { seed: [["INT"], {}], cfg: [["FLOAT"], {}] } },
  }),
  CheckpointLoaderSimple: def({
    display_name: "Load Checkpoint",
    category: "loaders",
    description: "Loads a diffusion checkpoint.",
  }),
};

describe("searchObjectInfo", () => {
  it("finds a node by a term in its class name / description (face detector)", () => {
    const hits = searchObjectInfo(objectInfo, "face detector");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].class_type).toBe("UltralyticsDetectorProvider");
    expect(hits[0].outputs).toContain("bbox_detector");
  });

  it("ranks an exact class-name match first", () => {
    const hits = searchObjectInfo(objectInfo, "ksampler");
    expect(hits[0].class_type).toBe("KSampler");
  });

  it("matches on input names too", () => {
    const hits = searchObjectInfo(objectInfo, "cfg");
    expect(hits.map((h) => h.class_type)).toContain("KSampler");
  });

  it("ANDs multiple terms and returns nothing when one is absent", () => {
    expect(searchObjectInfo(objectInfo, "face zzzznotpresent")).toHaveLength(0);
  });

  it("honors the result limit", () => {
    expect(searchObjectInfo(objectInfo, "", 2)).toHaveLength(2);
  });

  it("fuzzy-matches a typo when no substring match exists (ksamplr → KSampler)", () => {
    // Strict substring finds nothing for the typo; the fuzzy (subsequence) pass
    // recovers KSampler.
    const hits = searchObjectInfo(objectInfo, "ksamplr");
    expect(hits.map((h) => h.class_type)).toContain("KSampler");
  });

  it("prefers exact/substring matches over fuzzy (strict pass wins)", () => {
    // "sampler" is a substring of KSampler; the strict pass returns it and the
    // fuzzy pass never runs, so unrelated subsequence hits don't dilute results.
    const hits = searchObjectInfo(objectInfo, "sampler");
    expect(hits[0].class_type).toBe("KSampler");
  });
});
