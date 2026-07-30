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
import { basename } from "node:path";
import { downloadModel } from "./model-resolver.js";
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

/** Normalize a target subfolder to a canonical POSIX-ish form for id hashing:
 *  backslashes → forward slashes, collapsed, no leading/trailing slash. */
function normalizeSubfolder(sub: string): string {
  return sub.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/+|\/+$/g, "");
}

/**
 * Resolve the on-disk filename EXACTLY as downloadModel does, so an omitted
 * filename and an explicit one that equals the URL-derived name map to the SAME
 * file (and thus the same job id) — otherwise two concurrent writers would race
 * one path. Mirrors model-resolver.downloadModel: explicit filename → its
 * basename; else the URL pathname basename; else "model.safetensors".
 */
function resolveDownloadFilename(url: string, filename?: string): string {
  if (filename && filename.trim().length > 0) return basename(filename);
  try {
    return basename(new URL(url).pathname) || "model.safetensors";
  } catch {
    return "model.safetensors";
  }
}

/**
 * DISTINCT public id, keyed on URL AND destination — used as BOTH the registry
 * key and `job.id`. The same URL fetched to two different subfolders/filenames
 * gets two ids, so each is a separate job that download_status can poll
 * individually (the URL-only scheme collapsed them into one, wrote only the
 * first destination, and reported both done). Adoption of an in-flight download
 * therefore requires the SAME target.
 *
 * The tuple is JSON-encoded (NOT space/char-joined) so field boundaries are
 * unambiguous: ("loras foo","bar") and ("loras","foo bar") must NOT collide, and
 * the filename is RESOLVED the same way the write resolves it so omitted ==
 * explicit-URL-basename produces one id (one writer), not two.
 */
export function downloadJobIdFor(
  url: string,
  targetSubfolder: string,
  filename?: string,
): string {
  const canonical = JSON.stringify([
    url,
    normalizeSubfolder(targetSubfolder),
    resolveDownloadFilename(url, filename),
  ]);
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

/**
 * Start a download, or adopt one already running for the same URL+destination.
 *
 * The adoption case matters: the visible symptom of the old bug was "the agent
 * looks stuck", and the natural user response is to ask again. Without this,
 * the second ask starts a SECOND stream onto the same target path — two writers,
 * one file. Returning the in-flight job makes a repeated request harmless. Two
 * requests for the same URL but DIFFERENT destinations are NOT the same job.
 */
export function startDownloadJob(
  url: string,
  targetSubfolder: string,
  filename?: string,
  auth?: DownloadAuth,
  /** Post-download work (sidecars, type checks). Its lines land on `job.notes`
   *  so they reach the user even when the download outlives the tool call. */
  onComplete?: (path: string) => Promise<string[]>,
): Entry {
  const id = downloadJobIdFor(url, targetSubfolder, filename);
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
  const settled = downloadModel(url, targetSubfolder, filename, auth)
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
