/**
 * #1574 — when the completion event and `download_model action:"status"` disagree, say so.
 *
 * The tray raised `transfer completed` for an 11.46GB download while
 * `download_model action:"status"` reported it still streaming, `list_local_models` showed the
 * file absent, and the category count only rose minutes later. The file landed AFTER the
 * event.
 *
 * The completion event is built from a PROGRESS ROW read off disk each tick. `status` answers
 * from the JOB RECORD. Two stores, and the event consults only one — the same split #1545
 * documented from the other side.
 *
 * ## Why this ANNOTATES and never suppresses
 *
 * The first version of this dropped the contradicted event. Review killed it, correctly: a
 * terminal record may legitimately still read `downloading` until the ~15s persistence
 * heartbeat retries (see `persistDownloadJob`'s return value, #1545). The debounce bucket is
 * deleted before filtering and never requeued, so suppressing on a lagging record would
 * PERMANENTLY lose the completion notification for a download that genuinely finished.
 *
 * That trades a confusing message for a missing one, which is worse: the user is waiting on
 * that event. So the event always fires, and a disagreement is disclosed on it. The harm in
 * the report is a CONFIDENT false completion — "the natural next action is to use the file" —
 * and a hedge is precisely what removes that.
 *
 * ## Identity
 *
 * The two stores do not share an id. A progress row's `id` is the progress/tray identity;
 * the job's `id` is its public status handle (`6226e26ba97f8527` in the report, against tray
 * `93015fbfa0fa9933`). The row is matched against the job's `progressId ?? trayId`, which is
 * what writes those rows. An earlier version compared row id to job id and was therefore
 * INERT — it never matched anything, and its unit tests missed that because they fed
 * synthetic rows carrying whatever id the assertion wanted.
 */

/** Only the fields this reads. Both stores arrive as parsed JSON, so a shape mismatch must
 *  degrade to "no disagreement", never throw on the event path. */
interface RowLike {
  id?: unknown;
  status?: unknown;
}
interface JobLike {
  id?: unknown;
  trayId?: unknown;
  progressId?: unknown;
  status?: unknown;
}

/** The identity a PROGRESS ROW is written under. */
function progressIdentityOf(job: JobLike): string | null {
  const progress = typeof job.progressId === "string" ? job.progressId : null;
  const tray = typeof job.trayId === "string" ? job.trayId : null;
  return progress ?? tray;
}

/**
 * Does the job record disagree with announcing this row as completed?
 *
 * True ONLY on a positive contradiction: a record exists for this exact progress identity and
 * still says `downloading`. A missing record is not evidence — the record store resets on an
 * orchestrator respawn, which is exactly the reported session.
 */
export function completionDisagreesWithRecord(row: RowLike, jobs: readonly JobLike[]): boolean {
  if (!row || typeof row !== "object") return false;
  // Only COMPLETIONS. A failure event carries its own hedged wording (#1150) and must be
  // left entirely alone.
  if (row.status !== "done") return false;
  const id = typeof row.id === "string" ? row.id : null;
  if (!id) return false;
  if (!Array.isArray(jobs)) return false;
  const record = jobs.find((j) => j && typeof j === "object" && progressIdentityOf(j) === id);
  if (!record) return false;
  return record.status === "downloading";
}

/** The disclosure appended to a completion the record disagrees with. Deliberately states
 *  BOTH readings and what to do, rather than picking a winner this cannot establish. */
export const COMPLETION_DISAGREEMENT_NOTE =
  "CAVEAT: `download_model action:\"status\"` still reports this transfer as downloading. " +
  "The two are read from different stores and the record can lag a real completion by a few " +
  "seconds, so this may simply be that — but a completion event has also been observed to " +
  "arrive minutes before the file existed (#1574). Check `download_model action:\"status\"` " +
  "and that the file is present before loading it.";
