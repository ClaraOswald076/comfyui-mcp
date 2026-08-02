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
  // workspace-env (imported transitively for live-first script anchoring)
  // promisifies execFile at module load, so it must be present.
  execFile: vi.fn(),
}));

// assessRelaunch (restart preflight) validates the resolved interpreter/script
// exist on disk. Default: everything exists; a test overrides for the stale-path
// case.
const mockExistsSync = vi.hoisted(() => vi.fn((_p: string) => true));
// statSync drives the spawn-cwd DIRECTORY proof (codex gate: an existing
// regular FILE at COMFYUI_PATH must not become the cwd). Default: a directory.
const mockStatSync = vi.hoisted(() =>
  vi.fn((_p: string) => ({ isDirectory: () => true })),
);
vi.mock("node:fs", () => ({
  existsSync: mockExistsSync,
  statSync: mockStatSync,
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
  parseListenerPidFromNetstat,
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
  mockStatSync.mockImplementation(() => ({ isDirectory: () => true }));
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
        shell: false,
        stdio: "ignore",
        windowsHide: true,
      }),
    );
    // The spawn cwd is the ABSOLUTE anchor the script resolved against (#711):
    // the live script's own install dir when the host parses the Windows argv
    // path (win32), otherwise the configured install dir (POSIX fallback).
    const spawnOpts = mockSpawn.mock.calls[0][2] as { cwd?: string };
    expect(["C:\\ComfyUI", "/fake/ComfyUI"]).toContain(spawnOpts.cwd);
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

  it("omits the spawn cwd when COMFYUI_PATH points at a nonexistent dir (#711)", async () => {
    // A stale/nonexistent COMFYUI_PATH passed as the spawn cwd would ENOENT the
    // relaunch. The fallback must omit cwd instead — the child then inherits
    // this process's (existing) working directory.
    mockConfig.comfyuiPath = "/stale/missing/ComfyUI";
    mockExistsSync.mockImplementation(() => false);
    mockStatSync.mockImplementation(() => {
      throw new Error("ENOENT: no such file or directory");
    });
    setLaunchInfo();
    mockSpawnedChildren();
    mockNoPortProcess();
    mockFetchOk(true);

    const result = await startComfyUI();

    expect(result.started).toBe(true);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const opts = mockSpawn.mock.calls[0][2] as { cwd?: string };
    expect(opts.cwd).toBeUndefined();
  });

  it("omits the spawn cwd when COMFYUI_PATH resolves to a regular FILE (codex gate)", async () => {
    // An existing-but-not-a-directory COMFYUI_PATH passed as the spawn cwd
    // fails ENOTDIR after the server was already stopped — the same
    // lost-server failure class as #711. The fallback must omit cwd.
    mockConfig.comfyuiPath = "/fake/ComfyUI/main.py";
    mockStatSync.mockImplementation(() => ({ isDirectory: () => false }));
    setLaunchInfo();
    mockSpawnedChildren();
    mockNoPortProcess();
    mockFetchOk(true);

    const result = await startComfyUI();

    expect(result.started).toBe(true);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const opts = mockSpawn.mock.calls[0][2] as { cwd?: string };
    expect(opts.cwd).toBeUndefined();
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
          // `lsof -nP -iTCP:PORT -sTCP:LISTEN -Fpn` field output: p<pid> / n<addr:port>.
          return "p4321\nn127.0.0.1:8188\n";
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
      // `lsof -nP -iTCP:PORT -sTCP:LISTEN -Fpn` field output: p<pid> / n<addr:port>.
      if (cmd.includes("lsof")) return "p4321\nn127.0.0.1:8188\n";
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

  it("reboots a local Desktop app via ComfyUI-Manager instead of killing it (#400)", async () => {
    // A Desktop install is Electron-supervised: killing it and re-spawning the
    // exe leaves it down (stopped:true, started:false). It must reboot via the
    // Manager HTTP endpoint and never be killed. The old behavior (refuse when
    // the exe can't be located) no longer applies — the exe is irrelevant now.
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
    // Exe cannot be located on disk — under the old path this refused; now it
    // is never consulted because we reboot via the Manager instead.
    mockExistsSync.mockImplementation(() => false);
    __processControlTestHooks.setRemoteRebootTimingForTests({
      settleMs: 0,
      budgetMs: 1000,
      intervalMs: 5,
    });
    const fetchMock = mockFetchOk(true); // reboot fires + /system_stats ready
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await restartComfyUI();

    expect(result.stopped).toBe(true);
    expect(result.started).toBe(true);
    expect(result.message).toMatch(/rebooted via ComfyUI-Manager/i);
    expect(result.message).toMatch(/Desktop\/supervised/i);
    // Never killed / re-spawned.
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(killSpy).not.toHaveBeenCalled();
    expect(
      mockExecSync.mock.calls.some(([c]) => /taskkill/i.test(String(c))),
    ).toBe(false);
    // The Manager reboot endpoint was hit.
    expect(
      fetchMock.mock.calls.some(([u]) => String(u).includes("/manager/reboot")),
    ).toBe(true);

    killSpy.mockRestore();
  });
});

describe("parseListenerPidFromNetstat — locale-independent port→PID (#449)", () => {
  it("finds the owning PID from an English LISTENING line", () => {
    const out = "  TCP    0.0.0.0:8188   0.0.0.0:0   LISTENING       6789";
    expect(parseListenerPidFromNetstat(out, 8188)).toBe(6789);
  });

  it("finds the PID even when the state word is LOCALIZED (German 'ABHÖREN')", () => {
    // The old detector piped through `findstr LISTENING`; on non-English Windows
    // the state column is translated, so that filter matched nothing and a
    // reachable ComfyUI looked like 'no process on port' (issue #449).
    const out = [
      "Aktive Verbindungen",
      "",
      "  Proto  Lokale Adresse     Remoteadresse      Status      PID",
      "  TCP    0.0.0.0:8188       0.0.0.0:0          ABHÖREN     6789",
    ].join("\n");
    expect(parseListenerPidFromNetstat(out, 8188)).toBe(6789);
  });

  it("matches an IPv6 listener too", () => {
    const out = "  TCP    [::]:8188   [::]:0   ABHÖREN   6789";
    expect(parseListenerPidFromNetstat(out, 8188)).toBe(6789);
  });

  it("IGNORES an outbound/established connection whose REMOTE peer uses the port", () => {
    // Local column is bound to an ephemeral port; only the foreign column shows
    // :8188. Anchoring on the local column must skip this line.
    const out = "  TCP    127.0.0.1:54210   127.0.0.1:8188   HERGESTELLT   4444";
    expect(parseListenerPidFromNetstat(out, 8188)).toBeNull();
  });

  it("does not confuse a superset port (:81880 / :18188) with :8188", () => {
    const out = [
      "  TCP    0.0.0.0:81880   0.0.0.0:0   LISTENING   1111",
      "  TCP    0.0.0.0:18188   0.0.0.0:0   LISTENING   2222",
    ].join("\n");
    expect(parseListenerPidFromNetstat(out, 8188)).toBeNull();
  });

  it("rejects a non-listening row whose LOCAL side is bound to :8188 (foreign endpoint not :0)", () => {
    // An established/outbound socket can have its LOCAL side on :8188 while the
    // server is actually down. A listener always has foreign port 0; requiring
    // that avoids returning (and killing) the wrong PID.
    const out = "  TCP    127.0.0.1:8188   203.0.113.9:55123   HERGESTELLT   9999";
    expect(parseListenerPidFromNetstat(out, 8188)).toBeNull();
  });

  it("still selects the LISTENING row when a live established connection is also present", () => {
    const out = [
      "  TCP    0.0.0.0:8188      0.0.0.0:0          ABHÖREN       6789",
      "  TCP    127.0.0.1:8188    127.0.0.1:55123    HERGESTELLT   6789",
    ].join("\n");
    expect(parseListenerPidFromNetstat(out, 8188)).toBe(6789);
  });
});

describe("findPidByPort resilience to localized netstat state (#449)", () => {
  // IS_WIN is captured from os.platform() at module load, so this test exercises
  // the Windows `netstat` branch only on Windows. On Ubuntu CI findPidByPort
  // takes the `lsof` path and this wiring test is not meaningful — the pure
  // parseListenerPidFromNetstat suite above covers the locale mechanism on every
  // platform. (The reachable-diagnostic tests below are platform-agnostic: they
  // resolve no PID on either branch.)
  const winIt = process.platform === "win32" ? it : it.skip;
  winIt("stop_comfyui finds the listener PID even on non-English Windows", async () => {
    // Realistic German netstat -ano blob: state column is 'ABHÖREN', not
    // 'LISTENING'. The mock emulates the actual shell pipeline — a chained
    // `findstr LISTENING` (the OLD detector) would filter every line out,
    // reproducing the false 'no process on port' failure. The current detector
    // parses `netstat -ano` directly and must still map the port to PID 6789.
    const GERMAN_BLOB = [
      "Aktive Verbindungen",
      "",
      "  Proto  Lokale Adresse     Remoteadresse      Status      PID",
      "  TCP    0.0.0.0:8188       0.0.0.0:0          ABHÖREN     6789",
      "  TCP    [::]:8188          [::]:0             ABHÖREN     6789",
      "  TCP    127.0.0.1:54210    127.0.0.1:8188     HERGESTELLT 4444",
    ].join("\n");

    let killed = false;
    mockExecSync.mockImplementation((cmd: string) => {
      if (/taskkill/i.test(cmd)) {
        killed = true;
        return "";
      }
      if (cmd.includes("netstat")) {
        if (killed) return ""; // port freed after kill → waitForPortFree resolves
        // Emulate the shell: a chained `findstr LISTENING` filters by that word.
        if (/findstr\s+LISTENING/i.test(cmd)) {
          return GERMAN_BLOB.split("\n")
            .filter((l) => l.includes("LISTENING"))
            .join("\n");
        }
        return GERMAN_BLOB;
      }
      if (cmd.includes("lsof")) throw new Error("not listening");
      return ""; // tasklist / powershell fallback / `if exist` → nothing
    });
    mockGetSystemStats.mockResolvedValue({
      system: { argv: ["python", "main.py", "--port", "8188"] },
    });

    const result = await stopComfyUI();

    expect(result.stopped).toBe(true);
    expect(result.message).toContain("6789");
    expect(
      mockExecSync.mock.calls.some(([c]) => /taskkill/i.test(String(c))),
    ).toBe(true);
    expect(mockResetClient).toHaveBeenCalled();
  });

  it("restart reports a REACHABLE diagnostic (not 'no process') when the server answers but no PID maps", async () => {
    // /system_stats answers (server reachable) but every port→PID lookup comes
    // back empty. Liveness is the reachable server, so we must NOT claim the
    // process is absent — and we must NOT take the server down (issue #449).
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("lsof")) throw new Error("not listening");
      return ""; // netstat, powershell, tasklist → nothing resolves a PID
    });
    mockGetSystemStats.mockResolvedValue({
      system: { argv: ["python", "main.py", "--port", "8188"] },
    });
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await restartComfyUI();

    expect(result.stopped).toBe(false);
    expect(result.started).toBe(false);
    expect(result.message).toMatch(/reachable on port 8188/i);
    expect(result.message).not.toMatch(/no comfyui process found/i);
    // Server left untouched: no relaunch, no kill.
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(
      mockExecSync.mock.calls.some(([c]) => /taskkill/i.test(String(c))),
    ).toBe(false);

    killSpy.mockRestore();
  });

  it("reachable-but-no-PID must NOT fall through to killing a Desktop shell (atomic-restart)", async () => {
    // Server answers /system_stats but no port→PID maps, AND a Desktop shell
    // (Comfy Desktop.exe) is present. We must NOT kill that shell — we can't
    // confirm it owns :8188 — so leave everything untouched and diagnose.
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("lsof")) throw new Error("not listening");
      if (/tasklist/i.test(cmd)) {
        // A Comfy Desktop shell IS running.
        return '"Comfy Desktop.exe","4242","Console","1","206,248 K"';
      }
      return ""; // netstat / powershell resolve no listener PID
    });
    mockGetSystemStats.mockResolvedValue({
      system: { argv: ["python", "main.py", "--port", "8188"] },
    });
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await restartComfyUI();

    expect(result.stopped).toBe(false);
    expect(result.started).toBe(false);
    expect(result.message).toMatch(/reachable on port 8188/i);
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(
      mockExecSync.mock.calls.some(([c]) => /taskkill/i.test(String(c))),
    ).toBe(false);
    expect(killSpy).not.toHaveBeenCalled();

    killSpy.mockRestore();
  });
});
