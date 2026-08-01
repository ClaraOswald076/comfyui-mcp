import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logger } from "../utils/logger.js";

/**
 * Durable per-tab SDK session ids, so an agent's memory survives the orchestrator
 * PROCESS dying — a wedge auto-restart, a crash, an OOM — not just a soft reload.
 *
 * The panel also persists the session id (onSession → a `session` frame → the
 * panel's localStorage), and resumes by re-sending it on reconnect. But that path
 * is the PANEL's: if the orchestrator is killed and a fresh one comes up before the
 * panel re-sends `hello.resume` — or the panel never sends it — the conversation is
 * silently lost (P0: the agent "forgets everything" after an auto-restart). This is
 * the orchestrator's own belt-and-suspenders copy: written when the agent reports
 * its session id, read as the resume fallback when a tab first spawns. Keyed by the
 * bridge port so two ComfyUI instances on one machine never cross-resume.
 *
 * TWO indexes (#570):
 *  - `sessions` — keyed by the exact (composite `tabId::backend`) key. Authoritative
 *    when the tab id is STABLE across a reload (a SAVED workflow: `wf:<path>`).
 *  - `stable` — keyed by a caller-supplied identity that survives a panel reload
 *    even for an UNSAVED workflow, whose tab id is an ephemeral `tmp:<uuid>` that is
 *    REGENERATED every reload. See {@link deriveStableKey}: keyed on the panel's
 *    durable per-instance workflow uuid (globally unique — no cross-workflow
 *    collision); absent a valid uuid the index is skipped entirely (fail closed —
 *    never the collision-prone origin+title key). Without this, an orchestrator
 *    restart that also
 *    reloads the panel brings the tab back under a never-stored `tmp:` id → store
 *    miss → fresh session → conversation gone. The stable index is the resume
 *    FALLBACK: `sessions` (exact tab id) always wins when present, so this never
 *    weakens the precise path — it only rescues the ephemeral one.
 *
 * Both indexes carry a write timestamp and are GC'd on load (entries older than
 * {@link SessionStore.GC_TTL_MS} are dropped), so the file can't grow unbounded with
 * dead `tmp:`/`e2e-*`/`spike-*` keys from prior runs.
 */

interface Entry {
  /** SDK session id to resume. */
  s: string;
  /** Epoch ms of the last write — for GC. */
  t: number;
  /** STABLE index only: the panel tab (owner) that last wrote this key. Used to
   *  distinguish "the SAME tab's session evolved (rewind/fork)" from "a DIFFERENT
   *  same-title tab contends for this non-unique key". */
  o?: string;
  /** STABLE index only: POISONED — two different tabs wrote two different sessions
   *  under this (title-collision) key, so it can no longer be trusted to resume
   *  either. getStable refuses it; only clearStable (a NEW chat) revives the key. */
  p?: boolean;
  /** EXACT index only: the trusted workflow-identity uuid this session belongs to, so a
   *  SAVED tab whose file is OVERWRITTEN in place (same `wf:<path>` tab id, new uuid) can
   *  be detected — the tab-id-keyed exact record would otherwise resume the PRIOR
   *  workflow's chat. Durable, so the check survives an orchestrator restart (#570 P0). */
  u?: string;
}

interface StoreFileV2 {
  v: 2;
  sessions: Record<string, Entry>;
  stable: Record<string, Entry>;
}

/**
 * Derive the STABLE resume key for an UNSAVED-workflow tab (#570).
 *
 * #587 keyed this on `origin + title + backend` — the only identity thought to
 * survive the tmp:<uuid> tab-id churn. But an unsaved workflow's title is the
 * DEFAULT "Unsaved Workflow" (ComfyUI even re-derives the "(N)" suffix as tabs
 * open/close), which is NOT unique: two DIFFERENT unsaved workflows collide on one
 * key. #587 documented the resulting sequential-collision as an accepted limitation
 * and pointed at a future per-instance id. That limitation is the #570 REOPEN: after
 * a workflow reset the stable index served an UNRELATED earlier on-disk session for a
 * turn (the wrong conversation), because a stale same-title sibling shared the key
 * (the concurrent-collision poison guard can't catch a sequential/cross-restart one).
 *
 * The panel now advertises its durable, globally-unique per-instance workflow id
 * (#186/#386 — minted with crypto.randomUUID, embedded in the graph's `extra` and so
 * carried across a browser reload by ComfyUI's unsaved-workflow persistence; it is the
 * very id that keys the durable chat transcript, which DID restore correctly in the
 * report; and it is FORKED to a fresh uuid whenever a graph is cloned/imported, so
 * two distinct instances never share it). Key on THAT: two distinct unsaved workflows
 * can never share a uuid, so the cross-resume is structurally impossible, and the id
 * survives the reload that regenerates the tmp: tab id. Backend partitions the key
 * (per-provider sessions); the ComfyUI ORIGIN is folded in too so a uuid replayed from
 * copied graph metadata onto a DIFFERENT instance can't bridge them. The identifier is
 * validated against the crypto.randomUUID() shape before it is trusted.
 *
 * FAIL CLOSED (#570 reopen): when no VALID uuid is supplied — an older/pre-capability
 * panel, or a malformed value — we return `undefined` and do NOT fall back to the
 * origin+title key. That legacy key is the collision mechanism the reopen is about;
 * reusing it would silently keep the wrong-resume alive for un-upgraded panels. Without
 * a unique identity the orchestrator simply forgoes the disk fallback: the panel's own
 * hello.resume still covers the common reload, and a miss starts fresh — a lost resume,
 * never a wrong one.
 *
 * LEGACY RECORDS: a store written by #587 may hold old `tmp::<origin>::<title>::<backend>`
 * stable entries. The new scheme NEVER produces or reads that key shape, so those records
 * are inert and age out via GC. We deliberately do NOT migrate them onto a uuid identity:
 * the legacy key is non-unique, so mapping it to a uuid would let a brand-new same-title
 * workflow inherit an unrelated abandoned session — reintroducing the exact wrong-resume
 * this fix removes. The upgrade cost is a lost (not wrong) resume for a pre-upgrade unsaved
 * session whose panel also fails to send hello.resume — an accepted, bounded trade-off.
 *
 * The poison guard (see {@link SessionStore.setStable}) is unchanged and still matters:
 * the SAME workflow opened in two live browser tabs shares one uuid, and two live tabs
 * writing distinct sessions to it still poison the key rather than cross-resume.
 */
const WORKFLOW_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The validated + canonicalized (origin, uuid) behind a stable key, or undefined when
 *  either is missing/untrusted (fail closed). The origin MUST be the caller's
 *  SERVER-OBSERVED (unspoofable) handshake origin — never the client-supplied
 *  hello.comfyui_url — so a spoofed origin can't let a copied uuid derive another
 *  instance's key. Shared by {@link deriveStableKey} (resume key) and
 *  {@link deriveWorkflowIdentity} (the backend-independent identity used to tell a
 *  same-socket tab-id MIGRATION of one workflow from a SWITCH to a different one). */
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

export function deriveStableKey(opts: {
  workflowUuid?: string | undefined;
  origin?: string | undefined;
  backend: string;
}): string | undefined {
  const p = workflowIdentityParts(opts);
  if (!p) return undefined; // fail closed: no durable identity / no trusted origin
  return `wfid::${p.origin}::${p.uuid}::${opts.backend}`;
}

/** Backend-INDEPENDENT workflow identity (origin+uuid), for distinguishing a
 *  same-socket tab-id migration (same identity) from a workflow switch (different
 *  identity). undefined when the identity can't be trusted (fail closed → treated as
 *  "no proof of continuity", so a rebind is refused rather than risked). */
export function deriveWorkflowIdentity(opts: {
  workflowUuid?: string | undefined;
  origin?: string | undefined;
}): string | undefined {
  const p = workflowIdentityParts(opts);
  return p ? `${p.origin}::${p.uuid}` : undefined;
}

export class SessionStore {
  /** Entries untouched for longer than this are pruned on load. Resumes are
   *  same-day / few-days in practice; three weeks is a generous ceiling that still
   *  bounds growth (stale test + reloaded-`tmp:` keys never accumulate forever). */
  static readonly GC_TTL_MS = 21 * 24 * 60 * 60 * 1000;

  private readonly path: string;
  private sessions: Record<string, Entry>;
  private stable: Record<string, Entry>;

  constructor(port: number) {
    this.path = join(tmpdir(), `comfyui-mcp-panel-sessions-${port}.json`);
    const loaded = this.read();
    this.sessions = loaded.sessions;
    this.stable = loaded.stable;
    // If load had to SANITIZE the file (migrate the legacy format, GC an expired
    // entry, clamp a corrupt future timestamp), persist the cleaned version NOW.
    // Otherwise a clamped-in-memory-only future timestamp survives on disk and is
    // re-clamped to "now" on every load — immortal, never aging out (#570 P3).
    if (loaded.dirty) this.flush();
  }

  private now(): number {
    return Date.now();
  }

  private read(): { sessions: Record<string, Entry>; stable: Record<string, Entry>; dirty: boolean } {
    const empty = { sessions: {}, stable: {}, dirty: false };
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.path, "utf8"));
      if (!parsed || typeof parsed !== "object") return empty;
      const obj = parsed as Record<string, unknown>;
      const cutoff = this.now() - SessionStore.GC_TTL_MS;
      // `dirty` = the on-disk bytes no longer match what we hold, so the constructor
      // must re-flush (drop GC'd/malformed rows, persist a clamped timestamp, migrate).
      let dirty = false;
      // Coerce an untrusted map into {key -> Entry}, dropping malformed/expired rows.
      const coerce = (raw: unknown): Record<string, Entry> => {
        const out: Record<string, Entry> = {};
        if (raw === undefined) return out; // absent field — canonicalized on next write
        if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
          dirty = true; // malformed container → rewrite as a canonical {} on load
          return out;
        }
        const nowMs = this.now();
        for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
          if (!v || typeof v !== "object") {
            dirty = true;
            continue;
          }
          const e = v as { s?: unknown; t?: unknown; o?: unknown; p?: unknown; u?: unknown };
          if (typeof e.s !== "string") {
            dirty = true;
            continue;
          }
          // Sanitize the timestamp. A corrupt `1e999` parses as Infinity and would
          // slip past `t < cutoff` forever (never GC'd, never refreshed); a finite
          // FUTURE value (e.g. 1e100) likewise never ages out and makes touch() a
          // no-op. Non-finite → epoch 0 (pruned as too old); future → clamped to now
          // so the TTL is measured from load like any other entry.
          const rawT = typeof e.t === "number" && Number.isFinite(e.t) ? e.t : 0;
          let t = rawT;
          if (t > nowMs) t = nowMs;
          if (t !== rawT) dirty = true; // clamp/coerce must be persisted (P3)
          if (t < cutoff) {
            dirty = true; // GC drop must be persisted
            continue;
          }
          const entry: Entry = { s: e.s, t };
          if (typeof e.o === "string") entry.o = e.o;
          if (e.p === true) entry.p = true;
          if (typeof e.u === "string") entry.u = e.u;
          out[k] = entry;
        }
        return out;
      };
      if (obj.v === 2) {
        const sessions = coerce(obj.sessions);
        const stable = coerce(obj.stable);
        return { sessions, stable, dirty };
      }
      // LEGACY flat format (Record<string,string>) — migrate. Stamp `now` so the
      // migration itself never trips GC (a live install's keys stay resumable).
      const sessions: Record<string, Entry> = {};
      for (const [k, v] of Object.entries(obj)) {
        if (typeof v === "string") sessions[k] = { s: v, t: this.now() };
      }
      return { sessions, stable: {}, dirty: true }; // format upgrade → re-flush as v2
    } catch {
      // Missing or corrupt — start empty. Resume falls back to a fresh session.
    }
    return empty;
  }

  private flush(): void {
    try {
      const payload: StoreFileV2 = { v: 2, sessions: this.sessions, stable: this.stable };
      writeFileSync(this.path, JSON.stringify(payload));
    } catch (err) {
      logger.debug(`[session-store] write failed: ${String(err)}`);
    }
  }

  /** Touch an entry's timestamp on a resume hit so an actively-used session never
   *  ages out of the store. GC only ever reclaims a key that hasn't been RESUMED
   *  (spawned) within the TTL — i.e. a genuinely idle tab. Debounced (1h) so the
   *  per-spawn read doesn't churn the disk. */
  private touch(map: Record<string, Entry>, key: string): void {
    const e = map[key];
    if (!e) return;
    const now = this.now();
    if (now - e.t < 60 * 60 * 1000) return;
    e.t = now;
    this.flush();
  }

  /** The persisted session id to resume for a tab, if any. */
  get(tabId: string): string | undefined {
    const s = this.sessions[tabId]?.s;
    if (s !== undefined) this.touch(this.sessions, tabId);
    return s;
  }

  /** The trusted workflow-identity uuid the exact session under this key belongs to
   *  (#570 P0), or undefined. Lets the hello handler detect a SAVED workflow overwritten
   *  in place (same tab id, new uuid) and clear the stale session. */
  identityOf(tabId: string): string | undefined {
    return this.sessions[tabId]?.u;
  }

  /** Record (and persist) a tab's current session id, bound to its trusted workflow
   *  identity uuid (when known). No-op if BOTH the id and the identity are unchanged. */
  set(tabId: string, sessionId: string, identityUuid?: string): void {
    const u = typeof identityUuid === "string" && identityUuid ? identityUuid : undefined;
    const existing = this.sessions[tabId];
    if (existing?.s === sessionId && existing.u === u) {
      // Same id AND identity — refresh the timestamp so an actively-used session never
      // GCs out, but skip the disk write when the timestamp is already recent.
      if (this.now() - existing.t < 60 * 60 * 1000) return;
    }
    const entry: Entry = { s: sessionId, t: this.now() };
    if (u) entry.u = u;
    this.sessions[tabId] = entry;
    this.flush();
  }

  /** Forget a tab's session — called when the panel starts a NEW chat, so the
   *  disk fallback never resurrects a deliberately-reset conversation. */
  clear(tabId: string): void {
    if (!(tabId in this.sessions)) return;
    delete this.sessions[tabId];
    this.flush();
  }

  /** The resume session id for a STABLE identity (survives a panel reload for an
   *  unsaved workflow), if any. A POISONED key (two tabs contended — see setStable)
   *  returns undefined, so a collision degrades to a fresh session, never a resume of
   *  the WRONG conversation. See the class docstring. */
  getStable(stableKey: string): string | undefined {
    const e = this.stable[stableKey];
    if (!e || e.p) return undefined;
    this.touch(this.stable, stableKey);
    return e.s;
  }

  /** Record (and persist) the session id under a STABLE identity, so a reloaded
   *  unsaved-workflow tab (new `tmp:` id) can still resume it. `owner` is the panel
   *  tab writing it — the collision discriminator.
   *
   *  The stable key (origin+title+backend) is NOT unique: two unsaved tabs with the
   *  same default title collide. If a DIFFERENT owner writes a DIFFERENT session
   *  under an existing key, that key is POISONED — neither tab may resume it, so a
   *  fresh sibling can never inherit the other's conversation. The SAME owner writing
   *  a new session (a rewind/fork) is NOT a collision; a reloaded tab writing the
   *  SAME (resumed) session under a new owner just refreshes it. */
  setStable(stableKey: string, sessionId: string, owner?: string): void {
    const existing = this.stable[stableKey];
    if (existing?.p) return; // already poisoned — stays refused until clearStable
    if (
      existing &&
      existing.s !== sessionId &&
      existing.o !== undefined &&
      owner !== undefined &&
      existing.o !== owner
    ) {
      // Two different tabs, two different sessions, one non-unique key → poison it.
      this.stable[stableKey] = { s: "", t: this.now(), p: true };
      this.flush();
      return;
    }
    if (existing && existing.s === sessionId && existing.o === owner) {
      // Unchanged — refresh the timestamp (debounced) so an active session doesn't GC.
      if (this.now() - existing.t < 60 * 60 * 1000) return;
    }
    const entry: Entry = { s: sessionId, t: this.now() };
    if (owner !== undefined) entry.o = owner;
    this.stable[stableKey] = entry;
    this.flush();
  }

  /** Forget a stable identity's session (a deliberate NEW chat on that tab). */
  clearStable(stableKey: string): void {
    if (!(stableKey in this.stable)) return;
    delete this.stable[stableKey];
    this.flush();
  }
}
