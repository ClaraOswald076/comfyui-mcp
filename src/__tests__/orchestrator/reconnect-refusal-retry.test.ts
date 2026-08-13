// #1529 — `panel_set_widget` is refused while ComfyUI's backend is reconnecting.
// The refusal is correct (a mutation dispatched in that window lands on a canvas
// the reconnect is about to rebuild) but the caller was left to guess when to
// retry, and two manual attempts hit the same wall.
//
// WHY A MUTATION MAY BE RE-ISSUED HERE, when the rule is that it never may: the
// panel's own gate states the property this depends on —
//
//   "Both refusals are retryable and state that nothing was applied — true
//    because the gate runs BEFORE the executor."
//
// Same licence as #1143's pre-queue Manager refusal: the answer is about the
// REQUEST, so nothing ran, so re-issuing cannot double-apply. It is not a guess
// about timing.
//
// AND WHY IT POLLS RATHER THAN REUSING THE EXISTING RETRY: that path waits
// `retrySettleMs()` — 400ms — and retries once, which fits the workflow-switch
// section it was built for ("a fraction of a second"). A backend reconnect is
// "usually seconds" by the panel's own account, so a single 400ms retry lands in
// the same window and the fix would do NOTHING while looking correct. The
// "recovers after several seconds" case below is the one that catches that.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../comfyui/client.js", () => ({
  getObjectInfo: vi.fn(),
  backfillObjectInfo: vi.fn(),
  resetClient: vi.fn(),
  resetObjectInfoCache: vi.fn(),
}));

const { buildPanelToolDefs, makePanelToolCtx, __panelToolsTestHooks } = await import(
  "../../orchestrator/panel-tools.js"
);
import { WorkflowTargetStore } from "../../services/workflow-target-store.js";
import type { PanelToolCtx, ToolResult } from "../../orchestrator/panel-tools.js";

const TAB = "11111111-2222-3333-4444-555555555555";

const BACKEND_DOWN =
  `[backend-reconnecting] ComfyUI's backend connection is down right now (a restart or ` +
  `reconnect is in progress), so "graph_set_widget" was NOT applied — nothing changed. A graph ` +
  `mutation dispatched in this window can land on a canvas the reconnect is about to rebuild.`;

const SETTLING =
  `[post-reconnect-settling] ComfyUI reconnected moments ago and the panel has not yet ` +
  `re-proven that the canvas is bound to the active workflow, so "graph_set_widget" was NOT ` +
  `applied — nothing changed.`;

let attempts: number;

function bridge(plan: { failures: number; refusal?: string; then?: "ok" | Error }) {
  return {
    send: async (cmd: Record<string, unknown>) => {
      if (cmd.cmd !== "graph_set_widget") return { ok: true };
      attempts++;
      if (attempts <= plan.failures) throw new Error(plan.refusal ?? BACKEND_DOWN);
      if (plan.then instanceof Error) throw plan.then;
      return { applied: true, attempts };
    },
    push: () => 1,
    canReach: (id: string) => id === TAB,
    isHeadless: () => false,
    tabs: () => [{ tab_id: TAB, title: "wf", connected_at: 0 }],
    resolveActiveTabId: () => TAB,
    refreshWorkflowUuid: () => true,
    workflowUuidFor: () => ({ known: true, uuid: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" }),
    tabCanMutateGraph: () => true,
    tabGraphMutationCapability: () => ({ known: true, canMutate: true }),
  } as unknown as PanelToolCtx["bridge"];
}

async function setWidget(plan: Parameters<typeof bridge>[0]) {
  const ctx = makePanelToolCtx(bridge(plan), TAB, new WorkflowTargetStore());
  const def = buildPanelToolDefs().find((d) => d.name === "panel_set_widget");
  if (!def) throw new Error("panel_set_widget is not registered");
  const res: ToolResult = await def.handler(
    { node_id: 605, widget: "video", value: "pritty_013.mp4" } as never,
    ctx,
  );
  return {
    text: res.content.map((c) => (c as { text?: string }).text ?? "").join(" "),
    isError: res.isError === true,
  };
}

beforeEach(() => {
  attempts = 0;
  // Keep the poll fast; the BUDGET is what this suite is about, not the cadence.
  __panelToolsTestHooks.setRetrySettleMs(5);
  // Shrink the BUDGET too, or the give-up case burns the real 12s of wall clock.
  process.env.COMFYUI_PANEL_RECONNECT_RETRY_S = "0.4";
});

describe("a reconnect refusal is waited out, not handed back (#1529)", () => {
  it("applies the mutation once the backend returns", async () => {
    const out = await setWidget({ failures: 2 });

    expect(out.isError).toBe(false);
    // It really retried — without this the assertion would pass on a bridge that
    // simply succeeded first time, proving nothing about the retry.
    expect(attempts).toBe(3);
  });

  it("recovers after SEVERAL seconds, not just one settle interval", async () => {
    // A budget far longer than one settle interval, which is the property at issue.
    process.env.COMFYUI_PANEL_RECONNECT_RETRY_S = "5";
    // The case that catches an inert fix. The pre-existing retry waits 400ms and
    // gives up; a backend reconnect is "usually seconds". With a settle of 5ms
    // here, 40 failures stands in for a reconnect far longer than one interval.
    const out = await setWidget({ failures: 40 });

    expect(out.isError).toBe(false);
    expect(attempts).toBe(41);
  });

  it("waits out the post-reconnect settling refusal too", async () => {
    const out = await setWidget({ failures: 3, refusal: SETTLING });

    expect(out.isError).toBe(false);
    expect(attempts).toBe(4);
  });

  it("STOPS at any other error — that is where the licence ends", async () => {
    // The exception is licensed by "nothing ran". A different error means that is
    // no longer known, and re-issuing past it is the double-apply the allowlist
    // exists to prevent.
    const out = await setWidget({
      failures: 1,
      then: new Error("graph_set_widget failed: no node with id 605"),
    });

    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/no node with id 605/);
    // Exactly one retry, then it stopped rather than hammering.
    expect(attempts).toBe(2);
  });

  it("gives up honestly, in the panel's own words", async () => {
    // A reconnect that never finishes must not be reported as anything other than
    // what it is. The panel's message names the recovery; inventing a verdict here
    // would replace advice that works with a guess.
    const out = await setWidget({ failures: Number.MAX_SAFE_INTEGER });

    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/backend-reconnecting/);
    expect(out.text).toMatch(/nothing changed/);
    expect(attempts).toBeGreaterThan(1);
  });

  it("does NOT retry a refusal that merely mentions reconnecting", async () => {
    // The predicate is anchored on the panel's bracketed marker AND the
    // not-applied claim. An error that only talks about a reconnect — or that
    // wraps this text — must not license re-issuing a mutation.
    const out = await setWidget({
      failures: 1,
      refusal: "relay failed: the backend is reconnecting, so this may not have applied",
    });

    expect(out.isError).toBe(true);
    expect(attempts).toBe(1);
  });
});
