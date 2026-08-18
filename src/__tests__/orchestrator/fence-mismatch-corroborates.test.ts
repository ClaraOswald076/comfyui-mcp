// #1330 — a mismatch that clears by itself still cost fourteen refusals.
//
// The reporter built a new workflow: panel_add_node and panel_set_widget succeeded for
// 12 nodes, then EVERY panel_connect was refused with
//
//   workflow instance mismatch: this command was issued for workflow instance
//   3282b824-…, and the active canvas reports cf8f83cd-…. Nothing was applied.
//
// Calling panel_set_workflow_target({mode:"current"}) immediately afterwards reported
// `already_current` naming 3282b824 — the SAME uuid the refused commands carried — and
// every retried connect then succeeded. So the canvas identity flipped and settled back
// while a new unsaved workflow was materialising, and nothing in the refusal separated
// that from "you are genuinely pointed at another workflow".
//
// THE FENCE IS NOT WEAKENED, NOTHING IS AUTO-APPLIED — AND (#1646) THE PROBE IS
// READ-ONLY. The refusal still stands; the orchestrator re-reads the live canvas and
// reports WHICH of the two states it found. What it no longer does is adopt: the first
// version re-derived the fence onto the live canvas when the two genuinely differed,
// so the caller's NEXT mutations were silently re-pointed at the canvas the refusal
// had named as the wrong one. The fence now moves only on an explicit rebind
// (panel_set_workflow_target({mode:"current"}) or a successful open). One informed
// retry replaces fourteen blind ones.
//
// Recommending a retry is safe here specifically because the panel checks the fence
// BEFORE running the handler — "Nothing was applied" is structural, not an echoed claim.

import { beforeEach, describe, expect, it } from "vitest";

import {
  buildPanelToolDefs,
  makePanelToolCtx,
  type PanelToolCtx,
  type ToolResult,
} from "../../orchestrator/panel-tools.js";
import { WorkflowTargetStore } from "../../services/workflow-target-store.js";

const TAB = "wf:workflows/a.json";
const STAMP = "3282b824-5890-4c87-9da4-7936c155aa8c"; // what the command carried
const OTHER = "cf8f83cd-ce65-4307-ad9c-0dc5f5d491d4"; // what the canvas transiently said

let listCalls: number;
let stamp: string | undefined;

/** A self-corroborating workflow_list reply — the active record also appears in the
 *  open-workflow list flagged active, which is what corroboration requires. */
function settled(uuid: string): Record<string, unknown> {
  const active = { path: "workflows/a.json", routing_key: TAB, workflow_uuid: uuid };
  return { active, workflows: [{ ...active, active: true }], active_confirmed: true };
}

/** `liveUuid` is what workflow_list reports the canvas to be when the orchestrator
 *  re-reads it after the refusal. */
function bridge(liveUuid: string | null) {
  return {
    send: async (cmd: Record<string, unknown>) => {
      if (cmd.cmd === "workflow_list") {
        listCalls += 1;
        if (!liveUuid) throw new Error("panel did not answer");
        return settled(liveUuid);
      }
      // Any MUTATING graph command is refused by the panel's fence, exactly as the
      // panel words it (the leading token is preserved deliberately, so it is matched).
      throw new Error(
        `workflow instance mismatch: this command was issued for workflow instance ${STAMP}, ` +
          `and the active canvas reports ${OTHER}. Nothing was applied.`,
      );
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

/** Drive a real MUTATING tool (panel_connect) through the real ctx.call path. */
async function connect(liveUuid: string | null): Promise<string> {
  const ctx = makePanelToolCtx(bridge(liveUuid), TAB, new WorkflowTargetStore());
  const def = buildPanelToolDefs().find((d) => d.name === "panel_connect");
  if (!def) throw new Error("panel_connect is not registered");
  const res: ToolResult = await def.handler(
    { from_node_id: 1, to_node_id: 2 } as never,
    ctx,
  );
  return res.content.map((c) => (c as { text?: string }).text ?? "").join(" ");
}

beforeEach(() => {
  listCalls = 0;
  stamp = STAMP; // the session is fenced to the uuid the command carries
});

describe("a fenced mutation is corroborated before the caller retries blindly (#1330)", () => {
  it("TRANSIENT: the canvas settles back to the stamped id — say so, and retry ONCE", async () => {
    // The reporter's exact state: re-reading finds the fence already names the live
    // canvas, so the disagreement is gone by the time we look.
    const text = await connect(STAMP);

    // The re-derivation really ran — without this the assertions below could all be
    // satisfied by a message that never consulted the panel at all.
    expect(listCalls).toBeGreaterThan(0);

    expect(text).toMatch(/CHECKED/);
    expect(text).toMatch(/TRANSIENT/);
    expect(text).toMatch(/RETRY THIS EXACT CALL ONCE/);
    // The instruction that actually saves the 14 calls.
    expect(text).toMatch(/re-issuing the whole build would duplicate/i);
    // The refusal itself is preserved verbatim — the comparison is the evidence.
    expect(text).toContain(STAMP);
    expect(text).toMatch(/NOT applied — nothing changed/);
    // The transient probe must not have touched the fence either.
    expect(stamp).toBe(STAMP);
  });

  it("GENUINELY DIFFERENT: the fence is NOT re-pointed, and the caller is told which (#1646)", async () => {
    // Not the reporter's case, and it must not be described as transient — telling an
    // agent to retry into a different workflow is how an edit lands on the wrong graph.
    // #1646: the first version of this check RE-DERIVED the fence onto the live canvas
    // here, so every later mutation in the same sequence was accepted against the OTHER
    // tab. The probe now reports the divergence and leaves the fence exactly as it was.
    stamp = STAMP;
    const text = await connect(OTHER);

    expect(listCalls).toBeGreaterThan(0);
    expect(text).toMatch(/NOT re-pointed/);
    expect(text).toContain(OTHER);
    expect(text).toContain(STAMP);
    // Both deliberate recoveries are named; the move is never made for the caller.
    expect(text).toMatch(/panel_open_workflow/);
    expect(text).toMatch(/panel_set_workflow_target\(\{mode:"current"\}\)/);
    expect(text).not.toMatch(/TRANSIENT/);
    expect(text).not.toMatch(/RETRY THIS EXACT CALL ONCE/);
    // THE assertion this issue exists for: the fence still names the workflow the
    // command was issued for, so a later edit in the same sequence is refused
    // rather than mutating the other canvas.
    expect(stamp, "the probe never adopted the live canvas's identity").toBe(STAMP);
  });

  it("a later mutation after a GENUINE mismatch is still refused against the original target", async () => {
    // The reported corruption, end to end: open/routing raced, the first mutation
    // mismatched, and the auto-rebind then ACCEPTED the following edits against the
    // wrong canvas. With the fence preserved, the next mutation fails the same way.
    stamp = STAMP;
    await connect(OTHER);
    const second = await connect(OTHER);

    expect(second).toMatch(/NOT applied — nothing changed/);
    expect(second).toMatch(/NOT re-pointed/);
    expect(stamp).toBe(STAMP);
  });

  it("UNREADABLE: promises nothing, because nothing was established", async () => {
    // The failure direction that matters. If the re-derivation could not read the
    // panel, claiming the retry will work would send the agent back into the same
    // loop this issue is about — with our encouragement this time.
    const text = await connect(null);

    expect(text).toMatch(/could not be established/);
    expect(text).toMatch(/a bare retry will fail the same way/);
    expect(text).not.toMatch(/TRANSIENT/);
    expect(text).not.toMatch(/RETRY THIS EXACT CALL ONCE/);
    expect(stamp).toBe(STAMP);
  });

  it("the fence still REFUSES — this discloses, it never applies", async () => {
    // The whole point of the fence is that a mutation cannot land on the wrong graph.
    // Corroboration must not become a way to smuggle one through.
    const text = await connect(STAMP);
    expect(text).toMatch(/^Error:/);
    expect(text).toMatch(/Nothing was applied/);
  });
});
