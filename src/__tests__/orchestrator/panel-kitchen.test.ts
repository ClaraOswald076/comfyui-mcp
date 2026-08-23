import { describe, expect, it, vi } from "vitest";

vi.mock("../../services/workspace-env.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/workspace-env.js")>();
  return { ...actual, resolveComfyuiPython: () => ({ python: undefined }) };
});

vi.mock("../../comfyui/client.js", () => ({
  getLogs: vi.fn(async () => []),
  getSystemStats: vi.fn(async () => ({
    system: { os: "Linux", python_version: "3.12", embedded_python: false, argv: [] },
    devices: [],
  })),
}));

import {
  buildPanelToolDefs,
  makePanelToolCtx,
  type PanelToolCtx,
  type ToolResult,
} from "../../orchestrator/panel-tools.js";
import { WorkflowTargetStore } from "../../services/workflow-target-store.js";
import { resetKitchenHintSession } from "../../services/kitchen.js";

const TAB = "wf:workflows/a.json";

function textOf(res: ToolResult): string {
  return res.content.map((c) => ("text" in c ? c.text : "")).join("\n");
}

function panelKitchenHarness(graphQueryReply: unknown) {
  const sent: Array<Record<string, unknown>> = [];
  const bridge = {
    send: async (cmd: Record<string, unknown>) => {
      sent.push(cmd);
      if (cmd.cmd === "graph_query") return graphQueryReply;
      return {};
    },
    push: () => 1,
    canReach: () => true,
    isHeadless: () => false,
    tabs: () => [{ tab_id: TAB, title: "wf", connected_at: 0 }],
    resolveActiveTabId: () => TAB,
    tabCanMutateGraph: () => true,
    tabGraphMutationCapability: () => ({ known: true, canMutate: true }),
    workflowUuidFor: () => ({ known: false }),
    refreshWorkflowUuid: () => true,
  } as unknown as PanelToolCtx["bridge"];
  const ctx = makePanelToolCtx(bridge, TAB, new WorkflowTargetStore());
  const def = buildPanelToolDefs().find((d) => d.name === "panel_kitchen")!;
  return { ctx, def, sent };
}

const unetRow = (id: number) => ({
  id,
  type: "UNETLoader",
  widgets: { unet_name: "flux1-dev.safetensors", weight_dtype: "default" },
});

async function assessLiveGraph(graphQueryReply: unknown) {
  resetKitchenHintSession();
  const harness = panelKitchenHarness(graphQueryReply);
  const res = await harness.def.handler({ action: "assess" } as never, harness.ctx);
  expect(res.isError).toBeFalsy();
  expect(harness.sent).toContainEqual({
    cmd: "graph_query",
    types: ["UNETLoader"],
    fields: "detail",
    limit: 200,
    max_chars: 60000,
  });
  return JSON.parse(textOf(res)) as { loaders: Array<Record<string, unknown>> };
}

describe("panel_kitchen", () => {
  it("is on the panel surface with status/assess/apply", () => {
    const def = buildPanelToolDefs().find((d) => d.name === "panel_kitchen");
    expect(def, "panel_kitchen is not registered").toBeTruthy();
    expect(def!.description).toMatch(/action:"status"/);
    expect(def!.description).toMatch(/action:"assess"/);
    expect(def!.description).toMatch(/action:"apply"/);
  });

  it("assess walks an object graph response from graph_query, not a saved file", async () => {
    const body = await assessLiveGraph({ nodes: [unetRow(12)] });

    expect(body.loaders[0]).toMatchObject({
      node_id: "12",
      node_type: "UNETLoader",
      unet_name: { status: "known", value: "flux1-dev.safetensors" },
      weight_dtype: { status: "known", value: "default" },
    });
  });

  it("assess normalizes text-serialized graph_query rows and skips malformed rows", async () => {
    const body = await assessLiveGraph({
      matched: 1,
      text: ["not-json", JSON.stringify(unetRow(12)), JSON.stringify(null), JSON.stringify(["not a row"])].join("\n"),
    });

    expect(body.loaders).toHaveLength(1);
    expect(body.loaders[0]).toMatchObject({
      node_id: "12",
      unet_name: { status: "known", value: "flux1-dev.safetensors" },
    });
  });

  it("assess keeps supporting an array graph response from graph_query", async () => {
    const body = await assessLiveGraph([unetRow(13)]);

    expect(body.loaders).toHaveLength(1);
    expect(body.loaders[0]?.node_id).toBe("13");
  });

  it.each([
    ["malformed graph_query text", { matched: 1, shown: 1, text: "{not-json" }],
    ["an empty text result", { matched: 0, shown: 0, text: "" }],
    ["an empty object graph", { nodes: [] }],
    ["an empty array graph", []],
  ] as const)("assess returns no loaders for %s", async (_shape, graph) => {
    const body = await assessLiveGraph(graph);

    expect(body.loaders).toEqual([]);
  });

  it("refuses a truncated graph_query instead of assessing a partial graph", async () => {
    resetKitchenHintSession();
    const harness = panelKitchenHarness({
      matched: 2,
      shown: 1,
      truncated: true,
      truncated_by: "max_chars",
      text: JSON.stringify(unetRow(12)),
    });

    const res = await harness.def.handler({ action: "assess" } as never, harness.ctx);

    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/truncated.*detail rows/i);
    expect(harness.sent).toContainEqual({
      cmd: "graph_query",
      types: ["UNETLoader"],
      fields: "detail",
      limit: 200,
      max_chars: 60000,
    });
  });

  it("apply of an unknown id names the assess ids rather than guessing", async () => {
    const bridge = {
      send: async (cmd: Record<string, unknown>) => {
        if (cmd.cmd === "graph_query") return { nodes: [] };
        return {};
      },
      push: () => 1,
      canReach: () => true,
      isHeadless: () => false,
      tabs: () => [{ tab_id: TAB, title: "wf", connected_at: 0 }],
      resolveActiveTabId: () => TAB,
      tabCanMutateGraph: () => true,
      tabGraphMutationCapability: () => ({ known: true, canMutate: true }),
      workflowUuidFor: () => ({ known: false }),
      refreshWorkflowUuid: () => true,
    } as unknown as PanelToolCtx["bridge"];
    const ctx = makePanelToolCtx(bridge, TAB, new WorkflowTargetStore());
    const def = buildPanelToolDefs().find((d) => d.name === "panel_kitchen")!;
    const res = await def.handler(
      { action: "apply", recommendation_id: "fp8_unet_fast:12" } as never,
      ctx,
    );
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/fp8_unet_fast:12/);
    expect(textOf(res)).toMatch(/assess/);
  });
});
