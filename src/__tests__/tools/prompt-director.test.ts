import { afterEach, describe, expect, it, vi } from "vitest";

// 0.50.0 slice 14: this is get_workflow (action:"prompt_director") now, so the
// inspection body is exercised directly rather than through a registrar; the
// dispatch that reaches it is covered by
// src/__tests__/tools/workflow-library.test.ts.
import { promptDirectorInspectAction } from "../../tools/prompt-director.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('get_workflow (action:"prompt_director") inspection', () => {
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

    const result = await promptDirectorInspectAction("42");

    // Routed through comfyuiFetch (so CF Access / COMFYUI_AUTH_* headers reach
    // this endpoint too). With no auth configured the only thing added is the
    // timeout ceiling: this call passes no signal of its own, and before that
    // ceiling existed it could wait forever on a host that never answers.
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8188/prompt_director/inspection?node_id=42");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(result.content[0].text).toContain('"node_id": "42"');
    expect(result.content[0].text).toContain("prompt_director_auto");
  });
});
