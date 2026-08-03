/**
 * The ENVIRONMENT a restart must relaunch ComfyUI into (#776).
 *
 * `restart_comfyui` reconstructs the launch COMMAND (interpreter + argv) from the
 * running server's `/system_stats`, but until this module existed it never
 * reconstructed the launch ENVIRONMENT: `spawn()` with no `env` option inherits
 * the ORCHESTRATOR's `process.env`, which is a DIFFERENT environment from the one
 * a third-party launcher gave the server.
 *
 * That is exactly what broke #776. Stability Matrix does not put its bundled
 * tools on the system PATH — it injects them into the child it launches:
 *   • `<Data>/PortableGit/cmd`      → GitPython finds `git` (ComfyUI-Manager
 *                                     aborts with "Bad git executable" without it)
 *   • `<Data>/Assets/ffmpeg[/bin]`  → nodes that shell out to ffmpeg/ffprobe
 * Relaunching the same venv + argv WITHOUT those PATH entries produced an import
 * failure at startup, ComfyUI never answered `/system_stats`, and the restart left
 * the user's server DOWN.
 *
 * The rules here, hardest evidence first:
 *   1. LIVE PROCESS — on Linux we can read the running server's real environment
 *      (`/proc/<pid>/environ`) while it is still alive. That is the launch
 *      environment, verbatim, whatever launcher produced it. Use it.
 *   2. STABILITY MATRIX — a Stability Matrix-managed install is recognizable from
 *      its on-disk shape (`<Data>/Packages/<pkg>/…` beside `<Data>/PortableGit`
 *      and `<Data>/Assets`). Its injected environment is small, documented and
 *      VERIFIABLE on disk, so we reconstruct exactly those two PATH entries plus
 *      GIT_PYTHON_GIT_EXECUTABLE — the same recovery launch the #776 reporter
 *      verified by hand — and say so in the tool result.
 *   3. AN OPAQUE LAUNCHER — a launcher we can recognize but whose environment we
 *      canNOT reproduce (Pinokio builds it from a per-app script). We do NOT
 *      guess: the caller REFUSES *before stopping anything*, because a refusal is
 *      always better than a stop we cannot undo.
 *   4. PLAIN INSTALL — no launcher marker at all (a terminal / .bat / venv
 *      launch). Inheriting our environment is the long-standing behavior and the
 *      one these installs were already restarted with successfully; nothing is
 *      known to be missing, so nothing is reconstructed.
 *
 * Everything here is filesystem-evidence based: no shape is ever ASSUMED, and a
 * marker that cannot be corroborated on disk downgrades to a refusal, never to a
 * guess.
 */

import { existsSync, readFileSync } from "node:fs";
import { delimiter } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Where the relaunch environment came from — reported to the caller. */
export type LaunchEnvSource =
  /** Read from the LIVE process while it was still running (Linux /proc). */
  | "live-process"
  /** Reconstructed from a Stability Matrix install detected on disk. */
  | "stability-matrix"
  /** No launcher marker — the child inherits this process's environment. */
  | "inherited";

/** The launch-environment facts surfaced in the start/restart tool result. */
export interface LaunchEnvInfo {
  source: LaunchEnvSource;
  /** One-line human summary, safe to append to a tool message. */
  note: string;
  /**
   * FALSE when the server's real launch environment is known to be
   * launcher-owned and could NOT be rebuilt — the relaunch would be degraded.
   * The pre-stop preflight turns this into a refusal; a server that is ALREADY
   * down only gets a warning (see `reason`/`advice`).
   */
  reproducible: boolean;
  /** Directories prepended to PATH (empty/absent when nothing was injected). */
  path_additions?: string[];
  /** The recognized launcher, when one was recognized. */
  launcher?: string;
}

export interface LaunchEnvResolution {
  /** Mirrors `info.reproducible` — the single gate the callers branch on. */
  reproducible: boolean;
  /**
   * The environment to hand to `spawn()`. `undefined` means "pass no `env`
   * option" — i.e. inherit this process's environment verbatim, unchanged from
   * the behavior that predates #776. Always `undefined` when
   * `reproducible` is false: we never fabricate a launcher environment.
   */
  env?: NodeJS.ProcessEnv;
  info: LaunchEnvInfo;
  /** Set only when NOT reproducible: why the environment cannot be rebuilt. */
  reason?: string;
  /** Set only when NOT reproducible: what the user should do instead. */
  advice?: string;
}

export interface StabilityMatrixLayout {
  /** The Stability Matrix `Data` root (parent of `Packages`). */
  dataRoot: string;
  /** `<Data>/PortableGit/cmd` (or `/bin`) — absent when not on disk. */
  gitDir?: string;
  /** The git binary inside `gitDir` — absent when not on disk. */
  gitExe?: string;
  /** `<Data>/Assets/ffmpeg[/bin]` — absent when not on disk. */
  ffmpegDir?: string;
  /** Whether `<Data>/Assets/ffmpeg` itself exists (drives the refusal wording:
   *  "present but unreadable" vs "not there at all" — both irreproducible). */
  ffmpegRootExists: boolean;
}

// ---------------------------------------------------------------------------
// Separator-agnostic path helpers
//
// The paths we inspect come from the running ComfyUI's sys.argv, which is
// WINDOWS-flavored whenever ComfyUI runs on Windows — regardless of the host this
// orchestrator process runs on. node:path would mangle `C:\…` on POSIX, so parse
// with an explicit both-separators split and re-join with the separator the input
// itself used (the same approach resolveLaunchCommand already takes).
// ---------------------------------------------------------------------------

function separatorOf(p: string): string {
  return p.includes("\\") ? "\\" : "/";
}

function segmentsOf(p: string): string[] {
  return p.split(/[\\/]/);
}

function basenameOf(p: string): string {
  const segs = segmentsOf(p).filter((s) => s !== "");
  return segs.length > 0 ? segs[segs.length - 1] : p;
}

/**
 * Ancestor directories of `p`, NEAREST first. The filesystem root itself is
 * skipped (nothing useful is ever detected there).
 */
function ancestorsOf(p: string): string[] {
  const sep = separatorOf(p);
  const segs = segmentsOf(p);
  const out: string[] = [];
  for (let i = segs.length - 1; i >= 1; i--) {
    const joined = segs.slice(0, i).join(sep);
    if (joined === "") continue; // POSIX root — nothing to detect there
    out.push(joined);
  }
  return out;
}

function joinPath(base: string, ...parts: string[]): string {
  const sep = separatorOf(base);
  return [base.replace(/[\\/]+$/, ""), ...parts].join(sep);
}

/** existsSync that can never throw (a bad path must read as "absent"). */
function pathExists(p: string): boolean {
  try {
    return existsSync(p);
  } catch {
    return false;
  }
}

function firstExisting(candidates: string[]): string | undefined {
  for (const c of candidates) {
    if (pathExists(c)) return c;
  }
  return undefined;
}

/** The directory holding `p` (its nearest ancestor). */
function dirOf(p: string): string | undefined {
  return ancestorsOf(p)[0];
}

// ---------------------------------------------------------------------------
// Stability Matrix detection
// ---------------------------------------------------------------------------

/**
 * Recognize a Stability Matrix-managed install from the paths involved in the
 * relaunch (script, interpreter, cwd, raw argv[0]).
 *
 * Stability Matrix keeps every package under `<Data>/Packages/<PackageName>` and
 * its shared tooling as siblings of `Packages` (`<Data>/PortableGit`,
 * `<Data>/Assets`). So: find an ancestor literally named `Packages` whose parent
 * ACTUALLY HOLDS one of those tooling directories on disk.
 *
 * The tooling directory is REQUIRED corroboration, never inferred from a name: a
 * perfectly ordinary install that happens to live under some `…/Data/Packages/…`
 * path must NOT be mistaken for a Stability Matrix one, because that
 * misclassification would refuse a restart that works today.
 */
export function detectStabilityMatrix(
  paths: ReadonlyArray<string | undefined>,
): StabilityMatrixLayout | null {
  for (const p of paths) {
    if (!p) continue;
    for (const ancestor of ancestorsOf(p)) {
      if (basenameOf(ancestor).toLowerCase() !== "packages") continue;
      const dataRoot = dirOf(ancestor);
      if (!dataRoot) continue;
      const gitRoot = joinPath(dataRoot, "PortableGit");
      const ffmpegRoot = joinPath(dataRoot, "Assets", "ffmpeg");
      const hasGitRoot = pathExists(gitRoot);
      const hasFfmpegRoot = pathExists(ffmpegRoot);
      // No Stability Matrix tooling beside `Packages` → not a Stability Matrix
      // install (or one with nothing to inject). Either way there is nothing to
      // reconstruct, so fall through to the ordinary inherit path.
      if (!hasGitRoot && !hasFfmpegRoot) continue;

      const gitExe = firstExisting([
        joinPath(gitRoot, "cmd", "git.exe"),
        joinPath(gitRoot, "cmd", "git"),
        joinPath(gitRoot, "bin", "git.exe"),
        joinPath(gitRoot, "bin", "git"),
      ]);
      const ffmpegExe = firstExisting([
        joinPath(ffmpegRoot, "bin", "ffmpeg.exe"),
        joinPath(ffmpegRoot, "bin", "ffmpeg"),
        joinPath(ffmpegRoot, "ffmpeg.exe"),
        joinPath(ffmpegRoot, "ffmpeg"),
      ]);
      return {
        dataRoot,
        gitExe,
        gitDir: gitExe ? dirOf(gitExe) : undefined,
        ffmpegDir: ffmpegExe ? dirOf(ffmpegExe) : undefined,
        ffmpegRootExists: hasFfmpegRoot,
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Opaque launchers — recognized, but NOT reproducible
// ---------------------------------------------------------------------------

/**
 * Launchers that own the server's environment in a way we cannot rebuild from
 * disk. Pinokio composes each app's environment in a per-app JS install script
 * (its own conda/git/ffmpeg shims, per-app venvs, arbitrary exports); nothing on
 * disk tells us what the running process actually got. Relaunching such a server
 * with OUR environment is precisely the #776 failure mode, so these refuse.
 */
const OPAQUE_LAUNCHER_DIRS: ReadonlyArray<{
  dir: string;
  name: string;
  /** ALL of these must exist under the root — name alone is never proof. */
  requireDirs: string[];
  /** The install must live under this subdirectory of the root. */
  requireInstallUnder: string;
}> = [
  // A Pinokio home holds BOTH `api/` (the installed apps) and `bin/` (its shims),
  // and every app it manages lives under `<root>/api/…`.
  {
    dir: "pinokio",
    name: "Pinokio",
    requireDirs: ["api", "bin"],
    requireInstallUnder: "api",
  },
];

/** Is `child` inside `parent`? Separator- and (Windows-)case-insensitive. */
function isUnder(child: string, parent: string): boolean {
  const norm = (s: string): string[] =>
    segmentsOf(s)
      .filter((seg) => seg !== "")
      .map((seg) => seg.toLowerCase());
  const c = norm(child);
  const p = norm(parent);
  if (p.length === 0 || c.length <= p.length) return false;
  return p.every((seg, i) => c[i] === seg);
}

/**
 * A recognized launcher whose environment we cannot rebuild.
 *
 * A refusal here BLOCKS a restart, so the evidence bar is deliberately higher than
 * for Stability Matrix (whose detection only unlocks a reconstruction): a
 * false positive costs the user a restart that would have worked. A directory
 * merely NAMED `pinokio`, or one that merely happens to contain a `bin`, is not
 * enough (coordinator gate). We require three independent signals: the named root,
 * ALL of the launcher's own top-level directories, and the install actually
 * sitting inside the subtree the launcher keeps its apps in.
 */
export function detectOpaqueLauncher(
  paths: ReadonlyArray<string | undefined>,
): { name: string; root: string } | null {
  for (const p of paths) {
    if (!p) continue;
    for (const ancestor of ancestorsOf(p)) {
      const base = basenameOf(ancestor).toLowerCase();
      const hit = OPAQUE_LAUNCHER_DIRS.find((l) => l.dir === base);
      if (!hit) continue;
      if (!hit.requireDirs.every((d) => pathExists(joinPath(ancestor, d)))) continue;
      if (!isUnder(p, joinPath(ancestor, hit.requireInstallUnder))) continue;
      return { name: hit.name, root: ancestor };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Live process environment (Linux)
// ---------------------------------------------------------------------------

/**
 * The RUNNING server's own environment, read from `/proc/<pid>/environ`.
 *
 * This is the launch environment verbatim — whatever launcher produced it — so it
 * is the best possible answer when it is available. It MUST be read while the
 * process is still alive (the whole `/proc/<pid>` tree vanishes the instant the
 * stop kills the pid), which is why the caller captures it at gather-time next to
 * the live cwd (#535). Linux only; every other platform has no supported way to
 * read another process's environment block, and we do not guess.
 */
export function readLiveProcessEnv(pid: number): NodeJS.ProcessEnv | undefined {
  if (!pid || pid <= 0 || process.platform !== "linux") return undefined;
  try {
    // /proc/<pid>/environ is a NUL-separated KEY=VALUE list. Build the separator
    // from a char code rather than writing a raw control byte into this file.
    const NUL = String.fromCharCode(0);
    const raw = readFileSync(`/proc/${pid}/environ`, "utf-8");
    const env: NodeJS.ProcessEnv = {};
    let count = 0;
    for (const entry of raw.split(NUL)) {
      if (entry === "") continue;
      const eq = entry.indexOf("=");
      if (eq <= 0) continue;
      env[entry.slice(0, eq)] = entry.slice(eq + 1);
      count++;
    }
    // An empty read tells us nothing (permission-trimmed / raced) — treat it as
    // "unknown" rather than relaunching into a blank environment.
    return count > 0 ? env : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Environment construction
// ---------------------------------------------------------------------------

/**
 * Find an env key case-insensitively. Windows environment blocks are
 * case-insensitive and Node's `process.env` emulates that, but a plain object
 * copy does NOT — writing a fresh "PATH" next to an inherited "Path" would hand
 * the child two competing PATHs.
 */
function findEnvKey(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === wanted) return key;
  }
  return undefined;
}

function pathAlreadyContains(current: string, dir: string): boolean {
  const target = dir.replace(/[\\/]+$/, "").toLowerCase();
  return current
    .split(delimiter)
    .some((part) => part.trim().replace(/[\\/]+$/, "").toLowerCase() === target);
}

/**
 * Copy `base` and PREPEND `additions` to its PATH (creating PATH if absent),
 * skipping entries already present. Prepending — not appending — is what the
 * launcher itself does, and it is what makes the bundled git/ffmpeg win over any
 * different copy the orchestrator happens to have.
 */
function withPathAdditions(
  base: NodeJS.ProcessEnv,
  additions: string[],
): { env: NodeJS.ProcessEnv; added: string[] } {
  const env: NodeJS.ProcessEnv = { ...base };
  const pathKey = findEnvKey(env, "PATH") ?? "PATH";
  const current = env[pathKey] ?? "";
  const added: string[] = [];
  for (const dir of additions) {
    if (!dir || pathAlreadyContains(current, dir) || added.includes(dir)) continue;
    added.push(dir);
  }
  if (added.length > 0) {
    env[pathKey] = current
      ? [...added, current].join(delimiter)
      : added.join(delimiter);
  }
  return { env, added };
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export interface LaunchEnvInput {
  /** Paths involved in the relaunch: script, interpreter, cwd, raw argv[0]. */
  paths: ReadonlyArray<string | undefined>;
  /** The live process's own environment, if it could be captured. */
  liveEnv?: NodeJS.ProcessEnv;
  /** Injectable base environment (defaults to this process's). */
  baseEnv?: NodeJS.ProcessEnv;
}

/**
 * Decide what environment a relaunch should use, and whether that environment is
 * actually REPRODUCIBLE.
 *
 * `reproducible:false` is a hard STOP for a caller that is about to KILL a healthy
 * server: it must refuse BEFORE the server is touched, never after (#776 cardinal
 * rule — a refusal costs a restart, a bad relaunch costs the server). A caller
 * whose server is ALREADY down must NOT refuse: keeping it down is the one
 * outcome worse than a possibly-degraded launch, so it launches with the best
 * environment available and warns.
 */
export function resolveLaunchEnvironment(
  input: LaunchEnvInput,
): LaunchEnvResolution {
  const baseEnv = input.baseEnv ?? process.env;

  // 1. The live process's REAL environment beats every inference.
  if (input.liveEnv && Object.keys(input.liveEnv).length > 0) {
    return {
      reproducible: true,
      env: { ...input.liveEnv },
      info: {
        source: "live-process",
        reproducible: true,
        note:
          "relaunched with the environment captured from the running ComfyUI " +
          "process itself (read live before the stop)",
      },
    };
  }

  // 2. Stability Matrix — reconstruct exactly what it injects, from disk.
  const sm = detectStabilityMatrix(input.paths);
  if (sm) {
    // PARTIAL reconstruction is NOT reconstruction. Detection above only fires when
    // Stability Matrix tooling actually exists beside `Packages`, so this IS a
    // launcher-owned install — and EVERY component it is known to inject must be
    // resolvable before we may call the environment reproducible.
    //
    // Crucially, "the directory isn't there" does NOT license us to skip a
    // component: from here we cannot tell "the user never installed FFmpeg" (so
    // the launcher injects nothing) apart from "the assets live somewhere we do
    // not know how to look" (so the launcher injects something we would drop). The
    // #776 lesson is that dropping the second case costs the user their server, so
    // an unresolvable component ALWAYS refuses (coordinator gate P1(1)) — the
    // wording just distinguishes the two shapes for the human reading it.
    const missing: string[] = [];
    if (!sm.gitExe) {
      missing.push(
        `its bundled Git (looked under "${joinPath(sm.dataRoot, "PortableGit")}") — ` +
          "without it ComfyUI-Manager aborts at import with \"Bad git executable\"",
      );
    }
    if (!sm.ffmpegDir) {
      const ffmpegRoot = joinPath(sm.dataRoot, "Assets", "ffmpeg");
      missing.push(
        sm.ffmpegRootExists
          ? `its bundled FFmpeg (found "${ffmpegRoot}" but no ffmpeg binary inside it)`
          : `its bundled FFmpeg ("${ffmpegRoot}" does not exist, so we cannot tell whether ` +
            "this install has no FFmpeg or keeps it somewhere we do not know to look)",
      );
    }
    if (missing.length > 0) {
      return {
        reproducible: false,
        info: {
          source: "inherited",
          reproducible: false,
          launcher: "Stability Matrix",
          note:
            "Stability Matrix install detected, but part of the tooling it injects could " +
            "not be located on disk — the launcher environment could NOT be reproduced",
        },
        reason:
          `This ComfyUI is managed by Stability Matrix (${sm.dataRoot}), which launches it ` +
          `with its own bundled tooling on PATH, but this could not be located: ${missing.join("; ")}. ` +
          "That environment cannot be reproduced here.",
        advice:
          "Restart ComfyUI from Stability Matrix itself so it comes back with the " +
          "environment its packages expect.",
      };
    }
    // Both components are guaranteed resolved here — anything less refused above.
    const { env, added } = withPathAdditions(baseEnv, [sm.gitDir!, sm.ffmpegDir!]);
    // GitPython (ComfyUI-Manager) resolves `git` through this variable first;
    // Stability Matrix sets it, and without it Manager aborts at import with
    // "Bad git executable" even when PATH is right (#776). Guaranteed present —
    // a missing git refused above.
    const gitKey =
      findEnvKey(env, "GIT_PYTHON_GIT_EXECUTABLE") ?? "GIT_PYTHON_GIT_EXECUTABLE";
    env[gitKey] = sm.gitExe!;
    return {
      reproducible: true,
      env,
      info: {
        source: "stability-matrix",
        reproducible: true,
        launcher: "Stability Matrix",
        path_additions: added,
        note:
          `Stability Matrix install detected (${sm.dataRoot}) — relaunched with its ` +
          "PortableGit + FFmpeg on PATH and GIT_PYTHON_GIT_EXECUTABLE set, " +
          "so ComfyUI-Manager and ffmpeg-dependent nodes keep working",
      },
    };
  }

  // 3. A launcher we recognize but cannot reproduce — refuse before stopping.
  const opaque = detectOpaqueLauncher(input.paths);
  if (opaque) {
    return {
      reproducible: false,
      info: {
        source: "inherited",
        reproducible: false,
        launcher: opaque.name,
        note:
          `${opaque.name} builds this server's environment at launch time — it could ` +
          "NOT be reproduced here",
      },
      reason:
        `This ComfyUI is launched by ${opaque.name} (${opaque.root}), which builds the ` +
        "server's environment (its own git/ffmpeg/python shims and exports) at launch " +
        "time. That environment cannot be read from a process we did not start, so a " +
        "relaunch from here would come back missing it.",
      advice:
        `Restart ComfyUI from ${opaque.name} itself so it comes back with the ` +
        "environment it was launched with.",
    };
  }

  // 4. Plain install — inherit, exactly as before #776.
  return {
    reproducible: true,
    info: {
      source: "inherited",
      reproducible: true,
      note: "relaunched with this process's environment (no launcher-owned environment detected)",
    },
  };
}
