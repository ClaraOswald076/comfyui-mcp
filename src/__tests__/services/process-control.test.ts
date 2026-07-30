import { EventEmitter } from "node:events";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

const mockConfig = vi.hoisted(() => ({
  resolvedPort: 8188,
  comfyuiPath: "/fake/ComfyUI" as string | undefined,
}));

const mockExecSync = vi.hoisted(() => vi.fn());
const mockSpawn = vi.hoisted(() => vi.fn());
const mockGetSystemStats = vi.hoisted(() => vi.fn());
const mockResetClient = vi.hoisted(() => vi.fn());

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

// assessRelaunch (restart preflight) validates the resolved interpreter/script
// exist on disk. Default: everything exists; a test overrides for the stale-path
// case.
const mockExistsSync = vi.hoisted(() => vi.fn((_p: string) => true));
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

const mockFindComfyuiPython = vi.hoisted(() => vi.fn());
vi.mock("../../services/env-capabilities.js", () => ({
  findComfyuiPython: mockFindComfyuiPython,
}));

import {
  __processControlTestHooks,
  restartComfyUI,
  startComfyUI,
  stopComfyUI,
} from "../../services/process-control.js";

class FakeChild extends EventEmitter {
  unref = vi.fn();
}

const ORIGINAL_ENV = { ...process.env };

function setLaunchInfo(): void {
  __processControlTestHooks.setLastProcessInfo({
    pid: 0,
    port: 8188,
    argv: ["python", "main.py", "--port", "8188"],
    isDesktopApp: false,
  });
}

function mockSpawnedChildren(): FakeChild[] {
  const children: FakeChild[] = [];
  mockSpawn.mockImplementation(() => {
    const child = new FakeChild();
    children.push(child);
    return child;
  });
  return children;
}

function mockNoPortProcess(): void {
  mockExecSync.mockImplementation((cmd: string) => {
    if (cmd.includes("lsof")) throw new Error("not listening");
    return "";
  });
}

function mockFetchOk(ok: boolean): Mock {
  const fetchMock = vi.fn(async () => ({ ok }) as Response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function spawnError(message = "spawn python ENOENT"): NodeJS.ErrnoException {
  const err = new Error(message) as NodeJS.ErrnoException;
  err.code = "ENOENT";
  err.syscall = "spawn python";
  err.path = "python";
  return err;
}

beforeEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  process.env = { ...ORIGINAL_ENV };
  delete process.env.COMFYUI_ALWAYS_RESTART;
  delete process.env.COMFYUI_RESTART_MAX_ATTEMPTS;
  delete process.env.COMFYUI_RESTART_WINDOW_S;
  delete process.env.COMFYUI_STARTUP_CHECK_INTERVAL_S;
  delete process.env.COMFYUI_STARTUP_CHECK_MAX_TRIES;
  mockConfig.resolvedPort = 8188;
  mockConfig.comfyuiPath = "/fake/ComfyUI";
  mockFindComfyuiPython.mockReturnValue("/fake/ComfyUI/python_embeded/python.exe");
  mockExistsSync.mockImplementation(() => true);
  __processControlTestHooks.reset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  process.env = { ...ORIGINAL_ENV };
  __processControlTestHooks.reset();
});

describe("process-control startup readiness", () => {
  it("reports ready after the bounded readiness probe succeeds", async () => {
    setLaunchInfo();
    const children = mockSpawnedChildren();
    mockNoPortProcess();
    const fetchMock = mockFetchOk(true);

    const result = await startComfyUI();

    expect(result.started).toBe(true);
    expect(result.ready).toBe(true);
    expect(result.readiness).toEqual({
      ready: true,
      timed_out: false,
      attempts: 1,
      max_tries: 60,
      interval_ms: 1000,
      waited_ms: expect.any(Number),
      probe_url: "http://127.0.0.1:8188/system_stats",
    });
    expect(result.auto_restart?.enabled).toBe(false);
    expect(mockSpawn).toHaveBeenCalledWith(
      "python",
      ["main.py", "--port", "8188"],
      expect.objectContaining({
        detached: true,
        cwd: "/fake/ComfyUI",
        shell: false,
        stdio: "ignore",
      }),
    );
    expect(children[0].unref).toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("relaunches via the resolved Python interpreter when argv[0] is a main.py script (#330)", async () => {
    // Real ComfyUI /system_stats argv is sys.argv: argv[0] is the SCRIPT path
    // (…/main.py), NOT the interpreter. Spawning that directly on Windows fails
    // with `spawn EFTYPE`; the relaunch must resolve the Python interpreter and
    // pass the whole argv as its args.
    __processControlTestHooks.setLastProcessInfo({
      pid: 0,
      port: 8188,
      argv: ["C:\\ComfyUI\\main.py", "--port", "8188"],
      isDesktopApp: false,
    });
    const children = mockSpawnedChildren();
    mockNoPortProcess();
    mockFetchOk(true);

    const result = await startComfyUI();

    expect(result.started).toBe(true);
    expect(mockFindComfyuiPython).toHaveBeenCalledWith("/fake/ComfyUI", [
      "C:\\ComfyUI\\main.py",
      "--port",
      "8188",
    ]);
    expect(mockSpawn).toHaveBeenCalledWith(
      "/fake/ComfyUI/python_embeded/python.exe",
      ["C:\\ComfyUI\\main.py", "--port", "8188"],
      expect.objectContaining({
        detached: true,
        cwd: "/fake/ComfyUI",
        shell: false,
        stdio: "ignore",
        windowsHide: true,
      }),
    );
    expect(children[0].unref).toHaveBeenCalled();
  });

  it("recognizes a QUOTED main.py script path and relaunches via the interpreter (#401 / #433)", async () => {
    // A launcher can leave surrounding quotes on argv[0] ("C:\ComfyUI\main.py").
    // The suffix test must strip them, else the quoted path fails the `.py` check,
    // bypasses the resolver, and is spawned as the executable.
    __processControlTestHooks.setLastProcessInfo({
      pid: 0,
      port: 8188,
      argv: ['"C:\\ComfyUI\\main.py"', "--port", "8188"],
      isDesktopApp: false,
    });
    const children = mockSpawnedChildren();
    mockNoPortProcess();
    mockFetchOk(true);

    const result = await startComfyUI();

    expect(result.started).toBe(true);
    // Resolved via the Python interpreter, with the UNQUOTED script path.
    expect(mockSpawn).toHaveBeenCalledWith(
      "/fake/ComfyUI/python_embeded/python.exe",
      ["C:\\ComfyUI\\main.py", "--port", "8188"],
      expect.objectContaining({ detached: true, shell: false }),
    );
    expect(children[0].unref).toHaveBeenCalled();
  });

  it("anchors a RELATIVE script argv[0] to the ComfyUI root (portable launcher, #330)", async () => {
    // The standard Windows portable launcher runs `python ComfyUI\main.py` from
    // the portable ROOT, so sys.argv[0] is relative. Since we force cwd to the
    // nested ComfyUI dir, passing it verbatim would look for ComfyUI\ComfyUI\
    // main.py — it must be anchored to config.comfyuiPath.
    __processControlTestHooks.setLastProcessInfo({
      pid: 0,
      port: 8188,
      argv: ["ComfyUI\\main.py", "--port", "8188"],
      isDesktopApp: false,
    });
    mockSpawnedChildren();
    mockNoPortProcess();
    mockFetchOk(true);

    const result = await startComfyUI();

    expect(result.started).toBe(true);
    expect(mockSpawn).toHaveBeenCalledWith(
      "/fake/ComfyUI/python_embeded/python.exe",
      [join("/fake/ComfyUI", "main.py"), "--port", "8188"],
      expect.objectContaining({ cwd: "/fake/ComfyUI", shell: false }),
    );
  });

  it("reports timeout instead of ready when bounded probes never succeed", async () => {
    vi.useFakeTimers();
    process.env.COMFYUI_STARTUP_CHECK_INTERVAL_S = "0.01";
    process.env.COMFYUI_STARTUP_CHECK_MAX_TRIES = "2";
    setLaunchInfo();
    mockSpawnedChildren();
    mockNoPortProcess();
    const fetchMock = mockFetchOk(false);

    const pending = startComfyUI();
    await vi.advanceTimersByTimeAsync(10);
    const result = await pending;

    expect(result.started).toBe(false);
    expect(result.ready).toBe(false);
    expect(result.readiness).toMatchObject({
      ready: false,
      timed_out: true,
      attempts: 2,
      max_tries: 2,
      interval_ms: 10,
      probe_url: "http://127.0.0.1:8188/system_stats",
    });
    expect(result.message).toMatch(/did not become ready/i);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reports child process spawn errors without throwing", async () => {
    setLaunchInfo();
    const children = mockSpawnedChildren();
    mockNoPortProcess();
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));

    const pending = startComfyUI();
    expect(() => children[0].emit("error", spawnError())).not.toThrow();
    const result = await pending;

    expect(result).toMatchObject({
      started: false,
      ready: false,
      message: expect.stringMatching(/failed to launch/i),
      spawn_error: {
        message: "spawn python ENOENT",
        code: "ENOENT",
        syscall: "spawn python",
        path: "python",
      },
    });
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });
});

describe("process-control crash supervision", () => {
  it("does not restart a supervised child after deliberate stop_comfyui", async () => {
    process.env.COMFYUI_ALWAYS_RESTART = "1";
    setLaunchInfo();
    const children = mockSpawnedChildren();
    mockFetchOk(true);

    let portCheckCalls = 0;
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("netstat") || cmd.includes("lsof")) {
        portCheckCalls += 1;
        if (portCheckCalls === 3) {
          if (cmd.includes("netstat"))
            return "  TCP    0.0.0.0:8188   0.0.0.0:0   LISTENING       4321";
          return "4321";
        }
        throw new Error("not listening");
      }
      return "";
    });
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    mockGetSystemStats.mockResolvedValue({
      system: { argv: ["python", "main.py", "--port", "8188"] },
    });

    await startComfyUI();
    const stopResult = await stopComfyUI();
    expect(() => children[0].emit("error", spawnError("late EIO"))).not.toThrow();
    children[0].emit("exit", 1, null);

    expect(stopResult.stopped).toBe(true);
    expect(stopResult.auto_restart?.enabled).toBe(true);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(mockResetClient).toHaveBeenCalled();

    killSpy.mockRestore();
  });

  it("restarts unexpected child exits up to the configured window limit", async () => {
    process.env.COMFYUI_ALWAYS_RESTART = "1";
    process.env.COMFYUI_RESTART_MAX_ATTEMPTS = "2";
    process.env.COMFYUI_RESTART_WINDOW_S = "60";
    setLaunchInfo();
    const children = mockSpawnedChildren();
    mockNoPortProcess();
    mockFetchOk(true);

    const startResult = await startComfyUI();
    children[0].emit("exit", 1, null);
    children[1].emit("exit", 1, null);
    children[2].emit("exit", 1, null);

    expect(startResult.started).toBe(true);
    expect(startResult.auto_restart).toMatchObject({
      enabled: true,
      supported: true,
      max_restarts: 2,
      window_ms: 60000,
    });
    expect(mockSpawn).toHaveBeenCalledTimes(3);
    expect(children).toHaveLength(3);
  });

  it("counts repeated supervised child errors against the restart budget", async () => {
    process.env.COMFYUI_ALWAYS_RESTART = "1";
    process.env.COMFYUI_RESTART_MAX_ATTEMPTS = "2";
    process.env.COMFYUI_RESTART_WINDOW_S = "60";
    setLaunchInfo();
    const children = mockSpawnedChildren();
    mockNoPortProcess();
    mockFetchOk(true);

    const startResult = await startComfyUI();
    expect(() => children[0].emit("error", spawnError("first"))).not.toThrow();
    expect(() => children[1].emit("error", spawnError("second"))).not.toThrow();
    expect(() => children[2].emit("error", spawnError("third"))).not.toThrow();

    expect(startResult.started).toBe(true);
    expect(mockSpawn).toHaveBeenCalledTimes(3);
    expect(children).toHaveLength(3);
  });
});

describe("process-control restart relaunch preflight (#368/#370)", () => {
  // execSync mock that reports a live PID on the port (so the running instance
  // is found) but records any kill so a test can assert the server was NOT taken
  // down.
  function mockLivePortNoKill(): void {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("netstat"))
        return "  TCP    0.0.0.0:8188   0.0.0.0:0   LISTENING       4321";
      if (cmd.includes("lsof")) return "4321";
      // tasklist (desktop detection), taskkill, `if exist`, etc. → nothing found
      return "";
    });
  }

  it("refuses to stop when the resolved script points at a stale install that doesn't exist", async () => {
    mockLivePortNoKill();
    mockGetSystemStats.mockResolvedValue({
      system: { argv: ["C:\\stale\\ComfyUI\\main.py", "--port", "8188"] },
    });
    // The interpreter resolves and exists, but the stale main.py does not.
    mockExistsSync.mockImplementation((p: string) => !/stale/i.test(p));
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await restartComfyUI();

    expect(result.stopped).toBe(false);
    expect(result.started).toBe(false);
    expect(result.message).toMatch(/refusing to restart/i);
    expect(result.message).toMatch(/stale/i);
    // Server must be left running: no relaunch spawn, no kill, no client reset
    // (resetClient only fires inside the stop path).
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(mockResetClient).not.toHaveBeenCalled();
    expect(
      mockExecSync.mock.calls.some(([c]) => /taskkill/i.test(String(c))),
    ).toBe(false);
    expect(killSpy).not.toHaveBeenCalled();

    killSpy.mockRestore();
  });

  it("refuses to stop a Desktop app whose launcher exe cannot be located", async () => {
    mockLivePortNoKill();
    mockGetSystemStats.mockResolvedValue({
      system: {
        argv: [
          "C:\\Users\\x\\AppData\\Local\\Programs\\Comfy Desktop\\resources\\ComfyUI\\main.py",
          "--port",
          "8188",
        ],
      },
    });
    // Nothing exists on disk — the Desktop exe cannot be located.
    mockExistsSync.mockImplementation(() => false);
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await restartComfyUI();

    expect(result.stopped).toBe(false);
    expect(result.started).toBe(false);
    expect(result.message).toMatch(/refusing to restart/i);
    expect(result.message).toMatch(/desktop/i);
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(mockResetClient).not.toHaveBeenCalled();

    killSpy.mockRestore();
  });
});
