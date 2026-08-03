// Installs / updates / reinstalls the ComfyUI sidebar panel
// ("comfyui-agent-panel" on the Comfy Registry; repo comfyui-mcp-panel) into a
// LOCAL ComfyUI's custom_nodes, and auto-ensures it on MCP load.
//
// Policy (decided by the user):
//   - on load → install if MISSING (install-if-missing only, see ensurePanelInstalled).
//   - explicit `update` action → pull the latest nightly on demand. When
//     ComfyUI-Manager provably no-ops the update (stale legacy 3.x, #724) and
//     the panel dir is a real git checkout, fall back to a pinned `git merge --ff-only`
//     on the panel repo, verified on disk by the same #639 machinery.
//   - target version is always "nightly" (the registry git-HEAD channel) — there
//     is no clean semver to diff, so we never churn an existing install on load.
//
// SAFETY:
//   - LOCAL-only: no COMFYUI_PATH → no-op cleanly (remote/cloud modes).
//   - NEVER touch a dev install: custom_nodes/comfyui-mcp-panel is often a
//     SYMLINK/junction to the developer's working repo. lstat → skip/refuse.
//   - on-load ensure is fire-and-forget, hard-timed-out, and never throws.
//   - opt-out env COMFYUI_MCP_PANEL_AUTOINSTALL=0/false disables auto-ensure.
//   - install/update/reinstall queue via ComfyUI-Manager; ComfyUI must be
//     RESTARTED to load the new/updated node (we never auto-restart).

import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { config, isLocalMode } from "../config.js";
import { logger } from "../utils/logger.js";
import { parsePyproject } from "./node-authoring.js";
import {
  installCustomNode,
  updateCustomNode,
  reinstallCustomNode,
  nonInteractiveGitEnv,
  type NodeOpResult,
} from "./node-management.js";
import { getSystemStats } from "../comfyui/client.js";
import {
  describePanelPin,
  getPanelPinState,
  PANEL_PIN_ENV_VAR,
  type PanelPinState,
} from "./panel-settings.js";
import { withPanelMutationLock } from "./panel-pin-guard.js";
import { describePanelUpdateRecovery, PANEL_REPO_URL } from "./panel-recovery.js";
import { compareSemver } from "./self-update.js";
import { SEMVER_RE } from "./ui-bridge.js";
import {
  clearPanelDiskObservation,
  lastPanelBaseResolution,
  panelBaseSync,
  primePanelBase,
  recordPanelDiskObservation,
  type PanelBaseSource,
} from "./panel-workspace.js";

/** Comfy Registry id (also pyproject [project].name). Authoritative for detection. */
export const PANEL_REGISTRY_ID = "comfyui-agent-panel";

/** Always install/update/reinstall the panel from the registry git-HEAD channel. */
export const PANEL_VERSION = "nightly";

/**
 * Fast-path directory names to probe first. The panel installs to a custom_nodes
 * subdir named after the REPO ("comfyui-mcp-panel"), but the registry name is
 * "comfyui-agent-panel" — so check both quickly, then fall back to a full scan.
 * The pyproject `name == comfyui-agent-panel` match is always authoritative.
 */
const FAST_PATH_DIRS = ["comfyui-mcp-panel", "comfyui-agent-panel"];

/** Hard cap so the on-load ensure can never block startup. */
const ENSURE_TIMEOUT_MS = 20_000;

/** How long the fire-and-forget on-load ensure will wait for the panel op lock
 *  before giving up (well inside ENSURE_TIMEOUT_MS, so a lock held by another
 *  orchestrator process degrades to `unavailable` rather than a timeout). */
const ENSURE_LOCK_WAIT_MS = 3_000;

export class PanelInstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PanelInstallError";
  }
}

// ---------------------------------------------------------------------------
// Injectable deps (mirrors node-authoring's pattern for clean unit tests)
// ---------------------------------------------------------------------------

export interface PanelInstallerDeps {
  /**
   * True only in LOCAL mode. In remote (--comfyui-url) / cloud mode the Manager
   * mutations target a REMOTE host, so panel install/update/reinstall must be
   * refused even when COMFYUI_PATH happens to be set (the local FS scan would be
   * the WRONG filesystem). The on-load ensure also no-ops.
   */
  isLocalMode: () => boolean;
  /** Resolved local ComfyUI root, or undefined when no local workspace is known. */
  comfyuiPath: () => string | undefined;
  /** Process env (for the opt-out flag). */
  env: () => NodeJS.ProcessEnv;
  existsSync: (p: string) => boolean;
  /**
   * Tri-state REGULAR-FILE probe: true = a regular file exists at `p`, false =
   * confirmed not-a-servable-file (ENOENT, ENOTDIR, or it exists but is a
   * directory), undefined = could not determine (EACCES/EIO/…). Used to detect a
   * served web asset — only a regular file is served, and unlike existsSync
   * (which collapses every error to false), an indeterminate probe lets the
   * shadow scan fail closed instead of silently omitting a served copy. Never
   * throws.
   */
  probeFile: (p: string) => boolean | undefined;
  /** True when `p` is a symlink/junction (dev install). Never throws. */
  isSymlink: (p: string) => boolean;
  /**
   * Tri-state directory check (following symlinks): true = directory, false =
   * CONFIRMED non-directory (a regular file), undefined = COULD NOT DETERMINE
   * (stat error). Callers must only SKIP an entry on an explicit `false`; an
   * undefined must be treated as a possible directory (fail closed). Never throws.
   */
  isDirectory: (p: string) => boolean | undefined;
  /**
   * Canonical physical path of `p` (resolves symlinks + the real on-disk case),
   * or undefined if it can't be resolved. Used to decide whether two entries are
   * the SAME directory independent of case-sensitivity quirks. Never throws.
   */
  realPath: (p: string) => string | undefined;
  readdir: (p: string) => string[];
  readFile: (p: string) => string;
  /**
   * Resolve the git commit sha the pack dir's checkout is currently at (HEAD),
   * or undefined if it isn't a git checkout / can't be resolved. Used to detect
   * a `nightly` (git-HEAD) update that advanced the COMMIT without bumping the
   * pyproject version string. Never throws.
   */
  gitRevision: (dir: string) => string | undefined;
  /**
   * `git status --porcelain` in the panel's checkout — the #724 fallback's
   * cleanliness gate, checked BEFORE any pull: a fast-forward only refuses
   * local edits it overlaps, so a dirty worktree (modified tracked files in
   * untouched paths, staged changes, untracked files) must refuse the fallback
   * outright — comfyui-mcp never mutates a dirty checkout. Returns the raw
   * porcelain output (empty = clean). THROWS when git itself fails; callers
   * treat that as "cannot prove clean", never as clean.
   */
  gitStatusPorcelain: (dir: string) => string;
  /**
   * `git fetch --quiet` — refreshes the tracked remote ref WITHOUT touching
   * the worktree. The #724 fallback fetches ONCE, then pins every later
   * check (the ignored-file collision proof) and the mutation itself to the
   * fetched sha, so a remote commit landing mid-flight can never slip an
   * uninspected change into the merge (codex gate: no double-fetch race).
   * THROWS on any failure — "cannot prove currency" refuses.
   */
  gitFetch: (dir: string) => void;
  /**
   * `git merge --ff-only <rev>` in the panel's own checkout — the #724
   * fallback's mutation, pinned to the EXACT upstream sha the caller fetched
   * and inspected (never a second fetch). `--ff-only` can only fast-forward:
   * it never merges, never rebases, and refuses a diverged checkout. Only
   * ever called for a resolved git checkout whose worktree passed the
   * gitStatusPorcelain cleanliness gate and the ignored-file collision
   * proof against this same rev. Returns git's trimmed output. THROWS on
   * any failure — a throw means "could not update", never "nothing to pull".
   */
  gitMergeFfOnly: (dir: string, rev: string) => string;
  /**
   * `git rev-parse --show-toplevel` — proves this dir IS the checkout root
   * (not merely has git metadata) before any fallback mutation. THROWS on
   * failure; callers refuse unless the resolved root is the panel dir.
   */
  gitWorktreeRoot: (dir: string) => string;
  /**
   * `git rev-parse @{upstream}` — the tracked remote's sha. THROWS when no
   * upstream is configured; callers treat that as “cannot prove currency”.
   */
  gitUpstreamRev: (dir: string) => string;

  /**
   * Ignored local files a fast-forward to `upstreamRev` would SILENTLY
   * OVERWRITE (git protects untracked files from checkout, but NOT ignored
   * ones): the ignored untracked files intersected with the diff
   * HEAD..upstreamRev. The rev MUST be the same pinned sha the caller then
   * merges, so the proof covers the exact mutation (codex gate). The #724
   * fallback refuses when this returns anything. THROWS when it cannot
   * prove the intersection — "cannot prove" refuses.
   */
  gitIgnoredPullConflicts: (dir: string, upstreamRev: string) => string[];
  /**
   * #771 — `git clone --depth 1 <panel repo> <destDir>`, for the REGISTRY-ZIP
   * install shape. A panel installed from the Comfy Registry is an unpacked zip
   * with NO `.git`, so the #724 fast-forward has nothing to fast-forward and the
   * Manager cannot resolve it either. The only remaining honest remedy is to
   * fetch a fresh copy and swap it in. THROWS on any failure — a partial clone
   * must never be swapped over a working install.
   *
   * OPTIONAL, along with the three filesystem primitives below, and they are
   * required as a SET: a caller that supplies only some of them would fail
   * halfway through a swap. When any is absent the reinstall fallback is simply
   * unavailable and the update reports the honest "could not update" error it
   * reported before #771 — never a partial mutation.
   */
  gitClonePanel?: (destDir: string) => void;
  /** Create a directory (and parents). THROWS on failure. */
  mkdirp?: (p: string) => void;
  /** Rename/move a path. THROWS on failure. Same-volume moves only. */
  rename?: (from: string, to: string) => void;
  /** Recursively remove a path; must NOT throw when it is already absent. */
  removeDir?: (p: string) => void;
  /**
   * The user's explicit panel-version pin, if any. While a pin is in force NO
   * code path here may move the panel — install/update/reinstall refuse and the
   * on-load ensure skips. Never throws (an unreadable pin reports
   * `indeterminate`, which counts as pinned).
   */
  readPin: () => PanelPinState;
  /**
   * Detect the connected Manager's API dialect ("legacy" 3.x | "v2"/"v2-batch" v4).
   * The #724 git fallback fires ONLY on "legacy": an empty-queue signature is
   * indistinguishable from an outage/failed enqueue on other dialects, and a git
   * mutation is only warranted on the PROVEN stale-3.x host (codex gate). Default
   * is the real detectManagerApi; tests stub it.
   */
  detectManagerDialect?: ((base?: string) => Promise<"v2" | "v2-batch" | "legacy" | undefined>) | undefined;
  /** Is the target ComfyUI reachable right now? Never throws. */
  isReachable: () => Promise<boolean>;
  install: (opts: { id: string; version?: string }) => Promise<NodeOpResult>;
  update: (opts: { id: string }) => Promise<NodeOpResult>;
  reinstall: (opts: { id: string; version?: string }) => Promise<NodeOpResult>;
}

/**
 * Resolve the current commit sha of a git checkout at `dir` by reading its
 * `.git` metadata directly (no subprocess). Handles a normal `.git/` dir, a
 * `.git` FILE pointer (worktrees/submodules: `gitdir: <path>`), a symbolic HEAD
 * (`ref: refs/heads/<branch>`) resolved via loose refs then `packed-refs`, and a
 * detached HEAD (raw sha). Returns undefined and NEVER throws on any failure.
 */
export function resolveGitRevision(dir: string): string | undefined {
  const read = (p: string): string | undefined => {
    try {
      return readFileSync(p, "utf-8");
    } catch {
      return undefined;
    }
  };
  try {
    let base = join(dir, ".git");
    let st;
    try {
      st = lstatSync(base);
    } catch {
      return undefined;
    }
    if (st.isFile()) {
      const pointer = (read(base) ?? "").trim();
      const m = pointer.match(/^gitdir:\s*(.+)$/);
      if (!m) return undefined;
      base = isAbsolute(m[1]) ? m[1] : join(dir, m[1]);
    }
    const head = (read(join(base, "HEAD")) ?? "").trim();
    if (!head) return undefined;
    const refM = head.match(/^ref:\s*(.+)$/);
    if (!refM) {
      // Detached HEAD → the sha is inline.
      // A FULL SHA-1 (40) or SHA-256 (64) object id — never a truncated value.
      return /^([0-9a-f]{40}|[0-9a-f]{64})$/i.test(head) ? head : undefined;
    }
    const refPath = refM[1].trim();
    // A resolved ref value must be a real commit sha — never return transient or
    // symbolic content (e.g. "ref: ...", "updating") that would look like a
    // spurious HEAD move and fabricate a successful update.
    const asSha = (v: string | undefined): string | undefined => {
      const t = (v ?? "").trim();
      // FULL SHA-1 (40) or SHA-256 (64) only — reject truncated/abbreviated ids.
      return /^([0-9a-f]{40}|[0-9a-f]{64})$/i.test(t) ? t : undefined;
    };
    // A linked worktree keeps HEAD in its per-worktree gitdir but the shared refs
    // (loose + packed-refs) in `commondir`. Search the gitdir first, then it.
    const searchDirs = [base];
    const commondir = (read(join(base, "commondir")) ?? "").trim();
    if (commondir) {
      searchDirs.push(isAbsolute(commondir) ? commondir : join(base, commondir));
    }
    for (const d of searchDirs) {
      const loose = asSha(read(join(d, refPath)));
      if (loose) return loose;
      const packed = read(join(d, "packed-refs"));
      if (packed) {
        for (const line of packed.split(/\r?\n/)) {
          if (!line || line.startsWith("#") || line.startsWith("^")) continue;
          const sp = line.indexOf(" ");
          if (sp <= 0) continue;
          if (line.slice(sp + 1).trim() === refPath) {
            const sha = asSha(line.slice(0, sp));
            if (sha) return sha;
          }
        }
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** Hard cap on the #724 fallback git fetch/merge (a fetch + fast-forward). */
const PANEL_GIT_PULL_TIMEOUT_MS = 180_000;

/** `git status` is local metadata — a short cap is plenty. */
const PANEL_GIT_STATUS_TIMEOUT_MS = 30_000;

/**
 * Run a read-or-mutate git command in the panel checkout, never prompting for
 * credentials (nonInteractiveGitEnv). Returns trimmed stdout. THROWS a
 * PanelInstallError with git's stderr on any failure — a clean exit is the
 * only signal the command actually did its work.
 */
function runGit(dir: string, args: string[], timeoutMs: number): string {
  try {
    const out = execFileSync("git", args, {
      cwd: dir,
      encoding: "utf-8",
      timeout: timeoutMs,
      env: nonInteractiveGitEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    return (out ?? "").trim();
  } catch (err) {
    const e = err as {
      stdout?: Buffer | string;
      stderr?: Buffer | string;
      message?: string;
    };
    const detail = [e.stdout, e.stderr]
      .map((b) => (b == null ? "" : b.toString()))
      .join("")
      .trim();
    throw new PanelInstallError(
      `git ${args.join(" ")} in ${dir} failed: ${detail || e.message || "unknown error"}`,
    );
  }
}

/**
 * `git status --porcelain` in the panel's checkout — the #724 fallback's
 * CLEANLINESS gate. Empty output = clean; anything else (modified tracked
 * files, staged changes, untracked files) means the fallback must REFUSE:
 * `git pull --ff-only` only refuses local edits that OVERLAP the fast-forward,
 * so edits in untouched paths would be silently carried through our mutation.
 * THROWS when git itself fails, which callers must treat as "cannot prove
 * clean" — never as clean.
 */
export function gitStatusPorcelain(dir: string): string {
  return runGit(dir, ["status", "--porcelain"], PANEL_GIT_STATUS_TIMEOUT_MS);
}

/**
 * `git fetch --quiet` — refresh the tracked remote ref without touching the
 * worktree. THROWS a PanelInstallError with git's stderr on any failure.
 */
export function gitFetch(dir: string): void {
  runGit(dir, ["fetch", "--quiet"], PANEL_GIT_PULL_TIMEOUT_MS);
}

/**
 * `git merge --ff-only <rev>` in the panel's own checkout — the #724 fallback
 * for hosts where ComfyUI-Manager provably no-ops updates (stale legacy 3.x).
 * The rev is PINNED: the caller fetched once, proved no ignored-file
 * collision against this exact sha, and only then merges it — a `git pull`
 * would fetch AGAIN and could apply a newer, uninspected commit (codex gate).
 * `--ff-only` can only fast-forward: it never merges, never rebases, and
 * refuses a diverged checkout. Callers MUST gate it on gitStatusPorcelain
 * first — a fast-forward does NOT refuse dirty paths it doesn't overlap, and
 * comfyui-mcp never mutates a dirty checkout. THROWS a PanelInstallError with
 * git's stderr on any failure.
 */
export function gitMergeFfOnly(dir: string, rev: string): string {
  return runGit(dir, ["merge", "--ff-only", rev], PANEL_GIT_PULL_TIMEOUT_MS);
}

/**
 * `git rev-parse --show-toplevel` for the #724 fallback: a `.git` pointer
 * proves metadata exists, NOT that this directory is the worktree ROOT — a
 * copied/stale gitdir could make status/pull mutate a sibling checkout while
 * the report credits the panel repo (codex gate). THROWS on any failure;
 * callers refuse unless the resolved root IS the panel dir.
 */
/**
 * #771 — shallow-clone the panel repo into `destDir`, which MUST NOT exist.
 *
 * Run from `destDir`'s PARENT rather than from destDir (which isn't there yet),
 * and with `--end-of-options` so a path that begins with `-` can never be read
 * as a git flag. The clone URL is our own compile-time constant, never caller
 * input, so there is nothing to inject through it.
 */
export function gitClonePanel(destDir: string): void {
  runGit(
    dirname(destDir),
    ["clone", "--depth", "1", "--end-of-options", PANEL_REPO_URL, destDir],
    PANEL_GIT_PULL_TIMEOUT_MS,
  );
}

export function gitWorktreeRoot(dir: string): string {
  return runGit(dir, ["rev-parse", "--show-toplevel"], PANEL_GIT_STATUS_TIMEOUT_MS).trim();
}

/** `git rev-parse @{upstream}` — the sha the checkout tracks. THROWS when no
 *  upstream is configured; the "at upstream tip" claim requires this proof. */
export function gitUpstreamRev(dir: string): string {
  return runGit(dir, ["rev-parse", "@{upstream}"], PANEL_GIT_STATUS_TIMEOUT_MS).trim();
}

/**
 * Ignored-file collision proof for the #724 fallback (codex gate): `git status
 * --porcelain` omits ignored files, and a fast-forward does NOT protect them —
 * when the remote newly tracks a path that is locally ignored, the merge
 * silently overwrites the local file. Intersect the ignored untracked files
 * with the diff HEAD..upstreamRev, where upstreamRev is the SAME pinned sha
 * the caller then merges, so the proof covers the exact mutation. THROWS
 * (PanelInstallError) when the proof cannot be computed — callers treat that
 * as "cannot prove safe", never as safe.
 */
export function gitIgnoredPullConflicts(dir: string, upstreamRev: string): string[] {
  const ignored = runGit(
    dir,
    ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"],
    PANEL_GIT_STATUS_TIMEOUT_MS,
  )
    .split("\0")
    .filter(Boolean);
  if (ignored.length === 0) return [];
  const incoming = new Set(
    runGit(dir, ["diff", "--name-only", "-z", "HEAD", upstreamRev], PANEL_GIT_STATUS_TIMEOUT_MS)
      .split("\0")
      .filter(Boolean),
  );
  return ignored.filter((f) => incoming.has(f));
}

export const defaultDeps: PanelInstallerDeps = {
  isLocalMode: () => isLocalMode(),
  // #766/#769 — LIVE-FIRST. The panel is not a file the user reads; it is a web
  // extension the RUNNING ComfyUI serves to the browser tab, so the only
  // custom_nodes that can matter is the one belonging to the server we are
  // connected to. `panelBaseSync` prefers the live server's `--base-directory`
  // (Comfy Desktop keeps custom_nodes there, NOT next to main.py — #766) and
  // then its argv root (#769), falling back to the ordinary sync resolver —
  // COMFYUI_PATH, then a saved default workspace (#700) — when the server is
  // unreachable or its argv yields nothing. See panel-workspace.ts.
  comfyuiPath: () => panelBaseSync(),
  env: () => process.env,
  existsSync,
  probeFile: (p) => {
    try {
      return statSync(p).isFile(); // true = regular file, false = exists but a dir
    } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code;
      // ENOENT/ENOTDIR = confirmed no servable file here; else indeterminate.
      return code === "ENOENT" || code === "ENOTDIR" ? false : undefined;
    }
  },
  isSymlink: (p) => {
    try {
      return lstatSync(p).isSymbolicLink();
    } catch {
      return false;
    }
  },
  isDirectory: (p) => {
    try {
      // statSync follows symlinks: a dir symlink IS web-served, so it counts.
      return statSync(p).isDirectory();
    } catch {
      // Could not determine — return undefined so the caller fails closed rather
      // than treating a served backup as a skippable "file".
      return undefined;
    }
  },
  realPath: (p) => {
    try {
      // .native returns the real on-disk case on Windows/macOS.
      return realpathSync.native(p);
    } catch {
      return undefined;
    }
  },
  readdir: (p) => readdirSync(p),
  readFile: (p) => readFileSync(p, "utf-8"),
  gitRevision: (dir) => resolveGitRevision(dir),
  gitStatusPorcelain: (dir) => gitStatusPorcelain(dir),
  gitFetch: (dir) => gitFetch(dir),
  gitMergeFfOnly: (dir, rev) => gitMergeFfOnly(dir, rev),
  gitWorktreeRoot: (dir) => gitWorktreeRoot(dir),
  gitUpstreamRev: (dir) => gitUpstreamRev(dir),
  gitIgnoredPullConflicts: (dir, rev) => gitIgnoredPullConflicts(dir, rev),
  gitClonePanel: (destDir) => gitClonePanel(destDir),
  mkdirp: (p) => {
    mkdirSync(p, { recursive: true });
  },
  rename: (from, to) => renameSync(from, to),
  removeDir: (p) => rmSync(p, { recursive: true, force: true }),
  readPin: () => getPanelPinState(),
  isReachable: async () => {
    try {
      await getSystemStats();
      return true;
    } catch {
      return false;
    }
  },
  install: (opts) => installCustomNode(opts),
  update: (opts) => updateCustomNode(opts),
  reinstall: (opts) => reinstallCustomNode(opts),
};

/**
 * Resolve the LIVE ComfyUI base once, at the START of a panel operation, so
 * every `deps.comfyuiPath()` inside it agrees (#766/#769).
 *
 * The resolution needs `/system_stats`, so it is async, while the dep is sync
 * and is read from several places within one operation — detection, the shadow
 * scan, the post-op re-read. If those could disagree, the "did the pack MOVE?"
 * proof would be comparing two different directories, which is the one thing
 * this file must never do.
 *
 * Only fires for the REAL deps. An injected dep set has already declared where
 * ComfyUI is; probing a live server would be both pointless and, in tests,
 * a network call nobody asked for.
 */
async function primeBaseFor(deps: PanelInstallerDeps): Promise<void> {
  if (deps !== defaultDeps) return;
  await primePanelBase();
}

// ---------------------------------------------------------------------------
// Version pin
//
// A pin is the user's explicit "hold the panel here". Every mutating path in
// this file consults it FIRST and refuses while it is in force — the on-load
// ensure, install, update and reinstall alike. The escape hatch is to clear the
// pin (install_panel(action='unpin'), or COMFYUI_MCP_PANEL_PIN=off), never for
// us to decide the pin was probably fine to ignore.
// ---------------------------------------------------------------------------

/**
 * Read the pin so that NO failure mode reads as "unpinned". A reader that throws
 * is reported as an indeterminate pin, which counts as pinned: silently moving a
 * user off a pin we merely failed to read is the exact bug this guards.
 */
function readPinSafe(deps: PanelInstallerDeps): PanelPinState {
  try {
    return deps.readPin();
  } catch (err) {
    logger.warn(
      `[panel] could not read the panel version pin: ${
        err instanceof Error ? err.message : String(err)
      } — treating the panel as PINNED (refusing to move it).`,
    );
    return { pinned: true, source: "settings", indeterminate: true };
  }
}

/*
 * Serializes every panel MUTATION (the on-load ensure and each
 * install/update/reinstall). Two overlapping panel ops would each read the
 * other's half-applied disk state, and the #639 "did it move?" proof compares a
 * pre-image against a post-image — interleave them and both comparisons are
 * meaningless. One at a time makes each op's before/after its own.
 *
 * It also closes the pin race: the final pin check (assertNotPinned, immediately
 * before the Manager call) and the call itself sit inside this critical section,
 * so a pin cannot be written in between — by this process OR another one.
 */
/**
 * Exported so PIN WRITES take the same lock. Without that, a pin could be
 * committed after an in-flight update passed its final pin check but before the
 * Manager actually touched disk — the update would then land on a now-pinned
 * install and report success. Serializing both means a pin either lands before
 * an op starts (and blocks it) or after it finishes (and blocks the next one);
 * it never slices one in half.
 *
 * The underlying lock is a FILE, not module state: running more than one
 * orchestrator process (one per MCP client) is ordinary here, and two processes
 * do not share a promise chain. See panel-pin-guard.ts.
 */
export function withPanelOpLock<T>(
  fn: () => Promise<T>,
  opts: { timeoutMs?: number } = {},
): Promise<T> {
  return withPanelMutationLock(fn, opts);
}

/** The refusal a pin produces for a mutating action, with the way out. */
function pinRefusalMessage(action: string, pin: PanelPinState): string {
  return (
    `Refusing to ${action} the panel: it is ${describePanelPin(pin)}. ` +
    `A pin is honoured even when a newer panel exists — clear it first with ` +
    `install_panel(action='unpin')` +
    (pin.source === "env"
      ? ` (this pin comes from the ${PANEL_PIN_ENV_VAR} environment variable, so ` +
        `it must be unset/changed in the environment — unpin cannot remove it)`
      : ``) +
    `, then re-run the ${action}.`
  );
}

/**
 * Throw if a pin is in force. Called BOTH on entry (fail fast with a good
 * message before any work) and again immediately before the ComfyUI-Manager
 * call inside the op lock — detection can take a while, and a pin set during
 * that window must still be honoured.
 */
function assertNotPinned(action: string, deps: PanelInstallerDeps): void {
  const pin = readPinSafe(deps);
  if (pin.pinned) throw new PanelInstallError(pinRefusalMessage(action, pin));
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

export interface PanelDetection {
  /** Whether panel management even applies here (false in remote/cloud). */
  applicable: boolean;
  installed: boolean;
  /** Matched custom_nodes subdir, if installed. */
  dir?: string;
  /** Installed version, read from the matched dir's pyproject.toml. */
  version?: string;
  /**
   * Current git commit sha of the matched dir's checkout (if it is one). Lets an
   * `update` detect a `nightly` git-HEAD advance that did NOT bump the version
   * string, and prove a genuine no-change (identical pre/post sha).
   */
  gitRev?: string;
  /** The matched dir is a symlink/junction → dev install, manage manually. */
  isDevSymlink: boolean;
  /**
   * False when the pre-op inspection was INCONCLUSIVE — the custom_nodes
   * enumeration failed, OR a candidate's pyproject existed but could not be
   * read/parsed (it might be the panel we failed to read). A `installed: false`
   * verdict is then NOT a proven absence, so action paths must not treat it as a
   * fresh-install (absent→present) baseline — that would fabricate success.
   */
  scanReliable?: boolean;
}

/**
 * Scan <COMFYUI_PATH>/custom_nodes for a subdir whose pyproject.toml
 * `[project].name == "comfyui-agent-panel"`. LOCAL-only: with no comfyuiPath
 * (remote/cloud) returns applicable:false / installed:false.
 */
export async function detectPanelInstall(
  deps: PanelInstallerDeps = defaultDeps,
): Promise<PanelDetection> {
  const comfyPath = deps.comfyuiPath();
  // LOCAL-only: in remote/cloud mode the local FS is the wrong filesystem to
  // reason about, so detection is not applicable even if COMFYUI_PATH is set.
  if (!deps.isLocalMode() || !comfyPath) {
    return { applicable: false, installed: false, isDevSymlink: false };
  }

  const customNodes = join(comfyPath, "custom_nodes");

  // P1a — DEV-JUNCTION GUARD, FIRST and INDEPENDENT of pyproject parsing.
  // lstat the KNOWN panel target dirs directly: if either is a symlink/junction
  // it is a dev install and must be protected from any mutation, EVEN when its
  // pyproject.toml is missing, corrupt, or unreadable. (A missing/bad pyproject
  // must never downgrade a junction to "not installed" — that would let
  // install/reinstall clobber the developer's working repo.)
  for (const name of FAST_PATH_DIRS) {
    const dir = join(customNodes, name);
    if (deps.isSymlink(dir)) {
      let version: string | undefined;
      const pyproject = join(dir, "pyproject.toml");
      if (deps.existsSync(pyproject)) {
        try {
          version = parsePyproject(deps.readFile(pyproject)).version;
        } catch {
          version = undefined;
        }
      }
      return {
        applicable: true,
        installed: true,
        dir,
        version,
        gitRev: deps.gitRevision(dir),
        isDevSymlink: true,
      };
    }
  }

  // Candidate dirs: fast-path names first, then any other subdir.
  const candidates: string[] = FAST_PATH_DIRS.map((n) => join(customNodes, n));
  let scanReliable = true;
  if (deps.existsSync(customNodes)) {
    let entries: string[] = [];
    try {
      entries = deps.readdir(customNodes);
    } catch {
      // Enumeration FAILED — a "not installed" verdict from here is unreliable.
      entries = [];
      scanReliable = false;
    }
    for (const e of entries) {
      const full = join(customNodes, e);
      if (!candidates.includes(full)) candidates.push(full);
    }
  }

  for (const dir of candidates) {
    // Never resolve a backup/copy-shaped dir (e.g. ".comfyui-agent-panel.bak-*")
    // as the canonical install — it is a shadow, handled by findPanelShadows
    // (#641). The FAST_PATH canonical names are never backup-shaped.
    if (looksLikePanelBackupName(basename(dir))) continue;
    const pyproject = join(dir, "pyproject.toml");
    if (!deps.existsSync(pyproject)) continue;
    let parsed: { projectName?: string; version?: string };
    try {
      parsed = parsePyproject(deps.readFile(pyproject));
    } catch {
      // A candidate pyproject EXISTS but could not be read/parsed — this dir
      // MIGHT be the panel we failed to read. A resulting "not installed" verdict
      // is therefore NOT conclusive: mark the scan unreliable so callers don't
      // treat it as a proven absence (which would fabricate an absent→present
      // install). Read reliability is folded into scanReliable.
      scanReliable = false;
      continue;
    }
    if (parsed.projectName === PANEL_REGISTRY_ID) {
      return {
        applicable: true,
        installed: true,
        dir,
        version: parsed.version,
        gitRev: deps.gitRevision(dir),
        isDevSymlink: deps.isSymlink(dir),
        scanReliable,
      };
    }
  }

  return { applicable: true, installed: false, isDevSymlink: false, scanReliable };
}

// ---------------------------------------------------------------------------
// Shadow detection (#641)
//
// ComfyUI serves EVERY directory under custom_nodes as a web extension —
// INCLUDING dot-prefixed ones (the Python node loader skips dotdirs, but the web
// server does NOT). So a leftover backup like `.comfyui-agent-panel.bak-0.11.28`
// is served live at /extensions/.comfyui-agent-panel.bak-0.11.28/... and, because
// "." sorts before "c", can WIN registration and shadow the real panel. The disk
// pyproject of the canonical dir then reads the new version while the browser
// keeps loading the old one — a silent fabricated-success just like the #639
// no-op. We scan custom_nodes for ANY panel-serving dir other than the canonical
// install and fail closed when one exists.
// ---------------------------------------------------------------------------

export interface PanelShadow {
  /** custom_nodes subdir name (e.g. ".comfyui-agent-panel.bak-0.11.28"). */
  name: string;
  /** Version read from its pyproject, if any. */
  version?: string;
}

/**
 * EXACT (case-sensitive) canonical panel dir basename. Used only to avoid
 * flagging the real install when no canonical dir was resolved; a case-VARIANT
 * (e.g. "ComfyUI-MCP-Panel" on a case-sensitive volume) is NOT exempted here —
 * it is content-checked like any other dir so a distinct serving copy is caught.
 */
function isExactCanonicalPanelName(name: string): boolean {
  return (FAST_PATH_DIRS as readonly string[]).includes(name);
}

/**
 * Whether two paths are the SAME on-disk directory, by PHYSICAL identity:
 * realpath resolves symlinks + the real filesystem case, which is authoritative
 * regardless of case-sensitivity. On a case-INSENSITIVE volume "ComfyUI-MCP-Panel"
 * and "comfyui-mcp-panel" resolve to the same real path (one dir → exempt the
 * canonical); on a case-SENSITIVE volume (Linux, or a case-sensitive APFS/macOS
 * volume) they resolve to DISTINCT real paths (two dirs → never exempt the
 * shadow). When realpath cannot resolve EITHER side, physical identity is
 * unknown, so we FAIL CLOSED and exempt only an EXACT string match — never
 * case-fold a possibly-distinct directory into the canonical.
 */
function samePathCI(
  a: string | undefined,
  b: string | undefined,
  deps: PanelInstallerDeps,
): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const ra = deps.realPath(a);
  const rb = deps.realPath(b);
  if (ra && rb) return ra === rb; // authoritative physical identity
  // realpath unavailable → can't prove identity → only exact-equal is "same".
  return false;
}

/**
 * The remainder (after the canonical base) of a panel BACKUP name: only
 * separators / digits / dots may precede the FIRST backup marker, which is
 * either "~" or a whole-word backup keyword. Descriptive text AFTER the marker is
 * allowed (e.g. "-backup-2026-final", "~snapshot"); a non-backup word BEFORE the
 * marker ("-tools-old", "-holder-backup") means it is a backup of a DIFFERENT
 * (sibling) node, not the panel, so it must NOT match.
 */
const PANEL_BACKUP_REST =
  /^[._\-0-9]*(?:~|(?:bak|backup|old|copy|orig|save|prev|previous)(?![a-z]))/i;

/**
 * A dir NAME that looks like a leftover copy/backup OF THE PANEL — the shadowing
 * trap from #641. The name must START WITH a canonical panel base name (after an
 * optional leading dot) and then be EITHER exactly that name while hidden (a
 * dot-prefixed copy of the real panel) OR a panel-backup suffix (see
 * PANEL_BACKUP_REST). Copies that dropped their name are caught by the CONTENT
 * signal instead.
 */
export function looksLikePanelBackupName(name: string): boolean {
  const hidden = name.startsWith(".");
  const core = (hidden ? name.slice(1) : name).toLowerCase();
  const base = (FAST_PATH_DIRS as readonly string[]).find(
    (n) => core === n || core.startsWith(n),
  );
  if (!base) return false;
  const rest = core.slice(base.length);
  // Exactly a canonical name: a HIDDEN copy (".comfyui-agent-panel") shadows the
  // real panel; a plain "comfyui-agent-panel" IS the real install (not a backup).
  if (rest === "") return hidden;
  return PANEL_BACKUP_REST.test(rest);
}

/**
 * Web-extension asset paths ComfyUI serves for the panel. A custom_nodes dir that
 * contains ANY of these is served as the panel's frontend (at /extensions/<dir>/…)
 * and therefore shadows the canonical install regardless of its dir name or
 * pyproject — this is the #641 CONTENT signal, spelling-independent.
 */
const PANEL_WEB_MARKERS = [
  ["web", "js", "comfyui-mcp-panel.js"],
  ["web", "img", "comfyui-mcp-wordmark.svg"],
] as const;

/**
 * Tri-state: does `dir` serve the panel's web-extension assets? true = a marker
 * is present, false = all markers CONFIRMED absent, undefined = a probe FAILED
 * (indeterminate). Callers must treat undefined as a POSSIBLE shadow (fail
 * closed), never as "no assets". Never throws.
 */
function servesPanelWebAssets(
  dir: string,
  deps: PanelInstallerDeps,
): boolean | undefined {
  let probeFailed = false;
  for (const seg of PANEL_WEB_MARKERS) {
    const r = deps.probeFile(join(dir, ...seg));
    if (r === true) return true;
    if (r === undefined) probeFailed = true; // indeterminate — can't confirm absent
  }
  return probeFailed ? undefined : false;
}

/**
 * Find panel-serving dirs under custom_nodes that would SHADOW the canonical
 * install — any dir (other than the true canonical) that ComfyUI would SERVE as
 * the panel's web extension. Detection is CONTENT-first (the dir serves the
 * panel's web assets → spelling-independent), plus a cheap name heuristic and an
 * exact pyproject-name match. FAILS CLOSED on uncertainty: a served copy whose
 * pyproject is unreadable/absent is still flagged (as a possible shadow with no
 * version), never silently omitted. LOCAL-only.
 *
 * THROWS if custom_nodes exists but cannot be enumerated: shadow inspection is
 * then INDETERMINATE and the ACTION paths must fail closed rather than assume
 * "no shadow". (panelStatus wraps this and stays non-throwing.)
 */
export function findPanelShadows(
  canonicalDir: string | undefined,
  deps: PanelInstallerDeps = defaultDeps,
): PanelShadow[] {
  const comfyPath = deps.comfyuiPath();
  if (!deps.isLocalMode() || !comfyPath) return [];
  const customNodes = join(comfyPath, "custom_nodes");

  // Enumerate custom_nodes. A missing dir (ENOENT) legitimately means "no
  // shadows"; ANY other failure (EACCES/EIO/…) is INDETERMINATE — NOT swallowed,
  // so the action paths fail closed rather than assume "no shadows".
  let entries: string[];
  try {
    entries = deps.readdir(customNodes);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw err;
  }

  const shadows: PanelShadow[] = [];
  for (const name of entries) {
    const dir = join(customNodes, name);
    // ComfyUI serves DIRECTORIES as web extensions — a regular FILE that happens
    // to share the name is not served and must not block actions. Skip ONLY on a
    // CONFIRMED non-directory; an undefined (stat error) is indeterminate and
    // must NOT omit a possible served backup → fail closed by continuing to check.
    if (deps.isDirectory(dir) === false) continue;
    // PHYSICAL IDENTITY FIRST: a symlink/junction/alias that resolves to the
    // canonical dir serves the SAME (updated) assets → it is NOT a shadow, even
    // if its NAME is backup-shaped (e.g. ".comfyui-agent-panel.bak" ->
    // comfyui-mcp-panel). realpath-unavailable falls back to exact-string only.
    if (samePathCI(dir, canonicalDir, deps)) continue;
    // With no canonical resolved, don't flag a dir whose name is EXACTLY a
    // canonical basename (it is most likely the real install). Case-variant or
    // backup-shaped names are still content-checked below — never exempted here.
    if (!canonicalDir && isExactCanonicalPanelName(name)) continue;
    const isBackup = looksLikePanelBackupName(name);

    // CONTENT signal: does this dir serve the panel's web assets? If so it is a
    // shadow no matter how it is named or whether its pyproject is readable. An
    // INDETERMINATE probe (undefined) is treated as a possible shadow (fail
    // closed) — only a CONFIRMED-absent (false) clears the content signal.
    const servesPanel = servesPanelWebAssets(dir, deps) !== false;

    let isPanelCopy = isBackup || servesPanel;
    let version: string | undefined;
    const pyproject = join(dir, "pyproject.toml");
    if (deps.existsSync(pyproject)) {
      try {
        const parsed = parsePyproject(deps.readFile(pyproject));
        if (parsed.projectName === PANEL_REGISTRY_ID) {
          isPanelCopy = true;
          version = parsed.version;
        }
        // else: pyproject readable but a different name. If it still SERVES panel
        // assets (isPanelCopy) it remains a shadow with an unknown panel version.
      } catch {
        // FAIL CLOSED: unreadable pyproject does NOT clear a content/name signal.
        // A served copy we cannot identify is a POSSIBLE shadow, not "no shadow".
      }
    }
    if (isPanelCopy) shadows.push({ name, version });
  }
  return shadows;
}

/** Fail closed when a shadowing panel dir exists (used by install/update/reinstall). */
function assertNoPanelShadow(
  action: string,
  canonicalDir: string | undefined,
  deps: PanelInstallerDeps,
): void {
  let shadows: PanelShadow[];
  try {
    shadows = findPanelShadows(canonicalDir, deps);
  } catch (err) {
    // Indeterminate: we could not enumerate custom_nodes, so we CANNOT rule out a
    // shadowing backup. Fail closed rather than fabricate success.
    throw new PanelInstallError(
      `Panel ${action} cannot be confirmed: unable to inspect custom_nodes for ` +
        `shadowing panel copies (${err instanceof Error ? err.message : String(err)}). ` +
        `A leftover backup dir there could shadow the real panel in the browser ` +
        `(#641). NOT reporting success — check custom_nodes for stray panel copies ` +
        `(especially dot-prefixed ".comfyui-agent-panel.bak-*"), then retry.`,
    );
  }
  if (shadows.length === 0) return;
  const names = shadows
    .map(
      (s) =>
        `"${s.name}"${s.version ? ` (${s.version})` : " (identity could not be verified)"}`,
    )
    .join(", ");
  throw new PanelInstallError(
    `Panel ${action} cannot be confirmed: a SHADOW copy of the panel exists in ` +
      `custom_nodes — ${names}. ComfyUI serves EVERY dir under custom_nodes as a web ` +
      `extension (including dot-prefixed ones the node loader hides), and such a ` +
      `copy can WIN registration by sort order (e.g. ".comfyui-agent-panel.bak-*" ` +
      `sorts before "comfyui-agent-panel"), so the BROWSER may keep loading the old ` +
      `panel even though the real dir on disk is up to date (#641). NOT reporting ` +
      `success. Remove or MOVE the offending dir OUT of custom_nodes (e.g. to a temp ` +
      `folder) — or, if its identity could not be verified, make its pyproject.toml ` +
      `readable so it can be identified — then hard-refresh the ComfyUI tab. A ` +
      `backup belongs anywhere EXCEPT under custom_nodes.`,
  );
}

/**
 * Non-throwing shadow describe for the fire-and-forget on-load ensure. Returns a
 * human warning when a shadow exists OR the inspection was indeterminate, else
 * undefined. (The explicit tool paths use the throwing assertNoPanelShadow.)
 */
function describePanelShadow(
  canonicalDir: string | undefined,
  deps: PanelInstallerDeps,
): string | undefined {
  let shadows: PanelShadow[];
  try {
    shadows = findPanelShadows(canonicalDir, deps);
  } catch (err) {
    return (
      `could not inspect custom_nodes for shadowing panel copies ` +
      `(${err instanceof Error ? err.message : String(err)}) — a stray ` +
      `".comfyui-agent-panel.bak-*" there could shadow the panel in the browser (#641)`
    );
  }
  if (shadows.length === 0) return undefined;
  const names = shadows.map((s) => `"${s.name}"`).join(", ");
  return (
    `${shadows.length} shadow copy/copies in custom_nodes (${names}) are ALSO ` +
    `web-served and can win registration by sort order — the browser may load the ` +
    `OLD panel. Move them OUT of custom_nodes, then hard-refresh the ComfyUI tab (#641)`
  );
}

// ---------------------------------------------------------------------------
// On-load ensure (install-if-missing only)
// ---------------------------------------------------------------------------

export type EnsureAction =
  | "installed"
  | "up-to-date"
  | "skipped-dev"
  | "skipped"
  | "shadowed" // installed/present, but a #641 shadow copy will win in the browser
  | "unavailable";

export interface EnsureResult {
  action: EnsureAction;
  reason?: string;
  dir?: string;
  installedVersion?: string;
  restartRequired?: boolean;
}

export interface EnsureOptions {
  deps?: PanelInstallerDeps;
  timeoutMs?: number;
}

/**
 * The explicit opt-out applies to every unattended panel mutation. A user who
 * disables on-load installation must not get an automatic version sync later
 * merely because a desktop tab says hello.
 */
export function isPanelAutoInstallDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.COMFYUI_MCP_PANEL_AUTOINSTALL ?? "").trim().toLowerCase();
  return v === "0" || v === "false" || v === "no" || v === "off";
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`panel ensure timed out after ${ms}ms`)),
      ms,
    );
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

async function ensureInner(deps: PanelInstallerDeps): Promise<EnsureResult> {
  if (isPanelAutoInstallDisabled(deps.env())) {
    return {
      action: "skipped",
      reason: "COMFYUI_MCP_PANEL_AUTOINSTALL disabled",
    };
  }

  if (!deps.isLocalMode()) {
    return {
      action: "unavailable",
      reason: "Panel auto-install is local-only (remote/cloud mode active).",
    };
  }

  if (!deps.comfyuiPath()) {
    return {
      action: "unavailable",
      reason: "No local ComfyUI (COMFYUI_PATH unset); panel auto-install is local-only.",
    };
  }

  if (!(await deps.isReachable())) {
    return { action: "unavailable", reason: "ComfyUI is not reachable." };
  }

  // An explicit pin outranks auto-install: installing the `nightly` channel over
  // a pinned version is exactly the silent move the pin forbids. Skip and say so.
  const pin = readPinSafe(deps);
  if (pin.pinned) {
    return {
      action: "skipped",
      reason: `panel version pin in force — ${describePanelPin(pin)}`,
    };
  }

  const detection = await detectPanelInstall(deps);

  if (detection.isDevSymlink) {
    return {
      action: "skipped-dev",
      reason: "dev install (symlink) — managed manually",
      dir: detection.dir,
      installedVersion: detection.version,
    };
  }

  if (!detection.installed) {
    // #639 — if the pre-op enumeration FAILED, "not installed" is unreliable: a
    // pre-existing panel in a non-fast-path dir may have been missed. Installing
    // blind risks a duplicate (shadow), and we could not honestly claim a fresh
    // install, so skip and report unavailable rather than fabricate "installed".
    if (detection.scanReliable === false) {
      return {
        action: "unavailable",
        reason:
          "Could not enumerate custom_nodes to confirm the panel is missing; " +
          "skipping auto-install to avoid a duplicate/unverified install.",
      };
    }
    // Final pin check adjacent to the mutation (see runPanelActionInner): the
    // reachability probe and detection above are not instantaneous.
    const latePin = readPinSafe(deps);
    if (latePin.pinned) {
      return {
        action: "skipped",
        reason: `panel version pin in force — ${describePanelPin(latePin)}`,
      };
    }
    await deps.install({ id: PANEL_REGISTRY_ID, version: PANEL_VERSION });
    // #639 — VERIFY it actually landed (fresh re-read); never log "installed"
    // from the Manager result alone (a stale 3.x no-op drains the queue trivially).
    const post = await detectPanelInstall(deps);
    const landed = post.installed && !!post.version;
    // #641 — report a shadow FIRST: a served backup copy explains a wrong panel in
    // the browser whether or not the canonical install landed this run.
    const shadow = describePanelShadow(post.dir, deps);
    if (shadow) {
      return {
        action: "shadowed",
        reason: landed
          ? `Installed ${PANEL_REGISTRY_ID} (${post.version}) but ${shadow}.`
          : `Panel auto-install could not be verified on disk (likely a stale ` +
            `ComfyUI-Manager no-op, #639/#424), AND ${shadow}`,
        dir: post.dir,
        installedVersion: post.version,
        restartRequired: landed ? true : undefined,
      };
    }
    if (!landed) {
      return {
        action: "unavailable",
        reason:
          `Panel auto-install could not be verified on disk — ComfyUI-Manager ` +
          `reported the queue drained but the pack is not present. Likely a stale ` +
          `ComfyUI-Manager 3.x no-op (#639/#424). Install the panel from source or ` +
          `update ComfyUI-Manager, then restart ComfyUI.`,
      };
    }
    return {
      action: "installed",
      reason: `Installed ${PANEL_REGISTRY_ID} (${post.version}).`,
      dir: post.dir,
      installedVersion: post.version,
      restartRequired: true,
    };
  }

  // Present already. We never diff nightly on load (no clean version), so we
  // leave it untouched — the explicit `update` action refreshes on demand. But a
  // #641 shadow copy still mis-serves the panel, so surface it if present.
  const shadow = describePanelShadow(detection.dir, deps);
  if (shadow) {
    return {
      action: "shadowed",
      reason: shadow,
      dir: detection.dir,
      installedVersion: detection.version,
    };
  }
  return {
    action: "up-to-date",
    dir: detection.dir,
    installedVersion: detection.version,
  };
}

/**
 * The on-load policy engine. LOCAL + reachable only; install-if-missing.
 * Hard-timed-out and swallows every error (returns `unavailable` on failure),
 * so it can be fired-and-forgotten from startup without ever blocking/crashing.
 */
export async function ensurePanelInstalled(
  opts: EnsureOptions = {},
): Promise<EnsureResult> {
  const deps = opts.deps ?? defaultDeps;
  try {
    // Serialized with the explicit actions: the on-load ensure must not race an
    // install_panel call the user fired at the same moment. Its lock wait is
    // SHORT — this is fire-and-forget at startup, so if another process holds
    // the lock we give up quickly (returning `unavailable`) rather than eating
    // the whole ensure budget waiting.
    return await withTimeout(
      withPanelOpLock(() => ensureInner(deps), { timeoutMs: ENSURE_LOCK_WAIT_MS }),
      opts.timeoutMs ?? ENSURE_TIMEOUT_MS,
    );
  } catch (err) {
    logger.debug("panel: ensure failed", {
      err: err instanceof Error ? err.message : String(err),
    });
    return {
      action: "unavailable",
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// Tool-facing operations
// ---------------------------------------------------------------------------

export interface PanelStatus {
  applicable: boolean;
  installed: boolean;
  dir?: string;
  installedVersion?: string;
  isDevSymlink: boolean;
  targetVersion: string;
  /**
   * #641 — other panel-serving dirs under custom_nodes that SHADOW the real
   * install in the browser (e.g. a ".comfyui-agent-panel.bak-*" backup). When
   * non-empty, the SERVED panel may not match `installedVersion` on disk.
   */
  shadows: PanelShadow[];
  /**
   * #641 — the shadow scan could NOT be completed (custom_nodes was not
   * enumerable). `shadows: []` then means "we did not find any" rather than
   * "there are none", so callers must not read the empty array as an all-clear.
   * Structural, not just prose in `note`: a consumer branching on
   * `shadows.length` would otherwise treat an indeterminate scan as safe.
   */
  shadowInspectFailed?: boolean;
  /**
   * The user's explicit version pin. While `pin.pinned` is true, install/update/
   * reinstall refuse and the on-load ensure skips — see the pin guard above.
   */
  pin: PanelPinState;
  /**
   * #639 — the custom_nodes enumeration itself FAILED, so `installed: false` is
   * unreliable: a pre-existing panel may have been missed, and installing blind
   * risks a duplicate (or clobbering a NEWER one). Consumers must not treat an
   * unreliable "absent" as an install invitation.
   */
  scanReliable?: boolean;
  /**
   * The ComfyUI root this status is ABOUT — the custom_nodes parent that was
   * actually scanned (#766/#769). Reported so an unexpected `installed: false`
   * can be recognised as "you looked in the wrong tree" rather than "the panel
   * is gone".
   */
  comfyuiPath?: string;
  /** How `comfyuiPath` was chosen. See panel-workspace.ts. */
  baseSource?: PanelBaseSource;
  note: string;
}

/** status action — never throws. */
export async function panelStatus(
  deps: PanelInstallerDeps = defaultDeps,
): Promise<PanelStatus> {
  await primeBaseFor(deps);
  const detection = await detectPanelInstall(deps).catch(
    () =>
      ({ applicable: false, installed: false, isDevSymlink: false }) as PanelDetection,
  );

  let shadows: PanelShadow[] = [];
  let shadowInspectFailed = false;
  if (detection.applicable) {
    try {
      shadows = findPanelShadows(detection.dir, deps);
    } catch {
      shadowInspectFailed = true;
    }
  }
  const shadowNote = shadowInspectFailed
    ? ` NOTE (#641): could not enumerate custom_nodes to check for shadowing panel ` +
      `backups — a stray ".comfyui-agent-panel.bak-*" there could shadow the real ` +
      `panel in the browser. Check manually.`
    : shadows.length > 0
      ? ` WARNING (#641): ${shadows.length} shadow copy/copies in custom_nodes (${shadows
          .map((s) => `"${s.name}"`)
          .join(", ")}) are ALSO served as web extensions and may shadow the real ` +
        `panel in the browser (dot-prefixed dirs win by sort order). Remove/move ` +
        `them OUT of custom_nodes, then hard-refresh the ComfyUI tab.`
      : "";

  // #766/#769 — say WHICH ComfyUI root this answer is about, and how it was
  // chosen. Both issues were, at bottom, a status report about a directory the
  // user did not think they were asking about; naming it makes that visible
  // instead of leaving "installed: false" to be read as "the panel is missing".
  const baseResolution = deps === defaultDeps ? lastPanelBaseResolution() : undefined;
  const comfyuiPath = deps.comfyuiPath();
  const baseSource: PanelBaseSource | undefined = baseResolution?.source;
  const baseNote = (() => {
    if (!baseResolution?.base) return "";
    if (baseResolution.source === "live-base-directory") {
      return (
        ` Resolved against the RUNNING ComfyUI's --base-directory (${baseResolution.base})` +
        (baseResolution.overriddenConfiguredBase
          ? `, not the configured workspace ` +
            `(${baseResolution.overriddenConfiguredBase}) — a Comfy Desktop-style split ` +
            `install keeps custom_nodes under the base directory (#766).`
          : `.`)
      );
    }
    if (baseResolution.source === "live-argv-root") {
      return (
        ` Resolved from the RUNNING ComfyUI's own install root (${baseResolution.base})` +
        (baseResolution.overriddenConfiguredBase
          ? `, not the configured workspace (${baseResolution.overriddenConfiguredBase}).`
          : ` — no COMFYUI_PATH or saved workspace was needed (#769).`)
      );
    }
    return "";
  })();

  let note: string;
  if (!detection.applicable) {
    note = !deps.isLocalMode()
      ? `Remote/cloud mode — panel install is managed on the ComfyUI host, not from ` +
        `here. ${describePanelUpdateRecovery()}`
      : `Panel management is local-only, and no local ComfyUI could be resolved — ` +
        `neither COMFYUI_PATH, a saved default workspace, nor the running server's ` +
        `own launch arguments yielded a root containing custom_nodes. Set ` +
        `COMFYUI_PATH, or save a default workspace with workspace(action='set_default').`;
  } else if (detection.isDevSymlink) {
    note = "dev install (symlink) — managed manually; install/update/reinstall are refused.";
  } else if (!detection.installed) {
    note = `Not installed. Run install_panel(action='install') to add the panel (${PANEL_VERSION}). Restart ComfyUI afterwards.`;
  } else {
    note = `Installed${
      detection.version ? ` (${detection.version})` : ""
    }. Run install_panel(action='update') to pull the latest ${PANEL_VERSION}. Restart ComfyUI after updating.`;
  }

  // Record what we just READ OFF DISK, so the bridge's write-gate refusal can
  // tell a stale browser BUNDLE from a stale INSTALL. The orchestrator runs the
  // panel sync (and therefore this) on every panel hello, so the observation and
  // the tab's advertised version describe the same moment. Only a real read is
  // recorded; an absent or unreadable pack CLEARS it rather than leaving a stale
  // "your install is fine" behind.
  if (deps === defaultDeps) {
    if (detection.applicable && detection.installed && detection.version) {
      recordPanelDiskObservation(detection.version, detection.dir);
    } else {
      clearPanelDiskObservation();
    }
  }

  const pin = readPinSafe(deps);
  const pinNote = pin.pinned
    ? ` PIN: ${describePanelPin(pin)} — install/update/reinstall are refused ` +
      `until it is cleared with install_panel(action='unpin')` +
      (pin.source === "env" ? ` (env pins must be unset in the environment).` : `.`)
    : "";

  return {
    applicable: detection.applicable,
    installed: detection.installed,
    dir: detection.dir,
    installedVersion: detection.version,
    isDevSymlink: detection.isDevSymlink,
    targetVersion: PANEL_VERSION,
    shadows,
    shadowInspectFailed,
    scanReliable: detection.scanReliable,
    comfyuiPath,
    baseSource,
    pin,
    note: note + baseNote + shadowNote + pinNote,
  };
}

/**
 * Read the panel status for a caller-selected LOCAL ComfyUI root.
 *
 * `apply_manifest` may adopt a saved/default/live root for one call while
 * `config.comfyuiPath` remains unset. Verifying through the ordinary default
 * status in that case would inspect no directory (or a different one) and turn
 * a Manager queue result into fabricated panel success. This narrow adapter
 * keeps the status scan — including #641's served-shadow check — on the same
 * root the manifest install targeted without mutating process-global config.
 */
export function panelStatusAt(comfyuiPath: string): Promise<PanelStatus> {
  return panelStatus({
    ...defaultDeps,
    isLocalMode: () => true,
    comfyuiPath: () => comfyuiPath,
  });
}

export interface PanelActionResult {
  action: "install" | "update" | "reinstall";
  result: NodeOpResult;
  restartRequired: boolean;
  message: string;
  /** update only — installed version read from disk BEFORE the op (if known). */
  previousVersion?: string;
  /** update only — installed version RE-READ from disk AFTER the op (if known). */
  installedVersion?: string;
}

// ---------------------------------------------------------------------------
// Update verification (#639)
//
// ComfyUI-Manager reports its queue "drained" as soon as done_count >= total_count
// (see runManagerQueue). A stale/legacy Manager 3.x returns total_count:0 with a
// non-zero done_count — the drain check passes TRIVIALLY (2 >= 0) while nothing is
// ever enqueued, so the pack on disk is untouched. Trusting that signal as proof
// of work is the silent fabricate-success bug (#639, same root cause as #424).
//
// The fix: after an `update`, RE-READ the installed identity fresh from disk (the
// pyproject version AND the git-HEAD sha) and require PROVEN movement to claim
// success. Nothing moved → fail closed. Never trust the Manager counts as proof
// of work (they are queue-wide, not task-correlated); they only sharpen the
// failure diagnostic. Shadow copies (#641) are checked separately.
// ---------------------------------------------------------------------------

interface QueueCounts {
  total?: number;
  done?: number;
  inProgress?: number;
  pending?: number;
  processing?: boolean;
}

/**
 * Best-effort extraction of ComfyUI-Manager queue counts from a NodeOpResult's
 * raw `details`. Returns `{}` when `details` isn't a manager-http queue status
 * object (e.g. the cm-cli path returns a string). Never throws.
 */
export function readQueueCounts(details: unknown): QueueCounts {
  if (!details || typeof details !== "object") return {};
  const d = details as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" ? v : undefined);
  return {
    total: num(d.total_count),
    done: num(d.done_count),
    inProgress: num(d.in_progress_count),
    pending: num(d.pending_count),
    processing: typeof d.is_processing === "boolean" ? (d.is_processing as boolean) : undefined,
  };
}

/**
 * The stale ComfyUI-Manager 3.x silent no-op signature: the queue "drained" but
 * the requested task was never really run. Either nothing was ever enqueued
 * (total_count:0 — the drain check `done >= total` passes trivially) or the
 * counts are incoherent (done > total, impossible in a real queue). These are
 * NEVER produced by a task that actually executed, so they are a safe FAILURE
 * signal (used only to fail closed / sharpen diagnostics, never to claim work).
 */
export function looksLikeManagerNoOp(details: unknown): boolean {
  const c = readQueueCounts(details);
  const nothingEnqueued = c.total === 0;
  const incoherent =
    c.total !== undefined && c.done !== undefined && c.done > c.total;
  return nothingEnqueued || incoherent;
}

/**
 * The PROVEN legacy-3.x empty-queue signature — the ONLY queue state that may
 * authorize the #724 git fallback (codex gate). total_count, done_count,
 * in_progress_count and is_processing are REQUIRED by the Manager's status
 * contract (QueueStatus in node-management): each must be PRESENT and exactly
 * 0/false — a missing field is unproven, never a default-safe zero. The one
 * optional field, pending_count (absent on legacy 3.x), must be 0 when
 * reported. The broader looksLikeManagerNoOp also matches incoherent counts
 * (done > total), which is fine as a FAILURE diagnostic but must never
 * authorize a git mutation: a partial, malformed, or contradictory response
 * is not proof of the stale-3.x no-op.
 */
export function isProvenLegacyEmptyQueue(details: unknown): boolean {
  const c = readQueueCounts(details);
  if (!(c.total === 0 && c.done === 0 && c.inProgress === 0 && c.processing === false)) {
    return false;
  }
  // pending_count is optional (absent on legacy 3.x) — but a REPORTED value
  // must be a real numeric 0. A malformed one ("1", null, …) normalizes to
  // undefined in readQueueCounts, which must read as UNPROVEN, not absent.
  if (details && typeof details === "object" && "pending_count" in details) {
    const p = (details as Record<string, unknown>).pending_count;
    return typeof p === "number" && p === 0;
  }
  return true;
}

export type UpdateOutcome =
  | "updated" // version OR git-HEAD moved on disk → the update definitely applied.
  | "no-op" // nothing moved AND Manager shows the stale-3.x no-op signature.
  | "unverified"; // nothing provably moved / can't read post identity — fail closed.

export interface UpdateVerdict {
  outcome: UpdateOutcome;
  previousVersion?: string;
  installedVersion?: string;
  previousRev?: string;
  installedRev?: string;
  counts: QueueCounts;
}

export interface PanelUpdateIdentity {
  previousVersion?: string;
  installedVersion?: string;
  previousRev?: string;
  installedRev?: string;
}

/**
 * Decide whether an `update` actually advanced the panel on disk. Heart of the
 * #639 fix.
 *
 * SUCCESS REQUIRES PROVEN MOVEMENT. We compare the pre/post ON-DISK identity —
 * the pyproject version AND the git-HEAD commit sha (post RE-READ fresh from
 * disk, never cached) — and only report `updated` when one of them actually
 * MOVED. The panel tracks the `nightly` (git-HEAD) channel, so a commit can
 * advance WITHOUT a version bump; a moved sha therefore also counts as updated.
 *
 * Crucially, an UNCHANGED local git-HEAD is NOT proof of being current: it only
 * proves nothing was pulled locally — which is exactly the #639 no-op. Local
 * HEAD says nothing about the upstream tip, so we never treat "HEAD unchanged"
 * as success. When nothing moved we fail closed: `no-op` when the Manager counts
 * show the stale-3.x signature (total_count:0, or the incoherent done>total), and
 * `unverified` otherwise. The queue counts are queue-WIDE drain counters (not
 * correlated to this task), so they are used ONLY to sharpen the FAILURE
 * diagnostic — NEVER as positive proof that work happened.
 */
export function classifyPanelUpdate(
  identity: PanelUpdateIdentity,
  details: unknown,
): UpdateVerdict {
  const { previousVersion, installedVersion, previousRev, installedRev } = identity;
  const counts = readQueueCounts(details);
  const base = { ...identity, counts };

  // Can't read ANY post-update identity → cannot confirm anything landed.
  if (!installedVersion && !installedRev) {
    return { ...base, outcome: "unverified" };
  }

  // Something moved on disk (version bump OR git-HEAD advance) → update applied.
  const versionMoved =
    !!previousVersion && !!installedVersion && installedVersion !== previousVersion;
  const revMoved = !!previousRev && !!installedRev && installedRev !== previousRev;
  if (versionMoved || revMoved) return { ...base, outcome: "updated" };

  // Nothing provably moved. Use the Manager counts ONLY to name the failure:
  // the stale-3.x no-op signature → the reported no-op; otherwise we simply
  // couldn't confirm.
  if (looksLikeManagerNoOp(details)) return { ...base, outcome: "no-op" };

  return { ...base, outcome: "unverified" };
}

/** Turn an update verdict into an honest result — or throw when it did not apply. */
function finalizeUpdate(
  verdict: UpdateVerdict,
  post: PanelDetection,
  result: NodeOpResult,
): PanelActionResult {
  const { outcome, previousVersion, installedVersion, counts } = verdict;
  const dirNote = post.dir ? ` at ${post.dir}` : "";

  if (outcome === "updated") {
    const from = verdict.previousVersion ?? verdict.previousRev?.slice(0, 8) ?? "?";
    const to = verdict.installedVersion ?? verdict.installedRev?.slice(0, 8) ?? "?";
    return {
      action: "update",
      result,
      restartRequired: true,
      message:
        `Panel updated (${from} → ${to}) via ComfyUI-Manager (${PANEL_VERSION}). ` +
        `RESTART ComfyUI to load the updated panel node.`,
      previousVersion,
      installedVersion,
    };
  }

  // Nothing provably moved → NEVER report success. An unchanged local git-HEAD /
  // version cannot distinguish "already at the upstream tip" from "the update
  // silently no-op'd", so we fail closed with an honest, actionable diagnostic.
  if (outcome === "no-op") {
    throw new PanelInstallError(
      `Panel update did NOT apply: nothing changed on disk${dirNote} (installed ` +
        `version still ${previousVersion ?? "unknown"}) after ComfyUI-Manager ` +
        `reported the queue drained. Manager reported done_count=` +
        `${counts.done ?? "?"} with total_count=${counts.total ?? "?"} — it never ` +
        `actually enqueued the update. This is the stale ComfyUI-Manager 3.x silent ` +
        `no-op (#639, same root cause as #424). Fix: update ComfyUI-Manager on the ` +
        `host (git pull in custom_nodes/ComfyUI-Manager, or pip install -U ` +
        `comfyui_manager) and retry, or reinstall the panel from source (git pull ` +
        `the panel dir / reinstall the pack), then RESTART ComfyUI.`,
    );
  }

  // unverified — no proof it advanced, and no clear no-op signature either.
  throw new PanelInstallError(
    `Could not verify the panel update applied: the installed version ` +
      `(${installedVersion ?? "unreadable"}) and git-HEAD did not change` +
      `${dirNote} after ComfyUI-Manager reported the queue drained. NOT reporting ` +
      `success — an unchanged checkout can't prove you are at the latest nightly ` +
      `versus a silent no-op. You may already be current; otherwise ComfyUI-Manager ` +
      `may be stale (#424). RESTART ComfyUI and re-check the version, or reinstall ` +
      `the panel from source.`,
  );
}

/**
 * The #724 fallback for the update path: ComfyUI-Manager provably no-op'd the
 * update (the stale legacy-3.x signature), but the panel dir is a REAL git
 * checkout — so update it without the Manager, exactly like the manual
 * workaround from the issue (`git pull --ff-only` in the panel repo), then run
 * the SAME #639 verification over the result (fresh on-disk re-read, #641
 * shadow scan, proven movement) rather than trusting git's output text.
 *
 * Two refusals guard the pull itself:
 *  - DIRTY WORKTREE: a fast-forward only refuses local edits it OVERLAPS, so
 *    the checkout must be PROVEN clean (git status --porcelain) before we
 *    mutate it. Anything else — or a cleanliness check that itself fails —
 *    refuses the fallback rather than carry/clobber local state.
 *  - DIRECTORY BINDING: `dir` is the checkout the pre-op git proof belongs to
 *    (enforced by the caller). The post-pull verification must describe that
 *    SAME directory; a re-detection landing elsewhere makes the pre/post
 *    comparison meaningless and is refused.
 *
 * Success still REQUIRES proven movement on disk. The one new honest outcome
 * is "already current": a pinned `git merge --ff-only` fast-forwarded to the fetched remote and
 * found HEAD not behind — proof of currency the Manager queue counts could
 * never give — so that reports "already up to date" (NOT "updated"; nothing
 * changed, no restart needed). A failed pull throws with BOTH diagnostics; it
 * never reads as "nothing to pull".
 */
async function updateViaGitCheckoutFallback(opts: {
  deps: PanelInstallerDeps;
  dir: string;
  previousVersion?: string;
  previousRev?: string;
  result: NodeOpResult;
}): Promise<PanelActionResult> {
  const { deps, dir, previousVersion, previousRev, result } = opts;

  // PRE-PULL REVISION GATE — the post-Manager detection's HEAD must be
  // readable before we mutate. An unreadable revision at this point means the
  // no-op verdict itself is unprovable (a head-only Manager advance looks
  // identical), so firing a pull would mutate on a false premise and then
  // misreport git-applied work or a tip it cannot see (codex gate). Fail
  // closed BEFORE any mutation, never pull.
  const prePullRev = deps.gitRevision(dir);
  if (!prePullRev) {
    throw new PanelInstallError(
      `Panel update did NOT apply: ComfyUI-Manager reported the queue drained ` +
        `but the panel checkout's HEAD revision is unreadable at ${dir}, so ` +
        `whether it updated (a nightly advance with no version bump) is ` +
        `UNVERIFIABLE — the git fallback does not fire on an unprovable no-op. ` +
        `Check the panel repo (git log) and ComfyUI-Manager on the host, then ` +
        `re-check install_panel(action='status').`,
    );
  }

  // WORKTREE-ROOT GATE — `.git` proves metadata exists, not that this dir is
  // the checkout ROOT. A copied/stale gitdir would let status/pull mutate a
  // sibling repo and credit the panel with that repo's moved HEAD. Require the
  // resolved toplevel to BE the panel dir (same path identity as the #641
  // shadow code). Any failure here is "cannot prove", which refuses.
  let worktreeRoot: string;
  try {
    worktreeRoot = deps.gitWorktreeRoot(dir);
  } catch (err) {
    throw new PanelInstallError(
      `Panel update did NOT apply: ComfyUI-Manager never enqueued the update (the ` +
        `stale legacy 3.x silent no-op, #639/#724), and the git fallback is ` +
        `REFUSED: could not prove ${dir} is the panel repo's worktree root (git ` +
        `rev-parse failed — ${err instanceof Error ? err.message : String(err)}). ` +
        `Update the panel repo manually, then RESTART ComfyUI.`,
    );
  }
  if (!samePathCI(worktreeRoot, dir, deps)) {
    throw new PanelInstallError(
      `Refusing the panel update git fallback: the git worktree root resolves to ` +
        `${worktreeRoot}, NOT the panel directory ${dir} — status/pull would ` +
        `mutate a DIFFERENT checkout than the one we verified (a copied or stale ` +
        `gitdir pointer). Nothing was done; check how the panel dir's .git got ` +
        `there, then update the correct repo manually and RESTART ComfyUI.`,
    );
  }

  // CLEANLINESS GATE — never mutate a dirty checkout. A porcelain failure is
  // "cannot prove clean", which refuses exactly like a dirty one.
  let porcelain: string;
  try {
    porcelain = deps.gitStatusPorcelain(dir).trim();
  } catch (err) {
    throw new PanelInstallError(
      `Panel update did NOT apply: ComfyUI-Manager never enqueued the update (the ` +
        `stale legacy 3.x silent no-op, #639/#724), and the git fallback is ` +
        `REFUSED: could not confirm the panel repo at ${dir} is clean (git ` +
        `status failed — ${err instanceof Error ? err.message : String(err)}). ` +
        `Update the panel repo manually (git pull in ${dir}), then RESTART ComfyUI.`,
    );
  }
  if (porcelain !== "") {
    throw new PanelInstallError(
      `Refusing the panel update git fallback: the panel repo at ${dir} has ` +
        `UNCOMMITTED changes or untracked files (git status --porcelain):\n` +
        `${porcelain}\ncomfyui-mcp never mutates a dirty checkout — a ` +
        `fast-forward could carry or clobber that local state. Commit, stash, or ` +
        `discard the changes (or update the panel repo manually), then retry. ` +
        `(ComfyUI-Manager also no-op'd this update — the stale legacy 3.x ` +
        `signature, #639/#724 — so updating it on the host restores the Manager ` +
        `path: git pull in custom_nodes/ComfyUI-Manager, or pip install -U ` +
        `comfyui_manager.)`,
    );
  }

  // PINNED FETCH — fetch ONCE, then bind every later proof and the mutation
  // itself to the fetched upstream sha. A `git pull` would fetch a SECOND
  // time; a commit landing between the two fetches could newly track an
  // ignored local path and slip past the collision proof into the merge
  // (codex gate). The rev we inspect is the rev we merge — no race.
  let targetRev: string;
  try {
    deps.gitFetch(dir);
    targetRev = deps.gitUpstreamRev(dir);
  } catch (err) {
    throw new PanelInstallError(
      `Panel update did NOT apply: ComfyUI-Manager never enqueued the update (the ` +
        `stale legacy 3.x silent no-op, #639/#724), and the git fallback is ` +
        `REFUSED: could not fetch/resolve the upstream revision for ${dir} ` +
        `(${err instanceof Error ? err.message : String(err)}). Update the ` +
        `panel repo manually (git pull in ${dir}), then RESTART ComfyUI.`,
    );
  }

  // IGNORED-FILE GATE — porcelain omits ignored files, but a fast-forward does
  // NOT protect them: when the remote newly tracks a path that is locally
  // ignored, the merge silently overwrites the local file (codex gate). Refuse
  // on any proven collision against the PINNED rev; a proof failure also
  // refuses (fail closed).
  let ignoredConflicts: string[];
  try {
    ignoredConflicts = deps.gitIgnoredPullConflicts(dir, targetRev);
  } catch (err) {
    throw new PanelInstallError(
      `Panel update did NOT apply: ComfyUI-Manager never enqueued the update (the ` +
        `stale legacy 3.x silent no-op, #639/#724), and the git fallback is ` +
        `REFUSED: could not prove the pull would not silently overwrite ignored ` +
        `local files in ${dir} (${err instanceof Error ? err.message : String(err)}). ` +
        `Update the panel repo manually (git pull in ${dir}), then RESTART ComfyUI.`,
    );
  }
  if (ignoredConflicts.length > 0) {
    const shown = ignoredConflicts.slice(0, 5).join(", ");
    const more = ignoredConflicts.length > 5 ? ` (+${ignoredConflicts.length - 5} more)` : "";
    throw new PanelInstallError(
      `Refusing the panel update git fallback: ${ignoredConflicts.length} locally-IGNORED ` +
        `file(s) in ${dir} would be SILENTLY OVERWRITTEN by the fast-forward ` +
        `(git protects untracked files from checkout, but not ignored ones): ` +
        `${shown}${more}. Move or delete them (or git add them), then retry — ` +
        `or update the panel repo manually. (ComfyUI-Manager also no-op'd this ` +
        `update — the stale legacy 3.x signature, #639/#724.)`,
    );
  }

  let gitOutput: string;
  try {
    gitOutput = deps.gitMergeFfOnly(dir, targetRev);
  } catch (err) {
    // The Manager no-op'd AND the direct merge failed — name both, truthfully.
    throw new PanelInstallError(
      `Panel update did NOT apply: nothing changed on disk at ${dir} (installed ` +
        `version still ${previousVersion ?? "unknown"}). ComfyUI-Manager never ` +
        `enqueued the update (the stale legacy 3.x silent no-op, #639/#724), and ` +
        `the direct git fallback on the panel repo failed too — ` +
        `${err instanceof Error ? err.message : String(err)}. ` +
        `Fix: update ComfyUI-Manager on the host (git pull in custom_nodes/` +
        `ComfyUI-Manager, or pip install -U comfyui_manager) and retry, or update ` +
        `the panel repo manually (git pull in ${dir}), then RESTART ComfyUI.`,
    );
  }

  // The merge ran clean — VERIFY with the same machinery (#639/#641): re-read
  // the installed identity FRESH from disk, fail closed on a shadow, require
  // proven movement. Never infer success from git's output.
  const post = await detectPanelInstall(deps);
  if (!post.installed || !post.version) {
    throw new PanelInstallError(
      `Could not verify the panel update applied: the pack is ${
        post.installed ? "present but its version is unreadable" : "not present"
      } at ${dir} after the pinned fast-forward succeeded. NOT reporting success. ` +
        `Re-check the pack and retry, then RESTART ComfyUI.`,
    );
  }
  // DIRECTORY BINDING — the verification must describe the SAME checkout we
  // pulled; a re-detection resolving a different dir means the pre/post
  // identity comparison would span two repos. Refuse rather than claim either.
  if (!post.dir || !samePathCI(dir, post.dir, deps)) {
    throw new PanelInstallError(
      `Could not verify the panel update applied: after the pinned fast-forward in ` +
        `${dir}, re-detection resolved a DIFFERENT panel dir ` +
        `(${post.dir ?? "none"}), so the before/after comparison would not ` +
        `describe the checkout that was pulled. NOT reporting success — check ` +
        `custom_nodes for duplicate or moved panel dirs, then re-check the ` +
        `installed version.`,
    );
  }
  assertNoPanelShadow("update", post.dir, deps);
  // REVISION PROOF — after a pull, the checkout's HEAD must be READABLE. An
  // unreadable rev is NOT "at tip": a pull that advanced HEAD without a
  // version bump would otherwise fall through to "already up to date" with
  // zero evidence either way (codex gate). Fail closed, never at-tip.
  if (!post.gitRev) {
    throw new PanelInstallError(
      `Could not verify the panel update applied: the pinned fast-forward ran clean ` +
        `in ${dir}, but the checkout's HEAD revision is unreadable afterward, ` +
        `so whether it moved (a nightly advance with no version bump) is ` +
        `UNVERIFIABLE. NOT reporting success and NOT reporting "already at ` +
        `tip" — check the panel repo (git log), then re-check ` +
        `install_panel(action='status').`,
    );
  }
  const verdict = classifyPanelUpdate(
    {
      previousVersion,
      installedVersion: post.version,
      previousRev,
      installedRev: post.gitRev,
    },
    result.details,
  );
  if (verdict.outcome === "updated") {
    const from = verdict.previousVersion ?? verdict.previousRev?.slice(0, 8) ?? "?";
    const to = verdict.installedVersion ?? verdict.installedRev?.slice(0, 8) ?? "?";
    // The embedded result came from the Manager call that no-op'd — its own
    // message may credit ComfyUI-Manager. The report must not contradict the
    // git-fallback path that actually did the work (codex gate).
    const fallbackMessage =
      `Panel updated (${from} → ${to}) via a pinned git merge --ff-only on the panel repo ` +
      `(${dir}), verified on disk: ComfyUI-Manager no-op'd the update (stale ` +
      `legacy 3.x, #724), so the update was applied directly from git. RESTART ` +
      `ComfyUI to load the updated panel node.`;
    const honestResult = { ...result, message: fallbackMessage };
    return {
      action: "update",
      result: honestResult,
      restartRequired: true,
      message: fallbackMessage,
      previousVersion,
      installedVersion: post.version,
    };
  }

  // Nothing moved even though git pull exited clean. Before claiming “at the
  // upstream tip”, PROVE it: HEAD must equal the tracked upstream sha — a
  // locally-AHEAD checkout (committed local work) also exits pull cleanly and
  // would otherwise be blessed as upstream currency (codex gate). No upstream
  // configured or a mismatch → unverifiable, never “at tip”.
  let upstreamRev: string | undefined;
  try {
    upstreamRev = deps.gitUpstreamRev(dir);
  } catch {
    upstreamRev = undefined;
  }
  if (!upstreamRev || upstreamRev !== post.gitRev) {
    throw new PanelInstallError(
      `Could not verify the panel is current: the pinned fast-forward ran clean in ` +
        `${dir}, but ${!upstreamRev ? "no upstream is configured, so currency is UNPROVABLE" : `HEAD (${post.gitRev?.slice(0, 8)}) does not match the tracked upstream (${upstreamRev.slice(0, 8)}) — the checkout has committed local work upstream doesn't have`}. ` +
        `NOT reporting "at upstream tip" and NOT reporting an update. Check the ` +
        `panel repo (git status / git log), then re-check install_panel(action='status').`,
    );
  }
  // HEAD === upstream: git FETCHED the remote and proved the checkout current.
  // That is genuine proof of currency — report "already up to date" honestly
  // (NOT "updated"; nothing changed, no restart). The embedded result came
  // from the Manager call that no-op'd — override its message too, so the
  // report never credits the Manager for a verification git did (codex gate).
  const atTipMessage =
    `Panel is already at the upstream tip (${post.version}) — ComfyUI-Manager ` +
    `no-op'd the update (stale legacy 3.x, #724), but a pinned git merge ` +
    `--ff-only on ${dir} verified the checkout is current (git: ` +
    `${gitOutput || "no output"}). Nothing changed on disk; no restart needed.`;
  return {
    action: "update",
    result: { ...result, message: atTipMessage },
    restartRequired: false,
    message: atTipMessage,
    previousVersion,
    installedVersion: post.version,
  };
}

/**
 * The #771 fallback: the panel was installed from the COMFY REGISTRY as a zip.
 *
 * That install shape has no `.git`, which knocks out both existing update
 * routes at once. ComfyUI-Manager cannot resolve it (its update queue drains
 * having enqueued nothing), and the #724 fast-forward has nothing to
 * fast-forward. The reporter of #771 was therefore hard-blocked: the write gate
 * told them to run install_panel, and install_panel was the thing that could not
 * work. This closes that loop by doing, under verification, exactly the manual
 * sequence that unblocked them — clone the panel repo fresh and swap it in.
 *
 * Every guard from the git path applies here too, plus the ones a WHOLESALE
 * REPLACEMENT needs that a fast-forward does not:
 *
 *  - NEVER ON A GIT CHECKOUT. A resolvable HEAD means the #724 fast-forward is
 *    the right tool; replacing a real checkout would throw away the user's
 *    branch, remotes and any local commits. This fallback is strictly for the
 *    shape that has no other option.
 *  - THE REPLACEMENT IS VALIDATED BEFORE ANYTHING MOVES. The clone must carry
 *    the panel's own pyproject identity, a readable version, and the BUILT web
 *    bundle ComfyUI actually serves. Swapping in a source tree with no
 *    `web/js` would leave the browser with no panel at all — an "update" that
 *    uninstalls.
 *  - NEVER BACKWARDS. A staged version older than the installed one is refused
 *    outright; equal versions report honestly as "already current" and do not
 *    touch the disk.
 *  - THE BACKUP LEAVES custom_nodes. ComfyUI serves every directory under
 *    custom_nodes as a web extension, so parking the old copy beside the new one
 *    would shadow it in the browser and make a real update look like a no-op
 *    (#641). It goes to a sibling of custom_nodes instead.
 *  - THE SWAP IS REVERSIBLE. If the new dir cannot be moved into place after the
 *    old one is out, the old one is put back before throwing. The user never
 *    ends up with no panel because we failed halfway.
 *
 * Success still requires PROVEN on-disk movement re-read afterwards (#639) and a
 * clean shadow scan (#641) — the same discipline as every other path here.
 */
interface PanelSwapOps {
  clone: (destDir: string) => void;
  mkdirp: (p: string) => void;
  rename: (from: string, to: string) => void;
  removeDir: (p: string) => void;
}

/**
 * The four primitives the swap needs, or undefined when the dep set does not
 * carry all of them. Required as a SET: half a swap is worse than none, so a
 * partial dep set disables the fallback entirely rather than starting work it
 * cannot finish or undo.
 */
function resolveSwapOps(deps: PanelInstallerDeps): PanelSwapOps | undefined {
  const { gitClonePanel, mkdirp, rename, removeDir } = deps;
  if (!gitClonePanel || !mkdirp || !rename || !removeDir) return undefined;
  return { clone: gitClonePanel, mkdirp, rename, removeDir };
}

async function updateViaRegistryZipReinstall(opts: {
  deps: PanelInstallerDeps;
  ops: PanelSwapOps;
  dir: string;
  comfyuiPath: string;
  previousVersion?: string;
  result?: NodeOpResult;
  /** Why the Manager path could not do it — quoted in every message. */
  managerReason: string;
}): Promise<PanelActionResult> {
  const { deps, ops, dir, comfyuiPath, previousVersion, result, managerReason } = opts;

  // NOT A GIT CHECKOUT. This is the whole precondition: a readable HEAD means
  // #724's fast-forward applies and a wholesale replace would destroy work.
  if (deps.gitRevision(dir)) {
    throw new PanelInstallError(
      `Panel update did NOT apply (${managerReason}), and the reinstall-from-source ` +
        `fallback is REFUSED: ${dir} IS a git checkout, so replacing it wholesale ` +
        `would discard its branch, remotes and any local commits. The fast-forward ` +
        `path handles a checkout; this one exists only for a Comfy Registry zip ` +
        `install. Update the panel repo manually (git pull in ${dir}), then RESTART ComfyUI.`,
    );
  }

  // Final pin check, adjacent to the mutation (same contract as every other
  // path): a pin written while we were probing must still be honoured.
  assertNotPinned("update", deps);

  // A shadowing copy must be cleared FIRST. Replacing the canonical dir while a
  // shadow is served would leave the browser on the old panel and make a
  // genuinely-applied update look like it failed.
  assertNoPanelShadow("update", dir, deps);

  // Stage OUTSIDE custom_nodes (a sibling of it), for two reasons: a
  // half-written clone inside custom_nodes would be served as a web extension
  // and shadow the real panel, and ComfyUI would try to import it as a node
  // pack. Same volume as the panel dir, so the swap is a rename, not a copy.
  const staging = join(
    comfyuiPath,
    `.comfyui-agent-panel.staging-${process.pid}-${Date.now()}`,
  );
  if (deps.existsSync(staging)) {
    throw new PanelInstallError(
      `Panel update did NOT apply (${managerReason}), and the reinstall-from-source ` +
        `fallback is REFUSED: the staging path ${staging} already exists. Remove it ` +
        `and retry.`,
    );
  }

  let stagedVersion: string | undefined;
  try {
    ops.clone(staging);

    // VALIDATE THE REPLACEMENT BEFORE ANYTHING MOVES.
    const stagedPyproject = join(staging, "pyproject.toml");
    if (!deps.existsSync(stagedPyproject)) {
      throw new PanelInstallError(
        `the freshly cloned panel at ${staging} has no pyproject.toml, so it cannot ` +
          `be identified as the panel pack`,
      );
    }
    const parsed = parsePyproject(deps.readFile(stagedPyproject));
    if (parsed.projectName !== PANEL_REGISTRY_ID) {
      throw new PanelInstallError(
        `the freshly cloned panel at ${staging} declares [project].name ` +
          `"${parsed.projectName ?? "(none)"}", not "${PANEL_REGISTRY_ID}"`,
      );
    }
    if (!parsed.version) {
      throw new PanelInstallError(
        `the freshly cloned panel at ${staging} has no readable version, so the ` +
          `update could not be verified afterwards`,
      );
    }
    stagedVersion = parsed.version;

    // The BUILT bundle must be present. The panel ships prebuilt web assets, but
    // if a clone ever landed without them, swapping it in would serve the
    // browser nothing — an "update" that silently uninstalls the panel. An
    // indeterminate probe is not a pass.
    if (servesPanelWebAssets(staging, deps) !== true) {
      throw new PanelInstallError(
        `the freshly cloned panel at ${staging} does not carry the built web bundle ` +
          `(web/js), so installing it would leave the ComfyUI tab with no panel at all`,
      );
    }

    // NEVER BACKWARDS, and never a pointless swap.
    if (previousVersion && SEMVER_RE.test(previousVersion.trim()) && SEMVER_RE.test(stagedVersion.trim())) {
      const delta = compareSemver(stagedVersion, previousVersion);
      if (delta < 0) {
        throw new PanelInstallError(
          `the published panel (${stagedVersion}) is OLDER than the one installed ` +
            `(${previousVersion}) — refusing to move the panel backwards`,
        );
      }
      if (delta === 0) {
        // Honest non-mutation: the installed pack already matches upstream.
        ops.removeDir(staging);
        const atTip =
          `Panel is already at the published version (${stagedVersion}) — ` +
          `${managerReason}, and a fresh clone of the panel repo carries the SAME ` +
          `version, so there is nothing to install. Nothing changed on disk; no ` +
          `restart needed.`;
        return {
          action: "update",
          result: result ?? {
            mechanism: "git-clone",
            message: atTip,
            details: { staged_version: stagedVersion },
          },
          restartRequired: false,
          message: atTip,
          previousVersion,
          installedVersion: previousVersion,
        };
      }
    }
  } catch (err) {
    // Nothing has moved yet — clean up the staging dir and report truthfully.
    ops.removeDir(staging);
    const detail = err instanceof Error ? err.message : String(err);
    throw new PanelInstallError(
      `Panel update did NOT apply: nothing was changed on disk at ${dir} (installed ` +
        `version still ${previousVersion ?? "unknown"}). ${managerReason}, and the ` +
        `reinstall-from-source fallback could not proceed — ${detail}. Fix: update ` +
        `ComfyUI-Manager on the host (git pull in custom_nodes/ComfyUI-Manager, or ` +
        `pip install -U comfyui_manager) and retry, or replace the panel manually ` +
        `(clone ${PANEL_REPO_URL} and swap it in, keeping the old copy OUT of ` +
        `custom_nodes), then RESTART ComfyUI.`,
    );
  }

  // THE SWAP. Backup goes to a sibling of custom_nodes — never inside it (#641).
  const backupRoot = join(comfyuiPath, "custom_nodes_backup");
  const backupDir = join(
    backupRoot,
    `${basename(dir)}-${previousVersion ?? "unknown"}-${Date.now()}`,
  );
  try {
    ops.mkdirp(backupRoot);
    ops.rename(dir, backupDir);
  } catch (err) {
    ops.removeDir(staging);
    throw new PanelInstallError(
      `Panel update did NOT apply: nothing was changed on disk. ${managerReason}, and ` +
        `the reinstall-from-source fallback could not move the existing panel out of ` +
        `custom_nodes (${dir} → ${backupDir}: ` +
        `${err instanceof Error ? err.message : String(err)}). The old panel is ` +
        `untouched. Check permissions / that ComfyUI does not hold the directory ` +
        `open (stop ComfyUI and retry).`,
    );
  }
  try {
    ops.rename(staging, dir);
  } catch (err) {
    // PUT IT BACK. A failure here must never leave the user with no panel.
    let restored = true;
    try {
      ops.rename(backupDir, dir);
    } catch {
      restored = false;
    }
    ops.removeDir(staging);
    throw new PanelInstallError(
      `Panel update did NOT apply: ${managerReason}, and the reinstall-from-source ` +
        `fallback failed while moving the new panel into place ` +
        `(${staging} → ${dir}: ${err instanceof Error ? err.message : String(err)}). ` +
        (restored
          ? `The previous panel was RESTORED to ${dir} — nothing was lost.`
          : `The previous panel could NOT be restored automatically: it is at ` +
            `${backupDir}. Move it back to ${dir} manually before restarting ComfyUI.`),
    );
  }

  // VERIFY — same machinery as every other path (#639/#641): re-read the
  // installed identity FRESH from disk, fail closed on a shadow, and require
  // proven movement. The version we report is the one we OBSERVED, never
  // `stagedVersion` (what we intended to install).
  const post = await detectPanelInstall(deps);
  if (!post.installed || !post.version) {
    throw new PanelInstallError(
      `Panel reinstall-from-source moved the new pack into ${dir}, but re-reading it ` +
        `afterwards found it ${post.installed ? "present with an unreadable version" : "absent"}. ` +
        `NOT reporting success. The previous panel is at ${backupDir} — restore it ` +
        `if the new one is broken, then RESTART ComfyUI.`,
    );
  }
  if (!post.dir || !samePathCI(dir, post.dir, deps)) {
    throw new PanelInstallError(
      `Panel reinstall-from-source cannot be verified: after swapping ${dir}, ` +
        `re-detection resolved a DIFFERENT panel dir (${post.dir ?? "none"}), so the ` +
        `before/after comparison would not describe the directory that changed. NOT ` +
        `reporting success — check custom_nodes for duplicate panel dirs. The ` +
        `previous panel is at ${backupDir}.`,
    );
  }
  assertNoPanelShadow("update", post.dir, deps);
  if (previousVersion && post.version === previousVersion) {
    throw new PanelInstallError(
      `Panel reinstall-from-source did NOT change the installed version (still ` +
        `${post.version}) at ${dir}, even though a fresh clone was swapped in. NOT ` +
        `reporting an update — something is serving the old pack. The previous panel ` +
        `is at ${backupDir}.`,
    );
  }

  const message =
    `Panel updated (${previousVersion ?? "unknown"} → ${post.version}) by reinstalling ` +
    `from source, verified on disk at ${dir}: ${managerReason}, and the pack is a ` +
    `Comfy Registry ZIP install with no .git, so neither ComfyUI-Manager nor a ` +
    `fast-forward could move it (#771). A fresh clone of ${PANEL_REPO_URL} was ` +
    `swapped in and the previous copy was moved OUT of custom_nodes to ${backupDir} ` +
    `(leaving it beside the panel would shadow the new one in the browser). RESTART ` +
    `ComfyUI to load the updated panel node, then hard-refresh the ComfyUI tab.`;
  return {
    action: "update",
    result: result
      ? { ...result, message }
      : {
          mechanism: "git-clone",
          message,
          details: { backup_dir: backupDir, installed_version: post.version },
        },
    restartRequired: true,
    message,
    previousVersion,
    installedVersion: post.version,
  };
}

export interface PanelActionOptions {
  /**
   * Target version for install/reinstall, defaulting to the `nightly` channel.
   *
   * Exists so a caller that asked for a SPECIFIC version — e.g.
   * `install_custom_node(id="comfyui-agent-panel", version="0.11.20")`, which is
   * redirected here to get the verified path — actually gets the version it
   * asked for. Redirecting and silently substituting `nightly` would do
   * something other than what the caller requested while reporting success.
   * (`update` has no version to honour; it always pulls the channel tip.)
   */
  version?: string;
}

/**
 * install/update/reinstall the panel. LOCAL-only and refuses dev symlinks.
 * Targets the "nightly" channel unless a version is given. Caller must RESTART
 * ComfyUI to load the change.
 */
export function runPanelAction(
  action: "install" | "update" | "reinstall",
  deps: PanelInstallerDeps = defaultDeps,
  opts: PanelActionOptions = {},
): Promise<PanelActionResult> {
  // Serialized: never let two panel mutations interleave (see withPanelOpLock).
  return withPanelOpLock(() => runPanelActionInner(action, deps, opts));
}

export async function runPanelActionInner(
  action: "install" | "update" | "reinstall",
  deps: PanelInstallerDeps,
  opts: PanelActionOptions = {},
): Promise<PanelActionResult> {
  const targetVersion = opts.version?.trim() || PANEL_VERSION;
  // Resolve the LIVE ComfyUI base ONCE, before the first deps.comfyuiPath()
  // read, so detection, the shadow scan and the post-op re-read all describe
  // the same directory (#766/#769).
  await primeBaseFor(deps);
  // P1b — truly LOCAL-only. Refuse in remote/cloud mode even when COMFYUI_PATH
  // is set: installCustomNode/reinstallCustomNode would queue Manager mutations
  // against the REMOTE host while our symlink guard inspected the LOCAL disk —
  // the wrong filesystem. The panel must be managed on the ComfyUI host itself.
  if (!deps.isLocalMode()) {
    throw new PanelInstallError(
      `Panel ${action} is local-only and is refused in remote/cloud mode ` +
        `(a remote COMFYUI_URL / Comfy Cloud is active). Install the panel on ` +
        `the ComfyUI host itself.`,
    );
  }
  // Bind the base ONCE. Every later read in this operation — the registry-zip
  // fallback's staging/backup paths especially — must be rooted at the SAME
  // ComfyUI the detection scanned, never at a value re-resolved mid-flight.
  const comfyPath = deps.comfyuiPath();
  if (!comfyPath) {
    throw new PanelInstallError(
      `Panel ${action} is local-only and requires a local ComfyUI install, and none ` +
        `could be resolved — neither COMFYUI_PATH, a saved default workspace, nor ` +
        `the running server's own launch arguments yielded a root containing ` +
        `custom_nodes (#769). Set COMFYUI_PATH or save a default workspace with ` +
        `workspace(action='set_default'). (This is a no-op in remote/cloud mode.)`,
    );
  }

  // PIN GUARD — before any Manager mutation is queued. This is the single choke
  // point that makes "we never move a pinned user" true for every caller (the
  // sync skill, the panel, a hand-written install_panel call), not just the ones
  // that remembered to check. It is re-checked once more immediately before the
  // Manager call, since detection below is not instantaneous.
  assertNotPinned(action, deps);

  const detection = await detectPanelInstall(deps);
  if (detection.isDevSymlink) {
    throw new PanelInstallError(
      `Refusing to ${action} the panel: it is a dev install (symlink at ${detection.dir}) ` +
        `— managed manually. Update it via your repo/git instead.`,
    );
  }

  // Capture the on-disk identity BEFORE the op (from the guard detection we just
  // did — read fresh, not cached elsewhere).
  const wasPresent = detection.installed;
  const previousVersion = detection.version;
  const previousRev = detection.gitRev;

  if (action === "update") {
    // Final pin check, inside the op lock and adjacent to the mutation: a pin
    // set while detection was running must still be honoured.
    assertNotPinned(action, deps);

    // #771 — STATUS AND UPDATE MUST NOT CONTRADICT EACH OTHER.
    //
    // `deps.update` is the GENERIC node-pack update. Its post-op presence gate
    // (#730) resolves the pack through ComfyUI-Manager's installed/registry
    // list, keyed on the registry id — a completely different question from the
    // one `panelStatus` answers by scanning custom_nodes and reading
    // pyproject.toml. For a Comfy Registry ZIP install those two disagree: the
    // Manager list does not resolve `comfyui-agent-panel`, so the generic gate
    // throws "…is not installed locally and was not found in the
    // ComfyUI-Manager registry", asserting an absence it never checked on disk —
    // about a pack `status` had just reported at a concrete dir and version.
    //
    // We hold the authoritative on-disk answer right here in `detection`. So a
    // failure from the generic path is recorded as "ComfyUI-Manager could not
    // update it" and we continue to the verified fallbacks. It is only allowed
    // to propagate when the disk AGREES the pack is absent — then the message
    // is true and there is genuinely nothing to update.
    let result: NodeOpResult | undefined;
    let managerFailure: string | undefined;
    try {
      result = await deps.update({ id: PANEL_REGISTRY_ID });
    } catch (err) {
      if (!detection.installed) throw err;
      managerFailure = err instanceof Error ? err.message : String(err);
      logger.warn(
        `[panel] ComfyUI-Manager could not update the panel (${managerFailure}) — the ` +
          `pack IS installed at ${detection.dir ?? "custom_nodes"}` +
          `${detection.version ? ` (${detection.version})` : ""}, so falling back to a ` +
          `direct, verified update (#771).`,
      );
    }

    if (!result) {
      // The Manager path threw. `detection.installed` is proven true (checked
      // above), so route straight to whichever direct path fits this install
      // SHAPE — a fast-forward for a checkout, a verified reinstall for a
      // registry zip. Both prove movement on disk before reporting anything.
      //
      // The Manager's RAW text is deliberately NOT quoted into what we report.
      // It is precisely the sentence we have just disproved ("it is not
      // installed locally…"), and carrying it into a success message would
      // reintroduce the contradiction one layer down — the user would read a
      // verified update that still insists the pack does not exist. The raw
      // text is logged above and travels in `details` for diagnosis; the
      // human-facing summary states only what is true.
      const managerReason =
        `ComfyUI-Manager could not update the panel (it does not resolve ` +
        `"${PANEL_REGISTRY_ID}" in its own installed-pack list, though the pack IS ` +
        `on disk at ${detection.dir ?? "custom_nodes"})`;
      if (previousRev && detection.dir) {
        return updateViaGitCheckoutFallback({
          deps,
          dir: detection.dir,
          previousVersion,
          previousRev,
          // Synthesize the shape the fallback reports around; there is no real
          // Manager result because the Manager call failed.
          result: {
            mechanism: "manager-http",
            message: managerReason,
            details: { manager_error: managerFailure },
          },
        });
      }
      const swapOps = detection.dir ? resolveSwapOps(deps) : undefined;
      if (detection.dir && swapOps) {
        return updateViaRegistryZipReinstall({
          deps,
          ops: swapOps,
          dir: detection.dir,
          comfyuiPath: comfyPath,
          previousVersion,
          // The raw Manager text rides along in `details` for diagnosis; the
          // message the fallback composes never quotes it.
          result: {
            mechanism: "manager-http",
            message: managerReason,
            details: { manager_error: managerFailure },
          },
          managerReason,
        });
      }
      throw new PanelInstallError(
        `Panel update did NOT apply: ${managerReason}. The panel IS installed` +
          `${detection.dir ? ` at ${detection.dir}` : ""}` +
          `${previousVersion ? ` (version ${previousVersion})` : ""} — whatever the ` +
          `Manager's error says, that is what install_panel(action='status') reads ` +
          `off the disk — but no direct update path is available here (it is not a ` +
          `git checkout, so there is nothing to fast-forward). ` +
          `${describePanelUpdateRecovery()} (ComfyUI-Manager reported: ${managerFailure})`,
      );
    }

    // #639 — VERIFY the update actually advanced the pack. Re-read the installed
    // identity FRESH from disk (never trust Manager's queue-drained signal, nor
    // any value captured before the op), then classify honestly.
    const post = await detectPanelInstall(deps);
    // #641 — a shadowing copy makes the SERVED panel differ from post.version, so
    // even a real version advance is a fabricated success. Fail closed first.
    assertNoPanelShadow(action, post.dir, deps);
    // #639 req — the installed VERSION must be readable post-update, else we
    // cannot verify the applied version (fail closed; never trust a HEAD move
    // alone when the pyproject version can't be read).
    if (!post.installed || !post.version) {
      throw new PanelInstallError(
        `Could not verify the panel update applied: the pack is ${
          post.installed ? "present but its version is unreadable" : "not present"
        } after ComfyUI-Manager reported the queue drained. NOT reporting success. ` +
          `Re-check the pack and retry, or reinstall the panel from source, then ` +
          `RESTART ComfyUI.`,
      );
    }
    const verdict = classifyPanelUpdate(
      {
        previousVersion,
        installedVersion: post.version,
        previousRev,
        installedRev: post.gitRev,
      },
      result.details,
    );
    // #724 — the Manager PROVABLY no-op'd (the stale legacy-3.x signature), and
    // the panel dir is a real git checkout (a pre-op HEAD resolved; a registry
    // zip has no .git, and a dev symlink was refused above). The verified
    // Manager path is a dead end on that host tier, so fall back to
    // a pinned `git merge --ff-only` on the panel repo and verify THAT the same way
    // instead of only surfacing the error.
    if (verdict.outcome === "no-op" && previousRev && post.dir) {
      // SIGNATURE GATE — only the PROVEN empty queue (total 0 AND done 0,
      // nothing pending/in-progress, not processing) authorizes a git
      // mutation. The broader no-op signature also matches incoherent counts
      // (done > total): a malformed or contradictory response is a failure
      // diagnostic, never proof of the stale-3.x state this fallback exists
      // to repair (codex gate).
      if (!isProvenLegacyEmptyQueue(result.details)) {
        const c = readQueueCounts(result.details);
        throw new PanelInstallError(
          `Panel update did NOT apply: nothing changed on disk, and the Manager's ` +
          `queue counts are NOT the proven legacy-3.x empty-queue signature ` +
          `(need total 0 AND done 0 with nothing pending/in-progress; got ` +
          `total=${c.total ?? "?"}, done=${c.done ?? "?"}, pending=${c.pending ?? "?"}, ` +
          `in_progress=${c.inProgress ?? "?"}) — the git fallback does not fire on ` +
          `an incoherent or partial signature. Update ComfyUI-Manager on the host ` +
          `and retry, or update the panel repo manually (git pull in ${post.dir}), ` +
          `then RESTART ComfyUI.`,
        );
      }
      // DIALECT GATE — the empty-queue signature only MEANS "stale Manager 3.x"
      // on a legacy host. On a v4 host (or with the dialect unproven) the same
      // signature is an outage/failed enqueue, and a git mutation is not
      // warranted (codex gate): report the unverified no-op instead of pulling.
      // Probe the dialect of the SAME Manager the update call used — the
      // base travels back on the result (a mid-op retarget must not let a
      // v2-host outage read as 'legacy' from another endpoint, codex gate).
      let dialect: string | undefined;
      if (deps.detectManagerDialect) {
        dialect = await deps.detectManagerDialect(result.managerBase);
      } else {
        try {
          const { detectManagerApi } = await import("./node-management.js");
          dialect = await detectManagerApi(result.managerBase);
        } catch {
          dialect = undefined;
        }
      }
      if (dialect !== "legacy") {
        throw new PanelInstallError(
          `Panel update did NOT apply: nothing changed on disk, and the Manager's ` +
            `API dialect here is ${dialect ?? "unproven"}, NOT the legacy 3.x whose ` +
            `silent no-op this matches (#724) — so the git fallback does not fire ` +
            `(an empty queue on this host is an outage or a failed enqueue, not the ` +
            `stale-3.x signature). Update ComfyUI-Manager on the host and retry, or ` +
            `update the panel repo manually (git pull in ${post.dir}), then RESTART ComfyUI.`,
        );
      }

      // Bind the fallback to ONE directory: the git proof (previousRev) belongs
      // to the ORIGINAL detection, so the pull and the post verification must
      // target that same checkout. A re-detection that resolves a DIFFERENT
      // panel dir means the two reads disagree about what "the panel" is —
      // pulling there could mutate a repo we never proved, so refuse.
      if (!detection.dir || !samePathCI(detection.dir, post.dir, deps)) {
        throw new PanelInstallError(
          `Panel update did NOT apply: ComfyUI-Manager never enqueued the update ` +
            `(the stale legacy 3.x silent no-op, #639/#724), and the git fallback ` +
            `is REFUSED: the panel dir re-detected after the Manager call ` +
            `(${post.dir}) is not the checkout the pre-update git proof belongs ` +
            `to (${detection.dir ?? "unresolved"}). Pulling it could mutate the ` +
            `WRONG repo, so nothing was done. Check custom_nodes for duplicate ` +
            `or moved panel dirs, then retry.`,
        );
      }
      return updateViaGitCheckoutFallback({
        deps,
        dir: detection.dir,
        previousVersion,
        previousRev,
        result,
      });
    }
    // #771 — the same dead end, one install shape over. The Manager did nothing
    // AND there is no `previousRev`, which for a pack that IS installed and is
    // NOT a dev symlink (both established above) means precisely one thing: a
    // Comfy Registry ZIP install with no `.git`. The fast-forward above cannot
    // fire (nothing to fast-forward) and the Manager cannot resolve it, so
    // without this branch the user is left with a hard version gate and no
    // working remedy at all — which is the bug. Reinstall from source instead,
    // under the same verification.
    const zipSwapOps =
      verdict.outcome !== "updated" &&
      !previousRev &&
      detection.installed &&
      detection.dir &&
      post.dir &&
      samePathCI(detection.dir, post.dir, deps)
        ? resolveSwapOps(deps)
        : undefined;
    if (zipSwapOps && detection.dir) {
      return updateViaRegistryZipReinstall({
        deps,
        ops: zipSwapOps,
        dir: detection.dir,
        comfyuiPath: comfyPath,
        previousVersion,
        result,
        managerReason:
          `ComfyUI-Manager reported the queue drained without moving the pack on disk`,
      });
    }
    return finalizeUpdate(verdict, post, result);
  }

  // install / reinstall. Same final pin check as the update path above.
  assertNotPinned(action, deps);
  const result =
    action === "install"
      ? await deps.install({ id: PANEL_REGISTRY_ID, version: targetVersion })
      : await deps.reinstall({ id: PANEL_REGISTRY_ID, version: targetVersion });

  // #639 — VERIFY the pack afterward. installCustomNode verifies presence
  // downstream (#232), but reinstallCustomNode does NOT — it returns as soon as
  // the Manager queue drains, which the stale 3.x no-op passes trivially. Re-read
  // fresh from disk here so BOTH paths fail closed rather than fabricate success.
  const post = await detectPanelInstall(deps);
  // #641 — fail closed on a shadow FIRST: a served backup copy is the more
  // actionable diagnostic (it explains a wrong panel in the browser) and is named
  // with its specific remedy, even when the canonical install itself did not land.
  assertNoPanelShadow(action, post.dir, deps);
  if (!post.installed || !post.version) {
    throw new PanelInstallError(
      `Panel ${action} did NOT land: the pack is ${
        post.installed ? "present but its version is unreadable" : "not present"
      } in custom_nodes after ComfyUI-Manager reported the queue drained. This is ` +
        `the stale ComfyUI-Manager 3.x silent no-op (#639, same root cause as #424): ` +
        `NOT reporting success. Fix: update ComfyUI-Manager on the host (git pull in ` +
        `custom_nodes/ComfyUI-Manager, or pip install -U comfyui_manager) and retry, ` +
        `or install the panel from source, then RESTART ComfyUI.`,
    );
  }

  // SUCCESS REQUIRES PROVEN CHANGE (mirrors the update path): the pack went from
  // ABSENT→present (fresh install landed), or its version/git-HEAD moved. Proven
  // disk movement is checked FIRST — the ComfyUI-Manager queue counts are
  // queue-WIDE (not task-correlated), so they must NEVER veto a change the disk
  // already proves.
  const versionMoved =
    !!previousVersion && !!post.version && post.version !== previousVersion;
  const revMoved =
    !!previousRev && !!post.gitRev && post.gitRev !== previousRev;
  // Only a RELIABLE pre-op scan may establish absent→present. If the pre-op
  // enumeration failed (indeterminate), a "was absent" baseline is untrustworthy
  // — a pre-existing panel in a non-fast-path dir could have been missed — so we
  // do NOT infer a fresh install from it (that would fabricate success).
  const reliablyAbsent = !wasPresent && detection.scanReliable !== false;
  const changed = reliablyAbsent || versionMoved || revMoved;

  if (!changed) {
    // Nothing provably changed. Use the stale-3.x no-op count signature ONLY here
    // (not as a veto above) to sharpen the failure diagnostic.
    if (looksLikeManagerNoOp(result.details)) {
      const c = readQueueCounts(result.details);
      throw new PanelInstallError(
        `Panel ${action} did NOT execute: ComfyUI-Manager reported the queue ` +
          `drained without actually enqueuing the task (total_count=` +
          `${c.total ?? "?"}, done_count=${c.done ?? "?"}), so the pack on disk ` +
          `(${PANEL_REGISTRY_ID} ${post.version}) is unchanged — likely a stale ` +
          `pre-existing copy. This is the stale ComfyUI-Manager 3.x silent no-op ` +
          `(#639, same root cause as #424): NOT reporting success. Fix: update ` +
          `ComfyUI-Manager on the host (git pull in custom_nodes/ComfyUI-Manager, ` +
          `or pip install -U comfyui_manager) and retry, or install the panel from ` +
          `source, then RESTART ComfyUI.`,
      );
    }
    throw new PanelInstallError(
      `Panel ${action} did NOT change anything on disk: the pack is still ` +
        `${PANEL_REGISTRY_ID} ${post.version} (git-HEAD unchanged) after ` +
        `ComfyUI-Manager reported the queue drained. NOT reporting success — an ` +
        `unchanged checkout can't prove the ${action} actually executed versus a ` +
        `silent no-op (stale ComfyUI-Manager 3.x, #424). If you meant to refresh or ` +
        `upgrade, update ComfyUI-Manager on the host and retry, use ` +
        `install_panel(action='update'), or install the panel from source, then ` +
        `RESTART ComfyUI.`,
    );
  }

  return {
    action,
    result,
    restartRequired: true,
    message:
      `Panel ${action} applied via ComfyUI-Manager: pack ${
        wasPresent ? "advanced to" : "installed on disk at"
      } ${PANEL_REGISTRY_ID} ${post.version}. RESTART ComfyUI to load the panel node.`,
    previousVersion,
    installedVersion: post.version,
  };
}
