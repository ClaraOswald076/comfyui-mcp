// #1292 — A RECOVERY OPERATION THAT TELLS YOU TO RETRY IT HAS NOT FINISHED
// RECOVERING.
//
// Immediately after panel_restart_comfyui and the tab's reconnect, the panel is
// mid-reconciliation: it answers workflow_list, but marks its active record
// UNCONFIRMED. Corroboration correctly refuses to adopt through that — a stale
// or mixed reply can carry ANOTHER canvas's perfectly valid uuid, and stamping
// it would wedge the tab while reporting `bound`.
//
// So the refusal is right. What was wrong is who paid for it. The caller got a
// hard failure whose own remedy was "call this again in a moment" — and the
// reporter did, five seconds later, and the identical call returned
// `already_current` with no user action in between. The window belongs to the
// operation, not to the caller.
//
// THE CORROBORATION RULE DOES NOT MOVE. Every recheck is judged by the same
// fail-closed test; what a recheck buys is a FRESH SNAPSHOT to judge, never a
// lower bar. The two properties below are therefore inseparable, and both are
// asserted here: the transient window is absorbed, AND a reply that stays
// contradictory is still refused no matter how many times it is re-read.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildPanelToolDefs,
  makePanelToolCtx,
  __panelToolsTestHooks,
  type PanelToolCtx,
  type ToolResult,
} from "../../orchestrator/panel-tools.js";
import { WorkflowTargetStore } from "../../services/workflow-target-store.js";

const TAB = "wf:workflows/a.json";
const STALE = "11111111-1111-4111-8111-111111111111";
const LIVE = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";

/** Successive workflow_list replies; the last one repeats once exhausted. */
let listReplies: Array<Record<string, unknown>>;
let listCalls: number;
let stamp: string | undefined;

/** A healthy, self-corroborating reply: the active record also appears in the
 *  open-workflow list flagged active. */
function settled(uuid: string): Record<string, unknown> {
  const active = { path: "workflows/a.json", routing_key: "wf:workflows/a.json", workflow_uuid: uuid };
  return { active, workflows: [{ ...active, active: true }], active_confirmed: true };
}

/** The reporter's shape: the panel answers, but says its own active record is
 *  NOT confirmed — the post-restart reconciliation window. */
function reconciling(): Record<string, unknown> {
  const active = { path: "workflows/a.json", routing_key: "wf:workflows/a.json", workflow_uuid: LIVE };
  return { active, workflows: [{ ...active, active: true }], active_confirmed: false };
}

function bridge() {
  return {
    send: async (cmd: Record<string, unknown>) => {
      if (cmd.cmd === "workflow_list") {
        const n = listCalls;
        listCalls += 1;
        return listReplies[Math.min(n, listReplies.length - 1)];
      }
      return { ok: true };
    },
    push: () => 1,
    canReach: (id: string) => id === TAB,
    isHeadless: () => false,
    tabs: () => [{ tab_id: TAB, title: "wf", connected_at: 0 }],
    resolveActiveTabId: () => TAB,
    refreshWorkflowUuid: (_tabId: string, uuid: string) => {
      stamp = uuid;
      return true;
    },
    workflowUuidFor: () => ({ known: true, uuid: stamp }),
    tabCanMutateGraph: () => true,
    tabGraphMutationCapability: () => ({ known: true, canMutate: true }),
  } as unknown as PanelToolCtx["bridge"];
}

async function setCurrent(): Promise<{ res: ToolResult; text: string }> {
  const ctx = makePanelToolCtx(bridge(), TAB, new WorkflowTargetStore());
  const def = buildPanelToolDefs().find((d) => d.name === "panel_set_workflow_target");
  if (!def) throw new Error("panel_set_workflow_target is not registered");
  const res: ToolResult = await def.handler({ mode: "current" }, ctx);
  return { res, text: (res.content[0] as { text: string }).text };
}

beforeEach(() => {
  listCalls = 0;
  stamp = STALE;
});

describe("mode:'current' absorbs the post-restart reconciliation window (#1292)", () => {
  it("RECOVERS when the panel settles on a later read — the reported case", async () => {
    // Exactly the report: UNCONFIRMED immediately after the restart, correct on
    // the next read. Before this fix the caller saw a hard failure here and had
    // to make the identical call again themselves.
    listReplies = [reconciling(), settled(LIVE)];

    const { res, text } = await setCurrent();

    expect(stamp, "the live canvas's identity was adopted").toBe(LIVE);
    expect(res.isError).toBeFalsy();
    expect(text).toMatch(/"graph_binding": "bound"/);
    // It re-read rather than reasoning its way past the refusal — and STOPPED at
    // the read that succeeded. No further round trip happens between the read we
    // corroborated and the stamp we write from it, which is what keeps the
    // adopted record and the tab being stamped the same tab (codex review, P1).
    expect(listCalls, "one recheck, then adopt — no read after the good one").toBe(2);
  });

  it("recovers from a MIXED list too — same window, different symptom", async () => {
    // Two entries flagged active is the other face of a half-reconciled panel.
    const active = { path: "workflows/a.json", routing_key: "wf:workflows/a.json", workflow_uuid: LIVE };
    listReplies = [
      {
        active,
        workflows: [
          { ...active, active: true },
          { path: "workflows/b.json", routing_key: "wf:workflows/b.json", active: true },
        ],
      },
      settled(LIVE),
    ];

    const { res } = await setCurrent();

    expect(stamp).toBe(LIVE);
    expect(res.isError).toBeFalsy();
  });

  it("does NOT wait when the FIRST read already corroborates", async () => {
    // The common path must not pay for the rare one.
    listReplies = [settled(LIVE)];

    const started = Date.now();
    const { res } = await setCurrent();

    expect(res.isError).toBeFalsy();
    expect(stamp).toBe(LIVE);
    expect(listCalls, "one read is enough when it answers cleanly").toBe(1);
    expect(Date.now() - started, "no recheck delay on the happy path").toBeLessThan(400);
  });

  // ---------------------------------------------------------------------------
  // The half that makes the retry safe. A recheck must buy a fresh snapshot to
  // judge — never a lower bar to clear.
  // ---------------------------------------------------------------------------

  it("STILL REFUSES a reply that never settles — the bar does not drop with attempts", async () => {
    // A permanently contradictory reply: the active record names canvas B while
    // the panel's own list says A is active. Re-reading it four times must not
    // make the fourth answer more adoptable than the first.
    const active = { path: "workflows/b.json", routing_key: "wf:workflows/b.json", workflow_uuid: OTHER };
    listReplies = [
      { active, workflows: [{ path: "workflows/a.json", routing_key: "wf:workflows/a.json", active: true }] },
    ];

    const { res, text } = await setCurrent();

    expect(stamp, "the other canvas's uuid never reached the fence").toBe(STALE);
    expect(res.isError).toBe(true);
    expect(text).not.toMatch(/"graph_binding": "bound"/);
    expect(listCalls, "it did recheck — and still refused").toBeGreaterThan(1);
  });

  it("REFUSES an UNCONFIRMED record that never becomes confirmed", async () => {
    // The reporter's exact symptom, but permanent. The refusal is the same one
    // #514 installed; only the number of attempts before it changed.
    listReplies = [reconciling()];

    const { res, text } = await setCurrent();

    expect(stamp).toBe(STALE);
    expect(res.isError).toBe(true);
    expect(text).toMatch(/UNCONFIRMED/);
    // #2059 — UNCONFIRMED keeps the short 3-step budget; the longer missing-active
    // wait must not leak onto this path or this recovery gets slower for nothing.
    expect(listCalls, "1 initial + 3 short rechecks").toBe(4);
  });

  it("STOPS PRESCRIBING the retry it just performed", async () => {
    // The old remedy was "call this again in a moment". After four rechecks over
    // ~2.9s that is the least likely thing left to work, and it reads as though
    // nothing was tried. Report what was done, then name the remedy that has not
    // been.
    listReplies = [reconciling()];

    const { text } = await setCurrent();

    expect(text).toMatch(/ALREADY TRIED: the panel was re-read \d+ times over ~\d/);
    expect(text).not.toMatch(/call this again in a moment/);
    // The remedy that HAS not been tried is the one offered.
    expect(text).toMatch(/manually refresh/);
  });

  // ---------------------------------------------------------------------------
  // Rechecking a fact that CANNOT change is just a slower version of the same
  // error (codex review, P2). The split is snapshot-vs-shape, not failure-vs-
  // success: what is open and which entry is flagged can change in 400ms; which
  // FIELDS a build sends cannot.
  // ---------------------------------------------------------------------------

  it("does NOT recheck a reply whose SHAPE can never corroborate", async () => {
    // An older panel that sends no open-workflow list at all. Every later read
    // says exactly the same thing, so the rechecks would only add ~2.9s to an
    // error the caller was going to get anyway.
    const active = { path: "workflows/a.json", routing_key: "wf:workflows/a.json", workflow_uuid: LIVE };
    listReplies = [{ active }];

    const started = Date.now();
    const { text } = await setCurrent();

    expect(listCalls, "nothing to wait for — one read").toBe(1);
    expect(Date.now() - started).toBeLessThan(400);
    expect(stamp, "still refused — not rechecking is not accepting").toBe(STALE);
    // …and the remedy stops promising that waiting helps.
    expect(text).toMatch(/WHY RETRYING WILL NOT HELP/);
    expect(text).not.toMatch(/call this again in a moment/);
  });

  it("DOES recheck an EMPTY open-workflow list — that one is a snapshot", async () => {
    // The neighbouring case, and the reason the two are not folded: an absent
    // `workflows` field is a property of the build, an empty one is a mid-restore
    // panel that has not re-listed its tabs yet.
    const active = { path: "workflows/a.json", routing_key: "wf:workflows/a.json", workflow_uuid: LIVE };
    listReplies = [{ active, workflows: [] }, settled(LIVE)];

    const { res } = await setCurrent();

    expect(listCalls).toBe(2);
    expect(stamp).toBe(LIVE);
    expect(res.isError).toBeFalsy();
  });

  it("does not recheck a panel that reports NO identity — a different failure", async () => {
    // `no_uuid` means the installed pack exposes no workflow identity at all.
    // Rechecking a build that will never answer differently only makes the same
    // error slower, and its remedy (update the panel) is unrelated to settling.
    const active = { path: "workflows/a.json", routing_key: "wf:workflows/a.json" };
    listReplies = [{ active, workflows: [{ ...active, active: true }], active_confirmed: true }];

    const { text } = await setCurrent();

    expect(listCalls, "one read — there is nothing to wait for").toBe(1);
    expect(text).toMatch(/must be UPDATED/);
    expect(text).not.toMatch(/ALREADY TRIED/);
  });
});

/**
 * #2059 — after panel_restart_comfyui the sidebar can hello and answer
 * workflow_list with NO top-level `active` record. The ordinary 3-step / ~2.9s
 * window (1 initial + 3 rechecks = 4 reads) exhausted and left the session
 * fenced to the previous instance. Rechecks for that reason now run longer,
 * and a reconnect that replaces the tab mid-wait restarts the budget for the
 * newly connected tab.
 */
function noActive(): Record<string, unknown> {
  return {
    workflows: [{ path: "workflows/a.json", routing_key: "wf:workflows/a.json", active: true }],
    active_confirmed: true,
  };
}

describe("mode:'current' waits for a missing active-workflow record after restart (#2059)", () => {
  afterEach(() => {
    __panelToolsTestHooks.setFenceMissingActiveRecheckSteps(null);
    __panelToolsTestHooks.setFenceCorroborationRecheckSteps(null);
  });

  it("RECOVERS when the active record appears after the old 4-read window — the reported case", async () => {
    // Four replies with no `active` is exactly what the 2.9s budget used to
    // exhaust. The fifth is the record the frontend publishes once restore
    // finishes. Shrunk so the suite does not wait the real extra seconds.
    __panelToolsTestHooks.setFenceMissingActiveRecheckSteps([5, 5, 5, 5]);
    listReplies = [noActive(), noActive(), noActive(), noActive(), settled(LIVE)];

    const { res, text } = await setCurrent();

    expect(stamp, "the live canvas's identity was adopted").toBe(LIVE);
    expect(res.isError).toBeFalsy();
    expect(text).toMatch(/"graph_binding": "bound"/);
    expect(listCalls, "four misses, then the fifth read that carries active").toBe(5);
  });

  it("STILL REFUSES a permanently missing active record after the longer wait", async () => {
    __panelToolsTestHooks.setFenceMissingActiveRecheckSteps([5, 5, 5, 5]);
    listReplies = [noActive()];

    const { res, text } = await setCurrent();

    expect(stamp).toBe(STALE);
    expect(res.isError).toBe(true);
    expect(text).toMatch(/no active-workflow record/);
    expect(text).toMatch(/ALREADY TRIED: the panel was re-read 5 times/);
    expect(listCalls).toBe(5);
  });

  it("restarts the wait when a newly connected tab replaces the socket mid-retry", async () => {
    // Three rechecks — the ORIGINAL budget. Without tab-keying, the 4th read
    // (new tab, still no active) would exhaust it and never see the 5th.
    __panelToolsTestHooks.setFenceMissingActiveRecheckSteps([5, 5, 5]);

    const OLD = "wf:workflows/old.json";
    const NEW = "wf:workflows/a.json";
    let liveTab = OLD;
    let generation = 1;

    const tabBridge = {
      send: async (cmd: Record<string, unknown>) => {
        if (cmd.cmd === "workflow_list") {
          const n = listCalls;
          listCalls += 1;
          if (n === 2) {
            // After the 3rd reply the old socket is gone; the next call's
            // ensureReachable rebinds onto the newly connected tab.
            liveTab = NEW;
            generation = 2;
          }
          if (liveTab === NEW && n >= 4) return settled(LIVE);
          return noActive();
        }
        return { ok: true };
      },
      push: () => 1,
      canReach: (id: string) => id === liveTab,
      isHeadless: () => false,
      tabs: () => [{ tab_id: liveTab, title: "wf", connected_at: 0 }],
      resolveActiveTabId: () => liveTab,
      tabConnectionIdentity: () => ({ generation, tabSessionId: "browser-tab-a" }),
      refreshWorkflowUuid: (_tabId: string, uuid: string) => {
        stamp = uuid;
        return true;
      },
      workflowUuidFor: () => ({ known: true, uuid: stamp }),
      tabCanMutateGraph: () => true,
      tabGraphMutationCapability: () => ({ known: true, canMutate: true }),
    } as unknown as PanelToolCtx["bridge"];

    const ctx = makePanelToolCtx(tabBridge, OLD, new WorkflowTargetStore());
    const def = buildPanelToolDefs().find((d) => d.name === "panel_set_workflow_target");
    if (!def) throw new Error("panel_set_workflow_target is not registered");
    const res: ToolResult = await def.handler({ mode: "current" }, ctx);
    const text = (res.content[0] as { text: string }).text;

    expect(ctx.tabId, "session rebound onto the newly connected tab").toBe(NEW);
    expect(stamp, "the new tab's live identity was adopted").toBe(LIVE);
    expect(res.isError).toBeFalsy();
    expect(text).toMatch(/"graph_binding": "bound"/);
    expect(listCalls, "old tab exhausted the original budget; new tab got its own wait").toBe(5);
  });
});
