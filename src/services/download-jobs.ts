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
import type { ResumeDiagnostic } from "./download-resume-diag.js";
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
  /** This job's OWN resume decision (#467), reported by its physical download via
   *  a callback and stored here — so download_status surfaces exactly this job's
   *  outcome and never a stale/other job's. Absent when no resumable download ran
   *  (Manager dispatch, cache hit, a job that coalesced onto another's stream, or
   *  a failure before streaming). */
  resume?: ResumeDiagnostic;
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
  /** Every registry key this entry is indexed under (request key, and the
   *  destination key when locally resolvable). Kept so a superseding job can
   *  unregister ALL of a stale entry's keys — no orphaned index rows. */
  keys: string[];
}

// The in-flight registry is indexed under MULTIPLE keys per job so dedup is
// ROUTE-INDEPENDENT: a repeated request finds the in-flight job whether or not the
// Manager↔local route flipped between calls (#420 codex round 2). One Entry object
// is shared by all its keys.
const jobs = new Map<string, Entry>();

// Per-DESTINATION-PATH serialization chain (#467 P1-C). Two concurrent jobs for
// the SAME on-disk destination with DIFFERENT auth are (correctly) distinct jobs
// with distinct representations — but they both materialize to that ONE path, and
// each runs post-download work (onComplete) against it. Running them concurrently
// lets one job's writer replace the destination WHILE the other's onComplete reads
// it — so Alice's callback could process Bob's bytes. We serialize by the auth-free
// destination path so each job's download+materialize+onComplete sees ITS OWN bytes
// uninterrupted; the final on-disk file is deterministically the last-started job's
// (inherent: one path can hold one file). Keyed by the resolved targetPath (LOCAL
// downloads only — the Manager writes server-side and has no local race).
const destChains = new Map<string, Promise<void>>();

/**
 * Point `key` at `entry`, ENTRY-SCOPED (#420 codex round 3, rule 2/3): never clobber
 * a row currently owned by a DIFFERENT, still-in-flight writer — that would orphan a
 * live download's index. Records the key on the entry so it can be retired later.
 */
function registerKey(entry: Entry, key: string): void {
  const cur = jobs.get(key);
  if (cur && cur !== entry && cur.job.status === "downloading") return;
  if (!entry.keys.includes(key)) entry.keys.push(key);
  jobs.set(key, entry);
}

/**
 * Retire a superseded (done/error) entry, ENTRY-SCOPED (#420 codex round 3, rule 2):
 * only delete an index row that STILL points at THIS entry, so retiring an older job
 * can never delete a key that has since been reassigned to a newer/live entry.
 */
function retireEntry(entry: Entry): void {
  for (const key of entry.keys) {
    if (jobs.get(key) === entry) jobs.delete(key);
  }
}

/** The tray keys rows on a hash of the SOURCE URL; match it so both agree. */
export function downloadIdFor(url: string): string {
  return createHash("sha256").update(url).digest("hex").slice(0, 16);
}

/**
 * The download's DISTINCT public id — a hash of the given identity string. Callers
 * pass the canonical resolved on-disk `targetPath` PLUS an auth discriminator
 * (#467 P1-A), so identity is the DESTINATION *and representation*: two requests
 * that resolve to the SAME file with the SAME auth are one job/one writer (even
 * from different URLs), but the SAME file with DIFFERENT auth are DIFFERENT
 * downloads (a different representation) and must not dedup. Requests to different
 * destinations are separately pollable via download_status.
 */
export function downloadJobIdFor(identity: string): string {
  return createHash("sha256").update(identity).digest("hex").slice(0, 16);
}

/**
 * ROUTE-INDEPENDENT request key: a canonical, collision-safe JSON-encoded tuple of
 * {url, trimmed subfolder, filename}. Derived ONLY from the request inputs — never
 * from the resolved destination or the chosen route — so a repeated call for the
 * SAME request adopts the in-flight job regardless of a Manager↔local reachability
 * flip between calls (#420 codex round 2). Every job is indexed under this key; a
 * locally-resolvable job is ALSO indexed under its destination key (below) so the
 * "two different URLs → one local destination → one writer" dedup still holds.
 */
/** A stable per-request discriminator for the caller's auth/representation. The
 *  JOB layer dedups BEFORE the header-aware cache layer is reached, and it is
 *  otherwise auth-blind — so without this, two concurrent same-URL+same-dest
 *  calls with DIFFERENT bearer/custom headers would adopt the FIRST job and the
 *  second caller would get the first's bytes AND resume callback (#467 P1-A). The
 *  `auth` param is the per-caller differentiator (config-global tokens are
 *  identical across concurrent calls, so they need not enter the key). Two auth
 *  encodings that transmit the SAME headers may still be split here — harmless:
 *  they then coalesce correctly at the cache layer (same representation). */
function authIdentity(auth?: DownloadAuth): string {
  return auth ? createHash("sha256").update(JSON.stringify(auth)).digest("hex").slice(0, 12) : "";
}

function requestDownloadKey(
  url: string,
  targetSubfolder: string,
  filename?: string,
  auth?: DownloadAuth,
): string {
  const canonical = JSON.stringify([
    url,
    String(targetSubfolder ?? "").trim(),
    filename ?? null,
    authIdentity(auth),
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

  // DEDUP INDEX (route-independent) vs WRITER ROUTE (the single decision above) are
  // deliberately separated (#420 codex round 2). The in-flight lookup/registration
  // is keyed by the REQUEST (url+subfolder+filename), which NEVER changes with the
  // route — so two separate calls for one request with a Manager↔local flip between
  // them still resolve to ONE job (no same-file double-write). When the request is
  // locally resolvable we ALSO index the destination-path key, preserving the
  // "two different URLs → same local destination → one writer" dedup (WS-4). An
  // invalid filename/subfolder is REJECTED here (by resolveDownloadTarget), up
  // front, exactly as the write would reject it.
  const reqKey = requestDownloadKey(url, targetSubfolder, filename, auth);
  let destKey: string | undefined;
  let destPath: string | undefined;
  if (!dispatchToManager) {
    const target = await resolveDownloadTarget(url, targetSubfolder, filename);
    destPath = target.targetPath;
    // Fold auth into the destination key too (#467 P1-A): two concurrent calls to
    // the SAME on-disk destination with DIFFERENT auth are DIFFERENT downloads
    // (different representations) and must NOT dedup to one writer/one job.
    destKey = downloadJobIdFor(`${target.targetPath}\n${authIdentity(auth)}`);
  }
  // The PUBLIC id (download_status handle): the destination key when we have one
  // (so distinct destinations are separately pollable), else the request key.
  const id = destKey ?? reqKey;
  // This call's keys: the route-independent request key, plus the destination key
  // when locally resolvable (two-URLs-one-dest dedup).
  const lookupKeys = destKey ? [reqKey, destKey] : [reqKey];
  const trayId = downloadIdFor(url);

  // ADOPT ONLY AN IN-FLIGHT ENTRY (#420 codex round 3, rule 3): a FINISHED entry
  // under any key is treated as absent — it must never shadow a currently-downloading
  // writer reachable under another key, nor cause a retire that overwrites a live row.
  // Scan every key and prefer an in-flight match.
  let adopted: Entry | undefined;
  for (const k of lookupKeys) {
    const e = jobs.get(k);
    if (e && e.job.status === "downloading") {
      adopted = e;
      break;
    }
  }
  if (adopted) {
    // Re-index THIS call's keys onto the adopted entry (#420 codex round 3, rule 1):
    // when URL B adopts URL A's in-flight job by destination, B's request key must
    // now point at the same entry too — otherwise a later repeat of B (especially
    // after a local→Manager flip that drops the destination key) would miss it and
    // start a second writer onto one file. Entry-scoped, so it can't steal a live row.
    for (const k of lookupKeys) registerKey(adopted, k);
    logger.info(`Download already in flight, adopting it: ${adopted.job.id}`, {
      url,
      target_subfolder: targetSubfolder,
      filename,
    });
    return adopted;
  }
  // No in-flight match. Retire any superseded (done/error) entries shadowing our keys
  // — entry-scoped, so we only clear rows still pointing at that finished entry and
  // never delete a row now owned by a different, live writer (rule 2).
  const retired = new Set<Entry>();
  for (const k of lookupKeys) {
    const e = jobs.get(k);
    if (e && !retired.has(e)) {
      retireEntry(e);
      retired.add(e);
    }
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

  // Serialize behind any in-flight job writing the SAME destination path (#467
  // P1-C) so this job's download+materialize+onComplete run without a concurrent
  // different-auth writer swapping the destination out from under its callback.
  const priorSameDest = destPath ? destChains.get(destPath) : undefined;

  // The promise is stored, never left dangling — an unhandled rejection here
  // would take down the process on a simple 404.
  // The physical download reports its resume decision straight onto THIS job — no
  // shared keyed map, so it can never be misattributed to another job (#467).
  const settled = (async () => {
    // Wait for the prior same-destination job to fully finish (never fail THIS job
    // because that one errored — swallow its result).
    if (priorSameDest) await priorSameDest.catch(() => undefined);
    try {
      const path = await downloadModel(url, targetSubfolder, filename, auth, dispatchToManager, (d) => {
        job.resume = d;
      });
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
    } catch (err: unknown) {
      job.status = "error";
      job.error = err instanceof Error ? err.message : String(err);
      job.finished_at = Date.now();
    }
  })();

  // Make THIS job the tail of its destination's serialization chain, and prune the
  // chain entry once it's the last one to settle (bounded map).
  if (destPath) {
    const key = destPath;
    destChains.set(key, settled);
    void settled.finally(() => {
      if (destChains.get(key) === settled) destChains.delete(key);
    });
  }

  // Index under EVERY key (deduped) so any of them adopts this one writer. Uses the
  // entry-scoped registerKey guard so a fresh registration can never overwrite a row
  // still owned by a different, live writer (rule 3).
  const entry: Entry = { job, settled, keys: [] };
  for (const k of new Set(lookupKeys)) registerKey(entry, k);
  return entry;
}

export function getDownloadJob(id: string): DownloadJob | undefined {
  // The registry indexes each job under its request key and (when local) its
  // destination key; the public id is one of those, so a direct get resolves it.
  return jobs.get(id)?.job;
}

export function listDownloadJobs(): DownloadJob[] {
  // One Entry is indexed under multiple keys — dedup by identity so a job appears
  // once regardless of how many keys point at it.
  const seen = new Set<Entry>();
  const out: DownloadJob[] = [];
  for (const e of jobs.values()) {
    if (seen.has(e)) continue;
    seen.add(e);
    out.push(e.job);
  }
  return out.sort((a, b) => b.started_at - a.started_at);
}

/** Test seam — the registry is process-global otherwise. */
export function resetDownloadJobs(): void {
  jobs.clear();
  destChains.clear();
}
