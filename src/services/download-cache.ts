import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  copyFile,
  link,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ModelError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { redactUrlForLogs } from "./download-auth.js";
import { reportDownloadProgress, type DownloadProgress } from "./download-progress.js";
import {
  downloadCloudUrlToFile,
  supportsCloudDownload,
  type CloudStorageAuth,
} from "./storage/index.js";

const DEFAULT_CACHE_DIR = join(homedir(), ".comfyui-mcp", "cache");
const HASH_CHARS = 32;
const MAX_HTTP_REDIRECTS = 5;
const inflight = new Map<string, Promise<string>>();

/** Best-effort remove — never throws (rm may be stubbed in tests, or the file
 *  may already be gone). Used on the integrity-failure cleanup paths. */
async function safeRm(path: string): Promise<void> {
  try {
    await rm(path, { force: true });
  } catch {
    /* best effort */
  }
}

/** On-disk size, or undefined when it can't be determined (fs layer stubbed in
 *  tests, or a stat hiccup) — callers must not block a download over a missing
 *  number, only over a number that proves corruption. */
async function fileSizeOrUndefined(path: string): Promise<number | undefined> {
  try {
    const st = await stat(path);
    return typeof st?.size === "number" ? st.size : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Extract the useful diagnostic bits from an error thrown by `fetch()` itself
 * (a network-layer failure, not an HTTP status). undici surfaces these as
 * `TypeError: fetch failed` whose real reason lives on `.cause` (an Error with
 * a `code`/`errno` such as ENOTFOUND, ECONNRESET, UND_ERR_CONNECT_TIMEOUT, or
 * a TLS `ERR_TLS_CERT_ALTNAME_INVALID`). The top-level message is the useless
 * generic "fetch failed" (issue #411) — the actionable detail is one level
 * down, so unwrap the cause chain into a single readable string.
 */
function describeFetchError(err: unknown): { message: string; code?: string } {
  const parts: string[] = [];
  let code: string | undefined;
  let cur: unknown = err;
  const seen = new Set<unknown>();
  while (cur instanceof Error && !seen.has(cur)) {
    seen.add(cur);
    const c = (cur as { code?: unknown }).code;
    if (typeof c === "string" && !code) code = c;
    const label = typeof c === "string" ? `${cur.message} (${c})` : cur.message;
    if (label && !parts.includes(label)) parts.push(label);
    cur = (cur as { cause?: unknown }).cause;
  }
  if (parts.length === 0) parts.push(String(err));
  return { message: parts.join(": "), code };
}

/**
 * Fetch that converts a network-layer failure into a ModelError carrying the
 * unwrapped `cause` — so a Hugging Face Xet / CAS host that fails DNS, TLS, a
 * connect timeout, or a proxy reset reports WHY instead of a bare "fetch
 * failed" (issue #411). HTTP responses (any status) pass straight through; only
 * a thrown fetch is wrapped. The ModelError is rethrown as-is by downloadWithCache
 * (it never masks a ModelError), so the actionable cause reaches the tool result.
 */
async function fetchOrThrow(
  url: string,
  init: RequestInit,
  logUrl: string,
): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (err) {
    const { message, code } = describeFetchError(err);
    throw new ModelError(
      `Download request to the model host failed at the network layer: ${message}. ` +
        `This is a connectivity/TLS/proxy failure reaching the file host (for Hugging Face ` +
        `this is often the Xet/CAS CDN, e.g. cas-bridge.xethub.hf.co) — not an HTTP error. ` +
        `Check DNS/connectivity to the host, any corporate proxy or firewall, and system time/TLS certs; ` +
        `set HF_ENDPOINT to a reachable mirror if huggingface.co is blocked in your region, then retry.`,
      { url: logUrl, code, cause: message },
    );
  }
}

export const downloadCacheFs = {
  copyFile,
  link,
  mkdir,
  readdir,
  rename,
  rm,
  stat,
  utimes,
};

/** Identifies a download for the panel progress tray (id = stable key, name =
 *  the friendly file name). Absent for internal/cache-only callers. */
export interface ProgressMeta {
  id: string;
  name: string;
}

export interface DownloadCacheOptions {
  url: string;
  headers: Record<string, string>;
  targetPath: string;
  logUrl?: string;
  storageAuth?: CloudStorageAuth;
  progress?: ProgressMeta;
}

export interface DownloadCacheResult {
  targetPath: string;
  usedCache: boolean;
  cachePath?: string;
  materializedBy?: "hardlink" | "copy";
}

function cacheDir(): string {
  return resolve(process.env.COMFYUI_DOWNLOAD_CACHE_DIR || DEFAULT_CACHE_DIR);
}

function cacheSizeLimitBytes(): number {
  const raw = Number(process.env.COMFYUI_LRU_CACHE_SIZE_GB ?? "0");
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return raw * 1024 * 1024 * 1024;
}

function cachePathForUrl(url: string): string {
  const hash = createHash("sha256").update(url).digest("hex").slice(0, HASH_CHARS);
  let extension = "";
  try {
    extension = extname(basename(new URL(url).pathname));
  } catch {
    // Callers validate URLs before reaching this layer; keep the cache helper
    // defensive so fallback direct downloads can still surface the real error.
  }
  return join(cacheDir(), `${hash}${extension}`);
}

async function touch(path: string): Promise<void> {
  const now = new Date();
  await downloadCacheFs.utimes(path, now, now);
}

/** Read a persisted resume validator (ETag / Last-Modified) or null if absent.
 *  Best-effort: a missing/unreadable sidecar just means "resume without an
 *  If-Range guard" — never fatal. */
async function readValidatorSidecar(path: string): Promise<string | null> {
  try {
    const raw = (await readFile(path, "utf-8")).trim();
    return raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

/** Persist the resume validator next to a .partial. Best-effort — a failure
 *  here only costs us the change-detection guard on a later resume. */
async function writeValidatorSidecar(path: string, value: string): Promise<void> {
  try {
    await writeFile(path, value, "utf-8");
  } catch {
    /* best effort */
  }
}

/** The strongest resume validator a response can offer, preferring Hugging
 *  Face's content-addressed `X-Linked-Etag` (the LFS/Xet object hash — carried
 *  on the huggingface.co/resolve 302, NOT on the CAS CDN's final 200) over a
 *  plain ETag, falling back to Last-Modified. Capturing X-Linked-Etag from the
 *  redirect is what lets HF Xet downloads persist a sidecar at all (#467): the
 *  final CAS response returns neither ETag nor Last-Modified, so without this a
 *  Xet partial could NEVER be safely resumed. */
function extractValidator(res: Response): string | null {
  return (
    res.headers.get("x-linked-etag") ||
    res.headers.get("etag") ||
    res.headers.get("last-modified")
  );
}

/**
 * Why a resume was (or wasn't) taken on the most recent attempt for a given
 * source URL. Recorded in-process so `download_status` — which runs in the SAME
 * MCP server process as the streaming download — can tell the agent/user that a
 * multi-GB `.partial` was discarded and WHY, instead of a silent full
 * re-download (#467). Keyed by the tray id (a 16-hex hash of the source URL),
 * matching DownloadJob.trayId so the status tool can look it up directly.
 */
export type ResumeOutcome =
  | "resumed"
  | "declined:no-validator"
  | "declined:etag-changed";

export interface ResumeDiagnostic {
  outcome: ResumeOutcome;
  /** Bytes of pre-existing `.partial` discarded on a declined resume (0 when the
   *  resume was taken). */
  discardedBytes: number;
  /** Epoch ms this decision was made. */
  at: number;
}

const resumeDiagnostics = new Map<string, ResumeDiagnostic>();

/** Tray id for a source URL — MUST match download-jobs' downloadIdFor so
 *  download_status can key a diagnostic off the job it already holds. */
function trayIdForUrl(url: string): string {
  return createHash("sha256").update(url).digest("hex").slice(0, 16);
}

function recordResumeDiagnostic(
  url: string,
  outcome: ResumeOutcome,
  discardedBytes: number,
): void {
  resumeDiagnostics.set(trayIdForUrl(url), { outcome, discardedBytes, at: Date.now() });
}

/** Read the last resume decision for a download's tray id (or undefined). */
export function getResumeDiagnostic(trayId: string): ResumeDiagnostic | undefined {
  return resumeDiagnostics.get(trayId);
}

/** Test seam — the diagnostics map is process-global otherwise. */
export function resetResumeDiagnostics(): void {
  resumeDiagnostics.clear();
}

async function streamUrlToFile(
  url: string,
  targetPath: string,
  headers: Record<string, string>,
  logUrl = redactUrlForLogs(url),
  storageAuth: CloudStorageAuth = {},
  resumeFromBytes = 0,
  progress?: ProgressMeta,
  resumable = false,
): Promise<void> {
  if (supportsCloudDownload(url)) {
    await downloadCloudUrlToFile(url, targetPath, storageAuth);
    // #343 edge: the S3/Azure path bypasses the HTTP size gate below. The cloud
    // downloaders verify their own Content-Length (truncation), but a stream
    // that yielded ZERO bytes can still resolve cleanly — backstop it here so a
    // 0-byte cloud object can never be reported as a successful download.
    const actual = await fileSizeOrUndefined(targetPath);
    if (actual === 0) {
      await safeRm(targetPath);
      throw new ModelError(
        "Download produced a 0-byte file — the cloud source (S3/Azure) sent no data. Removed it; retry.",
        { url: logUrl },
      );
    }
    return;
  }

  // Resumable downloads: when a partial file exists at targetPath we ask the
  // server for the remaining bytes via Range. If the server returns 206 with
  // matching Content-Range we append; if it returns 200 (range unsupported,
  // or the file changed upstream) we truncate and restart. Idea from
  // josephoibrahim/comfy-cozy.
  //
  // #343 edge: a plain Range resume is unsafe if the upstream file CHANGED
  // between the two calls — we would append fresh bytes onto a stale prefix and
  // the size check could still pass, producing a corrupt file. Guard it with a
  // conditional resume: we persist the first response's validator (ETag, else
  // Last-Modified) in a sidecar next to the .partial and replay it as `If-Range`
  // on resume. Per RFC 9110 the server then returns 206 (append) ONLY if the
  // resource is byte-for-byte unchanged, otherwise 200 with the full body (which
  // our append-vs-truncate logic below restarts cleanly). Belt-and-braces, we
  // also validate the 206 Content-Range starts exactly at our resume offset.
  const validatorSidecar = `${targetPath}.etag`;
  let currentUrl = url;
  let currentHeaders = headers;
  // How many bytes we will actually attempt to resume from. A resume is only
  // SAFE when we can prove the upstream file is unchanged, which requires the
  // validator (ETag/Last-Modified) we persisted on the first attempt. Without a
  // sidecar — a stale partial from a pre-fix build, or a server that sent no
  // validator — we cannot detect a changed file, so we must NOT append: fall
  // back to a clean restart (Range omitted, the "w" flag truncates the partial).
  let effectiveResume = resumeFromBytes;
  // Did we actually ask the server to resume (Range + If-Range)? Used after the
  // response to distinguish a taken resume (206) from an If-Range MISS (200 =
  // upstream changed) so we can surface WHY the partial was discarded (#467).
  let requestedResume = false;
  // The persisted content-addressed validator we are resuming AGAINST — kept so
  // we can re-compare it to the value the resolve redirect reports NOW, and
  // refuse the append ourselves if they differ (belt-and-braces on top of the
  // origin's If-Range: we never trust a CAS 206 whose upstream object changed).
  let priorValidator: string | null = null;
  if (resumeFromBytes > 0) {
    priorValidator = resumable
      ? await readValidatorSidecar(validatorSidecar)
      : null;
    if (priorValidator) {
      currentHeaders = {
        ...currentHeaders,
        Range: `bytes=${resumeFromBytes}-`,
        "If-Range": priorValidator,
      };
      requestedResume = true;
    } else {
      // No trustworthy validator → discard the un-verifiable partial state. This
      // is the deliberate #343 safety fallback, but it used to be SILENT: a
      // multi-GB HF Xet partial (whose CAS CDN sent no ETag/Last-Modified, so no
      // sidecar was ever written) got thrown away and re-downloaded from 0 with
      // no log and no signal to the agent (#467). Log it AND record a diagnostic
      // download_status can surface.
      effectiveResume = 0;
      logger.warn(
        `Discarding a ${resumeFromBytes}-byte partial download and restarting from 0: no ` +
          `ETag/Last-Modified validator was ever persisted for it, so a safe resume can't be ` +
          `verified (common on Hugging Face's Xet/CAS CDN, which omits both headers on the file ` +
          `body). This is the safety-first behavior — an unverifiable resume risks a corrupt ` +
          `file (#343). Future downloads capture the validator from the resolve redirect so they ` +
          `CAN resume.`,
        { url: logUrl, discardedBytes: resumeFromBytes },
      );
      if (resumable) recordResumeDiagnostic(url, "declined:no-validator", resumeFromBytes);
    }
  }
  // The content-addressed validator captured from the resolve REDIRECT (HF's
  // 302 carries X-Linked-Etag — the file's LFS/Xet content hash — even though
  // the final CAS 200 carries no validator). Strictly X-Linked-Etag: a generic
  // ETag/Last-Modified on a 3xx describes the redirect/pointer resource, NOT the
  // target file, so it must never be promoted to the file's validator. Used
  // both as the sidecar fallback (so Xet downloads become resumable) AND as the
  // resume-time change check below (#467).
  let redirectValidator: string | null = null;
  // Did the bytes ultimately come from a DIFFERENT origin than we requested (HF
  // resolve → CAS CDN)? A cross-origin 206 can't lean on the requesting origin's
  // If-Range — the CDN may honor a stale Range and 206 a CHANGED object — so a
  // cross-origin resume append MUST independently prove the content is unchanged
  // via the content-addressed X-Linked-Etag (#467/#343).
  let crossOriginRedirect = false;
  let res: Response;
  for (let redirectCount = 0; ; redirectCount += 1) {
    res = await fetchOrThrow(
      currentUrl,
      { headers: currentHeaders, redirect: "manual" },
      currentUrl === url ? logUrl : redactUrlForLogs(currentUrl),
    );
    if (res.status < 300 || res.status >= 400) break;

    // Capture the content-addressed resume validator off the redirect itself.
    // HF's resolve URL 302s to the CAS CDN and carries X-Linked-Etag (the LFS/Xet
    // object hash) on the 302; the final CAS 200 carries NO validator. Without
    // this, Xet downloads never persisted a sidecar and could never resume (#467).
    // ONLY X-Linked-Etag — a generic ETag on a 3xx is the pointer's, not the file's.
    if (!redirectValidator) redirectValidator = res.headers.get("x-linked-etag");

    if (redirectCount >= MAX_HTTP_REDIRECTS) {
      throw new ModelError(
        `Download redirect limit exceeded (${MAX_HTTP_REDIRECTS}) — the model host kept ` +
          `redirecting (Hugging Face routes resolve URLs through the Xet/CAS CDN; a loop ` +
          `here usually means a broken mirror or a proxy rewriting the redirect chain).`,
        {
          url: redactUrlForLogs(currentUrl),
          status: res.status,
        },
      );
    }

    const location = res.headers.get("location");
    if (!location) {
      // A 3xx with no Location can't be followed. HF's Xet/CAS flow ALWAYS
      // includes a Location on its resolve redirect, so a missing one means a
      // proxy stripped it or the host mis-responded — say so instead of the
      // confusing "Download failed: 302 Found" the !res.ok path would emit.
      throw new ModelError(
        `Download failed: the model host returned a ${res.status} redirect with no ` +
          `Location header, so it can't be followed. For Hugging Face this usually means a ` +
          `proxy stripped the redirect to the Xet/CAS CDN — check any corporate proxy, or ` +
          `set HF_ENDPOINT to a reachable mirror and retry.`,
        { url: redactUrlForLogs(currentUrl), status: res.status },
      );
    }

    let nextUrl: string;
    try {
      nextUrl = new URL(location, currentUrl).toString();
    } catch {
      throw new ModelError(
        `Download failed: the model host returned a ${res.status} redirect to an invalid ` +
          `Location ("${location}"). The redirect chain can't be followed — retry, or set ` +
          `HF_ENDPOINT to a reachable mirror if this is a Hugging Face URL.`,
        {
          url: redactUrlForLogs(currentUrl),
          status: res.status,
        },
      );
    }
    // Drop credential-bearing headers (Authorization etc.) when the redirect
    // crosses origins. HF's resolve URL 302s to a *pre-signed* Xet/CAS URL on a
    // different host (e.g. cas-bridge.xethub.hf.co) that needs no auth — and
    // forwarding our HF Bearer token to a third-party CDN would leak it. This
    // matches how huggingface_hub follows the CAS redirect. BUT keep Range /
    // If-Range: they are not credentials, and the pre-signed CAS URL supports
    // byte-range requests — dropping them meant a resume's Range never reached
    // the CDN, so HF Xet resumes always fell back to a full re-download (#467).
    const sameOrigin = new URL(nextUrl).origin === new URL(currentUrl).origin;
    currentUrl = nextUrl;
    if (!sameOrigin) {
      crossOriginRedirect = true;
      const preserved: Record<string, string> = {};
      if (currentHeaders.Range) preserved.Range = currentHeaders.Range;
      if (currentHeaders["If-Range"]) preserved["If-Range"] = currentHeaders["If-Range"];
      currentHeaders = preserved;
    }
  }

  if (!res.ok) {
    // Civitai requires an account token for ALL downloads (401 keyless, 403
    // for gated/early-access) — a raw status code leaves agents flailing
    // through retries (live E2E), so name the fix.
    const civitaiAuthHint =
      (res.status === 401 || res.status === 403) && /(^|\.)civitai\.com$/i.test(new URL(currentUrl).hostname)
        ? " — CivitAI requires an API token for downloads. Set CIVITAI_API_TOKEN (panel Settings › “Set CivitAI token…”, or the env var; create one at civitai.com/user/account) and retry. Do NOT retry other model ids — they will all fail the same way until a token is set."
        : "";
    throw new ModelError(
      `Download failed: ${res.status} ${res.statusText}${civitaiAuthHint}`,
      { url: currentUrl === url ? logUrl : redactUrlForLogs(currentUrl), status: res.status },
    );
  }

  if (!res.body) {
    throw new ModelError("Download response has no body", { url: logUrl });
  }

  // #467/#343 belt-and-braces on a 206 RESUME APPEND. A same-origin 206 is safe:
  // the very server that evaluated our If-Range is the one serving the bytes, so
  // a 206 already proves the resource is unchanged. A CROSS-ORIGIN 206 (HF resolve
  // → CAS CDN) cannot lean on that — the CDN may honor a stale Range and 206 a
  // CHANGED object regardless of the origin's If-Range — so we must independently
  // prove the object is unchanged via the content-addressed X-Linked-Etag captured
  // off the redirect: it MUST be present AND equal the validator the partial was
  // written against. We also refuse any 206 whose redirect PROVES a change
  // (X-Linked-Etag present but different), cross-origin or not. Only 206s are
  // gated — a 200 is a full body and restarts cleanly through the branch below.
  // On refusal, drop the partial + sidecar so a retry is a clean full download.
  if (requestedResume && res.status === 206) {
    const provenChange = redirectValidator !== null && redirectValidator !== priorValidator;
    const unprovenCrossOrigin = crossOriginRedirect && redirectValidator !== priorValidator; // includes missing
    if (provenChange || unprovenCrossOrigin) {
      const why = provenChange
        ? "the resolve redirect now points at a DIFFERENT content-addressed object (X-Linked-Etag changed)"
        : "the resume crossed origins to a CDN that returned no content-addressed validator, so an unchanged upstream can't be proven";
      await safeRm(targetPath);
      await safeRm(validatorSidecar);
      recordResumeDiagnostic(url, "declined:etag-changed", resumeFromBytes);
      logger.warn(
        `Discarding a ${resumeFromBytes}-byte partial download and restarting from 0: ${why}. ` +
          `Refusing to append the 206 (would risk corrupting the file, #343). Removed the partial; retry.`,
        { url: logUrl, discardedBytes: resumeFromBytes },
      );
      throw new ModelError(
        `Download resume rejected: ${why}. Removed the stale partial so a retry restarts cleanly.`,
        { url: logUrl },
      );
    }
  }

  // Decide append vs truncate based on the response. We only append when we
  // actually asked for a range (effectiveResume > 0, i.e. we had a validator)
  // AND the server honoured it with a 206. Any other 2xx (typically 200) means
  // the server is sending the full file — exactly what If-Range yields when the
  // upstream file changed — so we overwrite and restart, which is correct.
  const appendMode = effectiveResume > 0 && res.status === 206;

  // The authoritative full-file size, taken from a 206's Content-Range total.
  // Used as the truncation target so a SHORT 206 (a server that satisfies only
  // part of the requested range — RFC 9110 §15.3.7) can't slip through.
  let rangeTotal: number | undefined;
  if (appendMode) {
    // #343 edge: a 206 MUST fully prove where it resumes AND how big the whole
    // file is. Parse Content-Range strictly as `bytes <start>-<end>/<total>` and
    // reject unless: start === our resume offset, end >= start, total is known
    // and consistent (end === total-1, i.e. the range runs to the end of the
    // representation). A missing/malformed/partial range (e.g. `bytes 4-7/1000`
    // returning only 4 of the remaining bytes, or `bytes 4-3/3`, or unanchored
    // garbage) would otherwise let a truncated file be finalized as complete or
    // be appended at the wrong offset. Drop the partial + validator so a retry
    // starts clean rather than compounding the corruption.
    const contentRange = res.headers.get("content-range");
    // Range-unit name is case-insensitive (RFC 9110 §14.1) — accept "Bytes"/"BYTES".
    const m = contentRange ? /^bytes (\d+)-(\d+)\/(\d+)$/i.exec(contentRange.trim()) : null;
    const start = m ? Number(m[1]) : NaN;
    const end = m ? Number(m[2]) : NaN;
    const total = m ? Number(m[3]) : NaN;
    const valid =
      m !== null &&
      start === effectiveResume &&
      end >= start &&
      total > end &&
      end === total - 1;
    if (!valid) {
      await safeRm(targetPath);
      await safeRm(validatorSidecar);
      throw new ModelError(
        `Download resume rejected: a 206 for byte ${effectiveResume}+ must carry a complete, ` +
          `consistent Content-Range "bytes ${effectiveResume}-<end>/<total>" reaching the end of ` +
          `the file, but the server sent ${contentRange ? `"${contentRange}"` : "no Content-Range"}. ` +
          `Refusing to append (would corrupt or truncate the file). Removed the partial; retry.`,
        { url: logUrl, status: res.status },
      );
    }
    rangeTotal = total;
  }

  const flags = appendMode ? "a" : "w";

  // On a fresh/full write (restart) of a resumable target, make the validator
  // and the on-disk bytes failure-atomic: first drop any stale sidecar AND the
  // stale partial (so a crash here leaves NO validator → the next attempt has no
  // sidecar and safely restarts), THEN persist the new validator so that once we
  // begin writing, a truncated partial is already paired with a MATCHING
  // validator. On a 206 append the existing sidecar already matches — leave it.
  if (resumable && !appendMode) {
    // If we ASKED to resume (had a validator, sent Range+If-Range) but the
    // server didn't honor it (200, not 206), the upstream file changed — the
    // If-Range miss — so the partial is being discarded. Surface WHY (#467)
    // rather than silently restarting.
    if (requestedResume) {
      logger.warn(
        `Discarding a ${resumeFromBytes}-byte partial download and restarting from 0: the server ` +
          `answered the If-Range resume request with a full ${res.status} instead of a 206, which ` +
          `means the upstream file CHANGED since the partial was written. Appending would corrupt ` +
          `it (#343), so re-downloading in full.`,
        { url: logUrl, discardedBytes: resumeFromBytes },
      );
      recordResumeDiagnostic(url, "declined:etag-changed", resumeFromBytes);
    }
    await safeRm(validatorSidecar);
    await safeRm(targetPath);
    // Prefer the final response's validator; fall back to one captured off the
    // redirect chain (HF Xet: the CAS 200 has none, but the resolve 302 carried
    // X-Linked-Etag) so the partial written now becomes resumable later (#467).
    const validator = extractValidator(res) || redirectValidator;
    if (validator) await writeValidatorSidecar(validatorSidecar, validator);
  } else if (appendMode) {
    // A resume was actually taken (validated 206 append). Record it so
    // download_status can report the partial was reused, not discarded (#467).
    recordResumeDiagnostic(url, "resumed", 0);
  }

  const nodeStream = Readable.fromWeb(res.body as import("node:stream/web").ReadableStream);
  const fileStream = createWriteStream(targetPath, { flags });

  // Truncation target = the true full-file size. For a validated 206 that is the
  // Content-Range total (NOT content-length, which is only the remaining slice
  // and would mask a short 206). For a 200 it is the Content-Length.
  const lengthHeader = Number(res.headers.get("content-length") || 0);
  const expectedTotal = appendMode
    ? (rangeTotal ?? 0)
    : lengthHeader > 0
      ? lengthHeader
      : 0;

  // A pipeline() can resolve on a stream that ended EARLY (server dropped the
  // connection, proxy cut it, disk edge case) — leaving a 0-byte or truncated
  // file that would otherwise be reported as a successful download (#343: silent
  // model corruption). Verify the written size before we ever return success.
  const assertComplete = async (): Promise<void> => {
    let actual: number | undefined;
    try {
      const st = await stat(targetPath);
      actual = typeof st?.size === "number" ? st.size : undefined;
    } catch {
      actual = undefined;
    }
    // Couldn't read a real size (e.g. the fs layer is stubbed in tests, or stat
    // hiccuped) → can't verify, so don't block a download over a missing number.
    if (actual === undefined) return;
    if (actual === 0) {
      // Nothing landed — remove it (and its validator sidecar) so it can't
      // masquerade as a real file / poison a resume with a validator that has
      // no matching bytes. Best-effort: never let cleanup throw here.
      await safeRm(targetPath);
      if (resumable) await safeRm(validatorSidecar);
      throw new ModelError(
        "Download produced a 0-byte file — the source sent no data. Removed it; retry.",
        { url: logUrl },
      );
    }
    if (expectedTotal > 0 && actual < expectedTotal) {
      // Truncated. Keep the partial on disk so a later call can range-resume it,
      // but do NOT report this as a completed download.
      throw new ModelError(
        `Download truncated: wrote ${actual} of ${expectedTotal} bytes — the stream ended early. Not complete; retry to resume.`,
        { url: logUrl },
      );
    }
  };

  // No progress wanted (internal/cache caller, or not under the panel) → straight pipe.
  if (!progress) {
    await pipeline(nodeStream, fileStream);
    await assertComplete();
    // Complete: the validator sidecar is only needed to guard a resume, so drop it.
    if (resumable) await safeRm(validatorSidecar);
    return;
  }

  // Tally bytes as they flow and report throughput to the panel tray.
  const total = expectedTotal;
  let downloaded = appendMode ? effectiveResume : 0;
  let windowStart = Date.now();
  let windowBytes = downloaded;
  let bytesPerSec = 0;
  const emit = (status: DownloadProgress["status"], force = false) =>
    reportDownloadProgress(
      { id: progress.id, name: progress.name, downloaded, total, bytes_per_sec: bytesPerSec, status },
      force,
    );
  emit("downloading", true); // show the row immediately, even before the first chunk
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      downloaded += chunk.length;
      const now = Date.now();
      const dt = now - windowStart;
      if (dt >= 400) {
        bytesPerSec = ((downloaded - windowBytes) * 1000) / dt;
        windowStart = now;
        windowBytes = downloaded;
        emit("downloading");
      }
      cb(null, chunk);
    },
  });
  try {
    await pipeline(nodeStream, counter, fileStream);
    await assertComplete();
    if (resumable) await safeRm(validatorSidecar);
    bytesPerSec = 0;
    emit("done", true);
  } catch (err) {
    emit("error", true);
    throw err;
  }
}

async function downloadIntoCache(
  url: string,
  headers: Record<string, string>,
  logUrl?: string,
  storageAuth: CloudStorageAuth = {},
  progress?: ProgressMeta,
): Promise<string> {
  const target = cachePathForUrl(url);
  const key = target;

  const existing = inflight.get(key);
  if (existing) return existing;

  const promise = (async () => {
    await downloadCacheFs.mkdir(cacheDir(), { recursive: true });

    try {
      const info = await downloadCacheFs.stat(target);
      if (info.isFile()) {
        // #343 edge: never serve a 0-byte cache entry as a hit. One could exist
        // from an interrupted rename, an older build without the size gate, or
        // external tampering — treat it as a miss and re-download rather than
        // materializing an empty file that reports success.
        if (info.size === 0) {
          await downloadCacheFs.rm(target, { force: true }).catch(() => undefined);
        } else {
          await touch(target);
          return target;
        }
      }
    } catch {
      // Cache miss.
    }

    // Deterministic .partial filename so a crashed/interrupted download
    // resumes from the byte it left off on the next call, rather than
    // restarting from zero. (See streamUrlToFile for the Range + flags
    // handshake.) Cleanup on terminal failure stays unchanged.
    const partial = join(cacheDir(), `.${basename(target)}.partial`);
    let resumeFromBytes = 0;
    try {
      const existing = await downloadCacheFs.stat(partial);
      if (existing.isFile() && existing.size > 0) {
        resumeFromBytes = existing.size;
        logger.info("Resuming partial download", {
          url: logUrl,
          bytes: resumeFromBytes,
        });
      }
    } catch {
      // No partial — fresh download.
    }

    try {
      await streamUrlToFile(
        url,
        partial,
        headers,
        logUrl,
        storageAuth,
        resumeFromBytes,
        progress,
        true, // resumable: cache partials use the .partial + If-Range resume handshake
      );
      await downloadCacheFs.rename(partial, target);
      await touch(target);
      return target;
    } catch (err) {
      // Leave the partial on disk for a future resume; only nuke it if it
      // is now empty (server said the previous partial was bogus, or our
      // first write failed).
      try {
        const remaining = await downloadCacheFs.stat(partial);
        if (remaining.size === 0) {
          await downloadCacheFs.rm(partial, { force: true }).catch(() => undefined);
          // The validator sidecar is only meaningful alongside a resumable
          // partial — drop it too so a later attempt doesn't If-Range against a
          // file that no longer exists.
          await downloadCacheFs.rm(`${partial}.etag`, { force: true }).catch(() => undefined);
        }
      } catch {
        // Partial gone — nothing to clean.
      }
      throw err;
    }
  })();

  inflight.set(key, promise);
  try {
    return await promise;
  } finally {
    inflight.delete(key);
  }
}

async function materializeCacheFile(
  cachePath: string,
  targetPath: string,
): Promise<"hardlink" | "copy"> {
  if (resolve(cachePath) === resolve(targetPath)) return "hardlink";

  await downloadCacheFs.rm(targetPath, { force: true });
  try {
    await downloadCacheFs.link(cachePath, targetPath);
    return "hardlink";
  } catch {
    await downloadCacheFs.copyFile(cachePath, targetPath);
    return "copy";
  }
}

async function evictLruIfNeeded(): Promise<void> {
  const limit = cacheSizeLimitBytes();
  if (limit <= 0) return;

  const dir = cacheDir();
  const entries = await downloadCacheFs.readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && !entry.name.startsWith("."))
      .map(async (entry) => {
        const path = join(dir, entry.name);
        const info = await downloadCacheFs.stat(path);
        return {
          path,
          size: info.size,
          time: Math.max(info.atimeMs, info.mtimeMs),
        };
      }),
  );

  let total = files.reduce((sum, file) => sum + file.size, 0);
  if (total <= limit) return;

  files.sort((a, b) => a.time - b.time);
  for (const file of files) {
    await downloadCacheFs.rm(file.path, { force: true });
    total -= file.size;
    if (total <= limit) break;
  }
}

export async function downloadUrlToFile(
  url: string,
  targetPath: string,
  headers: Record<string, string>,
  logUrl?: string,
  storageAuth: CloudStorageAuth = {},
  progress?: ProgressMeta,
): Promise<void> {
  await streamUrlToFile(url, targetPath, headers, logUrl, storageAuth, 0, progress);
}

export async function downloadWithCache(
  options: DownloadCacheOptions,
): Promise<DownloadCacheResult> {
  const logUrl = options.logUrl ?? redactUrlForLogs(options.url);
  try {
    const cachePath = await downloadIntoCache(
      options.url,
      options.headers,
      logUrl,
      options.storageAuth,
      options.progress,
    );
    const materializedBy = await materializeCacheFile(cachePath, options.targetPath);
    await evictLruIfNeeded();
    return {
      targetPath: options.targetPath,
      usedCache: true,
      cachePath,
      materializedBy,
    };
  } catch (err) {
    if (err instanceof ModelError) throw err;
    logger.warn("Download cache unavailable; falling back to direct download", {
      url: logUrl,
      error: err instanceof Error ? err.message : String(err),
    });
    await downloadUrlToFile(
      options.url,
      options.targetPath,
      options.headers,
      logUrl,
      options.storageAuth,
      options.progress,
    );
    return { targetPath: options.targetPath, usedCache: false };
  }
}
