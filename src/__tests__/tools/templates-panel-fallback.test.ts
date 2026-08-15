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

/**
 * The configured target, switchable per test.
 *
 * DEFAULTS TO A DIALABLE PORT, and that is load-bearing. It used to be the
 * reporter's own `http://127.0.0.1:9`, which is on the Fetch BLOCKED-PORT list —
 * so `fetch` refuses it before opening a socket and no connection can ever be
 * established to it. Under the structural half of `mayAskAnotherServer`, that
 * address alone licenses the fallback, which meant every test in this file
 * would pass with the entire error-code half deleted, and the "does NOT fall
 * back on ECONNRESET" cases were asserting against a combination that cannot
 * physically occur: port 9 never dials, so it can never reset.
 *
 * So the bulk of the file runs against a port that DOES dial and simply has
 * nothing listening (8199), which is what exercises the code half — and the
 * reporter's blocked-port case gets its own describe block that sets port 9
 * explicitly and drives the REAL rejection.
 */
let configuredBase = "http://127.0.0.1:8199";

vi.mock("../../config.js", () => ({
  // json-guard's credential redaction reads these three off `config`.
  config: { comfyuiApiKey: undefined, huggingfaceToken: undefined, civitaiApiToken: undefined },
  getComfyUIBaseUrl: () => configuredBase,
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

const CONFIGURED = "http://127.0.0.1:8199/api/workflow_templates";
const PANEL_ORIGIN = "http://127.0.0.1:8188";
const PANEL_URL = `${PANEL_ORIGIN}/api/workflow_templates`;

/** A target `fetch` will actually dial, so the ERROR is what decides. */
const DIALABLE = CONFIGURED;
/** The reporter's own COMFYUI_URL. Port 9 is on the Fetch blocked-port list, so
 *  `fetch` refuses it before opening a socket — the address decides, and the
 *  error never even gets a code. */
const BLOCKED_PORT_BASE = "http://127.0.0.1:9";
const BLOCKED_PORT_URL = `${BLOCKED_PORT_BASE}/api/workflow_templates`;

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

/** The REAL shape node raises for a blocked port — `TypeError: fetch failed`
 *  whose cause is a bare `Error("bad port")` with NO code. Measured against the
 *  live runtime; `fetch-bad-port.test.ts` drives the genuine article rather than
 *  this reconstruction, so the two cannot silently drift apart. */
function badPortFailure(): TypeError {
  const err = new TypeError("fetch failed");
  (err as { cause?: unknown }).cause = new Error("bad port");
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
    expect(choosePanelFallbackOrigin(CONFIGURED, ["http://127.0.0.1:8199"])).toEqual({
      kind: "same",
      origin: "http://127.0.0.1:8199",
    });
  });

  it("reports ALIAS when the same server was published under a different host spelling", () => {
    // THIS TEST USED TO ASSERT `same`, and its stated reason — "a fallback here
    // would re-request the same server that just refused" — is false. #1175
    // collapses these spellings so DRIFT is not reported for them; it does not
    // make them one socket. A ComfyUI bound only to `[::1]:8199` refuses
    // `127.0.0.1:8199` and answers `[::1]:8199`, so the address that works was
    // the one being declined. (#1600 gate, finding 2 — demonstrated by
    // execution.)
    expect(
      choosePanelFallbackOrigin("http://localhost:8199/api/workflow_templates", ["http://127.0.0.1:8199"]),
    ).toEqual({ kind: "alias", origin: "http://127.0.0.1:8199", then: [] });
    expect(
      choosePanelFallbackOrigin("http://127.0.0.1:8199/api/workflow_templates", ["http://[::1]:8199"]),
    ).toEqual({ kind: "alias", origin: "http://[::1]:8199", then: [] });
  });

  it("still reports SAME for an identical host spelling, so nothing is re-asked pointlessly", () => {
    // The boundary on the other side of the finding above: same canonical AND
    // same host is one socket, and retrying it would be a second request to the
    // address that just refused.
    expect(
      choosePanelFallbackOrigin("http://127.0.0.1:8199/api/workflow_templates", [
        "http://127.0.0.1:8199",
      ]),
    ).toEqual({ kind: "same", origin: "http://127.0.0.1:8199" });
    // Case is a spelling of one host, not two — `URL` lowercases it, so the
    // alias route must not fire on it and start re-asking the failed address.
    expect(
      choosePanelFallbackOrigin("http://Comfy.Test:8199/api/workflow_templates", [
        "http://comfy.test:8199",
      ]),
    ).toEqual({ kind: "same", origin: "http://comfy.test:8199" });
  });

  it("CHAINS the alias ahead of a single foreign candidate instead of choosing", () => {
    // Both single-choice orderings are wrong in one direction, and the gate found
    // each in turn: preferring the foreign origin answers from a machine the user
    // did not configure while their own server was available (round 2), and
    // preferring the alias makes the foreign panel unreachable when the alias does
    // not answer (round 1's fix, which caused that). The chain owes neither.
    expect(
      choosePanelFallbackOrigin("http://127.0.0.1:8199/api/workflow_templates", [
        "http://192.168.1.50:8188",
        "http://[::1]:8199",
      ]),
    ).toEqual({
      kind: "alias",
      origin: "http://[::1]:8199",
      // Each candidate carries its OWN kind, so the caller does not infer it from
      // the position — which stopped being sound once a chain could hold more
      // than one alias (#1600 gate round 3, finding 3).
      then: [{ origin: "http://192.168.1.50:8188", kind: "use" }],
    });
  });

  it("keeps an ORDER-INDEPENDENT verdict — connection order is not a fact about servers", () => {
    // Gate round 2, finding 3. The canonical dedup kept the FIRST spelling per
    // origin and dropped the rest, so the alias was discarded before anything
    // could classify it: the same two panels answered `same` or `alias` depending
    // purely on which browser tab connected first. Both orders, one verdict.
    const failed = "http://127.0.0.1:8199/api/workflow_templates";
    const expected = { kind: "alias", origin: "http://[::1]:8199", then: [] };
    expect(choosePanelFallbackOrigin(failed, ["http://127.0.0.1:8199", "http://[::1]:8199"])).toEqual(
      expected,
    );
    expect(choosePanelFallbackOrigin(failed, ["http://[::1]:8199", "http://127.0.0.1:8199"])).toEqual(
      expected,
    );
  });

  it("collapses REPEATS of one address, which are not extra candidates", () => {
    // Deduplication is by host, so two tabs on the same address stay one
    // candidate — the thing the old canonical dedup got right and must keep.
    expect(
      choosePanelFallbackOrigin(CONFIGURED, [
        "http://192.168.1.50:8188",
        "http://192.168.1.50:8188",
      ]),
    ).toEqual({ kind: "use", origin: "http://192.168.1.50:8188", then: [] });
  });

  it("prefers an ALIAS over a REFUSAL, which is the verdict that answers nothing", () => {
    // Two foreign origins mean neither can be chosen, and the alias is not a third
    // guess between them — #1175 already holds it IS the configured server. Taking
    // it resolves the refusal without picking between the two, so this can only
    // turn "no answer" into an answer.
    expect(
      choosePanelFallbackOrigin("http://127.0.0.1:8199/api/workflow_templates", [
        "http://192.168.1.50:8188",
        "http://10.0.0.9:8188",
        "http://localhost:8199",
      ]),
    ).toEqual({ kind: "alias", origin: "http://localhost:8199", then: [] });
  });

  it("does not treat a DIFFERENT PORT on an alias host as the same server", () => {
    // The alias rule is about the host spelling only. A different port is a
    // different origin by every rule here, so it stays an ordinary candidate.
    expect(
      choosePanelFallbackOrigin("http://127.0.0.1:8199/api/workflow_templates", ["http://[::1]:8188"]),
    ).toEqual({ kind: "use", origin: "http://[::1]:8188", then: [] });
  });

  it("picks the single different origin, keeping the spelling the browser reported", () => {
    expect(choosePanelFallbackOrigin(CONFIGURED, ["http://LOCALHOST:8188"])).toEqual({
      kind: "use",
      origin: "http://LOCALHOST:8188",
      then: [],
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
      choosePanelFallbackOrigin(CONFIGURED, ["http://127.0.0.1:8199", "http://127.0.0.1:8188"]),
    ).toEqual({ kind: "use", origin: "http://127.0.0.1:8188", then: [] });
  });

  it("says nothing when the failed target does not parse", () => {
    // "different from something I cannot read" is not a finding.
    expect(choosePanelFallbackOrigin("::::", ["http://127.0.0.1:8188"])).toEqual({ kind: "none" });
  });

  it("adds prose ONLY for the ambiguous case", () => {
    expect(describeDeclinedPanelFallback({ kind: "none" })).toBe("");
    expect(describeDeclinedPanelFallback({ kind: "same", origin: "http://x:1" })).toBe("");
    expect(describeDeclinedPanelFallback({ kind: "use", origin: "http://x:1", then: [] })).toBe("");
    expect(describeDeclinedPanelFallback({ kind: "alias", origin: "http://x:1", then: [] })).toBe("");
  });
});

describe("mayAskAnotherServer", () => {
  it("answers only for codes that prove no connection was established", () => {
    for (const code of ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "UND_ERR_CONNECT_TIMEOUT"]) {
      expect(mayAskAnotherServer(transportFailure(code), DIALABLE)).toBe(true);
    }
    for (const code of ["ECONNRESET", "EPIPE", "UND_ERR_SOCKET", "ETIMEDOUT", "CERT_HAS_EXPIRED"]) {
      expect(mayAskAnotherServer(transportFailure(code), DIALABLE)).toBe(false);
    }
  });

  it("DENIES an unrecognised or absent code, rather than allowing it", () => {
    // The inversion. The trigger this replaced allowed everything it did not name.
    expect(mayAskAnotherServer(transportFailure("ENOBODYKNOWS"), DIALABLE)).toBe(false);
    expect(mayAskAnotherServer(new Error("something went wrong"), DIALABLE)).toBe(false);
    expect(mayAskAnotherServer(undefined, DIALABLE)).toBe(false);
    expect(mayAskAnotherServer("a string", DIALABLE)).toBe(false);
  });

  // ── The structural route: an address fetch cannot dial ──────────────────────
  //
  // The reporter's `http://127.0.0.1:9` is refused as a Fetch BAD PORT before a
  // socket exists, and that refusal carries NO error code. A code-only predicate
  // therefore answered "no" for the exact configuration this feature was written
  // for, and the fallback never ran — with a fully green suite, because every
  // test synthesized ECONNREFUSED.

  it("allows the fallback on a BLOCKED PORT, whatever the error says", () => {
    // No socket is ever opened, so "no connection was established" holds by
    // construction — a stronger proof than ECONNREFUSED, not a weaker one.
    expect(mayAskAnotherServer(badPortFailure(), BLOCKED_PORT_URL)).toBe(true);
    // Even an error that would be DENIED on a dialable address: on this target
    // it cannot have come from a connection, because there was none.
    expect(mayAskAnotherServer(transportFailure("ECONNRESET"), BLOCKED_PORT_URL)).toBe(true);
    // …and the same error on a dialable address is still denied, so the line
    // above is the address talking and not a loosened rule.
    expect(mayAskAnotherServer(transportFailure("ECONNRESET"), DIALABLE)).toBe(false);
  });

  it("allows the fallback on a scheme fetch does not dial", () => {
    expect(mayAskAnotherServer(new TypeError("fetch failed"), "ftp://127.0.0.1/api")).toBe(true);
  });

  it("does NOT treat an ordinary port as undialable", () => {
    for (const base of ["http://127.0.0.1:8188", "http://127.0.0.1:8199", "http://x.test"]) {
      expect(mayAskAnotherServer(transportFailure("ECONNRESET"), `${base}/api`)).toBe(false);
    }
  });

  it("rejects an abort, which carries no code to look up", () => {
    for (const name of ["TimeoutError", "AbortError"]) {
      const err = new Error("aborted");
      err.name = name;
      expect(mayAskAnotherServer(err, DIALABLE)).toBe(false);
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
    expect(mayAskAnotherServer(transportFailure(tls), DIALABLE)).toBe(false); // but a server WAS there

    // And they agree where they genuinely should, so the test above is pinning a
    // real divergence rather than an unrelated pair of answers.
    expect(deliveryDoubt("ECONNREFUSED", "POST")).toBe("");
    expect(mayAskAnotherServer(transportFailure("ECONNREFUSED"), DIALABLE)).toBe(true);
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
    // The published spelling is BYTE-IDENTICAL to the configured one on purpose.
    // It used to be `http://localhost:8199` against a configured
    // `http://127.0.0.1:8199`, which is not the same socket — that pairing is now
    // an alias and IS retried (#1600 gate, finding 2). Testing "do not re-ask the
    // same address" with two different addresses proved nothing about either.
    setConnectedPanelOrigins(() => ["http://127.0.0.1:8199"]);
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
    expect(textOf(res)).toContain("127.0.0.1:8199/api/workflow_templates");
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

  it("never asserts where the panel is, on ANY fallback outcome", async () => {
    // The success path is not the only place the claim was made. The
    // secondary-failure and redirect-refusal messages carried the same sentence,
    // and fixing one wording while two survive is how a corrected message gets
    // re-quoted later as though it were current. All three, in one sweep.
    const RETIRED = "the ComfyUI a connected sidebar panel is on";
    const outcomes: Array<[string, (url: string) => Promise<Response>]> = [
      ["success", async (url) => (url === CONFIGURED ? Promise.reject(transportFailure()) : jsonResponse({ a: [] }))],
      ["fallback also unreachable", async () => Promise.reject(transportFailure())],
      [
        "fallback redirects",
        async (url) =>
          url === CONFIGURED
            ? Promise.reject(transportFailure())
            : new Response("", { status: 302, headers: { location: "http://elsewhere/" } }),
      ],
      [
        "fallback non-2xx",
        async (url) =>
          url === CONFIGURED ? Promise.reject(transportFailure()) : jsonResponse({ e: 1 }, 404),
      ],
    ];
    for (const [label, impl] of outcomes) {
      setConnectedPanelOrigins(() => [PANEL_ORIGIN]);
      stubFetch(impl);
      const body = textOf(await handler()({ action: "list_templates" }));
      expect(body, `outcome: ${label}`).not.toContain(RETIRED);
      // …and each still names the origin it actually dealt with, so the phrase is
      // gone because the claim was corrected, not because the text was dropped.
      expect(body, `outcome: ${label}`).toContain(PANEL_ORIGIN);
    }

    // The AMBIGUOUS branch needs two origins, so it could not appear in the loop
    // above — and that is exactly why the stale claim survived there for a whole
    // review round. A sweep that cannot reach a branch does not cover it.
    setConnectedPanelOrigins(() => [PANEL_ORIGIN, "http://192.168.1.50:8188"]);
    stubFetch(async () => Promise.reject(transportFailure()));
    const declinedBody = textOf(await handler()({ action: "list_templates" }));
    expect(declinedBody, "outcome: ambiguous/declined").not.toContain(RETIRED);
    // The retired present-tense wording this branch used, specifically.
    expect(declinedBody, "outcome: ambiguous/declined").not.toContain("origins are connected");
    expect(declinedBody).toContain("were published");
    expect(declinedBody).toContain(PANEL_ORIGIN);
    expect(declinedBody).toContain("192.168.1.50:8188");
  });

  it("discloses the age on the DECLINED (ambiguous) path too", async () => {
    // Round one corrected four emitted sites and missed this fifth one, because
    // it is the only branch that reaches none of them.
    setConnectedPanelOrigins(() => [PANEL_ORIGIN, "http://192.168.1.50:8188"]);
    stubFetch(async () => Promise.reject(transportFailure()));

    const body = textOf(await handler()({ action: "list_templates" }));

    expect(body).toContain("did NOT retry");
    expect(body).toContain("a moment ago");
  });

  it("discloses a CHANNEL age on the declined path, not just the live bridge", async () => {
    const dir = mkdtempSync(join(tmpdir(), "panel-origins-declined-"));
    try {
      writeFileSync(
        join(dir, PANEL_ORIGINS_FILE),
        JSON.stringify({
          origins: [PANEL_ORIGIN, "http://192.168.1.50:8188"],
          updated: Date.now() - 45_000,
          pid: process.pid,
        }),
      );
      vi.stubEnv("COMFYUI_MCP_PROGRESS_DIR", dir);
      setConnectedPanelOrigins(null);
      stubFetch(async () => Promise.reject(transportFailure()));

      const body = textOf(await handler()({ action: "list_templates" }));

      expect(body).toContain("did NOT retry");
      expect(body).toMatch(/about 4[4-9]s ago/);
    } finally {
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    }
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

  // ── The REPORTER'S OWN CONFIGURATION, end to end, unsynthesized ─────────────

  it("reaches the fallback for the reporter's http://127.0.0.1:9 — REAL rejection", async () => {
    // No stubbed error. The configured target is the reporter's blocked port and
    // the REAL global fetch produces the real refusal; only the panel's origin is
    // served, by a real socket. If node's pre-dial refusal ever stops being
    // recognised, this goes red — which the synthesized ECONNREFUSED tests could
    // never do, and did not, while the feature was a no-op for this exact input.
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"from-the-panel":[{"name":"t1"},{"name":"t2"}]}');
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as AddressInfo).port;
    const previous = configuredBase;
    configuredBase = BLOCKED_PORT_BASE;
    try {
      setConnectedPanelOrigins(() => [`http://127.0.0.1:${port}`]);
      // Deliberately NOT stubbing fetch: this must exercise the genuine article.
      const res = await handler()({ action: "list_templates" });

      expect(res.isError).toBeFalsy();
      const body = textOf(res);
      expect(body).toContain('"template_count": 2');
      expect(body).toContain(`"answered_by": "http://127.0.0.1:${port}"`);
    } finally {
      configuredBase = previous;
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("proves the reporter's failure carries NO error code to match on", async () => {
    // The premise of the fix above, measured rather than asserted. If node ever
    // starts attaching a code here, the structural route stops being the only
    // thing that can save this case and this test says so.
    let caught: unknown;
    try {
      await fetch(BLOCKED_PORT_URL);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(TypeError);
    const cause = (caught as { cause?: { message?: string; code?: string } }).cause;
    expect(cause?.message).toBe("bad port");
    expect(cause?.code).toBeUndefined();
    // …and that is exactly why the address, not the error, has to decide.
    expect(mayAskAnotherServer(caught, BLOCKED_PORT_URL)).toBe(true);
  });


  // ── #1600 merge gate, round 1 ──────────────────────────────────────────────

  it("RETRIES the alias spelling when only the other loopback family answers", async () => {
    // Gate finding 2, end to end and over a real socket. The server listens on
    // IPv6 loopback ONLY; the configured target is the IPv4 spelling of the same
    // port, which therefore refuses. Before the fix the chooser said `same` and
    // this returned the original failure while an address that answers was
    // sitting in the published set.
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"v6-only":[{"name":"a"}]}');
    });
    await new Promise<void>((r) => server.listen(0, "::1", () => r()));
    const port = (server.address() as AddressInfo).port;
    const previous = configuredBase;
    // The IPv4 spelling of a port bound only to ::1 — a real ECONNREFUSED, not a
    // synthesized one.
    configuredBase = `http://127.0.0.1:${port}`;
    try {
      setConnectedPanelOrigins(() => [`http://[::1]:${port}`]);
      const res = await handler()({ action: "list_templates" });

      expect(res.isError).toBeFalsy();
      const body = textOf(res);
      expect(body).toContain('"template_count": 1');
      expect(body).toContain(`"answered_by": "http://[::1]:${port}"`);
    } finally {
      configuredBase = previous;
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("does NOT claim a tunnel or boundary when both addresses are one machine", async () => {
    // The `use` message's mechanism sentence ("a browser reached it and we
    // cannot — something is in the way") is nonsense between a host and itself.
    setConnectedPanelOrigins(() => ["http://[::1]:8199"]);
    stubFetch(async () => {
      throw transportFailure();
    });

    const body = textOf(await handler()({ action: "list_templates" }));

    expect(body).toContain("[::1]:8199");
    expect(body).not.toContain("a tunnel, a container boundary");
    expect(body).toContain("loopback rules");
  });

  it("keeps the tunnel wording for a genuinely different origin", async () => {
    // The other side of that boundary: the sentence must not have been dropped
    // for everyone in the course of removing it from the alias path.
    setConnectedPanelOrigins(() => [PANEL_ORIGIN]);
    stubFetch(async () => {
      throw transportFailure();
    });

    const body = textOf(await handler()({ action: "list_templates" }));

    expect(body).toContain("a tunnel, a container boundary");
  });

  it("DISCLOSES that an origin carries no path, so a prefixed mount is invisible", async () => {
    // Gate finding 1. A panel served from `http://host/comfy/` publishes
    // `http://host`, so this reads the ROOT — and where a different ComfyUI
    // answers the root, the index is real and from the wrong install. Nothing
    // available here can tell the two apart (an Origin has no path), so the
    // assumption is stated in the payload instead of left implied.
    setConnectedPanelOrigins(() => [PANEL_ORIGIN]);
    stubFetch(async (url) => {
      if (url === CONFIGURED) throw transportFailure();
      return jsonResponse({ core: [{ name: "a" }] });
    });

    const body = textOf(await handler()({ action: "list_templates" }));

    expect(body).toContain("carries no path");
    expect(body).toContain("ROOT of that address");
    expect(body).toContain("path prefix");
  });

  it("attributes a 2xx with a NON-INDEX body to the server that answered", async () => {
    // The SIXTH emitted outcome, and the one that sent the reader to the wrong
    // machine: classifyNonJson's remedy is built from the CONFIGURED base, and
    // after a fallback that is the address we just proved unreachable, while the
    // body being diagnosed came from somewhere else.
    setConnectedPanelOrigins(() => [PANEL_ORIGIN]);
    stubFetch(async (url) => {
      if (url === CONFIGURED) throw transportFailure();
      return new Response("<!doctype html><html><body>ComfyUI</body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    });

    const res = await handler()({ action: "list_templates" });

    expect(res.isError).toBe(true);
    const body = textOf(res);
    // The shared helper's own diagnosis survives — the error code and text are
    // not replaced, only attributed.
    expect(body).toContain("NON_JSON_RESPONSE");
    expect(body).toContain("NOT your configured ComfyUI");
    expect(body).toContain(PANEL_ORIGIN);
    // …and the remedy is redirected at the server that actually answered.
    expect(body).toContain(`check ${PANEL_ORIGIN}`);
  });

  it("leaves the non-fallback diagnosis byte-for-byte alone", async () => {
    // The note must appear ONLY after a fallback. When the configured target
    // answers with a bad body there is nothing to attribute, and a stray note
    // would name a panel that never entered the request.
    stubFetch(async () =>
      new Response("<!doctype html><html></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );

    const body = textOf(await handler()({ action: "list_templates" }));

    expect(body).toContain("NON_JSON_RESPONSE");
    expect(body).not.toContain("NOT your configured ComfyUI");
  });

  // ── #1600 merge gate, round 2 ──────────────────────────────────────────────

  it("FALLS THROUGH to the foreign panel when the alias does not answer", async () => {
    // The chain, end to end. The alias is asked FIRST because it is the configured
    // server; when nothing is there, the foreign panel is still asked rather than
    // the call dying on a preference.
    setConnectedPanelOrigins(() => ["http://[::1]:8199", PANEL_ORIGIN]);
    stubFetch(async (url) => {
      if (url === CONFIGURED || url === "http://[::1]:8199/api/workflow_templates") {
        throw transportFailure();
      }
      return jsonResponse({ core: [{ name: "a" }] });
    });

    const res = await handler()({ action: "list_templates" });

    expect(res.isError).toBeFalsy();
    expect(calls.map((c) => c.url)).toEqual([
      CONFIGURED,
      "http://[::1]:8199/api/workflow_templates",
      PANEL_URL,
    ]);
    expect(textOf(res)).toContain(`"answered_by": "${PANEL_ORIGIN}"`);
  });

  it("STOPS the chain at an answer, and never walks past one", async () => {
    // A status is an answer from the address we asked. Walking on from it is how a
    // caller ends up reading one server's reply as another's — so a 404 from the
    // alias ends the chain, and the foreign panel is never asked.
    setConnectedPanelOrigins(() => ["http://[::1]:8199", PANEL_ORIGIN]);
    stubFetch(async (url) => {
      if (url === CONFIGURED) throw transportFailure();
      if (url === "http://[::1]:8199/api/workflow_templates") return jsonResponse({ e: 1 }, 404);
      return jsonResponse({ core: [{ name: "a" }] });
    });

    const res = await handler()({ action: "list_templates" });

    expect(res.isError).toBe(true);
    expect(calls.map((c) => c.url)).toEqual([
      CONFIGURED,
      "http://[::1]:8199/api/workflow_templates",
    ]);
    expect(textOf(res)).toContain("[::1]:8199");
  });

  it("does NOT walk past a REDIRECT REFUSAL to the next candidate", async () => {
    // The guard the test above does NOT reach. A 404 is returned, not thrown, so
    // the chain stops there whatever the continue-condition says — a mutation
    // letting ANY error continue survived that test. The only failure that can
    // reach the guard is the redirect refusal, and it must stop the walk: a 3xx is
    // an ANSWER from that origin, and moving on from it to a different server is
    // the attribution mistake this whole path exists to prevent.
    setConnectedPanelOrigins(() => ["http://[::1]:8199", PANEL_ORIGIN]);
    stubFetch(async (url) => {
      if (url === CONFIGURED) throw transportFailure();
      if (url === "http://[::1]:8199/api/workflow_templates") {
        return new Response("", { status: 302, headers: { location: "http://elsewhere/" } });
      }
      return jsonResponse({ core: [{ name: "a" }] });
    });

    const res = await handler()({ action: "list_templates" });

    expect(res.isError).toBe(true);
    expect(calls.map((c) => c.url)).toEqual([
      CONFIGURED,
      "http://[::1]:8199/api/workflow_templates",
    ]);
    const body = textOf(res);
    expect(body).toContain("REDIRECT");
    expect(body).toContain("NOT followed");
  });

  it("does NOT fall back when the configured server answered with a REDIRECT", async () => {
    // Gate round 2, finding 1, over a real socket. `fetch` follows redirects, and
    // the error names only the LAST hop — so a configured server that 302s to a
    // dead address rejected with a bare ECONNREFUSED, indistinguishable from the
    // configured address itself refusing, and the index came back from another
    // machine under a note saying this one could not be reached at all.
    const dead = createServer(() => {});
    await new Promise<void>((r) => dead.listen(0, "127.0.0.1", () => r()));
    const deadPort = (dead.address() as AddressInfo).port;
    await new Promise<void>((r) => dead.close(() => r()));

    const server = createServer((_req, res) => {
      res.writeHead(302, { location: `http://127.0.0.1:${deadPort}/api/workflow_templates` });
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as AddressInfo).port;
    const previous = configuredBase;
    configuredBase = `http://127.0.0.1:${port}`;
    try {
      // A panel IS connected and WOULD answer. It must not be asked: the
      // configured server replied, and a reply is not a failure to reach it.
      const panel = createServer((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"from-the-panel":[{"name":"x"}]}');
      });
      await new Promise<void>((r) => panel.listen(0, "127.0.0.1", () => r()));
      const panelPort = (panel.address() as AddressInfo).port;
      setConnectedPanelOrigins(() => [`http://127.0.0.1:${panelPort}`]);
      try {
        const res = await handler()({ action: "list_templates" });

        expect(res.isError).toBe(true);
        const body = textOf(res);
        expect(body).toContain("302");
        // The panel's index must be nowhere in this result.
        expect(body).not.toContain("from-the-panel");
        expect(body).not.toContain("answered_by");
      } finally {
        await new Promise<void>((r) => panel.close(() => r()));
      }
    } finally {
      configuredBase = previous;
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  // ── #1600 merge gate, round 3 ──────────────────────────────────────────────

  it("does NOT walk past an alias that ANSWERED and then failed", async () => {
    // Finding 1. The walk continued on ANY rejection, so an alias whose
    // connection was ESTABLISHED and then reset advanced to a foreign server —
    // the exact move the PRIMARY path refuses to make. A reset proves a server IS
    // there, and asking a different machine because we lost its answer is how one
    // install's index gets reported as another's.
    setConnectedPanelOrigins(() => ["http://[::1]:8199", "http://192.168.1.50:8188"]);
    stubFetch(async (url) => {
      if (url === CONFIGURED) throw transportFailure();
      if (url.startsWith("http://[::1]:8199")) throw transportFailure("ECONNRESET", "read");
      return jsonResponse({ "from-the-foreign-panel": [{ name: "x" }] });
    });

    const res = await handler()({ action: "list_templates" });

    expect(res.isError).toBe(true);
    const body = textOf(res);
    expect(body).not.toContain("from-the-foreign-panel");
    expect(body).not.toContain("answered_by");
    expect(body).toContain("[::1]:8199");
    // The foreign panel must never have been dialled at all.
    expect(calls.map((c) => c.url)).not.toContain(
      "http://192.168.1.50:8188/api/workflow_templates",
    );
  });

  it("REFUSES a fallback body that is not a template index", async () => {
    // Finding 2. `expectShape` accepted any non-array object, so a 200 carrying
    // `{"error": "..."}` from an origin the user never configured was surfaced as
    // a listing — source_count 1, the error object presented as templates. The
    // whole design rests on a fallback body being CHECKED before it is believed.
    setConnectedPanelOrigins(() => [PANEL_ORIGIN]);
    stubFetch(async (url) => {
      if (url === CONFIGURED) throw transportFailure();
      return jsonResponse({ error: "not a template index" });
    });

    const res = await handler()({ action: "list_templates" });

    expect(res.isError).toBe(true);
    const body = textOf(res);
    expect(body).not.toContain('"source_count": 1');
    expect(body).not.toContain('"templates"');
    expect(body).toContain(PANEL_ORIGIN);
  });

  it("keeps EVERY alias spelling in the chain", () => {
    // Finding 3. `aliases.slice(0, 1)` threw away the other spellings — the same
    // "a canonical match is not a socket match" mistake this PR fixed one level
    // up. Two spellings of one server are two SOCKETS, and only one may answer.
    expect(
      choosePanelFallbackOrigin("http://localhost:8199/api/workflow_templates", [
        "http://127.0.0.1:8199",
        "http://[::1]:8199",
      ]),
    ).toEqual({
      kind: "alias",
      origin: "http://127.0.0.1:8199",
      then: [{ origin: "http://[::1]:8199", kind: "alias" }],
    });
  });

  it("tries a SECOND alias spelling when the first refuses", async () => {
    // Finding 3, end to end: the live IPv6 address was never dialled.
    const previous = configuredBase;
    configuredBase = "http://localhost:8199";
    try {
      setConnectedPanelOrigins(() => ["http://127.0.0.1:8199", "http://[::1]:8199"]);
      stubFetch(async (url) => {
        if (url.startsWith("http://localhost:8199")) throw transportFailure();
        if (url.startsWith("http://127.0.0.1:8199")) throw transportFailure();
        return jsonResponse({ "from-the-v6-alias": [{ name: "t" }] });
      });

      const res = await handler()({ action: "list_templates" });

      expect(res.isError).toBeFalsy();
      const body = textOf(res);
      expect(body).toContain("from-the-v6-alias");
      expect(body).toContain('"answered_by": "http://[::1]:8199"');
    } finally {
      configuredBase = previous;
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
