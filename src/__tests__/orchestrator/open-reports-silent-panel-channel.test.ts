// artokun/comfyui-mcp#1560 — a post-open probe that got NO ANSWER was thrown away, and
// it was the one fact that ended the reporter's retry loop.
//
// THE REPORTED SEQUENCE. `panel_open_workflow` returned the UNPROVEN verdict; every
// `panel_*` graph call after it refused with `workflow instance mismatch`;
// `panel_set_workflow_target({mode:"current"})` — the documented recovery — reported
// "the panel did not answer"; and `panel_open_workflow` was retried TWICE more, each
// time reproducing the identical error. No agent-side recovery existed.
//
// WHAT THIS PROCESS ALREADY KNEW. On the open's own error branch,
// `observeActiveAfterOpen` sends a `workflow_list` — the read the fence EXEMPTS. In the
// reporter's session that read cannot have answered either. Its failure was swallowed
// ("could not ask — nothing was observed, so nothing is claimed") and the caller got the
// panel's verdict verbatim, with no hint that the channel itself was the problem.
//
// That silence DISCRIMINATES. `panel_set_workflow_target({mode:"current"})` re-derives
// via `rebindWorkflowFence`, which makes its own `workflow_list` round trip — the SAME
// read that just failed. So "the exempt read did not come back" is what separates
// "retry the open" (hopeless) from "the panel JS in the open tab is what needs fixing".
//
// NOT FIXED HERE, deliberately: the fence is still not adopted on an UNPROVEN verdict.
// Pointing a session at a canvas the panel could not identify is the write-to-the-wrong-
// graph failure the fence exists to prevent, and it has been rejected on this codebase
// more than once. This makes the dead end NAMEABLE, not survivable.

import { describe, expect, it } from "vitest";

import {
  buildPanelToolDefs,
  makePanelToolCtx,
  type PanelToolCtx,
  type ToolResult,
} from "../../orchestrator/panel-tools.js";
import { attachPanelAnswered } from "../../services/panel-answered.js";
import { WorkflowTargetStore } from "../../services/workflow-target-store.js";

const TAB = "wf:workflows/a.json";
const PATH = "workflows/a.json";
const LIVE = "77777777-7777-4777-8777-777777777777";

/** The reporter's verdict: identity itself unproven. */
const IDENTITY_UNPROVEN =
  `workflow_open RAN but could not prove that the active canvas was rebound to ${PATH}, so treat ` +
  `the canvas as unknown rather than unchanged. The panel could not confirm which workflow is ` +
  `active, so the open may have left a different one active.`;

/** The other verdict class: identity PROVEN, content unknown. */
const IDENTITY_PROVEN_DRIFT =
  `workflow_open RAN and the canvas IS bound to ${PATH} — that much was proven — but the graph ` +
  `on it does not match the state that was loaded. Treat the canvas as UNKNOWN and re-read it ` +
  `(panel_graph_outline) before editing.`;

/** A GENUINE acked failure: nothing was opened, so no probe should be provoked. */
const GENUINE_FAILURE = `no workflow matching "${PATH}" — it isn't among the saved/open workflows.`;

type ListBehaviour =
  | "throw"
  | "ok"
  | "ok_no_uuid"
  /** The probe read fails and the NEXT one succeeds — a tab that reconnected in the
   *  gap. Two separate round trips, so this is a real production state, and it is the
   *  only one in which the fence is repaired DESPITE a silent probe. */
  | "throw_then_ok"
  /** The panel RECEIVED the read and refused it — the bridge's `ok:false` branch,
   *  whose error carries the "something answered" mark (`attachPanelAnswered`). This
   *  is `isError` like a timeout and is its exact OPPOSITE: the tab is talking. */
  | "acked_error";

function bridge(openVerdict: string, list: ListBehaviour) {
  const calls: string[] = [];
  let stamp: string | undefined;
  let listCalls = 0;
  const b = {
    send: async (cmd: Record<string, unknown>) => {
      calls.push(String(cmd.cmd));
      if (cmd.cmd === "workflow_list") {
        listCalls += 1;
        if (list === "acked_error") {
          // Worded to LOOK like a silence on purpose: the classification must come
          // from the mark, and a message-shaped rule would also have to survive
          // being translated. This is the shape ui-bridge mints on `ok:false`.
          throw attachPanelAnswered(
            new Error(`the panel could not answer workflow_list: its workflow store is not ready`),
          );
        }
        const silent = list === "throw" || (list === "throw_then_ok" && listCalls === 1);
        if (silent) throw new Error(`Panel tab ${TAB} did not reply to "workflow_list" within 6000 ms`);
        const active = {
          path: PATH,
          routing_key: TAB,
          ...(list === "ok_no_uuid" ? {} : { workflow_uuid: LIVE }),
        };
        return { active, workflows: [{ ...active, active: true }], active_confirmed: true };
      }
      if (cmd.cmd === "workflow_open") throw new Error(openVerdict);
      // #1639 — identity-PROVEN re-derivation is gated on the live graph
      // refusing this session's stamp. Without this the probe would succeed
      // (this stub's default `{ok:true}`) and the fence would stay closed.
      if (cmd.cmd === "graph_query") {
        throw new Error(
          "workflow instance mismatch: issued for workflow instance " +
            "00000000-0000-4000-8000-000000000000 but canvas is " +
            LIVE,
        );
      }
      return { ok: true };
    },
    push: () => 1,
    canReach: () => true,
    isHeadless: () => false,
    tabs: () => [{ tab_id: TAB, title: "wf", connected_at: 0 }],
    resolveActiveTabId: () => TAB,
    refreshWorkflowUuid: (_t: string, uuid: string) => {
      calls.push(`adopt:${uuid}`);
      stamp = uuid;
      return true;
    },
    workflowUuidFor: () => ({ known: Boolean(stamp), uuid: stamp }),
    tabCanMutateGraph: () => true,
    tabGraphMutationCapability: () => ({ known: true, canMutate: true }),
  } as unknown as PanelToolCtx["bridge"];
  return { b, calls };
}

async function openWorkflow(openVerdict: string, list: ListBehaviour) {
  const { b, calls } = bridge(openVerdict, list);
  const ctx = makePanelToolCtx(b, TAB, new WorkflowTargetStore());
  const def = buildPanelToolDefs().find((d) => d.name === "panel_open_workflow");
  if (!def) throw new Error("panel_open_workflow is not registered");
  const res: ToolResult = await def.handler({ path: PATH } as never, ctx);
  return {
    text: res.content.map((c) => (c as { text?: string }).text ?? "").join(" "),
    isError: res.isError === true,
    calls,
  };
}

describe("a post-open exempt read that did not answer is REPORTED (#1560)", () => {
  it("the reporter's dead end: the silence is named, with the consequence that follows", async () => {
    const { text, isError, calls } = await openWorkflow(IDENTITY_UNPROVEN, "throw");

    // The probe genuinely ran — the whole claim rests on that round trip.
    expect(calls).toContain("workflow_list");
    expect(isError).toBe(true);
    // The panel's own verdict survives verbatim; this only ADDS what we measured.
    expect(text).toContain("could not prove that the active canvas was rebound");
    expect(text).toMatch(/PANEL CHANNEL: NOT ANSWERING/);
    // The measurement itself, including WHY it failed.
    expect(text).toMatch(/did not reply to "workflow_list"/);
    // The consequence that ends the loop the reporter ran: both remedies read the
    // same channel, so neither is a different thing to try.
    // Anchored on the CLAIM, not on a character window: the documented recovery reads
    // the very channel that just failed, so it is not a fresh thing to try.
    expect(text).toMatch(/panel_set_workflow_target\(\{mode:"current"\}\)/);
    expect(text).toMatch(/re-derives the fence from its own `workflow_list` round trip/i);
    expect(text).toMatch(/reads the same channel that just failed/i);
    expect(text).toMatch(/Retrying panel_open_workflow does not help/i);
    // The remedy that is actually left.
    expect(text).toMatch(/Ctrl\+Shift\+R/);
  });

  it("does NOT claim the panel is permanently gone — one bounded read is all it saw", async () => {
    // CLAIM SHAPE MUST MATCH OBSERVATION SHAPE. A single 6s read timing out cannot
    // establish permanence, and a tab still reconnecting after a ComfyUI restart
    // answers late and recovers on its own. Saying "the panel is dead" here would be
    // the same over-claim this cluster keeps producing.
    const { text } = await openWorkflow(IDENTITY_UNPROVEN, "throw");

    expect(text).toMatch(/does not (?:establish|prove)/i);
    expect(text).toMatch(/still reconnecting/i);
    expect(text).toMatch(/retry/i);
  });

  it("adopts NOTHING — the fence stays closed on an unidentifiable canvas", async () => {
    // The direction that would be dangerous, and the reason the reporter's own
    // suggested fix was declined. Naming the dead end must not become surviving it.
    const { text, calls } = await openWorkflow(IDENTITY_UNPROVEN, "throw");

    expect(calls.some((c) => c.startsWith("adopt:"))).toBe(false);
    expect(text).not.toMatch(/FENCE: CLEARED/);
  });

  it("an exempt read that ANSWERED says nothing about a silent channel", async () => {
    // The false-positive direction. `ok_no_uuid` answers fully and simply carries no
    // identity — a different failure with a different remedy, and telling that caller
    // to hard-refresh their tab would name a cause that is not theirs.
    const { text } = await openWorkflow(IDENTITY_UNPROVEN, "ok_no_uuid");

    expect(text).not.toMatch(/PANEL CHANNEL: NOT ANSWERING/);
  });

  it("a REPAIRED fence is not reported as a silent channel", async () => {
    // On the identity-PROVEN verdict the fence is re-derived (#1337). If that
    // re-derivation succeeded, the channel demonstrably answered, and the note would
    // contradict the line above it.
    const { text } = await openWorkflow(IDENTITY_PROVEN_DRIFT, "ok");

    expect(text).toMatch(/FENCE: CLEARED/);
    expect(text).not.toMatch(/PANEL CHANNEL: NOT ANSWERING/);
  });

  it("a probe that went silent but a fence that CAME BACK is not called a dead channel", async () => {
    // The two reads are separate round trips: the probe can time out and the #1337
    // re-derivation, moments later, can succeed on a tab that reconnected in the gap.
    // Saying "expect mode:current to fail the same way" on top of a line announcing
    // FENCE: CLEARED would be self-contradicting — and the fence IS the thing the
    // caller was blocked on.
    const { text } = await openWorkflow(IDENTITY_PROVEN_DRIFT, "throw_then_ok");

    expect(text).toMatch(/FENCE: CLEARED/);
    expect(text).not.toMatch(/PANEL CHANNEL: NOT ANSWERING/);
  });

  it("a silent channel on the identity-PROVEN verdict is reported too", async () => {
    // Same dead end, reached through the other verdict: the #1337 re-derivation needs
    // the same read, so its failure leaves the session just as fenced.
    const { text } = await openWorkflow(IDENTITY_PROVEN_DRIFT, "throw");

    expect(text).toMatch(/FENCE: NOT cleared/);
    expect(text).toMatch(/PANEL CHANNEL: NOT ANSWERING/);
  });

  it("a panel that ANSWERS the probe with an ERROR is never called silent (review, P1)", async () => {
    // THE FALSE CLAIM THIS NOTE COULD MAKE. `isError` covers two opposite
    // observations: nothing came back, and the tab received the read, ran it and
    // replied refusing it. The first version of this fix mapped both to "unanswered",
    // so a working panel got `PANEL CHANNEL: NOT ANSWERING` — a statement contradicted
    // by the very reply that produced it — plus a hard-refresh prescription for a
    // problem this user does not have. The suite only covered the canonical timeout,
    // where the two agree.
    const { text, isError, calls } = await openWorkflow(IDENTITY_UNPROVEN, "acked_error");

    // The probe really ran and really failed — this is not the "nothing to observe"
    // case sneaking in through the back door.
    expect(calls).toContain("workflow_list");
    expect(isError).toBe(true);
    // The panel's own verdict is still reported verbatim; only the CHANNEL claim goes.
    expect(text).toContain("could not prove that the active canvas was rebound");
    expect(text).not.toMatch(/PANEL CHANNEL: NOT ANSWERING/);
    // …including the remedy it carries. Sending this caller to reload their tab is
    // the actionable half of the false claim.
    expect(text).not.toMatch(/Ctrl\+Shift\+R/);
    expect(text).not.toMatch(/reads the same channel that just failed/i);
  });

  it("the same, through the identity-PROVEN verdict", async () => {
    // The other route to the note. Here the #1337 re-derivation runs first and hits
    // the same answering-but-refusing panel, so the fence genuinely is not cleared —
    // and that is still not evidence of a dead channel.
    const { text } = await openWorkflow(IDENTITY_PROVEN_DRIFT, "acked_error");

    expect(text).toMatch(/FENCE: NOT cleared/);
    expect(text).not.toMatch(/PANEL CHANNEL: NOT ANSWERING/);
  });

  it("a GENUINE acked failure provokes no probe and no note", async () => {
    // Nothing was opened, so there is no canvas question to ask and no channel claim
    // to make. This repo already pins that a genuine error must not trigger a
    // workflow_list round trip at all.
    const { text, calls } = await openWorkflow(GENUINE_FAILURE, "throw");

    expect(calls).not.toContain("workflow_list");
    expect(text).not.toMatch(/PANEL CHANNEL: NOT ANSWERING/);
  });
});
