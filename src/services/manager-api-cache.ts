import { performance } from "node:perf_hooks";
import { logger } from "../utils/logger.js";

// ---------------------------------------------------------------------------
// ComfyUI-Manager API dialect cache (issue #646)
//
// detectManagerApi() (services/node-management.ts) probes the connected ComfyUI
// once and classifies its Manager into one of three wire dialects. Probing on
// every operation would add 1-3 round trips to every Manager call, so the result
// is cached — but it used to be cached for the WHOLE PROCESS LIFETIME, keyed
// only by the base URL.
//
// A ComfyUI restart at the SAME base URL can change the dialect underneath us:
// upgrading the 3.x custom-node Manager to pip comfyui_manager 4.x, or dropping
// --enable-manager-legacy-ui, keeps the URL identical while flipping which
// endpoints exist. The URL-keyed lifetime cache then routes every subsequent
// Manager call through the PREVIOUS server's endpoints — download_model kept
// speaking the v2-batch/legacy-UI dialect to a normal Manager 4.2.2 and failed
// with a legacy-UI arbitrary-URL rejection forever (#646).
//
// This module is the single owner of that cached classification, so the two
// self-healing mechanisms live in one place:
//
//   1. EXPLICIT INVALIDATION on the restart lifecycle the repo already has.
//      Every place that drops the memoized /object_info because ComfyUI is
//      being restarted (services/process-control.ts stop/restart/Manager-reboot,
//      the panel's restart tools) also drops the dialect — same signal, same
//      reason: what the live server exposes may have just changed.
//
//   2. A TTL BACKSTOP for the OUT-OF-BAND restart — the #646 report's actual
//      path: the user upgraded Manager and restarted ComfyUI themselves, so no
//      mcp tool ever ran and no explicit invalidation fired. This mirrors the
//      /object_info TTL added for the same class of bug in #528: within the
//      window calls are served from cache (no extra probes on the hot path), and
//      the first call after the window re-probes and picks up whatever the live
//      server now is. Manager exposes no boot id / generation counter, so a TTL
//      is the lightest self-healing mechanism available.
//
// Deliberately kept in its own leaf module (logger-only imports) so the restart
// paths can invalidate the dialect without importing the heavyweight
// node-management unit (comfy-cli subprocesses, git helpers, …).
// ---------------------------------------------------------------------------

/**
 * The three Manager wire dialects found in the wild (issue #116 found the
 * second; #235 the third) — see detectManagerApi() for how each is recognized.
 *   "v2"       pip comfyui_manager (Manager v4) in NORMAL mode — the unified
 *              POST /v2/manager/queue/task envelope.
 *   "v2-batch" pip comfyui_manager started with --enable-manager-legacy-ui: the
 *              bundled 3.x server under the /v2 prefix (POST .../queue/batch).
 *   "legacy"   the 3.x custom-node Manager: per-operation /manager/queue/*.
 */
export type ManagerApi = "v2" | "v2-batch" | "legacy";

/**
 * Freshness window for a detected dialect. 60s keeps the probe off the hot path
 * for any realistic burst of Manager operations while bounding how long an
 * out-of-band Manager upgrade + restart can be mis-routed. Override with
 * COMFYUI_MCP_MANAGER_API_TTL_MS (0 re-probes on every call; a large value
 * restores the old lifetime-cache behavior).
 */
const MANAGER_API_TTL_MS = (() => {
  const raw = process.env.COMFYUI_MCP_MANAGER_API_TTL_MS;
  if (raw === undefined || raw.trim() === "") return 60_000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 60_000;
})();

/**
 * Elapsed-time source for the freshness window. MONOTONIC on purpose: a wall
 * clock can be stepped in either direction (NTP correction, VM snapshot restore,
 * a manual fix), and Date.now() arithmetic then misreports how much real time has
 * passed — a backward step can make an already-expired entry read as fresh again
 * once wall time catches back up to the stamp. performance.now() only ever moves
 * forward, so the window always measures actual elapsed time.
 */
function monotonicNow(): number {
  return performance.now();
}

let cache: { base: string; api: ManagerApi; at: number } | null = null;

/**
 * Invalidation epoch. resetManagerApiCache() bumps it; a detection that STARTED
 * under an older epoch must not commit its result, otherwise a probe already in
 * flight when ComfyUI restarted would re-pin the PRE-restart dialect right after
 * the restart cleared it (the same guard /object_info carries — #528).
 */
let epoch = 0;

/** Current invalidation epoch — capture it before an async detection/operation
 *  and pass it back to the commit helpers so a concurrent reset wins. */
export function managerApiEpoch(): number {
  return epoch;
}

/**
 * The cached dialect for `base`, or undefined when there is none, it was
 * detected against a different base URL, or it has aged out of the freshness
 * window.
 *
 * Age is measured on the MONOTONIC clock (see monotonicNow), so stepping the
 * system clock — in either direction — can neither extend the window nor
 * resurrect an entry that has already aged out. The `age >= 0` check is kept as a
 * defensive floor: a monotonic source cannot produce a negative age, and if one
 * ever appeared the safe reading is EXPIRED, not fresh (#528 review).
 */
export function getCachedManagerApi(base: string): ManagerApi | undefined {
  if (!cache || cache.base !== base) return undefined;
  const age = monotonicNow() - cache.at;
  if (age >= 0 && age < MANAGER_API_TTL_MS) return cache.api;
  logger.debug("Manager API dialect cache expired — re-probing", {
    base,
    was: cache.api,
    age_ms: age,
  });
  return undefined;
}

/**
 * Record a detected dialect. When `startEpoch` is supplied and no longer matches
 * the current epoch, the write is DROPPED: something invalidated the cache while
 * this detection was in flight (a restart), so its conclusion describes a server
 * that may no longer be there. The caller still gets the value it detected — it
 * simply isn't pinned for later callers.
 */
export function cacheManagerApi(base: string, api: ManagerApi, startEpoch?: number): void {
  if (startEpoch !== undefined && startEpoch !== epoch) {
    logger.debug("Dropping Manager API dialect detected across an invalidation", {
      base,
      api,
      startEpoch,
      epoch,
    });
    return;
  }
  cache = { base, api, at: monotonicNow() };
}

/**
 * Forget the detected dialect so the next Manager call re-probes the live
 * server. Call this whenever the connected ComfyUI is (or may have been)
 * restarted — a restart is exactly when the Manager generation can change under
 * a stable URL (#646) — and when a Manager response proves the cached dialect
 * wrong.
 */
export function resetManagerApiCache(reason?: string): void {
  const was = cache?.api;
  cache = null;
  epoch++;
  logger.debug("Manager API dialect cache reset", { reason, was, epoch });
}

/** @internal — test hook: pin a dialect for `base`, or clear the cache. */
export function setManagerApiCacheForTests(base: string, api?: ManagerApi): void {
  resetManagerApiCache("test");
  if (api) cacheManagerApi(base, api);
}
