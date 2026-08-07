// Durable per-session record of SUBMITTED agent turns (#886).
//
// The claude-backend keeps its turn-trace FIFO in memory, so a session restart
// (the self-restart loop after a drop, or a full orchestrator respawn during
// the reconnect churn) forgets which turns were ever submitted. A late result
// from the dead session then arrives matching NO live trace, and an empty
// registry read as "no turn was ever submitted" is the "could not determine →
// determined not" fold: the turn WAS submitted, only its record was lost. This
// module is the record that survives, so a post-restart reader can tell "a
// turn is still outstanding" from "no turn was ever submitted" — the
// difference between "completed but unverified" and "this result came from
// nowhere".
//
// Scope: a RECOGNITION aid, not a classification input. A recorded id never
// makes a result ok:true — fail-closed (#745) is untouched. It only changes
// what we can honestly SAY about an unmatched result.
//
// Layout (codex gate, round 2): one file per (session, backend INSTANCE) —
// `turn-registry-<session>-<instance>.json` — so two live instances on one
// session can never erase each other's records with a lost update (there is
// no shared writer and no lock to go stale). Reported outcomes go to a shared
// TOMBSTONE file (`…-tombstones.json`): both a recognized late landing (spent)
// and a normally-resolved turn (round 3 — the only thing that invalidates a
// concurrent resumer's carried REPLICA of the resolved turn's record). A lost
// tombstone only revives an already-reported record (over-recognition — the
// hedged message), while a lost live record would produce the confident
// "matched to no submitted turn", a false assertion. Every failure side is
// chosen to land soft.

import { mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logger } from "../utils/logger.js";
import { writeFileDurable } from "../utils/durable-write.js";

/** Records older than this are pruned on load — a session resumed after this
 *  long is ancient history whose outstanding-turn record no longer justifies
 *  keeping the files (and the directory must not grow unbounded). */
const GC_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Bound on remembered outstanding tags — a pathological session that never
 *  lands a result can't grow the record without limit. Oldest drop first,
 *  and the drop is recorded (incomplete) rather than silent. */
export const MAX_REGISTRY_IDS = 64;

/** Bound on the tombstone list — over it, the oldest tombstone drops, which
 *  can only revive a consumed record (over-recognition, the soft side). */
const MAX_TOMBSTONES = 256;

interface InstanceFile {
  v: 1;
  sessionId: string;
  /** The backend instance that owns this file (randomUUID per instance). Turn
   *  ids are only unique within one instance (turnSeq restarts per process),
   *  so every record is namespaced by owner — two instances that each left
   *  their own turn "1" outstanding are TWO records, not one. */
  owner: string;
  /** This owner's submitted turns whose result was never seen. */
  unresolved: number[];
  /** Dead-turn records this owner carries across restarts (`<owner>:<id>`). */
  carried: string[];
  /** The owner KNOWS this record is incomplete (a bound dropped entries). A
   *  loader must not turn a known-incomplete record into the confident
   *  negative. */
  incomplete?: boolean;
  updatedAt: number;
}

interface TombstoneFile {
  v: 1;
  /** Owner-tagged records whose late landing was already recognized — spent,
   *  so a later reader never recognizes (or reports) the same turn twice. */
  spent: string[];
  updatedAt: number;
}

export interface TurnRegistryLoad {
  /** `absent` means provably no record (no files for this session); `degraded`
   *  means some record could not be read — the caller must not treat what was
   *  loaded as complete. `tags` carries whatever COULD be read either way. */
  kind: "ok" | "absent" | "degraded";
  /** Outstanding owner-tagged records, tombstones subtracted. */
  tags: string[];
  /** A loaded record self-declared incompleteness (a bound dropped entries). */
  incomplete: boolean;
  reason?: string;
}

function registryDir(): string {
  return process.env.COMFYUI_MCP_TURN_REGISTRY_DIR || join(tmpdir(), "comfyui-mcp-turn-registry");
}

function safe(s: string): string {
  // Session/instance ids are UUIDs; strip anything path-hostile anyway so a
  // malformed id can never escape the registry dir.
  return s.replace(/[^A-Za-z0-9_-]/g, "_");
}

function sessionPrefix(sessionId: string): string {
  return `turn-registry-${safe(sessionId)}-`;
}

function instancePath(sessionId: string, owner: string): string {
  return join(registryDir(), `${sessionPrefix(sessionId)}${safe(owner)}.json`);
}

function tombstonePath(sessionId: string): string {
  return join(registryDir(), `${sessionPrefix(sessionId)}tombstones.json`);
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Load every outstanding-turn record for a session being resumed: the union
 *  of all live instance files, minus spent tombstones. A file that can't be
 *  read or parsed degrades the load (its tags are lost, so the record is not
 *  provably complete) without discarding what the other files still prove. */
export function loadTurnRegistry(sessionId: string): TurnRegistryLoad {
  gcTurnRegistries(sessionPrefix(sessionId));
  let names: string[];
  try {
    names = readdirSync(registryDir());
  } catch (err) {
    // ONLY ENOENT proves absence (nothing was ever written). Any other
    // failure (permissions, I/O, a file where a dir should be) means records
    // may exist that we cannot read — degrade, never report "absent".
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { kind: "absent", tags: [], incomplete: false };
    }
    return { kind: "degraded", tags: [], incomplete: false, reason: String(err) };
  }
  const prefix = sessionPrefix(sessionId);
  const mine = names.filter((n) => n.startsWith(prefix) && n.endsWith(".json"));
  if (mine.length === 0) return { kind: "absent", tags: [], incomplete: false };

  let degraded: string | null = null;
  let incomplete = false;
  const spent = new Set<string>();
  const tombPath = tombstonePath(sessionId);
  try {
    const parsed = readJson(tombPath) as Partial<TombstoneFile>;
    if (parsed.v === 1 && Array.isArray(parsed.spent)) {
      for (const t of parsed.spent) if (typeof t === "string") spent.add(t);
    } else {
      degraded = "tombstone file has an unrecognized shape";
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") degraded = String(err);
  }

  const tags = new Set<string>();
  for (const name of mine) {
    if (name === `${prefix}tombstones.json`) continue;
    try {
      const parsed = readJson(join(registryDir(), name)) as Partial<InstanceFile>;
      if (parsed.v !== 1 || typeof parsed.owner !== "string" || !Array.isArray(parsed.unresolved)) {
        degraded = degraded ?? `${name}: unrecognized registry shape`;
        continue;
      }
      if (parsed.incomplete === true) incomplete = true;
      for (const id of parsed.unresolved) {
        if (typeof id === "number") tags.add(`${parsed.owner}:${id}`);
      }
      if (Array.isArray(parsed.carried)) {
        for (const t of parsed.carried) if (typeof t === "string") tags.add(t);
      }
    } catch (err) {
      degraded = degraded ?? `${name}: ${String(err)}`;
    }
  }
  for (const t of spent) tags.delete(t);
  return {
    kind: degraded ? "degraded" : "ok",
    tags: [...tags],
    incomplete,
    ...(degraded ? { reason: degraded } : {}),
  };
}

/** Persist THIS instance's outstanding-turn record (its own file — never a
 *  shared one). THROWS on failure (writeFileDurable's contract); the caller
 *  decides what a durability failure means. An empty AND complete record
 *  deletes the file: absence is the clean state. An empty but INCOMPLETE
 *  record stays — the incompleteness itself is information a loader needs. */
export function saveTurnRegistry(
  sessionId: string,
  owner: string,
  unresolved: number[],
  carried: string[],
  incomplete: boolean,
): void {
  const path = instancePath(sessionId, owner);
  if (unresolved.length === 0 && carried.length === 0 && !incomplete) {
    try {
      rmSync(path, { force: true });
    } catch (err) {
      // A failed delete leaves a stale record that a later resume would read
      // as outstanding turns — surface it, don't swallow it silently.
      throw err;
    }
    return;
  }
  mkdirSync(registryDir(), { recursive: true });
  const data: InstanceFile = {
    v: 1,
    sessionId,
    owner,
    unresolved: unresolved.slice(-MAX_REGISTRY_IDS),
    carried: carried.slice(-MAX_REGISTRY_IDS),
    ...(incomplete ? { incomplete: true } : {}),
    updatedAt: Date.now(),
  };
  writeFileDurable(path, JSON.stringify(data));
}

/** Spend a record: a recognized late landing tombstones its tag so no later
 *  reader (of ANY instance's file) can recognize the same turn twice. THROWS
 *  on failure — a lost tombstone only revives an already-reported record
 *  (over-recognition, the soft side), so the caller logs and moves on. */
export function tombstoneTurn(sessionId: string, tag: string): void {
  const path = tombstonePath(sessionId);
  let spent: string[] = [];
  try {
    const parsed = readJson(path) as Partial<TombstoneFile>;
    if (parsed.v === 1 && Array.isArray(parsed.spent)) {
      spent = parsed.spent.filter((t): t is string => typeof t === "string");
    }
    // A corrupt tombstone file restarts empty: the cost of a lost tombstone is
    // a repeated hedged disclosure, never a fabricated success.
  } catch {
    // absent is the common case
  }
  if (!spent.includes(tag)) spent.push(tag);
  const data: TombstoneFile = { v: 1, spent: spent.slice(-MAX_TOMBSTONES), updatedAt: Date.now() };
  mkdirSync(registryDir(), { recursive: true });
  writeFileDurable(path, JSON.stringify(data));
}

/** Best-effort prune of stale registry files — EXCEPT the session being
 *  loaded right now: pruning its records first and then reporting "absent"
 *  would turn a known-incomplete read into the confident negative. Never
 *  throws: GC must not break a load. */
function gcTurnRegistries(keepPrefix?: string): void {
  let names: string[];
  try {
    names = readdirSync(registryDir());
  } catch {
    return; // dir doesn't exist yet — nothing to prune
  }
  const cutoff = Date.now() - GC_TTL_MS;
  for (const name of names) {
    // Registries AND crash-orphaned durable-write temp files (the 7-day cutoff
    // makes a live writer's fresh temp unreachable here).
    if (!name.startsWith("turn-registry-") || (!name.endsWith(".json") && !name.includes(".json.tmp-"))) {
      continue;
    }
    if (keepPrefix && name.startsWith(keepPrefix)) continue;
    try {
      const path = join(registryDir(), name);
      if (statSync(path).mtimeMs < cutoff) rmSync(path, { force: true });
    } catch (err) {
      logger.debug(`[turn-registry] gc: ${String(err)}`);
    }
  }
}
