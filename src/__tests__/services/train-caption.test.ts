import { describe, expect, it, beforeAll, afterAll, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock the Agent SDK before anything imports the caption service — no real
// subscription calls in tests. `queryMode` lets individual tests swap in a
// failure stream (auth error / transient error) without re-mocking the module.
let queryMode: "ok" | "auth" | "transient" | "counting-transient" = "ok";
let queryCalls = 0;
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: () => {
    queryCalls++;
    const mode = queryMode;
    return (async function* () {
      if (mode === "auth") {
        // How the SDK reports a not-logged-in run: an error `result`, not a throw.
        yield { type: "result", subtype: "error_during_execution", is_error: true, result: "Not logged in · Please run /login" };
        return;
      }
      if (mode === "transient" || mode === "counting-transient") {
        yield { type: "result", subtype: "error_during_execution", is_error: true, result: "transient hiccup — try again" };
        return;
      }
      yield {
        type: "assistant",
        message: { content: [{ type: "text", text: "e2echar, waiting at a rainy bus stop, city lights" }] },
      };
      yield { type: "result", subtype: "success" };
    })();
  },
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
  // A larger set so "stops after the first failure" is distinguishable from
  // "iterated every file".
  const bdir = join(root, "datasets", "beta");
  mkdirSync(bdir, { recursive: true });
  for (let i = 1; i <= 5; i++) writeFileSync(join(bdir, `img_0000${i}.png`), "fakepng");
});
afterEach(() => {
  queryMode = "ok";
  queryCalls = 0;
});
afterAll(() => {
  if (saved === undefined) delete process.env.COMFYUI_MCP_TRAINING_DIR;
  else process.env.COMFYUI_MCP_TRAINING_DIR = saved;
  rmSync(root, { recursive: true, force: true });
});

import { captionDataset, captionImage, CaptionAuthError } from "../../services/train-caption.js";

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

  it("fails fast on a persistent auth failure — stops after the FIRST file, does not iterate all (#438)", async () => {
    queryMode = "auth";
    await expect(captionDataset("beta", { trigger: "e2echar" })).rejects.toBeInstanceOf(CaptionAuthError);
    // The whole batch shares one Claude session — one auth probe, not 5.
    expect(queryCalls).toBe(1);
  });

  it("auth error carries an actionable /login message", async () => {
    queryMode = "auth";
    await expect(captionDataset("beta", {})).rejects.toThrow(/login/i);
  });

  it("a transient per-file error still continues through the whole batch", async () => {
    queryMode = "transient";
    const r = await captionDataset("beta", {});
    expect(r.captioned).toBe(0);
    expect(r.failed).toHaveLength(5); // every file attempted, none aborted the batch
    expect(queryCalls).toBe(5);
  });
});
