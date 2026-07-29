import { isAbsolute, join, resolve } from "node:path";
import { config } from "../config.js";
import { getSystemStats } from "../comfyui/client.js";
import { ValidationError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";

// ---------------------------------------------------------------------------
// Resolve ComfyUI's REAL output directory.
//
// ComfyUI can be launched with --output-directory (or --base-directory) which
// redirects generated images away from the default <COMFYUI_PATH>/output (e.g.
// to a shared drive like ComfyUI-Shared\output). Tools that scan the output
// directory on the local filesystem (convert_image, list_output_images) must
// therefore NOT assume <COMFYUI_PATH>/output, or they find nothing after a
// successful render.
//
// The authoritative source is ComfyUI itself: /system_stats reports the launch
// argv (system.argv), from which we parse --output-directory / --base-directory.
// We fall back to <COMFYUI_PATH>/output when ComfyUI is unreachable or did not
// override the directory. Same class of fix as the doubled-COMFYUI_PATH bug.
// ---------------------------------------------------------------------------

/** Resolve a possibly-relative dir against a base (or COMFYUI_PATH, or cwd). */
function resolveDir(value: string, base?: string): string {
  if (isAbsolute(value)) return resolve(value);
  const root = base ?? config.comfyuiPath ?? process.cwd();
  return resolve(root, value);
}

/** Read a flag's value supporting both `--flag value` and `--flag=value`. */
function flagValue(argv: string[], index: number, flag: string): string | undefined {
  const token = argv[index];
  if (token === flag) return argv[index + 1];
  if (token.startsWith(`${flag}=`)) return token.slice(flag.length + 1);
  return undefined;
}

/**
 * Parse the configured output directory out of ComfyUI's launch argv.
 * --output-directory wins; otherwise --base-directory implies <base>/output.
 * Returns undefined when neither flag is present.
 */
export function parseOutputDirFromArgv(argv: string[] | undefined): string | undefined {
  if (!argv || argv.length === 0) return undefined;

  let outputDir: string | undefined;
  let baseDir: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    outputDir = flagValue(argv, i, "--output-directory") ?? outputDir;
    baseDir = flagValue(argv, i, "--base-directory") ?? baseDir;
  }

  const resolvedBase = baseDir ? resolveDir(baseDir) : undefined;
  if (outputDir) return resolveDir(outputDir, resolvedBase);
  if (resolvedBase) return join(resolvedBase, "output");
  return undefined;
}

/**
 * Parse the running server's base directory (`--base-directory`) out of its
 * launch argv. This is the authoritative root ComfyUI derives models/, input/,
 * output/, and user/ from — on a Desktop install it commonly points at a drive
 * entirely different from COMFYUI_PATH (the code checkout). Returns undefined
 * when the flag is absent.
 */
export function parseBaseDirFromArgv(argv: string[] | undefined): string | undefined {
  if (!argv || argv.length === 0) return undefined;
  let baseDir: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    baseDir = flagValue(argv, i, "--base-directory") ?? baseDir;
  }
  return baseDir ? resolveDir(baseDir) : undefined;
}

/**
 * Parse the models directory the running server actually reads from. ComfyUI has
 * no dedicated `--models-directory` flag; the models root is `<base>/models`
 * when `--base-directory` is set. Returns undefined when the flag is absent.
 */
export function parseModelsDirFromArgv(argv: string[] | undefined): string | undefined {
  const base = parseBaseDirFromArgv(argv);
  return base ? join(base, "models") : undefined;
}

/**
 * Parse every `--extra-model-paths-config` value out of the launch argv (the
 * flag may be repeated). This is the config file the running server actually
 * loads extra model search paths from — on ComfyUI Desktop it is an
 * auto-generated `…\Comfy Desktop\shared_model_paths.yaml`, NOT the app-data
 * `ComfyUI\extra_models_config.yaml` the tools historically guessed. Returns []
 * when the flag is absent.
 */
export function parseExtraModelPathsConfigsFromArgv(argv: string[] | undefined): string[] {
  if (!argv || argv.length === 0) return [];
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const v = flagValue(argv, i, "--extra-model-paths-config");
    if (v) out.push(resolveDir(v));
  }
  return out;
}

/**
 * Resolve the models directory the CONNECTED server actually reads from. Asks
 * the running ComfyUI (/system_stats argv → `--base-directory`) first; falls
 * back to `<COMFYUI_PATH>/models`. This is the source of truth for
 * download_model's destination so files land where the live server sees them
 * (issues #346/#369) rather than in a stale COMFYUI_PATH install.
 */
export async function resolveModelsDir(): Promise<string> {
  try {
    const stats = await getSystemStats();
    const fromArgv = parseModelsDirFromArgv(stats.system?.argv);
    if (fromArgv) {
      logger.debug("Resolved ComfyUI models directory from launch argv", {
        modelsDir: fromArgv,
      });
      return fromArgv;
    }
  } catch (err) {
    logger.debug(
      "Could not resolve models dir from /system_stats; using COMFYUI_PATH/models",
      { error: err instanceof Error ? err.message : String(err) },
    );
  }
  if (!config.comfyuiPath) {
    throw new ValidationError(
      "COMFYUI_PATH is not configured. Set the COMFYUI_PATH environment variable.",
    );
  }
  return resolve(config.comfyuiPath, "models");
}

/**
 * Best-effort: the running server's `--extra-model-paths-config` file, or
 * undefined when unreachable / not launched with the flag. Never throws.
 */
export async function resolveServerExtraModelConfig(): Promise<string | undefined> {
  try {
    const stats = await getSystemStats();
    const configs = parseExtraModelPathsConfigsFromArgv(stats.system?.argv);
    return configs[0];
  } catch {
    return undefined;
  }
}

/** <COMFYUI_PATH>/output fallback. Throws if COMFYUI_PATH is unset. */
export function localOutputDirFallback(): string {
  if (!config.comfyuiPath) {
    throw new ValidationError(
      "COMFYUI_PATH is not configured. Set the COMFYUI_PATH environment variable.",
    );
  }
  return resolve(config.comfyuiPath, "output");
}

// ---------------------------------------------------------------------------
// Resolve ComfyUI's REAL input directory — the exact mirror of the output-dir
// logic above. ComfyUI can be launched with --input-directory (or
// --base-directory) which redirects the LoadImage / VHS_LoadVideo / LoadAudio
// search path away from the default <COMFYUI_PATH>/input. Filesystem-path tools
// that write or check files in the input directory must therefore NOT assume
// <COMFYUI_PATH>/input, or a server with a custom --input-directory rejects the
// file ("Invalid image file") while the tool reports success. Prefer the server
// API (/upload/image, see stage_output_as_input) when possible; use this only
// for genuine local filesystem operations.
// ---------------------------------------------------------------------------

/**
 * Parse the configured input directory out of ComfyUI's launch argv.
 * --input-directory wins; otherwise --base-directory implies <base>/input.
 * Returns undefined when neither flag is present.
 */
export function parseInputDirFromArgv(argv: string[] | undefined): string | undefined {
  if (!argv || argv.length === 0) return undefined;

  let inputDir: string | undefined;
  let baseDir: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    inputDir = flagValue(argv, i, "--input-directory") ?? inputDir;
    baseDir = flagValue(argv, i, "--base-directory") ?? baseDir;
  }

  const resolvedBase = baseDir ? resolveDir(baseDir) : undefined;
  if (inputDir) return resolveDir(inputDir, resolvedBase);
  if (resolvedBase) return join(resolvedBase, "input");
  return undefined;
}

/** <COMFYUI_PATH>/input fallback. Throws if COMFYUI_PATH is unset. */
export function localInputDirFallback(): string {
  if (!config.comfyuiPath) {
    throw new ValidationError(
      "COMFYUI_PATH is not configured. Set the COMFYUI_PATH environment variable.",
    );
  }
  return resolve(config.comfyuiPath, "input");
}

/**
 * Resolve the directory ComfyUI actually reads inputs from. Asks the running
 * ComfyUI (/system_stats argv) first; falls back to <COMFYUI_PATH>/input.
 */
export async function resolveInputDir(): Promise<string> {
  try {
    const stats = await getSystemStats();
    const fromArgv = parseInputDirFromArgv(stats.system?.argv);
    if (fromArgv) {
      logger.debug("Resolved ComfyUI input directory from launch argv", {
        inputDir: fromArgv,
      });
      return fromArgv;
    }
  } catch (err) {
    logger.debug(
      "Could not resolve input dir from /system_stats; using COMFYUI_PATH/input",
      { error: err instanceof Error ? err.message : String(err) },
    );
  }
  return localInputDirFallback();
}

/**
 * Resolve the directory ComfyUI actually writes outputs to. Asks the running
 * ComfyUI (/system_stats argv) first; falls back to <COMFYUI_PATH>/output.
 */
export async function resolveOutputDir(): Promise<string> {
  try {
    const stats = await getSystemStats();
    const fromArgv = parseOutputDirFromArgv(stats.system?.argv);
    if (fromArgv) {
      logger.debug("Resolved ComfyUI output directory from launch argv", {
        outputDir: fromArgv,
      });
      return fromArgv;
    }
  } catch (err) {
    logger.debug(
      "Could not resolve output dir from /system_stats; using COMFYUI_PATH/output",
      { error: err instanceof Error ? err.message : String(err) },
    );
  }
  return localOutputDirFallback();
}
