/**
 * Background registry for model downloads.
 *
 * `download_model` used to await the whole transfer before returning anything.
 * On a multi-GB checkpoint that left the agent's tool call pending for minutes:
 * the turn stayed alive burning tokens with nothing to say, and when the user
 * forced a message to break the apparent hang, the pending call was cancelled —
 * so the agent reported the download as not done. The stream kept writing to
 * disk regardless, which is the worst version of the bug: the file arrives and
 * the agent tells you it didn't. (Reported in Discord; issue #290.)
 *
 * This registry lets the tool hand back a handle instead of blocking forever,
 * mirroring the move generation already made from a blocking `run_workflow` to
 * `enqueue_workflow` + `get_job_status`.
 */

import { createHash } from "node:crypto";
import {
  downloadModel,
  resolveDownloadTarget,
  shouldDispatchDownloadToManager,
} from "./model-resolver.js";
import type { DownloadAuth } from "./download-auth.js";
import { logger } from "../utils/logger.js";

export interface DownloadJob {
  /** DISTINCT public id, derived from URL AND destination, so the same URL
   *  fetched to two different targets is two separately-pollable jobs
   *  (download_status(id) resolves each independently). Also the registry key. */
  id: string;
  /** The panel tray / progress-file id — a hash of the SOURCE URL only, matching
   *  the row the streaming download writes (readDownloadProgress keys on this).
   *  Kept separate from `id` so distinct-destination jobs still read their live
   *  byte progress from the tray. */
  trayId: string;
  url: string;
  target_subfolder: string;
  filename?: string;
  status: "downloading" | "done" | "error";
  /** Absolute path once the file has landed. */
  path?: string;
  error?: string;
  started_at: number;
  finished_at?: number;
  /** Lines produced by post-download work (trigger words, sidecar paths,
   *  not-a-model warnings). These used to be returned inline by the tool; once a
   *  download outlives its tool call they have to survive somewhere the agent
   *  can still read them, or handing back a handle would silently drop them. */
  notes?: string[];
}

interface Entry {
  job: DownloadJob;
  settled: Promise<void>;
}

const jobs = new Map<string, Entry>();

/** The tray keys rows on a hash of the SOURCE URL; match it so both agree. */
export function downloadIdFor(url: string): string {
  return createHash("sha256").update(url).digest("hex").slice(0, 16);
}

/**
 * The download's DISTINCT public id — a hash of the canonical resolved on-disk
 * `targetPath` (from the shared resolveDownloadTarget), used as BOTH the registry
 * key and `job.id`. Identity is the DESTINATION, not the URL: two requests that
 * resolve to the SAME file are one job/one writer (even from different URLs);
 * requests to different destinations are separately pollable via download_status.
 */
export function downloadJobIdFor(targetPath: string): string {
  return createHash("sha256").update(targetPath).digest("hex").slice(0, 16);
}

/**
 * REMOTE-mode id: there is NO local filesystem to resolve a targetPath from —
 * downloadModel dispatches to the ComfyUI host's Manager, which decides the
 * server-side destination. Key by a canonical, collision-safe JSON-encoded tuple
 * of {url, trimmed subfolder, filename} so field boundaries are unambiguous and a
 * repeated identical request still adopts the in-flight job. (We can't dedupe two
 * DIFFERENT urls aimed at one server-side dest here — the server owns that.)
 */
function remoteDownloadJobIdFor(
  url: string,
  targetSubfolder: string,
  filename?: string,
): string {
  const canonical = JSON.stringify([
    url,
    String(targetSubfolder ?? "").trim(),
    filename ?? null,
  ]);
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

/**
 * Start a download, or adopt one already running for the same on-disk destination.
 *
 * The adoption case matters: the visible symptom of the old bug was "the agent
 * looks stuck", and the natural user response is to ask again. Without this,
 * the second ask starts a SECOND stream onto the same target path — two writers,
 * one file. Returning the in-flight job makes a repeated request harmless.
 *
 * Async because the destination is resolved by the SAME code the write uses
 * (resolveDownloadTarget), so the job is keyed by the exact `targetPath` the file
 * lands at — any two inputs resolving to one file are one job — and an INVALID
 * input (blank / path-ful filename, escaping subfolder) is REJECTED here, up
 * front, exactly as the download itself would reject it (never basename'd into a
 * collision with a valid request). REMOTE mode still resolves a canonical
 * server-side targetPath for identity even though the bytes are fetched by the
 * Manager, so duplicate remote dispatches to one destination also dedupe.
 */
export async function startDownloadJob(
  url: string,
  targetSubfolder: string,
  filename?: string,
  auth?: DownloadAuth,
  /** Post-download work (sidecars, type checks). Its lines land on `job.notes`
   *  so they reach the user even when the download outlives the tool call. */
  onComplete?: (path: string) => Promise<string[]>,
): Promise<Entry> {
  // Identity depends on mode. LOCAL: resolve the canonical on-disk destination
  // with the SAME resolver the write uses (throws on an invalid filename/subfolder
  // — surfaced immediately, matching downloadModel's own rejection — and keys by
  // the exact targetPath so identity is the destination, not the URL). REMOTE:
  // there is NO local filesystem — downloadModel short-circuits to the Manager
  // dispatch, so resolving a local models dir would wrongly THROW (COMFYUI_PATH
  // unset). Key by a canonical remote identity instead and let downloadModel take
  // the Manager path. shouldDispatchDownloadToManager() also covers the #420
  // reconnect case: a nominally-local session whose effective base was lost still
  // routes through the connected Manager (and must NOT try to resolve a local
  // targetPath, which would throw), keying by the same canonical remote identity.
  //
  // CRITICAL: evaluate the route EXACTLY ONCE and thread it into downloadModel
  // below. The predicate awaits live /system_stats and reads mutable base config,
  // so a reconnect/reachability flip between two evaluations would split the job —
  // Manager-key + local-writer (or a duplicate job) for one request (#420 codex
  // round 1). One decision keys the identity AND drives the writer.
  const dispatchToManager = await shouldDispatchDownloadToManager();
  const id = dispatchToManager
    ? remoteDownloadJobIdFor(url, targetSubfolder, filename)
    : downloadJobIdFor((await resolveDownloadTarget(url, targetSubfolder, filename)).targetPath);
  const trayId = downloadIdFor(url);
  const existing = jobs.get(id);
  if (existing && existing.job.status === "downloading") {
    logger.info(`Download already in flight, adopting it: ${id}`, {
      url,
      target_subfolder: targetSubfolder,
      filename,
    });
    return existing;
  }

  const job: DownloadJob = {
    id,
    trayId,
    url,
    target_subfolder: targetSubfolder,
    filename,
    status: "downloading",
    started_at: Date.now(),
  };

  // The promise is stored, never left dangling — an unhandled rejection here
  // would take down the process on a simple 404.
  const settled = downloadModel(url, targetSubfolder, filename, auth, dispatchToManager)
    .then(async (path) => {
      job.path = path;
      if (onComplete) {
        // Post-processing must not turn a landed file into a failed download —
        // the bytes are on disk either way, and reporting "error" here would
        // reproduce the very bug this registry exists to fix.
        try {
          job.notes = await onComplete(path);
        } catch (err) {
          job.notes = [
            `(post-download step failed: ${err instanceof Error ? err.message : String(err)} — the file itself downloaded fine)`,
          ];
        }
      }
      job.status = "done";
      job.finished_at = Date.now();
    })
    .catch((err: unknown) => {
      job.status = "error";
      job.error = err instanceof Error ? err.message : String(err);
      job.finished_at = Date.now();
    });

  const entry: Entry = { job, settled };
  jobs.set(id, entry);
  return entry;
}

export function getDownloadJob(id: string): DownloadJob | undefined {
  // The registry is keyed by the distinct public id (URL+destination), so each
  // destination resolves to its own job.
  return jobs.get(id)?.job;
}

export function listDownloadJobs(): DownloadJob[] {
  return [...jobs.values()]
    .map((e) => e.job)
    .sort((a, b) => b.started_at - a.started_at);
}

/** Test seam — the registry is process-global otherwise. */
export function resetDownloadJobs(): void {
  jobs.clear();
}
