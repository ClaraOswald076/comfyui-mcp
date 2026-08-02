import { execSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, readlinkSync, statSync } from "node:fs";
import { platform } from "node:os";
import { isAbsolute, join } from "node:path";
import { getSystemStats, resetClient, resetObjectInfoCache } from "../comfyui/client.js";
import { config, getComfyUIBaseUrl, isRemoteMode } from "../config.js";
import { comfyuiFetch } from "../comfyui/fetch.js";
import { ProcessControlError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { findComfyuiPython } from "./env-capabilities.js";
import { resetManagerApiCache } from "./manager-api-cache.js";
import { parseListenerPidFromNetstat, findPidByPort } from "./port-owner.js";
import {
  recordLaunchedInterpreter,
  clearLaunchedInterpreter,
} from "./live-interpreter.js";
import {
  liveRootFromArgv,
  resolveEffectiveComfyUIBase,
  markLocalComfyUILaunched,
  resetLocalComfyUILaunchState,
} from "./workspace-env.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ProcessInfo {
  pid: number;
  port: number;
  argv: string[];
  isDesktopApp: boolean;
  desktopExePath?: string;
  /**
   * The live ComfyUI process's working directory, captured at gather-time while
   * the process is still ALIVE (a known-good moment). Used to resolve a RELATIVE
   * launch script (`python main.py`) to an absolute path so relaunch works
   * regardless of the orchestrator's own cwd — and, crucially, still resolves
   * after the stop kills the pid (when `/proc/<pid>/cwd` is gone) (#535).
   */
  liveCwd?: string;
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

// parseListenerPidFromNetstat / findPidByPort now live in port-owner.ts so the
// live-interpreter resolver can use them without importing this module (which would
// cycle through workspace-env). Re-exported here: this is still their public home.
export { parseListenerPidFromNetstat, findPidByPort };

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
    // Default budget is 60s (was 20s). ComfyUI with a normal set of custom nodes
    // routinely takes >20s to answer /system_stats on a cold start, so a 20-probe
    // budget reported `started:false` moments before a healthy instance became
    // ready (issue #367). Tunable via COMFYUI_STARTUP_CHECK_MAX_TRIES.
    maxTries: parsePositiveIntEnv("COMFYUI_STARTUP_CHECK_MAX_TRIES", 60),
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

interface SpawnedComfyUI {
  child: ChildProcess;
}

let recordedLaunchChild: ChildProcess | undefined;

function adoptLaunchedChild(child: ChildProcess): void {
  recordedLaunchChild = child;
  // Env-trust ONLY (#633 P1b) — the launched interpreter itself is recorded by
  // spawnFromProcessInfo via recordLaunchedInterpreter (live-interpreter.ts), the
  // single launch record, and trusted only after PID + creation-time validation.
  markLocalComfyUILaunched();
  const clearIfCurrent = (): void => {
    if (recordedLaunchChild !== child) return;
    recordedLaunchChild = undefined;
    resetLocalComfyUILaunchState();
    // Same fail-closed reasoning for the recorded interpreter: once our child is
    // gone, a successor on that port may run a DIFFERENT python (#401).
    clearLaunchedInterpreter();
  };
  child.once("exit", clearIfCurrent);
  child.once("error", clearIfCurrent);
}

function spawnFromProcessInfo(info: ProcessInfo): SpawnedComfyUI | null {
  if (info.isDesktopApp) {
    if (IS_WIN) {
      const exe = info.desktopExePath;
      if (!exe) return null;
      return { child: spawn(exe, [], { detached: true, stdio: "ignore", shell: false }) };
    }

    const appPath = info.desktopExePath ?? "ComfyUI";
    return { child: spawn("open", ["-a", appPath], { detached: true, stdio: "ignore" }) };
  }

  const cmd = resolveLaunchCommand(info);
  if (!cmd) return null;
  const child = spawn(cmd.exe, cmd.args, {
    detached: true,
    stdio: "ignore",
    // Prefer the cwd the command resolved against (the live process cwd or the
    // absolute install anchor for a relaunch, #535/#711); only then the
    // configured install dir — and only as an ABSOLUTE path that exists on disk.
    // A stale/relative/nonexistent config.comfyuiPath as cwd would ENOENT the
    // spawn (#711); omitting cwd inherits this process's (existing) working dir.
    cwd: cmd.cwd ?? configuredInstallCwd(),
    shell: false,
    windowsHide: true,
  });
  // GROUND TRUTH for #401: we chose this interpreter, so we KNOW which python the
  // server runs — no layout inference required. Keyed to the PID so it is discarded
  // the moment a different process owns the port. (Desktop-app launches return
  // above: that exe is a launcher, not an interpreter.)
  if (child.pid) recordLaunchedInterpreter(child.pid, cmd.exe);
  return { child };
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
/**
 * The ABSOLUTE ComfyUI dir (the one directly holding `main.py`) to anchor a
 * RELATIVE sys.argv[0] against, resolved LIVE-FIRST and consistently with the
 * canonical base download_model / the environment services already use (#476,
 * #426). Order, most-trustworthy first:
 *   1. the LIVE running server's own argv-derived install root (absolute argv[0]);
 *   2. the canonical effective base — COMFYUI_PATH or the saved default workspace
 *      — i.e. the exact absolute install download_model wrote into in the same
 *      session (resolveEffectiveComfyUIBase);
 *   3. config.comfyuiPath, when absolute, as a last resort.
 * Returns undefined only when none is absolute; callers then fall back to the raw
 * (possibly relative) argv and the refuse-safe preflight refuses a genuinely
 * unresolvable install.
 */
function resolveScriptAnchor(argv: string[]): string | undefined {
  const live = liveRootFromArgv(argv);
  if (live && isAbsolute(live)) return live;
  const base = resolveEffectiveComfyUIBase();
  if (base && isAbsolute(base)) return base;
  if (config.comfyuiPath && isAbsolute(config.comfyuiPath)) {
    return config.comfyuiPath;
  }
  return undefined;
}

/**
 * The live process's own working directory — the most authoritative anchor for a
 * RELATIVE launch script. A ComfyUI launched as `python main.py …` has argv[0] =
 * `main.py` with no path root, an unset/stale COMFYUI_PATH gives no canonical base,
 * and no absolute argv root exists — so every anchor in resolveScriptAnchor comes
 * up empty and restart refuses, even though the reachable process's cwd points at a
 * valid install containing main.py (#535). On Linux we read `/proc/<pid>/cwd`. This
 * MUST be captured while the process is still alive (gatherProcessInfo) because the
 * symlink vanishes the instant the pid is killed; other OSes have no cheap /proc
 * equivalent and return undefined (the existing refuse-safe fallback still applies).
 */
let liveCwdResolverOverride: ((pid: number) => string | undefined) | null = null;

function resolveLiveProcessCwd(pid: number): string | undefined {
  if (liveCwdResolverOverride) return liveCwdResolverOverride(pid);
  if (!pid || IS_WIN) return undefined;
  try {
    const cwd = readlinkSync(`/proc/${pid}/cwd`);
    return cwd && isAbsolute(cwd) ? cwd : undefined;
  } catch {
    return undefined;
  }
}

function resolveLaunchCommand(
  info: ProcessInfo,
): { exe: string; args: string[]; cwd?: string } | null {
  if (info.argv.length === 0) return null;
  const [first, ...rest] = info.argv;
  // Strip surrounding quotes a launcher may leave on the script path BEFORE the
  // suffix test — otherwise `"C:\…\main.py"` fails the `.py` check, bypasses the
  // unified live-first resolver, and gets treated as the executable (#401 / PR #433
  // round 3). Kept in sync with liveRootFromArgv's quote handling.
  const firstUnquoted = first.trim().replace(/^["']+/, "").replace(/["']+$/, "");
  const looksLikeScript = /\.pyw?$/i.test(firstUnquoted);
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
      /^[a-zA-Z]:[\\/]/.test(firstUnquoted) || /^\\\\/.test(firstUnquoted);
    const scriptBasename = firstUnquoted.split(/[\\/]/).pop() || firstUnquoted;
    // LIVE-FIRST anchor for a RELATIVE argv[0]: resolve the canonical ABSOLUTE
    // ComfyUI dir the same way download_model / the env services do, so restart
    // never refuses on a stale/relative COMFYUI_PATH while the reachable install
    // lives elsewhere (#476, #426). config.comfyuiPath is only ONE input to that
    // canonical base (which also honors the saved default workspace), so anchor
    // to the base — not to config.comfyuiPath directly. When no absolute anchor
    // exists we keep the raw (possibly relative) script and let assessRelaunch's
    // refuse-safe preflight catch a truly unresolvable install.
    const anchor = resolveScriptAnchor(info.argv);
    const scriptIsAbsolute = isAbsolute(firstUnquoted) || isWindowsAbsolute;
    // LIVE-CWD anchor (#535): before falling back to the canonical base, resolve a
    // RELATIVE script against the running process's OWN cwd (captured live, so it
    // survives the stop that kills the pid). Two hard requirements keep the stop
    // refuse-safe and env-consistent:
    //   1. Both the script AND the interpreter must be resolved from the SAME live
    //      cwd — never pair a live-cwd script with a stale COMFYUI_PATH's python,
    //      which would relaunch the live server under the wrong environment (codex
    //      round-2 P1). So the interpreter is re-resolved with the live cwd as its
    //      search root (finds that install's own venv/embedded python).
    //   2. Both must be validated as REGULAR FILES (not just existsSync): a dir
    //      named `main.py`, or a dir at the interpreter path, must NOT unlock a kill
    //      we can't actually exec afterward (codex round-2 P1).
    // Split into segments + re-join so a Windows `ComfyUI\main.py` normalizes to
    // host-native separators on a POSIX host instead of a literal one-segment name.
    const relSegments = firstUnquoted.split(/[\\/]/).filter(Boolean);
    let liveCwdScript: string | undefined;
    let liveCwdPython: string | undefined;
    if (!scriptIsAbsolute && info.liveCwd && relSegments.length > 0) {
      const candidateScript = join(info.liveCwd, ...relSegments);
      const candidatePython = findComfyuiPython(info.liveCwd, info.argv);
      const pythonIsAbsolute =
        !!candidatePython &&
        (isAbsolute(candidatePython) || /^[a-zA-Z]:[\\/]/.test(candidatePython));
      if (
        isRegularFile(candidateScript) &&
        pythonIsAbsolute &&
        isRegularFile(candidatePython)
      ) {
        liveCwdScript = candidateScript;
        liveCwdPython = candidatePython;
      }
    }
    const script = scriptIsAbsolute
      ? firstUnquoted
      : liveCwdScript
        ? liveCwdScript
        : anchor
          ? join(anchor, scriptBasename)
          : firstUnquoted;
    // When the script was anchored to the LIVE cwd, use that install's OWN python
    // and spawn FROM that cwd — never a stale/nonexistent config.comfyuiPath, which
    // would ENOENT the spawn after the server was already killed (#535). An
    // absolute / canonical-base script spawns from its OWN anchor dir the same way
    // (#711): the anchor is the absolute install root the script was resolved
    // against, so the relaunch never depends on a wrong/undefined working
    // directory. Only an UNANCHORED relative script leaves cwd unset — the
    // refuse-safe preflight (#476/#426) rejects that case before any stop.
    const exe = liveCwdScript ? liveCwdPython! : python;
    const cwd = liveCwdScript ? info.liveCwd : anchor;
    return { exe, args: [script, ...rest], cwd };
  }
  return { exe: first, args: rest };
}

function fileExists(p: string | undefined): boolean {
  if (!p) return false;
  try {
    return existsSync(p);
  } catch {
    return false;
  }
}

/**
 * config.comfyuiPath as a spawn cwd — only when it is an ABSOLUTE path to an
 * existing DIRECTORY. A stale, relative, or nonexistent COMFYUI_PATH passed as
 * cwd would ENOENT the spawn after the server was already stopped (#711), and
 * a path that resolves to a regular FILE fails the same way (ENOTDIR) — both
 * recreate the lost-server failure this guard exists to prevent (codex gate).
 * Callers then omit cwd and the child inherits this process's (existing)
 * working dir.
 */
function configuredInstallCwd(): string | undefined {
  if (!config.comfyuiPath || !isAbsolute(config.comfyuiPath)) return undefined;
  try {
    return statSync(config.comfyuiPath).isDirectory()
      ? config.comfyuiPath
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Stricter than fileExists: the path must be a REGULAR FILE, not a directory.
 * Used to unlock the atomic live-cwd relaunch (#535) — a directory named
 * `main.py`, or a directory at the interpreter path, exists per existsSync yet
 * cannot be exec'd, so validating it as a file keeps the stop refuse-safe. NOT a
 * drop-in for fileExists elsewhere: a macOS `.app` bundle is a directory.
 */
function isRegularFile(p: string | undefined): boolean {
  if (!p) return false;
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** True when a token looks like a filesystem path (has a separator or a drive). */
function looksLikePath(s: string): boolean {
  return /[\\/]/.test(s) || /^[a-zA-Z]:/.test(s);
}

/**
 * Can we actually relaunch this instance? A restart must be atomic-ish: if we
 * can't build (and validate) a relaunch command, we must NOT stop the running
 * server — losing a restart is cheap, losing the server is not (issues
 * #368/#370). For a Desktop app this also RESOLVES + validates the launcher exe
 * (mutating `info.desktopExePath`) so the subsequent spawn uses a real path
 * rather than a regex guess that never matched the current "Comfy Desktop"
 * branding. For a script-based install it confirms the resolved interpreter and
 * `main.py` exist on disk — catching a stale COMFYUI_PATH that points at an
 * install with no runnable server.
 */
function assessRelaunch(info: ProcessInfo): { ok: boolean; reason?: string } {
  if (info.isDesktopApp) {
    if (IS_WIN) {
      const exe = fileExists(info.desktopExePath)
        ? info.desktopExePath
        : findDesktopExeFromCommonPaths();
      if (!exe || !fileExists(exe)) {
        return {
          ok: false,
          reason:
            "Could not determine (or locate on disk) the ComfyUI Desktop executable to relaunch.",
        };
      }
      info.desktopExePath = exe;
      return { ok: true };
    }
    // macOS: relaunch via `open -a`, which accepts an app bundle path or name.
    // Prefer a bundle that still exists on disk; fall back to a located one.
    const appPath = fileExists(info.desktopExePath)
      ? info.desktopExePath
      : findDesktopExeFromCommonPaths();
    if (!appPath || !fileExists(appPath)) {
      return {
        ok: false,
        reason:
          "Could not determine (or locate on disk) the ComfyUI Desktop app to relaunch.",
      };
    }
    info.desktopExePath = appPath;
    return { ok: true };
  }

  const cmd = resolveLaunchCommand(info);
  if (!cmd) {
    return {
      ok: false,
      reason:
        "Could not build a relaunch command from the running server's launch arguments.",
    };
  }
  if (looksLikePath(cmd.exe) && !fileExists(cmd.exe)) {
    return {
      ok: false,
      reason: `Resolved Python interpreter does not exist on disk: ${cmd.exe}.`,
    };
  }
  const script = cmd.args[0];
  if (script && /\.pyw?$/i.test(script)) {
    // We could only VALIDATE the script when it was resolved to an ABSOLUTE path
    // (either argv[0] was absolute, or resolveScriptAnchor anchored a relative
    // argv[0] to a canonical absolute install). A script still RELATIVE here means
    // the live-first anchor produced nothing absolute — i.e. a truly unresolvable
    // install (stale/relative COMFYUI_PATH, no saved workspace, no argv root). We
    // cannot confirm it exists, so REFUSE rather than kill a reachable server we
    // can't relaunch (#476/#426 refuse-safe; also covers a bare `main.py`).
    const scriptIsAbsolute =
      isAbsolute(script) ||
      /^[a-zA-Z]:[\\/]/.test(script) ||
      /^\\\\/.test(script);
    if (!scriptIsAbsolute || !fileExists(script)) {
      return {
        ok: false,
        reason:
          `Resolved ComfyUI script does not exist on disk: ${script} — ` +
          "could not locate the ComfyUI install; set COMFYUI_PATH or a default " +
          "workspace (COMFYUI_PATH may point at a stale/old install that has no " +
          "runnable server).",
      };
    }
  }
  return { ok: true };
}

/**
 * Resolve the running instance to control: ComfyUI's /system_stats argv + the
 * PID on the port, falling back to OS-level Desktop-app detection when the API
 * and port are unreachable. Returns null when nothing can be found.
 */
async function acquireProcessInfo(): Promise<{
  info: ProcessInfo | null;
  diagnostic?: string;
}> {
  try {
    return { info: await gatherProcessInfo() };
  } catch (err) {
    // #449: the server answered /system_stats but we could not map its port to
    // a PID. Do NOT fall through to killing a Desktop shell we can't confirm
    // owns :PORT — surface the diagnostic and leave everything untouched.
    if (err instanceof ProcessControlError && err.reachableButNoPid) {
      return { info: null, diagnostic: err.message };
    }
    const desktopPids = findDesktopAppPids();
    if (desktopPids.length > 0) {
      logger.info(
        `API unreachable but found Desktop app PIDs: ${desktopPids.join(", ")}`,
      );
      return {
        info: {
          pid: desktopPids[0],
          port: config.resolvedPort,
          argv: [],
          isDesktopApp: true,
          desktopExePath: findDesktopExeFromCommonPaths(),
        },
      };
    }
    // Genuinely down (not reachable, no Desktop shell): let callers use their
    // existing friendly "no process" message.
    return { info: null };
  }
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

  // The supervised ComfyUI is GONE (crash/exit), whether or not we go on to
  // respawn it. Whatever Manager dialect we classified belonged to that dead
  // instance, and a respawn can come back as a different Manager generation on
  // the same URL — re-probe rather than trust it (#646).
  resetManagerApiCache("supervised comfyui exited");

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
  restarted.child.unref();
  if (!lastProcessInfo.isDesktopApp) adoptLaunchedChild(restarted.child);
  superviseChild(restarted.child, lastProcessInfo);
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
    // Liveness is the reachable SERVER, not only a local PID scan. If
    // /system_stats just answered (argv populated) yet we still can't map the
    // listening socket to a PID, say so precisely instead of claiming the
    // process doesn't exist (issue #449).
    if (argv.length > 0) {
      const reachableErr = new ProcessControlError(
        `ComfyUI is reachable on port ${port} but its listening process could not ` +
          `be mapped to a local PID (port-owner lookup failed). The server was left ` +
          `untouched. On a portable/embedded-Python install, restart it via its ` +
          `launcher/console or trigger a ComfyUI-Manager reboot.`,
      );
      reachableErr.reachableButNoPid = true;
      throw reachableErr;
    }
    throw new ProcessControlError(
      `No process found listening on port ${port}. Is ComfyUI running?`,
    );
  }

  const desktop = isDesktopApp(argv);
  const desktopExe = desktop ? findDesktopExePath(argv) : undefined;
  // Capture the live process cwd NOW, while the pid is guaranteed alive — the
  // `/proc/<pid>/cwd` symlink is gone the instant a later stop kills it (#535).
  const liveCwd = desktop ? undefined : resolveLiveProcessCwd(pid);

  return {
    pid,
    port,
    argv,
    isDesktopApp: desktop,
    desktopExePath: desktopExe,
    liveCwd,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function stopComfyUI(preInfo?: ProcessInfo): Promise<StopResult> {
  if (isRemoteMode()) {
    throw new ProcessControlError(
      "stop_comfyui operates on the local machine's ComfyUI process and is not " +
        "available when targeting a remote instance via --comfyui-url.",
    );
  }
  logger.info("Stopping ComfyUI...");
  detachSupervisor();
  // The server we may have launched is going away — clear the shares-our-env flag so
  // a differently-launched successor doesn't inherit env-trust it shouldn't (#633 P1b).
  // Forget the recorded interpreter too: a stop was requested, so the launch record
  // must not outlive the process it describes (#401).
  recordedLaunchChild = undefined;
  resetLocalComfyUILaunchState();
  clearLaunchedInterpreter();

  // Gather info before we kill it (or reuse the caller's pre-validated info so a
  // relaunch preflight in restartComfyUI is not discarded).
  let info = preInfo ?? null;
  let acquireDiagnostic: string | undefined;
  if (!info) {
    const acquired = await acquireProcessInfo();
    info = acquired.info;
    acquireDiagnostic = acquired.diagnostic;
  }
  if (!info) {
    return {
      stopped: false,
      message:
        acquireDiagnostic ??
        `No ComfyUI process found on port ${config.resolvedPort}. Is ComfyUI running?`,
      has_restart_info: false,
    };
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
  // a restart is exactly when the node set may have changed. The detected
  // ComfyUI-Manager API dialect is live-derived the same way: the instance that
  // comes back on this port can be a different Manager generation (a 3.x→4.x
  // upgrade, or dropping --enable-manager-legacy-ui) at an unchanged URL, and a
  // stale dialect misroutes every later Manager call (#646).
  resetClient();
  resetObjectInfoCache();
  resetManagerApiCache("comfyui stopped");

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
  const spawnError = captureChildProcessError(launched.child);
  launched.child.unref();
  lastProcessInfo = info;
  superviseChild(launched.child, info);
  // A python `spawn` inherits our process.env, so this local server shares our
  // environment — mark it so its live extra_model_paths $VAR references may be
  // expanded against process.env (#633 P1b). A Desktop-app launch's env is NOT
  // guaranteed to be ours, so it stays fail-closed (unmarked).
  if (!info.isDesktopApp) {
    adoptLaunchedChild(launched.child);
    // Revoke env-trust the instant OUR launched child goes away — on EXIT and on a
    // failed spawn (ERROR): a successor server that later takes the port may have a
    // DIFFERENT env, so it must NOT inherit our trust (#633 P1b stale-flag). Fail
    // closed the moment we no longer own the process (`error` covers the spawn_error
    // path where `exit` may not fire). adoptLaunchedChild wires both handlers.
  }

  // A NEW server instance is coming up on this port — whatever Manager dialect we
  // classified belonged to whatever ran here before (start_comfyui is also
  // reachable without a preceding stopComfyUI, e.g. after an external kill or a
  // Manager upgrade), so re-probe rather than trust it (#646).
  resetManagerApiCache("comfyui started");

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
// TWO Manager generations serve reboot on DIFFERENT routes+verbs (issue #116):
//   • v4 lineage (pip comfyui_manager ≥4.x): POST /v2/manager/reboot
//   • released Manager 3.x legacy: GET /manager/reboot — and some 3.x builds
//     register it under POST, so we try both verbs on the legacy path before
//     giving up (panel #253/#266, this repo #425). ComfyUI's frontend catchall
//     answers unknown GETs 200/404 and unregistered POSTs 405, so a wrong route
//     surfaces as 404/405 and we fall through to the next candidate.
const REBOOT_ROUTES: ReadonlyArray<{ path: string; method: "POST" | "GET" }> = [
  { path: "/v2/manager/reboot", method: "POST" },
  { path: "/manager/reboot", method: "GET" },
  { path: "/manager/reboot", method: "POST" },
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
/**
 * True when a 200 response is (almost certainly) ComfyUI's frontend SPA catchall
 * rather than a real Manager reboot ack. The catchall serves the index HTML with
 * Content-Type text/html; a Manager reboot route either drops the connection or
 * returns a tiny non-HTML body. Best-effort and defensive: any read error →
 * treat as NOT a catchall (don't suppress a genuine ack on a transient read
 * failure).
 */
async function looksLikeSpaCatchall(res: Response): Promise<boolean> {
  try {
    const ctype = (res.headers.get("content-type") ?? "").toLowerCase();
    if (ctype.includes("text/html")) return true;
    // No/unknown content-type: sniff the first bytes for an HTML document.
    const body = (await res.clone().text()).trimStart().slice(0, 256).toLowerCase();
    return body.startsWith("<!doctype html") || body.startsWith("<html");
  } catch {
    return false;
  }
}

async function rebootViaManager(): Promise<RebootResult> {
  const base = getComfyUIBaseUrl();
  const failures: string[] = [];

  for (const { path, method } of REBOOT_ROUTES) {
    const url = `${base}${path}`;
    try {
      const res = await comfyuiFetch(url, { method });
      if (res.ok) {
        // GUARD (codex P1): ComfyUI's frontend catchall answers an UNKNOWN GET
        // with the SPA index — HTTP 200 text/html — so a 200 here does NOT prove
        // a reboot route exists. A genuine Manager reboot handler exits before it
        // can respond (→ a connection drop, handled below) or returns a tiny
        // non-HTML ack; treat a 200 that looks like the HTML catchall as "route
        // absent" and fall through to the next candidate rather than falsely
        // reporting a reboot that never fired (which readiness — a still-up
        // server — would then rubber-stamp as success).
        if (await looksLikeSpaCatchall(res)) {
          failures.push(`${method} ${path} → HTTP 200 (frontend catchall, not a reboot route)`);
          continue;
        }
        return { rebooting: true, endpoint: path, method };
      }
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
    note:
      `No reachable ComfyUI-Manager reboot endpoint (this ComfyUI likely runs the ` +
      `LEGACY Manager 3.x, which does not expose an HTTP reboot route).${
        failures.length ? ` Tried: ${failures.join("; ")}.` : ""
      } For a LOCAL install, use the headless restart_comfyui tool (kill + relaunch); ` +
      `otherwise restart ComfyUI on the host, or upgrade to Manager v4+.`,
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

/**
 * Restart via a ComfyUI-Manager HTTP reboot instead of killing a process.
 *
 * Used for BOTH the remote target (--comfyui-url) AND a locally-installed
 * ComfyUI **Desktop** instance. Desktop is Electron-supervised: killing its
 * Python backend (or even the Electron shell) leaves it down with no reliable
 * relaunch — spawning "Comfy Desktop.exe" does not deterministically bring the
 * :PORT listener back, which is exactly issue #400 (stopped:true, started:false
 * after 60 probes). The Manager `/v2/manager/reboot` handler asks the SAME
 * supervisor that owns the process to cycle it, so it comes back the way it
 * started. We therefore NEVER kill a Desktop instance; if the reboot can't be
 * fired we refuse and leave the server running rather than take it down with no
 * way back.
 */
async function restartViaManagerReboot(context: {
  /** Human label for logs and the success message ("remote" | "Desktop"). */
  label: string;
}): Promise<RestartResult> {
  logger.info(`Restarting ${context.label} ComfyUI via ComfyUI-Manager reboot...`);

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

  // The reboot HAS been accepted — the server is going down regardless of what
  // the readiness poll below concludes. Drop the detected dialect now so the
  // timed-out branch (which returns early) can't leave the pre-reboot dialect
  // pinned for the instance that eventually comes back (#646).
  resetManagerApiCache("comfyui reboot fired via Manager");

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

  // Back and ready — refresh the WS client singleton + memoized /object_info +
  // the detected Manager dialect, since a reboot is exactly when the node set
  // and the Manager generation may have changed (#646). The dialect is dropped a
  // SECOND time here on purpose: a probe that ran against the half-booted server
  // during the readiness wait must not stay pinned.
  resetClient();
  resetObjectInfoCache();
  resetManagerApiCache("comfyui rebooted via Manager");

  return {
    stopped: true,
    started: true,
    ready: true,
    readiness,
    message:
      `ComfyUI rebooted via ComfyUI-Manager and came back ready (${readiness.waited_ms}ms) — ` +
      `${context.label}/supervised restart.`,
  };
}

export async function restartComfyUI(): Promise<RestartResult> {
  if (isRemoteMode()) {
    // Remote target: can't process-control it, but a Manager HTTP reboot brings
    // back a self-supervised ComfyUI (e.g. the tunnelled Desktop app).
    return restartViaManagerReboot({ label: "remote" });
  }
  logger.info("Restarting ComfyUI...");

  // Preflight: resolve the RUNNING instance and confirm we can relaunch it
  // BEFORE stopping anything. A restart must be atomic-ish — if the relaunch
  // command can't be built/validated (stale COMFYUI_PATH, unknown Desktop exe),
  // refuse and leave the server up rather than take it down with no way back
  // (issues #368/#370).
  const { info, diagnostic } = await acquireProcessInfo();
  if (!info) {
    return {
      stopped: false,
      started: false,
      message:
        diagnostic ??
        `No ComfyUI process found on port ${config.resolvedPort} to restart. Is ComfyUI running?`,
    };
  }
  // A locally-installed ComfyUI **Desktop** instance is Electron-supervised.
  // Killing it (Python backend or Electron shell) and re-spawning the exe does
  // not reliably bring the :PORT listener back (issue #400: stopped:true,
  // started:false after 60 probes). Route it through the Manager reboot — the
  // supervisor that owns the process cycles it — and NEVER kill it. Only
  // self-spawned Python installs fall through to the kill+relaunch path below.
  if (info.isDesktopApp) {
    return restartViaManagerReboot({ label: "Desktop" });
  }

  const relaunch = assessRelaunch(info);
  if (!relaunch.ok) {
    return {
      stopped: false,
      started: false,
      message:
        `Refusing to restart: ${relaunch.reason} ComfyUI was left running (not stopped) ` +
        "so you don't lose the server. Fix the launch path (e.g. COMFYUI_PATH) and try again.",
    };
  }

  // Stop — hand it the pre-validated info so the relaunch details (incl. the
  // resolved Desktop exe) survive into startComfyUI's lastProcessInfo.
  const stopResult = await stopComfyUI(info);
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

/**
 * Refuse-safe preflight for an OUT-OF-BAND restart — one that stops ComfyUI
 * WITHOUT going through our validated kill+relaunch (e.g. the panel's
 * ComfyUI-Manager reboot, which asks the Manager to cycle the process and never
 * consults our relaunch command). The same atomic-ish invariant as
 * restartComfyUI applies (#368/#370): a stop must never happen before a
 * relaunch is proven possible. On a Pinokio-style install (#742) the running
 * server is externally supervised yet its relaunch is NOT provable from here
 * (a relative `main.py` argv with no COMFYUI_PATH/workspace anchor and no live
 * process cwd), and the supervisor does NOT re-launch after a plain Manager
 * restart — so the reboot would kill ComfyUI permanently. Only the PROVEN
 * dangerous shape refuses: a reachable, running, non-Desktop local instance
 * whose relaunch command cannot be built/validated. Everything else returns
 * ok:true and the caller proceeds exactly as before:
 *   - remote mode (no local process to assess);
 *   - nothing found / unreachable-but-unmapped (no proven running process —
 *     #449 already punts those to a Manager reboot on purpose);
 *   - a Desktop app (Electron-supervised — the Manager reboot IS its safe
 *     restart path, #400);
 *   - a validated relaunch (assessRelaunch, the #476/#426 machinery).
 */
export async function preflightLocalRestart(): Promise<{
  ok: boolean;
  reason?: string;
}> {
  if (isRemoteMode()) return { ok: true };
  const { info } = await acquireProcessInfo();
  if (!info) return { ok: true };
  if (info.isDesktopApp) return { ok: true };
  const relaunch = assessRelaunch(info);
  if (relaunch.ok) return { ok: true };
  return { ok: false, reason: relaunch.reason };
}

export const __processControlTestHooks = {
  reset(): void {
    detachSupervisor();
    lastProcessInfo = null;
    supervisorRestartCount = 0;
    supervisorWindowStartedAt = 0;
    supervisorGaveUp = false;
    remoteRebootTimingOverride = null;
    liveCwdResolverOverride = null;
  },
  /** Inject a fake live-process-cwd resolver (#535) so tests can drive the
   *  `/proc/<pid>/cwd` relative-script anchor without a real process/filesystem. */
  setLiveCwdResolver(fn: ((pid: number) => string | undefined) | null): void {
    liveCwdResolverOverride = fn;
  },
  setLastProcessInfo(info: ProcessInfo): void {
    lastProcessInfo = info;
  },
  /** Inject fast remote-reboot timing so tests don't wait the real ~120s budget. */
  setRemoteRebootTimingForTests(timing: RemoteRebootTiming | null): void {
    remoteRebootTimingOverride = timing;
  },
};
