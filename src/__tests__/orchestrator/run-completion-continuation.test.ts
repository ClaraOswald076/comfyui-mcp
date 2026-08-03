// #468 — `panel_run`'s completion event must survive AUTOMATIC GOAL CONTINUATION.
//
// The old delivery path (agent_event → manager.injectEvent → PanelAgent.queue)
// was fire-and-forget: uncorrelated, silently dropped when no agent was live,
// and discarded outright when a queued-but-unread item died with its agent. An
// ordinary single run leaves the agent IDLE, so the completion is drained
// instantly and none of that shows. A goal continuation keeps the agent BUSY for
// the whole render — which is exactly the window where the completion sits
// unread and the continuation's own turn churn (deferred effort/MCP restarts,
// the self-restart loop) tears the listener down underneath it.
//
// These tests lock the four properties the fix promises:
//   1. delivered across a continuation (the agent is busy the whole render);
//   2. a completion with no live agent is JOURNALED and replayed, correlated to
//      the run it arrived for;
//   3. a completion that cannot be correlated is REPORTED as undetermined, never
//      swallowed and never presented as the awaited render;
//   4. a replay can never satisfy a DIFFERENT run.

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type {
  AgentBackend,
  AgentEvent,
  BackendStartOptions,
  ModelChoice,
} from "../../orchestrator/agent-backend.js";
import { CLAUDE_CAPABILITIES } from "../../orchestrator/agent-backend.js";
import {
  RunCompletionJournalImpl,
  type CompletionPayload,
} from "../../orchestrator/run-completion-journal.js";

let PanelAgentManager: typeof import("../../orchestrator/panel-agent.js").PanelAgentManager;

beforeAll(async () => {
  ({ PanelAgentManager } = await import("../../orchestrator/panel-agent.js"));
});

const PROMPT_A = "246da5fc-a6b4-4e85-bbd5-5f2463a757a0";
const PROMPT_B = "5bc36c41-fe83-481f-8a71-b9dd1c3b05a4";

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}

/**
 * A backend that models AUTOMATIC GOAL CONTINUATION: it holds each turn open
 * until the test releases it, so the agent is continuously busy while the render
 * completes — the exact state the completion has to survive.
 */
class ContinuationBackend implements AgentBackend {
  readonly id = "claude" as const;
  readonly capabilities = CLAUDE_CAPABILITIES;
  turns: string[] = [];
  /** Resolves the turn currently in flight. */
  private release: (() => void) | null = null;
  /** When true, a turn never produces a `result` (a stalled/abandoned turn). */
  strandTurns = false;

  async *run(opts: BackendStartOptions): AsyncGenerator<AgentEvent> {
    yield { type: "session", sessionId: "sess-468" };
    for await (const turn of opts.channel) {
      this.turns.push((turn as { text?: string }).text ?? "");
      await new Promise<void>((resolve) => {
        this.release = resolve;
      });
      if (this.strandTurns) continue;
      yield { type: "result", ok: true, subtype: "success" };
    }
  }

  /** Let the in-flight turn finish (its `result` acks any carried completion). */
  finishTurn(): void {
    const r = this.release;
    this.release = null;
    r?.();
  }

  async interrupt(): Promise<void> {
    this.finishTurn();
  }
  async listModels(): Promise<ModelChoice[]> {
    return [];
  }
}

/** Wires a manager to a journal exactly as the orchestrator does (index.ts's
 *  flushRunCompletions / onEventDelivered / onEventUndelivered / onAgentReady),
 *  through the journal's own deliverPending so no delivery logic is duplicated. */
function makeHarness(backend: AgentBackend) {
  const journal = new RunCompletionJournalImpl();
  const flush = (tab: string) =>
    journal.deliverPending(tab, (payload, token) =>
      manager.injectEvent(tab, payload, { eventToken: token }),
    );
  const manager = new PanelAgentManager({
    mcpServers: {},
    systemAppend: "",
    model: "claude-test",
    onSay: () => {},
    onTurn: () => {},
    makeBackend: () => backend,
    onEventDelivered: (_key: string, tokens: string[]) => {
      for (const t of tokens) journal.ack(t);
    },
    onEventUndelivered: (key: string, tokens: string[]) => {
      for (const t of tokens) journal.release(t);
      flush(key);
    },
    onAgentReady: (key: string) => flush(key),
  } as never);
  /** The orchestrator's agent_event handler for kind:"executed". */
  const arrive = (tab: string, payload: CompletionPayload) => {
    journal.record(tab, payload);
    flush(tab);
  };
  return { journal, manager, flush, arrive };
}

describe("run completion across automatic goal continuation (#468)", () => {
  it("delivers the completion into the next turn while the agent is busy continuing a goal", async () => {
    const backend = new ContinuationBackend();
    const { journal, manager, arrive } = makeHarness(backend);
    const tab = "tab-continuation";

    journal.openRun(PROMPT_A, { tabId: tab });
    manager.send(tab, "render it and keep going");
    await waitFor(() => backend.turns.length >= 1);

    // The render finishes MID-CONTINUATION: the agent is still inside turn 1.
    arrive(tab, { kind: "executed", prompt_id: PROMPT_A, images: [{ filename: "out_0001.png" }] });
    expect(backend.turns.length).toBe(1); // nothing delivered yet — still busy

    backend.finishTurn(); // the continuation turn ends
    await waitFor(() => backend.turns.length >= 2);

    expect(backend.turns[1]).toContain("out_0001.png");
    expect(backend.turns[1]).toContain(PROMPT_A);
    expect(backend.turns[1]).toContain("This is the run YOU queued");
    // Still journaled until the turn CARRYING it ends — hand-off is not proof.
    expect(journal.outstanding(tab)).toHaveLength(1);

    backend.finishTurn();
    await waitFor(() => journal.outstanding(tab).length === 0);
    expect(journal.ticketFor(PROMPT_A)?.settled).toBe(true);
  });

  it("journals a completion that lands with no live agent and replays it to the right run", async () => {
    const backend = new ContinuationBackend();
    const { journal, manager, arrive } = makeHarness(backend);
    const tab = "tab-no-agent";

    journal.openRun(PROMPT_A, { tabId: tab });
    // No agent exists yet for this tab (the previous one was torn down by a
    // restart the continuation triggered) — the old code dropped this silently.
    arrive(tab, { kind: "executed", prompt_id: PROMPT_A, images: [{ filename: "late_0001.png" }] });
    expect(journal.outstanding(tab)).toHaveLength(1);
    expect(journal.pending(tab)).toHaveLength(1); // still awaiting a delivery attempt

    // A fresh agent comes back → onAgentReady replays it.
    manager.send(tab, "still here?");
    await waitFor(() => backend.turns.length >= 1);

    // The replay is queued AHEAD of the message that spawned the agent, so both
    // land; assert the completion text is present in some turn.
    const all = backend.turns.join("\n");
    expect(all).toContain("late_0001.png");
    expect(all).toContain(PROMPT_A);
    expect(all).toContain("This is the run YOU queued");

    backend.finishTurn();
    await waitFor(() => journal.outstanding(tab).length === 0);
    expect(journal.ticketFor(PROMPT_A)?.settled).toBe(true);
  });

  it("replays a completion whose carrying turn was abandoned — it is never swallowed", async () => {
    const backend = new ContinuationBackend();
    const { journal, manager, arrive } = makeHarness(backend);
    const tab = "tab-abandoned";

    journal.openRun(PROMPT_A, { tabId: tab });
    manager.send(tab, "go");
    await waitFor(() => backend.turns.length >= 1);
    backend.finishTurn();

    arrive(tab, { kind: "executed", prompt_id: PROMPT_A, images: [{ filename: "kept_0001.png" }] });
    await waitFor(() => backend.turns.length >= 2);
    expect(backend.turns[1]).toContain("kept_0001.png");

    // The turn carrying it is thrown away (a plain Stop / abandoned turn). The
    // completion must come BACK, not die with the turn.
    await manager.interrupt(tab, { requeueInFlight: false });
    await waitFor(() => backend.turns.length >= 3);
    expect(backend.turns[2]).toContain("kept_0001.png");
    expect(backend.turns[2]).toContain("RE-DELIVERED");
  });

  it("reports an uncorrelatable completion as UNDETERMINED instead of swallowing it", async () => {
    const backend = new ContinuationBackend();
    const { journal, manager, arrive } = makeHarness(backend);
    const tab = "tab-unknown";

    journal.openRun(PROMPT_A, { tabId: tab }); // the agent IS waiting on a run
    manager.send(tab, "go");
    await waitFor(() => backend.turns.length >= 1);
    backend.finishTurn();

    // …but the completion that arrives carries no prompt id at all.
    arrive(tab, { kind: "executed", images: [{ filename: "mystery_0001.png" }] });
    await waitFor(() => backend.turns.length >= 2);

    const text = backend.turns[1];
    expect(text).toContain("mystery_0001.png"); // still delivered
    expect(text).toContain("UNDETERMINED");
    expect(text).toContain("get_history");
    expect(text).not.toContain("This is the run YOU queued");
    // …and it must not settle the run the agent is actually waiting on.
    backend.finishTurn();
    await waitFor(() => journal.outstanding(tab).length === 0);
    expect(journal.ticketFor(PROMPT_A)?.settled).toBe(false);
  });

  it("reports a completion for a run this session never queued as UNDETERMINED", async () => {
    const backend = new ContinuationBackend();
    const { journal, manager, arrive } = makeHarness(backend);
    const tab = "tab-foreign";

    journal.openRun(PROMPT_A, { tabId: tab });
    manager.send(tab, "go");
    await waitFor(() => backend.turns.length >= 1);
    backend.finishTurn();

    arrive(tab, { kind: "executed", prompt_id: PROMPT_B, images: [{ filename: "theirs.png" }] });
    await waitFor(() => backend.turns.length >= 2);

    const text = backend.turns[1];
    expect(text).toContain("does NOT match any run you queued");
    expect(text).toContain("UNDETERMINED");
    expect(text).toContain(PROMPT_B);

    backend.finishTurn();
    await waitFor(() => journal.outstanding(tab).length === 0);
    expect(journal.ticketFor(PROMPT_A)?.settled).toBe(false); // our run is still open
  });

  it("a replayed completion never satisfies a DIFFERENT run", async () => {
    const backend = new ContinuationBackend();
    const { journal, manager, arrive } = makeHarness(backend);
    const tab = "tab-two-runs";

    // Run A completes but its delivery is stranded (no agent yet).
    journal.openRun(PROMPT_A, { tabId: tab });
    arrive(tab, { kind: "executed", prompt_id: PROMPT_A, images: [{ filename: "a.png" }] });
    expect(journal.pending(tab)).toHaveLength(1);

    // Only AFTER that does the agent queue run B. The stranded completion must
    // not drift onto it when it is finally replayed.
    journal.openRun(PROMPT_B, { tabId: tab });

    manager.send(tab, "go");
    await waitFor(() => backend.turns.length >= 1);
    backend.finishTurn();
    await waitFor(() => journal.outstanding(tab).length === 0);

    const all = backend.turns.join("\n");
    expect(all).toContain("a.png");
    expect(all).toContain(PROMPT_A);
    expect(all).not.toContain(PROMPT_B);
    expect(journal.ticketFor(PROMPT_A)?.settled).toBe(true);
    expect(journal.ticketFor(PROMPT_B)?.settled).toBe(false); // B is still outstanding
  });
});

describe("run completion journal correlation (#468)", () => {
  let journal: RunCompletionJournalImpl;
  beforeEach(() => {
    journal = new RunCompletionJournalImpl();
  });

  it("correlates ONLY by exact prompt id — there is no most-recent-run fallback", () => {
    journal.openRun(PROMPT_A, { tabId: "t" });
    expect(journal.correlate({ prompt_id: PROMPT_A })).toEqual({
      status: "matched",
      promptId: PROMPT_A,
    });
    expect(journal.correlate({ prompt_id: PROMPT_B })).toEqual({
      status: "foreign",
      promptId: PROMPT_B,
    });
    expect(journal.correlate({})).toEqual({ status: "unidentified" });
    // A near-miss id is foreign, never "close enough".
    expect(journal.correlate({ prompt_id: `${PROMPT_A}x` }).status).toBe("foreign");
  });

  it("freezes the correlation at arrival — a run opened later can never claim it", () => {
    const entry = journal.record("t", { kind: "executed", prompt_id: PROMPT_A });
    expect(entry.correlation.status).toBe("foreign"); // A wasn't queued yet
    journal.openRun(PROMPT_A, { tabId: "t" }); // …now it is
    // The stored entry keeps its arrival verdict; only NEW arrivals see the run.
    expect(journal.pending("t")[0].correlation.status).toBe("foreign");
  });

  it("openRun without a prompt id is refused — nothing can be correlated to it", () => {
    expect(journal.openRun(null, { tabId: "t" })).toBe(false);
    expect(journal.openRun("", { tabId: "t" })).toBe(false);
    expect(journal.openRun(PROMPT_A, { tabId: "t" })).toBe(true);
  });

  it("collapses a re-sent completion for the same run onto one entry", () => {
    journal.openRun(PROMPT_A, { tabId: "t" });
    const first = journal.record("t", { kind: "executed", prompt_id: PROMPT_A });
    const again = journal.record("t", { kind: "executed", prompt_id: PROMPT_A });
    expect(again.token).toBe(first.token);
    expect(journal.outstanding("t")).toHaveLength(1);
  });

  it("only the entry's OWN run is settled on ack", () => {
    journal.openRun(PROMPT_A, { tabId: "t" });
    journal.openRun(PROMPT_B, { tabId: "t" });
    const entry = journal.record("t", { kind: "executed", prompt_id: PROMPT_A });
    journal.ack(entry.token);
    expect(journal.ticketFor(PROMPT_A)?.settled).toBe(true);
    expect(journal.ticketFor(PROMPT_B)?.settled).toBe(false);
  });

  it("an entry is only cleared by ack — a hand-off alone keeps it replayable", () => {
    journal.openRun(PROMPT_A, { tabId: "t" });
    journal.record("t", { kind: "executed", prompt_id: PROMPT_A });
    const dead = journal.deliverPending("t", () => false);
    expect(dead.delivered).toBe(0);
    expect(dead.blockedOn).not.toBeNull();
    expect(journal.pending("t")).toHaveLength(1); // refused → still pending

    const seen: CompletionPayload[] = [];
    journal.deliverPending("t", (p) => {
      seen.push(p);
      return true;
    });
    expect(seen[0].replayed).toBe(true); // second attempt is flagged a re-delivery
    expect(journal.pending("t")).toHaveLength(0); // handed off
    expect(journal.outstanding("t")).toHaveLength(1); // …but not acked, so kept

    journal.release(journal.outstanding("t")[0].token);
    expect(journal.pending("t")).toHaveLength(1); // handed back → replayable again
  });

  it("delivery stops at the first refusal so completions keep arrival order", () => {
    journal.openRun(PROMPT_A, { tabId: "t" });
    journal.openRun(PROMPT_B, { tabId: "t" });
    journal.record("t", { kind: "executed", prompt_id: PROMPT_A });
    journal.record("t", { kind: "executed", prompt_id: PROMPT_B });
    const seen: string[] = [];
    journal.deliverPending("t", (p) => {
      seen.push(String(p.prompt_id));
      return false;
    });
    expect(seen).toEqual([PROMPT_A]);
  });

  it("moveKey re-addresses a tab's entries without touching anyone else's", () => {
    journal.openRun(PROMPT_A, { tabId: "old" });
    journal.record("old", { kind: "executed", prompt_id: PROMPT_A });
    journal.record("other", { kind: "executed", prompt_id: PROMPT_B });
    journal.moveKey("old", "new");
    expect(journal.pending("old")).toHaveLength(0);
    expect(journal.pending("new")).toHaveLength(1);
    expect(journal.pending("other")).toHaveLength(1);
  });

  it("forget drops a gone tab's entries and leaves other tabs alone", () => {
    journal.record("gone", { kind: "executed", prompt_id: PROMPT_A });
    journal.record("kept", { kind: "executed", prompt_id: PROMPT_B });
    journal.forget("gone");
    expect(journal.outstanding("gone")).toHaveLength(0);
    expect(journal.outstanding("kept")).toHaveLength(1);
  });
});
