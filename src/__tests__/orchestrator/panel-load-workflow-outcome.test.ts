// #2106 — the panel can apply graph_load and lose the fetch carrying its reply.
// Exercise the real makePanelToolCtx + panel_load_workflow boundary so the test covers
// dispatch observation, transport classification, and the post-failure probes together.

import { describe, expect, it } from "vitest";
import {
  buildPanelToolDefs,
  makePanelToolCtx,
  type PanelToolCtx,
  type ToolResult,
} from "../../orchestrator/panel-tools.js";

const TAB = "11111111-2222-3333-4444-555555555555";
const WORKFLOW_UUID = "99999999-8888-4777-a666-555555555555";
const OTHER_UUID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const DISPATCHED_RID = "22222222-3333-4444-8555-666666666666";

const UI_GRAPH = {
  last_node_id: 16,
  nodes: Array.from({ length: 16 }, (_, index) => ({ id: index + 1, type: "KSampler" })),
  links: [],
};

const textOf = (res: ToolResult): string =>
  res.content.map((part) => (part as { text?: string }).text ?? "").join(" ");

function loadTool() {
  const tool = buildPanelToolDefs().find((def) => def.name === "panel_load_workflow");
  if (!tool) throw new Error("panel_load_workflow is not registered");
  return tool;
}

function bridgeFor(options: {
  dispatch?: boolean;
  graphLoadError?: string;
  nodeCount?: number;
  workflowUuid?: string;
  nodeTypeMismatch?: boolean;
  preExistingSame?: boolean;
} = {}) {
  const sent: string[] = [];
  let serializeCalls = 0;
  const bridge = {
    send: async (
      cmd: Record<string, unknown>,
      opts?: { onDispatchedRid?: (rid: string) => void },
    ) => {
      sent.push(String(cmd.cmd));
      if (cmd.cmd === "graph_load") {
        if (options.dispatch !== false) opts?.onDispatchedRid?.(DISPATCHED_RID);
        throw new Error(options.graphLoadError ?? "Failed to fetch");
      }
      if (cmd.cmd === "graph_serialize") {
        serializeCalls += 1;
        const nodeCount = options.nodeCount ?? UI_GRAPH.nodes.length;
        const nodes = UI_GRAPH.nodes.slice(0, nodeCount).map((node, index) =>
          serializeCalls > 1 && options.nodeTypeMismatch && index === 0
            ? { ...node, type: "DifferentNode" }
            : serializeCalls === 1 && index === 0 && !options.preExistingSame
              ? { ...node, type: "OldNode" }
              : node,
        );
        return { workflow: { ...UI_GRAPH, nodes }, node_count: nodeCount };
      }
      if (cmd.cmd === "workflow_list") {
        const workflowUuid = options.workflowUuid ?? WORKFLOW_UUID;
        const key = `tmp:${workflowUuid}`;
        return {
          active: { workflow_uuid: workflowUuid, key },
          active_confirmed: true,
          workflows: [{ workflow_uuid: workflowUuid, key, active: true }],
        };
      }
      return { ok: true };
    },
    push: () => 1,
    canReach: () => true,
    isHeadless: () => false,
    tabs: () => [{ tab_id: TAB, title: "workflow", connected_at: 0 }],
    resolveActiveTabId: () => TAB,
    workflowUuidFor: () => ({ known: true, uuid: WORKFLOW_UUID }),
    tabGraphMutationCapability: () => ({ known: true, canMutate: true }),
  } as unknown as PanelToolCtx["bridge"];
  return { bridge, sent };
}

async function load(
  options: Parameters<typeof bridgeFor>[0] = {},
): Promise<{ result: ToolResult; sent: string[] }> {
  const { bridge, sent } = bridgeFor(options);
  const result = await loadTool().handler({ graph: UI_GRAPH }, makePanelToolCtx(bridge, TAB));
  return { result: result as ToolResult, sent };
}

describe("panel_load_workflow post-dispatch fetch failure (#2106)", () => {
  it("acknowledges a UI graph proven by the same UUID and node count", async () => {
    const { result, sent } = await load();
    const payload = JSON.parse(textOf(result)) as Record<string, unknown>;

    expect(result.isError).toBeFalsy();
    expect(payload).toMatchObject({
      loaded: true,
      reconciled: true,
      acknowledged_after_error: true,
      format: "ui",
      node_count: 16,
      workflow_uuid: WORKFLOW_UUID,
      response_error: "Failed to fetch",
    });
    expect(sent).toEqual(["graph_serialize", "graph_load", "graph_serialize", "workflow_list"]);
  });

  it("keeps an outcome-unknown error when the live node count does not prove the load", async () => {
    const { result, sent } = await load({ nodeCount: 15 });
    const text = textOf(result);

    expect(result.isError).toBe(true);
    expect(text).toContain("Failed to fetch");
    expect(text).toContain("OUTCOME UNKNOWN");
    expect(text).toContain(`retry_of:"${DISPATCHED_RID}"`);
    expect(sent).toEqual(["graph_serialize", "graph_load", "graph_serialize"]);
  });

  it("keeps an outcome-unknown error when the active workflow UUID changed", async () => {
    const { result, sent } = await load({ workflowUuid: OTHER_UUID });
    const text = textOf(result);

    expect(result.isError).toBe(true);
    expect(text).toContain("OUTCOME UNKNOWN");
    expect(text).toContain(`retry_of:"${DISPATCHED_RID}"`);
    expect(sent).toEqual(["graph_serialize", "graph_load", "graph_serialize", "workflow_list"]);
  });

  it("does not recover an old graph with the same UUID and node count", async () => {
    const { result, sent } = await load({ nodeTypeMismatch: true });
    const text = textOf(result);

    expect(result.isError).toBe(true);
    expect(text).toContain("OUTCOME UNKNOWN");
    expect(text).toContain(`retry_of:"${DISPATCHED_RID}"`);
    expect(sent).toEqual(["graph_serialize", "graph_load", "graph_serialize"]);
  });

  it("keeps an identical pre-existing graph outcome-unknown because causality is unproven", async () => {
    const { result, sent } = await load({ preExistingSame: true });
    const text = textOf(result);

    expect(result.isError).toBe(true);
    expect(text).toContain("OUTCOME UNKNOWN");
    expect(text).toContain(`retry_of:"${DISPATCHED_RID}"`);
    expect(sent).toEqual(["graph_serialize", "graph_load"]);
  });

  it("does not reconcile or soften a genuine executor failure", async () => {
    const { result, sent } = await load({ graphLoadError: "Unknown node type: MissingNode" });
    const text = textOf(result);

    expect(result.isError).toBe(true);
    expect(text).toContain("Unknown node type: MissingNode");
    expect(text).not.toContain("OUTCOME UNKNOWN");
    expect(sent).toEqual(["graph_serialize", "graph_load"]);
  });

  it("does not call a mutation outcome-unknown when fetch failed before dispatch", async () => {
    const { result, sent } = await load({ dispatch: false });
    const text = textOf(result);

    expect(result.isError).toBe(true);
    expect(text).toBe("Error: Failed to fetch");
    expect(text).not.toContain("OUTCOME UNKNOWN");
    expect(sent).toEqual(["graph_serialize", "graph_load"]);
  });
});
