// #728 — the stall watchdog's interrupt path must report the failure ONCE and
// hold the turn gate until the turn GENUINELY ends.
//
// OLD BUG: onTurnStalled() surfaced "⚠️ The agent stopped responding…", then
// released the turn gate SYNCHRONOUSLY (completeTurn()) and called
// backend.interrupt() directly. Two failures followed:
//   1. When the backend emitted the expected terminal
//      `{ ok: false, subtype: "interrupted" }` result, the result handler didn't
//      know it was watchdog-initiated, so the never-end-in-silence guard painted
//      a SECOND, contradictory failure: "⚠️ That turn failed (interrupted)…".
//   2. The synchronous completeTurn() made the next queued batch eligible BEFORE
//      the interrupted turn had settled.
//
// FIX: the watchdog marks the failure surfaced (errorSurfaced) and routes
// through the guarded interrupt() flow — the aborted turn's terminal result (or
// the bounded interrupt-release fallback if none arrives) opens the gate at the
// genuine turn end. ONE report per turn, both directions: a stall after an
// `error` event already painted the failure line suppresses the stall warning,
// and a late `error` event after the stall warning suppresses the error line.
// And when the fallback abandons a turn (force-release with no result), the dead
// turn's stragglers are dead-lettered by BACKEND-MINTED TURN MARKER (r3): every
// event is stamped with the monotonic marker of the turn it belongs to, so an
// event stamped OLDER than the in-flight turn (or ≤ the abandoned turn's marker)
// is logged but never painted and never gate-affecting — regardless of
// interleaving with the new turn's own events. Backends that never stamp
// (legacy) get NO dead-lettering — previous behavior.
//
// TURN_IDLE_MS / INTERRUPT_RELEASE_FALLBACK_MS are read from the env at
// panel-agent module load, so set SHORT windows BEFORE importing the module.

process.env.COMFYUI_MCP_TURN_IDLE_MS = "100";
process.env.COMFYUI_MCP_INTERRUPT_RELEASE_MS = "500";

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

/** How long after the observed trip we wait before asserting the gate is still
 *  held. The OLD code released the gate synchronously INSIDE onTurnStalled, so
 *  the queued turn drained within a few ms of the trip — 150ms is ~30x margin.
 *  Still comfortably before the 500ms interrupt-release fallback (armed at the
 *  trip), so a held gate here proves the RESULT — not the fallback — opens it. */
const GATE_HELD_MS = 150;

/** A backend whose turn emits NOTHING (the true zero-event freeze the watchdog
 *  exists to catch) until the test releases that turn's terminal result, which
 *  is always the interrupt landing: `{ ok: false, subtype: "interrupted" }`.
 *
 *  The input pump is DECOUPLED (it starts reading the NEXT turn while the
 *  current one is held, mirroring the Claude SDK's independent input pump), so
 *  a turn-gate release is observable as a new turn being READ — independent of
 *  the withheld result. No events are ever emitted spontaneously, so the
 *  watchdog trips on schedule.
 *
 *  TURN MARKERS (#728 r3): like the real backends, it mints a monotonic marker
 *  per turn READ (1, 2, …) and stamps it on that turn's terminal event — even
 *  when the event is emitted LATE, after a newer turn was read (true attribution
 *  is the contract). Terminal emission is decoupled from the pump loop (the gate
 *  promise is registered at READ time and emits itself), so a later turn's
 *  terminal can land while an earlier turn's is still withheld. Test-driven
 *  emissions (emitError/emitEvent) carry an explicit marker so a straggler can
 *  be attributed to a DEAD turn on purpose. `legacy = true` suppresses all
 *  markers, modeling a third-party backend that never stamps (PanelAgent must
 *  then do NO dead-lettering — previous behavior). */
class HeldResultBackend implements AgentBackend {
  readonly id = "claude" as const;
  readonly capabilities = CLAUDE_CAPABILITIES;
  turns: string[] = [];
  interrupted = 0;
  /** The wedge: an interrupt does NOT end the held turn or emit its result —
   *  the test alone decides when (if ever) the interrupted result lands. Set to
   *  true right before agent.stop() so teardown's interrupt unwinds the pump. */
  releaseOnInterrupt = false;
  /** Legacy mode: emit every event WITHOUT a turn marker (third-party backend). */
  legacy = false;
  /** Turns with marker ≥ this emit LIVENESS (onActivity pings) while held — a
   *  healthy working backend, so the (correctly re-armed) watchdog stays quiet
   *  for them during long observation windows. Default ∞: nothing pings. */
  livenessFromTurn = Number.POSITIVE_INFINITY;
  private startedCount = 0;
  private startedWaiters: Array<{ n: number; resolve: () => void }> = [];

  private markStarted(): void {
    this.startedCount += 1;
    this.startedWaiters = this.startedWaiters.filter((w) => {
      if (this.startedCount >= w.n) {
        w.resolve();
        return false;
      }
      return true;
    });
  }

  /** Resolve once the pump has READ at least `n` turns. Rejects after
   *  `timeoutMs` so a gate that never drains fails fast instead of hanging. */
  waitStarted(n: number, timeoutMs = 3000): Promise<void> {
    if (this.startedCount >= n) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`turn ${n} never started (gate did not drain)`)),
        timeoutMs,
      );
      this.startedWaiters.push({
        n,
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
      });
    });
  }

  /** Release the held turn whose marker is `n` (1 = the first turn read),
   *  emitting `ev` as its terminal event (default: the interrupt landing),
   *  stamped with turn n so even a LATE straggler is attributed to its own turn. */
  releaseTurn(n: number, ev: AgentEvent = { type: "result", ok: false, subtype: "interrupted" }): void {
    this.held.get(n)?.(ev);
  }

  /** Emit an `error` event (test-controlled) — the way codex/gemini/grok report
   *  a turn failure BEFORE their terminal result. The error leaves the turn
   *  ACTIVE (no result), so the watchdog can still trip. `turn` is the marker it
   *  belongs to (the DEAD turn's marker manufactures a straggler). */
  emitError(message: string, turn?: number): void {
    this.emitFn?.({
      type: "error",
      message,
      ...(turn !== undefined && !this.legacy ? { turn } : {}),
    });
  }

  /** Emit any event verbatim (test-controlled, marker included as given). */
  emitEvent(ev: AgentEvent): void {
    this.emitFn?.(ev);
  }

  private emitFn: ((ev: AgentEvent) => void) | null = null;
  /** Held terminal gates by marker — resolved by `releaseTurn()` with the
   *  terminal event to emit. Registered AT READ TIME so a later turn can be
   *  released while an earlier one is still withheld. */
  private held = new Map<number, (ev: AgentEvent) => void>();

  async *run(opts: BackendStartOptions): AsyncGenerator<AgentEvent> {
    const out: AgentEvent[] = [];
    let wakeOut: (() => void) | null = null;
    let inputDone = false;
    const emit = (ev: AgentEvent) => {
      out.push(ev);
      wakeOut?.();
      wakeOut = null;
    };

    // INPUT PUMP — read each turn as the gate releases it; hold its terminal
    // event until the test releases it. Record + register at READ time (via the
    // read promise itself), NOT at a pump loop top that only advances after the
    // previous turn's release — an early (buggy) gate release or an out-of-order
    // terminal would otherwise be invisible to the test.
    const pump = (async () => {
      const it = opts.channel[Symbol.asyncIterator]();
      let marker = 0;
      const read = () =>
        it.next().then((res) => {
          if (res.done) return res;
          marker += 1; // mint: the marker of the turn just read
          const k = marker;
          this.turns.push(res.value.text);
          this.markStarted();
          // SILENCE: no events for this turn until the test releases its
          // terminal event. The gate emits ITSELF when released — decoupled
          // from this pump's read loop, so any turn's terminal can land while
          // an earlier turn's is still withheld.
          const gate = new Promise<AgentEvent>((resolve) => {
            this.held.set(k, resolve);
          });
          void gate.then((terminal) => {
            this.held.delete(k);
            emit(this.legacy ? terminal : { ...terminal, turn: k });
          });
          // Liveness for healthy held turns (opt-in per test): re-arms the
          // panel's idle watchdog so it correctly does NOT trip them.
          if (k >= this.livenessFromTurn) {
            const ping = setInterval(() => opts.onActivity?.(), 40);
            ping.unref?.();
            void gate.then(() => clearInterval(ping));
          }
          return res;
        });
      let r = await read(); // read turn 1
      while (!r.done) {
        r = await read(); // gated by the panel's turn gate — one per release
      }
      inputDone = true;
      wakeOut?.();
      wakeOut = null;
    })();

    emit({ type: "session", sessionId: "sess-held" });
    this.emitFn = emit;
    try {
      while (!inputDone || out.length) {
        if (!out.length) {
          await new Promise<void>((resolve) => {
            wakeOut = resolve;
          });
          continue;
        }
        yield out.shift()!;
      }
    } finally {
      await pump.catch(() => {});
    }
  }

  async interrupt(): Promise<void> {
    this.interrupted += 1;
    // The wedged turn survives an interrupt — no result is emitted — unless the
    // test armed releaseOnInterrupt (teardown), which lets agent.stop()'s
    // interrupt unwind the pump so the run loop can end.
    if (!this.releaseOnInterrupt) return;
    const held = [...this.held.values()];
    this.held.clear();
    for (const r of held) r({ type: "result", ok: false, subtype: "interrupted" });
  }

  async listModels(): Promise<ModelChoice[]> {
    return [];
  }
}

function makeDeps(says: string[]) {
  return {
    mcpServers: {},
    systemAppend: "",
    model: "claude-test",
    onSay: (_tab: string, text: string) => {
      says.push(text);
    },
    onTurn: () => {},
  };
}

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** The watchdog fired: stall warning surfaced and the backend interrupted. */
function tripped(backend: HeldResultBackend, says: string[]): boolean {
  return backend.interrupted >= 1 && says.some((s) => /stopped responding/i.test(s));
}

describe("stall watchdog interrupt reports once and holds the turn gate (#728)", () => {
  it("emits exactly ONE failure report and holds the gate until the interrupted result lands", async () => {
    const says: string[] = [];
    const backend = new HeldResultBackend();
    const agent = new PanelAgent("tab-728a", makeDeps(says) as never, backend);
    void agent.start();

    // Turn 1 starts and freezes (zero events); turn 2 queues behind the gate.
    agent.send("first message");
    await backend.waitStarted(1);
    agent.send("second message queued behind the stall");

    // The watchdog trips: one stall warning + one backend interrupt.
    await waitFor(() => tripped(backend, says));

    // The gate must still be HELD — the interrupted turn hasn't settled (its
    // result is withheld). The old synchronous completeTurn() drained turn 2
    // within ms of the trip, so this assertion failed before the fix.
    await new Promise((r) => setTimeout(r, GATE_HELD_MS));
    expect(backend.turns).toEqual(["first message"]);

    // The backend delivers the interrupted turn's terminal result — the genuine
    // turn end. NOW the gate opens and the queued turn drains.
    backend.releaseTurn(1);
    await backend.waitStarted(2);
    expect(backend.turns[1]).toContain("second message");

    backend.releaseOnInterrupt = true; // let stop()'s interrupt unwind the pump
    await agent.stop();

    // Exactly ONE user-visible failure report: the stall warning. The follow-up
    // interrupted result must NOT paint a second "That turn failed" line.
    const warnings = says.filter((s) => s.includes("⚠️"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/stopped responding/i);
    expect(says.join("\n")).not.toMatch(/That turn failed/i);
  });

  it("still releases the gate via the bounded fallback when no result ever arrives", async () => {
    const says: string[] = [];
    const backend = new HeldResultBackend();
    const agent = new PanelAgent("tab-728b", makeDeps(says) as never, backend);
    void agent.start();

    agent.send("first message");
    await backend.waitStarted(1);
    agent.send("second message queued behind the stall");

    await waitFor(() => tripped(backend, says));

    // Held before the fallback window (500ms from the trip) elapses…
    await new Promise((r) => setTimeout(r, GATE_HELD_MS));
    expect(backend.turns).toEqual(["first message"]);

    // …then the bounded interrupt-release fallback force-opens the gate (the
    // interrupted result NEVER comes), so the queued turn still drains — an
    // interrupt can't stop cold. waitStarted rejects if it never does.
    await backend.waitStarted(2);
    expect(backend.turns[1]).toContain("second message");

    backend.releaseOnInterrupt = true; // let stop()'s interrupt unwind the pump
    await agent.stop();

    // No result ever arrived, so there is nothing to duplicate — still exactly
    // one visible warning.
    const warnings = says.filter((s) => s.includes("⚠️"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/stopped responding/i);
  });

  it("error event first, result withheld → the watchdog does NOT paint a second report", async () => {
    // The codex-gate finding on PR #746: handleEvent('error') paints the turn's
    // failure line but leaves the turn ACTIVE; if the terminal result never
    // arrives, the watchdog must NOT add its stall warning on top (one report
    // per turn) — while still interrupting and releasing the gate via the
    // guarded fallback.
    const says: string[] = [];
    const backend = new HeldResultBackend();
    const agent = new PanelAgent("tab-728c", makeDeps(says) as never, backend);
    void agent.start();

    agent.send("first message");
    await backend.waitStarted(1);
    agent.send("second message queued behind the stall");

    // The backend reports the turn's failure, then goes silent (no result).
    backend.emitError("provider exploded", 1);
    await waitFor(() => says.some((s) => /turn failed/i.test(s)));

    // The watchdog still trips on the silence (the error left the turn active)
    // and interrupts the backend…
    await waitFor(() => backend.interrupted >= 1);

    // …the gate stays held until the bounded fallback opens it (no result ever
    // arrives)…
    await new Promise((r) => setTimeout(r, GATE_HELD_MS));
    expect(backend.turns).toEqual(["first message"]);
    await backend.waitStarted(2);
    expect(backend.turns[1]).toContain("second message");

    backend.releaseOnInterrupt = true; // let stop()'s interrupt unwind the pump
    await agent.stop();

    // …but the stall warning is SUPPRESSED: the error event was this turn's ONE
    // failure report.
    const warnings = says.filter((s) => s.includes("⚠️"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/turn failed/i);
    expect(says.join("\n")).not.toMatch(/stopped responding/i);
  });

  it("stall warning first, late error event for the same turn → the error line is suppressed", async () => {
    // The symmetric order: the watchdog's stall warning already reported this
    // turn's failure (errorSurfaced), so a late backend `error` event for the
    // SAME turn must not paint a second line.
    const says: string[] = [];
    const backend = new HeldResultBackend();
    const agent = new PanelAgent("tab-728d", makeDeps(says) as never, backend);
    void agent.start();

    agent.send("first message");
    await backend.waitStarted(1);
    agent.send("second message queued behind the stall");

    // Watchdog trips first: stall warning painted, backend interrupted.
    await waitFor(() => tripped(backend, says));

    // A late `error` event arrives for the same (already-reported) turn, then
    // the interrupted result settles the turn and opens the gate.
    backend.emitError("late backend error", 1);
    backend.releaseTurn(1);
    await backend.waitStarted(2);
    expect(backend.turns[1]).toContain("second message");

    backend.releaseOnInterrupt = true; // let stop()'s interrupt unwind the pump
    await agent.stop();

    // Exactly ONE report — the stall warning; the late error line is suppressed.
    const warnings = says.filter((s) => s.includes("⚠️"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/stopped responding/i);
    expect(says.join("\n")).not.toMatch(/turn failed/i);
  });

  it("fallback release + new dispatch → the dead turn's straggler error/result are dead-lettered", async () => {
    // The r2 codex-gate finding on PR #746: after the bounded fallback force-opens
    // the gate, the ABANDONED turn may still emit. Its straggler `error` must not
    // paint against the NEW turn (whose dispatch reset errorSurfaced), and its
    // straggler `result` must not complete the NEW turn's gate early — the new
    // turn completes on its OWN result.
    const says: string[] = [];
    const backend = new HeldResultBackend();
    // Turn 2+ is a HEALTHY working backend (liveness pings) — only turn 1 is
    // frozen — so turn 2's (correctly re-armed) watchdog stays quiet while the
    // test holds it through the straggler-observation windows.
    backend.livenessFromTurn = 2;
    const agent = new PanelAgent("tab-728e", makeDeps(says) as never, backend);
    void agent.start();

    agent.send("first message");
    await backend.waitStarted(1);
    agent.send("second message");

    // Watchdog trips; the interrupted result NEVER arrives, so the bounded
    // fallback abandons turn 1 and opens the gate → turn 2 dispatches.
    await waitFor(() => tripped(backend, says));
    await backend.waitStarted(2);
    expect(backend.turns).toEqual(["first message", "second message"]);

    // A third message queues behind turn 2's gate.
    agent.send("third message");

    // Straggler #1: the DEAD turn's late error — dead-lettered, never painted.
    backend.emitError("late old-turn error", 1);
    await new Promise((r) => setTimeout(r, 100));
    expect(says.filter((s) => s.includes("⚠️"))).toHaveLength(1); // still only the stall warning

    // Straggler #2: the DEAD turn's late result — dead-lettered; it must NOT
    // complete turn 2's gate, so turn 3 stays parked.
    backend.releaseTurn(1); // turn 1's withheld terminal (interrupted)
    await new Promise((r) => setTimeout(r, GATE_HELD_MS));
    expect(backend.turns).toEqual(["first message", "second message"]);

    // Turn 2's OWN result (success) completes turn 2 → turn 3 drains.
    backend.releaseTurn(2, { type: "result", ok: true, subtype: "success" });
    await backend.waitStarted(3);
    expect(backend.turns[2]).toContain("third message");

    backend.releaseOnInterrupt = true; // let stop()'s interrupt unwind the pump
    await agent.stop();

    // Exactly ONE report overall: the original stall warning.
    const warnings = says.filter((s) => s.includes("⚠️"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/stopped responding/i);
    expect(says.join("\n")).not.toMatch(/turn failed/i);
  });

  it("result-only new turn after a fallback abandonment is NOT dead-lettered (no wedge)", async () => {
    // The r3 codex-gate finding #1: after the fallback abandons A, B's VALID
    // first event may be its terminal result (the event contract permits
    // result-only turns). With markers it is stamped B — not A — so it reaches
    // completeTurn() and B's gate opens. (The credit heuristic dead-lettered it
    // as A's and wedged B.)
    const says: string[] = [];
    const backend = new HeldResultBackend();
    const agent = new PanelAgent("tab-728f", makeDeps(says) as never, backend);
    void agent.start();

    agent.send("first message");
    await backend.waitStarted(1);
    agent.send("second message");

    // A stalls → watchdog → fallback abandons A (its result NEVER comes) → B.
    await waitFor(() => tripped(backend, says));
    await backend.waitStarted(2);
    expect(backend.turns).toEqual(["first message", "second message"]);
    agent.send("third message"); // queued behind B's gate

    // B's FIRST and ONLY event is its terminal result — stamped 2, so it
    // completes B's gate even though A's terminal never arrived.
    backend.releaseTurn(2, { type: "result", ok: true, subtype: "success" });
    await backend.waitStarted(3); // would time out if B were wedged
    expect(backend.turns[2]).toContain("third message");

    backend.releaseOnInterrupt = true; // let stop()'s interrupt unwind the pump
    await agent.stop();

    const warnings = says.filter((s) => s.includes("⚠️"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/stopped responding/i);
  });

  it("new turn's work before the dead turn's late terminal keeps the straggler dead-lettered", async () => {
    // The r3 codex-gate finding #2: B emits ordinary work BEFORE A's late
    // terminal. Markers make attribution order-independent — A's terminal is
    // stamped 1, so it is dead-lettered no matter what B emitted first: no wrong
    // report, no premature gate completion. (The credit heuristic cleared the
    // credit on B's work and then attributed A's terminal to B.)
    const says: string[] = [];
    const backend = new HeldResultBackend();
    backend.livenessFromTurn = 2; // B works healthily while held (see test E)
    const agent = new PanelAgent("tab-728g", makeDeps(says) as never, backend);
    void agent.start();

    agent.send("first message");
    await backend.waitStarted(1);
    agent.send("second message");

    await waitFor(() => tripped(backend, says));
    await backend.waitStarted(2);
    expect(backend.turns).toEqual(["first message", "second message"]);
    agent.send("third message"); // queued behind B's gate

    // B's valid work arrives FIRST (stamped 2 → processed normally)…
    backend.emitEvent({ type: "assistant", text: "B is working", turn: 2 });
    await waitFor(() => says.some((s) => s.includes("B is working")));

    // …THEN A's late terminal (stamped 1): still dead-lettered — turn 3 parked.
    backend.releaseTurn(1);
    await new Promise((r) => setTimeout(r, GATE_HELD_MS));
    expect(backend.turns).toEqual(["first message", "second message"]);

    // B's OWN terminal completes B → turn 3 drains.
    backend.releaseTurn(2, { type: "result", ok: true, subtype: "success" });
    await backend.waitStarted(3);
    expect(backend.turns[2]).toContain("third message");

    backend.releaseOnInterrupt = true; // let stop()'s interrupt unwind the pump
    await agent.stop();

    // No wrong report: only the original stall warning.
    const warnings = says.filter((s) => s.includes("⚠️"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/stopped responding/i);
    expect(says.join("\n")).not.toMatch(/turn failed/i);
  });

  it("legacy no-marker backend gets NO dead-lettering (previous behavior)", async () => {
    // A backend that never stamps turn markers must behave exactly as before
    // this PR series: PanelAgent can't attribute stragglers, so it does NOT
    // dead-letter — better a rare duplicate than a wedge.
    const says: string[] = [];
    const backend = new HeldResultBackend();
    backend.legacy = true; // emit everything WITHOUT a turn marker
    const agent = new PanelAgent("tab-728h", makeDeps(says) as never, backend);
    void agent.start();

    agent.send("first message");
    await backend.waitStarted(1);
    agent.send("second message");

    await waitFor(() => tripped(backend, says));
    await backend.waitStarted(2);
    expect(backend.turns).toEqual(["first message", "second message"]);
    agent.send("third message"); // queued behind turn 2's gate

    // Unmarked straggler error → processed (painted), exactly as pre-markers.
    backend.emitError("legacy straggler error");
    await waitFor(() => says.some((s) => /turn failed/i.test(s)));

    // Unmarked straggler result → completes the gate, exactly as pre-markers:
    // turn 3 drains WITHOUT turn 2's own result ever arriving.
    backend.releaseTurn(1);
    await backend.waitStarted(3);
    expect(backend.turns[2]).toContain("third message");

    backend.releaseOnInterrupt = true; // let stop()'s interrupt unwind the pump
    await agent.stop();

    const warnings = says.filter((s) => s.includes("⚠️"));
    expect(warnings).toHaveLength(2); // stall warning + the painted straggler error
    expect(warnings[0]).toMatch(/stopped responding/i);
    expect(warnings[1]).toMatch(/turn failed/i);
  });
});
