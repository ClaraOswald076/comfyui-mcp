import { describe, expect, it } from "vitest";
import { parseTrainingProgress, TRAINER_IMAGE, resolveDocker } from "../../services/ai-toolkit.js";

describe("parseTrainingProgress", () => {
  it("parses a tqdm-style line with step/total + loss", () => {
    const line = "my_lora:  12%|#2        | 240/2000 [01:03<07:41,  4.2it/s, lr: 1.0e-04 loss: 3.9e-01]";
    const t = parseTrainingProgress(line);
    expect(t).not.toBeNull();
    expect(t!.step).toBe(240);
    expect(t!.totalSteps).toBe(2000);
    expect(t!.loss).toBeCloseTo(0.39, 5);
  });

  it("parses loss with = separator", () => {
    const t = parseTrainingProgress("step 500/2000 loss=0.215");
    expect(t!.step).toBe(500);
    expect(t!.loss).toBeCloseTo(0.215, 5);
  });

  it("captures a saved sample image path", () => {
    const t = parseTrainingProgress("Saved sample to /output/my_lora/samples/1727890_000000250.png");
    expect(t).not.toBeNull();
    expect(t!.sample).toMatch(/000000250\.png$/);
  });

  it("returns null for a non-progress line", () => {
    expect(parseTrainingProgress("Loading model black-forest-labs/FLUX.1-dev ...")).toBeNull();
    expect(parseTrainingProgress("   ")).toBeNull();
  });

  it("ignores bare dataset/download bars without a loss reading", () => {
    // Real E2E artifact: the dataset-scan bar "6/6" was misparsed as step 6/6.
    expect(parseTrainingProgress("100%|##########| 6/6 [00:00<00:00, 15.00it/s]")).toBeNull();
    expect(parseTrainingProgress(" 33%|###       | 2/6 [00:00<00:00, 14.54it/s]")).toBeNull();
    const t = parseTrainingProgress("Loading weights: 100%|###| 196/196 [00:00<00:00, 2669.35it/s]");
    expect(t).toBeNull();
  });

  it("always keeps the raw line", () => {
    const t = parseTrainingProgress("100/200 loss: 0.5");
    expect(t!.raw).toBe("100/200 loss: 0.5");
  });
});

describe("trainer config surface", () => {
  it("has a default image tag and resolves a docker binary", () => {
    expect(TRAINER_IMAGE).toContain("comfyui-mcp-trainer");
    expect(typeof resolveDocker()).toBe("string");
    expect(resolveDocker().length).toBeGreaterThan(0);
  });
});
