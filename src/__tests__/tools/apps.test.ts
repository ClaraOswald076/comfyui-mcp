import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { z } from "zod";
import { DEAD_NAMES, TOOL_NAMES } from "../../tools/vocabulary.js";

// The apps tool is a thin proxy over the panel pack's
// /comfyui_mcp_panel/apps/* routes — mock fetch, keep the real URL building +
// error translation. Since 0.49.0 slice 2 the five apps_* tools are ONE
// action-parameterized `apps` tool; every action must still hit exactly the
// route, method and body its predecessor did.

import { registerAppsTools } from "../../tools/apps.js";

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
}>;

interface Registered {
  name: string;
  shape: z.ZodRawShape;
  handler: ToolHandler;
}

function registered(): Registered[] {
  const tools: Registered[] = [];
  const server = {
    tool: (name: string, _d: string, shape: z.ZodRawShape, h: ToolHandler) => {
      tools.push({ name, shape, handler: h });
    },
  };
  registerAppsTools(server as never);
  return tools;
}

/** The single `apps` handler. */
function apps(): ToolHandler {
  const tools = registered();
  if (tools.length !== 1 || tools[0].name !== "apps") {
    throw new Error(`expected one tool named apps, got ${tools.map((t) => t.name).join(", ")}`);
  }
  return tools[0].handler;
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

describe("apps tool registration", () => {
  it("registers exactly one tool named `apps` (5→1)", () => {
    const tools = registered();
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("apps");
  });

  // The whole reason for the flat-enum shape rule: a z.discriminatedUnion renders
  // as ZERO parameters, hiding every input from the model.
  it("exposes a visible flat `action` enum with every per-action parameter", () => {
    const [{ shape }] = registered();
    const json = z.toJSONSchema(z.object(shape)) as {
      properties?: Record<string, { enum?: string[] }>;
      required?: string[];
    };
    expect(Object.keys(json.properties ?? {}).sort()).toEqual([
      "action", "app_id", "prompt_id", "registry_url", "slug", "values", "version",
    ]);
    expect(json.properties?.action.enum?.sort()).toEqual([
      "get", "import", "list", "run", "run_status",
    ]);
    // Only `action` can be required — the others differ per action and are
    // enforced in the handler, which reports the field by name.
    expect(json.required).toEqual(["action"]);
  });
});

describe("apps action dispatch", () => {
  it('action:"list" proxies GET /comfyui_mcp_panel/apps', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ apps: [{ id: APP_ID, name: "X" }] }));
    const res = await apps()({ action: "list" });
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(res.content[0].text).apps[0].name).toBe("X");
    expect(String(fetchMock.mock.calls[0][0])).toContain("/comfyui_mcp_panel/apps");
  });

  it('action:"list" explains a missing Apps API (old panel pack)', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, 404));
    const res = await apps()({ action: "list" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("predates the Apps feature");
  });

  it('action:"get" proxies GET /comfyui_mcp_panel/apps/<id>', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: APP_ID, has_prompt: true }));
    const res = await apps()({ action: "get", app_id: APP_ID });
    expect(JSON.parse(res.content[0].text).has_prompt).toBe(true);
    expect(String(fetchMock.mock.calls[0][0])).toContain(`/comfyui_mcp_panel/apps/${APP_ID}`);
  });

  it('action:"run" POSTs values and returns the prompt_id', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, prompt_id: "p1" }));
    const res = await apps()({ action: "run", app_id: APP_ID, values: { "6.text": "a dog" } });
    expect(JSON.parse(res.content[0].text).prompt_id).toBe("p1");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain(`/comfyui_mcp_panel/apps/${APP_ID}/run`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ values: { "6.text": "a dog" } });
  });

  it('action:"run" with no values still POSTs an empty object', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, prompt_id: "p1" }));
    await apps()({ action: "run", app_id: APP_ID });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ values: {} });
  });

  it('action:"run" surfaces the server\'s validation error', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: "patch targets unknown node 99" }, 400));
    const res = await apps()({ action: "run", app_id: APP_ID, values: { "99.text": "x" } });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("unknown node 99");
  });

  it('action:"run_status" hits the runs route', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ status: "done", outputs: {} }));
    const res = await apps()({ action: "run_status", app_id: APP_ID, prompt_id: "p1" });
    expect(JSON.parse(res.content[0].text).status).toBe("done");
    expect(String(fetchMock.mock.calls[0][0])).toContain(`/apps/${APP_ID}/runs/p1`);
  });

  it("transport failure is a readable error, not a crash", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    const res = await apps()({ action: "list" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("Cannot reach the panel's Apps API");
  });

  it('action:"import" fetches the registry bundle and POSTs it to the panel', async () => {
    const REG = "https://reg.example.workers.dev";
    process.env.COMFYUI_MCP_REGISTRY_URLS = REG;
    try {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === `${REG}/v1/apps/${APP_ID}/bundle`) {
        return jsonResponse({
          manifest: { id: APP_ID, name: "Cloud App", deps: { models: [], customNodes: [] } },
          prompt: { 6: { class_type: "CLIPTextEncode", inputs: { text: "x" } } },
          workflow: { nodes: [] },
        });
      }
      if (url === `${REG}/v1/apps/${APP_ID}/thumbnail`) {
        return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
      }
      if (url.endsWith("/comfyui_mcp_panel/apps") && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as {
          manifest: { id: string; source: { type: string }; published: { slug: string } };
          thumbnail_b64?: string;
        };
        expect(body.manifest.id).toBe(APP_ID);
        expect(body.manifest.source.type).toBe("registry");
        expect(body.manifest.published.slug).toBe("maker/cloud-app");
        expect(body.thumbnail_b64).toBe(Buffer.from([1, 2, 3]).toString("base64"));
        return jsonResponse({ ok: true, id: APP_ID });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    const res = await apps()({
      action: "import",
      registry_url: REG,
      app_id: APP_ID,
      slug: "maker/cloud-app",
      version: 3,
    });
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(res.content[0].text).ok).toBe(true);
    } finally {
      delete process.env.COMFYUI_MCP_REGISTRY_URLS;
    }
  });

  it('action:"import" rejects a registry URL outside the allowlist', async () => {
    const res = await apps()({
      action: "import",
      registry_url: "http://169.254.169.254/latest",
      app_id: APP_ID,
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("allowlisted");
  });

  it('action:"run_status" rejects a traversal-shaped prompt_id', async () => {
    const res = await apps()({
      action: "run_status",
      app_id: APP_ID,
      prompt_id: "../../../../system_stats",
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("invalid prompt_id");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // app_id / prompt_id / registry_url cannot be schema-required in a flat enum
  // shape, so the handler enforces them and names the missing field. Nothing may
  // reach the network on the way.
  it("reports the missing per-action argument, and calls nothing", async () => {
    for (const action of ["get", "run", "run_status", "import"]) {
      const res = await apps()({ action });
      expect(res.isError, action).toBe(true);
      expect(res.content[0].text, action).toContain("app_id");
    }
    const noPrompt = await apps()({ action: "run_status", app_id: APP_ID });
    expect(noPrompt.isError).toBe(true);
    expect(noPrompt.content[0].text).toContain("invalid prompt_id");

    const noUrl = await apps()({ action: "import", app_id: APP_ID });
    expect(noUrl.isError).toBe(true);
    expect(noUrl.content[0].text).toContain("registry_url");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("an unknown action returns a clear error result", async () => {
    const res = await apps()({ action: "bogus" });
    expect(res.isError).toBe(true);
    const text = res.content.map((c) => c.text).join(" ");
    expect(text).toMatch(/unknown apps action/i);
    expect(text).toMatch(/list, get, run, run_status, import/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("the five apps_* names are retired", () => {
  const old = ["apps_list", "apps_get", "apps_run", "apps_run_status", "apps_import"];

  it("each old name is in DEAD_NAMES with replacement `apps`", () => {
    for (const name of old) {
      const entry = DEAD_NAMES.find((d) => d.name === name);
      expect(entry, `${name} must be declared dead`).toBeDefined();
      expect(entry!.since).toBe("0.49.0");
      expect(entry!.replacement).toContain("apps");
    }
  });

  it("no old name is still in the live ledger, and `apps` is", () => {
    for (const name of old) expect(TOOL_NAMES as readonly string[]).not.toContain(name);
    expect(TOOL_NAMES as readonly string[]).toContain("apps");
  });
});
