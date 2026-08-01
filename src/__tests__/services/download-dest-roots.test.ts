import { describe, expect, it, beforeEach, vi } from "vitest";
import { join, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Regression suite for the download DESTINATION resolver — the COMFYUI_PATH-vs-
// live-server-path family, applied specifically to where download_model lands a
// file (resolveDownloadTarget / resolveModelSubfolderPreferServer):
//
//   (a) #346 — a server launched with --base-directory that DIFFERS from
//       COMFYUI_PATH must root the download at the SERVER's models dir (where the
//       running ComfyUI actually reads models), NOT at COMFYUI_PATH/models.
//   (b) #633 — a target_subfolder that is a SYMLINK resolving into a directory
//       registered as an active extra_model_path must be ALLOWED (that's exactly
//       where ComfyUI reads), even though its real path is on another drive/mount.
//   (c) path-safety floor — a symlink whose real path escapes EVERY registered
//       root (primary models + extra_model_paths) is STILL refused, so the #633
//       allowance never becomes an arbitrary-write hole.
//
// These run the REAL resolveModelsDir (output-dir) and the REAL symlink guard so
// the fix is exercised end to end; only the live server (/system_stats), the
// filesystem, config, and the registered extra roots are controlled.
// ---------------------------------------------------------------------------

const h = vi.hoisted(() => ({
  config: { comfyuiPath: "/comfy" as string | undefined },
  isRemoteMode: false,
}));
vi.mock("../../config.js", () => ({
  config: h.config,
  isRemoteMode: () => h.isRemoteMode,
}));

// resolveModelsDir consults existsSync only for an argv-derived live root; not
// exercised by these tests (base-directory / fallback paths). Default false.
vi.mock("node:fs", () => ({ existsSync: () => false }));

const getSystemStats = vi.fn();
vi.mock("../../comfyui/client.js", () => ({
  getSystemStats: (...a: unknown[]) => getSystemStats(...a),
  // getClient is referenced by list functions; unused here but must exist.
  getClient: () => ({ fetchApi: vi.fn() }),
}));

// Registered extra_model_paths roots are injected per test.
const getExtraModelRootsMock = vi.fn();
vi.mock("../../services/extra-paths.js", () => ({
  getExtraModelRoots: (...a: unknown[]) => getExtraModelRootsMock(...a),
}));

// Filesystem: control lstat (is a segment a symlink?) and realpath (where does it
// point?) per test. mkdir/stat are inert; the tests stop at resolution, before any
// real write.
const lstatMock = vi.fn();
const realpathMock = vi.fn();
vi.mock("node:fs/promises", () => ({
  copyFile: vi.fn(),
  link: vi.fn(),
  lstat: (...a: unknown[]) => lstatMock(...a),
  mkdir: vi.fn(),
  readdir: vi.fn(),
  readFile: vi.fn(),
  realpath: (...a: unknown[]) => realpathMock(...a),
  rename: vi.fn(),
  rm: vi.fn(),
  stat: vi.fn(),
  utimes: vi.fn(),
  unlink: vi.fn(),
  writeFile: vi.fn(),
}));

// Real argv parsing (liveRootFromArgv) + a config-backed effective-base helper, so
// resolveModelsDir's live-first / fallback logic runs for real.
vi.mock("../../services/workspace-env.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../services/workspace-env.js")
  >("../../services/workspace-env.js");
  return {
    resolveEffectiveComfyUIBase: () =>
      h.config.comfyuiPath ?? (h.isRemoteMode ? undefined : h.config.comfyuiPath),
    liveRootFromArgv: actual.liveRootFromArgv,
  };
});

import {
  resolveDownloadTarget,
  resolveModelSubfolderPreferServer,
} from "../../services/model-resolver.js";
import { ModelError } from "../../utils/errors.js";

const COMFYUI_PATH = "/comfy";

beforeEach(() => {
  h.config.comfyuiPath = COMFYUI_PATH;
  h.isRemoteMode = false;
  getSystemStats.mockReset();
  getExtraModelRootsMock.mockReset().mockResolvedValue([]);
  // Default: nothing is a symlink; realpath is identity.
  lstatMock.mockReset().mockResolvedValue({ isSymbolicLink: () => false });
  realpathMock.mockReset().mockImplementation((p: string) => Promise.resolve(p));
});

describe("(a) #346 — download honors the running server's --base-directory", () => {
  it("resolves the destination under the SERVER's models dir, not COMFYUI_PATH/models", async () => {
    // COMFYUI_PATH is a stale Desktop checkout; the LIVE server runs with
    // --base-directory C:\COMFY, so its real models dir is C:\COMFY\models.
    const serverBase = resolve("/C/COMFY");
    getSystemStats.mockResolvedValue({
      system: { argv: ["python", "main.py", "--base-directory", serverBase] },
    });

    const target = await resolveDownloadTarget(
      "https://example.com/model.safetensors",
      "unet",
      "model.safetensors",
    );

    // Lands where the connected ComfyUI actually reads models…
    expect(target.targetDir).toBe(join(serverBase, "models", "unet"));
    expect(target.targetPath).toBe(join(serverBase, "models", "unet", "model.safetensors"));
    // …NOT under the stale COMFYUI_PATH install (the #346 bug).
    expect(target.targetDir).not.toBe(resolve(COMFYUI_PATH, "models", "unet"));
  });

  it("honors --models-directory override too", async () => {
    const serverBase = resolve("/C/COMFY");
    const modelsDir = resolve("/D/shared-models");
    getSystemStats.mockResolvedValue({
      system: {
        argv: [
          "python",
          "main.py",
          "--base-directory",
          serverBase,
          "--models-directory",
          modelsDir,
        ],
      },
    });

    const target = await resolveDownloadTarget(
      "https://example.com/model.safetensors",
      "checkpoints",
    );
    expect(target.targetDir).toBe(join(modelsDir, "checkpoints"));
  });

  it("falls back to COMFYUI_PATH/models when the server is unreachable", async () => {
    getSystemStats.mockRejectedValue(new Error("ECONNREFUSED"));
    const target = await resolveDownloadTarget(
      "https://example.com/model.safetensors",
      "loras",
      "m.safetensors",
    );
    expect(target.targetDir).toBe(resolve(COMFYUI_PATH, "models", "loras"));
  });
});

describe("(b) #633 — a symlinked target into a registered extra_model_path is allowed", () => {
  it("permits models/<link> -> /external/... when that target IS a registered extra root", async () => {
    // No --base-directory: models root is COMFYUI_PATH/models.
    getSystemStats.mockRejectedValue(new Error("no server"));
    const modelsRoot = resolve(COMFYUI_PATH, "models");
    const linkDir = resolve(modelsRoot, "external_unet_download");
    // The symlink's real location — an external drive/mount ComfyUI reads models from.
    const externalRoot = resolve("/Volumes/Render/00_AI/models/unet");

    // That external dir is an ACTIVE extra_model_path (category unet).
    getExtraModelRootsMock.mockResolvedValue([
      { category: "unet", dir: externalRoot, group: "comfyui" },
    ]);
    lstatMock.mockImplementation((p: string) =>
      Promise.resolve({ isSymbolicLink: () => resolve(p) === linkDir }),
    );
    realpathMock.mockImplementation((p: string) =>
      Promise.resolve(resolve(p) === linkDir ? externalRoot : resolve(p)),
    );

    // Allowed — resolves without throwing to the lexical target under models/.
    const dir = await resolveModelSubfolderPreferServer("external_unet_download");
    expect(dir).toBe(linkDir);
  });

  it("permits a NESTED path under the symlinked-into-registered-root dir", async () => {
    getSystemStats.mockRejectedValue(new Error("no server"));
    const modelsRoot = resolve(COMFYUI_PATH, "models");
    const linkDir = resolve(modelsRoot, "external_unet_download");
    const externalRoot = resolve("/Volumes/Render/00_AI/models/unet");

    getExtraModelRootsMock.mockResolvedValue([
      { category: "unet", dir: externalRoot, group: "comfyui" },
    ]);
    lstatMock.mockImplementation((p: string) =>
      Promise.resolve({ isSymbolicLink: () => resolve(p) === linkDir }),
    );
    realpathMock.mockImplementation((p: string) =>
      Promise.resolve(resolve(p) === linkDir ? externalRoot : resolve(p)),
    );

    const dir = await resolveModelSubfolderPreferServer("external_unet_download/sub");
    expect(dir).toBe(resolve(linkDir, "sub"));
  });
});

describe("(c) path-safety floor — a symlink escaping every registered root is refused", () => {
  it("rejects models/<link> -> /tmp/evil when it lands in NO registered root", async () => {
    getSystemStats.mockRejectedValue(new Error("no server"));
    const modelsRoot = resolve(COMFYUI_PATH, "models");
    const linkDir = resolve(modelsRoot, "external_unet_download");
    const evilOutside = resolve("/tmp/evil-outside");
    const registeredRoot = resolve("/Volumes/Render/00_AI/models/unet");

    // A registered root EXISTS, but the symlink does not resolve into it.
    getExtraModelRootsMock.mockResolvedValue([
      { category: "unet", dir: registeredRoot, group: "comfyui" },
    ]);
    lstatMock.mockImplementation((p: string) =>
      Promise.resolve({ isSymbolicLink: () => resolve(p) === linkDir }),
    );
    realpathMock.mockImplementation((p: string) =>
      Promise.resolve(resolve(p) === linkDir ? evilOutside : resolve(p)),
    );

    await expect(
      resolveModelSubfolderPreferServer("external_unet_download"),
    ).rejects.toBeInstanceOf(ModelError);
    await expect(
      resolveModelSubfolderPreferServer("external_unet_download"),
    ).rejects.toThrow(/outside the models directory/i);
  });

  it("REFUSES a symlink into a registered custom_nodes root (no arbitrary CODE write) — codex P0", async () => {
    // custom_nodes is a registered extra path (ComfyUI imports Python from it), so a
    // path-only allowance would let a model download land executable code there. The
    // guard must honor MODEL roots only, so this escape is still refused even though
    // the real path IS under a registered (non-model) root.
    getSystemStats.mockRejectedValue(new Error("no server"));
    const modelsRoot = resolve(COMFYUI_PATH, "models");
    const linkDir = resolve(modelsRoot, "sneaky");
    const customNodesRoot = resolve("/opt/ComfyUI/custom_nodes");

    getExtraModelRootsMock.mockResolvedValue([
      { category: "custom_nodes", dir: customNodesRoot, group: "comfyui" },
    ]);
    lstatMock.mockImplementation((p: string) =>
      Promise.resolve({ isSymbolicLink: () => resolve(p) === linkDir }),
    );
    realpathMock.mockImplementation((p: string) =>
      Promise.resolve(resolve(p) === linkDir ? customNodesRoot : resolve(p)),
    );

    await expect(
      resolveModelSubfolderPreferServer("sneaky"),
    ).rejects.toBeInstanceOf(ModelError);
    await expect(
      resolveModelSubfolderPreferServer("sneaky"),
    ).rejects.toThrow(/outside the models directory/i);
  });

  it("REFUSES a RELABELED model category that physically aliases the base custom_nodes (path-based veto) — codex round 2", async () => {
    // The attack the label-only denylist missed: register a MODEL category (unet)
    // pointing at the install's real custom_nodes dir. It passes a category-label
    // filter but the resolved REAL PATH is a code root, so it must still be refused.
    getSystemStats.mockRejectedValue(new Error("no server"));
    const modelsRoot = resolve(COMFYUI_PATH, "models");
    const linkDir = resolve(modelsRoot, "totally_a_model");
    // Base install custom_nodes = sibling of the models root.
    const baseCustomNodes = resolve(COMFYUI_PATH, "custom_nodes");

    getExtraModelRootsMock.mockResolvedValue([
      { category: "unet", dir: baseCustomNodes, group: "comfyui" },
    ]);
    lstatMock.mockImplementation((p: string) =>
      Promise.resolve({ isSymbolicLink: () => resolve(p) === linkDir }),
    );
    realpathMock.mockImplementation((p: string) =>
      Promise.resolve(resolve(p) === linkDir ? baseCustomNodes : resolve(p)),
    );

    await expect(
      resolveModelSubfolderPreferServer("totally_a_model"),
    ).rejects.toBeInstanceOf(ModelError);
  });

  it("REFUSES a relabeled alias to a NON-standard registered custom_nodes dir — codex round 2", async () => {
    // custom_nodes registered at a non-default path, then a MODEL category aliasing the
    // same physical dir. The code-root set is built from the custom_nodes-category
    // entry (by real path), so the aliased model label cannot launder the write.
    getSystemStats.mockRejectedValue(new Error("no server"));
    const modelsRoot = resolve(COMFYUI_PATH, "models");
    const linkDir = resolve(modelsRoot, "looks_fine");
    const nodesDir = resolve("/data/comfy-nodes");

    getExtraModelRootsMock.mockResolvedValue([
      { category: "custom_nodes", dir: nodesDir, group: "comfyui" },
      { category: "unet", dir: nodesDir, group: "comfyui" },
    ]);
    lstatMock.mockImplementation((p: string) =>
      Promise.resolve({ isSymbolicLink: () => resolve(p) === linkDir }),
    );
    realpathMock.mockImplementation((p: string) =>
      Promise.resolve(resolve(p) === linkDir ? nodesDir : resolve(p)),
    );

    await expect(
      resolveModelSubfolderPreferServer("looks_fine"),
    ).rejects.toBeInstanceOf(ModelError);
  });

  it("REFUSES a relabeled alias to the base custom_nodes when --models-directory is NOT a sibling of it — codex round 3 Q2", async () => {
    // The layout the sibling-derivation missed: models live on a different drive
    // (--models-directory) than the base install, so the code dir is NOT
    // dirname(modelsRoot)/custom_nodes. The veto must derive custom_nodes from the
    // real --base-directory, so a `unet: <base>/custom_nodes` relabel is still refused.
    const serverBase = resolve("/C/Comfy");
    const modelsDir = resolve("/D/models");
    getSystemStats.mockResolvedValue({
      system: {
        argv: [
          "python",
          "main.py",
          "--base-directory",
          serverBase,
          "--models-directory",
          modelsDir,
        ],
      },
    });
    const linkDir = resolve(modelsDir, "sneaky");
    const baseCustomNodes = resolve(serverBase, "custom_nodes"); // the REAL code dir

    getExtraModelRootsMock.mockResolvedValue([
      { category: "unet", dir: baseCustomNodes, group: "comfyui" },
    ]);
    lstatMock.mockImplementation((p: string) =>
      Promise.resolve({ isSymbolicLink: () => resolve(p) === linkDir }),
    );
    realpathMock.mockImplementation((p: string) =>
      Promise.resolve(resolve(p) === linkDir ? baseCustomNodes : resolve(p)),
    );

    await expect(
      resolveModelSubfolderPreferServer("sneaky"),
    ).rejects.toBeInstanceOf(ModelError);
  });

  it("REFUSES a link resolving into a custom_nodes subdir NESTED under a registered model root — codex round 3", async () => {
    // A model root /data/models is registered (loras), and custom_nodes sits UNDER it.
    // A link into <model-root>/custom_nodes/... is underAny(modelRoots) yet must be
    // vetoed because it is also underAny(codeRoots).
    getSystemStats.mockRejectedValue(new Error("no server"));
    const modelsRoot = resolve(COMFYUI_PATH, "models");
    const linkDir = resolve(modelsRoot, "peek");
    const modelRoot = resolve("/data/models");
    const nestedCustomNodes = resolve(modelRoot, "custom_nodes");
    const evilTarget = resolve(nestedCustomNodes, "evilpack");

    getExtraModelRootsMock.mockResolvedValue([
      { category: "loras", dir: modelRoot, group: "comfyui" },
      { category: "custom_nodes", dir: nestedCustomNodes, group: "comfyui" },
    ]);
    lstatMock.mockImplementation((p: string) =>
      Promise.resolve({ isSymbolicLink: () => resolve(p) === linkDir }),
    );
    realpathMock.mockImplementation((p: string) =>
      Promise.resolve(resolve(p) === linkDir ? evilTarget : resolve(p)),
    );

    await expect(
      resolveModelSubfolderPreferServer("peek"),
    ).rejects.toBeInstanceOf(ModelError);
  });

  it("ALLOWS a link into a model-root subdir that is NOT under custom_nodes (inverse nesting)", async () => {
    getSystemStats.mockRejectedValue(new Error("no server"));
    const modelsRoot = resolve(COMFYUI_PATH, "models");
    const linkDir = resolve(modelsRoot, "ok");
    const modelRoot = resolve("/data/models");
    const nestedCustomNodes = resolve(modelRoot, "custom_nodes");
    const goodTarget = resolve(modelRoot, "loras/sub"); // under model root, NOT under code

    getExtraModelRootsMock.mockResolvedValue([
      { category: "loras", dir: modelRoot, group: "comfyui" },
      { category: "custom_nodes", dir: nestedCustomNodes, group: "comfyui" },
    ]);
    lstatMock.mockImplementation((p: string) =>
      Promise.resolve({ isSymbolicLink: () => resolve(p) === linkDir }),
    );
    realpathMock.mockImplementation((p: string) =>
      Promise.resolve(resolve(p) === linkDir ? goodTarget : resolve(p)),
    );

    const dir = await resolveModelSubfolderPreferServer("ok");
    expect(dir).toBe(linkDir);
  });

  it("rejects the escape when NO extra roots are registered at all", async () => {
    getSystemStats.mockRejectedValue(new Error("no server"));
    const modelsRoot = resolve(COMFYUI_PATH, "models");
    const linkDir = resolve(modelsRoot, "external_unet_download");
    const evilOutside = resolve("/tmp/evil-outside");

    getExtraModelRootsMock.mockResolvedValue([]);
    lstatMock.mockImplementation((p: string) =>
      Promise.resolve({ isSymbolicLink: () => resolve(p) === linkDir }),
    );
    realpathMock.mockImplementation((p: string) =>
      Promise.resolve(resolve(p) === linkDir ? evilOutside : resolve(p)),
    );

    await expect(
      resolveModelSubfolderPreferServer("external_unet_download"),
    ).rejects.toBeInstanceOf(ModelError);
  });
});
