import { describe, expect, it, beforeEach, vi } from "vitest";

// Mock the three boundaries the tool's resolveCheckpoint/Enqueue path touches;
// keep generateImage, the workflow composer and DefaultsManager real so the
// graph actually gets built.
const listLocalModelsMock = vi.fn();
vi.mock("../../services/model-resolver.js", () => ({
  listLocalModels: (...a: unknown[]) => listLocalModelsMock(...a),
}));

const selectMock = vi.fn();
vi.mock("../../services/checkpoint-capability.js", () => ({
  selectTxt2ImgCheckpoint: (...a: unknown[]) => selectMock(...a),
}));

const enqueueWorkflowMock = vi.fn(async () => ({
  prompt_id: "pid-1",
  queue_remaining: 0,
}));
vi.mock("../../services/workflow-executor.js", () => ({
  enqueueWorkflow: (...a: unknown[]) => enqueueWorkflowMock(...a),
}));

import { registerGenerateImageTool } from "../../tools/generate-image.js";
import { DefaultsManager } from "../../services/defaults-manager.js";
import type { WorkflowJSON } from "../../comfyui/types.js";

type ToolResult = {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
};
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

function getHandler(): ToolHandler {
  let handler: ToolHandler | undefined;
  const server = {
    tool: (n: string, _d: string, _s: unknown, h: ToolHandler) => {
      if (n === "generate_image") handler = h;
    },
  };
  registerGenerateImageTool(server as never);
  if (!handler) throw new Error("generate_image not registered");
  return handler;
}

function enqueuedWorkflow(): WorkflowJSON {
  return enqueueWorkflowMock.mock.calls[0][0] as WorkflowJSON;
}

function ckptName(wf: WorkflowJSON): unknown {
  return Object.values(wf).find((n) => n.class_type === "CheckpointLoaderSimple")
    ?.inputs.ckpt_name;
}

beforeEach(() => {
  listLocalModelsMock.mockReset();
  selectMock.mockReset();
  enqueueWorkflowMock.mockClear();
  DefaultsManager.reset();
  DefaultsManager.configure({ configPath: "/tmp/__never__.json", env: {} });
});

describe("generate_image checkpoint auto-select (#892)", () => {
  it("enqueues with the txt2img-capable checkpoint the selector picked", async () => {
    listLocalModelsMock.mockResolvedValue([{ name: "x" }, { name: "y" }]);
    selectMock.mockResolvedValue({
      name: "good.safetensors",
      capability: "capable",
      skippedIncapable: ["ltx_video.safetensors"],
    });
    const res = await getHandler()({ prompt: "a red apple" });
    expect(res.isError).toBeFalsy();
    expect(selectMock).toHaveBeenCalledOnce();
    expect(ckptName(enqueuedWorkflow())).toBe("good.safetensors");
    const out = JSON.parse(res.content[0].text);
    expect(out.checkpoint).toBe("good.safetensors");
  });

  it("fails fast with an honest, actionable error when no checkpoint is txt2img-capable", async () => {
    listLocalModelsMock.mockResolvedValue([
      { name: "a_ltx.safetensors" },
      { name: "b_wan.safetensors" },
    ]);
    selectMock.mockResolvedValue(null);
    const res = await getHandler()({ prompt: "a red apple" });
    expect(res.isError).toBe(true);
    const text = res.content[0].text;
    expect(text).toMatch(/none appears txt2img-capable/i);
    // Names the offending models and the remedy.
    expect(text).toContain("a_ltx.safetensors");
    expect(text).toContain("b_wan.safetensors");
    expect(text).toContain("checkpoint");
    expect(text).toContain("download_model");
    // Nothing was enqueued — no guaranteed-to-fail graph.
    expect(enqueueWorkflowMock).not.toHaveBeenCalled();
  });

  it("keeps the generic 'no checkpoint' error when the listing fails", async () => {
    listLocalModelsMock.mockRejectedValue(new Error("connection refused"));
    const res = await getHandler()({ prompt: "a red apple" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/No checkpoint/i);
    expect(enqueueWorkflowMock).not.toHaveBeenCalled();
  });

  it("does not consult the listing when a checkpoint is passed explicitly", async () => {
    const res = await getHandler()({
      prompt: "a red apple",
      checkpoint: "explicit.safetensors",
    });
    expect(res.isError).toBeFalsy();
    expect(listLocalModelsMock).not.toHaveBeenCalled();
    expect(ckptName(enqueuedWorkflow())).toBe("explicit.safetensors");
  });
});

describe("generate_image seed handling (#865)", () => {
  it("passes the caller's seed through and shields it from re-randomization", async () => {
    const res = await getHandler()({ prompt: "p", checkpoint: "x.safetensors", seed: 12345 });
    expect(res.isError).toBeFalsy();
    const wf = enqueuedWorkflow();
    const sampler = Object.values(wf).find((n) => n.class_type === "KSampler");
    expect(sampler?.inputs.seed).toBe(12345);
    // The composer already drew/used the seed; the executor must not touch it.
    expect(enqueueWorkflowMock).toHaveBeenCalledWith(expect.anything(), {
      disable_random_seed: true,
    });
  });

  it("still randomizes when no seed is given (composer-side draw)", async () => {
    const res = await getHandler()({ prompt: "p", checkpoint: "x.safetensors" });
    expect(res.isError).toBeFalsy();
    const sampler = Object.values(enqueuedWorkflow()).find(
      (n) => n.class_type === "KSampler",
    );
    expect(typeof sampler?.inputs.seed).toBe("number");
  });
});
