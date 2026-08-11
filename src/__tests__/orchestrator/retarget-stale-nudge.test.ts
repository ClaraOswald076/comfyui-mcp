// #1429 — a retarget that lands while a tab is MID-TURN cannot replace that tab's
// comfyui MCP child, so the rest of that turn is served by a child still pointed
// at the OLD target. These pin the two halves of telling the agent about it:
//
//   * a tab that DEFERRED gets the nudge (it really did spend a turn stale), and
//   * a tab that was IDLE does NOT (its respawn beat any tool call, so the nudge
//     would be a false alarm — and a nudge is a real agent TURN, not a log line,
//     so a spurious one costs the user a response about nothing).
//
// The second is the direction that fails silently. `onlyWhenDeferred` could be
// ignored entirely and every "does the busy tab get told?" assertion would still
// pass, because the old code delivered the nudge to everyone.

import { describe, expect, it, beforeAll } from "vitest";
import type {
  AgentBackend,
  AgentEvent,
  BackendStartOptions,
  ModelChoice,
} from "../../orchestrator/agent-backend.js";
import { CLAUDE_CAPABILITIES } from "../../orchestrator/agent-backend.js";
import {
  retargetIsWorthNudging,
  retargetRestartArgs,
  staleTargetNudge,
} from "../../orchestrator/retarget-nudge.js";

let PanelAgentManager: typeof import("../../orchestrator/panel-agent.js").PanelAgentManager;

beforeAll(async () => {
  ({ PanelAgentManager } = await import("../../orchestrator/panel-agent.js"));
});

/** Same shape as restart-coalesce.test.ts's backend: records every run() and every
 *  turn text, and can hold a turn open so a tab stays BUSY. */
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

async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}

const NUDGE = staleTargetNudge("http://127.0.0.1:8188", "https://pod-8188.proxy.runpod.net");

describe("#1429 retarget nudge reaches exactly the tabs that were stale", () => {
  it("a MID-TURN tab is told, when its deferred respawn finally lands", async () => {
    const backend = new RecordingBackend();
    backend.autoComplete = false; // hold the first turn open → tab is BUSY
    const manager = makeManager(backend);

    manager.send("tab-busy", "render me something");
    await waitFor(() => backend.turnTexts.length >= 1);

    // The retarget arrives mid-turn: it can only be scheduled.
    const tally = manager.restartAllForMcpEnv(NUDGE, { onlyWhenDeferred: true });
    expect(tally).toEqual({ live: 1, applied: 0, scheduled: 1 });
    // Nothing delivered YET — the turn is still running, and interrupting it to
    // deliver news is not the trade this makes.
    expect(backend.turnTexts).toHaveLength(1);

    backend.autoComplete = true;
    backend.release(); // turn-done → applyPendingRestarts fires the respawn + nudge

    await waitFor(() => backend.turnTexts.includes(NUDGE));
    expect(backend.turnTexts.filter((t) => t === NUDGE)).toHaveLength(1);
  });

  it("an IDLE tab is NOT told — its child was replaced before it could run anything", async () => {
    const backend = new RecordingBackend();
    backend.autoComplete = true; // turn completes at once → tab goes IDLE
    const manager = makeManager(backend);

    manager.send("tab-idle", "hello");
    await waitFor(() => backend.turnTexts.length >= 1);
    // Let the turn finish so the tab is genuinely idle, not merely un-started.
    await new Promise((r) => setTimeout(r, 50));

    const before = backend.turnTexts.length;
    const tally = manager.restartAllForMcpEnv(NUDGE, { onlyWhenDeferred: true });
    // Applied on the spot — so there was never a stale window to report.
    expect(tally.scheduled).toBe(0);
    expect(tally.applied).toBe(1);

    // Give a wrongly-delivered nudge every chance to show up.
    await new Promise((r) => setTimeout(r, 150));
    expect(backend.turnTexts.slice(before)).not.toContain(NUDGE);
    expect(backend.turnTexts).not.toContain(NUDGE);
  });

  it("does NOT erase a per-request retry nudge already queued for that tab (#164)", async () => {
    const backend = new RecordingBackend();
    backend.autoComplete = false;
    const manager = makeManager(backend);

    manager.send("tab-both", "download that model");
    await waitFor(() => backend.turnTexts.length >= 1);

    // A per-request retry nudge is queued first (credentials arrived, #164) …
    expect(manager.restartForMcpEnv("tab-both", "RETRY the download")).toBe("scheduled");
    // … then a retarget lands on the same still-busy tab.
    manager.restartAllForMcpEnv(NUDGE, { onlyWhenDeferred: true });

    backend.autoComplete = true;
    backend.release();

    await waitFor(() => backend.turnTexts.includes("RETRY the download"));
    // The more specific nudge survives; the retarget did not overwrite it, and
    // the tab is not restarted twice to deliver both.
    expect(backend.turnTexts.filter((t) => t === "RETRY the download")).toHaveLength(1);
    expect(backend.turnTexts).not.toContain(NUDGE);
  });

  it("the plain (non-retarget) nudge still reaches an IDLE tab — #164 semantics unchanged", async () => {
    const backend = new RecordingBackend();
    backend.autoComplete = true;
    const manager = makeManager(backend);

    manager.send("tab-plain", "hello");
    await waitFor(() => backend.turnTexts.length >= 1);

    // No onlyWhenDeferred: this nudge means "the thing you just tried can be
    // retried NOW", which is exactly right for an idle tab.
    manager.restartAllForMcpEnv("RETRY");
    await waitFor(() => backend.turnTexts.includes("RETRY"));
  });
});

describe("#1429 nudge wording", () => {
  it("names BOTH addresses — 'the target moved' alone cannot be acted on", () => {
    const msg = staleTargetNudge("http://old:8188", "http://new:8188");
    expect(msg).toContain("http://old:8188");
    expect(msg).toContain("http://new:8188");
  });

  it("says the stale address is a likely cause of a failure in that turn", () => {
    // The reported symptom (#1415-shaped) is a confusing connection failure; an
    // agent that reads this must not conclude ComfyUI is down.
    expect(staleTargetNudge("a", "b").toLowerCase()).toContain("retry");
  });

  it("a first-ever target is a startup seed, not a move — nothing to nudge about", () => {
    expect(retargetIsWorthNudging(null, "http://127.0.0.1:8188")).toBe(false);
    expect(retargetIsWorthNudging(undefined, "http://127.0.0.1:8188")).toBe(false);
    expect(retargetIsWorthNudging("", "http://127.0.0.1:8188")).toBe(false);
  });

  it("a same-address reaffirmation is not a move either", () => {
    expect(retargetIsWorthNudging("http://127.0.0.1:8188", "http://127.0.0.1:8188")).toBe(false);
  });

  it("an actual switch IS worth nudging about", () => {
    expect(retargetIsWorthNudging("http://127.0.0.1:8188", "https://pod.proxy.net")).toBe(true);
  });
});

// The call site is `manager.restartAllForMcpEnv(...retargetRestartArgs(prev, url))`,
// so these ARE the wiring: a change that dropped the flag would have to change
// this function, and these assertions, to get through.
describe("#1429 the arguments the retarget actually passes", () => {
  it("a real switch passes the nudge AND onlyWhenDeferred", () => {
    const args = retargetRestartArgs("http://127.0.0.1:8188", "https://pod.proxy.net");
    expect(args).toHaveLength(2);
    expect(args[0]).toBe(staleTargetNudge("http://127.0.0.1:8188", "https://pod.proxy.net"));
    // Without this flag every idle tab is nudged too — the exact false alarm the
    // deferred-only path exists to prevent.
    expect(args[1]).toEqual({ onlyWhenDeferred: true });
  });

  it("a startup seed passes NOTHING — the plain silent respawn", () => {
    expect(retargetRestartArgs(null, "http://127.0.0.1:8188")).toEqual([]);
  });

  it("a same-address reaffirmation passes nothing either", () => {
    expect(retargetRestartArgs("http://x:8188", "http://x:8188")).toEqual([]);
  });

  it("spreading the empty result is the no-nudge call — not an undefined nudge", () => {
    // `restartAllForMcpEnv(...[])` must be indistinguishable from `…()`, or the
    // #164 nudge-preserving branch (which keys on `nudge === undefined`) changes
    // meaning for every retarget.
    const [nudge, opts] = retargetRestartArgs(null, "http://127.0.0.1:8188");
    expect(nudge).toBeUndefined();
    expect(opts).toBeUndefined();
  });
});
