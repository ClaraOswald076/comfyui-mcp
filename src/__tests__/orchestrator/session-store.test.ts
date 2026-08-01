// The P0 guard: a tab's SDK session id must survive the orchestrator PROCESS being
// killed and respawned (a wedge auto-restart), so the agent resumes the SAME
// conversation instead of silently forgetting everything. SessionStore is the
// durable, disk-backed copy that makes that possible — independent of whether the
// panel re-sends `hello.resume`. A fresh SessionStore on the same port simulates a
// brand-new orchestrator process reading what the previous one persisted.

import { describe, expect, it, afterEach } from "vitest";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SessionStore,
  deriveStableKey,
  deriveWorkflowIdentity,
  workflowIdentityParts,
} from "../../orchestrator/session-store.js";

// A port unlikely to collide with a real run or another test.
const PORT = 59187;
// Two valid crypto.randomUUID()-shaped ids (deriveStableKey validates the format).
const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";
const FILE = join(tmpdir(), `comfyui-mcp-panel-sessions-${PORT}.json`);

afterEach(() => {
  try {
    rmSync(FILE);
  } catch {
    /* already gone */
  }
});

describe("SessionStore", () => {
  it("starts empty when no file exists", () => {
    const store = new SessionStore(PORT);
    expect(store.get("tab-a")).toBeUndefined();
  });

  it("persists a session id across a process restart (the P0 fix)", () => {
    const first = new SessionStore(PORT);
    first.set("tab-a", "sess-111");
    first.set("tab-b", "sess-222");

    // A brand-new process: a fresh store on the same port reads the prior one's disk.
    const restarted = new SessionStore(PORT);
    expect(restarted.get("tab-a")).toBe("sess-111");
    expect(restarted.get("tab-b")).toBe("sess-222");
  });

  it("overwrites a tab's session id (e.g. a fork/rewind makes a new one)", () => {
    const store = new SessionStore(PORT);
    store.set("tab-a", "sess-old");
    store.set("tab-a", "sess-new");
    expect(store.get("tab-a")).toBe("sess-new");
    expect(new SessionStore(PORT).get("tab-a")).toBe("sess-new");
  });

  it("clear() forgets a tab so a NEW chat starts fresh (no resurrected resume)", () => {
    const store = new SessionStore(PORT);
    store.set("tab-a", "sess-111");
    store.clear("tab-a");
    expect(store.get("tab-a")).toBeUndefined();
    // And the erasure is durable — a restart must not bring it back.
    expect(new SessionStore(PORT).get("tab-a")).toBeUndefined();
  });

  it("survives a corrupt/garbage file by starting empty", () => {
    const store = new SessionStore(PORT);
    store.set("tab-a", "sess-111");
    // Stomp the file with junk, then reload.
    writeFileSync(FILE, "{ not json");
    expect(new SessionStore(PORT).get("tab-a")).toBeUndefined();
  });

  it("isolates ids by port (two ComfyUI instances never cross-resume)", () => {
    const a = new SessionStore(PORT);
    a.set("tab-a", "sess-from-A");
    const b = new SessionStore(PORT + 1);
    try {
      expect(b.get("tab-a")).toBeUndefined();
    } finally {
      try {
        rmSync(join(tmpdir(), `comfyui-mcp-panel-sessions-${PORT + 1}.json`));
      } catch {
        /* ignore */
      }
    }
  });

  it("reads a LEGACY flat file (Record<string,string>) and keeps resuming (#570 migration)", () => {
    // A pre-#570 store on disk is a flat {tabId: sessionId} map. The new reader must
    // migrate it in place so an upgrade never forgets a live session.
    writeFileSync(FILE, JSON.stringify({ "wf:x::claude": "sess-legacy" }));
    const store = new SessionStore(PORT);
    expect(store.get("wf:x::claude")).toBe("sess-legacy");
    // And a subsequent write persists the v2 structured format without losing it.
    store.set("wf:y::claude", "sess-new");
    const restarted = new SessionStore(PORT);
    expect(restarted.get("wf:x::claude")).toBe("sess-legacy");
    expect(restarted.get("wf:y::claude")).toBe("sess-new");
  });

  describe("stable resume key — unsaved workflows survive a reload (#570)", () => {
    it("resumes by stable key when the ephemeral tab id changed", () => {
      const first = new SessionStore(PORT);
      // The unsaved tab's session, recorded under BOTH the (ephemeral) tab id and a
      // STABLE key (origin+title+backend).
      first.set("tmp:old-uuid::claude", "sess-unsaved");
      first.setStable("tmp::http://127.0.0.1:8188::Unsaved Workflow (6)::claude", "sess-unsaved");

      // Orchestrator restart + panel reload: the tab returns under a NEW tmp id, so
      // the exact-tab lookup misses — but the stable key still hits.
      const restarted = new SessionStore(PORT);
      expect(restarted.get("tmp:new-uuid::claude")).toBeUndefined();
      expect(
        restarted.getStable("tmp::http://127.0.0.1:8188::Unsaved Workflow (6)::claude"),
      ).toBe("sess-unsaved");
    });

    it("clearStable forgets the stable session (a deliberate NEW chat)", () => {
      const store = new SessionStore(PORT);
      store.setStable("skey", "sess-1");
      store.clearStable("skey");
      expect(store.getStable("skey")).toBeUndefined();
      expect(new SessionStore(PORT).getStable("skey")).toBeUndefined();
    });

    it("SAME owner writing a new session (rewind/fork) is not a collision", () => {
      const store = new SessionStore(PORT);
      store.setStable("skey", "sess-1", "tmp:tabA");
      store.setStable("skey", "sess-2", "tmp:tabA"); // same tab, forked session
      expect(store.getStable("skey")).toBe("sess-2");
    });

    it("a reloaded tab writing the SAME session under a new owner just refreshes", () => {
      const store = new SessionStore(PORT);
      store.setStable("skey", "sess-1", "tmp:tabA");
      store.setStable("skey", "sess-1", "tmp:tabA-reloaded"); // new tmp id, resumed session
      expect(store.getStable("skey")).toBe("sess-1");
    });

    it("POISONS a title-collision so a sibling can't resume the wrong conversation", () => {
      const store = new SessionStore(PORT);
      // Two different unsaved tabs, same title -> same stable key, distinct sessions.
      store.setStable("skey", "sess-A", "tmp:tabA");
      store.setStable("skey", "sess-B", "tmp:tabB"); // collision
      // Neither may resume it now — degrade to fresh, never resume the wrong one.
      expect(store.getStable("skey")).toBeUndefined();
      // Poison is durable and sticky (a later write doesn't un-poison it).
      store.setStable("skey", "sess-C", "tmp:tabC");
      expect(store.getStable("skey")).toBeUndefined();
      expect(new SessionStore(PORT).getStable("skey")).toBeUndefined();
      // Only an explicit NEW chat (clearStable) revives the key.
      store.clearStable("skey");
      store.setStable("skey", "sess-D", "tmp:tabD");
      expect(store.getStable("skey")).toBe("sess-D");
    });
  });

  // #570 REOPEN: #587 keyed the stable resume index on origin+title+backend. An
  // unsaved workflow's title is the DEFAULT "Unsaved Workflow", so two DIFFERENT
  // unsaved workflows collided on one key and a reset resumed an unrelated earlier
  // on-disk session (the WRONG conversation) for a turn. deriveStableKey keys on the
  // panel's durable, globally-unique per-instance uuid when advertised, so the two
  // can never share a key — and the uuid survives the reload that churns the tmp: id.
  describe("deriveStableKey — durable per-instance uuid retires the same-title collision (#570 reopen)", () => {
    it("two DIFFERENT unsaved workflows sharing the default title get DIFFERENT keys", () => {
      // The exact reopened scenario: same origin, same "Unsaved Workflow" title
      // (title is no longer part of the key at all) — but distinct per-instance uuids.
      const a = deriveStableKey({ workflowUuid: UUID_A, origin: "http://127.0.0.1:8188", backend: "claude" });
      const b = deriveStableKey({ workflowUuid: UUID_B, origin: "http://127.0.0.1:8188", backend: "claude" });
      expect(a).not.toBe(b);
    });

    it("the SAME instance keeps ONE key across a reload (churned tmp id / title suffix)", () => {
      // Post-reload the tmp:<uuid> tab id and even the title's "(N)" suffix can
      // change; only the embedded per-instance uuid is stable — and since the key no
      // longer includes the title, the SAME uuid always yields the SAME resume key.
      const before = deriveStableKey({ workflowUuid: UUID_A, origin: "http://127.0.0.1:8188", backend: "claude" });
      const after = deriveStableKey({ workflowUuid: UUID_A, origin: "http://127.0.0.1:8188", backend: "claude" });
      expect(after).toBe(before);
    });

    it("the uuid key partitions by backend (per-provider sessions)", () => {
      const claude = deriveStableKey({ workflowUuid: UUID_A, origin: "o", backend: "claude" });
      const codex = deriveStableKey({ workflowUuid: UUID_A, origin: "o", backend: "codex" });
      expect(claude).not.toBe(codex);
    });

    it("the SAME uuid from a DIFFERENT origin can't cross-resume (copied graph metadata)", () => {
      // The uuid is embedded in graph JSON that can be copied to another instance;
      // folding the origin into the key stops a replayed uuid from bridging them.
      const a = deriveStableKey({ workflowUuid: UUID_A, origin: "http://127.0.0.1:8188", backend: "claude" });
      const b = deriveStableKey({ workflowUuid: UUID_A, origin: "http://127.0.0.1:8199", backend: "claude" });
      expect(a).not.toBe(b);
    });

    it("FAIL CLOSED: no uuid (old panel) → undefined, never the collision-prone legacy key", () => {
      // The whole reopen was the origin+title key; an un-upgraded panel that sends no
      // uuid must NOT fall back to it. undefined = the orchestrator forgoes the disk
      // fallback and starts fresh (a lost resume, never a wrong one).
      expect(deriveStableKey({ origin: "http://127.0.0.1:8188", backend: "claude" })).toBeUndefined();
      // Blank/whitespace and malformed identifiers are treated as absent too — a junk
      // value never becomes an arbitrary session handle.
      expect(deriveStableKey({ workflowUuid: "  ", origin: "o", backend: "claude" })).toBeUndefined();
      expect(deriveStableKey({ workflowUuid: "not-a-uuid", origin: "o", backend: "claude" })).toBeUndefined();
    });

    it("FAIL CLOSED: a missing/blank origin (no trusted handshake origin) → undefined", () => {
      // The origin must be the server-observed handshake origin; when the bridge can't
      // supply one (relay/headless) we key on nothing rather than an untrusted value.
      expect(deriveStableKey({ workflowUuid: UUID_A, backend: "claude" })).toBeUndefined();
      expect(deriveStableKey({ workflowUuid: UUID_A, origin: "   ", backend: "claude" })).toBeUndefined();
    });

    it("canonicalizes the origin (case + trailing slash) so trivial variants share one key", () => {
      const a = deriveStableKey({ workflowUuid: UUID_A, origin: "http://127.0.0.1:8188/", backend: "claude" });
      const b = deriveStableKey({ workflowUuid: UUID_A, origin: "HTTP://127.0.0.1:8188", backend: "claude" });
      expect(a).toBe(b);
    });

    it("END-TO-END: two same-title workflows no longer cross-resume through the store", () => {
      const store = new SessionStore(PORT);
      // Workflow A converses (session sess-A), stored under its uuid key.
      const keyA = deriveStableKey({ workflowUuid: UUID_A, origin: "o", backend: "claude" })!;
      store.setStable(keyA, "sess-A", "tmp:tabA");
      // A DIFFERENT unsaved workflow B, same default title, opens after a restart.
      const keyB = deriveStableKey({ workflowUuid: UUID_B, origin: "o", backend: "claude" })!;
      // Under #587 (origin+title) keyA === keyB and B would resume A's sess-A. Now:
      expect(store.getStable(keyB)).toBeUndefined(); // B never inherits A's chat
      // And A itself still resumes across a fresh process (durable).
      expect(new SessionStore(PORT).getStable(keyA)).toBe("sess-A");
    });

    it("IDENTITY REGRESSION: a fail-closed hello retires the prior session so a reset can't resurrect it", () => {
      // Models the index.ts fail-closed branch (both the direct re-hello path AND the
      // tab-id-migration carry-over path, which funnel to the same clearStable). A tab
      // connected with a valid uuid and persisted session S under its key. It then
      // re-hellos from an old/malformed panel (no uuid) → identity regression: the
      // orchestrator clears S (via the carried-over prior key on a migration). This is
      // what stops a later `new_session` (which can no longer resolve the key) from
      // leaving S on disk for a subsequent valid-uuid hello to getStable() back —
      // resurrecting a conversation the user reset. After the clear, even recomputing
      // the SAME uuid key misses, so nothing is resurrected.
      const store = new SessionStore(PORT);
      const key = deriveStableKey({ workflowUuid: UUID_A, origin: "o", backend: "claude" })!;
      store.setStable(key, "sess-S", "tmp:tabA");
      expect(store.getStable(key)).toBe("sess-S");

      // Fail-closed hello: deriveStableKey returns undefined; the branch clears `key`.
      expect(deriveStableKey({ origin: "o", backend: "claude" })).toBeUndefined();
      store.clearStable(key);

      // Later valid-uuid hello recomputes the identical key — but it now misses, so the
      // reset conversation is NOT resurrected. Durable across a fresh process too.
      const recomputed = deriveStableKey({ workflowUuid: UUID_A, origin: "o", backend: "claude" })!;
      expect(recomputed).toBe(key);
      expect(store.getStable(recomputed)).toBeUndefined();
      expect(new SessionStore(PORT).getStable(recomputed)).toBeUndefined();
    });

    it("WORKFLOW IDENTITY: distinguishes a same-workflow migration from a workflow switch (#570 P0a)", () => {
      // deriveWorkflowIdentity is the backend-independent discriminator the hello
      // handler uses to decide whether a same-socket re-hello under a new tab id is a
      // tab-id MIGRATION of one workflow (identity UNCHANGED → rebind the agent) or a
      // SWITCH to a different workflow (identity CHANGED → retire, never rebind).
      const a = deriveWorkflowIdentity({ workflowUuid: UUID_A, origin: "http://127.0.0.1:8188" });
      const aAgain = deriveWorkflowIdentity({ workflowUuid: UUID_A, origin: "http://127.0.0.1:8188" });
      const b = deriveWorkflowIdentity({ workflowUuid: UUID_B, origin: "http://127.0.0.1:8188" });
      expect(a).toBeDefined();
      expect(aAgain).toBe(a); // same workflow → migration (rebind is safe)
      expect(b).not.toBe(a); // different workflow → switch (must NOT rebind)
      // Backend-independent (a provider switch is not a workflow switch).
      // Fails closed (undefined) without a valid uuid or trusted origin — so the
      // migration decision treats "no proof of continuity" as "do not rebind".
      expect(deriveWorkflowIdentity({ origin: "http://127.0.0.1:8188" })).toBeUndefined();
      expect(deriveWorkflowIdentity({ workflowUuid: UUID_A })).toBeUndefined();
      expect(deriveWorkflowIdentity({ workflowUuid: "not-a-uuid", origin: "o" })).toBeUndefined();
      // Canonicalized parts match deriveStableKey's (case + trailing slash).
      expect(workflowIdentityParts({ workflowUuid: UUID_A, origin: "HTTP://Host:8188/" })).toEqual({
        origin: "http://host:8188",
        uuid: UUID_A,
      });
    });

    it("BACKEND SWITCH: each provider's session stays under its OWN recomputed key (no cross-provider resume)", () => {
      // Models the set_backend recompute. Same tab/workflow (one origin+uuid), used on
      // backend A then switched to B without a reconnect. Because set_backend recomputes
      // tabStableKey for the new backend, B's onSession persists under the B key — NOT
      // the A key — so a later reconnect on A resumes A's session and a reconnect on B
      // resumes B's, never each other's (the backend-isolation guarantee).
      const store = new SessionStore(PORT);
      const keyClaude = deriveStableKey({ workflowUuid: UUID_A, origin: "o", backend: "claude" })!;
      const keyCodex = deriveStableKey({ workflowUuid: UUID_A, origin: "o", backend: "codex" })!;
      expect(keyClaude).not.toBe(keyCodex);
      store.setStable(keyClaude, "sess-claude", "tmp:tabA"); // on claude
      // switch to codex → key recomputed → codex onSession writes under the codex key.
      store.setStable(keyCodex, "sess-codex", "tmp:tabA");
      // Neither leaked into the other; both resume correctly across a fresh process.
      const restarted = new SessionStore(PORT);
      expect(restarted.getStable(keyClaude)).toBe("sess-claude");
      expect(restarted.getStable(keyCodex)).toBe("sess-codex");
    });
  });

  it("clamps a corrupt FUTURE timestamp AND persists the clamp so it can't be immortal (#570 P3)", () => {
    writeFileSync(
      FILE,
      JSON.stringify({
        v: 2,
        sessions: { "wf:x::claude": { s: "sess-future", t: 1e100 } },
        stable: {},
      }),
    );
    // Load clamps 1e100 → now AND re-flushes, so disk no longer holds the immortal
    // value (otherwise every reload just re-clamps it and it never ages out).
    const store = new SessionStore(PORT);
    expect(store.get("wf:x::claude")).toBe("sess-future");
    const onDisk = JSON.parse(readFileSync(FILE, "utf8")) as {
      sessions: Record<string, { t: number }>;
    };
    const t = onDisk.sessions["wf:x::claude"].t;
    expect(Number.isFinite(t)).toBe(true);
    expect(t).toBeLessThanOrEqual(Date.now());
  });

  it("garbage-collects entries older than the TTL on load (#570 unbounded growth)", () => {
    // Hand-craft a v2 file with one FRESH and one ANCIENT entry in each index.
    const old = Date.now() - (SessionStore.GC_TTL_MS + 60_000);
    const fresh = Date.now();
    writeFileSync(
      FILE,
      JSON.stringify({
        v: 2,
        sessions: {
          "e2e-stale::claude": { s: "sess-old", t: old },
          "wf:live::claude": { s: "sess-live", t: fresh },
        },
        stable: {
          "spike-stale": { s: "sess-old2", t: old },
          "tmp::o::T::claude": { s: "sess-live2", t: fresh },
        },
      }),
    );
    const store = new SessionStore(PORT);
    // Stale keys pruned; live keys kept.
    expect(store.get("e2e-stale::claude")).toBeUndefined();
    expect(store.get("wf:live::claude")).toBe("sess-live");
    expect(store.getStable("spike-stale")).toBeUndefined();
    expect(store.getStable("tmp::o::T::claude")).toBe("sess-live2");
    // The prune is durable — a re-read of the just-written file has dropped them.
    store.set("wf:another::claude", "x"); // forces a flush
    const restarted = new SessionStore(PORT);
    expect(restarted.get("e2e-stale::claude")).toBeUndefined();
    expect(restarted.getStable("spike-stale")).toBeUndefined();
  });
});
