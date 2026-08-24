// #1670 — after a CUDA crash, /history and /internal/logs answer HTTP 502 with
// an EMPTY body. Diagnostics used to append the SPA-catch-all remedy
// ("Confirm the configured ComfyUI base URL really is a ComfyUI API root")
// even though the same endpoint had just served /system_stats JSON.
//
// These tests drive the SHIPPED tools — get_history (action:"diagnose") and
// get_system_stats (action:"logs") — through the real client wiring. Mocking
// classifyNonJson or getHistory would let the wrong next-step survive.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../config.js", () => ({
  config: { comfyuiSsl: false, comfyuiPath: "", comfyuiBasePath: "" },
  getComfyUIApiHost: () => "remote.example:8188",
  getComfyUIBasePath: () => "",
  getComfyUIBaseUrl: () => "http://remote.example:8188",
  getComfyUIAuthHeaders: () => ({}),
  isCloudMode: () => false,
  isRemoteMode: () => true,
}));

import { resetClient } from "../../comfyui/client.js";
import { resetComfyApiRootValidated } from "../../comfyui/json-guard.js";
import { registerDiagnosticsTools } from "../../tools/diagnostics.js";
import { registerSystemStatsTools } from "../../tools/system-stats.js";
import { getEnvironmentAction } from "../../tools/workspace-env.js";

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

function getHandler(
  name: string,
  register: (server: never) => void,
): ToolHandler {
  let handler: ToolHandler | undefined;
  const server = {
    tool: (n: string, _d: string, _s: unknown, h: ToolHandler) => {
      if (n === name) handler = h;
    },
  };
  register(server as never);
  if (!handler) throw new Error(`tool ${name} not registered`);
  return handler;
}

function empty502(): Response {
  return new Response(null, { status: 502, statusText: "Bad Gateway" });
}

function statsOk(): Response {
  return new Response(
    JSON.stringify({
      system: { comfyui_version: "0.33.1" },
      devices: [{ name: "cuda:0" }],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function undiciFailure(code: string, detail: string): Error {
  const cause = new Error(detail);
  (cause as { code?: string }).code = code;
  return new TypeError("fetch failed", { cause });
}

/** Route /system_stats to JSON while healthy; everything else is the post-crash 502. */
function serve(mode: { healthy: boolean }): void {
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const href = String(input);
    if (mode.healthy && href.includes("/system_stats")) return statsOk();
    return empty502();
  }) as unknown as typeof fetch;
}

function expectOutageNotMisconfig(text: string): void {
  expect(text).toContain("502");
  expect(text).toContain("EMPTY body");
  expect(text).toMatch(/temporary server outage/i);
  expect(text).not.toContain("Confirm the configured ComfyUI base URL");
  expect(text).not.toContain("the same catch-all that produced this page");
  expect(text).not.toContain("really is a ComfyUI API root");
}

beforeEach(() => {
  vi.clearAllMocks();
  resetClient();
  resetComfyApiRootValidated();
});

describe("post-CUDA-crash empty 502 is an outage, not a base-URL misconfig (#1670)", () => {
  it('get_history (action:"diagnose") does not prescribe reconfiguring the base URL', async () => {
    serve({ healthy: false });
    const out = await getHandler("get_history", registerDiagnosticsTools)({ action: "diagnose" });
    expect(out.isError).toBe(true);
    const text = out.content[0].text;
    expect(text).toContain("/history");
    expectOutageNotMisconfig(text);
  });

  it('get_system_stats (action:"logs") does not prescribe reconfiguring the base URL', async () => {
    serve({ healthy: false });
    const out = await getHandler("get_system_stats", registerSystemStatsTools)({ action: "logs" });
    expect(out.isError).toBe(true);
    const text = out.content[0].text;
    expect(text).toContain("/internal/logs");
    expectOutageNotMisconfig(text);
  });

  it("a prior successful /system_stats makes the 502 name the previously-working root", async () => {
    const mode = { healthy: true };
    serve(mode);

    const stats = await getHandler("get_system_stats", registerSystemStatsTools)({ action: "stats" });
    expect(stats.isError).not.toBe(true);
    expect(stats.content[0].text).toContain("0.33.1");

    // Same configured endpoint, now answering empty 502 the way nginx does
    // after ComfyUI dies on a CUDA illegal-memory-access.
    mode.healthy = false;

    const diagnose = await getHandler("get_history", registerDiagnosticsTools)({
      action: "diagnose",
    });
    const logs = await getHandler("get_system_stats", registerSystemStatsTools)({
      action: "logs",
    });

    for (const out of [diagnose, logs]) {
      expect(out.isError).toBe(true);
      const text = out.content[0].text;
      expectOutageNotMisconfig(text);
      expect(text).toContain("already served");
      expect(text).toContain("/system_stats");
      expect(text).toContain("not newly misconfigured");
    }
  });

  it('get_system_stats (action:"health") preserves transport details without a circular retry', async () => {
    global.fetch = vi.fn().mockRejectedValue(
      undiciFailure("ECONNREFUSED", "connect ECONNREFUSED remote.example:8188"),
    ) as unknown as typeof fetch;

    const out = await getHandler("get_system_stats", registerSystemStatsTools)({ action: "health" });
    expect(out.isError).toBe(true);
    const payload = JSON.parse(out.content[0].text) as { error: string; message: string };
    expect(payload.error).toBe("CONNECTION_ERROR");
    expect(payload.message).toContain("ECONNREFUSED");
    expect(payload.message).toContain("http://remote.example:8188/system_stats");
    expect(payload.message).toContain('install_comfyui (action:"environment")');
    expect(payload.message).toContain("independent readiness probe");
    expect(payload.message).not.toContain('get_system_stats (action:"health")');
  });

  it('health failure -> environment probe keeps nested error text non-recursive (#2188)', async () => {
    global.fetch = vi.fn().mockRejectedValue(
      undiciFailure("ECONNREFUSED", "connect ECONNREFUSED remote.example:8188"),
    ) as unknown as typeof fetch;

    const health = await getHandler("get_system_stats", registerSystemStatsTools)({ action: "health" });
    const healthPayload = JSON.parse(health.content[0].text) as { message: string };
    expect(healthPayload.message).toContain('install_comfyui (action:"environment")');

    const environment = await getEnvironmentAction();
    expect(environment.isError).not.toBe(true);
    const environmentPayload = JSON.parse(environment.content[0].text) as {
      running_instance: { reachable: boolean; error?: string };
    };
    const nested = environmentPayload.running_instance.error ?? "";
    expect(environmentPayload.running_instance.reachable).toBe(false);
    expect(nested).toContain("ECONNREFUSED");
    expect(nested).toContain("http://remote.example:8188/system_stats");
    expect(nested).toContain("COMFYUI_AUTH_*");
    expect(nested).not.toContain('install_comfyui (action:"environment")');
    expect(nested).not.toContain('get_system_stats (action:"health")');
  });
});
