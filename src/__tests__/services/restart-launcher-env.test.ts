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
  /** Set per-test when the listener-ownership check matters. */
  pid: number | undefined = undefined;
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
/** Contents served for `<Data>/settings.json`, or undefined for "no such file". */
const mockSettingsJsonRef = vi.hoisted(() => ({ value: undefined as string | undefined }));

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
  // Serves the launcher's own config file (launcherConfigMentions); everything
  // else — /proc reads — is absent, as on the reporter's platform.
  readFileSync: vi.fn((p: string) => {
    const s = String(p);
    if (mockSettingsJsonRef.value !== undefined && /settings\.jsonc?$/i.test(s)) {
      return mockSettingsJsonRef.value;
    }
    throw new Error("ENOENT");
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

import { detectStabilityMatrix } from "../../services/launcher-env.js";
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
const SM_GIT_ROOT = join(SM_DATA, "PortableGit");
const SM_GIT_DIR = join(SM_GIT_ROOT, "cmd");
const SM_GIT_EXE = join(SM_GIT_DIR, "git.exe");
const SM_FFMPEG_ROOT = join(SM_DATA, "Assets", "ffmpeg");
const SM_FFMPEG_DIR = join(SM_FFMPEG_ROOT, "bin");
const SM_FFMPEG_EXE = join(SM_FFMPEG_DIR, "ffmpeg.exe");

// A plain install (no launcher marker anywhere in its paths).
const PLAIN_BASE = resolve("PlainComfyTest", "ComfyUI");
const PLAIN_MAIN = join(PLAIN_BASE, "main.py");
const PLAIN_PY = join(PLAIN_BASE, "venv", "bin", "python");

// Pinokio: an app tree under a `pinokio` root.
const PINOKIO_HOME = resolve("pinokio");
const PINOKIO_API = join(PINOKIO_HOME, "api");
const PINOKIO_BIN = join(PINOKIO_HOME, "bin");
const PINOKIO_APP = join(PINOKIO_API, "comfy.git", "app");
const PINOKIO_MAIN = join(PINOKIO_APP, "main.py");
const PINOKIO_PY = join(PINOKIO_APP, "env", "bin", "python");

// An ordinary install that merely SITS under a `pinokio` tree (not inside its
// `api/` app subtree) — this must never be mistaken for a Pinokio-managed server.
const BENIGN_PINOKIO_PATH = join(PINOKIO_BIN, "comfy", "main.py");
const BENIGN_PINOKIO_PY = join(PINOKIO_BIN, "comfy", "venv", "bin", "python");

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

function spawnCapturingChildren(pid?: number): FakeChild[] {
  const children: FakeChild[] = [];
  mockSpawn.mockImplementation(() => {
    const child = new FakeChild();
    child.pid = pid;
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
  // Likewise no creation-time stamp by default — the shape on the platforms where
  // the native read is deliberately skipped. Tests that exercise PID identity
  // install their own resolver.
  __processControlTestHooks.setProcessIdentityResolver(() => undefined);
  // Default lineage: the process on the port IS our child. Ownership tests
  // override this; every other test just needs the common case not to lie.
  __processControlTestHooks.setParentPidResolver(() => process.pid);
  mockSettingsJsonRef.value = undefined;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  process.env = { ...ORIGINAL_ENV };
  __processControlTestHooks.reset();
});

// ---------------------------------------------------------------------------

describe("restart_comfyui — Stability Matrix launcher environment (#776)", () => {
  /**
   * @param git    the bundled git binary is resolvable
   * @param ffmpeg the bundled ffmpeg binary is resolvable
   * @param roots  which tooling ROOT directories exist (the detection evidence)
   */
  function useStabilityMatrix(opts?: {
    git?: boolean;
    ffmpeg?: boolean;
    roots?: string[];
    /** Contents of `<Data>/settings.json`, when the test wants one to exist. */
    settingsJson?: string;
  }): void {
    const git = opts?.git ?? true;
    const ffmpeg = opts?.ffmpeg ?? true;
    const roots = opts?.roots ?? [SM_GIT_ROOT, SM_FFMPEG_ROOT];
    mockSettingsJsonRef.value = opts?.settingsJson;
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
      if (roots.includes(s)) return true;
      if (git && s === SM_GIT_EXE) return true;
      if (ffmpeg && s === SM_FFMPEG_EXE) return true;
      return false;
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

  async function expectRefusedBeforeStopping(): Promise<string> {
    mockLivePortThenFree();
    spawnCapturingChildren();
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await restartComfyUI();

    expect(result.stopped).toBe(false);
    expect(result.started).toBe(false);
    expect(result.message).toMatch(/refusing to restart/i);
    // NOTHING was stopped and nothing was spawned.
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(killSpy).not.toHaveBeenCalled();
    expect(
      mockExecSync.mock.calls.some(([cmd]) => /taskkill/i.test(String(cmd))),
    ).toBe(false);

    killSpy.mockRestore();
    return result.message;
  }

  it("REFUSES before stopping when NONE of the launcher's tooling resolves", async () => {
    // Provably launcher-owned (both tooling roots are there) but neither binary
    // resolves — the environment cannot be reproduced. Guessing (= inheriting
    // ours) is exactly what took the server down in #776.
    useStabilityMatrix({ git: false, ffmpeg: false });

    const message = await expectRefusedBeforeStopping();

    expect(message).toMatch(/Stability Matrix/i);
    // Told to use the owning launcher — not the generic COMFYUI_PATH advice.
    expect(message).toMatch(/Restart ComfyUI from Stability Matrix/i);
  });

  it("REFUSES before stopping on a PARTIAL layout — FFmpeg present but the bundled Git missing", async () => {
    // A half-rebuilt environment is not a rebuilt environment: relaunching with
    // ffmpeg but no git reproduces the exact #776 failure (Manager aborts at
    // import with "Bad git executable" and the server never comes back).
    useStabilityMatrix({ git: false, ffmpeg: true });

    const message = await expectRefusedBeforeStopping();

    expect(message).toMatch(/bundled Git/i);
    expect(message).toMatch(/Bad git executable/i);
  });

  it("REFUSES before stopping when the FFmpeg asset dir exists but holds no ffmpeg binary", async () => {
    useStabilityMatrix({ git: true, ffmpeg: false });

    const message = await expectRefusedBeforeStopping();

    expect(message).toMatch(/bundled FFmpeg/i);
    expect(message).toMatch(/Assets/);
  });

  it("RESTARTS with Git alone when FFmpeg is provably NOT INSTALLED, and names what was not injected", async () => {
    // A legitimate SM install with PortableGit and no FFmpeg asset at all. There is
    // nothing for the launcher to inject either, so relaunching without it is
    // exactly what the launcher itself would do — refusing here would make such an
    // install PERMANENTLY unrestartable, which is not a safer resting place than a
    // launch that works.
    useStabilityMatrix({ git: true, ffmpeg: false, roots: [SM_GIT_ROOT] });
    mockLivePortThenFree();
    spawnCapturingChildren();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true }) as Response),
    );
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await restartComfyUI();

    expect(result.message).not.toMatch(/refusing to restart/i);
    expect(result.started).toBe(true);
    expect(result.launch_env?.source).toBe("stability-matrix");
    // Git IS injected; FFmpeg is reported as absent rather than silently ignored.
    const opts = spawnOptions();
    expect(envGet(opts.env!, "PATH")!.split(delimiter)[0]).toBe(SM_GIT_DIR);
    expect(envGet(opts.env!, "GIT_PYTHON_GIT_EXECUTABLE")).toBe(SM_GIT_EXE);
    expect(result.launch_env?.path_additions).toEqual([SM_GIT_DIR]);
    expect(result.launch_env?.not_installed).toEqual(["FFmpeg"]);
    expect(result.message).toMatch(/no bundled FFmpeg anywhere under its Data folder/i);

    killSpy.mockRestore();
  });

  it("REFUSES when the launcher's own config names a component whose directory is missing", async () => {
    // "Absent" only means not-installed when NOTHING references it. Stability
    // Matrix records what it manages in Data/settings.json, so a mention there
    // turns absence into "expected but unlocatable" — the genuinely ambiguous case
    // that must refuse rather than silently drop what the launcher injects.
    useStabilityMatrix({
      git: true,
      ffmpeg: false,
      roots: [SM_GIT_ROOT],
      settingsJson: '{"assets":["ffmpeg","python310"]}',
    });

    const message = await expectRefusedBeforeStopping();

    expect(message).toMatch(/bundled FFmpeg/i);
    expect(message).toMatch(/Restart ComfyUI from Stability Matrix/i);
  });

  it("does NOT mistake an ordinary install that merely lives under a `Data/Packages` path for Stability Matrix", async () => {
    // Name-only evidence must never trigger a refusal: no PortableGit/Assets
    // beside `Packages` means there is no launcher tooling to reconstruct, and
    // this install restarted fine before #776.
    useStabilityMatrix({ git: false, ffmpeg: false, roots: [] });
    mockLivePortThenFree();
    spawnCapturingChildren();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true }) as Response),
    );
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await restartComfyUI();

    expect(result.message).not.toMatch(/refusing to restart/i);
    expect(result.started).toBe(true);
    expect(result.launch_env?.source).toBe("inherited");
    expect(result.launch_env?.reproducible).toBe(true);
    expect(spawnOptions().env).toBeUndefined();

    killSpy.mockRestore();
  });
});

describe("launcher layout detection — path-root handling (#776)", () => {
  // The paths come from the running ComfyUI's sys.argv, which is WINDOWS-flavored
  // whenever ComfyUI runs on Windows regardless of this host. These are pure
  // string+existsSync tests, so they pin the parsing on every OS.
  function pinTooling(dataRoot: string, sep: string): string {
    const gitRoot = `${dataRoot}${sep}PortableGit`;
    const gitExe = `${gitRoot}${sep}cmd${sep}git.exe`;
    mockExistsSync.mockImplementation((p: string) => {
      const s = String(p);
      return s === gitRoot || s === gitExe;
    });
    return gitExe;
  }

  it("keeps a UNC root intact (both leading backslashes)", () => {
    const DATA = "\\\\server\\share\\SM\\Data";
    const gitExe = pinTooling(DATA, "\\");

    const sm = detectStabilityMatrix([`${DATA}\\Packages\\ComfyUI\\main.py`]);

    expect(sm?.dataRoot).toBe(DATA);
    expect(sm?.gitExe).toBe(gitExe);
  });

  it("keeps an extended-length (\\\\?\\) root intact", () => {
    const DATA = "\\\\?\\C:\\SM\\Data";
    const gitExe = pinTooling(DATA, "\\");

    const sm = detectStabilityMatrix([`${DATA}\\Packages\\ComfyUI\\main.py`]);

    expect(sm?.dataRoot).toBe(DATA);
    expect(sm?.gitExe).toBe(gitExe);
  });

  it("keeps a drive-letter root intact", () => {
    const DATA = "C:\\Stability Matrix\\Data";
    const gitExe = pinTooling(DATA, "\\");

    const sm = detectStabilityMatrix([`${DATA}\\Packages\\ComfyUI\\main.py`]);

    expect(sm?.dataRoot).toBe(DATA);
    expect(sm?.gitExe).toBe(gitExe);
  });

  it("keeps a POSIX absolute root intact", () => {
    const DATA = "/home/u/StabilityMatrix/Data";
    const gitExe = `${DATA}/PortableGit/cmd/git`;
    mockExistsSync.mockImplementation((p: string) => {
      const s = String(p);
      return s === `${DATA}/PortableGit` || s === gitExe;
    });

    const sm = detectStabilityMatrix([`${DATA}/Packages/ComfyUI/main.py`]);

    expect(sm?.dataRoot).toBe(DATA);
    expect(sm?.gitExe).toBe(gitExe);
  });
});

describe("restart_comfyui — irreproducible launcher environments (#776)", () => {
  function usePinokio(opts?: { corroborated?: boolean }): void {
    const corroborated = opts?.corroborated ?? true;
    mockFindComfyuiPython.mockReturnValue(PINOKIO_PY);
    mockLiveRootFromArgv.mockReturnValue(PINOKIO_APP);
    mockGetSystemStats.mockResolvedValue({
      system: { argv: [PINOKIO_MAIN, "--port", "8188"] },
    });
    mockExistsSync.mockImplementation((p: string) => {
      const s = String(p);
      if (s === PINOKIO_MAIN || s === PINOKIO_PY) return true;
      // BOTH `api/` and `bin/` are the on-disk evidence of a real Pinokio home.
      return corroborated && (s === PINOKIO_API || s === PINOKIO_BIN);
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

  it("does NOT refuse an ordinary install that merely SITS under a `pinokio` tree", async () => {
    // The inverse regression: a real Pinokio home (both `api/` and `bin/` present)
    // but an install living under `pinokio/bin/...`, NOT inside the `api/` app
    // subtree Pinokio manages. A path-component name is not evidence, and a false
    // refusal blocks a restart that would have worked.
    mockFindComfyuiPython.mockReturnValue(BENIGN_PINOKIO_PY);
    mockLiveRootFromArgv.mockReturnValue(join(PINOKIO_BIN, "comfy"));
    mockGetSystemStats.mockResolvedValue({
      system: { argv: [BENIGN_PINOKIO_PATH, "--port", "8188"] },
    });
    mockExistsSync.mockImplementation((p: string) => {
      const s = String(p);
      return (
        s === BENIGN_PINOKIO_PATH ||
        s === BENIGN_PINOKIO_PY ||
        s === PINOKIO_API ||
        s === PINOKIO_BIN
      );
    });
    mockLivePortThenFree();
    spawnCapturingChildren();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true }) as Response),
    );
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await restartComfyUI();

    expect(result.message).not.toMatch(/refusing to restart/i);
    expect(result.message).not.toMatch(/Pinokio/);
    expect(result.started).toBe(true);
    expect(result.launch_env?.source).toBe("inherited");
    expect(result.launch_env?.reproducible).toBe(true);

    killSpy.mockRestore();
  });

  it("does NOT treat a directory merely NAMED `pinokio` as a Pinokio install", async () => {
    // Name-only evidence must never refuse a restart that works today.
    usePinokio({ corroborated: false });
    mockLivePortThenFree();
    spawnCapturingChildren();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true }) as Response),
    );
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await restartComfyUI();

    expect(result.message).not.toMatch(/refusing to restart/i);
    expect(result.started).toBe(true);
    expect(result.launch_env?.source).toBe("inherited");
    expect(result.launch_env?.reproducible).toBe(true);

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
    // A STABLE identity that also CORROBORATES the server's own argv — the capture
    // is only adopted when the pid provably still denotes that same ComfyUI.
    __processControlTestHooks.setProcessIdentityResolver(() => ({
      startedAt: "t1",
      commandLine: `${PINOKIO_PY} ${PINOKIO_MAIN} --port 8188`,
    }));
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

describe("restart_comfyui — a PID is not a process identity (#776)", () => {
  const PINOKIO_ARGV = [PINOKIO_MAIN, "--port", "8188"];
  const PLAIN_ARGV = [PLAIN_MAIN, "--port", "8188"];

  function usePinokioInstall(): void {
    mockFindComfyuiPython.mockReturnValue(PINOKIO_PY);
    mockLiveRootFromArgv.mockReturnValue(PINOKIO_APP);
    mockGetSystemStats.mockResolvedValue({
      system: { argv: PINOKIO_ARGV },
    });
    mockExistsSync.mockImplementation((p: string) => {
      const s = String(p);
      return (
        s === PINOKIO_MAIN ||
        s === PINOKIO_PY ||
        s === PINOKIO_API ||
        s === PINOKIO_BIN
      );
    });
  }

  /**
   * An identity reader returning the given (creation-time, command-line) pairs in
   * call order. A plain string is shorthand for "this stamp, still running the
   * ComfyUI we identified".
   */
  function identitySequence(
    steps: Array<string | { startedAt: string; commandLine: string }>,
    matchingArgv: string[],
  ): void {
    let i = 0;
    __processControlTestHooks.setProcessIdentityResolver(() => {
      const step = steps[Math.min(i, steps.length - 1)];
      i++;
      return typeof step === "string"
        ? { startedAt: step, commandLine: matchingArgv.join(" ") }
        : step;
    });
  }

  it("does NOT adopt the environment of a PID that was recycled during the read", async () => {
    // ComfyUI exits after the port lookup and the OS hands its number to an
    // unrelated process, whose /proc/<pid>/environ we would otherwise adopt as
    // ComfyUI's launch environment. Proof that it is rejected: this Pinokio
    // install is only restartable BECAUSE of a live environment, so discarding
    // the bogus capture must drop it back to the irreproducible-launcher refusal.
    usePinokioInstall();
    __processControlTestHooks.setLiveEnvResolver(() => ({
      PATH: "/some/unrelated/process/path",
      NOT_COMFYUI: "1",
    }));
    // lookup, then the re-verify after the env read sees a different process.
    identitySequence(["t1", "t2"], PINOKIO_ARGV);
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

  it("REFUSES outright when the OS says the port owner is running something other than the server that answered", async () => {
    // The gap a creation-time stamp alone cannot close: if the pid was recycled
    // BEFORE we ever read its stamp, every later re-read agrees with itself about
    // the WRONG process. The independent signal is the server's own /system_stats
    // argv — an unrelated program on that number cannot match it. That is POSITIVE
    // counter-evidence, so it must refuse on its own rather than merely decline to
    // bind (which would leave a later transport hiccup free to wave it through).
    usePinokioInstall();
    __processControlTestHooks.setLiveEnvResolver(() => ({ NOT_COMFYUI: "1" }));
    __processControlTestHooks.setProcessIdentityResolver(() => ({
      startedAt: "t9",
      commandLine: "/usr/bin/some-unrelated-daemon --serve",
    }));
    mockLivePortThenFree();
    spawnCapturingChildren();
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await restartComfyUI();

    expect(result.stopped).toBe(false);
    expect(result.started).toBe(false);
    expect(result.message).toMatch(/not running the ComfyUI that answered/i);
    expect(result.message).toMatch(/some-unrelated-daemon/);
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(killSpy).not.toHaveBeenCalled();

    killSpy.mockRestore();
  });

  it("REFUSES on that mismatch EVEN IF the HTTP re-check then fails transiently", async () => {
    // The combination that used to slip through: the command-line mismatch was
    // downgraded to "no identity", the re-fetch errored so it proved nothing, and
    // the pre-kill check then only re-verified the numeric PID's port ownership —
    // killing the replacement using the previous server's argv and env plan.
    usePinokioInstall();
    let answers = 0;
    mockGetSystemStats.mockImplementation(async () => {
      answers++;
      if (answers > 1) throw new Error("ECONNRESET");
      return { system: { argv: [PINOKIO_MAIN, "--port", "8188"] } };
    });
    __processControlTestHooks.setProcessIdentityResolver(() => ({
      startedAt: "t9",
      commandLine: "/usr/bin/some-unrelated-daemon --serve",
    }));
    mockLivePortThenFree();
    spawnCapturingChildren();
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await restartComfyUI();

    expect(result.stopped).toBe(false);
    expect(result.message).toMatch(/not running the ComfyUI that answered/i);
    expect(killSpy).not.toHaveBeenCalled();
    expect(
      mockExecSync.mock.calls.some(([cmd]) => /taskkill/i.test(String(cmd))),
    ).toBe(false);
    expect(mockSpawn).not.toHaveBeenCalled();

    killSpy.mockRestore();
  });

  it("re-checks identity for a DESKTOP answer too, so a substituted instance is never rebooted in its place", async () => {
    // `isDesktopApp` is derived from the FIRST, possibly stale argv. Skipping the
    // recheck there is how a Desktop answer from A gets a ComfyUI-Manager reboot
    // fired at a non-Desktop B that took the port in the meantime.
    const DESKTOP_MAIN = join(
      resolve("AppData", "Local", "Programs", "@comfyorgcomfyui-electron"),
      "resources",
      "ComfyUI",
      "main.py",
    );
    let answers = 0;
    mockFindComfyuiPython.mockReturnValue(PLAIN_PY);
    mockLiveRootFromArgv.mockReturnValue(PLAIN_BASE);
    mockGetSystemStats.mockImplementation(async () => {
      answers++;
      // A = the Desktop app; B = an ordinary install that grabbed the port.
      return {
        system: {
          argv:
            answers <= 1
              ? [DESKTOP_MAIN, "--port", "8188"]
              : [PLAIN_MAIN, "--port", "8188"],
        },
      };
    });
    mockExistsSync.mockImplementation((p: string) => {
      const s = String(p);
      return s === PLAIN_MAIN || s === PLAIN_PY;
    });
    mockLivePortThenFree();
    spawnCapturingChildren();
    const rebootFetch = vi.fn(async () => ({ ok: true }) as Response);
    vi.stubGlobal("fetch", rebootFetch);
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await restartComfyUI();

    expect(result.stopped).toBe(false);
    expect(result.started).toBe(false);
    expect(result.message).toMatch(/changed while it was being identified/i);
    // No Manager reboot was fired at the substituted instance, and nothing killed.
    expect(rebootFetch).not.toHaveBeenCalled();
    expect(killSpy).not.toHaveBeenCalled();

    killSpy.mockRestore();
  });

  it("does NOT KILL a PID that no longer owns the port it was found on", async () => {
    // The server exited between the port lookup and the stop. Its number may
    // already belong to something else, so nothing may be killed.
    usePlainInstallForIdentity();
    let netstatCalls = 0;
    mockExecSync.mockImplementation((cmd: string) => {
      if (/netstat/i.test(cmd)) {
        netstatCalls++;
        // Owned during the lookup; gone by the pre-kill re-check.
        return netstatCalls <= 1
          ? "  TCP    0.0.0.0:8188   0.0.0.0:0   LISTENING       4321"
          : "";
      }
      if (/lsof/i.test(cmd)) {
        netstatCalls++;
        if (netstatCalls > 1) throw new Error("not listening");
        return "p4321\nn127.0.0.1:8188\n";
      }
      return "";
    });
    spawnCapturingChildren();
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await restartComfyUI();

    expect(result.stopped).toBe(false);
    expect(result.started).toBe(false);
    expect(result.message).toMatch(/no longer owns that port/i);
    expect(result.message).toMatch(/must not be killed/i);
    expect(killSpy).not.toHaveBeenCalled();
    expect(
      mockExecSync.mock.calls.some(([cmd]) => /taskkill/i.test(String(cmd))),
    ).toBe(false);
    expect(mockSpawn).not.toHaveBeenCalled();

    killSpy.mockRestore();
  });

  it("does NOT KILL a PID whose process CREATION TIME changed under it", async () => {
    // The stronger identity: the number is still listening, but it is not the
    // process we identified (#650's pid + creation-time identity).
    usePlainInstallForIdentity();
    identitySequence(["t1", "t2"], PLAIN_ARGV); // lookup, then the pre-kill re-verify
    mockLivePortThenFree();
    spawnCapturingChildren();
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await restartComfyUI();

    expect(result.stopped).toBe(false);
    expect(result.started).toBe(false);
    expect(result.message).toMatch(/creation time/i);
    expect(result.message).toMatch(/must not be killed/i);
    expect(killSpy).not.toHaveBeenCalled();
    expect(mockSpawn).not.toHaveBeenCalled();

    killSpy.mockRestore();
  });

  it("REFUSES when the server that answered is NOT the one that ends up owning the port", async () => {
    // ComfyUI A answers /system_stats, exits, and ComfyUI B — a DIFFERENT install,
    // different argv — takes the port before the lookup. Binding A's answer to B's
    // pid would make us kill B on the strength of A's launch arguments. Re-asking
    // the server after the pid is in hand catches exactly that.
    usePlainInstallForIdentity();
    const OTHER_MAIN = join(resolve("OtherComfy"), "main.py");
    let answers = 0;
    mockGetSystemStats.mockImplementation(async () => {
      answers++;
      // First answer: install A. Second (after the pid was bound): install B.
      return {
        system: { argv: answers <= 1 ? PLAIN_ARGV : [OTHER_MAIN, "--port", "8188"] },
      };
    });
    mockLivePortThenFree();
    spawnCapturingChildren();
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await restartComfyUI();

    expect(result.stopped).toBe(false);
    expect(result.started).toBe(false);
    expect(result.message).toMatch(/changed while it was being identified/i);
    expect(killSpy).not.toHaveBeenCalled();
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(
      mockExecSync.mock.calls.some(([cmd]) => /taskkill/i.test(String(cmd))),
    ).toBe(false);

    killSpy.mockRestore();
  });

  it("does NOT refuse when the identity re-check merely fails to reach the server", async () => {
    // Absence of evidence is not evidence: a transport hiccup on the re-fetch must
    // not turn a perfectly good restart into a refusal.
    usePlainInstallForIdentity();
    let answers = 0;
    mockGetSystemStats.mockImplementation(async () => {
      answers++;
      if (answers > 1) throw new Error("ECONNRESET");
      return { system: { argv: PLAIN_ARGV } };
    });
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

    killSpy.mockRestore();
  });

  it("leaves crash supervision INTACT when the kill itself fails", async () => {
    // `taskkill`/`kill` fail for ordinary reasons — access denied above all — and
    // the server is then still running. Tearing supervision down before the kill
    // would disarm auto-restart for a server we did not manage to stop.
    usePlainInstallForIdentity();
    mockExecSync.mockImplementation((cmd: string) => {
      if (/taskkill|pkill|\bkill\b/i.test(cmd)) {
        throw new Error("ERROR: The process ... could not be terminated. Access is denied.");
      }
      if (/netstat/i.test(cmd)) {
        return "  TCP    0.0.0.0:8188   0.0.0.0:0   LISTENING       4321";
      }
      if (/lsof/i.test(cmd)) return "p4321\nn127.0.0.1:8188\n";
      return "";
    });
    spawnCapturingChildren();
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("EPERM");
    });

    const result = await restartComfyUI();

    expect(result.stopped).toBe(false);
    expect(result.started).toBe(false);
    expect(result.message).toMatch(/could not stop comfyui/i);
    expect(result.message).toMatch(/crash supervision and launch record are untouched/i);
    // Nothing was relaunched — the old server is still the one running.
    expect(mockSpawn).not.toHaveBeenCalled();

    killSpy.mockRestore();
  });

  function usePlainInstallForIdentity(): void {
    mockFindComfyuiPython.mockReturnValue(PLAIN_PY);
    mockLiveRootFromArgv.mockReturnValue(PLAIN_BASE);
    mockGetSystemStats.mockResolvedValue({
      system: { argv: PLAIN_ARGV },
    });
    mockExistsSync.mockImplementation((p: string) => {
      const s = String(p);
      return s === PLAIN_MAIN || s === PLAIN_PY;
    });
  }
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

  it("does NOT claim a successful restart when the healthy listener is somebody ELSE's process", async () => {
    // Readiness only proves that SOMETHING answers on the port. If an external
    // launcher/supervisor bound it while our child failed, the server is up but
    // OUR relaunch did not do it — saying "restarted successfully" would be false.
    usePlainInstall();
    // The port owner reported after the relaunch (4321) is not our child (999).
    spawnCapturingChildren(999);
    let killed = false;
    mockExecSync.mockImplementation((cmd: string) => {
      if (/taskkill|pkill|\bkill\b/i.test(cmd)) {
        killed = true;
        return "";
      }
      if (/netstat/i.test(cmd)) {
        // Free during the post-kill wait, then a DIFFERENT process owns it again.
        return killed && !restarted
          ? ""
          : "  TCP    0.0.0.0:8188   0.0.0.0:0   LISTENING       4321";
      }
      if (/lsof/i.test(cmd)) {
        if (killed && !restarted) throw new Error("not listening");
        return "p4321\nn127.0.0.1:8188\n";
      }
      return "";
    });
    let restarted = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        restarted = true; // something answers on the port again
        return { ok: true } as Response;
      }),
    );
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await restartComfyUI();

    expect(result.listener_ownership).toBe("not-ours");
    // The STRUCTURED result must not read as a successful restart either: this
    // call did not start the server. `ready` stays true — the server really is up.
    expect(result.started).toBe(false);
    expect(result.ready).toBe(true);
    expect(result.message).not.toMatch(/restarted successfully/i);
    expect(result.message).toMatch(/NOT as a result of this restart/i);
    expect(result.message).toMatch(/another launcher or supervisor owns it/i);
    expect(result.message).not.toMatch(/could not be started/i);
    // ...and it must SURVIVE the tool's JSON serialization.
    expect(JSON.parse(JSON.stringify(result)).listener_ownership).toBe("not-ours");

    killSpy.mockRestore();
  });

  it("does NOT claim success when our child died and the replacement listener's PID cannot even be mapped", async () => {
    // The #449 shape: a healthy API but an unmappable port owner. A DEAD launched
    // child is decisive on its own — it cannot be the process now answering — so
    // "undecidable PID" must not launder a failed relaunch into a success.
    usePlainInstall();
    const children = spawnCapturingChildren(999);
    let killed = false;
    mockExecSync.mockImplementation((cmd: string) => {
      if (/taskkill|pkill|\bkill\b/i.test(cmd)) {
        killed = true;
        return "";
      }
      // After the kill the port owner is never mappable again.
      if (/netstat/i.test(cmd)) {
        return killed ? "" : "  TCP    0.0.0.0:8188   0.0.0.0:0   LISTENING       4321";
      }
      if (/lsof/i.test(cmd)) {
        if (killed) throw new Error("not listening");
        return "p4321\nn127.0.0.1:8188\n";
      }
      return "";
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        // Our child is gone, yet something healthy answers on the port.
        children[0]?.emit("exit", 1, null);
        return { ok: true } as Response;
      }),
    );
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await restartComfyUI();

    expect(result.listener_ownership).toBe("not-ours");
    expect(result.started).toBe(false);
    expect(result.ready).toBe(true);
    expect(result.message).not.toMatch(/restarted successfully/i);
    expect(result.message).toMatch(/NOT as a result of this restart/i);
    expect(result.message).toMatch(/which exited: exit code 1/);

    killSpy.mockRestore();
  });

  it("claims a successful restart ONLY when the port owner is matched to the process we launched", async () => {
    // The one case where "restarted successfully" is a claim we can back: the
    // mapped port owner IS our child's pid.
    usePlainInstall();
    spawnCapturingChildren(4321);
    let killed = false;
    let relaunched = false;
    mockExecSync.mockImplementation((cmd: string) => {
      if (/taskkill|pkill|\bkill\b/i.test(cmd)) {
        killed = true;
        return "";
      }
      if (/netstat/i.test(cmd)) {
        return killed && !relaunched
          ? ""
          : "  TCP    0.0.0.0:8188   0.0.0.0:0   LISTENING       4321";
      }
      if (/lsof/i.test(cmd)) {
        if (killed && !relaunched) throw new Error("not listening");
        return "p4321\nn127.0.0.1:8188\n";
      }
      return "";
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        relaunched = true;
        return { ok: true } as Response;
      }),
    );
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await restartComfyUI();

    expect(result.started).toBe(true);
    expect(result.listener_ownership).toBe("ours");
    expect(result.message).toMatch(/restarted successfully/i);
    expect(result.message).not.toMatch(/could not be confirmed/i);

    killSpy.mockRestore();
  });

  it("does NOT claim a matching PID as ours when the child is already gone but its `exit` event has not been delivered", async () => {
    // The lifecycle race: our child dies, the OS reuses its number for a program
    // that binds the port, and readiness sees that healthy replacement BEFORE Node
    // delivers the `exit` event. A bare `portOwnerPid === ourPid` would call it
    // "ours". A synchronous signal-0 probe says otherwise.
    usePlainInstall();
    spawnCapturingChildren(4321);
    let killed = false;
    let relaunched = false;
    mockExecSync.mockImplementation((cmd: string) => {
      if (/taskkill|pkill|\bkill\b/i.test(cmd)) {
        killed = true;
        return "";
      }
      if (/netstat/i.test(cmd)) {
        return killed && !relaunched
          ? ""
          : "  TCP    0.0.0.0:8188   0.0.0.0:0   LISTENING       4321";
      }
      if (/lsof/i.test(cmd)) {
        if (killed && !relaunched) throw new Error("not listening");
        return "p4321\nn127.0.0.1:8188\n";
      }
      return "";
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        relaunched = true;
        return { ok: true } as Response;
      }),
    );
    // Signal-0 liveness probes for our child report ESRCH; the process-group kill
    // during the stop still succeeds. NOTE the `exit` event is deliberately never
    // emitted — that is the whole point of the race.
    const killSpy = vi
      .spyOn(process, "kill")
      .mockImplementation((pid: number, signal?: string | number) => {
        if (signal === 0) {
          const err = new Error("ESRCH") as NodeJS.ErrnoException;
          err.code = "ESRCH";
          throw err;
        }
        return true;
      });

    const result = await restartComfyUI();

    expect(result.listener_ownership).toBe("not-ours");
    expect(result.started).toBe(false);
    expect(result.ready).toBe(true);
    expect(result.message).not.toMatch(/restarted successfully/i);
    expect(result.message).toMatch(/NOT as a result of this restart/i);

    killSpy.mockRestore();
  });


  /** The relaunch scenario shared by the lineage tests: same pid, alive, and the
   *  port owned again once the API answers. */
  function stableRelaunchOnPid4321(): void {
    usePlainInstall();
    spawnCapturingChildren(4321);
    let killed = false;
    let relaunched = false;
    mockExecSync.mockImplementation((cmd: string) => {
      if (/taskkill|pkill|\bkill\b/i.test(cmd)) {
        killed = true;
        return "";
      }
      if (/netstat/i.test(cmd)) {
        return killed && !relaunched
          ? ""
          : "  TCP    0.0.0.0:8188   0.0.0.0:0   LISTENING       4321";
      }
      if (/lsof/i.test(cmd)) {
        if (killed && !relaunched) throw new Error("not listening");
        return "p4321\nn127.0.0.1:8188\n";
      }
      return "";
    });
    __processControlTestHooks.setProcessIdentityResolver(() => ({
      startedAt: "same-second",
      commandLine: `${PLAIN_PY} ${PLAIN_MAIN} --port 8188`,
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        relaunched = true;
        return { ok: true } as Response;
      }),
    );
  }

  it("does NOT claim ownership when LINEAGE says the process on the port is not our child", async () => {
    // Everything else matches — pid, liveness, creation stamp, command line — as it
    // would for a number recycled by ANOTHER ComfyUI with identical argv (and on
    // macOS, within the same `lstart` second). Parentage is the one signal that
    // does not depend on when we looked.
    stableRelaunchOnPid4321();
    __processControlTestHooks.setParentPidResolver(() => process.pid + 1);
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await restartComfyUI();

    expect(result.listener_ownership).toBe("not-ours");
    expect(result.started).toBe(false);
    expect(result.message).not.toMatch(/restarted successfully/i);

    killSpy.mockRestore();
  });

  it("withholds the claim when the parent cannot be read at all", async () => {
    stableRelaunchOnPid4321();
    __processControlTestHooks.setParentPidResolver(() => undefined);
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await restartComfyUI();

    // Not knowing is never promoted to a claim — but it does not deny the restart
    // either, so the server stays reported as up.
    expect(result.listener_ownership).toBe("unconfirmed");
    expect(result.started).toBe(true);
    expect(result.message).not.toMatch(/restarted successfully/i);

    killSpy.mockRestore();
  });

  it("DOES claim it when the process is provably our own child", async () => {
    stableRelaunchOnPid4321();
    __processControlTestHooks.setParentPidResolver(() => process.pid);
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await restartComfyUI();

    expect(result.listener_ownership).toBe("ours");
    expect(result.message).toMatch(/restarted successfully/i);

    killSpy.mockRestore();
  });

  it("says so plainly when listener ownership is UNDECIDABLE — without denying a restart that worked", async () => {
    // Unmappable port owner + a still-alive launched child. Reporting this as a
    // FAILED restart would mislabel every ordinary restart on hosts where the
    // port-owner lookup is unavailable, so the result stays started:true and the
    // uncertainty is stated instead of guessed either way.
    usePlainInstall();
    spawnCapturingChildren(999);
    let killed = false;
    mockExecSync.mockImplementation((cmd: string) => {
      if (/taskkill|pkill|\bkill\b/i.test(cmd)) {
        killed = true;
        return "";
      }
      if (/netstat/i.test(cmd)) {
        return killed ? "" : "  TCP    0.0.0.0:8188   0.0.0.0:0   LISTENING       4321";
      }
      if (/lsof/i.test(cmd)) {
        if (killed) throw new Error("not listening");
        return "p4321\nn127.0.0.1:8188\n";
      }
      return "";
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true }) as Response),
    );
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await restartComfyUI();

    expect(result.started).toBe(true);
    expect(result.ready).toBe(true);
    expect(result.listener_ownership).toBe("unconfirmed");
    expect(result.message).toMatch(/could not be confirmed as the process this call launched/i);
    // ...and the headline must not ATTRIBUTE the healthy listener to this restart.
    expect(result.message).not.toMatch(/restarted successfully/i);
    expect(result.message).toMatch(/could not be confirmed as the one serving the port/i);
    // THE POINT of a string state: `undefined` would be dropped by JSON.stringify,
    // leaving a payload indistinguishable from one that never carried the field —
    // i.e. from a plain success. The uncertainty has to reach the consumer.
    const serialized = JSON.parse(JSON.stringify(result));
    expect(Object.hasOwn(serialized, "listener_ownership")).toBe(true);
    expect(serialized.listener_ownership).toBe("unconfirmed");

    killSpy.mockRestore();
  });

  it("names the launched process's EXIT when it dies before the API comes up", async () => {
    usePlainInstall();
    mockLivePortThenFree();
    const children = spawnCapturingChildren();
    // The API never answers; meanwhile the process we launched dies (the #776
    // shape: ComfyUI aborting during import in a degraded environment).
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        children[0]?.emit("exit", 1, null);
        throw new Error("ECONNREFUSED");
      }),
    );
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await restartComfyUI();

    expect(result.stopped).toBe(true);
    expect(result.started).toBe(false);
    expect(result.message).toMatch(/EXITED \(exit code 1\)/);
    expect(result.message).toMatch(/failed relaunch, not a slow start/i);

    killSpy.mockRestore();
  });

  it("states listener ownership on EVERY return path, including 'another launcher took the port'", async () => {
    // After our stop, a different launcher binds the port during the settle delay,
    // so start_comfyui exits via its "already running" branch. That branch used to
    // carry no ownership at all — and since JSON.stringify DROPS undefined, the
    // payload was indistinguishable from an old build that never had the field.
    usePlainInstall();
    let killed = false;
    mockExecSync.mockImplementation((cmd: string) => {
      if (/taskkill|pkill|\bkill\b/i.test(cmd)) {
        killed = true;
        return "";
      }
      if (/netstat/i.test(cmd)) {
        // Freed by the kill, then taken again by somebody else before the relaunch.
        return killed && netstatCalls++ === 0
          ? ""
          : "  TCP    0.0.0.0:8188   0.0.0.0:0   LISTENING       7777";
      }
      if (/lsof/i.test(cmd)) {
        if (killed && netstatCalls++ === 0) throw new Error("not listening");
        return "p7777\nn127.0.0.1:8188\n";
      }
      return "";
    });
    let netstatCalls = 0;
    spawnCapturingChildren();
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await restartComfyUI();

    expect(result.listener_ownership).toBe("not-ours");
    const serialized = JSON.parse(JSON.stringify(result));
    expect(Object.hasOwn(serialized, "listener_ownership")).toBe(true);
    expect(serialized.listener_ownership).toBe("not-ours");
    expect(result.message).not.toMatch(/restarted successfully/i);

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
