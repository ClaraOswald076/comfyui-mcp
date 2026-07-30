import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir, platform } from "node:os";
import { join } from "node:path";

const IS_WIN = platform() === "win32";
/** Create a venv interpreter on disk under `root`, returning its absolute path. */
async function makeVenvPython(root: string): Promise<string> {
  const bin = IS_WIN ? join(root, ".venv", "Scripts") : join(root, ".venv", "bin");
  await mkdir(bin, { recursive: true });
  const exe = join(bin, IS_WIN ? "python.exe" : "python3");
  await writeFile(exe, "", "utf-8");
  return exe;
}

// ---------------------------------------------------------------------------
// Mocks for modules with side effects / network at load time
// ---------------------------------------------------------------------------

type ExecResult = { stdout?: string; stderr?: string } | Error;

// Shared mutable state created via vi.hoisted so the vi.mock factories (which
// are hoisted to the top of the module) can safely reference it.
const h = vi.hoisted(() => {
  return {
    mockConfig: { comfyuiPath: undefined as string | undefined, resolvedPort: 8188 },
    mockGetSystemStats: vi.fn(),
    execFileResponder: (() => new Error("not configured")) as (
      cmd: string,
      args: string[],
    ) => ExecResult,
  };
});

vi.mock("../../config.js", () => ({
  config: h.mockConfig,
  getComfyUIBaseUrl: () => "http://127.0.0.1:8188",
  getComfyUIAuthHeaders: () => ({}),
  // resolveComfyuiPython → resolveEffectiveComfyUIBase consults isRemoteMode().
  isRemoteMode: () => false,
}));

vi.mock("../../comfyui/client.js", () => ({
  getSystemStats: () => h.mockGetSystemStats(),
}));

// execFile is wrapped by promisify() at module load. The mock invokes the
// node-style callback so promisify resolves/rejects accordingly. Tests set
// h.execFileResponder to control responses, keyed loosely by command/args.
vi.mock("node:child_process", () => ({
  execFile: (
    cmd: string,
    args: string[],
    _opts: unknown,
    cb: (err: Error | null, res?: { stdout: string; stderr: string }) => void,
  ) => {
    const result = h.execFileResponder(cmd, args);
    if (result instanceof Error) {
      cb(result);
    } else {
      cb(null, { stdout: result.stdout ?? "", stderr: result.stderr ?? "" });
    }
  },
}));

const mockConfig = h.mockConfig;
const mockGetSystemStats = h.mockGetSystemStats;
function setExecFileResponder(
  fn: (cmd: string, args: string[]) => ExecResult,
): void {
  h.execFileResponder = fn;
}

import {
  configureWorkspace,
  resetWorkspaceConfig,
  getWorkspace,
  setDefaultWorkspace,
  listWorkspaces,
  getEnvironment,
  liveRootFromArgv,
  resolveComfyuiPython,
} from "../../services/workspace-env.js";

async function tmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "comfyui-ws-"));
}

beforeEach(() => {
  mockConfig.comfyuiPath = undefined;
  mockConfig.resolvedPort = 8188;
  mockGetSystemStats.mockReset();
  setExecFileResponder(() => new Error("not configured"));
  resetWorkspaceConfig();
  delete process.env.COMFYUI_PATH;
});

afterEach(() => {
  resetWorkspaceConfig();
});

// ---------------------------------------------------------------------------
// set_default_workspace / get_workspace round-trip
// ---------------------------------------------------------------------------

describe("setDefaultWorkspace + getWorkspace round-trip", () => {
  it("persists the default workspace to the config file and reads it back", async () => {
    const dir = await tmpDir();
    const cfgPath = join(dir, "workspace.json");
    try {
      configureWorkspace({ configPath: cfgPath });

      const result = await setDefaultWorkspace("/some/ComfyUI");
      expect(result.saved).toBe(true);
      expect(result.default_workspace).toBe("/some/ComfyUI");
      expect(result.config_path).toBe(cfgPath);

      // File on disk has the value
      const raw = JSON.parse(await readFile(cfgPath, "utf-8"));
      expect(raw.defaultWorkspace).toBe("/some/ComfyUI");

      // get_workspace reads it back; no comfyuiPath so source is default-config
      const ws = await getWorkspace();
      expect(ws.default_workspace).toBe("/some/ComfyUI");
      expect(ws.workspace_path).toBe("/some/ComfyUI");
      expect(ws.workspace_source).toBe("default-config");
      expect(ws.api_target).toBe("http://127.0.0.1:8188");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("creates the parent directory when persisting to a missing path", async () => {
    const dir = await tmpDir();
    const cfgPath = join(dir, "nested", "deep", "workspace.json");
    try {
      configureWorkspace({ configPath: cfgPath });
      await setDefaultWorkspace("/x/ComfyUI");
      const raw = JSON.parse(await readFile(cfgPath, "utf-8"));
      expect(raw.defaultWorkspace).toBe("/x/ComfyUI");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("trims whitespace and rejects empty paths", async () => {
    const dir = await tmpDir();
    const cfgPath = join(dir, "workspace.json");
    try {
      configureWorkspace({ configPath: cfgPath });
      const r = await setDefaultWorkspace("  /trim/me  ");
      expect(r.default_workspace).toBe("/trim/me");
      await expect(setDefaultWorkspace("   ")).rejects.toThrow(/non-empty/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports source 'env' when COMFYUI_PATH is set and 'auto-detected' otherwise", async () => {
    const dir = await tmpDir();
    const cfgPath = join(dir, "workspace.json");
    try {
      configureWorkspace({ configPath: cfgPath });
      mockConfig.comfyuiPath = "/active/ComfyUI";

      // auto-detected (no env var)
      let ws = await getWorkspace();
      expect(ws.workspace_path).toBe("/active/ComfyUI");
      expect(ws.workspace_source).toBe("auto-detected");

      // env-driven
      process.env.COMFYUI_PATH = "/active/ComfyUI";
      ws = await getWorkspace();
      expect(ws.workspace_source).toBe("env");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports source 'none' when nothing is configured", async () => {
    const dir = await tmpDir();
    try {
      configureWorkspace({ configPath: join(dir, "missing.json") });
      const ws = await getWorkspace();
      expect(ws.workspace_path).toBeUndefined();
      expect(ws.workspace_source).toBe("none");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("ignores a malformed config file and treats it as empty", async () => {
    const dir = await tmpDir();
    const cfgPath = join(dir, "workspace.json");
    try {
      await writeFile(cfgPath, "{ not json", "utf-8");
      configureWorkspace({ configPath: cfgPath });
      const ws = await getWorkspace();
      expect(ws.default_workspace).toBeUndefined();
      expect(ws.workspace_source).toBe("none");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("ignores a non-string defaultWorkspace (shape validation)", async () => {
    const dir = await tmpDir();
    const cfgPath = join(dir, "workspace.json");
    try {
      await writeFile(cfgPath, JSON.stringify({ defaultWorkspace: 123 }), "utf-8");
      configureWorkspace({ configPath: cfgPath });
      const ws = await getWorkspace();
      expect(ws.default_workspace).toBeUndefined();
      expect(ws.workspace_source).toBe("none");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// list_workspaces
// ---------------------------------------------------------------------------

describe("listWorkspaces", () => {
  it("includes the active path and saved default and marks them", async () => {
    const dir = await tmpDir();
    const cfgPath = join(dir, "workspace.json");
    // Build a real valid-looking install so looks_valid is true for the active.
    const activeInstall = join(dir, "ActiveComfyUI");
    await mkdir(join(activeInstall, "models"), { recursive: true });
    try {
      configureWorkspace({ configPath: cfgPath });
      mockConfig.comfyuiPath = activeInstall;
      await setDefaultWorkspace("/saved/default/ComfyUI");

      const list = await listWorkspaces();
      expect(list.active_workspace).toBe(activeInstall);
      expect(list.default_workspace).toBe("/saved/default/ComfyUI");

      const active = list.workspaces.find((w) => w.path === activeInstall);
      expect(active?.active).toBe(true);
      expect(active?.looks_valid).toBe(true);

      const def = list.workspaces.find(
        (w) => w.path === "/saved/default/ComfyUI",
      );
      expect(def?.is_default).toBe(true);
      // Nonexistent path → not valid
      expect(def?.looks_valid).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// get_environment
// ---------------------------------------------------------------------------

describe("getEnvironment", () => {
  it("reports running instance from system_stats and degrades local probes when no path", async () => {
    const dir = await tmpDir();
    try {
      configureWorkspace({ configPath: join(dir, "workspace.json") });
      mockConfig.comfyuiPath = undefined;
      mockGetSystemStats.mockResolvedValueOnce({
        system: {
          os: "posix",
          python_version: "3.12.1",
          embedded_python: false,
          comfyui_version: "0.3.10",
        },
        devices: [
          {
            name: "NVIDIA RTX 4090",
            type: "cuda",
            index: 0,
            vram_total: 24 * 1024 * 1024 * 1024,
            vram_free: 20 * 1024 * 1024 * 1024,
            torch_vram_total: 0,
            torch_vram_free: 0,
          },
        ],
      });

      const env = await getEnvironment();
      expect(env.running_instance.reachable).toBe(true);
      expect(env.running_instance.os).toBe("posix");
      expect(env.running_instance.comfyui_version).toBe("0.3.10");
      expect(env.running_instance.devices?.[0]).toMatchObject({
        name: "NVIDIA RTX 4090",
        type: "cuda",
        vram_total_mb: 24 * 1024,
      });

      // No local path → probes skipped, note present, no python/git
      expect(env.local.workspace_path).toBeUndefined();
      expect(env.local.python).toBeUndefined();
      expect(env.local.git).toBeUndefined();
      expect(env.local.note).toMatch(/No local ComfyUI path/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("falls back to the saved default workspace for local probes when COMFYUI_PATH is unset", async () => {
    const dir = await tmpDir();
    const cfgPath = join(dir, "workspace.json");
    const install = join(dir, "DefaultComfyUI");
    await mkdir(install, { recursive: true });
    try {
      configureWorkspace({ configPath: cfgPath });
      mockConfig.comfyuiPath = undefined; // no active path
      await setDefaultWorkspace(install); // but a saved default
      mockGetSystemStats.mockRejectedValueOnce(new Error("offline"));
      setExecFileResponder((_cmd, args) => {
        if (args.includes("--version")) return { stdout: "Python 3.12.0\n" };
        return new Error("nope");
      });

      const env = await getEnvironment();
      // Local probes ran against the saved default rather than being skipped.
      expect(env.local.workspace_path).toBe(install);
      expect(env.local.python?.version).toBe("3.12.0");
      expect(env.local.note).toMatch(/saved default workspace/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("captures the unreachable error and still returns local probes when path set", async () => {
    const dir = await tmpDir();
    const install = join(dir, "ComfyUI");
    await mkdir(install, { recursive: true });
    try {
      configureWorkspace({ configPath: join(dir, "workspace.json") });
      mockConfig.comfyuiPath = install;
      mockGetSystemStats.mockRejectedValueOnce(new Error("ECONNREFUSED"));

      // python --version succeeds; pip show returns one package; git fails
      setExecFileResponder((cmd, args) => {
        if (args.includes("--version")) {
          return { stdout: "Python 3.11.5\n" };
        }
        if (args.includes("pip")) {
          return {
            stdout:
              "Name: torch\nVersion: 2.3.1\n---\nName: numpy\nVersion: 1.26.4\n",
          };
        }
        // git rev-parse — no .git dir so probeGitRev returns early anyway,
        // but guard with an error to be safe.
        return new Error("not a git repo");
      });

      const env = await getEnvironment();
      expect(env.running_instance.reachable).toBe(false);
      expect(env.running_instance.error).toMatch(/ECONNREFUSED/);

      expect(env.local.workspace_path).toBe(install);
      expect(env.local.python?.version).toBe("3.11.5");
      expect(env.local.packages?.torch).toBe("2.3.1");
      expect(env.local.packages?.numpy).toBe("1.26.4");
      // No .git directory created → git omitted
      expect(env.local.git).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("notes when python is unavailable in a configured workspace", async () => {
    const dir = await tmpDir();
    const install = join(dir, "ComfyUI");
    await mkdir(install, { recursive: true });
    try {
      configureWorkspace({ configPath: join(dir, "workspace.json") });
      mockConfig.comfyuiPath = install;
      mockGetSystemStats.mockRejectedValueOnce(new Error("offline"));
      // Every subprocess fails (no python on PATH)
      setExecFileResponder(() => new Error("command not found"));

      const env = await getEnvironment();
      expect(env.local.python).toBeUndefined();
      expect(env.local.note).toMatch(/Python interpreter not found/i);
      expect(env.local.packages).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reads ComfyUI-Manager version from pyproject.toml and git rev when present", async () => {
    const dir = await tmpDir();
    const install = join(dir, "ComfyUI");
    await mkdir(join(install, "custom_nodes", "ComfyUI-Manager"), {
      recursive: true,
    });
    await writeFile(
      join(install, "custom_nodes", "ComfyUI-Manager", "pyproject.toml"),
      '[project]\nname = "comfyui-manager"\nversion = "3.10.1"\n',
      "utf-8",
    );
    await mkdir(join(install, ".git"), { recursive: true });
    try {
      configureWorkspace({ configPath: join(dir, "workspace.json") });
      mockConfig.comfyuiPath = install;
      mockGetSystemStats.mockRejectedValueOnce(new Error("offline"));

      setExecFileResponder((cmd, args) => {
        if (cmd === "git" && args.includes("--short")) {
          return { stdout: "abc1234\n" };
        }
        if (cmd === "git" && args.includes("--abbrev-ref")) {
          return { stdout: "master\n" };
        }
        if (args.includes("--version")) return { stdout: "Python 3.12.0\n" };
        if (args.includes("pip")) return new Error("no pip");
        return new Error("unexpected");
      });

      const env = await getEnvironment();
      expect(env.local.comfyui_manager_version).toBe("3.10.1");
      expect(env.local.git).toEqual({ rev: "abc1234", branch: "master" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("omits packages (no false report) when the probed python disagrees with the running ComfyUI (#401)", async () => {
    const dir = await tmpDir();
    const install = join(dir, "ComfyUI");
    await mkdir(install, { recursive: true });
    try {
      configureWorkspace({ configPath: join(dir, "workspace.json") });
      mockConfig.comfyuiPath = install;
      // Running ComfyUI is on python 3.12.11 …
      mockGetSystemStats.mockResolvedValueOnce({
        system: { os: "nt", python_version: "3.12.11", comfyui_version: "0.27.1" },
        devices: [],
      });
      // … but the interpreter we can probe (bare PATH python) is 3.11.7 — a DIFFERENT
      // environment. torch etc. from it would be a false report, so degrade.
      setExecFileResponder((_cmd, args) => {
        if (args.includes("--version")) return { stdout: "Python 3.11.7\n" };
        if (args.includes("pip"))
          return { stdout: "Name: torch\nVersion: 9.9.9\n" }; // must NOT surface
        return new Error("nope");
      });

      const env = await getEnvironment();
      expect(env.local.python?.version).toBe("3.11.7");
      expect(env.local.python_probe_trusted).toBe(false);
      expect(env.local.packages).toBeUndefined();
      expect(env.local.note).toMatch(/does not match the running ComfyUI python/i);
      expect(env.local.note).toMatch(/#401/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports packages when the probed python matches the running ComfyUI major.minor", async () => {
    const dir = await tmpDir();
    const install = join(dir, "ComfyUI");
    await mkdir(install, { recursive: true });
    try {
      configureWorkspace({ configPath: join(dir, "workspace.json") });
      mockConfig.comfyuiPath = install;
      mockGetSystemStats.mockResolvedValueOnce({
        system: { os: "nt", python_version: "3.12.11", comfyui_version: "0.27.1" },
        devices: [],
      });
      // Same major.minor (3.12) as the running instance → trusted.
      setExecFileResponder((_cmd, args) => {
        if (args.includes("--version")) return { stdout: "Python 3.12.4\n" };
        if (args.includes("pip")) return { stdout: "Name: torch\nVersion: 2.5.0\n" };
        return new Error("nope");
      });

      const env = await getEnvironment();
      expect(env.local.python_probe_trusted).toBe(true);
      expect(env.local.packages?.torch).toBe("2.5.0");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("resolves the LIVE server's own interpreter over the pinned COMFYUI_PATH (#401 / #433 getEnvironment)", async () => {
    const dir = await tmpDir();
    const rootA = join(dir, "A"); // pinned COMFYUI_PATH
    const rootB = join(dir, "B"); // the LIVE running server (from argv main.py)
    await mkdir(rootA, { recursive: true });
    await mkdir(rootB, { recursive: true });
    const exeA = await makeVenvPython(rootA);
    const exeB = await makeVenvPython(rootB);
    void exeA;
    try {
      configureWorkspace({ configPath: join(dir, "workspace.json") });
      mockConfig.comfyuiPath = rootA;
      // Live server on 3.12, argv points at B/main.py; A and B share major.minor.
      mockGetSystemStats.mockResolvedValueOnce({
        system: {
          os: "nt",
          python_version: "3.12.11",
          comfyui_version: "0.27.1",
          argv: [join(rootB, "main.py"), "--port", "8188"],
        },
        devices: [],
      });
      // Differentiate the two interpreters BY EXECUTABLE PATH: only B has the package.
      setExecFileResponder((cmd, args) => {
        const isB = cmd.includes(`${rootB}`);
        if (args.includes("--version"))
          return { stdout: isB ? "Python 3.12.9\n" : "Python 3.12.1\n" };
        if (args.includes("pip"))
          return { stdout: isB ? "Name: torch\nVersion: 2.6.0\n" : "Name: torch\nVersion: 1.0.0\n" };
        return new Error("nope");
      });

      const env = await getEnvironment();
      // Probed B (the live interpreter), not the pinned A.
      expect(env.local.python?.executable).toBe(exeB);
      expect(env.local.python_probe_trusted).toBe(true);
      expect(env.local.packages?.torch).toBe("2.6.0"); // B's, not A's 1.0.0
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("omits packages when the LIVE root has no venv and only the pinned workspace does (#401 / #433)", async () => {
    const dir = await tmpDir();
    const rootA = join(dir, "A"); // pinned COMFYUI_PATH — the only venv on disk
    const rootB = join(dir, "B"); // live root, but NO interpreter under it
    await mkdir(rootB, { recursive: true });
    const exeA = await makeVenvPython(rootA);
    try {
      configureWorkspace({ configPath: join(dir, "workspace.json") });
      mockConfig.comfyuiPath = rootA;
      mockGetSystemStats.mockResolvedValueOnce({
        system: {
          os: "nt",
          python_version: "3.12.11",
          comfyui_version: "0.27.1",
          argv: [join(rootB, "main.py")],
        },
        devices: [],
      });
      setExecFileResponder((_cmd, args) => {
        if (args.includes("--version")) return { stdout: "Python 3.12.1\n" };
        if (args.includes("pip")) return { stdout: "Name: torch\nVersion: 1.0.0\n" };
        return new Error("nope");
      });

      const env = await getEnvironment();
      // We could only probe A, but A is provably NOT the live interpreter → untrusted.
      expect(env.local.python?.executable).toBe(exeA);
      expect(env.local.python_probe_trusted).toBe(false);
      expect(env.local.packages).toBeUndefined();
      expect(env.local.note).toMatch(/#401/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("liveRootFromArgv (#401 / #433 — robust argv parsing)", () => {
  it("returns the absolute dir of an absolute main.py", () => {
    const root = IS_WIN ? "C:\\Comfy\\ComfyUI" : "/opt/ComfyUI";
    const argv = [join(root, "main.py"), "--port", "8188"];
    expect(liveRootFromArgv(argv)).toBe(root);
  });

  it("strips surrounding quotes on the main.py path", () => {
    const root = IS_WIN ? "C:\\Comfy\\ComfyUI" : "/opt/ComfyUI";
    const argv = [`"${join(root, "main.py")}"`];
    expect(liveRootFromArgv(argv)).toBe(root);
  });

  it("resolves a RELATIVE main.py against the server cwd when available, else UNRESOLVED", () => {
    const cwd = IS_WIN ? "C:\\portable" : "/portable";
    const rel = IS_WIN ? "ComfyUI\\main.py" : "ComfyUI/main.py";
    expect(liveRootFromArgv([rel], cwd)).toBe(join(cwd, "ComfyUI"));
    // No cwd → cannot resolve to an absolute dir → UNRESOLVED (not a bogus rel root).
    expect(liveRootFromArgv([rel])).toBeUndefined();
  });

  it("treats a bare 'main.py' as cwd (when absolute) or UNRESOLVED", () => {
    const cwd = IS_WIN ? "C:\\here" : "/here";
    expect(liveRootFromArgv(["main.py"], cwd)).toBe(cwd);
    expect(liveRootFromArgv(["main.py"])).toBeUndefined();
  });

  it("ignores non-main.py args and returns undefined when there is no main.py", () => {
    expect(liveRootFromArgv(["python", "--port", "8188"])).toBeUndefined();
    // A boundary check: 'notmain.py' must NOT be treated as main.py.
    expect(liveRootFromArgv([IS_WIN ? "C:\\x\\notmain.py" : "/x/notmain.py"])).toBeUndefined();
  });

  it("returns undefined for missing/empty argv", () => {
    expect(liveRootFromArgv(undefined)).toBeUndefined();
    expect(liveRootFromArgv([])).toBeUndefined();
  });
});

describe("resolveComfyuiPython live-first (#401 / #433)", () => {
  it("prefers the live argv root over the pinned COMFYUI_PATH, both with venvs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "comfyui-resolve-"));
    try {
      const rootA = join(dir, "A");
      const rootB = join(dir, "B");
      await mkdir(rootA, { recursive: true });
      await mkdir(rootB, { recursive: true });
      await makeVenvPython(rootA);
      const exeB = await makeVenvPython(rootB);

      const res = resolveComfyuiPython(rootA, [join(rootB, "main.py")]);
      expect(res.python).toBe(exeB);
      expect(res.live).toBe(true);
      expect(res.liveRoot).toBe(rootB);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
