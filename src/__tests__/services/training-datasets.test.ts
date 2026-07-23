import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point the training root at a temp dir (trainingRoot() reads the env per call).
let root: string;
let saved: string | undefined;
beforeAll(() => {
  saved = process.env.COMFYUI_MCP_TRAINING_DIR;
  root = mkdtempSync(join(tmpdir(), "train-datasets-test-"));
  process.env.COMFYUI_MCP_TRAINING_DIR = root;
});
afterAll(() => {
  if (saved === undefined) delete process.env.COMFYUI_MCP_TRAINING_DIR;
  else process.env.COMFYUI_MCP_TRAINING_DIR = saved;
  rmSync(root, { recursive: true, force: true });
});

import { getDataset, getJobConfig, listDatasets, readTrainingFile } from "../../services/training-datasets.js";

function stageDataset(name: string, files: Array<[string, string | null]>) {
  const dir = join(root, "datasets", name);
  mkdirSync(dir, { recursive: true });
  for (const [file, caption] of files) {
    writeFileSync(join(dir, file), "fakepng");
    if (caption != null) {
      writeFileSync(join(dir, file.replace(/\.[^.]+$/, ".txt")), caption);
    }
  }
  return dir;
}

describe("listDatasets / getDataset", () => {
  it("lists staged datasets newest-first with image/caption counts (empty dirs excluded)", () => {
    stageDataset("alpha", [["img_00001.png", "ohwx a person"], ["img_00002.png", null]]);
    stageDataset("empty", []);
    mkdirSync(join(root, "datasets", "beta"), { recursive: true });
    writeFileSync(join(root, "datasets", "beta", "img_00001.png"), "x");
    const list = listDatasets();
    expect(list.map((d) => d.name)).toEqual(["beta", "alpha"]);
    expect(list.find((d) => d.name === "alpha")).toMatchObject({ imageCount: 2, captionedCount: 1 });
  });

  it("detail returns the items with captions (null when uncaptioned) + the reusable datasetPath", () => {
    const d = getDataset("alpha");
    expect(d.datasetPath.replace(/\\/g, "/")).toContain("/datasets/alpha");
    expect(d.items).toEqual([
      { file: "img_00001.png", caption: "ohwx a person" },
      { file: "img_00002.png", caption: null },
    ]);
  });

  it("rejects traversal and unknown names", () => {
    expect(() => getDataset("../secrets")).toThrow(/invalid dataset name/);
    expect(() => getDataset("no-such-set")).toThrow(/no dataset/);
  });
});

describe("readTrainingFile (train_file)", () => {
  it("inlines an image under the training root with its mime type", () => {
    const f = readTrainingFile(join(root, "datasets", "alpha", "img_00001.png"));
    expect(f.mimeType).toBe("image/png");
    expect(Buffer.from(f.data, "base64").toString()).toBe("fakepng");
  });

  it("rejects escapes, non-images, and oversize files", () => {
    expect(() => readTrainingFile(join(tmpdir(), "outside.png"))).toThrow(/escapes/);
    expect(() => readTrainingFile(join(root, "datasets", "alpha", "img_00001.txt"))).toThrow(/only image files/);
    const big = join(root, "datasets", "alpha", "big.png");
    writeFileSync(big, Buffer.alloc(2 * 1024 * 1024 + 1));
    expect(() => readTrainingFile(big)).toThrow(/too large/);
  });
});

describe("getJobConfig", () => {
  beforeAll(() => {
    const jobDir = join(root, "jobs", "jobcfg1");
    mkdirSync(jobDir, { recursive: true });
    writeFileSync(
      join(jobDir, "config.yml"),
      [
        "job: extension",
        "config:",
        "  name: e2e",
        "  process:",
        "    - type: sd_trainer",
        "      network: { type: lora, linear: 16, linear_alpha: 16 }",
        "      save: { save_every: 250 }",
        "      datasets:",
        "        - folder_path: /dataset",
        "          resolution: [512, 768]",
        "      train: { steps: 2000, lr: 0.0001, batch_size: 1 }",
        "      model: { quantize: true }",
        "      sample: { sample_every: 250 }",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(root, "jobs", "jobcfg1.json"),
      JSON.stringify({
        id: "jobcfg1",
        name: "e2e",
        flow: "character",
        model: "flux1-dev",
        trigger: "e2echar",
        status: "completed",
        progress: { samples: [] },
        datasetPath: join(root, "datasets", "alpha"),
        jobDir,
        outputDir: join(jobDir, "output"),
        log: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );
  });

  it("reads the effective settings back from config.yml (steps/lr/rank/resolution/cadences/quantize)", async () => {
    const v = await getJobConfig("jobcfg1");
    expect(v).toMatchObject({
      id: "jobcfg1",
      name: "e2e",
      trigger: "e2echar",
      source: "config.yml",
      params: {
        steps: 2000,
        lr: 0.0001,
        rank: 16,
        resolution: [512, 768],
        batchSize: 1,
        saveEvery: 250,
        sampleEvery: 250,
        quantize: true,
      },
    });
    expect(v.datasetPath).toContain("alpha");
  });

  it("throws on an unknown job id", async () => {
    await expect(getJobConfig("nope")).rejects.toThrow(/no training job/);
  });
});
