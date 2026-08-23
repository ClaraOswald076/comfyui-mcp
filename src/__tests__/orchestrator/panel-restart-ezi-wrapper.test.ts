// #2118 — an EZi/CEI helper serves the panel on one local port while the
// immutable ComfyUI boot endpoint and Manager live on another. The panel restart
// must use the verified backend proof, not the helper listener's process identity.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  target: { value: "http://127.0.0.1:50404" },
  boot: { value: "http://127.0.0.1:8188" },
  generation: { value: 7 },
}));

vi.mock("../../comfyui/client.js", () => ({
  getObjectInfo: vi.fn(),
  getQueue: vi.fn(),
  getSystemStats: vi.fn(),
  resetClient: vi.fn(),
  resetObjectInfoCache: vi.fn(),
}));

vi.mock("../../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config.js")>();
  return {
    ...actual,
    config: { ...actual.config, comfyuiRestartCommand: undefined },
    getComfyUIBaseUrl: () => hoisted.target.value,
    getBootLocalComfyUIBaseUrl: () => hoisted.boot.value,
    getComfyuiTargetGeneration: () => hoisted.generation.value,
    isRemoteMode: () => false,
    isCloudMode: () => false,
  };
});

const { buildPanelToolDefs, __panelToolsTestHooks } = await import(
  "../../orchestrator/panel-tools.js"
);
import type { PanelToolCtx, ToolResult } from "../../orchestrator/panel-tools.js";

const PROXY = hoisted.target.value;
const BACKEND = hoisted.boot.value;
const ARGV = ["C:\\ComfyUI\\main.py", "--port", "8188"];

const parse = (res: ToolResult): Record<string, unknown> =>
  JSON.parse(res.content.find((c) => c.type === "text")!.text as string);

function restartHandler() {
  const def = buildPanelToolDefs().find((d) => d.name === "panel_restart_comfyui");
  if (!def) throw new Error("panel_restart_comfyui not found");
  return def.handler;
}

function makeCtx(sends: Array<Record<string, unknown>>): PanelToolCtx {
  return {
    call: async () => {
      throw new Error("ctx.call must not be used by the restart handler");
    },
    confirm: async () => "yes" as const,
    ensureReachable: () => {},
    bridge: {
      send: async (cmd: Record<string, unknown>) => {
        sends.push(cmd);
        return cmd.cmd === "comfy_reboot" ? { rebooting: true } : {};
      },
      tabIsLocal: () => true,
      tabServerOrigin: () => PROXY,
      tabOrigin: () => PROXY,
      canReach: () => true,
      tabSockId: () => "sock-2118",
    } as unknown as PanelToolCtx["bridge"],
    tabId: "tab-2118",
    panelConnectionIdentity: () => ({ generation: 1, tabSessionId: "session-2118" }),
    awaitPostRestartReachable: async () => true,
    tabCanMutateGraph: () => true,
  } as unknown as PanelToolCtx;
}

beforeEach(() => {
  __panelToolsTestHooks.setVerifiedProxyRestartTarget(async () => ({
    proxyBase: PROXY,
    backendBase: BACKEND,
    generation: hoisted.generation.value,
    argv: [...ARGV],
  }));
  __panelToolsTestHooks.setLocalRestartPreflight(async () => {
    throw new Error("the verified proxy path must not run local process preflight");
  });
  __panelToolsTestHooks.setPanelRebootTiming({
    settleMs: 0,
    budgetMs: 60,
    intervalMs: 5,
    probeTimeoutMs: 10,
  });
  let probes = 0;
  __panelToolsTestHooks.setHealthProbe(async (base) => {
    expect(base).toBe(BACKEND);
    return probes++ === 0 ? "down" : "healthy";
  });
});

afterEach(() => {
  __panelToolsTestHooks.setVerifiedProxyRestartTarget(null);
  __panelToolsTestHooks.setLocalRestartPreflight(null);
  __panelToolsTestHooks.setPanelRebootTiming(null);
  __panelToolsTestHooks.setHealthProbe(null);
});

describe("panel_restart_comfyui with an EZi/CEI proxy (#2118)", () => {
  it("accepts the tab binding, skips proxy process ownership, and dispatches the panel reboot", async () => {
    const sends: Array<Record<string, unknown>> = [];
    const out = parse(await restartHandler()({}, makeCtx(sends)));

    expect(out.rebooting).toBe(true);
    expect(out.refused).toBeUndefined();
    expect(sends.filter((cmd) => cmd.cmd === "comfy_reboot")).toHaveLength(1);
    expect(out.server_ready).toBe(true);
  });
});
