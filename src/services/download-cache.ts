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
import type { ResumeReporter } from "./download-resume-diag.js";
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

/** POSITIVELY true only when `path` is confirmed discarded — it no longer exists
 *  (stat throws ENOENT) or exists but is empty (size 0). A non-ENOENT stat error
 *  (a transient fs hiccup) or a still-present non-empty file returns false, so a
 *  swallowed removal failure is never mistaken for a completed discard (#467). */
async function partialConfirmedDiscarded(path: string): Promise<boolean> {
  try {
    const st = await stat(path);
    return typeof st?.size === "number" && st.size === 0;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === "ENOENT";
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
  /** Sink for this download's resume decision, reported to the CALLER (the job)
   *  so it stores the outcome on itself — never in a shared keyed map that could
   *  misattribute it to another job (#467). Not called on a coalesced/cache-hit
   *  path (no physical resume happened). */
  onResume?: ResumeReporter;
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

/** Representation-affecting request headers, folded into the cache identity so a
 *  same-URL fetch carrying DIFFERENT auth/headers (two users' Bearer tokens, a
 *  Cookie/API-key, or ANY custom header like `X-Custom-Auth` that selects a
 *  user-scoped or gated representation) can NEVER share a cache entry / in-flight
 *  stream and install the wrong bytes (#467 P1-2). Query-param auth already
 *  varies the URL itself (applyDownloadAuth folds it in), so this covers the
 *  header case the URL can't. Hashes EVERY caller-supplied header (an allowlist
 *  would silently miss custom auth headers) — these are the request headers built
 *  from the caller's auth/config, NOT the volatile hop headers (Range/If-Range),
 *  which are added later inside streamUrlToFile and never reach here. Empty ⇒ the
 *  key is the bare URL, so unauthenticated public downloads keep existing paths. */
function representationKey(headers: Record<string, string>): string {
  const relevant = Object.keys(headers)
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
    .map((k) => `${k.toLowerCase()}=${headers[k]}`)
    .join("\n");
  return relevant ? createHash("sha256").update(relevant).digest("hex").slice(0, 12) : "";
}

/** Cache-identity namespace. Bumped when the identity SCHEME changes so entries
 *  from an older scheme can never be served under the new one. Critically this
 *  fixes a cross-auth leak (#467 P1-C): the PRE-header-aware code cached
 *  header-authenticated downloads under the BARE URL, so without a namespace a
 *  post-upgrade UNAUTHENTICATED caller (also bare-URL) could be served bytes that
 *  were cached earlier under someone's auth. We can't tell a legacy entry's
 *  provenance, so ALL new identities — authed AND unauthed — are prefixed, which
 *  orphans every legacy `sha256(url)` entry (a one-time re-download; orphans age
 *  out via LRU when COMFYUI_LRU_CACHE_SIZE_GB is set, else are inert on disk). */
const CACHE_NS = "v2";

function cacheIdentity(url: string, headers: Record<string, string>): string {
  const repr = representationKey(headers);
  // Namespaced for BOTH authed and unauthed so neither can collide with a legacy
  // bare-URL entry of unknown auth provenance (#467 P1-C).
  return repr ? `${CACHE_NS}\n${url}\n${repr}` : `${CACHE_NS}\n${url}`;
}

function cachePathForUrl(url: string, headers: Record<string, string> = {}): string {
  const hash = createHash("sha256")
    .update(cacheIdentity(url, headers))
    .digest("hex")
    .slice(0, HASH_CHARS);
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

async function streamUrlToFile(
  url: string,
  targetPath: string,
  headers: Record<string, string>,
  logUrl = redactUrlForLogs(url),
  storageAuth: CloudStorageAuth = {},
  resumeFromBytes = 0,
  progress?: ProgressMeta,
  resumable = false,
  /** Sink for THIS physical download's resume decision, threaded from the job so
   *  the outcome is stored on that job — never in a shared keyed map that could
   *  misattribute it to another job (#467). Absent for internal/direct callers. */
  onResume?: ResumeReporter,
): Promise<void> {
  if (supportsCloudDownload(url)) {
    // Cloud downloaders (S3/Azure) don't range-resume — they overwrite the target.
    // If a partial exists it's being discarded; surface that (#467) instead of a
    // silent restart. Truncate it OURSELVES first and CONFIRM (throw on failure)
    // BEFORE reporting discarded:true — the cloud SDKs validate the request/body
    // before opening their write stream, so reporting pre-download could otherwise
    // claim a discard that a later auth/network failure never performed (P1-1).
    if (resumable && resumeFromBytes > 0) {
      try {
        await writeFile(targetPath, "");
      } catch (err) {
        throw new ModelError(
          `Download restart failed: could not truncate the stale ${resumeFromBytes}-byte partial ` +
            `before a cloud re-download. Retry (a fresh attempt restarts from 0).`,
          { url: logUrl, cause: err instanceof Error ? err.message : String(err) },
        );
      }
      logger.warn(
        `Discarded a ${resumeFromBytes}-byte partial download and restarting from 0: cloud ` +
          `downloads (S3/Azure) don't support byte-range resume, so the partial was overwritten — ` +
          `re-downloading in full.`,
        { url: logUrl, discardedBytes: resumeFromBytes },
      );
      onResume?.({ outcome: "declined:full-response", discardedBytes: resumeFromBytes, discarded: true });
    }
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
  // Set when a partial existed but no sidecar validator did, so we declined to
  // resume. The discard is only REPORTED once we actually truncate it (after a
  // successful response), so a fetch/redirect/status failure before then can't
  // falsely claim the partial was discarded (#467 codex round 4).
  let resumeDeclinedNoValidator = false;
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
      // No trustworthy validator → we will discard the un-verifiable partial and
      // restart (the deliberate #343 safety fallback). This USED to be silent: a
      // multi-GB HF Xet partial (whose CAS CDN sent no ETag/Last-Modified, so no
      // sidecar was ever written) got thrown away and re-downloaded from 0 with
      // no log and no signal (#467). Defer the log/diagnostic until we actually
      // truncate (below), so a pre-write failure can't falsely report a discard.
      effectiveResume = 0;
      if (resumable) resumeDeclinedNoValidator = true;
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
  // Set if ANY hop in the redirect chain reports a content-addressed X-Linked-Etag
  // that DIFFERS from the validator the partial was written against — proof the
  // upstream object changed, even if a later/earlier hop happens to match. Closes
  // the multi-hop hole where only the first (or last) value is inspected (#467).
  let sawChangedRedirectValidator = false;
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
    // Keep the LAST value seen (nearest the final object) for the sidecar/match,
    // AND flag if ANY hop's value contradicts the persisted validator on a resume.
    const hopValidator = res.headers.get("x-linked-etag");
    if (hopValidator) {
      redirectValidator = hopValidator;
      if (requestedResume && priorValidator && hopValidator !== priorValidator) {
        sawChangedRedirectValidator = true;
      }
    }

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
  // prove the object is unchanged via the content-addressed X-Linked-Etag: it MUST
  // be present AND equal the validator the partial was written against. We check
  // BOTH the values captured off the 3xx redirects AND the FINAL response's own
  // X-Linked-Etag — a matching redirect followed by a final CDN 206 carrying a
  // DIFFERENT content hash must NOT slip through (#467 P0-2). We refuse any 206
  // whose observed validators PROVE a change (present but different), cross-origin
  // or not. Only 206s are gated — a 200 is a full body and restarts cleanly below.
  // On refusal, drop the partial + sidecar so a retry is a clean full download.
  if (requestedResume && res.status === 206) {
    // The final response's OWN content-addressed validator (the CAS 206 usually
    // omits it, but when present it describes exactly THESE bytes — authoritative).
    const finalValidator = res.headers.get("x-linked-etag");
    // Any content-addressed validator we observed that CONTRADICTS the partial's.
    const provenChange =
      sawChangedRedirectValidator ||
      (redirectValidator !== null && redirectValidator !== priorValidator) ||
      (finalValidator !== null && finalValidator !== priorValidator);
    // The validator that best binds THESE bytes: the final response's own, else
    // the nearest redirect's. Used for the cross-origin "must be proven" check.
    const boundValidator = finalValidator ?? redirectValidator;
    const unprovenCrossOrigin = crossOriginRedirect && boundValidator !== priorValidator; // includes missing
    if (provenChange || unprovenCrossOrigin) {
      // provenChange (a validator we saw DIFFERS from the partial's) is a proven
      // change; unprovenCrossOrigin alone (no validator to compare) is merely
      // UNVERIFIABLE — report each honestly rather than always "changed".
      const why = provenChange
        ? "the upstream now reports a DIFFERENT content-addressed object (X-Linked-Etag changed" +
          (finalValidator !== null && finalValidator !== priorValidator
            ? " on the final response"
            : " on a redirect hop") +
          ")"
        : "the resume crossed origins to a CDN that returned no content-addressed validator, so an unchanged upstream can't be proven";
      // Remove the stale partial + sidecar, then CONFIRM the partial is actually
      // gone (safeRm swallows failures) before claiming it — a swallowed rm
      // failure must not be reported as "removed", and would otherwise leave a
      // partial a retry re-hits (#467 P1-a). The declined outcome is accurate
      // regardless (we refused to append); only the removal wording is conditional.
      await safeRm(targetPath);
      await safeRm(validatorSidecar);
      const removed = await partialConfirmedDiscarded(targetPath);
      onResume?.({
        outcome: provenChange ? "declined:etag-changed" : "declined:unverifiable",
        discardedBytes: resumeFromBytes,
        discarded: removed,
      });
      const tail = removed
        ? "Removed the stale partial so a retry restarts cleanly."
        : "Could not remove the stale partial — a retry may repeat this rejection; delete the .partial manually if so.";
      logger.warn(
        `Refusing to append a 206 and ${removed ? "discarded" : "abandoning"} a ${resumeFromBytes}-byte ` +
          `partial: ${why} — appending would risk corrupting the file (#343). ${tail}`,
        { url: logUrl, discardedBytes: resumeFromBytes, partialRemoved: removed },
      );
      throw new ModelError(
        `Download resume rejected: ${why}. ${tail}`,
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
    // Drop any stale sidecar, then EXPLICITLY truncate the stale partial to zero
    // and verify that truncation SUCCEEDED before we either (a) pair a new
    // validator with the file or (b) report the discard. Doing the truncation
    // ourselves (create-or-truncate to 0) — rather than relying on the lazy "w"
    // stream open below — lets us confirm the old prefix is gone up front. The
    // ordering is the #343 safety invariant: a new validator must NEVER be paired
    // with un-truncated stale bytes (a later If-Range 206 would then append fresh
    // bytes onto a stale prefix and silently corrupt the file). If truncation
    // fails, we write NO validator (a retry sees no sidecar → safe restart) and
    // report nothing (the discard didn't actually happen).
    await safeRm(validatorSidecar);
    // If we can't truncate the stale partial, FAIL rather than fall through to the
    // "w" open below: a partial-truncate failure that the later "w" open then
    // silently fixed would perform the discard WITHOUT reporting it (#467). By
    // throwing here we guarantee the discard is either reported (truncation
    // succeeded) or the download errors (never a silent discard). The sidecar was
    // already removed, so a retry sees no validator → safe restart (#343).
    try {
      await writeFile(targetPath, "");
    } catch (err) {
      throw new ModelError(
        `Download restart failed: could not truncate the stale ${resumeFromBytes}-byte partial to ` +
          `re-download it. Removed its validator; retry (a fresh attempt restarts from 0).`,
        { url: logUrl, cause: err instanceof Error ? err.message : String(err) },
      );
    }
    if (resumeFromBytes > 0 && requestedResume) {
      // Asked to resume (had a validator, sent Range+If-Range) but got a full 200
      // — the upstream changed OR the host doesn't support range resume. The
      // partial is now truncated and the file is being re-downloaded in full.
      logger.warn(
        `Discarded a ${resumeFromBytes}-byte partial download and restarting from 0: the server ` +
          `answered the If-Range resume request with a full ${res.status} instead of a 206 — the ` +
          `upstream file changed, or the host doesn't support resuming — so re-downloading in full.`,
        { url: logUrl, discardedBytes: resumeFromBytes },
      );
      onResume?.({ outcome: "declined:full-response", discardedBytes: resumeFromBytes, discarded: true });
    } else if (resumeFromBytes > 0 && resumeDeclinedNoValidator) {
      // A partial existed but no sidecar validator did, so we never even sent a
      // Range — a safe resume couldn't be verified (common on HF's Xet/CAS CDN,
      // which omits ETag/Last-Modified on the body). Truncated + re-download full.
      logger.warn(
        `Discarded a ${resumeFromBytes}-byte partial download and restarting from 0: no ` +
          `ETag/Last-Modified validator was ever persisted for it, so a safe resume can't be ` +
          `verified (common on Hugging Face's Xet/CAS CDN, which omits both headers on the file ` +
          `body). This is the safety-first behavior — an unverifiable resume risks a corrupt file ` +
          `(#343). Future downloads capture the validator from the resolve redirect so they CAN resume.`,
        { url: logUrl, discardedBytes: resumeFromBytes },
      );
      onResume?.({ outcome: "declined:no-validator", discardedBytes: resumeFromBytes, discarded: true });
    }
    // The file is now confirmed truncated (we threw otherwise), so a new validator
    // can never pair with a stale prefix (#343). Prefer the final response's
    // validator; fall back to one captured off the redirect chain (HF Xet: the CAS
    // 200 has none, but the resolve 302 carried X-Linked-Etag).
    const validator = extractValidator(res) || redirectValidator;
    if (validator) await writeValidatorSidecar(validatorSidecar, validator);
  } else if (appendMode) {
    // A resume was actually taken (validated 206 append). Record it so
    // download_status can report the partial was reused, not discarded (#467).
    onResume?.({ outcome: "resumed", discardedBytes: 0, discarded: false });
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
    // Couldn't read the written size. FAIL CLOSED when we have an authoritative
    // expected total to check against (#467 P1-B): a transient stat failure must
    // NOT let an early/oversized body be finalized (renamed into cache) as a
    // success — that is exactly the silent-corruption class #343 guards. Keep the
    // partial on disk (it may still be range-resumable) and error instead. Only
    // when NO expected total is known (server sent no Content-Length/Content-Range)
    // do we return — there is nothing to verify against, so a missing size can't
    // prove corruption and mustn't block the download.
    if (actual === undefined) {
      if (expectedTotal > 0) {
        throw new ModelError(
          `Download could not be verified: expected ${expectedTotal} bytes but the written file size ` +
            `couldn't be read — not finalizing (the file may be incomplete). Retry.`,
          { url: logUrl },
        );
      }
      return;
    }
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
    if (expectedTotal > 0 && actual > expectedTotal) {
      // OVERSIZED — the server streamed MORE than the authoritative size (a 206
      // Content-Range total, or a 200 Content-Length). A validated resume that
      // claims `bytes 4-7/8` but streams extra bytes would otherwise finalize a
      // corrupt file with no error (#467 P0-1). This is NOT resumable — the bytes
      // on disk are wrong — so remove the partial + validator and fail; a retry
      // starts clean rather than range-resuming a corrupt prefix.
      await safeRm(targetPath);
      if (resumable) await safeRm(validatorSidecar);
      throw new ModelError(
        `Download oversized: wrote ${actual} bytes but the file is only ${expectedTotal} — the ` +
          `response sent more data than its declared size (corrupt or misbehaving server). Removed ` +
          `the bad file; retry.`,
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
  onResume?: ResumeReporter,
): Promise<string> {
  // Header-aware identity (#467 P1-2): a same-URL download with a different
  // Authorization/Cookie/API-key gets its OWN cache file, partial and in-flight
  // slot — never coalesced onto another caller's stream/representation.
  const target = cachePathForUrl(url, headers);
  const key = target;

  const existing = inflight.get(key);
  // A job COALESCING onto an in-flight physical download gets no resume decision
  // of its own — the decision is reported to the job that actually runs the
  // stream (#467). This is inherent to the callback model: onResume is not passed
  // to the shared promise, so a coalesced caller simply awaits the same result.
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
          // Cache hit ⇒ no resume/discard this attempt; onResume is never called,
          // so the job's resume field stays empty (nothing to surface).
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
        onResume,
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
      options.onResume,
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
