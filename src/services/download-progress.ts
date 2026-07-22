// Cross-process download-progress channel.
//
// Model downloads run INSIDE the panel agent's comfyui MCP subprocess, but the
// panel bridge that renders the download tray lives in the ORCHESTRATOR process.
// To bridge them without a socket, the subprocess writes a small per-download
// progress JSON into COMFYUI_MCP_PROGRESS_DIR; the orchestrator watches that dir
// and broadcasts the rows to the panel (see src/orchestrator/index.ts).
//
// This no-ops entirely when COMFYUI_MCP_PROGRESS_DIR is unset — i.e. for every
// normal (non-panel) use of the MCP — so it costs nothing outside the panel.

import { mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";

export interface DownloadProgress {
  /** Stable id for this download (a hash of the source URL). */
  id: string;
  /** Human-friendly file name shown in the tray. */
  name: string;
  /** Bytes written so far. */
  downloaded: number;
  /** Total bytes (0 when the server didn't send Content-Length). */
  total: number;
  /** Instantaneous throughput, bytes/sec. */
  bytes_per_sec: number;
  /** Lifecycle. */
  status: "downloading" | "done" | "error";
  /** Epoch ms of this snapshot (set on write). */
  updated: number;
  /** The ComfyUI target this download serves (the writer's own COMFYUI_URL at
   *  write time — self-scoping, no reporter changes needed). The pod idle-stop
   *  veto counts ONLY rows for the watched pod: a local download must not
   *  disable a pod's auto-stop, nor vice versa (#269). Absent on pre-fix rows. */
  target?: string;
}

const PROGRESS_DIR = process.env.COMFYUI_MCP_PROGRESS_DIR || "";
/** Late-bound by the ORCHESTRATOR at startup (its own process has no env var —
 *  codex finding: the control channel was dead for in-process direct/mobile
 *  tool calls). progressEnabled() stays env-only on purpose: runpod.ts uses it
 *  as the spawned-child discriminator, and the orchestrator is NOT a child. */
let lateBoundDir = "";
export function setProgressDir(dir: string): void {
  lateBoundDir = dir;
}
function channelDir(): string {
  return PROGRESS_DIR || lateBoundDir;
}
const lastWriteAt = new Map<string, number>();

/** True when running under the panel orchestrator (progress channel is active). */
export function progressEnabled(): boolean {
  return !!PROGRESS_DIR;
}

function fileFor(id: string, target?: string): string {
  // The id is a hex hash from callers, but stay defensive about the filename.
  // Include a TARGET discriminator (codex finding: the same URL downloaded for
  // local AND pod concurrently shared one file — the last writer's target won
  // the per-pod idle veto and a pod could be auto-stopped mid-transfer).
  const disc = createHash("sha1")
    .update(target ?? `pid:${process.pid}`)
    .digest("hex")
    .slice(0, 8);
  return join(PROGRESS_DIR, `${id.replace(/[^a-zA-Z0-9_.-]/g, "_")}-${disc}.json`);
}

/** Credential-free form of a target URL for persisted rows / control files:
 *  strips userinfo (https://user:pass@host) before anything hits disk or a
 *  bridge frame (codex finding — raw COMFYUI_URL was being broadcast). */
function redactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.username = "";
    u.password = "";
    // Query/fragment can carry credentials too (?token=secret) — the contract
    // is credential-free before disk/broadcast (codex finding).
    u.search = "";
    u.hash = "";
    return u.toString().replace(/\/+$/, "");
  } catch {
    return raw.split("@").pop() ?? raw; // unparseable — drop anything before the last @
  }
}

/**
 * Write a progress snapshot for one download. The in-flight "downloading" state
 * is throttled to ~3/sec to avoid hammering the disk; terminal states
 * (done/error) always write so the final row is accurate.
 */
export function reportDownloadProgress(
  p: Omit<DownloadProgress, "updated">,
  force = false,
): void {
  if (!PROGRESS_DIR) return;
  const now = Date.now();
  if (!force && p.status === "downloading") {
    if (now - (lastWriteAt.get(p.id) ?? 0) < 300) return;
  }
  lastWriteAt.set(p.id, now);
  try {
    mkdirSync(PROGRESS_DIR, { recursive: true });
    // Stamp the writer's OWN target (the spawned MCP child's COMFYUI_URL): the
    // idle-stop veto scopes by it, and after a retarget the respawned child
    // reports against the new host while stale rows age out (codex finding:
    // a process-wide count let any download disable any pod's auto-stop).
    // Redacted — target URLs can carry userinfo (codex finding).
    const rawTarget = p.target ?? (process.env.COMFYUI_URL?.trim() || undefined);
    const target = rawTarget ? redactUrl(rawTarget) : undefined;
    writeFileSync(fileFor(p.id, target), JSON.stringify({ ...p, target, updated: now }));
  } catch {
    // best-effort — progress is cosmetic, never fail a download over it
  }
}

/**
 * Read back one download's latest snapshot, so `download_status` can report
 * bytes/throughput instead of a bare "still going". Progress files are
 * TARGET-SCOPED ({id}-{disc}.json — the same URL can download for local AND a
 * pod at once), so scan every variant for this id and return the most recently
 * updated snapshot. Returns null when progress reporting is off (no
 * COMFYUI_MCP_PROGRESS_DIR) or nothing has been written yet — callers must
 * treat byte counts as decoration, never as the source of truth for whether a
 * download finished.
 */
export function readDownloadProgress(id: string): DownloadProgress | null {
  if (!PROGRESS_DIR) return null;
  try {
    const prefix = `${id.replace(/[^a-zA-Z0-9_.-]/g, "_")}-`;
    let best: DownloadProgress | null = null;
    for (const f of readdirSync(PROGRESS_DIR)) {
      if (!f.startsWith(prefix) || !f.endsWith(".json")) continue;
      try {
        const parsed = JSON.parse(readFileSync(join(PROGRESS_DIR, f), "utf8")) as DownloadProgress;
        if (parsed && typeof parsed === "object" && typeof parsed.updated === "number") {
          if (!best || parsed.updated > best.updated) best = parsed;
        }
      } catch {
        // skip an absent/mid-write variant
      }
    }
    return best;
  } catch {
    return null; // absent or mid-write — not an error
  }
}

/** Remove a download's progress file(s) (e.g. on cancel). Target-scoped files
 *  share the id prefix, so clear every variant for the logical download. */
export function clearDownloadProgress(id: string): void {
  if (!PROGRESS_DIR) return;
  lastWriteAt.delete(id);
  try {
    const prefix = `${id.replace(/[^a-zA-Z0-9_.-]/g, "_")}-`;
    for (const f of readdirSync(PROGRESS_DIR)) {
      if (f.startsWith(prefix) && f.endsWith(".json")) rmSync(join(PROGRESS_DIR, f), { force: true });
    }
  } catch {
    // ignore
  }
}

// ── Control channel (MCP child → orchestrator) ──────────────────────────────
// runpod_* tools invoked by a panel AGENT run in the spawned stdio MCP child:
// setComfyuiTarget / getRunpodWatcher() there affect only that child — the
// orchestrator's QueueMonitor, watcher, host indicator and agent envs would
// stay on the old target while the tool result claims "connected + watched"
// (#269, codex). This one-file request channel reuses the proven progress-dir
// plumbing: the child stamps a target request; the orchestrator's 700ms
// poll loop applies it through the SAME applyComfyuiUrl fan-out as a panel
// hello. Self-healing (a stale request is ignored after its TTL) and idempotent
// (in-process callers already applied the change — re-applying dedupes).

export interface TargetChangeRequest {
  /** Retarget the orchestrator here (omit for a watch/unwatch-only request). */
  url?: string;
  /** Generation guard for URL retargets (codex finding): apply ONLY when the
   *  orchestrator's CURRENT target still equals what the child saw at write
   *  time — a newer direct choice made during the poll delay must not be
   *  overwritten by a stale queued request. */
  expectedCurrentUrl?: string;
  /** Retarget to the orchestrator's OWN resolved local fallback — the child
   *  must not guess it: a child spawned AFTER a pod connect has no memory of
   *  the LAN rig, and would wrongly overwrite it with 127.0.0.1 (codex). */
  local?: boolean;
  /** Only retarget local when the orchestrator's CURRENT target is this pod —
   *  a stale child (left on pod A after another tab moved to B) stopping A
   *  must not drag the authoritative target off B (codex finding). The ack
   *  still reports the resulting URL so the stale child ALIGNS to it. */
  onlyIfTarget?: string;
  /** A pod the caller just STOPPED — the orchestrator clears its recorded
   *  auto-connect failure (a spawned child's stop otherwise leaves the
   *  "still billing" warning up forever — codex finding). */
  stoppedPodId?: string;
  /** Wait for this pod's ComfyUI to become READY (stats+queue), THEN retarget
   *  + watch — the ORCHESTRATOR waits, so the tool call returns inside the
   *  MCP 60s request lifetime instead of blocking for minutes (codex). */
  connectWhenReady?: { url: string; podId: string };
  /** Pod to watch (status broadcast + idle auto-stop) after the retarget. */
  watchPodId?: string;
  /** Stop watching entirely (local switch). */
  unwatch?: boolean;
  /** Scope the unwatch to THIS pod (stop-fallback): the orchestrator unwatches
   *  only when it's actually watching this one — an unrelated watched pod must
   *  survive a different pod's stop (codex finding). */
  unwatchPodId?: string;
  /** Set when the requester will block on awaitTargetApplied — the orchestrator
   *  writes an applied-ack ONLY for these (fire-and-forget requests would leak
   *  ack files nobody consumes — codex finding). */
  wantAck?: boolean;
  updated: number;
}

const CONTROL_TTL_MS = 60_000; // a request older than this is stale — ignore
/** Per-request control files are prefixed so the orchestrator consumes EXACTLY
 *  the file it read (no read-then-delete race between agent children, and no
 *  timestamp-collision identity problems — codex finding). Kept OUT of
 *  pollDownloads' tray rows via the "control-" prefix (applied-acks too). */
export const CONTROL_PREFIX = "control-";
const REQUEST_PREFIX = `${CONTROL_PREFIX}target-`;
const APPLIED_PREFIX = `${CONTROL_PREFIX}applied-`;
let controlSeq = 0;

function controlDirPath(dir: string = channelDir()): string | null {
  return dir || null;
}

/** Ask the orchestrator to retarget (+ optionally watch a pod). Returns the
 *  request file path (for awaitTargetApplied), or null when the channel is
 *  inactive (no progress dir). */
export function requestTargetChange(req: Omit<TargetChangeRequest, "updated">): string | null {
  const dir = controlDirPath();
  if (!dir) return null;
  try {
    mkdirSync(dir, { recursive: true });
    // Redact any credential-bearing target URL before it touches disk (codex).
    const safe: Omit<TargetChangeRequest, "updated"> = {
      ...req,
      ...(req.url ? { url: redactUrl(req.url) } : {}),
      ...(req.connectWhenReady ? { connectWhenReady: { ...req.connectWhenReady, url: redactUrl(req.connectWhenReady.url) } } : {}),
    };
    // Unique-per-request file: consumption deletes exactly this name — a second
    // child's request can never be clobbered by the first's delete.
    const file = join(dir, `${REQUEST_PREFIX}${process.pid}-${Date.now()}-${controlSeq++}.json`);
    writeFileSync(file, JSON.stringify({ ...safe, updated: Date.now() }));
    return file;
  } catch {
    return null; // best-effort — the caller's own retarget still happened
  }
}

/** The ack file the orchestrator writes after applying a given request file. */
function appliedFileFor(requestFile: string): string {
  return join(dirname(requestFile), `${APPLIED_PREFIX}${basename(requestFile).slice(REQUEST_PREFIX.length)}`);
}

/** Child side: wait for the orchestrator to apply our request and report the
 *  RESULTING target (its own remembered LAN fallback included — the child
 *  can't compute it, codex finding). Returns the ack, or null on timeout —
 *  callers must then report honestly rather than guess 127.0.0.1. */
export async function awaitTargetApplied(requestFile: string, timeoutMs = 4_000): Promise<{ url: string; applied: boolean } | null> {
  const ack = appliedFileFor(requestFile);
  const start = Date.now();
  for (;;) {
    try {
      const raw = JSON.parse(readFileSync(ack, "utf-8")) as { url?: string; applied?: boolean };
      if (typeof raw?.url === "string") {
        rmSync(ack, { force: true }); // consumed — don't leak it into a later poll
        return { url: raw.url, applied: raw.applied !== false };
      }
    } catch {
      // not applied yet
    }
    if (Date.now() - start > timeoutMs) return null;
    await new Promise((r) => setTimeout(r, 150));
  }
}

export interface PendingTargetChange {
  req: TargetChangeRequest;
  file: string;
}

/** Orchestrator side: all fresh pending requests (within TTL), oldest first.
 *  The dir is EXPLICIT: the orchestrator computes progressDir itself while the
 *  module-level env capture is unset in its own process (codex finding — the
 *  channel was write-only: children stamped, nobody read). */
export function listTargetChangeRequests(dir: string): PendingTargetChange[] {
  const out: PendingTargetChange[] = [];
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => f.startsWith(REQUEST_PREFIX) && f.endsWith(".json"));
  } catch {
    return out;
  }
  for (const f of files) {
    try {
      const file = join(dir, f);
      const raw = JSON.parse(readFileSync(file, "utf-8")) as TargetChangeRequest;
      if (typeof raw?.updated !== "number") continue;
      if (!raw.url && !raw.local && !raw.watchPodId && !raw.unwatch && !raw.connectWhenReady && !raw.stoppedPodId) continue;
      if (Date.now() - raw.updated > CONTROL_TTL_MS) {
        rmSync(file, { force: true }); // reap stale requests while we're here
        continue;
      }
      out.push({ req: raw, file });
    } catch {
      // mid-write or corrupt — retry next tick
    }
  }
  return out.sort((a, b) => a.req.updated - b.req.updated);
}

/** Orchestrator side: after applying a request, ack it with the RESULTING
 *  target so the requesting child can align its own process to the TRUE
 *  fallback/target (it can't compute the orchestrator's remembered LAN URL —
 *  codex finding). `applied` reports whether a guarded (onlyIfTarget) request
 *  was actually applied — a guarded-out request must not read as a successful
 *  local switch (codex finding). Best-effort; the child times out gracefully. */
export function ackTargetChange(requestFile: string, url: string, applied = true): void {
  try {
    writeFileSync(appliedFileFor(requestFile), JSON.stringify({ url, applied, updated: Date.now() }));
  } catch {
    // ignore
  }
}

/** Orchestrator side: consume one applied request file (exactly the file that
 *  was read — never a newer replacement, since each request is its own file). */
export function consumeTargetChange(file: string): void {
  try {
    rmSync(file, { force: true });
  } catch {
    // ignore
  }
}
