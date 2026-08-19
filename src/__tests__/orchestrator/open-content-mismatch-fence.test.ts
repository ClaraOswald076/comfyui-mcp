// #1639 — `workflow_open` asserted "you are on the right workflow" while the
// canvas still showed the PREVIOUS graph, and #1337's identity-PROVEN fence
// re-derivation then CLEARED the fence so later graph reads of that previous
// graph succeeded as if they were the opened file.
//
// TWO LEVELS WERE BEING CONFLATED, the other way from #1337. That issue treated
// content-level uncertainty as if it blocked an identity-level fence. This one
// treated an identity-level CLAIM as if the live graph had moved. Clearing the
// fence on `the canvas IS bound to X` is what made `panel_graph_outline` return
// workflow A's 13 inpaint nodes after opening B, with `active_confirmed:true`
// for B.
//
// THE DISCRIMINATOR is a live graph read UNDER THE EXISTING FENCE, taken before
// any re-derivation:
//   - the read SUCCEEDS → the canvas still answers as the previous workflow.
//     Do not re-derive. Contradict "you are on the right workflow".
//   - the read is refused with `workflow instance mismatch` → the canvas
//     identity actually moved. That is the #1337 wedge; re-derive.
//   - the read does not come back → content is unverified. Do not re-derive.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildPanelToolDefs,
  makePanelToolCtx,
  type PanelToolCtx,
  type ToolResult,
} from "../../orchestrator/panel-tools.js";
import { QueueMonitor } from "../../services/queue-monitor.js";
import { WorkflowTargetStore } from "../../services/workflow-target-store.js";
import { markReplyTimeout } from "../../services/ui-bridge.js";

const TAB = "wf:workflows/a.json";
const PATH = "workflows/b.json";
const LIVE = "77777777-7777-4777-8777-777777777777";
const PRIOR = "11111111-1111-4111-8111-111111111111";

const IDENTITY_PROVEN_DRIFT =
  `workflow_open RAN and the canvas IS bound to ${PATH} — that much was proven — but the graph ` +
  `on it does not match the state that was loaded, and every node that was loaded is on it with ` +
  `the same id and type, and nothing extra appeared — no node was lost. What differs is per-node ` +
  `fields. You are on the right workflow. You are NOT on the wrong workflow: ${PATH} IS the ` +
  `active one. This reply carries NO fence refresh.`;

type GraphQuery = "answers" | "mismatch" | "timeout";

function bridge(graphQuery: GraphQuery) {
  const calls: string[] = [];
  let stamp: string | undefined = PRIOR;
  const b = {
    send: async (cmd: Record<string, unknown>) => {
      calls.push(String(cmd.cmd));
      if (cmd.cmd === "workflow_list") {
        const active = { path: PATH, routing_key: `wf:${PATH}`, workflow_uuid: LIVE };
        return { active, workflows: [{ ...active, active: true }], active_confirmed: true };
      }
      if (cmd.cmd === "workflow_open") throw new Error(IDENTITY_PROVEN_DRIFT);
      if (cmd.cmd === "graph_query") {
        if (graphQuery === "timeout") {
          throw markReplyTimeout(
            new Error(
              `Panel tab ${TAB} did not reply to "graph_query" within 8000 ms — the ComfyUI tab ` +
                `may be backgrounded or frozen`,
            ),
          );
        }
        if (graphQuery === "mismatch") {
          throw new Error(
            `workflow instance mismatch: issued for workflow instance ${PRIOR} but canvas is ${LIVE}`,
          );
        }
        return { ids: [1, 2, 3], node_count: 13 };
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
  return { b, calls, stampOf: () => stamp };
}

beforeEach(() => {
  const qm = QueueMonitor as unknown as { state: { runningPromptId: string | null } };
  qm.state.runningPromptId = null;
});

afterEach(() => {
  const qm = QueueMonitor as unknown as { state: { runningPromptId: string | null } };
  qm.state.runningPromptId = null;
});

async function openWorkflow(graphQuery: GraphQuery) {
  const { b, calls, stampOf } = bridge(graphQuery);
  const ctx = makePanelToolCtx(b, TAB, new WorkflowTargetStore());
  const def = buildPanelToolDefs().find((d) => d.name === "panel_open_workflow");
  if (!def) throw new Error("panel_open_workflow is not registered");
  const res: ToolResult = await def.handler({ path: PATH } as never, ctx);
  return {
    text: res.content.map((c) => (c as { text?: string }).text ?? "").join(" "),
    isError: res.isError === true,
    calls,
    stamp: stampOf(),
  };
}

describe("workflow_open does not clear the fence when the live graph still answers (#1639)", () => {
  it("the reporter's wedge: identity named B, live graph still answers as A — fence stays", async () => {
    const { text, isError, calls, stamp } = await openWorkflow("answers");

    expect(isError).toBe(true);
    expect(calls).toContain("graph_query");
    expect(calls.some((c) => c.startsWith("adopt:"))).toBe(false);
    expect(stamp).toBe(PRIOR);
    expect(text).toMatch(/FENCE: NOT cleared/);
    expect(text).toMatch(/CONTENT MISMATCH/);
    expect(text).toMatch(/PREVIOUS workflow/);
    // The panel's own reassurance is contradicted, not amplified.
    expect(text).toMatch(/do NOT trust "you are on the right workflow"/i);
    expect(text).not.toMatch(/FENCE: CLEARED/);
  });

  it("preserves the panel's content warning — the open still fails", async () => {
    const { text, isError } = await openWorkflow("answers");

    expect(isError).toBe(true);
    expect(text).toContain("You are on the right workflow");
    expect(text).toMatch(/do NOT edit or save expecting the opened file/i);
  });

  it("an unread live graph is UNVERIFIED — the fence is not re-derived on a missing read", async () => {
    const { text, isError, calls, stamp } = await openWorkflow("timeout");

    expect(isError).toBe(true);
    expect(calls).toContain("graph_query");
    expect(calls.some((c) => c.startsWith("adopt:"))).toBe(false);
    expect(stamp).toBe(PRIOR);
    expect(text).toMatch(/FENCE: NOT cleared/);
    expect(text).toMatch(/UNVERIFIED/);
    expect(text).toMatch(/do NOT trust "you are on the right workflow"/i);
    expect(text).not.toMatch(/FENCE: CLEARED/);
  });

  it("a genuine instance-mismatch refusal still re-derives — the #1337 wedge stays recovered", async () => {
    const { text, calls, stamp } = await openWorkflow("mismatch");

    expect(calls).toContain("graph_query");
    expect(calls).toContain("workflow_list");
    expect(text).toMatch(/FENCE: CLEARED/);
    expect(stamp).toBe(LIVE);
    expect(text).toMatch(/content warning above still stands/i);
  });
});
