import { execSync, spawn, type ChildProcess } from "node:child_process";
import { platform } from "node:os";
import { isAbsolute, join } from "node:path";
import { getSystemStats, resetClient, resetObjectInfoCache } from "../comfyui/client.js";
import { config, getComfyUIBaseUrl, isRemoteMode } from "../config.js";
import { comfyuiFetch } from "../comfyui/fetch.js";
import { ProcessControlError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { findComfyuiPython } from "./env-capabilities.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ProcessInfo {
  pid: number;
  port: number;
  argv: string[];
  isDesktopApp: boolean;
  desktopExePath?: string;
}

interface StopResult {
  stopped: boolean;
  message: string;
  has_restart_info: boolean;
  auto_restart?: SupervisorResult;
}

interface StartResult {
  started: boolean;
  message: string;
  pid?: number;
  ready?: boolean;
  readiness?: StartupReadinessResult;
  auto_restart?: SupervisorResult;
  spawn_error?: ChildProcessErrorDetails;
}

interface RestartResult {
  stopped: boolean;
  started: boolean;
  message: string;
  ready?: boolean;
  readiness?: StartupReadinessResult;
  auto_restart?: SupervisorResult;
  spawn_error?: ChildProcessErrorDetails;
}

interface StartupReadinessResult {
  ready: boolean;
  timed_out: boolean;
  attempts: number;
  max_tries: number;
  interval_ms: number;
  waited_ms: number;
  probe_url: string;
}

interface SupervisorResult {
  enabled: boolean;
  supported: boolean;
  max_restarts: number;
  window_ms: number;
  restart_count: number;
  gave_up: boolean;
  message?: string;
}

interface RestartPolicy {
  enabled: boolean;
  maxRestarts: number;
  windowMs: number;
}

interface ChildProcessErrorDetails {
  message: string;
  code?: string;
  errno?: number;
  syscall?: string;
  path?: string;
}

// ---------------------------------------------------------------------------
// Module-level state — persists between MCP tool calls within a session
// ---------------------------------------------------------------------------

let lastProcessInfo: ProcessInfo | null = null;
let supervisedChild: ChildProcess | null = null;
let supervisedExitHandler: ((code: number | null, signal: NodeJS.Signals | null) => void) | null = null;
let supervisedErrorHandler: ((err: Error) => void) | null = null;
let supervisorRestartCount = 0;
let supervisorWindowStartedAt = 0;
let supervisorGaveUp = false;

// ---------------------------------------------------------------------------
// Cross-platform helpers
// ---------------------------------------------------------------------------

const IS_WIN = platform() === "win32";

function findPidByPort(port: number): number | null {
  try {
    if (IS_WIN) {
      // netstat -ano | findstr :PORT | findstr LISTENING
      const out = execSync(
        `netstat -ano | findstr :${port} | findstr LISTENING`,
        { encoding: "utf-8", timeout: 5000 },
      ).trim();
      // Lines look like: TCP  0.0.0.0:8188  0.0.0.0:0  LISTENING  12345
      for (const line of out.split("\n")) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 5) {
          const pid = parseInt(parts[parts.length - 1], 10);
          if (!isNaN(pid) && pid > 0) return pid;
        }
      }
    } else {
      const out = execSync(`lsof -ti :${port}`, {
        encoding: "utf-8",
        timeout: 5000,
      }).trim();
      const pid = parseInt(out.split("\n")[0], 10);
      if (!isNaN(pid) && pid > 0) return pid;
    }
  } catch {
    // Command failed — no process on that port
  }
  return null;
}

/**
 * Find PIDs of the Desktop app's Electron shell — current branding
 * ("Comfy Desktop.exe" / "Comfy Desktop.app") and legacy ("ComfyUI.exe" /
 * "ComfyUI.app"). The Python backend is a child of the Electron app, so we
 * need to kill the parent to fully stop the Desktop app.
 */
function findDesktopAppPids(): number[] {
  const pids: number[] = [];
  if (IS_WIN) {
    for (const exe of ["ComfyUI.exe", "Comfy Desktop.exe"]) {
      try {
        const out = execSync(
          `tasklist /FI "IMAGENAME eq ${exe}" /FO CSV /NH`,
          { encoding: "utf-8", timeout: 5000 },
        ).trim();
        for (const line of out.split("\n")) {
          // CSV format: "ComfyUI.exe","12345","Console","1","206,248 K"
          // (the image name is already filtered — match any first column)
          const match = line.match(/^"[^"]+","(\d+)"/);
          if (match) pids.push(parseInt(match[1], 10));
        }
      } catch {
        // No processes with this image name
      }
    }
  } else {
    try {
      const out = execSync(`pgrep -f "ComfyUI.app|Comfy Desktop.app"`, {
        encoding: "utf-8",
        timeout: 5000,
      }).trim();
      for (const line of out.split("\n")) {
        const pid = parseInt(line, 10);
        if (!isNaN(pid) && pid > 0) pids.push(pid);
      }
    } catch {
      // No Desktop app processes found
    }
  }
  return pids;
}

function killProcessTree(pid: number): void {
  try {
    if (IS_WIN) {
      execSync(`taskkill /PID ${pid} /T /F`, {
        encoding: "utf-8",
        timeout: 10000,
      });
    } else {
      // Try SIGTERM first, then SIGKILL after a short wait
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        process.kill(pid, "SIGTERM");
      }
      // Give it a moment, then force kill
      try {
        execSync(`sleep 1 && kill -9 ${pid} 2>/dev/null`, {
          encoding: "utf-8",
          timeout: 5000,
        });
      } catch {
        // Already dead — that's fine
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // "not found" / "no such process" are fine — process already dead
    if (!/not found|no such process|does not exist/i.test(msg)) {
      throw new ProcessControlError(`Failed to kill process ${pid}: ${msg}`);
    }
  }
}

/**
 * Kill the Desktop app entirely — find all Electron shell PIDs and kill each tree.
 * Falls back to killing just the port PID if no Desktop processes found.
 */
function killDesktopApp(portPid: number): void {
  const desktopPids = findDesktopAppPids();
  if (desktopPids.length > 0) {
    logger.info(`Killing Desktop app processes: ${desktopPids.join(", ")}`);
    for (const pid of desktopPids) {
      killProcessTree(pid);
    }
  } else {
    // Fallback — just kill the port process
    killProcessTree(portPid);
  }
}

function isDesktopApp(argv: string[]): boolean {
  const joined = argv.join(" ").toLowerCase();
  return (
    joined.includes("programs/comfyui/resources") ||
    joined.includes("programs\\comfyui\\resources") ||
    joined.includes("comfyui.app") ||
    // Current branding ("Comfy Desktop\Comfy Desktop.exe", "Comfy Desktop.app")
    // and the electron-era install dir.
    joined.includes("comfy desktop") ||
    joined.includes("@comfyorgcomfyui-electron")
  );
}

/**
 * Try to find the ComfyUI Desktop exe from common install locations.
 * Used as a fallback when no process info was previously captured.
 */
function findDesktopExeFromCommonPaths(): string | undefined {
  if (IS_WIN) {
    const home = process.env.LOCALAPPDATA || process.env.USERPROFILE || "";
    const candidates = [
      // Current branding: "Comfy Desktop" (per-machine and per-user installs)
      `C:\\Program Files\\Comfy Desktop\\Comfy Desktop.exe`,
      `${process.env.LOCALAPPDATA}\\Programs\\Comfy Desktop\\Comfy Desktop.exe`,
      // Electron-era install dir
      `${process.env.LOCALAPPDATA}\\Programs\\@comfyorgcomfyui-electron\\ComfyUI.exe`,
      // Legacy names
      `${home}\\Programs\\ComfyUI\\ComfyUI.exe`,
      `${process.env.LOCALAPPDATA}\\Programs\\ComfyUI\\ComfyUI.exe`,
      `C:\\Program Files\\ComfyUI\\ComfyUI.exe`,
    ];
    for (const p of candidates) {
      try {
        const result = execSync(`if exist "${p}" echo found`, { encoding: "utf-8", timeout: 2000 });
        if (result.includes("found")) return p;
      } catch {
        // Not found
      }
    }
  } else {
    // macOS
    const candidates = [
      "/Applications/Comfy Desktop.app",
      `${process.env.HOME}/Applications/Comfy Desktop.app`,
      "/Applications/ComfyUI.app",
      `${process.env.HOME}/Applications/ComfyUI.app`,
    ];
    for (const p of candidates) {
      try {
        execSync(`test -d "${p}"`, { timeout: 2000 });
        return p;
      } catch {
        // Not found
      }
    }
  }
  return undefined;
}

function findDesktopExePath(argv: string[]): string | undefined {
  const joined = argv.join(" ");

  if (IS_WIN) {
    // Look for the main ComfyUI Desktop exe by walking up from the python/main.py path
    // Typical: C:\Users\X\AppData\Local\Programs\ComfyUI\resources\ComfyUI\main.py
    // Desktop exe: C:\Users\X\AppData\Local\Programs\ComfyUI\ComfyUI.exe
    const match = joined.match(
      /([A-Za-z]:[\\\/].*?[\\\/]Programs[\\\/]ComfyUI)[\\\/]resources/i,
    );
    if (match) return `${match[1]}\\ComfyUI.exe`;
  } else {
    // macOS: /Applications/ComfyUI.app/...
    const match = joined.match(/(\/.*?ComfyUI\.app)/);
    if (match) return match[1];
  }
  return undefined;
}

async function waitForPortFree(port: number, timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (findPidByPort(port) === null) return;
    await sleep(500);
  }
  throw new ProcessControlError(
    `Port ${port} still in use after ${timeoutMs / 1000}s`,
  );
}

function parsePositiveNumberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parsePositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : fallback;
}

function getStartupReadinessConfig(): { intervalMs: number; maxTries: number } {
  return {
    intervalMs: Math.round(
      parsePositiveNumberEnv("COMFYUI_STARTUP_CHECK_INTERVAL_S", 1) * 1000,
    ),
    maxTries: parsePositiveIntEnv("COMFYUI_STARTUP_CHECK_MAX_TRIES", 20),
  };
}

function getRestartPolicy(): RestartPolicy {
  const enabled = /^(1|true|yes)$/i.test(process.env.COMFYUI_ALWAYS_RESTART ?? "");
  return {
    enabled,
    maxRestarts: parsePositiveIntEnv("COMFYUI_RESTART_MAX_ATTEMPTS", 3),
    windowMs: Math.round(
      parsePositiveNumberEnv("COMFYUI_RESTART_WINDOW_S", 60) * 1000,
    ),
  };
}

/**
 * Poll `/system_stats` until ComfyUI answers 2xx. This poller is TOLERANT of the
 * down window: a thrown fetch error (ECONNRESET / socket hang up / fetch failed)
 * and any non-2xx (including a 502/503/504 from a proxy/tunnel in front of a
 * killed origin) are all swallowed and treated as "not ready yet — keep polling".
 * That property is what lets the same routine cover both a locally-spawned start
 * and a remote ComfyUI-Manager reboot (where ComfyUI briefly disappears).
 *
 * `cfg` overrides the interval/try budget — the local start uses the short
 * env-tuned default; the remote reboot passes a longer budget.
 */
async function waitForApiReady(
  cfg?: { intervalMs: number; maxTries: number },
): Promise<StartupReadinessResult> {
  const { intervalMs, maxTries } = cfg ?? getStartupReadinessConfig();
  const probeUrl = `${getComfyUIBaseUrl()}/system_stats`;
  const start = Date.now();
  let attempts = 0;

  for (; attempts < maxTries; attempts++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000);
      let res: Response;
      try {
        res = await comfyuiFetch(probeUrl, { signal: controller.signal });
      } finally {
        clearTimeout(timeout);
      }
      if (res.ok) {
        logger.info("ComfyUI API is ready");
        return {
          ready: true,
          timed_out: false,
          attempts: attempts + 1,
          max_tries: maxTries,
          interval_ms: intervalMs,
          waited_ms: Date.now() - start,
          probe_url: probeUrl,
        };
      }
    } catch {
      // Not ready yet
    }
    if (attempts < maxTries - 1) await sleep(intervalMs);
  }

  return {
    ready: false,
    timed_out: true,
    attempts,
    max_tries: maxTries,
    interval_ms: intervalMs,
    waited_ms: Date.now() - start,
    probe_url: probeUrl,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function detachSupervisor(): void {
  if (supervisedChild && supervisedExitHandler) {
    supervisedChild.off("exit", supervisedExitHandler);
  }
  if (supervisedChild && supervisedErrorHandler) {
    supervisedChild.off("error", supervisedErrorHandler);
  }
  supervisedChild = null;
  supervisedExitHandler = null;
  supervisedErrorHandler = null;
}

function childProcessErrorDetails(err: unknown): ChildProcessErrorDetails {
  if (!(err instanceof Error)) return { message: String(err) };
  const nodeErr = err as NodeJS.ErrnoException;
  return {
    message: err.message,
    code: typeof nodeErr.code === "string" ? nodeErr.code : undefined,
    errno: typeof nodeErr.errno === "number" ? nodeErr.errno : undefined,
    syscall: typeof nodeErr.syscall === "string" ? nodeErr.syscall : undefined,
    path: typeof nodeErr.path === "string" ? nodeErr.path : undefined,
  };
}

function supervisorResult(info?: ProcessInfo): SupervisorResult {
  const policy = getRestartPolicy();
  return {
    enabled: policy.enabled,
    supported: Boolean(info && !info.isDesktopApp),
    max_restarts: policy.maxRestarts,
    window_ms: policy.windowMs,
    restart_count: supervisorRestartCount,
    gave_up: supervisorGaveUp,
    message: !policy.enabled
      ? "Auto-restart is disabled."
      : info?.isDesktopApp
        ? "Auto-restart supervision is only supported for directly spawned Python ComfyUI processes."
        : undefined,
  };
}

function rememberRestartAttempt(policy: RestartPolicy): boolean {
  const now = Date.now();
  if (supervisorWindowStartedAt === 0 || now - supervisorWindowStartedAt > policy.windowMs) {
    supervisorWindowStartedAt = now;
    supervisorRestartCount = 0;
    supervisorGaveUp = false;
  }

  if (supervisorRestartCount >= policy.maxRestarts) {
    supervisorGaveUp = true;
    return false;
  }

  supervisorRestartCount += 1;
  return true;
}

function spawnFromProcessInfo(info: ProcessInfo): ChildProcess | null {
  if (info.isDesktopApp) {
    if (IS_WIN) {
      const exe = info.desktopExePath;
      if (!exe) return null;
      return spawn(exe, [], {
        detached: true,
        stdio: "ignore",
        shell: false,
      });
    }

    const appPath = info.desktopExePath ?? "ComfyUI";
    return spawn("open", ["-a", appPath], {
      detached: true,
      stdio: "ignore",
    });
  }

  const cmd = resolveLaunchCommand(info);
  if (!cmd) return null;
  return spawn(cmd.exe, cmd.args, {
    detached: true,
    stdio: "ignore",
    cwd: config.comfyuiPath ?? undefined,
    shell: false,
    windowsHide: true,
  });
}

/**
 * Turn captured process info into a spawnable (executable, args) pair.
 *
 * The argv we save comes from ComfyUI's `/system_stats` — i.e. Python's
 * `sys.argv`, whose argv[0] is the SCRIPT path (`…/main.py`), NOT the Python
 * interpreter. Spawning that script directly with `shell:false` fails on
 * Windows with `spawn EFTYPE` (the OS cannot exec a `.py` as a PE binary),
 * which is exactly the restart_comfyui relaunch failure in #330. When argv[0]
 * is a script we resolve the real ComfyUI Python interpreter and pass the whole
 * argv (main.py + flags) as its args. When argv[0] is already an interpreter
 * (e.g. a supervised child we spawned ourselves), we spawn it verbatim.
 */
function resolveLaunchCommand(
  info: ProcessInfo,
): { exe: string; args: string[] } | null {
  if (info.argv.length === 0) return null;
  const [first, ...rest] = info.argv;
  const looksLikeScript = /\.pyw?$/i.test(first.trim());
  if (looksLikeScript) {
    const python = findComfyuiPython(config.comfyuiPath ?? undefined, info.argv);
    if (!python) return null;
    // sys.argv[0] can be RELATIVE (the standard Windows portable launcher runs
    // `python ComfyUI\main.py` from the portable root). We force cwd to
    // config.comfyuiPath — the ComfyUI dir that directly holds main.py — so a
    // relative script would resolve against the wrong dir (…/ComfyUI/ComfyUI/
    // main.py). Anchor it: use the absolute path as-is, otherwise main.py under
    // the resolved ComfyUI root.
    //
    // The argv mirrors the running ComfyUI's sys.argv, which is Windows-flavored
    // when ComfyUI runs on Windows — regardless of what OS this process is on.
    // So detect absoluteness and the script basename in a separator-agnostic way
    // rather than trusting the host `path` module (which mangles `C:\…` / `\`
    // paths on POSIX). The final join stays host-native to match comfyuiPath.
    const isWindowsAbsolute =
      /^[a-zA-Z]:[\\/]/.test(first) || /^\\\\/.test(first);
    const scriptBasename = first.split(/[\\/]/).pop() || first;
    const script =
      isAbsolute(first) || isWindowsAbsolute || !config.comfyuiPath
        ? first
        : join(config.comfyuiPath, scriptBasename);
    return { exe: python, args: [script, ...rest] };
  }
  return { exe: first, args: rest };
}

function handleSupervisedChildStop(
  child: ChildProcess,
  reason: {
    code?: number | null;
    signal?: NodeJS.Signals | null;
    error?: ChildProcessErrorDetails;
  },
): void {
  if (supervisedChild !== child) return;
  detachSupervisor();

  if (!lastProcessInfo) return;
  const currentPolicy = getRestartPolicy();
  if (!currentPolicy.enabled) return;

  if (!rememberRestartAttempt(currentPolicy)) {
    logger.warn("ComfyUI exited unexpectedly; auto-restart limit reached", {
      code: reason.code,
      signal: reason.signal,
      error: reason.error,
      maxRestarts: currentPolicy.maxRestarts,
      windowMs: currentPolicy.windowMs,
    });
    return;
  }

  logger.warn("ComfyUI exited unexpectedly; restarting", {
    code: reason.code,
    signal: reason.signal,
    error: reason.error,
    restartCount: supervisorRestartCount,
    maxRestarts: currentPolicy.maxRestarts,
  });

  const restarted = spawnFromProcessInfo(lastProcessInfo);
  if (!restarted) {
    logger.warn("Could not auto-restart ComfyUI because launch info was incomplete");
    return;
  }
  restarted.unref();
  superviseChild(restarted, lastProcessInfo);
}

function captureChildProcessError(
  child: ChildProcess,
): Promise<ChildProcessErrorDetails> {
  return new Promise((resolve) => {
    child.once("error", (err) => {
      const error = childProcessErrorDetails(err);
      logger.error("ComfyUI child process emitted an error", { error });
      resolve(error);
    });
  });
}

function superviseChild(child: ChildProcess, info: ProcessInfo): void {
  detachSupervisor();
  const policy = getRestartPolicy();
  if (!policy.enabled || info.isDesktopApp) return;

  supervisedChild = child;
  supervisedExitHandler = (code, signal) => {
    handleSupervisedChildStop(child, { code, signal });
  };
  supervisedErrorHandler = (err) => {
    const error = childProcessErrorDetails(err);
    logger.error("ComfyUI child process emitted an error", { error });
    handleSupervisedChildStop(child, { error });
  };
  child.on("exit", supervisedExitHandler);
  child.once("error", supervisedErrorHandler);
}

// ---------------------------------------------------------------------------
// Gather process info from running ComfyUI
// ---------------------------------------------------------------------------

async function gatherProcessInfo(): Promise<ProcessInfo> {
  const port = config.resolvedPort;

  // 1. Get argv from /system_stats
  let argv: string[] = [];
  try {
    const stats = await getSystemStats();
    argv = stats.system.argv ?? [];
  } catch {
    logger.warn("Could not fetch system_stats — will rely on PID detection");
  }

  // 2. Find PID by port
  const pid = findPidByPort(port);
  if (!pid) {
    throw new ProcessControlError(
      `No process found listening on port ${port}. Is ComfyUI running?`,
    );
  }

  const desktop = isDesktopApp(argv);
  const desktopExe = desktop ? findDesktopExePath(argv) : undefined;

  return { pid, port, argv, isDesktopApp: desktop, desktopExePath: desktopExe };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function stopComfyUI(): Promise<StopResult> {
  if (isRemoteMode()) {
    throw new ProcessControlError(
      "stop_comfyui operates on the local machine's ComfyUI process and is not " +
        "available when targeting a remote instance via --comfyui-url.",
    );
  }
  logger.info("Stopping ComfyUI...");
  detachSupervisor();

  // Gather info before we kill it
  let info: ProcessInfo;
  try {
    info = await gatherProcessInfo();
  } catch (err) {
    // API and port are dead — try OS-level Desktop app detection
    const desktopPids = findDesktopAppPids();
    if (desktopPids.length > 0) {
      logger.info(`API unreachable but found Desktop app PIDs: ${desktopPids.join(", ")}`);
      const port = config.resolvedPort;
      info = {
        pid: desktopPids[0],
        port,
        argv: [],
        isDesktopApp: true,
        desktopExePath: findDesktopExeFromCommonPaths(),
      };
    } else {
      return {
        stopped: false,
        message:
          err instanceof ProcessControlError
            ? err.message
            : `Failed to find ComfyUI process: ${err}`,
        has_restart_info: false,
      };
    }
  }

  // Save for later start
  lastProcessInfo = info;
  logger.info("Captured process info", {
    pid: info.pid,
    port: info.port,
    isDesktopApp: info.isDesktopApp,
    argv: info.argv.join(" "),
  });

  // Kill process tree (for Desktop app, kill the Electron shell too)
  if (info.isDesktopApp) {
    killDesktopApp(info.pid);
  } else {
    killProcessTree(info.pid);
  }

  // Reset the WebSocket client singleton + the memoized /object_info —
  // a restart is exactly when the node set may have changed.
  resetClient();
  resetObjectInfoCache();

  // Wait for port to actually free
  try {
    await waitForPortFree(info.port);
  } catch {
    logger.warn("Port did not free in time, but process kill was sent");
  }

  return {
    stopped: true,
    message: `ComfyUI (PID ${info.pid}) stopped on port ${info.port}`,
    has_restart_info: true,
    auto_restart: supervisorResult(info),
  };
}

export async function startComfyUI(): Promise<StartResult> {
  if (isRemoteMode()) {
    throw new ProcessControlError(
      "start_comfyui launches ComfyUI on the local machine and is not " +
        "available when targeting a remote instance via --comfyui-url.",
    );
  }
  const port = config.resolvedPort;

  // Check if already running
  const existingPid = findPidByPort(port);
  if (existingPid) {
    return {
      started: false,
      message: `ComfyUI is already running on port ${port} (PID ${existingPid})`,
      pid: existingPid,
    };
  }

  let info = lastProcessInfo;
  if (!info) {
    // No saved info — try to detect and launch the Desktop app
    const desktopExe = findDesktopExeFromCommonPaths();
    if (desktopExe) {
      logger.info(`No saved process info, but found Desktop app at: ${desktopExe}`);
      info = {
        pid: 0,
        port,
        argv: [],
        isDesktopApp: true,
        desktopExePath: desktopExe,
      };
    } else {
      return {
        started: false,
        message:
          "No previous process info and could not find ComfyUI Desktop app. Start ComfyUI manually.",
      };
    }
  }

  logger.info("Starting ComfyUI...", {
    isDesktopApp: info.isDesktopApp,
    argv: info.argv.join(" "),
  });

  const launched = spawnFromProcessInfo(info);
  if (!launched) {
    return {
      started: false,
      message: info.isDesktopApp
        ? "Could not determine ComfyUI Desktop executable path. Please start it manually."
        : "No command-line info captured from previous run. Start ComfyUI manually.",
      auto_restart: supervisorResult(info),
    };
  }
  const spawnError = captureChildProcessError(launched);
  launched.unref();
  lastProcessInfo = info;
  superviseChild(launched, info);

  // Wait for API to become ready
  const startupResult = await Promise.race([
    waitForApiReady().then((readiness) => ({ readiness })),
    spawnError.then((error) => ({ spawn_error: error })),
  ]);
  if ("spawn_error" in startupResult) {
    return {
      started: false,
      ready: false,
      message:
        `ComfyUI process failed to launch: ${startupResult.spawn_error.message}`,
      spawn_error: startupResult.spawn_error,
      auto_restart: supervisorResult(info),
    };
  }

  const readiness = startupResult.readiness;
  if (!readiness.ready) {
    return {
      started: false,
      ready: false,
      readiness,
      message:
        `ComfyUI process was launched but the API did not become ready after ${readiness.waited_ms}ms (${readiness.attempts}/${readiness.max_tries} probes). Check the ComfyUI logs.`,
      auto_restart: supervisorResult(info),
    };
  }

  const newPid = findPidByPort(port);
  return {
    started: true,
    ready: true,
    readiness,
    message: `ComfyUI started on port ${port}${newPid ? ` (PID ${newPid})` : ""}`,
    pid: newPid ?? undefined,
    auto_restart: supervisorResult(info),
  };
}

// ---------------------------------------------------------------------------
// Remote restart — reboot a remote/tunnelled ComfyUI through ComfyUI-Manager.
//
// A locally-spawned ComfyUI is restarted by killing + relaunching the process.
// A REMOTE ComfyUI (reached via --comfyui-url, e.g. a Cloudflare-tunnelled
// ComfyUI Desktop app) can't be process-controlled from here — but ComfyUI
// Desktop self-supervises, so a ComfyUI-Manager HTTP reboot DOES bring it back.
// We fire that reboot and poll readiness instead of throwing.
// ---------------------------------------------------------------------------

interface RebootResult {
  rebooting: boolean;
  endpoint?: string;
  method?: string;
  reason?: string;
  note?: string;
}

// Match the repo's Manager path convention (node-management.ts appends these to
// getComfyUIBaseUrl() with no `/api` prefix — the panel's `/api/...` form is only
// because its browser `api.fetchApi` prepends `/api`). Canonical v4 POST route
// first, then the legacy GET route for older Manager builds.
const REBOOT_ROUTES: ReadonlyArray<{ path: string; method: "POST" | "GET" }> = [
  { path: "/v2/manager/reboot", method: "POST" },
  { path: "/manager/reboot", method: "GET" },
];

/**
 * A dropped/aborted connection is the SUCCESS signal for a reboot: the Manager
 * handler calls exit(0) the instant it accepts the request, so the origin dies
 * before it can send an HTTP response and `fetch` rejects.
 */
function isConnectionDrop(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  // NOTE: ECONNREFUSED is deliberately absent — it means "nothing is listening"
  // (the origin was ALREADY down before we called), not "we killed it mid-request".
  // A process reboot we caused surfaces as ECONNRESET / socket-hang-up / terminated.
  return /ECONNRESET|socket hang up|fetch failed|network|ECONNABORTED|EPIPE|terminated|premature close|other side closed|aborted/i.test(
    msg,
  );
}

/**
 * Fire a ComfyUI-Manager reboot over HTTP against the connected (remote) base URL.
 * Classification:
 *   FIRED   (rebooting:true)  — res.ok (2xx) OR a connection drop OR HTTP 502/503/504.
 *                               A killed origin behind a proxy/Cloudflare surfaces
 *                               as a 5xx bad-gateway (NOT a raw socket drop), so we
 *                               must treat those as "reboot fired" too.
 *   REFUSED (rebooting:false) — HTTP 403 → Manager security forbids remote reboot.
 *   NO-ENDPOINT (rebooting:false) — every route gave a non-firing failure (e.g. 404).
 */
async function rebootViaManager(): Promise<RebootResult> {
  const base = getComfyUIBaseUrl();
  const failures: string[] = [];

  for (const { path, method } of REBOOT_ROUTES) {
    const url = `${base}${path}`;
    try {
      const res = await comfyuiFetch(url, { method });
      if (res.ok) return { rebooting: true, endpoint: path, method };
      if (res.status === 403) {
        return {
          rebooting: false,
          reason: "manager-security",
          note:
            "Reboot refused (HTTP 403) — ComfyUI-Manager's security level (or an " +
            "access proxy in front) forbids it; lower the Manager security level or reboot on the host.",
        };
      }
      if (res.status === 502 || res.status === 503 || res.status === 504) {
        return {
          rebooting: true,
          endpoint: path,
          method,
          note: `reboot fired — the origin dropped behind a proxy (HTTP ${res.status}) as it went down`,
        };
      }
      // 404 / other non-OK: wrong route for this Manager build — try the next.
      failures.push(`${method} ${path} → HTTP ${res.status}`);
    } catch (err) {
      if (isConnectionDrop(err)) {
        return {
          rebooting: true,
          endpoint: path,
          method,
          note: "connection dropped (origin going down) — reboot fired",
        };
      }
      failures.push(
        `${method} ${path} → ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return {
    rebooting: false,
    reason: "no-endpoint",
    note: `No reachable ComfyUI-Manager reboot endpoint.${
      failures.length ? ` Tried: ${failures.join("; ")}` : ""
    }`,
  };
}

interface RemoteRebootTiming {
  /** Grace pause after firing before we start probing (lets the origin actually go down). */
  settleMs: number;
  /** Total readiness budget. */
  budgetMs: number;
  /** Interval between readiness probes. */
  intervalMs: number;
}

let remoteRebootTimingOverride: RemoteRebootTiming | null = null;

function getRemoteRebootTiming(): RemoteRebootTiming {
  if (remoteRebootTimingOverride) return remoteRebootTimingOverride;
  return {
    settleMs: Math.round(
      parsePositiveNumberEnv("COMFYUI_REMOTE_REBOOT_SETTLE_S", 3) * 1000,
    ),
    budgetMs: Math.round(
      parsePositiveNumberEnv("COMFYUI_REMOTE_REBOOT_BUDGET_S", 120) * 1000,
    ),
    intervalMs: Math.round(
      parsePositiveNumberEnv("COMFYUI_REMOTE_REBOOT_INTERVAL_S", 2) * 1000,
    ),
  };
}

async function restartRemoteViaManager(): Promise<RestartResult> {
  logger.info("Restarting remote ComfyUI via ComfyUI-Manager reboot...");

  const reboot = await rebootViaManager();
  if (!reboot.rebooting) {
    return {
      stopped: false,
      started: false,
      message: reboot.note ?? "ComfyUI-Manager reboot could not be triggered.",
    };
  }

  logger.info("ComfyUI-Manager reboot fired", {
    endpoint: reboot.endpoint,
    method: reboot.method,
    note: reboot.note,
  });

  const timing = getRemoteRebootTiming();
  if (timing.settleMs > 0) await sleep(timing.settleMs);

  // Clamp the interval to a sane floor: a 0 (or tiny) env value would make
  // maxTries unbounded (ceil(budget/0) = Infinity) and hot-loop the poller,
  // hanging the tool call if the host never returns.
  const intervalMs = Math.max(250, timing.intervalMs);
  const maxTries = Math.max(1, Math.ceil(timing.budgetMs / intervalMs));
  const readiness = await waitForApiReady({ intervalMs, maxTries });

  if (!readiness.ready) {
    return {
      stopped: true,
      started: false,
      ready: false,
      readiness,
      message:
        `Reboot was triggered but ComfyUI did not come back within ${timing.budgetMs}ms — ` +
        "check the host (is it the Desktop app / supervised?).",
    };
  }

  // Back and ready — refresh the WS client singleton + memoized /object_info,
  // since a reboot is exactly when the node set may have changed.
  resetClient();
  resetObjectInfoCache();

  return {
    stopped: true,
    started: true,
    ready: true,
    readiness,
    message:
      `ComfyUI rebooted via ComfyUI-Manager and came back ready (${readiness.waited_ms}ms) — ` +
      "remote/supervised restart.",
  };
}

export async function restartComfyUI(): Promise<RestartResult> {
  if (isRemoteMode()) {
    // Remote target: can't process-control it, but a Manager HTTP reboot brings
    // back a self-supervised ComfyUI (e.g. the tunnelled Desktop app).
    return restartRemoteViaManager();
  }
  logger.info("Restarting ComfyUI...");

  // Stop
  const stopResult = await stopComfyUI();
  if (!stopResult.stopped) {
    return {
      stopped: false,
      started: false,
      message: `Could not stop ComfyUI: ${stopResult.message}`,
    };
  }

  // Brief pause to let OS fully release resources
  await sleep(1000);

  // Start
  const startResult = await startComfyUI();
  if (!startResult.started) {
    return {
      stopped: true,
      started: false,
      ready: startResult.ready,
      readiness: startResult.readiness,
      message: `ComfyUI was stopped but could not be started: ${startResult.message}`,
      auto_restart: startResult.auto_restart,
      spawn_error: startResult.spawn_error,
    };
  }

  return {
    stopped: true,
    started: true,
    ready: startResult.ready,
    readiness: startResult.readiness,
    message: `ComfyUI restarted successfully. ${startResult.message}`,
    auto_restart: startResult.auto_restart,
  };
}

export const __processControlTestHooks = {
  reset(): void {
    detachSupervisor();
    lastProcessInfo = null;
    supervisorRestartCount = 0;
    supervisorWindowStartedAt = 0;
    supervisorGaveUp = false;
    remoteRebootTimingOverride = null;
  },
  setLastProcessInfo(info: ProcessInfo): void {
    lastProcessInfo = info;
  },
  /** Inject fast remote-reboot timing so tests don't wait the real ~120s budget. */
  setRemoteRebootTimingForTests(timing: RemoteRebootTiming | null): void {
    remoteRebootTimingOverride = timing;
  },
};
