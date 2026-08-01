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
  armableResume,
  deriveStableKey,
  deriveWorkflowIdentity,
  destinationHasCollisionState,
  keepsBackendState,
  siblingOwnsStableKey,
  workflowIdentityParts,
} from "../../orchestrator/session-store.js";

// #570 — a tab-id migration destination collides when it holds ANY per-backend state, INCLUDING a
// render-held (heldDuringGen) queue. Previously held-only destinations were missed → the source
// re-key appended to the destination's held array → the superseded tab's message flushed into the
// incoming tab on render completion. The predicate must treat a render-held queue as a collision.
describe("destinationHasCollisionState (#570 render-held included)", () => {
  it("treats a RENDER-HELD queue as collision state (the previously-missed case)", () => {
    expect(
      destinationHasCollisionState({ hasManagerState: false, hasDurableSession: false, renderHeldCount: 1 }),
    ).toBe(true);
  });
  it("treats manager state or a durable session as collision state", () => {
    expect(
      destinationHasCollisionState({ hasManagerState: true, hasDurableSession: false, renderHeldCount: 0 }),
    ).toBe(true);
    expect(
      destinationHasCollisionState({ hasManagerState: false, hasDurableSession: true, renderHeldCount: 0 }),
    ).toBe(true);
  });
  it("no state of any kind ⇒ not a collision (a fresh destination id)", () => {
    expect(
      destinationHasCollisionState({ hasManagerState: false, hasDurableSession: false, renderHeldCount: 0 }),
    ).toBe(false);
  });
});

// #570 — a tab OWNS every backend key whose session it RETAINS (a provider switch preserves the
// old provider's session), so a second honest tab must not resume a key a connected sibling still
// owns — even after that sibling switched to a different provider. Ownership derives from the
// retained-session state, NOT the sibling's current-backend mapping.
describe("siblingOwnsStableKey (#570 owned-SET, not current-backend)", () => {
  const ORIGIN = "http://127.0.0.1:8188";
  const identity = { origin: ORIGIN, uuid: UUID_A };
  const claudeKey = deriveStableKey({ workflowUuid: UUID_A, origin: ORIGIN, backend: "claude" })!;

  it("A switched Claude→Codex but RETAINS its Claude session ⇒ still owns the Claude key (B must not resume it)", () => {
    // Model A's retained state exactly as the handler derives it: the durable exact session
    // survives the provider-switch retire.
    const store = new SessionStore(PORT);
    store.set("tmp:A::claude", "sess-A-claude", deriveWorkflowIdentity(identity));
    store.setStable(claudeKey, "sess-A-claude", "tmp:A");
    const retains = store.get("tmp:A::claude") !== undefined; // true — A retains Claude
    expect(
      siblingOwnsStableKey({
        siblingIdentity: identity, // A's identity (its CURRENT backend is Codex — irrelevant)
        candidateKey: claudeKey,
        candidateBackend: "claude",
        siblingRetainsSession: retains,
      }),
    ).toBe(true);
  });

  it("once A's Claude session is genuinely CLEARED, it no longer owns the key (B CAN resume)", () => {
    const store = new SessionStore(PORT);
    store.set("tmp:A::claude", "sess-A-claude", deriveWorkflowIdentity(identity));
    store.clear("tmp:A::claude"); // genuine clear (new_session / real teardown)
    const retains = store.get("tmp:A::claude") !== undefined; // false
    expect(
      siblingOwnsStableKey({
        siblingIdentity: identity,
        candidateKey: claudeKey,
        candidateBackend: "claude",
        siblingRetainsSession: retains,
      }),
    ).toBe(false);
  });

  it("a sibling with a DIFFERENT workflow identity never owns the key", () => {
    expect(
      siblingOwnsStableKey({
        siblingIdentity: { origin: ORIGIN, uuid: UUID_B },
        candidateKey: claudeKey,
        candidateBackend: "claude",
        siblingRetainsSession: true,
      }),
    ).toBe(false);
  });

  it("no identity / no retained session ⇒ not owned (fail open to a fresh resume)", () => {
    expect(
      siblingOwnsStableKey({ siblingIdentity: undefined, candidateKey: claudeKey, candidateBackend: "claude", siblingRetainsSession: true }),
    ).toBe(false);
    expect(
      siblingOwnsStableKey({ siblingIdentity: identity, candidateKey: claudeKey, candidateBackend: "claude", siblingRetainsSession: false }),
    ).toBe(false);
  });
});

// #570 — a panel-scoped hello.resume may arm from the SHARED stable key only when no OTHER live
// tab holds it, so a concurrent sibling can't attach to the first tab's live conversation.
describe("armableResume (#570 concurrent-tab guard)", () => {
  it("arms an EXACT tab-id match unconditionally (unique to this tab)", () => {
    expect(armableResume({ exactOwned: true, stableOwned: false, otherTabHoldsStableKey: false })).toBe(true);
    // Exact ownership wins even if a sibling holds the stable key.
    expect(armableResume({ exactOwned: true, stableOwned: true, otherTabHoldsStableKey: true })).toBe(true);
  });

  it("arms a STABLE-key match ONLY when no other live tab holds it", () => {
    expect(armableResume({ exactOwned: false, stableOwned: true, otherTabHoldsStableKey: false })).toBe(true);
    // The codex leak: a second live tab of the same identity sends the shared session id → DROP.
    expect(armableResume({ exactOwned: false, stableOwned: true, otherTabHoldsStableKey: true })).toBe(false);
  });

  it("does NOT arm an unowned hint", () => {
    expect(armableResume({ exactOwned: false, stableOwned: false, otherTabHoldsStableKey: false })).toBe(false);
  });
});

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

    it("RESUME OWNERSHIP: a session owned by workflow A's identity is NOT owned by workflow B (#570 P0)", () => {
      // Models the hello-handler's untrusted-hello.resume guard. The panel's default
      // panel-scoped chat keeps ONE global session id S and re-sends it as hello.resume
      // for EVERY workflow. The orchestrator honors it ONLY when S is owned by the tab's
      // trusted identity — its exact-tab store entry OR its trusted stable key. Workflow A
      // owns S; a fresh/copied workflow B (a different uuid) does NOT, so B's hello.resume=S
      // is rejected → no cross-workflow chat resume.
      const store = new SessionStore(PORT);
      const keyA = deriveStableKey({ workflowUuid: UUID_A, origin: "o", backend: "claude" })!;
      store.setStable(keyA, "sess-S", "tmp:tabA"); // A converses; onSession persisted S
      store.set("tmp:tabA::claude", "sess-S"); // and under A's exact key
      const resume = "sess-S";

      // A (same identity, e.g. a reload): OWNED via the stable key → honor.
      const keyAReload = deriveStableKey({ workflowUuid: UUID_A, origin: "o", backend: "claude" })!;
      expect(store.getStable(keyAReload) === resume).toBe(true);

      // B (a different workflow that the panel re-hello'd with the same global S): the
      // exact key differs (new tmp id) AND B's stable key doesn't hold S → NOT owned.
      const keyB = deriveStableKey({ workflowUuid: UUID_B, origin: "o", backend: "claude" })!;
      const bOwnsResume =
        store.get("tmp:tabB::claude") === resume || store.getStable(keyB) === resume;
      expect(bOwnsResume).toBe(false); // B's hello.resume=S is dropped, never cross-resumes A
    });

    it("IN-PLACE REPLACE: the exact session is bound to a durable identity uuid (#570 P0)", () => {
      // A SAVED workflow keeps its wf:<path> tab id when its file is overwritten with a
      // DIFFERENT workflow. The exact record carries the trusted uuid it belongs to, so the
      // hello handler can detect the change (boundUuid !== hello uuid) and clear the stale
      // session — durable, so it survives an orchestrator restart.
      const first = new SessionStore(PORT);
      first.set("wf:foo.json::claude", "sess-A", UUID_A);
      expect(first.get("wf:foo.json::claude")).toBe("sess-A");
      expect(first.identityOf("wf:foo.json::claude")).toBe(UUID_A);

      // Fresh process (restart): the binding is durable.
      const restarted = new SessionStore(PORT);
      expect(restarted.identityOf("wf:foo.json::claude")).toBe(UUID_A);
      // The overwritten workflow B has a DIFFERENT uuid → the handler detects the mismatch
      // (modeled here) and clears the stale session so B can't inherit A's chat.
      expect(restarted.identityOf("wf:foo.json::claude") !== UUID_B).toBe(true);
      restarted.clear("wf:foo.json::claude");
      expect(restarted.get("wf:foo.json::claude")).toBeUndefined();
      expect(new SessionStore(PORT).get("wf:foo.json::claude")).toBeUndefined();
    });

    it("CROSS-ORIGIN: the exact identity binding includes the origin (same uuid, different origin ≠ owned)", () => {
      // The exact record binds the FULL canonical identity (origin::uuid), not just the
      // uuid — so a copied/replayed uuid arriving from a DIFFERENT ComfyUI origin on the
      // same bridge port under the same wf:<path> key does NOT prove ownership → reset.
      const store = new SessionStore(PORT);
      const boundA = `http://127.0.0.1:8188::${UUID_A}`;
      store.set("wf:foo.json::claude", "sess-A", boundA);
      expect(store.identityOf("wf:foo.json::claude")).toBe(boundA);
      // Same uuid, DIFFERENT origin → the handler's `provenOwn` (boundIdentity ===
      // helloIdentity) is false → the stale session is reset, not resumed.
      const helloFromOtherOrigin = `http://127.0.0.1:8199::${UUID_A}`;
      expect(store.identityOf("wf:foo.json::claude") === helloFromOtherOrigin).toBe(false);
      // Same origin + same uuid → owned.
      expect(store.identityOf("wf:foo.json::claude") === boundA).toBe(true);
    });

    it("PRE-UPGRADE: an exact record with no identity binding reads back unbound (drives fail-closed reset)", () => {
      // A record written before the `u` field existed (a v2 {s,t} entry, or a migrated
      // legacy flat record) has a session but NO identity. identityOf() is undefined, so
      // the hello handler treats it as untrusted (can't prove it's this workflow's) and
      // resets — a one-time lost resume, never a wrong resume.
      writeFileSync(
        FILE,
        JSON.stringify({
          v: 2,
          sessions: { "wf:foo.json::claude": { s: "sess-pre-upgrade", t: Date.now() } },
          stable: {},
        }),
      );
      const store = new SessionStore(PORT);
      expect(store.get("wf:foo.json::claude")).toBe("sess-pre-upgrade"); // session present
      expect(store.identityOf("wf:foo.json::claude")).toBeUndefined(); // but NOT identity-bound
      // Legacy flat format (Record<string,string>) migrates likewise — no identity.
      writeFileSync(FILE, JSON.stringify({ "wf:bar.json::claude": "sess-legacy" }));
      const legacy = new SessionStore(PORT);
      expect(legacy.get("wf:bar.json::claude")).toBe("sess-legacy");
      expect(legacy.identityOf("wf:bar.json::claude")).toBeUndefined();
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

  // #570 — per-backend teardown at the identity boundary. A cold-start hello on ONE provider
  // must NOT erase a DIFFERENT provider's still-valid same-workflow session.
  describe("keepsBackendState — provider-switch continuity survives a cold start (#570)", () => {
    const HELLO = `http://127.0.0.1:8188::${UUID_A}`;

    it("KEEPS a dormant provider whose DURABLE identity matches the hello workflow", () => {
      // Claude has a persisted session bound to workflow A; this hello selected Codex after a
      // restart (tabStableIdentity empty). Claude's session belongs to the SAME workflow → keep.
      expect(
        keepsBackendState({
          storedIdentity: HELLO, // Claude's Entry.u
          priorIdentity: undefined, // cold start
          isCurrentBackend: false, // Claude is the DORMANT provider here
          helloIdentity: HELLO,
        }),
      ).toBe(true);
    });

    it("RESETS a provider bound to a DIFFERENT workflow (in-place replacement)", () => {
      const OTHER = `http://127.0.0.1:8188::${UUID_B}`;
      expect(
        keepsBackendState({
          storedIdentity: OTHER,
          priorIdentity: undefined,
          isCurrentBackend: false,
          helloIdentity: HELLO,
        }),
      ).toBe(false);
    });

    it("RESETS a provider with NO durable record unless it is the CURRENT backend with a matching prior identity", () => {
      // Dormant, no session → reset (nothing proven).
      expect(
        keepsBackendState({ storedIdentity: undefined, isCurrentBackend: false, helloIdentity: HELLO }),
      ).toBe(false);
      // Current backend, spawn-window live agent (no durable record): the tab's prior-hello
      // identity certifies it.
      expect(
        keepsBackendState({
          storedIdentity: undefined,
          priorIdentity: HELLO,
          isCurrentBackend: true,
          helloIdentity: HELLO,
        }),
      ).toBe(true);
      // …but a dormant provider must NOT borrow the tab's prior identity.
      expect(
        keepsBackendState({
          storedIdentity: undefined,
          priorIdentity: HELLO,
          isCurrentBackend: false,
          helloIdentity: HELLO,
        }),
      ).toBe(false);
    });

    it("FAILS CLOSED when the hello carries no identity (identity-less client)", () => {
      expect(
        keepsBackendState({ storedIdentity: HELLO, isCurrentBackend: true, helloIdentity: undefined }),
      ).toBe(false);
    });

    it("PROVEN tab-id migration spawn window: a just-rebound agent with NO durable record is KEPT via the carried source identity", () => {
      // A tmp:→wf: save/rename migration rebinds the agent to the new tab id. The new id has no
      // prior identity and, in the spawn→first-session window, no durable record. The hello
      // handler carries the PROVEN source identity (prevIdentity === newIdentity) forward as the
      // tab's prior identity, so the ownership gate recognizes the rebound backend as owned and
      // does NOT reset it (which would cancel its in-flight turn / drop its queued message).
      expect(
        keepsBackendState({
          storedIdentity: undefined, // spawn window — no SessionStore entry yet
          priorIdentity: HELLO, // carried proven source identity (prevIdentity === newIdentity)
          isCurrentBackend: true, // migration keeps the same backend (tab-id-only change)
          helloIdentity: HELLO,
        }),
      ).toBe(true);
      // Without the carried identity (the bug: prior derived from the empty new tab id) it WOULD
      // reset — proving the carry is load-bearing.
      expect(
        keepsBackendState({
          storedIdentity: undefined,
          priorIdentity: undefined,
          isCurrentBackend: true,
          helloIdentity: HELLO,
        }),
      ).toBe(false);
    });

    it("END-TO-END: a persisted Claude session survives a restart + hello on Codex for the same workflow", () => {
      const store = new SessionStore(PORT);
      // Claude conversed on workflow A before the restart — persisted, bound to A's identity.
      store.set("tmp:tabW::claude", "sess-claude-A", HELLO);
      // Cold start: tabStableIdentity empty; the first hello selects Codex for the SAME workflow.
      // The per-backend loop keeps Claude (matching) and resets Codex (no record).
      const backends = ["claude", "codex"] as const;
      const helloBackend = "codex";
      const kept: string[] = [];
      for (const b of backends) {
        const bKey = `tmp:tabW::${b}`;
        if (
          keepsBackendState({
            storedIdentity: store.identityOf(bKey),
            priorIdentity: undefined,
            isCurrentBackend: b === helloBackend,
            helloIdentity: HELLO,
          })
        ) {
          kept.push(b);
          continue;
        }
        store.clear(bKey); // models manager.reset()'s durable-session clear
      }
      expect(kept).toEqual(["claude"]);
      // Switching back to Claude still resumes the pre-restart conversation.
      expect(store.get("tmp:tabW::claude")).toBe("sess-claude-A");
      expect(new SessionStore(PORT).get("tmp:tabW::claude")).toBe("sess-claude-A"); // durable
    });
  });
});
