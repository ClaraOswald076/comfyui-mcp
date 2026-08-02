import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// --- Mocks (declared before importing the module under test) ---

// The local-fallback path resolves the model on disk via this; stub it so the
// tests don't depend on a configured COMFYUI_PATH / real models tree.
const resolveExistingModelFileMock = vi.fn();
vi.mock("../../services/model-resolver.js", async () => {
  const actual = await vi.importActual<typeof import("../../services/model-resolver.js")>(
    "../../services/model-resolver.js",
  );
  return {
    ...actual,
    resolveExistingModelFile: (...a: unknown[]) => resolveExistingModelFileMock(...a),
  };
});

import {
  registerModelExplorerTools,
  explorerHttpError,
  parseSafetensorsEmbeddedMetadata,
  SAFETENSORS_HEADER_MAX_BYTES,
} from "../../tools/model-explorer.js";

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
    // Default: nothing resolvable locally (remote-mode behavior) — the degrade
    // tests override this with a real temp file.
    resolveExistingModelFileMock.mockReset();
    resolveExistingModelFileMock.mockRejectedValue(new Error("No local ComfyUI path configured (test default)"));
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

/** Build a real safetensors file body: 8-byte LE header length + header JSON
 *  (+ a token tensor payload, which readers here must never touch). */
function makeSafetensorsBytes(metadata: Record<string, string> | null): Buffer {
  const header = {
    "model.layers.0.weight": { dtype: "F16", shape: [2, 2], data_offsets: [0, 8] },
    ...(metadata ? { __metadata__: metadata } : {}),
  };
  const json = Buffer.from(JSON.stringify(header), "utf8");
  const len = Buffer.alloc(8);
  len.writeBigUInt64LE(BigInt(json.length));
  return Buffer.concat([len, json, Buffer.alloc(8)]);
}

describe("parseSafetensorsEmbeddedMetadata", () => {
  it("extracts the __metadata__ map from a valid header", () => {
    const buf = makeSafetensorsBytes({
      "modelspec.architecture": "stable-diffusion-xl-v1-base",
      ss_tag_frequency: "{}",
    });
    expect(parseSafetensorsEmbeddedMetadata(buf)).toEqual({
      "modelspec.architecture": "stable-diffusion-xl-v1-base",
      ss_tag_frequency: "{}",
    });
  });

  it("returns null when the header carries no __metadata__", () => {
    expect(parseSafetensorsEmbeddedMetadata(makeSafetensorsBytes(null))).toBeNull();
  });

  it("returns null for a buffer too short to hold the length prefix", () => {
    expect(parseSafetensorsEmbeddedMetadata(Buffer.from("abc"))).toBeNull();
  });

  it("returns null when the declared header exceeds the safety cap", () => {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64LE(BigInt(SAFETENSORS_HEADER_MAX_BYTES + 1));
    expect(parseSafetensorsEmbeddedMetadata(buf)).toBeNull();
  });

  it("returns null when the buffer is truncated inside the header JSON", () => {
    const buf = makeSafetensorsBytes({ a: "b" });
    // Cut past the 8-byte dummy payload into the header itself.
    expect(parseSafetensorsEmbeddedMetadata(buf.subarray(0, buf.length - 10))).toBeNull();
  });
});

describe("model_metadata_read local fallback (#363 reopen)", () => {
  const fetchMock = vi.fn();
  let dir: string;

  beforeEach(async () => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    resolveExistingModelFileMock.mockReset();
    dir = await mkdtemp(join(tmpdir(), "model-explorer-363-"));
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(dir, { recursive: true, force: true });
  });

  /** Point the resolver mock at a real temp file, the way the real resolver
   *  would (absolute path + genuine fs.Stats). */
  async function stubLocalModel(filePath: string) {
    const info = await stat(filePath);
    resolveExistingModelFileMock.mockResolvedValue({ path: filePath, root: dir, info });
  }

  it("404 + model present locally → structured 'unavailable' result with local metadata, NOT isError", async () => {
    const filePath = join(dir, "model.safetensors");
    await writeFile(
      filePath,
      makeSafetensorsBytes({ "modelspec.architecture": "stable-diffusion-xl-v1-base" }),
    );
    await writeFile(
      `${filePath}.civitai.json`,
      JSON.stringify({ trainedWords: ["dark fantasy"], baseModel: "SDXL 1.0" }),
    );
    await stubLocalModel(filePath);
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404, text: async () => "" });

    const { read } = makeServer();
    const res = await read({ category: "checkpoints", name: "model.safetensors" });

    expect(res.isError).toBeFalsy();
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.model_explorer).toBe("unavailable");
    expect(parsed.source).toBe("local-fallback");
    expect(parsed.reason).toContain("comfyui-model-explorer");
    expect(parsed.install).toMatch(/ComfyUI-Manager|install_custom_node/);
    expect(parsed.file.path).toBe(filePath);
    expect(parsed.file.size_bytes).toBeGreaterThan(0);
    expect(parsed.embedded_metadata["modelspec.architecture"]).toBe("stable-diffusion-xl-v1-base");
    expect(parsed.civitai_sidecar.trainedWords).toEqual(["dark fantasy"]);
    // Must NOT be the old raw-status phrasing.
    expect(res.content[0].text).not.toContain("detail HTTP 404 (is ComfyUI running");
  });

  it("404 + non-safetensors file (.ckpt) → degrade result with sidecar but null embedded metadata", async () => {
    const filePath = join(dir, "old.ckpt");
    await writeFile(filePath, Buffer.from([0x80, 0x02, 0x7d])); // pickle magic-ish
    await writeFile(`${filePath}.civitai.json`, JSON.stringify({ baseModel: "SD 1.5" }));
    await stubLocalModel(filePath);
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404, text: async () => "" });

    const { read } = makeServer();
    const res = await read({ category: "checkpoints", name: "old.ckpt" });

    expect(res.isError).toBeFalsy();
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.model_explorer).toBe("unavailable");
    expect(parsed.embedded_metadata).toBeNull();
    expect(parsed.civitai_sidecar.baseModel).toBe("SD 1.5");
  });

  it("404 + model NOT resolvable locally (remote mode / missing file) → keeps the actionable error", async () => {
    resolveExistingModelFileMock.mockRejectedValue(
      new Error("No local ComfyUI path configured."),
    );
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404, text: async () => "" });

    const { read } = makeServer();
    const res = await read({ category: "checkpoints", name: "ghost.safetensors" });

    expect(res.isError).toBe(true);
    const text = res.content[0].text;
    expect(text).toContain("comfyui-model-explorer");
    expect(text).toContain("could not find the requested model file");
  });
});
