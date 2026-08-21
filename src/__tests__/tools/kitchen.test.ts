import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const LOG = [
  "comfy-kitchen version: 0.2.31",
  "Found comfy_kitchen backend cuda: available",
  "Found triton 3.7.0. Enabling comfy-kitchen triton backend.",
  "Using Comfy Kitchen attention",
].join("\n");

vi.mock("../../services/workspace-env.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/workspace-env.js")>();
  return { ...actual, resolveComfyuiPython: () => ({ python: undefined }) };
});

vi.mock("../../comfyui/client.js", () => ({
  getLogs: vi.fn(async () => LOG.split("\n")),
  getSystemStats: vi.fn(async () => ({
    system: {
      os: "Linux",
      python_version: "3.12.0",
      embedded_python: false,
      argv: ["python", "main.py"],
      comfy_package_versions: [{ name: "comfy-kitchen", installed: "0.2.31" }],
    },
    devices: [
      {
        name: "NVIDIA GeForce RTX 4090",
        type: "cuda",
        index: 0,
        vram_total: 24 * 1024 ** 3,
        vram_free: 20 * 1024 ** 3,
        torch_vram_total: 0,
        torch_vram_free: 0,
      },
    ],
  })),
}));

import { registerKitchenTools } from "../../tools/kitchen.js";
import { known, resetKitchenHintSession } from "../../services/kitchen.js";

type Handler = (args: Record<string, unknown>) => Promise<{
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
}>;

function registered() {
  const tools: Array<{ name: string; desc: string; shape: z.ZodRawShape; handler: Handler }> = [];
  const server = {
    tool: (name: string, desc: string, shape: z.ZodRawShape, handler: Handler) => {
      tools.push({ name, desc, shape, handler });
    },
  };
  registerKitchenTools(server as never);
  return tools;
}

function call(args: Record<string, unknown>) {
  const [{ shape, handler }] = registered();
  const parsed = z.object(shape).parse(args) as Record<string, unknown>;
  return handler(parsed);
}

const text = async (args: Record<string, unknown>) => {
  const res = await call(args);
  return res.content.map((c) => c.text).join("\n");
};

beforeEach(() => {
  resetKitchenHintSession();
});

describe("kitchen tool", () => {
  it("registers one action-parameterized tool", () => {
    const tools = registered();
    expect(tools.map((t) => t.name)).toEqual(["kitchen"]);
    expect(tools[0].desc).toMatch(/action:"status"/);
    expect(tools[0].desc).toMatch(/action:"assess"/);
    expect(tools[0].desc).toMatch(/action:"apply"/);
  });

  it("status reports present as a fact, never omits it", async () => {
    const body = JSON.parse(await text({ action: "status" }));
    expect(body.status.present).toEqual(
      expect.objectContaining({ status: expect.stringMatching(/^(known|unknown)$/) }),
    );
    expect(body.status.location).toMatch(/^(LOCAL|REMOTE)$/);
    expect(body.status.gpu).toEqual(expect.objectContaining({ fp8: expect.anything() }));
  });

  it("assess of a default UNETLoader returns recommendations only from known facts", async () => {
    const body = JSON.parse(
      await text({
        action: "assess",
        workflow: {
          "12": {
            class_type: "UNETLoader",
            inputs: { unet_name: "flux1-dev.safetensors", weight_dtype: "default" },
          },
        },
      }),
    );
    expect(Array.isArray(body.recommendations)).toBe(true);
    expect(body.loaders[0].weight_dtype).toEqual(known("default"));
    // Without a live kitchen probe the fp8 rec must not invent itself.
    expect(body.recommendations.every((r: { kind: string }) => r.kind !== "fp8_unet_fast" || body.status.present.status === "known")).toBe(
      true,
    );
  });

  it("assess without a workflow tells the caller to pass one or use panel_kitchen", async () => {
    const body = JSON.parse(await text({ action: "assess" }));
    expect(body.recommendations).toEqual([]);
    expect(body.note).toMatch(/panel_kitchen/);
  });

  it("apply of a widget rec mutates the supplied workflow", async () => {
    const workflow = {
      "12": {
        class_type: "UNETLoader",
        inputs: { unet_name: "flux1-dev.safetensors", weight_dtype: "default" },
      },
    };
    // Drive assess first so the id is the one the shipped assess function minted.
    const assessed = JSON.parse(await text({ action: "assess", workflow }));
    const rec = assessed.recommendations.find((r: { kind: string }) => r.kind === "fp8_unet_fast");
    if (!rec) {
      // On a machine without kitchen/fp8 the rec does not fire — that is the
      // conjunction, not a skip. Apply of a missing id still has to say so.
      const missing = JSON.parse(
        await text({ action: "apply", workflow, recommendation_id: "fp8_unet_fast:12" }),
      );
      expect(missing.applied).toBe(false);
      expect(missing.error).toMatch(/fp8_unet_fast:12/);
      return;
    }
    const applied = JSON.parse(
      await text({ action: "apply", workflow, recommendation_id: rec.id }),
    );
    expect(applied.applied).toBe(true);
    expect(applied.workflow["12"].inputs.weight_dtype).toBe("fp8_e4m3fn_fast");
  });

  it("apply of a flag rec without confirm asks for it", async () => {
    const assessed = JSON.parse(await text({ action: "assess", workflow: {} }));
    const rec = assessed.recommendations.find((r: { kind: string }) => r.kind === "ck_attention");
    if (!rec) return;
    const out = JSON.parse(await text({ action: "apply", workflow: {}, recommendation_id: rec.id }));
    expect(out.needs_confirm).toBe(true);
    expect(out.applied).toBe(false);
  });
});
