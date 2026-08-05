// #788 — the tool mode the comfyui CHILD is actually spawned with.
//
// The reconcile tests in ollama-audio.test.ts stub `connectTools` wholesale, so
// they pin the DECISION but not the wiring: production could stop passing the
// live model into comfyuiSpawnEnv and they would all still pass, while the
// respawned child came up compact for a 70B model — the auto-selected surface
// silently not applied, which is the whole of #788. This file mocks the MCP SDK
// instead and asserts on the environment the child process is really given.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Every env a stdio child was handed by a COMPLETED `Client.connect`, in order.
 *
 * Recorded in the mocked connect rather than in the transport constructor: a
 * transport that is built and never connected spawns nothing, so asserting on
 * construction alone would let "we computed the right env and never used it"
 * pass as "the child came up in the right mode". The mock also refuses to serve
 * tools before that connect finishes, so a connect whose result is not waited
 * for fails here the way it would in production — an unconnected client that
 * still gets asked for its catalog.
 */
const spawnEnvs: Array<Record<string, string>> = [];

class FakeStdioTransport {
  env: Record<string, string>;
  constructor(opts: { env?: Record<string, string> }) {
    this.env = { ...(opts.env ?? {}) };
  }
  async close() {}
}

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: FakeStdioTransport,
}));

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    connected = false;
    async connect(transport: FakeStdioTransport) {
      // A real connect spawns a process and handshakes; it does not complete in
      // the caller's tick. The macrotask makes "the caller didn't wait" visible
      // rather than accidentally harmless.
      await new Promise((r) => setTimeout(r, 0));
      this.connected = true;
      spawnEnvs.push(transport.env);
    }
    async listTools() {
      if (!this.connected) throw new Error("listTools before connect completed");
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

/** The tool surface this backend really ended up with. */
function surfaceOf(backend: unknown) {
  return backend as { toolModeDecision: { mode: string } | null; comfyTools: unknown[] };
}

function backendFor(model: string) {
  return new OllamaBackend({
    model,
    mcpServers: { comfyui: { transport: "stdio", command: "node", args: [], env: {} } },
  });
}

describe("#788 — the spawned comfyui child really gets the mode chosen for the MODEL", () => {
  it("spawns compact for a small model", async () => {
    const backend = backendFor("qwen3:4b");
    await backend.prepare();
    expect(spawnEnvs).toHaveLength(1);
    expect(spawnEnvs[0].COMFYUI_MCP_TOOL_MODE).toBe("compact");
    // …and the surface is LIVE: a connect that was fired and not waited for
    // leaves the catalog unreadable, which connectTools turns into no decision
    // at all. Asserting the env alone would not notice.
    expect(surfaceOf(backend).toolModeDecision?.mode).toBe("compact");
    expect(surfaceOf(backend).comfyTools).toHaveLength(1);
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
