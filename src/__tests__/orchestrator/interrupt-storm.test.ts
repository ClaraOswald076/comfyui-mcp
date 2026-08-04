// #568 Defect 2 — an interrupt STORM must not starve the turn-gate release
// fallback. When the SDK is wedged (an interrupt produces NO terminal result), the
// gate is held by the aborted turn and only the bounded fallback can force it open.
// The OLD fallback did clearTimeout + re-arm on EVERY interrupt, so a stream of
// "send now" landing closer together than the window kept cancelling the pending
// net before it could fire — the gate stayed shut and NO turn ever started again
// ("Interrupted." with PENDING messages nothing flushes). The fix coalesces
// (keeps the earliest deadline) so the net set by the FIRST interrupt of a burst is
// an absolute ceiling, and fires on the live gate condition.

// Shrink the window so the test is fast. Read at module import, so set it BEFORE
// the dynamic import below.
process.env.COMFYUI_MCP_INTERRUPT_RELEASE_MS = "150";

import { describe, expect, it, beforeAll, afterEach } from "vitest";
import type {
  AgentBackend,
  AgentEvent,
  BackendStartOptions,
  ModelChoice,
} from "../../orchestrator/agent-backend.js";
import { CLAUDE_CAPABILITIES } from "../../orchestrator/agent-backend.js";

let PanelAgent: typeof import("../../orchestrator/panel-agent.js").PanelAgent;
let PanelAgentManager: typeof import("../../orchestrator/panel-agent.js").PanelAgentManager;

beforeAll(async () => {
  ({ PanelAgent, PanelAgentManager } = await import("../../orchestrator/panel-agent.js"));
});

/** A WEDGED backend: each turn hangs, and an interrupt breaks the hang (so the
 *  for-await returns to pull the next batch) but emits NO terminal result — exactly
 *  the wedge in the report, where completeTurn never fires and only the release
 *  fallback can reopen the gate. */
class WedgedBackend implements AgentBackend {
  readonly id = "claude" as const;
  readonly capabilities = CLAUDE_CAPABILITIES;
  turns: string[] = [];
  interrupted = 0;
  private breakTurn: (() => void) | null = null;

  async *run(opts: BackendStartOptions): AsyncGenerator<AgentEvent> {
    yield { type: "session", sessionId: "sess-wedge" };
    for await (const turn of opts.channel) {
      this.turns.push(turn.text);
      await new Promise<void>((resolve) => {
        this.breakTurn = resolve;
      });
      this.breakTurn = null;
      // Deliberately NO result event — the SDK is wedged. The gate can only be
      // reopened by the interrupt release fallback.
    }
  }

  async interrupt(): Promise<void> {
    this.interrupted += 1;
    const brk = this.breakTurn;
    this.breakTurn = null;
    brk?.();
  }

  async listModels(): Promise<ModelChoice[]> {
    return [];
  }
}

function makeDeps() {
  return {
    mcpServers: {},
    systemAppend: "",
    model: "claude-test",
    onSay: () => {},
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

describe("interrupt storm does not starve the release fallback (#568 Defect 2)", () => {
  it("a turn still starts even under CONTINUOUS send-now interrupts spaced under the window", async () => {
    const backend = new WedgedBackend();
    const agent = new PanelAgent("tab-storm", makeDeps() as never, backend);
    void agent.start();

    // Turn 1 is in flight (hung — no result will ever come from this wedged turn).
    agent.send("first (the wedged turn)");
    await waitFor(() => backend.turns.length === 1);

    // A queued follow-up that the user is trying to get answered.
    agent.send("second (must eventually run)");

    // The storm: hammer "send now" every 50ms — FASTER than the 150ms window. With
    // the old cancel-and-re-arm, this stream keeps postponing the net indefinitely;
    // it must NOT here. The interval keeps running across the assertion window on
    // purpose — the release must fire WHILE interrupts are still arriving.
    const storm = setInterval(() => {
      void agent.interrupt({ requeueInFlight: true });
    }, 50);

    try {
      // Despite the ongoing storm, a NEW turn must start within a bounded time
      // (window + margin). With the old code this never happens while the interval
      // runs, so this waitFor would time out.
      await waitFor(() => backend.turns.length >= 2, 1200);
    } finally {
      clearInterval(storm);
    }

    expect(backend.turns.length).toBeGreaterThanOrEqual(2);
    // The queued follow-up was addressed (not stranded as a PENDING message).
    expect(backend.turns.join("\n\n")).toContain("second (must eventually run)");

    await agent.stop();
  });

  it("a single interrupt whose result never arrives still releases the gate (baseline)", async () => {
    const backend = new WedgedBackend();
    const agent = new PanelAgent("tab-single", makeDeps() as never, backend);
    void agent.start();

    agent.send("wedged first");
    await waitFor(() => backend.turns.length === 1);
    agent.send("the follow-up");

    // One interrupt, no further storm — the fallback fires ~window later.
    await agent.interrupt({ requeueInFlight: true });
    await waitFor(() => backend.turns.length >= 2, 1000);
    expect(backend.turns.join("\n\n")).toContain("the follow-up");

    await agent.stop();
  });

  // The property that makes the net starvation-free rather than merely "eventually
  // scheduled": the deadline set by the FIRST interrupt of an unsettled burst is an
  // ABSOLUTE ceiling. Later interrupts refresh the guard (so it keeps naming the
  // still-stuck turn) but must never push the deadline out. Timing it — not just
  // "does a turn eventually start" — is what distinguishes the two: a re-arming net
  // still fires eventually once the storm stops, so a generous bound passes in BOTH
  // states.
  it("releases within ONE window of the FIRST interrupt, however many follow", async () => {
    const backend = new WedgedBackend();
    const agent = new PanelAgent("tab-ceiling", makeDeps() as never, backend);
    void agent.start();

    agent.send("wedged first");
    await waitFor(() => backend.turns.length === 1);
    agent.send("the follow-up");

    const firstInterruptAt = Date.now();
    void agent.interrupt({ requeueInFlight: true });
    // Keep hammering INSIDE the window (50ms < 150ms) — each one is a chance to
    // postpone the net.
    const storm = setInterval(() => {
      void agent.interrupt({ requeueInFlight: true });
    }, 50);
    try {
      await waitFor(() => backend.turns.length >= 2, 1200);
    } finally {
      clearInterval(storm);
    }
    const elapsed = Date.now() - firstInterruptAt;

    // One 150ms window plus scheduling slack. A net that any later interrupt could
    // re-arm would land far beyond this (the storm ran for the whole wait).
    expect(elapsed).toBeLessThan(600);

    await agent.stop();
  });
});

// #568 — the two defects compound: a stale identity means the interrupt reaches no
// live agent at all, and an interrupt that reaches nothing arms NO recovery (no turn
// gate is held for it, no release fallback is scheduled). Reporting that as a
// completed cancellation is a could-not/did-not conflation, and it is what left the
// user hammering "send now" at a tab with nothing behind it. The outcome must be
// distinguishable.
describe("interrupt reports whether a live agent actually took it (#568)", () => {
  it("false when the key has no agent, true once one exists", async () => {
    const backend = new WedgedBackend();
    const manager = new PanelAgentManager({
      mcpServers: {},
      systemAppend: "",
      model: "claude-test",
      onSay: () => {},
      onTurn: () => {},
      makeBackend: () => backend,
    } as never);

    const key = "tmp:no-agent::claude";
    expect(manager.hasLiveAgent(key)).toBe(false);
    // Nothing was cancelled — and, critically, nothing was scheduled to recover either.
    await expect(manager.interrupt(key, { requeueInFlight: true })).resolves.toBe(false);

    manager.send(key, "spawns the agent");
    await waitFor(() => backend.turns.length === 1);
    expect(manager.hasLiveAgent(key)).toBe(true);
    await expect(manager.interrupt(key, { requeueInFlight: true })).resolves.toBe(true);

    await manager.stopAll();
  });
});
