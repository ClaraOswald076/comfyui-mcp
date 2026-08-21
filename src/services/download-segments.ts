// Multi-connection (segmented) body transfer for the model download path (#1697).
//
// WHY THIS EXISTS
// `streamUrlToFile` pulls a multi-GB model over ONE HTTP connection. A single
// TCP flow is bounded by BDP (window / RTT) and, on CDNs, frequently by an
// explicit per-connection rate limit — which is why `aria2c -x4` and
// `hf_transfer` beat a plain client on exactly these files. The owner asked for
// "fast multi channel downloads": this is that, done in-process.
//
// WHY NOT aria2c
// aria2 is NOT a mechanism this package already drives. It appears here only
// inside `docker/runpod/*` (installed into the RunPod image for ComfyUI
// Manager's OWN downloader) and in prose telling agents not to shell out to it.
// Driving a binary from the MCP would mean vendoring it or auto-installing it —
// it is absent by default on Windows, macOS and most Linux images — and would
// give up the panel progress tray, `download_model action:"cancel"`, the download
// cache, the #343/#467 resume validators and the #473 payload sniff, all of which
// live on this path. N ranged `fetch`es cost no new dependency and behave
// identically on Windows, macOS and Linux, because they are the same Node.
//
// SAFETY MODEL — the two things that must not regress
//
// 1. IT MUST NEVER BE THE REASON A DOWNLOAD FAILS. Range support is PROBED with a
//    real request before any file is touched, and the probe is the ONLY place
//    `SegmentedRangeUnsupportedError` can come from. While it runs, the caller
//    still holds its unread single-connection response — so on a refusal the
//    caller streams that response down the ordinary path. The fallback is not a
//    reimplementation of the old path; it IS the old path.
//
// 2. IT MUST NEVER LEAVE A HOLE. Parallel writers fill a file out of order, so at
//    any instant the middle can be unwritten while the size already reads full —
//    and a zero-filled hole under a correct file SIZE is silent corruption, which
//    is strictly worse than the slowness this fixes. So segments are written to a
//    SEPARATE `<target>.seg` file that no resume path knows how to read, and that
//    file reaches `targetPath` only via `rename`:
//      - on success, after every segment has reported exactly its own length and
//        the sum equals the declared total;
//      - on failure/cancel, truncated first to the longest CONTIGUOUS prefix
//        (segment 0's bytes, plus segment 1's only if segment 0 finished, and so
//        on), which is by construction hole-free and therefore range-resumable
//        exactly like a failed single-stream attempt.
//    `targetPath` therefore never contains a hole at any instant, including after
//    a hard kill: a kill leaves the holey bytes in `.seg`, which is not a resume
//    candidate and is truncated away by the next segmented attempt.

import { open, rename, rm, truncate, type FileHandle } from "node:fs/promises";
import { Readable } from "node:stream";
import { ModelError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { abortableDelay, classifyDownloadFailure } from "./download-retry.js";

/** Raised ONLY by `probeSegmentedRanges`, and only before anything is written.
 *  The caller MUST treat it as "use the single-connection response you are still
 *  holding", never as a download failure. */
export class SegmentedRangeUnsupportedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "SegmentedRangeUnsupportedError";
  }
}

export interface Segment {
  /** Absolute offset of this segment's first byte in the finished file. */
  start: number;
  /** Absolute offset of this segment's LAST byte (inclusive, RFC 9110 style). */
  end: number;
}

export interface SegmentedPolicy {
  /** Parallel connections. 1 disables segmentation entirely. */
  connections: number;
  /** Below this many bytes a transfer is not worth splitting — the extra
   *  round-trips cost more than the parallelism returns. */
  minBytes: number;
  /** Attempts per segment before the whole segmented attempt gives up. A blip on
   *  ONE of N connections must not throw away the other N-1's progress. */
  maxAttemptsPerSegment: number;
}

const DEFAULTS: SegmentedPolicy = {
  connections: 4,
  minBytes: 64 * 1024 * 1024,
  maxAttemptsPerSegment: 3,
};

/** Never cut a segment smaller than this; past it the per-request overhead
 *  dominates and more connections stop paying. */
const MIN_SEGMENT_BYTES = 1024 * 1024;

/** How much of a segment to accumulate before issuing one positional `writev`.
 *  See the measurement note in `drainSegmentBody`. */
const SEGMENT_WRITE_BATCH_BYTES = 1024 * 1024;

function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    logger.warn(`Ignoring ${name}="${raw}" — not a number; using ${fallback}.`);
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** Live policy, read per download so a setting change needs no restart. */
export function segmentedDownloadPolicy(): SegmentedPolicy {
  return {
    // 1 disables — the documented escape hatch, mirroring
    // COMFYUI_DOWNLOAD_MAX_ATTEMPTS=1 on the retry policy.
    connections: envInt("COMFYUI_DOWNLOAD_CONNECTIONS", DEFAULTS.connections, 1, 16),
    minBytes:
      envInt("COMFYUI_DOWNLOAD_SEGMENT_MIN_MB", DEFAULTS.minBytes / (1024 * 1024), 1, 65_536) *
      1024 *
      1024,
    maxAttemptsPerSegment: DEFAULTS.maxAttemptsPerSegment,
  };
}

export interface SegmentEligibility {
  /** Final response status. Only a fresh 200 is split — a 206 means we are
   *  resuming a partial and the append path owns the offsets. */
  status: number;
  /** True when this response is being APPENDED to an existing partial. */
  appendMode: boolean;
  /** `Accept-Ranges` on the final response. */
  acceptRanges: string | null;
  /** `Content-Encoding` on the final response. A compressed body's byte offsets
   *  are offsets into the ENCODED octets; splitting one and writing the pieces
   *  as-is would produce a file the decoder never sees whole. */
  contentEncoding: string | null;
  /** The final response's OWN Content-Length. */
  contentLength: number;
  /** The size the caller will verify the finished file against. Must agree with
   *  `contentLength`: when Hugging Face's X-Linked-Size exceeds the CDN's
   *  Content-Length (#467's truncating-proxy case) we do not know which one the
   *  ranges are indexed against, so we decline and let the single-stream path
   *  apply its own understatement guard. */
  expectedTotal: number;
  /** Did the REQUEST already carry a Range (a resume)? Then the offsets in this
   *  response are relative to that request and are not ours to re-cut. */
  requestHadRange: boolean;
  policy: SegmentedPolicy;
}

/**
 * Decide whether this response may be re-fetched as N ranges, and cut the ranges.
 *
 * Pure and total: returns `null` for every case that must fall through to the
 * single-connection path. Kept separate from the transfer so the eligibility
 * rules can be tested without a socket.
 */
export function planSegments(e: SegmentEligibility): Segment[] | null {
  if (e.policy.connections <= 1) return null;
  if (e.status !== 200) return null;
  if (e.appendMode) return null;
  if (e.requestHadRange) return null;
  if ((e.acceptRanges || "").trim().toLowerCase() !== "bytes") return null;
  const enc = (e.contentEncoding || "").trim().toLowerCase();
  if (enc && enc !== "identity") return null;
  if (!Number.isFinite(e.contentLength) || e.contentLength < e.policy.minBytes) return null;
  // The two totals must agree, or we do not know what the ranges index.
  if (e.expectedTotal !== e.contentLength) return null;

  const total = e.contentLength;
  const connections = Math.max(
    1,
    Math.min(e.policy.connections, Math.floor(total / MIN_SEGMENT_BYTES)),
  );
  if (connections <= 1) return null;

  const per = Math.floor(total / connections);
  const segments: Segment[] = [];
  for (let i = 0; i < connections; i += 1) {
    const start = i * per;
    // The last segment absorbs the remainder, so the union is exactly [0, total).
    const end = i === connections - 1 ? total - 1 : start + per - 1;
    segments.push({ start, end });
  }
  return segments;
}

/** Parse `Content-Range: bytes <start>-<end>/<total>` strictly. Anything else
 *  (including a `*` total, or a unit other than bytes) is a refusal. */
export function parseContentRange(
  value: string | null,
): { start: number; end: number; total: number } | null {
  const m = /^bytes\s+(\d+)-(\d+)\/(\d+)$/.exec((value || "").trim());
  if (!m) return null;
  const start = Number(m[1]);
  const end = Number(m[2]);
  const total = Number(m[3]);
  if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(total)) return null;
  if (end < start || total <= end) return null;
  return { start, end, total };
}

export interface SegmentedRunOptions {
  /** The FINAL (post-redirect) URL the single-connection response came from. */
  url: string;
  /** The headers that produced that response — already stripped of credentials
   *  on a cross-origin hop by the caller, so a segment request carries exactly
   *  what the accepted single-connection request carried. */
  headers: Record<string, string>;
  /** The staged `.partial` (or exclusive temp) the caller streams into. Reached
   *  ONLY by the final rename; see the hole invariant at the top of this file. */
  targetPath: string;
  totalBytes: number;
  segments: Segment[];
  signal?: AbortSignal;
  /** Redacted URL for logs/errors. */
  logUrl: string;
  /** Every byte that reaches disk, from every segment — the SAME sink the
   *  single-connection counter feeds, so the panel tray and the #470 stall
   *  watchdog behave identically on both paths. */
  onBytes?: (delta: number) => void;
  maxAttemptsPerSegment?: number;
  /** Test seam. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/** A proven-range-capable server plus the response that proved it. */
export interface SegmentedProbe {
  segments: Segment[];
  /** Index of the segment whose response is held in `response`. */
  index: number;
  response: Response;
  totalBytes: number;
}

export interface SegmentedRunResult {
  connections: number;
  bytesWritten: number;
}

/** The `.seg` scratch file for a staged target. Exported so tests assert on the
 *  writer's own derivation rather than re-implementing the name. */
export function segmentScratchPath(targetPath: string): string {
  return `${targetPath}.seg`;
}

function abortError(): DOMException {
  return new DOMException("The download was cancelled.", "AbortError");
}

/**
 * Ask the server for ONE segment's range and require a well-formed 206.
 *
 * Touches no file. This is the only source of `SegmentedRangeUnsupportedError`,
 * and the caller runs it while it still holds an unread single-connection
 * response — so a refusal costs one request and nothing else.
 *
 * Segment 1 (not 0) is probed on purpose: a server that ignores `Range` answers
 * `bytes=0-...` with a 200 whose bytes are indistinguishable from a correct
 * segment 0, so probing the first segment could not tell the two apart. A
 * non-zero start cannot be faked — either the response is a 206 whose
 * Content-Range says so, or it is not usable.
 */
export async function probeSegmentedRanges(
  opts: Omit<SegmentedRunOptions, "onBytes" | "maxAttemptsPerSegment">,
): Promise<SegmentedProbe> {
  if (opts.segments.length < 2) {
    throw new SegmentedRangeUnsupportedError("fewer than two segments to fetch");
  }
  if (opts.signal?.aborted) throw abortError();
  const doFetch = opts.fetchImpl ?? fetch;
  const index = 1;
  const seg = opts.segments[index];

  let res: Response;
  try {
    res = await doFetch(opts.url, {
      headers: { ...opts.headers, Range: `bytes=${seg.start}-${seg.end}` },
      redirect: "manual",
      signal: opts.signal,
    });
  } catch (err) {
    if (opts.signal?.aborted) throw err;
    // Even a transport failure on the probe is a FALLBACK, not a failure: the
    // caller's single-connection response is alive and can still deliver the file.
    throw new SegmentedRangeUnsupportedError(
      `the range probe could not be issued: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (res.status !== 206) {
    await res.body?.cancel().catch(() => {});
    throw new SegmentedRangeUnsupportedError(
      `the server answered a Range request with ${res.status} instead of 206`,
    );
  }
  const cr = parseContentRange(res.headers.get("content-range"));
  if (!cr || cr.start !== seg.start || cr.end !== seg.end || cr.total !== opts.totalBytes) {
    await res.body?.cancel().catch(() => {});
    throw new SegmentedRangeUnsupportedError(
      `the server answered a Range request with Content-Range ` +
        `"${res.headers.get("content-range")}", which does not match the requested ` +
        `bytes=${seg.start}-${seg.end}/${opts.totalBytes}`,
    );
  }
  if (!res.body) {
    throw new SegmentedRangeUnsupportedError("the server answered a Range request with no body");
  }
  return { segments: opts.segments, index, response: res, totalBytes: opts.totalBytes };
}

/**
 * Open the scratch file for a positional write.
 *
 * The staged `.partial` is SHARED — a second process running the same download
 * names the same path (that is what `stagedFileIsShared` is about) — so it names
 * the same `.seg` too, and whichever process finishes first renames it away
 * underneath the other. Left as a raw ENOENT that reads as a corrupt install and
 * is not retryable, so the loser's download would fail outright where it used to
 * succeed. Report it as what it is: interference, and retryable — the retry finds
 * the winner's file already in the cache.
 */
function scratchTakenError(opts: SegmentedRunOptions): ModelError {
  return new ModelError(
    `Another process finished staging this download and took the staged file. ` +
      `Nothing was corrupted; retry to pick up its result.`,
    { url: opts.logUrl, retryable: true },
  );
}

async function openScratch(opts: SegmentedRunOptions): Promise<FileHandle> {
  try {
    return await open(segmentScratchPath(opts.targetPath), "r+");
  } catch (err) {
    // The loser opened it AFTER the winner renamed it away.
    if ((err as { code?: string })?.code === "ENOENT") throw scratchTakenError(opts);
    throw err;
  }
}

/** Drop the first `n` bytes from a buffer list, so a short `writev` can be
 *  resumed from exactly where the OS stopped. */
export function dropWritten(buffers: Buffer[], n: number): Buffer[] {
  let skip = n;
  const out: Buffer[] = [];
  for (const b of buffers) {
    if (skip >= b.length) {
      skip -= b.length;
      continue;
    }
    out.push(skip > 0 ? b.subarray(skip) : b);
    skip = 0;
  }
  return out;
}

/** Drain one 206 body into the scratch file at its absolute offset, advancing
 *  `state.written` as bytes land so a retry resumes mid-segment and a failure
 *  can be truncated to a contiguous prefix. */
async function drainSegmentBody(
  opts: SegmentedRunOptions,
  res: Response,
  seg: Segment,
  state: { written: number },
  index: number,
): Promise<void> {
  const length = seg.end - seg.start + 1;
  const fh = await openScratch(opts);

  // Coalesce arriving chunks into one positional `writev` rather than issuing an
  // awaited write per ~64 KiB chunk. MEASURED on an out-of-process loopback
  // origin, 512 MiB, arms alternating: a write per chunk ran 0.63x a single
  // sequential stream, 1 MiB batches run 0.84x, and 4 MiB batches fall back to
  // 0.52x. 1 MiB is the measured optimum, not a guess.
  //
  // This is NOT a stream highWaterMark and adds no pipeline stage — #1738/#1746
  // stay closed. It changes how many syscalls a segment issues, nothing about
  // how the single-connection pipe is buffered.
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  // Bytes count as WRITTEN only once they are on disk. Buffered-but-unflushed
  // bytes must never advance `state.written`, or a failure would truncate to a
  // "contiguous prefix" containing bytes the file does not hold — the very hole
  // this module exists to prevent.
  const flush = async (): Promise<void> => {
    if (pendingBytes === 0) return;
    let buffers = pending;
    let remaining = pendingBytes;
    pending = [];
    pendingBytes = 0;
    // LOOP ON SHORT WRITES. `filehandle.writev`/`write` resolve with the number
    // of bytes the OS actually took and do NOT retry a short write (only
    // `writeFile` does). Advancing `state.written` by the requested count would
    // let the counter run ahead of the file, and then every guard in this module
    // reads the counter: the next write would start past an unwritten gap, a
    // retry's Range would skip it, `written === length` and the total and
    // `assertComplete`'s stat() would all pass, and `contiguousPrefix` would
    // publish a "resumable prefix" with a hole inside it. Advance ONLY by what
    // landed. (The single-connection path never had this: `createWriteStream`
    // loops internally.)
    while (remaining > 0) {
      const { bytesWritten } = await fh.writev(buffers, seg.start + state.written);
      // Fail closed on BOTH directions of a nonsensical count. Zero would spin
      // forever; more than we offered would advance `state.written` past what the
      // file holds, which is the same over-reporting bug by another route — and
      // clamping it would hide a misbehaving filesystem rather than surface it.
      if (!(bytesWritten > 0) || bytesWritten > remaining) {
        throw new ModelError(
          `Download segment ${index} could not write to the staging file (the filesystem reported ` +
            `${bytesWritten} of ${remaining} bytes). Not finalizing.`,
          { url: opts.logUrl, retryable: true },
        );
      }
      state.written += bytesWritten;
      remaining -= bytesWritten;
      if (remaining > 0) buffers = dropWritten(buffers, bytesWritten);
    }
  };
  let nodeBody: Readable | undefined;
  try {
    nodeBody = Readable.fromWeb(res.body as import("node:stream/web").ReadableStream);
    for await (const chunk of nodeBody) {
      if (opts.signal?.aborted) throw abortError();
      const buf = chunk as Buffer;
      // Refuse to write past this segment's own range. A server that streams
      // more than its Content-Range promised would otherwise overwrite the NEXT
      // segment's bytes, producing a plausible size and no error.
      if (state.written + pendingBytes + buf.length > length) {
        throw new ModelError(
          `Download segment ${index} oversized: the server sent more than the ${length} bytes ` +
            `its Content-Range promised. Not finalizing.`,
          { url: opts.logUrl },
        );
      }
      pending.push(buf);
      pendingBytes += buf.length;
      // Report on ARRIVAL, not on flush, so the #470 stall watchdog sees liveness
      // at chunk granularity rather than in batch-sized steps.
      opts.onBytes?.(buf.length);
      if (pendingBytes >= SEGMENT_WRITE_BATCH_BYTES) await flush();
    }
    await flush();
  } finally {
    // Release this response on EVERY exit, not just a fully-drained one. A
    // retryable failure part-way through leaves the body unread, and attempt 2
    // opens a new socket while this one stays pinned until GC — the same leak
    // fixed on the probe-setup path.
    nodeBody?.destroy();
    await fh.close().catch(() => {});
  }
  if (state.written !== length) {
    throw new ModelError(
      `Download segment ${index} truncated: wrote ${state.written} of ${length} bytes — the ` +
        `stream ended early.`,
      { url: opts.logUrl, retryable: true },
    );
  }
}

/** Fetch a segment's REMAINING range and drain it. Used for every segment except
 *  the probe's first attempt, and for every retry (including the probe's). */
async function fetchSegmentOnce(
  opts: SegmentedRunOptions,
  seg: Segment,
  state: { written: number },
  index: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  const doFetch = opts.fetchImpl ?? fetch;
  const length = seg.end - seg.start + 1;
  if (state.written >= length) return;
  const from = seg.start + state.written;

  const res = await doFetch(opts.url, {
    headers: { ...opts.headers, Range: `bytes=${from}-${seg.end}` },
    redirect: "manual",
    signal,
  });
  if (res.status !== 206) {
    await res.body?.cancel().catch(() => {});
    // Mid-run this is NOT a fallback signal — the caller's single-connection
    // response is long gone and other segments already hold bytes. Fail the
    // attempt; the outer retry loop re-probes from scratch, and if the server has
    // genuinely stopped honouring ranges that probe falls back to one connection.
    throw new ModelError(
      `Download segment ${index} was answered with ${res.status} instead of 206 for ` +
        `Range bytes=${from}-${seg.end} — the server stopped honouring byte ranges mid-transfer. ` +
        `Not finalizing; retry.`,
      { url: opts.logUrl, retryable: true },
    );
  }
  const cr = parseContentRange(res.headers.get("content-range"));
  if (!cr || cr.start !== from || cr.end !== seg.end || cr.total !== opts.totalBytes) {
    await res.body?.cancel().catch(() => {});
    throw new ModelError(
      `Download segment ${index} was answered with Content-Range ` +
        `"${res.headers.get("content-range")}" for a requested bytes=${from}-${seg.end}/` +
        `${opts.totalBytes}. Not finalizing; retry.`,
      { url: opts.logUrl, retryable: true },
    );
  }
  if (!res.body) {
    throw new ModelError(`Download segment ${index} returned a 206 with no body.`, {
      url: opts.logUrl,
      retryable: true,
    });
  }
  await drainSegmentBody(opts, res, seg, state, index);
}

/** Longest prefix of the file that is provably written, with no hole. */
export function contiguousPrefix(
  segments: Segment[],
  states: ReadonlyArray<{ written: number }>,
): number {
  let prefix = 0;
  for (let i = 0; i < segments.length; i += 1) {
    const length = segments[i].end - segments[i].start + 1;
    prefix += states[i].written;
    if (states[i].written < length) break;
  }
  return prefix;
}

/**
 * Transfer `probe.segments` in parallel into `targetPath`.
 *
 * Never throws `SegmentedRangeUnsupportedError` — by the time this runs, ranges
 * are proven and the caller's single-connection response has been released, so
 * there is nothing to fall back to. Every throw is a real download failure, with
 * `targetPath` left holding a hole-free, resumable prefix.
 */
export async function runSegmentedDownload(
  opts: SegmentedRunOptions,
  probe: SegmentedProbe,
): Promise<SegmentedRunResult> {
  const segments = probe.segments;
  const scratch = segmentScratchPath(opts.targetPath);
  const maxAttempts = Math.max(1, opts.maxAttemptsPerSegment ?? DEFAULTS.maxAttemptsPerSegment);
  const states: Array<{ written: number }> = segments.map(() => ({ written: 0 }));

  // Stop the other connections the instant one segment gives up, so a failure
  // does not sit waiting for gigabytes it is going to discard. Linked to the
  // caller's signal so a user cancel still propagates.
  const abandon = new AbortController();
  const signal = opts.signal
    ? AbortSignal.any([opts.signal, abandon.signal])
    : abandon.signal;

  try {
    // `open(..., "w")` creates AND truncates, discarding any `.seg` a killed run
    // left behind. Nothing else reads that name, so this is unconditional.
    const created = await open(scratch, "w");
    await created.close();

    // Drop any stale bytes at the target NOW, exactly when the single-connection
    // path's `flags: "w"` would have truncated them. Without this, a restart over
    // a large existing `.partial` would hold the old bytes AND the growing `.seg`
    // at once — up to double the peak disk the volume-space check upstream
    // reserved.
    // ENOENT only: a fresh download has no target yet, and that is the one
    // failure this may ignore. Swallowing anything else (a target that exists and
    // cannot be truncated) would silently re-introduce the double-disk case the
    // truncate exists to prevent.
    await truncate(opts.targetPath, 0).catch((err: unknown) => {
      if ((err as { code?: string })?.code !== "ENOENT") throw err;
    });
  } catch (err) {
    // Nothing has read the probe's 206 yet, and nobody downstream will — release
    // its socket rather than leaving it pinned until GC.
    await probe.response.body?.cancel().catch(() => {});
    throw err;
  }

  let firstFailure: unknown;

  const runSegment = async (index: number): Promise<void> => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        if (index === probe.index && attempt === 1) {
          await drainSegmentBody(opts, probe.response, segments[index], states[index], index);
        } else {
          await fetchSegmentOnce(opts, segments[index], states[index], index, signal);
        }
        return;
      } catch (err) {
        // A user cancel is never retried. Neither is a sibling-triggered abort:
        // some other segment has already failed for a real reason.
        if (opts.signal?.aborted || abandon.signal.aborted) throw err;
        const { retryable, reason } = classifyDownloadFailure(err);
        if (!retryable || attempt >= maxAttempts) throw err;
        logger.warn(
          `Download segment ${index} attempt ${attempt} failed (${reason}); resuming this ` +
            `segment from byte ${states[index].written} of ` +
            `${segments[index].end - segments[index].start + 1}.`,
        );
        await abortableDelay(Math.min(2000, 250 * 2 ** (attempt - 1)), signal);
      }
    }
  };

  try {
    // `allSettled`, not `all`: with `all` the first rejection returns while the
    // other connections are still writing into `.seg`, and the failure cleanup
    // below would truncate the file underneath live writers.
    const settled = await Promise.allSettled(
      segments.map((_, i) =>
        runSegment(i).catch((err) => {
          if (firstFailure === undefined) {
            firstFailure = err;
            abandon.abort();
          }
          throw err;
        }),
      ),
    );
    if (firstFailure !== undefined) throw firstFailure;
    const stillRejected = settled.find((s) => s.status === "rejected");
    if (stillRejected && stillRejected.status === "rejected") throw stillRejected.reason;

    // Belt and braces on the hole invariant: every segment must have reported
    // EXACTLY its own length, and the sum must be the declared total. The stat()
    // the caller runs afterwards can only see a SIZE, which a hole does not
    // change — this is the check a hole cannot pass.
    for (let i = 0; i < segments.length; i += 1) {
      const length = segments[i].end - segments[i].start + 1;
      if (states[i].written !== length) {
        throw new ModelError(
          `Download segment ${i} incomplete: ${states[i].written} of ${length} bytes. ` +
            `Not finalizing.`,
          { url: opts.logUrl, retryable: true },
        );
      }
    }
    const bytesWritten = states.reduce((a, s) => a + s.written, 0);
    if (bytesWritten !== opts.totalBytes) {
      throw new ModelError(
        `Segmented download wrote ${bytesWritten} bytes but the file is ${opts.totalBytes}. ` +
          `Not finalizing.`,
        { url: opts.logUrl, retryable: true },
      );
    }
    try {
      await rename(scratch, opts.targetPath);
    } catch (err) {
      // The loser held its handles open across the winner's rename and only found
      // the scratch gone at the end. Same interference, same retryable verdict.
      if ((err as { code?: string })?.code === "ENOENT") throw scratchTakenError(opts);
      throw err;
    }
    abandon.abort();
    return { connections: segments.length, bytesWritten };
  } catch (err) {
    // Keep only the hole-free prefix and publish it under the resumable name, so
    // a failed or cancelled segmented attempt leaves exactly what a failed
    // single-connection attempt leaves: a valid prefix its `.etag` sidecar
    // describes.
    try {
      await truncate(scratch, contiguousPrefix(segments, states));
      await rename(scratch, opts.targetPath);
    } catch (cleanupErr) {
      logger.warn(
        `Could not preserve the segmented download's partial prefix for ${opts.logUrl}: ` +
          `${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`,
      );
      await rm(scratch, { force: true }).catch(() => {});
    }
    throw err;
  }
}
