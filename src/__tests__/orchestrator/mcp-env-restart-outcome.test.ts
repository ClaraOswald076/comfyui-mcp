// #826 — the respawn must be PROVABLE, not assumed.
//
// panel_request_secret used to answer "the comfyui tools respawn with it as soon
// as this turn ends" whether or not anything was ever going to respawn. The
// restart entry points now return WHAT THEY DID, so the caller can say
// "1 replaced now", "1 queued for the end of this turn", or "no live tool
// session" — and can never describe a queued replacement as a completed one, or
// report a respawn for a tab that has no agent at all.
//
// The distinctions these tests defend:
//   applied   — the agent was idle, the replacement happened synchronously.
//   scheduled — the agent is mid-turn; the replacement is only QUEUED.
//   no-agent  — nothing exists on this key; this must never read as success.

import { describe, expect, it, beforeAll } from "vitest";
import type {
  AgentBackend,
  AgentEvent,
  BackendStartOptions,
  ModelChoice,
} from "../../orchestrator/agent-backend.js";
import { CLAUDE_CAPABILITIES } from "../../orchestrator/agent-backend.js";

let PanelAgentManager: typeof import("../../orchestrator/panel-agent.js").PanelAgentManager;
let tallyRestart: typeof import("../../orchestrator/panel-agent.js").tallyRestart;

beforeAll(async () => {
  ({ PanelAgentManager, tallyRestart } = await import("../../orchestrator/panel-agent.js"));
});

class RecordingBackend implements AgentBackend {
  readonly id = "claude" as const;
  readonly capabilities = CLAUDE_CAPABILITIES;
  runCount = 0;
  turnTexts: string[] = [];
  autoComplete = true;
  private releaseTurn: (() => void) | null = null;

  async *run(opts: BackendStartOptions): AsyncGenerator<AgentEvent> {
    this.runCount += 1;
    yield { type: "session", sessionId: "sess-x" };
    for await (const turn of opts.channel) {
      this.turnTexts.push(turn.text);
      if (!this.autoComplete) {
        await new Promise<void>((resolve) => {
          this.releaseTurn = resolve;
        });
        this.releaseTurn = null;
      }
      yield { type: "result", ok: true, subtype: "success" };
    }
  }

  release(): void {
    const r = this.releaseTurn;
    this.releaseTurn = null;
    r?.();
  }

  async interrupt(): Promise<void> {
    this.release();
  }

  async listModels(): Promise<ModelChoice[]> {
    return [];
  }
}

function makeManager(backend: AgentBackend) {
  return new PanelAgentManager({
    mcpServers: {},
    systemAppend: "",
    model: "claude-test",
    onSay: () => {},
    onTurn: () => {},
    makeBackend: () => backend,
  } as never);
}

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("restartForMcpEnv reports what it actually did (#826)", () => {
  it("returns 'no-agent' for a tab with no live agent — never a silent success", () => {
    const manager = makeManager(new RecordingBackend());
    expect(manager.restartForMcpEnv("tab-that-never-existed", "RETRY")).toBe("no-agent");
  });

  it("returns 'scheduled' while the agent is mid-turn — the replacement has NOT happened", async () => {
    const backend = new RecordingBackend();
    backend.autoComplete = false; // hold the agent busy
    const manager = makeManager(backend);
    manager.send("tab-busy", "hello");
    await waitFor(() => backend.runCount >= 1 && backend.turnTexts.length >= 1);

    expect(manager.restartForMcpEnv("tab-busy", "RETRY")).toBe("scheduled");
    // Proof that "scheduled" is not "applied": no new run has started.
    expect(backend.runCount).toBe(1);

    backend.autoComplete = true;
    backend.release();
    await waitFor(() => backend.runCount >= 2);
  });

  it("returns 'applied' when the agent is idle — the replacement happened now", async () => {
    const backend = new RecordingBackend();
    const manager = makeManager(backend);
    manager.send("tab-idle", "hello");
    await waitFor(() => backend.runCount >= 1 && backend.turnTexts.length >= 1);
    // Let the turn settle so the agent is genuinely idle.
    await waitFor(() => manager.restartForMcpEnv("tab-idle") === "applied", 3000);
    expect(backend.runCount).toBeGreaterThanOrEqual(2);
  });
});

describe("tallyRestart: an agent that vanished counts as NEITHER (#826)", () => {
  it("counts 'applied' as applied and nothing else", () => {
    const t = { live: 1, applied: 0, scheduled: 0 };
    tallyRestart(t, "applied");
    expect(t).toEqual({ live: 1, applied: 1, scheduled: 0 });
  });

  it("counts 'scheduled' as scheduled and nothing else", () => {
    const t = { live: 1, applied: 0, scheduled: 0 };
    tallyRestart(t, "scheduled");
    expect(t).toEqual({ live: 1, applied: 0, scheduled: 1 });
  });

  it("counts 'no-agent' as neither — a vanished agent was not respawned and nothing will respawn it", () => {
    const t = { live: 1, applied: 0, scheduled: 0 };
    tallyRestart(t, "no-agent");
    expect(t).toEqual({ live: 1, applied: 0, scheduled: 0 });
  });
});

describe("restartAllForMcpEnv tallies every live agent (#826)", () => {
  it("reports zero live agents when there are none — nothing to claim", () => {
    const manager = makeManager(new RecordingBackend());
    expect(manager.restartAllForMcpEnv()).toEqual({ live: 0, applied: 0, scheduled: 0 });
  });

  it("counts a busy agent as scheduled, not applied", async () => {
    const backend = new RecordingBackend();
    backend.autoComplete = false;
    const manager = makeManager(backend);
    manager.send("tab-a", "hello");
    await waitFor(() => backend.runCount >= 1 && backend.turnTexts.length >= 1);

    expect(manager.restartAllForMcpEnv()).toEqual({ live: 1, applied: 0, scheduled: 1 });

    backend.autoComplete = true;
    backend.release();
    await waitFor(() => backend.runCount >= 2);
  });

  it("counts every live tab, so a multi-tab respawn cannot under-report", async () => {
    const backend = new RecordingBackend();
    backend.autoComplete = false;
    const manager = makeManager(backend);
    manager.send("tab-a", "hello");
    manager.send("tab-b", "hello");
    await waitFor(() => backend.turnTexts.length >= 2);

    const tally = manager.restartAllForMcpEnv();
    expect(tally.live).toBe(2);
    expect(tally.applied + tally.scheduled).toBe(2);

    backend.autoComplete = true;
    backend.release();
  });

  it("still returns a tally on the nudge-preserving path (#164) instead of dropping the tab", async () => {
    // A tab that already has a nudge queued takes the early-continue branch. That
    // branch must still be COUNTED — a tab silently missing from the tally would
    // make the tool under-report the work in flight.
    const backend = new RecordingBackend();
    backend.autoComplete = false;
    const manager = makeManager(backend);
    manager.send("tab-nudged", "hello");
    await waitFor(() => backend.runCount >= 1 && backend.turnTexts.length >= 1);

    expect(manager.restartForMcpEnv("tab-nudged", "RETRY")).toBe("scheduled");
    // Silent broadcast: hits the preserve-existing-nudge branch for this tab.
    expect(manager.restartAllForMcpEnv()).toEqual({ live: 1, applied: 0, scheduled: 1 });

    backend.autoComplete = true;
    backend.release();
    await waitFor(() => backend.runCount >= 2);
    // And the nudge still survived (the #164 invariant is unchanged).
    expect(backend.turnTexts.filter((t) => t === "RETRY")).toHaveLength(1);
  });
});
