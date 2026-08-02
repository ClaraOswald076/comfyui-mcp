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
  renameSync,
  rmSync,
  statSync,
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

/**
 * A lock is stale only when it is BOTH old AND owned by a dead process.
 *
 * The pid check is what makes reclaiming safe. Age alone let two waiters both
 * judge the same lock stale, and the slower one could then delete the FRESH
 * lock the faster one had just taken — putting two mutations in flight at once,
 * the exact thing the lock exists to prevent. A live holder's lock now never
 * reads as stale, so that interleaving cannot arise. (pid liveness is the right
 * test here precisely because this is a single-machine, local-first project.)
 */
function lockIsStale(path: string): boolean {
  try {
    if (Date.now() - statSync(path).mtimeMs <= STALE_LOCK_MS) return false;
    let pid: unknown;
    try {
      pid = (JSON.parse(readFileSync(path, "utf-8")) as { pid?: unknown })?.pid;
    } catch {
      // Unreadable/corrupt content on an already-old lock: nobody can claim it.
      return true;
    }
    return !pidAlive(pid);
  } catch {
    // Vanished between EEXIST and stat — the next create attempt will settle it.
    return false;
  }
}

/**
 * Remove a lock judged stale, ATOMICALLY. Renaming first means only one waiter
 * can win the reclaim (the rest get ENOENT and simply retry); deleting the path
 * directly would let a straggler delete whatever now sits there.
 */
function reclaimStaleLock(path: string): void {
  const claim = `${path}.reclaim-${randomUUID()}`;
  try {
    renameSync(path, claim);
  } catch {
    return; // someone else reclaimed it first — just retry the create
  }
  rmSync(claim, { force: true });
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
      if (lockIsStale(path)) {
        reclaimStaleLock(path);
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out after ${timeoutMs}ms waiting for the panel operation lock ` +
            `(${path}). Another panel install/update/pin is in progress — possibly in ` +
            `another orchestrator process. Retry shortly.`,
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

  const run = (async () => {
    const release = await acquireFileLock(opts.timeoutMs ?? DEFAULT_ACQUIRE_MS);
    try {
      return await lockHolderContext.run(true, fn);
    } finally {
      release();
    }
  });

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
