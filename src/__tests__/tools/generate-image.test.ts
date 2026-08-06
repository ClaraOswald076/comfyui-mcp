import { describe, expect, it, beforeEach, vi } from "vitest";

/**
 * `generate_image` — the nine-action generation surface (0.50.0 slice 16).
 *
 * Tests the DISPATCHER, which is the only new code: schema shape, which handler
 * each action reaches with which arguments, the per-action missing-field errors,
 * the one value constraint that had to move from zod into the handler
 * (`strength`), unknown-action rejection, and absence-not-falsiness.
 *
 * A wrong dispatch here is not cosmetic — nine actions build nine different
 * graphs on a real GPU — so there is a table pinning that each action reaches
 * EXACTLY ONE handler and no other.
 */

const generateImageMock = vi.fn(async () => ({
  prompt_id: "p-img",
  queue_remaining: 0,
  checkpoint: "sd15.safetensors",
}));
vi.mock("../../services/generate-image.js", () => ({
  generateImage: (...a: unknown[]) => generateImageMock(...a),
}));

vi.mock("../../services/workflow-executor.js", () => ({
  enqueueWorkflow: async () => ({ prompt_id: "p-x", queue_remaining: 0 }),
}));
vi.mock("../../services/model-resolver.js", () => ({
  listLocalModels: async () => [{ name: "sd15.safetensors" }],
}));
vi.mock("../../services/remove-background.js", () => ({
  REMBG_NODE: "RMBG",
}));

const result = (text: string) => ({ content: [{ type: "text" as const, text }] });

const audioMock = vi.fn(async () => result("audio-result"));
vi.mock("../../tools/generate-audio.js", () => ({
  generateAudioAction: (...a: unknown[]) => audioMock(...a),
}));
const threeDMock = vi.fn(async () => result("3d-result"));
vi.mock("../../tools/generate-3d.js", () => ({
  generate3dAction: (...a: unknown[]) => threeDMock(...a),
}));
const videoMock = vi.fn(async () => result("video-result"));
vi.mock("../../tools/generate-video.js", () => ({
  generateVideoAction: (...a: unknown[]) => videoMock(...a),
}));
const upscaleMock = vi.fn(async () => result("upscale-result"));
vi.mock("../../tools/upscale-image.js", () => ({
  upscaleImageAction: (...a: unknown[]) => upscaleMock(...a),
}));
const rmbgMock = vi.fn(async () => result("rmbg-result"));
vi.mock("../../tools/remove-background.js", () => ({
  removeBackgroundAction: (...a: unknown[]) => rmbgMock(...a),
}));
const controlnetMock = vi.fn(async () => result("controlnet-result"));
const ipAdapterMock = vi.fn(async () => result("ip-adapter-result"));
vi.mock("../../tools/generate-conditioned.js", () => ({
  generateWithControlNetAction: (...a: unknown[]) => controlnetMock(...a),
  generateWithIpAdapterAction: (...a: unknown[]) => ipAdapterMock(...a),
}));
const regenerateMock = vi.fn(async () => result("re-render-result"));
vi.mock("../../tools/assets.js", () => ({
  regenerateAction: (...a: unknown[]) => regenerateMock(...a),
}));

import { z } from "zod";
import { registerGenerateImageTool } from "../../tools/generate-image.js";

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
}>;

function capture(): { handler: ToolHandler; schema: Record<string, z.ZodTypeAny> } {
  let handler: ToolHandler | undefined;
  let schema: Record<string, z.ZodTypeAny> | undefined;
  const server = {
    tool: (n: string, _d: string, s: Record<string, z.ZodTypeAny>, h: ToolHandler) => {
      if (n === "generate_image") {
        handler = h;
        schema = s;
      }
    },
  };
  registerGenerateImageTool(server as never);
  if (!handler || !schema) throw new Error("generate_image not registered");
  return { handler, schema };
}

const ALL_HANDLERS = [
  audioMock,
  threeDMock,
  videoMock,
  upscaleMock,
  rmbgMock,
  controlnetMock,
  ipAdapterMock,
  regenerateMock,
];

beforeEach(() => {
  vi.clearAllMocks();
  generateImageMock.mockResolvedValue({
    prompt_id: "p-img",
    queue_remaining: 0,
    checkpoint: "sd15.safetensors",
  });
});

describe("generate_image — schema shape", () => {
  it("makes `action` the ONLY required field", () => {
    const { schema } = capture();
    const required = Object.entries(schema)
      .filter(([name]) => name !== "action")
      .filter(([, s]) => !s.safeParse(undefined).success)
      .map(([name]) => name);
    expect(required, "these are schema-required besides `action`").toEqual([]);
    expect(schema.action.safeParse(undefined).success).toBe(false);
  });

  it("exposes its parameters (a discriminated union would render zero)", () => {
    const { schema } = capture();
    const json = z.toJSONSchema(z.object(schema), { io: "input", unrepresentable: "any" }) as {
      properties?: Record<string, unknown>;
    };
    expect(Object.keys(json.properties ?? {})).toEqual(
      expect.arrayContaining([
        "action",
        "prompt",
        "image",
        "asset_id",
        "control_image",
        "reference_image",
        "model_family",
        "duration",
        "mode",
        "scale",
        "model",
      ]),
    );
  });

  it("accepts exactly the nine actions", () => {
    const { schema } = capture();
    for (const a of [
      "image", "audio", "video", "3d", "controlnet",
      "ip_adapter", "regenerate", "upscale", "remove_background",
    ]) {
      expect(schema.action.safeParse(a).success, a).toBe(true);
    }
    expect(schema.action.safeParse("upscale_image").success).toBe(false);
  });

  it("keeps the per-field VALUE constraints the old tools had", () => {
    const { schema } = capture();
    expect(schema.width.safeParse(0).success).toBe(false); // .int().positive()
    expect(schema.cfg.safeParse(-1).success).toBe(false); // .positive()
    expect(schema.scale.safeParse(3).success).toBe(false); // literal 2 | 4
    expect(schema.scale.safeParse(4).success).toBe(true);
    expect(schema.bpm.safeParse(500).success).toBe(false); // 10..300
    expect(schema.temperature.safeParse(3).success).toBe(false); // 0..2
    expect(schema.duration.safeParse(0).success).toBe(false); // .positive()
    expect(schema.model_family.safeParse("nope").success).toBe(false);
    expect(schema.weight_type.safeParse("style transfer").success).toBe(true);
  });

  it("leaves `strength` unconstrained at the zod layer, because two actions disagreed", () => {
    const { schema } = capture();
    // video wanted 0..1, controlnet wanted >0 unbounded. Both are still enforced
    // — in the handler, per action (see the range tests below).
    expect(schema.strength.safeParse(2).success).toBe(true);
    expect(schema.strength.safeParse(0).success).toBe(true);
    expect(schema.strength.safeParse(-1).success).toBe(true);
  });
});

describe("generate_image — per-action dispatch", () => {
  it('action:"image" builds a txt2img with only the txt2img fields', async () => {
    const { handler } = capture();
    const res = await handler({
      action: "image",
      prompt: "a fox",
      width: 512,
      height: 512,
      batch_size: 2,
      // belongs to other actions; must not reach generateImage
      control_image: "pose.png",
      duration: 30,
    });
    expect(generateImageMock).toHaveBeenCalledTimes(1);
    const [args] = generateImageMock.mock.calls[0] as [Record<string, unknown>];
    expect(args).toMatchObject({ prompt: "a fox", width: 512, height: 512, batch_size: 2 });
    expect(args).not.toHaveProperty("control_image");
    expect(args).not.toHaveProperty("duration");
    expect(JSON.parse(res.content[0].text).checkpoint).toBe("sd15.safetensors");
  });

  it('action:"audio" forwards the audio fields', async () => {
    const { handler } = capture();
    const res = await handler({
      action: "audio",
      model_family: "ace_step_1.5",
      prompt: "lofi beat",
      duration: 30,
      bpm: 90,
      lyrics: "la la",
    });
    expect(audioMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model_family: "ace_step_1.5",
        prompt: "lofi beat",
        duration: 30,
        bpm: 90,
        lyrics: "la la",
      }),
    );
    expect(res.content[0].text).toBe("audio-result");
  });

  it('action:"video" forwards the video fields', async () => {
    const { handler } = capture();
    await handler({
      action: "video",
      prompt: "a fox walking",
      seconds: 5,
      resolution: "832x480",
      fps: 16,
      image: "start.png",
      strength: 0.6,
    });
    expect(videoMock).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "a fox walking",
        seconds: 5,
        resolution: "832x480",
        fps: 16,
        image: "start.png",
        strength: 0.6,
      }),
    );
  });

  it('action:"3d" forwards mode/prompt/image/node/inputs', async () => {
    const { handler } = capture();
    await handler({
      action: "3d",
      mode: "image",
      image: "ref.png",
      node: "MeshyImageToModelNode",
      inputs: { style: "pbr" },
    });
    expect(threeDMock).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "image",
        image: "ref.png",
        node: "MeshyImageToModelNode",
        inputs: { style: "pbr" },
      }),
    );
  });

  it('action:"controlnet" forwards the control image and the common fields', async () => {
    const { handler } = capture();
    await handler({
      action: "controlnet",
      prompt: "a fox",
      control_image: "pose.png",
      controlnet_model: "cn.safetensors",
      strength: 1.5,
      steps: 25,
    });
    expect(controlnetMock).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "a fox",
        control_image: "pose.png",
        controlnet_model: "cn.safetensors",
        strength: 1.5,
        steps: 25,
      }),
    );
  });

  it('action:"ip_adapter" forwards the reference image and its knobs', async () => {
    const { handler } = capture();
    await handler({
      action: "ip_adapter",
      prompt: "a fox",
      reference_image: "style.png",
      weight: 0.9,
      weight_type: "style transfer",
    });
    expect(ipAdapterMock).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "a fox",
        reference_image: "style.png",
        weight: 0.9,
        weight_type: "style transfer",
      }),
    );
  });

  it('action:"regenerate" forwards asset_id and overrides', async () => {
    const { handler } = capture();
    await handler({
      action: "regenerate",
      asset_id: "a-1",
      overrides: { steps: 40 },
      disable_random_seed: true,
    });
    expect(regenerateMock).toHaveBeenCalledWith({
      asset_id: "a-1",
      overrides: { steps: 40 },
      disable_random_seed: true,
    });
  });

  it('action:"upscale" forwards image/scale/model only', async () => {
    const { handler } = capture();
    await handler({ action: "upscale", image: "in.png", scale: 2, model: "4x.pth", prompt: "ignored" });
    expect(upscaleMock).toHaveBeenCalledWith({ image: "in.png", scale: 2, model: "4x.pth" });
  });

  it('action:"remove_background" forwards image/model/filename_prefix only', async () => {
    const { handler } = capture();
    await handler({
      action: "remove_background",
      image: "in.png",
      model: "BiRefNet_toonout",
      filename_prefix: "cut",
      scale: 4,
    });
    expect(rmbgMock).toHaveBeenCalledWith({
      image: "in.png",
      model: "BiRefNet_toonout",
      filename_prefix: "cut",
    });
  });

  it("routes each action to EXACTLY ONE handler and no other", async () => {
    const { handler } = capture();
    const table: Array<[Record<string, unknown>, ReturnType<typeof vi.fn> | null]> = [
      [{ action: "image", prompt: "x" }, null], // null = the inline generateImage branch
      [{ action: "audio", model_family: "ace_step_1.5", prompt: "x", duration: 5 }, audioMock],
      [{ action: "video", prompt: "x" }, videoMock],
      [{ action: "3d", mode: "text", prompt: "x" }, threeDMock],
      [{ action: "controlnet", prompt: "x", control_image: "c.png" }, controlnetMock],
      [{ action: "ip_adapter", prompt: "x", reference_image: "r.png" }, ipAdapterMock],
      [{ action: "regenerate", asset_id: "a" }, regenerateMock],
      [{ action: "upscale", image: "i.png" }, upscaleMock],
      [{ action: "remove_background", image: "i.png" }, rmbgMock],
    ];
    for (const [args, expected] of table) {
      vi.clearAllMocks();
      await handler(args);
      for (const m of ALL_HANDLERS) {
        expect(m.mock.calls.length, `${String(args.action)} must not reach a sibling handler`).toBe(
          m === expected ? 1 : 0,
        );
      }
      expect(generateImageMock.mock.calls.length, `${String(args.action)} → generateImage`).toBe(
        expected === null ? 1 : 0,
      );
    }
  });
});

describe("generate_image — missing-field errors NAME the field", () => {
  it.each([
    ["image", "prompt", {}],
    ["audio", "model_family", {}],
    ["audio", "prompt", { model_family: "ace_step_1.5" }],
    ["audio", "duration", { model_family: "ace_step_1.5", prompt: "x" }],
    ["video", "prompt", {}],
    ["3d", "mode", {}],
    ["controlnet", "prompt", {}],
    ["controlnet", "control_image", { prompt: "x" }],
    ["ip_adapter", "prompt", {}],
    ["ip_adapter", "reference_image", { prompt: "x" }],
    ["regenerate", "asset_id", {}],
    ["upscale", "image", {}],
    ["remove_background", "image", {}],
  ])('action:"%s" without `%s` says which field is missing', async (action, field, rest) => {
    const { handler } = capture();
    const res = await handler({ action, ...(rest as Record<string, unknown>) });
    expect(res.isError).toBe(true);
    const { message } = JSON.parse(res.content[0].text) as { message: string };
    expect(message).toContain(`\`${field}\``);
    expect(message).toContain(`action:"${action}"`);
  });
});

describe("generate_image — the strength range moved into the handler, intact", () => {
  it('action:"video" still rejects a strength above 1', async () => {
    const { handler } = capture();
    const res = await handler({ action: "video", prompt: "x", strength: 2 });
    expect(res.isError).toBe(true);
    const { message } = JSON.parse(res.content[0].text) as { message: string };
    expect(message).toContain("`strength`");
    expect(message).toContain("between 0 and 1");
    expect(videoMock).not.toHaveBeenCalled();
  });

  it('action:"video" accepts 0 and 1 at the boundaries, exactly as the old schema did', async () => {
    const { handler } = capture();
    for (const v of [0, 1]) {
      vi.clearAllMocks();
      const res = await handler({ action: "video", prompt: "x", strength: v });
      expect(res.isError, `strength ${v}`).toBeUndefined();
      expect(videoMock).toHaveBeenCalledWith(expect.objectContaining({ strength: v }));
    }
  });

  it('action:"controlnet" accepts 1.5 — a value the video range would have rejected', async () => {
    const { handler } = capture();
    const res = await handler({
      action: "controlnet",
      prompt: "x",
      control_image: "c.png",
      strength: 1.5,
    });
    expect(res.isError).toBeUndefined();
    expect(controlnetMock).toHaveBeenCalledWith(expect.objectContaining({ strength: 1.5 }));
  });

  it('action:"controlnet" still rejects a non-positive strength', async () => {
    const { handler } = capture();
    const res = await handler({
      action: "controlnet",
      prompt: "x",
      control_image: "c.png",
      strength: 0,
    });
    expect(res.isError).toBe(true);
    const { message } = JSON.parse(res.content[0].text) as { message: string };
    expect(message).toContain("`strength`");
    expect(message).toContain("greater than 0");
    expect(controlnetMock).not.toHaveBeenCalled();
  });
});

describe("generate_image — absence, not falsiness", () => {
  it('an EMPTY prompt still reaches the service (it was legal before, and still is)', async () => {
    const { handler } = capture();
    const res = await handler({ action: "image", prompt: "" });
    expect(res.isError).toBeUndefined();
    expect(generateImageMock).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "" }),
      expect.anything(),
    );
  });

  it("an EMPTY asset_id still reaches the registry lookup, which owns the not-found answer", async () => {
    const { handler } = capture();
    await handler({ action: "regenerate", asset_id: "" });
    expect(regenerateMock).toHaveBeenCalledWith(
      expect.objectContaining({ asset_id: "" }),
    );
  });

  it("an EMPTY image filename still reaches the upscale service", async () => {
    const { handler } = capture();
    await handler({ action: "upscale", image: "" });
    expect(upscaleMock).toHaveBeenCalledWith(expect.objectContaining({ image: "" }));
  });

  it("seed 0 is forwarded, not treated as unset", async () => {
    const { handler } = capture();
    await handler({ action: "image", prompt: "x", seed: 0 });
    expect(generateImageMock).toHaveBeenCalledWith(
      expect.objectContaining({ seed: 0 }),
      expect.anything(),
    );
  });
});

describe("generate_image — unknown action", () => {
  it("rejects an unknown action, listing the valid ones", async () => {
    const { handler } = capture();
    const res = await handler({ action: "upscale_image" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("Unknown generate_image action");
    for (const m of ALL_HANDLERS) expect(m).not.toHaveBeenCalled();
    expect(generateImageMock).not.toHaveBeenCalled();
  });
});
