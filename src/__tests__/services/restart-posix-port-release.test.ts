// The restart flow on POSIX, where the port is probed with `lsof` (#776).
//
// This file exists because of a failure that NO amount of local testing on Windows
// could have caught. `probePortOwner` distinguishes "the port is free" from "I
// could not look", and on POSIX it draws that distinction from how `lsof` FAILED:
// exit 1 means "ran fine, matched nothing"; anything else means the probe itself
// did not work. The rest of the suite modelled "nothing is listening" as a bare
// `throw new Error(...)`, which carries neither an exit status nor an errno — so on
// POSIX every post-kill wait read it as "could not look", polled for its full
// budget, and the tests timed out. On Windows the netstat branch answers first and
// never reaches lsof, so the same suite was green.
//
// The platform is therefore MOCKED here rather than inherited, so this path is
// exercised on every developer machine and not only on a Linux runner.

import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class FakeChild extends EventEmitter {
  unref = vi.fn();
  pid: number | undefined = 4321;
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

// FORCE THE POSIX BRANCH. port-owner captures `IS_WIN` at module load, so the
// platform has to be mocked before it is imported.
vi.mock("node:os", () => ({ platform: () => "linux" }));

vi.mock("../../config.js", () => ({
  config: mockConfig,
  getComfyUIBaseUrl: () => "http://127.0.0.1:8188",
  getComfyUIAuthHeaders: () => ({}),
  isRemoteMode: () => false,
}));

vi.mock("node:child_process", () => ({
  execSync: mockExecSync,
  spawn: mockSpawn,
  execFile: vi.fn(),
  execFileSync: vi.fn(() => {
    throw new Error("no process reader in test");
  }),
}));

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
  resolveEffectiveComfyUIBase: () => BASE,
  liveRootFromArgv: () => BASE,
  markLocalComfyUILaunched: vi.fn(),
  resetLocalComfyUILaunchState: vi.fn(),
}));

import {
  __processControlTestHooks,
  restartComfyUI,
} from "../../services/process-control.js";

// POSIX-DIALECT LITERALS, deliberately not `path.join`/`resolve`. The platform is
// mocked to linux, so every separator-sensitive comparison downstream (notably
// commandLineMatchesArgv, which normalises differently per platform) evaluates as
// POSIX. Building these with the host's `path` would produce Windows separators
// under a POSIX-thinking comparison — a test written in one dialect and evaluated
// in the other, which is its own class of false result.
const BASE = "/opt/PosixComfy/ComfyUI";
const MAIN = `${BASE}/main.py`;
const PYTHON = `${BASE}/venv/bin/python`;
const ARGV = [MAIN, "--port", "8188"];

/** `lsof` exiting 1 with no output: "ran fine, matched nothing". */
function lsofNoMatches(): Error {
  const err = new Error("no listener") as Error & { status?: number };
  err.status = 1;
  return err;
}

/** `lsof` not installed — the shell reports 127. The probe did NOT run. */
function lsofMissing(): Error {
  const err = new Error("sh: lsof: not found") as Error & { status?: number };
  err.status = 127;
  return err;
}

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  process.env = { ...ORIGINAL_ENV };
  process.env.COMFYUI_STARTUP_CHECK_INTERVAL_S = "0.01";
  process.env.COMFYUI_STARTUP_CHECK_MAX_TRIES = "1";
  mockConfig.resolvedPort = 8188;
  mockConfig.comfyuiPath = BASE;
  mockFindComfyuiPython.mockReturnValue(PYTHON);
  mockExistsSync.mockImplementation((p: string) => {
    const s = String(p);
    return s === MAIN || s === PYTHON || s === BASE;
  });
  mockGetSystemStats.mockResolvedValue({ system: { argv: ARGV } });
  mockSpawn.mockImplementation(() => new FakeChild());
  __processControlTestHooks.reset();
  __processControlTestHooks.setProcessIdentityResolver(() => ({
    startedAt: "stable-stamp",
  }));
  __processControlTestHooks.setParentPidResolver(() => process.pid);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  process.env = { ...ORIGINAL_ENV };
  __processControlTestHooks.reset();
});

describe("restart_comfyui on POSIX — port release via lsof (#776)", () => {
  it("completes PROMPTLY when lsof reports the port free after the kill", async () => {
    // The regression: reading lsof's exit-1 as "could not look" made the port-free
    // wait burn its entire budget on every successful restart. A generous ceiling
    // here still fails loudly against that behaviour (the wait is 15s).
    let killed = false;
    mockExecSync.mockImplementation((cmd: string) => {
      if (/kill/i.test(cmd)) {
        killed = true;
        return "";
      }
      if (/lsof/i.test(cmd)) {
        if (killed) throw lsofNoMatches();
        return "p4321\nn127.0.0.1:8188\n";
      }
      return "";
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true }) as Response),
    );
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const startedAt = Date.now();
    const result = await restartComfyUI();
    const elapsed = Date.now() - startedAt;

    expect(result.stopped).toBe(true);
    expect(result.started).toBe(true);
    expect(elapsed).toBeLessThan(8000);

    killSpy.mockRestore();
  }, 20_000);

  it("does NOT read a MISSING lsof as proof the port is free", async () => {
    // A container without lsof. The probe did not run, so the stop cannot claim the
    // process died — but it still commits and relaunches, because a refusal after
    // the kill could not restore anything.
    let killed = false;
    mockExecSync.mockImplementation((cmd: string) => {
      if (/kill/i.test(cmd)) {
        killed = true;
        return "";
      }
      if (/lsof/i.test(cmd)) {
        if (killed) throw lsofMissing();
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

    expect(result.stopped).toBe(true);
    expect(result.message).toMatch(/could not be checked after the kill/i);
    // ...and the server was brought back rather than abandoned.
    expect(mockSpawn).toHaveBeenCalledTimes(1);

    killSpy.mockRestore();
  }, 30_000);
});
