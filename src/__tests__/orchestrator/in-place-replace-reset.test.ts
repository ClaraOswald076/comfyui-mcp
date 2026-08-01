// #570 P0 — a SAVED workflow overwritten IN PLACE (same wf:<path> tab id, new uuid) must
// start FRESH. The hello handler detects the durable identity mismatch and calls
// manager.reset(key) — a FULL session boundary. This pins the manager-lifecycle half:
// (1) the exact session is BOUND to the identity uuid (identityForKey → SessionStore.u),
// and (2) reset() stops the LIVE agent AND clears the durable session + pending resume, so
// the next message can't continue the replaced workflow's conversation.

import { describe, expect, it, beforeAll, afterEach } from "vitest";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentBackend,
  AgentEvent,
  BackendStartOptions,
  ModelChoice,
} from "../../orchestrator/agent-backend.js";
import { CLAUDE_CAPABILITIES } from "../../orchestrator/agent-backend.js";
import { SessionStore } from "../../orchestrator/session-store.js";

let PanelAgentManager: typeof import("../../orchestrator/panel-agent.js").PanelAgentManager;
beforeAll(async () => {
  ({ PanelAgentManager } = await import("../../orchestrator/panel-agent.js"));
});

const PORT = 59244;
const FILE = join(tmpdir(), `comfyui-mcp-panel-sessions-${PORT}.json`);
afterEach(() => {
  try {
    rmSync(FILE);
  } catch {
    /* already gone */
  }
});

class SessioningBackend implements AgentBackend {
  readonly id = "claude" as const;
  readonly capabilities = CLAUDE_CAPABILITIES;
  turnTexts: string[] = [];
  sessionId = "sess-A";
  async *run(opts: BackendStartOptions): AsyncGenerator<AgentEvent> {
    for await (const turn of opts.channel) {
      yield { type: "session", sessionId: this.sessionId };
      this.turnTexts.push(turn.text);
      yield { type: "result", ok: true, subtype: "success" } as AgentEvent;
    }
  }
  async interrupt(): Promise<void> {}
  async listModels(): Promise<ModelChoice[]> {
    return [];
  }
}

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}

const UUID_A = "11111111-1111-4111-8111-111111111111";
const IDENTITY_A = `http://127.0.0.1:8188::${UUID_A}`;

describe("in-place workflow replacement resets the live session (#570 P0)", () => {
  it("binds the exact session to its identity uuid and reset() clears the live agent + session", async () => {
    const backend = new SessioningBackend();
    const store = new SessionStore(PORT);
    const manager = new PanelAgentManager({
      mcpServers: {},
      systemAppend: "",
      model: "claude-test",
      onSay: () => {},
      onTurn: () => {},
      onSession: () => {},
      sessionStore: store,
      makeBackend: () => backend,
      // Mirrors index.ts: the tab's FULL trusted workflow identity (origin::uuid).
      identityForKey: () => IDENTITY_A,
    } as never);

    const key = "wf:foo.json::claude";
    // Workflow A converses — the session persists BOUND to A's uuid.
    manager.send(key, "hello from workflow A");
    await waitFor(() => backend.turnTexts.length === 1);
    expect(store.get(key)).toBe("sess-A");
    expect(store.identityOf(key)).toBe(IDENTITY_A); // durable full-identity binding
    expect(manager.hasLiveAgent(key)).toBe(true);

    // The hello handler, on detecting boundUuid (UUID_A) !== the new hello's uuid, calls
    // manager.reset(key). That must stop the LIVE agent AND clear the durable session —
    // not just the disk record — so the replaced workflow can't be continued.
    manager.reset(key);
    expect(manager.hasLiveAgent(key)).toBe(false); // live agent stopped
    expect(store.get(key)).toBeUndefined(); // durable session cleared
    expect(store.identityOf(key)).toBeUndefined();

    await manager.stopAll();
  });

  it("#570: a proven tab-id migration rebinds EVERY backend, so a dormant provider's session survives", async () => {
    // Saved workflow A: Claude conversed (dormant after a switch to Codex), Codex is current, then
    // a save/rename changes the wf: tab id. The migration must move the dormant Claude session to
    // the new id too — not only the current (Codex) one — or switching back to Claude starts fresh.
    const backend = new SessioningBackend();
    const store = new SessionStore(PORT);
    const manager = new PanelAgentManager({
      mcpServers: {},
      systemAppend: "",
      model: "claude-test",
      onSay: () => {},
      onTurn: () => {},
      onSession: () => {},
      sessionStore: store,
      makeBackend: () => backend,
      identityForKey: () => IDENTITY_A,
    } as never);

    // Dormant Claude session + live-then-retired: model both providers having durable sessions
    // under the OLD tab id (Claude dormant, Codex current) — bound to the same workflow identity.
    store.set("wf:old.json::claude", "sess-claude", IDENTITY_A);
    store.set("wf:old.json::codex", "sess-codex", IDENTITY_A);

    // The proven migration loops over KNOWN_BACKENDS calling rebindAgent(old::b → new::b).
    for (const b of ["claude", "codex"]) {
      manager.rebindAgent(`wf:old.json::${b}`, `wf:new.json::${b}`);
    }

    // BOTH providers' sessions moved to the new id (dormant Claude included), old keys cleared.
    expect(store.get("wf:new.json::claude")).toBe("sess-claude");
    expect(store.get("wf:new.json::codex")).toBe("sess-codex");
    expect(store.get("wf:old.json::claude")).toBeUndefined();
    expect(store.get("wf:old.json::codex")).toBeUndefined();
    // …and durably: switching back to Claude on the new id resumes its original conversation.
    expect(new SessionStore(PORT).get("wf:new.json::claude")).toBe("sess-claude");

    await manager.stopAll();
  });

  it("#570: a tab-id migration COLLISION resets the superseded destination then rebinds the source (no cross-tab leak)", async () => {
    // The same workflow open in TWO tabs; the incoming socket migrates onto the other's id. The
    // bridge has already SUPERSEDED the destination's socket, so its still-mapped agent would
    // render into the incoming tab. Reset the superseded destination, THEN rebind the source into
    // the freed id so the incoming tab keeps its OWN conversation.
    const store = new SessionStore(PORT);
    const manager = new PanelAgentManager({
      mcpServers: {},
      systemAppend: "",
      model: "claude-test",
      onSay: () => {},
      onTurn: () => {},
      onSession: () => {},
      sessionStore: store,
      makeBackend: () => new SessioningBackend(),
      identityForKey: () => IDENTITY_A,
    } as never);

    const oldKey = "tmp:A::claude"; // incoming/source tab
    const newKey = "wf:foo.json::claude"; // destination tab (already open, same workflow)
    manager.send(newKey, "destination tab (B) conversation");
    manager.send(oldKey, "incoming tab (A) conversation");
    await waitFor(() => manager.hasLiveAgent(oldKey) && manager.hasLiveAgent(newKey));

    // Without handling, rebind REFUSES (destination occupied) and the source stays stranded live
    // under the old id — the leak precondition.
    expect(manager.rebindAgent(oldKey, newKey)).toBe(false);
    expect(manager.hasLiveAgent(oldKey)).toBe(true);

    // Collision handling: reset the superseded destination (its agent is removed → it can no
    // longer render into the incoming socket), THEN rebind the incoming source into the freed id.
    manager.reset(newKey);
    expect(manager.rebindAgent(oldKey, newKey)).toBe(true); // source takes the id
    expect(manager.hasLiveAgent(newKey)).toBe(true); // incoming tab keeps its OWN (source) conversation
    expect(manager.hasLiveAgent(oldKey)).toBe(false); // nothing stranded under the old id

    await manager.stopAll();
  });

  it("#570: a backend switch RETIRES the prior provider (preserves its session) so switching back resumes", async () => {
    // BOTH provider-switch protocols on the SAME workflow — the explicit set_backend event AND
    // a re-hello that selects a different backend — now funnel to manager.retire(prevKey). They
    // must NOT reset the old provider: that would clear its durable exact record, and a SAVED
    // wf: workflow has no stable-key fallback, so switching back could never resume. retire()
    // stops the live agent but keeps the identity-bound session, so a later switch-back
    // continues the original conversation (codex round-trip). This pins that shared operation.
    const backend = new SessioningBackend();
    const store = new SessionStore(PORT);
    const manager = new PanelAgentManager({
      mcpServers: {},
      systemAppend: "",
      model: "claude-test",
      onSay: () => {},
      onTurn: () => {},
      onSession: () => {},
      sessionStore: store,
      makeBackend: () => backend,
      identityForKey: () => IDENTITY_A,
    } as never);

    const claudeKey = "wf:foo.json::claude"; // a SAVED workflow (no stable-key fallback)
    manager.send(claudeKey, "hi from claude on workflow A");
    await waitFor(() => backend.turnTexts.length === 1);
    expect(store.get(claudeKey)).toBe("sess-A");
    expect(manager.hasLiveAgent(claudeKey)).toBe(true);

    // Provider switch A(claude) → B(codex): set_backend now RETIRES claude, not resets it.
    manager.retire(claudeKey);
    expect(manager.hasLiveAgent(claudeKey)).toBe(false); // live agent stopped (no double-run)
    // …but the durable session is PRESERVED — this is what makes the switch-BACK resumable.
    expect(store.get(claudeKey)).toBe("sess-A");
    expect(store.identityOf(claudeKey)).toBe(IDENTITY_A);
    // Durable across a fresh process too (a restart between switches).
    expect(new SessionStore(PORT).get(claudeKey)).toBe("sess-A");

    await manager.stopAll();
  });

  it("P0a: a live agent in the spawn→first-session window (no durable record) is still torn down", async () => {
    // The prior workflow can have a LIVE agent BEFORE its first `session` event — so no
    // durable exact record exists yet. The identity-boundary reset gates on STATE
    // (hasLiveAgent), not on a durable record, so this window is covered. Here we prove the
    // precondition (live agent, no durable session) and that manager.reset tears it down.
    class NoSessionBackend implements AgentBackend {
      readonly id = "claude" as const;
      readonly capabilities = CLAUDE_CAPABILITIES;
      started = false;
      release: (() => void) | null = null;
      async *run(opts: BackendStartOptions): AsyncGenerator<AgentEvent> {
        for await (const _turn of opts.channel) {
          this.started = true;
          // Hang the turn WITHOUT ever yielding a `session` event — the spawn→first-session
          // window. (No `yield { type: "session" }`.)
          await new Promise<void>((r) => {
            this.release = r;
          });
        }
      }
      async interrupt(): Promise<void> {
        this.release?.();
      }
      async listModels(): Promise<ModelChoice[]> {
        return [];
      }
    }
    const backend = new NoSessionBackend();
    const store = new SessionStore(PORT);
    const manager = new PanelAgentManager({
      mcpServers: {},
      systemAppend: "",
      model: "claude-test",
      onSay: () => {},
      onTurn: () => {},
      onSession: () => {},
      sessionStore: store,
      makeBackend: () => backend,
      identityForKey: () => IDENTITY_A,
    } as never);
    const key = "wf:foo.json::claude";
    manager.send(key, "hang without a session");
    await waitFor(() => backend.started);
    // The window: a LIVE agent, but NO durable session record yet.
    expect(manager.hasLiveAgent(key)).toBe(true);
    expect(store.get(key)).toBeUndefined();
    // The identity-boundary branch (gated on hasLiveAgent, not the durable record) resets it.
    manager.reset(key);
    expect(manager.hasLiveAgent(key)).toBe(false);
    await manager.stopAll();
  });

  it("P0: failed-start held mail counts as state (torn down on an identity transition)", async () => {
    // A backend prepare() failure DROPS the agent but PARKS the queued user message in
    // heldMessages (#256) — no live agent, no session. hasAnyState must still see it, so an
    // in-place replacement resets it instead of re-delivering the prior workflow's message.
    class RejectingBackend implements AgentBackend {
      readonly id = "claude" as const;
      readonly capabilities = CLAUDE_CAPABILITIES;
      async prepare(): Promise<void> {
        throw new Error("prepare rejected (bad key)");
      }
      async *run(): AsyncGenerator<AgentEvent> {
        throw new Error("run must not be reached");
      }
      async interrupt(): Promise<void> {}
      async listModels(): Promise<ModelChoice[]> {
        return [];
      }
    }
    const store = new SessionStore(PORT);
    const manager = new PanelAgentManager({
      mcpServers: {},
      systemAppend: "",
      model: "claude-test",
      onSay: () => {},
      onTurn: () => {},
      onStartFailure: () => {},
      onSession: () => {},
      sessionStore: store,
      makeBackend: () => new RejectingBackend(),
      identityForKey: () => IDENTITY_A,
    } as never);
    const key = "wf:foo.json::claude";
    manager.send(key, "A's private message queued behind a failed start");
    // The start fails: no live agent, no durable session — but the message is PARKED.
    await waitFor(() => manager.hasAnyState(key) && !manager.hasLiveAgent(key));
    expect(store.get(key)).toBeUndefined();
    expect(manager.hasAnyState(key)).toBe(true); // held mail is state
    // The identity boundary (gated on hasAnyState) resets — the parked message is dropped,
    // never re-delivered into the replacement workflow.
    manager.reset(key);
    expect(manager.hasAnyState(key)).toBe(false);
    await manager.stopAll();
  });
});
