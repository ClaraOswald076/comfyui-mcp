import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import {
  completionFenceIdentity,
  RunCompletionIdempotencyFence,
  scheduleRunCompletion,
} from "../../orchestrator/run-completion-idempotency.js";

const tempDirs: string[] = [];

function fencePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "cmcp-2341-"));
  tempDirs.push(dir);
  return join(dir, "run-completion-fence.json");
}

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("run completion scheduling idempotency (#2341)", () => {
  it("uses the stable completion key first and keeps the route/session in the identity", () => {
    const identity = completionFenceIdentity("orchestrator::claude", {
      prompt_id: "prompt-a",
      completion_key: "route-session/prompt-a/generation-1",
    });
    expect(identity).toBe(
      JSON.stringify(["panel_run", "orchestrator::claude", "completion_key", "route-session/prompt-a/generation-1"]),
    );
    expect(completionFenceIdentity("orchestrator::codex", { prompt_id: "prompt-a" })).not.toBe(
      completionFenceIdentity("orchestrator::claude", { prompt_id: "prompt-a" }),
    );
  });

  it("persists a seen/delivered fence across a new orchestrator instance", () => {
    let now = 10_000;
    const path = fencePath();
    const first = new RunCompletionIdempotencyFence({ path, now: () => now });
    const identity = completionFenceIdentity("orchestrator::claude", { prompt_id: "prompt-a" })!;

    expect(first.claim(identity)).toBe(true);
    expect(first.state(identity)).toBe("seen");
    expect(first.markDelivered(identity)).toBe(true);
    expect(first.state(identity)).toBe("delivered");
    expect(JSON.parse(readFileSync(path, "utf8")).entries[identity].state).toBe("delivered");

    const afterReconnect = new RunCompletionIdempotencyFence({ path, now: () => now });
    expect(afterReconnect.claim(identity)).toBe(false);
    expect(afterReconnect.state(identity)).toBe("delivered");

    now += 6 * 60 * 60_000;
    expect(afterReconnect.claim(identity)).toBe(true);
    expect(afterReconnect.state(identity)).toBe("seen");
  });

  it("bounds retained identities and allows distinct routes and prompts", () => {
    let now = 20_000;
    const path = fencePath();
    const fence = new RunCompletionIdempotencyFence({ path, now: () => now, maxEntries: 2 });
    const a = completionFenceIdentity("route-a", { prompt_id: "a" })!;
    const b = completionFenceIdentity("route-a", { prompt_id: "b" })!;
    const c = completionFenceIdentity("route-b", { prompt_id: "a" })!;

    expect(fence.claim(a)).toBe(true);
    now += 1;
    expect(fence.claim(b)).toBe(true);
    now += 1;
    expect(fence.claim(c)).toBe(true);
    expect(fence.state(a)).toBeUndefined();
    expect(fence.state(b)).toBe("seen");
    expect(fence.state(c)).toBe("seen");
  });

  it("suppresses a repeat before injection, including a stale frontend on reconnect", () => {
    const path = fencePath();
    const fence = new RunCompletionIdempotencyFence({ path, now: () => 30_000 });
    const payload = { kind: "executed", prompt_id: "prompt-replayed" };
    let injections = 0;
    const suppressed: string[] = [];
    const schedule = (token: string, route = "orchestrator::claude", promptId = payload.prompt_id) =>
      scheduleRunCompletion({
        route,
        payload: { ...payload, prompt_id: promptId },
        token,
        fence,
        inject: () => {
          injections += 1;
          return true;
        },
        suppress: (duplicateToken) => suppressed.push(duplicateToken),
      });

    expect(schedule("first")).toBe(true);
    expect(schedule("stale-reconnect"), "same session + prompt must not create a second turn").toBe(true);
    expect(injections).toBe(1);
    expect(suppressed).toEqual(["stale-reconnect"]);

    expect(schedule("different-session", "orchestrator::codex")).toBe(true);
    expect(schedule("different-prompt", "orchestrator::claude", "prompt-distinct")).toBe(true);
    expect(injections).toBe(3);
  });

  it("does not retain a refused hand-off as a false delivered fence", () => {
    const path = fencePath();
    const fence = new RunCompletionIdempotencyFence({ path, now: () => 40_000 });
    const payload = { kind: "executed", prompt_id: "prompt-retry" };
    let accept = false;
    let injections = 0;
    const schedule = (token: string) =>
      scheduleRunCompletion({
        route: "orchestrator::claude",
        payload,
        token,
        fence,
        inject: () => {
          injections += 1;
          return accept;
        },
        suppress: () => undefined,
      });

    expect(schedule("refused")).toBe(false);
    expect(fence.state(completionFenceIdentity("orchestrator::claude", payload)!)).toBeUndefined();
    accept = true;
    expect(schedule("retry")).toBe(true);
    expect(injections).toBe(2);
  });

  it("allows the journal to replay the same hand-off after an agent teardown", () => {
    const path = fencePath();
    const fence = new RunCompletionIdempotencyFence({ path, now: () => 45_000 });
    const identity = completionFenceIdentity("orchestrator::claude", { prompt_id: "prompt-replayed" })!;
    let injections = 0;

    expect(
      scheduleRunCompletion({
        route: "orchestrator::claude",
        payload: { kind: "executed", prompt_id: "prompt-replayed" },
        token: "first",
        fence,
        inject: () => {
          injections += 1;
          return true;
        },
        suppress: () => undefined,
      }),
    ).toBe(true);
    expect(
      scheduleRunCompletion({
        route: "orchestrator::claude",
        payload: { kind: "executed", prompt_id: "prompt-replayed", replayed: true },
        token: "journal-replay",
        replay: true,
        fence,
        inject: () => {
          injections += 1;
          return true;
        },
        suppress: () => undefined,
      }),
    ).toBe(true);

    expect(injections).toBe(2);
    expect(fence.state(identity)).toBe("delivered");
  });

  it("suppresses POSSIBLE_REPEAT even when an old panel has no stable id", () => {
    const path = fencePath();
    const fence = new RunCompletionIdempotencyFence({ path, now: () => 50_000 });
    let injections = 0;
    let suppressed = 0;
    const handled = scheduleRunCompletion({
      route: "orchestrator::claude",
      payload: { kind: "executed", possible_repeat: true },
      token: "unkeyed-repeat",
      fence,
      inject: () => {
        injections += 1;
        return true;
      },
      suppress: () => {
        suppressed += 1;
      },
    });

    expect(handled).toBe(true);
    expect(injections).toBe(0);
    expect(suppressed).toBe(1);
  });

  it("suppresses POSSIBLE_REPEAT even if the persisted fence was evicted", () => {
    const path = fencePath();
    const fence = new RunCompletionIdempotencyFence({ path, now: () => 60_000 });
    let injections = 0;
    let suppressed = 0;

    expect(
      scheduleRunCompletion({
        route: "orchestrator::claude",
        payload: { kind: "executed", prompt_id: "prompt-repeat", possible_repeat: true },
        token: "repeat-without-fence",
        fence,
        inject: () => {
          injections += 1;
          return true;
        },
        suppress: () => {
          suppressed += 1;
        },
      }),
    ).toBe(true);

    expect(injections).toBe(0);
    expect(suppressed).toBe(1);
    expect(fence.state(completionFenceIdentity("orchestrator::claude", { prompt_id: "prompt-repeat" })!)).toBe(
      "delivered",
    );
  });
});
