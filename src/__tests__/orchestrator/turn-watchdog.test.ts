// Focused tests for the per-turn freeze watchdog's LIVENESS re-arm. The watchdog
// must NOT trip while the backend is genuinely working — even when that work
// produces raw provider notifications that translate to NO AgentEvents (a long
// Codex MCP tool call running a multi-minute ComfyUI generation) — yet MUST still
// catch a true zero-event freeze (the app-server hangs and emits nothing at all).
//
// TURN_IDLE_MS is read from the env at panel-agent module load, so we set a SHORT
// window BEFORE importing the module (dynamic import after setting the env).

import { describe, expect, it, beforeAll } from "vitest";
import type {
  AgentBackend,
  AgentEvent,
  BackendStartOptions,
  ModelChoice,
} from "../../orchestrator/agent-backend.js";
import { CLAUDE_CAPABILITIES } from "../../orchestrator/agent-backend.js";

// SHORT idle window for the test — must be set before importing panel-agent.
const IDLE_MS = 120;
process.env.COMFYUI_MCP_TURN_IDLE_MS = String(IDLE_MS);

// Imported after the env is set so TURN_IDLE_MS picks up our short window.
let PanelAgent: typeof import("../../orchestrator/panel-agent.js").PanelAgent;

beforeAll(async () => {
  ({ PanelAgent } = await import("../../orchestrator/panel-agent.js"));
});

/** A backend whose turn emits periodic LIVENESS signals (onActivity) but NO
 *  AgentEvents until `finishAfterMs`, then a single terminal `result`. This is the
 *  "healthy long generation" shape: raw notifications keep arriving, but nothing
 *  is translated into an AgentEvent during the wait. */
class LiveButQuietBackend implements AgentBackend {
  readonly id = "claude" as const;
  readonly capabilities = CLAUDE_CAPABILITIES;
  interrupted = 0;
  constructor(
    private readonly pingEveryMs: number,
    private readonly finishAfterMs: number,
  ) {}
  async *run(opts: BackendStartOptions): AsyncGenerator<AgentEvent> {
    yield { type: "session", sessionId: "sess-quiet" };
    for await (const _turn of opts.channel) {
      void _turn;
      const start = Date.now();
      // Emit liveness pings (no AgentEvents) for the whole work window.
      while (Date.now() - start < this.finishAfterMs) {
        opts.onActivity?.();
        await new Promise((r) => setTimeout(r, this.pingEveryMs));
      }
      // Turn really finished → terminal result (disarms the watchdog).
      yield { type: "result", ok: true, subtype: "success" };
    }
  }
  async interrupt(): Promise<void> {
    this.interrupted += 1;
  }
  async listModels(): Promise<ModelChoice[]> {
    return [];
  }
}

/** A backend that opens a tool call, then goes completely silent — no events, no
 *  liveness pings — while the tool "runs", then closes it and finishes. This is
 *  the #307-review scenario: an MCP tool call (install_custom_node awaiting the
 *  Manager) streams NOTHING between item/started and item/completed, so without
 *  the tool-busy defer the watchdog would falsely interrupt a healthy tool call. */
class SilentToolBackend implements AgentBackend {
  readonly id = "codex" as const;
  readonly capabilities = CLAUDE_CAPABILITIES;
  interrupted = 0;
  constructor(private readonly toolRunsMs: number) {}
  async *run(opts: BackendStartOptions): AsyncGenerator<AgentEvent> {
    yield { type: "session", sessionId: "sess-tool" };
    for await (const _turn of opts.channel) {
      void _turn;
      yield { type: "tool_call", name: "install_custom_node", phase: "start" };
      // The tool runs with ZERO further activity for well past the idle window.
      await new Promise((r) => setTimeout(r, this.toolRunsMs));
      yield { type: "tool_call", name: "install_custom_node", phase: "end" };
      yield { type: "result", ok: true, subtype: "success" };
    }
  }
  async interrupt(): Promise<void> {
    this.interrupted += 1;
  }
  async listModels(): Promise<ModelChoice[]> {
    return [];
  }
}

/** A backend that opens a tool call and then NEVER closes it or emits anything —
 *  a genuinely stuck tool. The watchdog must still trip once TOOL_BUSY_MAX_MS is
 *  exceeded, so a wedge mid-tool is not masked forever. */
class StuckToolBackend implements AgentBackend {
  readonly id = "codex" as const;
  readonly capabilities = CLAUDE_CAPABILITIES;
  interrupted = 0;
  async *run(opts: BackendStartOptions): AsyncGenerator<AgentEvent> {
    yield { type: "session", sessionId: "sess-stuck" };
    for await (const _turn of opts.channel) {
      void _turn;
      yield { type: "tool_call", name: "install_custom_node", phase: "start" };
      await new Promise<void>(() => {}); // never completes
    }
  }
  async interrupt(): Promise<void> {
    this.interrupted += 1;
  }
  async listModels(): Promise<ModelChoice[]> {
    return [];
  }
}

/** A backend whose turn emits NOTHING at all (no events, no liveness) — the true
 *  zero-event freeze the watchdog exists to catch. */
class SilentBackend implements AgentBackend {
  readonly id = "claude" as const;
  readonly capabilities = CLAUDE_CAPABILITIES;
  interrupted = 0;
  async *run(opts: BackendStartOptions): AsyncGenerator<AgentEvent> {
    yield { type: "session", sessionId: "sess-silent" };
    for await (const _turn of opts.channel) {
      void _turn;
      // Hang forever (until interrupted) with no events and no liveness pings.
      await new Promise<void>(() => {});
    }
  }
  async interrupt(): Promise<void> {
    this.interrupted += 1;
  }
  async listModels(): Promise<ModelChoice[]> {
    return [];
  }
}

function makeDeps(says: string[], turns: Array<"working" | "done">) {
  return {
    mcpServers: {},
    systemAppend: "",
    model: "claude-test",
    onSay: (_tab: string, text: string) => {
      says.push(text);
    },
    onTurn: (_tab: string, state: "working" | "done") => {
      turns.push(state);
    },
  };
}

describe("per-turn freeze watchdog liveness re-arm", () => {
  it("does NOT trip while the backend emits liveness pings (no AgentEvents) past the idle window", async () => {
    const says: string[] = [];
    const turns: Array<"working" | "done"> = [];
    // Work for ~6x the idle window, pinging at ~half the window — every ping
    // re-arms the watchdog, so it must never trip.
    const backend = new LiveButQuietBackend(IDLE_MS / 2, IDLE_MS * 6);
    const agent = new PanelAgent("tab-quiet", makeDeps(says, turns) as never, backend);
    void agent.start();
    agent.send("please run a long Wan2.2 video generation");

    // Wait well past the idle window but for less than the total work window.
    await new Promise((r) => setTimeout(r, IDLE_MS * 4));

    // The healthy generation must NOT have been falsely interrupted or surfaced
    // as a stall while it's still working.
    expect(backend.interrupted).toBe(0);
    expect(says.join("\n")).not.toMatch(/stopped responding|stalled/i);

    // Let the turn finish cleanly.
    await new Promise((r) => setTimeout(r, IDLE_MS * 4));
    expect(backend.interrupted).toBe(0);
    expect(turns).toContain("done");
    await agent.stop();
  });

  it("DOES trip on a true zero-event freeze (no events, no liveness)", async () => {
    const says: string[] = [];
    const turns: Array<"working" | "done"> = [];
    const backend = new SilentBackend();
    const agent = new PanelAgent("tab-silent", makeDeps(says, turns) as never, backend);
    void agent.start();
    agent.send("this turn will hang with zero activity");

    // Wait past the idle window — with no liveness the watchdog must trip.
    await new Promise((r) => setTimeout(r, IDLE_MS * 4));

    expect(says.join("\n")).toMatch(/stopped responding|stalled/i);
    expect(backend.interrupted).toBeGreaterThanOrEqual(1);
    expect(turns).toContain("done"); // gate released so the next batch can run
    await agent.stop();
  });

  it("does NOT trip while a tool call is open, even with a silent app-server (#307)", async () => {
    const says: string[] = [];
    const turns: Array<"working" | "done"> = [];
    // Tool "runs" for ~5x the idle window emitting NOTHING — the exact scenario a
    // long install_custom_node produces. The open tool call must hold the
    // watchdog off; before the fix, the narrowed liveness let it trip here.
    const backend = new SilentToolBackend(IDLE_MS * 5);
    const agent = new PanelAgent("tab-tool", makeDeps(says, turns) as never, backend);
    void agent.start();
    agent.send("install the impact pack");

    await new Promise((r) => setTimeout(r, IDLE_MS * 3));
    expect(backend.interrupted).toBe(0);
    expect(says.join("\n")).not.toMatch(/stopped responding|stalled/i);

    // Let the tool finish and the turn complete cleanly.
    await new Promise((r) => setTimeout(r, IDLE_MS * 4));
    expect(backend.interrupted).toBe(0);
    expect(turns).toContain("done");
    await agent.stop();
  });

  it("DOES trip a tool open past TOOL_BUSY_MAX_MS (a genuinely stuck tool)", async () => {
    // Bound the defer so a mid-tool wedge isn't masked forever. The cap is read
    // LIVE in onTurnStalled (toolBusyMaxMs()), so setting it to 1ms makes the very
    // first stall check past an open tool trip instead of deferring.
    process.env.COMFYUI_MCP_TOOL_BUSY_MAX_MS = "1";
    const says: string[] = [];
    const turns: Array<"working" | "done"> = [];
    const backend = new StuckToolBackend();
    const agent = new PanelAgent("tab-stuck", makeDeps(says, turns) as never, backend);
    void agent.start();
    agent.send("install a node that will hang");

    await new Promise((r) => setTimeout(r, IDLE_MS * 4));
    expect(says.join("\n")).toMatch(/stopped responding|stalled/i);
    expect(backend.interrupted).toBeGreaterThanOrEqual(1);
    await agent.stop();
    delete process.env.COMFYUI_MCP_TOOL_BUSY_MAX_MS;
  });
});
