// In-process resume-decision registry (#467).
//
// When a resumable download declines to reuse (or refuses) a `.partial`, this
// records WHY so `download_status` — which runs in the SAME MCP server process
// as the streaming download — can tell the agent/user that a multi-GB partial
// was discarded and for what reason, instead of a silent full re-download.
//
// Kept in its OWN module (only node:crypto) rather than in download-cache so
// that download-jobs can clear a stale decision on a new attempt WITHOUT pulling
// download-cache's heavy transitive deps (storage/*, which needs child_process)
// into every consumer's test mocks.

import { createHash } from "node:crypto";

export type ResumeOutcome =
  | "resumed"
  /** No validator sidecar existed, so a safe resume couldn't even be attempted;
   *  the partial was discarded and re-downloaded in full (in-stream restart). */
  | "declined:no-validator"
  /** We attempted a conditional resume but the server answered with a full 200
   *  instead of a 206 — the upstream changed OR the host doesn't support range
   *  resume; either way the partial was discarded (in-stream restart). */
  | "declined:full-response"
  /** A 206 whose content-addressed validator PROVED the upstream object changed
   *  — refused to avoid a corrupt append; the job errors and a retry restarts. */
  | "declined:etag-changed"
  /** A cross-origin (CDN) 206 that carried NO content-addressed validator, so an
   *  unchanged upstream couldn't be proven — refused for safety; retry restarts. */
  | "declined:unverifiable";

export interface ResumeDiagnostic {
  outcome: ResumeOutcome;
  /** Bytes of pre-existing `.partial` discarded on a declined resume (0 when the
   *  resume was taken). */
  discardedBytes: number;
  /** Epoch ms this decision was made. */
  at: number;
}

const resumeDiagnostics = new Map<string, ResumeDiagnostic>();

/** Tray id for a source URL — MUST match download-jobs' downloadIdFor so
 *  download_status can key a diagnostic off the job it already holds. */
export function trayIdForUrl(url: string): string {
  return createHash("sha256").update(url).digest("hex").slice(0, 16);
}

export function recordResumeDiagnostic(
  url: string,
  outcome: ResumeOutcome,
  discardedBytes: number,
): void {
  resumeDiagnostics.set(trayIdForUrl(url), { outcome, discardedBytes, at: Date.now() });
}

/** Read the last resume decision for a download's tray id (or undefined).
 *
 *  Keyed by tray id (URL hash), matching DownloadJob.trayId. Only THIS attempt's
 *  decision is ever present: startDownloadJob clears any earlier decision for the
 *  tray id when a fresh job starts (#467 P2), so a stale discard can't be
 *  misattributed to a later job. Concurrent same-URL jobs to different
 *  destinations are views of ONE physical cache download (the cache coalesces by
 *  the URL+representation identity), so sharing the decision is accurate. */
export function getResumeDiagnostic(trayId: string): ResumeDiagnostic | undefined {
  return resumeDiagnostics.get(trayId);
}

/** Clear any prior resume decision for a tray id. Called when a NEW download job
 *  starts so a decision from an EARLIER attempt for the same URL can never be
 *  attributed to this one — a per-attempt reset that closes the timestamp-compare
 *  equality/rollback hole (#467 P2), robust to same-ms Date.now() and wall-clock
 *  rollback that a `diag.at >= started_at` check misses. */
export function clearResumeDiagnostic(trayId: string): void {
  resumeDiagnostics.delete(trayId);
}

/** Test seam — the diagnostics map is process-global otherwise. */
export function resetResumeDiagnostics(): void {
  resumeDiagnostics.clear();
}
