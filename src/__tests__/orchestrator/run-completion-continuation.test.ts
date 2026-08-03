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

/**
 * A MARKER-STAMPING backend (like Claude): every turn's events carry the turn's
 * marker, and the test drives the event stream by hand so a straggler from an
 * abandoned turn can be injected at will.
 */
class MarkerBackend implements AgentBackend {
  readonly id = "claude" as const;
  readonly capabilities = CLAUDE_CAPABILITIES;
  turns: string[] = [];
  private sink: ((ev: AgentEvent) => void) | null = null;
  private queued: AgentEvent[] = [];

  async *run(opts: BackendStartOptions): AsyncGenerator<AgentEvent> {
    let wake: (() => void) | null = null;
    this.sink = (ev) => {
      this.queued.push(ev);
      const w = wake;
      wake = null;
      w?.();
    };
    void (async () => {
      for await (const turn of opts.channel) {
        this.turns.push((turn as { text?: string }).text ?? "");
        // Mark the turn as producing SOME stamped output, so the agent learns
        // this backend stamps markers (exactly what Claude does).
        this.sink?.({ type: "assistant", text: "", turn: this.turns.length } as AgentEvent);
      }
    })();
    for (;;) {
      while (this.queued.length) yield this.queued.shift()!;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  }

  emit(ev: AgentEvent): void {
    this.sink?.(ev);
  }
  async interrupt(): Promise<void> {}
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

  it("a traceless straggler result does NOT ack the current turn's completion", async () => {
    // #728 lets an UNMARKED result through the dead-letter guard for gate
    // liveness. On a marker-stamping backend that result may belong to an
    // abandoned earlier turn, so it must not retire a completion the CURRENT
    // turn is carrying — otherwise a turn that then stalls has nothing to
    // hand back and the completion is gone.
    const backend = new MarkerBackend();
    const { journal, manager, arrive } = makeHarness(backend);
    const tab = "tab-straggler";

    journal.openRun(PROMPT_A, { tabId: tab });
    manager.send(tab, "go");
    await waitFor(() => backend.turns.length >= 1);
    backend.emit({ type: "result", ok: true, subtype: "success", turn: 1 });

    arrive(tab, { kind: "executed", prompt_id: PROMPT_A, images: [{ filename: "carried.png" }] });
    await waitFor(() => backend.turns.length >= 2); // turn 2 carries the completion

    // An unmarked straggler from the abandoned turn 1 arrives.
    backend.emit({ type: "result", ok: false, subtype: "error_during_execution" });
    await new Promise((r) => setTimeout(r, 20));
    expect(journal.outstanding(tab)).toHaveLength(1); // NOT acked

    // Turn 2's own (marked) result is what acks it.
    backend.emit({ type: "result", ok: true, subtype: "success", turn: 2 });
    await waitFor(() => journal.outstanding(tab).length === 0);
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

  it("a completion parked in HELD mail survives a reset that discards that mail", async () => {
    // A failed start parks the agent's whole queue — including an injected
    // completion — in heldMessages. `reset()` (New chat / resume_session) throws
    // that mail away; the completion must come BACK to the journal, not be left
    // stranded in a hand-off state nothing ever flushes again.
    const doomed: AgentBackend = {
      id: "claude" as const,
      capabilities: CLAUDE_CAPABILITIES,
      async prepare() {
        throw new Error("endpoint rejected the key (http 401)");
      },
      // eslint-disable-next-line require-yield
      async *run(): AsyncGenerator<AgentEvent> {
        throw new Error("never runs");
      },
      async interrupt() {},
      async listModels() {
        return [];
      },
    };
    const { journal, manager, arrive } = makeHarness(doomed);
    const tab = "tab-heldmail";

    journal.openRun(PROMPT_A, { tabId: tab });
    manager.send(tab, "go"); // spawns an agent whose prepare() rejects
    arrive(tab, { kind: "executed", prompt_id: PROMPT_A, images: [{ filename: "held.png" }] });
    // Taken onto the doomed agent's queue…
    await waitFor(() => journal.pending(tab).length === 0);
    // …then parked in held mail when the start failed.
    await waitFor(() => manager.hasHeldMail(tab));

    manager.reset(tab); // New chat — held mail is discarded
    expect(journal.pending(tab)).toHaveLength(1); // handed back, replayable
    expect(journal.outstanding(tab)).toHaveLength(1);
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
    expect(journal.correlate("t", { prompt_id: PROMPT_A })).toEqual({
      status: "matched",
      promptId: PROMPT_A,
    });
    expect(journal.correlate("t", { prompt_id: PROMPT_B })).toEqual({
      status: "foreign",
      promptId: PROMPT_B,
    });
    expect(journal.correlate("t", {})).toEqual({ status: "unidentified" });
    // A near-miss id is foreign, never "close enough".
    expect(journal.correlate("t", { prompt_id: `${PROMPT_A}x` }).status).toBe("foreign");
  });

  it("a run queued on ANOTHER tab never matches — cross-tab is foreign, not matched", () => {
    journal.openRun(PROMPT_A, { tabId: "wf:one" });
    expect(journal.correlate("wf:one", { prompt_id: PROMPT_A }).status).toBe("matched");
    // The same run finishing after the browser tab switched to a different
    // workflow must NOT be presented to the new workflow's agent as its own.
    expect(journal.correlate("wf:two", { prompt_id: PROMPT_A }).status).toBe("foreign");
  });

  it("forget drops the tab's RUN TICKETS too, so a late completion reads as undetermined", () => {
    journal.openRun(PROMPT_A, { tabId: "wf:one" });
    journal.forget("wf:one");
    expect(journal.ticketFor(PROMPT_A)).toBeUndefined();
    expect(journal.correlate("wf:one", { prompt_id: PROMPT_A }).status).toBe("foreign");
  });

  it("moveKey carries the run tickets, so a migrated tab's own run still matches", () => {
    journal.openRun(PROMPT_A, { tabId: "tmp:draft" });
    journal.moveKey("tmp:draft", "wf:saved.json");
    expect(journal.correlate("wf:saved.json", { prompt_id: PROMPT_A }).status).toBe("matched");
    expect(journal.correlate("tmp:draft", { prompt_id: PROMPT_A }).status).toBe("foreign");
  });

  it("closeRuns keeps the arrived completions but DOWNGRADES them to undetermined", () => {
    // New chat / switch to a historical session: the conversation that queued the
    // run is gone, so a render it queued must not be introduced to the
    // replacement agent as "the run YOU queued" — neither a future completion
    // nor one already sitting undelivered in the journal.
    journal.openRun(PROMPT_A, { tabId: "t" });
    const arrived = journal.record("t", { kind: "executed", prompt_id: PROMPT_A });
    expect(arrived?.correlation.status).toBe("matched");
    journal.closeRuns("t");
    expect(journal.ticketFor(PROMPT_A)).toBeUndefined();
    expect(journal.correlate("t", { prompt_id: PROMPT_A }).status).toBe("foreign");
    // Still deliverable — never swallowed — but no longer claimed as ours. A
    // correlation may only ever weaken, never strengthen.
    expect(journal.pending("t")).toHaveLength(1);
    expect(journal.pending("t")[0].correlation.status).toBe("foreign");
  });

  it("a completion re-sent AFTER its delivery was acked is suppressed, not delivered twice", () => {
    journal.openRun(PROMPT_A, { tabId: "t" });
    const entry = journal.record("t", { kind: "executed", prompt_id: PROMPT_A });
    journal.deliverPending("t", () => true);
    journal.ack(entry!.token); // the carrying turn ended — entry is gone
    expect(journal.record("t", { kind: "executed", prompt_id: PROMPT_A })).toBeNull();
    expect(journal.pending("t")).toHaveLength(0);
  });

  it("evicting a HANDED-OFF completion is counted too — a hand-off is not proof of consumption", () => {
    for (let i = 0; i < 32; i++) journal.record("t", { kind: "executed", prompt_id: `h-${i}` });
    journal.deliverPending("t", () => true); // all handed off, none acked
    expect(journal.droppedFor("t")).toBe(0);
    // One more arrival pushes the oldest handed-off entry out. If its agent dies
    // before reading it, `release` would have nothing to re-arm — so it counts.
    journal.record("t", { kind: "executed", prompt_id: "h-overflow" });
    expect(journal.droppedFor("t")).toBe(1);
  });

  it("a re-sent completion does NOT re-arm a hand-off (no duplicate delivery)", () => {
    journal.openRun(PROMPT_A, { tabId: "t" });
    journal.record("t", { kind: "executed", prompt_id: PROMPT_A });
    journal.deliverPending("t", () => true); // handed off, not yet acked
    expect(journal.pending("t")).toHaveLength(0);
    // The panel re-sends the same completion — it must not queue a second copy.
    journal.record("t", { kind: "executed", prompt_id: PROMPT_A, note: "resend" });
    expect(journal.pending("t")).toHaveLength(0);
    expect(journal.outstanding("t")).toHaveLength(1);
  });

  it("evicting a still-pending completion is COUNTED and reported on the next delivery", () => {
    // Fill past the per-tab ceiling with completions nothing can deliver.
    for (let i = 0; i < 40; i++) {
      journal.record("t", { kind: "executed", prompt_id: `p-${i}` });
    }
    const lost = journal.droppedFor("t");
    expect(lost).toBeGreaterThan(0);
    const seen: CompletionPayload[] = [];
    journal.deliverPending("t", (p) => {
      seen.push(p);
      return true;
    });
    expect(seen[0].dropped_completions).toBe(lost);
    // Reported once, then cleared — later deliveries don't re-report it.
    expect(journal.droppedFor("t")).toBe(0);
    expect(seen[1]?.dropped_completions).toBeUndefined();
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

  it("moveKey carries the delivered memo and the eviction counter, not just the entries", () => {
    // A tmp: → wf: save/rename migration must move ALL per-tab state, or a
    // post-migration re-send is delivered twice and an eviction disclosure is
    // silently dropped.
    journal.openRun(PROMPT_A, { tabId: "tmp:draft" });
    const entry = journal.record("tmp:draft", { kind: "executed", prompt_id: PROMPT_A });
    journal.deliverPending("tmp:draft", () => true);
    journal.ack(entry!.token);
    for (let i = 0; i < 40; i++) journal.record("tmp:draft", { kind: "executed", prompt_id: `d-${i}` });
    const lost = journal.droppedFor("tmp:draft");
    expect(lost).toBeGreaterThan(0);

    journal.moveKey("tmp:draft", "wf:saved.json");
    expect(journal.droppedFor("wf:saved.json")).toBe(lost);
    expect(journal.droppedFor("tmp:draft")).toBe(0);
    // The re-send is still suppressed under the NEW id.
    expect(journal.record("wf:saved.json", { kind: "executed", prompt_id: PROMPT_A })).toBeNull();
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
