// #2242 — panel_add_node must leave enough time for a slow full /object_info refresh
// to compose its reply. If the relay expires first, the mutation may still be applied
// by the panel and a later caller retry can create a duplicate node.

import { describe, expect, it } from "vitest";

import {
  buildPanelToolDefs,
  makePanelToolCtx,
  type PanelToolCtx,
} from "../../orchestrator/panel-tools.js";
import { WorkflowTargetStore } from "../../services/workflow-target-store.js";

const TAB = "wf:workflows/2242.json";

describe("panel_add_node ACK budget (#2242)", () => {
  it("forwards the bounded 90s refresh budget to graph_add_node", async () => {
    const seen: Array<{ cmd: string; timeoutMs: number | undefined }> = [];
    const bridge = {
      send: async (cmd: Record<string, unknown>, opts?: { timeoutMs?: number }) => {
        seen.push({ cmd: String(cmd.cmd), timeoutMs: opts?.timeoutMs });
        return { node_id: 42, class_type: cmd.class_type };
      },
      push: () => 1,
      canReach: () => true,
      isHeadless: () => false,
      tabs: () => [{ tab_id: TAB, title: "wf", connected_at: 0 }],
      resolveActiveTabId: () => TAB,
      tabCanMutateGraph: () => true,
      tabGraphMutationCapability: () => ({ known: true, canMutate: true }),
    } as unknown as PanelToolCtx["bridge"];
    const ctx = makePanelToolCtx(bridge, TAB, new WorkflowTargetStore());
    const def = buildPanelToolDefs().find((entry) => entry.name === "panel_add_node");
    if (!def) throw new Error("panel_add_node is not registered");

    const result = await def.handler({ class_type: "RemoteStacker" }, ctx);

    expect(result.isError).not.toBe(true);
    expect(seen).toEqual([{ cmd: "graph_add_node", timeoutMs: 90_000 }]);
  });
});
