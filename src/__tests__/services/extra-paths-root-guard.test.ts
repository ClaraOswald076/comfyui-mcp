/**
 * Point-of-use revalidation of an INFERRED standalone root (#648, coordinator P1-2).
 *
 * Resolution and I/O are separated by awaits, so proving the root exists ONCE during
 * resolution is a TOCTOU check. Two things can happen in that window:
 *   - the root is DELETED  → a read must say UNRESOLVED, not return a phantom EMPTY
 *     config (readConfigFile maps a missing file to {}), and a write must not proceed;
 *   - the root is REPLACED by a different directory at the same pathname → neither read
 *     nor write may proceed, and `createParents: false` alone does not help because the
 *     path exists again.
 *
 * Both are only reachable deterministically by scripting `statSync` for the root, which
 * is what this file does: the real fs is used for everything else, and only the guarded
 * root's stat is driven from a queue.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mockIsRemoteMode = vi.hoisted(() => vi.fn(() => false));
vi.mock("../../config.js", () => ({
  config: { comfyuiPath: undefined as string | undefined },
  isRemoteMode: mockIsRemoteMode,
  getComfyUIBaseUrl: () => "http://127.0.0.1:8188",
}));

vi.mock("../../services/output-dir.js", () => ({
  resolveServerExtraModelConfig: vi.fn(async () => undefined),
}));

vi.mock("../../comfyui/client.js", () => ({
  getSystemStats: vi.fn(async () => {
    throw new Error("unreachable");
  }),
}));

/**
 * Scripted stat results for ONE path. Each entry is either an inode number (directory
 * present with that identity) or null (gone). Entries are consumed in order; once the
 * queue is empty the real filesystem answers again.
 */
const script = vi.hoisted(() => ({
  path: "" as string,
  queue: [] as Array<number | null>,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    statSync: ((p: string, ...rest: unknown[]) => {
      if (script.path && String(p) === script.path && script.queue.length > 0) {
        const next = script.queue.shift();
        if (next === null) {
          const err = new Error(`ENOENT: no such file or directory, stat '${p}'`);
          (err as NodeJS.ErrnoException).code = "ENOENT";
          throw err;
        }
        return { isDirectory: () => true, dev: 42, ino: next } as unknown as ReturnType<
          typeof actual.statSync
        >;
      }
      return (actual.statSync as (...a: unknown[]) => unknown)(p, ...rest);
    }) as typeof actual.statSync,
  };
});

import { config } from "../../config.js";
import { addExtraPath, listExtraPaths, removeExtraPath } from "../../services/extra-paths.js";
import { configureWorkspace, resetWorkspaceConfig } from "../../services/workspace-env.js";

let dirs: string[] = [];

async function trackTmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "comfyui-root-guard-"));
  dirs.push(dir);
  return dir;
}

/** Persist a saved default workspace and arm the stat script for it. */
async function savedWorkspace(stats: Array<number | null>): Promise<string> {
  const workspace = await trackTmp();
  const cfgDir = await trackTmp();
  const cfgPath = join(cfgDir, "workspace.json");
  await writeFile(cfgPath, JSON.stringify({ defaultWorkspace: workspace }), "utf-8");
  configureWorkspace({ configPath: cfgPath });
  script.path = workspace;
  script.queue = [...stats];
  return workspace;
}

beforeEach(() => {
  config.comfyuiPath = undefined;
  delete process.env.COMFYUI_PATH;
  mockIsRemoteMode.mockReturnValue(false);
  dirs = [];
  script.path = "";
  script.queue = [];
});

afterEach(async () => {
  resetWorkspaceConfig();
  script.path = "";
  script.queue = [];
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

describe("inferred root revalidation at the point of use", () => {
  it("list: a root that DISAPPEARS after the resolution gate is UNRESOLVED, not empty", async () => {
    // stat #1 = the resolution gate (present); stat #2 = the pre-read revalidation (gone).
    await savedWorkspace([1, null]);

    await expect(listExtraPaths({ target: "standalone" })).rejects.toThrow(
      /UNRESOLVED.*no longer an existing directory/s,
    );
  });

  it("list: a root REPLACED by a different directory is UNRESOLVED", async () => {
    // Same pathname, different inode → not the tree this call resolved.
    await savedWorkspace([1, 2]);

    await expect(listExtraPaths({ target: "standalone" })).rejects.toThrow(
      /UNRESOLVED.*REPLACED by a different directory/s,
    );
  });

  it("add: a root REPLACED between the read and the write is refused, and nothing is written", async () => {
    // #1 gate, #2 pre-read, #3 pre-write (replaced).
    const workspace = await savedWorkspace([1, 1, 2]);

    await expect(
      addExtraPath({ target: "standalone", category: "loras", path: "E:/loras" }),
    ).rejects.toThrow(/REPLACED by a different directory/);
    expect(existsSync(join(workspace, "extra_model_paths.yaml"))).toBe(false);
  });

  it("add: a root that DISAPPEARS between the read and the write is refused", async () => {
    const workspace = await savedWorkspace([1, 1, null]);

    await expect(
      addExtraPath({ target: "standalone", category: "loras", path: "E:/loras" }),
    ).rejects.toThrow(/no longer an existing directory/);
    expect(existsSync(join(workspace, "extra_model_paths.yaml"))).toBe(false);
  });

  it("remove: the same guard applies to the removal write path", async () => {
    const workspace = await savedWorkspace([1, 1, 2]);
    await writeFile(
      join(workspace, "extra_model_paths.yaml"),
      "comfyui_mcp:\n  loras: E:/loras\n",
      "utf-8",
    );

    await expect(
      removeExtraPath({ target: "standalone", category: "loras", path: "E:/loras" }),
    ).rejects.toThrow(/REPLACED by a different directory/);
    // The original config is untouched.
    expect(existsSync(join(workspace, "extra_model_paths.yaml"))).toBe(true);
  });

  it("a stable root passes every revalidation and the operation succeeds", async () => {
    // Same inode throughout → no false refusals from the guard.
    const workspace = await savedWorkspace([7, 7, 7, 7, 7, 7]);

    const added = await addExtraPath({
      target: "standalone",
      group: "shared",
      category: "loras",
      path: "E:/loras",
    });
    expect(added.changed).toBe(true);
    expect(added.path).toBe(join(workspace, "extra_model_paths.yaml"));
  });

  it("a filesystem that reports no usable inode degrades to an existence check", async () => {
    // Real stats (no script) on a real directory: dev/ino may be 0 on some Windows
    // volumes, so identity is simply absent — the guard must still allow the operation
    // rather than refusing everything it cannot fingerprint.
    const workspace = await trackTmp();
    const cfgDir = await trackTmp();
    const cfgPath = join(cfgDir, "workspace.json");
    await writeFile(cfgPath, JSON.stringify({ defaultWorkspace: workspace }), "utf-8");
    configureWorkspace({ configPath: cfgPath });

    const added = await addExtraPath({ target: "standalone", category: "vae", path: "E:/vae" });
    expect(added.changed).toBe(true);
  });
});
