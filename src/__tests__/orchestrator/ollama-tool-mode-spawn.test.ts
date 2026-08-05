// #788 — the tool mode the comfyui CHILD is actually spawned with.
//
// The reconcile tests in ollama-audio.test.ts stub `connectTools` wholesale, so
// they pin the DECISION but not the wiring: production could stop passing the
// live model into comfyuiSpawnEnv and they would all still pass, while the
// respawned child came up compact for a 70B model — the auto-selected surface
// silently not applied, which is the whole of #788. This file mocks the MCP SDK
// instead and asserts on the environment the child process is really given.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Every env the backend handed to a spawned stdio child, in order. */
const spawnEnvs: Array<Record<string, string>> = [];

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: class {
    constructor(opts: { env?: Record<string, string> }) {
      spawnEnvs.push({ ...(opts.env ?? {}) });
    }
    async close() {}
  },
}));

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    async connect() {}
    async listTools() {
      return { tools: [{ name: "list_tools", description: "d", inputSchema: { type: "object" } }] };
    }
    async close() {}
  },
}));

const { OllamaBackend } = await import("../../orchestrator/ollama-backend.js");

beforeEach(() => {
  spawnEnvs.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/version")) return new Response(JSON.stringify({ version: "0.31.1" }), { status: 200 });
      return new Response("{}", { status: 200 });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.COMFYUI_MCP_TOOL_MODE;
});

function backendFor(model: string) {
  return new OllamaBackend({
    model,
    mcpServers: { comfyui: { transport: "stdio", command: "node", args: [], env: {} } },
  });
}

describe("#788 — the spawned comfyui child really gets the mode chosen for the MODEL", () => {
  it("spawns compact for a small model", async () => {
    await backendFor("qwen3:4b").prepare();
    expect(spawnEnvs).toHaveLength(1);
    expect(spawnEnvs[0].COMFYUI_MCP_TOOL_MODE).toBe("compact");
  });

  it("spawns full for a large model", async () => {
    await backendFor("llama3.3:70b").prepare();
    expect(spawnEnvs[0].COMFYUI_MCP_TOOL_MODE).toBe("full");
  });

  it("a live switch RESPAWNS the child with the new model's mode, not the old one's", async () => {
    const backend = backendFor("qwen3:4b");
    await backend.prepare();
    expect(spawnEnvs[0].COMFYUI_MCP_TOOL_MODE).toBe("compact");

    await backend.setModel("llama3.3:70b");
    await (backend as unknown as { reconcileToolModeForModel: () => Promise<void> }).reconcileToolModeForModel();
    // The child the 70B model will actually call through must be the full one.
    expect(spawnEnvs).toHaveLength(2);
    expect(spawnEnvs[1].COMFYUI_MCP_TOOL_MODE).toBe("full");
  });

  it("an explicit user choice is still what the child is spawned with, in both directions", async () => {
    process.env.COMFYUI_MCP_TOOL_MODE = "compact";
    const backend = backendFor("qwen3:4b");
    await backend.prepare();
    expect(spawnEnvs[0].COMFYUI_MCP_TOOL_MODE).toBe("compact");
    await backend.setModel("llama3.3:70b");
    await (backend as unknown as { reconcileToolModeForModel: () => Promise<void> }).reconcileToolModeForModel();
    // Pinned: no respawn at all, and certainly not a full one.
    expect(spawnEnvs).toHaveLength(1);
  });
});
