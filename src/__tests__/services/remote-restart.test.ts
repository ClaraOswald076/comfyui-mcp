// Remote restart: when the orchestrator targets a REMOTE ComfyUI (--comfyui-url,
// e.g. a Cloudflare-tunnelled Desktop app), restart_comfyui must NOT throw — it
// fires a ComfyUI-Manager HTTP reboot and polls readiness until the (self-
// supervised) origin comes back. Everything is exercised through mocked
// comfyuiFetch + isRemoteMode; no real process/port/network is touched.

import { describe, expect, it, beforeEach, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  remoteMode: { value: true },
  fetchMock: vi.fn(),
  resetClient: vi.fn(),
  resetObjectInfoCache: vi.fn(),
  getSystemStats: vi.fn(async () => ({ system: { argv: [] as string[] } })),
  execSync: vi.fn(() => ""),
  spawn: vi.fn(),
}));

vi.mock("../../config.js", () => ({
  config: { resolvedPort: 8188, comfyuiPath: "/fake/comfy", comfyuiBasePath: "" },
  getComfyUIBaseUrl: () => "http://remote.example:8188",
  isRemoteMode: () => hoisted.remoteMode.value,
}));

vi.mock("../../comfyui/fetch.js", () => ({
  comfyuiFetch: (url: string, init?: RequestInit) => hoisted.fetchMock(url, init),
}));

vi.mock("../../comfyui/client.js", () => ({
  getSystemStats: hoisted.getSystemStats,
  resetClient: hoisted.resetClient,
  resetObjectInfoCache: hoisted.resetObjectInfoCache,
}));

vi.mock("node:child_process", () => ({
  execSync: hoisted.execSync,
  spawn: hoisted.spawn,
}));

import {
  restartComfyUI,
  __processControlTestHooks,
} from "../../services/process-control.js";

type FetchCall = [string, RequestInit | undefined];
const pathOf = (u: string): string => new URL(u).pathname;
const findCall = (pred: (path: string) => boolean): FetchCall | undefined =>
  (hoisted.fetchMock.mock.calls as FetchCall[]).find(([u]) => pred(pathOf(u)));

beforeEach(() => {
  hoisted.remoteMode.value = true;
  hoisted.fetchMock.mockReset();
  hoisted.resetClient.mockClear();
  hoisted.resetObjectInfoCache.mockClear();
  hoisted.getSystemStats.mockClear();
  hoisted.execSync.mockReset();
  hoisted.execSync.mockImplementation(() => "");
  __processControlTestHooks.reset();
});

describe("restartComfyUI — remote (Manager reboot)", () => {
  it("reboot POST 502, then /system_stats errors twice then 200 → started + ready", async () => {
    __processControlTestHooks.setRemoteRebootTimingForTests({
      settleMs: 0,
      budgetMs: 1000,
      intervalMs: 5,
    });
    let statsCalls = 0;
    hoisted.fetchMock.mockImplementation(async (url: string) => {
      const path = pathOf(url);
      if (path === "/v2/manager/reboot") {
        // Killed origin behind a proxy/tunnel surfaces as a 5xx bad-gateway.
        return new Response("bad gateway", { status: 502 });
      }
      if (path === "/system_stats") {
        statsCalls++;
        if (statsCalls <= 2) throw new Error("fetch failed");
        return new Response(JSON.stringify({ system: {} }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });

    const res = await restartComfyUI();

    expect(res.stopped).toBe(true);
    expect(res.started).toBe(true);
    expect(res.ready).toBe(true);
    expect(res.message).toContain("rebooted via ComfyUI-Manager");
    expect(hoisted.resetClient).toHaveBeenCalledTimes(1);
    expect(hoisted.resetObjectInfoCache).toHaveBeenCalledTimes(1);
    // The 502 on the canonical POST route counts as "fired" — the legacy GET
    // route must never be tried.
    expect(findCall((p) => p === "/manager/reboot")).toBeUndefined();
  });

  it("Manager returns 403 → not started, manager-security note, does NOT throw", async () => {
    __processControlTestHooks.setRemoteRebootTimingForTests({
      settleMs: 0,
      budgetMs: 100,
      intervalMs: 5,
    });
    hoisted.fetchMock.mockImplementation(async (url: string) => {
      // Both routes end in "/manager/reboot"; refuse either with 403.
      if (pathOf(url).endsWith("/manager/reboot")) {
        return new Response("forbidden", { status: 403 });
      }
      return new Response("", { status: 404 });
    });

    const res = await restartComfyUI();

    expect(res.started).toBe(false);
    expect(res.stopped).toBe(false);
    expect(res.message).toContain("403");
    expect(res.message).toContain("security");
    // A refusal must not arm a readiness poll or reset the client.
    expect(findCall((p) => p === "/system_stats")).toBeUndefined();
    expect(hoisted.resetClient).not.toHaveBeenCalled();
  });

  it("reboot fires but readiness never returns within budget → not started, timeout message", async () => {
    __processControlTestHooks.setRemoteRebootTimingForTests({
      settleMs: 0,
      budgetMs: 30,
      intervalMs: 10,
    });
    hoisted.fetchMock.mockImplementation(async (url: string) => {
      const path = pathOf(url);
      if (path === "/v2/manager/reboot") return new Response("", { status: 200 });
      if (path === "/system_stats") throw new Error("ECONNRESET");
      return new Response("", { status: 404 });
    });

    const res = await restartComfyUI();

    expect(res.stopped).toBe(true);
    expect(res.started).toBe(false);
    expect(res.ready).toBe(false);
    expect(res.message).toContain("did not come back within 30ms");
    expect(hoisted.resetClient).not.toHaveBeenCalled();
  });

  it("local mode routes through stop/start — the remote reboot path is not taken", async () => {
    hoisted.remoteMode.value = false;
    // No PID on the port and no Desktop app process → stopComfyUI can't find it.
    hoisted.execSync.mockImplementation(() => "");
    hoisted.fetchMock.mockImplementation(async () => new Response("", { status: 200 }));

    const res = await restartComfyUI();

    // Went down the local stop→start path (which reports it couldn't stop),
    // never the Manager reboot path.
    expect(res.started).toBe(false);
    expect(res.message).toContain("Could not stop");
    expect(findCall((p) => p.endsWith("/manager/reboot"))).toBeUndefined();
  });
});
