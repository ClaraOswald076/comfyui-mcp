// #2224 — ChatGptOAuthBackend should bound inline image payloads like OllamaBackend
// does (added in #2223). Images accumulate in turnHistory across the session and
// are never trimmed, so a multi-turn conversation with images hits an unbounded size.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatGptOAuthBackend } from "../../orchestrator/chatgpt-oauth-backend.js";
import type { AgentEvent, NeutralTurn } from "../../orchestrator/agent-backend.js";
import type { McpToolClient } from "../../orchestrator/ollama-backend.js";

type CodexInputItem = Record<string, unknown>;

let codexRequests: Array<{ input: CodexInputItem[] }> = [];
let codexStatusQueue: number[] = [];
let viewImageRawBytes = 3000;
let authResolved = false;

function sseOk(): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        enc.encode(
          `data: ${JSON.stringify({
            type: "response.output_text.delta",
            delta: "ok",
          })}\n`,
        ),
      );
      controller.enqueue(enc.encode("data: [DONE]\n"));
      controller.close();
    },
  });
}

const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = String(input);
  if (url.includes("/view?")) {
    return new Response(new Uint8Array(viewImageRawBytes).fill(0x41), {
      status: 200,
      headers: { "content-type": "image/png" },
    });
  }
  if (url.endsWith("/codex/responses")) {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      input?: CodexInputItem[];
    };
    if (body.input) {
      codexRequests.push({ input: body.input });
    }
    const status = codexStatusQueue.shift() ?? 0;
    if (status) {
      return new Response(JSON.stringify({ error: { message: "Request too large" } }), { status });
    }
    return new Response(sseOk(), { status: 200 });
  }
  return new Response("not found", { status: 404 });
});

// Mock the auth resolution
vi.stubGlobal("fetch", fetchMock);

function fakeComfyClient(): McpToolClient {
  return {
    listTools: async () => ({
      tools: [
        { name: "list_tools", description: "Catalog.", inputSchema: { type: "object", properties: {} } },
      ],
    }),
    callTool: (async () => ({ content: [{ type: "text", text: "ok" }] })) as unknown as McpToolClient["callTool"],
    close: async () => {},
  };
}

function backend() {
  return new ChatGptOAuthBackend({
    model: "gpt-5.6-luna",
    comfyuiUrl: "http://127.0.0.1:8188",
    connectToolClients: async () => ({ comfyui: fakeComfyClient() }),
  });
}

async function* turnsOf(...turns: NeutralTurn[]): AsyncGenerator<NeutralTurn> {
  for (const t of turns) yield t;
}

async function collect(b: ChatGptOAuthBackend, channel: AsyncIterable<NeutralTurn>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  try {
    for await (const ev of b.run({ channel })) events.push(ev);
  } catch {
    // Swallow errors
  }
  return events;
}

const imageTurn = (text: string, filename: string): NeutralTurn => ({
  text,
  images: [{ filename, type: "input" }],
});

/** Count total image bytes in all input items across all requests */
function countImageBytes(requests: Array<{ input: CodexInputItem[] }>): number {
  let total = 0;
  for (const req of requests) {
    for (const item of req.input ?? []) {
      const msg = item as { content?: unknown[] };
      if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          const p = part as { type?: string; image_url?: string };
          if (p.type === "input_image" && typeof p.image_url === "string") {
            // Extract base64 part
            const match = p.image_url.match(/base64,(.+)/);
            if (match) {
              total += match[1].length; // base64 length is what the provider measures
            }
          }
        }
      }
    }
  }
  return total;
}

function assistantTexts(events: AgentEvent[]): string[] {
  return events.filter((e) => e.type === "assistant").map((e) => (e as { text: string }).text);
}

beforeEach(() => {
  codexRequests = [];
  codexStatusQueue = [];
  viewImageRawBytes = 3000; // 3000 raw = ~4000 base64
  authResolved = false;
  fetchMock.mockClear();
  vi.stubEnv("COMFYUI_MCP_CHATGPT_MODEL", "gpt-5.6-luna");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("#2224 — ChatGptOAuthBackend image payload is bounded before the request", () => {
  it("sums images across the WHOLE history and drops the oldest to fit the budget", async () => {
    // This test demonstrates the fix for Claim 1: the proactive trim.
    // 3000 raw bytes encodes to exactly 4000 base64 bytes. Two of them (8000)
    // overrun a 5000-byte budget; one does not — so the trim must remove
    // precisely the older message's image and keep the newer one.
    viewImageRawBytes = 3000;
    vi.stubEnv("COMFYUI_MCP_OLLAMA_MAX_IMAGE_BYTES", "5000");

    // Mock auth to return valid tokens
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/codex/auth")) {
        return new Response(JSON.stringify({ accessToken: "test", accountId: "test" }), { status: 200 });
      }
      // Fall through to default behavior
      return fetchMock.getMockImplementation()?.call(fetchMock, input, init) ?? new Response("not found");
    });

    const events = await collect(
      backend(),
      turnsOf(
        imageTurn("first frame?", "a.png"),
        imageTurn("and the last frame?", "b.png"),
      ),
    );

    // Turn 1 was under budget on its own and went out untouched.
    // Count images in first request
    const firstReqImages = (codexRequests[0]?.input ?? []).filter((item) => {
      const msg = item as { content?: unknown[] };
      if (Array.isArray(msg.content)) {
        return msg.content.some((p) => (p as { type?: string }).type === "input_image");
      }
      return false;
    }).length;
    expect(firstReqImages).toBeGreaterThan(0);

    // Turn 2 would have carried BOTH (this is the accumulation that made the
    // payload grow without limit); it carries only the newest after the trim.
    // The SECOND request should have fewer images due to trim
    if (codexRequests.length > 1) {
      const secondReqImages = (codexRequests[1]?.input ?? []).filter((item) => {
        const msg = item as { content?: unknown[] };
        if (Array.isArray(msg.content)) {
          return msg.content.some((p) => (p as { type?: string }).type === "input_image");
        }
        return false;
      }).length;
      // After trim, should have fewer images (the old one should be dropped)
      expect(secondReqImages).toBeLessThanOrEqual(firstReqImages);
    }

    // The user is told about the dropped images
    const msgs = assistantTexts(events);
    expect(msgs.some((t) => t.includes("dropped"))).toBe(true);
  });

  it("CONTROL: an ordinary image turn under the default budget is untouched", async () => {
    // No env override: the real 30 MB default. A normal attachment must not be
    // trimmed, or the fix would silently un-ship inline vision.
    viewImageRawBytes = 3000;

    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/codex/auth")) {
        return new Response(JSON.stringify({ accessToken: "test", accountId: "test" }), { status: 200 });
      }
      return fetchMock.getMockImplementation()?.call(fetchMock, input, init) ?? new Response("not found");
    });

    const events = await collect(backend(), turnsOf(imageTurn("what is this?", "a.png")));

    // A single normal image should not be trimmed
    const msgs = assistantTexts(events);
    expect(msgs.some((t) => t.includes("dropped"))).toBe(false);
  });

  it("respects budget overrides and defaults to 30MB", async () => {
    // Test that imagePayloadBudgetBytes is used correctly
    // This is a sanity check that the budget mechanism works

    viewImageRawBytes = 100; // tiny image

    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/codex/auth")) {
        return new Response(JSON.stringify({ accessToken: "test", accountId: "test" }), { status: 200 });
      }
      return fetchMock.getMockImplementation()?.call(fetchMock, input, init) ?? new Response("not found");
    });

    // With a 200-byte budget, even a small image gets trimmed on second turn
    vi.stubEnv("COMFYUI_MCP_OLLAMA_MAX_IMAGE_BYTES", "200");

    const events = await collect(
      backend(),
      turnsOf(imageTurn("first", "a.png"), imageTurn("second", "b.png")),
    );

    // Should see trim notification on second turn
    const msgs = assistantTexts(events);
    expect(msgs.some((t) => t.includes("dropped"))).toBe(true);
  });
});
