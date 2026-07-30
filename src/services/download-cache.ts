import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  copyFile,
  link,
  mkdir,
  readdir,
  rename,
  rm,
  stat,
  utimes,
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

async function streamUrlToFile(
  url: string,
  targetPath: string,
  headers: Record<string, string>,
  logUrl = redactUrlForLogs(url),
  storageAuth: CloudStorageAuth = {},
  resumeFromBytes = 0,
  progress?: ProgressMeta,
): Promise<void> {
  if (supportsCloudDownload(url)) {
    await downloadCloudUrlToFile(url, targetPath, storageAuth);
    return;
  }

  // Resumable downloads: when a partial file exists at targetPath we ask the
  // server for the remaining bytes via Range. If the server returns 206 with
  // matching Content-Range we append; if it returns 200 (range unsupported,
  // or the file changed upstream) we truncate and restart. Idea from
  // josephoibrahim/comfy-cozy.
  let currentUrl = url;
  let currentHeaders = headers;
  if (resumeFromBytes > 0) {
    currentHeaders = { ...currentHeaders, Range: `bytes=${resumeFromBytes}-` };
  }
  let res: Response;
  for (let redirectCount = 0; ; redirectCount += 1) {
    res = await fetchOrThrow(
      currentUrl,
      { headers: currentHeaders, redirect: "manual" },
      currentUrl === url ? logUrl : redactUrlForLogs(currentUrl),
    );
    if (res.status < 300 || res.status >= 400) break;

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
    // Drop request headers (Authorization etc.) when the redirect crosses
    // origins. HF's resolve URL 302s to a *pre-signed* Xet/CAS URL on a
    // different host (e.g. cas-bridge.xethub.hf.co) that needs no auth — and
    // forwarding our HF Bearer token to a third-party CDN would leak it. This
    // matches how huggingface_hub follows the CAS redirect.
    const sameOrigin = new URL(nextUrl).origin === new URL(currentUrl).origin;
    currentUrl = nextUrl;
    if (!sameOrigin) currentHeaders = {};
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

  // Decide append vs truncate based on the response. If we asked for a range
  // and got 206, append; any other 2xx (typically 200) means the server is
  // sending the full file so we must overwrite.
  const appendMode = resumeFromBytes > 0 && res.status === 206;
  const flags = appendMode ? "a" : "w";

  const nodeStream = Readable.fromWeb(res.body as import("node:stream/web").ReadableStream);
  const fileStream = createWriteStream(targetPath, { flags });

  // Content-Length is the REMAINING bytes for a 206 resume, so add the bytes
  // already on disk to get the true expected total.
  const lengthHeader = Number(res.headers.get("content-length") || 0);
  const expectedTotal = lengthHeader > 0 ? lengthHeader + (appendMode ? resumeFromBytes : 0) : 0;

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
      // Nothing landed — remove it so it can't masquerade as a real file / poison
      // resume. Best-effort: rm may be stubbed, so never let it throw here.
      try {
        await rm(targetPath, { force: true });
      } catch {
        /* best effort */
      }
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
    return;
  }

  // Tally bytes as they flow and report throughput to the panel tray.
  const total = expectedTotal;
  let downloaded = appendMode ? resumeFromBytes : 0;
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
        await touch(target);
        return target;
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
