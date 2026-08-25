import {
  listDownloadJobs,
  reconcileStalledDownloadRecord,
  type DownloadJob,
} from "../services/download-jobs.js";
import {
  failureErrorDetail,
  failureRecordDisposition,
  reconcileDownloadDoneFailures,
  type DownloadDoneFailureLike,
} from "./download-done-guard.js";

export interface DownloadDoneInjection<T extends DownloadDoneFailureLike> {
  kind: "download_done";
  downloads: T[];
}

/**
 * The failure-reconciliation stage used by the download poll loop.
 *
 * The live loop already has the authoritative records because the completion guard reads
 * them once per flush; callers pass those records to avoid a second filesystem scan. Tests
 * may omit them to exercise the same production lookup against the persisted job store.
 */
export function reconcileDownloadDoneBatch<T extends DownloadDoneFailureLike>(
  rows: T[],
  records?: readonly DownloadJob[],
  progress?: { hasAdvanced: (row: { id?: unknown; target?: unknown; attempt?: unknown }) => boolean },
  onInject?: (event: DownloadDoneInjection<T>) => void,
): T[] {
  let authoritative = records;
  if (!authoritative) {
    try {
      authoritative = listDownloadJobs();
    } catch {
      authoritative = [];
    }
  }
  for (const row of rows) row.progressAdvanced = progress?.hasAdvanced(row) === true;
  for (const row of rows) {
    const match = failureRecordDisposition(row, authoritative);
    if (match.disposition !== "stalled" && match.disposition !== "stale") continue;
    const durable = reconcileStalledDownloadRecord(
      match.record as DownloadJob,
      failureErrorDetail(row, authoritative),
    );
    if (!durable) row.recordDisagrees = true;
  }
  const disagreeing = reconcileDownloadDoneFailures(rows, authoritative);
  // The advancement proof is producer-internal; recordDisagrees is the only reconciliation
  // result the consumer needs. Do not add the polling detail to the agent event payload.
  for (const row of rows) delete row.progressAdvanced;
  onInject?.({ kind: "download_done", downloads: rows });
  return disagreeing;
}
