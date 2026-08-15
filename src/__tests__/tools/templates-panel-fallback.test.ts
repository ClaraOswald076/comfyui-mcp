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
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
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
import { deliveryDoubt, setConnectedPanelOrigins } from "../../comfyui/fetch.js";
import { PANEL_ORIGINS_FILE } from "../../services/panel-origin-channel.js";
import {
  choosePanelFallbackOrigin,
  describeDeclinedPanelFallback,
  mayAskAnotherServer,
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

/** A `TypeError: fetch failed` carrying `code` on its cause — the exact shape
 *  undici raises for every transport failure, and the only one comfyuiFetch
 *  rewrites. Anything else already says what happened.
 *
 *  Built from the REAL shape on purpose: undici wraps a refused connection, a
 *  reset socket and a rejected TLS handshake identically at the top level, and it
 *  is precisely that sameness which let the shipped trigger treat them alike. */
function transportFailure(code = "ECONNREFUSED", detail = "connect"): TypeError {
  const err = new TypeError("fetch failed");
  (err as { cause?: unknown }).cause = Object.assign(new Error(`${detail} ${code}`), { code });
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

describe("mayAskAnotherServer", () => {
  it("answers only for codes that prove no connection was established", () => {
    for (const code of ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "UND_ERR_CONNECT_TIMEOUT"]) {
      expect(mayAskAnotherServer(transportFailure(code))).toBe(true);
    }
    for (const code of ["ECONNRESET", "EPIPE", "UND_ERR_SOCKET", "ETIMEDOUT", "CERT_HAS_EXPIRED"]) {
      expect(mayAskAnotherServer(transportFailure(code))).toBe(false);
    }
  });

  it("DENIES an unrecognised or absent code, rather than allowing it", () => {
    // The inversion. The trigger this replaced allowed everything it did not name.
    expect(mayAskAnotherServer(transportFailure("ENOBODYKNOWS"))).toBe(false);
    expect(mayAskAnotherServer(new Error("something went wrong"))).toBe(false);
    expect(mayAskAnotherServer(undefined)).toBe(false);
    expect(mayAskAnotherServer("a string")).toBe(false);
  });

  it("rejects an abort, which carries no code to look up", () => {
    for (const name of ["TimeoutError", "AbortError"]) {
      const err = new Error("aborted");
      err.name = name;
      expect(mayAskAnotherServer(err)).toBe(false);
    }
  });

  it("does NOT share a classification with deliveryDoubt's never-delivered set", () => {
    // A PROXY CLASSIFICATION OUTLIVES ITS PROOF. These two sets look
    // interchangeable and answer OPPOSITE questions, and merging them is the
    // failure mode this project has already paid for once.
    //
    //   deliveryDoubt asks  "could the server have ACTED on my POST?"
    //   mayAskAnotherServer asks  "was there no server at that address at all?"
    //
    // A TLS handshake rejection is never-delivered to the first (no application
    // byte was written) and emphatically NOT never-connected to the second (the
    // TCP connection completed and a peer presented a certificate). If a later
    // edit ever points one at the other's set, this diverging case fails.
    const tls = "CERT_HAS_EXPIRED";
    expect(deliveryDoubt(tls, "POST")).toBe(""); // never delivered — no doubt raised
    expect(mayAskAnotherServer(transportFailure(tls))).toBe(false); // but a server WAS there

    // And they agree where they genuinely should, so the test above is pinning a
    // real divergence rather than an unrelated pair of answers.
    expect(deliveryDoubt("ECONNREFUSED", "POST")).toBe("");
    expect(mayAskAnotherServer(transportFailure("ECONNREFUSED"))).toBe(true);
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

  // ── Review finding 2: what LICENSES asking a second server ──────────────────
  //
  // The trigger was "any error that is not a named abort", which admitted every
  // transport failure there is. These pin the boundary from BOTH sides: a
  // failure on an ESTABLISHED connection must not send the question elsewhere,
  // and a genuinely never-connected one must still work.

  it.each([
    // The connection was ESTABLISHED and then died. A server was there.
    ["ECONNRESET", "read"],
    ["EPIPE", "write"],
    ["UND_ERR_SOCKET", "other side closed"],
    // The TCP connection completed and a peer answered the ClientHello, so a
    // server IS there — this is a trust-configuration problem with the configured
    // target, and answering it from a different machine would hide a fixable bug.
    ["CERT_HAS_EXPIRED", "certificate has expired"],
    ["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "unable to verify"],
    ["DEPTH_ZERO_SELF_SIGNED_CERT", "self signed certificate"],
    // AMBIGUOUS between an unanswered SYN and a dead established socket, and
    // "unambiguous" is the bar.
    ["ETIMEDOUT", "connect"],
    // Connected; the server was merely slow.
    ["UND_ERR_HEADERS_TIMEOUT", "headers timeout"],
    // UNRECOGNISED — the default must DENY. This is the inversion: the shipped
    // trigger allowed everything it did not specifically name.
    ["ESOMETHINGNEW", "who knows"],
  ])("does NOT ask another server on %s — that is not a never-connected failure", async (code, detail) => {
    setConnectedPanelOrigins(() => [PANEL_ORIGIN]);
    stubFetch(async () => {
      throw transportFailure(code, detail);
    });

    const res = await handler()({ action: "list_templates" });

    expect(res.isError).toBe(true);
    // ONE request. The panel's ComfyUI is never asked.
    expect(calls).toHaveLength(1);
    expect(textOf(res)).not.toContain(PANEL_URL);
  });

  it.each([
    ["ECONNREFUSED", "connect"],
    ["ENOTFOUND", "getaddrinfo"],
    ["EAI_AGAIN", "getaddrinfo"],
    ["EHOSTUNREACH", "connect"],
    ["ENETUNREACH", "connect"],
    ["UND_ERR_CONNECT_TIMEOUT", "connect timeout"],
  ])("DOES ask the panel's server on %s — no connection was ever established", async (code, detail) => {
    setConnectedPanelOrigins(() => [PANEL_ORIGIN]);
    stubFetch(async (url) => {
      if (url === CONFIGURED) throw transportFailure(code, detail);
      return jsonResponse({ p: [{ name: "t" }] });
    });

    const res = await handler()({ action: "list_templates" });

    expect(res.isError).toBeFalsy();
    expect(calls.map((c) => c.url)).toEqual([CONFIGURED, PANEL_URL]);
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

  // ── Review finding 1: redirects, and WHO actually answered ──────────────────
  //
  // `fetch` follows redirects by default. The origin here is supplied from
  // OUTSIDE the configuration — a handshake Origin the browser reported — so
  // whatever listens there could move this request to any host it liked while
  // `answered_by` went on naming the origin we picked. The body would then be
  // surfaced as a template index credited to a server that never produced it.

  it("asks the fallback origin with redirects DISABLED", async () => {
    setConnectedPanelOrigins(() => [PANEL_ORIGIN]);
    stubFetch(async (url) => {
      if (url === CONFIGURED) throw transportFailure();
      return jsonResponse({});
    });

    await handler()({ action: "list_templates" });

    // The WIRING, not just the refusal below: without this the 3xx never becomes
    // a response to refuse, because fetch has already chased it.
    expect(calls[1].init?.redirect).toBe("manual");
  });

  it("REFUSES a redirect from the fallback origin instead of following it", async () => {
    setConnectedPanelOrigins(() => [PANEL_ORIGIN]);
    stubFetch(async (url) => {
      if (url === CONFIGURED) throw transportFailure();
      if (url === PANEL_URL) {
        return new Response("", {
          status: 302,
          headers: { location: "http://169.254.169.254/latest/meta-data/" },
        });
      }
      // Reaching here at all is the bug: it means the redirect was chased.
      return jsonResponse({ pwned: [{ name: "secret" }] });
    });

    const res = await handler()({ action: "list_templates" });

    expect(res.isError).toBe(true);
    const body = textOf(res);
    expect(body).toContain("REDIRECT");
    expect(body).toContain("NOT followed");
    expect(body).toContain("169.254.169.254");
    // Exactly two requests: the configured one and the refused fallback. A third
    // would BE the SSRF.
    expect(calls.map((c) => c.url)).toEqual([CONFIGURED, PANEL_URL]);
    // And nothing from the redirect target is surfaced as an answer.
    expect(body).not.toContain("pwned");
    expect(body).not.toContain("template_count");
  });

  it("refuses a redirect from a REAL socket, not just a hand-built 302", async () => {
    // The test above builds its 302 with `new Response(...)`, and would pass
    // whatever undici actually does. That matters here more than usual: the fetch
    // STANDARD says `redirect: "manual"` yields an opaqueredirect response —
    // status 0, no headers — which would make the refusal branch dead code and
    // this whole guard a no-op. Node returns the real 302 instead. Since that is
    // a runtime behaviour rather than a contract, it gets a real server.
    let redirectTargetHits = 0;
    const server = createServer((req, res) => {
      if (req.url?.startsWith("/api/workflow_templates")) {
        res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" });
        res.end("");
        return;
      }
      redirectTargetHits++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"pwned":[{"name":"x"}]}');
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as AddressInfo).port;
    try {
      setConnectedPanelOrigins(() => [`http://127.0.0.1:${port}`]);
      const realFetch = globalThis.fetch;
      calls = [];
      vi.stubGlobal("fetch", (input: unknown, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, init });
        // Only the CONFIGURED target is faked. The fallback goes over a real
        // socket, with the real `init` production code chose.
        if (url === CONFIGURED) throw transportFailure();
        return realFetch(input as string, init);
      });

      const res = await handler()({ action: "list_templates" });

      expect(res.isError).toBe(true);
      const body = textOf(res);
      expect(body).toContain("REDIRECT");
      expect(body).toContain("NOT followed");
      // Read off a REAL response's headers — the assertion that dies if a future
      // node starts returning an opaqueredirect.
      expect(body).toContain("169.254.169.254");
      expect(redirectTargetHits).toBe(0);
      expect(body).not.toContain("pwned");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("attributes the listing to the origin that ANSWERED, not the one we asked", async () => {
    // Defence in depth behind the refusal above. `answered_by` is read off
    // `res.url` rather than restated from our own intent, so attribution follows
    // the evidence even if a future edit lets a hop through — a wrong
    // `answered_by` is the silently-wrong result this whole path exists to avoid.
    setConnectedPanelOrigins(() => [PANEL_ORIGIN]);
    stubFetch(async (url) => {
      if (url === CONFIGURED) throw transportFailure();
      const res = jsonResponse({ elsewhere: [{ name: "t" }] });
      Object.defineProperty(res, "url", { value: "http://10.0.0.7:8188/api/workflow_templates" });
      return res;
    });

    const res = await handler()({ action: "list_templates" });

    expect(res.isError).toBeFalsy();
    const body = textOf(res);
    expect(body).toContain(`"answered_by": "http://10.0.0.7:8188"`);
    expect(body).not.toContain(`"answered_by": "${PANEL_ORIGIN}"`);
  });

  it("keeps the browser's spelling when the answering origin is the same server", async () => {
    // #1175's lesson pointed at attribution: `http://LOCALHOST:8188` and
    // `http://localhost:8188` are one server, and reporting a "different"
    // answering origin for a case difference would be a false alarm.
    setConnectedPanelOrigins(() => ["http://LOCALHOST:8188"]);
    stubFetch(async (url) => {
      if (url === CONFIGURED) throw transportFailure();
      const res = jsonResponse({ ok: [{ name: "t" }] });
      Object.defineProperty(res, "url", { value: "http://localhost:8188/api/workflow_templates" });
      return res;
    });

    const res = await handler()({ action: "list_templates" });

    expect(textOf(res)).toContain(`"answered_by": "http://LOCALHOST:8188"`);
  });

  // ── Review finding 3: the CLAIM must match the observation ──────────────────
  //
  // The channel admits a record up to two minutes old and then discards the
  // timestamp. A panel that moved A→B inside that window still causes a fetch of
  // A, and the response proves only that A answered — never that a panel is on
  // it. The note used to assert the latter.

  it("claims only that the origin ANSWERED, never where the panel is now", async () => {
    setConnectedPanelOrigins(() => [PANEL_ORIGIN]);
    stubFetch(async (url) => {
      if (url === CONFIGURED) throw transportFailure();
      return jsonResponse({ p: [{ name: "t" }] });
    });

    const res = await handler()({ action: "list_templates" });

    const body = textOf(res);
    expect(body).toContain("ANSWERED this request");
    expect(body).toContain("not a live reading of where a panel is now");
    // The retired present-tense assertion about the PANEL, in the exact wording
    // that made the claim. Its absence is the fix.
    expect(body).not.toContain("the ComfyUI a connected sidebar panel is on");
  });

  it("DISCLOSES how old the origin evidence was, reading it off the channel record", async () => {
    const dir = mkdtempSync(join(tmpdir(), "panel-origins-age-"));
    try {
      writeFileSync(
        join(dir, PANEL_ORIGINS_FILE),
        JSON.stringify({
          origins: [PANEL_ORIGIN],
          // Well inside PANEL_ORIGINS_MAX_AGE_MS, so the record is still ACCEPTED
          // — the point is that being accepted is not the same as being current.
          updated: Date.now() - 45_000,
          pid: process.pid,
        }),
      );
      vi.stubEnv("COMFYUI_MCP_PROGRESS_DIR", dir);
      setConnectedPanelOrigins(null);
      stubFetch(async (url) => {
        if (url === CONFIGURED) throw transportFailure();
        return jsonResponse({ p: [{ name: "t" }] });
      });

      const res = await handler()({ action: "list_templates" });

      // Rounded to the second, so allow the test's own elapsed time.
      expect(textOf(res)).toMatch(/about 4[4-9]s ago/);
    } finally {
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("says 'a moment ago' for the in-process bridge, which is read live", async () => {
    setConnectedPanelOrigins(() => [PANEL_ORIGIN]);
    stubFetch(async (url) => {
      if (url === CONFIGURED) throw transportFailure();
      return jsonResponse({ p: [{ name: "t" }] });
    });

    expect(textOf(await handler()({ action: "list_templates" }))).toContain("a moment ago");
  });

  it("discloses the age on a NON-2xx from the fallback too", async () => {
    setConnectedPanelOrigins(() => [PANEL_ORIGIN]);
    stubFetch(async (url) => {
      if (url === CONFIGURED) throw transportFailure();
      return jsonResponse({ error: "no such route" }, 404);
    });

    const body = textOf(await handler()({ action: "list_templates" }));
    expect(body).toContain("a moment ago");
    expect(body).toContain("does not establish that a panel is on it now");
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
