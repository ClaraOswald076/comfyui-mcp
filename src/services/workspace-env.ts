import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, isAbsolute, join, resolve as pathResolve } from "node:path";
import { promisify } from "node:util";
import { config, getComfyUIBaseUrl, isRemoteMode } from "../config.js";
import { getSystemStats } from "../comfyui/client.js";
import { logger } from "../utils/logger.js";
import { ValidationError } from "../utils/errors.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Workspace config persistence (mirrors comfy-cli set-default / which)
// ---------------------------------------------------------------------------

interface WorkspaceConfig {
  defaultWorkspace?: string;
}

/**
 * Resolve the path to the workspace config JSON file.
 * Uses XDG_CONFIG_HOME when set, otherwise ~/.config/comfyui-mcp/workspace.json.
 */
function defaultWorkspaceConfigPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const root = xdg && xdg.length > 0 ? xdg : join(homedir(), ".config");
  return join(root, "comfyui-mcp", "workspace.json");
}

// Module-level override hook so tests can point at a temp file. Defaults to the
// platform config path lazily (so env changes in tests are picked up before set).
let configPathOverride: string | undefined;

export function configureWorkspace(opts: { configPath?: string }): void {
  configPathOverride = opts.configPath;
}

export function resetWorkspaceConfig(): void {
  configPathOverride = undefined;
}

// Whether THIS MCP process launched the connected LOCAL ComfyUI during this session
// via a python `spawn` (which inherits process.env). When true, the running server
// shares our environment, so it is safe to expand `$VAR`/`${VAR}`/`%VAR%` in its live
// extra_model_paths config against process.env. A server we did NOT launch (separately
// started, possibly with a DIFFERENT env, or a Desktop-app launch whose env we don't
// share) must NOT have its config vars expanded against our env — that could authorize
// a wrong-place download destination (#633 P1b). Set ONLY on the env-inheriting python
// spawn path, cleared on stop; module-scoped, so it resets each MCP process lifetime.
let localComfyUILaunchedByUs = false;

/** Record that this MCP process spawned the local ComfyUI (env inherited). */
export function markLocalComfyUILaunched(): void {
  localComfyUILaunchedByUs = true;
}

/** Clear the launched-by-us flag (on stop, and a test seam). */
export function resetLocalComfyUILaunchState(): void {
  localComfyUILaunchedByUs = false;
}

/** True when this MCP process launched the connected local ComfyUI (shares our env). */
export function didLaunchLocalComfyUI(): boolean {
  return localComfyUILaunchedByUs;
}

function workspaceConfigPath(): string {
  return configPathOverride ?? defaultWorkspaceConfigPath();
}

/**
 * Synchronous read of the saved default workspace (set via set_default_workspace).
 * Mirrors readWorkspaceConfig()'s validation but is sync, so sync filesystem-path
 * resolvers (e.g. model-resolver.getModelsRoot) can consult the saved default
 * workspace without going async — this is what lets local downloads / model
 * lookups work when COMFYUI_PATH isn't set but a default workspace is saved.
 * Returns undefined when unset, invalid, or unreadable.
 */
export function getSavedDefaultWorkspaceSync(): string | undefined {
  const path = workspaceConfigPath();
  try {
    if (!existsSync(path)) return undefined;
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    const dw = (parsed as Record<string, unknown>).defaultWorkspace;
    if (typeof dw === "string" && dw.trim().length > 0) return dw;
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * The SINGLE source of truth for the effective LOCAL ComfyUI base directory used
 * by every filesystem-backed tool (download_model, verify_custom_node, model
 * lookups, apply_manifest's adoption). Resolution order, applied consistently so
 * the tools never disagree about where ComfyUI lives when COMFYUI_PATH is unset:
 *
 *   1. config.comfyuiPath — COMFYUI_PATH env or auto-detection (wins).
 *   2. When NOT targeting a remote ComfyUI, the saved DEFAULT WORKSPACE
 *      (set via set_default_workspace) — this is what get_workspace /
 *      get_environment already report, so local downloads / model lookups /
 *      node verification work without COMFYUI_PATH.
 *
 * Never returns a local workspace in remote mode (that dir isn't the remote
 * target; remote-mode callers route through ComfyUI-Manager instead). Returns
 * undefined when no usable local path exists — callers then either detect a live
 * server base dir (/system_stats) or emit a clear, actionable error.
 */
export function resolveEffectiveComfyUIBase(): string | undefined {
  if (config.comfyuiPath) return config.comfyuiPath;
  if (isRemoteMode()) return undefined;
  return getSavedDefaultWorkspaceSync();
}

/**
 * The LIVE connected server's own install root, derived from its /system_stats
 * launch argv (the `main.py` path — see liveRootFromArgv). This is the ComfyUI
 * that is ACTUALLY running, so it is the source of truth for where a download /
 * node install must land — even when COMFYUI_PATH is unset, OR points at a
 * DIFFERENT, stale install than the connected one (#490/#463). Returns undefined
 * in remote mode (the live root is a path on the REMOTE host, not usable as a
 * local target), when the server is unreachable, or when argv yields no
 * resolvable absolute root. Best-effort and NEVER throws.
 */
export async function resolveLiveComfyUIBase(): Promise<string | undefined> {
  if (isRemoteMode()) return undefined;
  try {
    const stats = await getSystemStats();
    return liveRootFromArgv(
      stats.system?.argv,
      (stats.system as { cwd?: string })?.cwd,
    );
  } catch {
    return undefined;
  }
}

/**
 * ONE `/system_stats` snapshot for callers that need to derive several things from the
 * SAME server state (the launch flags AND the install root), rather than issuing two
 * calls that could straddle a restart — the same invariant `resolveModelsDirWithBases`
 * keeps for the download destination. `reachable: false` covers remote mode (the server's
 * paths are on another host) and any failure. Never throws.
 */
export async function getLiveServerSnapshot(): Promise<{
  reachable: boolean;
  argv?: string[];
  cwd?: string;
}> {
  if (isRemoteMode()) return { reachable: false };
  try {
    const stats = await getSystemStats();
    return {
      reachable: true,
      argv: stats.system?.argv,
      cwd: (stats.system as { cwd?: string })?.cwd,
    };
  } catch {
    return { reachable: false };
  }
}

async function readWorkspaceConfig(): Promise<WorkspaceConfig> {
  const path = workspaceConfigPath();
  if (!existsSync(path)) return {};
  try {
    const raw = await readFile(path, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      logger.warn("Workspace config is not a JSON object, ignoring", { path });
      return {};
    }
    // Validate the shape rather than blindly casting: defaultWorkspace must be a
    // non-empty string when present, else it is dropped.
    const cfg: WorkspaceConfig = {};
    const dw = (parsed as Record<string, unknown>).defaultWorkspace;
    if (typeof dw === "string" && dw.trim().length > 0) {
      cfg.defaultWorkspace = dw;
    } else if (dw !== undefined) {
      logger.warn("Ignoring invalid defaultWorkspace in workspace config", {
        path,
        type: typeof dw,
      });
    }
    return cfg;
  } catch (err) {
    logger.warn("Failed to parse workspace config, ignoring", {
      path,
      error: err instanceof Error ? err.message : err,
    });
    return {};
  }
}

async function writeWorkspaceConfig(cfg: WorkspaceConfig): Promise<void> {
  const path = workspaceConfigPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(cfg, null, 2), "utf-8");
}

// ---------------------------------------------------------------------------
// ComfyUI install auto-detection
// (mirrors detectComfyUIPaths logic in src/config.ts — kept local because that
//  helper is not exported and config.ts is owned by another unit)
// ---------------------------------------------------------------------------

/**
 * Auto-detect ComfyUI installation directories. Checks common locations on
 * macOS, Linux, and Windows. Returns all found paths, most-preferred first.
 */
export function detectComfyUIInstalls(): string[] {
  const home = homedir();
  const candidates: string[] = [];

  // macOS: ComfyUI Desktop app stores data here
  candidates.push(join(home, "Documents", "ComfyUI"));
  // macOS: Application Support
  candidates.push(join(home, "Library", "Application Support", "ComfyUI"));
  // Common manual install locations
  candidates.push(join(home, "ComfyUI"));
  candidates.push(join(home, "code", "ComfyUI"));
  candidates.push(join(home, "projects", "ComfyUI"));
  candidates.push(join(home, "src", "ComfyUI"));
  // Linux common paths
  candidates.push("/opt/ComfyUI");
  candidates.push(join(home, ".local", "share", "ComfyUI"));
  // Windows common paths
  candidates.push(join(home, "AppData", "Local", "ComfyUI"));
  candidates.push(join(home, "Desktop", "ComfyUI"));
  // Windows: ComfyUI Desktop app installs here
  candidates.push(
    join(home, "AppData", "Local", "Programs", "ComfyUI", "resources", "ComfyUI"),
  );

  // Scan ~/Documents and ~/My Documents for any ComfyUI-named directories
  const documentsDirs = [join(home, "Documents"), join(home, "My Documents")];
  for (const dir of documentsDirs) {
    try {
      if (!existsSync(dir)) continue;
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && entry.name.toLowerCase().includes("comfyui")) {
          const fullPath = join(dir, entry.name);
          if (!candidates.includes(fullPath)) candidates.push(fullPath);
        }
      }
    } catch {
      // Ignore permission errors
    }
  }

  return candidates.filter((p) => {
    if (!existsSync(p)) return false;
    if (!p.includes("Documents")) return true;
    return existsSync(join(p, "models")) || existsSync(join(p, "custom_nodes"));
  });
}

// ---------------------------------------------------------------------------
// get_workspace — mirrors comfy-cli which
// ---------------------------------------------------------------------------

export interface WorkspaceInfo {
  workspace_path?: string;
  workspace_source: "env" | "auto-detected" | "default-config" | "none";
  default_workspace?: string;
  api_target: string;
}

export async function getWorkspace(): Promise<WorkspaceInfo> {
  const cfg = await readWorkspaceConfig();
  const apiTarget = getComfyUIBaseUrl();

  let source: WorkspaceInfo["workspace_source"];
  if (config.comfyuiPath) {
    // config.comfyuiPath is COMFYUI_PATH env or auto-detection
    source = process.env.COMFYUI_PATH ? "env" : "auto-detected";
  } else if (cfg.defaultWorkspace) {
    source = "default-config";
  } else {
    source = "none";
  }

  return {
    workspace_path: config.comfyuiPath ?? cfg.defaultWorkspace,
    workspace_source: source,
    default_workspace: cfg.defaultWorkspace,
    api_target: apiTarget,
  };
}

// ---------------------------------------------------------------------------
// set_default_workspace — mirrors comfy-cli set-default
// ---------------------------------------------------------------------------

export interface SetDefaultResult {
  saved: boolean;
  default_workspace: string;
  config_path: string;
  exists: boolean;
}

export async function setDefaultWorkspace(
  path: string,
): Promise<SetDefaultResult> {
  const trimmed = path.trim();
  if (trimmed.length === 0) {
    throw new ValidationError("Workspace path must be a non-empty string.");
  }

  const cfg = await readWorkspaceConfig();
  cfg.defaultWorkspace = trimmed;
  await writeWorkspaceConfig(cfg);

  return {
    saved: true,
    default_workspace: trimmed,
    config_path: workspaceConfigPath(),
    exists: existsSync(trimmed),
  };
}

// ---------------------------------------------------------------------------
// list_workspaces — auto-detected installs + active + saved default
// ---------------------------------------------------------------------------

export interface WorkspaceListEntry {
  path: string;
  active: boolean;
  is_default: boolean;
  looks_valid: boolean;
}

export interface WorkspaceList {
  active_workspace?: string;
  default_workspace?: string;
  workspaces: WorkspaceListEntry[];
}

export async function listWorkspaces(): Promise<WorkspaceList> {
  const cfg = await readWorkspaceConfig();
  const detected = detectComfyUIInstalls();

  // Merge detected installs with active path and saved default so the caller
  // sees a complete picture even if one isn't in the detection list.
  const paths = new Set<string>(detected);
  if (config.comfyuiPath) paths.add(config.comfyuiPath);
  if (cfg.defaultWorkspace) paths.add(cfg.defaultWorkspace);

  const workspaces: WorkspaceListEntry[] = [...paths].map((p) => ({
    path: p,
    active: p === config.comfyuiPath,
    is_default: p === cfg.defaultWorkspace,
    looks_valid:
      existsSync(join(p, "models")) || existsSync(join(p, "custom_nodes")),
  }));

  return {
    active_workspace: config.comfyuiPath,
    default_workspace: cfg.defaultWorkspace,
    workspaces,
  };
}

// ---------------------------------------------------------------------------
// get_environment — mirrors comfy-cli env
// ---------------------------------------------------------------------------

const IS_WIN = platform() === "win32";

/** Run a command quietly; return trimmed stdout or undefined on any failure. */
async function probe(
  cmd: string,
  args: string[],
  opts?: { cwd?: string },
): Promise<string | undefined> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      cwd: opts?.cwd,
      timeout: 8000,
      windowsHide: true,
    });
    const out = (stdout || stderr || "").trim();
    return out.length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Derive the ABSOLUTE directory that holds the running server's `main.py` from its
 * `/system_stats` argv (Python's `sys.argv`, whose argv[0] is the script path). This
 * is the LIVE running instance's install root — the source of truth for which python
 * is actually running ComfyUI (#401 / PR #433 review). Robust against the argv shapes
 * codex flagged: surrounding quotes are stripped; a RELATIVE `ComfyUI/main.py` or a
 * bare `main.py` is resolved against the server's reported cwd WHEN AVAILABLE; and if
 * the main.py path cannot be resolved to an absolute directory we return `undefined`
 * (UNRESOLVED) rather than a bogus/relative root — callers must NOT then silently
 * fall back to a persisted default and mark it "live".
 */
export function liveRootFromArgv(
  argv: string[] | undefined,
  cwd?: string,
): string | undefined {
  const script = liveScriptFromArgv(argv, cwd);
  return script ? dirname(script) : undefined;
}

/**
 * The same derivation as `liveRootFromArgv` but returning the `main.py` FILE itself
 * rather than its directory — `dirname()` of this is exactly what `liveRootFromArgv`
 * returns, which is why that function delegates here instead of duplicating the parse.
 *
 * The file path is what a caller needs to follow a SYMLINK: ComfyUI locates its implicit
 * `extra_model_paths.yaml` next to `os.path.realpath(__file__)`, so a launcher that keeps
 * `/launcher/main.py` symlinked to `/installs/B/main.py` reads `/installs/B/…`. Only the
 * script path can be realpath'd; the directory cannot (the symlink is on the file).
 * Callers that must not follow symlinks — notably the #633 authorization path, which is
 * anchored to the lexical argv root — keep using `liveRootFromArgv`.
 */
export function liveScriptFromArgv(
  argv: string[] | undefined,
  cwd?: string,
): string | undefined {
  if (!Array.isArray(argv)) return undefined;
  for (const rawArg of argv) {
    if (typeof rawArg !== "string") continue;
    // Strip surrounding quotes a launcher may leave on the path.
    const a = rawArg.trim().replace(/^["']+/, "").replace(/["']+$/, "");
    // Must actually END in main.py / main.pyw (boundary guards against notmain.py).
    if (!/(^|[\\/])main\.pyw?$/i.test(a)) continue;
    const dir = dirname(a);
    if (dir === "." || dir === "") {
      // Bare "main.py" — only resolvable via an absolute cwd.
      return cwd && isAbsolute(cwd) ? pathResolve(cwd, a) : undefined;
    }
    if (isAbsolute(dir)) return a;
    // Relative dir (e.g. "ComfyUI/main.py") — resolve against the server's cwd.
    if (cwd && isAbsolute(cwd)) return pathResolve(cwd, a);
    return undefined; // cannot resolve to an absolute dir → UNRESOLVED
  }
  return undefined;
}

/**
 * Resolve the Python interpreter that ACTUALLY belongs to a ComfyUI install
 * `root`, honoring EVERY layout ComfyUI ships with — portable Windows builds keep
 * python under `standalone-env` / `python_embeded` (NOT just `.venv`/`venv`). Used
 * by apply_manifest's pip installs and the cloned-node deps installer so those run
 * under the install's OWN interpreter, not a bare system `python` that would
 * contaminate the host env while reporting success (#463 codex review). Returns
 * the first candidate present on disk, else a bare platform python name as a last
 * resort. `undefined` root → bare python.
 */
export function resolveRootInterpreter(root: string | undefined): string {
  const names = IS_WIN ? ["python.exe", "python"] : ["python3", "python"];
  if (root) {
    for (const c of interpreterCandidates(root)) {
      if (/^\\\\/.test(c)) continue; // skip UNC (existsSync can block on dead shares)
      try {
        if (existsSync(c)) return c;
      } catch {
        // ignore and continue
      }
    }
  }
  return names[0];
}

/** Platform interpreter candidates under a ComfyUI install root, most-preferred first. */
function interpreterCandidates(root: string): string[] {
  const names = IS_WIN ? ["python.exe", "python"] : ["python3", "python"];
  const candidates: string[] = [];
  if (IS_WIN) {
    candidates.push(join(root, "standalone-env", "python.exe"));
    candidates.push(join(root, "python_embeded", "python.exe"));
    candidates.push(join(root, "..", "python_embeded", "python.exe"));
  }
  const venvBins = IS_WIN
    ? [join(root, ".venv", "Scripts"), join(root, "venv", "Scripts")]
    : [join(root, ".venv", "bin"), join(root, "venv", "bin")];
  for (const bin of venvBins) for (const n of names) candidates.push(join(bin, n));
  return candidates;
}

export interface ComfyuiPythonResolution {
  /** The interpreter to probe. Absolute when verified; a bare PATH name as last resort. */
  python: string | undefined;
  /** The interpreter exists on disk under a known ComfyUI root (venv/embedded). */
  verified: boolean;
  /** That root is the LIVE running server's own install root — i.e. this is provably
   *  the interpreter running ComfyUI. Only a `live` interpreter's negatives are
   *  authoritative; anything else must be treated as unknown/untrusted (#401). */
  live: boolean;
  /** The resolved absolute live root, when one could be determined from argv. */
  liveRoot?: string;
}

/**
 * Resolve the python that ComfyUI actually runs on, LIVE-FIRST. The running server's
 * argv-derived install root is tried BEFORE an explicit COMFYUI_PATH, which is tried
 * before the saved default workspace (#418) — and the saved default is consulted ONLY
 * when there is neither a live argv nor an explicit path to trust. Portable/standalone
 * installs keep python under python_embeded / standalone-env (not just .venv), so all
 * are checked. Falls back to a bare PATH name (`verified:false, live:false`) when no
 * on-disk interpreter is found — a negative off THAT is untrustworthy (#401 / PR #433).
 *
 * REMOTE mode (`opts.remote`): the live interpreter is on the REMOTE host and cannot be
 * probed locally, so a locally-existing argv path is NOT treated as `live` — otherwise a
 * coincident local install would have its (version-matching) negatives mis-reported as
 * authoritative for a server running elsewhere. In remote mode we do not probe the live
 * root at all; callers degrade to honest-unknown / untrusted (#401 / PR #433 round 3).
 */
export function resolveComfyuiPython(
  comfyuiPath: string | undefined,
  statsArgv: string[] | undefined,
  opts?: { cwd?: string; remote?: boolean },
): ComfyuiPythonResolution {
  const names = IS_WIN ? ["python.exe", "python"] : ["python3", "python"];
  const remote = opts?.remote ?? false;
  const liveRoot = liveRootFromArgv(statsArgv, opts?.cwd);

  const rootsWithFlag: Array<{ root: string; live: boolean }> = [];
  // Only a LOCAL live root is a probeable live interpreter. Skip it entirely in remote
  // mode so we never probe a coincident local path as if it were the remote server's.
  if (liveRoot && !remote) rootsWithFlag.push({ root: liveRoot, live: true });
  if (comfyuiPath && comfyuiPath !== liveRoot) {
    rootsWithFlag.push({ root: comfyuiPath, live: false });
  }
  // Saved default only when we have nothing more trustworthy to go on (never remote).
  if (!liveRoot && !comfyuiPath && !remote) {
    const saved = resolveEffectiveComfyUIBase();
    if (saved) rootsWithFlag.push({ root: saved, live: false });
  }

  for (const { root, live } of rootsWithFlag) {
    for (const c of interpreterCandidates(root)) {
      // Skip UNC paths — existsSync on a dead network share can block for seconds.
      if (/^\\\\/.test(c)) continue;
      try {
        if (existsSync(c)) return { python: c, verified: true, live, liveRoot };
      } catch {
        // ignore and continue
      }
    }
  }
  return { python: names[0], verified: false, live: false, liveRoot };
}

/** True when two python version strings share the same major.minor (3.12.11 ~ 3.12.0). */
function pythonVersionsAgree(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const mm = (v: string): string | undefined => v.replace(/^Python\s+/i, "").match(/^(\d+\.\d+)/)?.[1];
  const ma = mm(a);
  const mb = mm(b);
  return !!ma && ma === mb;
}

async function probePipPackages(
  pythonExe: string,
  names: string[],
): Promise<Record<string, string>> {
  // `pip show` is portable across pip/uv-managed venvs.
  const found: Record<string, string> = {};
  const out = await probe(pythonExe, [
    "-m",
    "pip",
    "show",
    ...names,
  ]);
  if (!out) return found;
  // `pip show A B C` emits records separated by a line of "---".
  for (const block of out.split(/^---$/m)) {
    const nameMatch = block.match(/^Name:\s*(.+)$/m);
    const verMatch = block.match(/^Version:\s*(.+)$/m);
    if (nameMatch && verMatch) {
      found[nameMatch[1].trim().toLowerCase()] = verMatch[1].trim();
    }
  }
  return found;
}

async function probeGitRev(
  workspacePath: string,
): Promise<{ rev?: string; branch?: string } | undefined> {
  if (!existsSync(join(workspacePath, ".git"))) return undefined;
  const rev = await probe("git", ["rev-parse", "--short", "HEAD"], {
    cwd: workspacePath,
  });
  const branch = await probe("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: workspacePath,
  });
  if (!rev && !branch) return undefined;
  return { rev, branch };
}

/** Read ComfyUI-Manager version from its local install if present. */
async function readManagerVersion(
  workspacePath: string,
): Promise<string | undefined> {
  const dirNames = ["ComfyUI-Manager", "comfyui-manager"];
  for (const dirName of dirNames) {
    const file = join(workspacePath, "custom_nodes", dirName, "pyproject.toml");
    try {
      if (!existsSync(file)) continue;
      // Tiny TOML peek — only the version line, no full parser needed.
      const text = await readFile(file, "utf-8");
      const m = text.match(/^version\s*=\s*["']([^"']+)["']/m);
      if (m) return m[1];
      // Presence without a parseable version still tells us it's installed.
      return "installed";
    } catch {
      // try next
    }
  }
  // Fallback: directory presence
  for (const dirName of dirNames) {
    if (existsSync(join(workspacePath, "custom_nodes", dirName))) {
      return "installed";
    }
  }
  return undefined;
}

export interface EnvironmentInfo {
  // Running instance (from /system_stats — works remotely)
  running_instance: {
    reachable: boolean;
    api_target: string;
    os?: string;
    python_version?: string;
    embedded_python?: boolean;
    comfyui_version?: string;
    devices?: Array<{
      name: string;
      type: string;
      vram_total_mb?: number;
      vram_free_mb?: number;
    }>;
    error?: string;
  };
  // Local workspace probes (omitted/degraded when no local path)
  local: {
    workspace_path?: string;
    python?: { executable: string; version: string };
    /** Whether the probed python is trusted to be the running ComfyUI's own
     *  interpreter. False when a bare PATH python was used or its version
     *  disagrees with the running instance — in that case `packages` is omitted
     *  rather than reporting versions from the wrong environment (#401). */
    python_probe_trusted?: boolean;
    git?: { rev?: string; branch?: string };
    comfyui_manager_version?: string;
    packages?: Record<string, string>;
    note?: string;
  };
}

const KEY_PACKAGES = [
  "torch",
  "torchvision",
  "torchaudio",
  "xformers",
  "numpy",
  "transformers",
  "diffusers",
  "comfyui-frontend-package",
];

export async function getEnvironment(): Promise<EnvironmentInfo> {
  const apiTarget = getComfyUIBaseUrl();

  // 1. Running instance via /system_stats (works for remote targets too)
  const running: EnvironmentInfo["running_instance"] = {
    reachable: false,
    api_target: apiTarget,
  };
  // argv/cwd of the LIVE server (from /system_stats) drive live-first interpreter
  // resolution below — captured here so a probe never targets the wrong python.
  let statsArgv: string[] | undefined;
  let statsCwd: string | undefined;
  try {
    const stats = await getSystemStats();
    running.reachable = true;
    running.os = stats.system.os;
    running.python_version = stats.system.python_version;
    running.embedded_python = stats.system.embedded_python;
    running.comfyui_version = stats.system.comfyui_version;
    statsArgv = stats.system.argv;
    // ComfyUI does not currently report cwd, but tolerate it if a future/build does.
    statsCwd = (stats.system as { cwd?: string }).cwd;
    running.devices = (stats.devices ?? []).map((d) => ({
      name: d.name,
      type: d.type,
      vram_total_mb:
        typeof d.vram_total === "number"
          ? Math.round(d.vram_total / (1024 * 1024))
          : undefined,
      vram_free_mb:
        typeof d.vram_free === "number"
          ? Math.round(d.vram_free / (1024 * 1024))
          : undefined,
    }));
  } catch (err) {
    running.error = err instanceof Error ? err.message : String(err);
  }

  // 2. Local probes — use the active path, else fall back to the saved default
  //    workspace (set via set_default_workspace) so `env` still inspects a known
  //    local install when COMFYUI_PATH isn't set.
  const local: EnvironmentInfo["local"] = {};
  const cfg = await readWorkspaceConfig();
  const workspacePath = config.comfyuiPath ?? cfg.defaultWorkspace;

  // LIVE-FIRST interpreter resolution — identical to resolveComfyuiPython used by
  // the panel env block, so the two paths can never disagree (#401 / PR #433). The
  // running server's argv root wins over an explicit COMFYUI_PATH, which wins over
  // the saved default.
  const remote = isRemoteMode();
  const resolved = resolveComfyuiPython(workspacePath, statsArgv, { cwd: statsCwd, remote });

  // The install root we can actually inspect on disk: an explicit/saved workspace,
  // else the live server's own root (so we still report git/manager for a live
  // server even when no workspace path is configured).
  const localRoot = workspacePath ?? resolved.liveRoot;
  if (!localRoot) {
    local.note =
      "No local ComfyUI path configured (COMFYUI_PATH unset, none auto-detected, " +
      "and no saved default workspace) and no live server main.py to locate one. " +
      "Local environment probes skipped; remote /system_stats used instead.";
    return { running_instance: running, local };
  }

  local.workspace_path = localRoot;
  if (!config.comfyuiPath && cfg.defaultWorkspace) {
    local.note = `Using saved default workspace "${cfg.defaultWorkspace}" (COMFYUI_PATH not set).`;
  }

  const version = resolved.python ? await probe(resolved.python, ["--version"]) : undefined;
  if (resolved.python && version) {
    const ver = version.replace(/^Python\s+/i, "");
    local.python = { executable: resolved.python, version: ver };

    // "Trusted" means the probed interpreter IS the one running ComfyUI, so its
    // package list truly describes the live environment (#401). Order of certainty:
    //   - REMOTE: the running server is elsewhere; NO local interpreter is its own,
    //     so never trust a local probe (a coincident local path is not the server's).
    //   - resolved.live: we resolved the interpreter from the live server's own
    //     argv root — provably correct.
    //   - server unreachable: nothing live to contradict, but only trust a REAL
    //     workspace venv/embedded python — NOT a bare PATH fallback (which is not
    //     provably the configured workspace's interpreter).
    //   - live root unknown (reachable but argv gave no resolvable root): best we
    //     can do is a version cross-check against the running instance.
    //   - live root KNOWN but we're not on it (a different/saved workspace): the
    //     probe is a DIFFERENT environment — untrusted, omit packages.
    const runningPy = running.python_version;
    let trusted: boolean;
    if (remote) {
      trusted = false;
    } else if (resolved.live) {
      trusted = true;
    } else if (!running.reachable) {
      trusted = resolved.verified;
    } else if (!resolved.liveRoot) {
      trusted = pythonVersionsAgree(ver, runningPy);
    } else {
      trusted = false;
    }
    local.python_probe_trusted = trusted;

    if (trusted) {
      const pkgs = await probePipPackages(resolved.python, KEY_PACKAGES);
      if (Object.keys(pkgs).length > 0) local.packages = pkgs;
    } else {
      const detail = remote
        ? "the running ComfyUI is REMOTE — a locally-probed interpreter is not the remote server's environment"
        : resolved.liveRoot
          ? `the probe interpreter is a different workspace than the running ComfyUI (it does not match the running ComfyUI python ${runningPy})`
          : !running.reachable
            ? "the server is unreachable and no workspace venv/embedded python was found (a bare PATH python is not authoritative)"
            : `probed python ${ver} does not match the running ComfyUI python ${runningPy}`;
      local.note = [
        local.note,
        `Package versions omitted: ${detail}, so reporting them would be a false ` +
          `capability report (#401). Point COMFYUI_PATH at the install actually ` +
          `running ComfyUI for an accurate report.`,
      ]
        .filter(Boolean)
        .join(" ");
    }
  } else {
    local.note = [
      local.note,
      "Python interpreter not found on PATH or in the workspace venv/embedded python.",
    ]
      .filter(Boolean)
      .join(" ");
  }

  const git = await probeGitRev(localRoot);
  if (git) local.git = git;

  const managerVersion = await readManagerVersion(localRoot);
  if (managerVersion) local.comfyui_manager_version = managerVersion;

  return { running_instance: running, local };
}
