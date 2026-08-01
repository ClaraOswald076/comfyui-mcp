import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, join, isAbsolute, resolve } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { config, isRemoteMode } from "../config.js";
import {
  resolveServerExtraModelConfig,
  parseExtraModelPathsConfigsFromArgvRaw,
  type LiveServerSnapshot,
} from "./output-dir.js";
import { liveRootFromArgv } from "./workspace-env.js";
import { ValidationError } from "../utils/errors.js";

export const EXTRA_PATH_TARGETS = ["auto", "standalone", "desktop"] as const;
export type ExtraPathTarget = (typeof EXTRA_PATH_TARGETS)[number];

export interface ExtraPathCategory {
  category: string;
  paths: string[];
}

export interface ExtraPathGroup {
  name: string;
  base_path?: string;
  is_default?: unknown;
  categories: ExtraPathCategory[];
}

export interface ExtraPathsConfigInfo {
  target: Exclude<ExtraPathTarget, "auto">;
  path: string;
  exists: boolean;
  groups: ExtraPathGroup[];
  notes: string[];
}

export interface ExtraPathMutationResult extends ExtraPathsConfigInfo {
  changed: boolean;
  message: string;
}

interface ExtraPathOptions {
  target?: ExtraPathTarget;
  configPath?: string;
}

interface ExtraPathMutationOptions extends ExtraPathOptions {
  group?: string;
  category: string;
  path: string;
  isDefault?: boolean;
}

/**
 * Mirror ComfyUI's path expansion (utils/extra_config.py → os.path.expandvars then
 * os.path.expanduser) so a live config's `base_path`/entries classify absolute-vs-
 * relative the SAME way the running server does. Undefined variables are left intact
 * (matching Python), so nothing collapses to a bogus root. `%VAR%` is expanded on
 * Windows only (Python expandvars). Used ONLY for authorization resolution (#633).
 */
function expandUserAndVars(input: string): string {
  let s = input;
  // expandvars: ${VAR} and $VAR on all platforms; %VAR% additionally on Windows.
  s = s.replace(/\$\{([^}]+)\}/g, (m, n) => process.env[n] ?? m);
  s = s.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (m, n) => process.env[n] ?? m);
  if (platform() === "win32") {
    s = s.replace(/%([^%]+)%/g, (m, n) => process.env[n] ?? m);
  }
  // expanduser: a leading `~` (bare or `~/`, `~\`) → the current user's home dir.
  if (s === "~" || s.startsWith("~/") || s.startsWith("~\\")) {
    s = join(homedir(), s.slice(1));
  }
  return s;
}

const RESERVED_KEYS = new Set(["base_path", "is_default"]);
const SAFE_KEY_RE = /^[A-Za-z0-9_.-]+$/;
const CONTROL_RE = /[\x00\r\n]/;

function assertSafeKey(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new ValidationError(`${label} must be a non-empty string.`);
  if (!SAFE_KEY_RE.test(trimmed)) {
    throw new ValidationError(
      `${label} may contain only letters, numbers, dot, dash, and underscore: ${value}`,
    );
  }
  return trimmed;
}

function assertPathValue(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new ValidationError("Path must be a non-empty string.");
  if (CONTROL_RE.test(trimmed)) {
    throw new ValidationError("Path must not contain NUL or newline characters.");
  }
  return trimmed;
}

function desktopConfigPath(): string {
  const p = platform();
  if (p === "win32") {
    const root = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
    return join(root, "ComfyUI", "extra_models_config.yaml");
  }
  if (p === "darwin") {
    return join(homedir(), "Library", "Application Support", "ComfyUI", "extra_models_config.yaml");
  }
  const root = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(root, "ComfyUI", "extra_models_config.yaml");
}

function standaloneConfigPath(): string {
  if (!config.comfyuiPath) {
    throw new ValidationError(
      "No local ComfyUI path is known. Set COMFYUI_PATH, set a default workspace, " +
        "or pass config_path explicitly.",
    );
  }
  return join(config.comfyuiPath, "extra_model_paths.yaml");
}

function resolveTargetPath(opts: ExtraPathOptions = {}): {
  target: Exclude<ExtraPathTarget, "auto">;
  path: string;
} {
  if (opts.configPath) {
    return {
      target: opts.target === "desktop" ? "desktop" : "standalone",
      path: opts.configPath,
    };
  }

  const target = opts.target ?? "auto";
  if (target === "desktop") return { target, path: desktopConfigPath() };
  if (target === "standalone") return { target, path: standaloneConfigPath() };

  const desktop = desktopConfigPath();
  if (existsSync(desktop)) return { target: "desktop", path: desktop };
  return { target: "standalone", path: standaloneConfigPath() };
}

function splitPaths(value: unknown): string[] {
  if (typeof value === "string") {
    return value
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  }
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === "string")
      .map((line) => line.trim())
      .filter(Boolean);
  }
  return [];
}

function readGroup(raw: unknown, name: string): ExtraPathGroup | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const categories: ExtraPathCategory[] = [];
  for (const [key, value] of Object.entries(obj)) {
    if (RESERVED_KEYS.has(key)) continue;
    const paths = splitPaths(value);
    if (paths.length > 0) categories.push({ category: key, paths });
  }
  return {
    name,
    base_path: typeof obj.base_path === "string" ? obj.base_path : undefined,
    is_default: obj.is_default,
    categories,
  };
}

function parseConfig(text: string): Record<string, unknown> {
  if (!text.trim()) return {};
  const parsed = parseYaml(text, { maxAliasCount: 50 });
  if (parsed == null) return {};
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ValidationError("Extra paths config must be a YAML object.");
  }
  return parsed as Record<string, unknown>;
}

async function readConfigFile(path: string): Promise<Record<string, unknown>> {
  if (!existsSync(path)) return {};
  return parseConfig(await readFile(path, "utf-8"));
}

function summarize(
  target: Exclude<ExtraPathTarget, "auto">,
  path: string,
  raw: Record<string, unknown>,
  extraNotes: string[] = [],
): ExtraPathsConfigInfo {
  const groups: ExtraPathGroup[] = [];
  for (const [name, value] of Object.entries(raw)) {
    const group = readGroup(value, name);
    if (group) groups.push(group);
  }
  const notes = [
    ...extraNotes,
    // The generic "which file" hint only applies to the static-heuristic path; a
    // server-resolved config (extraNotes present) already states the real file,
    // so skip it to avoid contradicting that.
    ...(extraNotes.length > 0
      ? []
      : [
          target === "desktop"
            ? "Desktop uses extra_models_config.yaml in the OS ComfyUI app-data directory."
            : "Standalone/manual installs use extra_model_paths.yaml in the ComfyUI root.",
        ]),
    "Categories are generic ComfyUI search-path keys, so model folders and custom_nodes can both be represented when supported by the running ComfyUI build.",
    "Restart ComfyUI after editing this file so startup path registration is rebuilt.",
  ];
  return { target, path, exists: existsSync(path), groups, notes };
}

/**
 * Detect the ComfyUI-Desktop auto-generated shared config, which carries a
 * "do not edit manually" header and is regenerated by the Desktop app.
 */
function isDesktopGeneratedConfig(path: string): boolean {
  return /Comfy Desktop[\\/].*shared_model_paths\.ya?ml$/i.test(path);
}

/**
 * Resolve the target config path, PREFERRING the file the running server was
 * actually launched with (`--extra-model-paths-config`, read from /system_stats
 * argv) when the caller didn't pin an explicit target/config_path. On ComfyUI
 * Desktop the live file is `…\Comfy Desktop\shared_model_paths.yaml`, NOT the
 * app-data `ComfyUI\extra_models_config.yaml` the static heuristic guesses — so
 * without this, list_extra_paths reports fiction and add_extra_path is a silent
 * no-op against a file the server never reads (issue #345). Returns the resolved
 * target plus any warning notes to surface. Best-effort: falls back to the
 * static resolveTargetPath when the server is unreachable.
 */
async function resolveTargetPathPreferServer(opts: ExtraPathOptions = {}): Promise<{
  target: Exclude<ExtraPathTarget, "auto">;
  path: string;
  notes: string[];
}> {
  // Explicit config_path or an explicit non-auto target: honor the caller.
  if (opts.configPath || (opts.target && opts.target !== "auto")) {
    return { ...resolveTargetPath(opts), notes: [] };
  }

  const serverConfig = await resolveServerExtraModelConfig();
  if (!serverConfig) {
    return { ...resolveTargetPath(opts), notes: [] };
  }

  const notes = [
    `Resolved from the running ComfyUI's --extra-model-paths-config launch flag (the file the live server actually reads): ${serverConfig}`,
  ];
  // The static guess is only for a divergence diagnostic — never let it (e.g. a
  // missing COMFYUI_PATH for the standalone fallback) break the real resolution.
  try {
    const staticGuess = resolveTargetPath(opts);
    if (resolve(staticGuess.path) !== resolve(serverConfig)) {
      notes.push(
        `NOTE: this differs from the path the static heuristic would have used (${staticGuess.path}). Editing that other file would be a silent no-op — the running server does not read it.`,
      );
    }
  } catch {
    // No static guess available — the server-resolved path stands on its own.
  }
  const isDesktop =
    isDesktopGeneratedConfig(serverConfig) ||
    /Comfy Desktop[\\/]|[\\/]ComfyUI[\\/]extra_models_config\.ya?ml$/i.test(serverConfig);
  if (isDesktopGeneratedConfig(serverConfig)) {
    notes.push(
      "WARNING: this file is auto-generated by ComfyUI Desktop ('do not edit manually') and will be overwritten by the Desktop app. For a durable model path, place or symlink the models under the server's --base-directory models dir instead of editing this YAML.",
    );
  }
  return { target: isDesktop ? "desktop" : "standalone", path: serverConfig, notes };
}

export async function listExtraPaths(
  opts: ExtraPathOptions = {},
): Promise<ExtraPathsConfigInfo> {
  const resolved = await resolveTargetPathPreferServer(opts);
  const raw = await readConfigFile(resolved.path);
  return summarize(resolved.target, resolved.path, raw, resolved.notes);
}

/** One model search directory contributed by extra_model_paths configuration. */
export interface ExtraModelRoot {
  /** The ComfyUI category key (e.g. "checkpoints", "loras") the dir serves. */
  category: string;
  /** Absolute directory on disk that ComfyUI loads this category's models from. */
  dir: string;
  /** The owning config group name (for diagnostics). */
  group: string;
}

/**
 * Enumerate every model directory declared in the active extra_model_paths /
 * extra_models_config file — i.e. the same extra roots (often on other drives
 * like E:\) that ComfyUI itself loads models from. Each entry pairs a category
 * key with the absolute directory that serves it (paths are resolved against the
 * group's base_path when relative). Returns [] when no config exists or no local
 * ComfyUI path is known. Best-effort: never throws (a malformed/unreadable
 * config yields []), so callers can treat extra roots as an additive search set.
 */
export async function getExtraModelRoots(
  opts: ExtraPathOptions = {},
): Promise<ExtraModelRoot[]> {
  let info: ExtraPathsConfigInfo;
  try {
    info = await listExtraPaths(opts);
  } catch {
    return [];
  }
  const roots: ExtraModelRoot[] = [];
  for (const group of info.groups) {
    const base = group.base_path?.trim();
    for (const category of group.categories) {
      for (const p of category.paths) {
        const dir = isAbsolute(p)
          ? resolve(p)
          : base
            ? resolve(base, p)
            : resolve(p);
        roots.push({ category: category.category, dir, group: group.name });
      }
    }
  }
  return roots;
}

/**
 * The extra model roots the LIVE, running ComfyUI ACTUALLY registers — for the ONE
 * purpose of AUTHORIZING a write into a symlinked download destination that escapes
 * the primary models dir (#633). Authorization must be fail-closed and anchored to
 * the running server, NEVER a stale/static local config the server does not load
 * (codex P0d): a config the server no longer reads must not authorize an escaping
 * symlink, and an unreachable server must authorize nothing.
 *
 * Takes the SINGLE live `/system_stats` snapshot the caller already used to resolve
 * the models/base dirs — NOT its own stats call — so authorization roots can never
 * come from a different server state than the code-root veto (codex inter-snapshot
 * race). Trusted sources, all from that snapshot, so a stale local COMFYUI_PATH /
 * default-workspace config can never authorize an escape:
 *   - every ABSOLUTE `--extra-model-paths-config` file the server was LAUNCHED with
 *     (raw argv values; a RELATIVE flag value is SKIPPED — it can't be resolved to
 *     the live server's file from the MCP process, so trusting it would let a stale
 *     local same-named config authorize; fail closed); and
 *   - `<live main.py root>/extra_model_paths.yaml` — ComfyUI's auto-loaded default,
 *     anchored to the server's OWN install root (its main.py dir from argv), NOT an
 *     arbitrary base dir or the local workspace.
 *
 * Relative `base_path` / category paths are resolved against the CONFIG FILE's own
 * directory, exactly as ComfyUI resolves them — never against the MCP process CWD —
 * so a same-named/relative config in a stale workspace cannot misattribute a root.
 *
 * Returns `authoritative: false` (and no roots) whenever the server was unreachable,
 * so the caller REFUSES every escaping symlink rather than authorize from a guess.
 * Never throws.
 */
export async function getLiveExtraModelRoots(
  snapshot: LiveServerSnapshot,
): Promise<{ authoritative: boolean; roots: ExtraModelRoot[] }> {
  if (!snapshot?.reachable) return { authoritative: false, roots: [] };
  const argv = snapshot.argv;
  const configPaths = new Set<string>();
  // Launched flag files — ABSOLUTE values only (relative → fail closed, see docblock).
  for (const raw of parseExtraModelPathsConfigsFromArgvRaw(argv)) {
    if (isAbsolute(raw)) configPaths.add(resolve(raw));
  }
  // Auto-loaded default in the LIVE install root (its main.py dir). Skip in remote
  // mode: the live root is a path on the remote host.
  if (!isRemoteMode()) {
    const liveRoot = liveRootFromArgv(argv, snapshot.cwd);
    if (liveRoot) configPaths.add(resolve(liveRoot, "extra_model_paths.yaml"));
  }

  const roots: ExtraModelRoot[] = [];
  for (const cfg of configPaths) {
    if (!existsSync(cfg)) continue;
    let raw: Record<string, unknown>;
    try {
      raw = parseConfig(await readFile(cfg, "utf-8"));
    } catch {
      continue; // unreadable/malformed — skip; never authorize from a bad file
    }
    // Match ComfyUI: relative entries resolve against the YAML file's OWN directory.
    const cfgDir = dirname(resolve(cfg));
    for (const [name, value] of Object.entries(raw)) {
      const group = readGroup(value, name);
      if (!group) continue;
      // ComfyUI expands `~` and env vars in base_path/entries BEFORE classifying
      // absolute vs relative (utils/extra_config.py). Without this, `base_path: ~/models`
      // would be treated as RELATIVE and mis-resolved to `<config-dir>/~/models`, so a
      // legit symlink into the REAL registered $HOME root would be wrongly REFUSED.
      const rawBase = group.base_path ? expandUserAndVars(group.base_path.trim()) : undefined;
      const base = rawBase
        ? isAbsolute(rawBase)
          ? resolve(rawBase)
          : resolve(cfgDir, rawBase)
        : undefined;
      for (const category of group.categories) {
        for (const rawPath of category.paths) {
          const p = expandUserAndVars(rawPath);
          const dir = isAbsolute(p) ? resolve(p) : resolve(base ?? cfgDir, p);
          roots.push({ category: category.category, dir, group: name });
        }
      }
    }
  }
  return { authoritative: true, roots };
}

function ensureGroup(raw: Record<string, unknown>, name: string): Record<string, unknown> {
  const existing = raw[name];
  if (existing && typeof existing === "object" && !Array.isArray(existing)) {
    return existing as Record<string, unknown>;
  }
  const group: Record<string, unknown> = {};
  raw[name] = group;
  return group;
}

async function writeConfigFile(path: string, raw: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, stringifyYaml(raw, { lineWidth: 0 }), "utf-8");
}

export async function addExtraPath(
  opts: ExtraPathMutationOptions,
): Promise<ExtraPathMutationResult> {
  const resolved = await resolveTargetPathPreferServer(opts);
  const groupName = assertSafeKey(opts.group ?? "comfyui_mcp", "Group");
  const category = assertSafeKey(opts.category, "Category");
  const nextPath = assertPathValue(opts.path);
  if (RESERVED_KEYS.has(category)) {
    throw new ValidationError(`"${category}" is a reserved config key, not a path category.`);
  }

  const raw = await readConfigFile(resolved.path);
  const group = ensureGroup(raw, groupName);
  if (opts.isDefault !== undefined && group.is_default === undefined) {
    group.is_default = opts.isDefault;
  }

  const paths = splitPaths(group[category]);
  const changed = !paths.includes(nextPath);
  if (changed) {
    paths.push(nextPath);
    group[category] = paths.join("\n");
    await writeConfigFile(resolved.path, raw);
  }
  const info = summarize(resolved.target, resolved.path, raw, resolved.notes);
  return {
    ...info,
    changed,
    message: changed
      ? `Added ${nextPath} to ${groupName}.${category}. Restart ComfyUI to apply it.`
      : `${nextPath} is already present in ${groupName}.${category}.`,
  };
}

export async function removeExtraPath(
  opts: ExtraPathMutationOptions,
): Promise<ExtraPathMutationResult> {
  const resolved = await resolveTargetPathPreferServer(opts);
  const groupName = assertSafeKey(opts.group ?? "comfyui_mcp", "Group");
  const category = assertSafeKey(opts.category, "Category");
  const removePath = assertPathValue(opts.path);

  const raw = await readConfigFile(resolved.path);
  const group = raw[groupName];
  let changed = false;
  if (group && typeof group === "object" && !Array.isArray(group)) {
    const obj = group as Record<string, unknown>;
    const remaining = splitPaths(obj[category]).filter((p) => p !== removePath);
    changed = remaining.length !== splitPaths(obj[category]).length;
    if (changed) {
      if (remaining.length > 0) obj[category] = remaining.join("\n");
      else delete obj[category];
      await writeConfigFile(resolved.path, raw);
    }
  }
  const info = summarize(resolved.target, resolved.path, raw, resolved.notes);
  return {
    ...info,
    changed,
    message: changed
      ? `Removed ${removePath} from ${groupName}.${category}. Restart ComfyUI to apply it.`
      : `${removePath} was not present in ${groupName}.${category}.`,
  };
}
