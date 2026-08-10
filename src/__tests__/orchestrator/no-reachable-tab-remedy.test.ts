// #971 (panel) — the recovery told the caller to do the thing that had just
// failed, using the thing that was missing.
//
// The reporter's trace is a loop:
//
//   1. panel_set_workflow_target(mode:"current")  -> reports `bound`
//   2. panel_set_widget                           -> [root-workflow-uuid-mismatch]
//   3. the prescribed recovery, panel_open_workflow
//        -> "no reachable panel tab yet … or rebind with
//            panel_set_workflow_target({mode:'current'})"
//   4. which is step 1 — and whose only probe is a `workflow_list` call TO A TAB,
//      so it needs exactly what step 3 just said is missing.
//
// The message folded two causes that want opposite advice:
//
//   nothing connected      -> nothing to rebind ONTO; the rebind cannot help
//   connected, none is ours -> the rebind is precisely right
//
// The bridge can tell them apart, so the remedy now matches the cause.

import { describe, expect, it } from "vitest";

import {
  buildPanelToolDefs,
  makePanelToolCtx,
  type PanelToolCtx,
  type ToolResult,
} from "../../orchestrator/panel-tools.js";
import { WorkflowTargetStore } from "../../services/workflow-target-store.js";

const TAB = "wf:workflows/a.json";

/** A bridge that reports `tabs` but never becomes reachable, which is the state
 *  `awaitReachable` gives up on. */
function bridgeWith(tabs: Array<{ tab_id: string; headless?: boolean }>) {
  return {
    send: async () => ({ ok: true }),
    push: () => 1,
    canReach: () => false,
    isHeadless: (id: string) => tabs.find((t) => t.tab_id === id)?.headless === true,
    tabs: () => tabs.map((t) => ({ tab_id: t.tab_id, title: "wf", connected_at: 0 })),
    resolveActiveTabId: () => tabs[0]?.tab_id ?? TAB,
    workflowUuidFor: () => ({ known: false }),
    tabCanMutateGraph: () => true,
    tabGraphMutationCapability: () => ({ known: true, canMutate: true }),
  } as unknown as PanelToolCtx["bridge"];
}

async function openWorkflow(bridge: PanelToolCtx["bridge"]): Promise<string> {
  const ctx = makePanelToolCtx(bridge, TAB, new WorkflowTargetStore());
  // The pre-send reachability wait is what produces this failure; make it give up
  // immediately rather than waiting out the real budget.
  (ctx as { awaitReachable?: () => Promise<boolean> }).awaitReachable = async () => false;
  const def = buildPanelToolDefs().find((d) => d.name === "panel_open_workflow");
  if (!def) throw new Error("panel_open_workflow is not registered");
  const res: ToolResult = await def.handler({ path: "workflows/b.json" }, ctx);
  return (res.content[0] as { text: string }).text;
}

describe("the no-reachable-tab remedy matches its cause (#971)", () => {
  it("NOTHING connected: does not send the caller to a rebind that cannot work", async () => {
    // The reporter's loop. `mode:"current"` re-derives the fence from a
    // `workflow_list` call to a tab — with none connected there is nothing to
    // ask, so offering it is advice that cannot come true.
    const text = await openWorkflow(bridgeWith([]));

    expect(text).toMatch(/NO panel tab is connected at all/);
    expect(text).toMatch(/Rebinding CANNOT help while nothing is connected/);
    // …and it names what does help instead.
    expect(text).toMatch(/Wait for the tab to reconnect|open\/refresh the ComfyUI tab/);
  });

  it("CONNECTED but not ours: the rebind IS the right move, and is offered", async () => {
    // The other half of the old sentence, and here the advice is correct: there
    // is a live tab to re-point the session at.
    const text = await openWorkflow(bridgeWith([{ tab_id: "wf:workflows/other.json" }]));

    expect(text).toMatch(/1 panel tab\(s\) are connected/);
    expect(text).toMatch(/panel_set_workflow_target\(\{mode:"current"\}\)/);
    expect(text).not.toMatch(/CANNOT help/);
  });

  it("headless tabs do not count as something to rebind onto", async () => {
    // A headless tab is not a panel a user is looking at; counting it would give
    // the "rebind onto the live one" advice when there is no live one.
    const text = await openWorkflow(bridgeWith([{ tab_id: "hl:1", headless: true }]));
    expect(text).toMatch(/NO panel tab is connected at all/);
  });

  it("an unreadable bridge keeps the old, cause-neutral wording", async () => {
    // Fail toward what was there before rather than guessing which cause it is:
    // asserting either one would be a claim we cannot support.
    const blind = {
      ...(bridgeWith([]) as object),
      tabs: () => {
        throw new Error("bridge is not enumerable here");
      },
    } as unknown as PanelToolCtx["bridge"];
    const text = await openWorkflow(blind);

    expect(text).toMatch(/no reachable panel tab yet/);
    expect(text).not.toMatch(/NO panel tab is connected at all/);
    expect(text).not.toMatch(/are connected/);
  });

  it("every branch still says NOTHING WAS SENT — that fact must not move", async () => {
    // The pre-send wait exists so a mutating command is not fired into a dead
    // binding. A caller that cannot tell whether it was sent retries blindly,
    // which is the double-apply this guard prevents.
    for (const bridge of [bridgeWith([]), bridgeWith([{ tab_id: "wf:other" }])]) {
      expect(await openWorkflow(bridge)).toMatch(/Nothing was\s+sent/);
    }
  });
});
