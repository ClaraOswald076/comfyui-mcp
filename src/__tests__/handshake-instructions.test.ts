// #1747 — the MCP initialize handshake must carry the cross-cutting flows so
// every agent does not re-derive them from 37 tool descriptions.
//
// boot.ts seizes stdio, so a test cannot import it (same constraint as #1447).
// The text is executed here through a real McpServer handshake; the wiring into
// boot.ts / panel-mcp-http.ts is a text fact, checked the same way #1447 checks
// SERVER_VERSION.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  PANEL_HANDSHAKE_INSTRUCTIONS,
  PANEL_HANDSHAKE_INSTRUCTIONS_CEILING_BYTES,
  STDIO_HANDSHAKE_INSTRUCTIONS,
  STDIO_HANDSHAKE_INSTRUCTIONS_CEILING_BYTES,
} from "../handshake-instructions.js";

const bootSrc = readFileSync(new URL("../boot.ts", import.meta.url), "utf-8");
const panelHttpSrc = readFileSync(
  new URL("../orchestrator/panel-mcp-http.ts", import.meta.url),
  "utf-8",
);
const introspectSrc = readFileSync(new URL("../tools/introspect.ts", import.meta.url), "utf-8");
const callToolSrc = readFileSync(new URL("../orchestrator/index.ts", import.meta.url), "utf-8");

async function handshakeInstructionsOf(instructions: string): Promise<string | undefined> {
  const server = new McpServer(
    { name: "handshake-test", version: "0.0.0" },
    { capabilities: { tools: {} }, instructions },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "handshake-test-client", version: "0.0.0" });
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return client.getInstructions();
  } finally {
    await client.close();
    await server.close();
  }
}

describe("stdio handshake instructions (#1747)", () => {
  const bytes = Buffer.byteLength(STDIO_HANDSHAKE_INSTRUCTIONS, "utf8");

  it(`fits the recorded budget (${bytes} utf8 bytes ≤ ${STDIO_HANDSHAKE_INSTRUCTIONS_CEILING_BYTES})`, () => {
    // The number is the point of the test: this text is injected into every
    // client on every connect, so growth has to be a reviewed edit.
    expect(bytes).toBeGreaterThan(400);
    expect(bytes).toBeLessThanOrEqual(STDIO_HANDSHAKE_INSTRUCTIONS_CEILING_BYTES);
  });

  it("teaches the four cross-cutting flows without duplicating tool schemas", () => {
    const text = STDIO_HANDSHAKE_INSTRUCTIONS;

    // Call order / pre-flight.
    expect(text).toContain("get_system_stats");
    expect(text).toContain('action:"health"');
    expect(text).toContain("generate_image");
    expect(text).toContain("create_workflow");
    expect(text).toContain('action:"validate"');
    expect(text).toContain("enqueue_workflow");
    expect(text).toContain("list_packs");

    // Async handles to poll.
    expect(text).toContain("prompt_id");
    expect(text).toContain("download_model");
    expect(text).toContain('action:"status"');
    expect(text).toContain("get_history");
    expect(text).toMatch(/still running/i);

    // Compact discovery (the configuration where this block earns the most).
    expect(text).toContain("list_tools");
    expect(text).toContain("describe_tool");
    expect(text).toContain("call_tool");
    expect(text).toContain('"name"');
    expect(text).toContain('"args"');

    // Trust posture.
    expect(text).toContain("CONTENT");
    expect(text).toMatch(/model card/i);
    expect(text).toMatch(/not instructions/i);

    // Saved file vs live canvas — without pulling in the panel catalog.
    expect(text).toContain("get_workflow");
    expect(text).toContain("panel_*");

    // Not a schema dump.
    expect(text).not.toMatch(/"type"\s*:\s*"object"/);
    expect(text).not.toContain('"properties"');
    expect(text).not.toContain("z.string");
    expect(text).not.toContain("inputSchema");
  });

  it("an MCP client receives the block at initialize", async () => {
    await expect(handshakeInstructionsOf(STDIO_HANDSHAKE_INSTRUCTIONS)).resolves.toBe(
      STDIO_HANDSHAKE_INSTRUCTIONS,
    );
  });
});

describe("panel handshake instructions (#1747)", () => {
  const bytes = Buffer.byteLength(PANEL_HANDSHAKE_INSTRUCTIONS, "utf8");

  it(`fits the recorded budget (${bytes} utf8 bytes ≤ ${PANEL_HANDSHAKE_INSTRUCTIONS_CEILING_BYTES})`, () => {
    expect(bytes).toBeGreaterThan(120);
    expect(bytes).toBeLessThanOrEqual(PANEL_HANDSHAKE_INSTRUCTIONS_CEILING_BYTES);
  });

  it("is a live-canvas block, not a recap of the stdio catalog", () => {
    const text = PANEL_HANDSHAKE_INSTRUCTIONS;
    expect(text).toContain("panel_graph_outline");
    expect(text).toContain("panel_query_graph");
    expect(text).toContain("panel_add_node");
    expect(text).toContain("panel_run");
    expect(text).toContain("CONTENT");
    expect(text).not.toContain("generate_image");
    expect(text).not.toContain("list_tools");
    expect(text).not.toMatch(/"type"\s*:\s*"object"/);
  });

  it("an MCP client receives the block at initialize", async () => {
    await expect(handshakeInstructionsOf(PANEL_HANDSHAKE_INSTRUCTIONS)).resolves.toBe(
      PANEL_HANDSHAKE_INSTRUCTIONS,
    );
  });
});

describe("the production McpServer sites are wired (#1747)", () => {
  it("boot.ts (the handshake external clients read) passes the stdio block", () => {
    expect(bootSrc).toMatch(/instructions:\s*STDIO_HANDSHAKE_INSTRUCTIONS/);
    expect(bootSrc).toMatch(
      /import\s*\{\s*STDIO_HANDSHAKE_INSTRUCTIONS\s*\}\s*from\s*"\.\/handshake-instructions\.js"/,
    );
  });

  it("panel-mcp-http.ts passes the panel block", () => {
    expect(panelHttpSrc).toMatch(/instructions:\s*PANEL_HANDSHAKE_INSTRUCTIONS/);
    expect(panelHttpSrc).toMatch(
      /import\s*\{\s*PANEL_HANDSHAKE_INSTRUCTIONS\s*\}\s*from\s*"\.\.\/handshake-instructions\.js"/,
    );
  });

  it("the introspect probe and the in-process call_tool child stay empty", () => {
    // Those two McpServer sites are not agent handshakes. Wiring them would
    // spend the budget on a dump script and on our own Client.
    expect(introspectSrc).not.toMatch(/instructions\s*:/);
    const callToolCtor = callToolSrc.indexOf('name: "comfyui-mcp-calltool"');
    expect(callToolCtor, "the call_tool McpServer identity block moved").toBeGreaterThan(-1);
    const around = callToolSrc.slice(callToolCtor, callToolCtor + 400);
    expect(around).not.toMatch(/instructions\s*:/);
  });
});
