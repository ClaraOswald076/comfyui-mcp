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
});
