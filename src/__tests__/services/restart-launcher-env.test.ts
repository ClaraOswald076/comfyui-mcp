// Launcher environment preservation across restart_comfyui (#776).
//
// restart_comfyui rebuilt the launch COMMAND but not the launch ENVIRONMENT: the
// relaunch spawned with no `env`, so the child inherited the ORCHESTRATOR's
// process.env instead of the environment the launcher gave the server. On a
// Stability Matrix install that dropped its bundled PortableGit and FFmpeg from
// PATH — ComfyUI-Manager aborted at import with "Bad git executable", ComfyUI
// never answered /system_stats, and the restart left the server DOWN.
//
// The invariants under test:
//   1. the environment is PRESERVED across a restart (live-read, or reconstructed
//      from a detected Stability Matrix layout);
//   2. an environment we cannot reproduce REFUSES **before** anything is stopped;
//   3. a relaunch that does not come back reports the truth (stopped, not started)
//      instead of claiming a successful restart.
//
// Boundaries only are mocked: config, workspace-env, the python resolver,
// child_process, node:fs, the ComfyUI client and global fetch. No real
// process/port/network/filesystem is touched.

import { EventEmitter } from "node:events";
import { delimiter, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class FakeChild extends EventEmitter {
  unref = vi.fn();
}

const mockConfig = vi.hoisted(() => ({
  resolvedPort: 8188,
  comfyuiPath: undefined as string | undefined,
}));

const mockExecSync = vi.hoisted(() => vi.fn());
const mockSpawn = vi.hoisted(() => vi.fn());
const mockGetSystemStats = vi.hoisted(() => vi.fn());
const mockExistsSync = vi.hoisted(() => vi.fn((_p: string) => true));
const mockFindComfyuiPython = vi.hoisted(() => vi.fn());
const mockResolveBase = vi.hoisted(() => vi.fn<[], string | undefined>());
const mockLiveRootFromArgv = vi.hoisted(() =>
  vi.fn<[string[], string?], string | undefined>(),
);

vi.mock("../../config.js", () => ({
  config: mockConfig,
  getComfyUIBaseUrl: () => "http://127.0.0.1:8188",
  getComfyUIAuthHeaders: () => ({}),
  isRemoteMode: () => false,
}));

vi.mock("node:child_process", () => ({
  execSync: mockExecSync,
  spawn: mockSpawn,
}));

// node:fs is shared by process-control (script/interpreter validation) AND by
// launcher-env (the on-disk corroboration of a launcher layout), so one existsSync
// map drives both.
vi.mock("node:fs", () => ({
  existsSync: mockExistsSync,
  readlinkSync: vi.fn(() => {
    throw new Error("no /proc in test");
  }),
  readFileSync: vi.fn(() => {
    throw new Error("no /proc in test");
  }),
  statSync: vi.fn((p: string) => {
    if (!mockExistsSync(String(p))) throw new Error("ENOENT");
    return { isFile: () => true, isDirectory: () => false };
  }),
}));

vi.mock("../../comfyui/client.js", () => ({
  getSystemStats: mockGetSystemStats,
  resetClient: vi.fn(),
  resetObjectInfoCache: vi.fn(),
}));

vi.mock("../../utils/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../../services/env-capabilities.js", () => ({
  findComfyuiPython: mockFindComfyuiPython,
}));

vi.mock("../../services/workspace-env.js", () => ({
  resolveEffectiveComfyUIBase: mockResolveBase,
  liveRootFromArgv: mockLiveRootFromArgv,
  markLocalComfyUILaunched: vi.fn(),
  resetLocalComfyUILaunchState: vi.fn(),
}));

import {
  __processControlTestHooks,
  preflightLocalRestart,
  restartComfyUI,
  startComfyUI,
  stopComfyUI,
} from "../../services/process-control.js";

// ---------------------------------------------------------------------------
// Install layouts. HOST-NATIVE absolute paths so the separator-agnostic
// detection is exercised on whatever OS runs the suite.
// ---------------------------------------------------------------------------

// Stability Matrix: packages under <Data>/Packages/<pkg>, shared tooling beside it.
const SM_DATA = resolve("StabilityMatrixTest", "Data");
const SM_PKG = join(SM_DATA, "Packages", "ComfyUI");
const SM_MAIN = join(SM_PKG, "main.py");
const SM_PY = join(SM_PKG, "venv", "Scripts", "python.exe");
const SM_GIT_DIR = join(SM_DATA, "PortableGit", "cmd");
const SM_GIT_EXE = join(SM_GIT_DIR, "git.exe");
const SM_FFMPEG_DIR = join(SM_DATA, "Assets", "ffmpeg", "bin");
const SM_FFMPEG_EXE = join(SM_FFMPEG_DIR, "ffmpeg.exe");

// A plain install (no launcher marker anywhere in its paths).
const PLAIN_BASE = resolve("PlainComfyTest", "ComfyUI");
const PLAIN_MAIN = join(PLAIN_BASE, "main.py");
const PLAIN_PY = join(PLAIN_BASE, "venv", "bin", "python");

// Pinokio: an app tree under a `pinokio` root.
const PINOKIO_APP = resolve("pinokio", "api", "comfy.git", "app");
const PINOKIO_MAIN = join(PINOKIO_APP, "main.py");
const PINOKIO_PY = join(PINOKIO_APP, "env", "bin", "python");

const ORIGINAL_ENV = { ...process.env };

/** Case-insensitive env lookup (Windows env blocks are case-insensitive). */
function envGet(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [k, v] of Object.entries(env)) {
    if (k.toLowerCase() === wanted) return v;
  }
  return undefined;
}

/** execSync that reports a live PID on the port until a kill, then port free. */
function mockLivePortThenFree(): { killed: () => boolean } {
  let killed = false;
  mockExecSync.mockImplementation((cmd: string) => {
    if (/taskkill|pkill|\bkill\b/i.test(cmd)) {
      killed = true;
      return "";
    }
    if (/netstat/i.test(cmd)) {
      return killed
        ? ""
        : "  TCP    0.0.0.0:8188   0.0.0.0:0   LISTENING       4321";
    }
    if (/lsof/i.test(cmd)) {
      if (killed) throw new Error("not listening");
      return "p4321\nn127.0.0.1:8188\n";
    }
    return "";
  });
  return { killed: () => killed };
}

function spawnCapturingChildren(): FakeChild[] {
  const children: FakeChild[] = [];
  mockSpawn.mockImplementation(() => {
    const child = new FakeChild();
    children.push(child);
    return child;
  });
  return children;
}

function spawnOptions(): { cwd?: string; env?: NodeJS.ProcessEnv } {
  return mockSpawn.mock.calls[0][2] as { cwd?: string; env?: NodeJS.ProcessEnv };
}

beforeEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  process.env = { ...ORIGINAL_ENV };
  process.env.COMFYUI_STARTUP_CHECK_INTERVAL_S = "0.01";
  process.env.COMFYUI_STARTUP_CHECK_MAX_TRIES = "1";
  process.env.PATH = ORIGINAL_ENV.PATH ?? "/usr/bin";
  mockConfig.resolvedPort = 8188;
  mockConfig.comfyuiPath = undefined;
  mockResolveBase.mockReturnValue(undefined);
  mockLiveRootFromArgv.mockReturnValue(undefined);
  __processControlTestHooks.reset();
  // No live-process environment is readable by default (the Windows/macOS case,
  // and the #776 reporter's platform). Individual tests opt in.
  __processControlTestHooks.setLiveEnvResolver(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  process.env = { ...ORIGINAL_ENV };
  __processControlTestHooks.reset();
});

// ---------------------------------------------------------------------------

describe("restart_comfyui — Stability Matrix launcher environment (#776)", () => {
  function useStabilityMatrix(opts?: { assets?: boolean }): void {
    const assets = opts?.assets ?? true;
    mockFindComfyuiPython.mockReturnValue(SM_PY);
    mockLiveRootFromArgv.mockReturnValue(SM_PKG);
    mockGetSystemStats.mockResolvedValue({
      system: {
        argv: [SM_MAIN, "--preview-method", "auto", "--enable-manager"],
      },
    });
    mockExistsSync.mockImplementation((p: string) => {
      const s = String(p);
      if (s === SM_MAIN || s === SM_PY) return true;
      if (!assets) return false;
      return s === SM_GIT_EXE || s === SM_FFMPEG_EXE;
    });
  }

  it("restores PortableGit + FFmpeg on PATH (and GIT_PYTHON_GIT_EXECUTABLE) for the relaunch", async () => {
    useStabilityMatrix();
    mockLivePortThenFree();
    spawnCapturingChildren();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true }) as Response),
    );
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await restartComfyUI();

    expect(result.stopped).toBe(true);
    expect(result.started).toBe(true);
    expect(result.ready).toBe(true);

    // The relaunch DID carry an explicit environment (the bug was `env` omitted,
    // silently inheriting the orchestrator's).
    const opts = spawnOptions();
    expect(opts.env).toBeDefined();
    const path = envGet(opts.env!, "PATH") ?? "";
    const entries = path.split(delimiter);
    // Both launcher directories are PREPENDED, ahead of whatever we inherited —
    // the launcher's own copies must win.
    expect(entries[0]).toBe(SM_GIT_DIR);
    expect(entries[1]).toBe(SM_FFMPEG_DIR);
    expect(envGet(opts.env!, "GIT_PYTHON_GIT_EXECUTABLE")).toBe(SM_GIT_EXE);

    // ...and the result SAYS the launcher shape was detected and restored.
    expect(result.launch_env?.source).toBe("stability-matrix");
    expect(result.launch_env?.launcher).toBe("Stability Matrix");
    expect(result.launch_env?.path_additions).toEqual([
      SM_GIT_DIR,
      SM_FFMPEG_DIR,
    ]);
    expect(result.message).toMatch(/Stability Matrix/i);

    killSpy.mockRestore();
  });

  it("REFUSES before stopping when the launcher's tooling cannot be found on disk", async () => {
    // The install is provably launcher-owned, but its Git/FFmpeg assets are gone,
    // so its environment cannot be reproduced. Guessing (= inheriting ours) is
    // exactly what took the server down in #776.
    useStabilityMatrix({ assets: false });
    mockLivePortThenFree();
    spawnCapturingChildren();
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await restartComfyUI();

    expect(result.stopped).toBe(false);
    expect(result.started).toBe(false);
    expect(result.message).toMatch(/refusing to restart/i);
    expect(result.message).toMatch(/Stability Matrix/i);
    // Told to use the owning launcher — not the generic COMFYUI_PATH advice.
    expect(result.message).toMatch(/Restart ComfyUI from Stability Matrix/i);
    // NOTHING was stopped and nothing was spawned.
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(killSpy).not.toHaveBeenCalled();
    expect(
      mockExecSync.mock.calls.some(([cmd]) => /taskkill/i.test(String(cmd))),
    ).toBe(false);

    killSpy.mockRestore();
  });
});

describe("restart_comfyui — irreproducible launcher environments (#776)", () => {
  function usePinokio(): void {
    mockFindComfyuiPython.mockReturnValue(PINOKIO_PY);
    mockLiveRootFromArgv.mockReturnValue(PINOKIO_APP);
    mockGetSystemStats.mockResolvedValue({
      system: { argv: [PINOKIO_MAIN, "--port", "8188"] },
    });
    mockExistsSync.mockImplementation((p: string) => {
      const s = String(p);
      return s === PINOKIO_MAIN || s === PINOKIO_PY;
    });
  }

  it("REFUSES a Pinokio-launched server BEFORE stopping it", async () => {
    usePinokio();
    mockLivePortThenFree();
    spawnCapturingChildren();
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await restartComfyUI();

    expect(result.stopped).toBe(false);
    expect(result.started).toBe(false);
    expect(result.message).toMatch(/refusing to restart/i);
    expect(result.message).toMatch(/Pinokio/);
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(killSpy).not.toHaveBeenCalled();

    killSpy.mockRestore();
  });

  it("still allows the OUT-OF-BAND Manager reboot preflight (that restart preserves the environment itself)", async () => {
    // A Manager reboot re-execs the SAME process, which keeps its own launcher
    // environment — so the environment rule must NOT leak into this preflight.
    usePinokio();
    mockLivePortThenFree();

    await expect(preflightLocalRestart()).resolves.toEqual({ ok: true });
  });

  it("does NOT refuse from start_comfyui when the server is ALREADY down — it launches and warns", async () => {
    // The refusal exists to protect a RUNNING server. Once ComfyUI is already
    // stopped, refusing would leave it down forever — the one outcome worse than a
    // possibly-degraded launch. So start_comfyui launches and says so plainly.
    usePinokio();
    mockLivePortThenFree();
    spawnCapturingChildren();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true }) as Response),
    );
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const stopped = await stopComfyUI();
    expect(stopped.stopped).toBe(true);

    const started = await startComfyUI();

    expect(started.started).toBe(true);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    // Best available environment = ours (never a fabricated launcher one).
    expect(spawnOptions().env).toBeUndefined();
    expect(started.launch_env?.reproducible).toBe(false);
    expect(started.launch_env?.launcher).toBe("Pinokio");
    expect(started.message).toMatch(/WARNING/);
    expect(started.message).toMatch(/Pinokio/);

    killSpy.mockRestore();
  });

  it("relaunches a Pinokio server when its LIVE environment could be read", async () => {
    // Same install, but this time we captured the real environment off the live
    // process — there is nothing left to guess, so the restart proceeds.
    usePinokio();
    const LIVE_ENV = {
      PATH: `/pinokio/bin/git:/usr/bin`,
      GIT_PYTHON_GIT_EXECUTABLE: "/pinokio/bin/git/git",
      PINOKIO_APP_NAME: "comfy",
    };
    __processControlTestHooks.setLiveEnvResolver(() => ({ ...LIVE_ENV }));
    mockLivePortThenFree();
    spawnCapturingChildren();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true }) as Response),
    );
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await restartComfyUI();

    expect(result.stopped).toBe(true);
    expect(result.started).toBe(true);
    // Spawned with the LIVE environment verbatim — not the orchestrator's.
    expect(spawnOptions().env).toEqual(LIVE_ENV);
    expect(result.launch_env?.source).toBe("live-process");

    killSpy.mockRestore();
  });
});

describe("restart_comfyui — plain installs are unchanged (#776)", () => {
  function usePlainInstall(): void {
    mockFindComfyuiPython.mockReturnValue(PLAIN_PY);
    mockLiveRootFromArgv.mockReturnValue(PLAIN_BASE);
    mockGetSystemStats.mockResolvedValue({
      system: { argv: [PLAIN_MAIN, "--port", "8188"] },
    });
    mockExistsSync.mockImplementation((p: string) => {
      const s = String(p);
      return s === PLAIN_MAIN || s === PLAIN_PY;
    });
  }

  it("inherits this process's environment (no `env` override) and still restarts", async () => {
    usePlainInstall();
    mockLivePortThenFree();
    spawnCapturingChildren();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true }) as Response),
    );
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await restartComfyUI();

    expect(result.stopped).toBe(true);
    expect(result.started).toBe(true);
    // No env override: `spawn` inherits process.env, exactly as before #776.
    expect(spawnOptions().env).toBeUndefined();
    expect(result.launch_env?.source).toBe("inherited");

    killSpy.mockRestore();
  });

  it("reports the TRUTH when the relaunch never comes back (stopped, not started)", async () => {
    usePlainInstall();
    mockLivePortThenFree();
    spawnCapturingChildren();
    // The process is spawned but the API never answers — the server is DOWN.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await restartComfyUI();

    expect(result.stopped).toBe(true);
    expect(result.started).toBe(false);
    expect(result.ready).toBe(false);
    expect(result.message).toMatch(/stopped but could not be started/i);
    expect(result.message).not.toMatch(/restarted successfully/i);
    // The environment it was launched into is named, so the failure is debuggable.
    expect(result.launch_env?.source).toBe("inherited");

    killSpy.mockRestore();
  });
});
