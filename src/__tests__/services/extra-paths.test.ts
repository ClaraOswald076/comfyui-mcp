import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

let dirs: string[] = [];
const oldAppData = process.env.APPDATA;

beforeEach(() => {
  config.comfyuiPath = undefined;
  dirs = [];
  mockResolveServerExtraModelConfig.mockResolvedValue(undefined);
  mockIsRemoteMode.mockReturnValue(false);
  // Point the saved-default-workspace store at a path that does not exist, so the
  // default for every test is "no saved default" (never the developer's real one).
  configureWorkspace({ configPath: join(tmpdir(), "comfyui-mcp-no-such-workspace.json") });
});

afterEach(async () => {
  process.env.APPDATA = oldAppData;
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

  it("a nonexistent COMFYUI_PATH is NOT gated (pre-#648 behavior preserved)", async () => {
    // The stale guard covers only the saved default workspace: COMFYUI_PATH is the user
    // directly naming a root, and it has always reported exists:false rather than erroring.
    const gone = join(await trackTmp(), "no-such-install");
    config.comfyuiPath = gone;

    const result = await listExtraPaths({ target: "standalone" });
    expect(result.path).toBe(join(gone, "extra_model_paths.yaml"));
    expect(result.exists).toBe(false);
    expect(result.groups).toEqual([]);
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
