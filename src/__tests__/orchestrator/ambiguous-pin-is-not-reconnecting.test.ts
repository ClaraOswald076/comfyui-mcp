// #1001 — a turn issued from several workflows at once was reported as a panel
// that is "still reconnecting after a restart/reload".
//
// The two conditions are opposites. The ambiguity refusal fires when every tab
// is connected and healthy but no single one is honestly "the" target (#884);
// the reconnect wording is for the post-restart window when NO tab is reachable.
// They were conflated because the refusal's message opens with the literal
// phrase "no connected tab can be chosen for …", and the transient classifier
// was a substring match on /no connected tab/.
//
// Two consequences, both visible in the report:
//   1. A retry-safe read (graph_outline, workflow_list) took the post-reconnect
//      retry branch: sleep, rebind, re-dispatch — guaranteed to fail
//      identically, because the pin is decided once per batch and does not heal
//      on a clock.
//   2. The final message asserted the panel was still reconnecting. It was not.
//      The reporter believed it and filed "reconnect readiness is reported
//      before the graph tool route is usable" as a second, independent root
//      cause — citing that sentence as their evidence. There was no second bug;
//      there was one speculative sentence presented as an observation.
//
// The fix is a typed marker, mirroring the capability-refusal precedent (#709)
// which solved the same shape: an error whose own text already names its cause
// and its recovery must not be wrapped in a guess.
//
// The ctx under test is the REAL makePanelToolCtx — the classifier and the
// wrapper are both module-private, and testing them directly would not prove
// they are wired to the path the reporter actually hit.

import { describe, expect, it } from "vitest";

import {
  makePanelToolCtx,
  type PanelToolCtx,
  type ToolResult,
} from "../../orchestrator/panel-tools.js";
import { markDispatched, markRoutingAmbiguity } from "../../services/ui-bridge.js";

const textOf = (res: ToolResult): string => (res.content[0] as { text: string }).text;

/**
 * The refusal the bridge really produces: resolveTarget throws it, and send()'s
 * catch tags the SAME object dispatched:false. Both markers therefore ride along
 * together, exactly as in production.
 */
function ambiguityRefusal(scope = "orchestrator::codex"): Error {
  return markDispatched(
    markRoutingAmbiguity(
      new Error(
        `no connected tab can be chosen for "${scope}": the current turn was issued from ` +
          `multiple workflows at once, so its target is ambiguous. Target a workflow ` +
          `explicitly (panel_set_workflow_target / panel_open_workflow) or wait for the ` +
          `next single-origin message.`,
      ),
    ),
    false,
  );
}

/** The genuine post-restart window — same opening phrase, opposite cause. */
function connectedNone(): Error {
  return markDispatched(
    new Error(`no connected tab with id "tab-1". Connected: none — refresh the ComfyUI browser tab`),
    false,
  );
}

/**
 * A bridge that counts send attempts, so "was it retried?" is observable rather
 * than inferred from wording. Two tabs are reported connected: the ambiguity
 * case is defined by tabs being healthy, and a single-tab bridge would let the
 * strict-single auto-heal muddy what is being measured.
 */
function countingBridge(fail: () => Error) {
  const calls: string[] = [];
  const bridge = {
    send: async (cmd: Record<string, unknown>) => {
      calls.push(String(cmd.cmd));
      throw fail();
    },
    push: () => 1,
    canReach: () => true,
    isHeadless: () => false,
    tabs: () => [
      { tab_id: "tab-1", title: "video_minimax_h3_t2v", connected_at: 0 },
      { tab_id: "tab-2", title: "other_workflow", connected_at: 0 },
    ],
    resolveActiveTabId: () => "tab-1",
  } as unknown as PanelToolCtx["bridge"];
  return { bridge, calls };
}

describe("#1001: an ambiguous pin is not a reconnecting panel", () => {
  it("does not retry a read whose pin is ambiguous — waiting cannot clear it", async () => {
    const { bridge, calls } = countingBridge(ambiguityRefusal);
    const ctx = makePanelToolCtx(bridge, "tab-1");
    const res = await ctx.call({ cmd: "graph_outline" });

    expect(res.isError).toBe(true);
    // ONE attempt. The old behaviour slept ~400ms, rebound, and dispatched a
    // second time — an identical failure by construction.
    expect(calls).toEqual(["graph_outline"]);
  });

  it("never claims the panel is reconnecting when every tab is connected", async () => {
    const { bridge } = countingBridge(ambiguityRefusal);
    const ctx = makePanelToolCtx(bridge, "tab-1");
    const text = textOf(await ctx.call({ cmd: "graph_outline" }));

    // The fabricated diagnosis the reporter filed as a second root cause.
    expect(text).not.toContain("still reconnecting");
    expect(text).not.toContain("restart/reload");
    // …nor the other two speculative causes from the generic differential.
    expect(text).not.toContain("may be disconnected");
    expect(text).not.toContain("Retry in a moment");
  });

  it("surfaces the real cause and both real recoveries verbatim", async () => {
    const { bridge } = countingBridge(ambiguityRefusal);
    const ctx = makePanelToolCtx(bridge, "tab-1");
    const text = textOf(await ctx.call({ cmd: "graph_outline" }));

    expect(text).toContain("issued from multiple workflows at once");
    expect(text).toContain("panel_set_workflow_target");
    expect(text).toContain("next single-origin message");
    // dispatched:false is authoritative — resolveTarget throws before any write.
    expect(text).toContain("nothing was applied");
  });

  it("holds for the other tool the reporter called (workflow_list)", async () => {
    const { bridge, calls } = countingBridge(ambiguityRefusal);
    const ctx = makePanelToolCtx(bridge, "tab-1");
    const text = textOf(await ctx.call({ cmd: "workflow_list" }));

    expect(calls).toEqual(["workflow_list"]);
    expect(text).not.toContain("still reconnecting");
  });
});

describe("#1001: narrowing must not cost the genuine reconnect handling", () => {
  // The post-restart window uses the SAME opening phrase deliberately — it is
  // the machine-readable marker the retry machinery keys on. If this regresses,
  // every real reconnect stops being retried, which is far worse than the bug
  // being fixed.
  it("still retries a read during the real Connected:none window", async () => {
    const { bridge, calls } = countingBridge(connectedNone);
    const ctx = makePanelToolCtx(bridge, "tab-1");
    const res = await ctx.call({ cmd: "graph_outline" });

    expect(res.isError).toBe(true);
    expect(calls).toEqual(["graph_outline", "graph_outline"]);
  });

  it("still names the reconnect when that is genuinely the cause", async () => {
    const { bridge } = countingBridge(connectedNone);
    const ctx = makePanelToolCtx(bridge, "tab-1");
    expect(textOf(await ctx.call({ cmd: "graph_outline" }))).toContain("still reconnecting");
  });
});
