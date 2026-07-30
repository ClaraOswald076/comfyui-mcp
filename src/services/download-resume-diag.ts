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
  /** Bytes of pre-existing `.partial` involved in a declined resume (0 when the
   *  resume was taken). */
  discardedBytes: number;
  /** Whether the stale partial was CONFIRMED removed/truncated. True for the
   *  in-stream restart declines (recorded only after a confirmed discard) and for
   *  a 206 refusal whose removal was verified; false when a 206 refusal could NOT
   *  remove the partial (a swallowed rm failure) — so download_status never claims
   *  "discarded" when the bytes may still be on disk (#467). */
  discarded: boolean;
  /** Epoch ms this decision was made. */
  at: number;
}

const resumeDiagnostics = new Map<string, ResumeDiagnostic>();

/** Tray id for a source URL — MUST match download-jobs' downloadIdFor so
 *  download_status can key a diagnostic off the job it already holds. */
export function trayIdForUrl(url: string): string {
  return createHash("sha256").update(url).digest("hex").slice(0, 16);
}

/** The key a resume diagnostic is stored under. It is the tray id (URL hash)
 *  PLUS a per-representation discriminator when the caller supplied auth — so two
 *  CONCURRENT same-URL downloads carrying DIFFERENT auth (now separate physical
 *  cache downloads, #467 P1-2) record and read DISTINCT diagnostics instead of
 *  clobbering each other. No auth ⇒ bare tray id, so the common case (and the
 *  panel tray key) is unchanged. `authIdentity` is any stable per-caller string
 *  (e.g. JSON of the DownloadAuth); the exact value only needs to be identical
 *  between the recorder (streamUrlToFile) and the reader (download_status), which
 *  is guaranteed by computing it ONCE per job and threading it to both. */
export function resumeKeyFor(url: string, authIdentity?: string): string {
  const tray = trayIdForUrl(url);
  if (!authIdentity) return tray;
  const disc = createHash("sha256").update(authIdentity).digest("hex").slice(0, 8);
  return `${tray}:${disc}`;
}

export function recordResumeDiagnostic(
  key: string,
  outcome: ResumeOutcome,
  discardedBytes: number,
  discarded = true,
): void {
  resumeDiagnostics.set(key, { outcome, discardedBytes, discarded, at: Date.now() });
}

/** Read the last resume decision for a download's resume key (or undefined).
 *
 *  Keyed by the resume key (see resumeKeyFor), matching DownloadJob.resumeKey.
 *  Only THIS attempt's decision is ever present: the per-attempt reset runs where
 *  a genuinely-new physical download begins (streamUrlToFile) and on a cache hit
 *  (#467 P1-b/P2), so a stale decision can't be misattributed to a later attempt.
 *  Two concurrent same-URL jobs with DIFFERENT auth get DISTINCT keys (they are
 *  separate physical cache downloads); same-URL same-auth jobs to different
 *  destinations share ONE physical download and one key — accurately. */
export function getResumeDiagnostic(key: string): ResumeDiagnostic | undefined {
  return resumeDiagnostics.get(key);
}

/** Clear any prior resume decision for a slot. Called where a genuinely-new
 *  physical download begins (streamUrlToFile) and on a cache hit — NOT per job —
 *  so a decision from an EARLIER attempt can never be attributed to a later one,
 *  while a job that merely coalesces onto an in-flight download does not wipe the
 *  active stream's decision (#467 P1-b/P2). Closes the timestamp-compare
 *  equality/rollback hole a `diag.at >= started_at` check would miss. */
export function clearResumeDiagnostic(key: string): void {
  resumeDiagnostics.delete(key);
}

/** Test seam — the diagnostics map is process-global otherwise. */
export function resetResumeDiagnostics(): void {
  resumeDiagnostics.clear();
}
