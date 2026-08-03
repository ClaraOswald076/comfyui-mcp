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
// turn's straggler `error`/`result` are dead-lettered — never painted against,
// and never completing the gate of, the turn that replaces it (r2).
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
 *  watchdog trips on schedule. */
class HeldResultBackend implements AgentBackend {
  readonly id = "claude" as const;
  readonly capabilities = CLAUDE_CAPABILITIES;
  turns: string[] = [];
  interrupted = 0;
  /** The wedge: an interrupt does NOT end the held turn or emit its result —
   *  the test alone decides when (if ever) the interrupted result lands. Set to
   *  true right before agent.stop() so teardown's interrupt unwinds the pump. */
  releaseOnInterrupt = false;
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

  /** Release the OLDEST held turn, emitting `ev` as its terminal event (default:
   *  the interrupt landing). Turn 2+ can thus end with a SUCCESS result while the
   *  stalled turn's straggler is the interrupted one. */
  releaseTurn(ev: AgentEvent = { type: "result", ok: false, subtype: "interrupted" }): void {
    this.releaseResolvers.shift()?.(ev);
  }

  /** Emit an `error` event for the in-flight turn (test-controlled) — the way
   *  codex/gemini/grok report a turn failure BEFORE their terminal result. The
   *  error leaves the turn ACTIVE (no result), so the watchdog can still trip. */
  emitError(message: string): void {
    this.emitFn?.({ type: "error", message });
  }

  private emitFn: ((ev: AgentEvent) => void) | null = null;
  /** One resolver per in-flight turn, FIFO — resolved by `releaseTurn()` with the
   *  terminal event to emit for that turn. */
  private releaseResolvers: Array<(ev: AgentEvent) => void> = [];

  async *run(opts: BackendStartOptions): AsyncGenerator<AgentEvent> {
    const out: AgentEvent[] = [];
    let wakeOut: (() => void) | null = null;
    let inputDone = false;
    const emit = (ev: AgentEvent) => {
      out.push(ev);
      wakeOut?.();
      wakeOut = null;
    };

    // INPUT PUMP — concurrent, read-ahead, manual per-turn result release.
    const pump = (async () => {
      const it = opts.channel[Symbol.asyncIterator]();
      // Record each turn at READ time — the moment the gate releases it into the
      // backend — via the read promise itself, NOT at the pump loop top: the loop
      // only consumes the read-ahead AFTER this turn's withheld result, which
      // would make an early (buggy) gate release invisible to the test.
      const read = () =>
        it.next().then((res) => {
          if (!res.done) {
            this.turns.push(res.value.text);
            this.markStarted();
          }
          return res;
        });
      let r = await read(); // read turn 1
      while (!r.done) {
        // DECOUPLED read-ahead: begin reading the NEXT turn now (parks at the
        // turn gate while this turn is held) — mirrors the SDK input pump.
        const readAhead = read();
        // SILENCE: no events for this turn until the test releases its terminal
        // event (an interrupted result, or whatever releaseTurn was given).
        const terminal = await new Promise<AgentEvent>((resolve) => {
          this.releaseResolvers.push(resolve);
        });
        emit(terminal);
        r = await readAhead;
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
    const held = this.releaseResolvers;
    this.releaseResolvers = [];
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
    backend.releaseTurn();
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
    backend.emitError("provider exploded");
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
    backend.emitError("late backend error");
    backend.releaseTurn();
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
    backend.emitError("late old-turn error");
    await new Promise((r) => setTimeout(r, 100));
    expect(says.filter((s) => s.includes("⚠️"))).toHaveLength(1); // still only the stall warning

    // Straggler #2: the DEAD turn's late result — dead-lettered; it must NOT
    // complete turn 2's gate, so turn 3 stays parked.
    backend.releaseTurn(); // FIFO: turn 1's withheld terminal (interrupted)
    await new Promise((r) => setTimeout(r, GATE_HELD_MS));
    expect(backend.turns).toEqual(["first message", "second message"]);

    // Turn 2's OWN result (success) completes turn 2 → turn 3 drains.
    backend.releaseTurn({ type: "result", ok: true, subtype: "success" });
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
});
