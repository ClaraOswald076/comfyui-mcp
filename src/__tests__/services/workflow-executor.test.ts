import { describe, expect, it, beforeEach, vi, afterEach } from "vitest";

// Mock the ComfyUI client so enqueue + /object_info are observable, and the
// job watcher so no background state is created.
const enqueuePromptMock = vi.fn(async () => ({
  prompt_id: "pid-1",
  queue_remaining: 0,
}));
const getObjectInfoMock = vi.fn();
vi.mock("../../comfyui/client.js", () => ({
  enqueuePrompt: (...a: unknown[]) => enqueuePromptMock(...a),
  getSystemStats: vi.fn(),
  getObjectInfo: (...a: unknown[]) => getObjectInfoMock(...a),
}));

const watchMock = vi.fn();
vi.mock("../../services/job-watcher.js", () => ({
  JobWatcher: { watch: (...a: unknown[]) => watchMock(...a) },
}));

import {
  enqueueWorkflow,
  seedInputRange,
} from "../../services/workflow-executor.js";
import type { ObjectInfo, WorkflowJSON } from "../../comfyui/types.js";

const INT32_MAX = 2147483647;

const OBJECT_INFO: ObjectInfo = {
  ClaudeNode: {
    input: {
      required: {
        prompt: ["STRING", {}],
        seed: [
          "INT",
          { default: 0, min: 0, max: INT32_MAX, control_after_generate: true },
        ],
      },
    },
    output: ["STRING"],
    output_is_list: [false],
    output_name: ["text"],
    name: "ClaudeNode",
    display_name: "Claude",
    description: "",
    category: "api node/text",
    output_node: false,
  },
  KSampler: {
    input: {
      required: {
        seed: ["INT", { default: 0, min: 0, max: 0xffffffffffffffff }],
      },
    },
    output: ["LATENT"],
    output_is_list: [false],
    output_name: ["latent"],
    name: "KSampler",
    display_name: "KSampler",
    description: "",
    category: "sampling",
    output_node: false,
  },
};

function enqueuedWorkflow(): WorkflowJSON {
  return enqueuePromptMock.mock.calls[0][0] as WorkflowJSON;
}

beforeEach(() => {
  enqueuePromptMock.mockClear();
  watchMock.mockClear();
  getObjectInfoMock.mockReset();
  getObjectInfoMock.mockResolvedValue(OBJECT_INFO);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("seedInputRange", () => {
  it("uses the node's declared [min, max] when present", () => {
    expect(seedInputRange(OBJECT_INFO, "ClaudeNode", "seed")).toEqual([
      0,
      INT32_MAX,
    ]);
  });

  it("falls back to the int32 range for an unknown class_type", () => {
    expect(seedInputRange(OBJECT_INFO, "NoSuchNode", "seed")).toEqual([
      0,
      INT32_MAX,
    ]);
  });

  it("falls back to the int32 range when object_info is unavailable", () => {
    expect(seedInputRange(undefined, "ClaudeNode", "seed")).toEqual([
      0,
      INT32_MAX,
    ]);
  });

  it("falls back when the declared bounds are incoherent (min > max)", () => {
    const broken = {
      Weird: {
        input: { required: { seed: ["INT", { min: 100, max: 5 }] } },
      },
    } as unknown as ObjectInfo;
    expect(seedInputRange(broken, "Weird", "seed")).toEqual([0, INT32_MAX]);
  });

  it("honors a declared max wider than int32 (KSampler 2^64-1)", () => {
    const [min, max] = seedInputRange(OBJECT_INFO, "KSampler", "seed");
    expect(min).toBe(0);
    expect(max).toBeGreaterThan(INT32_MAX);
    // …but the draw ceiling is clamped to exactly-representable doubles.
    expect(max).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER);
  });
});

describe("enqueueWorkflow seed randomization (#865)", () => {
  it("never draws above the node's declared max (ClaudeNode int32)", async () => {
    // With the old fixed 2**32 range this draw lands at 4294967291, which
    // ComfyUI rejects with "Value 4294967291 bigger than max of 2147483647".
    vi.spyOn(Math, "random").mockReturnValue(0.9999999);
    await enqueueWorkflow({
      "1": { class_type: "ClaudeNode", inputs: { prompt: "hi", seed: 1 } },
    });
    const seed = enqueuedWorkflow()["1"].inputs.seed as number;
    expect(seed).toBeLessThanOrEqual(INT32_MAX);
    // Assert the exact draw, not just the bound: min + floor(r * (max-min+1)).
    expect(seed).toBe(Math.floor(0.9999999 * (INT32_MAX + 1)));
  });

  it("uses the int32 fallback when the class_type is unknown to object_info", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.9999999);
    await enqueueWorkflow({
      "1": { class_type: "CustomNodeNotInObjectInfo", inputs: { seed: 1 } },
    });
    const seed = enqueuedWorkflow()["1"].inputs.seed as number;
    expect(seed).toBeLessThanOrEqual(INT32_MAX);
    expect(seed).toBe(Math.floor(0.9999999 * (INT32_MAX + 1)));
  });

  it("still enqueues with the int32 fallback when /object_info cannot be fetched", async () => {
    getObjectInfoMock.mockRejectedValue(new Error("server mid-restart"));
    vi.spyOn(Math, "random").mockReturnValue(0.9999999);
    const result = await enqueueWorkflow({
      "1": { class_type: "ClaudeNode", inputs: { seed: 1 } },
    });
    expect(result.prompt_id).toBe("pid-1");
    const seed = enqueuedWorkflow()["1"].inputs.seed as number;
    expect(seed).toBeLessThanOrEqual(INT32_MAX);
  });

  it("draws within a wider declared range when the node allows it", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    await enqueueWorkflow({
      "3": { class_type: "KSampler", inputs: { seed: 1 } },
    });
    const seed = enqueuedWorkflow()["3"].inputs.seed as number;
    // 0 + floor(0.5 * 2**64) — above the int32 range the old code capped at.
    expect(seed).toBeGreaterThan(INT32_MAX);
  });

  it("leaves inputs named in preserve_seed_inputs exactly as supplied", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    await enqueueWorkflow(
      {
        "3": {
          class_type: "KSampler",
          inputs: { seed: 42, noise_seed: 7 },
        },
      },
      { preserve_seed_inputs: ["seed"] },
    );
    const inputs = enqueuedWorkflow()["3"].inputs;
    expect(inputs.seed).toBe(42); // caller-fixed, untouched
    expect(inputs.noise_seed).not.toBe(7); // still re-randomized
  });

  it("does not touch any seed when disable_random_seed is set", async () => {
    await enqueueWorkflow(
      {
        "1": { class_type: "ClaudeNode", inputs: { seed: 1 } },
        "3": { class_type: "KSampler", inputs: { seed: 42 } },
      },
      { disable_random_seed: true },
    );
    const wf = enqueuedWorkflow();
    expect(wf["1"].inputs.seed).toBe(1);
    expect(wf["3"].inputs.seed).toBe(42);
  });

  it("registers the job watcher with the workflow actually sent", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    await enqueueWorkflow({
      "1": { class_type: "ClaudeNode", inputs: { seed: 1 } },
    });
    expect(watchMock).toHaveBeenCalledTimes(1);
    expect(watchMock.mock.calls[0][0]).toBe("pid-1");
    expect(watchMock.mock.calls[0][1]).toEqual(enqueuedWorkflow());
  });
});
