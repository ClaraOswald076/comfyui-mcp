import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

// The apps tools are thin proxies over the panel pack's
// /comfyui_mcp_panel/apps/* routes — mock fetch, keep the real URL building +
// error translation.

import { registerAppsTools } from "../../tools/apps.js";

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
}>;

function getHandler(name: string): ToolHandler {
  let handler: ToolHandler | undefined;
  const server = {
    tool: (n: string, _d: string, _s: unknown, h: ToolHandler) => {
      if (n === name) handler = h;
    },
  };
  registerAppsTools(server as never);
  if (!handler) throw new Error(`tool ${name} not registered`);
  return handler;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const APP_ID = "123e4567-e89b-42d3-a456-426614174000";

describe("apps tools", () => {
  it("apps_list proxies GET /comfyui_mcp_panel/apps", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ apps: [{ id: APP_ID, name: "X" }] }));
    const res = await getHandler("apps_list")({});
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(res.content[0].text).apps[0].name).toBe("X");
    expect(String(fetchMock.mock.calls[0][0])).toContain("/comfyui_mcp_panel/apps");
  });

  it("apps_list explains a missing Apps API (old panel pack)", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, 404));
    const res = await getHandler("apps_list")({});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("predates the Apps feature");
  });

  it("apps_run POSTs values and returns the prompt_id", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, prompt_id: "p1" }));
    const res = await getHandler("apps_run")({ app_id: APP_ID, values: { "6.text": "a dog" } });
    expect(JSON.parse(res.content[0].text).prompt_id).toBe("p1");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain(`/comfyui_mcp_panel/apps/${APP_ID}/run`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ values: { "6.text": "a dog" } });
  });

  it("apps_run surfaces the server's validation error", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: "patch targets unknown node 99" }, 400));
    const res = await getHandler("apps_run")({ app_id: APP_ID, values: { "99.text": "x" } });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("unknown node 99");
  });

  it("apps_run_status hits the runs route", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ status: "done", outputs: {} }));
    const res = await getHandler("apps_run_status")({ app_id: APP_ID, prompt_id: "p1" });
    expect(JSON.parse(res.content[0].text).status).toBe("done");
    expect(String(fetchMock.mock.calls[0][0])).toContain(`/apps/${APP_ID}/runs/p1`);
  });

  it("transport failure is a readable error, not a crash", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    const res = await getHandler("apps_list")({});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("Cannot reach the panel's Apps API");
  });

  it("apps_import fetches the registry bundle and POSTs it to the panel", async () => {
    const REG = "https://reg.example.workers.dev";
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === `${REG}/v1/apps/${APP_ID}/bundle`) {
        return jsonResponse({
          manifest: { id: APP_ID, name: "Cloud App", deps: { models: [], customNodes: [] } },
          prompt: { 6: { class_type: "CLIPTextEncode", inputs: { text: "x" } } },
          workflow: { nodes: [] },
        });
      }
      if (url.endsWith("/comfyui_mcp_panel/apps") && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as {
          manifest: { id: string; source: { type: string }; published: { slug: string } };
        };
        expect(body.manifest.id).toBe(APP_ID);
        expect(body.manifest.source.type).toBe("registry");
        expect(body.manifest.published.slug).toBe("maker/cloud-app");
        return jsonResponse({ ok: true, id: APP_ID });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    const res = await getHandler("apps_import")({
      registry_url: REG,
      app_id: APP_ID,
      slug: "maker/cloud-app",
      version: 3,
    });
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(res.content[0].text).ok).toBe(true);
  });

  it("apps_import rejects a non-http registry URL", async () => {
    const res = await getHandler("apps_import")({ registry_url: "file:///etc/passwd", app_id: APP_ID });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("http(s)");
  });
});
