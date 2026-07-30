// Regression guard for #175: a structured / multi-part user payload must reach
// the backend as READABLE text, never the literal "[object Object]" and never
// an empty prompt that silently drops the turn's content.
//
// This drives a payload through the SAME chokepoint the production path uses —
// PanelAgent's batching channel(), which now coerces each queued part with
// promptText() before joining — and asserts on what the backend actually
// receives as `turn.text`.

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

/** Minimal backend that records each turn's text and immediately completes it. */
class RecordingBackend implements AgentBackend {
  readonly id = "claude" as const;
  readonly capabilities = CLAUDE_CAPABILITIES;
  turns: string[] = [];
  private waiters: Array<{ n: number; resolve: () => void }> = [];

  waitFor(n: number, timeoutMs = 2000): Promise<void> {
    if (this.turns.length >= n) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`turn ${n} never arrived`)), timeoutMs);
      this.waiters.push({ n, resolve: () => { clearTimeout(timer); resolve(); } });
    });
  }

  async *run(opts: BackendStartOptions): AsyncGenerator<AgentEvent> {
    yield { type: "session", sessionId: "sess-rec" };
    for await (const turn of opts.channel) {
      this.turns.push(turn.text);
      this.waiters = this.waiters.filter((w) => {
        if (this.turns.length >= w.n) { w.resolve(); return false; }
        return true;
      });
      yield { type: "assistant", text: `ok: ${turn.text}` };
      yield { type: "result", ok: true, subtype: "success" };
    }
  }

  async interrupt(): Promise<void> {}
  async listModels(): Promise<ModelChoice[]> {
    return [];
  }
}

function makeDeps() {
  return {
    mcpServers: {},
    systemAppend: "",
    model: "claude-test",
    onSay: () => {},
    onTurn: () => {},
  };
}

describe("#175 structured user payload reaches the backend as readable text", () => {
  it("extracts the string `text` field from a multi-part payload", async () => {
    const backend = new RecordingBackend();
    const agent = new PanelAgent("tab-175a", makeDeps() as never, backend);
    void agent.start();

    // A structured payload where a plain string is expected (typed via cast, as
    // it would arrive over the wire).
    agent.send({ text: "hello from a structured part", parts: [{ kind: "text" }] } as unknown as string);
    await backend.waitFor(1);

    expect(backend.turns[0]).toBe("hello from a structured part");
    expect(backend.turns[0]).not.toContain("[object Object]");
    await agent.stop();
  });

  it("JSON-serializes a payload with no string text rather than emitting [object Object]", async () => {
    const backend = new RecordingBackend();
    const agent = new PanelAgent("tab-175b", makeDeps() as never, backend);
    void agent.start();

    agent.send({ kind: "image", ref: "input/a.png" } as unknown as string);
    await backend.waitFor(1);

    expect(backend.turns[0]).not.toBe("[object Object]");
    expect(backend.turns[0]).toContain("input/a.png");
    await agent.stop();
  });

  it("does NOT erase a payload whose text is empty but still carries parts", async () => {
    const backend = new RecordingBackend();
    const agent = new PanelAgent("tab-175c", makeDeps() as never, backend);
    void agent.start();

    agent.send({ text: "", parts: [{ kind: "image", ref: "input/b.png" }] } as unknown as string);
    await backend.waitFor(1);

    expect(backend.turns[0]).not.toBe("");
    expect(backend.turns[0]).toContain("input/b.png");
    await agent.stop();
  });
});
