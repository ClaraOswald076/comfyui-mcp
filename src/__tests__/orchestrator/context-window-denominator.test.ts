// Regression tests for the context-meter denominator (#543).
//
// BUG: the panel's context-usage ring scored `used / contextWindow`, but
// contextWindow only ever RATCHETED UP (`ev.contextWindow > this.contextWindow`).
// Because the model can change mid-session (setModel is live — no restart),
// switching DOWN to a smaller-window model kept the larger denominator forever,
// so the meter silently under-reported fill (100k used shown as 10% of a stale
// 1M window when the true figure was 50% of the current 200k window).
//
// FIX: track the LATEST reported window (drop the `>` guard), and CLEAR the cache
// on a model switch so the outgoing model's window can't score the next turn —
// reportStatus omits contextPct while the cache is 0 (the panel holds its prior
// reading) and the next result refreshes it for the incoming model. `used` is
// still reported throughout.
//
// Harness mirrors effort-carry.test.ts: a fake AgentBackend that emits scripted
// assistant/result events + a PanelAgentManager wired to capture onStatus.

import { describe, expect, it, beforeAll } from "vitest";
import type {
  AgentBackend,
  AgentEvent,
  BackendStartOptions,
  ModelChoice,
} from "../../orchestrator/agent-backend.js";
import { CLAUDE_CAPABILITIES } from "../../orchestrator/agent-backend.js";

let PanelAgentManager: typeof import("../../orchestrator/panel-agent.js").PanelAgentManager;

beforeAll(async () => {
  ({ PanelAgentManager } = await import("../../orchestrator/panel-agent.js"));
});

interface TurnSpec {
  /** Prompt usage for the assistant event (used = input + cache reads/creates). */
  usage?: Record<string, number>;
  /** Window the result event reports; omit to report NO window that turn. */
  contextWindow?: number;
}

/** Emits one scripted assistant (+usage) then one result (+contextWindow) per
 *  incoming turn, in order from `turns`. Records the models setModel() was asked
 *  to apply. */
class ScriptedContextBackend implements AgentBackend {
  readonly id = "claude" as const;
  readonly capabilities = CLAUDE_CAPABILITIES;
  turns: TurnSpec[] = [];
  modelCalls: string[] = [];
  private i = 0;

  async *run(opts: BackendStartOptions): AsyncGenerator<AgentEvent> {
    yield { type: "session", sessionId: "sess-ctx" };
    for await (const turn of opts.channel) {
      void turn;
      const spec = this.turns[this.i++] ?? {};
      if (spec.usage) yield { type: "assistant", text: "", usage: spec.usage };
      yield {
        type: "result",
        ok: true,
        subtype: "success",
        ...(spec.contextWindow != null ? { contextWindow: spec.contextWindow } : {}),
      };
    }
  }

  async interrupt(): Promise<void> {}
  async setModel(model: string): Promise<void> {
    this.modelCalls.push(model);
  }
  async listModels(): Promise<ModelChoice[]> {
    return [];
  }
}

/** Like ScriptedContextBackend but HOLDS each turn after the assistant event,
 *  before the result — so a test can switch models MID-TURN and then release the
 *  outgoing turn's (old-model) result. */
class GatedContextBackend implements AgentBackend {
  readonly id = "claude" as const;
  readonly capabilities = CLAUDE_CAPABILITIES;
  turns: TurnSpec[] = [];
  modelCalls: string[] = [];
  private i = 0;
  private releaseResult: (() => void) | null = null;

  async *run(opts: BackendStartOptions): AsyncGenerator<AgentEvent> {
    yield { type: "session", sessionId: "sess-gated" };
    for await (const turn of opts.channel) {
      void turn;
      const spec = this.turns[this.i++] ?? {};
      if (spec.usage) yield { type: "assistant", text: "", usage: spec.usage };
      await new Promise<void>((resolve) => {
        this.releaseResult = resolve;
      });
      this.releaseResult = null;
      yield {
        type: "result",
        ok: true,
        subtype: "success",
        ...(spec.contextWindow != null ? { contextWindow: spec.contextWindow } : {}),
      };
    }
  }

  releaseTurn(): void {
    const r = this.releaseResult;
    this.releaseResult = null;
    r?.();
  }
  async interrupt(): Promise<void> {
    this.releaseTurn();
  }
  async setModel(model: string): Promise<void> {
    this.modelCalls.push(model);
  }
  async listModels(): Promise<ModelChoice[]> {
    return [];
  }
}

interface CapturedStatus {
  used?: number;
  contextWindow?: number;
  contextPct?: number;
  model?: string;
}

function makeManager(backend: AgentBackend, statuses: CapturedStatus[]) {
  return new PanelAgentManager({
    mcpServers: {},
    systemAppend: "",
    model: "claude-big", // starting model
    onSay: () => {},
    onTurn: () => {},
    onStatus: (_tab: string, status: CapturedStatus) => {
      statuses.push({ ...status });
    },
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

describe("context-meter denominator tracks the CURRENT model's window (#543)", () => {
  it("a SMALLER window reported later replaces the larger one (no max-ratchet)", async () => {
    const backend = new ScriptedContextBackend();
    // Turn 1: a 1M-window model. Turn 2: a 200k-window model, same 100k used.
    backend.turns = [
      { usage: { input_tokens: 100_000 }, contextWindow: 1_000_000 },
      { usage: { input_tokens: 100_000 }, contextWindow: 200_000 },
    ];
    const statuses: CapturedStatus[] = [];
    const manager = makeManager(backend, statuses);
    const tab = "tab-ratchet";

    manager.send(tab, "turn 1");
    await waitFor(() => statuses.some((s) => s.contextWindow === 1_000_000));

    manager.send(tab, "turn 2");
    await waitFor(() => statuses.some((s) => s.contextWindow === 200_000));

    const last = statuses[statuses.length - 1];
    // The denominator SHRANK with the model — 100k / 200k = 0.5, NOT the stale
    // 100k / 1M = 0.1 the old max-ratchet would have kept.
    expect(last.contextWindow).toBe(200_000);
    expect(last.contextPct).toBeCloseTo(0.5, 6);
    // The old max-ratchet would have pinned the denominator at 1M forever; the
    // final reading must reflect the CURRENT (smaller) model, not the largest seen.
    expect(last.contextWindow).not.toBe(1_000_000);
  });

  it("a model switch DROPS the outgoing model's window rather than reusing it", async () => {
    const backend = new ScriptedContextBackend();
    // Turn 1 establishes a 1M window. Turn 2 (after the switch) reports NO window,
    // so any denominator that survives can only be the stale cache.
    backend.turns = [
      { usage: { input_tokens: 100_000 }, contextWindow: 1_000_000 },
      { usage: { input_tokens: 100_000 } }, // no window this turn
    ];
    const statuses: CapturedStatus[] = [];
    const manager = makeManager(backend, statuses);
    const tab = "tab-switch";

    manager.send(tab, "turn 1");
    await waitFor(() => statuses.some((s) => s.contextWindow === 1_000_000));

    // Switch models live — this must clear the cached window.
    await manager.setOptions(tab, { model: "claude-small" });
    expect(backend.modelCalls).toContain("claude-small");

    // Only inspect statuses emitted AFTER the switch.
    statuses.length = 0;
    manager.send(tab, "turn 2");
    await waitFor(() => statuses.some((s) => s.used === 100_000));
    // Give the result event a beat to also land.
    await new Promise((r) => setTimeout(r, 30));

    // Every post-switch status still reports `used`, but NONE reports a denominator
    // (the stale 1M is gone and the new model reported none yet).
    expect(statuses.length).toBeGreaterThan(0);
    for (const s of statuses) {
      expect(s.used).toBe(100_000);
      expect(s.contextWindow).toBeUndefined();
      expect(s.contextPct).toBeUndefined();
    }
  });

  it("a model switched DURING a turn: the outgoing turn's late result does NOT restore the old window", async () => {
    const backend = new GatedContextBackend();
    // Turn 1 (on the big model) will report a 1M window — but only AFTER we've
    // switched to the small model mid-turn. That stale window must be dropped.
    backend.turns = [{ usage: { input_tokens: 100_000 }, contextWindow: 1_000_000 }];
    const statuses: CapturedStatus[] = [];
    const manager = makeManager(backend, statuses);
    const tab = "tab-midturn";

    manager.send(tab, "turn 1");
    // Wait until the assistant event has reported usage (turn is now HELD before result).
    await waitFor(() => statuses.some((s) => s.used === 100_000));

    // Switch models while the (big-model) turn is still in flight.
    await manager.setOptions(tab, { model: "claude-small" });
    expect(backend.modelCalls).toContain("claude-small");

    // Only look at what happens AFTER the switch releases the old-model result.
    statuses.length = 0;
    backend.releaseTurn();
    await waitFor(() => statuses.some((s) => s.used === 100_000));
    await new Promise((r) => setTimeout(r, 30));

    // The late 1M window belonged to the outgoing model — it must NOT become the
    // small model's denominator.
    for (const s of statuses) {
      expect(s.contextWindow).not.toBe(1_000_000);
      expect(s.contextWindow).toBeUndefined();
    }
  });
});
