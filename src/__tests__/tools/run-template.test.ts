import { describe, expect, it, beforeEach, afterAll, vi } from "vitest";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ObjectInfo } from "../../comfyui/types.js";

// Mock template resolution (skills-access) + enqueue + status/history; keep
// override parsing + modifyWorkflow (set_input) real so we test the actual
// "resolve → apply overrides → enqueue" path end to end.
const resolvePackWorkflowFileMock = vi.fn<(name: string) => string | null>();
const enumeratePacksMock = vi.fn(() => [
  { name: "anima-txt2img", has_workflow: true },
  { name: "anima-img2img", has_workflow: true },
  { name: "krea2-txt2img", has_workflow: true },
]);
vi.mock("../../tools/skills-access.js", () => ({
  resolvePackWorkflowFile: (...a: [string]) => resolvePackWorkflowFileMock(...a),
  enumeratePacks: () => enumeratePacksMock(),
}));

const enqueueWorkflowMock = vi.fn(async () => ({
  prompt_id: "rt-prompt-1",
  queue_remaining: 0,
}));
vi.mock("../../services/workflow-executor.js", () => ({
  enqueueWorkflow: (...a: unknown[]) => enqueueWorkflowMock(...a),
}));

const getJobStatusMock = vi.fn();
vi.mock("../../services/queue-manager.js", () => ({
  getJobStatus: (...a: unknown[]) => getJobStatusMock(...a),
}));

const getHistoryMock = vi.fn();
const getObjectInfoMock = vi.fn(async () => ({}));
vi.mock("../../comfyui/client.js", () => ({
  getHistory: (...a: unknown[]) => getHistoryMock(...a),
  getObjectInfo: () => getObjectInfoMock(),
}));

import { registerWorkflowExecuteTools } from "../../tools/workflow-execute.js";
import { waitFor } from "../helpers/wait-for.js";

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
}>;

function getHandler(): ToolHandler {
  let handler: ToolHandler | undefined;
  const server = {
    tool: (n: string, _d: string, _s: unknown, h: ToolHandler) => {
      if (n === "enqueue_workflow") handler = h;
    },
  };
  registerWorkflowExecuteTools(server as never);
  if (!handler) throw new Error("enqueue_workflow not registered");
  return handler;
}

// A minimal API-format template graph on disk (what resolvePackWorkflowFile returns).
const TEMPLATE_GRAPH = {
  "3": {
    class_type: "KSampler",
    inputs: { seed: 1, steps: 20, cfg: 7, model: ["4", 0], positive: ["6", 0] },
  },
  "6": {
    class_type: "CLIPTextEncode",
    // `size` is an ARRAY-valued widget whose first element is NOT a node id —
    // it must be overridable (not misclassified as a graph connection).
    inputs: { text: "default prompt", size: [1024, 1024], clip: ["4", 1] },
  },
  // #1037 — a V3 DYNAMICCOMBO's nested leaves are keyed "<combo>.<leaf>" in the
  // API prompt, so an override key naming one contains TWO dots. Modelled on the
  // reported ResizeImageMaskNode, with one leaf LINKED and one a plain widget.
  "343": {
    class_type: "ResizeImageMaskNode",
    inputs: {
      resize_type: "scale dimensions",
      // Points at node "3", which EXISTS here — isLinkRef only treats an array
      // as a connection when its first element is a real node id.
      "resize_type.width": ["3", 0],
      "resize_type.crop": "center",
      scale_method: "lanczos",
    },
  },
};

const dir = mkdtempSync(join(tmpdir(), "run-template-"));
const wfFile = join(dir, "workflow.json");
writeFileSync(wfFile, JSON.stringify(TEMPLATE_GRAPH));

afterAll(() => rmSync(dir, { recursive: true, force: true }));

beforeEach(() => {
  resolvePackWorkflowFileMock.mockReset().mockReturnValue(wfFile);
  enqueueWorkflowMock.mockClear();
  getJobStatusMock.mockReset();
  getHistoryMock.mockReset();
  getObjectInfoMock.mockReset().mockResolvedValue({});
});

const KREA_PACKS = [
  "krea2-txt2img-manual",
  "krea2-txt2img-json",
  "krea2-combo",
] as const;

const RBG_REQUIRED_INPUTS = [
  "conditioning",
  "variance_preset",
  "fine_tune_variance",
  "model_type",
  "fade_curve",
  "noise_injection",
  "protect_mode",
  "protect_regions",
  "direction_shift",
  "shift_strength",
  "variance_schedule",
  "cutoff_step",
  "total_steps",
  "cutoff_strength",
  "seed",
] as const;

function rbgObjectInfo(withInputOrder: boolean): ObjectInfo {
  const required = {
    conditioning: ["CONDITIONING"],
    variance_preset: [["🌿 Balanced", "⚙️ Custom"]],
    fine_tune_variance: ["INT", { min: 0, max: 100 }],
    model_type: [["⚙️ Other", "📸 Krea2 (SingleStream)"]],
    fade_curve: [["Instant", "Linear"]],
    noise_injection: [["Beginning Steps", "Ending Steps"]],
    protect_mode: [["🚫 None", "First Half"]],
    protect_regions: ["STRING", { default: "" }],
    direction_shift: [["🚫 None", "🌀 Chaos"]],
    shift_strength: ["INT", { min: 0, max: 200 }],
    variance_schedule: [["constant", "decreasing", "step_cutoff", "tiered_release", "hard_lock"]],
    cutoff_step: ["INT", { min: 0, max: 100 }],
    total_steps: ["INT", { min: 1, max: 100 }],
    cutoff_strength: ["FLOAT", { min: 0, max: 1 }],
    seed: ["INT", { min: 0, max: Number.MAX_SAFE_INTEGER }],
  };
  const def = {
    input: {
      required,
      // These current optional fields prove that adding optional schema entries
      // after seed does not consume the seed-control phantom or shift the row.
      optional: {
        target_vibe: ["CONDITIONING"],
        vibe_blend: ["FLOAT", { min: 0, max: 1 }],
      },
    },
    ...(withInputOrder
      ? {
          input_order: {
            required: [...RBG_REQUIRED_INPUTS],
            optional: ["target_vibe", "vibe_blend"],
          },
        }
      : {}),
    output: ["CONDITIONING", "IMAGE"],
    output_is_list: [false, false],
    output_name: ["conditioning", "variance_heatmap"],
    name: "RBG_Smart_Seed_Variance",
    display_name: "RBG Smart Seed Variance",
    description: "",
    category: "RBG Suite/Advanced",
    output_node: false,
  };
  return { RBG_Smart_Seed_Variance: def } as unknown as ObjectInfo;
}

function activeKreaPackFile(pack: (typeof KREA_PACKS)[number]): {
  file: string;
  seed: number;
} {
  const graph = JSON.parse(
    readFileSync(new URL(`../../../packs/${pack}/workflow.json`, import.meta.url), "utf8"),
  ) as { nodes: Array<{ type: string; mode?: number; widgets_values?: unknown[] }> };
  const node = graph.nodes.find((candidate) => candidate.type === "RBG_Smart_Seed_Variance");
  if (!node || !Array.isArray(node.widgets_values)) throw new Error(`${pack} has no RBG node`);
  node.mode = 0;
  const seed = node.widgets_values[13];
  if (typeof seed !== "number") throw new Error(`${pack} RBG seed is not numeric`);
  const file = join(dir, `${pack}-active.json`);
  writeFileSync(file, JSON.stringify(graph));
  return { file, seed };
}

describe('enqueue_workflow (action:"run_template")', () => {
  it("applies '<nodeId>.<widget>' overrides so the ENQUEUED workflow reflects them", async () => {
    const handler = getHandler();

    const res = await handler({
      action: "run_template",
      template: "anima-txt2img",
      overrides: { "6.text": "a red fox in snow", "3.steps": 8, "3.cfg": 1.5 },
    });

    expect(res.isError).toBeFalsy();
    expect(enqueueWorkflowMock).toHaveBeenCalledTimes(1);
    const enqueued = enqueueWorkflowMock.mock.calls[0][0] as typeof TEMPLATE_GRAPH;
    expect(enqueued["6"].inputs.text).toBe("a red fox in snow");
    expect(enqueued["3"].inputs.steps).toBe(8);
    expect(enqueued["3"].inputs.cfg).toBe(1.5);
    // untouched slots + wiring survive
    expect(enqueued["3"].inputs.model).toEqual(["4", 0]);
    expect(enqueued["6"].inputs.clip).toEqual(["4", 1]);

    const out = JSON.parse(res.content[0].text);
    expect(out.prompt_id).toBe("rt-prompt-1");
    expect(out.status).toBe("enqueued");
    expect(out.overrides_applied).toEqual(["6.text", "3.steps", "3.cfg"]);
  });

  // #1037 — the reporter's blocked workaround, and why it was never the parser.
  //
  // `overrides={"343.resize_type.crop":"center"}` came back as "node 343 has no
  // input resize_type.crop. Overridable widgets: resize_type, scale_method". The
  // key splits on the FIRST dot, so `widget` was already "resize_type.crop" —
  // correct. The key was missing from the GRAPH, because the converter was
  // dropping it (fixed in 0.50.14). So the blocked escape hatch was a SYMPTOM of
  // the same bug, not a second one. These pin that it now works, and that the
  // guards either side of it did not loosen.
  it("accepts a NESTED '<nodeId>.<combo>.<leaf>' override key", async () => {
    const handler = getHandler();
    const res = await handler({
      action: "run_template",
      template: "anima-txt2img",
      overrides: { "343.resize_type.crop": "disabled" },
    });
    expect(res.isError).toBeFalsy();
    const enqueued = enqueueWorkflowMock.mock.calls[0][0] as Record<
      string,
      { inputs: Record<string, unknown> }
    >;
    expect(enqueued["343"].inputs["resize_type.crop"]).toBe("disabled");
    // Siblings untouched.
    expect(enqueued["343"].inputs.scale_method).toBe("lanczos");
    expect(enqueued["343"].inputs.resize_type).toBe("scale dimensions");
  });

  // A LINKED nested leaf is still a graph connection — overriding it would break
  // the wiring, and the nested key must not smuggle past that guard.
  it("still refuses to override a LINKED nested leaf", async () => {
    const handler = getHandler();
    const res = await handler({
      action: "run_template",
      template: "anima-txt2img",
      overrides: { "343.resize_type.width": 512 },
    });
    expect(res.isError).toBe(true);
    expect(String((res.content[0] as { text: string }).text)).toContain(
      "graph CONNECTION, not a widget",
    );
  });

  it("still rejects a nested key the node does not have", async () => {
    const handler = getHandler();
    const res = await handler({
      action: "run_template",
      template: "anima-txt2img",
      overrides: { "343.resize_type.nope": 1 },
    });
    expect(res.isError).toBe(true);
    // The text is a JSON envelope, so quotes arrive escaped — match on the key
    // names rather than the punctuation around them.
    const text = String((res.content[0] as { text: string }).text);
    expect(text).toContain("has no input");
    expect(text).toContain("resize_type.nope");
    expect(text).toContain("resize_type.crop"); // the real keys are listed
  });

  it("enqueues the template unmodified when no overrides given", async () => {
    const handler = getHandler();
    const res = await handler({ action: "run_template", template: "anima-txt2img" });
    expect(res.isError).toBeFalsy();
    const enqueued = enqueueWorkflowMock.mock.calls[0][0] as typeof TEMPLATE_GRAPH;
    expect(enqueued["6"].inputs.text).toBe("default prompt");
  });

  it("maps all Krea2 pack RBG widgets through current schemas, with or without input_order", async () => {
    const handler = getHandler();

    for (const withInputOrder of [true, false]) {
      getObjectInfoMock.mockResolvedValue(rbgObjectInfo(withInputOrder));
      for (const pack of KREA_PACKS) {
        const { file, seed } = activeKreaPackFile(pack);
        resolvePackWorkflowFileMock.mockReturnValue(file);
        enqueueWorkflowMock.mockClear();

        const res = await handler({ action: "run_template", template: pack });
        expect(res.isError).toBeFalsy();
        const enqueued = enqueueWorkflowMock.mock.calls.at(-1)?.[0] as Record<
          string,
          { class_type: string; inputs: Record<string, unknown> }
        >;
        const rbg = Object.values(enqueued).find(
          (node) => node.class_type === "RBG_Smart_Seed_Variance",
        );
        expect(rbg, `${pack} should preserve the active RBG node`).toBeDefined();
        expect(rbg?.inputs).toMatchObject({
          variance_preset: "🌿 Balanced",
          fine_tune_variance: 55,
          model_type: "⚙️ Other",
          fade_curve: "Instant",
          noise_injection: "Beginning Steps",
          protect_mode: "🚫 None",
          protect_regions: "🚫 None",
          direction_shift: "🚫 None",
          shift_strength: 129,
          variance_schedule: "constant",
          cutoff_step: 8,
          total_steps: 20,
          cutoff_strength: 0,
          seed,
        });
        expect(rbg?.inputs).not.toHaveProperty("randomize");
      }
    }
  });

  it("errors with near-matches when the template does not resolve", async () => {
    resolvePackWorkflowFileMock.mockReturnValue(null);
    const handler = getHandler();

    const res = await handler({ action: "run_template", template: "anima-txt2mg" });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/No template named .{0,2}anima-txt2mg/);
    expect(res.content[0].text).toMatch(/anima-txt2img/);
    expect(enqueueWorkflowMock).not.toHaveBeenCalled();
  });

  it("rejects override keys without the nodeId.widget shape", async () => {
    const handler = getHandler();
    const res = await handler({ action: "run_template", template: "anima-txt2img", overrides: { steps: 8 } });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/<nodeId>\.<widget_name>/);
    expect(enqueueWorkflowMock).not.toHaveBeenCalled();
  });

  it("rejects overrides naming a missing node or widget, listing what exists", async () => {
    const handler = getHandler();

    const badNode = await handler({ action: "run_template", template: "anima-txt2img", overrides: { "99.text": "x" } });
    expect(badNode.isError).toBe(true);
    expect(badNode.content[0].text).toMatch(/no node .{0,2}99/);

    const badWidget = await handler({ action: "run_template", template: "anima-txt2img", overrides: { "6.nope": "x" } });
    expect(badWidget.isError).toBe(true);
    expect(badWidget.content[0].text).toMatch(/has no input .{0,2}nope/);
    expect(badWidget.content[0].text).toMatch(/text/); // lists available inputs
    expect(enqueueWorkflowMock).not.toHaveBeenCalled();
  });

  it("allows overriding an array-valued widget (not a link — first element isn't a node id)", async () => {
    const handler = getHandler();
    const res = await handler({
      action: "run_template",
      template: "anima-txt2img",
      overrides: { "6.size": [512, 768] },
    });
    expect(res.isError).toBeFalsy();
    const enqueued = enqueueWorkflowMock.mock.calls[0][0] as typeof TEMPLATE_GRAPH;
    expect(enqueued["6"].inputs.size).toEqual([512, 768]);
  });

  it("rejects overrides targeting a graph CONNECTION (link) input", async () => {
    const handler = getHandler();
    // "3.positive" is ["6", 0] and node "6" exists → a real connection.
    const res = await handler({ action: "run_template", template: "anima-txt2img", overrides: { "3.positive": "x" } });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/CONNECTION/);
    expect(res.content[0].text).toMatch(/seed/); // lists overridable widgets
    expect(enqueueWorkflowMock).not.toHaveBeenCalled();
  });

  it("wait:true polls to completion and returns outputs", async () => {
    getJobStatusMock
      .mockResolvedValueOnce({ running: true, pending: false, done: false })
      .mockResolvedValue({ running: false, pending: false, done: true });
    getHistoryMock.mockResolvedValue({
      "rt-prompt-1": {
        outputs: { "9": { images: [{ filename: "fox.png", type: "output" }] } },
      },
    });
    const handler = getHandler();

    const p = handler({ action: "run_template", template: "anima-txt2img", wait: true, timeout_s: 30 });
    // first poll: not done → 1.5s sleep → second poll: done
    await waitFor(async () => {
      const res = await p;
      const out = JSON.parse(res.content[0].text);
      expect(out.status).toBe("completed");
      expect(out.outputs["9"].images[0].filename).toBe("fox.png");
    }, { timeout: 10000 });
  }, 15000);
});
