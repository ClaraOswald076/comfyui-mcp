import { getHistory, type HistoryEntry } from "../comfyui/client.js";
import { buildCompletionNotification } from "./job-watcher.js";
import { extractWorkflowGraph } from "./history-select.js";
import { normalizeHistoryMessages } from "./job-history.js";
import { AssetRegistry } from "./asset-registry.js";
import { logger } from "../utils/logger.js";

/**
 * Reconcile the in-memory AssetRegistry with ComfyUI's /history (#751).
 *
 * The registry is populated by JobWatcher, which only sees prompts THIS process
 * submitted via enqueueWorkflow. A render dispatched any other way — panel_run
 * (the panel queues via the browser's own app.queuePrompt), an earlier MCP
 * session, or anything before a server restart — completes without a watcher,
 * so its outputs never registered and list_assets read as empty even though
 * get_history showed them. Reconciling on demand closes that gap: outputs that
 * really exist in history are registered with source "history-reconcile",
 * with the prompt's recorded graph as the workflow snapshot (so regenerate /
 * get_asset_metadata keep working) and the run's real completion time as
 * createdAt (so ordering, `since` filters, and TTL expiry stay truthful).
 *
 * Nothing is fabricated: an entry registers only when its history status
 * affirmatively says success (status_str === "success" AND no error/interrupt
 * message — missing, unknown, or contradictory status fails toward NOT
 * registering), it carries a usable prompt graph, it lists real image outputs,
 * and it has a real execution_success timestamp for createdAt (execution_start
 * is not completion time, and "now" would silently misorder — untimed entries
 * are skipped, not guessed). Entries older than the registry TTL register but
 * read as expired immediately — the TTL stays the single source of truth for
 * record lifetime.
 */

export interface ReconcileResult {
  /** Completed prompts inspected (after the recency cap). */
  scanned: number;
  /** Newly registered records. */
  registered: number;
  /** History outputs already present in the registry (left untouched). */
  skippedExisting: number;
}

/** Only the newest N completed prompts are reconciled per call. */
const DEFAULT_MAX_PROMPTS = 25;

function queueNumberOf(entry: HistoryEntry): number {
  const p = entry?.prompt as unknown;
  return Array.isArray(p) ? Number(p[0]) || 0 : 0;
}

/** ComfyUI history timestamps are epoch seconds or milliseconds depending on
 *  version — infer from magnitude, mirroring durationMs in job-history.ts. */
function normalizeEpochMs(ts: unknown): number | undefined {
  if (typeof ts !== "number" || !Number.isFinite(ts)) return undefined;
  if (ts > 1_000_000_000_000) return ts; // epoch ms
  if (ts > 1_000_000_000) return ts * 1000; // epoch s
  return undefined;
}

/** The run's real completion time (ms epoch), taken ONLY from the
 *  execution_success message — the one truthful completion timestamp.
 *  execution_start is deliberately not a fallback: it is start time, and using
 *  it would backdate a long render past the TTL / a `since` boundary and hide
 *  it. Returns undefined when history carries no trustworthy value. */
function completionTimeMs(entry: HistoryEntry, now: number): number | undefined {
  const success = normalizeHistoryMessages(entry).find(
    (m) => m[0] === "execution_success",
  );
  const ms = normalizeEpochMs(success?.[1]?.timestamp);
  // Implausibly far in the future (clock skew, non-epoch value) — untrustworthy.
  if (ms === undefined || ms > now + 60_000) return undefined;
  return ms;
}

export async function reconcileAssetsFromHistory(opts: {
  maxPrompts?: number;
  now?: () => number;
} = {}): Promise<ReconcileResult> {
  const maxPrompts = opts.maxPrompts ?? DEFAULT_MAX_PROMPTS;
  const now = opts.now ?? Date.now;

  const history = await getHistory();
  const completed = Object.entries(history)
    .filter(([, entry]) => entry?.status?.completed === true)
    .sort((a, b) => queueNumberOf(b[1]) - queueNumberOf(a[1]))
    .slice(0, maxPrompts);

  let registered = 0;
  let skippedExisting = 0;

  for (const [promptId, entry] of completed) {
    // Eligibility keys on the HISTORY entry's own status fields, not the
    // notification builder's default: buildCompletionNotification assumes
    // success unless it finds a well-formed execution_error/interrupted
    // message, which would admit a status_str:"error" entry whose messages
    // are missing or malformed. Anything short of an affirmative success
    // fails toward NOT registering.
    if (entry.status?.status_str !== "success") continue;

    // Parse outputs exactly like the watched path does — same extraction and
    // URL building. The notification's message-derived status acts as a veto:
    // a contradictory execution_error/interrupted message rejects the entry
    // even when status_str says success.
    const notification = buildCompletionNotification(promptId, entry, now());
    if (notification.status !== "success" || notification.outputs.length === 0) {
      continue;
    }
    // The recorded graph is the provenance regenerate / get_asset_metadata
    // rely on; without it there is nothing truthful to register.
    const workflow = extractWorkflowGraph(entry);
    if (!workflow) continue;

    // createdAt must be the run's REAL completion time — an entry without a
    // trustworthy execution_success timestamp is skipped rather than guessed
    // (see completionTimeMs).
    const createdAt = completionTimeMs(entry, now());
    if (createdAt === undefined) {
      logger.debug("Skipping history entry with no usable completion timestamp", {
        prompt_id: promptId,
      });
      continue;
    }

    const fresh = notification.outputs
      .map((output) => ({
        node_id: output.node_id,
        images: output.images.filter((img) => {
          // Keep the original (watched or earlier-reconciled) record: its
          // createdAt and any already-handed-out asset_id stay stable.
          if (AssetRegistry.has(promptId, img)) {
            skippedExisting++;
            return false;
          }
          return true;
        }),
      }))
      .filter((output) => output.images.length > 0);
    if (fresh.length === 0) continue;

    const records = AssetRegistry.register({
      promptId,
      workflow,
      outputs: fresh,
      source: "history-reconcile",
      createdAt,
    });
    registered += records.length;
  }

  const result = { scanned: completed.length, registered, skippedExisting };
  if (result.registered > 0) {
    logger.info("Reconciled assets from ComfyUI history", result);
  }
  return result;
}
