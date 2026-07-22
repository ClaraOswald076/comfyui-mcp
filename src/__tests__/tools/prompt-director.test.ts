import { afterEach, describe, expect, it, vi } from "vitest";

import { registerPromptDirectorTools } from "../../tools/prompt-director.js";

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
}>;

function makeServer() {
  const handlers = new Map<string, ToolHandler>();
  const server = {
    tool: (name: string, _description: string, _schema: unknown, handler: ToolHandler) => {
      handlers.set(name, handler);
    },
  };
  registerPromptDirectorTools(server as never);
  return handlers.get("prompt_director_inspect")!;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("prompt_director_inspect tool", () => {
  it("reads the bounded runtime inspection registry and filters by node id", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        schema_version: "1.0",
        inspections: [{ node_id: "42", kind: "prompt_director_auto", payload: { warnings: [] } }],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const inspect = makeServer();
    const result = await inspect({ node_id: "42" });

    // Routed through comfyuiFetch now (so CF Access / COMFYUI_AUTH_* headers reach
    // this endpoint too); with no auth configured it calls fetch(url, {}).
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8188/prompt_director/inspection?node_id=42",
      {},
    );
    expect(result.content[0].text).toContain('"node_id": "42"');
    expect(result.content[0].text).toContain("prompt_director_auto");
  });
});
