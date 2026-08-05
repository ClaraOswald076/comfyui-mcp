// Persistent catalog of local LoRA files with human/agent-readable metadata:
// descriptions, setup instructions, trigger keywords, strength hints, and
// preview images. Synced against listLocalModels('loras') so missing files are
// flagged without dropping curated notes.

import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { getInstanceSlug } from "../config.js";
import { listLocalModels, type LocalModel } from "./model-resolver.js";
import { writeFileDurable } from "../utils/durable-write.js";
import { logger } from "../utils/logger.js";

/** ComfyUI-relative path under models/ (e.g. "loras/style/foo.safetensors"). */
export type LoraRelPath = string;

export interface LoraCatalogEntry {
  /** Stable slug derived from relPath. */
  id: string;
  /** Path relative to ComfyUI models/ root. */
  relPath: LoraRelPath;
  /** Short label for pickers and UI. */
  displayName: string;
  /** What this LoRA does — style, subject, effect, etc. */
  description: string;
  /** How to wire it: checkpoint pairing, node type, clip placement, etc. */
  setupInstructions: string;
  /** Trigger words / tokens to include in prompts. */
  keywords: string[];
  /** Optional tokens to avoid or negative-prompt hints. */
  negativeKeywords?: string[];
  /** Compatible base models (SDXL, Flux, Pony, etc.). */
  baseModels: string[];
  /** Suggested strength range and default for LoraLoader widgets. */
  strengthMin?: number;
  strengthMax?: number;
  strengthDefault?: number;
  /** Filename under the instance previews dir (not absolute). */
  previewFile?: string;
  /** Optional CivitAI / source links. */
  civitaiModelId?: number;
  civitaiVersionId?: number;
  sourceUrl?: string;
  tags?: string[];
  notes?: string;
  /** Present after sync when the file is no longer on disk. */
  missing?: boolean;
  fileSize?: number;
  modifiedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface LoraCatalogFile {
  version: 1;
  entries: Record<string, LoraCatalogEntry>;
}

export interface LoraCatalogListOptions {
  query?: string;
  includeMissing?: boolean;
  tag?: string;
  baseModel?: string;
  limit?: number;
}

export interface LoraCatalogSyncResult {
  scanned: number;
  added: number;
  updated: number;
  markedMissing: number;
  total: number;
}

const CATALOG_VERSION = 1 as const;
const PREVIEW_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

function dataBaseDir(): string {
  return process.env.COMFYUI_MCP_DATA_DIR?.trim() || join(homedir(), ".comfyui-mcp");
}

/** Override for tests. */
export function loraCatalogPath(): string {
  const override = process.env.COMFYUI_MCP_LORA_CATALOG?.trim();
  if (override) return override;
  const slug = getInstanceSlug();
  return join(dataBaseDir(), "instances", slug, "lora-catalog.json");
}

export function loraPreviewsDir(): string {
  const override = process.env.COMFYUI_MCP_LORA_PREVIEWS?.trim();
  if (override) return override;
  const slug = getInstanceSlug();
  return join(dataBaseDir(), "instances", slug, "lora-previews");
}

export function loraIdFromPath(relPath: string): string {
  const base = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
  const slug = base
    .toLowerCase()
    .replace(/\.(safetensors|ckpt|pt|bin)$/i, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "lora";
}

function defaultDisplayName(relPath: string): string {
  const file = basename(relPath);
  return file.replace(/\.(safetensors|ckpt|pt|bin)$/i, "").replace(/_/g, " ");
}

/**
 * The on-disk catalog read THREE ways: absent (start fresh), parsed (use it),
 * or CORRUPT (present but unparseable — crash-truncated, hand-edited wrong).
 * The third must never be folded into the first: an empty in-memory catalog
 * written back over a corrupt file destroys whatever curation the file still
 * holds — "could not determine" becoming "determined empty" with data loss.
 */
interface CatalogRead {
  data: LoraCatalogFile;
  /** Why the existing file could not be used — set only when it EXISTS. */
  corrupt?: string;
}

/** The catalog file's raw text, three ways: absent, unreadable, or the bytes. */
function readCatalogRaw(path: string): { raw?: string; unreadable?: string } {
  // NO existsSync pre-screen: it cannot tell "absent" from "cannot look" (an
  // unsearchable ancestor answers false either way), and a false "absent"
  // would let a later write overwrite a catalog we merely failed to SEE.
  try {
    return { raw: readFileSync(path, "utf-8") };
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return {};
    return { unreadable: err instanceof Error ? err.message : String(err) };
  }
}

/** Parse raw catalog text, setting aside malformed entry VALUES. */
function parseCatalogRaw(raw: string): CatalogRead {
  try {
    const parsed = JSON.parse(raw) as unknown;
    const entries = (parsed as LoraCatalogFile | null)?.entries;
    if (
      parsed &&
      typeof parsed === "object" &&
      (parsed as LoraCatalogFile).version === CATALOG_VERSION &&
      // null passes typeof "object"; an ARRAY passes it too but string-keyed
      // upserts on it do not survive JSON.stringify — the write would report
      // success and persist nothing. Only a plain record is a catalog.
      entries !== null &&
      entries !== undefined &&
      typeof entries === "object" &&
      !Array.isArray(entries)
    ) {
      // The record itself is shaped right, but individual VALUES may not be
      // (a hand-edit or a partial write leaves "some-lora": null or {} behind
      // — a null crashes list(), a missing displayName crashes the sort, a
      // missing id makes remove() "delete" a key of `undefined`, a key that
      // is not the entry's id makes remove() delete nothing while reporting
      // the removal done, a string in an array field (or a non-string member)
      // crashes .some(x => x.toLowerCase()), a non-string previewFile makes
      // remove() throw AFTER the entry was durably deleted, and a null
      // createdAt is silently coalesced on the next write). The bar is the
      // shape every write path in this file produces. Keep the valid
      // entries, and mark the file corrupt so the next write PRESERVES the
      // original before replacing it.
      const clean: Record<string, LoraCatalogEntry> = {};
      const dropped: string[] = [];
      for (const [key, value] of Object.entries(entries)) {
        const v = value as LoraCatalogEntry | null;
        const rec = v as unknown as Record<string, unknown> | null;
        const stringArray = (f: string, required: boolean) => {
          const arr = rec?.[f];
          if (arr === undefined) return !required;
          return Array.isArray(arr) && arr.every((x) => typeof x === "string");
        };
        const optString = (f: string) =>
          rec?.[f] === undefined || typeof rec?.[f] === "string";
        const optNumber = (f: string) =>
          rec?.[f] === undefined || typeof rec?.[f] === "number";
        if (
          v &&
          typeof v === "object" &&
          !Array.isArray(v) &&
          v.id === key &&
          typeof v.relPath === "string" &&
          typeof v.displayName === "string" &&
          typeof rec!.createdAt === "string" &&
          typeof rec!.updatedAt === "string" &&
          typeof rec!.description === "string" &&
          typeof rec!.setupInstructions === "string" &&
          stringArray("keywords", true) &&
          stringArray("baseModels", true) &&
          stringArray("negativeKeywords", false) &&
          stringArray("tags", false) &&
          ["previewFile", "sourceUrl", "notes", "modifiedAt"].every(optString) &&
          ["strengthMin", "strengthMax", "strengthDefault", "civitaiModelId", "civitaiVersionId", "fileSize"].every(optNumber) &&
          // "missing": "false" is truthy — a present LoRA would list as missing.
          (rec!.missing === undefined || typeof rec!.missing === "boolean")
        ) {
          clean[key] = value;
        } else {
          dropped.push(key);
        }
      }
      if (dropped.length === 0) return { data: parsed as LoraCatalogFile };
      const detail =
        `${dropped.length} malformed ${dropped.length === 1 ? "entry" : "entries"} ` +
        `(${dropped.slice(0, 3).join(", ")}${dropped.length > 3 ? ", …" : ""})`;
      return {
        data: { ...(parsed as LoraCatalogFile), entries: clean },
        corrupt: detail,
      };
    }
    return { data: { version: CATALOG_VERSION, entries: {} }, corrupt: "not a v1 catalog" };
  } catch (err) {
    return {
      data: { version: CATALOG_VERSION, entries: {} },
      corrupt: err instanceof Error ? err.message : String(err),
    };
  }
}

function writeCatalogFile(data: LoraCatalogFile): void {
  const path = loraCatalogPath();
  mkdirSync(dirname(path), { recursive: true });
  // Temp + fsync + atomic rename (#798): a truncate-and-write can leave a TORN
  // catalog after a crash, which every later read then correctly refuses to
  // trust — the curation is not lost but it is unusable until someone repairs
  // the file by hand.
  writeFileDurable(path, JSON.stringify(data, null, 2));
}

/** Monotonic suffix so two backups in the same millisecond never collide. */
let backupSeq = 0;

// ---------------------------------------------------------------------------
// Cross-process write lock
//
// `persist()` is a read-modify-write, and two agents on one rig is ordinary
// here. Without exclusion both processes read the same healthy bytes, both pass
// the unchanged check, and the second write silently erases the first — and
// because BOTH probes were healthy neither takes the corrupt-file backup, so
// there is nothing to recover from either.
//
// Re-reading immediately before the write does NOT close that. It shrinks the
// window to microseconds and leaves the loss silent, which is the same fold one
// order of magnitude smaller: "we did not catch a concurrent writer" read as
// "there is no concurrent writer". Only an exclusive create ("wx" = O_EXCL,
// atomic across processes) actually excludes one.
//
// The lock covers writers running THIS code. A hand-edit lands wherever it
// lands — that is the user editing their own file, and the baseline check
// already catches the ones that complete before our read.
// ---------------------------------------------------------------------------

/** How long a write waits for another writer's turn before refusing. A held
 *  lock covers one read and one write — milliseconds — so this is already a
 *  long queue, and the caller gets an honest "not saved, retry" rather than an
 *  unbounded stall. */
const CATALOG_LOCK_WAIT_MS = 2_000;

/** Three orders of magnitude past how long a holder is ever inside the critical
 *  section, so no live writer can age its own lock into reclaimability. Only a
 *  crash leaves a lock this old — which is also what makes the release below
 *  safe (see there). */
const CATALOG_LOCK_STALE_MS = 30_000;

/** Cross-platform pid liveness. EPERM means a process with that number EXISTS
 *  and is simply not ours to signal — alive, not dead. Reading it as dead is
 *  what would let a live holder's lock be reclaimed out from under it. */
function catalogLockOwnerAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

/** Block this thread briefly. persist() and every caller of it are synchronous
 *  all the way up, and a contended wait here is milliseconds long. */
function napSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Whoever holds the lock, as far as the file can say. An unreadable or
 *  truncated record names NO holder — which is not evidence of an abandoned
 *  lock, only an absence of evidence: the age check below is what licenses a
 *  reclaim. */
function readCatalogLockPid(lockPath: string): number | undefined {
  try {
    const rec = JSON.parse(readFileSync(lockPath, "utf-8")) as { pid?: unknown };
    return typeof rec.pid === "number" ? rec.pid : undefined;
  } catch {
    return undefined;
  }
}

/** Remove a lock ONLY when it is provably abandoned: older than any live holder
 *  could be, AND owned by a pid that is gone (or by no readable pid at all).
 *  Every other state waits — deleting a lock whose holder is still inside its
 *  critical section reintroduces exactly the loss the lock prevents. */
function reclaimAbandonedCatalogLock(lockPath: string): boolean {
  let observed: number;
  try {
    observed = statSync(lockPath).mtimeMs;
  } catch {
    return true; // already gone — the path is free, retry the create
  }
  if (Date.now() - observed < CATALOG_LOCK_STALE_MS) return false;
  const pid = readCatalogLockPid(lockPath);
  if (pid !== undefined && catalogLockOwnerAlive(pid)) return false;
  try {
    // Delete only the exact instance just judged. A lock taken in the gap is
    // brand new, so its mtime cannot match one already CATALOG_LOCK_STALE_MS
    // old — and freeing a fresh holder's path is the one mistake a reclaim
    // must never make.
    if (statSync(lockPath).mtimeMs !== observed) return false;
    rmSync(lockPath, { force: true });
    logger.warn(
      `[lora-catalog] reclaimed an abandoned write lock at ${lockPath} (owner ` +
        `${pid === undefined ? "unrecorded" : `pid ${pid}`} is no longer running).`,
    );
    return true;
  } catch {
    return false; // could not remove it — wait it out rather than assume
  }
}

/** Take the catalog write lock, or THROW. Refuse-vs-disclose: nothing has been
 *  written yet, so a failure here refuses the change outright and says so. */
function acquireCatalogLock(path: string): { lockPath: string; token: string } {
  const lockPath = `${path}.lock`;
  const token = randomUUID();
  const deadline = Date.now() + CATALOG_LOCK_WAIT_MS;
  for (;;) {
    try {
      mkdirSync(dirname(lockPath), { recursive: true });
      const fd = openSync(lockPath, "wx");
      try {
        try {
          writeFileSync(fd, JSON.stringify({ pid: process.pid, token, at: new Date().toISOString() }));
        } finally {
          closeSync(fd);
        }
      } catch (initErr) {
        // Created but not identified. A lock nothing can attribute is one no
        // later writer can wait on intelligently, so remove our own husk rather
        // than leave it for the staleness timer.
        try {
          rmSync(lockPath, { force: true });
        } catch {
          // The init failure is the one worth reporting.
        }
        throw initErr;
      }
      return { lockPath, token };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      // ONLY EEXIST is contention. A create that fails because the volume is
      // full or read-only must surface now, not burn the whole budget first
      // and then be reported as somebody else's lock.
      if (code !== "EEXIST") {
        throw new Error(
          `Could not take the LoRA catalog write lock at ${lockPath} ` +
            `(${err instanceof Error ? err.message : String(err)}). This change was NOT saved.`,
        );
      }
      if (reclaimAbandonedCatalogLock(lockPath)) continue;
      if (Date.now() >= deadline) {
        throw new Error(
          `Another writer has held the LoRA catalog lock at ${lockPath} for more than ` +
            `${Math.round(CATALOG_LOCK_WAIT_MS / 1000)}s. This change was NOT saved — re-read ` +
            `and retry. If no other comfyui-mcp process is running, delete that file.`,
        );
      }
      napSync(25);
    }
  }
}

/** Release the lock this call took. */
function releaseCatalogLock(lockPath: string, token: string): void {
  // A lock is reclaimed only when it is BOTH older than CATALOG_LOCK_STALE_MS
  // and owned by a pid that is gone — and this process is alive and has been
  // inside the critical section for milliseconds, so ours cannot have been
  // taken and replaced. The token check makes that reasoning checkable instead
  // of assumed: if what is at the path is somehow not ours, leave it alone
  // rather than free a path another writer owns.
  let holder: string | undefined;
  try {
    holder = (JSON.parse(readFileSync(lockPath, "utf-8")) as { token?: string }).token;
  } catch {
    // Unreadable: no other writer could have put it there (see above), and
    // leaving it would stall every write for CATALOG_LOCK_STALE_MS.
  }
  if (holder !== undefined && holder !== token) {
    logger.warn(
      `[lora-catalog] the write lock at ${lockPath} is no longer the one this write took; ` +
        `leaving it in place for its owner.`,
    );
    return;
  }
  try {
    rmSync(lockPath, { force: true });
  } catch (err) {
    logger.warn(
      `[lora-catalog] could not release the write lock at ${lockPath} ` +
        `(${err instanceof Error ? err.message : String(err)}). Catalog writes will wait ` +
        `and then refuse until it is removed or ages out.`,
    );
  }
}

/** Run `fn` with the catalog write lock held. */
function withCatalogWriteLock<T>(path: string, fn: () => T): T {
  const { lockPath, token } = acquireCatalogLock(path);
  try {
    return fn();
  } finally {
    releaseCatalogLock(lockPath, token);
  }
}

function normalizeRelPath(path: string): string {
  const p = path.replace(/\\/g, "/").replace(/^\/+/, "");
  if (p.startsWith("models/")) return p.slice("models/".length);
  if (!p.startsWith("loras/") && !p.includes("/")) return `loras/${p}`;
  return p;
}

function entryFromLocal(model: LocalModel, now: string): LoraCatalogEntry {
  const relPath = normalizeRelPath(model.path.startsWith("loras/") ? model.path : `loras/${model.name}`);
  const id = loraIdFromPath(relPath);
  return {
    id,
    relPath,
    displayName: defaultDisplayName(relPath),
    description: "",
    setupInstructions: "",
    keywords: [],
    baseModels: [],
    fileSize: model.size || undefined,
    modifiedAt: model.modified || undefined,
    missing: false,
    createdAt: now,
    updatedAt: now,
  };
}

function mergeDiskEntry(existing: LoraCatalogEntry | undefined, disk: LoraCatalogEntry): LoraCatalogEntry {
  if (!existing) return disk;
  return {
    ...existing,
    relPath: disk.relPath,
    fileSize: disk.fileSize,
    modifiedAt: disk.modifiedAt,
    missing: false,
    updatedAt: new Date().toISOString(),
  };
}

function matchesQuery(entry: LoraCatalogEntry, query: string): boolean {
  const q = query.toLowerCase().trim();
  if (!q) return true;
  const hay = [
    entry.displayName,
    entry.relPath,
    entry.description,
    entry.setupInstructions,
    entry.notes ?? "",
    ...(entry.keywords ?? []),
    ...(entry.tags ?? []),
    ...(entry.baseModels ?? []),
  ]
    .join(" ")
    .toLowerCase();
  return hay.includes(q);
}

/** Public summary shape for panel UI and pickers. */
export function toLoraSummary(entry: LoraCatalogEntry): Record<string, unknown> {
  const previewUrl = entry.previewFile
    ? join(loraPreviewsDir(), entry.previewFile)
    : undefined;
  return {
    id: entry.id,
    relPath: entry.relPath,
    displayName: entry.displayName,
    description: entry.description,
    setupInstructions: entry.setupInstructions,
    keywords: entry.keywords,
    negativeKeywords: entry.negativeKeywords ?? [],
    baseModels: entry.baseModels,
    strengthDefault: entry.strengthDefault,
    strengthMin: entry.strengthMin,
    strengthMax: entry.strengthMax,
    previewFile: entry.previewFile,
    previewPath: previewUrl && existsSync(previewUrl) ? previewUrl : undefined,
    tags: entry.tags ?? [],
    missing: !!entry.missing,
    sourceUrl: entry.sourceUrl,
  };
}

/**
 * Is this preview file still referenced by the catalog AS IT NOW IS ON DISK?
 * Checked before deleting: another writer may have persisted a reference to
 * the file after our own write, and deleting it would orphan THEIR entry.
 * A failed re-read answers "referenced" — the safe side for a delete.
 */
function previewReferencedOnDisk(previewFile: string): boolean {
  const probe = readCatalogRaw(loraCatalogPath());
  if (!probe.raw) return true; // unreadable/absent → do not delete
  const read = parseCatalogRaw(probe.raw);
  // A corrupt catalog says NOTHING about what references the file — the safe
  // answer for a delete is "referenced".
  if (read.corrupt) return true;
  return Object.values(read.data.entries).some((e) => e.previewFile === previewFile);
}

/** Delete a preview file only once nothing on disk references it. */
function deletePreviewIfUnreferenced(previewsDirPath: string, previewFile: string): void {
  if (previewReferencedOnDisk(previewFile)) return;
  const p = join(previewsDirPath, previewFile);
  if (existsSync(p)) {
    try {
      unlinkSync(p);
    } catch {
      /* best effort */
    }
  }
}

export class LoraCatalog {
  // Immediately overwritten by reload() from the constructor.
  private data: LoraCatalogFile = { version: CATALOG_VERSION, entries: {} };
  /**
   * The on-disk state `this.data` was built from — the baseline every write
   * is checked against. `{}` (neither field) means the file was absent.
   */
  private baseline: { raw?: string; unreadable?: string } = {};

  constructor() {
    this.reload();
  }

  reload(): void {
    const path = loraCatalogPath();
    const probe = readCatalogRaw(path);
    this.baseline = probe;
    if (probe.unreadable) {
      logger.warn(`[lora-catalog] could not read ${path}: ${probe.unreadable}`);
      this.data = { version: CATALOG_VERSION, entries: {} };
      return;
    }
    if (probe.raw === undefined) {
      this.data = { version: CATALOG_VERSION, entries: {} };
      return;
    }
    const read = parseCatalogRaw(probe.raw);
    if (read.corrupt) {
      logger.warn(
        `[lora-catalog] ${path}: ${read.corrupt}; the original will be preserved before any write replaces it.`,
      );
    }
    this.data = read.data;
  }

  /**
   * Persist — but NEVER over a corrupt original without preserving it first.
   * The corrupt file is the only copy of whatever curation it still holds;
   * overwriting it unread is the rescue path deleting the thing it rescues.
   * If it cannot even be copied, refuse the write outright: a loud failure
   * beats silent data loss.
   *
   * All of it runs under the cross-process write lock, because every check
   * below is a read and the write is a separate syscall: without exclusion two
   * processes can each pass every check against the same healthy bytes and the
   * second write erases the first, silently and with no backup taken (both
   * probes were healthy, so neither branch preserves anything).
   *
   * THREE checks before anything is replaced:
   *  - STALE-INSTANCE: the file must still be the state this.data was built
   *    from. Another writer's COMPLETED, healthy update is refused (re-read
   *    and retry) rather than silently overwritten; a file that became
   *    CORRUPT since our read is preserved and then replaced (nothing
   *    readable is lost — our in-memory state is the newer good copy of it).
   *  - MID-PERSIST RACE: the bytes probed must still be the bytes on disk
   *    when the write begins. The lock excludes every writer running this
   *    code, so what is left for this to catch is a foreign one — a hand-edit
   *    landing between the two reads.
   *  - POST-WRITE: what is actually ON DISK afterwards, not what we intended
   *    to put there. A write that returned without throwing is not by itself
   *    proof the bytes arrived.
   *
   * And on ANY failure, re-sync from disk before rethrowing: the caller is
   * about to see this mutation as FAILED, so it must not linger in memory —
   * a later persist would silently commit what was reported as not applied.
   */
  private persist(): void {
    try {
      const path = loraCatalogPath();
      withCatalogWriteLock(path, () => this.persistLocked(path));
    } catch (err) {
      // reload() never throws (a failed read degrades to empty + corrupt).
      this.reload();
      throw err;
    }
  }

  /** The persist itself, with the write lock already held. */
  private persistLocked(path: string): void {
    {
      const probe = readCatalogRaw(path);
      const now = readCatalogRaw(path);
      if (now.raw !== probe.raw || now.unreadable !== probe.unreadable) {
        throw new Error(
          `The LoRA catalog at ${path} changed on disk while this write was being ` +
            `prepared — NOT overwriting another writer's update. This change was not ` +
            `saved; re-read and retry.`,
        );
      }
      const unchanged =
        probe.raw === this.baseline.raw && probe.unreadable === this.baseline.unreadable;
      const probeParsed = probe.raw !== undefined ? parseCatalogRaw(probe.raw) : undefined;
      const corrupt = probe.unreadable ?? probeParsed?.corrupt;
      if (!unchanged && !corrupt) {
        throw new Error(
          `The LoRA catalog at ${path} changed on disk since it was read — NOT ` +
            `overwriting another writer's update. This change was not saved; re-read ` +
            `and retry.`,
        );
      }
      if (corrupt) {
        const action = probe.unreadable ? "read" : "parsed";
        // Unique per process AND per backup within it: two stale instances
        // sharing a Date.now() tick must not have the second backup overwrite
        // the first — that would erase the corrupt original after all.
        const backup = `${path}.corrupt-${Date.now()}-${process.pid}-${backupSeq++}`;
        try {
          copyFileSync(path, backup);
          logger.warn(
            `[lora-catalog] the catalog at ${path} could not be ${action} (${corrupt}); ` +
              `the original was preserved at ${backup} before being replaced.`,
          );
        } catch (err) {
          throw new Error(
            `The LoRA catalog at ${path} could not be ${action} (${corrupt}) and ` +
              `could not be preserved either (${err instanceof Error ? err.message : String(err)}). ` +
              `Refusing to overwrite it — inspect or repair the file manually.`,
          );
        }
      }
      const intended = JSON.stringify(this.data, null, 2);
      writeCatalogFile(this.data);
      // The baseline is what is ACTUALLY on disk, read back — not what we meant
      // to put there. Taking the intended bytes on faith is how a write that
      // landed somewhere else, or landed short, becomes the state every later
      // persist compares against: the next unchanged check would then pass on a
      // file nobody ever wrote, and quietly overwrite whatever is really there.
      const written = readCatalogRaw(path);
      if (written.raw === intended) {
        this.baseline = { raw: written.raw };
        return;
      }
      if (written.unreadable && probe.unreadable) {
        // The catalog could not be read BEFORE this write either, so the
        // read-back carries no new information — and refusing on it would
        // refuse every write to a catalog this process can write but not read,
        // permanently, for a write that most likely landed. That is the fold
        // pointed the other way. DISCLOSE instead: the write has happened, only
        // its confirmation is missing, and the baseline records what was
        // actually observed rather than what we hoped for.
        logger.warn(
          `[lora-catalog] wrote ${path}, but it still cannot be read back ` +
            `(${written.unreadable}) — the write is UNCONFIRMED. Check the file's ` +
            `permissions if entries appear to go missing.`,
        );
        this.baseline = { unreadable: written.unreadable };
        return;
      }
      // The file was readable going in and does not hold what we just wrote, so
      // something is genuinely wrong with the write path. Say only that — NOT
      // that the change was discarded; persist()'s reload picks it up if it did
      // in fact land.
      throw new Error(
        `The LoRA catalog at ${path} does not read back as what was just written ` +
          `(${
            written.unreadable
              ? `it could not be read: ${written.unreadable}`
              : written.raw === undefined
                ? "it is not there"
                : "its contents differ"
          }). This change is NOT confirmed saved — inspect the file, then retry.`,
      );
    }
  }

  list(opts: LoraCatalogListOptions = {}): LoraCatalogEntry[] {
    let entries = Object.values(this.data.entries);
    if (!opts.includeMissing) entries = entries.filter((e) => !e.missing);
    if (opts.tag) {
      const t = opts.tag.toLowerCase();
      entries = entries.filter((e) => (e.tags ?? []).some((x) => x.toLowerCase() === t));
    }
    if (opts.baseModel) {
      const b = opts.baseModel.toLowerCase();
      entries = entries.filter((e) =>
        (e.baseModels ?? []).some((x) => x.toLowerCase().includes(b)),
      );
    }
    if (opts.query) entries = entries.filter((e) => matchesQuery(e, opts.query!));
    entries.sort((a, b) => a.displayName.localeCompare(b.displayName));
    if (typeof opts.limit === "number" && opts.limit > 0) {
      entries = entries.slice(0, opts.limit);
    }
    return entries;
  }

  get(idOrPath: string): LoraCatalogEntry | null {
    const key = idOrPath.trim();
    if (this.data.entries[key]) return this.data.entries[key];
    const norm = normalizeRelPath(key);
    const id = loraIdFromPath(norm);
    if (this.data.entries[id]) return this.data.entries[id];
    for (const e of Object.values(this.data.entries)) {
      if (e.relPath === norm || e.relPath.endsWith(`/${basename(norm)}`)) return e;
    }
    return null;
  }

  async syncFromDisk(): Promise<LoraCatalogSyncResult> {
    const models = await listLocalModels("loras");
    const now = new Date().toISOString();
    const seenIds = new Set<string>();
    let added = 0;
    let updated = 0;

    for (const model of models) {
      const disk = entryFromLocal(model, now);
      seenIds.add(disk.id);
      const prev = this.data.entries[disk.id];
      if (!prev) {
        this.data.entries[disk.id] = disk;
        added++;
      } else {
        const wasMissing = !!prev.missing;
        this.data.entries[disk.id] = mergeDiskEntry(prev, disk);
        if (wasMissing) updated++;
      }
    }

    let markedMissing = 0;
    for (const [id, entry] of Object.entries(this.data.entries)) {
      if (!seenIds.has(id) && !entry.missing) {
        entry.missing = true;
        entry.updatedAt = now;
        markedMissing++;
      }
    }

    this.persist();
    return {
      scanned: models.length,
      added,
      updated: updated + markedMissing,
      markedMissing,
      total: Object.keys(this.data.entries).length,
    };
  }

  upsert(partial: Partial<LoraCatalogEntry> & { relPath?: string; id?: string }): LoraCatalogEntry {
    const now = new Date().toISOString();
    let id = partial.id?.trim();
    let relPath = partial.relPath ? normalizeRelPath(partial.relPath) : undefined;

    if (!id && relPath) id = loraIdFromPath(relPath);
    if (id && !relPath) relPath = this.data.entries[id]?.relPath;
    if (!id || !relPath) {
      throw new Error("upsert requires id or relPath");
    }

    const prev = this.data.entries[id];
    const entry: LoraCatalogEntry = {
      id,
      relPath,
      displayName: partial.displayName?.trim() || prev?.displayName || defaultDisplayName(relPath),
      description: partial.description ?? prev?.description ?? "",
      setupInstructions: partial.setupInstructions ?? prev?.setupInstructions ?? "",
      keywords: partial.keywords ?? prev?.keywords ?? [],
      negativeKeywords: partial.negativeKeywords ?? prev?.negativeKeywords,
      baseModels: partial.baseModels ?? prev?.baseModels ?? [],
      strengthMin: partial.strengthMin ?? prev?.strengthMin,
      strengthMax: partial.strengthMax ?? prev?.strengthMax,
      strengthDefault: partial.strengthDefault ?? prev?.strengthDefault,
      previewFile: partial.previewFile ?? prev?.previewFile,
      civitaiModelId: partial.civitaiModelId ?? prev?.civitaiModelId,
      civitaiVersionId: partial.civitaiVersionId ?? prev?.civitaiVersionId,
      sourceUrl: partial.sourceUrl ?? prev?.sourceUrl,
      tags: partial.tags ?? prev?.tags,
      notes: partial.notes ?? prev?.notes,
      missing: partial.missing ?? prev?.missing,
      fileSize: partial.fileSize ?? prev?.fileSize,
      modifiedAt: partial.modifiedAt ?? prev?.modifiedAt,
      createdAt: prev?.createdAt ?? now,
      updatedAt: now,
    };

    this.data.entries[id] = entry;
    this.persist();
    return entry;
  }

  setPreview(idOrPath: string, sourcePath: string): LoraCatalogEntry {
    const entry = this.get(idOrPath);
    if (!entry) throw new Error(`No catalog entry for "${idOrPath}"`);

    const src = sourcePath.trim();
    if (!existsSync(src)) throw new Error(`Preview source not found: ${src}`);
    const ext = extname(src).toLowerCase();
    if (!PREVIEW_EXTS.has(ext)) {
      throw new Error(`Preview must be an image (${[...PREVIEW_EXTS].join(", ")})`);
    }

    const dir = loraPreviewsDir();
    mkdirSync(dir, { recursive: true });
    const destName = `${entry.id}${ext}`;
    const dest = join(dir, destName);

    // Write the new preview and PERSIST the reference before deleting the old
    // one: persist can refuse (a concurrently-changed catalog, an
    // unpreservable corrupt original), and an old preview deleted ahead of a
    // failed persist leaves the surviving entry pointing at a file that is
    // gone. An orphaned NEW preview after a failed persist is the harmless
    // direction.
    copyFileSync(src, dest);
    let updated: LoraCatalogEntry;
    try {
      updated = this.upsert({ id: entry.id, previewFile: destName });
    } catch (err) {
      // The file swap already happened; only its description failed. Disclose
      // BOTH — refusing as though nothing changed would misreport applied
      // work, and the retry reconciles the catalog with the file.
      throw new Error(
        `The preview image was already written to ${dest}, but recording it in the ` +
          `catalog FAILED: ${err instanceof Error ? err.message : String(err)}. ` +
          `The file on disk is the NEW preview; the catalog may still describe the old one — retry to reconcile.`,
      );
    }

    if (entry.previewFile && entry.previewFile !== destName) {
      deletePreviewIfUnreferenced(dir, entry.previewFile);
    }
    return updated;
  }

  remove(idOrPath: string): boolean {
    const entry = this.get(idOrPath);
    if (!entry) return false;
    delete this.data.entries[entry.id];
    // Persist BEFORE deleting the preview: a refused persist reloads the
    // entry (still referencing its preview), so the preview must still exist.
    this.persist();
    if (entry.previewFile) {
      deletePreviewIfUnreferenced(loraPreviewsDir(), entry.previewFile);
    }
    return true;
  }
}

let singleton: LoraCatalog | null = null;

export function getLoraCatalog(): LoraCatalog {
  if (!singleton) singleton = new LoraCatalog();
  else singleton.reload();
  return singleton;
}

/** Reset singleton — tests only. */
export function resetLoraCatalog(): void {
  singleton = null;
}