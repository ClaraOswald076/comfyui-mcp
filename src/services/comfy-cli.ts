import * as childProcess from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, dirname, extname, join } from "node:path";
import { config } from "../config.js";
import { resolveEffectiveComfyUIBase } from "./workspace-env.js";

/**
 * The ComfyUI install a comfy-cli invocation TARGETS when the caller passed no explicit
 * `workspace`. That is the operation-target question, and `resolveEffectiveComfyUIBase`
 * is the only thing that answers it — including its refusal to name a local directory
 * when the session is pointed somewhere else.
 *
 * This used to read `config.comfyuiPath ?? resolveEffectiveComfyUIBase()`, which failed
 * twice over (#490): the resolver did not yet enforce the mode check this comment
 * claimed for it, AND the `??` short-circuited past the resolver entirely whenever
 * COMFYUI_PATH was set — the ordinary local configuration — so fixing the resolver alone
 * would not have reached here. The two operands answer different questions ("where is
 * the user's local install" vs "which install does this act on") and the `??` silently
 * substituted the first for the second.
 *
 * It matters most here: this module runs `comfy-cli uninstall` and `comfy-cli disable`.
 * With a remote `--comfyui-url` session and a stale local COMFYUI_PATH, those commands
 * ran against the local install while the reply described only the remote server.
 *
 * Returning null when nothing is resolvable is the point — callers refuse rather than
 * guess. Do not reintroduce a fallback here; a `??` at this seam is the bug.
 */
function defaultWorkspace(): string | null {
  return resolveEffectiveComfyUIBase() ?? null;
}

export interface ComfyCliError {
  code: string;
  message: string;
  hint?: string | null;
  details?: unknown;
}

export interface ComfyCliEnvelope<T = unknown> {
  schema?: string;
  type?: string;
  ok: boolean;
  command: string;
  version: string;
  where: "local" | "cloud" | null;
  data: T | null;
  error: ComfyCliError | null;
}

export interface ComfyCliRunOptions {
  workspace?: string | null;
  where?: "local" | "cloud";
  timeoutMs?: number;
  /**
   * Idle (liveness) timeout in milliseconds. When set, the process is only
   * killed if it produces NO stdout/stderr output for this long — each chunk
   * of output (e.g. a downloader progress line) resets the clock. This lets a
   * long-but-live download run to completion while still terminating a truly
   * stalled one. Takes precedence over `timeoutMs` when both are provided.
   */
  idleTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

/** Minimal shape of the child process we consume; keeps this testable. */
export interface IdleTimeoutChild {
  stdout: NodeJS.EventEmitter | null;
  stderr: NodeJS.EventEmitter | null;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "close", listener: (code: number | null) => void): unknown;
  kill(signal?: NodeJS.Signals): unknown;
}

export interface IdleTimeoutResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

/**
 * Await a spawned child process, killing it only after `idleTimeoutMs` elapses
 * with no output on either stream. Any stdout/stderr chunk is treated as
 * liveness and resets the idle timer. Exported for direct testing.
 */
export function awaitProcessWithIdleTimeout(
  child: IdleTimeoutChild,
  idleTimeoutMs: number,
  timers: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout } = { setTimeout, clearTimeout },
): Promise<IdleTimeoutResult> {
  return new Promise<IdleTimeoutResult>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;

    const clearIdle = () => {
      if (idleTimer) {
        timers.clearTimeout(idleTimer);
        idleTimer = null;
      }
    };
    const armIdle = () => {
      clearIdle();
      idleTimer = timers.setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, idleTimeoutMs);
    };

    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
      armIdle();
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
      armIdle();
    });
    child.on("error", (error: Error) => {
      if (settled) return;
      settled = true;
      clearIdle();
      reject(error);
    });
    child.on("close", (code: number | null) => {
      if (settled) return;
      settled = true;
      clearIdle();
      resolve({ stdout, stderr, exitCode: timedOut ? 1 : code ?? 0, timedOut });
    });

    armIdle();
  });
}

const MIN_COMFY_CLI_VERSION = [1, 11, 1] as const;
const versionCache = new Map<string, string | null>();

function executableNames(): string[] {
  return process.platform === "win32" ? ["comfy.exe", "comfy"] : ["comfy"];
}

function workspaceCandidates(workspace?: string | null): string[] {
  if (!workspace) return [];
  const roots = [workspace, dirname(workspace)];
  const dirs = roots.flatMap((root) => [
    join(root, ".venv", process.platform === "win32" ? "Scripts" : "bin"),
    join(root, "venv", process.platform === "win32" ? "Scripts" : "bin"),
  ]);
  return dirs.flatMap((dir) => executableNames().map((name) => join(dir, name)));
}

/** Resolve comfy-cli without invoking a shell. COMFY_CLI_PATH is authoritative. */
export function resolveComfyCliExecutable(options: { refresh?: boolean; workspace?: string | null } = {}): string | null {
  const explicit = process.env.COMFY_CLI_PATH?.trim();
  if (explicit) {
    if (process.platform === "win32" && [".cmd", ".bat"].includes(extname(explicit).toLowerCase())) {
      return null;
    }
    return existsSync(explicit) ? explicit : null;
  }

  const workspace = options.workspace ?? defaultWorkspace();
  for (const candidate of workspaceCandidates(workspace)) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  for (const dir of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    for (const name of executableNames()) {
      const candidate = join(dir.replace(/^"|"$/g, ""), name);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}

function buildArgs(args: readonly string[], options: ComfyCliRunOptions): string[] {
  const result = ["--json"];
  const workspace = options.workspace === undefined ? defaultWorkspace() : options.workspace;
  if (workspace) result.push("--workspace", workspace);
  if (options.where) result.push("--where", options.where);
  result.push("--skip-prompt", ...args);
  return result;
}

export function parseComfyCliEnvelope<T>(stdout: string, stderr = "", exitCode?: number): ComfyCliEnvelope<T> {
  const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
  let parsed: unknown;
  for (let index = lines.length - 1; index >= 0; index--) {
    try {
      parsed = JSON.parse(lines[index]);
      break;
    } catch {
      // JSON streaming commands may emit events before the final envelope.
    }
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`comfy-cli did not return a JSON envelope${exitCode == null ? "" : ` (exit ${exitCode})`}: ${stderr || stdout}`);
  }
  const envelope = parsed as Partial<ComfyCliEnvelope<T>>;
  if (
    envelope.schema !== "envelope/1" ||
    envelope.type !== "envelope" ||
    typeof envelope.ok !== "boolean" ||
    typeof envelope.command !== "string" ||
    typeof envelope.version !== "string"
  ) {
    throw new Error("comfy-cli returned JSON that does not match envelope/1");
  }
  return envelope as ComfyCliEnvelope<T>;
}

function hasJsonRecord(stdout: string): boolean {
  return stdout.trim().split(/\r?\n/).some((line) => {
    try {
      JSON.parse(line);
      return true;
    } catch {
      return false;
    }
  });
}

export function normalizeComfyCliResult<T = unknown>(
  args: readonly string[],
  options: ComfyCliRunOptions,
  result: { stdout: string; stderr: string; exitCode: number },
  version: string,
): ComfyCliEnvelope<T> {
  try {
    return parseComfyCliEnvelope<T>(result.stdout, result.stderr, result.exitCode);
  } catch (error) {
    if (hasJsonRecord(result.stdout)) throw error;
  }

  const command = args.join(" ");
  const details = { stdout: result.stdout.trim(), stderr: result.stderr.trim() };
  const alreadyStopped =
    args.length === 1 &&
    args[0] === "stop" &&
    /no comfyui is running in the background/i.test(details.stderr || details.stdout);
  if (alreadyStopped) {
    return {
      schema: "envelope/1",
      type: "envelope",
      ok: true,
      command,
      version,
      where: options.where ?? null,
      data: { ...details, already_stopped: true } as T,
      error: null,
    };
  }
  if (result.exitCode !== 0) {
    return {
      schema: "envelope/1",
      type: "envelope",
      ok: false,
      command,
      version,
      where: options.where ?? null,
      data: null,
      error: {
        code: "legacy_command_failed",
        message: details.stderr || details.stdout || `comfy-cli exited with code ${result.exitCode}`,
        details: { ...details, exit_code: result.exitCode },
      },
    };
  }
  return {
    schema: "envelope/1",
    type: "envelope",
    ok: true,
    command,
    version,
    where: options.where ?? null,
    data: details as T,
    error: null,
  };
}

function requireExecutable(options: ComfyCliRunOptions): string {
  const executable = resolveComfyCliExecutable({ workspace: options.workspace });
  if (!executable) {
    throw new Error(
      "comfy-cli was not found. Install comfy-cli>=1.11.1 and ensure `comfy` is on PATH, " +
        "set COMFY_CLI_PATH, or install it in the selected ComfyUI workspace's .venv.",
    );
  }
  return executable;
}

function unsupportedVersionEnvelope<T>(
  args: readonly string[],
  options: ComfyCliRunOptions,
  version: string | null,
): ComfyCliEnvelope<T> {
  return {
    schema: "envelope/1",
    type: "envelope",
    ok: false,
    command: args.join(" "),
    version: version ?? "unknown",
    where: options.where ?? null,
    data: null,
    error: {
      code: "unsupported_version",
      message: `comfy-cli >=1.11.1 is required; found ${version ?? "an unrecognized version"}.`,
      hint: "Upgrade with: python -m pip install --upgrade comfy-cli",
    },
  };
}

export async function runComfyCli<T = unknown>(args: readonly string[], options: ComfyCliRunOptions = {}): Promise<ComfyCliEnvelope<T>> {
  const executable = requireExecutable(options);
  const detectedVersion = getExecutableVersion(executable);
  if (!isSupportedComfyCliVersion(detectedVersion)) {
    return unsupportedVersionEnvelope<T>(args, options, detectedVersion);
  }
  const version = detectedVersion!;
  if (options.idleTimeoutMs != null) {
    try {
      const child = childProcess.spawn(executable, buildArgs(args, options), {
        windowsHide: true,
        env: { ...process.env, PYTHONUTF8: "1", ...options.env },
        cwd: options.cwd,
      });
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      const result = await awaitProcessWithIdleTimeout(child, options.idleTimeoutMs);
      if (result.timedOut) {
        return {
          schema: "envelope/1",
          type: "envelope",
          ok: false,
          command: args.join(" "),
          version,
          where: options.where ?? null,
          data: null,
          error: {
            code: "idle_timeout",
            message:
              `comfy-cli produced no output for ${Math.round(options.idleTimeoutMs / 1000)}s and was terminated as stalled.`,
            hint: "The download appears stuck. Check network connectivity and the source URL, then retry.",
            details: { stdout: result.stdout.trim(), stderr: result.stderr.trim() },
          },
        };
      }
      return normalizeComfyCliResult<T>(args, options, result, version);
    } catch (error) {
      const spawnError = error as Error & { code?: string };
      if (spawnError.code === "ENOENT") throw error;
      return normalizeComfyCliResult<T>(args, options, { stdout: "", stderr: spawnError.message, exitCode: 1 }, version);
    }
  }
  try {
    const result = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      childProcess.execFile(
        executable,
        buildArgs(args, options),
        {
          encoding: "utf8",
          timeout: options.timeoutMs ?? 120_000,
          windowsHide: true,
          maxBuffer: 16 * 1024 * 1024,
          env: { ...process.env, PYTHONUTF8: "1", ...options.env },
          cwd: options.cwd,
        },
        (error, stdout, stderr) => error ? reject(Object.assign(error, { stdout, stderr })) : resolve({ stdout, stderr }),
      );
    });
    return normalizeComfyCliResult<T>(args, options, { ...result, exitCode: 0 }, version);
  } catch (error) {
    const processError = error as Error & { stdout?: string; stderr?: string; code?: number | string };
    if (processError.code === "ENOENT") throw error;
    const exitCode = typeof processError.code === "number" ? processError.code : 1;
    return normalizeComfyCliResult<T>(
      args,
      options,
      {
        stdout: processError.stdout ?? "",
        stderr: processError.stderr || processError.message,
        exitCode,
      },
      version,
    );
  }
}

export function runComfyCliSync<T = unknown>(args: readonly string[], options: ComfyCliRunOptions = {}): ComfyCliEnvelope<T> {
  const executable = requireExecutable(options);
  const detectedVersion = getExecutableVersion(executable);
  if (!isSupportedComfyCliVersion(detectedVersion)) {
    return unsupportedVersionEnvelope<T>(args, options, detectedVersion);
  }
  const version = detectedVersion!;
  try {
    const stdout = childProcess.execFileSync(executable, buildArgs(args, options), {
      encoding: "utf8",
      timeout: options.timeoutMs ?? 120_000,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, PYTHONUTF8: "1", ...options.env },
      cwd: options.cwd,
    });
    return normalizeComfyCliResult<T>(args, options, { stdout, stderr: "", exitCode: 0 }, version);
  } catch (error) {
    const processError = error as Error & { code?: string; stdout?: string | Buffer; stderr?: string | Buffer; status?: number };
    if (processError.code === "ENOENT") throw error;
    const stdout = processError.stdout?.toString() ?? "";
    const stderr = processError.stderr?.toString() || processError.message;
    return normalizeComfyCliResult<T>(args, options, { stdout, stderr, exitCode: processError.status ?? 1 }, version);
  }
}

function getExecutableVersion(executable: string): string | null {
  if (versionCache.has(executable)) return versionCache.get(executable) ?? null;
  const result = childProcess.spawnSync(executable, ["--json", "--version"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
    env: { ...process.env, PYTHONUTF8: "1" },
  });
  try {
    const version = parseComfyCliEnvelope(result.stdout ?? "", result.stderr ?? "", result.status ?? undefined).version;
    versionCache.set(executable, version);
    return version;
  } catch {
    versionCache.set(executable, null);
    return null;
  }
}

export function getComfyCliVersion(options: { workspace?: string | null } = {}): string | null {
  const executable = resolveComfyCliExecutable({ workspace: options.workspace });
  return executable ? getExecutableVersion(executable) : null;
}

/**
 * Whether a usable comfy-cli (found AND version-supported) is available for the
 * given workspace. A found-but-unrecognized/too-old CLI is NOT usable — read-only
 * tools treat that identically to "absent" so they can fall back to the connected
 * server instead of surfacing `unsupported_version` (#487).
 */
export function isComfyCliUsable(options: { workspace?: string | null } = {}): boolean {
  const executable = resolveComfyCliExecutable({ workspace: options.workspace });
  if (!executable) return false;
  return isSupportedComfyCliVersion(getExecutableVersion(executable));
}

export function isSupportedComfyCliVersion(version: string | null): boolean {
  if (!version) return false;
  const parts = version.split(".").slice(0, 3).map((part) => Number.parseInt(part, 10));
  if (parts.some((part) => !Number.isFinite(part))) return false;
  for (let index = 0; index < MIN_COMFY_CLI_VERSION.length; index++) {
    if ((parts[index] ?? 0) > MIN_COMFY_CLI_VERSION[index]) return true;
    if ((parts[index] ?? 0) < MIN_COMFY_CLI_VERSION[index]) return false;
  }
  return true;
}

export function shouldUseComfyCli(
  explicit: boolean | undefined,
  localMode: boolean,
  executable: string | null,
  version: string | null,
): boolean {
  if (explicit !== undefined) return explicit;
  return localMode && executable !== null && isSupportedComfyCliVersion(version);
}

export function assertComfyCliOk<T>(envelope: ComfyCliEnvelope<T>): ComfyCliEnvelope<T> {
  if (!envelope.ok) {
    const error = envelope.error;
    throw new Error(`${error?.code ? `${error.code}: ` : ""}${error?.message ?? "comfy-cli command failed"}${error?.hint ? ` (${error.hint})` : ""}`);
  }
  return envelope;
}
