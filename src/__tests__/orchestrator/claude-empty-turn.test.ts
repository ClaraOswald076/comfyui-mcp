// #740 — the Claude backend must not drop blocking SDK informational messages
// (e.g. a UserPromptSubmit hook denying the prompt) and must never report a turn
// that produced NO assistant content as a successful turn. The SDK ends such a
// turn with a `result` whose subtype is STILL "success"; the adapter has to
// classify it truthfully and surface the reason.
//
// Pattern follows claude-spawn-env.test.ts: the optional Agent SDK is mocked,
// the backend is driven through run(), and the canonical AgentEvents are
// collected and asserted on.

import { describe, expect, it, beforeEach, vi } from "vitest";
import type { AgentEvent } from "../../orchestrator/agent-backend.js";

const hoisted = vi.hoisted(() => ({
  /** A push-based async message source — stands in for the live SDK query stream. */
  queue: new (class {
    private buf: unknown[] = [];
    private waiters: Array<() => void> = [];
    private closed = false;
    reset(): void {
      this.buf = [];
      this.closed = false;
    }
    push(m: unknown): void {
      this.buf.push(m);
      for (const w of this.waiters.splice(0)) w();
    }
    end(): void {
      this.closed = true;
      for (const w of this.waiters.splice(0)) w();
    }
    async *iterate(): AsyncGenerator<unknown> {
      for (;;) {
        while (this.buf.length) yield this.buf.shift();
        if (this.closed) return;
        await new Promise<void>((resolve) => this.waiters.push(resolve));
      }
    }
  })(),
  onInterrupt: null as null | (() => void),
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: () => {
    const iter = hoisted.queue.iterate();
    return Object.assign(iter, {
      supportedModels: async () => [],
      supportedCommands: async () => [],
      interrupt: async () => {
        hoisted.onInterrupt?.();
      },
      setModel: async () => {},
    });
  },
}));

beforeEach(() => {
  hoisted.queue.reset();
  hoisted.onInterrupt = null;
});

const INIT = {
  type: "system",
  subtype: "init",
  session_id: "00000000-1111-2222-3333-444444444444",
  model: "claude-test-1",
  apiKeySource: "none",
  skills: [],
};

const RESULT_SUCCESS = { type: "result", subtype: "success" };

function assistantMsg(text: string) {
  return {
    type: "assistant",
    message: { role: "assistant", id: "msg-1", content: [{ type: "text", text }] },
    uuid: "a-1",
    session_id: INIT.session_id,
    parent_tool_use_id: null,
  };
}

function informational(extra: Record<string, unknown>) {
  return {
    type: "system",
    subtype: "informational",
    content: "UserPromptSubmit operation blocked by hook: memory-worker unavailable",
    level: "warning",
    uuid: "i-1",
    session_id: INIT.session_id,
    ...extra,
  };
}

async function* channel() {
  yield { text: "hi" };
}

/** Drive one backend session over the given script; resolve with the events. */
async function runScript(script: unknown[]): Promise<AgentEvent[]> {
  const { ClaudeBackend } = await import("../../orchestrator/claude-backend.js");
  const backend = new ClaudeBackend({ mcpServers: {}, systemAppend: "" });
  for (const m of script) hoisted.queue.push(m);
  hoisted.queue.end();
  const events: AgentEvent[] = [];
  for await (const ev of backend.run({ channel: channel() as never })) events.push(ev);
  return events;
}

const resultsOf = (events: AgentEvent[]) => events.filter((e) => e.type === "result");
const errorsOf = (events: AgentEvent[]) =>
  events.filter((e): e is Extract<AgentEvent, { type: "error" }> => e.type === "error");

describe("Claude backend #740 — blocking SDK informational messages", () => {
  it("surfaces the hook-block reason and fails the turn (prevent_continuation)", async () => {
    const events = await runScript([
      INIT,
      informational({ prevent_continuation: true }),
      RESULT_SUCCESS,
    ]);
    // The user receives the block reason…
    const errors = errorsOf(events);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("UserPromptSubmit operation blocked by hook");
    // …exactly one terminal result is emitted, and it is a FAILED one…
    const results = resultsOf(events);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ type: "result", ok: false, subtype: "success" });
    // …and no successful/empty assistant turn was produced.
    expect(events.some((e) => e.type === "assistant")).toBe(false);
  });

  it("honors the camelCase preventContinuation wire spelling too", async () => {
    const events = await runScript([
      INIT,
      informational({ preventContinuation: true }),
      RESULT_SUCCESS,
    ]);
    expect(errorsOf(events)).toHaveLength(1);
    expect(resultsOf(events)).toHaveLength(1);
    expect(resultsOf(events)[0]).toMatchObject({ ok: false });
  });

  it("a blocking turn does not leak its failure into the NEXT turn", async () => {
    const events = await runScript([
      INIT,
      informational({ prevent_continuation: true }),
      RESULT_SUCCESS,
      assistantMsg("recovered"),
      RESULT_SUCCESS,
    ]);
    const results = resultsOf(events);
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ ok: false });
    expect(results[1]).toMatchObject({ ok: true });
  });
});

describe("Claude backend #740 — an empty turn is never a success", () => {
  it("a result/success with no assistant content is reported as a failure", async () => {
    const events = await runScript([INIT, RESULT_SUCCESS]);
    const errors = errorsOf(events);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("without producing a reply");
    const results = resultsOf(events);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ ok: false, subtype: "success" });
  });

  it("a normal turn (assistant text + result/success) still reports success", async () => {
    const events = await runScript([INIT, assistantMsg("Hello!"), RESULT_SUCCESS]);
    expect(errorsOf(events)).toHaveLength(0);
    const results = resultsOf(events);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ ok: true });
    const said = events.filter((e) => e.type === "assistant");
    expect(said).toHaveLength(1);
    expect(said[0]).toMatchObject({ text: "Hello!" });
  });

  it("a non-blocking informational does not fail or replace the turn", async () => {
    const events = await runScript([
      INIT,
      informational({}), // no prevent_continuation → execution continues
      assistantMsg("still answered"),
      RESULT_SUCCESS,
    ]);
    expect(errorsOf(events)).toHaveLength(0);
    expect(resultsOf(events)).toHaveLength(1);
    expect(resultsOf(events)[0]).toMatchObject({ ok: true });
  });

  it("slash-command output (local_command_output) counts as turn content", async () => {
    const events = await runScript([
      INIT,
      {
        type: "system",
        subtype: "local_command_output",
        content: "Context: 12k / 200k",
        uuid: "l-1",
        session_id: INIT.session_id,
      },
      RESULT_SUCCESS,
    ]);
    expect(errorsOf(events)).toHaveLength(0);
    expect(resultsOf(events)).toHaveLength(1);
    expect(resultsOf(events)[0]).toMatchObject({ ok: true });
  });

  it("an empty result right after interrupt() is the interrupt landing, not a failure", async () => {
    const { ClaudeBackend } = await import("../../orchestrator/claude-backend.js");
    const backend = new ClaudeBackend({ mcpServers: {}, systemAppend: "" });
    hoisted.onInterrupt = () => {
      hoisted.queue.push(RESULT_SUCCESS);
      hoisted.queue.end();
    };
    hoisted.queue.push(INIT);
    const events: AgentEvent[] = [];
    const done = (async () => {
      for await (const ev of backend.run({ channel: channel() as never })) events.push(ev);
    })();
    // Wait until the session event proves run() is live (q exists), then stop.
    await vi.waitFor(() => expect(events.some((e) => e.type === "session")).toBe(true));
    await backend.interrupt();
    await done;
    expect(errorsOf(events)).toHaveLength(0);
    const results = resultsOf(events);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ ok: true });
  });
});
