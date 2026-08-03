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
  describe as describeCorrelation,
  type CompletionPayload,
} from "../../orchestrator/run-completion-journal.js";
import { destinationHasCollisionState } from "../../orchestrator/session-store.js";

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
  readonly capabilities = CLAUDE_CAPABILITIES; // declares turnMarkers: true
  turns: string[] = [];
  /** Resolves the turn currently in flight. */
  private release: (() => void) | null = null;
  /** When true, a turn never produces a `result` (a stalled/abandoned turn). */
  strandTurns = false;

  async *run(opts: BackendStartOptions): AsyncGenerator<AgentEvent> {
    yield { type: "session", sessionId: "sess-468" };
    let turnSeq = 0;
    for await (const turn of opts.channel) {
      this.turns.push((turn as { text?: string }).text ?? "");
      turnSeq += 1;
      await new Promise<void>((resolve) => {
        this.release = resolve;
      });
      if (this.strandTurns) continue;
      // Stamped with its own turn marker, exactly as a real marker-declaring
      // backend does — that is what lets it ack the completion it carried.
      yield { type: "result", ok: true, subtype: "success", turn: turnSeq };
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
  readonly capabilities = CLAUDE_CAPABILITIES; // declares turnMarkers: true
  turns: string[] = [];
  private sink: ((ev: AgentEvent) => void) | null = null;
  private queued: AgentEvent[] = [];
  /** When true a turn emits NO stamped event at all (the zero-output turn whose
   *  traceless terminal is what breaks a learn-by-observation ack gate). */
  private readonly silentTurns: boolean;

  constructor(opts: { silentTurns?: boolean } = {}) {
    this.silentTurns = opts.silentTurns === true;
  }

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
        if (this.silentTurns) continue;
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
  journal.setRevoker(
    (key, token) => manager.revokeEvent(key, token),
    (key) => void flush(key),
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
    // Mirrors index.ts exactly, INCLUDING the `carried` flag — a harness that
    // drops it would silently exercise the unbounded path.
    onEventUndelivered: (key: string, tokens: string[], opts?: { carried?: boolean }) => {
      for (const t of tokens) journal.release(t, { carried: opts?.carried === true });
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
    // liveness. On a marker-declaring backend that result may belong to an
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
    // It is handed BACK, not acked — and immediately re-delivered into a new
    // turn, so the completion is neither lost nor fabricated as delivered.
    await waitFor(() => backend.turns.length >= 3);
    expect(backend.turns[2]).toContain("carried.png");
    expect(backend.turns[2]).toContain("RE-DELIVERED");
    expect(journal.outstanding(tab)).toHaveLength(1);
    expect(journal.ticketFor(PROMPT_A)?.settled).toBe(false);

    // Only the carrying turn's OWN marked result settles it.
    backend.emit({ type: "result", ok: true, subtype: "success", turn: 3 });
    await waitFor(() => journal.outstanding(tab).length === 0);
    expect(journal.ticketFor(PROMPT_A)?.settled).toBe(true);
  });

  it("a straggler arriving BEFORE the carrying turn stamps anything still cannot ack", async () => {
    // The unsound-inference case: a gate that LEARNS "this backend stamps" by
    // observation is still unlearned in exactly this window — a zero-output
    // turn's traceless terminal lands before the replacement turn emits any
    // stamped event. Capability is DECLARED, so the gate holds from the start.
    const backend = new MarkerBackend({ silentTurns: true });
    const { journal, manager, arrive } = makeHarness(backend);
    const tab = "tab-straggler-early";

    journal.openRun(PROMPT_A, { tabId: tab });
    manager.send(tab, "go"); // turn 1 emits NOTHING
    await waitFor(() => backend.turns.length >= 1);
    backend.emit({ type: "result", ok: true, subtype: "success", turn: 1 });

    arrive(tab, { kind: "executed", prompt_id: PROMPT_A, images: [{ filename: "early.png" }] });
    await waitFor(() => backend.turns.length >= 2); // turn 2 carries it, still silent

    // No marker has EVER been observed on this run at this point — a
    // learn-by-observation gate would ack here and destroy the replay.
    backend.emit({ type: "result", ok: false, subtype: "error_during_execution" });
    await waitFor(() => backend.turns.length >= 3); // handed back and re-delivered
    expect(backend.turns[2]).toContain("early.png");
    expect(journal.outstanding(tab)).toHaveLength(1);
    expect(journal.ticketFor(PROMPT_A)?.settled).toBe(false);
  });

  it("a completion parked in held mail survives retire() (provider switch)", async () => {
    // retire() PRESERVES held mail, which is why it used to strand the
    // completion riding in it: the journal entry stayed `handed_off` — a state
    // deliverPending() skips — with no agent left to consume it.
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
    const tab = "tab-retire-heldmail";

    journal.openRun(PROMPT_A, { tabId: tab });
    manager.send(tab, "go");
    arrive(tab, { kind: "executed", prompt_id: PROMPT_A, images: [{ filename: "retired.png" }] });
    await waitFor(() => journal.pending(tab).length === 0); // taken by the doomed agent
    await waitFor(() => manager.hasHeldMail(tab));

    manager.retire(tab); // provider switch retires the failed key
    expect(journal.pending(tab)).toHaveLength(1); // handed back, replayable
    expect(journal.outstanding(tab)).toHaveLength(1);
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

  it("retire() removes the completion from held mail, not just its token", async () => {
    // retire() PRESERVES held mail on purpose. Stripping only the token left the
    // event's TEXT in that mail: switching Claude→Codex handed the journal token
    // to Codex (delivered, correctly), and switching BACK to Claude re-delivered
    // the retained text as an ordinary user message — no token, no flag,
    // indistinguishable from a real second completion.
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
    // Fails the first TWO starts (parking, re-delivering, then re-parking the
    // queue in held mail), then works. Two consecutive failures matter: the
    // re-delivery goes through send(), which must preserve the completionOnly
    // marker or the second parking makes the completion's text un-removable.
    const healthy = new ContinuationBackend();
    let failuresLeft = 2;
    const flaky: AgentBackend = {
      id: "claude" as const,
      capabilities: CLAUDE_CAPABILITIES,
      async prepare() {
        if (failuresLeft > 0) {
          failuresLeft -= 1;
          throw new Error("endpoint rejected the key (http 401)");
        }
      },
      run: (o) => healthy.run(o),
      async interrupt() {},
      async listModels() {
        return [];
      },
    };
    const { journal, manager, arrive } = makeHarness(flaky);
    const tab = "tab-retire-textleak";

    journal.openRun(PROMPT_A, { tabId: tab });
    manager.send(tab, "keep me"); // an ordinary user message must SURVIVE
    arrive(tab, { kind: "executed", prompt_id: PROMPT_A, images: [{ filename: "leak.png" }] });
    await waitFor(() => journal.pending(tab).length === 0); // taken by the doomed agent
    await waitFor(() => manager.hasHeldMail(tab));

    // A second start also fails: the held mail is re-delivered through send()
    // and re-parked. The completionOnly marker must survive that round trip.
    manager.send(tab, "try again");
    await waitFor(() => manager.hasHeldMail(tab) && failuresLeft === 0);

    manager.retire(tab); // provider switch retires the failed key
    expect(journal.pending(tab)).toHaveLength(1); // its token came back

    // Next start succeeds: held mail replays, and the journal replays the
    // completion. The completion's text must appear exactly once.
    manager.send(tab, "hello again");
    await waitFor(() => healthy.turns.length >= 1);
    healthy.finishTurn();
    await new Promise((r) => setTimeout(r, 30));

    const all = healthy.turns.join("\n");
    expect(all).toContain("keep me"); // the user's message survived
    // …and the completion appears EXACTLY ONCE. Stripping only the token left a
    // second, token-less copy of this text behind in the preserved mail.
    expect(all.split("leak.png").length - 1).toBe(1);
  });

  it("a rewind hands its completion back as CARRIED (bounded, not an infinite replay)", async () => {
    // A turn abandoned by a rewind (and, by the same wiring, by the stall
    // watchdog) must return the completion it was carrying — but as a CARRIED
    // release, or an agent that keeps abandoning turns would be handed the same
    // completion on every turn forever.
    const backend = new MarkerBackend();
    const { journal, manager, arrive } = makeHarness(backend);
    const tab = "tab-rewind-carried";

    journal.openRun(PROMPT_A, { tabId: tab });
    manager.send(tab, "go");
    await waitFor(() => backend.turns.length >= 1);
    backend.emit({ type: "result", ok: true, subtype: "success", turn: 1 });

    arrive(tab, { kind: "executed", prompt_id: PROMPT_A, images: [{ filename: "rewound.png" }] });
    // MarkerBackend emits a stamped event per turn, so turn 2 is PROVEN received
    // before the rewind — which is what makes the release carried.
    await waitFor(() => backend.turns.length >= 2);
    await waitFor(() => journal.outstanding(tab).length === 1);

    manager.rewind(tab, null); // abandons the in-flight turn
    await waitFor(() => (journal.outstanding(tab)[0]?.carriedReleases ?? 0) >= 1);
    expect(journal.outstanding(tab)).toHaveLength(1); // returned, not lost
  });

  it("an unmarked straggler RESULT never counts as carried, so it can't settle an unseen completion", async () => {
    // #728 lets unmarked events past the dead-letter gate. On a marker-declaring
    // backend such a result may belong to an abandoned turn and arrive while the
    // replacement turn is still pre-submission — three of those must not walk the
    // settle bound and retire a completion nobody ever received.
    const silent = new MarkerBackend({ silentTurns: true });
    const { journal, manager, arrive } = makeHarness(silent);
    const tab = "tab-straggler-bound";

    journal.openRun(PROMPT_A, { tabId: tab });
    manager.send(tab, "go");
    await waitFor(() => silent.turns.length >= 1);
    silent.emit({ type: "result", ok: true, subtype: "success", turn: 1 });

    arrive(tab, { kind: "executed", prompt_id: PROMPT_A, images: [{ filename: "unseen.png" }] });
    await waitFor(() => silent.turns.length >= 2); // dispatched, no events for it

    for (let i = 0; i < 4; i++) {
      silent.emit({ type: "result", ok: false, subtype: "error_during_execution" }); // UNMARKED
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(journal.outstanding(tab)).toHaveLength(1); // never settled
    expect(journal.outstanding(tab)[0].carriedReleases ?? 0).toBe(0);
    expect(journal.ticketFor(PROMPT_A)?.settled).toBe(false);
  });

  it("a turn the backend never RECEIVED is released UNCARRIED — it can't count toward the bound", async () => {
    // The token is attached at dispatch, but Claude resolves output images before
    // submitting the turn. Aborting in that window means the model never saw the
    // completion, so it must not count toward the settle bound.
    const silent = new MarkerBackend({ silentTurns: true });
    const { journal, manager, arrive } = makeHarness(silent);
    const tab = "tab-unreceived";

    journal.openRun(PROMPT_A, { tabId: tab });
    manager.send(tab, "go");
    await waitFor(() => silent.turns.length >= 1);
    silent.emit({ type: "result", ok: true, subtype: "success", turn: 1 });

    arrive(tab, { kind: "executed", prompt_id: PROMPT_A, images: [{ filename: "unseen.png" }] });
    await waitFor(() => silent.turns.length >= 2); // dispatched, but NO events for it

    manager.rewind(tab, null);
    await new Promise((r) => setTimeout(r, 30));
    expect(journal.outstanding(tab)).toHaveLength(1); // returned…
    expect(journal.outstanding(tab)[0].carriedReleases ?? 0).toBe(0); // …unbounded
  });

  it("a completion survives an agent whose self-restart loop GAVE UP", async () => {
    // The give-up branch of settle() only unmapped the agent — its still-unread
    // queue died with it, leaving the journal entry `handed_off`, a state
    // deliverPending() skips. Silent, permanent loss.
    let starts = 0;
    const flappy: AgentBackend = {
      id: "claude" as const,
      capabilities: CLAUDE_CAPABILITIES,
      // A session that ends immediately, every time, without reading the channel.
      // eslint-disable-next-line require-yield
      async *run(): AsyncGenerator<AgentEvent> {
        starts += 1;
        return;
      },
      async interrupt() {},
      async listModels() {
        return [];
      },
    };
    const { journal, manager, arrive } = makeHarness(flappy);
    const tab = "tab-gaveup";

    journal.openRun(PROMPT_A, { tabId: tab });
    manager.send(tab, "go");
    arrive(tab, { kind: "executed", prompt_id: PROMPT_A, images: [{ filename: "gaveup.png" }] });
    await waitFor(() => journal.pending(tab).length === 0); // taken onto the doomed queue
    await waitFor(() => starts >= 4, 5000); // the bounded restart loop gives up

    // Held for the next start, with its token intact — not stranded handed_off.
    await waitFor(() => manager.hasHeldMail(tab), 5000);
    expect(journal.outstanding(tab)).toHaveLength(1);
    expect(journal.ticketFor(PROMPT_A)?.settled).toBe(false);
  });

  it("a queued completion whose id is then REUSED is pulled back and re-worded", async () => {
    // The wording is baked in when the event is queued. If the completion is
    // still sitting unread and its correlation then weakens (ComfyUI reused the
    // prompt id), the stale copy would otherwise reach the agent still claiming
    // "the run YOU queued" — letting it read run A's output as run B's result.
    const backend = new ContinuationBackend();
    const { journal, manager, arrive } = makeHarness(backend);
    const tab = "tab-reissue";

    journal.openRun(PROMPT_A, { tabId: tab });
    manager.send(tab, "go");
    await waitFor(() => backend.turns.length >= 1); // turn 1 is HELD open

    // A's completion lands while the agent is busy → queued, unread.
    arrive(tab, { kind: "executed", prompt_id: PROMPT_A, images: [{ filename: "runA.png" }] });
    expect(journal.outstanding(tab)[0].state).toBe("handed_off");

    // ComfyUI reuses the id for run B while A's copy is still unread: the stale
    // copy is pulled back off the queue and immediately re-queued, re-worded.
    journal.openRun(PROMPT_A, { tabId: tab });
    expect(journal.outstanding(tab)).toHaveLength(1); // one copy, not two

    backend.finishTurn();
    await waitFor(() => backend.turns.length >= 2);
    const text = backend.turns[1];
    expect(text).toContain("runA.png"); // still delivered — never swallowed
    expect(text).not.toContain("This is the run YOU queued");
    expect(text).toContain("UNDETERMINED");
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
    // Carried by the entry it rode out on, so only THAT one reports it…
    expect(seen[1]?.dropped_completions).toBeUndefined();
    // …and it is spent only when that entry's carrying turn ends (a hand-off is
    // not consumption — see the replay test below).
    expect(journal.droppedFor("t")).toBe(lost);
    journal.ack(journal.outstanding("t")[0].token);
    expect(journal.droppedFor("t")).toBe(0);
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

  it("a REUSED prompt id delivers every completion, as UNDETERMINED, suppressing none", () => {
    // Nothing on the wire distinguishes generation A's completion from B's — the
    // panel sends only the id. So once an id is queued twice it identifies no
    // single run: suppressing on the delivered proofs could swallow B's real
    // result, and claiming a match could present A's result as B's.
    journal.openRun(PROMPT_A, { tabId: "t" });
    const first = journal.record("t", { kind: "executed", prompt_id: PROMPT_A });
    expect(first!.correlation.status).toBe("matched"); // not reused yet
    journal.deliverPending("t", () => true);
    journal.ack(first!.token);
    expect(journal.record("t", { kind: "executed", prompt_id: PROMPT_A })).toBeNull(); // memo holds

    journal.openRun(PROMPT_A, { tabId: "t" }); // ComfyUI reused the id
    expect(journal.ticketFor(PROMPT_A)?.reused).toBe(true);

    // Both a late resend of A and B's real completion are now delivered, each
    // labelled UNDETERMINED. Neither is suppressed; neither claims to be "the
    // run YOU queued".
    const second = journal.record("t", { kind: "executed", prompt_id: PROMPT_A });
    expect(second).not.toBeNull();
    expect(second!.correlation.status).toBe("foreign");
    journal.deliverPending("t", () => true);
    journal.ack(second!.token);
    const third = journal.record("t", { kind: "executed", prompt_id: PROMPT_A });
    expect(third).not.toBeNull(); // NOT swallowed as a duplicate of the previous
    expect(third!.correlation.status).toBe("foreign");
  });

  it("a REUSED id never COALESCES — B's completion gets its own entry, so A's ack can't take it", () => {
    // Coalescing assumes the prompt id identifies one run; `reused` is exactly
    // the state where that is void. Merging B into A's entry would return A's
    // entry for B, leave A's text in the already-queued turn, and let A's ack
    // remove the sole entry — B never delivered. Duplicate over loss.
    journal.openRun(PROMPT_A, { tabId: "t" });
    journal.openRun(PROMPT_A, { tabId: "t" }); // ComfyUI reused the id
    expect(journal.ticketFor(PROMPT_A)?.reused).toBe(true);

    const late = journal.record("t", { kind: "executed", prompt_id: PROMPT_A, note: "run A (late)" });
    journal.deliverPending("t", () => true); // A handed off, unread

    const real = journal.record("t", { kind: "executed", prompt_id: PROMPT_A, note: "run B (real)" });
    expect(real).not.toBeNull();
    expect(real!.token).not.toBe(late!.token); // its OWN entry, never merged
    expect(real!.payload.note).toBe("run B (real)");

    // A's turn ends: it takes only its own entry with it.
    journal.ack(late!.token);
    expect(journal.pending("t")).toHaveLength(1);
    expect(journal.pending("t")[0].payload.note).toBe("run B (real)");
  });

  it("re-queuing a prompt id SUPERSEDES the old entry — the old result can't answer for the new run", () => {
    // Prompt-id reuse while the previous completion is still in an agent's queue.
    // Merging into that entry would hand the OLD result over as the NEW run's
    // (its queued turn still holds the old text) and the new completion would
    // never be delivered at all.
    journal.openRun(PROMPT_A, { tabId: "t" });
    const old = journal.record("t", { kind: "executed", prompt_id: PROMPT_A, note: "run A" });
    journal.deliverPending("t", () => true); // handed off, unread, unacked

    journal.openRun(PROMPT_A, { tabId: "t" }); // ComfyUI reused the id
    const fresh = journal.record("t", { kind: "executed", prompt_id: PROMPT_A, note: "run B" });
    expect(fresh).not.toBeNull();
    expect(fresh!.token).not.toBe(old!.token); // its OWN entry, not a merge
    expect(journal.pending("t")).toHaveLength(1);

    // …and it is DOWNGRADED: it may still be delivered (it is a real result) but
    // never as "the run YOU queued", which would present run A's output as the
    // awaited outcome of run B.
    expect(old!.correlation.status).toBe("foreign");

    // The old entry's turn ends: it must NOT settle the reopened ticket, and must
    // NOT memoize the id as delivered (which would suppress run B's completion).
    journal.ack(old!.token);
    expect(journal.ticketFor(PROMPT_A)?.settled).toBe(false);
    expect(journal.pending("t")).toHaveLength(1); // run B still awaits delivery

    // Run B's own completion is delivered too — as UNDETERMINED, because a
    // reused id can no longer be attributed to one run.
    journal.deliverPending("t", () => true);
    journal.ack(fresh!.token);
    expect(journal.outstanding("t")).toHaveLength(0);
  });

  it("an eviction disclosure rides a surviving entry, so it can't be discarded before it's told", () => {
    // The side map is bounded; a count parked there for a tab that still HAS a
    // deliverable entry could be discarded before it was ever reported. The
    // count now rides that entry instead.
    journal.record("t", { kind: "executed", prompt_id: "keeper" });
    for (let i = 0; i < 40; i++) journal.record("t", { kind: "executed", prompt_id: `e-${i}` });
    const lost = journal.droppedFor("t");
    expect(lost).toBeGreaterThan(0);
    // The count must live ON a surviving entry, not in the boundable side map —
    // that is what makes it undiscardable while the tab can still be told.
    const carrier = journal.outstanding("t").find((e) => (e.disclose ?? 0) > 0);
    expect(carrier).toBeDefined();
    expect(carrier!.disclose).toBe(lost);
    // Churn far past the side map's bound with agentless tabs; ours is untouched.
    for (let i = 0; i < 200; i++) {
      journal.record(`ghost-${i}`, { kind: "executed", prompt_id: `g-${i}` });
      journal.forget(`ghost-${i}`);
    }
    expect(journal.droppedFor("t")).toBe(lost); // still intact
    const seen: CompletionPayload[] = [];
    journal.deliverPending("t", (p) => {
      seen.push(p);
      return true;
    });
    expect(seen[0].dropped_completions).toBe(lost);
  });

  it("an eviction disclosure never lands on a HANDED-OFF entry that can't report it", () => {
    // deliverPending only reads PENDING entries. Stamping the count on a
    // handed-off one attaches the warning to text already queued (nobody will
    // build that payload again) and ack() then spends it: neither replayed nor
    // disclosed. With no pending entry it must go to the side map, where the
    // next pending delivery picks it up.
    for (let i = 0; i < 32; i++) journal.record("t", { kind: "executed", prompt_id: `h-${i}` });
    journal.deliverPending("t", () => true); // all handed off, none acked
    expect(journal.pending("t")).toHaveLength(0);

    journal.record("t", { kind: "executed", prompt_id: "overflow" }); // evicts one
    const lost = journal.droppedFor("t");
    expect(lost).toBeGreaterThan(0);
    // No pending entry carries it…
    expect(journal.outstanding("t").filter((e) => e.state === "handed_off" && e.disclose)).toHaveLength(0);
    // …and the next PENDING delivery reports it.
    const seen: CompletionPayload[] = [];
    journal.deliverPending("t", (p) => {
      seen.push(p);
      return true;
    });
    expect(seen[0].dropped_completions).toBe(lost);
  });

  it("a very late resend is still suppressed after the bounded memo has aged out", () => {
    // The delivered memo is FIFO-capped, so a busy tab ages it out. The run
    // TICKET's `settled` flag is the second, longer-lived record of "we already
    // reported this run" — either one must suppress a resend.
    journal.openRun(PROMPT_A, { tabId: "t" });
    const entry = journal.record("t", { kind: "executed", prompt_id: PROMPT_A });
    journal.deliverPending("t", () => true);
    journal.ack(entry!.token);
    expect(journal.ticketFor(PROMPT_A)?.settled).toBe(true);

    // Flood with REAL runs (openRun + completion + ack), so the ticket map
    // overflows too — the settled ticket is evicted preferentially, which is
    // exactly the window where the proof used to disappear.
    for (let i = 0; i < 200; i++) {
      journal.openRun(`flood-${i}`, { tabId: "t" });
      const e = journal.record("t", { kind: "executed", prompt_id: `flood-${i}` });
      journal.deliverPending("t", () => true);
      journal.ack(e!.token);
    }
    // Its ticket is long gone (tickets are the smaller bound, and settled ones
    // are evicted first) — the memo is what must outlive it.
    expect(journal.ticketFor(PROMPT_A)).toBeUndefined();
    expect(journal.record("t", { kind: "executed", prompt_id: PROMPT_A })).toBeNull();
  });

  it("an eviction disclosure survives a hand-off that is never consumed", () => {
    // A hand-off is not consumption. If the agent holding the warning is stopped
    // before its turn runs, the replay must carry the warning again — clearing it
    // at hand-off left the eviction permanently undisclosed.
    journal.record("t", { kind: "executed", prompt_id: "keeper" });
    for (let i = 0; i < 40; i++) journal.record("t", { kind: "executed", prompt_id: `e-${i}` });
    const lost = journal.droppedFor("t");
    expect(lost).toBeGreaterThan(0);

    const first: CompletionPayload[] = [];
    journal.deliverPending("t", (p) => {
      first.push(p);
      return true;
    });
    expect(first[0].dropped_completions).toBe(lost);

    // The agent died before reading it → released → replayed.
    for (const e of journal.outstanding("t")) journal.release(e.token);
    const again: CompletionPayload[] = [];
    journal.deliverPending("t", (p) => {
      again.push(p);
      return true;
    });
    expect(again[0].dropped_completions).toBe(lost); // still disclosed

    // Only the carrying turn ENDING spends it.
    const carrier = journal.outstanding("t")[0];
    journal.ack(carrier.token);
    expect(journal.droppedFor("t")).toBe(0);
  });

  it("a prompt id reused AFTER its ticket was evicted still delivers the new run's completion", () => {
    // The memo outlives the ticket by design, so a reuse can take the
    // FRESH-ticket path with a stale memo still standing. `panel_run` promises
    // automatic delivery for that new run — the memo must not swallow it.
    journal.openRun(PROMPT_A, { tabId: "t" });
    const first = journal.record("t", { kind: "executed", prompt_id: PROMPT_A });
    journal.deliverPending("t", () => true);
    journal.ack(first!.token);
    for (let i = 0; i < 200; i++) {
      journal.openRun(`flood-${i}`, { tabId: "t" });
      const e = journal.record("t", { kind: "executed", prompt_id: `flood-${i}` });
      journal.deliverPending("t", () => true);
      journal.ack(e!.token);
    }
    expect(journal.ticketFor(PROMPT_A)).toBeUndefined(); // evicted, so this is a FRESH ticket
    expect(journal.record("t", { kind: "executed", prompt_id: PROMPT_A })).toBeNull(); // resend: suppressed

    journal.openRun(PROMPT_A, { tabId: "t" }); // ComfyUI reused the id for a NEW run
    const second = journal.record("t", { kind: "executed", prompt_id: PROMPT_A });
    expect(second).not.toBeNull();
    expect(second!.correlation.status).toBe("matched");
  });

  it("a stall/rewind abandon is CARRIED, so a freezing backend can't replay forever", () => {
    // Both auto-repeat, so an unbounded release there is an infinite replay
    // source. Three dispatched-and-abandoned turns settle it instead.
    journal.openRun(PROMPT_A, { tabId: "t" });
    const entry = journal.record("t", { kind: "executed", prompt_id: PROMPT_A });
    for (let i = 0; i < 3; i++) {
      journal.deliverPending("t", () => true);
      journal.release(entry!.token, { carried: true });
    }
    expect(journal.outstanding("t")).toHaveLength(0);
  });

  it("hasOutstanding reports any undelivered completion (the self-restart gate)", () => {
    expect(journal.hasOutstanding()).toBe(false);
    const entry = journal.record("t", { kind: "executed", prompt_id: PROMPT_A });
    expect(journal.hasOutstanding()).toBe(true);
    journal.deliverPending("t", () => true);
    expect(journal.hasOutstanding()).toBe(true); // handed off is NOT delivered
    journal.ack(entry!.token);
    expect(journal.hasOutstanding()).toBe(false);
  });

  it("allOutstanding names every undelivered completion, per tab, for the exit disclosure", () => {
    // A FATAL self-exit bypasses the idle gate by design and the journal is
    // in-memory, so these die with the process. They must be reported on the way
    // out (per tab, naming the run) rather than silently evaporating.
    journal.openRun(PROMPT_A, { tabId: "wf:one" });
    journal.record("wf:one", { kind: "executed", prompt_id: PROMPT_A });
    journal.record("wf:two", { kind: "executed", prompt_id: PROMPT_B });
    const handed = journal.record("wf:two", { kind: "executed" });
    journal.deliverPending("wf:two", () => true); // handed off still counts

    const all = journal.allOutstanding();
    expect(all).toHaveLength(3);
    expect(all.filter((e) => e.key === "wf:one")).toHaveLength(1);
    expect(all.filter((e) => e.key === "wf:two")).toHaveLength(2);
    expect(describeCorrelation(all[0].correlation)).toContain(PROMPT_A);

    journal.ack(handed!.token);
    expect(journal.allOutstanding()).toHaveLength(2); // acked ones are gone
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

  it("a tab holding ONLY a journal entry counts as OCCUPIED for a tab-id migration", () => {
    // CRITICAL: the destination of a same-workflow tab-id migration can have had
    // its agent AND durable session cleared (New chat) and still hold an
    // undelivered completion. If the occupancy check ignores the journal, the
    // destination reads as empty, the source is rebound onto its id, and the
    // next flush hands the DESTINATION tab's render to the SOURCE tab's
    // conversation — a cross-conversation delivery, worse than a lost one.
    expect(
      destinationHasCollisionState({
        hasManagerState: false,
        hasDurableSession: false,
        renderHeldCount: 0,
        journaledCompletionCount: 1,
      }),
    ).toBe(true);
    expect(
      destinationHasCollisionState({
        hasManagerState: false,
        hasDurableSession: false,
        renderHeldCount: 0,
        journaledCompletionCount: 0,
      }),
    ).toBe(false);
    // …and the purge that follows leaves nothing for the incoming agent to
    // inherit, for BOTH pending and already-handed-off entries.
    journal.record("wf:dest", { kind: "executed", prompt_id: PROMPT_B });
    journal.deliverPending("wf:dest", () => true);
    journal.record("wf:dest", { kind: "executed", prompt_id: PROMPT_A });
    expect(journal.outstanding("wf:dest")).toHaveLength(2);
    journal.forget("wf:dest");
    expect(journal.outstanding("wf:dest")).toHaveLength(0);
    journal.moveKey("wf:src", "wf:dest"); // then the source migrates in
    expect(journal.outstanding("wf:dest")).toHaveLength(0);
  });

  it("an identical ID-LESS completion re-sent while still journaled collapses onto one entry", () => {
    // With no prompt id there is no run identity, so content is the only
    // evidence of sameness. While BOTH copies are undelivered, collapsing them
    // cannot lose news the agent already has — so a re-sent frame must not
    // produce two turns.
    const payload = { kind: "executed", images: [{ filename: "mystery_0001.png" }] };
    const first = journal.record("t", { ...payload });
    expect(first).not.toBeNull();
    expect(journal.record("t", { ...payload })).toBe(first);
    expect(journal.pending("t")).toHaveLength(1);

    // A DIFFERENT id-less render is still its own entry.
    expect(
      journal.record("t", { kind: "executed", images: [{ filename: "other_0002.png" }] }),
    ).not.toBeNull();
    expect(journal.pending("t")).toHaveLength(2);
  });

  it("an ID-LESS twin is NEVER merged into an entry that is already handed off", () => {
    // The collapse is only safe while BOTH copies are undelivered. A
    // `handed_off` entry is sitting unread in a busy agent's queue and will be
    // acked when its turn ends — merging a second real render into it would
    // delete the second render outright, with no flag. That is a silent swallow,
    // the exact hazard the design splits to avoid.
    const payload = { kind: "executed", images: [{ filename: "ComfyUI_temp_00001_.png" }] };
    const first = journal.record("t", { ...payload });
    journal.deliverPending("t", () => true); // handed off, still unread + unacked
    expect(journal.pending("t")).toHaveLength(0);

    const second = journal.record("t", { ...payload });
    expect(second).not.toBeNull();
    expect(second!.token).not.toBe(first!.token); // its OWN entry
    expect(second!.possibleRepeat).toBe(true); // …and flagged
    expect(journal.pending("t")).toHaveLength(1);

    // Acking the first must not take the second with it.
    journal.ack(first!.token);
    expect(journal.outstanding("t")).toHaveLength(1);
  });

  it("an ID-LESS completion matching an ALREADY-DELIVERED one is FLAGGED, never swallowed", () => {
    // Identical content is not proof of identity — ComfyUI reuses temp output
    // names across a restart — so suppressing here could silently lose a second
    // real render. Deliver it, flagged, and let the agent decide.
    const payload = { kind: "executed", images: [{ filename: "ComfyUI_temp_00001_.png" }] };
    const first = journal.record("t", { ...payload });
    journal.deliverPending("t", () => true);
    journal.ack(first!.token);

    const again = journal.record("t", { ...payload });
    expect(again).not.toBeNull(); // NOT swallowed
    expect(again!.possibleRepeat).toBe(true);
    const seen: CompletionPayload[] = [];
    journal.deliverPending("t", (p) => {
      seen.push(p);
      return true;
    });
    expect(seen[0].possible_repeat).toBe(true);
    expect(seen[0].run_correlation).toBe("unidentified");
  });

  it("the id-less content memo moves with a tab-id migration", () => {
    const payload = { kind: "executed", images: [{ filename: "idless.png" }] };
    const entry = journal.record("tmp:draft", { ...payload });
    journal.deliverPending("tmp:draft", () => true);
    journal.ack(entry!.token);
    journal.moveKey("tmp:draft", "wf:saved.json");
    const again = journal.record("wf:saved.json", { ...payload });
    expect(again!.possibleRepeat).toBe(true); // the memo followed the tab
  });

  it("teardown hand-backs are UNBOUNDED — only turns that ran count toward the settle bound", () => {
    // A completion queued behind a busy turn can survive several ordinary
    // provider/session replacements before anything drains that queue. Those
    // hand-backs must never settle it: nobody read it.
    journal.openRun(PROMPT_A, { tabId: "t" });
    const entry = journal.record("t", { kind: "executed", prompt_id: PROMPT_A });
    for (let i = 0; i < 10; i++) {
      journal.deliverPending("t", () => true);
      journal.release(entry!.token); // teardown: uncarried
    }
    expect(journal.outstanding("t")).toHaveLength(1);
    expect(journal.ticketFor(PROMPT_A)?.settled).toBe(false);

    // A turn that RAN and ended without a provable ack is the cycle that IS
    // bounded — three of those settle it rather than replay forever.
    for (let i = 0; i < 3; i++) {
      journal.deliverPending("t", () => true);
      journal.release(entry!.token, { carried: true });
    }
    expect(journal.outstanding("t")).toHaveLength(0);
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
