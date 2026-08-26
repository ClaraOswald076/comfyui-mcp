import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";

const state = vi.hoisted(() => ({
  baseUrl: "http://127.0.0.1:8188",
  headlessCalls: 0,
}));

vi.mock("../../config.js", () => ({
  getComfyUIBaseUrl: () => state.baseUrl,
  getComfyUIAuthHeaders: () => ({}),
}));

vi.mock("../../comfyui/fetch.js", () => ({
  comfyuiFetch: async () => {
    state.headlessCalls += 1;
    throw new Error("the panel-backed path must not use COMFYUI_URL");
  },
}));

vi.mock("../../services/api-nodes.js", () => ({
  checkWorkflowRuntime: vi.fn(),
  extractWorkflowClassTypes: vi.fn(),
}));

vi.mock("../../services/workflow-deps.js", () => ({
  extractWorkflowDependencies: vi.fn(),
  installWorkflowDependencies: vi.fn(),
  defaultWorkflowDepsDeps: () => ({ deps: "test" }),
}));

vi.mock("../../services/skill-cache.js", () => ({
  generateSkillCached: vi.fn(),
}));

vi.mock("../../services/manifest.js", () => ({
  resolvePackManifestFile: vi.fn(),
}));

import { registerSkillsAccessTools } from "../../tools/skills-access.js";
import { startPanelTemplateRelayServer } from "../../services/panel-template-relay.js";
import { createPanelTemplateRelayWiring } from "../../orchestrator/index.js";

const SECRET = "b".repeat(64);
const servers: Array<{ close(): Promise<void> }> = [];

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");
  return `http://127.0.0.1:${address.port}`;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function listPacksHandler(): (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }> {
  const tools: Array<{ handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }> }> = [];
  registerSkillsAccessTools({
    tool: (_name: string, _description: string, _shape: unknown, handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>) => {
      tools.push({ handler });
    },
  } as never);
  if (tools.length !== 1) throw new Error(`expected one list_packs tool, got ${tools.length}`);
  return tools[0].handler;
}

afterEach(async () => {
  delete process.env.COMFYUI_MCP_RELAY_SECRET;
  delete process.env.COMFYUI_MCP_TEMPLATE_RELAY_URL;
  state.headlessCalls = 0;
  for (const server of servers.splice(0)) await server.close();
  vi.restoreAllMocks();
});

describe("list_packs -> panel template relay production boundary (#2196)", () => {
  it("drives action:list_templates through the real child request and relay before headless fetch", async () => {
    const panel = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ "panel-pack": [{ name: "live-template" }] }));
    });
    const panelOrigin = await listen(panel);
    servers.push({ close: () => closeServer(panel) });

    const relay = await startPanelTemplateRelayServer({
      bridge: { canReach: () => true },
      resolvePanelAgent: () => ({ agentKey: "orchestrator::codex", secret: SECRET }),
      resolvePanelTab: () => "tab-1",
      resolveCurrentTarget: () => ({ url: state.baseUrl, generation: 0 }),
      resolvePanelUrl: () => `${panelOrigin}/api/workflow_templates`,
      resolveAllowedPanelOrigin: () => panelOrigin,
    });
    servers.push(relay);
    process.env.COMFYUI_MCP_RELAY_SECRET = SECRET;
    process.env.COMFYUI_MCP_TEMPLATE_RELAY_URL = relay.endpointUrl;
    state.baseUrl = `${panelOrigin}/comfyapi`;

    const result = await listPacksHandler()({ action: "list_templates" });
    const rendered = JSON.parse(result.content.map((block) => block.text).join(" ")) as Record<string, unknown>;
    expect(rendered).toMatchObject({
      source_count: 1,
      template_count: 1,
      templates: { "panel-pack": [{ name: "live-template" }] },
    });
    expect(state.headlessCalls).toBe(0);
  });
  // #2382/#2385 REGRESSION PIN. 0.52.135 dropped "localhost" from the relay's
  // loopback set, so this exact call returned "The connected panel template
  // relay failed (NO_PANEL_ORIGIN)." instead of the index for every user whose
  // ComfyUI is served at http://localhost:<port>. The headless COMFYUI_URL path
  // is fail-closed once a panel route exists, so there was nothing to fall back
  // to. This drives the REAL orchestrator wiring, not a hand-written origin
  // resolver, because the defect lived in what that wiring authorizes.
  it("serves list_templates through the relay when the panel is served at localhost", async () => {
    const panel = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ "panel-pack": [{ name: "localhost-template" }] }));
    });
    const boundOrigin = await listen(panel);
    servers.push({ close: () => closeServer(panel) });
    const port = new URL(boundOrigin).port;
    const localhostOrigin = `http://localhost:${port}`;
    state.baseUrl = `${localhostOrigin}/comfyapi`;

    const bridge = {
      canReach: () => true,
      resolveFailure: () => undefined,
      resolveSharedTabId: () => "tab-1",
      tabServerOrigin: () => localhostOrigin,
    };
    const relay = await startPanelTemplateRelayServer({
      bridge,
      ...createPanelTemplateRelayWiring({
        bridge,
        currentTarget: () => state.baseUrl,
        currentTargetGeneration: () => 0,
        secrets: new Map([[SECRET, "orchestrator::codex"]]),
      }),
    });
    servers.push(relay);
    process.env.COMFYUI_MCP_RELAY_SECRET = SECRET;
    process.env.COMFYUI_MCP_TEMPLATE_RELAY_URL = relay.endpointUrl;

    const result = await listPacksHandler()({ action: "list_templates" });
    const text = result.content.map((block) => block.text).join(" ");
    expect(text).not.toContain("NO_PANEL_ORIGIN");
    expect(JSON.parse(text)).toMatchObject({
      source_count: 1,
      template_count: 1,
      templates: { "panel-pack": [{ name: "localhost-template" }] },
    });
    expect(state.headlessCalls).toBe(0);
  });
});
