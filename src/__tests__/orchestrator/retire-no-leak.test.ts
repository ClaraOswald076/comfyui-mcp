// #570 P0a — a RETIRED agent must not leak a buffered event into the workflow it was
// retired in favor of. PanelAgentManager.retire()/stop() set `closed` fire-and-forget,
// but the backend's `for await` loop can still yield ONE more event before it observes
// the flag. The bridge's same-socket migration alias routes frames addressed to the
// retired tab to the newly-targeted one, so if that buffered event still fired
// onSession/onSay/onStream the OLD workflow's reply or session id would surface in the
// SWITCHED-TO workflow. handleEvent() now drops every event once closed.

import { describe, expect, it, beforeAll } from "vitest";
import type {
  AgentBackend,
  AgentEvent,
  BackendStartOptions,
  ModelChoice,
} from "../../orchestrator/agent-backend.js";
import { CLAUDE_CAPABILITIES } from "../../orchestrator/agent-backend.js";

let PanelAgent: typeof import("../../orchestrator/panel-agent.js").PanelAgent;

beforeAll(async () => {
  ({ PanelAgent } = await import("../../orchestrator/panel-agent.js"));
});

/** A backend that, once its turn is unblocked, emits a session + a say event. The test
 *  unblocks it only AFTER the agent is stopped, so those events arrive post-close. */
class LateEventBackend implements AgentBackend {
  readonly id = "claude" as const;
  readonly capabilities = CLAUDE_CAPABILITIES;
  private release: (() => void) | null = null;
  gate = new Promise<void>((resolve) => {
    this.release = resolve;
  });

  async *run(_opts: BackendStartOptions): AsyncGenerator<AgentEvent> {
    // Hold before emitting anything so the test can stop() the agent first.
    await this.gate;
    yield { type: "session", sessionId: "sess-late-LEAK" };
    yield { type: "say", text: "the OLD workflow's leaked reply", id: "m1" };
    yield { type: "result", subtype: "success" } as AgentEvent;
  }
  fire(): void {
    this.release?.();
  }
  async interrupt(): Promise<void> {}
  async listModels(): Promise<ModelChoice[]> {
    return [];
  }
}

async function tick(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 20));
}

describe("a retired/stopped agent leaks no buffered event (#570 P0a)", () => {
  it("drops a session/say yielded after stop() — no callback fires", async () => {
    const backend = new LateEventBackend();
    const sessions: string[] = [];
    const says: string[] = [];
    const deps = {
      mcpServers: {},
      systemAppend: "",
      model: "claude-test",
      onSession: (_tab: string, sid: string) => sessions.push(sid),
      onSay: (_tab: string, text: string) => says.push(text),
      onTurn: () => {},
    };
    const agent = new PanelAgent("tab-retire", deps as never, backend);
    void agent.start();
    agent.send("go");

    // Retire the agent BEFORE the backend emits (mirrors retire() on a workflow switch).
    await agent.stop();
    expect(agent.isStopped).toBe(true);

    // Now let the buffered session/say events flow. handleEvent must drop them.
    backend.fire();
    await tick();

    expect(sessions).toEqual([]); // no session id surfaced into the switched-to tab
    expect(says).toEqual([]); // no old reply leaked
  });
});
