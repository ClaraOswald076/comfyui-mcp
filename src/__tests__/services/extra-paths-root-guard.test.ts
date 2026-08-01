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
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

const mockGetSystemStats = vi.hoisted(() =>
  vi.fn(async (): Promise<{ system?: { argv?: string[]; cwd?: string } }> => {
    throw new Error("unreachable");
  }),
);
vi.mock("../../comfyui/client.js", () => ({ getSystemStats: mockGetSystemStats }));

/**
 * Scripted stat results for ONE path. Each entry is either `{dev, ino}` (directory
 * present with that identity — `{dev: 0, ino: 0}` models a volume that reports no usable
 * identity) or null (gone). Entries are consumed in order; `consumed` records how many
 * were taken so a test can prove the guard actually ran the number of times it claims.
 */
type StatStep = { dev: number; ino: number } | null;
const script = vi.hoisted(() => ({
  path: "" as string,
  queue: [] as StatStep[],
  consumed: 0,
  /** Scripted symlink resolution: realpathSync(key) → value. Models a symlinked main.py
   *  on every platform (Windows needs privileges to create a real one). */
  realpath: {} as Record<string, string>,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    statSync: ((p: string, ...rest: unknown[]) => {
      if (script.path && String(p) === script.path && script.queue.length > 0) {
        const next = script.queue.shift() as StatStep;
        script.consumed += 1;
        if (next === null) {
          const err = new Error(`ENOENT: no such file or directory, stat '${p}'`);
          (err as NodeJS.ErrnoException).code = "ENOENT";
          throw err;
        }
        return { isDirectory: () => true, dev: next.dev, ino: next.ino } as unknown as ReturnType<
          typeof actual.statSync
        >;
      }
      return (actual.statSync as (...a: unknown[]) => unknown)(p, ...rest);
    }) as typeof actual.statSync,
    realpathSync: ((p: string, ...rest: unknown[]) => {
      const mapped = script.realpath[String(p)];
      if (mapped !== undefined) return mapped;
      return (actual.realpathSync as (...a: unknown[]) => unknown)(p, ...rest);
    }) as typeof actual.realpathSync,
  };
});

/** Shorthand: a present directory with identity `n` (0 → no usable identity). */
const at = (n: number): StatStep => ({ dev: n === 0 ? 0 : 42, ino: n });

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
async function savedWorkspace(stats: StatStep[]): Promise<string> {
  const workspace = await trackTmp();
  const cfgDir = await trackTmp();
  const cfgPath = join(cfgDir, "workspace.json");
  await writeFile(cfgPath, JSON.stringify({ defaultWorkspace: workspace }), "utf-8");
  configureWorkspace({ configPath: cfgPath });
  script.path = workspace;
  script.queue = [...stats];
  script.consumed = 0;
  return workspace;
}

beforeEach(() => {
  config.comfyuiPath = undefined;
  delete process.env.COMFYUI_PATH;
  mockIsRemoteMode.mockReturnValue(false);
  mockGetSystemStats.mockRejectedValue(new Error("unreachable"));
  dirs = [];
  script.path = "";
  script.queue = [];
  script.consumed = 0;
  script.realpath = {};
});

afterEach(async () => {
  resetWorkspaceConfig();
  script.path = "";
  script.queue = [];
  script.realpath = {};
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

describe("inferred root revalidation at the point of use", () => {
  it("list: a root that DISAPPEARS after the resolution gate is UNRESOLVED, not empty", async () => {
    // stat #1 = the resolution gate (present); stat #2 = the pre-read revalidation (gone).
    await savedWorkspace([at(1), null]);

    await expect(listExtraPaths({ target: "standalone" })).rejects.toThrow(
      /UNRESOLVED.*no longer an existing directory/s,
    );
    expect(script.consumed).toBe(2); // it really got as far as the pre-read check
  });

  it("list: a root REPLACED by a different directory is UNRESOLVED", async () => {
    // Same pathname, different inode → not the tree this call resolved.
    await savedWorkspace([at(1), at(2)]);

    await expect(listExtraPaths({ target: "standalone" })).rejects.toThrow(
      /UNRESOLVED.*REPLACED by a different directory/s,
    );
  });

  it("list: a root replaced DURING the read is caught by the POST-read revalidation", async () => {
    // #1 gate, #2 pre-read (fine — the read proceeds), #3 post-read (replaced). Without
    // the post-read check this would return a normal result built from the old tree.
    await savedWorkspace([at(1), at(1), at(2)]);

    await expect(listExtraPaths({ target: "standalone" })).rejects.toThrow(
      /REPLACED by a different directory/,
    );
    expect(script.consumed).toBe(3);
  });

  it("add: a root REPLACED between the read and the write is refused, and nothing is written", async () => {
    // #1 gate, #2 pre-read, #3 pre-write (replaced).
    const workspace = await savedWorkspace([at(1), at(1), at(2)]);

    await expect(
      addExtraPath({ target: "standalone", category: "loras", path: "E:/loras" }),
    ).rejects.toThrow(/REPLACED by a different directory/);
    expect(existsSync(join(workspace, "extra_model_paths.yaml"))).toBe(false);
    expect(script.consumed).toBe(3);
  });

  it("add: a root that DISAPPEARS between the read and the write is refused", async () => {
    const workspace = await savedWorkspace([at(1), at(1), null]);

    await expect(
      addExtraPath({ target: "standalone", category: "loras", path: "E:/loras" }),
    ).rejects.toThrow(/no longer an existing directory/);
    expect(existsSync(join(workspace, "extra_model_paths.yaml"))).toBe(false);
  });

  it("remove: the same guard applies to the removal write path", async () => {
    const workspace = await savedWorkspace([at(1), at(1), at(2)]);
    await writeFile(
      join(workspace, "extra_model_paths.yaml"),
      "comfyui_mcp:\n  loras: E:/loras\n",
      "utf-8",
    );

    await expect(
      removeExtraPath({ target: "standalone", category: "loras", path: "E:/loras" }),
    ).rejects.toThrow(/REPLACED by a different directory/);
    // The original config is untouched.
    expect(
      await readFile(join(workspace, "extra_model_paths.yaml"), "utf-8"),
    ).toContain("E:/loras");
  });

  it("a stable root passes every revalidation and the operation succeeds", async () => {
    // Exactly three scripted stats — gate, pre-read, pre-write — all the same inode.
    // Asserting the queue is EXHAUSTED proves the guard ran on every one of them
    // (a missing call would leave an entry behind).
    const workspace = await savedWorkspace([at(7), at(7), at(7)]);

    const added = await addExtraPath({
      target: "standalone",
      group: "shared",
      category: "loras",
      path: "E:/loras",
    });
    expect(added.changed).toBe(true);
    expect(added.path).toBe(join(workspace, "extra_model_paths.yaml"));
    expect(script.consumed).toBe(3);
    expect(script.queue).toHaveLength(0);
  });

  it("a filesystem reporting dev/ino 0 degrades to an existence check, never a refusal", async () => {
    // Some Windows volumes report no usable directory identity. The guard must then fall
    // back to plain existence rather than refusing everything it cannot fingerprint —
    // and must NOT read 0 !== 0 as a replacement.
    const workspace = await savedWorkspace([at(0), at(0), at(0)]);

    const added = await addExtraPath({ target: "standalone", category: "vae", path: "E:/vae" });
    expect(added.changed).toBe(true);
    expect(existsSync(join(workspace, "extra_model_paths.yaml"))).toBe(true);
    expect(script.consumed).toBe(3);
  });

  it("live root: a SYMLINKED main.py resolves to the real install root (platform-independent)", async () => {
    // ComfyUI reads the implicit config next to os.path.realpath(__file__). Scripted
    // realpathSync stands in for a symlink so this runs everywhere, including on a
    // Windows box that cannot create one.
    const launcher = await trackTmp();
    const real = await trackTmp();
    await writeFile(join(real, "main.py"), "# comfyui\n", "utf-8");
    script.realpath[join(launcher, "main.py")] = join(real, "main.py");
    mockGetSystemStats.mockResolvedValue({
      system: { argv: ["python", join(launcher, "main.py")] },
    });

    const added = await addExtraPath({ category: "loras", path: "E:/loras" });

    expect(added.path).toBe(join(real, "extra_model_paths.yaml"));
    expect(existsSync(join(real, "extra_model_paths.yaml"))).toBe(true);
    expect(existsSync(join(launcher, "extra_model_paths.yaml"))).toBe(false);
  });

  it("live root: it is GUARDED too — a replacement mid-call is refused", async () => {
    // The live root is derived from argv, so it gets the same point-of-use guard as any
    // other root this process derived (codex round 6, P1b).
    const live = await trackTmp();
    await writeFile(join(live, "main.py"), "# comfyui\n", "utf-8");
    mockGetSystemStats.mockResolvedValue({ system: { argv: ["python", join(live, "main.py")] } });
    script.path = live;
    script.queue = [at(1), at(1), at(2)]; // gate, pre-read, pre-write (replaced)
    script.consumed = 0;

    await expect(addExtraPath({ category: "loras", path: "E:/loras" })).rejects.toThrow(
      /REPLACED by a different directory/,
    );
    expect(existsSync(join(live, "extra_model_paths.yaml"))).toBe(false);
  });

  it("a root whose identity only BECOMES available mid-call is not treated as replaced", async () => {
    // Gate saw no identity (0) but a later stat reports one: nothing proves a change, so
    // the operation must proceed rather than fail on an unprovable mismatch.
    await savedWorkspace([at(0), at(9), at(9)]);

    const added = await addExtraPath({ target: "standalone", category: "vae", path: "E:/vae" });
    expect(added.changed).toBe(true);
  });
});
