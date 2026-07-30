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
  it("turns a 404 into an actionable missing-node message (not a raw 404)", () => {
    const err = explorerHttpError("detail", 404);
    expect(err.message).toContain("comfyui-model-explorer");
    expect(err.message).toContain("not installed");
    // Actionable install guidance.
    expect(err.message).toMatch(/ComfyUI-Manager|install_custom_node/);
    // Clarifies the file itself may exist.
    expect(err.message).toContain("model file itself may be present");
  });

  it("passes non-404 statuses through as a plain upstream error", () => {
    expect(explorerHttpError("detail", 503).message).toBe("model_explorer detail HTTP 503");
  });
});

describe("model_metadata_read missing-node fallback", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns a clear missing-capability message on 404, not a raw HTTP 404", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404 });
    const { read } = makeServer();
    const res = await read({ category: "checkpoints", name: "model.safetensors" });

    expect(res.isError).toBe(true);
    const text = res.content[0].text;
    expect(text).toContain("comfyui-model-explorer");
    expect(text).toContain("not installed");
    // Must NOT be the old raw-status phrasing.
    expect(text).not.toContain("detail HTTP 404 (is ComfyUI running");
  });

  it("still succeeds when the node is present", async () => {
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
