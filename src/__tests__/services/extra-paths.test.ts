import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

// isRemoteMode is consulted by resolveEffectiveComfyUIBase (the shared workspace
// resolver extra-paths now delegates to for the standalone root, #648), so the config
// mock must supply it rather than leaving it undefined.
const mockIsRemoteMode = vi.hoisted(() => vi.fn(() => false));
vi.mock("../../config.js", () => ({
  config: { comfyuiPath: undefined as string | undefined },
  isRemoteMode: mockIsRemoteMode,
  getComfyUIBaseUrl: () => "http://127.0.0.1:8188",
}));

// By default the running server is unreachable in unit tests, so the
// server-preferred config resolves to nothing and the static heuristic applies.
// A dedicated describe below overrides this to exercise the #345 path.
const mockResolveServerExtraModelConfig = vi.hoisted(() =>
  vi.fn(async (): Promise<string | undefined> => undefined),
);
vi.mock("../../services/output-dir.js", () => ({
  resolveServerExtraModelConfig: mockResolveServerExtraModelConfig,
}));

// A server launched with NO --extra-model-paths-config still implicitly reads
// <its own main.py root>/extra_model_paths.yaml, so extra-paths now consults
// resolveLiveComfyUIBase() (→ /system_stats argv) before any static heuristic. Default
// to UNREACHABLE so unit tests never touch the network or a real local ComfyUI; a
// dedicated describe overrides it.
const mockGetSystemStats = vi.hoisted(() =>
  vi.fn(async (): Promise<{ system?: { argv?: string[]; cwd?: string } }> => {
    throw new Error("ComfyUI unreachable (test default)");
  }),
);
vi.mock("../../comfyui/client.js", () => ({ getSystemStats: mockGetSystemStats }));

// Pin the platform so the Desktop app-data path is deterministic across CI OSes:
// the desktop tests drive it via APPDATA (the win32 branch). Without this, Linux
// uses XDG_CONFIG_HOME/~/.config and macOS uses ~/Library, so the temp-dir
// assertions fail on those runners. (homedir/tmpdir stay real.)
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, platform: () => "win32" };
});

import { config } from "../../config.js";
import {
  addExtraPath,
  expandVars,
  listExtraPaths,
  removeExtraPath,
} from "../../services/extra-paths.js";
import { configureWorkspace, resetWorkspaceConfig } from "../../services/workspace-env.js";

async function tmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "comfyui-extra-paths-"));
}

/** Can this machine create a file symlink? (Windows needs privileges/Developer Mode.) */
const CAN_SYMLINK = (() => {
  try {
    const dir = mkdtempSync(join(tmpdir(), "comfyui-symlink-probe-"));
    writeFileSync(join(dir, "t"), "t");
    symlinkSync(join(dir, "t"), join(dir, "link"), "file");
    rmSync(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
})();

let dirs: string[] = [];
const oldAppData = process.env.APPDATA;
const oldComfyuiPathEnv = process.env.COMFYUI_PATH;

beforeEach(() => {
  config.comfyuiPath = undefined;
  // process.env.COMFYUI_PATH is the explicit-vs-inferred discriminator: a test that
  // means "the user named this root" sets it to the same path as config.comfyuiPath.
  delete process.env.COMFYUI_PATH;
  dirs = [];
  mockResolveServerExtraModelConfig.mockResolvedValue(undefined);
  mockGetSystemStats.mockRejectedValue(new Error("ComfyUI unreachable (test default)"));
  mockIsRemoteMode.mockReturnValue(false);
  // Point the saved-default-workspace store at a path that does not exist, so the
  // default for every test is "no saved default" (never the developer's real one).
  configureWorkspace({ configPath: join(tmpdir(), "comfyui-mcp-no-such-workspace.json") });
});

afterEach(async () => {
  process.env.APPDATA = oldAppData;
  if (oldComfyuiPathEnv === undefined) delete process.env.COMFYUI_PATH;
  else process.env.COMFYUI_PATH = oldComfyuiPathEnv;
  config.comfyuiPath = undefined;
  resetWorkspaceConfig();
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

/** Persist a saved default workspace (as set_default_workspace would) and return it. */
async function saveDefaultWorkspace(workspace: string): Promise<void> {
  const dir = await trackTmp();
  const cfgPath = join(dir, "workspace.json");
  await writeFile(cfgPath, JSON.stringify({ defaultWorkspace: workspace }), "utf-8");
  configureWorkspace({ configPath: cfgPath });
}

async function trackTmp(): Promise<string> {
  const dir = await tmpDir();
  dirs.push(dir);
  return dir;
}

describe("extra paths config service", () => {
  it("lists a standalone extra_model_paths.yaml from COMFYUI_PATH", async () => {
    const root = await trackTmp();
    config.comfyuiPath = root;
    await writeFile(
      join(root, "extra_model_paths.yaml"),
      [
        "shared:",
        "  base_path: D:/AI",
        "  is_default: true",
        "  checkpoints: |",
        "    models/checkpoints",
        "    E:/checkpoints",
        "  custom_nodes: C:/ComfyUI/custom_nodes",
        "",
      ].join("\n"),
      "utf-8",
    );

    const result = await listExtraPaths({ target: "standalone" });

    expect(result.target).toBe("standalone");
    expect(result.exists).toBe(true);
    expect(result.path).toBe(join(root, "extra_model_paths.yaml"));
    expect(result.groups[0]).toMatchObject({
      name: "shared",
      base_path: "D:/AI",
      categories: [
        { category: "checkpoints", paths: ["models/checkpoints", "E:/checkpoints"] },
        { category: "custom_nodes", paths: ["C:/ComfyUI/custom_nodes"] },
      ],
    });
  });

  it("adds paths idempotently and removes exact matches", async () => {
    const root = await trackTmp();
    config.comfyuiPath = root;

    const first = await addExtraPath({
      target: "standalone",
      group: "shared",
      category: "loras",
      path: "D:/Models/loras",
      isDefault: true,
    });
    expect(first.changed).toBe(true);
    expect(first.groups[0].categories[0]).toEqual({
      category: "loras",
      paths: ["D:/Models/loras"],
    });

    const second = await addExtraPath({
      target: "standalone",
      group: "shared",
      category: "loras",
      path: "D:/Models/loras",
    });
    expect(second.changed).toBe(false);

    const raw = await readFile(join(root, "extra_model_paths.yaml"), "utf-8");
    expect(raw).toContain("shared:");
    expect(raw).toContain("is_default: true");
    expect(raw.match(/D:\/Models\/loras/g)).toHaveLength(1);

    const removed = await removeExtraPath({
      target: "standalone",
      group: "shared",
      category: "loras",
      path: "D:/Models/loras",
    });
    expect(removed.changed).toBe(true);
    expect(removed.groups[0].categories).toEqual([]);
  });

  it("uses the Desktop app-data config path when requested explicitly", async () => {
    const appData = await trackTmp();
    process.env.APPDATA = appData;

    const result = await addExtraPath({
      target: "desktop",
      group: "desktop_shared",
      category: "checkpoints",
      path: "E:/SD/checkpoints",
    });

    expect(result.target).toBe("desktop");
    expect(result.path).toBe(join(appData, "ComfyUI", "extra_models_config.yaml"));
    expect(result.exists).toBe(true);
    expect(result.groups[0].categories[0].paths).toEqual(["E:/SD/checkpoints"]);
  });

  it("auto target prefers an existing Desktop config over standalone", async () => {
    const root = await trackTmp();
    const appData = await trackTmp();
    config.comfyuiPath = root;
    process.env.APPDATA = appData;
    const desktopPath = join(appData, "ComfyUI", "extra_models_config.yaml");
    await addExtraPath({
      target: "desktop",
      group: "desktop_shared",
      category: "vae",
      path: "E:/vae",
    });

    const result = await listExtraPaths({ target: "auto" });
    expect(result.target).toBe("desktop");
    expect(result.path).toBe(desktopPath);
  });

  it("lists the live server's --extra-model-paths-config, not the static app-data guess (#345)", async () => {
    const appData = await trackTmp();
    process.env.APPDATA = appData;
    // The server was launched with a Desktop-generated shared config on another
    // path; that is the file it actually reads.
    const serverCfg = join(appData, "Comfy Desktop", "shared_model_paths.yaml");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(appData, "Comfy Desktop"), { recursive: true });
    await writeFile(
      serverCfg,
      "# Generated by Comfy Desktop - do not edit manually\nd_ai:\n  vae: E:/vae\n",
    );
    mockResolveServerExtraModelConfig.mockResolvedValue(serverCfg);

    const result = await listExtraPaths({ target: "auto" });
    expect(result.target).toBe("desktop");
    expect(result.path).toBe(serverCfg);
    // Warns that it is Desktop-generated / diverges from the static guess.
    expect(result.notes.some((n) => /do not edit|auto-generated/i.test(n))).toBe(true);
    expect(result.notes.some((n) => /--extra-model-paths-config/i.test(n))).toBe(true);
  });

  it("rejects unsafe category keys and newline-bearing paths", async () => {
    const root = await trackTmp();
    config.comfyuiPath = root;

    await expect(
      addExtraPath({
        target: "standalone",
        category: "../bad",
        path: "D:/Models",
      }),
    ).rejects.toThrow(/Category/);

    await expect(
      addExtraPath({
        target: "standalone",
        category: "checkpoints",
        path: "D:/Models\nother",
      }),
    ).rejects.toThrow(/newline/);
  });
});

describe("standalone root precedence — saved default workspace (#648)", () => {
  /** Write a one-group extra_model_paths.yaml into `root` and return its path. */
  async function seedConfig(root: string, category: string, dir: string): Promise<string> {
    const path = join(root, "extra_model_paths.yaml");
    await writeFile(path, [`seeded:`, `  ${category}: ${dir}`, ""].join("\n"), "utf-8");
    return path;
  }

  it("uses the saved default workspace when COMFYUI_PATH is unset", async () => {
    const workspace = await trackTmp();
    const cfgPath = await seedConfig(workspace, "checkpoints", "E:/ws/checkpoints");
    await saveDefaultWorkspace(workspace);
    config.comfyuiPath = undefined;

    const result = await listExtraPaths({ target: "standalone" });

    expect(result.path).toBe(cfgPath);
    expect(result.exists).toBe(true);
    expect(result.groups[0].categories).toEqual([
      { category: "checkpoints", paths: ["E:/ws/checkpoints"] },
    ]);
    // The non-default source is stated, never silently assumed.
    expect(result.notes.some((n) => /saved default workspace/i.test(n))).toBe(true);
    // …and the generic "which file" hint is still present on this static path.
    expect(result.notes.some((n) => /extra_model_paths\.yaml in the ComfyUI root/i.test(n))).toBe(
      true,
    );
  });

  it("auto target falls back to the saved default workspace when no Desktop config exists", async () => {
    const workspace = await trackTmp();
    const appData = await trackTmp(); // exists, but has no ComfyUI/extra_models_config.yaml
    process.env.APPDATA = appData;
    const cfgPath = await seedConfig(workspace, "loras", "E:/ws/loras");
    await saveDefaultWorkspace(workspace);
    config.comfyuiPath = undefined;

    const result = await listExtraPaths({ target: "auto" });

    expect(result.target).toBe("standalone");
    expect(result.path).toBe(cfgPath);
  });

  it("COMFYUI_PATH still WINS over a saved default workspace", async () => {
    const envRoot = await trackTmp();
    const workspace = await trackTmp();
    const envCfg = await seedConfig(envRoot, "vae", "E:/env/vae");
    await seedConfig(workspace, "vae", "E:/ws/vae");
    await saveDefaultWorkspace(workspace);
    config.comfyuiPath = envRoot;

    const result = await listExtraPaths({ target: "standalone" });

    expect(result.path).toBe(envCfg);
    expect(result.groups[0].categories).toEqual([{ category: "vae", paths: ["E:/env/vae"] }]);
    // No workspace-source note: the active path is the configured one.
    expect(result.notes.some((n) => /saved default workspace/i.test(n))).toBe(false);
  });

  it("mutations honor the saved default workspace too (add writes into it)", async () => {
    const workspace = await trackTmp();
    await saveDefaultWorkspace(workspace);
    config.comfyuiPath = undefined;

    const added = await addExtraPath({
      target: "standalone",
      group: "shared",
      category: "loras",
      path: "E:/ws/loras",
    });

    expect(added.path).toBe(join(workspace, "extra_model_paths.yaml"));
    expect(added.changed).toBe(true);
    const raw = await readFile(join(workspace, "extra_model_paths.yaml"), "utf-8");
    expect(raw).toContain("E:/ws/loras");
  });

  it("is EXPLICITLY unresolved (throws) when there is neither COMFYUI_PATH nor a saved default", async () => {
    config.comfyuiPath = undefined;
    await expect(listExtraPaths({ target: "standalone" })).rejects.toThrow(/UNRESOLVED/);
    // …and it never degrades to an authoritative-looking empty list.
    await expect(listExtraPaths({ target: "standalone" })).rejects.toThrow(
      /not an empty config/i,
    );
  });

  it("refuses a local saved default workspace in REMOTE mode (explicitly unresolved)", async () => {
    const workspace = await trackTmp();
    await seedConfig(workspace, "checkpoints", "E:/ws/checkpoints");
    await saveDefaultWorkspace(workspace);
    config.comfyuiPath = undefined;
    mockIsRemoteMode.mockReturnValue(true);

    await expect(listExtraPaths({ target: "standalone" })).rejects.toThrow(/UNRESOLVED/);
    await expect(listExtraPaths({ target: "standalone" })).rejects.toThrow(/REMOTE/);
  });

  it("REFUSES a saved default workspace that no longer exists (no phantom listing)", async () => {
    const gone = join(await trackTmp(), "moved-away", "ComfyUI");
    await saveDefaultWorkspace(gone);
    config.comfyuiPath = undefined;

    await expect(listExtraPaths({ target: "standalone" })).rejects.toThrow(/UNRESOLVED/);
    await expect(listExtraPaths({ target: "standalone" })).rejects.toThrow(
      /not an existing directory/i,
    );
  });

  it("REFUSES to materialize a vanished saved workspace on add (wrong-destination write)", async () => {
    const parent = await trackTmp();
    const gone = join(parent, "moved-away", "ComfyUI");
    await saveDefaultWorkspace(gone);
    config.comfyuiPath = undefined;

    await expect(
      addExtraPath({ target: "standalone", category: "loras", path: "E:/loras" }),
    ).rejects.toThrow(/UNRESOLVED/);
    // The recursive mkdir in writeConfigFile must never have run.
    expect(existsSync(join(parent, "moved-away"))).toBe(false);
  });

  it("REFUSES a saved default workspace that points at a FILE, not a directory", async () => {
    const dir = await trackTmp();
    const notADir = join(dir, "not-a-workspace.txt");
    await writeFile(notADir, "i am a file\n", "utf-8");
    await saveDefaultWorkspace(notADir);
    config.comfyuiPath = undefined;

    await expect(listExtraPaths({ target: "standalone" })).rejects.toThrow(
      /not an existing directory/i,
    );
  });

  it("REFUSES remove against a vanished saved workspace too (both mutation paths gated)", async () => {
    const parent = await trackTmp();
    const gone = join(parent, "moved-away", "ComfyUI");
    await saveDefaultWorkspace(gone);
    config.comfyuiPath = undefined;

    await expect(
      removeExtraPath({ target: "standalone", category: "loras", path: "E:/loras" }),
    ).rejects.toThrow(/UNRESOLVED/);
    expect(existsSync(join(parent, "moved-away"))).toBe(false);
  });

  it("a nonexistent EXPLICIT COMFYUI_PATH is NOT gated (pre-#648 behavior preserved)", async () => {
    // The stale guard covers INFERRED roots only: an explicit COMFYUI_PATH env var is the
    // user directly naming a root, and it has always reported exists:false, not errored.
    const gone = join(await trackTmp(), "no-such-install");
    config.comfyuiPath = gone;
    process.env.COMFYUI_PATH = gone;

    const result = await listExtraPaths({ target: "standalone" });
    expect(result.path).toBe(join(gone, "extra_model_paths.yaml"));
    expect(result.exists).toBe(false);
    expect(result.groups).toEqual([]);
  });

  it("an AUTO-DETECTED comfyuiPath that vanished IS gated (not an explicit user directive)", async () => {
    // config.comfyuiPath can come from startup auto-detection, which can go stale in a
    // long-lived MCP process exactly like a saved workspace (codex round 3, P1b).
    const gone = join(await trackTmp(), "no-such-install");
    config.comfyuiPath = gone;
    delete process.env.COMFYUI_PATH; // → auto-detected

    await expect(listExtraPaths({ target: "standalone" })).rejects.toThrow(/UNRESOLVED/);
    await expect(listExtraPaths({ target: "standalone" })).rejects.toThrow(/INFERRED/);
  });

  it("a DESCENDED COMFYUI_PATH (nested root) that vanished IS gated (codex round 4)", async () => {
    // config.ts's descendToNestedRoot turns a Desktop-installer wrapper named by
    // COMFYUI_PATH into <wrapper>/ComfyUI. That nested root is inferred, not named, and
    // can vanish while the wrapper survives — so it must NOT be recreated by mkdir -p.
    const wrapper = await trackTmp();
    const nested = join(wrapper, "ComfyUI");
    process.env.COMFYUI_PATH = wrapper; // what the user set
    config.comfyuiPath = nested; // what config.ts descended to; now gone

    await expect(listExtraPaths({ target: "standalone" })).rejects.toThrow(/UNRESOLVED/);
    await expect(
      addExtraPath({ target: "standalone", category: "loras", path: "E:/loras" }),
    ).rejects.toThrow(/UNRESOLVED/);
    expect(existsSync(nested)).toBe(false);
  });

  it("an UN-descended COMFYUI_PATH is still explicit even with a trailing separator", async () => {
    // Path comparison is normalized, so `D:\ComfyUI\` and `D:\ComfyUI` are the same root
    // and the explicit (ungated) classification is not lost to cosmetics.
    const gone = join(await trackTmp(), "no-such-install");
    config.comfyuiPath = gone;
    process.env.COMFYUI_PATH = `${gone}${sep}`;

    const result = await listExtraPaths({ target: "standalone" });
    expect(result.exists).toBe(false);
  });

  // Matrix: root SOURCE x on-disk STATE x OPERATION. Each row sets up the source, then
  // asserts every operation, so a regression in any single cell is caught (codex round 5).
  type Source = "explicit-env" | "inferred-detected" | "inferred-descended" | "saved-default";

  /** Point the resolver at `root` as `source`; returns the root. */
  async function useRoot(source: Source, root: string): Promise<void> {
    config.comfyuiPath = undefined;
    delete process.env.COMFYUI_PATH;
    if (source === "explicit-env") {
      config.comfyuiPath = root;
      process.env.COMFYUI_PATH = root;
    } else if (source === "inferred-detected") {
      config.comfyuiPath = root; // no env var → startup auto-detection
    } else if (source === "inferred-descended") {
      config.comfyuiPath = root; // config.ts descended COMFYUI_PATH to a nested root
      process.env.COMFYUI_PATH = join(root, "..");
    } else {
      await saveDefaultWorkspace(root);
    }
  }

  const inferred: Source[] = ["inferred-detected", "inferred-descended", "saved-default"];

  for (const source of inferred) {
    it(`${source}: a VANISHED root is refused by list, add and remove alike`, async () => {
      const parent = await trackTmp();
      const gone = join(parent, "wrapper", "ComfyUI");
      await useRoot(source, gone);

      await expect(listExtraPaths({ target: "standalone" })).rejects.toThrow(/UNRESOLVED/);
      await expect(
        addExtraPath({ target: "standalone", category: "loras", path: "E:/x" }),
      ).rejects.toThrow(/UNRESOLVED/);
      await expect(
        removeExtraPath({ target: "standalone", category: "loras", path: "E:/x" }),
      ).rejects.toThrow(/UNRESOLVED/);
      expect(existsSync(join(parent, "wrapper"))).toBe(false);
    });

    it(`${source}: an EXISTING root round-trips list -> add -> remove`, async () => {
      const root = await trackTmp();
      await useRoot(source, root);

      const added = await addExtraPath({
        target: "standalone",
        group: "shared",
        category: "loras",
        path: "E:/x",
      });
      expect(added.changed).toBe(true);
      expect(added.path).toBe(join(root, "extra_model_paths.yaml"));

      const listed = await listExtraPaths({ target: "standalone" });
      expect(listed.groups[0].categories).toEqual([{ category: "loras", paths: ["E:/x"] }]);

      const removed = await removeExtraPath({
        target: "standalone",
        group: "shared",
        category: "loras",
        path: "E:/x",
      });
      expect(removed.changed).toBe(true);
    });
  }

  it("explicit-env: a VANISHED root is NOT refused, and add still creates it (pre-#648)", async () => {
    // The deliberate asymmetry: an explicit COMFYUI_PATH is the user naming a root, so it
    // keeps its pre-#648 create-on-write behavior. Pinned so it cannot drift silently.
    const parent = await trackTmp();
    const gone = join(parent, "wrapper", "ComfyUI");
    await useRoot("explicit-env", gone);

    const listed = await listExtraPaths({ target: "standalone" });
    expect(listed.exists).toBe(false);

    const added = await addExtraPath({ target: "standalone", category: "loras", path: "E:/x" });
    expect(added.changed).toBe(true);
    expect(existsSync(join(gone, "extra_model_paths.yaml"))).toBe(true);
  });

  it("an explicit config_path is honored with no workspace lookup at all", async () => {
    const dir = await trackTmp();
    const explicit = join(dir, "custom.yaml");
    await writeFile(explicit, "grp:\n  unet: E:/explicit/unet\n", "utf-8");
    config.comfyuiPath = undefined; // no COMFYUI_PATH, no saved default → still fine

    const result = await listExtraPaths({ configPath: explicit });
    expect(result.path).toBe(explicit);
    expect(result.groups[0].categories).toEqual([{ category: "unet", paths: ["E:/explicit/unet"] }]);
  });
});

describe("a reachable server with NO --extra-model-paths-config is still authoritative", () => {
  /** Make /system_stats report a server running from `root`/main.py, and put a real
   *  main.py there — resolution now PROVES the live root by resolving that file, so a
   *  root we cannot see is refused rather than fabricated. */
  async function liveAt(root: string): Promise<void> {
    await writeFile(join(root, "main.py"), "# comfyui\n", "utf-8");
    mockGetSystemStats.mockResolvedValue({ system: { argv: ["python", join(root, "main.py")] } });
  }

  it("prefers <live root>/extra_model_paths.yaml over an EXISTING saved workspace", async () => {
    // The wrong-TREE case the existence gate cannot catch: workspace A is real, but the
    // live server runs from B and implicitly reads B/extra_model_paths.yaml.
    const workspaceA = await trackTmp();
    const liveB = await trackTmp();
    await writeFile(
      join(workspaceA, "extra_model_paths.yaml"),
      "stale:\n  checkpoints: E:/from-A\n",
      "utf-8",
    );
    await writeFile(
      join(liveB, "extra_model_paths.yaml"),
      "live:\n  checkpoints: E:/from-B\n",
      "utf-8",
    );
    await saveDefaultWorkspace(workspaceA);
    config.comfyuiPath = undefined;
    await liveAt(liveB);

    const result = await listExtraPaths(); // default auto target

    expect(result.path).toBe(join(liveB, "extra_model_paths.yaml"));
    expect(result.groups[0].categories).toEqual([
      { category: "checkpoints", paths: ["E:/from-B"] },
    ]);
    expect(result.notes.some((n) => /RUNNING ComfyUI's own install root/i.test(n))).toBe(true);
    expect(result.notes.some((n) => n.includes(workspaceA) && /silent no-op/i.test(n))).toBe(true);
  });

  it("add_extra_path WRITES into the live root, not the saved workspace", async () => {
    const workspaceA = await trackTmp();
    const liveB = await trackTmp();
    await saveDefaultWorkspace(workspaceA);
    config.comfyuiPath = undefined;
    await liveAt(liveB);

    const added = await addExtraPath({ group: "shared", category: "loras", path: "E:/loras" });

    expect(added.path).toBe(join(liveB, "extra_model_paths.yaml"));
    expect(existsSync(join(liveB, "extra_model_paths.yaml"))).toBe(true);
    expect(existsSync(join(workspaceA, "extra_model_paths.yaml"))).toBe(false);
  });

  it("also beats a COMFYUI_PATH pointing at a different install", async () => {
    const stale = await trackTmp();
    const liveB = await trackTmp();
    config.comfyuiPath = stale;
    process.env.COMFYUI_PATH = stale;
    await liveAt(liveB);

    const result = await listExtraPaths();
    expect(result.path).toBe(join(liveB, "extra_model_paths.yaml"));
  });

  it("does NOT override an explicit target or config_path", async () => {
    const workspaceA = await trackTmp();
    const liveB = await trackTmp();
    await saveDefaultWorkspace(workspaceA);
    config.comfyuiPath = undefined;
    await liveAt(liveB);

    const pinned = await listExtraPaths({ target: "standalone" });
    expect(pinned.path).toBe(join(workspaceA, "extra_model_paths.yaml"));

    const explicit = join(await trackTmp(), "custom.yaml");
    await writeFile(explicit, "g:\n  vae: E:/v\n", "utf-8");
    const byPath = await listExtraPaths({ configPath: explicit });
    expect(byPath.path).toBe(explicit);
  });

  it("the --extra-model-paths-config launch flag still wins over the implicit root", async () => {
    const liveB = await trackTmp();
    const flagged = join(await trackTmp(), "flagged.yaml");
    await writeFile(flagged, "f:\n  vae: E:/flag\n", "utf-8");
    await liveAt(liveB);
    mockResolveServerExtraModelConfig.mockResolvedValue(flagged);

    const result = await listExtraPaths();
    expect(result.path).toBe(flagged);
  });

  it("falls back to the static heuristic when the live root is not derivable", async () => {
    const workspaceA = await trackTmp();
    process.env.APPDATA = await trackTmp(); // no Desktop config → auto picks standalone
    await saveDefaultWorkspace(workspaceA);
    config.comfyuiPath = undefined;
    // Reachable, but argv has no main.py → no resolvable live root.
    mockGetSystemStats.mockResolvedValue({ system: { argv: ["python", "-c", "print(1)"] } });

    const result = await listExtraPaths();
    expect(result.path).toBe(join(workspaceA, "extra_model_paths.yaml"));
  });

  it("REFUSES when the live root cannot be resolved from here (container/WSL/another host)", async () => {
    // Reachable server reporting a root whose main.py we cannot see. Falling back to the
    // saved workspace would be exactly the wrong-tree write this branch exists to stop.
    const workspaceA = await trackTmp();
    await saveDefaultWorkspace(workspaceA);
    config.comfyuiPath = undefined;
    mockGetSystemStats.mockResolvedValue({
      system: { argv: ["python", join(await trackTmp(), "not-mounted", "main.py")] },
    });

    await expect(listExtraPaths()).rejects.toThrow(/UNRESOLVED.*cannot be resolved from this process/s);
    // …and it did NOT quietly write into the saved workspace instead.
    await expect(
      addExtraPath({ category: "loras", path: "E:/loras" }),
    ).rejects.toThrow(/UNRESOLVED/);
    expect(existsSync(join(workspaceA, "extra_model_paths.yaml"))).toBe(false);
  });

  // Real symlinks need privileges/Developer Mode on Windows. Skipped rather than
  // silently returning when unavailable, so it can never read as a vacuous pass;
  // extra-paths-root-guard.test.ts proves the same realpath behavior on every platform
  // by scripting realpathSync.
  it.skipIf(!CAN_SYMLINK)(
    "follows a SYMLINKED main.py to the real install root (ComfyUI uses realpath)",
    async () => {
      // ComfyUI locates the implicit config next to os.path.realpath(__file__), so a
      // launcher dir that symlinks main.py must not receive the write.
      const launcher = await trackTmp();
      const real = await trackTmp();
      await writeFile(join(real, "main.py"), "# comfyui\n", "utf-8");
      symlinkSync(join(real, "main.py"), join(launcher, "main.py"), "file");
      mockGetSystemStats.mockResolvedValue({
        system: { argv: ["python", join(launcher, "main.py")] },
      });
      config.comfyuiPath = undefined;

      const added = await addExtraPath({ category: "loras", path: "E:/loras" });
      expect(added.path).toBe(join(real, "extra_model_paths.yaml"));
      expect(existsSync(join(launcher, "extra_model_paths.yaml"))).toBe(false);
    },
  );

  it("ignores the live root in REMOTE mode (it is a path on the remote host)", async () => {
    const liveB = await trackTmp();
    process.env.APPDATA = await trackTmp(); // no Desktop config to fall into
    await liveAt(liveB);
    mockIsRemoteMode.mockReturnValue(true);
    config.comfyuiPath = undefined;

    // No local root is usable in remote mode → explicit UNRESOLVED, never the remote path.
    await expect(listExtraPaths()).rejects.toThrow(/UNRESOLVED/);
  });
});

describe("expandVars — single-pass %VAR% scanner (no placeholder round-trip)", () => {
  const VAR = "CMCP_EXPAND_TEST_VAR";
  const oldValue = process.env[VAR];

  beforeEach(() => {
    process.env[VAR] = "D:\\real";
  });
  afterEach(() => {
    if (oldValue === undefined) delete process.env[VAR];
    else process.env[VAR] = oldValue;
  });

  const cases: Array<[name: string, input: string, expected: string]> = [
    ["%% is an escaped literal %", "%%", "%"],
    ["%%VAR%% is the literal %VAR% form, not the value", `%%${VAR}%%`, `%${VAR}%`],
    ["a defined %VAR% expands", `%${VAR}%`, "D:\\real"],
    ["an UNDEFINED %VAR% stays literal", "%CMCP_NOT_SET_ANYWHERE%", "%CMCP_NOT_SET_ANYWHERE%"],
    ["a defined %VAR% expands mid-path", `C:\\a\\%${VAR}%\\b`, "C:\\a\\D:\\real\\b"],
    // The old implementation swapped `%%` for the literal token "__CMCP_PCT_9f3a__" and
    // restored it afterwards, so an input CONTAINING that token was silently rewritten
    // to `%` — a wrong-destination corruption. A single pass cannot do that.
    [
      "a path containing the old sentinel token survives byte-identical",
      "D:\\models\\__CMCP_PCT_9f3a__\\loras",
      "D:\\models\\__CMCP_PCT_9f3a__\\loras",
    ],
    [
      "a path made of ONLY the old sentinel token survives byte-identical",
      "__CMCP_PCT_9f3a__",
      "__CMCP_PCT_9f3a__",
    ],
    ["an unterminated trailing % is literal", "D:\\models\\100%", "D:\\models\\100%"],
    ["an odd lone % before text is literal", "%not_a_var", "%not_a_var"],
    ["%%% is %% (escape then a lone literal %)", "%%%", "%%"],
    ["no percent at all is untouched", "D:\\plain\\path", "D:\\plain\\path"],
  ];

  for (const [name, input, expected] of cases) {
    it(name, () => {
      expect(expandVars(input)).toBe(expected);
    });
  }

  it("round-trips: expanding an already-escaped value does not re-expand it", () => {
    // %%VAR%% → %VAR% (literal); feeding a value that legitimately contains a `%`
    // never turns into machinery on a later pass because there is no later pass.
    expect(expandVars(`%%${VAR}%%`)).toBe(`%${VAR}%`);
  });

  it("${VAR} and $VAR still expand (unchanged, all platforms)", () => {
    expect(expandVars(`\${${VAR}}`)).toBe("D:\\real");
    expect(expandVars(`$${VAR}`)).toBe("D:\\real");
    expect(expandVars("${CMCP_NOT_SET_ANYWHERE}")).toBe("${CMCP_NOT_SET_ANYWHERE}");
  });
});

/**
 * Every base_path spelling whose RESOLUTION CHANGED when the two-pass sentinel expander
 * was replaced by the single-pass CPython-shaped scanner, pinned so the next rewrite
 * cannot drift. Established by exhaustively comparing old vs new over all strings of
 * length <= 7 over {"%", defined var, undefined var, literal}: 3530 inputs differ, in
 * 192 shapes, and EVERY ONE of them contains a doubled "%%" — a base_path with no "%%"
 * is byte-identical under both.
 *
 * The rule that changed: the old code substituted a sentinel for EVERY "%%" in the
 * string BEFORE any variable token was identified, so a "%%" that was really the closing
 * "%" of one variable plus the opening "%" of the next was mis-consumed and everything
 * after it drifted. The scanner decides positionally — "%%" is an escape only when the
 * scan is AT a token boundary — which is what os.path.expandvars (ntpath) does, i.e.
 * what the ComfyUI process that reads the file does.
 */
describe("expandVars — every %VAR% spelling whose resolution changed (pinned)", () => {
  const A = "CMCP_XP_A";
  const B = "CMCP_XP_B";
  const Z = "CMCP_XP_UNDEFINED";
  const VA = "D:\\models";
  const VB = "E:\\extra";
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of [A, B, Z]) saved[k] = process.env[k];
    process.env[A] = VA;
    process.env[B] = VB;
    delete process.env[Z];
  });
  afterEach(() => {
    for (const k of [A, B, Z]) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  // [spelling, old result (for the record), new result = CPython/ComfyUI]
  const changed: Array<[input: string, old: string, expected: string]> = [
    [`%${A}%%${B}%`, `%${A}%${B}%`, `${VA}${VB}`],
    [`%${A}%%${Z}%`, `%${A}%${Z}%`, `${VA}%${Z}%`],
    [`%${A}%%${A}%`, `%${A}%${A}%`, `${VA}${VA}`],
    [`%${A}%%`, `%${A}%`, `${VA}%`],
    [`%${A}%%%`, `%${A}%%`, `${VA}%`],
    [`%${A}%%%${B}%`, `%${A}%%${B}%`, `${VA}%${B}%`],
    [`%${A}%%%%${B}%`, `%${A}%%${B}%`, `${VA}%${VB}`],
    [`%%%${A}%%`, `%%${A}%`, `%${VA}%`],
    [`%%${A}%${B}%%`, `%${A}%${B}%`, `%${A}${VB}%`],
    // The sentinel collision itself: a path literally containing the old placeholder.
    ["__CMCP_PCT_9f3a__", "%", "__CMCP_PCT_9f3a__"],
  ];

  for (const [input, old, expected] of changed) {
    it(`CHANGED ${JSON.stringify(input)}: was ${JSON.stringify(old)} -> now ${JSON.stringify(expected)}`, () => {
      expect(expandVars(input)).toBe(expected);
      expect(expandVars(input)).not.toBe(old);
    });
  }

  // Spellings the rewrite did NOT change. Pinned so a future "simplification" cannot
  // quietly move them either — these are the forms real configs actually use.
  const unchanged: Array<[input: string, expected: string]> = [
    ["%%", "%"],
    [`%%${A}%%`, `%${A}%`],
    [`%${A}%`, VA],
    [`%${Z}%`, `%${Z}%`],
    [`%${A}`, `%${A}`],
    ["%%%", "%%"],
    // The realistic "escaped percent inside a folder name" case — identical before/after.
    ["D:\\100%%\\models", "D:\\100%\\models"],
    ["D:\\100%\\models", "D:\\100%\\models"],
    ["D:\\plain\\path", "D:\\plain\\path"],
  ];

  for (const [input, expected] of unchanged) {
    it(`UNCHANGED ${JSON.stringify(input)} -> ${JSON.stringify(expected)}`, () => {
      expect(expandVars(input)).toBe(expected);
    });
  }
});
