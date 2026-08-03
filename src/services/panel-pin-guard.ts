// The panel version pin, enforced where the PANEL PACK IS IDENTIFIED AS THE
// TARGET — not where the panel-specific entry point happens to be.
//
// WHY THIS FILE EXISTS. The first cut of the pin put its guard inside
// `runPanelAction` and called that "the mutation choke point". It isn't one. The
// panel IS an ordinary custom node pack, so the generic node tools are a second,
// wider door into exactly the same ComfyUI-Manager mutation:
//
//     update_custom_node(id="comfyui-agent-panel")   → updateCustomNode(...)
//     update_custom_node(id="all")                   → updateCustomNode(...)
//     reinstall_custom_node(id="comfyui-mcp-panel")  → reinstallCustomNode(...)
//     update_all                                     → updateAllCustomNodes()
//
// None of those go through `runPanelAction`, so none of them saw the pin. A
// pinned user was one `id="all"` away from being moved. The guard therefore
// lives at the SERVICE layer of the generic mutations, where every caller —
// tools, apply_manifest, dependency installers, anything future — must pass.
//
// This module deliberately imports NOTHING from panel-installer or
// node-management: panel-installer already imports node-management's mutations,
// so a guard that reached back into either would create an import cycle. It
// depends only on the pin store.

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { logger } from "../utils/logger.js";
import {
  describePanelPin,
  getPanelPinState,
  PANEL_PIN_ENV_VAR,
  type PanelPinState,
} from "./panel-settings.js";

/** Thrown when a pin forbids a mutation. Distinct so callers can recognise it. */
export class PanelPinnedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PanelPinnedError";
  }
}

/**
 * Every spelling of "the sidebar panel pack" a caller might pass as an id. The
 * Comfy Registry name and the repo/dir name differ, and both are accepted by
 * ComfyUI-Manager, so both must match here.
 */
export const PANEL_PACK_ALIASES = [
  "comfyui-agent-panel", // Comfy Registry id / pyproject [project].name
  "comfyui-mcp-panel", // repo name, and the custom_nodes dir it installs to
] as const;

/** A bulk target that necessarily includes the panel. */
function isBulkTarget(id: string): boolean {
  return id === "all" || id === "*";
}

/**
 * Reduce any target spelling to a bare repo/pack name.
 *
 * This MUST cover every ref-carrying form `parseGitUrl` accepts, because those
 * are the forms a caller can actually pass: naively taking the last path segment
 * turned `…/comfyui-mcp-panel.git@v0.11.28` into `comfyui-mcp-panel.git@v0.11.28`
 * and `…/comfyui-mcp-panel/tree/main` into `main`, so BOTH slipped past the
 * matcher and moved a pinned panel. Kept deliberately independent of
 * node-management's parser: panel-installer already imports node-management, so
 * reaching back into it from here would be an import cycle.
 */
export function normalizePackTarget(id: string): string {
  let s = (id ?? "").trim().toLowerCase();
  if (!s) return "";
  // Drop query strings / fragments first.
  s = s.split(/[?#]/)[0] ?? "";
  // Forge "browse at a ref" forms (GitHub/GitLab/Gitea/Bitbucket), mirroring
  // parseGitUrl's list.
  s = s.replace(/\/-\/(tree|commit)\/.*$/, "");
  s = s.replace(/\/(tree|commit|commits|src)\/.*$/, "");
  s = s.replace(/\/releases\/tag\/.*$/, "");
  s = s.replace(/\/+$/, "");
  // Last path segment (handles bare ids, "author/repo", and full URLs).
  let seg = s.split(/[/\\]/).filter(Boolean).pop() ?? "";
  // npm/pip style `repo@ref` / `repo.git@ref`. The segment can no longer contain
  // an scp-style `git@host:` user part, since that lives before the ":".
  seg = seg.split("@")[0] ?? "";
  return seg.replace(/\.git$/, "");
}

/**
 * Does this mutation target cover the panel pack?
 *
 * Matches the bare aliases and every git-URL spelling that resolves to them,
 * case-insensitively — ComfyUI-Manager resolves all of these to the same pack,
 * so treating any of them as "not the panel" reopens the door this guard closes.
 * `"all"` is included because a bulk update moves the panel along with
 * everything else.
 */
export function targetsPanelPack(id: string): boolean {
  const raw = (id ?? "").trim().toLowerCase();
  if (!raw) return false;
  if (isBulkTarget(raw)) return true;
  if ((PANEL_PACK_ALIASES as readonly string[]).includes(raw)) return true;
  return (PANEL_PACK_ALIASES as readonly string[]).includes(normalizePackTarget(raw));
}

/** Is this an exact single-pack panel target (i.e. NOT a bulk "all")? */
export function targetsPanelPackExactly(id: string): boolean {
  const raw = (id ?? "").trim().toLowerCase();
  return !isBulkTarget(raw) && targetsPanelPack(id);
}

/**
 * Read the pin so that NO failure mode reads as "unpinned" — a reader that
 * throws is reported as an indeterminate pin, which counts as pinned.
 */
function readPin(): PanelPinState {
  try {
    return getPanelPinState();
  } catch (err) {
    logger.warn(
      `[panel] could not read the panel version pin: ${
        err instanceof Error ? err.message : String(err)
      } — treating the panel as PINNED (refusing to move it).`,
    );
    return { pinned: true, source: "settings", indeterminate: true };
  }
}

/**
 * Refuse a generic node mutation that would move a PINNED panel.
 *
 * `action` and `id` are only used to build the message; the decision is the
 * pin's. A bulk target gets its own wording because there is no way to update
 * everything-except-the-panel through ComfyUI-Manager — the user has to unpin or
 * update packs individually, and saying so is more useful than a generic refusal.
 */
export function assertPanelPinAllows(action: string, id: string): void {
  if (!targetsPanelPack(id)) return;
  const pin = readPin();
  if (!pin.pinned) return;

  const bulk = !targetsPanelPackExactly(id);
  const envNote =
    pin.source === "env"
      ? ` (this pin comes from the ${PANEL_PIN_ENV_VAR} environment variable, so it ` +
        `must be unset/changed in the environment — unpin cannot remove it)`
      : ``;

  throw new PanelPinnedError(
    bulk
      ? `Refusing to ${action} "${id}": that would also move the sidebar panel pack, ` +
        `which is ${describePanelPin(pin)}. ComfyUI-Manager cannot update ` +
        `everything-except-one-pack, so either clear the pin first with ` +
        `install_panel(action='unpin')${envNote} and re-run, or update the other packs ` +
        `individually by id.`
      : `Refusing to ${action} the sidebar panel pack ("${id}"): it is ` +
        `${describePanelPin(pin)}. A pin is honoured even when a newer panel exists — ` +
        `clear it first with install_panel(action='unpin')${envNote}, then re-run.`,
  );
}

/**
 * Refuse a panel-pack mutation on a path that has NO on-disk verification —
 * currently the sidebar `panel_install_node` / `panel_update_node` tools (which
 * drive the user's built-in ComfyUI Manager through the browser) and
 * `fix_custom_node`.
 *
 * These cannot be redirected into the verified path: `panel_*` acts on the
 * panel's own host through the browser Manager (which may not even be the
 * filesystem this process can read), and `fix` has no verified equivalent. Both
 * report success from the Manager queue alone — precisely the #639 signal that
 * proves nothing. Rather than let the panel be moved unverifiably, or pretend we
 * checked, they refuse and name the tool that does verify.
 *
 * The pin is reported FIRST when set, because that is the more specific reason.
 */
export function assertPanelNotTargetedUnverifiable(
  toolName: string,
  // `unknown` on purpose: panel-tool handlers receive loosely-typed args, and a
  // guard that forced a cast at every call site would eventually be skipped.
  id: unknown,
): void {
  if (typeof id !== "string" || !targetsPanelPack(id)) return;
  assertPanelPinAllows(toolName, id); // pinned → the pin message wins
  throw new PanelPinnedError(
    `${toolName} cannot manage the comfyui-mcp sidebar panel pack ("${id}"). That ` +
      `path reports success as soon as the ComfyUI-Manager queue drains, which a ` +
      `stale Manager does WITHOUT doing any work (#639) and which cannot see a ` +
      `".bak" shadow copy shadowing the real panel (#641) — so it could tell you the ` +
      `panel updated when it did not. Use install_panel instead: ` +
      `install_panel(action='sync') brings the panel in line with this orchestrator ` +
      `and re-reads the installed version from disk, and action='status' reports it.`,
  );
}

// ---------------------------------------------------------------------------
// Cross-process mutation lock
//
// The first cut serialized panel mutations with a module-global promise chain.
// That is not enough and the claim built on it was wrong: running more than one
// orchestrator process is ordinary here (one per MCP client). Process A could
// pass its final pin check and begin an awaited Manager update while process B
// wrote a pin against its own, entirely separate chain — and A would then move a
// now-pinned panel.
//
// So the lock is a FILE under ~/.comfyui-mcp/, which is the only thing both
// processes share. In-process we still chain (a file lock alone would spin), and
// the whole thing is re-entrant so `runPanelAction` can call a guarded service
// function while already holding it.
// ---------------------------------------------------------------------------

/** Lock file path. Overridable so tests never touch the real home directory. */
export function panelLockPath(): string {
  return (
    process.env.COMFYUI_MCP_PANEL_LOCK ||
    join(homedir(), ".comfyui-mcp", "panel-op.lock")
  );
}

/**
 * A lock older than this is assumed abandoned by a crashed process. Panel
 * operations are ComfyUI-Manager queue cycles measured in seconds; ten minutes
 * is far beyond a legitimate one, so reclaiming at that point cannot cut a live
 * op short, while still guaranteeing a crash can never wedge pinning forever.
 */
const STALE_LOCK_MS = 10 * 60_000;

/** Default acquisition budget. Callers that must not block (the fire-and-forget
 *  on-load ensure) pass something much shorter. */
const DEFAULT_ACQUIRE_MS = 60_000;

const POLL_MS = 100;

let inProcessChain: Promise<unknown> = Promise.resolve();

/**
 * Marks the async context of the current lock HOLDER, so re-entrancy is scoped
 * to work actually running inside it.
 *
 * A process-global "held" flag was wrong and dangerous: while an update held the
 * lock, an UNRELATED concurrent request (a pin write, say) saw the flag set and
 * sailed straight through — landing precisely in the window between the update's
 * final pin check and its Manager call. AsyncLocalStorage makes the exemption
 * apply only to callers nested within the holder's own execution.
 */
const lockHolderContext = new AsyncLocalStorage<true>();

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Is the process that wrote a lock still running? */
function pidAlive(pid: unknown): boolean {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    // Signal 0 performs the permission/existence check without delivering.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = the process exists but belongs to someone else — still ALIVE.
    return (err as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

interface StaleLockSnapshot {
  readonly raw: string;
  readonly dev: number;
  readonly ino: number;
}

function staleLockSnapshot(path: string): StaleLockSnapshot | undefined {
  try {
    const before = statSync(path);
    if (Date.now() - before.mtimeMs <= STALE_LOCK_MS) return undefined;
    const raw = readFileSync(path, "utf-8");
    const after = statSync(path);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.mtimeMs !== after.mtimeMs ||
      before.size !== after.size
    ) {
      return undefined;
    }
    let pid: unknown;
    try {
      pid = (JSON.parse(raw) as { pid?: unknown })?.pid;
    } catch {
      return undefined;
    }
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return undefined;
    return pidAlive(pid) ? undefined : { raw, dev: after.dev, ino: after.ino };
  } catch {
    return undefined;
  }
}

function stableLockFileSnapshot(path: string): StaleLockSnapshot | undefined {
  try {
    const before = statSync(path);
    const raw = readFileSync(path, "utf-8");
    const after = statSync(path);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.mtimeMs !== after.mtimeMs ||
      before.size !== after.size
    ) {
      return undefined;
    }
    return { raw, dev: after.dev, ino: after.ino };
  } catch {
    return undefined;
  }
}

/** A reclaim claim is only arbitration metadata, not the operation lock. A
 * crashed claimant must therefore never leave future recovery wedged behind an
 * incomplete record. */
function reclaimClaimIsAbandoned(path: string): boolean {
  try {
    if (Date.now() - statSync(path).mtimeMs <= STALE_LOCK_MS) return false;
    const record = JSON.parse(readFileSync(path, "utf-8")) as { pid?: unknown };
    return !pidAlive(record.pid);
  } catch {
    // This is safe for a claim (unlike the base lock): a writer whose old,
    // partial claim is removed cannot pass the token ownership check below.
    try {
      return Date.now() - statSync(path).mtimeMs > STALE_LOCK_MS;
    } catch {
      return false;
    }
  }
}

function snapshotStillMatches(path: string, observed: StaleLockSnapshot): boolean {
  try {
    const before = statSync(path);
    const raw = readFileSync(path, "utf-8");
    const after = statSync(path);
    return (
      before.dev === after.dev &&
      before.ino === after.ino &&
      before.mtimeMs === after.mtimeMs &&
      before.size === after.size &&
      after.dev === observed.dev &&
      after.ino === observed.ino &&
      raw === observed.raw
    );
  } catch {
    return false;
  }
}

/**
 * A stale fixed claim is itself reclaimed through an independent, tokenized
 * cleanup claim. The cleanup record is fresh and owned by this process, so a
 * competing cleaner cannot replace the fixed claim between its snapshot check
 * and removal. Reaping an abandoned cleanup record touches only metadata.
 */
function clearAbandonedReclaimClaim(claim: string): void {
  const observed = stableLockFileSnapshot(claim);
  if (!observed) return;
  const cleanup = `${claim}.cleanup`;
  const token = randomUUID();
  let fd: number | undefined;
  try {
    fd = openSync(cleanup, "wx");
    writeSync(fd, JSON.stringify({ pid: process.pid, token }));
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "EEXIST" && reclaimClaimIsAbandoned(cleanup)) {
      // Cleanup is arbitration metadata only, never the fixed claim pathname.
      rmSync(cleanup, { force: true });
    }
    return;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }

  const ownsCleanup = (): boolean => {
    try {
      const record = JSON.parse(readFileSync(cleanup, "utf-8")) as {
        pid?: unknown;
        token?: unknown;
      };
      return record.pid === process.pid && record.token === token;
    } catch {
      return false;
    }
  };
  const releaseCleanup = (): void => {
    if (ownsCleanup()) rmSync(cleanup, { force: true });
  };

  try {
    if (ownsCleanup() && snapshotStillMatches(claim, observed) && ownsCleanup()) {
      rmSync(claim);
    }
  } finally {
    releaseCleanup();
  }
}

function reclaimBoundStaleLock(path: string, observed: StaleLockSnapshot): boolean {
  const claim = `${path}.reclaim`;
  const token = randomUUID();
  let fd: number | undefined;
  try {
    // The claim has independent exclusive-create semantics. It binds this
    // reclaimer to the observed stale snapshot before the base path moves.
    fd = openSync(claim, "wx");
    writeSync(fd, JSON.stringify({ pid: process.pid, token }));
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "EEXIST" && reclaimClaimIsAbandoned(claim)) {
      clearAbandonedReclaimClaim(claim);
    }
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }

  const ownsClaim = (): boolean => {
    try {
      const record = JSON.parse(readFileSync(claim, "utf-8")) as {
        pid?: unknown;
        token?: unknown;
      };
      return record.pid === process.pid && record.token === token;
    } catch {
      return false;
    }
  };
  const releaseClaim = (): void => {
    if (ownsClaim()) rmSync(claim, { force: true });
  };

  try {
    if (!ownsClaim()) return false;
    const current = staleLockSnapshot(path);
    // A later fresh lock cannot satisfy the source file's exact identity and
    // bytes, so this reclaimer cannot delete it.
    if (
      !current ||
      current.dev !== observed.dev ||
      current.ino !== observed.ino ||
      current.raw !== observed.raw ||
      !ownsClaim()
    ) {
      return false;
    }
    rmSync(path);
    return true;
  } finally {
    releaseClaim();
  }
}

async function acquireFileLock(timeoutMs: number): Promise<() => void> {
  const path = panelLockPath();
  mkdirSync(dirname(path), { recursive: true });
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    try {
      // "wx" = create-exclusive: atomic across processes, which is the whole point.
      const fd = openSync(path, "wx");
      try {
        writeSync(
          fd,
          JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
        );
      } finally {
        closeSync(fd);
      }
      return () => {
        try {
          rmSync(path, { force: true });
        } catch (err) {
          logger.warn(
            `[panel] could not remove the panel op lock at ${path}: ${
              err instanceof Error ? err.message : String(err)
            } (it will be reclaimed as stale).`,
          );
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") {
        // Anything other than "already held" is a real failure. FAIL CLOSED:
        // proceeding without the lock is how a pinned user gets moved.
        throw new Error(
          `Could not take the panel operation lock at ${path}: ${
            err instanceof Error ? err.message : String(err)
          }. Refusing to mutate the panel without it.`,
        );
      }
      const stale = staleLockSnapshot(path);
      if (stale) {
        // Only a demonstrably abandoned lock gets here: old locks with a live
        // owner (and all fresh locks) still wait. The exclusive claim binds
        // this reclaimer to its observed file before the base is removed.
        if (reclaimBoundStaleLock(path, stale)) continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out after ${timeoutMs}ms waiting for the panel operation lock ` +
            `(${path}). Another panel install/update/pin is in progress — possibly in ` +
            `another orchestrator process. Fresh locks, malformed locks, and locks owned by a ` +
            `live process are never auto-reclaimed; a proven abandoned lock is reclaimed ` +
            `automatically. Retry shortly.`,
        );
      }
      await sleep(POLL_MS);
    }
  }
}

/**
 * Run `fn` with exclusive rights to mutate the panel or its pin, across BOTH
 * async callers in this process and other orchestrator processes.
 *
 * Re-entrant: a nested call while this process already holds the lock runs
 * immediately (the in-process chain guarantees only one holder is executing, so
 * a nested acquisition can only come from the holder itself). Rejections never
 * wedge the chain.
 */
export function withPanelMutationLock<T>(
  fn: () => Promise<T>,
  opts: { timeoutMs?: number } = {},
): Promise<T> {
  // Only work running INSIDE the current holder is exempt — not everything that
  // happens to overlap it in this process.
  if (lockHolderContext.getStore()) return fn();

  // `run` is the chain's settle CALLBACK — deliberately a function, NOT an
  // invoked IIFE (note: no trailing `()`). Passing an already-started promise
  // to .then() would resolve callers immediately with the chain's value while
  // the guarded work floated unfinished. Written without the `(async () =>
  // {...})` grouping parens because that shape reads as an IIFE and has been
  // mis-reviewed as one; the semantics were and are: callers resolve only
  // after the guarded action AND the release complete.
  const run = async (): Promise<T> => {
    const release = await acquireFileLock(opts.timeoutMs ?? DEFAULT_ACQUIRE_MS);
    try {
      return await lockHolderContext.run(true, fn);
    } finally {
      release();
    }
  };

  const started = inProcessChain.then(run, run);
  inProcessChain = started.then(
    () => undefined,
    () => undefined,
  );
  return started;
}

/**
 * Run a panel-moving mutation atomically with its pin check.
 *
 * assertPanelPinAllows alone is a TOCTOU race: the check passes, and THEN a pin
 * can be written before/while the ComfyUI-Manager operation runs (an update_all
 * drain takes seconds), so the update lands on a by-then-pinned panel. The pin
 * WRITE path takes this same lock, so checking inside it and holding it across
 * the whole mutation means a pin either lands before the op starts (and blocks
 * it) or after it finishes (and blocks the next one) — never in the middle.
 *
 * Targets that cannot move the panel skip the lock entirely: there is no pin
 * decision to make for them, and serializing every unrelated pack mutation
 * behind panel ops would be pointless contention.
 *
 * Re-entrant via withPanelMutationLock: runPanelAction already holds the lock
 * when it calls the guarded node-management mutations, so nesting is immediate.
 */
export function withPanelPinGuard<T>(
  action: string,
  id: string,
  op: () => Promise<T>,
): Promise<T> {
  if (!targetsPanelPack(id)) return op();
  return withPanelMutationLock(() => {
    assertPanelPinAllows(action, id);
    return op();
  });
}

// ---------------------------------------------------------------------------
// Pending panel-affecting operations
//
// Some panel-moving operations are handed to ComfyUI-Manager and then applied
// OUT OF BAND: update_all drains on the Manager's own worker after we return,
// and a snapshot restore is deferred to the next ComfyUI restart. The mutation
// lock cannot be held across that window (it would wedge pinning for minutes
// to days), and no completion/apply path exists IN THIS PROCESS to re-check a
// pin at — the Manager, not us, is the applying agent, which is exactly why
// the window exists. So each op records a marker here (with an expiry), and
// the pin-write path reads it inside the pin's critical section.
//
// A pin written while a marker is active does NOT just warn (#689): it
// attempts to CANCEL the pending work first (reset the Manager task queue /
// delete the deferred-restore file), clears the marker only for what was
// PROVABLY cancelled or proven no longer pending, and keeps the warning for
// the residue — in-flight work, remote hosts, anything unverifiable. The
// lock-held variants — update_custom_node(id="all"), which waits for the
// drain inside the lock, and every install_panel mutation — need no marker:
// no pin can be written inside their window at all.
// ---------------------------------------------------------------------------

export interface PanelPendingOp {
  /** What is pending: "update-all" | "snapshot-restore" (unknown kinds are
   *  tolerated when reading, so an older/newer record never reads as clear). */
  kind: string;
  /** Unique record id (records written before ids existed fall back to
   *  kind+queuedAt matching — which collides for two records minted in the
   *  same millisecond, so a stale clear could take the live one with it). */
  id?: string;
  /** When it was handed to ComfyUI-Manager (ISO). */
  queuedAt: string;
  /** When the warning lapses (ISO). After this the pin governs as usual — the
   *  pending op has either landed (the pin then holds FUTURE ops) or failed. */
  expiresAt: string;
  /** Human-facing explanation for the pin-write warning. */
  detail: string;
  /** The ComfyUI base URL the op was handed to, captured at enqueue time. A
   *  pin-write cancellation must target the ORIGINAL server even if the
   *  orchestrator has since been retargeted; when absent (older markers) the
   *  cancel falls back to the current target and says so in its report. */
  base?: string;
  /** update-all only: the ui_id of the enqueue attempt that actually landed
   *  (v4 derives each per-pack task id as `${uiId}_${pack}`), so a v4 host can
   *  later answer "did the panel's task already run" via
   *  /v2/manager/queue/history?ui_id=…. */
  uiId?: string;
}

/** update_all drains in minutes on the Manager's worker; an hour is far beyond
 *  a legitimate drain, so reclaiming then cannot cut a live op short. */
export const UPDATE_ALL_PENDING_MS = 60 * 60_000;

/** A snapshot restore is applied at the next ComfyUI restart, which this
 *  process cannot observe — that could be days away. The marker cannot outlive
 *  restarts forever, so it expires after a week and says so in its detail. */
export const SNAPSHOT_RESTORE_PENDING_MS = 7 * 24 * 60 * 60_000;

/** Marker file path. Overridable so tests never touch the real home directory. */
export function panelPendingOpsPath(): string {
  return (
    process.env.COMFYUI_MCP_PANEL_PENDING ||
    join(homedir(), ".comfyui-mcp", "panel-pending-ops.json")
  );
}

function isPanelPendingOp(value: unknown): value is PanelPendingOp {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const op = value as Record<string, unknown>;
  return (
    typeof op.kind === "string" &&
    typeof op.queuedAt === "string" &&
    typeof op.expiresAt === "string" &&
    typeof op.detail === "string" &&
    (op.base === undefined || typeof op.base === "string") &&
    (op.uiId === undefined || typeof op.uiId === "string")
  );
}

function readPanelPendingOpsFile(): { ops: PanelPendingOp[]; unreadable: boolean } {
  const path = panelPendingOpsPath();
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    // Only ENOENT proves there is no marker. Permission/I/O errors are
    // indeterminate and must keep a later pin from claiming clean protection.
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { ops: [], unreadable: false };
    }
    return { ops: [], unreadable: true };
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    const ops =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as { ops?: unknown }).ops
        : undefined;
    if (Array.isArray(ops) && ops.every(isPanelPendingOp)) {
      return { ops, unreadable: false };
    }
  } catch {
    // fall through
  }
  return { ops: [], unreadable: true };
}

/**
 * Record that a panel-affecting operation was handed to ComfyUI-Manager and may
 * still land out-of-band. Replaces any prior marker of the same kind.
 *
 * Call this BEFORE handing the operation to ComfyUI-Manager. A mutation whose
 * out-of-band window cannot be durably recorded must not start: otherwise a
 * user can set a pin immediately afterwards and be told it protects a panel
 * which the already-queued Manager operation is still free to move. The write
 * is read back before returning, so a successful syscall alone is not treated
 * as proof that the warning is durable.
 *
 * Once this succeeds, callers deliberately leave the marker in place even if
 * their Manager request errors. A transport error cannot prove the remote
 * Manager did not accept the request, and retaining a conservative warning is
 * safer than letting a later pin claim clean protection.
 */
export function recordPanelPendingOp(
  kind: "update-all" | "snapshot-restore",
  detail: string,
  ttlMs: number,
  extra: { base?: string; uiId?: string } = {},
): PanelPendingOp {
  const now = Date.now();
  const op: PanelPendingOp = {
    kind,
    id: randomUUID(),
    queuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlMs).toISOString(),
    detail,
    ...(extra.base ? { base: extra.base } : {}),
    ...(extra.uiId ? { uiId: extra.uiId } : {}),
  };
  try {
    const path = panelPendingOpsPath();
    const prior = readPanelPendingOpsFile();
    if (prior.unreadable) throw new Error("existing pending-operation record is unreadable");
    const kept = prior.ops.filter((o) => o.kind !== kind);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ ops: [...kept, op] }, null, 2), "utf-8");

    // Verify the exact replacement record, not merely that JSON still parses.
    // A partial/redirected write that drops this operation would recreate the
    // same false-protection window as a write failure.
    const confirmed = readPanelPendingOpsFile();
    if (
      confirmed.unreadable ||
      !confirmed.ops.some(
        (candidate) =>
          candidate.kind === op.kind &&
          candidate.queuedAt === op.queuedAt &&
          candidate.expiresAt === op.expiresAt &&
          candidate.detail === op.detail &&
          candidate.base === op.base &&
          candidate.uiId === op.uiId,
      )
    ) {
      throw new Error("pending-operation record did not survive a read-back verification");
    }
  } catch (err) {
    throw new Error(
      `Could not persist the pending ${kind} marker: ${
        err instanceof Error ? err.message : String(err)
      }. Refusing to start an operation that could move the panel after a later pin.`,
    );
  }
  return op;
}

/**
 * Remove a pending-op marker — ONLY the exact record handed in (matched by
 * kind + queuedAt), so a NEWER marker of the same kind recorded after it is
 * never silently dropped.
 *
 * Call this only for an op that was PROVABLY dealt with by the pin-write
 * cancellation path (#689): cancelled before it could run, or proven to be no
 * longer pending. Clearing anything else would let a later pin write report
 * clean protection while queued work is still out there.
 *
 * Read-back verified like recordPanelPendingOp, and fails CLOSED: any read or
 * write failure returns false and leaves the marker (and its warning) in
 * place. Returns true when the exact record is gone afterwards — including
 * when it was already absent (that is the goal state, not a success claim
 * about work this call did).
 */
export function clearPanelPendingOp(op: PanelPendingOp): boolean {
  // Identity by unique id when the record has one; only legacy records fall
  // back to kind+queuedAt (collision-prone in the same millisecond).
  const matches = (candidate: PanelPendingOp): boolean =>
    op.id !== undefined
      ? candidate.id === op.id
      : candidate.kind === op.kind && candidate.queuedAt === op.queuedAt;
  try {
    const path = panelPendingOpsPath();
    const prior = readPanelPendingOpsFile();
    if (prior.unreadable) return false;
    if (!prior.ops.some(matches)) return true; // already gone
    const kept = prior.ops.filter((candidate) => !matches(candidate));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ ops: kept }, null, 2), "utf-8");
    const confirmed = readPanelPendingOpsFile();
    return !confirmed.unreadable && !confirmed.ops.some(matches);
  } catch (err) {
    logger.warn(
      `[panel] could not clear the pending ${op.kind} marker: ${
        err instanceof Error ? err.message : String(err)
      } — leaving it (and its warning) in place.`,
    );
    return false;
  }
}

/**
 * The pending panel-affecting operations whose warning window is still open.
 *
 * Reads fail CLOSED, mirroring the pin store: a present-but-unreadable marker
 * file means we cannot prove nothing is pending, so it yields a synthetic
 * indeterminate op and the pin write still warns. Entries with an unparseable
 * expiry are kept (indeterminate = still warn), never dropped.
 */
export function activePanelPendingOps(now: number = Date.now()): PanelPendingOp[] {
  const { ops, unreadable } = readPanelPendingOpsFile();
  if (unreadable) {
    return [
      {
        kind: "unknown",
        queuedAt: new Date(0).toISOString(),
        expiresAt: new Date(0).toISOString(),
        detail:
          "the pending panel-operation record could not be read, so a queued " +
          "update or deferred restore may still be outstanding",
      },
    ];
  }
  // Expiry is informational only. We have no completion signal for a Manager
  // worker/deferred restore, so auto-expiry would falsely green a later pin.
  void now;
  return ops;
}
