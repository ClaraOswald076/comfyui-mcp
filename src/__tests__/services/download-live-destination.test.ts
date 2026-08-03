import { describe, expect, it, beforeEach, vi } from "vitest";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// #369 — "download_model reports success, the model never appears".
//
// Two halves are covered here, both about the LIVE server rather than local config:
//
//  (1) PRE-write — when the models root came from local configuration the running
//      server never vouched for, a destination the server demonstrably does not
//      read from is REFUSED before the transfer starts.
//  (2) POST-write — a landed file is verified on disk AND against the connected
//      server's own `/models/<category>` listing, and the VERIFIED path is what
//      gets reported. Reporting the intended path is what made the original bug
//      look like a success.
// ---------------------------------------------------------------------------

const h = vi.hoisted(() => ({
  comfyuiPath: "/comfy" as string | undefined,
  remote: false,
  baseUrl: "http://127.0.0.1:8188",
  /** Per-category listing the LIVE server answers with; undefined → 404. */
  liveListings: {} as Record<string, string[] | undefined>,
  /** The candidate models root on disk: category folder → files it contains. */
  onDisk: {} as Record<string, string[]>,
  modelsDirSource: "configured-base" as string,
  fetchCalls: [] as string[],
  /** What getLiveExtraModelRoots reports — only an AUTHORITATIVE, EMPTY answer can
   *  rule out "the server's models live on another drive". */
  liveExtraRoots: { authoritative: false, roots: [] as unknown[] },
}));

vi.mock("../../config.js", () => ({
  config: {
    get comfyuiPath() {
      return h.comfyuiPath;
    },
    huggingfaceToken: undefined,
    civitaiApiToken: undefined,
    resolvedPort: 8188,
  },
  getComfyUIBaseUrl: () => h.baseUrl,
  isRemoteMode: () => h.remote,
}));

vi.mock("../../comfyui/client.js", () => ({
  getSystemStats: vi.fn(async () => ({ system: { argv: ["ComfyUI\\main.py"] } })),
  getClient: () => ({
    fetchApi: async (path: string) => {
      h.fetchCalls.push(path);
      const category = path.replace(/^\/models\//, "");
      const listing = h.liveListings[category];
      if (listing === undefined) return { ok: false, json: async () => null };
      return { ok: true, json: async () => listing };
    },
  }),
}));

vi.mock("../../services/node-management.js", () => ({
  installModelViaManager: vi.fn(),
}));

vi.mock("../../services/extra-paths.js", () => ({
  getExtraModelRoots: vi.fn(async () => []),
  getLiveExtraModelRoots: vi.fn(async () => h.liveExtraRoots),
}));

vi.mock("../../services/output-dir.js", () => ({
  resolveModelsDir: vi.fn(async () => resolve("/live/ComfyUI/models")),
  resolveModelsDirWithBases: vi.fn(async () => ({
    modelsDir: resolve("/comfy/models"),
    baseDirs: [],
    snapshot: { reachable: true, argv: ["ComfyUI\\main.py"] },
    source: h.modelsDirSource,
  })),
  parseModelsDirFromArgv: vi.fn(() => undefined),
  hasUnresolvableRelativeModelDirFlag: vi.fn(() => false),
  isLiveAuthoritativeModelsDir: (s: string) =>
    s === "argv-flag" || s === "live-root" || s === "observed-root",
}));

const statMock = vi.fn();
const realpathMock = vi.fn();
const readdirMock = vi.fn();
vi.mock("node:fs/promises", () => ({
  copyFile: vi.fn(),
  link: vi.fn(),
  lstat: vi.fn(async () => ({ isSymbolicLink: () => false })),
  mkdir: vi.fn(),
  readdir: (...a: unknown[]) => readdirMock(...a),
  readFile: vi.fn(),
  realpath: (...a: unknown[]) => realpathMock(...a),
  rename: vi.fn(),
  rm: vi.fn(),
  stat: (...a: unknown[]) => statMock(...a),
  utimes: vi.fn(),
  unlink: vi.fn(),
  writeFile: vi.fn(),
}));

import {
  resolveModelSubfolderPreferServer,
  verifyLandedModel,
} from "../../services/model-resolver.js";
import { ModelError } from "../../utils/errors.js";

beforeEach(() => {
  h.comfyuiPath = "/comfy";
  h.remote = false;
  h.liveListings = {};
  h.onDisk = {};
  h.modelsDirSource = "configured-base";
  h.fetchCalls = [];
  h.liveExtraRoots = { authoritative: false, roots: [] };
  statMock.mockReset();
  realpathMock.mockReset();
  readdirMock.mockReset();
  // Model the candidate models root: `withFileTypes` enumerates its category
  // folders, a plain recursive read lists that category's files.
  readdirMock.mockImplementation(
    async (dir: string, opts?: { withFileTypes?: boolean }) => {
      if (opts?.withFileTypes) {
        return Object.keys(h.onDisk).map((name) => ({ name, isDirectory: () => true }));
      }
      const category = String(dir).split(/[\\/]/).filter(Boolean).pop() ?? "";
      return h.onDisk[category] ?? [];
    },
  );
  realpathMock.mockImplementation(async (p: string) => p);
  statMock.mockResolvedValue({ isFile: () => true, size: 10 });
});

describe("pre-write: a destination the LIVE server does not read from is refused (#369)", () => {
  it("REFUSES a locally-configured root whose contents the live server does not list", async () => {
    // The exact reported shape: the stale install holds a handful of models and
    // the running server lists a completely different set for that category.
    h.onDisk = {
      diffusion_models: [
        "stale-a.safetensors",
        "stale-b.safetensors",
        "stale-c.safetensors",
      ],
    };
    h.liveListings["diffusion_models"] = Array.from(
      { length: 24 },
      (_, i) => `live-${i}.safetensors`,
    );

    await expect(resolveModelSubfolderPreferServer("diffusion_models")).rejects.toThrow(
      ModelError,
    );
    const err = await resolveModelSubfolderPreferServer("diffusion_models").catch(
      (e: Error) => e,
    );
    const msg = (err as Error).message;
    expect(msg).toMatch(/does not read from it/);
    expect(msg).toMatch(/DIFFERENT install/);
    expect(msg).toMatch(/127\.0\.0\.1:8188/);
  });

  it("REFUSES on a POPULATED SIBLING when the target category is empty (codex gate)", async () => {
    // The stale install has never held a diffusion model, so the target folder is
    // empty and says nothing — but its checkpoints/ betrays the wrong install.
    h.onDisk = {
      diffusion_models: [],
      checkpoints: ["stale-ckpt.safetensors"],
    };
    h.liveListings["diffusion_models"] = ["live-unet.safetensors"];
    h.liveListings["checkpoints"] = ["live-ckpt.safetensors"];

    await expect(resolveModelSubfolderPreferServer("diffusion_models")).rejects.toThrow(
      /DIFFERENT install/,
    );
  });

  it("ALLOWS when the live listing and the directory share a file (same tree)", async () => {
    h.onDisk = { loras: ["shared.safetensors", "other.safetensors"] };
    h.liveListings["loras"] = ["shared.safetensors", "more.safetensors"];
    await expect(resolveModelSubfolderPreferServer("loras")).resolves.toBe(
      resolve("/comfy/models/loras"),
    );
  });

  it("ALLOWS when a SIBLING category agrees even though the target has no overlap yet", async () => {
    // One shared file anywhere in the root proves this IS the live tree.
    h.onDisk = { loras: [], checkpoints: ["shared.safetensors"] };
    h.liveListings["checkpoints"] = ["shared.safetensors"];
    await expect(resolveModelSubfolderPreferServer("loras")).resolves.toBe(
      resolve("/comfy/models/loras"),
    );
  });

  it("ALLOWS an empty tree when a live EXTRA ROOT could be holding the server's models", async () => {
    h.onDisk = { loras: [] };
    h.liveListings["loras"] = ["live-only.safetensors"];
    h.liveExtraRoots = { authoritative: true, roots: [{ category: "loras", dir: "/E/models/loras" }] };
    await expect(resolveModelSubfolderPreferServer("loras")).resolves.toBe(
      resolve("/comfy/models/loras"),
    );
  });

  it("ALLOWS an empty tree when extra-root authorization is INCONCLUSIVE (fails open)", async () => {
    h.onDisk = { loras: [] };
    h.liveListings["loras"] = ["live-only.safetensors"];
    h.liveExtraRoots = { authoritative: false, roots: [] }; // cannot rule extra roots out
    await expect(resolveModelSubfolderPreferServer("loras")).resolves.toBe(
      resolve("/comfy/models/loras"),
    );
  });

  it("ALLOWS an empty tree when the live server also has nothing (a fresh install's first model)", async () => {
    h.onDisk = { loras: [] };
    h.liveListings["loras"] = [];
    h.liveExtraRoots = { authoritative: true, roots: [] };
    await expect(resolveModelSubfolderPreferServer("loras")).resolves.toBe(
      resolve("/comfy/models/loras"),
    );
  });

  it("REFUSES an EMPTY tree when the live server loads models and registers no extra roots (codex gate r2)", async () => {
    // Two portable bundles of the same shape; the stale one is still empty, so the
    // per-category overlap test finds nothing to compare. But the server it is NOT
    // serving demonstrably reads models from somewhere this tree does not contain.
    h.onDisk = { loras: [], checkpoints: [] };
    h.liveListings["loras"] = ["a.safetensors", "b.safetensors"];
    h.liveListings["checkpoints"] = ["c.safetensors"];
    h.liveExtraRoots = { authoritative: true, roots: [] };
    await expect(resolveModelSubfolderPreferServer("loras")).rejects.toThrow(
      /DIFFERENT install/,
    );
  });

  it("ALLOWS when the server cannot answer for any category (inconclusive, fails open)", async () => {
    h.onDisk = { loras: ["a.safetensors"] };
    h.liveListings = {}; // every /models/<cat> 404s
    await expect(resolveModelSubfolderPreferServer("loras")).resolves.toBe(
      resolve("/comfy/models/loras"),
    );
  });

  it("does NOT second-guess a LIVE-AUTHORITATIVE root — no listing call at all", async () => {
    h.modelsDirSource = "observed-root";
    h.onDisk = { loras: ["stale.safetensors"] };
    h.liveListings["loras"] = ["completely-different.safetensors"];
    await expect(resolveModelSubfolderPreferServer("loras")).resolves.toBe(
      resolve("/comfy/models/loras"),
    );
    expect(h.fetchCalls).toEqual([]);
  });

  it("ignores non-core extensions on disk (a .gguf-only dir is not evidence of disagreement)", async () => {
    h.onDisk = { diffusion_models: ["weights.gguf"] };
    h.liveListings["diffusion_models"] = ["a.safetensors"];
    await expect(
      resolveModelSubfolderPreferServer("diffusion_models"),
    ).resolves.toBeTruthy();
  });
});

describe("post-write: the reported path is VERIFIED, not intended (#369)", () => {
  const target = resolve("/live/ComfyUI/models/loras/new.safetensors");

  it("reports the on-disk path and 'visible' when the live server lists the file", async () => {
    h.liveListings["loras"] = ["new.safetensors", "old.safetensors"];
    const res = await verifyLandedModel(target, "loras", { attempts: 1, retryMs: 0 });
    expect(res.verifiedPath).toBe(target);
    expect(res.liveVisible).toBe("visible");
    expect(res.note).toBeUndefined();
  });

  it("resolves a symlinked destination to the REAL path it reports", async () => {
    const real = resolve("/mnt/models/loras/new.safetensors");
    realpathMock.mockImplementation(async () => real);
    h.liveListings["loras"] = ["new.safetensors"];
    const res = await verifyLandedModel(target, "loras", { attempts: 1, retryMs: 0 });
    expect(res.verifiedPath).toBe(real);
  });

  it("reports NOT-VISIBLE (naming the server's real models dir) when the file is invisible", async () => {
    h.liveListings["loras"] = ["something-else.safetensors"];
    const res = await verifyLandedModel(target, "loras", { attempts: 2, retryMs: 0 });
    expect(res.liveVisible).toBe("not-visible");
    expect(res.verifiedPath).toBe(target);
    expect(res.note).toMatch(/does NOT list "new\.safetensors"/);
    expect(res.note).toMatch(/will not be usable/);
    expect(res.note).toContain(resolve("/live/ComfyUI/models"));
  });

  it("reports UNKNOWN — never a success — when the file is not on disk at all", async () => {
    statMock.mockRejectedValue(new Error("ENOENT"));
    const res = await verifyLandedModel(target, "loras", { attempts: 1, retryMs: 0 });
    expect(res.liveVisible).toBe("unknown");
    expect(res.verifiedPath).toBeUndefined();
    expect(res.note).toMatch(/could not be confirmed on disk/);
  });

  it("reports UNKNOWN when the server cannot answer for the category", async () => {
    h.liveListings = {};
    const res = await verifyLandedModel(target, "loras", { attempts: 2, retryMs: 0 });
    expect(res.liveVisible).toBe("unknown");
    expect(res.verifiedPath).toBe(target);
    expect(res.note).toMatch(/did not answer/);
  });

  it("reports UNKNOWN in remote mode (local placement says nothing about the remote host)", async () => {
    h.remote = true;
    const res = await verifyLandedModel(target, "loras", { attempts: 1, retryMs: 0 });
    expect(res.liveVisible).toBe("unknown");
    expect(res.note).toMatch(/remote/i);
  });

  it("matches a nested entry by its CATEGORY-RELATIVE path (ComfyUI lists 'sub/file')", async () => {
    h.liveListings["loras"] = ["sub/new.safetensors"];
    const res = await verifyLandedModel(target, "loras/sub", { attempts: 1, retryMs: 0 });
    expect(res.liveVisible).toBe("visible");
  });

  it("does NOT call a same-named file in a DIFFERENT subfolder visible (codex gate r2)", async () => {
    // The live server holds loras/b/new.safetensors; we wrote loras/a/new.safetensors
    // into a tree it does not read. A basename comparison would fabricate success.
    h.liveListings["loras"] = ["b/new.safetensors"];
    const res = await verifyLandedModel(target, "loras/a", { attempts: 1, retryMs: 0 });
    expect(res.liveVisible).toBe("not-visible");
    expect(res.note).toMatch(/a\/new\.safetensors/);
  });

  it("normalizes OS-native separators in the live listing", async () => {
    h.liveListings["loras"] = ["sub\\new.safetensors"];
    const res = await verifyLandedModel(target, "loras/sub", { attempts: 1, retryMs: 0 });
    expect(res.liveVisible).toBe("visible");
  });
});
