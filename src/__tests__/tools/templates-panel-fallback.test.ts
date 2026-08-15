// #1415 — `list_packs (action:"list_templates")` must be able to answer from the
// ComfyUI a connected sidebar panel is on, when the configured headless address
// cannot be reached at all.
//
// The reported session: panel connected and driving a live ComfyUI,
// `panel_graph_outline` working, COMFYUI_URL at `http://127.0.0.1:9`, and this
// action failing with a bare transport error. #954 named the address; #952/#1553
// added "a connected panel is on a DIFFERENT one". Neither answered it.
//
// What these tests pin is as much about what must NOT happen as what must:
// a second server is asked ONLY on a transport failure, never on a status; the
// fallback request carries NO configured credential; two connected ComfyUIs are
// refused rather than guessed between; and a listing that came from the panel's
// server SAYS SO, so it can never be read as describing COMFYUI_URL.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../../config.js", () => ({
  // json-guard's credential redaction reads these three off `config`.
  config: { comfyuiApiKey: undefined, huggingfaceToken: undefined, civitaiApiToken: undefined },
  getComfyUIBaseUrl: () => "http://127.0.0.1:9",
  // Non-empty on purpose: the fallback must NOT forward it to an origin the user
  // never configured. An empty header set would make that assertion vacuous.
  getComfyUIAuthHeaders: () => ({ Authorization: "Bearer configured-token" }),
}));

import { registerSkillsAccessTools } from "../../tools/skills-access.js";
import { setConnectedPanelOrigins } from "../../comfyui/fetch.js";
import { PANEL_ORIGINS_FILE } from "../../services/panel-origin-channel.js";
import {
  choosePanelFallbackOrigin,
  describeDeclinedPanelFallback,
} from "../../services/panel-fallback-target.js";

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

const CONFIGURED = "http://127.0.0.1:9/api/workflow_templates";
const PANEL_ORIGIN = "http://127.0.0.1:8188";
const PANEL_URL = `${PANEL_ORIGIN}/api/workflow_templates`;

/** A `TypeError: fetch failed` — the exact shape undici raises and the only one
 *  comfyuiFetch rewrites. Anything else already says what happened. */
function transportFailure(): TypeError {
  const err = new TypeError("fetch failed");
  (err as { cause?: unknown }).cause = Object.assign(new Error("connect ECONNREFUSED"), {
    code: "ECONNREFUSED",
  });
  return err;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

type Call = { url: string; init: RequestInit | undefined };

let calls: Call[];

function stubFetch(impl: (url: string) => Promise<Response>): void {
  calls = [];
  vi.stubGlobal("fetch", (input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return impl(url);
  });
}

const textOf = (res: Awaited<ReturnType<Handler>>) => res.content.map((c) => c.text).join(" ");

beforeEach(() => {
  setConnectedPanelOrigins(null);
});

afterEach(() => {
  vi.unstubAllGlobals();
  setConnectedPanelOrigins(null);
});

describe("choosePanelFallbackOrigin", () => {
  it("says nothing when no origin is published", () => {
    expect(choosePanelFallbackOrigin(CONFIGURED, [])).toEqual({ kind: "none" });
  });

  it("drops junk entries rather than treating them as candidates", () => {
    expect(choosePanelFallbackOrigin(CONFIGURED, ["", "   ", "not a url"])).toEqual({
      kind: "none",
    });
  });

  it("reports SAME when the only panel is on the address that failed", () => {
    expect(choosePanelFallbackOrigin(CONFIGURED, ["http://127.0.0.1:9"])).toEqual({
      kind: "same",
      origin: "http://127.0.0.1:9",
    });
  });

  it("treats loopback aliases as one server, so a spelling difference is not a candidate", () => {
    // #1175's lesson, applied to the ACTING side: `includes` compares spellings.
    // A fallback that fires here would re-request the same server that just
    // refused the connection.
    expect(
      choosePanelFallbackOrigin("http://localhost:9/api/workflow_templates", ["http://127.0.0.1:9"]),
    ).toEqual({ kind: "same", origin: "http://127.0.0.1:9" });
  });

  it("picks the single different origin, keeping the spelling the browser reported", () => {
    expect(choosePanelFallbackOrigin(CONFIGURED, ["http://LOCALHOST:8188"])).toEqual({
      kind: "use",
      origin: "http://LOCALHOST:8188",
    });
  });

  it("REFUSES when two different ComfyUIs are connected", () => {
    const choice = choosePanelFallbackOrigin(CONFIGURED, [
      "http://127.0.0.1:8188",
      "http://192.168.1.50:8188",
    ]);
    expect(choice).toEqual({
      kind: "ambiguous",
      origins: ["http://127.0.0.1:8188", "http://192.168.1.50:8188"],
    });
    expect(describeDeclinedPanelFallback(choice)).toContain("127.0.0.1:8188");
    expect(describeDeclinedPanelFallback(choice)).toContain("192.168.1.50:8188");
  });

  it("ignores the panel that is on the failed address when picking among the rest", () => {
    expect(
      choosePanelFallbackOrigin(CONFIGURED, ["http://127.0.0.1:9", "http://127.0.0.1:8188"]),
    ).toEqual({ kind: "use", origin: "http://127.0.0.1:8188" });
  });

  it("says nothing when the failed target does not parse", () => {
    // "different from something I cannot read" is not a finding.
    expect(choosePanelFallbackOrigin("::::", ["http://127.0.0.1:8188"])).toEqual({ kind: "none" });
  });

  it("adds prose ONLY for the ambiguous case", () => {
    expect(describeDeclinedPanelFallback({ kind: "none" })).toBe("");
    expect(describeDeclinedPanelFallback({ kind: "same", origin: "http://x:1" })).toBe("");
    expect(describeDeclinedPanelFallback({ kind: "use", origin: "http://x:1" })).toBe("");
  });
});

describe('list_packs action:"list_templates" — panel fallback', () => {
  it("answers from the panel's ComfyUI when the configured address is unreachable", async () => {
    setConnectedPanelOrigins(() => [PANEL_ORIGIN]);
    stubFetch(async (url) => {
      if (url === CONFIGURED) throw transportFailure();
      return jsonResponse({ "my-pack": [{ name: "t1" }, { name: "t2" }] });
    });

    const res = await handler()({ action: "list_templates" });

    expect(res.isError).toBeFalsy();
    const body = textOf(res);
    expect(body).toContain('"template_count": 2');
    // The OBSERVED effect: which server answered, not which was asked.
    expect(body).toContain(`"answered_by": "${PANEL_ORIGIN}"`);
    expect(body).toContain("could not be reached");

    expect(calls.map((c) => c.url)).toEqual([CONFIGURED, PANEL_URL]);
  });

  it("does NOT forward the configured credential to the panel's origin", async () => {
    setConnectedPanelOrigins(() => [PANEL_ORIGIN]);
    stubFetch(async (url) => {
      if (url === CONFIGURED) throw transportFailure();
      return jsonResponse({});
    });

    await handler()({ action: "list_templates" });

    // The configured call carries it…
    const primary = new Headers(calls[0].init?.headers);
    expect(primary.get("Authorization")).toBe("Bearer configured-token");
    // …and the fallback carries no headers at all. COMFYUI_AUTH_* was configured
    // for the headless target; an origin we did not configure must not receive it.
    expect(calls[1].init?.headers).toBeUndefined();
    expect(JSON.stringify(calls[1])).not.toContain("configured-token");
  });

  it("REFUSES to pick when two different ComfyUIs are connected, and names both", async () => {
    setConnectedPanelOrigins(() => ["http://127.0.0.1:8188", "http://192.168.1.50:8188"]);
    stubFetch(async () => {
      throw transportFailure();
    });

    const res = await handler()({ action: "list_templates" });

    expect(res.isError).toBe(true);
    const body = textOf(res);
    expect(body).toContain("did NOT retry");
    expect(body).toContain("127.0.0.1:8188");
    expect(body).toContain("192.168.1.50:8188");
    // Exactly ONE request: refusing means not asking either of them.
    expect(calls).toHaveLength(1);
  });

  it("does not re-ask the same server when the panel is on the address that failed", async () => {
    setConnectedPanelOrigins(() => ["http://localhost:9"]);
    stubFetch(async () => {
      throw transportFailure();
    });

    const res = await handler()({ action: "list_templates" });

    expect(res.isError).toBe(true);
    expect(calls).toHaveLength(1);
    // The pre-existing drift sentence still does the explaining.
    expect(textOf(res)).toContain("same origin");
  });

  it("does NOT fall back on a NON-2xx: the configured server answered", async () => {
    // A status is evidence the configured ComfyUI exists and replied. Asking a
    // different machine because we disliked the answer is the silently-wrong
    // result this whole path must not produce.
    setConnectedPanelOrigins(() => [PANEL_ORIGIN]);
    stubFetch(async () => jsonResponse({ error: "nope" }, 404));

    const res = await handler()({ action: "list_templates" });

    expect(res.isError).toBe(true);
    expect(calls).toHaveLength(1);
    expect(textOf(res)).not.toContain(PANEL_ORIGIN);
  });

  it("does NOT fall back on a TIMEOUT: the connection was accepted", async () => {
    setConnectedPanelOrigins(() => [PANEL_ORIGIN]);
    stubFetch(async () => {
      const err = new Error("The operation was aborted due to timeout");
      err.name = "TimeoutError";
      throw err;
    });

    const res = await handler()({ action: "list_templates" });

    expect(res.isError).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("keeps the original failure when no panel origin is known", async () => {
    stubFetch(async () => {
      throw transportFailure();
    });

    const res = await handler()({ action: "list_templates" });

    expect(res.isError).toBe(true);
    expect(calls).toHaveLength(1);
    expect(textOf(res)).toContain("127.0.0.1:9/api/workflow_templates");
  });

  it("names BOTH addresses when the panel's server cannot be reached either", async () => {
    setConnectedPanelOrigins(() => [PANEL_ORIGIN]);
    stubFetch(async () => {
      throw transportFailure();
    });

    const res = await handler()({ action: "list_templates" });

    expect(res.isError).toBe(true);
    const body = textOf(res);
    expect(body).toContain(CONFIGURED);
    expect(body).toContain(PANEL_URL);
    expect(calls).toHaveLength(2);
  });

  it("attributes a NON-2xx from the fallback to the panel's server, not the configured one", async () => {
    setConnectedPanelOrigins(() => [PANEL_ORIGIN]);
    stubFetch(async (url) => {
      if (url === CONFIGURED) throw transportFailure();
      return jsonResponse({ error: "no such route" }, 404);
    });

    const res = await handler()({ action: "list_templates" });

    expect(res.isError).toBe(true);
    const body = textOf(res);
    expect(body).toContain(PANEL_URL);
    expect(body).toContain("NOT your configured ComfyUI");
  });

  it("reaches the fallback in the SPAWNED CHILD, with no injected source at all", async () => {
    // REACHABILITY, not behaviour. Every test above installs the origin source by
    // hand, which is the ORCHESTRATOR's shape — and the reporter's failure happens
    // in the spawned stdio child, which never loads orchestrator/index.js and has
    // no bridge to inject from. The only thing it has is the file #1553 publishes
    // into the progress dir it shares with its parent. If this path did not reach
    // the fallback, every assertion above would still pass and the fix would ship
    // dead for the process that needs it.
    const dir = mkdtempSync(join(tmpdir(), "panel-origins-"));
    try {
      writeFileSync(
        join(dir, PANEL_ORIGINS_FILE),
        JSON.stringify({ origins: [PANEL_ORIGIN], updated: Date.now(), pid: process.pid }),
      );
      vi.stubEnv("COMFYUI_MCP_PROGRESS_DIR", dir);
      // Deliberately NOT installed: this is the child.
      setConnectedPanelOrigins(null);
      stubFetch(async (url) => {
        if (url === CONFIGURED) throw transportFailure();
        return jsonResponse({ "from-the-channel": [{ name: "t" }] });
      });

      const res = await handler()({ action: "list_templates" });

      expect(res.isError).toBeFalsy();
      expect(textOf(res)).toContain(`"answered_by": "${PANEL_ORIGIN}"`);
      expect(calls.map((c) => c.url)).toEqual([CONFIGURED, PANEL_URL]);
    } finally {
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("passes the configured target through untouched when it works", async () => {
    setConnectedPanelOrigins(() => [PANEL_ORIGIN]);
    stubFetch(async () => jsonResponse({ core: [{ name: "a" }] }));

    const res = await handler()({ action: "list_templates" });

    expect(res.isError).toBeFalsy();
    expect(calls).toHaveLength(1);
    // No attribution key at all on the ordinary path — its absence is what tells
    // a reader the listing describes COMFYUI_URL.
    expect(textOf(res)).not.toContain("answered_by");
  });
});
