// Pin-write CANCELLATION of pending panel-affecting work (#689).
//
// update_all and deferred snapshot restores are handed to ComfyUI-Manager and
// applied out of band (see panel-pin-guard.ts). Before this fix, a pin written
// inside their window only WARNED that the queued work could still move the
// now-pinned panel — violating the owner's constraint "never auto-update over
// an explicit pin". This module is what the pin-write path calls, inside the
// pin's critical section, to actually CANCEL that work:
//
//   update-all       → POST <prefix>/manager/queue/reset on the server the op
//                      was queued on (the marker's recorded base), which drops
//                      every PENDING Manager task. A task the worker already
//                      dequeued keeps running and CANNOT be cancelled — both
//                      halves are reported, never just the convenient one.
//   snapshot-restore → delete <manager files>/startup-scripts/
//                      restore-snapshot.json before the next ComfyUI restart
//                      consumes it (local installs only).
//
// HONESTY RULES (the point of the exercise):
//   - Queue counts are read BEFORE and AFTER a reset; the report names the
//     pending-dropped numbers rather than claiming the panel was saved.
//   - The marker is cleared ONLY for what was provably cancelled or proven no
//     longer pending (an empty, idle queue / a missing restore file cannot
//     land later). Everything else — in-flight work, remote hosts, reset
//     failures, unreadable state — keeps the marker and its warning.
//   - A queue reset is BLUNT: it drops ALL pending Manager tasks, not just the
//     update_all. The report says so.

import { getComfyUIBaseUrl } from "../config.js";
import { resetQueue } from "./manager-config.js";
import { fetchManagerQueueCounts } from "./node-management.js";
import { cancelPendingSnapshotRestore } from "./node-snapshots.js";
import { clearPanelPendingOp, type PanelPendingOp } from "./panel-pin-guard.js";
import { logger } from "../utils/logger.js";

export type PanelPendingCancelOutcome =
  /** Provably cancelled before it could run; marker cleared. */
  | "cancelled"
  /** Provably nothing left to cancel (queue empty+idle / no restore file), so
   *  the window is closed — but the work may ALREADY have landed; marker
   *  cleared, and the report says the panel may already have moved. */
  | "already-drained"
  /** Pending work was dropped, but a task was already RUNNING and cannot be
   *  cancelled; marker KEPT, warning preserved. */
  | "partially-cancelled"
  /** Nothing pending; the task is in flight on the Manager worker and cannot
   *  be cancelled; marker KEPT, warning preserved. */
  | "already-running"
  /** The state could not be read, the reset/delete failed, or the marker
   *  itself could not be cleared — nothing is claimed; marker KEPT. */
  | "could-not-verify"
  /** The deferred restore file lives on a remote ComfyUI host; marker KEPT. */
  | "cannot-cancel-remote"
  /** A marker kind this build has no cancellation route for (e.g. the
   *  synthetic unreadable-record marker); marker KEPT. */
  | "cannot-cancel";

export interface PanelPendingCancelReport {
  op: PanelPendingOp;
  outcome: PanelPendingCancelOutcome;
  /** Whether the pending-op marker was removed (only ever true for
   *  "cancelled" / "already-drained"). */
  markerCleared: boolean;
  /** Human-facing explanation — appended to the pin result verbatim. */
  detail: string;
  /** update-all only: pending tasks read BEFORE the reset. */
  pendingBefore?: number;
  /** update-all only: pending tasks read AFTER the reset. */
  pendingAfter?: number;
  /** update-all only: tasks in flight after the reset (cannot be cancelled). */
  inProgress?: number;
}

/** Clear the marker and fold the outcome into the report when even THAT
 *  fails — a proven cancel with an unremovable marker must keep warning. */
function finalize(
  op: PanelPendingOp,
  report: Omit<PanelPendingCancelReport, "op" | "markerCleared">,
): PanelPendingCancelReport {
  const cleared = clearPanelPendingOp(op);
  return {
    ...report,
    op,
    markerCleared: cleared,
    outcome: cleared ? report.outcome : "could-not-verify",
    detail: cleared
      ? report.detail
      : `${report.detail} — HOWEVER the pending-op marker itself could not be ` +
        `cleared, so its warning remains.`,
  };
}

async function cancelUpdateAll(op: PanelPendingOp): Promise<PanelPendingCancelReport> {
  // Aim at the server the update_all was queued on. resetQueue re-resolves the
  // current target when given no base — thread the marker's capture so a
  // retarget between enqueue and pin can't send the reset to the WRONG ComfyUI
  // (which would both miss the real queue and wipe an innocent one).
  const base = op.base ?? getComfyUIBaseUrl();
  const baseNote = op.base
    ? ` on ${base}`
    : ` on the CURRENT target ${base} (the marker recorded no server, so this ` +
      `may not be the ComfyUI the update_all was queued on)`;

  const before = await fetchManagerQueueCounts(base);
  if (!before) {
    return {
      op,
      outcome: "could-not-verify",
      markerCleared: false,
      detail:
        `could not read the ComfyUI-Manager queue${baseNote} — NOTHING was sent. ` +
        `The queued update_all may still be pending; the warning stands.`,
    };
  }

  // Nothing pending and nothing running: the queued work has already drained
  // (or a Manager restart dropped it in memory). It cannot land LATER, so the
  // marker's window is closed — but it may ALREADY have moved the panel, and
  // the report must say that rather than imply protection.
  if (before.pending === 0 && before.inProgress === 0 && !before.processing) {
    return finalize(op, {
      outcome: "already-drained",
      detail:
        `the Manager queue${baseNote} was already empty and idle, so there was ` +
        `NOTHING left to cancel — the update_all already drained (or never ` +
        `reached the queue). The panel may ALREADY have been moved — check ` +
        `install_panel(action='status').`,
      pendingBefore: 0,
      pendingAfter: 0,
      inProgress: 0,
    });
  }

  // Nothing pending but the worker is busy: our task may be the one in
  // flight, and an in-flight task CANNOT be cancelled (queue/reset only drops
  // PENDING work). Do not even send the reset — it would drop nothing of ours
  // while wiping other clients' queued work.
  if (before.pending === 0) {
    const busy =
      before.inProgress > 0
        ? `${before.inProgress} task(s) are RUNNING`
        : `the queue worker is busy`;
    return {
      op,
      outcome: "already-running",
      markerCleared: false,
      detail:
        `cannot cancel — the Manager queue${baseNote} has nothing pending but ` +
        `${busy}, and in-flight work cannot be cancelled (a queue reset only ` +
        `drops PENDING work). The update_all may STILL move the panel after ` +
        `this pin — check install_panel(action='status') once it settles.`,
      pendingBefore: 0,
      pendingAfter: 0,
      inProgress: before.inProgress,
    };
  }

  // There IS pending work: reset the queue and measure what it dropped.
  try {
    await resetQueue(base);
  } catch (err) {
    return {
      op,
      outcome: "could-not-verify",
      markerCleared: false,
      detail:
        `the queue reset FAILED${baseNote}: ${
          err instanceof Error ? err.message : String(err)
        }. The queued update_all may still be pending; the warning stands.`,
      pendingBefore: before.pending,
      inProgress: before.inProgress,
    };
  }

  const after = await fetchManagerQueueCounts(base);
  if (!after) {
    return {
      op,
      outcome: "could-not-verify",
      markerCleared: false,
      detail:
        `a queue reset was sent${baseNote} (${before.pending} task(s) were ` +
        `pending), but the post-reset queue state could not be read — what was ` +
        `dropped is UNVERIFIED. The queued update_all may still be pending.`,
      pendingBefore: before.pending,
      inProgress: before.inProgress,
    };
  }

  if (after.pending > 0) {
    return {
      op,
      outcome: "could-not-verify",
      markerCleared: false,
      detail:
        `a queue reset was sent${baseNote}, but ${after.pending} task(s) are ` +
        `still pending (was ${before.pending}) — the reset did not provably ` +
        `clear the queue (concurrent enqueues can re-fill it). The update_all ` +
        `may still be pending; the warning stands.`,
      pendingBefore: before.pending,
      pendingAfter: after.pending,
      inProgress: after.inProgress,
    };
  }

  const dropped = before.pending - after.pending;
  if (after.inProgress > 0 || after.processing) {
    const busy =
      after.inProgress > 0
        ? `${after.inProgress} task(s) were already RUNNING`
        : `the queue worker was already busy`;
    return {
      op,
      outcome: "partially-cancelled",
      markerCleared: false,
      detail:
        `dropped ${dropped} pending task(s) via a queue reset${baseNote} (the ` +
        `Manager queue is shared, so unrelated queued work was dropped too), ` +
        `BUT ${busy} and in-flight work cannot be cancelled — the update_all ` +
        `may STILL move the panel after this pin.`,
      pendingBefore: before.pending,
      pendingAfter: 0,
      inProgress: after.inProgress,
    };
  }

  return finalize(op, {
    outcome: "cancelled",
    detail:
      `cancelled the queued update_all before it ran: a queue reset${baseNote} ` +
      `dropped ${dropped} pending task(s), none remain, and nothing is running ` +
      `(the Manager queue is shared, so this also dropped any unrelated queued ` +
      `work).`,
    pendingBefore: before.pending,
    pendingAfter: 0,
    inProgress: 0,
  });
}

function cancelSnapshotRestore(op: PanelPendingOp): PanelPendingCancelReport {
  const result = cancelPendingSnapshotRestore();
  switch (result.outcome) {
    case "cancelled":
      return finalize(op, { outcome: "cancelled", detail: result.detail });
    case "not-scheduled":
      return finalize(op, { outcome: "already-drained", detail: result.detail });
    case "remote":
      return {
        op,
        outcome: "cannot-cancel-remote",
        markerCleared: false,
        detail: result.detail,
      };
    case "failed":
      return {
        op,
        outcome: "could-not-verify",
        markerCleared: false,
        detail: result.detail,
      };
  }
}

/** Attempt to cancel ONE pending panel-affecting op, honestly reported. */
export async function cancelPanelPendingOp(
  op: PanelPendingOp,
): Promise<PanelPendingCancelReport> {
  try {
    if (op.kind === "update-all") return await cancelUpdateAll(op);
    if (op.kind === "snapshot-restore") return cancelSnapshotRestore(op);
    return {
      op,
      outcome: "cannot-cancel",
      markerCleared: false,
      detail:
        `no cancellation route exists for "${op.kind}" pending ops — the ` +
        `warning stands.`,
    };
  } catch (err) {
    // A cancel must NEVER break the pin write itself: the pin governs every
    // future op either way, and the warning only fails closed.
    logger.warn("[panel] pending-op cancellation threw; keeping the marker", {
      kind: op.kind,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      op,
      outcome: "could-not-verify",
      markerCleared: false,
      detail:
        `cancellation of the pending ${op.kind} failed unexpectedly (${
          err instanceof Error ? err.message : String(err)
        }) — the warning stands.`,
    };
  }
}

/**
 * Attempt to cancel every active pending op, sequentially (Manager state is
 * measured before/after each reset, so parallel attempts would make the
 * counts uninterpretable). One report per op, in the same order.
 */
export async function cancelPanelPendingOps(
  ops: PanelPendingOp[],
): Promise<PanelPendingCancelReport[]> {
  const reports: PanelPendingCancelReport[] = [];
  for (const op of ops) {
    reports.push(await cancelPanelPendingOp(op));
  }
  return reports;
}
