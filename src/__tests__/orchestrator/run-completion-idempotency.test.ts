import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import {
  completionFenceIdentity,
  RunCompletionIdempotencyFence,
  scheduleRunCompletion,
} from "../../orchestrator/run-completion-idempotency.js";
import { RunCompletionJournalImpl } from "../../orchestrator/run-completion-journal.js";

const tempDirs: string[] = [];

function fencePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "cmcp-2341-"));
  tempDirs.push(dir);
  return join(dir, "run-completion-fence.json");
}

function stablePayload(promptId = "prompt-a", completionKey = `completion/${promptId}`) {
  return { kind: "executed", prompt_id: promptId, completion_key: completionKey };
}

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("run completion scheduling idempotency (#2341)", () => {
  it("uses a stable completion key first and requires journal proof for prompt ids", () => {
    const keyed = completionFenceIdentity("orchestrator::claude", {
      prompt_id: "prompt-a",
      completion_key: "route-session/prompt-a/generation-1",
    });
    expect(keyed).toBe(
      JSON.stringify(["panel_run", "orchestrator::claude", "completion_key", "route-session/prompt-a/generation-1"]),
    );

    expect(completionFenceIdentity("orchestrator::claude", { prompt_id: "prompt-a" })).toBeNull();
    const proven = completionFenceIdentity(
      "orchestrator::claude",
      { prompt_id: "prompt-a" },
      { journalProven: true },
    );
    expect(proven).toBe(JSON.stringify(["panel_run", "orchestrator::claude", "prompt_id", "prompt-a"]));
    expect(
      completionFenceIdentity("orchestrator::codex", { prompt_id: "prompt-a" }, { journalProven: true }),
    ).not.toBe(proven);
  });

  it("exposes journal proof only for an exact non-reused ticket generation", () => {
    const journal = new RunCompletionJournalImpl();
    journal.openRun("prompt-proven", { tabId: "tab-a", conversation: "orchestrator::claude" });
    const matched = journal.record(
      "orchestrator::claude",
      { kind: "executed", prompt_id: "prompt-proven" },
      { conversation: "orchestrator::claude" },
    );
    expect(journal.isJournalProvenForScheduling(matched.token)).toBe(true);

    const foreign = journal.record(
      "orchestrator::codex",
      { kind: "executed", prompt_id: "prompt-proven" },
      { conversation: "orchestrator::codex" },
    );
    expect(journal.isJournalProvenForScheduling(foreign.token)).toBe(false);

    journal.openRun("prompt-reused", { tabId: "tab-a", conversation: "orchestrator::claude" });
    journal.openRun("prompt-reused", { tabId: "tab-a", conversation: "orchestrator::claude" });
    const reused = journal.record(
      "orchestrator::claude",
      { kind: "executed", prompt_id: "prompt-reused" },
      { conversation: "orchestrator::claude" },
    );
    expect(journal.isJournalProvenForScheduling(reused.token)).toBe(false);
  });

  it("persists a delivered fence across a new orchestrator instance", () => {
    let now = 10_000;
    const path = fencePath();
    const first = new RunCompletionIdempotencyFence({ path, now: () => now });
    const identity = completionFenceIdentity("orchestrator::claude", stablePayload())!;

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

  it("bounds retained identities and allows distinct routes and completions", () => {
    let now = 20_000;
    const path = fencePath();
    const fence = new RunCompletionIdempotencyFence({ path, now: () => now, maxEntries: 2 });
    const a = completionFenceIdentity("route-a", stablePayload("a", "a"))!;
    const b = completionFenceIdentity("route-a", stablePayload("b", "b"))!;
    const c = completionFenceIdentity("route-b", stablePayload("a", "a"))!;

    expect(fence.claim(a)).toBe(true);
    now += 1;
    expect(fence.claim(b)).toBe(true);
    now += 1;
    expect(fence.claim(c)).toBe(true);
    expect(fence.state(a)).toBeUndefined();
    expect(fence.state(b)).toBe("seen");
    expect(fence.state(c)).toBe("seen");
  });

  it("suppresses a duplicate after a durable hand-off, including a stale frontend", () => {
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
        journalProven: true,
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
    const payload = stablePayload("prompt-retry", "completion/retry");
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
    const identity = completionFenceIdentity("orchestrator::claude", stablePayload("prompt-replayed"))!;
    let injections = 0;

    expect(
      scheduleRunCompletion({
        route: "orchestrator::claude",
        payload: stablePayload("prompt-replayed"),
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
        payload: { ...stablePayload("prompt-replayed"), replayed: true },
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

  it("injects POSSIBLE_REPEAT when there is no stable identity", () => {
    const fence = new RunCompletionIdempotencyFence({ path: fencePath(), now: () => 50_000 });
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
    expect(injections).toBe(1);
    expect(suppressed).toBe(0);
  });

  it("does not use an ambiguous or unprovable prompt id as a repeat fallback", () => {
    const fence = new RunCompletionIdempotencyFence({ path: fencePath(), now: () => 55_000 });
    const payload = { kind: "executed", prompt_id: "reused-id", possible_repeat: true };
    let injections = 0;
    let suppressed = 0;

    expect(completionFenceIdentity("orchestrator::claude", payload)).toBeNull();
    expect(
      scheduleRunCompletion({
        route: "orchestrator::claude",
        payload,
        token: "unprovable-repeat",
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

    expect(injections).toBe(1);
    expect(suppressed).toBe(0);
  });

  it("suppresses POSSIBLE_REPEAT only after a stable completion was durably handed off", () => {
    const path = fencePath();
    const fence = new RunCompletionIdempotencyFence({ path, now: () => 60_000 });
    const payload = { ...stablePayload("prompt-repeat", "completion/repeat"), possible_repeat: true };
    let injections = 0;
    let suppressed = 0;

    expect(
      scheduleRunCompletion({
        route: "orchestrator::claude",
        payload,
        token: "first-repeat",
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
    expect(injections).toBe(1);
    expect(suppressed).toBe(0);

    expect(
      scheduleRunCompletion({
        route: "orchestrator::claude",
        payload,
        token: "durable-repeat",
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
    expect(injections).toBe(1);
    expect(suppressed).toBe(1);
  });

  it("reclaims a persisted seen reservation after a crash before injection", () => {
    const now = 70_000;
    const path = fencePath();
    const first = new RunCompletionIdempotencyFence({ path, now: () => now });
    const payload = { ...stablePayload("prompt-crash", "completion/crash"), possible_repeat: true };
    const identity = completionFenceIdentity("orchestrator::claude", payload)!;

    // Simulate the crash window after the durable reservation and before manager.injectEvent.
    expect(first.claim(identity)).toBe(true);
    expect(first.state(identity)).toBe("seen");
    const afterRestart = new RunCompletionIdempotencyFence({ path, now: () => now });
    expect(afterRestart.state(identity)).toBe("seen");

    let injections = 0;
    let suppressed = 0;
    expect(
      scheduleRunCompletion({
        route: "orchestrator::claude",
        payload,
        token: "after-crash",
        fence: afterRestart,
        inject: () => {
          injections += 1;
          return true;
        },
        suppress: () => {
          suppressed += 1;
        },
      }),
    ).toBe(true);
    expect(injections).toBe(1);
    expect(suppressed).toBe(0);
    expect(afterRestart.state(identity)).toBe("delivered");
  });

  it("keeps a possible repeat pending when the fence cannot become durable", () => {
    const fenceFileDirectory = mkdtempSync(join(tmpdir(), "cmcp-2341-unwritable-"));
    tempDirs.push(fenceFileDirectory);
    const fence = new RunCompletionIdempotencyFence({
      path: fenceFileDirectory,
      now: () => 80_000,
    });
    let injections = 0;
    let suppressed = 0;

    expect(
      scheduleRunCompletion({
        route: "orchestrator::claude",
        payload: { ...stablePayload("prompt-no-durable-handoff", "completion/no-durable"), possible_repeat: true },
        token: "no-durable-fence",
        fence,
        inject: () => {
          injections += 1;
          return true;
        },
        suppress: () => {
          suppressed += 1;
        },
      }),
    ).toBe(false);
    expect(injections).toBe(0);
    expect(suppressed).toBe(0);
  });
});
