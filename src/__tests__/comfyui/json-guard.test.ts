// #828 — a remote ComfyUI's JSON endpoints answered with an HTML document and
// every tool surfaced only:
//
//     Unexpected token '<', "<!DOCTYPE "... is not valid JSON
//
// which names neither the URL, the status, nor what actually answered — and sent
// check_workflow_runtime into reporting "could not reach the ComfyUI server" for
// a server that answered perfectly well.
//
// The fix is to DETECT and SAY WHICH. These tests pin the classification (proxy
// error vs sign-in gate vs the frontend's catch-all index.html vs a plain 404)
// and the two rules that keep it honest: a body that parses as JSON is never
// reported as HTML, and a valid-JSON-but-wrong-document 200 is reported as such
// instead of being handed on as data.

import { describe, expect, it, vi } from "vitest";

// The body prefix is diagnostic, but a gateway that REFLECTS the request could
// put our own ComfyUI credential in it — and the prefix goes into an error the
// agent sees. Mock the auth headers so the redaction can be exercised.
const authHeaders = vi.hoisted(() => ({ value: {} as Record<string, string> }));
vi.mock("../../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config.js")>();
  return { ...actual, getComfyUIAuthHeaders: () => authHeaders.value };
});
import {
  classifyNonJson,
  isNonJsonResponseError,
  looksLikeHtmlParsedAsJson,
  readComfyJson,
  rethrowWithJsonDiagnosis,
} from "../../comfyui/json-guard.js";

const URL_UNDER_TEST = "http://remote.example:8188/api/workflow_templates";

function res(body: string, init: { status?: number; contentType?: string } = {}): Response {
  return new Response(body, {
    status: init.status ?? 200,
    headers: init.contentType ? { "content-type": init.contentType } : {},
  });
}

describe("classifyNonJson names what answered instead of ComfyUI (#828)", () => {
  it("names the ComfyUI FRONTEND only when the body carries its markers", () => {
    const d = classifyNonJson({
      url: URL_UNDER_TEST,
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: "<!DOCTYPE html><html><head><title>ComfyUI</title></head><body><div id='vue-app'></div></body></html>",
    });
    expect(d.kind).toBe("html-page");
    expect(d.message).toContain("ComfyUI web FRONTEND answered");
    expect(d.message).toContain("reverse proxy");
    // It must NOT accuse the server of being down/unreachable — it answered.
    expect(d.message).not.toMatch(/unreachable|not running|could not reach/i);
  });

  it("does NOT name a responder for generic HTML — it lists candidates instead", () => {
    // Nothing in a bare HTML body singles out the frontend, a proxy, a
    // maintenance page or an unrelated app. A confident wrong diagnosis costs
    // more than an honest "this does not identify which".
    const d = classifyNonJson({
      url: URL_UNDER_TEST,
      status: 200,
      contentType: "text/html",
      body: "<!DOCTYPE html><html><body><h1>Site under maintenance</h1></body></html>",
    });
    expect(d.kind).toBe("html-page");
    expect(d.message).toContain("does not identify which");
    expect(d.message).not.toContain("ComfyUI web FRONTEND answered");
    // The candidates are still listed, so the message stays actionable.
    expect(d.message).toContain("reverse proxy");
    expect(d.message).toContain("maintenance");
  });

  it("does not assert an identity proxy from a 401/403 STATUS alone", () => {
    // ComfyUI behind the user's own auth layer returns these too; the status
    // does not say which answered.
    const d = classifyNonJson({
      url: URL_UNDER_TEST,
      status: 403,
      contentType: "text/html",
      body: "<html><body>Access denied</body></html>",
    });
    expect(d.kind).toBe("login");
    expect(d.message).toContain("does not distinguish them");
    expect(d.message).not.toContain("SIGN-IN PAGE");
    // It still points the credential at the right place.
    expect(d.message).toContain("COMFYUI_AUTH_TOKEN");
    expect(d.message).toContain("CF_ACCESS_CLIENT_ID");
  });

  it("names a sign-in page only when the BODY shows one", () => {
    const d = classifyNonJson({
      url: URL_UNDER_TEST,
      status: 403,
      contentType: "text/html",
      body: '<html><form><input type="password" name="p"></form></html>',
    });
    expect(d.kind).toBe("login");
    expect(d.message).toContain("SIGN-IN PAGE");
    // A body-confirmed gateway DOES justify "give the credential to the gateway".
    expect(d.message).toContain("belongs to that GATEWAY, not to ComfyUI");
  });

  it("does not send the credential to the GATEWAY on an unconfirmed 401/403", () => {
    // ComfyUI behind the user's own auth layer returns these too, and telling
    // them to configure the wrong side wastes the round trip.
    const d = classifyNonJson({
      url: URL_UNDER_TEST,
      status: 401,
      contentType: "text/plain",
      body: "unauthorized",
    });
    expect(d.kind).toBe("login");
    expect(d.message).not.toContain("belongs to that GATEWAY, not to ComfyUI");
    expect(d.message).toContain("this response does not say which");
    // The remedy is still actionable — it names the knobs the connector uses.
    expect(d.message).toContain("COMFYUI_AUTH_TOKEN");
  });

  it("does not assert a proxy from a 502 STATUS alone", () => {
    const d = classifyNonJson({
      url: URL_UNDER_TEST,
      status: 503,
      contentType: "text/plain",
      body: "unavailable",
    });
    expect(d.kind).toBe("proxy-error");
    expect(d.message).toContain("does not identify what");
    expect(d.message).not.toContain("its OWN error page");
  });

  it("recognises a sign-in PAGE served with a 200 (a login redirect that already followed)", () => {
    const d = classifyNonJson({
      url: URL_UNDER_TEST,
      status: 200,
      contentType: "text/html",
      body: '<html><form action="/login"><input type="password" name="p"></form></html>',
    });
    expect(d.kind).toBe("login");
  });

  it("calls a 502/503/504 a proxy error page and says the proxy could not reach ComfyUI", () => {
    const d = classifyNonJson({
      url: URL_UNDER_TEST,
      status: 502,
      contentType: "text/html",
      body: "<html><head><title>502 Bad Gateway</title></head><body><center>nginx</center></body></html>",
    });
    expect(d.kind).toBe("proxy-error");
    expect(d.message).toContain("its OWN error page");
    expect(d.message).toContain("could not reach");
  });

  it("distinguishes a 404 HTML page from the SPA catch-all", () => {
    const d = classifyNonJson({
      url: URL_UNDER_TEST,
      status: 404,
      contentType: "text/html",
      body: "<html><body>Not Found</body></html>",
    });
    expect(d.kind).toBe("not-found");
  });

  it("classifies a non-HTML, non-JSON body as plain not-json", () => {
    const d = classifyNonJson({
      url: URL_UNDER_TEST,
      status: 200,
      contentType: "text/plain",
      body: "OK",
    });
    expect(d.kind).toBe("not-json");
  });

  it("always reports the url, status, content type and a short body prefix", () => {
    const d = classifyNonJson({
      url: URL_UNDER_TEST,
      status: 200,
      contentType: "text/html",
      body: "<!DOCTYPE html>\n<html>\n  <body>hello</body>\n</html>",
    });
    expect(d.message).toContain(URL_UNDER_TEST);
    expect(d.message).toContain("200");
    expect(d.message).toContain("text/html");
    expect(d.bodyPrefix).toBe("<!DOCTYPE html> <html> <body>hello</body> </html>");
    expect(d.message).toContain(d.bodyPrefix);
  });

  it("truncates a huge body instead of pasting a whole page into the message", () => {
    const d = classifyNonJson({
      url: URL_UNDER_TEST,
      status: 200,
      contentType: "text/html",
      body: `<!DOCTYPE html>${"x".repeat(5000)}`,
    });
    expect(d.bodyPrefix.length).toBeLessThanOrEqual(161);
    expect(d.bodyPrefix.endsWith("…")).toBe(true);
  });

  it("tells the caller how to check that the base URL is a ComfyUI at all", () => {
    const d = classifyNonJson({
      url: URL_UNDER_TEST,
      status: 200,
      contentType: "text/html",
      body: "<!DOCTYPE html><html></html>",
    });
    // Loading the UI in a browser is NOT proof — the same catch-all serves it.
    expect(d.message).toContain("/system_stats");
    expect(d.message).toContain("devices");
    expect(d.message).toContain("is not proof");
  });
});

describe("the diagnostic body prefix never carries our own credential back", () => {
  it("redacts a configured auth token a reflecting gateway echoed into its page", () => {
    authHeaders.value = { Authorization: "Bearer super-secret-token-xyz" };
    try {
      const d = classifyNonJson({
        url: URL_UNDER_TEST,
        status: 401,
        contentType: "text/html",
        body: "<html><body>Invalid credential: Bearer super-secret-token-xyz</body></html>",
      });
      expect(d.bodyPrefix).not.toContain("super-secret-token-xyz");
      expect(d.message).not.toContain("super-secret-token-xyz");
      expect(d.bodyPrefix).toContain("«redacted»");
    } finally {
      authHeaders.value = {};
    }
  });

  it("redacts the bare token even when the page echoes it without the scheme", () => {
    authHeaders.value = { Authorization: "Bearer super-secret-token-xyz" };
    try {
      const d = classifyNonJson({
        url: URL_UNDER_TEST,
        status: 403,
        contentType: "text/html",
        body: "<html>token super-secret-token-xyz rejected</html>",
      });
      expect(d.bodyPrefix).not.toContain("super-secret-token-xyz");
    } finally {
      authHeaders.value = {};
    }
  });

  it("WITHHOLDS the body entirely when the credential is too short to redact safely", () => {
    // Substituting a 3-character token would mangle unrelated text, and emitting
    // it unredacted would hand our own credential back through a tool result.
    // Fail closed instead of choosing between two bad options.
    authHeaders.value = { "X-API-Key": "abc" };
    try {
      const d = classifyNonJson({
        url: URL_UNDER_TEST,
        status: 401,
        contentType: "text/html",
        body: "<html>rejected key abc</html>",
      });
      expect(d.bodyPrefix).toBe("(body withheld: it contains the configured ComfyUI credential)");
      expect(d.message).not.toContain("rejected key abc");
    } finally {
      authHeaders.value = {};
    }
  });

  it("does not withhold when a short credential does NOT appear in the body", () => {
    authHeaders.value = { "X-API-Key": "abc" };
    try {
      const d = classifyNonJson({
        url: URL_UNDER_TEST,
        status: 500,
        contentType: "text/html",
        body: "<html>internal error</html>",
      });
      expect(d.bodyPrefix).toBe("<html>internal error</html>");
    } finally {
      authHeaders.value = {};
    }
  });

  it("leaves an ordinary body untouched when no credential is configured", () => {
    authHeaders.value = {};
    const d = classifyNonJson({
      url: URL_UNDER_TEST,
      status: 200,
      contentType: "text/html",
      body: "<html>plain page</html>",
    });
    expect(d.bodyPrefix).toBe("<html>plain page</html>");
    expect(d.bodyPrefix).not.toContain("«redacted»");
  });
});

describe("readComfyJson: parses JSON, explains everything else (#828)", () => {
  it("returns the parsed document on a normal JSON 200", async () => {
    const v = await readComfyJson<{ a: number }>(
      res('{"a":1}', { contentType: "application/json" }),
      { url: URL_UNDER_TEST },
    );
    expect(v).toEqual({ a: 1 });
  });

  it("throws a NonJsonResponseError naming the responder for an HTML 200", async () => {
    await expect(
      readComfyJson(res("<!DOCTYPE html><html></html>", { contentType: "text/html" }), {
        url: URL_UNDER_TEST,
      }),
    ).rejects.toSatisfy((e: unknown) => {
      if (!isNonJsonResponseError(e)) return false;
      // The reason, not just the failure: it must say WHAT answered.
      return e.diagnosis.kind === "html-page" && e.message.includes(URL_UNDER_TEST);
    });
  });

  it("trusts the BODY over the header: JSON mislabelled text/plain still parses", async () => {
    const v = await readComfyJson<{ ok: boolean }>(
      res('{"ok":true}', { contentType: "text/plain" }),
      { url: URL_UNDER_TEST },
    );
    expect(v).toEqual({ ok: true });
  });

  it("trusts the BODY over the header: HTML mislabelled application/json is still HTML", async () => {
    await expect(
      readComfyJson(res("<!DOCTYPE html><html></html>", { contentType: "application/json" }), {
        url: URL_UNDER_TEST,
      }),
    ).rejects.toThrow(/HTML page/);
  });

  it("surfaces a JSON error body verbatim rather than as a shape complaint", async () => {
    await expect(
      readComfyJson(res('{"error":"nope"}', { status: 500, contentType: "application/json" }), {
        url: URL_UNDER_TEST,
      }),
    ).rejects.toThrow(/returned 500/);
  });

  it("rejects valid JSON that is not the expected document, instead of handing it on", async () => {
    await expect(
      readComfyJson(res('{"message":"unauthorized"}', { contentType: "application/json" }), {
        url: `${URL_UNDER_TEST}`,
        expectShape: (v) => !!v && typeof v === "object" && "devices" in (v as object),
        shapeHint: "a ComfyUI /system_stats document",
      }),
    ).rejects.toThrow(/valid JSON that is not a ComfyUI \/system_stats document/);
  });

  it("accepts the document when the shape predicate is satisfied", async () => {
    const v = await readComfyJson<{ devices: unknown[] }>(
      res('{"devices":[],"system":{}}', { contentType: "application/json" }),
      {
        url: URL_UNDER_TEST,
        expectShape: (x) => !!x && typeof x === "object" && "devices" in (x as object),
      },
    );
    expect(v.devices).toEqual([]);
  });
});

describe("looksLikeHtmlParsedAsJson recognises a library's own parse failure (#828)", () => {
  it("matches the exact error #828 was reported as", () => {
    expect(
      looksLikeHtmlParsedAsJson(
        new SyntaxError(`Unexpected token '<', "<!DOCTYPE "... is not valid JSON`),
      ),
    ).toBe(true);
  });

  it("matches the older V8 wording too", () => {
    expect(
      looksLikeHtmlParsedAsJson(new SyntaxError("Unexpected token < in JSON at position 0")),
    ).toBe(true);
  });

  it("does NOT match an unrelated transport failure — that must keep its own message", () => {
    expect(looksLikeHtmlParsedAsJson(new Error("fetch failed"))).toBe(false);
    expect(looksLikeHtmlParsedAsJson(new Error("ECONNREFUSED 127.0.0.1:8188"))).toBe(false);
  });

  it("does NOT match a JSON-syntax error with no MARKUP in it", () => {
    // A truncated or malformed JSON body is a real, truthful error. Treating it
    // as "probably HTML" would fire a speculative second request and let a
    // LATER, different response rewrite the diagnosis.
    expect(
      looksLikeHtmlParsedAsJson(new SyntaxError("Unterminated string in JSON at position 42")),
    ).toBe(false);
    expect(looksLikeHtmlParsedAsJson(new SyntaxError("Unexpected end of JSON input"))).toBe(false);
    expect(
      looksLikeHtmlParsedAsJson(new SyntaxError(`Unexpected token 'x', "xyz" is not valid JSON`)),
    ).toBe(false);
  });
});

describe("rethrowWithJsonDiagnosis never asserts a cause it did not prove (#828)", () => {
  const ORIGINAL = new SyntaxError(`Unexpected token '<', "<!DOCTYPE "... is not valid JSON`);
  const PROBE_URL = "http://remote.example:8188/object_info";

  it("redacts a reflected credential OUT of the original parse message", async () => {
    // The library's parse error QUOTES the body it choked on, so a gateway that
    // reflects the request puts our own token in that message — and the message
    // is carried verbatim into the diagnosis.
    authHeaders.value = { Authorization: "Bearer echoed-secret-token-here" };
    try {
      global.fetch = vi.fn(
        async () =>
          new Response("<!DOCTYPE html><html></html>", {
            status: 200,
            headers: { "content-type": "text/html" },
          }),
      ) as unknown as typeof fetch;
      const reflecting = new SyntaxError(
        `Unexpected token '<', "<html>Bearer echoed-secret-token-here</html>" is not valid JSON`,
      );
      await expect(rethrowWithJsonDiagnosis(reflecting, PROBE_URL)).rejects.toSatisfy(
        (e: unknown) => e instanceof Error && !e.message.includes("echoed-secret-token-here"),
      );
    } finally {
      authHeaders.value = {};
    }
  });

  it("keeps the ORIGINAL message and marks the probe as a separate request", async () => {
    global.fetch = vi.fn(
      async () =>
        new Response("<!DOCTYPE html><html></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    ) as unknown as typeof fetch;

    await expect(rethrowWithJsonDiagnosis(ORIGINAL, PROBE_URL)).rejects.toSatisfy((e: unknown) => {
      if (!isNonJsonResponseError(e)) return false;
      return (
        e.message.includes(ORIGINAL.message) &&
        e.message.includes("not necessarily the same response")
      );
    });
  });

  it("rethrows the ORIGINAL untouched when the probe is inconclusive", async () => {
    // The endpoint answers JSON now, so we cannot claim the earlier body was
    // HTML — the truthful original error must survive unchanged.
    global.fetch = vi.fn(
      async () =>
        new Response('{"ok":true}', {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ) as unknown as typeof fetch;

    await expect(rethrowWithJsonDiagnosis(ORIGINAL, PROBE_URL)).rejects.toBe(ORIGINAL);
  });

  it("still redacts a reflected credential when the probe is INCONCLUSIVE", async () => {
    // The redaction must not depend on the probe happening to succeed — the raw
    // parse message quotes the body either way, and it is what gets rethrown.
    authHeaders.value = { Authorization: "Bearer echoed-secret-token-here" };
    try {
      global.fetch = vi.fn(
        async () =>
          new Response('{"ok":true}', {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ) as unknown as typeof fetch;
      const reflecting = new SyntaxError(
        `Unexpected token '<', "<html>Bearer echoed-secret-token-here</html>" is not valid JSON`,
      );
      await expect(rethrowWithJsonDiagnosis(reflecting, PROBE_URL)).rejects.toSatisfy(
        (e: unknown) =>
          e instanceof Error &&
          !e.message.includes("echoed-secret-token-here") &&
          e.message.includes("«redacted»"),
      );
    } finally {
      authHeaders.value = {};
    }
  });

  it("redacts the STACK too — a Node stack embeds the message", async () => {
    // Copying the stack verbatim would carry the credential straight past the
    // message redaction and into any unhandled-rejection log.
    authHeaders.value = { Authorization: "Bearer echoed-secret-token-here" };
    try {
      global.fetch = vi.fn(async () => {
        throw new Error("fetch failed");
      }) as unknown as typeof fetch;
      const reflecting = new SyntaxError(
        `Unexpected token '<', "<html>Bearer echoed-secret-token-here</html>" is not valid JSON`,
      );
      reflecting.stack = `SyntaxError: ${reflecting.message}\n    at somewhere`;
      await expect(rethrowWithJsonDiagnosis(reflecting, PROBE_URL)).rejects.toSatisfy(
        (e: unknown) =>
          e instanceof Error &&
          !e.message.includes("echoed-secret-token-here") &&
          !(e.stack ?? "").includes("echoed-secret-token-here"),
      );
    } finally {
      authHeaders.value = {};
    }
  });

  it("still redacts when the probe itself FAILS", async () => {
    authHeaders.value = { Authorization: "Bearer echoed-secret-token-here" };
    try {
      global.fetch = vi.fn(async () => {
        throw new Error("fetch failed");
      }) as unknown as typeof fetch;
      const reflecting = new SyntaxError(
        `Unexpected token '<', "<html>Bearer echoed-secret-token-here</html>" is not valid JSON`,
      );
      await expect(rethrowWithJsonDiagnosis(reflecting, PROBE_URL)).rejects.toSatisfy(
        (e: unknown) => e instanceof Error && !e.message.includes("echoed-secret-token-here"),
      );
    } finally {
      authHeaders.value = {};
    }
  });

  it("rethrows the ORIGINAL untouched when the probe itself fails", async () => {
    global.fetch = vi.fn(async () => {
      throw new Error("fetch failed");
    }) as unknown as typeof fetch;
    await expect(rethrowWithJsonDiagnosis(ORIGINAL, PROBE_URL)).rejects.toBe(ORIGINAL);
  });

  it("does not probe at all for an error that is not markup-parsed-as-JSON", async () => {
    const spy = vi.fn();
    global.fetch = spy as unknown as typeof fetch;
    const transport = new Error("fetch failed");
    await expect(rethrowWithJsonDiagnosis(transport, PROBE_URL)).rejects.toBe(transport);
    expect(spy).not.toHaveBeenCalled();
  });
});
