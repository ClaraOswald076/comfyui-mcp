import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { logger } from "../utils/logger.js";
import { SHARED_SESSION_SCOPE } from "../services/session-scope.js";
import { runningUnderTestRunner } from "../services/panel-secrets.js";

/**
 * Durable SDK session ids, so an agent's memory survives the orchestrator
 * PROCESS dying — a wedge auto-restart, a crash, an OOM — not just a soft
 * reload.
 *
 * SESSIONS ARE ORCHESTRATOR-SCOPED (#884, owner-stated invariant): one agent
 * session spans every panel, browser tab and open workflow this orchestrator
 * serves. The store is therefore keyed by the composite shared agent key
 * (`orchestrator::<backend>` — see src/services/session-scope.ts), one entry
 * per provider, and persisted in the user's config dir
 * (~/.comfyui-mcp/sessions/panel-sessions-<port>.json) — on disk, owned by the
 * orchestrator, never the browser. The panel's own localStorage copy is only a
 * last-resort hint for a wiped store. Keyed by the bridge port so two ComfyUI
 * instances on one machine never cross-resume.
 *
 * MIGRATIONS this constructor performs, once, on first load:
 *  - LOCATION: earlier builds wrote the file into the OS temp dir
 *    (world-writable on some systems, and routinely wiped). If the new file is
 *    absent and the tmpdir file exists, its `sessions` map is imported so an
 *    upgrade loses no history. The old file is left in place (an older
 *    orchestrator build may still be running against it); the OS reclaims it.
 *  - KEYING: earlier builds kept one session per (workflow tab, backend) —
 *    `wf:<path>::claude`, `tmp:<uuid>::codex`, … When the shared key for a
 *    backend has no entry yet, {@link get} adopts the MOST RECENTLY USED legacy
 *    entry for that backend as the shared conversation, so the user's newest
 *    per-workflow conversation becomes the one shared session instead of
 *    starting everyone from zero. Older legacy entries stay resumable via the
 *    panel's history picker (resume_session) and age out via GC.
 *  - The legacy `stable` index (per-workflow resume fallback for unsaved
 *    workflows, including its poison mechanism) is obsolete under a shared key
 *    that never churns — it is dropped on load, never read, never written.
 *
 * Entries carry a write timestamp and are GC'd on load (older than
 * {@link SessionStore.GC_TTL_MS}), so the file can't grow unbounded with dead
 * keys from prior runs.
 */

interface Entry {
  /** SDK session id to resume. */
  s: string;
  /** Epoch ms of the last write — for GC. */
  t: number;
  /** Optional workflow-identity binding retained from the per-workflow era.
   *  Unused for shared-scope keys (a shared session legitimately spans
   *  workflows); preserved on legacy entries so nothing is rewritten. */
  u?: string;
}

interface StoreFileV2 {
  v: 2;
  sessions: Record<string, Entry>;
}

const WORKFLOW_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The validated + canonicalized (origin, uuid) identity a panel hello/command
 *  claims, or undefined when either half is missing/untrusted. The origin MUST
 *  be the caller's SERVER-OBSERVED (unspoofable) handshake origin — never the
 *  client-supplied hello.comfyui_url. Still used for the per-command workflow
 *  STAMP (routing job: a command dispatched for workflow A must not mutate
 *  workflow B after a switch) — deliberately NOT for session identity, which is
 *  orchestrator-scoped (#884). */
export function workflowIdentityParts(opts: {
  workflowUuid?: string | undefined;
  origin?: string | undefined;
}): { origin: string; uuid: string } | undefined {
  const raw = typeof opts.workflowUuid === "string" ? opts.workflowUuid.trim() : "";
  const uuid = WORKFLOW_UUID_RE.test(raw) ? raw.toLowerCase() : "";
  if (!uuid) return undefined;
  const origin =
    typeof opts.origin === "string" ? opts.origin.trim().replace(/\/+$/, "").toLowerCase() : "";
  if (!origin) return undefined;
  return { origin, uuid };
}

/** Legacy-adoption screen: tab-id halves that must never seed the shared
 *  conversation (test/spike keys from prior runs). */
const LEGACY_ADOPT_EXCLUDE = /^(e2e-|spike-)/;

export class SessionStore {
  /** Entries untouched for longer than this are pruned on load. Resumes are
   *  same-day / few-days in practice; three weeks is a generous ceiling that
   *  still bounds growth. */
  static readonly GC_TTL_MS = 21 * 24 * 60 * 60 * 1000;

  private readonly path: string;
  /** The pre-#884 tmpdir location — read once for the location migration. */
  private readonly legacyPath: string;
  private sessions: Record<string, Entry>;

  constructor(port: number, opts: { dir?: string } = {}) {
    // #866 — guard at the WRITE, not per-test: this store lives in the user's
    // real ~/.comfyui-mcp, so a test that forgets to pass { dir } must refuse
    // loudly instead of silently polluting (and then reading back) real state.
    // Detection keys off the runner's own globals; when uncertain, the write is
    // allowed — a real user must never be refused their own store.
    if (!opts.dir && runningUnderTestRunner()) {
      throw new Error(
        "Refusing to open the real ~/.comfyui-mcp/sessions store from a test run: " +
          "pass { dir: <temp dir> } to SessionStore (see #866 — guard at the write, not per-test).",
      );
    }
    const dir = opts.dir ?? join(homedir(), ".comfyui-mcp", "sessions");
    this.path = join(dir, `panel-sessions-${port}.json`);
    this.legacyPath = join(tmpdir(), `comfyui-mcp-panel-sessions-${port}.json`);
    try {
      mkdirSync(dir, { recursive: true });
    } catch (err) {
      logger.warn(`[session-store] could not create ${dir}: ${String(err)}`);
    }
    const loaded = this.read();
    this.sessions = loaded.sessions;
    // If load had to SANITIZE (migrate the legacy format/location, GC an expired
    // entry, clamp a corrupt future timestamp), persist the cleaned version NOW —
    // otherwise a clamped-in-memory-only value survives on disk and is re-clamped
    // on every load, immortal.
    if (loaded.dirty) this.flush();
  }

  private now(): number {
    return Date.now();
  }

  /** Parse one store file's bytes into a sessions map, dropping malformed and
   *  expired rows. Handles the v2 shape and the ancient flat v1 map. */
  private parse(text: string): { sessions: Record<string, Entry>; dirty: boolean } {
    const empty = { sessions: {}, dirty: false };
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") return empty;
    const obj = parsed as Record<string, unknown>;
    const cutoff = this.now() - SessionStore.GC_TTL_MS;
    let dirty = false;
    const coerce = (raw: unknown): Record<string, Entry> => {
      const out: Record<string, Entry> = {};
      if (raw === undefined) return out;
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        dirty = true;
        return out;
      }
      const nowMs = this.now();
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        if (!v || typeof v !== "object") {
          dirty = true;
          continue;
        }
        const e = v as { s?: unknown; t?: unknown; u?: unknown };
        if (typeof e.s !== "string") {
          dirty = true;
          continue;
        }
        // Sanitize the timestamp: non-finite → epoch 0 (pruned as too old);
        // a finite FUTURE value is clamped to now so the TTL applies to it.
        const rawT = typeof e.t === "number" && Number.isFinite(e.t) ? e.t : 0;
        let t = rawT;
        if (t > nowMs) t = nowMs;
        if (t !== rawT) dirty = true;
        if (t < cutoff) {
          dirty = true;
          continue;
        }
        const entry: Entry = { s: e.s, t };
        if (typeof e.u === "string") entry.u = e.u;
        out[k] = entry;
      }
      return out;
    };
    if (obj.v === 2) {
      const sessions = coerce(obj.sessions);
      // A pre-#884 v2 file also carried a `stable` index — obsolete under the
      // shared key (see the class docstring). Dropping it must be persisted.
      if (obj.stable !== undefined) dirty = true;
      return { sessions, dirty };
    }
    // ANCIENT flat format (Record<string,string>) — migrate. Stamp `now` so the
    // migration itself never trips GC.
    const sessions: Record<string, Entry> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === "string") sessions[k] = { s: v, t: this.now() };
    }
    return { sessions, dirty: true };
  }

  private read(): { sessions: Record<string, Entry>; dirty: boolean } {
    try {
      return this.parse(readFileSync(this.path, "utf8"));
    } catch {
      // Missing or corrupt at the NEW location — try the pre-#884 tmpdir file so
      // an upgrade carries existing conversations over (location migration).
    }
    try {
      if (existsSync(this.legacyPath)) {
        const migrated = this.parse(readFileSync(this.legacyPath, "utf8"));
        if (Object.keys(migrated.sessions).length) {
          logger.info(
            `[session-store] migrated ${Object.keys(migrated.sessions).length} session(s) from ${this.legacyPath} to ${this.path}`,
          );
        }
        return { sessions: migrated.sessions, dirty: true }; // persist at the new location
      }
    } catch {
      // Legacy unreadable/corrupt — start empty; resume falls back to fresh.
    }
    return { sessions: {}, dirty: false };
  }

  private flush(): void {
    try {
      const payload: StoreFileV2 = { v: 2, sessions: this.sessions };
      writeFileSync(this.path, JSON.stringify(payload));
    } catch (err) {
      logger.debug(`[session-store] write failed: ${String(err)}`);
    }
  }

  /** Touch an entry's timestamp on a resume hit so an actively-used session
   *  never ages out. Debounced (1h) so the per-spawn read doesn't churn disk. */
  private touch(key: string): void {
    const e = this.sessions[key];
    if (!e) return;
    const now = this.now();
    if (now - e.t < 60 * 60 * 1000) return;
    e.t = now;
    this.flush();
  }

  /**
   * KEYING migration (#884): the shared key for a backend has no entry yet, but
   * per-workflow entries from the pre-#884 era may. Adopt the most recently
   * used one for this backend as the shared conversation, persisting it under
   * the shared key, so upgrading users keep their newest conversation's memory.
   *
   * Adoption CONSUMES every legacy entry for the backend (they are deleted).
   * This is what makes it one-shot: after a deliberate New chat clears the
   * shared key, a later get() finds no legacy entry to re-adopt — otherwise the
   * cleared conversation would silently resurrect. The archived conversations
   * themselves are untouched (the panel's history picker resumes them by
   * explicit session id via resume_session, never through these keys).
   */
  private adoptLegacyForSharedKey(sharedKey: string): Entry | undefined {
    const sep = sharedKey.indexOf("::");
    if (sep < 0) return undefined;
    const backend = sharedKey.slice(sep + 2);
    if (!backend) return undefined;
    const suffix = `::${backend}`;
    let bestKey: string | undefined;
    let best: Entry | undefined;
    const legacyKeys: string[] = [];
    for (const [k, e] of Object.entries(this.sessions)) {
      if (!k.endsWith(suffix)) continue;
      const tabHalf = k.slice(0, k.length - suffix.length);
      if (tabHalf === SHARED_SESSION_SCOPE || tabHalf.includes("::")) continue;
      if (LEGACY_ADOPT_EXCLUDE.test(tabHalf)) continue;
      legacyKeys.push(k);
      if (!best || e.t > best.t) {
        best = e;
        bestKey = k;
      }
    }
    if (!best || !bestKey) return undefined;
    const adopted: Entry = { s: best.s, t: this.now() };
    for (const k of legacyKeys) delete this.sessions[k]; // consumed — see docstring
    this.sessions[sharedKey] = adopted;
    this.flush();
    logger.info(
      `[session-store] adopted legacy per-workflow session ${bestKey.slice(0, 24)}… as the shared ${backend} conversation (${legacyKeys.length} legacy ${backend} entr${legacyKeys.length === 1 ? "y" : "ies"} consumed, #884)`,
    );
    return adopted;
  }

  /** The persisted session id to resume for a key, if any. For a shared-scope
   *  key with no entry, falls back to adopting the newest legacy per-workflow
   *  entry for that backend (see the class docstring). */
  get(key: string): string | undefined {
    let e: Entry | undefined = this.sessions[key];
    if (!e && key.startsWith(`${SHARED_SESSION_SCOPE}::`)) {
      e = this.adoptLegacyForSharedKey(key);
    }
    if (!e) return undefined;
    this.touch(key);
    return e.s;
  }

  /** The workflow-identity binding a legacy entry carries, if any. Retained for
   *  the manager's rebind plumbing; shared-scope entries never carry one. */
  identityOf(key: string): string | undefined {
    return this.sessions[key]?.u;
  }

  /** Record (and persist) a key's current session id. `identityUuid` is the
   *  legacy per-workflow binding — accepted for API compatibility, unused for
   *  shared-scope keys. No-op if both the id and binding are unchanged. */
  set(key: string, sessionId: string, identityUuid?: string): void {
    const u = typeof identityUuid === "string" && identityUuid ? identityUuid : undefined;
    const existing = this.sessions[key];
    if (existing?.s === sessionId && existing.u === u) {
      // Same id — refresh the timestamp so an active session never GCs out, but
      // skip the disk write when the timestamp is already recent.
      if (this.now() - existing.t < 60 * 60 * 1000) return;
    }
    const entry: Entry = { s: sessionId, t: this.now() };
    if (u) entry.u = u;
    this.sessions[key] = entry;
    this.flush();
  }

  /** Forget a key's session — called on a deliberate NEW chat, so the disk
   *  fallback never resurrects a conversation the user reset. */
  clear(key: string): void {
    if (!(key in this.sessions)) return;
    delete this.sessions[key];
    this.flush();
  }
}
