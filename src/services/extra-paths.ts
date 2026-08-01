import { existsSync, realpathSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, join, isAbsolute, resolve } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { config, isRemoteMode } from "../config.js";
import {
  parseExtraModelPathsConfigsFromArgvRaw,
  type LiveServerSnapshot,
} from "./output-dir.js";
import {
  liveRootFromArgv,
  liveScriptFromArgv,
  didLaunchLocalComfyUI,
  getLiveServerSnapshot,
  resolveEffectiveComfyUIBase,
} from "./workspace-env.js";
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

/** ComfyUI-style `~` expansion (utils/extra_config.py applies expanduser FIRST).
 *  ACCEPTED residuals (rare, user's own config on their own machine — maintainer
 *  ruling, same class as the ntpath `$$`/single-quote edges): POSIX `~otheruser`
 *  expansion and leading/trailing whitespace inside a quoted value are not modeled;
 *  only the current user's `~`/`~/` (the form real configs use) is expanded. */
function expandUser(s: string): string {
  if (s === "~" || s.startsWith("~/") || s.startsWith("~\\")) {
    return join(homedir(), s.slice(1));
  }
  return s;
}

// Bare `$NAME` grammar: posixpath uses `\w+`; Windows ntpath additionally admits `-`
// in the name (so `$FOO-bar` is ONE var → usually undefined → left literal, matching
// ComfyUI, instead of expanding `$FOO`). ACCEPTED deeper residuals (rare, trusted-mode
// only, the user's OWN config on their OWN machine — maintainer ruling): the nt `$$`→`$`
// escape and nt single-quote non-expansion are NOT modeled. `${...}` and simple
// `$NAME`/`%NAME%` (the forms real configs use) are exact.
const BARE_VAR = process.platform === "win32" ? /\$([\w-]+)/g : /\$(\w+)/g;
const BARE_VAR_TEST = process.platform === "win32" ? /\$[\w-]+/ : /\$\w+/;

/**
 * Windows `%VAR%` expansion, as a SINGLE LEFT-TO-RIGHT PASS over the string — the same
 * shape as CPython's `ntpath.expandvars`:
 *   - `%%` is an ESCAPED literal `%` (emit one `%`, consume both);
 *   - `%NAME%` (non-empty NAME with no `%` inside) substitutes `process.env[NAME]`, and
 *     an UNDEFINED variable leaves the WHOLE token literal;
 *   - anything else (including an unterminated trailing `%`) is emitted verbatim.
 *
 * Deliberately placeholder-free. The previous implementation protected `%%` by
 * substituting a sentinel token and restoring it in a later pass; ANY sentinel is a
 * legal path substring, so an input that literally contained it was silently rewritten
 * to `%` — a wrong-destination corruption of the same class as the raw-NUL sentinel
 * removed in 1ab84ce. A single pass never re-reads its own output, so no input can be
 * confused for machinery.
 */
function expandPercentVars(s: string): string {
  let out = "";
  let i = 0;
  while (i < s.length) {
    if (s[i] !== "%") {
      out += s[i];
      i += 1;
      continue;
    }
    if (s[i + 1] === "%") {
      out += "%"; // escaped literal `%`
      i += 2;
      continue;
    }
    // NAME runs to the next `%`; the escape branch above already excluded an empty NAME.
    const close = s.indexOf("%", i + 1);
    if (close === -1) {
      out += "%"; // unterminated — literal
      i += 1;
      continue;
    }
    const name = s.slice(i + 1, close);
    const value = process.env[name];
    // Undefined → keep the entire `%NAME%` token literal (ComfyUI/ntpath behavior).
    out += value ?? s.slice(i, close + 1);
    i = close + 1;
  }
  return out;
}

/** ComfyUI-style env expansion (os.path.expandvars): `${VAR}`/`$VAR` on all platforms,
 *  `%VAR%` on Windows with `%%` an ESCAPED literal `%`; an UNDEFINED variable is left
 *  literal. Exported for unit tests. */
export function expandVars(s: string): string {
  let r = s.replace(/\$\{([^}]+)\}/g, (m, n) => process.env[n] ?? m);
  r = r.replace(BARE_VAR, (m, n) => process.env[n] ?? m);
  if (platform() === "win32") r = expandPercentVars(r);
  return r;
}

/** True when `s` still contains an env-var token expandVars would substitute. Kept
 *  INCLUSIVE (matches the inner name even in an escaped `%%VAR%%`) so the untrusted
 *  fail-closed drop errs toward refusing rather than authorizing a guess. */
function hasEnvVarToken(s: string): boolean {
  if (/\$\{[^}]+\}/.test(s) || BARE_VAR_TEST.test(s)) return true;
  return platform() === "win32" && /%[^%]+%/.test(s);
}

/**
 * Expand a live config `base_path` EXACTLY as ComfyUI does (utils/extra_config.py):
 * expanduser FIRST, THEN expandvars, applied ONLY to base_path (per-category subpath
 * entries are left LITERAL — ComfyUI never expands them). Mirroring the order + scope
 * is a correctness requirement: authorizing a path ComfyUI would NOT register lets a
 * symlink escape to a dir the server never scans (#633 P1a).
 *
 * P1b (fail-closed env): `$VAR`/`${VAR}`/`%VAR%` is expanded against process.env ONLY
 * when the running server SHARES this process's environment (trustServerEnv — a local
 * server this MCP launched, which inherited our env). Otherwise the server's real
 * value is UNKNOWN, so a base_path that still needs an env var is UNRESOLVABLE and the
 * caller drops the whole group rather than authorize a guessed-wrong destination.
 * Returns undefined = unresolvable.
 */
function expandLiveBasePath(rawBase: string, trustServerEnv: boolean): string | undefined {
  const afterUser = expandUser(rawBase);
  if (hasEnvVarToken(afterUser)) {
    if (!trustServerEnv) return undefined; // server env unknown → fail closed
    return expandVars(afterUser);
  }
  return afterUser;
}

/**
 * Join a category entry to a truthy `base_path` the way ComfyUI does — via
 * `os.path.join(base, entry)`, for EVERY entry (never treating an absolute-LOOKING
 * entry independently). The load-bearing case is Windows: `os.path.join("D:\\base",
 * "\\unet")` is `D:\\unet` — a drive-RELATIVE `\unet` takes its drive from `base`, NOT
 * the MCP process's current drive. Node's `path.join`/`resolve` would instead produce
 * `C:\\unet` (the cwd drive), so a completely normal Windows config would authorize the
 * WRONG DRIVE and the download would land where ComfyUI can't see it (#633). A fully
 * absolute entry (drive+root, or UNC) still wins (matches os.path.join); a relative
 * entry is base+entry.
 */
function joinCategoryEntryToBase(base: string, entry: string): string {
  if (process.platform === "win32") {
    const isUNC = /^[\\/]{2}/.test(entry);
    const hasDrive = /^[a-zA-Z]:[\\/]/.test(entry);
    const rootedNoDrive = !isUNC && !hasDrive && /^[\\/]/.test(entry);
    // Extended-length / device-namespace bases (`\\?\…`, `\\.\…`) have an exotic
    // splitdrive we deliberately do NOT model — ACCEPTED residual (maintainer ruling:
    // essentially never a hand-written models base_path). Skip prefix extraction for
    // them so we never mis-capture a wrong share; they fall through to the generic join.
    const isDevicePath = /^[\\/]{2}[?.][\\/]/.test(base);
    if (rootedNoDrive && !isDevicePath) {
      // os.path.splitdrive-style prefix of base — a drive letter (`D:`) OR a UNC
      // share (`\\server\share`). A drive-relative `\unet` takes that prefix, so a
      // UNC base's share is preserved (`\\server\share\unet`), not the MCP drive.
      const prefix =
        /^([a-zA-Z]:)/.exec(base)?.[1] ??
        /^([\\/]{2}[^\\/]+[\\/]+[^\\/]+)/.exec(base)?.[1];
      if (prefix) return resolve(prefix + entry); // prefix from base, path from entry
      // base itself is rooted-but-driveless — os.path.join then yields the entry on the
      // current drive, which the fall-through resolve(entry) already produces.
    }
  }
  // Everything else mirrors os.path.join: an absolute entry wins, else base + entry.
  return isAbsolute(entry) ? resolve(entry) : resolve(base, entry);
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

/**
 * The local ComfyUI root whose `extra_model_paths.yaml` a standalone/manual install
 * uses. Delegates to `resolveEffectiveComfyUIBase()` — the SINGLE source of truth every
 * other filesystem-backed tool (download_model, model lookups, verify_custom_node,
 * get_environment) already uses — so this file can never disagree with them about where
 * ComfyUI lives. That order is:
 *
 *   1. `config.comfyuiPath` — COMFYUI_PATH env or auto-detection (wins), then
 *   2. the SAVED DEFAULT WORKSPACE (set_default_workspace), local mode only.
 *
 * Before #648 this read `config.comfyuiPath` DIRECTLY, so with COMFYUI_PATH unset
 * `list_extra_paths` threw while `get_workspace`/`get_environment` happily reported the
 * saved default workspace — the same install, two different answers.
 *
 * Throws (never guesses) when neither is available, INCLUDING remote mode, where
 * `resolveEffectiveComfyUIBase()` deliberately refuses to hand back a local workspace:
 * reporting some other root's model dirs as if they were the live server's is a
 * wrong-destination hazard, so an explicit unresolved error is the only safe answer.
 *
 * STALE-ROOT GUARD (codex rounds 2-3, P1): an INFERRED root — a saved default workspace
 * persisted once and maybe never revisited, or a startup AUTO-DETECTION that has since
 * gone away — has to prove the directory is still THERE before it can be used. Without
 * that check `add_extra_path` would resolve to `<gone root>/extra_model_paths.yaml`,
 * `writeConfigFile`'s recursive `mkdir` would MATERIALIZE the whole vanished tree, and
 * the tool would report "Added … Restart ComfyUI" for a file no ComfyUI will ever read —
 * a silent wrong-destination write. A missing/non-directory inferred root is therefore
 * an explicit error, for READS too: listing a phantom root as an empty config is exactly
 * the authoritative-looking lie this issue is about.
 *
 * An EXPLICIT `COMFYUI_PATH` env var is deliberately NOT gated: that is the user
 * directly naming a root, and its pre-#648 behavior (report `exists:false`, create the
 * dir on write) is left unchanged. `process.env.COMFYUI_PATH` is the discriminator —
 * the same one `getWorkspace()` uses to report `env` vs `auto-detected`.
 *
 * ACCEPTED residual (codex round 3 P2): `statSync` on a saved workspace that lives on a
 * DISCONNECTED UNC share can block for seconds. Not special-cased, because failing
 * closed on `\\server\share` would refuse a perfectly valid NAS install, and the very
 * next steps (`existsSync`/`readFile` on the config file under that same share, which
 * predate this guard) block identically — the guard adds no new class of exposure.
 */
/** Identity of a directory, when the filesystem reports a usable one. Windows leaves
 *  `ino` 0 for directories on some volumes, so it is optional — absent identity degrades
 *  to a plain existence check rather than refusing everything. */
interface DirIdentity {
  dev: number;
  ino: number;
}

function statDir(p: string): { identity?: DirIdentity } | undefined {
  try {
    const st = statSync(p);
    if (!st.isDirectory()) return undefined;
    return Number(st.ino) > 0 && Number(st.dev) > 0
      ? { identity: { dev: Number(st.dev), ino: Number(st.ino) } }
      : {};
  } catch {
    return undefined; // missing, unreadable, or a dangling symlink
  }
}

/**
 * A root whose existence was PROVEN during resolution and must still hold at every
 * point of use. Resolution and I/O are separated by awaits, so a one-time gate is a
 * TOCTOU check — the root can vanish (a read would then report a phantom EMPTY config,
 * the exact authoritative-looking lie this issue is about) or be REPLACED by a different
 * directory at the same pathname (a write would then land in the wrong tree and still
 * report success). `assertRootIntact` is therefore called immediately before every read
 * and again immediately before every write, and compares dev+ino when the filesystem
 * supplies them so a same-path replacement is caught, not just a deletion.
 *
 * ACCEPTED residual: on a volume that reports no usable inode (some Windows directory
 * cases) a replacement swapped in within the final microseconds before `writeFile` is
 * indistinguishable from the original. Single-user local machine, and the window is now
 * bounded by one syscall instead of the whole tool invocation.
 */
type GuardedRootSource = StandaloneRootSource | "live-root";

interface GuardedRoot {
  path: string;
  identity?: DirIdentity;
  source: GuardedRootSource;
}

function guardedRootOrigin(source: GuardedRootSource): string {
  if (source === "default-workspace") return "the saved default workspace (set_default_workspace)";
  if (source === "live-root") return "the running ComfyUI's own install root (from its launch argv)";
  return "a ComfyUI root this process INFERRED (auto-detection, or a nested root descended from COMFYUI_PATH)";
}

function assertRootIntact(guard: GuardedRoot | undefined): void {
  if (!guard) return;
  const now = statDir(guard.path);
  const origin = guardedRootOrigin(guard.source);
  if (!now) {
    throw new ValidationError(
      `UNRESOLVED: "${guard.path}" is no longer an existing directory. It came from ${origin} ` +
        "and disappeared while this call was running. Nothing was read or written — an empty " +
        "result here would look like a config with no extra paths, which is not what is true. " +
        "Re-run set_default_workspace with the current path, set COMFYUI_PATH, or pass " +
        "config_path explicitly.",
    );
  }
  if (
    guard.identity &&
    now.identity &&
    (now.identity.dev !== guard.identity.dev || now.identity.ino !== guard.identity.ino)
  ) {
    throw new ValidationError(
      `UNRESOLVED: "${guard.path}" was REPLACED by a different directory while this call was ` +
        `running (it came from ${origin}). Nothing was read or written — continuing would ` +
        "operate on a tree that is not the one this call resolved. Re-run the operation.",
    );
  }
}

type StandaloneRootSource = "comfyui-path-env" | "comfyui-path-inferred" | "default-workspace";

/** Same NORMALIZED LEXICAL path? (`path.resolve` on both, case-folded on win32.) It does
 *  NOT `realpath`, so 8.3 short names, a symlink vs its target, and UNC vs mapped-drive
 *  spellings of one share compare FALSE. That is the safe direction: a false negative
 *  demotes the root from "explicit" to "inferred", which only means it gets the existence
 *  gate and no `mkdir -p` — over-refusal, never an unguarded write to a wrong root. */
function samePath(a: string, b: string): boolean {
  try {
    const na = resolve(a);
    const nb = resolve(b);
    return process.platform === "win32" ? na.toLowerCase() === nb.toLowerCase() : na === nb;
  } catch {
    return false;
  }
}

function standaloneRoot(): {
  root: string;
  source: StandaloneRootSource;
  guard?: GuardedRoot;
} {
  const root = resolveEffectiveComfyUIBase();
  if (!root) {
    throw new ValidationError(
      "UNRESOLVED: no local ComfyUI path is known, so the standalone " +
        "extra_model_paths.yaml cannot be located" +
        (isRemoteMode()
          ? " (a REMOTE ComfyUI is targeted, and a local workspace is not that server's " +
            "config — reporting one would be wrong). Pass config_path explicitly, or set " +
            "COMFYUI_PATH to the local install you want to inspect."
          : ". Set COMFYUI_PATH, set a default workspace with set_default_workspace, " +
            "or pass config_path explicitly.") +
        " No extra paths are being reported — this is an unresolved lookup, not an empty config.",
    );
  }
  // config.comfyuiPath is what resolveEffectiveComfyUIBase prefers, so its presence (not
  // a re-derivation) separates it from the saved default. Only a root that is LITERALLY
  // what COMFYUI_PATH says is "explicit": config.ts also runs descendToNestedRoot(), so
  // an env var naming a Desktop-installer WRAPPER yields `<wrapper>/ComfyUI` — a path
  // this process INFERRED, which can vanish while the wrapper survives (codex round 4).
  // Anything inferred is gated exactly like the saved default workspace.
  const envPath = process.env.COMFYUI_PATH;
  const source: StandaloneRootSource = !config.comfyuiPath
    ? "default-workspace"
    : envPath && samePath(config.comfyuiPath, envPath)
      ? "comfyui-path-env"
      : "comfyui-path-inferred";
  if (source === "comfyui-path-env") return { root, source };

  const seen = statDir(root);
  if (!seen) {
    const origin =
      source === "default-workspace"
        ? "the saved default workspace (set_default_workspace) — the install was probably moved, renamed or deleted since it was saved"
        : "a ComfyUI root this process INFERRED rather than one you named literally " +
          "(startup auto-detection, or a nested root descended from COMFYUI_PATH) — it has " +
          "since been moved, renamed or deleted";
    throw new ValidationError(
      `UNRESOLVED: "${root}" is not an existing directory, so it cannot be used to locate ` +
        `extra_model_paths.yaml. That path came from ${origin}. Nothing was read or ` +
        "written — refusing to create a config under a root that does not exist, because no " +
        "ComfyUI would ever read it. Re-run set_default_workspace with the current path, set " +
        "COMFYUI_PATH, or pass config_path explicitly.",
    );
  }
  return { root, source, guard: { path: root, identity: seen.identity, source } };
}

/** Whether writing this config may recursively CREATE missing parent directories. False
 *  for an inferred root: it was just verified to exist, so a `mkdir -p` could only ever
 *  fire because the root vanished between the check and the write — and it would then
 *  resurrect the wrong destination instead of failing (codex round 3, P1a TOCTOU). With
 *  it off, that race surfaces as an honest ENOENT. */
interface ResolvedTarget {
  target: Exclude<ExtraPathTarget, "auto">;
  path: string;
  notes: string[];
  createParents: boolean;
  /** Set for an inferred root — re-proved before every read and every write. */
  guard?: GuardedRoot;
}

function standaloneConfigPath(): Omit<ResolvedTarget, "target"> {
  const { root, source, guard } = standaloneRoot();
  return {
    path: join(root, "extra_model_paths.yaml"),
    createParents: source === "comfyui-path-env",
    guard,
    notes:
      source === "default-workspace"
        ? [
            `Resolved from the saved default workspace (${root}) because COMFYUI_PATH is not set. ` +
              `This was NOT confirmed against the running ComfyUI (its live ` +
              `--extra-model-paths-config was not available), so if you have since switched ` +
              `installs this may not be the file the running server reads — check get_workspace ` +
              `and re-run set_default_workspace if it is stale.`,
          ]
        : [],
  };
}

function resolveTargetPath(opts: ExtraPathOptions = {}): ResolvedTarget {
  if (opts.configPath) {
    return {
      target: opts.target === "desktop" ? "desktop" : "standalone",
      path: opts.configPath,
      notes: [],
      createParents: true, // the caller named this exact file
    };
  }

  const target = opts.target ?? "auto";
  if (target === "desktop") {
    return { target, path: desktopConfigPath(), notes: [], createParents: true };
  }
  if (target === "standalone") return { target, ...standaloneConfigPath() };

  const desktop = desktopConfigPath();
  if (existsSync(desktop)) {
    return { target: "desktop", path: desktop, notes: [], createParents: true };
  }
  return { target: "standalone", ...standaloneConfigPath() };
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
  serverResolved = false,
): ExtraPathsConfigInfo {
  const groups: ExtraPathGroup[] = [];
  for (const [name, value] of Object.entries(raw)) {
    const group = readGroup(value, name);
    if (group) groups.push(group);
  }
  const notes = [
    ...extraNotes,
    // The generic "which file" hint only applies to the static-heuristic path; a
    // server-resolved config already states the real file, so skip it to avoid
    // contradicting that. (Keyed on serverResolved, NOT on "any extra note": the
    // static path can now also carry a note — the #648 default-workspace source.)
    ...(serverResolved
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
 * ComfyUI locates its implicit `extra_model_paths.yaml` next to `os.path.realpath(__file__)`
 * — the SYMLINK TARGET of its `main.py`, not the spelling in argv. `liveRootFromArgv` is
 * lexical (it is shared with the #633 authorization path and must not change), so this
 * resolves the real directory here: a launcher that keeps `/launcher/main.py` symlinked to
 * `/installs/B/main.py` makes ComfyUI read `/installs/B/extra_model_paths.yaml`, and
 * writing `/launcher/…` instead would be a silent no-op (codex round 6, P1a).
 *
 * It is the EXACT argv script that is resolved — not a sibling `main.py` picked by name —
 * so a server running `main.pyw` next to an unrelated symlinked `main.py` still resolves
 * to its own root (codex round 7). Requiring the file to RESOLVE also proves the live
 * root is reachable on THIS filesystem: a server in a container/WSL/another machine
 * reports a root we cannot see, and returning undefined there makes the caller refuse
 * explicitly instead of creating a lookalike tree locally and reporting success.
 */
function realLiveRoot(scriptPath: string): string | undefined {
  try {
    const real = realpathSync(scriptPath);
    // A DIRECTORY named main.py would realpath fine and prove nothing (codex round 7).
    if (!statSync(real).isFile()) return undefined;
    return dirname(real);
  } catch {
    return undefined; // not visible from here (container/WSL/another host), or gone
  }
}

/**
 * The `<live root>/extra_model_paths.yaml` a reachable server implicitly reads when it
 * was launched with no `--extra-model-paths-config`. The root is proven (its `main.py`
 * must resolve here) and then GUARDED and `createParents:false` like any other root this
 * process derived rather than the user naming: a reported root can be stale (the server
 * restarted elsewhere) or simply not ours to write to. Throws UNRESOLVED rather than
 * falling back to a static guess — falling back is precisely the wrong-tree write this
 * whole branch exists to stop.
 */
function implicitLiveTarget(
  scriptPath: string,
  opts: ExtraPathOptions,
  unresolvableFlag?: string,
): ResolvedTarget & { serverResolved: boolean } {
  const liveRoot = realLiveRoot(scriptPath);
  const seen = liveRoot ? statDir(liveRoot) : undefined;
  if (!liveRoot || !seen) {
    throw new ValidationError(
      `UNRESOLVED: the running ComfyUI was launched from "${scriptPath}", which cannot be ` +
        "resolved to a file from this process — the server is running on a filesystem this MCP " +
        "cannot see (another machine, a container, or WSL), or it moved since launch. The " +
        "extra_model_paths.yaml it reads sits next to that script, so nothing was read or " +
        "written; creating a lookalike config locally would be a silent no-op. Pass config_path " +
        "explicitly to target a file you can reach, or target: \"standalone\"/\"desktop\" to use " +
        "the local heuristic deliberately.",
    );
  }
  const path = join(liveRoot, "extra_model_paths.yaml");
  const notes = unresolvableFlag
    ? [
        `Resolved to the RUNNING ComfyUI's own extra_model_paths.yaml (${path}). ComfyUI loads this file from its install root whenever it exists, in addition to any --extra-model-paths-config — so edits here (including creating the file) take effect on the next restart.`,
        `NOTE: this server was also launched with a RELATIVE --extra-model-paths-config ("${unresolvableFlag}") and does not report its working directory, so THAT file cannot be located from this process and its entries are not listed here. Pass config_path with its absolute path to view or edit it.`,
      ]
    : [
        `Resolved from the RUNNING ComfyUI's own install root (${liveRoot}): it was launched with no --extra-model-paths-config, so this is the extra_model_paths.yaml it loads from that root (creating the file makes the next restart load it).`,
      ];
  // Divergence diagnostic only — a failing static guess (no COMFYUI_PATH, a vanished
  // saved workspace) must never break the real, live-anchored resolution.
  try {
    const staticGuess = resolveTargetPath(opts);
    if (resolve(staticGuess.path) !== resolve(path)) {
      notes.push(
        `NOTE: this differs from the path the static heuristic would have used (${staticGuess.path}) — e.g. a saved default workspace or COMFYUI_PATH pointing at a DIFFERENT install than the one running. Editing that other file would be a silent no-op: the running server does not read it. Pass config_path explicitly to target it anyway.`,
      );
    }
  } catch {
    // No static guess available — the live-resolved path stands on its own.
  }
  return {
    target: "standalone",
    path,
    notes,
    serverResolved: true,
    createParents: false, // the root is proven; only the YAML itself may be missing
    guard: { path: liveRoot, identity: seen.identity, source: "live-root" },
  };
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
 *
 * A server launched WITHOUT that flag still reads one: ComfyUI auto-loads
 * `<its own main.py root>/extra_model_paths.yaml`. So when the flag is absent but the
 * live root IS derivable from argv, that implicit file is used — it is what the running
 * server reads, and a reachable server is authoritative about that. Without this step a
 * saved default workspace `A` that merely EXISTS would take a successful write while the
 * live server runs from `B` and reads `B/extra_model_paths.yaml`: the user is told
 * "Added … Restart ComfyUI" and the path is simply not there afterwards. The stale-root
 * existence gate cannot catch that — `A` is real, just not the one in use — so the fix
 * has to be resolving from the live server rather than warning about a divergence.
 * Skipped in remote mode (the live root is a path on the remote host).
 *
 * Everything the live server contributes comes from ONE `/system_stats` snapshot, so the
 * launch flags and the install root can never be read from two different server states.
 * And when the server IS reachable but tells us nothing usable — a relative
 * `--extra-model-paths-config` with no reported cwd, or an argv with no `main.py` — the
 * answer is an explicit UNRESOLVED, never a quiet fall-through to the local heuristic:
 * we would be guessing at a file the running server does not read, and "success" on that
 * guess is exactly the silent no-op this branch exists to stop. `target`/`config_path`
 * remain the deliberate escape hatch, and both short-circuit above this.
 */
async function resolveTargetPathPreferServer(
  opts: ExtraPathOptions = {},
): Promise<ResolvedTarget & { serverResolved: boolean }> {
  // Explicit config_path or an explicit non-auto target: honor the caller.
  if (opts.configPath || (opts.target && opts.target !== "auto")) {
    return { ...resolveTargetPath(opts), serverResolved: false };
  }

  const snapshot = await getLiveServerSnapshot(); // remote/unreachable → reachable:false
  if (!snapshot.reachable) {
    return { ...resolveTargetPath(opts), serverResolved: false };
  }

  // LOCALITY PROOF (codex round 9, P2b): when argv names a main.py that does NOT resolve
  // to a real file here, the server's filesystem is not ours (a container/WSL/remote host
  // behind a loopback port). Nothing derived from its argv — including an ABSOLUTE
  // --extra-model-paths-config, which could name a same-spelled path on OUR disk — may be
  // written to in that state. Proven once, for every argv-derived branch below.
  const script = liveScriptFromArgv(snapshot.argv, snapshot.cwd);
  if (script && !realLiveRoot(script)) {
    throw new ValidationError(
      `UNRESOLVED: the running ComfyUI was launched from "${script}", which does not resolve to ` +
        "a file on this filesystem — the server is running in a container, WSL, or on another " +
        "host reached over the network. Its config paths name files on ITS disk, so a same-" +
        "spelled path here would be a different file and the edit would be a silent no-op. " +
        "Nothing was read or written — pass config_path explicitly with a file you can reach, " +
        'or target: "standalone"/"desktop" to use the local heuristic deliberately.',
    );
  }

  const rawFlags = parseExtraModelPathsConfigsFromArgvRaw(snapshot.argv);
  if (rawFlags.length === 0) {
    // No flag — ComfyUI loads the yaml next to its own main.py when that file exists.
    if (script) return implicitLiveTarget(script, opts);
    throw new ValidationError(
      "UNRESOLVED: the running ComfyUI was not launched with --extra-model-paths-config and " +
        "its launch argv does not reveal a main.py, so the extra_model_paths.yaml it reads " +
        "cannot be located. Nothing was read or written — the local heuristic would just be a " +
        'guess at a file this server may not read. Pass config_path explicitly, or target: ' +
        '"standalone"/"desktop" to use the local heuristic deliberately.',
    );
  }

  // ComfyUI resolves a launch flag with os.path.abspath, i.e. against the SERVER's cwd.
  // A relative value with no reported server cwd is UNRESOLVABLE from here: anchoring it
  // to this process's cwd/COMFYUI_PATH would target a same-named file in the wrong tree
  // (the same rule #346 applies to --output-directory and #633 to authorization).
  const rawFlag = rawFlags[0];
  const serverConfig = isAbsolute(rawFlag)
    ? resolve(rawFlag)
    : snapshot.cwd && isAbsolute(snapshot.cwd)
      ? resolve(snapshot.cwd, rawFlag)
      : undefined;
  if (!serverConfig) {
    // The flagged file cannot be located — but ComfyUI ALSO loads
    // <its own root>/extra_model_paths.yaml whenever that file exists, IN ADDITION to
    // every --extra-model-paths-config, and creating it makes the next restart load it.
    // So that file is a destination this server provably reads. Target it (and say what
    // is missing) instead of refusing: `/system_stats` does not report cwd on current
    // ComfyUI, so a refusal here would break the ordinary
    // `cd /opt/ComfyUI && python main.py --extra-model-paths-config extra.yaml` launch
    // outright (codex round 8, P1). Only when NEITHER file can be located do we refuse.
    if (script) return implicitLiveTarget(script, opts, rawFlag);
    throw new ValidationError(
      `UNRESOLVED: the running ComfyUI was launched with a RELATIVE --extra-model-paths-config ` +
        `("${rawFlag}") and reports neither its working directory nor a main.py, so no file it ` +
        "reads can be located from this process. Resolving the flag here would point at a " +
        "same-named file under this MCP's own directory and the edit would be a silent no-op. " +
        "Nothing was read or written — pass config_path explicitly with the absolute path the " +
        "server uses.",
    );
  }

  const notes = [
    `Resolved from the running ComfyUI's --extra-model-paths-config launch flag (the file the live server actually reads): ${serverConfig}`,
  ];
  // This tool reports ONE file, but ComfyUI aggregates every --extra-model-paths-config
  // it was given PLUS <its root>/extra_model_paths.yaml when that exists. Naming the
  // others keeps the result from reading as "all the server's extra paths" when it is
  // one of several (codex round 9, P2a).
  const alsoLoaded = [
    ...rawFlags.slice(1),
    ...(script && existsSync(join(dirname(script), "extra_model_paths.yaml"))
      ? [join(dirname(script), "extra_model_paths.yaml")]
      : []),
  ];
  if (alsoLoaded.length > 0) {
    notes.push(
      `NOTE: this is ONE of several configs the running ComfyUI loads — it also reads ${alsoLoaded.join(", ")}. Those entries are not listed here; pass config_path to view or edit each one.`,
    );
  }
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
  return {
    target: isDesktop ? "desktop" : "standalone",
    path: serverConfig,
    notes,
    serverResolved: true,
    // The live server told us this file, so its directory exists by construction.
    createParents: true,
  };
}

export async function listExtraPaths(
  opts: ExtraPathOptions = {},
): Promise<ExtraPathsConfigInfo> {
  const resolved = await resolveTargetPathPreferServer(opts);
  // Point of use: an inferred root that vanished between resolution and this read must
  // surface as UNRESOLVED, NOT as a normal empty config (readConfigFile maps a missing
  // file to {}, which would look authoritative — the exact failure #648 is about).
  assertRootIntact(resolved.guard);
  const raw = await readConfigFile(resolved.path);
  assertRootIntact(resolved.guard);
  return summarize(resolved.target, resolved.path, raw, resolved.notes, resolved.serverResolved);
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

  // Whether it is safe to expand a config `$VAR`/`%VAR%` against process.env: ONLY a
  // LOCAL server THIS MCP launched (which inherited our env) shares our environment;
  // a separately-launched/remote server may have a different env, so its config vars
  // must NOT be resolved against ours (#633 P1b).
  const trustServerEnv = !isRemoteMode() && didLaunchLocalComfyUI();

  const roots: ExtraModelRoot[] = [];
  for (const cfg of configPaths) {
    if (!existsSync(cfg)) continue;
    let raw: Record<string, unknown>;
    try {
      // ACCEPTED (intentional, not a defect — maintainer ruling): this reads the config's
      // CURRENT contents at download time, which may include a root the USER added AFTER
      // ComfyUI started but before restarting it. Authorizing a download to a root the
      // user just configured on their OWN machine is the desired behavior ("downloads go
      // where the user wants"); it becomes visible to ComfyUI on its next restart.
      raw = parseConfig(await readFile(cfg, "utf-8"));
    } catch {
      continue; // unreadable/malformed — skip; never authorize from a bad file
    }
    // Match ComfyUI: relative entries resolve against the YAML file's OWN directory.
    const cfgDir = dirname(resolve(cfg));
    for (const [name, value] of Object.entries(raw)) {
      const group = readGroup(value, name);
      if (!group) continue;
      // ComfyUI expands `~`/env vars in base_path (expanduser THEN expandvars) BEFORE
      // classifying absolute vs relative (utils/extra_config.py), so `base_path: ~/models`
      // registers the real $HOME root (and a legit symlink into it is authorized). A
      // base_path needing an env var we can't resolve against the server's env is
      // UNRESOLVABLE → drop the whole group (fail-closed). Category subpath entries are
      // left LITERAL, exactly as ComfyUI leaves them (#633 P1a/P1b).
      let base: string | undefined;
      if (group.base_path) {
        const expanded = expandLiveBasePath(group.base_path.trim(), trustServerEnv);
        if (expanded === undefined) continue; // unresolvable base_path → skip this group
        base = isAbsolute(expanded) ? resolve(expanded) : resolve(cfgDir, expanded);
      }
      for (const category of group.categories) {
        for (const p of category.paths) {
          // With a base_path, EVERY entry is os.path.join'd to it (incl. the Windows
          // drive-relative case) — never treated independently just because it looks
          // absolute. Only with NO base_path is an absolute entry used on its own.
          const dir = base
            ? joinCategoryEntryToBase(base, p)
            : isAbsolute(p)
              ? resolve(p)
              : resolve(cfgDir, p);
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

async function writeConfigFile(
  path: string,
  raw: Record<string, unknown>,
  createParents: boolean,
  guard?: GuardedRoot,
): Promise<void> {
  // Last check before the bytes land: the guarded root must still be the SAME existing
  // directory this call resolved (deleted → UNRESOLVED; replaced → UNRESOLVED).
  assertRootIntact(guard);
  // With createParents=false the root was already verified to exist, so skipping the
  // `mkdir -p` costs nothing in the normal case and turns the check→write race into an
  // honest ENOENT instead of silently RESURRECTING a vanished install and writing there.
  if (createParents) await mkdir(dirname(path), { recursive: true });
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

  assertRootIntact(resolved.guard);
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
    await writeConfigFile(resolved.path, raw, resolved.createParents, resolved.guard);
  }
  const info = summarize(resolved.target, resolved.path, raw, resolved.notes, resolved.serverResolved);
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

  assertRootIntact(resolved.guard);
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
      await writeConfigFile(resolved.path, raw, resolved.createParents, resolved.guard);
    }
  }
  const info = summarize(resolved.target, resolved.path, raw, resolved.notes, resolved.serverResolved);
  return {
    ...info,
    changed,
    message: changed
      ? `Removed ${removePath} from ${groupName}.${category}. Restart ComfyUI to apply it.`
      : `${removePath} was not present in ${groupName}.${category}.`,
  };
}
