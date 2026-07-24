// Regression coverage for #307: the idle watchdog must measure progress for the
// ACTIVE turn, not "any app-server traffic". Before the fix, runTurn() bumped
// onActivity for every notification before it was attributed to a turn — so
// background account/model/token notifications, and notifications for another
// thread/turn, re-armed the watchdog forever and a genuinely wedged turn never
// reached its stall deadline.
//
// These tests drive the live notificationHandler directly (the same seam the
// interrupt-recovery suite uses) and assert onActivity fires ONLY for
// active-turn item/*, turn/*, and error notifications.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../../utils/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

type BackendModule = typeof import("../../orchestrator/codex-backend.js");
type Backend = InstanceType<BackendModule["CodexBackend"]>;
let CodexBackend: BackendModule["CodexBackend"];

beforeAll(async () => {
  vi.resetModules();
  ({ CodexBackend } = await import("../../orchestrator/codex-backend.js"));
});

afterAll(() => vi.unstubAllEnvs());

type Handler = ((message: unknown) => void) | null;

/** Spin up a backend on a live turn and hand back the notificationHandler plus
 *  the onActivity spy, so a test can post notifications and count re-arms. */
async function armedTurn() {
  const onActivity = vi.fn();
  const client = {
    notificationHandler: null as Handler,
    exitError: null,
    exitPromise: new Promise(() => {}),
    request: vi.fn(async (method: string) => {
      if (method === "thread/start") return { thread: { id: "thread-1" }, model: "gpt-5.6-sol" };
      if (method === "turn/start") return { turn: { id: "turn-1" } };
      throw new Error(`unexpected request: ${method}`);
    }),
    close: vi.fn().mockResolvedValue(undefined),
  };
  const backend: Backend = new CodexBackend({ model: "gpt-5.6-sol" });
  Object.assign(backend, { client });

  async function* channel() {
    yield { text: "go" };
    // Hold the channel open so the turn stays live while we post notifications.
    await new Promise(() => {});
  }
  const iterator = backend.run({ channel: channel(), onActivity });
  await iterator.next(); // consume the session event
  // A pending .next() drives runTurn (which issues turn/start and installs the
  // notificationHandler). It stays unresolved because the channel is held open.
  void iterator.next();
  // Wait until turn/start has resolved and the id is known (post-buffer path).
  for (let i = 0; i < 50 && !(backend as Backend & { turnId?: string }).turnId; i += 1) {
    await new Promise((r) => setImmediate(r));
  }
  const notify = (msg: Record<string, unknown>) => client.notificationHandler?.(msg);
  return { onActivity, notify };
}

describe("Codex watchdog liveness (#307)", () => {
  it("re-arms for active-turn item/*, turn/*, and model/* turn events", async () => {
    const { onActivity, notify } = await armedTurn();
    onActivity.mockClear();
    notify({ method: "item/started", params: { threadId: "thread-1", turnId: "turn-1" } });
    notify({ method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1" } });
    notify({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-1" } } });
    // model/* turn events (provider routing/safety) carry a turnId and ARE
    // progress — a bare item/turn prefix check missed them (review finding 2).
    notify({ method: "model/safetyBuffering/updated", params: { threadId: "thread-1", turnId: "turn-1" } });
    notify({ method: "model/rerouted", params: { threadId: "thread-1", turnId: "turn-1" } });
    expect(onActivity).toHaveBeenCalledTimes(5);
  });

  it("re-arms for a retrying active-turn error (Codex still owns the turn)", async () => {
    const { onActivity, notify } = await armedTurn();
    onActivity.mockClear();
    notify({
      method: "error",
      params: { threadId: "thread-1", turnId: "turn-1", willRetry: true, error: { message: "Reconnecting..." } },
    });
    expect(onActivity).toHaveBeenCalledTimes(1);
  });

  it("does NOT re-arm for background account/token-usage notifications", async () => {
    const { onActivity, notify } = await armedTurn();
    onActivity.mockClear();
    // Real app-server background notifications (not requests): they arrive while
    // the active turn is silent, and attributing them as liveness is exactly what
    // kept a wedged turn alive forever. (account/read and model/list are REQUESTS,
    // sent via client.request — they never reach notificationHandler.)
    notify({ method: "account/updated", params: {} });
    notify({ method: "account/rateLimits/updated", params: {} });
    notify({ method: "thread/tokenUsage/updated", params: { threadId: "thread-1", turnId: "turn-1" } });
    expect(onActivity).not.toHaveBeenCalled();
  });

  it("does NOT re-arm for a stale or other-thread/other-turn notification", async () => {
    const { onActivity, notify } = await armedTurn();
    onActivity.mockClear();
    // Right method, wrong turn/thread — must be rejected by belongsToTurn BEFORE
    // it can bump the watchdog.
    notify({ method: "item/started", params: { threadId: "thread-1", turnId: "turn-OLD" } });
    notify({ method: "turn/completed", params: { threadId: "other-thread", turn: { id: "turn-1" } } });
    expect(onActivity).not.toHaveBeenCalled();
  });

  it("counts a genuinely wedged turn as idle despite background chatter", async () => {
    // The end-to-end shape of the bug: the turn emits nothing on its own
    // item/turn stream, but background traffic keeps arriving. onActivity must
    // stay at zero so the stall deadline is reachable.
    const { onActivity, notify } = await armedTurn();
    onActivity.mockClear();
    for (let i = 0; i < 25; i += 1) {
      notify({ method: "account/updated", params: {} });
      notify({ method: "thread/tokenUsage/updated", params: { threadId: "thread-1", turnId: "turn-1" } });
      notify({ method: "item/started", params: { threadId: "thread-1", turnId: "turn-STALE" } });
    }
    expect(onActivity).not.toHaveBeenCalled();
  });
});
