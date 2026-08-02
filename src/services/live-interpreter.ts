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

let launchRecord: { pid: number; python: string; startedAt?: string } | undefined;

/**
 * Record the exact interpreter process-control just spawned ComfyUI with, together
 * with the process's CREATION TIME. A PID alone is not a process identity: PIDs are
 * recycled, so if our child dies and an externally launched python is handed the
 * same number before our async cleanup runs, a PID-only check would hand the stale
 * interpreter to the replacement server. PID + start time is the standard identity
 * and closes that (#401 round 4). If the start time cannot be read we store none,
 * and the tier fails closed rather than trusting a bare PID match.
 */
export function recordLaunchedInterpreter(pid: number, python: string): void {
  if (!pid || !python) return;
  const startedAt = readProcessIdentity(pid)?.startedAt;
  launchRecord = { pid, python, startedAt };
  logger.info("Recorded the interpreter ComfyUI was launched with", {
    pid,
    python,
    startedAt: startedAt ?? "(unavailable)",
  });
}

/** Forget the launch record (our child exited, or a stop was requested). */
export function clearLaunchedInterpreter(): void {
  launchRecord = undefined;
}

/** Test seam / introspection. */
export function getLaunchedInterpreterRecord():
  | { pid: number; python: string; startedAt?: string }
  | undefined {
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

/** What the OS can tell us about a running process. */
export interface ProcessIdentity {
  /** Full command line, as the OS reports it. */
  commandLine?: string;
  /** Process creation time, in whatever stable form the platform provides. Only ever
   *  compared against another reading taken on the SAME platform. */
  startedAt?: string;
}

/**
 * Read a running process's command line AND creation time from the OS.
 *
 * Windows: WMI's `CommandLine`, NOT `ExecutablePath`. This distinction is the whole
 * point — for a venv, Windows reports ExecutablePath as the BASE interpreter the
 * venv trampoline loads (e.g. …\standalone-env\python.exe) while CommandLine's
 * argv[0] is the venv python (…\ComfyUI\.venv\Scripts\python.exe), which is what
 * `sys.executable` reports and whose site-packages the server actually imports.
 * Verified against a live ComfyUI Desktop instance while fixing #401.
 *
 * Linux: /proc/PID/cmdline ("\u0000"-separated argv) plus field 22 of /proc/PID/stat
 * (starttime, in clock ticks since boot). Avoids /proc/PID/exe, which resolves
 * through the venv symlink to the base interpreter.
 * macOS: `ps -o lstart=,command=`.
 */
export function readProcessIdentity(pid: number): ProcessIdentity | undefined {
  try {
    if (IS_WIN) {
      const out = execFileSync(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"; ` +
            `if ($p) { "START=" + $p.CreationDate.ToFileTimeUtc(); "CMD=" + $p.CommandLine }`,
        ],
        { encoding: "utf-8", timeout: 8000, windowsHide: true },
      );
      const startedAt = out.match(/^START=(.+)$/m)?.[1]?.trim();
      const commandLine = out.match(/^CMD=([\s\S]*)$/m)?.[1]?.trim();
      if (!startedAt && !commandLine) return undefined;
      return { commandLine: commandLine || undefined, startedAt: startedAt || undefined };
    }
    if (platform() === "linux") {
      // argv entries are "\u0000"-separated; rejoin them as a command line.
      const raw = readFileSync(`/proc/${pid}/cmdline`, "utf-8");
      const commandLine = raw.split("\u0000").filter(Boolean).join(" ").trim();
      let startedAt: string | undefined;
      try {
        const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
        // Field 2 (comm) can contain spaces and parens — parse after the LAST ')'.
        const after = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/);
        // After comm, fields run state(3)… so starttime (field 22) is index 19 here.
        startedAt = after[19];
      } catch {
        /* start time unavailable → the launched-by-us tier fails closed */
      }
      if (!commandLine && !startedAt) return undefined;
      return { commandLine: commandLine || undefined, startedAt };
    }
    const out = execFileSync("ps", ["-p", String(pid), "-o", "lstart=,command="], {
      encoding: "utf-8",
      timeout: 8000,
    }).trim();
    if (!out) return undefined;
    // `lstart` is a ctime-style stamp: "Fri Aug  1 12:00:00 2026".
    const m = out.match(/^(\w{3}\s+\w{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+([\s\S]*)$/);
    if (!m) return { commandLine: out };
    return { startedAt: m[1].replace(/\s+/g, " "), commandLine: m[2].trim() };
  } catch {
    return undefined;
  }
}

/** Back-compat helper: just argv[0] of a running process. */
export function readProcessArgv0(pid: number): string | undefined {
  const cmd = readProcessIdentity(pid)?.commandLine;
  return cmd ? argv0FromCommandLine(cmd) : undefined;
}

/**
 * Is the process we found on the port the one the SERVER told us about?
 *
 * `/system_stats.argv` is the running server's own `sys.argv` — an observation made
 * inside the process that answered OUR request. Requiring the command line of the
 * process holding the port to contain every one of those tokens correlates two
 * independent observations, instead of trusting whatever happens to hold the port.
 *
 * This defeats the concrete hazard: a python reverse proxy on 127.0.0.1:8188
 * forwarding to the real ComfyUI elsewhere is a different program with a different
 * command line, so it cannot match ComfyUI's argv — and its venv (which may well
 * lack Triton) is never mistaken for the server's. The same applies to a
 * tunnel/container-side forwarder, and to a second instance whose argv differs.
 *
 * Substring matching would absorb the quoting the OS adds around paths containing
 * spaces, but it also lets `main.py` match `proxy-main.py` and `8188` match
 * `81880` — a wrapper or neighbouring server could then pass its own venv off as
 * ComfyUI's. So matching is TOKEN-aware: the command line is split on whitespace,
 * surrounding quotes stripped, and each argv token must either equal a command-line
 * token exactly or match its final path segment (relative `main.py` vs absolute
 * `C:/ComfyUI/main.py`). Multi-word argv values (paths with spaces) fall back to a
 * full substring check, since they cannot be tokenised. Windows comparison is
 * case- and separator-insensitive.
 *
 * Residual, by design: a RELATIVE argv[0] (`ComfyUI\main.py`) can anchor to any
 * instance whose command line ends the same way, so two local installs are
 * indistinguishable here once one dies and the other grabs the port. Closing
 * that needs the process's cwd, which the restart path already correlates —
 * this correlation stays argument-only.
 */
export function commandLineMatchesArgv(
  commandLine: string | undefined,
  argv: string[] | undefined,
): boolean {
  if (!commandLine || !Array.isArray(argv) || argv.length === 0) return false;
  const norm = (s: string): string => (IS_WIN ? s.toLowerCase().replace(/\\/g, "/") : s);
  const stripQuotes = (s: string): string => s.replace(/^["']+|["']+$/g, "");
  const hay = norm(commandLine);
  const hayTokens = commandLine.split(/\s+/).map((t) => norm(stripQuotes(t)));
  const tokens = argv.filter((t): t is string => typeof t === "string" && t.trim() !== "");
  if (tokens.length === 0) return false;
  return tokens.every((t) => {
    const n = norm(stripQuotes(t.trim()));
    if (n === "") return true;
    if (n.includes(" ")) return hay.includes(n);
    // An ABSOLUTE argv path is an exact claim: it must equal a command-line
    // token, or `C:\ComfyUI\main.py` would "match" a different instance at
    // `D:\Other\ComfyUI\main.py`. Only a RELATIVE token (`main.py`) may anchor
    // to a token's final path segment.
    const absolute = n.startsWith("/") || /^[a-z]:\//.test(n);
    if (absolute) return hayTokens.some((h) => h === n);
    return hayTokens.some((h) => h === n || h.endsWith("/" + n));
  });
}

// ---------------------------------------------------------------------------
// The resolver
// ---------------------------------------------------------------------------

export interface ResolveOptions {
  /** The port the connected ComfyUI listens on. */
  port: number;
  /** The HOST we talk to. Binds the lookup to the right listener when several
   *  instances share a port across different loopback/bind addresses. */
  host?: string;
  /** True when the server is REMOTE — no local process is it, so there is no
   *  ground truth to be had and we must report nothing. */
  remote: boolean;
  /** `/system_stats.argv` — the running server's OWN sys.argv. Tier 2 requires the
   *  process holding the port to have a command line consistent with this, so a
   *  proxy or forwarder on the same port can never be mistaken for ComfyUI. Without
   *  it there is nothing to correlate against and tier 2 fails closed. */
  serverArgv?: string[];
  /** Test seams. */
  findPid?: (port: number, host?: string) => number | null;
  readIdentity?: (pid: number) => ProcessIdentity | undefined;
}

/**
 * The interpreter the running ComfyUI is ACTUALLY using, or `undefined` when we
 * cannot observe it. Never infers from install layout.
 *
 * Both tiers demand a real process IDENTITY, not just a PID:
 *  - tier 1 requires the port owner to be the process we launched — same PID AND
 *    same creation time, because PIDs get recycled and an externally launched
 *    python could otherwise inherit our record;
 *  - tier 2 requires the port owner's command line to match the argv the SERVER
 *    itself reported, so a python reverse proxy sitting on the port cannot pass its
 *    own venv off as ComfyUI's.
 * Any missing signal fails closed to `undefined` — unknown is always acceptable, a
 * confidently wrong package list is the entire bug (#401).
 */
export function resolveLiveInterpreter(opts: ResolveOptions): LiveInterpreter | undefined {
  if (opts.remote) return undefined;
  const findPid = opts.findPid ?? findPidByPort;
  const readIdentity = opts.readIdentity ?? readProcessIdentity;

  let pid: number | null = null;
  try {
    pid = findPid(opts.port, opts.host);
  } catch {
    pid = null;
  }
  if (!pid) return undefined;

  let identity: ProcessIdentity | undefined;
  try {
    identity = readIdentity(pid);
  } catch {
    identity = undefined;
  }

  // Tier 1 — the process we launched, confirmed by PID *and* start time.
  // The recorded interpreter must be ABSOLUTE: a bare `python` would be
  // re-resolved against OUR cwd/PATH at probe time, not necessarily the
  // interpreter the child actually spawned with — so a relative record fails
  // closed to tier 2.
  if (
    launchRecord &&
    launchRecord.pid === pid &&
    isAbsolute(launchRecord.python) &&
    existsSync(launchRecord.python)
  ) {
    // macOS `ps lstart` is SECOND-resolution: a PID recycled within the same
    // second compares equal. On that platform the timestamp alone is not an
    // identity, so the observed command line must also corroborate the recorded
    // interpreter; anywhere the stamp is sub-second (Linux ticks, Windows
    // FileTime) equality already is proof.
    const coarseStamp = platform() === "darwin";
    const corroborated =
      !coarseStamp ||
      commandLineMatchesArgv(identity?.commandLine, [launchRecord.python]);
    if (
      launchRecord.startedAt &&
      identity?.startedAt &&
      launchRecord.startedAt === identity.startedAt &&
      corroborated
    ) {
      return { python: launchRecord.python, source: "launched-by-us", pid };
    }
    // Same PID, different (or unreadable) start time → this is NOT our process, or
    // we cannot prove it is. Fall through to tier 2 rather than trust the record.
    logger.info("Ignoring the launch record: process identity could not be confirmed", {
      pid,
      recorded: launchRecord.startedAt ?? "(unavailable)",
      observed: identity?.startedAt ?? "(unavailable)",
    });
  }

  // Tier 2 — the OS process table, correlated against the server's own argv.
  if (!commandLineMatchesArgv(identity?.commandLine, opts.serverArgv)) return undefined;

  const argv0 = argv0FromCommandLine(identity?.commandLine ?? "");
  // A relative or bare argv[0] ("python", "./python") does not identify a file we
  // can probe — the process's cwd is not ours. Only an absolute path that exists
  // is usable; anything else is honestly unknown.
  if (argv0 && isAbsolute(argv0) && existsSync(argv0)) {
    return { python: argv0, source: "process-table", pid };
  }
  return undefined;
}
