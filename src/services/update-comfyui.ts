import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { platform } from "node:os";
import { config } from "../config.js";
import { resolveInstallInterpreter } from "./workspace-env.js";
import { queueUpdateAllCustomNodes } from "./node-management.js";
import { ProcessControlError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CommandResult {
  command: string;
  ok: boolean;
  output: string;
}

export interface UpdateCoreResult {
  updated: boolean;
  comfyui_path: string;
  package_manager: "uv" | "pip";
  steps: CommandResult[];
  message: string;
}

export interface UpdateNodesResult {
  updated: boolean;
  endpoint: string;
  queue_started: boolean;
  message: string;
  manager_response?: unknown;
}

// ---------------------------------------------------------------------------
// Cross-platform helpers
// ---------------------------------------------------------------------------

const IS_WIN = platform() === "win32";

/**
 * Run a command, capturing stdout+stderr. Throws ProcessControlError on
 * non-zero exit so callers can surface a clear failure.
 */
function runCommand(
  file: string,
  args: string[],
  cwd: string,
): CommandResult {
  const command = [file, ...args].join(" ");
  logger.info(`Running: ${command}`, { cwd });
  try {
    const output = execFileSync(file, args, {
      cwd,
      encoding: "utf-8",
      timeout: 300_000,
      // Inherit env so PATH resolves git/uv/pip; merge stderr into stdout.
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { command, ok: true, output: (output ?? "").trim() };
  } catch (err) {
    const e = err as { stdout?: Buffer | string; stderr?: Buffer | string; message?: string };
    const out = [e.stdout, e.stderr]
      .map((b) => (b == null ? "" : b.toString()))
      .join("")
      .trim();
    throw new ProcessControlError(
      `Command failed: ${command}\n${out || e.message || "unknown error"}`,
    );
  }
}

/**
 * Detect whether the ComfyUI install is managed by `uv` (a `.venv` created by
 * uv, or a uv lock present) versus plain pip. Falls back to checking whether
 * the `uv` binary is available on PATH. Defaults to pip.
 */
function detectPackageManager(comfyuiPath: string): "uv" | "pip" {
  // A uv-managed project typically has a uv.lock or pyproject managed by uv.
  if (
    existsSync(join(comfyuiPath, "uv.lock")) ||
    existsSync(join(comfyuiPath, ".venv", "uv-receipt.toml"))
  ) {
    return "uv";
  }
  // Otherwise see if `uv` is callable.
  try {
    execFileSync(IS_WIN ? "uv.exe" : "uv", ["--version"], {
      encoding: "utf-8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return "uv";
  } catch {
    return "pip";
  }
}

/**
 * Resolve the ComfyUI install path or throw a clear error explaining that core
 * updates require a local install (not available in remote --comfyui-url mode).
 */
function requireComfyUIPath(): string {
  const path = config.comfyuiPath;
  if (!path) {
    throw new ProcessControlError(
      "Cannot update ComfyUI core: no local install path is configured. " +
        "Core updates run git/pip against the ComfyUI directory and are not " +
        "available when targeting a remote instance via --comfyui-url / COMFYUI_URL. " +
        "Set COMFYUI_PATH to the local ComfyUI checkout to enable this.",
    );
  }
  if (!existsSync(path)) {
    throw new ProcessControlError(
      `Configured ComfyUI path does not exist: ${path}. Set COMFYUI_PATH correctly.`,
    );
  }
  return path;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Update ComfyUI core: `git pull` in config.comfyuiPath, then reinstall its
 * Python requirements via uv or pip. Mirrors `comfy-cli update`.
 */
export async function updateComfyUICore(): Promise<UpdateCoreResult> {
  const comfyuiPath = requireComfyUIPath();
  const pm = detectPackageManager(comfyuiPath);
  const steps: CommandResult[] = [];

  // Resolve the requirements install's interpreter BEFORE `git pull` mutates the
  // checkout: it must be the interpreter the RUNNING server imports from, never a
  // configured-workspace venv/PATH guess the server may not see (#651). Fail
  // closed when the live interpreter cannot be verified.
  const requirements = join(comfyuiPath, "requirements.txt");
  let venvPython: string | undefined;
  let pythonReason = "";
  if (existsSync(requirements)) {
    const resolved = await resolveInstallInterpreter(comfyuiPath);
    if (!resolved.python) {
      throw new ProcessControlError(
        `Cannot update ComfyUI core. ${resolved.reason} ` +
          "Set COMFYUI_PYTHON to the interpreter ComfyUI runs with, or restart ComfyUI through this MCP server and retry.",
      );
    }
    venvPython = resolved.python;
    pythonReason = ` ${resolved.reason}`;
  }

  // 1. git pull the core repo.
  steps.push(runCommand("git", ["pull"], comfyuiPath));

  // 2. Reinstall requirements into the resolved interpreter's env (never this
  //    server's Python). requirements.txt lives in the repo root.
  if (venvPython) {
    if (pm === "uv") {
      // `--python` pins uv to the resolved interpreter rather than an ambient env.
      steps.push(
        runCommand(
          "uv",
          ["pip", "install", "--python", venvPython, "-r", "requirements.txt"],
          comfyuiPath,
        ),
      );
    } else {
      steps.push(
        runCommand(
          venvPython,
          ["-m", "pip", "install", "-r", "requirements.txt"],
          comfyuiPath,
        ),
      );
    }
  } else {
    logger.warn(`No requirements.txt found at ${requirements}; skipping dependency install`);
  }

  return {
    updated: true,
    comfyui_path: comfyuiPath,
    package_manager: pm,
    steps,
    message: `ComfyUI core updated in ${comfyuiPath} using ${pm}.${pythonReason}`,
  };
}

/**
 * Update all installed custom nodes via the ComfyUI-Manager HTTP API.
 * Queues the update_all task then starts the queue worker (fire-and-forget —
 * the updates run asynchronously; unlike update_node with id "all", which
 * drains the queue).
 *
 * Routed through the Manager dialect machinery in node-management.ts (#656),
 * so the route follows the detected dialect instead of a hardcoded legacy
 * assumption:
 *   legacy 3.x:     POST /manager/queue/update_all      (mode in the JSON body)
 *   v4 / v2-batch:  POST /v2/manager/queue/update_all   (mode/client_id/ui_id
 *                                                      as query params)
 * then POST <same prefix>/start to kick the worker.
 */
export async function updateAllCustomNodes(): Promise<UpdateNodesResult> {
  const result = await queueUpdateAllCustomNodes();

  return {
    updated: true,
    endpoint: result.endpoint,
    queue_started: result.queueStarted,
    manager_response: result.managerResponse,
    message: result.queueStarted
      ? "Queued updates for all custom nodes via ComfyUI-Manager and started the queue worker. " +
        "Updates run asynchronously; a ComfyUI restart may be required afterward."
      : "Queued updates for all custom nodes via ComfyUI-Manager. " +
        "Could not confirm the queue worker started — check ComfyUI-Manager.",
  };
}

