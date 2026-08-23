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

describe("panel_kitchen", () => {
  it("is on the panel surface with status/assess/apply", () => {
    const def = buildPanelToolDefs().find((d) => d.name === "panel_kitchen");
    expect(def, "panel_kitchen is not registered").toBeTruthy();
    expect(def!.description).toMatch(/action:"status"/);
    expect(def!.description).toMatch(/action:"assess"/);
    expect(def!.description).toMatch(/action:"apply"/);
  });

  it("assess walks the live graph from graph_query, not a saved file", async () => {
    resetKitchenHintSession();
    const sent: Array<Record<string, unknown>> = [];
    const bridge = {
      send: async (cmd: Record<string, unknown>) => {
        sent.push(cmd);
        if (cmd.cmd === "graph_query") {
          return {
            nodes: [
              {
                id: 12,
                type: "UNETLoader",
                widgets: { unet_name: "flux1-dev.safetensors", weight_dtype: "default" },
              },
            ],
          };
        }
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
    const res = await def.handler({ action: "assess" } as never, ctx);
    expect(res.isError).toBeFalsy();
    expect(sent.some((s) => s.cmd === "graph_query")).toBe(true);
    const body = JSON.parse(textOf(res));
    expect(body.loaders[0].node_id).toBe("12");
    expect(body.loaders[0].weight_dtype).toEqual({ status: "known", value: "default" });
    expect(Array.isArray(body.recommendations)).toBe(true);
  });

  it("assess normalizes text-serialized graph_query rows and skips malformed rows", async () => {
    resetKitchenHintSession();
    const bridge = {
      send: async (cmd: Record<string, unknown>) => {
        if (cmd.cmd === "graph_query") {
          return {
            matched: 1,
            text: [
              "not-json",
              JSON.stringify({
                id: 12,
                type: "UNETLoader",
                widgets: { unet_name: "flux1-dev.safetensors", weight_dtype: "default" },
              }),
              JSON.stringify(null),
              JSON.stringify(["not a row"]),
            ].join("\n"),
          };
        }
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

    const res = await def.handler({ action: "assess" } as never, ctx);

    expect(res.isError).toBeFalsy();
    const body = JSON.parse(textOf(res));
    expect(body.loaders).toHaveLength(1);
    expect(body.loaders[0].node_id).toBe("12");
    expect(body.loaders[0].unet_name).toEqual({ status: "known", value: "flux1-dev.safetensors" });
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
