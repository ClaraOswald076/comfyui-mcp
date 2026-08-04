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
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
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
import {
  describeInstallPanelAction,
  describePanelUpdateRecovery,
  PANEL_REPO_URL,
} from "./panel-recovery.js";
import { compareSemver } from "./self-update.js";
import { SEMVER_RE } from "./ui-bridge.js";
import {
  clearPanelDiskObservation,
  isLiveDerivedBase,
  lastPanelBaseResolution,
  panelBaseSync,
  panelTargetGeneration,
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
   * Write a small text file (the swap journal). THROWS on failure — an
   * unrecorded swap is refused rather than performed unrecoverably.
   */
  writeFile?: (p: string, contents: string) => void;
  /**
   * Best-effort durability barrier for a DIRECTORY's entries, used between the
   * swap's renames. Optional and must never throw: several platforms (Windows
   * notably) cannot open a directory handle to fsync at all, and on those the
   * ordering guarantee comes from the filesystem committing metadata operations
   * in order rather than from this call.
   */
  syncDir?: (p: string) => void;
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
  // DURABLE, because this is a crash-recovery record and a crash is exactly
  // when it has to exist. A buffered write can be lost or reordered against the
  // rename that immediately follows it, which would leave no canonical panel
  // AND no record of where the backup went — the one outcome the journal is
  // there to prevent. Write, fsync the file, then fsync the containing
  // directory so the new entry itself is durable (a no-op on platforms that
  // refuse it, which is not a failure).
  syncDir: (p) => {
    try {
      const fd = openSync(p, "r");
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    } catch {
      // Unsupported on this platform (Windows cannot fsync a directory handle).
      // Not an error: see the barrier comment in updateViaRegistryZipReinstall.
    }
  },
  writeFile: (p, contents) => {
    const fd = openSync(p, "w");
    try {
      writeFileSync(fd, contents, "utf-8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      const dirFd = openSync(dirname(p), "r");
      try {
        fsyncSync(dirFd);
      } finally {
        closeSync(dirFd);
      }
    } catch {
      // Directory fsync is unsupported on some platforms (notably Windows).
      // The file's own fsync still ordered it before the rename.
    }
  },
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
 * Marks a dep set derived from `defaultDeps`. `pinPanelBase` returns a NEW
 * object, so identity against `defaultDeps` no longer answers "are these the
 * real deps?" — and that question governs whether we probe the live server and
 * whether an on-disk read is worth recording. Carry the answer explicitly.
 */
const REAL_DEPS = Symbol("panel-installer.realDeps");
/**
 * The ComfyUI target generation as it stood when the base was FROZEN — captured
 * before the live probe, so a retarget that completed during the freeze is
 * still visible afterwards. Reading the generation at re-entry instead would
 * miss exactly that: the orchestrator launches the panel sync and then
 * retargets, so by the time the mutation begins the change has already landed
 * and looks like the status quo.
 */
const PINNED_GENERATION = Symbol("panel-installer.pinnedGeneration");
/** The base this dep set was frozen to — re-asserted before any mutation. */
const PINNED_BASE = Symbol("panel-installer.pinnedBase");
type MarkedDeps = PanelInstallerDeps & {
  [REAL_DEPS]?: true;
  [PINNED_GENERATION]?: number;
  [PINNED_BASE]?: string;
};

/** Is this the production dep set (rather than an injected test one)? */
function isRealDeps(deps: PanelInstallerDeps): boolean {
  return deps === defaultDeps || (deps as MarkedDeps)[REAL_DEPS] === true;
}

/**
 * Resolve the LIVE ComfyUI base once and FREEZE it for the rest of the
 * operation (#766/#769).
 *
 * Priming alone is not enough, and assuming it was is a real bug: the live
 * resolution is cached with a short TTL, and `panelBaseSync()` falls back to the
 * configured base once that expires. A single panel update can easily outlive
 * it — ComfyUI-Manager operations are slow. On a Comfy Desktop split install the
 * pre-op detection would then inspect the live `--base-directory` tree while the
 * post-op verification inspected the configured one, and if the configured tree
 * happened to hold a newer panel the "did it move?" proof would compare two
 * different directories and report a success that never happened. That is
 * precisely the fabricated-success class #639 exists to prevent.
 *
 * So the base is read ONCE and pinned into a dep set for the whole operation.
 * Pinning is idempotent — an already-pinned set re-pins to the same value — and
 * for an injected dep set (whose `comfyuiPath` is already a constant) it is a
 * no-op that preserves existing behaviour exactly.
 */
export async function pinPanelBase(
  deps: PanelInstallerDeps,
  opts: { force?: boolean } = {},
): Promise<PanelInstallerDeps> {
  const real = isRealDeps(deps);
  // CAPTURE THE GENERATION FIRST, before the probe's await. The orchestrator
  // launches the panel sync and THEN retargets, so a retarget can complete
  // while we are freezing — and a generation read afterwards would record the
  // new target as though it had always been the one we froze against, making
  // the divergence invisible to every later check.
  // ONCE FROZEN, STAY FROZEN. runPanelActionInner re-pins on entry, and if that
  // re-pin re-read the generation it would erase the whole point: the retarget
  // we are trying to detect happens BETWEEN performPanelSync's freeze and that
  // re-entry, so a second capture would record the new target as the original
  // one. An already-pinned dep set keeps its first answer.
  const generation = pinnedGenerationOf(deps) ?? panelTargetGeneration();
  // Only probe the live server for the REAL deps. An injected dep set has
  // already declared where ComfyUI is; probing would be pointless and, in
  // tests, a network call nobody asked for.
  if (real) await primePanelBase({ force: opts.force });
  const base = deps.comfyuiPath();
  const pinned: MarkedDeps = { ...deps, comfyuiPath: () => base };
  if (real) pinned[REAL_DEPS] = true;
  pinned[PINNED_GENERATION] = generation;
  if (base !== undefined) pinned[PINNED_BASE] = base;
  return pinned;
}

/** The generation this dep set was frozen at, if it carries one. */
function pinnedGenerationOf(deps: PanelInstallerDeps): number | undefined {
  return (deps as MarkedDeps)[PINNED_GENERATION];
}

/** The base this dep set was frozen to, if it carries one. */
function pinnedBaseOf(deps: PanelInstallerDeps): string | undefined {
  return (deps as MarkedDeps)[PINNED_BASE];
}

/**
 * Refuse if the ComfyUI target changed since this dep set was frozen.
 *
 * Shared by EVERY path that mutates the panel, not just the explicit ones. The
 * automatic paths need it most: the on-load ensure and the interrupted-swap
 * repair both freeze a local base and then act on it, and a hello retarget can
 * land in between — restoring or installing into tree A while the Manager
 * request, and the answer we hand back, belong to B.
 *
 * A dep set with no pinned generation was never frozen (a direct call with
 * injected deps), so there is nothing to compare and nothing to refuse.
 */
export function assertPinnedTarget(
  deps: PanelInstallerDeps,
  action: string,
  stage: string,
): void {
  const frozen = pinnedGenerationOf(deps);
  if (frozen === undefined || panelTargetGeneration() === frozen) return;
  throw new PanelInstallError(
    `Panel ${action} ABORTED ${stage}: the ComfyUI this orchestrator targets changed ` +
      `while the operation was in flight, so the local directory it was working in ` +
      `(${deps.comfyuiPath() ?? "unresolved"}) may no longer belong to the install this ` +
      `result would describe. NOT acting on, or reporting, a possibly-wrong tree. ` +
      `Re-run install_panel(action='status'), then retry.`,
  );
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
  // `existsSync` collapses EVERY error to false, so an unreadable custom_nodes
  // (EACCES/EIO) is indistinguishable from a fresh install that has none — and
  // the second is a proven absence while the first is not. The tri-state probe
  // tells them apart: only `undefined` (could not determine) makes the scan
  // unreliable, so an install is never recommended over a directory we simply
  // could not read into.
  if (deps.isDirectory(customNodes) === undefined) scanReliable = false;
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
    // Nor the in-flight replacement of a swap that was interrupted. It IS a
    // real panel, but it is not the CANONICAL install, and resolving it as one
    // would make an update compare a directory that is about to be renamed.
    // findPanelShadows still reports it (it serves panel assets), and
    // reconcilePanelSwap is what resolves it.
    if (basename(dir) === PANEL_INCOMING_NAME) continue;
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

  // REPAIR AN INTERRUPTED SWAP AT STARTUP. Replacing a directory takes two
  // renames and cannot be made atomic, so a process kill or host crash between
  // them leaves custom_nodes with NO panel and the working copy in
  // custom_nodes_backup. Until this ran here, recovery required the user to
  // know to invoke another panel mutation — an in-product dead end for the one
  // failure that actually takes the panel away. This path runs on every load
  // and already holds the op lock, so it is where the repair belongs.
  const ensureBase = deps.comfyuiPath();
  if (ensureBase) {
    // Same target binding the explicit mutations use: this runs unattended on
    // load, and the hello that triggers it retargets asynchronously, so a
    // retarget can land between the freeze and this restore.
    assertPinnedTarget(deps, "auto-install", "before repairing an interrupted swap");
    const repaired = reconcilePanelSwap(ensureBase, deps, { repair: true });
    if (repaired.note) {
      logger.warn(`[panel] on load:${repaired.note}`);
    }
    if (!repaired.ok) {
      return {
        action: "unavailable",
        reason:
          `A previous panel update was interrupted and could not be repaired ` +
          `automatically.${repaired.note ?? ""}`,
      };
    }
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
    // #766 — and the same caution about WHICH TREE we looked in. An unattended
    // install into a root the running server never named would land in a
    // custom_nodes nothing loads, and the user would see no panel and no error.
    // On a split install (Comfy Desktop's --base-directory) the configured path
    // is exactly that root. Nobody is watching this path, so it only acts on a
    // tree the live server itself chose.
    if (isRealDeps(deps) && !isLiveDerivedBase(lastPanelBaseResolution())) {
      return {
        action: "unavailable",
        reason:
          "The panel appears absent, but the ComfyUI root scanned came from " +
          "configuration rather than the running server, so it is not proven to be " +
          "the tree ComfyUI serves from (#766). Skipping auto-install rather than " +
          "installing into a custom_nodes that may never be loaded.",
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
    assertPinnedTarget(deps, "auto-install", "before the ComfyUI-Manager install");
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
    assertPinnedTarget(deps, "auto-install", "before reporting the install");
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
      // Resolve and FREEZE the live base for the unattended install too. This
      // path runs on load with nobody watching, so an unprimed `panelBaseSync()`
      // would fall back to the configured tree and quietly inspect — or install
      // into — a custom_nodes the running server never reads (#766).
      withPanelOpLock(async () => ensureInner(await pinPanelBase(deps)), {
        timeoutMs: ENSURE_LOCK_WAIT_MS,
      }),
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
  /**
   * Only meaningful when `installed` is false: is that absence PROVEN?
   *
   * `installed: false` reads as authoritative, and prose warnings do not travel
   * — a caller reading the boolean would never see the note explaining that the
   * tree we scanned is not the one the server reads. So the qualification gets
   * its own field. False when the scan could not complete, or when the ComfyUI
   * root came from configuration rather than from the running server (#766), in
   * which case a perfectly good panel may be sitting in the tree that is
   * actually served. Consumers must not install on an unproven absence.
   */
  absenceProven?: boolean;
  note: string;
}

/**
 * Repair an interrupted panel swap, under the op lock. Safe to call from any
 * read path that is NOT already holding the lock.
 *
 * A crash between the swap's two renames is the one failure mode that takes the
 * panel AWAY rather than merely misreporting it: custom_nodes ends up with no
 * panel at all, and without this the user could only recover by knowing to
 * invoke another panel mutation, or by moving directories by hand. So the
 * ordinary "what's going on?" call repairs it.
 *
 * The lock is what makes this safe from a read path — it cannot cut across
 * another process's in-flight swap. It is taken only when a journal is actually
 * present AND the canonical directory is missing (both cheap, lock-free checks),
 * so the common case costs nothing; if the lock cannot be had quickly, the swap
 * that wrote the journal is most likely still running, and we leave it alone.
 *
 * Never throws.
 */
export async function repairInterruptedPanelSwap(
  deps: PanelInstallerDeps = defaultDeps,
): Promise<string | undefined> {
  try {
    const pinned = await pinPanelBase(deps);
    const base = pinned.comfyuiPath();
    if (!base || !pinned.isLocalMode()) return undefined;
    // Cheap pre-check, no lock: is there anything to look at? Gated on EITHER
    // marker — the in-flight directory is the authority (a journal can be lost
    // while the rename that created it survives), and the journal alone still
    // deserves a report even though it is never grounds to move anything.
    const incoming = join(base, "custom_nodes", PANEL_INCOMING_NAME);
    if (!pinned.existsSync(incoming) && !pinned.existsSync(swapJournalPath(base))) {
      return undefined;
    }
    return await withPanelOpLock(
      async () => {
        // A PIN IS A PROMISE, and this repair MOVES a directory. "Nothing moves
        // the panel while a pin is in force" has to include a well-intentioned
        // restore — a pinned user who was interrupted gets the state reported
        // (panelStatus says exactly where the copy is), not rearranged for them.
        assertNotPinned("repair", pinned);
        // And the target must still be the one we froze against: a retarget
        // landing here would restore tree A while the caller is asking about B.
        assertPinnedTarget(pinned, "repair", "before restoring the previous panel");
        const outcome = reconcilePanelSwap(base, pinned, { repair: true });
        assertPinnedTarget(pinned, "repair", "before reporting the restore");
        return outcome.note;
      },
      { timeoutMs: ENSURE_LOCK_WAIT_MS },
    );
  } catch (err) {
    logger.debug("panel: interrupted-swap repair skipped", {
      err: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

/** status action — never throws. */
export async function panelStatus(
  depsIn: PanelInstallerDeps = defaultDeps,
): Promise<PanelStatus> {
  // Freeze the base for this whole read: detection, the shadow scan and the
  // reported path must all describe ONE directory (see pinPanelBase).
  const deps = await pinPanelBase(depsIn);
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
  const baseResolution = isRealDeps(deps) ? lastPanelBaseResolution() : undefined;
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
    // "Not installed" is a claim about a PARTICULAR tree, and it is only as
    // good as our reason for believing that is the tree ComfyUI reads. When the
    // base is merely the configured path — the running server never named it —
    // this is exactly the #766 report: a perfectly good panel sitting in the
    // tree the server actually serves, reported as missing, with an invitation
    // to install a second copy where nothing would load it. Say which tree was
    // scanned and that it is uncorroborated, rather than asserting absence.
    //
    // The same applies, more sharply, when the scan itself did not complete:
    // `installed: false` from a failed enumeration is "we could not look", and
    // inviting an install on that basis could clobber a panel the scan simply
    // missed — the loss `scanReliable` was introduced to prevent.
    const uncorroborated =
      isRealDeps(deps) && !isLiveDerivedBase(baseResolution);
    note = detection.scanReliable === false
      ? `Whether the panel is installed is UNKNOWN: ${comfyuiPath ?? "custom_nodes"}` +
        `/custom_nodes could not be fully enumerated (or a candidate's pyproject.toml ` +
        `could not be read), so this is NOT a proven absence and no install is ` +
        `recommended — one could clobber a panel the scan missed. Make custom_nodes ` +
        `readable, then re-check.`
      : uncorroborated
      ? `No panel found in ${comfyuiPath ?? "custom_nodes"} — but this is the ` +
        `CONFIGURED path, and the running ComfyUI did not confirm it is the tree it ` +
        `serves from, so "not installed" is UNCORROBORATED. On a split install ` +
        `(Comfy Desktop's --base-directory, #766) the panel lives elsewhere and ` +
        `installing here would land in a custom_nodes nothing loads. Start/reach ` +
        `ComfyUI so its own install root can be read, or check get_environment's ` +
        `local.workspace_path, before installing.`
      : `Not installed. Run install_panel(action='install') to add the panel (${PANEL_VERSION}). Restart ComfyUI afterwards.`;
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
  if (isRealDeps(deps)) {
    // A SHADOW DISQUALIFIES THE READING. The observation exists to answer one
    // question — "is the panel the browser loads already current?" — and a
    // served copy in custom_nodes means the browser is loading something OTHER
    // than the canonical pack whose version we just read (#641). Telling that
    // user "your install is fine, just hard-refresh" is doubly wrong: the
    // refresh re-loads the shadow. An indeterminate scan counts as a shadow,
    // because `shadows: []` from an enumeration that failed is not an all-clear.
    const shadowClean = !shadowInspectFailed && shadows.length === 0;
    if (detection.applicable && detection.installed && detection.version && shadowClean) {
      // Bind the observation to the base that was actually scanned, so it can
      // never be replayed as evidence about a different ComfyUI tree.
      recordPanelDiskObservation(detection.version, detection.dir, comfyuiPath);
    } else {
      clearPanelDiskObservation();
    }
  }

  // An interrupted swap is REPORTED here, never repaired: panelStatus holds no
  // lock and is called from everywhere, so moving directories from it could cut
  // across another process's in-flight swap. The mutation paths do the repair.
  const swapNote = comfyuiPath
    ? (reconcilePanelSwap(comfyuiPath, deps, { repair: false }).note ?? "")
    : "";

  const pin = readPinSafe(deps);
  const pinNote = pin.pinned
    ? ` PIN: ${describePanelPin(pin)} — install/update/reinstall are refused ` +
      `until it is cleared by ${describeInstallPanelAction(
        "unpin",
        "removing the pin on the ComfyUI host and restarting the orchestrator there",
      )}` +
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
    absenceProven: detection.installed
      ? undefined
      : detection.applicable &&
        detection.scanReliable !== false &&
        (!isRealDeps(deps) || isLiveDerivedBase(baseResolution)),
    pin,
    note: note + baseNote + swapNote + shadowNote + pinNote,
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
  /**
   * Set when this operation had to REPAIR an interrupted earlier swap before it
   * could proceed — e.g. it moved the user's previous panel back into
   * custom_nodes, or discarded a staged replacement.
   *
   * Restoring somebody's panel is a material event and must not be visible only
   * in the server log: a caller told merely "update succeeded" would never learn
   * that their install had been broken and was put back.
   */
  recoveryNote?: string;
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
  | "downgraded" // the version PROVABLY went backwards — applied, but not an update.
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

  // MOVED IS NOT THE SAME AS FORWARD. Direction is decided HERE, in the
  // classifier, rather than at one of the call sites: this is the single place
  // a version PAIR becomes a verdict, so a guard anywhere else covers only the
  // branch it sits on. A Manager that resolves an older build and lands it
  // would otherwise be classified "updated" and reported as
  // "Panel updated (0.11.40 → 0.11.38)" — the user congratulated for being
  // downgraded. Only a READABLE, COMPARABLE regression counts; `compareSemver`
  // returns 0 for anything it cannot parse, so it is never trusted alone.
  const comparableRegression =
    !!previousVersion &&
    !!installedVersion &&
    SEMVER_RE.test(previousVersion.trim()) &&
    SEMVER_RE.test(installedVersion.trim()) &&
    compareSemver(installedVersion, previousVersion) < 0;
  if (comparableRegression) return { ...base, outcome: "downgraded" };

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

  // The pack moved BACKWARDS. It applied, so this is not a no-op — but it is
  // certainly not an update, and reporting it as one would leave the user on an
  // older panel than they started with, told they had just upgraded.
  if (outcome === "downgraded") {
    throw new PanelInstallError(
      `Panel update did NOT go forward: the pack${dirNote} is now ` +
        `${installedVersion ?? "unreadable"}, which is OLDER than the ` +
        `${previousVersion ?? "unknown"} that was installed before. ComfyUI-Manager ` +
        `resolved and applied an earlier build. NOT reporting this as an update — you ` +
        `are now on an older panel than you started with. Update ComfyUI-Manager on ` +
        `the host (git pull in custom_nodes/ComfyUI-Manager, or pip install -U ` +
        `comfyui_manager) and retry, or reinstall the panel from source, then RESTART ` +
        `ComfyUI.`,
    );
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
/**
 * The corroboration refusal shared by BOTH direct fallbacks.
 *
 * A "direct" fallback bypasses ComfyUI-Manager and mutates a directory this
 * process picked. That is only defensible when the running server itself named
 * the tree — otherwise, on a Comfy Desktop split install, we would fast-forward
 * (or replace) a dormant checkout and report a verified success while the
 * browser's panel never moved.
 */
function assertSwapTreeCorroborated(
  deps: PanelInstallerDeps,
  comfyuiPath: string,
  what: string,
  managerReason: string,
): void {
  if (swapTreeIsCorroborated(deps)) return;
  throw new PanelInstallError(
    `Panel update did NOT apply (${managerReason}), and ${what} is REFUSED: the ` +
      `running ComfyUI did not confirm that ${comfyuiPath} is the tree it serves from, ` +
      `so this is the CONFIGURED path rather than a corroborated one. On a split ` +
      `install (Comfy Desktop's --base-directory, #766) those differ, and updating the ` +
      `panel here could move a copy nobody serves while the browser keeps loading the ` +
      `real one — reported as a verified success. Start ComfyUI so its install root can ` +
      `be read, then retry. ${describePanelUpdateRecovery()}`,
  );
}

async function updateViaGitCheckoutFallback(opts: {
  deps: PanelInstallerDeps;
  dir: string;
  previousVersion?: string;
  previousRev?: string;
  result: NodeOpResult;
  /**
   * Refuse if the orchestrator retargeted mid-operation. This helper MUTATES a
   * checkout and then reports the result, so both must belong to the ComfyUI the
   * request was made for — see the note on runPanelActionInner's binding.
   */
  assertSameTarget: (stage: string) => void;
}): Promise<PanelActionResult> {
  const { deps, dir, previousVersion, previousRev, result, assertSameTarget } = opts;

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
    assertSameTarget("before fast-forwarding the panel checkout");
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
  // A fast-forward can only advance HEAD, but the pyproject version it lands is
  // whatever upstream committed — so a proven regression is still possible and
  // must never fall through to the "already at upstream tip" report below.
  if (verdict.outcome === "downgraded") {
    throw new PanelInstallError(
      `Panel update did NOT go forward: the pinned fast-forward in ${dir} left the pack ` +
        `at ${post.version}, which is OLDER than the ${previousVersion ?? "unknown"} ` +
        `installed before it. NOT reporting this as an update, and NOT reporting the ` +
        `checkout as current — check the panel repo (git log) before restarting ComfyUI.`,
    );
  }
  if (verdict.outcome === "updated") {
    const from = verdict.previousVersion ?? verdict.previousRev?.slice(0, 8) ?? "?";
    const to = verdict.installedVersion ?? verdict.installedRev?.slice(0, 8) ?? "?";
    // The embedded result came from the Manager call that no-op'd — its own
    // message may credit ComfyUI-Manager. The report must not contradict the
    // git-fallback path that actually did the work (codex gate).
    assertSameTarget("before reporting the fast-forward");
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
  assertSameTarget("before reporting the checkout as current");
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
  writeFile: (p: string, contents: string) => void;
}

// ---------------------------------------------------------------------------
// Swap journal — crash recovery for the one window that cannot be made atomic.
//
// Replacing a directory takes TWO renames (a rename onto a non-empty directory
// fails), so there is an instant where the panel is out of custom_nodes and its
// replacement is not yet in. A caught failure is handled inline — the backup is
// moved straight back. A process kill or host crash in that instant is not
// caught by anything, and would leave the user with NO panel in custom_nodes,
// the working copy stranded in custom_nodes_backup, and nothing on disk saying
// what happened or how to undo it.
//
// So the intent is written down BEFORE the first rename, to a file beside
// custom_nodes (never inside it — ComfyUI serves everything in there). The next
// panel operation reads it back and repairs.
//
// Reconciliation is deliberately timid. It restores ONLY when the canonical
// directory is missing — the single state that is unambiguously a broken swap —
// and it restores the copy that was already on disk and working, never the
// staged one, whose validation may not have finished. Anything else it merely
// reports. It runs under the panel op lock (both mutation entry points hold
// it), so it cannot fire in the middle of another process's swap.
// ---------------------------------------------------------------------------

const PANEL_SWAP_JOURNAL = ".comfyui-agent-panel.swap.json";

/**
 * The in-flight replacement, parked INSIDE custom_nodes under a fixed name.
 *
 * This is the mechanism that makes the swap survivable, and it replaces the
 * journal as the authority on "is a swap in progress?".
 *
 * The old ordering moved the working panel OUT and then moved the new one IN,
 * so between those two renames custom_nodes held NO panel — and recovery
 * depended on a journal file whose *directory entry* is not durable just because
 * the file's contents were fsync'd. A power loss could persist the rename and
 * lose the journal, leaving the user with no panel and nothing to recover from.
 * A journal that is not durable before the action it guards is not a journal.
 *
 * So the new panel is moved IN first, under this name, and the old one is moved
 * out afterwards. At every interruptible point at least one panel directory is
 * present in custom_nodes and ComfyUI serves it (the web layer serves
 * dot-prefixed dirs too — the same fact that makes #641 shadows possible works
 * in our favour here). And the recovery state is derivable from the FILESYSTEM
 * ALONE: this directory existing means a swap was interrupted, no journal
 * required. Nothing else ever creates this name.
 */
const PANEL_INCOMING_NAME = ".comfyui-agent-panel.incoming";

interface PanelSwapJournal {
  /** Canonical panel dir the swap targets. */
  dir: string;
  /** Where the working copy was moved to. */
  backupDir: string;
  /** The validated clone waiting to move in. */
  staging: string;
  startedAt: number;
  previousVersion?: string;
}

function swapJournalPath(comfyuiPath: string): string {
  return join(comfyuiPath, PANEL_SWAP_JOURNAL);
}

/**
 * Repair an interrupted swap, if one is recorded. Returns a human-readable note
 * when it did something (or could not), else undefined. Never throws — a
 * journal we cannot read must not block panel management, only be reported.
 */
interface SwapReconcileResult {
  /**
   * False ONLY when a broken swap was found and NOT put right. A mutation must
   * not proceed past that: installing into the empty canonical path would look
   * like success while the user's real panel stayed stranded in the backup dir,
   * and the next reconcile — seeing a directory there again — would quietly
   * delete the journal that recorded where it went.
   */
  ok: boolean;
  /** Human-readable note, when there is something to say. */
  note?: string;
}

/**
 * Is this directory a panel that would actually WORK if ComfyUI loaded it?
 *
 * Deliberately stricter than "the directory is there": recovery decisions delete
 * things, and a husk — an emptied directory, or one left by a half-finished move
 * — must never be mistaken for a healthy install and used to justify discarding
 * the only good copy. Requires the panel's own pyproject identity AND the built
 * web bundle; every uncertainty (unreadable file, indeterminate probe) answers
 * "no".
 */
function dirIsUsablePanel(dir: string, deps: PanelInstallerDeps): boolean {
  try {
    const pyproject = join(dir, "pyproject.toml");
    if (!deps.existsSync(pyproject)) return false;
    if (parsePyproject(deps.readFile(pyproject)).projectName !== PANEL_REGISTRY_ID) {
      return false;
    }
    return servesPanelWebAssets(dir, deps) === true;
  } catch {
    return false;
  }
}

function reconcilePanelSwap(
  comfyuiPath: string,
  deps: PanelInstallerDeps,
  opts: { repair: boolean },
): SwapReconcileResult {
  const journalPath = swapJournalPath(comfyuiPath);
  const incomingDir = join(comfyuiPath, "custom_nodes", PANEL_INCOMING_NAME);
  const incomingPresent = deps.existsSync(incomingDir);

  const readJournal = (): PanelSwapJournal | undefined => {
    if (!deps.existsSync(journalPath)) return undefined;
    try {
      const j = JSON.parse(deps.readFile(journalPath)) as PanelSwapJournal;
      return j?.dir && j?.backupDir ? j : undefined;
    } catch {
      return undefined;
    }
  };
  const dropJournal = () => {
    try {
      deps.removeDir?.(journalPath);
    } catch {
      // A stale journal is noise, not damage — the next reconcile re-reports it.
    }
  };

  // THE FILESYSTEM IS THE AUTHORITY, not the journal.
  //
  // A swap is in progress if and only if the incoming directory exists: nothing
  // else ever creates that name, and unlike a journal it is created by the very
  // rename that begins the operation, so it cannot be lost while the operation's
  // effects survive. The journal is now only a convenience — it names where the
  // old copy went — and is never, on its own, grounds to move anything.
  if (!incomingPresent) {
    const stale = readJournal();
    if (!stale) return { ok: true };
    if (deps.existsSync(stale.dir)) {
      // Panel present and no swap in flight — the record is simply spent.
      dropJournal();
      return { ok: true };
    }
    // A JOURNAL WITHOUT AN INCOMING DIRECTORY IS STALE, and stale means UNKNOWN,
    // not "a swap is half-done". The likeliest cause is a swap that COMPLETED
    // and died before deleting its journal — after which the user may well have
    // deliberately uninstalled the panel. Restoring the backup would then
    // resurrect software they intentionally removed. "There is a journal" only
    // ever meant "a journal exists". So: report, never mutate.
    return {
      ok: false,
      note:
        ` NOTE: a panel swap journal is present at ${journalPath}, but no in-flight swap ` +
        `was found and there is no panel at ${stale.dir}. That record may be left over ` +
        `from a swap that COMPLETED, in which case the panel is absent because it was ` +
        `deliberately uninstalled — so nothing has been moved. If you DID lose the panel ` +
        `to an interrupted update, its previous copy should be at ${stale.backupDir}: ` +
        `move it back and delete the journal, or reinstall with ` +
        `${describeInstallPanelAction("install", "a fresh install on the ComfyUI host")}.`,
    };
  }

  // A swap WAS interrupted. Which half depends on whether the canonical dir is
  // still there — and either way a panel is present in custom_nodes right now,
  // because the incoming directory is itself served.
  const journal = readJournal();
  const canonicalDir =
    journal?.dir ?? join(comfyuiPath, "custom_nodes", PANEL_REGISTRY_ID);
  // "EXISTS" IS WEAKER THAN "WORKS", and the difference decides whether we are
  // allowed to delete anything. The discard branch below throws away the staged
  // panel on the strength of the canonical one being fine — so the canonical one
  // has to be PROVEN fine: a real panel pyproject and the built web bundle
  // ComfyUI actually serves. A husk left by a half-finished move, or a directory
  // someone emptied, would otherwise cost the user the only working copy.
  const canonicalPresent = deps.existsSync(canonicalDir);
  const canonicalUsable = canonicalPresent && dirIsUsablePanel(canonicalDir, deps);

  // REPAIR ONLY UNDER THE OP LOCK. panelStatus is called from many places and
  // holds no lock, so repairing from there could move directories out from
  // under another process's in-flight swap. From a read it only reports.
  if (!opts.repair) {
    return {
      ok: false,
      note:
        ` WARNING: a panel update was interrupted — a staged replacement is sitting at ` +
        `${incomingDir}. ${
          canonicalPresent
            ? `Your existing panel at ${canonicalDir} is intact.`
            : `ComfyUI is currently serving that staged copy; the previous panel is at ` +
              `${journal?.backupDir ?? join(comfyuiPath, "custom_nodes_backup")}.`
        } Run ${describeInstallPanelAction("update", "an update on the ComfyUI host")} ` +
        `to finish or undo it automatically.`,
    };
  }

  if (canonicalPresent && !canonicalUsable) {
    // There is something at the canonical name, but it is not a working panel —
    // so neither branch below is safe. Discarding the staged copy could remove
    // the ONLY usable panel, and completing the move cannot rename onto an
    // occupied name. The user is not broken in the meantime: the staged copy is
    // dot-prefixed, so ComfyUI serves it. Report and touch nothing.
    return {
      ok: false,
      note:
        ` WARNING: a panel update was interrupted, and the directory at ${canonicalDir} ` +
        `is present but is NOT a usable panel (no readable panel pyproject.toml, or no ` +
        `built web bundle). Nothing has been moved: discarding the staged replacement ` +
        `at ${incomingDir} could remove the only working copy. ComfyUI serves that ` +
        `staged copy, so the panel still loads. Inspect ${canonicalDir}, remove it if ` +
        `it is a leftover, then re-run ` +
        `${describeInstallPanelAction("status", "a re-check on the ComfyUI host")}.`,
    };
  }

  if (canonicalUsable) {
    // Interrupted BEFORE the old panel was moved aside. The working panel is
    // untouched, so the conservative repair is to ABANDON the staged copy rather
    // than complete a swap whose remaining steps were never verified. The update
    // simply did not happen, and can be retried.
    try {
      deps.removeDir?.(incomingDir);
      dropJournal();
      logger.warn(
        `[panel] cleared a staged panel replacement left by an interrupted update ` +
          `(${incomingDir}); the existing panel at ${canonicalDir} is untouched.`,
      );
      return {
        ok: true,
        note:
          ` NOTE: a previous panel update was interrupted before it replaced anything. ` +
          `The staged copy has been discarded and your existing panel at ${canonicalDir} ` +
          `is intact — nothing was changed. Retry the update when convenient.`,
      };
    } catch (err) {
      return {
        ok: false,
        note:
          ` WARNING: a staged panel replacement at ${incomingDir} could not be cleared ` +
          `(${err instanceof Error ? err.message : String(err)}). ComfyUI serves every ` +
          `directory under custom_nodes, so it may SHADOW your real panel at ` +
          `${canonicalDir}. Remove it manually, then restart ComfyUI.`,
      };
    }
  }

  // Interrupted AFTER the old panel was moved aside: the staged copy is the only
  // panel in custom_nodes, and ComfyUI is already serving it. Finish the move so
  // it sits under its proper name.
  if (!deps.rename) {
    return {
      ok: false,
      note:
        ` WARNING: a panel update was interrupted with the replacement still at ` +
        `${incomingDir}; it cannot be moved into place from here. Rename it to ` +
        `${canonicalDir} manually, then restart ComfyUI.`,
    };
  }
  try {
    deps.rename(incomingDir, canonicalDir);
    dropJournal();
    logger.warn(
      `[panel] completed an interrupted panel update: moved ${incomingDir} into place ` +
        `at ${canonicalDir}. RESTART ComfyUI.`,
    );
    return {
      ok: true,
      note:
        ` NOTE: a previous panel update was interrupted after it had moved the old copy ` +
        `aside. The new panel has been moved into place at ${canonicalDir}` +
        `${journal?.backupDir ? ` (the previous copy remains at ${journal.backupDir})` : ""}. ` +
        `RESTART ComfyUI to load it.`,
    };
  } catch (err) {
    return {
      ok: false,
      note:
        ` WARNING: a panel update was interrupted and its replacement at ${incomingDir} ` +
        `could not be moved into place (${err instanceof Error ? err.message : String(err)}). ` +
        `ComfyUI is still serving it, so the panel works, but it is not under its proper ` +
        `name — rename it to ${canonicalDir} manually, then restart ComfyUI.`,
    };
  }
}

/**
 * The four primitives the swap needs, or undefined when the dep set does not
 * carry all of them. Required as a SET: half a swap is worse than none, so a
 * partial dep set disables the fallback entirely rather than starting work it
 * cannot finish or undo.
 */
function resolveSwapOps(deps: PanelInstallerDeps): PanelSwapOps | undefined {
  const { gitClonePanel, mkdirp, rename, removeDir, writeFile } = deps;
  if (!gitClonePanel || !mkdirp || !rename || !removeDir || !writeFile) return undefined;
  return { clone: gitClonePanel, mkdirp, rename, removeDir, writeFile };
}

/**
 * May we perform a WHOLESALE REPLACEMENT against this tree?
 *
 * The base resolution falls back to the configured path whenever
 * `/system_stats` cannot be reached — and on a Comfy Desktop split install the
 * configured path is exactly the tree the running server does NOT read (#766).
 * A transient probe failure is indistinguishable from "there is no split", so
 * the fallback can hand us a directory that holds a panel nobody is serving.
 *
 * For a READ that is acceptable (it is the best answer available, and it is
 * labelled). For deleting a directory and moving another over it, it is not: we
 * would replace a dormant copy, verify it happily, and report a verified update
 * while the panel in the user's browser stayed exactly where it was. So this
 * path requires the running server to have had a SAY in choosing the tree.
 *
 * `liveProbeFailed === false` with `source: "configured"` is fine — the server
 * answered and its argv simply offered nothing better.
 */
function swapTreeIsCorroborated(deps: PanelInstallerDeps): boolean {
  // An injected dep set declared its own base explicitly; there is no live
  // server to corroborate it against and none is implied.
  if (!isRealDeps(deps)) return true;
  // REACHABLE IS NOT ENOUGH. A /system_stats response with absent or
  // unparseable argv proves only that something answered on the URL; it does
  // not prove COMFYUI_PATH is the tree that server reads. Require a root the
  // running server actually named.
  const resolution = lastPanelBaseResolution();
  if (!isLiveDerivedBase(resolution)) return false;
  // AND IT MUST BE THE TREE WE FROZE. Asking only "is the CURRENT resolution
  // live-derived?" answers a question about now, while the directory we are
  // about to mutate was chosen earlier — so a retarget in between would let a
  // live-derived answer about server B bless a mutation of server A's tree,
  // which is precisely the wrong-tree swap this gate exists to stop. The two
  // must be the same directory.
  const frozen = pinnedBaseOf(deps) ?? deps.comfyuiPath();
  return !!frozen && !!resolution?.base && samePathCI(frozen, resolution.base, deps);
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
  /**
   * Refuse if the orchestrator retargeted mid-operation. Checked immediately
   * before the irreversible part and again before any success is reported: this
   * path MOVES directories, so acting on a target that has since changed could
   * replace the wrong machine's panel.
   */
  assertSameTarget: (stage: string) => void;
}): Promise<PanelActionResult> {
  const {
    deps,
    ops,
    dir,
    comfyuiPath,
    previousVersion,
    result,
    managerReason,
    assertSameTarget,
  } = opts;

  // CORROBORATE THE TREE before replacing anything in it.
  assertSwapTreeCorroborated(
    deps,
    comfyuiPath,
    "the reinstall-from-source fallback",
    managerReason,
  );

  // NOT A GIT CHECKOUT. This is the whole precondition: this path replaces the
  // directory wholesale, which would discard a checkout's branch, remotes and
  // any local commits.
  //
  // PROVE IT, do not infer it. `resolveGitRevision` returns undefined for BOTH
  // "there is no .git" and "there is a .git but its HEAD/ref/pointer could not
  // be read", so an unreadable or momentarily-malformed checkout looks exactly
  // like a Registry zip. Treating the second as the first would rename a
  // developer's working repo out of custom_nodes. So the absence of `.git`
  // itself is the requirement, and an unresolvable revision beside a present
  // `.git` is a refusal, not a licence.
  // The probes are TRI-STATE on purpose. `existsSync` collapses every error to
  // false, so an EACCES on `.git` would read as "there is no .git" and license
  // the replacement of a real checkout — the very inference this guard exists to
  // stop. `.git` is a directory in an ordinary clone and a FILE in a worktree or
  // submodule, so both shapes are probed, and only a CONFIRMED absence of both
  // (false, not undefined) counts as proof.
  const gitDir = join(dir, ".git");
  // `probeFile` is the only dep here whose FALSE is a real determination
  // (ENOENT/ENOTDIR, or "it is a directory"); `isDirectory` returns undefined
  // for a missing path too, so it cannot express absence. Combining the two
  // signals covers both shapes `.git` takes:
  //   undefined                     → the probe FAILED → refuse, prove nothing
  //   true                          → a regular file → worktree/submodule pointer
  //   false + existsSync            → present but not a file → a .git DIRECTORY
  //   false + !existsSync           → PROVEN absent → the zip shape, proceed
  const gitProbe = deps.probeFile(gitDir);
  if (gitProbe === undefined) {
    throw new PanelInstallError(
      `Panel update did NOT apply (${managerReason}), and the reinstall-from-source ` +
        `fallback is REFUSED: whether ${gitDir} exists could NOT be determined, so it ` +
        `cannot be PROVEN that ${dir} is not a git checkout. Replacing a checkout ` +
        `wholesale would discard its branch, remotes and any local commits, and this ` +
        `path never infers absence from a failed probe. Fix the permissions on ${dir} ` +
        `and retry, or update the pack manually.`,
    );
  }
  if (gitProbe === true || deps.existsSync(gitDir)) {
    const rev = deps.gitRevision(dir);
    throw new PanelInstallError(
      `Panel update did NOT apply (${managerReason}), and the reinstall-from-source ` +
        `fallback is REFUSED: ${dir} has a .git${
          rev ? "" : " whose revision could not be read"
        }, so it is${rev ? "" : " (or may be)"} a git checkout, and replacing it ` +
        `wholesale would discard its branch, remotes and any local commits. The ` +
        `fast-forward path handles a checkout; this one exists only for a Comfy ` +
        `Registry zip install, which has no .git at all. Update the panel repo ` +
        `manually (git pull in ${dir})${
          rev ? "" : `, or repair its .git metadata first`
        }, then RESTART ComfyUI.`,
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
    //
    // BOTH versions must be strictly comparable before a WHOLESALE REPLACEMENT.
    // Skipping the comparison when either side is unparseable would let a
    // `dev`/`0.11.38.1` clone overwrite a working 0.11.40 and then report
    // "Panel updated (0.11.40 → dev)" — an unproven downgrade of the live
    // panel, dressed as success. `compareSemver` returns 0 for anything it
    // cannot parse, so it cannot be trusted to catch this itself. No comparison
    // ⇒ no replacement.
    if (!SEMVER_RE.test(stagedVersion.trim())) {
      throw new PanelInstallError(
        `the freshly cloned panel reports version "${stagedVersion}", which is not a ` +
          `comparable version number, so it cannot be shown to be NEWER than the ` +
          `installed ${previousVersion ?? "(unreadable)"} — refusing to replace a ` +
          `working panel with an unverifiable one`,
      );
    }
    if (!previousVersion || !SEMVER_RE.test(previousVersion.trim())) {
      throw new PanelInstallError(
        `the installed panel's version (${previousVersion ?? "unreadable"}) is not a ` +
          `comparable version number, so replacing it with the published ` +
          `${stagedVersion} could silently move you BACKWARDS — refusing. Check the ` +
          `pack's pyproject.toml at ${dir} first`,
      );
    }
    {
      const delta = compareSemver(stagedVersion, previousVersion);
      if (delta < 0) {
        throw new PanelInstallError(
          `the published panel (${stagedVersion}) is OLDER than the one installed ` +
            `(${previousVersion}) — refusing to move the panel backwards`,
        );
      }
      if (delta === 0) {
        // Honest non-mutation — but "already current" is still a CLAIM about the
        // disk, and `previousVersion` was read before the Manager call and the
        // clone. Re-read it now, exactly as the mutating paths do: a pack that
        // was removed, moved or changed in that window must not be certified
        // current off a stale value (#639 discipline applies to claims of
        // currency, not only to claims of change).
        const still = await detectPanelInstall(deps);
        if (
          !still.installed ||
          !still.version ||
          !still.dir ||
          !samePathCI(dir, still.dir, deps) ||
          still.version !== previousVersion
        ) {
          throw new PanelInstallError(
            `Could not confirm the panel is current: a fresh clone carries ` +
              `${stagedVersion}, but re-reading ${dir} afterwards found ` +
              `${
                !still.installed
                  ? "no panel there"
                  : !still.version
                    ? "an unreadable version"
                    : !still.dir || !samePathCI(dir, still.dir, deps)
                      ? `the panel resolved at a different directory (${still.dir ?? "none"})`
                      : `version ${still.version}, not the ${previousVersion} this ` +
                        `check was based on`
              }. NOT reporting "already up to date" on a stale reading. Re-run ` +
              `install_panel(action='status').`,
          );
        }
        // A shadow makes any statement about what the BROWSER loads untrue,
        // including "you are already current".
        assertNoPanelShadow("update", still.dir, deps);
        assertSameTarget("before reporting the panel as current");
        ops.removeDir(staging);
        const atTip =
          `Panel is already at the published version (${still.version}, re-read from ` +
          `${still.dir}) — ${managerReason}, and a fresh clone of the panel repo ` +
          `carries the SAME version, so there is nothing to install. Nothing changed ` +
          `on disk; no restart needed.`;
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
          installedVersion: still.version,
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
  // THE SWAP, ordered so that a panel is ALWAYS present in custom_nodes.
  //
  // Replacing a directory cannot be done in one rename (renaming onto a
  // non-empty directory fails on every platform we support), so there is no
  // atomic version of this. What CAN be arranged is that no interruptible point
  // leaves custom_nodes empty of panels:
  //
  //   1. new panel  -> custom_nodes/.comfyui-agent-panel.incoming   (both present)
  //   2. old panel  -> custom_nodes_backup/...                      (incoming served)
  //   3. incoming   -> custom_nodes/comfyui-agent-panel             (done)
  //
  // After step 1 the old panel still serves; after step 2 the incoming one does
  // (ComfyUI serves dot-prefixed directories too — the fact behind #641 shadows,
  // working for us here). The earlier ordering did step 2 first and left a
  // window with NO panel at all, recoverable only via a journal whose directory
  // entry a power loss can drop even after the file's contents are fsync'd.
  //
  // Recovery is therefore derivable from the FILESYSTEM alone: the incoming
  // directory existing IS the evidence of an interrupted swap. The journal below
  // only records where the old copy went, and is never grounds to move anything
  // by itself (see reconcilePanelSwap).
  const incomingDir = join(comfyuiPath, "custom_nodes", PANEL_INCOMING_NAME);
  if (deps.existsSync(incomingDir)) {
    ops.removeDir(staging);
    throw new PanelInstallError(
      `Panel update did NOT apply (${managerReason}), and the reinstall-from-source ` +
        `fallback refused to start: a staged replacement is already sitting at ` +
        `${incomingDir}, which means an earlier update was interrupted and has not been ` +
        `reconciled yet. Re-run install_panel(action='status') to have it repaired, ` +
        `then retry.`,
    );
  }

  const journalPath = swapJournalPath(comfyuiPath);
  assertSameTarget("before replacing the panel directory");
  try {
    ops.mkdirp(backupRoot);
    ops.writeFile(
      journalPath,
      JSON.stringify(
        {
          dir,
          backupDir,
          staging: incomingDir,
          startedAt: Date.now(),
          previousVersion,
        } satisfies PanelSwapJournal,
        null,
        2,
      ),
    );
  } catch (err) {
    ops.removeDir(staging);
    throw new PanelInstallError(
      `Panel update did NOT apply: nothing was changed on disk. ${managerReason}, and ` +
        `the reinstall-from-source fallback refused to start because it could not ` +
        `record where the previous panel will be moved, at ${journalPath} ` +
        `(${err instanceof Error ? err.message : String(err)}). Check permissions on ` +
        `${comfyuiPath} and retry.`,
    );
  }

  // STEP 1 — bring the new panel IN. Both panels are now present; the incoming
  // one is dot-prefixed and would win registration, but this window is closed by
  // step 3 (and, if we are interrupted, by reconciliation).
  try {
    ops.rename(staging, incomingDir);
  } catch (err) {
    ops.removeDir(journalPath);
    ops.removeDir(staging);
    throw new PanelInstallError(
      `Panel update did NOT apply: nothing was changed on disk. ${managerReason}, and ` +
        `the reinstall-from-source fallback could not move the new panel into ` +
        `custom_nodes (${staging} → ${incomingDir}: ` +
        `${err instanceof Error ? err.message : String(err)}). The existing panel is ` +
        `untouched. Check permissions on ${comfyuiPath}/custom_nodes and retry.`,
    );
  }

  // BARRIER BETWEEN STEP 1 AND STEP 2.
  //
  // The recovery guarantee rests on this: if "old panel moved aside" survives a
  // crash, the earlier "new panel moved in" must have survived too, or there is
  // no panel and no marker to find one by.
  //
  // Two things back that up, in order of strength. First, both are RENAMES in
  // the same directory — metadata operations, which a journaling filesystem
  // (NTFS, ext4, APFS) commits in order, so a later one cannot land while an
  // earlier one is lost. That is a genuinely different situation from the
  // journal FILE this ordering replaced: file contents sit in the page cache and
  // can be dropped while later metadata persists, which is exactly why a journal
  // was the wrong mechanism. Second, belt and braces: confirm the entry is
  // actually visible before continuing, so we never move the old panel aside on
  // the strength of a rename that did not take, and ask the platform for a
  // durability barrier where it can give one.
  if (!deps.existsSync(incomingDir)) {
    ops.removeDir(staging);
    ops.removeDir(journalPath);
    throw new PanelInstallError(
      `Panel update did NOT apply: nothing was changed on disk. ${managerReason}, and ` +
        `the reinstall-from-source fallback stopped because the staged panel is not ` +
        `visible at ${incomingDir} after being moved there. The existing panel is ` +
        `untouched. Check ${comfyuiPath}/custom_nodes and retry.`,
    );
  }
  deps.syncDir?.(join(comfyuiPath, "custom_nodes"));

  // STEP 2 — move the old panel OUT, to a sibling of custom_nodes. Leaving it
  // beside the new one would shadow it in the browser (#641).
  try {
    ops.rename(dir, backupDir);
  } catch (err) {
    // The old panel is still in place and serving; get the staged copy OUT of
    // custom_nodes so it cannot shadow it, and leave the install exactly as we
    // found it.
    //
    // MOVE FIRST, DELETE SECOND. A plain recursive delete can fail partway (a
    // locked file, a permission fault) and leave a half-deleted directory still
    // sitting in custom_nodes — still served, still shadowing, and now damaged.
    // A rename back out to the staging path is a single atomic metadata
    // operation on the same volume, so it either fully succeeds or changes
    // nothing; only then is the deletion attempted, where a failure is harmless
    // because the directory is no longer under custom_nodes.
    let cleared = true;
    try {
      ops.rename(incomingDir, staging);
      try {
        ops.removeDir(staging);
      } catch {
        // Outside custom_nodes now — leftover bytes, not a shadow.
      }
    } catch {
      cleared = false;
    }
    if (cleared) ops.removeDir(journalPath);
    throw new PanelInstallError(
      `Panel update did NOT apply: ${managerReason}, and the reinstall-from-source ` +
        `fallback could not move the existing panel out of custom_nodes ` +
        `(${dir} → ${backupDir}: ${err instanceof Error ? err.message : String(err)}). ` +
        `Your panel at ${dir} is untouched and still serving. ` +
        (cleared
          ? `The staged replacement was discarded.`
          : `The staged replacement at ${incomingDir} could NOT be discarded and may ` +
            `shadow it — remove that directory, then restart ComfyUI.`) +
        ` Check permissions / that ComfyUI does not hold the directory open (stop ` +
        `ComfyUI and retry).`,
    );
  }

  // STEP 3 — put the new panel under its proper name. Until this lands the
  // incoming directory is what ComfyUI serves, so the panel is never absent.
  try {
    ops.rename(incomingDir, dir);
  } catch (err) {
    // DO NOT "ROLL BACK" HERE. The obvious-looking recovery — delete the
    // incoming copy, move the backup home — deletes the ONLY panel currently
    // under custom_nodes before it knows whether the restore will succeed. If
    // that second step then fails, the user is left with no panel at all: the
    // exact outage this whole ordering exists to prevent, reintroduced on a
    // path that was trying to help.
    //
    // Nothing needs undoing anyway. The incoming directory is a fully validated
    // panel (identity, version, built web bundle — all checked before it was
    // staged) and ComfyUI is serving it right now. This is a NAMING problem, not
    // an outage, and reconciliation finishes it later. So leave the filesystem
    // exactly as it is, keep the journal, and say so.
    throw new PanelInstallError(
      `Panel update did NOT complete: ${managerReason}, and the reinstall-from-source ` +
        `fallback failed while moving the new panel into place ` +
        `(${incomingDir} → ${dir}: ${err instanceof Error ? err.message : String(err)}). ` +
        `You are NOT without a panel — the new one is at ${incomingDir} and ComfyUI ` +
        `serves it, and the previous copy is at ${backupDir}. Nothing was rolled back, ` +
        `because undoing this would have meant deleting the only panel in custom_nodes ` +
        `first. Re-run install_panel(action='status') to have it moved into place ` +
        `automatically, then RESTART ComfyUI.`,
    );
  }

  // Both renames landed: there is a panel in custom_nodes again, so the
  // crash-repair window is CLOSED and the journal must go before verification —
  // a later throw here is an honest "could not verify", not a broken swap, and
  // leaving the journal would make the next operation "repair" a directory that
  // is already in place.
  ops.removeDir(journalPath);

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
  // AND IT MUST HAVE GONE FORWARD. The STAGED version was checked before the
  // swap, but this is a fresh read taken afterwards, and the two can disagree:
  // a concurrent Manager run or a manual edit between the final rename and this
  // read can leave something older in place. Reporting that as "updated" is the
  // same fabricated progress this file refuses everywhere else, so the OBSERVED
  // version is checked, not just the intended one.
  if (
    previousVersion &&
    SEMVER_RE.test(previousVersion.trim()) &&
    SEMVER_RE.test(post.version.trim()) &&
    compareSemver(post.version, previousVersion) < 0
  ) {
    throw new PanelInstallError(
      `Panel reinstall-from-source did NOT go forward: after the swap, ${dir} reads ` +
        `${post.version}, which is OLDER than the ${previousVersion} it replaced — even ` +
        `though the clone that was staged was newer. Something changed the pack between ` +
        `the swap and this check. NOT reporting an update. The previous panel is at ` +
        `${backupDir}; check custom_nodes before restarting ComfyUI.`,
    );
  }

  assertSameTarget("before reporting the reinstall");
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

/**
 * Public entry: runs the action, then makes sure any REPAIR it had to perform
 * first is visible to the caller.
 *
 * Restoring somebody's panel — or discarding a staged replacement — is a
 * material change to their install. Reporting it only in the server log would
 * leave the caller believing nothing happened but the update they asked for. It
 * rides on BOTH outcomes: a failed action that nonetheless repaired something
 * must say so just as loudly as a successful one.
 */
export async function runPanelActionInner(
  action: "install" | "update" | "reinstall",
  depsIn: PanelInstallerDeps,
  opts: PanelActionOptions = {},
): Promise<PanelActionResult> {
  const carried: { note?: string } = {};
  try {
    const result = await runPanelActionCore(action, depsIn, opts, carried);
    if (!carried.note) return result;
    return {
      ...result,
      recoveryNote: carried.note,
      message: `${result.message}${carried.note}`,
    };
  } catch (err) {
    // ANY error, not just ours. install/reinstall await ComfyUI-Manager
    // operations directly, which reject with NodeManagementError and friends —
    // so restricting this to PanelInstallError meant a repair could happen and
    // then be silently dropped because the action failed for an unrelated
    // reason. The message is appended in place rather than re-wrapped, so the
    // original error's CLASS and details survive for callers that check them.
    if (carried.note && err instanceof Error) {
      err.message = `${err.message}${carried.note}`;
    }
    throw err;
  }
}

async function runPanelActionCore(
  action: "install" | "update" | "reinstall",
  depsIn: PanelInstallerDeps,
  opts: PanelActionOptions,
  carried: { note?: string },
): Promise<PanelActionResult> {
  const targetVersion = opts.version?.trim() || PANEL_VERSION;
  // Resolve the LIVE ComfyUI base ONCE and FREEZE it for the whole operation,
  // so detection, the shadow scan, the staging/backup paths and the post-op
  // re-read all describe the same directory (#766/#769). A base that drifted
  // mid-op would make the "did the pack move?" proof compare two different
  // trees — see pinPanelBase.
  const deps = await pinPanelBase(depsIn);
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
  //
  // It runs BEFORE the interrupted-swap repair below, which also moves
  // directories. "Nothing here moves the panel while a pin is in force" has to
  // mean every mutation, including a well-intentioned repair: a pinned user who
  // was interrupted mid-update gets the broken state REPORTED (panelStatus says
  // where the copy is), not silently rearranged.
  assertNotPinned(action, deps);

  // REPAIR AN INTERRUPTED SWAP. If a previous reinstall-from-source was killed
  // between its two renames, custom_nodes has no panel right now and the working
  // copy is sitting in custom_nodes_backup. Detection would read that as "not
  // installed" and this operation would happily install over the top of a broken
  // state. Both mutation entry points hold the panel op lock, so this is the
  // safe place to put it back.
  // BIND THE OPERATION TO ONE TARGET.
  //
  // This function freezes a LOCAL filesystem base, but the ComfyUI-Manager
  // mutation it delegates to captures the HTTP target independently, at its own
  // call time. A retarget landing between the two would dispatch Manager work to
  // one server and then verify — or clone-swap — the other server's tree, and
  // report the second's result for the first's request. The orchestrator makes
  // this reachable in practice: it starts the panel sync on a hello and
  // retargets in the same handler.
  //
  // We cannot make the two captures atomic from here, but we can refuse to
  // report anything once they may have diverged: the generation is checked
  // immediately before the mutation and again before any success is returned.
  //
  // Use the generation captured when the base was FROZEN, not one read here.
  // performPanelSync freezes the base and only then calls this function, and a
  // retarget can land in between — by the time we re-enter, that change has
  // already happened and reading the generation now would record it as the
  // status quo, making the very divergence we are guarding against invisible.
  const opGeneration = pinnedGenerationOf(deps) ?? panelTargetGeneration();
  const assertSameTarget = (stage: string): void => {
    if (panelTargetGeneration() === opGeneration) return;
    throw new PanelInstallError(
      `Panel ${action} ABORTED ${stage}: the ComfyUI this orchestrator targets changed ` +
        `while the operation was in flight, so the local directory it was working in ` +
        `(${comfyPath}) and the server the ComfyUI-Manager request went to may no ` +
        `longer be the same install. NOT reporting a result that could describe the ` +
        `wrong one. Re-run install_panel(action='status'), then retry.`,
    );
  };

  // The repair MOVES directories (it completes or discards a staged swap), so it
  // is bound to the frozen target exactly like every other mutation here. Without
  // this, a retarget landing between the freeze and this point could discard or
  // complete the PREVIOUS target's interrupted swap before the later assertions
  // ever ran.
  assertSameTarget("before repairing an interrupted swap");
  const swapRepair = reconcilePanelSwap(comfyPath, deps, { repair: true });
  if (!swapRepair.ok) {
    // A broken swap we could NOT put right. Proceeding would install a fresh
    // panel into the empty canonical path and report success while the user's
    // real one stayed stranded in the backup dir — and the next reconcile,
    // seeing a directory there again, would delete the journal that says where
    // it went. Refuse until a human resolves it.
    throw new PanelInstallError(
      `Panel ${action} REFUSED: a previous panel update was interrupted and could not ` +
        `be repaired automatically, so custom_nodes is in an unknown state and ` +
        `${action}ing now could strand your existing panel.${swapRepair.note ?? ""}`,
    );
  }
  if (swapRepair.note) {
    logger.info(`[panel] before ${action}:${swapRepair.note}`);
  }
  // Carried onto every result this operation returns (see PanelActionResult
  // .recoveryNote): the caller must be told their panel was repaired, not just
  // that the update they asked for finished.
  carried.note = swapRepair.note;

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
    assertSameTarget("before the ComfyUI-Manager update");
    let result: NodeOpResult | undefined;
    let managerFailure: string | undefined;
    try {
      result = await deps.update({ id: PANEL_REGISTRY_ID });
    } catch (err) {
      // Propagate only when the DISK agrees the pack is absent — and only when
      // that reading is trustworthy. A failed custom_nodes enumeration also
      // yields `installed: false` (scanReliable === false), which is "we could
      // not look", not "it is not there"; rethrowing the Manager's absence
      // claim on that basis would put the #771 contradiction straight back.
      if (!detection.installed) {
        if (detection.scanReliable === false) {
          throw new PanelInstallError(
            `Panel update could not be attempted: ComfyUI-Manager reported an error ` +
              `(${err instanceof Error ? err.message : String(err)}), and custom_nodes ` +
              `could not be enumerated to check what is actually installed, so whether ` +
              `the panel is present is UNKNOWN. NOT accepting "not installed" from a ` +
              `scan that did not run. Make ${comfyPath}/custom_nodes readable, then ` +
              `re-run install_panel(action='status').`,
          );
        }
        throw err;
      }
      managerFailure = err instanceof Error ? err.message : String(err);
      logger.warn(
        `[panel] ComfyUI-Manager could not update the panel (${managerFailure}) — the ` +
          `pack IS installed at ${detection.dir ?? "custom_nodes"}` +
          `${detection.version ? ` (${detection.version})` : ""}, so falling back to a ` +
          `direct, verified update (#771).`,
      );
    }

    if (!result) {
      // RE-READ BEFORE FALLING BACK. A thrown Manager error does not prove the
      // Manager did nothing: its post-op presence check is the thing that
      // failed, so the update itself may already have landed. Falling back on
      // the PRE-call reading would then compare the fresh clone against a stale
      // version and could swap a just-installed newer panel out for an older
      // published one — a downgrade, reported as an update.
      const afterManager = await detectPanelInstall(deps);
      const managerMoved =
        afterManager.installed &&
        !!afterManager.version &&
        // SAME PHYSICAL DIRECTORY, like every other movement proof here. A
        // before/after comparison that spans two directories is not evidence of
        // an update: if the panel re-resolved from A to B, the "previous"
        // version is A's and the "installed" version is B's, and crediting the
        // difference to the Manager would invent an update that never happened.
        !!detection.dir &&
        !!afterManager.dir &&
        samePathCI(detection.dir, afterManager.dir, deps) &&
        ((!!previousVersion && afterManager.version !== previousVersion) ||
          (!!previousRev && !!afterManager.gitRev && afterManager.gitRev !== previousRev));
      // MOVED IS NOT THE SAME AS FORWARD. The Manager can resolve the pack to
      // an older build and land it, then throw its bad presence check — and a
      // bare "the version changed" test would report that regression as an
      // update, leaving the user quietly downgraded by a message congratulating
      // them. A git-HEAD advance with an unchanged version is still a legitimate
      // nightly move, so only a READABLE, COMPARABLE regression is caught here.
      if (
        managerMoved &&
        !!previousVersion &&
        !!afterManager.version &&
        SEMVER_RE.test(previousVersion.trim()) &&
        SEMVER_RE.test(afterManager.version.trim()) &&
        compareSemver(afterManager.version, previousVersion) < 0
      ) {
        throw new PanelInstallError(
          `Panel update did NOT go forward: ComfyUI-Manager replaced the pack at ` +
            `${afterManager.dir ?? "custom_nodes"} with an OLDER version ` +
            `(${previousVersion} → ${afterManager.version}) and then errored while ` +
            `checking its own installed-pack list (${managerFailure}). NOT reporting ` +
            `this as an update — you are now on an older panel than you started with. ` +
            `Update ComfyUI-Manager on the host and retry, or restore the newer panel, ` +
            `then RESTART ComfyUI.`,
        );
      }
      if (managerMoved && afterManager.dir) {
        // It DID work; only the reporting failed. Verify it the same way every
        // other success is verified, then report the movement we observed.
        assertNoPanelShadow("update", afterManager.dir, deps);
        assertSameTarget("before reporting a verified update");
        const moved =
          `Panel updated (${previousVersion ?? "unknown"} → ${afterManager.version}), ` +
          `verified on disk at ${afterManager.dir}. ComfyUI-Manager applied the update ` +
          `but then errored while checking its own installed-pack list ` +
          `(${managerFailure}) — that check reads the Manager's registry view, not the ` +
          `disk, so it is wrong about this pack, not about the update. RESTART ComfyUI ` +
          `to load it.`;
        return {
          action: "update",
          result: {
            mechanism: "manager-http",
            message: moved,
            details: { manager_error: managerFailure },
          },
          restartRequired: true,
          message: moved,
          previousVersion,
          installedVersion: afterManager.version,
        };
      }
      // Nothing moved. Continue with the FRESH reading, so the fallback's
      // never-backwards check compares against what is on disk NOW.
      const freshVersion = afterManager.installed ? afterManager.version : undefined;
      const freshDir = afterManager.installed ? afterManager.dir : detection.dir;
      const freshRev = afterManager.installed ? afterManager.gitRev : previousRev;

      // Route to whichever direct path fits this install SHAPE — a fast-forward
      // for a checkout, a verified reinstall for a registry zip. Both prove
      // movement on disk before reporting anything.
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
        `on disk at ${freshDir ?? "custom_nodes"})`;
      if (freshRev && freshDir) {
        // Same corroboration the ZIP swap demands: a DIRECT mutation must act
        // on a tree the running server named, not merely on a configured one.
        assertSwapTreeCorroborated(deps, comfyPath, "the git fallback", managerReason);
        return updateViaGitCheckoutFallback({
          deps,
          dir: freshDir,
          previousVersion: freshVersion,
          previousRev: freshRev,
          assertSameTarget,
          // Synthesize the shape the fallback reports around; there is no real
          // Manager result because the Manager call failed.
          result: {
            mechanism: "manager-http",
            message: managerReason,
            details: { manager_error: managerFailure },
          },
        });
      }
      const swapOps = freshDir ? resolveSwapOps(deps) : undefined;
      if (freshDir && swapOps) {
        return updateViaRegistryZipReinstall({
          deps,
          ops: swapOps,
          dir: freshDir,
          comfyuiPath: comfyPath,
          previousVersion: freshVersion,
          assertSameTarget,
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
          `${freshDir ? ` at ${freshDir}` : ""}` +
          `${freshVersion ? ` (version ${freshVersion})` : ""} — whatever the ` +
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
    // A PROVEN REGRESSION SHORT-CIRCUITS EVERYTHING. It must not fall through
    // to the no-op/zip fallbacks: those would quietly re-install over the top
    // and the user would never learn that ComfyUI-Manager had just moved them
    // backwards. Surface it instead.
    if (verdict.outcome === "downgraded") {
      assertSameTarget("before reporting the update verdict");
      return finalizeUpdate(verdict, post, result); // throws, honestly
    }
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
      // Same corroboration the ZIP swap demands: a DIRECT mutation must act on
      // a tree the running server named, not merely on a configured one (#766).
      assertSwapTreeCorroborated(
        deps,
        comfyPath,
        "the git fallback",
        "ComfyUI-Manager never enqueued the update (the stale legacy 3.x silent no-op)",
      );
      return updateViaGitCheckoutFallback({
        deps,
        dir: detection.dir,
        previousVersion,
        previousRev,
        result,
        assertSameTarget,
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
        assertSameTarget,
        managerReason:
          `ComfyUI-Manager reported the queue drained without moving the pack on disk`,
      });
    }
    assertSameTarget("before reporting the update verdict");
    return finalizeUpdate(verdict, post, result);
  }

  // install / reinstall. Same final pin check as the update path above.
  assertNotPinned(action, deps);
  assertSameTarget("before the ComfyUI-Manager install");
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
  //
  // AND MOVED IS NOT FORWARD. Same rule as the update path, which decides this
  // in classifyPanelUpdate: a Manager that resolves an older build and lands it
  // would otherwise be reported as the pack having "advanced to" a version
  // BELOW the one it replaced. The one legitimate backwards move is a caller who
  // asked for that exact version — `install_custom_node(version='0.11.20')` is
  // redirected here precisely so it gets what it asked for — so an explicit
  // request is honoured, and labelled as the downgrade it is.
  const regressed =
    !!previousVersion &&
    !!post.version &&
    SEMVER_RE.test(previousVersion.trim()) &&
    SEMVER_RE.test(post.version.trim()) &&
    compareSemver(post.version, previousVersion) < 0;
  if (regressed) {
    const requested = opts.version?.trim();
    if (!requested || requested !== post.version) {
      throw new PanelInstallError(
        `Panel ${action} did NOT go forward: the pack at ${post.dir ?? "custom_nodes"} ` +
          `is now ${post.version}, which is OLDER than the ${previousVersion} that was ` +
          `installed before${
            requested ? ` (you asked for "${requested}", which is not what landed)` : ""
          }. ComfyUI-Manager resolved and applied an earlier build. NOT reporting this ` +
          `as a completed ${action} — you are now on an older panel than you started ` +
          `with. Update ComfyUI-Manager on the host and retry, or reinstall the panel ` +
          `from source, then RESTART ComfyUI.`,
      );
    }
  }

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

  assertSameTarget("before reporting the install");
  return {
    action,
    result,
    restartRequired: true,
    message:
      `Panel ${action} applied via ComfyUI-Manager: pack ${
        wasPresent
          ? regressed
            ? "was DOWNGRADED, as explicitly requested, to"
            : "advanced to"
          : "installed on disk at"
      } ${PANEL_REGISTRY_ID} ${post.version}. RESTART ComfyUI to load the panel node.`,
    previousVersion,
    installedVersion: post.version,
  };
}
