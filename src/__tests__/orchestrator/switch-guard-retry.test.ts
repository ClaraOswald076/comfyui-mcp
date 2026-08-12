// #1027 — rapid read-only inspection across several workflow tabs produced a
// run of confusing errors: "canvas IS bound, but graph does not match loaded
// state", "workflow instance mismatch", "panel is switching/refreshing", and a
// 15s open timeout. The reporter read it as a wedge.
//
// It is a race, and the panel already handles its half correctly. While a
// workflow switch/reload is in flight it refuses every graph and workflow
// executor rather than queueing — refusing cannot reorder or double-apply — and
// says so explicitly:
//
//   the panel is switching/refreshing "<key>" right now, so "<cmd>" was NOT
//   applied — nothing changed. Retry in a moment.
//
// Nothing was applied, and the section lasts a fraction of a second. But that
// text matched none of the orchestrator's transient patterns, so a read issued
// right after panel_open_workflow surfaced the raw refusal instead of waiting
// the ~400ms the panel asked for.
//
// The second half matters as much: when the retry ALSO lands mid-switch, saying
// "still reconnecting after a restart/reload" would repeat #1001 exactly — the
// tab is connected and healthy, it is simply mid-switch.

import { beforeEach, describe, expect, it } from "vitest";

import {
  makePanelToolCtx,
  __panelToolsTestHooks,
  type PanelToolCtx,
  type ToolResult,
} from "../../orchestrator/panel-tools.js";
import { resetSwitchHolds } from "../../orchestrator/switch-hold.js";

const textOf = (res: ToolResult): string => (res.content[0] as { text: string }).text;

/** Verbatim from the panel's activeWorkflowReloadGuard branch. */
function switchGuardError(cmd = "graph_outline"): Error {
  return new Error(
    `the panel is switching/refreshing "wf:workflows/a.json" right now, so "${cmd}" ` +
      `was NOT applied — nothing changed. Retry in a moment.`,
  );
}

let attempts: number;

/** Fails the first `failures` sends with the switch guard, then succeeds. */
function bridgeFailing(failures: number, err: () => Error = switchGuardError) {
  attempts = 0;
  return {
    send: async () => {
      attempts += 1;
      if (attempts <= failures) throw err();
      return { ok: true, nodes: [] };
    },
    push: () => 1,
    canReach: () => true,
    isHeadless: () => false,
    tabs: () => [{ tab_id: "tab-1", title: "wf", connected_at: 0 }],
    resolveActiveTabId: () => "tab-1",
  } as unknown as PanelToolCtx["bridge"];
}

beforeEach(() => {
  __panelToolsTestHooks.setRetrySettleMs(0); // the real wait is ~400ms
  resetSwitchHolds(); // panel#1097 — the run is per tab and outlives one call
});

describe("#1027: a mid-switch refusal is retried, not surfaced", () => {
  it("retries a read that landed during the switch, and succeeds", async () => {
    const ctx = makePanelToolCtx(bridgeFailing(1), "tab-1");
    const res = await ctx.call({ cmd: "graph_outline" });
    expect(res.isError).toBeFalsy();
    expect(attempts).toBe(2); // refused once, then applied
  });

  it("does not re-issue a MUTATING command on its own initiative", async () => {
    const ctx = makePanelToolCtx(bridgeFailing(1), "tab-1");
    const res = await ctx.call({ cmd: "graph_add_node", class_type: "KSampler" });
    expect(res.isError).toBe(true);
    expect(attempts).toBe(1); // never retried — that is the double-apply rule
  });
});

describe("#1027: when the retry ALSO lands mid-switch", () => {
  it("does not call a connected panel 'reconnecting' — the #1001 mistake", async () => {
    const ctx = makePanelToolCtx(bridgeFailing(99), "tab-1");
    const text = textOf(await ctx.call({ cmd: "graph_outline" }));
    expect(text).not.toContain("still reconnecting");
    expect(text).not.toContain("restart/reload");
  });

  it("names the actual state, and that nothing was applied", async () => {
    const ctx = makePanelToolCtx(bridgeFailing(99), "tab-1");
    const text = textOf(await ctx.call({ cmd: "graph_outline" }));
    expect(text).toContain("was NOT applied");
    expect(text).toContain("switching or reloading");
    expect(text).toContain("this is not a");
    // The one thing that would genuinely explain a stuck switch.
    expect(text).toContain("unsaved-changes");
  });

  it("preserves the panel's own words for the reader", async () => {
    const ctx = makePanelToolCtx(bridgeFailing(99), "tab-1");
    expect(textOf(await ctx.call({ cmd: "graph_outline" }))).toContain(
      "panel is switching/refreshing",
    );
  });
});

describe("#1027: the other refusals keep their own handling", () => {
  it("a genuine reconnect still reports as a reconnect", async () => {
    const ctx = makePanelToolCtx(
      bridgeFailing(99, () => new Error('no connected tab with id "tab-1". Connected: none')),
      "tab-1",
    );
    const text = textOf(await ctx.call({ cmd: "graph_outline" }));
    expect(text).toContain("still reconnecting");
    expect(text).not.toContain("switching or reloading");
  });

  // An instance mismatch is NOT retryable: the stamp names a workflow that is no
  // longer active, and waiting cannot change that. Retrying it would burn a round
  // trip and then report the same thing.
  it("an instance mismatch is not retried", async () => {
    const ctx = makePanelToolCtx(
      bridgeFailing(99, () =>
        new Error(
          "workflow instance mismatch: this command targets a different workflow than the active canvas",
        ),
      ),
      "tab-1",
    );
    const res = await ctx.call({ cmd: "graph_outline" });
    expect(res.isError).toBe(true);
    expect(attempts).toBe(1);
  });
});

describe("panel#1097: a switch that never clears stops reading like one that will", () => {
  // The reporter retried into this refusal indefinitely. Every one of them said
  // "it normally clears in well under a second, so simply retry", because nothing
  // timed the RUN — so the tool could not notice its own advice failing.
  it("says nothing extra while the hold is still momentary", async () => {
    const ctx = makePanelToolCtx(bridgeFailing(99), "tab-1");
    const text = textOf(await ctx.call({ cmd: "graph_outline" }));
    expect(text).toContain("still switching or reloading");
    expect(text).not.toContain("HELD FOR");
  });

  it("reports the hold once a run of refusals contradicts that advice", async () => {
    const ctx = makePanelToolCtx(bridgeFailing(99), "tab-1");
    // Each call refuses twice (initial + the one retry), so the run builds.
    await ctx.call({ cmd: "graph_outline" });
    await new Promise((r) => setTimeout(r, 3100)); // past the "worth saying" floor
    const text = textOf(await ctx.call({ cmd: "graph_outline" }));

    expect(text).toContain("HELD FOR");
    expect(text).toContain("waiting for a person");
    expect(text).toContain("no number of retries will clear it");
  }, 15_000);

  it("a SUCCESS between refusals resets the run — the age is not cumulative", async () => {
    const ctx = makePanelToolCtx(bridgeFailing(99), "tab-1");
    await ctx.call({ cmd: "graph_outline" });
    await new Promise((r) => setTimeout(r, 3100));

    // A command that lands clears the hold…
    const okCtx = makePanelToolCtx(bridgeFailing(0), "tab-1");
    expect((await okCtx.call({ cmd: "graph_outline" })).isError).toBeFalsy();

    // …so the next refusal is a fresh, momentary one again.
    const after = textOf(await makePanelToolCtx(bridgeFailing(99), "tab-1").call({ cmd: "graph_outline" }));
    expect(after).not.toContain("HELD FOR");
  }, 15_000);
});
