// model_metadata talked to a DIFFERENT ComfyUI than every other tool.
//
// `comfyBase()` re-derived the address from raw env — `COMFYUI_URL`, else
// `COMFYUI_PORT` on loopback, else 127.0.0.1:8188 — while the rest of the
// codebase resolves it through `getComfyUIBaseUrl()`. Those disagree on three
// counts, each of which breaks a real deployment:
//
//   - PROTOCOL: an https ComfyUI (config.comfyuiSsl) was addressed as http.
//   - HOST:     the config-resolved host was ignored in favour of raw env.
//   - BASE PATH: a reverse-proxied install (`/comfyapi`) had its prefix dropped,
//                so every request 404'd against the proxy.
//
// And because the calls used bare `fetch`, they carried no COMFYUI_AUTH_*
// headers either — so an authenticated ComfyUI rejected them outright. That is
// exactly the class of deployment #952 and #954 were about, and this tool was
// never migrated with the others.
//
// They also inherited no timeout, which #1033's ceiling now supplies.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cfg = vi.hoisted(() => ({
  comfyuiBasePath: "",
  comfyuiSsl: false,
  comfyuiHost: "127.0.0.1",
  comfyuiPort: 8188,
}));

vi.mock("../../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config.js")>();
  return {
    ...actual,
    isRemoteMode: () => false,
    getComfyUIBaseUrl: () =>
      `${cfg.comfyuiSsl ? "https" : "http"}://${cfg.comfyuiHost}:${cfg.comfyuiPort}${cfg.comfyuiBasePath}`,
    getComfyUIAuthHeaders: () => ({ Authorization: "Bearer test-token" }),
    config: { ...actual.config, huggingfaceToken: undefined },
  };
});

const { registerModelExplorerTools } = await import("../../tools/model-explorer.js");

/** Capture the tool handlers the server registers. */
function collect(): Map<string, (args: Record<string, unknown>) => Promise<unknown>> {
  const tools = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>();
  const server = {
    tool: (name: string, _d: unknown, _s: unknown, handler: (a: Record<string, unknown>) => Promise<unknown>) => {
      tools.set(name, handler);
    },
  } as unknown as Parameters<typeof registerModelExplorerTools>[0];
  registerModelExplorerTools(server);
  return tools;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  cfg.comfyuiBasePath = "";
  cfg.comfyuiSsl = false;
  cfg.comfyuiHost = "127.0.0.1";
  cfg.comfyuiPort = 8188;
  fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ classify: {}, namespaces: {} }), { status: 200 }),
  );
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function readOnce(): Promise<void> {
  const read = collect().get("model_metadata")!;
  await read({ action: "read", category: "loras", name: "x.safetensors" });
}

describe("model_metadata addresses the SAME ComfyUI as every other tool", () => {
  it("honours the reverse-proxy base path", async () => {
    cfg.comfyuiBasePath = "/comfyapi";
    await readOnce();
    expect(String(fetchMock.mock.calls[0][0])).toContain("/comfyapi/model_explorer/detail");
  });

  it("honours https", async () => {
    cfg.comfyuiSsl = true;
    await readOnce();
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/^https:\/\//);
  });

  it("honours the configured host and port", async () => {
    cfg.comfyuiHost = "gpu.local";
    cfg.comfyuiPort = 9999;
    await readOnce();
    expect(String(fetchMock.mock.calls[0][0])).toContain("http://gpu.local:9999/");
  });

  // The auth gap. Going through comfyuiFetch is what injects COMFYUI_AUTH_*;
  // a bare fetch reached an authenticated ComfyUI with no credentials at all.
  it("sends the configured auth header", async () => {
    await readOnce();
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer test-token");
  });

  // #1033's ceiling rides along, so these can no longer wait forever.
  it("carries a timeout", async () => {
    await readOnce();
    expect((fetchMock.mock.calls[0][1] as RequestInit).signal).toBeInstanceOf(AbortSignal);
  });
});
