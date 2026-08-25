/**
 * #1574 / #2057 — when the tray event and `download_model action:"status"` disagree, say so.
 *
 * The completion event is built from a PROGRESS ROW read off disk each tick. `status` answers
 * from the JOB RECORD. Two stores, and the event consults only one — the same split #1545
 * documented from the other side.
 *
 * #1574: the tray raised `transfer completed` for an 11.46GB download while status reported
 * it still streaming. The file landed AFTER the event.
 *
 * #2057: the tray raised `Model download FAILED` (and claimed nothing transferred) for a
 * 19.53GB HuggingFace fetch while status — same id — still said **downloading** with
 * advancing bytes (0.14 → 0.22 GB). An agent that trusts FAILED re-issues into a live
 * writer, which is the corruption hazard status itself warns about. #1150 only hedges
 * when a LIVE TRAY ROW still shows that filename downloading; here the tray row itself
 * was the error, so that hedge never fired. The job record is the same authority status
 * reads, so a failure has to be checked against it the same way a completion is.
 *
 * ## Why this ANNOTATES and never suppresses
 *
 * The first version of the completion guard dropped the contradicted event. Review killed
 * it, correctly: a terminal record may legitimately still read `downloading` until the ~15s
 * persistence heartbeat retries (see `persistDownloadJob`'s return value, #1545). The
 * debounce bucket is deleted before filtering and never requeued, so suppressing on a
 * lagging record would PERMANENTLY lose the notification.
 *
 * That trades a confusing message for a missing one, which is worse: the user is waiting on
 * that event. So the event always fires, and a disagreement is disclosed on it. For a
 * completion the harm is a CONFIDENT false success; for a failure it is a CONFIDENT false
 * FAILED — both removed by hedging, not by silence.
 *
 * ## Identity
 *
 * The two stores do not share an id. A progress row's `id` is the progress/tray identity;
 * the job's `id` is its public status handle (`6226e26ba97f8527` in the #1574 report,
 * against tray `93015fbfa0fa9933`; `07d14bb0c73bc007` against tray `31bba4a9cdb04e28` in
 * #2057). The row is matched against the job's `progressId ?? trayId`, which is what
 * writes those rows. An earlier version compared row id to job id and was therefore
 * INERT — it never matched anything, and its unit tests missed that because they fed
 * synthetic rows carrying whatever id the assertion wanted.
 */

/** Only the fields this reads. Both stores arrive as parsed JSON, so a shape mismatch must
 *  degrade to "no disagreement", never throw on the event path. */
interface RowLike {
  id?: unknown;
  /** #1574 review — a progress row is scoped by (id, target), NOT id alone: a concurrent
   *  LOCAL and POD transfer of the same URL share an id and must stay distinguishable. */
  target?: unknown;
  status?: unknown;
  error?: unknown;
  /** Derived from monotonic progress snapshots, never from heartbeat timestamps. */
  progressAdvanced?: unknown;
}
export interface DownloadDoneRecordLike {
  id?: unknown;
  trayId?: unknown;
  progressId?: unknown;
  target?: unknown;
  status?: unknown;
  error?: unknown;
  /** Persisted records set this when their heartbeat is outside status' live window. */
  staleInflight?: unknown;
}

/** The identity a PROGRESS ROW is written under. */
function progressIdentityOf(job: DownloadDoneRecordLike): string | null {
  const progress = typeof job.progressId === "string" ? job.progressId : null;
  const tray = typeof job.trayId === "string" ? job.trayId : null;
  return progress ?? tray;
}

/**
 * The job record for this progress row, or null when nothing matches.
 *
 * (id, target) — the SAME key the supersession logic uses, and for the same reason: a
 * concurrent LOCAL and POD transfer of one URL shares an id but is two transfers with two
 * outcomes. Matching on id alone could annotate the wrong terminal, or miss a real
 * disagreement by finding the other one first (review).
 *
 * Target identity is production data, not a test-only discriminator. A row or record
 * without it is ambiguous when local and pod transfers share an id, so legacy targetless
 * records fail closed and never suppress or promote a terminal event.
 */
function matchingRecord(
  row: RowLike,
  jobs: readonly DownloadDoneRecordLike[],
): DownloadDoneRecordLike | null {
  if (!row || typeof row !== "object") return null;
  const id = typeof row.id === "string" ? row.id : null;
  if (!id) return null;
  if (!Array.isArray(jobs)) return null;
  const target = typeof row.target === "string" && row.target.length > 0 ? row.target : null;
  if (!target) return null;
  const candidates = jobs.filter(
    (j) =>
      j &&
      typeof j === "object" &&
      progressIdentityOf(j) === id &&
      typeof j.target === "string" &&
      j.target.length > 0 &&
      j.target === target,
  );
  if (!candidates.length) return null;
  // A reconnect can leave both an older terminal snapshot and the newer live record in
  // the persisted store. `download_model action:"status"` resolves that ambiguity in
  // favour of the live transfer; the tray guard must make the same choice or it can
  // announce FAILED while status is still advancing.
  // `download_model action:"status"` treats stale persisted rows as historical
  // diagnostics and resolves the terminal record instead. Prefer a fresh live record
  // when both snapshots are present, but keep a stale one available for error-detail
  // lookup and explicit non-live handling below.
  return (
    candidates.find((j) => j.status === "downloading" && j.staleInflight !== true) ??
    candidates.find((j) => j.status !== "downloading") ??
    candidates.find((j) => j.status === "downloading") ??
    candidates[0] ??
    null
  );
}

function recordStillDownloading(row: RowLike, jobs: readonly DownloadDoneRecordLike[]): boolean {
  const record = matchingRecord(row, jobs);
  // This is deliberately the same freshness boundary as the status action. A stale
  // persisted heartbeat can remain on disk for six hours, but status resolves it as a
  // terminal/no-live answer; it must not suppress a real FAILED tray notification.
  return record != null && record.status === "downloading" && record.staleInflight !== true;
}

/**
 * Does the job record disagree with announcing this row as completed?
 *
 * True ONLY on a positive contradiction: a record exists for this exact progress identity and
 * still says `downloading`. A missing record is not evidence — the record store resets on an
 * orchestrator respawn, which is exactly the reported session.
 */
export function completionDisagreesWithRecord(
  row: RowLike,
  jobs: readonly DownloadDoneRecordLike[],
): boolean {
  if (!row || typeof row !== "object") return false;
  // Completions only. Failures have their own check (#2057); #1150's live-tray hedge
  // stays a separate question (a different id writing the same filename).
  if (row.status !== "done") return false;
  return recordStillDownloading(row, jobs);
}

export type FailureRecordDisposition = "none" | "advancing" | "stalled" | "stale";

export interface FailureRecordMatch {
  disposition: FailureRecordDisposition;
  record: DownloadDoneRecordLike | null;
}

/** Classify a terminal tray row against the exact production job identity. */
export function failureRecordDisposition(
  row: RowLike,
  jobs: readonly DownloadDoneRecordLike[],
): FailureRecordMatch {
  if (!row || typeof row !== "object" || row.status !== "error") {
    return { disposition: "none", record: null };
  }
  const record = matchingRecord(row, jobs);
  if (!record || record.status !== "downloading") {
    return { disposition: "none", record: null };
  }
  if (record.staleInflight === true) return { disposition: "stale", record };
  return { disposition: row.progressAdvanced === true ? "advancing" : "stalled", record };
}

/**
 * Does the job record disagree with announcing this row as FAILED?
 *
 * Same identity and same positive-contradiction rule as {@link completionDisagreesWithRecord}.
 * #1150 only looks at live TRAY rows of the same filename; this looks at the job RECORD
 * `download_model action:"status"` reads. The reported case had no live tray row — the tray
 * itself was the error — while status still showed the same id streaming and advancing.
 */
export function failureDisagreesWithRecord(
  row: RowLike,
  jobs: readonly DownloadDoneRecordLike[],
): boolean {
  if (!row || typeof row !== "object") return false;
  if (row.status !== "error") return false;
  // A fresh heartbeat says only that persistence happened. The failure hedge requires
  // an actual byte increase observed by the poller, or a stalled stream could suppress
  // a genuine FAILED notification indefinitely. Stalled/stale records are reconciled to
  // terminal state by the production poll seam instead of being treated as live.
  return failureRecordDisposition(row, jobs).disposition === "advancing";
}

/** Bound one error string before it reaches the tray/agent event. */
export function boundedDownloadError(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const compact = value.replace(/\s+/g, " ").trim();
  return compact ? compact.slice(0, 400) : undefined;
}

/** Return the bounded error detail from the authoritative terminal record, when present. */
export function failureErrorDetail(
  row: RowLike,
  jobs: readonly DownloadDoneRecordLike[],
): string | undefined {
  if (!row || typeof row !== "object" || row.status !== "error") return undefined;
  const rowError = boundedDownloadError(row.error);
  const record = matchingRecord(row, jobs);
  return (
    rowError ??
    (record?.status !== "downloading" ? boundedDownloadError(record?.error) : undefined)
  );
}

export interface DownloadDoneFailureLike {
  id?: unknown;
  target?: unknown;
  status?: unknown;
  error?: unknown;
  recordDisagrees?: boolean;
  progressAdvanced?: boolean;
}

/**
 * Reconcile the failure half of one production download_done batch.
 *
 * The poll loop calls this after it has read the tray rows and authoritative job records,
 * before injecting the batch into the panel agent. Keeping the mutation here makes that
 * production seam directly testable without treating PanelAgentManager injection as the
 * producer-side proof.
 */
export function reconcileDownloadDoneFailures<T extends DownloadDoneFailureLike>(
  rows: T[],
  jobs: readonly DownloadDoneRecordLike[],
): T[] {
  const disagreeing: T[] = [];
  for (const row of rows) {
    if (failureDisagreesWithRecord(row, jobs)) {
      row.recordDisagrees = true;
      disagreeing.push(row);
    }
    if (row.status === "error") row.error = failureErrorDetail(row, jobs);
  }
  return disagreeing;
}

/** The disclosure appended to a completion the record disagrees with. Deliberately states
 *  BOTH readings and what to do, rather than picking a winner this cannot establish. */
export const COMPLETION_DISAGREEMENT_NOTE =
  "CAVEAT: `download_model action:\"status\"` still reports this transfer as downloading. " +
  "The two are read from different stores and the record can lag a real completion by a few " +
  "seconds, so this may simply be that — but a completion event has also been observed to " +
  "arrive minutes before the file existed (#1574). Check `download_model action:\"status\"` " +
  "and that the file is present before loading it.";

/** Instruction for a FAILED tray row whose job record is still downloading (#2057).
 *  Must not contain the word FAILED: that headline is what made the agent re-issue. */
export const FAILURE_DISAGREEMENT_NOTE =
  "`download_model action:\"status\"` still reports this transfer as downloading — " +
  "do NOT report it as failed";
