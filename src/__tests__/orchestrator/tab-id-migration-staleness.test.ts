// #568 Defect 1 — a panel tab-id migration must move the agent's OWN identity, not
// just re-file it under a new manager-map key. rebindAgent() re-keys this.agents,
// but the PanelAgent also carries its own `tabId`: every callback (onTurn/onSay/
// onSeen/onSession → sessionStore) fires with it, and the bound panel MCP server
// resolves panel_* against it. Left stale, the agent keeps addressing the DEAD
// pre-migration tab — the log shows the old id forever, panel_* throws "no connected
// tab", and the session persists under an orphaned key. These pin that the field
// (and the panel-server binding) move with the tab.

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
let PanelAgent: typeof import("../../orchestrator/panel-agent.js").PanelAgent;

beforeAll(async () => {
  ({ PanelAgentManager, PanelAgent } = await import("../../orchestrator/panel-agent.js"));
});

const PORT = 59231;
const FILE = join(tmpdir(), `comfyui-mcp-panel-sessions-${PORT}.json`);
afterEach(() => {
  try {
    rmSync(FILE);
  } catch {
    /* already gone */
  }
});

/** Emits a fresh session at the START of every turn (like a real resume/restart),
 *  so onSession fires again after a rebind — the proof that persistence follows the
 *  new key. Records the turns and the mids it dequeued. */
class SessioningBackend implements AgentBackend {
  readonly id = "claude" as const;
  readonly capabilities = CLAUDE_CAPABILITIES;
  turnTexts: string[] = [];
  sessionId = "sess-migrate";

  async *run(opts: BackendStartOptions): AsyncGenerator<AgentEvent> {
    for await (const turn of opts.channel) {
      yield { type: "session", sessionId: this.sessionId };
      this.turnTexts.push(turn.text);
      yield { type: "result", ok: true, subtype: "success" };
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

describe("tab-id migration moves the agent's own identity (#568 Defect 1)", () => {
  it("after rebind, callbacks fire under the NEW key and the session persists under it", async () => {
    const backend = new SessioningBackend();
    const store = new SessionStore(PORT);
    const seen: Array<{ tab: string; mid: string }> = [];
    const sessions: Array<{ tab: string; sid: string }> = [];
    const manager = new PanelAgentManager({
      mcpServers: {},
      systemAppend: "",
      model: "claude-test",
      onSay: () => {},
      onTurn: () => {},
      onSeen: (tab: string, mid: string) => seen.push({ tab, mid }),
      onSession: (tab: string, sid: string) => sessions.push({ tab, sid }),
      sessionStore: store,
      makeBackend: () => backend,
    } as never);

    const oldKey = "tmp:69c6-old::claude";
    const newKey = "tmp:7ca3-new::claude";

    // A turn under the OLD key — callbacks + persistence land under it.
    manager.send(oldKey, "before migration", { mid: "mid-1" });
    await waitFor(() => backend.turnTexts.length === 1);
    expect(seen.find((s) => s.mid === "mid-1")?.tab).toBe(oldKey);
    expect(store.get(oldKey)).toBe("sess-migrate");

    // Panel tab-id migration.
    expect(manager.rebindAgent(oldKey, newKey)).toBe(true);
    expect(manager.hasLiveAgent(newKey)).toBe(true);
    // The durable session moved with the tab (rebindAgent's moveDurable).
    expect(store.get(newKey)).toBe("sess-migrate");
    expect(store.get(oldKey)).toBeUndefined();

    // A turn under the NEW key: the live agent (same instance) must now report the
    // NEW key. Before the fix this.tabId was still oldKey, so onSeen/onSession fired
    // with the pre-migration id and the session re-persisted under a dead key.
    manager.send(newKey, "after migration", { mid: "mid-2" });
    await waitFor(() => backend.turnTexts.length === 2);
    expect(seen.find((s) => s.mid === "mid-2")?.tab).toBe(newKey);
    // onSession (new session frame this turn) reported the NEW key…
    expect(sessions.some((s) => s.tab === newKey)).toBe(true);
    // …and NOT re-created a stale entry under the old key.
    expect(store.get(oldKey)).toBeUndefined();
    expect(store.get(newKey)).toBe("sess-migrate");

    await manager.stopAll();
  });

  it("rebind re-points the bound panel MCP server so panel_* stops addressing the dead id", async () => {
    const backend = new SessioningBackend();
    const rebinds: string[] = [];
    // A stand-in panel server exposing the rebindTab hook createPanelMcpServer adds.
    const panelServer = {
      type: "sdk",
      name: "comfyui-panel",
      instance: {},
      rebindTab: (t: string) => rebinds.push(t),
    };
    const manager = new PanelAgentManager({
      mcpServers: {},
      systemAppend: "",
      model: "claude-test",
      onSay: () => {},
      onTurn: () => {},
      makeBackend: () => backend,
      makePanelServer: () => panelServer,
    } as never);

    const oldKey = "tmp:aaaa-old::claude";
    const newKey = "wf:bbbb-new::claude";
    manager.send(oldKey, "spawn under old");
    await waitFor(() => backend.turnTexts.length === 1);

    expect(manager.rebindAgent(oldKey, newKey)).toBe(true);
    // The panel server was re-pointed at the BARE panel tab id (no ::backend).
    expect(rebinds).toEqual(["wf:bbbb-new"]);

    await manager.stopAll();
  });

  it("PanelAgent.rebindTabId updates the field even with no panel server bound", () => {
    const agent = new PanelAgent(
      "tmp:x::claude",
      { mcpServers: {}, systemAppend: "", model: "m", onSay: () => {}, onTurn: () => {} } as never,
      { id: "claude", capabilities: CLAUDE_CAPABILITIES } as never,
    );
    expect(agent.tabId).toBe("tmp:x::claude");
    agent.rebindTabId("tmp:y::claude", "tmp:y");
    expect(agent.tabId).toBe("tmp:y::claude");
  });
});
