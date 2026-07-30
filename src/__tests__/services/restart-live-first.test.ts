// Live-first restart script resolution (#476, #426).
//
// A reachable, self-spawned (non-Desktop) ComfyUI whose sys.argv[0] is the
// RELATIVE portable-launcher path `ComfyUI\main.py` must RESTART — anchored to
// the canonical ABSOLUTE install that download_model / the environment services
// already resolved (resolveEffectiveComfyUIBase) — instead of REFUSING because a
// stale/relative COMFYUI_PATH made the script path look nonexistent. The
// refuse-safe behavior is preserved when NO valid live script can be resolved.
//
// Boundaries only are mocked: config, the env-resolution service (workspace-env),
// the python resolver (env-capabilities), child_process, node:fs, the ComfyUI
// client, and global fetch. No real process/port/network/filesystem is touched.

import { EventEmitter } from "node:events";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class FakeChild extends EventEmitter {
  unref = vi.fn();
}

const mockConfig = vi.hoisted(() => ({
  resolvedPort: 8188,
  // #476/#426: COMFYUI_PATH is unset/stale — the canonical absolute install is
  // known only to the env service (saved default workspace), exactly like the
  // one download_model wrote into in the same session.
  comfyuiPath: undefined as string | undefined,
}));

const mockExecSync = vi.hoisted(() => vi.fn());
const mockSpawn = vi.hoisted(() => vi.fn());
const mockGetSystemStats = vi.hoisted(() => vi.fn());
const mockResetClient = vi.hoisted(() => vi.fn());
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

vi.mock("node:fs", () => ({
  existsSync: mockExistsSync,
}));

vi.mock("../../comfyui/client.js", () => ({
  getSystemStats: mockGetSystemStats,
  resetClient: mockResetClient,
  resetObjectInfoCache: vi.fn(),
}));

vi.mock("../../utils/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../../services/env-capabilities.js", () => ({
  findComfyuiPython: mockFindComfyuiPython,
}));

// The env-resolution service is the boundary: it owns the canonical absolute base
// (download_model uses the same one) and the argv-derived live root.
vi.mock("../../services/workspace-env.js", () => ({
  resolveEffectiveComfyUIBase: mockResolveBase,
  liveRootFromArgv: mockLiveRootFromArgv,
}));

import {
  __processControlTestHooks,
  restartComfyUI,
} from "../../services/process-control.js";

// The canonical live install — where download_model wrote, and where the running
// server's python actually lives. HOST-NATIVE absolute so the test is portable:
// production resolveScriptAnchor uses node:path.isAbsolute, so a hardcoded
// Windows path would read as relative on Ubuntu/macOS CI.
const BASE = resolve("ComfyUI_portable", "ComfyUI");
const ABS_MAIN = join(BASE, "main.py");
const ABS_PYTHON = join(BASE, "python_embeded", "python.exe");

const ORIGINAL_ENV = { ...process.env };

/**
 * execSync that reports a live PID on the port until a kill is issued, then
 * reports the port free — so gatherProcessInfo finds the instance and
 * waitForPortFree returns promptly after the (mocked) kill.
 */
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
      return "4321";
    }
    return "";
  });
  return { killed: () => killed };
}

beforeEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  process.env = { ...ORIGINAL_ENV };
  process.env.COMFYUI_STARTUP_CHECK_INTERVAL_S = "0.01";
  process.env.COMFYUI_STARTUP_CHECK_MAX_TRIES = "1";
  mockConfig.resolvedPort = 8188;
  mockConfig.comfyuiPath = undefined;
  mockFindComfyuiPython.mockReturnValue(ABS_PYTHON);
  // Portable launcher: relative argv → no argv-derived live root.
  mockLiveRootFromArgv.mockReturnValue(undefined);
  // The env service knows the canonical absolute install.
  mockResolveBase.mockReturnValue(BASE);
  // Everything that resolves to the absolute canonical install exists on disk.
  mockExistsSync.mockImplementation((p: string) => {
    const s = String(p);
    return s === ABS_MAIN || s === ABS_PYTHON;
  });
  // Running server exposes the RELATIVE portable-launcher script path.
  mockGetSystemStats.mockResolvedValue({
    system: { argv: ["ComfyUI\\main.py", "--port", "8188"] },
  });
  __processControlTestHooks.reset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  process.env = { ...ORIGINAL_ENV };
  __processControlTestHooks.reset();
});

describe("restart_comfyui — live-first script resolution (#476, #426)", () => {
  it("RESTARTS a reachable install, anchoring a relative argv[0] to the canonical absolute base (not refusing on a stale/relative COMFYUI_PATH)", async () => {
    mockLivePortThenFree();
    const children: FakeChild[] = [];
    mockSpawn.mockImplementation(() => {
      const child = new FakeChild();
      children.push(child);
      return child;
    });
    // Relaunch preflight passes, stop frees the port, relaunch spawns, and the
    // readiness probe sees a live API — a genuine successful restart.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true }) as Response),
    );
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await restartComfyUI();

    // It did NOT take the refuse-safe branch — it actually restarted.
    expect(result.message).not.toMatch(/refusing to restart/i);
    expect(result.stopped).toBe(true);
    expect(result.started).toBe(true);
    expect(result.ready).toBe(true);

    // The relaunch spawned the resolved interpreter with the ABSOLUTE main.py —
    // anchored to the canonical base, not the bare relative "ComfyUI\main.py".
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const [exe, args] = mockSpawn.mock.calls[0];
    expect(exe).toBe(ABS_PYTHON);
    expect(args[0]).toBe(ABS_MAIN);

    killSpy.mockRestore();
  });

  it("REFUSES a bare relative `main.py` that cannot be anchored (no canonical base, no live root)", async () => {
    // Bare "main.py" with nothing to anchor it to is truly unresolvable — refuse
    // rather than kill a reachable server we cannot relaunch.
    mockResolveBase.mockReturnValue(undefined);
    mockGetSystemStats.mockResolvedValue({
      system: { argv: ["main.py", "--port", "8188"] },
    });
    mockExistsSync.mockImplementation((p: string) => String(p) === ABS_PYTHON);
    mockLivePortThenFree();
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await restartComfyUI();

    expect(result.stopped).toBe(false);
    expect(result.started).toBe(false);
    expect(result.message).toMatch(/refusing to restart/i);
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(killSpy).not.toHaveBeenCalled();

    killSpy.mockRestore();
  });

  it("still REFUSES (leaves the server running) when no valid live script can be resolved at all", async () => {
    // No canonical base, no live root, and the relative script does not exist.
    mockResolveBase.mockReturnValue(undefined);
    mockExistsSync.mockImplementation((p: string) => String(p) === ABS_PYTHON);
    mockLivePortThenFree();
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await restartComfyUI();

    expect(result.stopped).toBe(false);
    expect(result.started).toBe(false);
    expect(result.message).toMatch(/refusing to restart/i);
    expect(result.message).toMatch(/stale/i);
    // Server left running: no relaunch spawn, no kill.
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(killSpy).not.toHaveBeenCalled();
    expect(
      mockExecSync.mock.calls.some(([c]) => /taskkill/i.test(String(c))),
    ).toBe(false);

    killSpy.mockRestore();
  });
});
