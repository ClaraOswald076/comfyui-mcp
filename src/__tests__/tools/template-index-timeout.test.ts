// #1600 merge gate round 7 — the configured template read must let
// COMFYUI_MCP_HTTP_TIMEOUT_S govern it.
//
// `comfyuiFetch` applies its configurable ceiling ONLY to callers that passed no
// signal (`init.signal ?? defaultComfyTimeoutSignal()`). A hard-coded
// `AbortSignal.timeout(8000)` at the call site therefore always wins, and a user
// who raised the timeout for a slow remote still had this one read aborted at 8s
// — the setting silently did nothing here. That predates this PR; it is fixed
// here because this PR is what re-plumbed the request.
//
// WHY THIS IS A SEPARATE FILE, AND NOT A TIMING TEST. The first version of this
// drove real timers: a 50ms configured budget against a slower stubbed response.
// It passed alone and failed in the full suite, then failed alone too once the
// margin moved — the outcome depended on when the stub got scheduled relative to
// a timer that had already fired, which is not the claim being made. The claim is
// structural, and asserting it needs comfyuiFetch itself mocked, which must not
// leak into the behaviour tests next door.
//
// WHAT THE STRUCTURAL CLAIM IS, EXACTLY. This first read "passes NO signal", which
// was the shape of the round-7 fix rather than the finding behind it. The finding
// is that a HARD-CODED budget must not beat the user's setting. Passing no signal
// achieves that by letting comfyuiFetch fill in `defaultComfyTimeoutSignal()`; so
// does passing that same signal explicitly, which is what the walk now does in
// order to spend ONE budget across all its hops instead of a fresh ceiling per
// hop (a later gate finding — per-hop multiplies by the hop count, and the cap is
// 20). Both satisfy "the configured ceiling governs"; only the second also bounds
// the whole walk. So the assertion is on the OUTCOME — the signal at this call
// site is the configured one — rather than on the absence of a signal, which was
// only ever one way of getting there.

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.mock("../../config.js", () => ({
  config: { comfyuiApiKey: undefined, huggingfaceToken: undefined, civitaiApiToken: undefined },
  getComfyUIBaseUrl: () => "http://127.0.0.1:8188",
  getComfyUIAuthHeaders: () => ({}),
}));

const seen: Array<{ url: string; init: RequestInit | undefined }> = [];
/** Every signal handed out by the CONFIGURED-ceiling factory, so the call site's
 *  signal can be identified as one of them rather than merely "some signal". */
const configuredSignals: AbortSignal[] = [];

vi.mock("../../comfyui/fetch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../comfyui/fetch.js")>();
  return {
    ...actual,
    defaultComfyTimeoutSignal: () => {
      const signal = actual.defaultComfyTimeoutSignal();
      configuredSignals.push(signal);
      return signal;
    },
    comfyuiFetch: async (input: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(input), init });
      return new Response(JSON.stringify({ core: [{ name: "t" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  };
});

import { registerSkillsAccessTools } from "../../tools/skills-access.js";

type Handler = (args: Record<string, unknown>) => Promise<{
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
}>;

function handler(): Handler {
  const tools: Array<{ name: string; handler: Handler }> = [];
  const server = {
    tool: (name: string, _d: string, _s: z.ZodRawShape, h: Handler) => {
      tools.push({ name, handler: h });
    },
  };
  registerSkillsAccessTools(server as never);
  const t = tools.find((x) => x.name === "list_packs");
  if (!t) throw new Error("list_packs not registered");
  return t.handler;
}

describe('list_packs action:"list_templates" — the configured timeout governs', () => {
  it("uses the CONFIGURED ceiling, never a hard-coded budget of its own", async () => {
    seen.length = 0;
    configuredSignals.length = 0;

    const res = await handler()({ action: "list_templates" });

    expect(res.isError).toBeFalsy();
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe("http://127.0.0.1:8188/api/workflow_templates");
    // The whole finding in one assertion: whatever budget this call site spends
    // must come from `defaultComfyTimeoutSignal()` — i.e. from
    // COMFYUI_MCP_HTTP_TIMEOUT_S. A hard-coded `AbortSignal.timeout(8000)` is a
    // signal that is NOT one of these, and fails here exactly as it did when the
    // assertion read `toBeUndefined()`.
    const signal = seen[0].init?.signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(configuredSignals).toContain(signal);
    // …while the request is still the one it always was.
    expect(seen[0].init?.redirect).toBe("manual");
  });
});
