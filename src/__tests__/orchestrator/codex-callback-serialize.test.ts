// The Codex app-server `item/completed` commit for an `agentMessage` normally
// carries a string `text`, but newer builds can send structured content that
// String()-coerces to "[object Object]" and OVERWRITES the streamed reply the
// user already saw (#421, #422). These tests drive the notification handler and
// assert the committed `assistant` event is readable text — falling back to the
// streamed buffer when the final commit is malformed.

import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../../utils/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

type BackendModule = typeof import("../../orchestrator/codex-backend.js");
let CodexBackend: BackendModule["CodexBackend"];

beforeAll(async () => {
  vi.resetModules();
  ({ CodexBackend } = await import("../../orchestrator/codex-backend.js"));
});

function makeClient() {
  return {
    notificationHandler: null as ((message: unknown) => void) | null,
    exitError: null,
    exitPromise: new Promise(() => {}),
    request: vi.fn(async (method: string) => {
      if (method === "thread/start") return { thread: { id: "thread-1" }, model: "gpt-5.6-sol" };
      if (method === "turn/start") return { turn: { id: "turn-1" } };
      throw new Error(`unexpected request: ${method}`);
    }),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

/** Drain the async iterator until the turn's terminal `result`, collecting events. */
async function driveTurn(
  notify: (client: ReturnType<typeof makeClient>) => void,
): Promise<Array<Record<string, unknown>>> {
  const client = makeClient();
  const backend = new CodexBackend({ model: "gpt-5.6-sol" });
  Object.assign(backend, { client });

  async function* channel() {
    yield { text: "go" };
  }

  const iterator = backend.run({ channel: channel() });
  const events: Array<Record<string, unknown>> = [];

  // Drain concurrently — pulling keeps the async generator advancing (past the
  // session yield) so it can register the notification handler and start the turn.
  const drain = (async () => {
    for (let i = 0; i < 100; i += 1) {
      const { value, done } = await iterator.next();
      if (done) break;
      events.push(value as Record<string, unknown>);
      if ((value as { type?: string }).type === "result") break;
    }
  })();

  // Wait for the turn to be registered before pushing notifications.
  for (let attempt = 0; attempt < 50 && !(backend as any).turnId; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  notify(client);
  await drain;
  return events;
}

const completedTurn = (client: ReturnType<typeof makeClient>) =>
  client.notificationHandler?.({
    method: "turn/completed",
    params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } },
  });

describe("CodexBackend run-finished commit serialization (#421, #422)", () => {
  it("commits a STRUCTURED agentMessage payload as readable text, not [object Object]", async () => {
    const events = await driveTurn((client) => {
      client.notificationHandler?.({
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: { type: "agentMessage", id: "m1", text: [{ type: "text", text: "run finished ok" }] },
        },
      });
      completedTurn(client);
    });
    const assistant = events.find((e) => e.type === "assistant");
    expect(assistant?.text).toBe("run finished ok");
    expect(assistant?.text).not.toBe("[object Object]");
  });

  it("does NOT clobber the streamed reply when the final commit coerces to empty", async () => {
    const events = await driveTurn((client) => {
      // Stream the real reply the user sees.
      client.notificationHandler?.({
        method: "item/agentMessage/delta",
        params: { threadId: "thread-1", turnId: "turn-1", itemId: "m1", delta: "Hello, streamed " },
      });
      client.notificationHandler?.({
        method: "item/agentMessage/delta",
        params: { threadId: "thread-1", turnId: "turn-1", itemId: "m1", delta: "world." },
      });
      // Malformed final commit — an object with no readable text.
      client.notificationHandler?.({
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: { type: "agentMessage", id: "m1", text: { unexpected: "shape" } },
        },
      });
      completedTurn(client);
    });
    const assistant = events.find((e) => e.type === "assistant");
    expect(assistant?.text).toBe("Hello, streamed world.");
    expect(assistant?.text).not.toBe("[object Object]");
  });

  it("resets the streamed-text buffer between commits in a multi-message turn", async () => {
    const events = await driveTurn((client) => {
      // First message: streamed, then a malformed commit → falls back to stream.
      client.notificationHandler?.({
        method: "item/agentMessage/delta",
        params: { threadId: "thread-1", turnId: "turn-1", itemId: "m1", delta: "first reply" },
      });
      client.notificationHandler?.({
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: { type: "agentMessage", id: "m1", text: { bad: "shape" } },
        },
      });
      // Second message: a DIFFERENT malformed commit with NO deltas. Its fallback
      // must be "" (buffer reset), NOT the stale "first reply".
      client.notificationHandler?.({
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: { type: "agentMessage", id: "m2", text: { also: "bad" } },
        },
      });
      completedTurn(client);
    });
    const assistants = events.filter((e) => e.type === "assistant");
    expect(assistants).toHaveLength(2);
    expect(assistants[0]?.text).toBe("first reply");
    // No stale carryover from the first message's stream buffer.
    expect(assistants[1]?.text).toBe("");
  });

  it("still commits a plain-string final commit unchanged", async () => {
    const events = await driveTurn((client) => {
      client.notificationHandler?.({
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: { type: "agentMessage", id: "m1", text: "just a string" },
        },
      });
      completedTurn(client);
    });
    const assistant = events.find((e) => e.type === "assistant");
    expect(assistant?.text).toBe("just a string");
  });
});
