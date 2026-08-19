// The frontend's VIRTUAL-node registry, ORCHESTRATOR → spawned MCP child (#1400).
//
// `check_runtime` (checkWorkflowRuntime, services/api-nodes.ts) classifies a
// workflow's node types against the connected server's /object_info. A type
// absent from /object_info is reported in `unknownNodes` and collapses the
// verdict to "unknown" — cautious by design, because such a type COULD be a paid
// node the server does not expose. But the caution is wrong for a type that can
// never execute at all: a frontend-only VIRTUAL node (KJNodes' Get/Set bus,
// rgthree's Label / Fast Groups toggles, …). #1372/#1564 exempted the names the
// converter already knew; the owner declined a list of third-party names — a
// list goes stale silently and then reads as authoritative.
//
// The authority is the FRONTEND's LiteGraph registry: a type whose registered
// class sets `isVirtualNode === true` is skipped by ComfyUI's own serializer and
// never reaches the backend. The panel (comfyui-mcp-panel, the one process that
// CAN see that registry) proves it per type by probe-constructing the class, and
// serves it as the `graph_get_virtual_types` bridge command. The orchestrator
// pulls that answer on each panel hello and republishes it here, into the
// progress dir every spawned comfyui tool server already shares
// (COMFYUI_MCP_PROGRESS_DIR — the same plumbing as panel-origin-channel.ts,
// whose read/liveness/write helpers this module reuses so the two channels
// cannot drift). A child has no bridge; a file it can read is the whole channel.
//
// Entries are keyed by the tab's SERVER-OBSERVED handshake origin (UiBridge's
// tabServerOrigin), never the client-supplied hello claim — page JS can write
// the claim, it cannot forge the browser's Origin header (the #756 trust model).
// The reader matches its own target with sameOrigin (utils/origin.ts), so
// 127.0.0.1 and localhost spellings of one server are one entry (#1175).
//
// LEVEL-TRIGGERED like the sibling channel: the orchestrator republishes the
// CURRENT map on its 700ms poll tick, keyed to origins a connected tab actually
// fronts. A tab that goes away drops its entry within one tick, so a stale set
// stops exempting almost immediately. The record also carries the publisher's
// pid + a heartbeat, and the reader requires BOTH (see panel-origin-channel.ts
// for why each alone leaves a hole): a crashed orchestrator's record expires
// instead of exempting forever.
//
// ## What a wrong or stale answer could do, stated rather than implied
//
// The classifier checks /object_info FIRST: a type the server registers is
// classified from its def, and this set is never consulted for it — a stale or
// even hostile entry cannot move a REGISTERED (possibly paid) node. What an
// entry moves is only a type ABSENT from /object_info, from "unknown" to
// skipped. Such a type cannot execute on that server at all (an unregistered
// class_type is rejected at /prompt), so it cannot bill: the worst a stale entry
// produces is "local" for a workflow that is actually BROKEN (its pack removed),
// which fails loudly at queue time and is a runnability answer, not the
// cost answer this tool exists to give. The fail-closed direction is preserved.
//
// No-ops entirely when COMFYUI_MCP_PROGRESS_DIR is unset — a plain (non-panel)
// MCP server keeps the pre-#1400 "unknown" exactly as before.

import { join } from "node:path";
import {
  publisherAlive,
  readChannelFile,
  writeChannelPayload,
} from "./panel-origin-channel.js";
import { sameOrigin } from "../utils/origin.js";

/** File name inside the progress dir. The `control-` prefix is load-bearing:
 *  pollDownloads and listTargetChangeRequests both filter on it, so this file is
 *  never mistaken for a download row or a target-change request (same contract
 *  as PANEL_ORIGINS_FILE). */
export const FRONTEND_VIRTUAL_TYPES_FILE = "control-frontend-virtual-types.json";

/** Refresh cadence for an UNCHANGED map, so a reader can tell "still true" from
 *  "nobody has touched this since the orchestrator died". Mirrors the sibling
 *  channel's 30s heartbeat against the same 700ms tick. */
export const FRONTEND_VIRTUAL_TYPES_HEARTBEAT_MS = 30_000;

/** How stale a record may be before the reader stops trusting it (4x the
 *  heartbeat, mirroring the sibling channel: the cost of expiring a good record
 *  is a cautious "unknown", but flapping would be worse). */
export const FRONTEND_VIRTUAL_TYPES_MAX_AGE_MS = 120_000;

/** Defensive bounds on a payload that ultimately comes from page JS. The honest
 *  answer is a few dozen short type names; anything past these is not something
 *  a healthy panel sent. */
const MAX_TYPES_PER_ORIGIN = 512;
const MAX_TYPE_CHARS = 300;

export interface FrontendVirtualTypesEntry {
  /** The SERVER-OBSERVED handshake origin of the tab that proved these types. */
  origin: string;
  /** Type names whose registered class the panel proved `isVirtualNode === true`. */
  types: string[];
}

/** Read at CALL time, not at module load: a test can point the channel at a temp
 *  dir, and nothing in production changes it after spawn anyway. */
function channelFile(dir?: string): string | null {
  const base = dir ?? process.env.COMFYUI_MCP_PROGRESS_DIR ?? "";
  return base ? join(base, FRONTEND_VIRTUAL_TYPES_FILE) : null;
}

/** Last payload written by THIS process (change-only writes), and when. */
let lastPublished: string | null = null;
let lastWriteAt = 0;

/**
 * Orchestrator side: publish the CURRENT virtual-registry map — one entry per
 * origin a connected tab fronts and has answered `graph_get_virtual_types` for.
 * Level-triggered: callers pass the whole live map every tick, and an origin
 * whose tab disconnected drops out of the file within that tick.
 *
 * Best-effort: a failed write leaves the child on the previous record, which the
 * freshness check expires — the classifier falls back to "unknown", never to a
 * fabricated "virtual".
 */
export function publishFrontendVirtualTypes(
  dir: string,
  entries: readonly FrontendVirtualTypesEntry[],
  now: number = Date.now(),
): void {
  const file = channelFile(dir);
  if (!file) return;
  // What actually gets published: validated, bounded, deduped, ordered — the
  // change-key and the payload are both built from THIS, so they cannot
  // disagree, and a hostile-sized answer is cut to the defensive bounds before
  // it can reach the classifier.
  const published = entries
    .filter((e) => e && typeof e.origin === "string" && e.origin !== "")
    .map((e) => ({
      origin: e.origin,
      types: [
        ...new Set(
          (Array.isArray(e.types) ? e.types : []).filter(
            (t): t is string =>
              typeof t === "string" && t !== "" && t.length <= MAX_TYPE_CHARS,
          ),
        ),
      ]
        .sort()
        .slice(0, MAX_TYPES_PER_ORIGIN),
    }))
    .sort((a, b) => (a.origin < b.origin ? -1 : a.origin > b.origin ? 1 : 0));
  const key = JSON.stringify(published);
  const changed = key !== lastPublished;
  const heartbeatDue = now - lastWriteAt >= FRONTEND_VIRTUAL_TYPES_HEARTBEAT_MS;
  if (!changed && !heartbeatDue) return;
  const payload = JSON.stringify({ entries: published, updated: now, pid: process.pid });
  // A failed write leaves the PRIOR complete record in place; do NOT record this
  // as published, so the next tick retries (the sibling channel's rule).
  if (!writeChannelPayload(dir, file, payload)) return;
  lastPublished = key;
  lastWriteAt = now;
}

/** Test/shutdown hook: forget what this process last published, so the next
 *  publish writes unconditionally. */
export function resetPublishedFrontendVirtualTypes(): void {
  lastPublished = null;
  lastWriteAt = 0;
}

/**
 * Child side: the virtual types a connected panel proved for the ComfyUI at
 * `targetOrigin` (this process's own ComfyUI base URL — matching is alias-aware
 * via sameOrigin). An EMPTY SET — never an error — when there is no channel (a
 * plain MCP server), no live/fresh record, no entry for this origin, or the
 * payload is unreadable: "no proof" is the cautious answer, and the classifier's
 * pre-#1400 behaviour is the fallback every one of those shares.
 */
export function frontendVirtualTypesFor(
  targetOrigin: string | undefined,
  now: number = Date.now(),
): ReadonlySet<string> {
  const out = new Set<string>();
  const file = channelFile();
  if (!file || !targetOrigin) return out;
  try {
    const raw = JSON.parse(readChannelFile(file)) as {
      entries?: unknown;
      updated?: unknown;
      pid?: unknown;
    };
    if (!Array.isArray(raw?.entries)) return out;
    // A record whose publisher is gone describes a registry nobody is still
    // observing. Both checks, per the sibling channel: liveness catches the
    // death, freshness catches a reused pid.
    if (!publisherAlive(raw.pid)) return out;
    const updated = typeof raw.updated === "number" ? raw.updated : 0;
    // `updated > now` (a clock step, or a future-dated write) is NOT freshness
    // evidence — without this it would read as maximally fresh, forever.
    if (updated > now || now - updated > FRONTEND_VIRTUAL_TYPES_MAX_AGE_MS) return out;
    for (const entry of raw.entries as Array<{ origin?: unknown; types?: unknown }>) {
      if (!entry || typeof entry.origin !== "string" || !entry.origin) continue;
      if (!sameOrigin(entry.origin, targetOrigin)) continue;
      for (const t of Array.isArray(entry.types) ? entry.types : []) {
        if (typeof t === "string" && t !== "" && t.length <= MAX_TYPE_CHARS) out.add(t);
        if (out.size >= MAX_TYPES_PER_ORIGIN) break;
      }
      // One origin match is the answer; a second entry for the same server would
      // be a publisher bug, and first-wins is at least DETERMINISTIC about it.
      break;
    }
    return out;
  } catch {
    return out;
  }
}
