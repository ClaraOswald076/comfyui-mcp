#!/usr/bin/env node
/**
 * A non-executing MCP server, spawned by `claude -p` for one benchmark episode.
 *
 * Claude Code speaks MCP rather than chat-completions, so it cannot be driven
 * through the same loop as an Ollama or OpenAI-compatible model. It gets a real
 * MCP server instead — one that advertises the arm's REAL tool schemas (fetched
 * from the benchmark process, so they are the same bytes every other model
 * sees) and whose dispatcher cannot reach any service.
 *
 * Every decision is deferred to the benchmark process over loopback, so
 * `dispatch()` in scripts/tool-reach-bench.mts stays the single place where
 * "what is substantive, what is navigation, what is stubbed" is decided. This
 * file holds no policy of its own — it is a wire, deliberately, so the two
 * transports cannot drift into scoring different things.
 *
 *   REACH_ORACLE=http://127.0.0.1:PORT  REACH_EPISODE=<id>  node this-file.mjs
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const ORACLE = process.env.REACH_ORACLE;
const EPISODE = process.env.REACH_EPISODE;
if (!ORACLE || !EPISODE) {
  console.error("tool-reach-stub-server: REACH_ORACLE and REACH_EPISODE are required");
  process.exit(2);
}

const res = await fetch(`${ORACLE}/tools`);
if (!res.ok) {
  console.error(`tool-reach-stub-server: oracle ${ORACLE}/tools returned HTTP ${res.status}`);
  process.exit(2);
}
const { tools } = await res.json();

/**
 * The LOW-LEVEL Server, not McpServer.
 *
 * McpServer derives the `tools` capability from calls to `server.tool()`, which
 * takes a zod shape — and rebuilding these JSON Schemas as zod would change what
 * the model is shown, which is the exact thing under test. Declaring the
 * capability here and answering `tools/list` with the oracle's schemas verbatim
 * passes them through untouched. (Registering nothing on an McpServer also
 * leaves `tools` undeclared, and the SDK then refuses to install a tools/list
 * handler at all.)
 */
const server = new Server(
  { name: "comfyui", version: "0.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema ?? { type: "object", properties: {} },
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const r = await fetch(`${ORACLE}/call`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      episodeId: EPISODE,
      name: request.params.name,
      args: request.params.arguments ?? {},
    }),
  });
  const { text } = await r.json();
  return { content: [{ type: "text", text: String(text ?? "") }] };
});

await server.connect(new StdioServerTransport());
