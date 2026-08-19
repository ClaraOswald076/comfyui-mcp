// #1519 — a live graph READ refused by the workflow fence said nothing about how to fix it,
// and the two states behind that refusal are not the same state.
//
// The reporter's session resumed onto a different workflow and the first live-canvas read
// came back
//
//   workflow instance mismatch: this command carries no workflow-instance stamp, and the
//   active canvas reports 2b3f4684-…. Nothing was applied.
//
// MEASURED on main before this change: that sentence was the ENTIRE tool result. The
// corroboration #1330 added is gated on `isMutatingGraphCmd`, so a READ refused by the very
// same fence fell through every branch of the catch and the panel's raw refusal was
// surfaced verbatim — no verdict, no remedy. The reporter found
// `panel_set_workflow_target({mode:"current"})` themselves; that discovery is the report.
//
// TWO REFUSALS, NOT ONE — the part these assertions exist to pin. `isWorkflowInstanceMismatch`
// matches both of the panel's states and they have OPPOSITE remedies:
//
//   "carries no workflow-instance stamp"  → no identity at all. Nothing was compared.
//                                           Deriving a fence from the live canvas fixes it.
//   "issued for workflow instance <uuid>" → an identity the canvas disagrees with. Deriving
//                                           a fence from the live canvas ABANDONS the
//                                           workflow the caller named (the retarget #1646
//                                           removed for cause).
//
// So each case asserts its OWN remedy AND asserts the other case's remedy is absent. A
// verdict that merely mentioned rebinding would satisfy a one-sided test while re-collapsing
// the two states, which is the defect this issue is about.
//
// THE FENCE IS NOT MOVED. Every case asserts `refreshWorkflowUuid` was never called: the probe
// is the read-only one, the refusal still fails the call, and the caller decides.

import { beforeEach, describe, expect, it } from "vitest";

import {
  buildPanelToolDefs,
  makePanelToolCtx,
  type PanelToolCtx,
  type ToolResult,
} from "../../orchestrator/panel-tools.js";
import { WorkflowTargetStore } from "../../services/workflow-target-store.js";

const TAB = "wf:workflows/a.json";
const LIVE = "2b3f4684-b7e7-495b-a7a1-f40439e35e0a"; // what the canvas reports
const STALE = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa"; // a fence that has gone stale

let listCalls: number;
let adopted: string[];
let fence: { known: boolean; uuid?: string };

/** A self-corroborating workflow_list reply: the active record also appears in the
 *  open-workflow list flagged active, which is what corroboration requires. */
function settled(uuid: string | null): Record<string, unknown> {
  const active: Record<string, unknown> = {
    path: "workflows/a.json",
    routing_key: TAB,
    ...(uuid ? { workflow_uuid: uuid } : {}),
  };
  return { active, workflows: [{ ...active, active: true }], active_confirmed: true };
}

/**
 * `issuedFor` — what the panel's refusal states: a uuid (the WRONG-stamp wording) or
 * `null` (the MISSING-stamp wording). `liveUuid` — what workflow_list reports for the
 * live canvas, `null` for a canvas that has no identity of its own. `probeRefused` —
 * a build predating panel #759 that fences the recovery probe too.
 */
function bridge(opts: { issuedFor: string | null; liveUuid: string | null; probeRefused?: boolean }) {
  const refusal =
    `workflow instance mismatch: ` +
    (opts.issuedFor
      ? `this command was issued for workflow instance ${opts.issuedFor}`
      : `this command carries no workflow-instance stamp`) +
    `, and the active canvas reports ${LIVE}. Nothing was applied.`;
  return {
    send: async (cmd: Record<string, unknown>) => {
      if (cmd.cmd === "workflow_list") {
        listCalls += 1;
        // A build predating panel #759 fences the recovery probe too. It must
        // surface its own refusal, NOT re-enter the diagnosis that called it.
        if (opts.probeRefused) throw new Error(refusal);
        return settled(opts.liveUuid);
      }
      throw new Error(refusal);
    },
    push: () => 1,
    canReach: (id: string) => id === TAB,
    isHeadless: () => false,
    tabs: () => [{ tab_id: TAB, title: "wf", connected_at: 0 }],
    resolveActiveTabId: () => TAB,
    refreshWorkflowUuid: (_tabId: string, uuid: string) => {
      adopted.push(uuid);
      return true;
    },
    workflowUuidFor: () => fence,
    tabCanMutateGraph: () => true,
    tabGraphMutationCapability: () => ({ known: true, canMutate: true }),
  } as unknown as PanelToolCtx["bridge"];
}

/** Drive a real READ tool (panel_graph_outline) through the real ctx.call path. */
async function outline(
  opts: { issuedFor: string | null; liveUuid: string | null; probeRefused?: boolean },
  store = new WorkflowTargetStore(),
): Promise<string> {
  const ctx = makePanelToolCtx(bridge(opts), TAB, store);
  const def = buildPanelToolDefs().find((d) => d.name === "panel_graph_outline");
  if (!def) throw new Error("panel_graph_outline is not registered");
  const res: ToolResult = await def.handler({} as never, ctx);
  return res.content.map((c) => (c as { text?: string }).text ?? "").join(" ");
}

/** The remedy that is right ONLY for an absent stamp. */
const REBIND = /panel_set_workflow_target\(\{mode:"current"\}\) derives this session's fence/;
/** The remedy that is right ONLY for a wrong stamp. */
const CHOOSE = /to read the workflow you issued for, bring it back with panel_open_workflow/;

beforeEach(() => {
  listCalls = 0;
  adopted = [];
  fence = { known: true, uuid: undefined }; // definitively NOT fenced — #1519's state
});

describe("a fenced graph READ is diagnosed, and a missing stamp is not a wrong one (#1519)", () => {
  it("MISSING STAMP: says the stamp was absent and names the rebind that mints one", async () => {
    const text = await outline({ issuedFor: null, liveUuid: LIVE });

    // The live canvas really was re-read — without this every assertion below could
    // be satisfied by a message that never consulted the panel.
    expect(listCalls).toBeGreaterThan(0);

    expect(text).toMatch(/CHECKED/);
    expect(text).toMatch(/MISSING stamp rather than a wrong one/);
    expect(text).toMatch(REBIND);
    expect(text).toContain(LIVE);
    // The panel's own refusal is preserved verbatim — it is the evidence.
    expect(text).toContain("carries no workflow-instance stamp");
    // The OTHER state's remedy must not appear: there is no workflow this read was
    // "issued for", so telling the caller to bring one back is a fabricated target.
    expect(text).not.toMatch(CHOOSE);
    // The call still FAILS, and the fence was not moved.
    expect(text.startsWith("Error:")).toBe(true);
    expect(adopted).toEqual([]);
  });

  it("WRONG STAMP: names the choice between two real workflows, and NOT the mint-a-stamp rebind", async () => {
    // The collapse this branch must not make. A session that HAS an identity and a
    // canvas that disagrees is a different fact, and mode:"current" abandons the
    // workflow the caller named rather than repairing anything.
    fence = { known: true, uuid: STALE };
    const text = await outline({ issuedFor: STALE, liveUuid: LIVE });

    expect(listCalls).toBeGreaterThan(0);
    expect(text).toMatch(/WRONG stamp, not a missing one/);
    expect(text).toMatch(CHOOSE);
    expect(text).not.toMatch(REBIND);
    // It names BOTH identities, which is the fact the caller has to choose between.
    expect(text).toContain(STALE);
    expect(text).toContain(LIVE);
    // And it discloses what re-targeting costs, rather than presenting it as repair.
    expect(text).toMatch(/re-points every later EDIT/);
    expect(adopted).toEqual([]);
  });

  it("NO IDENTITY ANYWHERE: says the rebind will NOT clear it, and sends the caller to re-open", async () => {
    // #1331's lesson, applied to the read path: when the live canvas has no identity
    // either, mode:"current" reports success while the read keeps failing.
    const text = await outline({ issuedFor: null, liveUuid: null });

    expect(listCalls).toBeGreaterThan(0);
    expect(text).toMatch(/will NOT clear this/);
    expect(text).toMatch(/panel_open_workflow\(<path>\)/);
    expect(text).toMatch(/panel_save_workflow/);
    // The remedy that cannot work here must not be offered as one.
    expect(text).not.toMatch(REBIND);
    expect(adopted).toEqual([]);
  });

  it("PINNED: naming mode:\"current\" also discloses that it releases the pin", async () => {
    // mode:"current" is the right remedy for a missing stamp AND it silently drops a
    // pin. A caller who followed it to fix a read would lose their target and find
    // out by editing the wrong workflow later.
    const store = new WorkflowTargetStore();
    store.set(TAB, { mode: "pinned", path: "workflows/b.json", filename: "b.json" });
    const text = await outline({ issuedFor: null, liveUuid: LIVE }, store);

    expect(text).toMatch(REBIND);
    expect(text).toMatch(/PINNED to b\.json/);
    expect(text).toMatch(/RELEASES that pin/);
    expect(text).toMatch(/panel_open_workflow\("workflows\/b\.json"\)/);
    expect(adopted).toEqual([]);
  });

  it("UNSTATED SHAPE: a refusal that names neither state gets NO remedy invented for it", async () => {
    // The third answer. A panel wording this cannot classify is not evidence for
    // either state, and guessing one would be the collapse in the other direction.
    const ctx = makePanelToolCtx(
      {
        send: async (cmd: Record<string, unknown>) => {
          if (cmd.cmd === "workflow_list") {
            listCalls += 1;
            return settled(LIVE);
          }
          throw new Error("workflow instance mismatch: this command targets a different workflow");
        },
        push: () => 1,
        canReach: (id: string) => id === TAB,
        isHeadless: () => false,
        tabs: () => [{ tab_id: TAB, title: "wf", connected_at: 0 }],
        resolveActiveTabId: () => TAB,
        refreshWorkflowUuid: (_t: string, u: string) => {
          adopted.push(u);
          return true;
        },
        workflowUuidFor: () => fence,
        tabCanMutateGraph: () => true,
        tabGraphMutationCapability: () => ({ known: true, canMutate: true }),
      } as unknown as PanelToolCtx["bridge"],
      TAB,
      new WorkflowTargetStore(),
    );
    const def = buildPanelToolDefs().find((d) => d.name === "panel_graph_outline");
    if (!def) throw new Error("panel_graph_outline is not registered");
    const res: ToolResult = await def.handler({} as never, ctx);
    const text = res.content.map((c) => (c as { text?: string }).text ?? "").join(" ");

    expect(text).toMatch(/is NOT known from here/);
    expect(text).not.toMatch(REBIND);
    expect(text).not.toMatch(CHOOSE);
    expect(adopted).toEqual([]);
  });
});

describe("the #1519 diagnosis cannot re-enter itself, and changes no other path", () => {
  it("a panel that FENCES the recovery probe surfaces its refusal instead of recursing", async () => {
    // The probe this branch runs is `workflow_list`, which flows back through the same
    // catch. A build predating panel #759 fences it too — the branch is keyed on the
    // `graph_` prefix precisely so that reply cannot re-enter the diagnosis. Bounded
    // recursion would show up here as an exploding call count (or a hang), not as
    // wrong wording.
    const text = await outline({ issuedFor: null, liveUuid: LIVE, probeRefused: true });

    expect(listCalls).toBeLessThanOrEqual(4); // one read + at most the #1292 rechecks
    expect(text).toMatch(/UNKNOWN/);
    expect(text).toContain("carries no workflow-instance stamp");
    expect(adopted).toEqual([]);
  }, 20000);

  it("a MUTATION refused by the same fence keeps its own #1330 verdict", async () => {
    // The control. The mutation branch runs first and is untouched: its wording says
    // NOT APPLIED, which is the claim a read must not make and a write must.
    fence = { known: true, uuid: STALE };
    const ctx = makePanelToolCtx(
      bridge({ issuedFor: STALE, liveUuid: LIVE }),
      TAB,
      new WorkflowTargetStore(),
    );
    const def = buildPanelToolDefs().find((d) => d.name === "panel_connect");
    if (!def) throw new Error("panel_connect is not registered");
    const res: ToolResult = await def.handler({ from_node_id: 1, to_node_id: 2 } as never, ctx);
    const text = res.content.map((c) => (c as { text?: string }).text ?? "").join(" ");

    expect(text).toMatch(/NOT applied — nothing changed/);
    expect(text).not.toMatch(/no graph data was read/);
    expect(adopted).toEqual([]);
  });
});
