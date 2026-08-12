/**
 * #1479 — `download_model action:"status"` reported PROVEN-dead downloads as
 * "still streaming".
 *
 * After a session drop, three transfers that died with their owning process were
 * rendered as **downloading — still streaming**, with a note saying "the transfer may
 * still be running … Do not report this download as failed or missing." Nothing was
 * writing them: no `.partial`/`.part`/`.tmp` under `models/` or `%TEMP%`, and
 * `~/.comfyui-mcp/download-records/` was empty. `action:"cancel"` on the same ids
 * answered "that session is confirmed GONE — its process no longer exists".
 *
 * ## The evidence was already in the process
 *
 * `writerProcessGone()` settles it by probing the owner pid (ESRCH ⇒ proven dead), but
 * it was only reached from the CANCEL path. The status render branched solely on
 * `staleInflight`, which is heartbeat AGE. So two actions answered the same question
 * from the same process with opposite verdicts — and the wrong one was the one telling
 * the caller not to act.
 *
 * ## What must NOT change
 *
 * The cautious wording is right for a MERELY stale record. #761 established that a
 * reconnect can interrupt persistence, so a missed heartbeat alone does not prove the
 * transfer stopped, and refusing to say so is what keeps a live download from being
 * re-issued underneath itself.
 *
 * This changes only the case where death is PROVEN — the distinction that caution
 * exists to protect. `writerProcessGone` returns `undefined` when it cannot tell (no
 * recorded pid, or the probe itself failed), and `undefined` must keep the caution.
 */

/**
 * The status note for an in-flight record whose writer is PROVEN gone.
 *
 * Deliberately states the evidence rather than just the verdict: a caller who was told
 * five seconds ago not to touch this download needs to know why the answer changed.
 */
export function provenDeadStatusNote(opts: {
  staleForMs?: number;
  /** True when the record was a remote ComfyUI-Manager dispatch. */
  viaManager?: boolean;
}): string {
  const { staleForMs, viaManager } = opts;
  const stale =
    typeof staleForMs === "number" && staleForMs > 0
      ? ` Its heartbeat stopped ${Math.round(staleForMs / 1000)}s ago.`
      : "";
  // A Manager dispatch runs SERVER-side, so the local writer being gone says nothing
  // about the host's own fetch — claiming the transfer is dead there would be the same
  // over-reach in the other direction.
  const tail = viaManager
    ? ` This was a remote ComfyUI-Manager dispatch, so the SERVER-side fetch may still ` +
      `be running — only the local record's owner is proven gone. Check ` +
      `list_local_models to see whether the file landed.`
    : ` Nothing is writing this file. There is no local transfer to interrupt, so it ` +
      `is safe to re-issue the download — or call download_model action:"cancel" with ` +
      `this id and tray_id first to close the stale record.`;
  return (
    `\n    NOTE: this transfer is NOT running. The process that owned it no longer ` +
    `exists (probed by pid), so it died with its session (#1479).${stale}${tail}`
  );
}

/**
 * Which in-flight note to render.
 *
 * Returns `"proven-dead"` only on a demonstrated death, `"stale"` for a missed
 * heartbeat that proves nothing, and `"none"` otherwise. `provenGone === undefined`
 * is deliberately NOT proven-dead: absence of evidence is not evidence of absence,
 * and the caution is correct there.
 */
export function inflightNoteKind(opts: {
  status?: string;
  staleInflight?: boolean;
  provenGone?: boolean;
}): "proven-dead" | "stale" | "none" {
  const { status, staleInflight, provenGone } = opts;
  if (status !== "downloading") return "none";
  if (provenGone === true) return "proven-dead";
  return staleInflight ? "stale" : "none";
}
