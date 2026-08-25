import { beforeEach, describe, expect, it, vi } from "vitest";

const restartMock = vi.hoisted(() => vi.fn());
const panelTarget = vi.hoisted(() => ({
  baseUrl: "http://127.0.0.1:8188",
  generation: 0,
}));
const panelTabTarget = vi.hoisted(() => ({
  baseUrl: "http://127.0.0.1:8188",
}));
const kitchenFixture = vi.hoisted(() => ({
  rec: {
    id: "ck_attention",
    kind: "ck_attention",
    why: "INT8 attention is available.",
    safe: "Restart required; consent-gated.",
    restart: true,
    download: false,
    change: { type: "flag", flag: "--use-ck-attention" },
  },
}));

vi.mock("../../services/workspace-env.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/workspace-env.js")>();
  return { ...actual, resolveComfyuiPython: () => ({ python: undefined }) };
});

vi.mock("../../services/instance-witness.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/instance-witness.js")>();
  return { ...actual, acquireInstanceWitness: async () => undefined };
});

vi.mock("../../comfyui/client.js", () => ({
  getLogs: vi.fn(async () => []),
  getSystemStats: vi.fn(async () => ({ system: { argv: [] }, devices: [] })),
}));

vi.mock("../../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config.js")>();
  return {
    ...actual,
    getComfyUIBaseUrl: () => panelTarget.baseUrl,
    getComfyuiTargetGeneration: () => panelTarget.generation,
  };
});

vi.mock("../../services/process-control.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/process-control.js")>();
  return { ...actual, restartComfyUI: restartMock };
});

vi.mock("../../services/kitchen.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/kitchen.js")>();
  return {
    ...actual,
    gatherKitchenStatus: vi.fn(async () => ({})),
    assessKitchenGraph: vi.fn(async () => [kitchenFixture.rec]),
  };
});

import {
  buildPanelToolDefs,
  makePanelToolCtx,
  type PanelToolCtx,
  type ToolResult,
} from "../../orchestrator/panel-tools.js";
import { captureComfyUITargetFence } from "../../services/process-control.js";
import { WorkflowTargetStore } from "../../services/workflow-target-store.js";

const TAB = "wf:workflows/a.json";
function textOf(res: ToolResult): string {
  return res.content.map((c) => ("text" in c ? c.text : "")).join("\n");
}

function panelKitchenHarness(onGraphQuery?: () => void) {
  const sent: Array<Record<string, unknown>> = [];
  const bridge = {
    send: async (cmd: Record<string, unknown>) => {
      sent.push(cmd);
      if (cmd.cmd === "graph_query") {
        onGraphQuery?.();
        return { nodes: [] };
      }
      return {};
    },
    push: () => 1,
    canReach: () => true,
    isHeadless: () => false,
    tabs: () => [{ tab_id: TAB, title: "wf", connected_at: 0 }],
    tabOrigin: () => panelTabTarget.baseUrl,
    tabServerOrigin: () => new URL(panelTabTarget.baseUrl).origin,
    tabIsLocal: () => true,
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

beforeEach(() => {
  vi.clearAllMocks();
  panelTarget.baseUrl = "http://127.0.0.1:8188";
  panelTarget.generation = 0;
  panelTabTarget.baseUrl = "http://127.0.0.1:8188";
});

describe("panel_kitchen flag apply (#2277)", () => {
  it("reports applied only when the owned relaunch and serving argv prove the flag", async () => {
    restartMock.mockResolvedValue({
      stopped: true,
      started: true,
      startup: "confirmed",
      listener_ownership: "ours",
      message: "ComfyUI restarted successfully.",
      serving_argv: ["main.py", "--use-ck-attention"],
      target_fence: captureComfyUITargetFence(),
      target_stable: true,
    });
    const { ctx, def } = panelKitchenHarness();

    const res = await def.handler(
      { action: "apply", recommendation_id: "ck_attention", confirm: true, skip_proof: true } as never,
      ctx,
    );
    const body = JSON.parse(textOf(res));

    expect(body.applied).toBe(true);
    expect(body.flag_note).toMatch(/observed it in the serving ComfyUI argv/i);
    expect(restartMock).toHaveBeenCalledWith({
      additionalFlags: ["--use-ck-attention"],
      targetFence: captureComfyUITargetFence(),
    });
  });

  it("returns the launcher-specific refusal and applied:false when restart cannot inject it", async () => {
    restartMock.mockResolvedValue({
      stopped: false,
      started: false,
      startup: "not-attempted",
      listener_ownership: "unconfirmed",
      message:
        "Refusing to apply --use-ck-attention: ComfyUI Desktop owns the saved launch settings. " +
        "No launch argument was changed and ComfyUI was not stopped.",
      target_fence: captureComfyUITargetFence(),
      target_stable: true,
    });
    const { ctx, def } = panelKitchenHarness();

    const res = await def.handler(
      { action: "apply", recommendation_id: "ck_attention", confirm: true, skip_proof: true } as never,
      ctx,
    );
    const body = JSON.parse(textOf(res));

    expect(body.applied).toBe(false);
    expect(body.flag_note).toMatch(/Desktop owns the saved launch settings/i);
    expect(body.flag_note).toMatch(/applied:false/i);
  });

  it("refuses a cross-tab retarget during graph assessment before restart", async () => {
    const { ctx, def } = panelKitchenHarness(() => {
      panelTarget.baseUrl = "http://127.0.0.1:8288";
      panelTarget.generation = 1;
    });

    const res = await def.handler(
      { action: "apply", recommendation_id: "ck_attention", confirm: true, skip_proof: true } as never,
      ctx,
    );

    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/target changed/i);
    expect(restartMock).not.toHaveBeenCalled();
  });

  it("returns applied:false when the target changes during the relaunch result", async () => {
    restartMock.mockImplementation(async () => {
      panelTarget.baseUrl = "http://127.0.0.1:8288";
      panelTarget.generation = 1;
      return {
        stopped: true,
        started: true,
        startup: "confirmed",
        listener_ownership: "ours",
        message: "ComfyUI restarted successfully.",
        serving_argv: ["main.py", "--use-ck-attention"],
        target_fence: {
          baseUrl: "http://127.0.0.1:8188",
          generation: 0,
        },
        target_stable: true,
      };
    });
    const { ctx, def } = panelKitchenHarness();

    const res = await def.handler(
      { action: "apply", recommendation_id: "ck_attention", confirm: true, skip_proof: true } as never,
      ctx,
    );
    const body = JSON.parse(textOf(res));

    expect(body.applied).toBe(false);
    expect(body.flag_note).toMatch(/target changed/i);
    expect(restartMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the consent gate before any launcher mutation", async () => {
    const { ctx, def } = panelKitchenHarness();

    const res = await def.handler(
      { action: "apply", recommendation_id: "ck_attention", confirm: false, skip_proof: true } as never,
      ctx,
    );
    const body = JSON.parse(textOf(res));

    expect(body.applied).toBe(false);
    expect(body.needs_confirm).toBe(true);
    expect(restartMock).not.toHaveBeenCalled();
  });
});
