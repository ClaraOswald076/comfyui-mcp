/**
 * #1574 — do not announce a completion this orchestrator's own status tool would contradict.
 *
 * The tray raised `transfer completed` for an 11.46GB download while
 * `download_model action:"status"` reported it still streaming, `list_local_models` showed
 * the file absent, and the category count only rose minutes later. The file landed AFTER the
 * event.
 *
 * ## Why the guard sits here and not at the writer
 *
 * The completion event is driven by a PROGRESS ROW read off disk each tick. `status` answers
 * from the JOB RECORD. Two stores, and the event consults only one — the same split #1545
 * documented from the other side, where the completion is raised from this process's memory
 * while `status` reads the record from the spawned stdio child.
 *
 * Which writer set that row to `done` is not established. The three sites that write it look
 * sound in isolation (a `stat()` on the landed file; the filename appearing in the server's
 * model listing; the rename itself), and the reported session had both an orchestrator
 * respawn mid-transfer and two comfyui-mcp copies in the npx cache — so a stale or foreign
 * writer is the open question, and naming one without evidence would be a guess.
 *
 * The guard does not need the answer. Whatever wrote the row, the authoritative record is in
 * hand in the same tick, and announcing a completion it contradicts is the one outcome worth
 * preventing: a false `done` invites USING the file, where #1150's false `FAILED` at least
 * warned the reader.
 *
 * ## Everything ambiguous stays silent
 *
 * This suppresses an event a user is waiting for, so it fires only on a POSITIVE
 * contradiction — the record exists, is for this exact download, and says the bytes are still
 * moving. In particular an ABSENT record is NOT evidence: the record store resets on an
 * orchestrator respawn, which is precisely the reported session, and treating absence as "in
 * flight" would silence every completion after any respawn.
 */

/** The fields this reads. Deliberately structural rather than importing the row/job types:
 *  both stores are read as parsed JSON here, and a shape mismatch must degrade to "no
 *  opinion", never throw on the event path. */
interface RowLike {
  id?: unknown;
  status?: unknown;
}
interface JobLike {
  id?: unknown;
  status?: unknown;
}

/**
 * Would `download_model action:"status"` disagree with announcing this row as completed?
 *
 * True ONLY when the record for this exact id says `downloading`. Anything else — a missing
 * record, a different id, a non-completion row, a record that is terminal in some other way —
 * answers false, because none of them establish that the transfer is still running.
 */
export function completionContradictedByRecord(row: RowLike, jobs: readonly JobLike[]): boolean {
  if (!row || typeof row !== "object") return false;
  // Only COMPLETIONS are guarded. A failure event carries its own hedged wording (#1150) and
  // suppressing it would strand the user with no signal at all.
  if (row.status !== "done") return false;
  const id = typeof row.id === "string" ? row.id : null;
  if (!id) return false;
  if (!Array.isArray(jobs)) return false;
  // Matched on ID, never filename: a corrected retry of a 404 is a DIFFERENT id writing the
  // SAME name (#1150), so a name match would let an unrelated live attempt silence a genuine
  // completion.
  const record = jobs.find((j) => j && typeof j === "object" && j.id === id);
  if (!record) return false; // no opinion — see the respawn note above
  return record.status === "downloading";
}
