// #1778 — panel_save_workflow is fence-refused without corroborating, so a save-only
// retry loop never self-heals.
//
// When a command is refused by the workflow-instance fence, graph reads
// (isFencedGraphRead) and graph mutations (isMutatingGraphCmd) fire a read-only
// probe: workflow_list corroborates the instance the fence already holds, the
// first call still fails, and a retry dispatches. panel_save_workflow({}) is
// neither a graph_* command nor in MUTATING_GRAPH_EDIT_CMDS, so neither probe
// branch fires. The save handler then returns at `if (res.isError) return res`
// with the generic "tab may be disconnected" wrapper and an empty corroboration.
// A caller that only retries the save stays refused indefinitely.
//
// Same safety as #1656's graph probe: corroborateTabStamp, never refreshWorkflowUuid.
// A matching live uuid is the self-heal; a diverged canvas stays refused (#1646).

import { describe, expect, it } from "vitest";

import {
  buildPanelToolDefs,
  makePanelToolCtx,
  type PanelToolCtx,
  type ToolResult,
} from "../../orchestrator/panel-tools.js";
import { markDispatched } from "../../services/ui-bridge.js";
import { WorkflowTargetStore } from "../../services/workflow-target-store.js";

const TAB = "wf:route1:workflows/krea2_lora_ab_compare.json";
const CARRIED_UUID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_UUID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const carriedRefusal = (): Error =>
  markDispatched(
    new Error(
      `workflow instance mismatch: this command was issued for workflow instance ${CARRIED_UUID}, ` +
        `and the tab it routed to has not re-established its workflow identity since it ` +
        `re-registered under a new id — the uuid it currently carries (${CARRIED_UUID}) was ` +
        `inherited from the tab id it replaced, so it is not evidence about the canvas now ` +
        `mounted there. Nothing was dispatched. Re-target with ` +
        `panel_set_workflow_target({mode:"current"}), then retry.`,
    ),
    false,
  );

function harness(liveUuid: string) {
  const corroborated: string[] = [];
  const retargeted: string[] = [];
  /** Commands that actually reached a success reply — the dispatch the retry must earn. */
  const dispatched: string[] = [];
  const b = {
    send: async (cmd: Record<string, unknown>) => {
      if (cmd.cmd === "workflow_list") {
        const active = {
          path: "workflows/krea2_lora_ab_compare.json",
          routing_key: TAB,
          workflow_uuid: liveUuid,
        };
        return { active, workflows: [{ ...active, active: true }], active_confirmed: true };
      }
      // Models the real agreement gate: a carried stamp stays refused until the
      // live canvas CONFIRMS it. Corroboration is the only thing that flips this.
      const proven = corroborated.includes(CARRIED_UUID) && liveUuid === CARRIED_UUID;
      if (!proven) throw carriedRefusal();
      dispatched.push(typeof cmd.cmd === "string" ? cmd.cmd : "");
      if (cmd.cmd === "workflow_save" || cmd.cmd === "workflow_save_as") {
        return { saved: true, workflow: "x", workflow_uuid: CARRIED_UUID, routing_key: TAB };
      }
      return { ok: true };
    },
    push: () => 1,
    canReach: (id: string) => id === TAB,
    isHeadless: () => false,
    tabs: () => [{ tab_id: TAB, title: "wf", connected_at: 0 }],
    resolveActiveTabId: () => TAB,
    refreshWorkflowUuid: (_tabId: string, uuid: string) => {
      retargeted.push(uuid);
      return true;
    },
    corroborateTabStamp: (_tabId: string, uuid: string) => {
      corroborated.push(uuid);
      return true;
    },
    workflowUuidFor: () => ({ known: true, uuid: CARRIED_UUID }),
    tabCanMutateGraph: () => true,
    tabGraphMutationCapability: () => ({ known: true, canMutate: true }),
  } as unknown as PanelToolCtx["bridge"];
  return { bridge: b, corroborated, retargeted, dispatched };
}

type Harness = ReturnType<typeof harness>;

const textOf = (res: ToolResult): string =>
  res.content.map((c) => (c as { text?: string }).text ?? "").join(" ");

async function callTool(
  h: Harness,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ text: string; res: ToolResult }> {
  const ctx = makePanelToolCtx(h.bridge, TAB, new WorkflowTargetStore());
  const def = buildPanelToolDefs().find((d) => d.name === name);
  if (!def) throw new Error(`${name} is not registered`);
  const res: ToolResult = await def.handler(args as never, ctx);
  return { text: textOf(res), res };
}

describe("#1778 panel_save_workflow corroborates a fence refusal, so a save-only retry self-heals", () => {
  it("CONTROL: panel_graph_outline in this state probes, corroborates, and a retry dispatches", async () => {
    // The path the reporter already had: a fenced graph READ self-heals. If this
    // fails, the harness is wrong — not the save gap.
    const h = harness(CARRIED_UUID);
    const first = await callTool(h, "panel_graph_outline");
    expect(h.corroborated).toEqual([CARRIED_UUID]);
    expect(h.retargeted).toEqual([]);
    expect(first.res.isError).toBe(true);
    expect(h.dispatched).toEqual([]);

    const second = await callTool(h, "panel_graph_outline");
    expect(second.res.isError).toBeFalsy();
    expect(h.dispatched).toContain("graph_outline");
  });

  it("a matching live uuid is corroborated, and a save-only retry then dispatches", async () => {
    const h = harness(CARRIED_UUID);
    const first = await callTool(h, "panel_save_workflow");

    // The probe ran and offered the uuid already in force — that is the self-heal.
    expect(h.corroborated).toEqual([CARRIED_UUID]);
    // The RETARGETING write is not reached on the refusal: the fence does not move.
    expect(h.retargeted).toEqual([]);
    expect(first.res.isError).toBe(true);
    expect(first.text).toMatch(/workflow instance mismatch/);
    expect(first.text).toMatch(/CHECKED/);
    expect(first.text).toMatch(/RETRY THIS EXACT CALL ONCE/);
    // The generic dispatched:false wrapper is the misleading one: the tab is
    // connected; what is stale is the stamp. The probe must replace it.
    expect(first.text).not.toMatch(/tab may be disconnected/);
    // Nothing was written — the first save never dispatched.
    expect(h.dispatched).toEqual([]);

    // The reporter's loop: retry the SAME save, no graph_* in between.
    const second = await callTool(h, "panel_save_workflow");
    expect(second.res.isError).toBeFalsy();
    expect(h.dispatched).toContain("workflow_save");
  });

  it("Save-As on the same path corroborates too — it is the same tool, a different cmd", async () => {
    const h = harness(CARRIED_UUID);
    const first = await callTool(h, "panel_save_workflow", { name: "copy" });
    expect(h.corroborated).toEqual([CARRIED_UUID]);
    expect(first.res.isError).toBe(true);
    expect(h.dispatched).toEqual([]);

    const second = await callTool(h, "panel_save_workflow", { name: "copy" });
    expect(second.res.isError).toBeFalsy();
    expect(h.dispatched).toContain("workflow_save_as");
  });

  it("a path-less rename shares the gap and is covered by the same probe", async () => {
    // requiresStampTargetAgreement gates rename/close without a path the same way
    // it gates save. Widening the probe to the active-workflow mutators, not just
    // workflow_save, is what keeps that from becoming the next recurrence.
    const h = harness(CARRIED_UUID);
    const first = await callTool(h, "panel_rename_workflow", { name: "renamed" });
    expect(h.corroborated).toEqual([CARRIED_UUID]);
    expect(first.res.isError).toBe(true);
    expect(h.dispatched).toEqual([]);

    const second = await callTool(h, "panel_rename_workflow", { name: "renamed" });
    expect(second.res.isError).toBeFalsy();
    expect(h.dispatched).toContain("workflow_rename");
  });

  it("adopts NOTHING when the live canvas is a DIFFERENT workflow (#1646 stands)", async () => {
    const h = harness(OTHER_UUID);
    const first = await callTool(h, "panel_save_workflow");
    expect(h.corroborated).toEqual([]);
    expect(h.retargeted).toEqual([]);
    expect(first.res.isError).toBe(true);
    expect(first.text).toMatch(/DIFFERENT workflow/);
    expect(first.text).toContain(OTHER_UUID);
    expect(h.dispatched).toEqual([]);

    // A save-only retry cannot smuggle the write onto the other canvas.
    const second = await callTool(h, "panel_save_workflow");
    expect(second.res.isError).toBe(true);
    expect(h.dispatched).toEqual([]);
    expect(h.retargeted).toEqual([]);
  });
});
