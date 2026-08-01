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

import { closeSync, mkdirSync, openSync, rmSync, statSync, writeSync } from "node:fs";
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
 * Does this mutation target cover the panel pack?
 *
 * Matches the bare aliases, and a git URL whose repo component is one of them
 * (`https://github.com/artokun/comfyui-mcp-panel.git`), case-insensitively —
 * ComfyUI-Manager resolves all of these to the same pack, so treating any of
 * them as "not the panel" would reopen the door this guard closes. `"all"` is
 * included because a bulk update moves the panel along with everything else.
 */
export function targetsPanelPack(id: string): boolean {
  const raw = (id ?? "").trim().toLowerCase();
  if (!raw) return false;
  if (isBulkTarget(raw)) return true;
  if ((PANEL_PACK_ALIASES as readonly string[]).includes(raw)) return true;
  // Git URL / path form: compare the last path segment with .git stripped.
  const lastSegment = raw.split(/[/\\]/).filter(Boolean).pop() ?? "";
  const repo = lastSegment.replace(/\.git$/, "");
  return (PANEL_PACK_ALIASES as readonly string[]).includes(repo);
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
/** >0 while THIS process holds the lock, making nested acquisitions re-entrant. */
let heldDepth = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function lockIsStale(path: string): boolean {
  try {
    return Date.now() - statSync(path).mtimeMs > STALE_LOCK_MS;
  } catch {
    // Vanished between EEXIST and stat — the next create attempt will settle it.
    return false;
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
      if (lockIsStale(path)) {
        rmSync(path, { force: true });
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
  if (heldDepth > 0) return fn();

  const run = (async () => {
    const release = await acquireFileLock(opts.timeoutMs ?? DEFAULT_ACQUIRE_MS);
    heldDepth++;
    try {
      return await fn();
    } finally {
      heldDepth--;
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
