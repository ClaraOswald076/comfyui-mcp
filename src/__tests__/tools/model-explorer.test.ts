import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { z } from "zod";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEAD_NAMES, TOOL_NAMES } from "../../tools/vocabulary.js";

/**
 * The consolidated `model_metadata` tool (0.49.0 slice 5): the three
 * model_metadata_* tools folded into one action-parameterized tool. Proves the
 * consolidation did not change behaviour — every action runs the identical
 * logic the old tool ran (same /model_explorer/* fetches, same 404
 * degradations, same content blocks) — and that the flat-enum shape actually
 * EXPOSES its parameters (the discriminated-union trap renders zero params).
 */

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

interface Registered {
  name: string;
  shape: z.ZodRawShape;
  handler: ToolHandler;
}

function registered(): Registered[] {
  const tools: Registered[] = [];
  const server = {
    tool: (name: string, _desc: string, shape: z.ZodRawShape, handler: ToolHandler) => {
      tools.push({ name, shape, handler });
    },
  };
  registerModelExplorerTools(server as never);
  return tools;
}

/** The whole model-metadata surface is now ONE tool (0.49.0 slice 5). */
function handler(): ToolHandler {
  const tools = registered();
  expect(tools).toHaveLength(1);
  expect(tools[0].name).toBe("model_metadata");
  return tools[0].handler;
}

const text = (res: Awaited<ReturnType<ToolHandler>>) => res.content.map((c) => c.text).join(" ");

describe("model_metadata registration", () => {
  it("registers exactly one tool named `model_metadata` (3→1)", () => {
    const tools = registered();
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("model_metadata");
  });

  // The whole reason for the flat-enum shape rule: a z.discriminatedUnion renders
  // as ZERO parameters, hiding every input from the model.
  it("exposes a visible flat `action` enum with every per-action parameter", () => {
    const [{ shape }] = registered();
    // io: "input" — the conversion options the MCP SDK itself uses
    // (sdk/server/zod-json-schema-compat.js, asserted by docs-schema-parity.test.ts),
    // so this is the schema a client is actually given.
    const json = z.toJSONSchema(z.object(shape), { reused: "inline", io: "input" }) as {
      properties?: Record<string, { enum?: string[] }>;
      required?: string[];
    };
    expect(Object.keys(json.properties ?? {}).sort()).toEqual([
      "action",
      "category",
      "fields",
      "name",
      "note",
      "version_id",
    ]);
    expect(json.properties?.action.enum?.sort()).toEqual(["fetch_civitai", "propose", "read"]);
    // Only `action` can be required — the rest are per-action, enforced in the handler.
    expect(json.required).toEqual(["action"]);
  });

  it("an unknown action returns a clear error result", async () => {
    const res = await handler()({ action: "bogus" });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/unknown model_metadata action/i);
    expect(text(res)).toMatch(/fetch_civitai/);
  });
});

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

describe('action:"read" / action:"fetch_civitai" 404 handling', () => {
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

  it('action:"read": 404 → actionable message, not a raw HTTP 404', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404, text: async () => "" });
    const res = await handler()({ action: "read", category: "checkpoints", name: "model.safetensors" });

    expect(res.isError).toBe(true);
    expect(text(res)).toContain("comfyui-model-explorer");
    expect(text(res)).toContain("could not find the requested model file");
    // Must NOT be the old raw-status phrasing.
    expect(text(res)).not.toContain("detail HTTP 404 (is ComfyUI running");
  });

  it('action:"fetch_civitai": 404 (no version_id) → optional-feature-unavailable message, points at version_id path', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404, text: async () => "" });
    const res = await handler()({ action: "fetch_civitai", category: "loras", name: "x.safetensors" });

    expect(res.isError).toBe(true);
    expect(text(res)).toContain("comfyui-model-explorer");
    expect(text(res)).toContain("OPTIONAL");
    // Tells the caller how to recover without the node.
    expect(text(res)).toContain("version_id");
    expect(text(res)).not.toContain("civitai HTTP 404");
  });

  it('action:"fetch_civitai": 404 WITH version_id → degrades to CivitAI public API (no error)', async () => {
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
    const res = await handler()({
      action: "fetch_civitai",
      category: "loras",
      name: "x.safetensors",
      version_id: 1567118,
    });

    expect(res.isError).toBeFalsy();
    expect(text(res)).toContain("civitai-public-api");
    expect(text(res)).toContain("dark fantasy");
    expect(text(res)).toContain("a dark fantasy castle"); // mined example prompt
    expect(text(res)).toContain("1567118");
    // The public API URL was used for the fallback.
    const calledUrls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(calledUrls.some((u) => u.includes("civitai.com/api/v1/model-versions/1567118"))).toBe(true);
  });

  it('action:"fetch_civitai": 404 WITH version_id but public API also fails → clear error noting the version lookup failed', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 404, text: async () => "" })
      .mockResolvedValueOnce({ ok: false, status: 404, text: async () => "" });
    const res = await handler()({
      action: "fetch_civitai",
      category: "loras",
      name: "x.safetensors",
      version_id: 999999999,
    });

    expect(res.isError).toBe(true);
    expect(text(res)).toContain("comfyui-model-explorer");
    expect(text(res)).toContain("version_id was supplied");
  });

  it('action:"read": still succeeds when the node is present', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ classify: { asset_type: "checkpoint" }, namespaces: {} }),
      })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ candidates: [] }) });
    const res = await handler()({ action: "read", category: "checkpoints", name: "model.safetensors" });

    expect(res.isError).toBeFalsy();
    expect(text(res)).toContain("checkpoint");
  });
});

describe('action:"propose"', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs the identical proposal body and returns the pushed envelope", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true, seq: 7 }) });
    const res = await handler()({
      action: "propose",
      category: "loras",
      name: "x.safetensors",
      fields: { display_name: "Dark Fantasy XL" },
      note: "v2",
    });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { method: string; body: string }];
    expect(String(url)).toContain("/model_explorer/proposal");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      category: "loras",
      name: "x.safetensors",
      fields: { display_name: "Dark Fantasy XL" },
      note: "v2",
    });
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(text(res))).toEqual({
      pushed: true,
      seq: 7,
      note: expect.stringContaining("review window"),
    });
  });

  it("an upstream failure is an error result, as before", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({ ok: false, error: "boom" }) });
    const res = await handler()({
      action: "propose",
      category: "loras",
      name: "x.safetensors",
      fields: { display_name: "X" },
    });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("boom");
  });
});

describe("per-action presence guards (the flat shape cannot schema-require these)", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("category-less and name-less read/propose/fetch_civitai name the missing field and fetch nothing", async () => {
    for (const action of ["read", "propose", "fetch_civitai"]) {
      const noCategory = await handler()({ action });
      expect(noCategory.isError).toBe(true);
      expect(text(noCategory)).toContain(`action:"${action}" requires \`category\``);

      const noName = await handler()({ action, category: "loras" });
      expect(noName.isError).toBe(true);
      expect(text(noName)).toContain(`action:"${action}" requires \`name\``);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('action:"propose" without fields names it and fetches nothing', async () => {
    const res = await handler()({ action: "propose", category: "loras", name: "x.safetensors" });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('action:"propose" requires `fields`');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // The guard tests ABSENCE, not falsiness: an empty category/name passed
  // z.string() before this consolidation and reached the upstream route, which
  // answers with its own error. A `!category` guard would swallow that path.
  it("explicitly empty category/name still reach the upstream route, as before", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404, text: async () => "" });
    await handler()({ action: "read", category: "", name: "" });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0][0])).toContain("/model_explorer/detail?category=&name=");
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

// Remote mode must skip the local fallback entirely (the host's file tree is
// NOT the remote server's); this flag flips isRemoteMode() per-test while
// every other config export stays real. vi.mock/vi.hoisted are hoisted, so
// this still applies before the module under test is imported.
const remoteMode = vi.hoisted(() => ({ value: false }));
vi.mock("../../config.js", async () => {
  const actual = await vi.importActual<typeof import("../../config.js")>("../../config.js");
  return { ...actual, isRemoteMode: () => remoteMode.value };
});

describe('action:"read" local fallback (#363 reopen)', () => {
  const fetchMock = vi.fn();
  let dir: string;

  beforeEach(async () => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    resolveExistingModelFileMock.mockReset();
    remoteMode.value = false;
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

    const res = await handler()({ action: "read", category: "checkpoints", name: "model.safetensors" });

    expect(res.isError).toBeFalsy();
    const parsed = JSON.parse(text(res));
    expect(parsed.model_explorer).toBe("unavailable");
    expect(parsed.source).toBe("local-fallback");
    expect(parsed.reason).toContain("comfyui-model-explorer");
    expect(parsed.install).toMatch(/ComfyUI-Manager|install_custom_node/);
    expect(parsed.file.path).toBe(filePath);
    expect(parsed.file.size_bytes).toBeGreaterThan(0);
    expect(parsed.embedded_metadata["modelspec.architecture"]).toBe("stable-diffusion-xl-v1-base");
    expect(parsed.civitai_sidecar.trainedWords).toEqual(["dark fantasy"]);
    // Must NOT be the old raw-status phrasing.
    expect(text(res)).not.toContain("detail HTTP 404 (is ComfyUI running");
  });

  it("404 + non-safetensors file (.ckpt) → degrade result with sidecar but null embedded metadata", async () => {
    const filePath = join(dir, "old.ckpt");
    await writeFile(filePath, Buffer.from([0x80, 0x02, 0x7d])); // pickle magic-ish
    await writeFile(`${filePath}.civitai.json`, JSON.stringify({ baseModel: "SD 1.5" }));
    await stubLocalModel(filePath);
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404, text: async () => "" });

    const res = await handler()({ action: "read", category: "checkpoints", name: "old.ckpt" });

    expect(res.isError).toBeFalsy();
    const parsed = JSON.parse(text(res));
    expect(parsed.model_explorer).toBe("unavailable");
    expect(parsed.embedded_metadata).toBeNull();
    expect(parsed.civitai_sidecar.baseModel).toBe("SD 1.5");
  });

  it("404 + model NOT resolvable locally (remote mode / missing file) → keeps the actionable error", async () => {
    resolveExistingModelFileMock.mockRejectedValue(
      new Error("No local ComfyUI path configured."),
    );
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404, text: async () => "" });

    const res = await handler()({ action: "read", category: "checkpoints", name: "ghost.safetensors" });

    expect(res.isError).toBe(true);
    expect(text(res)).toContain("comfyui-model-explorer");
    expect(text(res)).toContain("could not find the requested model file");
  });

  it("404 + REMOTE mode → local fallback skipped even when a host file resolves; keeps the actionable error", async () => {
    remoteMode.value = true;
    const filePath = join(dir, "model.safetensors");
    await writeFile(
      filePath,
      makeSafetensorsBytes({ "modelspec.architecture": "stable-diffusion-xl-v1-base" }),
    );
    // The host's COMFYUI_PATH WOULD resolve this file — in remote mode that is
    // the wrong machine's tree, so the resolver must not even be consulted.
    await stubLocalModel(filePath);
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404, text: async () => "" });

    const res = await handler()({ action: "read", category: "checkpoints", name: "model.safetensors" });

    expect(res.isError).toBe(true);
    expect(text(res)).toContain("comfyui-model-explorer");
    expect(text(res)).toContain("could not find the requested model file");
    expect(text(res)).not.toContain("local-fallback");
    expect(resolveExistingModelFileMock).not.toHaveBeenCalled();
  });

  it("404 + resolver hits a DIRECTORY → no success-shaped result; keeps the actionable error", async () => {
    const subdir = await mkdtemp(join(dir, "not-a-file-")); // a real directory, not a model file
    resolveExistingModelFileMock.mockResolvedValue({ path: subdir, root: dir, info: await stat(subdir) });
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404, text: async () => "" });

    const res = await handler()({ action: "read", category: "checkpoints", name: "model.safetensors" });

    expect(res.isError).toBe(true);
    expect(text(res)).toContain("comfyui-model-explorer");
    expect(text(res)).not.toContain("local-fallback");
  });
});

describe("the three model_metadata_* names are retired", () => {
  const old = ["model_metadata_read", "model_metadata_propose", "model_metadata_fetch_civitai"];

  it("each old name is in DEAD_NAMES with replacement `model_metadata`", () => {
    for (const name of old) {
      const entry = DEAD_NAMES.find((d) => d.name === name);
      expect(entry, `${name} must be declared dead`).toBeDefined();
      expect(entry!.since).toBe("0.49.0");
      expect(entry!.replacement).toContain("model_metadata");
    }
  });

  it("no old name is still in the live ledger, and `model_metadata` is", () => {
    for (const name of old) expect(TOOL_NAMES as readonly string[]).not.toContain(name);
    expect(TOOL_NAMES as readonly string[]).toContain("model_metadata");
  });
});
