import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock the Agent SDK before anything imports the caption service — no real
// subscription calls in tests.
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: () =>
    (async function* () {
      yield {
        type: "assistant",
        message: { content: [{ type: "text", text: "e2echar, waiting at a rainy bus stop, city lights" }] },
      };
      yield { type: "result", subtype: "success" };
    })(),
}));

let root: string;
let saved: string | undefined;
beforeAll(() => {
  saved = process.env.COMFYUI_MCP_TRAINING_DIR;
  root = mkdtempSync(join(tmpdir(), "train-caption-test-"));
  process.env.COMFYUI_MCP_TRAINING_DIR = root;
  const dir = join(root, "datasets", "alpha");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "img_00001.png"), "fakepng");
  writeFileSync(join(dir, "img_00002.png"), "fakepng");
});
afterAll(() => {
  if (saved === undefined) delete process.env.COMFYUI_MCP_TRAINING_DIR;
  else process.env.COMFYUI_MCP_TRAINING_DIR = saved;
  rmSync(root, { recursive: true, force: true });
});

import { captionDataset, captionImage } from "../../services/train-caption.js";

describe("captionImage", () => {
  it("returns the model's bare caption (quotes stripped)", async () => {
    const cap = await captionImage({
      imagePath: join(root, "datasets", "alpha", "img_00001.png"),
      trigger: "e2echar",
    });
    expect(cap).toBe("e2echar, waiting at a rainy bus stop, city lights");
  });
});

describe("captionDataset", () => {
  it("writes every caption into the dataset's .txt files (subset via only)", async () => {
    const r = await captionDataset("alpha", { trigger: "e2echar" });
    expect(r).toEqual({ captioned: 2, failed: [] });
    const txt = readFileSync(join(root, "datasets", "alpha", "img_00001.txt"), "utf-8");
    expect(txt).toBe("e2echar, waiting at a rainy bus stop, city lights");
  });

  it("only: restricts which files get captioned", async () => {
    rmSync(join(root, "datasets", "alpha", "img_00001.txt"), { force: true });
    rmSync(join(root, "datasets", "alpha", "img_00002.txt"), { force: true });
    const r = await captionDataset("alpha", { only: ["img_00002.png"] });
    expect(r).toEqual({ captioned: 1, failed: [] });
    expect(readFileSync(join(root, "datasets", "alpha", "img_00002.txt"), "utf-8")).toContain("e2echar");
  });
});
