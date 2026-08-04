// Who owns the healthy listener after a launch? (#776)
//
// This module exists to make one invariant UNFORGEABLE rather than merely
// documented: a definite verdict — `ours` or `not-ours` — may only be produced by
// the code that actually gathered the evidence for it. The same defect kept
// reappearing on new paths (#796): an early return naming a definite answer it had
// no basis for. A comment could not stop that; a type can.
//
// `ListenerOwnership` is a branded string. The values serialise and compare as
// ordinary `"ours"` / `"not-ours"` / `"unconfirmed"`, but the type carries a
// phantom property no literal satisfies, and the only cast that mints one lives in
// `classified()` — which is private to this file and used solely inside
// `classifyListenerOwnership`. Callers get exactly two ways to obtain a value:
// classify (and earn a verdict), or `unclassifiedOwnership()` (and admit you did
// not). Living in its own module is the point: in a 2600-line file the cast was
// reachable by any future early return, which made the guarantee "that file's
// discipline" rather than the compiler's.

import type { ChildProcess } from "node:child_process";
import { commandLineMatchesArgv, type ProcessIdentity } from "./live-interpreter.js";

declare const CLASSIFIED: unique symbol;

export type ListenerOwnership = ("ours" | "not-ours" | "unconfirmed") & {
  readonly [CLASSIFIED]: true;
};

/** Mint a verdict. PRIVATE — the whole point of the module boundary. */
function classified(
  verdict: "ours" | "not-ours" | "unconfirmed",
): ListenerOwnership {
  return verdict as ListenerOwnership;
}

/** The only verdict a caller that did NOT classify is entitled to return. */
export function unclassifiedOwnership(): ListenerOwnership {
  return "unconfirmed" as ListenerOwnership;
}

// ---------------------------------------------------------------------------
// Path tokens
// ---------------------------------------------------------------------------

/**
 * A token's path dialect, decided from ROOTING rather than from the presence of a
 * separator character.
 *
 * Backslash is a legal filename character on POSIX, so "contains a backslash"
 * cannot mean "Windows": under that rule `/srv/Comfy\A` and `/srv/comfy\a` — two
 * different installs — normalised identically and case-folded into a false MATCH,
 * which is the direction that licenses stopping somebody else's process.
 *
 *   "win-rooted"  — a drive (`C:\`, `C:/`) or UNC (`\\host\share`) root. Windows
 *                   for certain: separators are interchangeable, case is not
 *                   significant.
 *   "win-relative"— backslashes and NO forward slash, e.g. `ComfyUI\main.py`. This
 *                   is how a Windows-launched ComfyUI reports `sys.argv[0]`, but it
 *                   is also a legal POSIX filename, so separators are normalised
 *                   and case is NOT folded on this evidence alone.
 *   "drive-relative" — `C:ComfyUI\main.py`, which resolves against that drive's
 *                   own working directory. Two processes can resolve the same text
 *                   to DIFFERENT installs, so it is not comparable at all.
 *   "posix"       — everything else. Case-sensitive, backslashes literal.
 */
type Dialect = "win-rooted" | "win-relative" | "drive-relative" | "posix";

function dialectOf(token: string): Dialect {
  if (/^[a-zA-Z]:[\\/]/.test(token) || /^\\\\/.test(token)) return "win-rooted";
  if (/^[a-zA-Z]:[^\\/]/.test(token)) return "drive-relative";
  if (token.includes("\\") && !token.includes("/")) return "win-relative";
  return "posix";
}

interface PathToken {
  text: string;
  /** Case may be folded when comparing against another token. */
  foldable: boolean;
  /** The text cannot be resolved to a location at all (drive-relative). */
  unresolvable: boolean;
}

function prepareToken(raw: string): PathToken {
  const trimmed = raw.trim().replace(/^["']+|["']+$/g, "");
  const dialect = dialectOf(trimmed);
  if (dialect === "drive-relative") {
    return { text: trimmed, foldable: false, unresolvable: true };
  }
  // Separators are only interchangeable in a Windows dialect. On POSIX a backslash
  // is part of the name and must stay.
  const windows = dialect === "win-rooted" || dialect === "win-relative";
  let t = windows ? trimmed.replace(/\\/g, "/") : trimmed;
  // Extended-length and UNC prefixes denote the same locations as their plain
  // spellings.
  t = t.replace(/^\/\/\?\/unc\//i, "//").replace(/^\/\/\?\//, "");
  if (t.includes("/")) {
    const drive = /^([a-zA-Z]:)(?=\/)/.exec(t)?.[1] ?? "";
    const rooted = t.startsWith("/") || drive !== "";
    const body = t.slice(drive.length);
    const out: string[] = [];
    for (const seg of body.split("/")) {
      if (seg === "" || seg === ".") continue;
      if (seg === "..") {
        if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
        // At a ROOT, `..` has nowhere to go — the OS clamps it, so we must too,
        // or `/../ComfyUI` and `/ComfyUI` (the same directory) read as different.
        else if (!rooted) out.push("..");
        continue;
      }
      out.push(seg);
    }
    t = `${drive}${rooted ? "/" : ""}${out.join("/")}`;
  }
  return { text: t, foldable: dialect === "win-rooted", unresolvable: false };
}

/**
 * Do two argv tokens denote the same thing?
 *
 * Case is folded ONLY when a side is rooted in a Windows path (that filesystem is
 * case-insensitive); everywhere else the comparison is exact, because a spurious
 * equality here can promote a listener to `ours`. Paths compare SEGMENT-ALIGNED —
 * one may be a suffix of the other — since we launch the script by absolute path
 * while the server reports the relative one it was handed.
 */
function tokensAgree(a: PathToken, b: PathToken): boolean {
  if (a.unresolvable || b.unresolvable) return false;
  const fold = a.foldable || b.foldable;
  const x = fold ? a.text.toLowerCase() : a.text;
  const y = fold ? b.text.toLowerCase() : b.text;
  if (x === y) return true;
  const pathish = (s: string): boolean => /\//.test(s) || /^[a-zA-Z]:/.test(s);
  if (!pathish(x) || !pathish(y)) return false;
  return x.endsWith(`/${y}`) || y.endsWith(`/${x}`);
}

// ---------------------------------------------------------------------------
// Liveness and lineage
// ---------------------------------------------------------------------------

/**
 * Is the process we spawned still alive? Tri-state, because only a DEFINITE answer
 * may change a verdict.
 *
 *   false     — an exit was recorded, or a signal-0 probe says ESRCH: it is gone.
 *   undefined — no pid to probe, or EPERM (something holds that number but it is
 *               not ours to signal). "Cannot tell", never "alive" and never "dead".
 *   true      — the pid exists and is signalable. Necessary, NOT sufficient: a
 *               recycled number passes too, which is why lineage is also required.
 */
export function launchedChildStillRunning(
  child: ChildProcess,
  kill: (pid: number, signal: 0) => void = (pid, signal) => {
    process.kill(pid, signal);
  },
): boolean | undefined {
  const pid = child.pid;
  if (pid == null) return undefined;
  // Loose null check: a not-yet-exited child reports `null`, and an absent
  // property must read the same way rather than as "already exited".
  if (child.exitCode != null || child.signalCode != null) return false;
  try {
    kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ESRCH" ? false : undefined;
  }
}

/**
 * Is `pid` THIS CALL'S CHILD, or a descendant of it?
 *
 * Traced to `childPid`, deliberately NOT to the orchestrator. Ancestry under the
 * long-lived MCP process proves almost nothing: a stale ComfyUI from an EARLIER
 * request is also descended from it, has identical argv, and may still hold the
 * port — so tracing to the orchestrator would report that sibling as `ours` and
 * announce a restart that never happened, while the child we just spawned may have
 * died on a bind failure. Only lineage through this launch's own child answers the
 * question actually being asked.
 *
 * `undefined` the moment the chain becomes unreadable, and on budget exhaustion:
 * running out of hops is "did not finish looking", not a negative answer.
 */
export function isDescendantOfChild(
  pid: number,
  childPid: number,
  readParentPid: (pid: number) => number | undefined,
  maxHops = 8,
): boolean | undefined {
  let current = pid;
  for (let hop = 0; hop < maxHops; hop++) {
    if (current === childPid) return true;
    const parent = readParentPid(current);
    if (parent == null) return undefined;
    // Reached the top of the tree without passing through our child.
    if (parent === current || parent <= 1) return false;
    current = parent;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// The classifier
// ---------------------------------------------------------------------------

export interface OwnershipEvidence {
  isDesktopApp: boolean;
  /** The child's `exit` event has already been delivered. */
  childExited: boolean;
  /** The child's `error` event has been delivered — the spawn FAILED. */
  spawnFailed: boolean;
  child: ChildProcess;
  /** The exact (interpreter + args) we launched. */
  launchArgv?: string[];
  /** The pid holding the port after readiness, or null when unmappable. */
  portOwnerPid: number | null;
  /** `sys.argv` as reported by whatever server is now answering. */
  servingArgv?: string[];
  readParentPid: (pid: number) => number | undefined;
  readIdentity: (pid: number) => ProcessIdentity | undefined;
  childIsAlive?: boolean | undefined;
}

export function classifyListenerOwnership(
  input: OwnershipEvidence,
): ListenerOwnership {
  /**
   * Does the server that is answering run what we launched?
   *
   * ASYMMETRIC by design. A MISMATCH is proof of the negative — nobody else's
   * command line is ours. A match is only CORROBORATION: another supervisor can
   * start the very same command, win the bind race, and answer identically, so it
   * may never promote anything to `ours`. And `unknown` is neither: it is the
   * absence of a comparison, and must not be spent as either.
   */
  const byArgv = (): "match" | "differ" | "unknown" => {
    if (!input.servingArgv?.length || !input.launchArgv?.length) return "unknown";
    // The interpreter is dropped from our side: the server reports `sys.argv`,
    // which never contains it. Order is preserved on both sides (a relaunch passes
    // the same arguments in the same order), so compare positionally, and require
    // the same COUNT so a foreign subset cannot pass as a match.
    const ours = input.launchArgv.slice(1).map(prepareToken).filter((t) => t.text);
    const serving = input.servingArgv.map(prepareToken).filter((t) => t.text);
    if (ours.length === 0 || serving.length === 0) return "unknown";
    // A drive-relative token resolves against a per-drive working directory we do
    // not know, so identical text can denote different installs. Not comparable.
    if (ours.some((t) => t.unresolvable) || serving.some((t) => t.unresolvable)) {
      return "unknown";
    }
    const same =
      ours.length === serving.length &&
      ours.every((token, i) => tokensAgree(token, serving[i]));
    return same ? "match" : "differ";
  };

  // A LAUNCH THAT NEVER HAPPENED is decisive on every path, Desktop included, so
  // these come first and no later shortcut can soften them. The spawn error is
  // latched independently of the readiness race, and Node leaves `pid` undefined
  // only when the spawn did not happen — the same fact by two routes.
  if (input.spawnFailed) return classified("not-ours");
  if (input.child.pid == null) return classified("not-ours");
  // A Desktop launch is undecidable BY DESIGN once it HAS started: we spawn the
  // Electron shell (or macOS `open`, which exits immediately by design) and its
  // child binds the port. Sits after the never-launched checks, before
  // `childExited`, because for Desktop a launcher exiting is normal.
  if (input.isDesktopApp) return classified("unconfirmed");

  const alive = input.childIsAlive;
  // OUR DIRECT CHILD IS GONE — by its `exit` event or by a signal-0 probe. Usually
  // that means the listener is somebody else's, but it is ALSO the shape of a
  // wrapper that launched ComfyUI as a grandchild and exited, after which the
  // grandchild is reparented and lineage cannot place it. So only a real, comparable
  // MISMATCH is decisive here; a match and an unreadable comparison alike degrade,
  // rather than telling that user their own server is not theirs.
  if (input.childExited || alive === false) {
    return byArgv() === "differ"
      ? classified("not-ours")
      : classified("unconfirmed");
  }

  const ourPid = input.child.pid;
  if (input.portOwnerPid == null) {
    // NO LISTENER WAS IDENTIFIED. `not-ours` is a positive finding about an
    // identified process, so it cannot be reached from here — there is nothing to
    // have found.
    return classified("unconfirmed");
  }
  if (input.portOwnerPid !== ourPid) {
    // A different pid holds the port. That is usually somebody else's server, but
    // it is also the shape of an indirect launch (wrapper, double fork,
    // trampoline) where the listener is our GRANDchild — so trace lineage through
    // THIS launch's child before concluding.
    const descendant = isDescendantOfChild(
      input.portOwnerPid,
      ourPid,
      input.readParentPid,
    );
    // Lineage does not outrank direct contrary evidence: a wrapper of ours can
    // bring up a DIFFERENT or stale ComfyUI, which would be in our tree while
    // plainly not being what we launched.
    if (descendant === true) {
      return byArgv() === "differ" ? classified("not-ours") : classified("ours");
    }
    if (descendant === false) return classified("not-ours");
    return byArgv() === "differ"
      ? classified("not-ours")
      : classified("unconfirmed");
  }
  // The pid MATCHES — but it could be a recycled number we cannot signal.
  if (alive !== true) return classified("unconfirmed");

  // LINEAGE is the discriminator that does not depend on WHEN we looked: we
  // spawned this child, so the process on the port must still be it. A recycled
  // number has a different parent. Not knowing is never promoted to `ours`.
  const parent = input.readParentPid(ourPid);
  if (parent == null) return classified("unconfirmed");
  if (parent !== process.pid) return classified("not-ours");

  // Belt and braces: the OS's view of the command line, and the server's own
  // account of itself, must both agree. Each is a decisive negative only.
  const identity = input.readIdentity(ourPid);
  if (
    identity?.commandLine &&
    input.launchArgv &&
    !commandLineMatchesArgv(identity.commandLine, input.launchArgv)
  ) {
    return classified("not-ours");
  }
  if (byArgv() === "differ") return classified("not-ours");
  return classified("ours");
}
