// Resume-decision types + reporting callback (#467).
//
// When a resumable download declines to reuse (or refuses) a `.partial`, the
// streaming layer reports WHY through a callback threaded from the caller (the
// download job), which stores it ON the job. Reporting to the specific job —
// rather than into a shared, string-keyed global map — means a decision can
// NEVER be misattributed to a different job (a stale prior attempt, a Manager
// dispatch, a cache hit, or a same-URL job whose identity is computed
// differently): a job only ever sees the decision its OWN physical download
// produced. A job that coalesces onto another's in-flight physical download
// simply gets none (the decision is surfaced on the job that ran the stream).

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
   *  in-stream restart declines (reported only after a confirmed discard) and for
   *  a 206 refusal whose removal was verified; false when a 206 refusal could NOT
   *  remove the partial (a swallowed rm failure) — so status never claims
   *  "discarded" when the bytes may still be on disk (#467). */
  discarded: boolean;
}

/** Sink the streaming layer calls (at most once, on the terminal decision) to
 *  report a resume outcome to the caller. Absent for internal/direct callers. */
export type ResumeReporter = (diagnostic: ResumeDiagnostic) => void;
