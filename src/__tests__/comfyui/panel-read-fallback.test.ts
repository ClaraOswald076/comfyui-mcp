import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const panelRead = vi.hoisted(() => vi.fn());
const fetchApi = vi.hoisted(() => vi.fn());

vi.mock("../../config.js", async () => {
  const actual = await vi.importActual<typeof import("../../config.js")>("../../config.js");
  return {
    ...actual,
    config: { ...actual.config, comfyuiBasePath: "/comfyapi", comfyuiPath: "" },
    getComfyUIApiHost: () => "127.0.0.1:8188",
    getComfyUIBasePath: () => "/comfyapi",
    getComfyUIBaseUrl: () => "http://127.0.0.1:8188/comfyapi",
    getComfyUIAuthHeaders: () => ({ Authorization: "Bearer headless-token" }),
    isCloudMode: () => false,
    isRemoteMode: () => true,
  };
});

vi.mock("@stable-canvas/comfyui-client", () => ({
  Client: class {
    apiURL(path: string): string {
      return path;
    }

    apiHeaders(init?: { headers?: unknown }): unknown {
      return init?.headers ?? {};
    }

    async fetch(url: string, init?: unknown): Promise<unknown> {
      return await fetchApi(url, init);
    }

    fetchApi = fetchApi;
    close() {}
  },
}));

vi.mock("../../services/panel-image-relay.js", async () => {
  const actual = await vi.importActual<typeof import("../../services/panel-image-relay.js")>(
    "../../services/panel-image-relay.js",
  );
  return { ...actual, requestPanelComfyUIRead: panelRead };
});

import {
  fetchImage,
  getHistory,
  getLogs,
  getSystemStats,
  resetClient,
} from "../../comfyui/client.js";
import { PanelComfyUIReadRelayError } from "../../services/panel-image-relay.js";

function transportFailure(): TypeError {
  return new TypeError(
    "fetch failed",
    { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) },
  );
}

beforeEach(() => {
  fetchApi.mockReset();
  panelRead.mockReset();
  resetClient();
  vi.stubGlobal("fetch", vi.fn(async () => { throw transportFailure(); }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("authenticated panel-backed ComfyUI read fallback (#2283)", () => {
  it("maps history, system_stats, and logs to the panel operations and parses bodies", async () => {
    fetchApi.mockRejectedValue(transportFailure());
    panelRead.mockImplementation(async (operation: string) => {
      if (operation === "history") {
        const body = '{"prompt-1":{"status":{"status_str":"success"}}}';
        return {
          operation,
          body,
          contentType: "application/json",
          bytes: Buffer.byteLength(body, "utf8"),
        };
      }
      if (operation === "logs") {
        const body = JSON.stringify("line one\nline two");
        return { operation, body, contentType: "text/plain", bytes: Buffer.byteLength(body, "utf8") };
      }
      const body = '{"system":{"os":"windows"},"devices":[]}';
      return { operation, body, contentType: "application/json", bytes: Buffer.byteLength(body, "utf8") };
    });

    await expect(getHistory()).resolves.toEqual({
      "prompt-1": { status: { status_str: "success" } },
    });
    await expect(getSystemStats()).resolves.toMatchObject({ system: { os: "windows" }, devices: [] });
    await expect(getLogs()).resolves.toEqual(["line one", "line two"]);
    expect(panelRead.mock.calls.map(([operation]) => operation)).toEqual([
      "history",
      "system_stats",
      "logs",
    ]);
  });

  it("does not use the panel for a configured-route HTTP error, timeout, or prompt-scoped history", async () => {
    fetchApi.mockResolvedValue(new Response("gateway down", { status: 503 }));
    await expect(getHistory()).rejects.toThrow();
    expect(panelRead).not.toHaveBeenCalled();

    fetchApi.mockReset();
    fetchApi.mockRejectedValue(transportFailure());
    const timedOut = new Error("request timed out");
    timedOut.name = "TimeoutError";
    vi.stubGlobal("fetch", vi.fn(async () => { throw timedOut; }));
    await expect(getSystemStats()).rejects.toThrow(/No reply from ComfyUI within/);
    expect(panelRead).not.toHaveBeenCalled();

    vi.stubGlobal("fetch", vi.fn(async () => { throw transportFailure(); }));
    await expect(getHistory("prompt-1")).rejects.toThrow(/fetch failed/);
    await expect(fetchImage("render.png")).rejects.toThrow(/fetch failed/);
    expect(panelRead).not.toHaveBeenCalled();

    fetchApi.mockReset();
    fetchApi.mockRejectedValueOnce(new Error("HTTP 503 from the configured route"));
    fetchApi.mockRejectedValueOnce(transportFailure());
    await expect(getLogs()).rejects.toThrow(/ECONNREFUSED|Failed to fetch ComfyUI logs/);
    expect(panelRead).not.toHaveBeenCalled();
  });

  it("surfaces an authenticated panel timeout/error without retrying unrelated origins", async () => {
    fetchApi.mockRejectedValue(transportFailure());
    panelRead.mockRejectedValue(new PanelComfyUIReadRelayError("panel timed out", "TIMEOUT"));

    await expect(getLogs()).rejects.toThrow(/read fallback failed safely \(TIMEOUT\)/);
    expect(panelRead).toHaveBeenCalledWith("logs");
  });
});
