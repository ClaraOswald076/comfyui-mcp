// GROUND TRUTH for "which python is the running ComfyUI actually using?" (#401).
//
// Everything else in this codebase INFERS the answer from install layout: look for
// a .venv under a root we believe in, prefer this candidate over that one, then
// cross-check a version. That inference is what produced the bug this module exists
// to end — a confident "Triton: not installed" read off the wrong interpreter, which
// made an agent strip working acceleration from a user's workflow.
//
// Inference cannot be hardened into proof. Two cloned venvs under one root, a conda
// env we don't even enumerate, a server launched with an interpreter from somewhere
// else entirely — no amount of layout heuristics or version/torch "fingerprints"
// distinguishes those, because none of them observe the process. So this module
// only reports an interpreter when something OBSERVED it:
//
//   1. WE LAUNCHED IT — process-control spawned ComfyUI and recorded the exact
//      interpreter it used. Not a guess: we chose that path.
//   2. THE OS TELLS US — the server is a local process listening on our port, and
//      the OS process table reports the command line it was started with. argv[0]
//      of a running python IS its interpreter.
//
// Anything else is `undefined`, and callers must degrade to UNKNOWN rather than
// report a package as absent. NOTE for future maintainers: ComfyUI does NOT expose
// `sys.executable` over HTTP (verified on 0.29.2 — /system_stats reports
// `embedded_python`, a BOOLEAN derived from sys.executable that throws the path
// away). If a future ComfyUI adds it, that becomes the best source of all and
// should be added here as tier 0 — it works for remote servers too.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { platform } from "node:os";
import { findPidByPort } from "./port-owner.js";
import { logger } from "./../utils/logger.js";

const IS_WIN = platform() === "win32";

/** How we came to know the interpreter — surfaced to users so "we know" reads
 *  differently from "we're guessing". */
export type InterpreterSource = "launched-by-us" | "process-table";

export interface LiveInterpreter {
  /** Absolute path to the interpreter the running server is using. */
  python: string;
  source: InterpreterSource;
  /** PID of the server process this was established for. */
  pid: number;
}

// ---------------------------------------------------------------------------
// Tier 1 — the interpreter WE launched ComfyUI with
// ---------------------------------------------------------------------------

let launchRecord: { pid: number; python: string } | undefined;

/**
 * Record the exact interpreter process-control just spawned ComfyUI with. Keyed by
 * PID so it can be VALIDATED later: if the port is owned by a different process,
 * ours died and something else took over, and the record must not be used.
 */
export function recordLaunchedInterpreter(pid: number, python: string): void {
  if (!pid || !python) return;
  launchRecord = { pid, python };
  logger.info("Recorded the interpreter ComfyUI was launched with", { pid, python });
}

/** Forget the launch record (our child exited, or a stop was requested). */
export function clearLaunchedInterpreter(): void {
  launchRecord = undefined;
}

/** Test seam / introspection. */
export function getLaunchedInterpreterRecord(): { pid: number; python: string } | undefined {
  return launchRecord;
}

// ---------------------------------------------------------------------------
// Tier 2 — the OS process table
// ---------------------------------------------------------------------------

/**
 * Split a command line into argv, honoring double-quoted paths. Windows launchers
 * routinely quote the interpreter ("C:\Program Files\...\python.exe"), and a naive
 * whitespace split would truncate it at the space.
 */
export function argv0FromCommandLine(cmdline: string): string | undefined {
  const s = cmdline.trim();
  if (!s) return undefined;
  if (s.startsWith('"')) {
    const end = s.indexOf('"', 1);
    return end > 1 ? s.slice(1, end) : undefined;
  }
  const m = s.match(/^\S+/);
  return m ? m[0] : undefined;
}

/**
 * Read argv[0] of a running process from the OS.
 *
 * Windows: WMI's `CommandLine`, NOT `ExecutablePath`. This distinction is the whole
 * point — for a venv, Windows reports ExecutablePath as the BASE interpreter the
 * venv trampoline loads (e.g. …\standalone-env\python.exe) while CommandLine's
 * argv[0] is the venv python (…\ComfyUI\.venv\Scripts\python.exe), which is what
 * `sys.executable` reports and whose site-packages the server actually imports.
 * Verified against a live ComfyUI Desktop instance while fixing #401.
 *
 * Linux: /proc/PID/cmdline (NUL-separated argv). Also avoids /proc/PID/exe, which
 * resolves through the venv symlink to the base interpreter.
 * macOS: `ps -o command=`.
 */
export function readProcessArgv0(pid: number): string | undefined {
  try {
    if (IS_WIN) {
      const out = execFileSync(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CommandLine`,
        ],
        { encoding: "utf-8", timeout: 8000, windowsHide: true },
      );
      return argv0FromCommandLine(out);
    }
    if (platform() === "linux") {
      // argv entries are NUL-separated; the first is argv[0].
      const raw = readFileSync(`/proc/${pid}/cmdline`, "utf-8");
      const first = raw.split("\u0000")[0];
      return first && first.trim() ? first.trim() : undefined;
    }
    const out = execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf-8",
      timeout: 8000,
    });
    return argv0FromCommandLine(out);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// The resolver
// ---------------------------------------------------------------------------

export interface ResolveOptions {
  /** The port the connected ComfyUI listens on. */
  port: number;
  /** True when the server is REMOTE — no local process is it, so there is no
   *  ground truth to be had and we must report nothing. */
  remote: boolean;
  /** Test seams. */
  findPid?: (port: number) => number | null;
  readArgv0?: (pid: number) => string | undefined;
}

/**
 * The interpreter the running ComfyUI is ACTUALLY using, or `undefined` when we
 * cannot observe it. Never infers from install layout.
 *
 * The launch record is only honored when the port is still owned by the PID we
 * launched — otherwise our child died and a different server took the port, and
 * reporting our old interpreter for it would be exactly the class of confident
 * wrong answer this module exists to prevent.
 */
export function resolveLiveInterpreter(opts: ResolveOptions): LiveInterpreter | undefined {
  if (opts.remote) return undefined;
  const findPid = opts.findPid ?? findPidByPort;
  const readArgv0 = opts.readArgv0 ?? readProcessArgv0;

  let pid: number | null = null;
  try {
    pid = findPid(opts.port);
  } catch {
    pid = null;
  }
  if (!pid) return undefined;

  if (launchRecord && launchRecord.pid === pid && existsSync(launchRecord.python)) {
    return { python: launchRecord.python, source: "launched-by-us", pid };
  }

  const argv0 = readArgv0(pid);
  // A relative or bare argv[0] ("python", "./python") does not identify a file we
  // can probe — the process's cwd is not ours. Only an absolute path that exists
  // is usable; anything else is honestly unknown.
  if (argv0 && isAbsolute(argv0) && existsSync(argv0)) {
    return { python: argv0, source: "process-table", pid };
  }
  return undefined;
}
