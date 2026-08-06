// #796 — the missing-model resolver (download_model action:"resolve_missing")
// folded a FAILED provider lookup into an empty
// result and then asserted "No candidates found on CivitAI or HuggingFace —
// try a different query": "could not look" narrated as "nothing exists",
// with advice that blames the query. The message must state the failure.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../comfyui/client.js", () => ({
  getObjectInfo: async () => ({
    CheckpointLoaderSimple: {
      input: { required: { ckpt_name: [["already-have.safetensors"], {}] } },
    },
  }),
  getSystemStats: async () => ({ devices: [{ vram_total: 16 * 1024 ** 3 }] }),
}));

const providers = vi.hoisted(() => ({ civitaiDown: true, hfDown: true }));
vi.mock("../../services/civitai-resolver.js", () => ({
  searchCivitaiModels: async () => {
    if (providers.civitaiDown) throw new Error("civitai 503");
    return { hits: [] };
  },
}));
vi.mock("../../services/model-resolver.js", () => ({
  searchHuggingFaceModels: async () => {
    if (providers.hfDown) throw new Error("hf timeout");
    return [];
  },
}));

import { resolveMissingModelsAction } from "../../tools/missing-models.js";

type Handler = (args: any) => Promise<{ content: Array<{ text?: unknown }> }>;

/**
 * 0.50.0 slice 11 retired the tool into download_model action:"resolve_missing".
 * The HANDLER is unchanged, so this file calls it directly; dispatch and the
 * `workflow` presence guard are covered in models-consolidated.test.ts.
 */
function captureHandler(): Handler {
  return resolveMissingModelsAction;
}

const WORKFLOW = {
  "1": {
    class_type: "CheckpointLoaderSimple",
    inputs: { ckpt_name: "flux1-dev.safetensors" },
  },
};

beforeEach(() => {
  providers.civitaiDown = true;
  providers.hfDown = true;
});

describe('action:"resolve_missing" never calls a failed lookup an empty one', () => {
  it("both providers down → 'could not look', NOT 'nothing exists'", async () => {
    const res = await captureHandler()({ workflow: WORKFLOW });
    const text = res.content[0]!.text as string;
    expect(text).toMatch(/the lookup FAILED/);
    expect(text).toMatch(/could not look/);
    expect(text).not.toMatch(/No candidates found on CivitAI or HuggingFace/);
  });

  it("one provider down with zero hits from the other → still not 'nothing exists'", async () => {
    providers.hfDown = false; // answers, but with nothing
    const res = await captureHandler()({ workflow: WORKFLOW });
    const text = res.content[0]!.text as string;
    expect(text).toMatch(/the lookup FAILED \(CivitAI\)/);
    expect(text).not.toMatch(/No candidates found on CivitAI or HuggingFace/);
  });

  it("both providers answering empty → the plain 'no candidates' message (control)", async () => {
    providers.civitaiDown = false;
    providers.hfDown = false;
    const res = await captureHandler()({ workflow: WORKFLOW });
    const text = res.content[0]!.text as string;
    expect(text).toMatch(/No candidates found on CivitAI or HuggingFace/);
    expect(text).not.toMatch(/lookup FAILED/);
  });
});
