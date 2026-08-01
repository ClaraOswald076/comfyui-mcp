import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { registerModelExplorerTools, explorerHttpError } from "../../tools/model-explorer.js";

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
}>;

function makeServer() {
  const handlers = new Map<string, ToolHandler>();
  const server = {
    tool: (name: string, _desc: string, _schema: unknown, handler: ToolHandler) => {
      handlers.set(name, handler);
    },
  };
  registerModelExplorerTools(server as never);
  return {
    read: handlers.get("model_metadata_read")!,
    fetchCivitai: handlers.get("model_metadata_fetch_civitai")!,
  };
}

describe("explorerHttpError", () => {
  it("turns a 404 into an actionable message covering BOTH causes (not a raw 404)", () => {
    const err = explorerHttpError("detail", 404);
    expect(err.message).toContain("comfyui-model-explorer");
    // Actionable install guidance for the node-absent case.
    expect(err.message).toMatch(/ComfyUI-Manager|install_custom_node/);
    // Does NOT over-claim the node is definitely absent — also covers the
    // installed-but-model-not-found case (codex #363 concern).
    expect(err.message).toContain("Most likely");
    expect(err.message).toContain("IS installed");
    expect(err.message).toContain("could not find the requested model file");
  });

  it("appends the upstream body as a hint when present", () => {
    expect(explorerHttpError("detail", 404, "model not found: foo").message).toContain(
      "Upstream detail: model not found: foo",
    );
  });

  it("passes non-404 statuses through as a plain upstream error", () => {
    expect(explorerHttpError("detail", 503).message).toBe("model_explorer detail HTTP 503");
    expect(explorerHttpError("civitai", 500).message).toBe("model_explorer civitai HTTP 500");
  });
});

describe("model_metadata_read / fetch_civitai 404 handling", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("model_metadata_read: 404 → actionable message, not a raw HTTP 404", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404, text: async () => "" });
    const { read } = makeServer();
    const res = await read({ category: "checkpoints", name: "model.safetensors" });

    expect(res.isError).toBe(true);
    const text = res.content[0].text;
    expect(text).toContain("comfyui-model-explorer");
    expect(text).toContain("could not find the requested model file");
    // Must NOT be the old raw-status phrasing.
    expect(text).not.toContain("detail HTTP 404 (is ComfyUI running");
  });

  it("model_metadata_fetch_civitai: 404 (no version_id) → optional-feature-unavailable message, points at version_id path", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404, text: async () => "" });
    const { fetchCivitai } = makeServer();
    const res = await fetchCivitai({ category: "loras", name: "x.safetensors" });

    expect(res.isError).toBe(true);
    const text = res.content[0].text;
    expect(text).toContain("comfyui-model-explorer");
    expect(text).toContain("OPTIONAL");
    // Tells the caller how to recover without the node.
    expect(text).toContain("version_id");
    expect(text).not.toContain("civitai HTTP 404");
  });

  it("model_metadata_fetch_civitai: 404 WITH version_id → degrades to CivitAI public API (no error)", async () => {
    fetchMock
      // node route 404s (node absent)
      .mockResolvedValueOnce({ ok: false, status: 404, text: async () => "" })
      // direct CivitAI public API succeeds
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          id: 1567118,
          modelId: 900,
          name: "v2",
          baseModel: "Flux.1 D",
          model: { name: "Dark Fantasy", type: "LORA", nsfw: false },
          trainedWords: ["dark fantasy"],
          description: "desc",
          downloadUrl: "https://civitai.com/api/download/models/1567118",
          images: [{ url: "u", meta: { prompt: "a dark fantasy castle" } }],
        }),
      });
    const { fetchCivitai } = makeServer();
    const res = await fetchCivitai({ category: "loras", name: "x.safetensors", version_id: 1567118 });

    expect(res.isError).toBeFalsy();
    const text = res.content[0].text;
    expect(text).toContain("civitai-public-api");
    expect(text).toContain("dark fantasy");
    expect(text).toContain("a dark fantasy castle"); // mined example prompt
    expect(text).toContain("1567118");
    // The public API URL was used for the fallback.
    const calledUrls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(calledUrls.some((u) => u.includes("civitai.com/api/v1/model-versions/1567118"))).toBe(true);
  });

  it("model_metadata_fetch_civitai: 404 WITH version_id but public API also fails → clear error noting the version lookup failed", async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 404, text: async () => "" })
      .mockResolvedValueOnce({ ok: false, status: 404, text: async () => "" });
    const { fetchCivitai } = makeServer();
    const res = await fetchCivitai({ category: "loras", name: "x.safetensors", version_id: 999999999 });

    expect(res.isError).toBe(true);
    const text = res.content[0].text;
    expect(text).toContain("comfyui-model-explorer");
    expect(text).toContain("version_id was supplied");
  });

  it("model_metadata_read: still succeeds when the node is present", async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ classify: { asset_type: "checkpoint" }, namespaces: {} }),
      })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ candidates: [] }) });
    const { read } = makeServer();
    const res = await read({ category: "checkpoints", name: "model.safetensors" });

    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain("checkpoint");
  });
});
