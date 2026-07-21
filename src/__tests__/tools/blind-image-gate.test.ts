// The Blind content-mode gate (panel issue #90): with COMFYUI_MCP_BLIND=1 the
// tool-registration boundary replaces every image content block with an honest
// text block — for BOTH the live McpServer path and the compact-mode catalog
// (call_tool router), so no image-returning tool can leak pixels to the model.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectToolCatalog } from "../../tools/index.js";

const PIXELS = Buffer.from("fake-png-bytes-here").toString("base64");

describe("blind image gate (COMFYUI_MCP_BLIND)", () => {
  const prev = process.env.COMFYUI_MCP_BLIND;
  beforeEach(() => {
    process.env.COMFYUI_MCP_BLIND = "1";
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.COMFYUI_MCP_BLIND;
    else process.env.COMFYUI_MCP_BLIND = prev;
  });

  it("scrubs image blocks and leaves text blocks intact (wrapper semantics)", async () => {
    // Exercise the boundary directly: register a synthetic tool through
    // registerAllTools' gate by reaching the same wrapper via collectToolCatalog
    // is awkward — the catalog only captures known groups. So assert semantics
    // on a real captured handler: view_image with a stubbed registry.
    const { AssetRegistry } = await import("../../services/asset-registry.js");
    const catalog = await collectToolCatalog();
    const entry = catalog.get("view_image");
    expect(entry).toBeTruthy();
    // Stub fetch so viewAssetImage returns real-looking pixels.
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(Buffer.from("fake-png-bytes-here"), {
        status: 200,
        headers: { "content-type": "image/png" },
      })) as typeof fetch;
    try {
      const [rec] = AssetRegistry.register({
        promptId: "p1",
        workflow: {},
        outputs: [{ node_id: "9", images: [{ filename: "blindtest.png", subfolder: "", type: "output" }] }],
      });
      const id = rec.assetId;
      const result = (await entry!.handler({ asset_id: id })) as {
        content: Array<{ type: string; text?: string; data?: string }>;
      };
      expect(result.content.some((b) => b.type === "image")).toBe(false);
      const note = result.content.find((b) => b.type === "text" && b.text?.includes("Blind mode"));
      expect(note).toBeTruthy();
      expect(note!.text).toContain("image withheld");
      expect(JSON.stringify(result)).not.toContain(PIXELS);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("without the env, pixels pass through unchanged", async () => {
    delete process.env.COMFYUI_MCP_BLIND;
    const { AssetRegistry } = await import("../../services/asset-registry.js");
    const catalog = await collectToolCatalog();
    const entry = catalog.get("view_image");
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(Buffer.from("fake-png-bytes-here"), {
        status: 200,
        headers: { "content-type": "image/png" },
      })) as typeof fetch;
    try {
      const [rec] = AssetRegistry.register({
        promptId: "p2",
        workflow: {},
        outputs: [{ node_id: "9", images: [{ filename: "cleartest.png", subfolder: "", type: "output" }] }],
      });
      const id = rec.assetId;
      const result = (await entry!.handler({ asset_id: id })) as {
        content: Array<{ type: string; data?: string }>;
      };
      expect(result.content.some((b) => b.type === "image")).toBe(true);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
