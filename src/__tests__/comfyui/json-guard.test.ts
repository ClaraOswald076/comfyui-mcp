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

import { describe, expect, it } from "vitest";
import {
  classifyNonJson,
  isNonJsonResponseError,
  looksLikeHtmlParsedAsJson,
  readComfyJson,
} from "../../comfyui/json-guard.js";

const URL_UNDER_TEST = "http://remote.example:8188/api/workflow_templates";

function res(body: string, init: { status?: number; contentType?: string } = {}): Response {
  return new Response(body, {
    status: init.status ?? 200,
    headers: init.contentType ? { "content-type": init.contentType } : {},
  });
}

describe("classifyNonJson names what answered instead of ComfyUI (#828)", () => {
  it("calls a 2xx HTML document the frontend/proxy catch-all, not a dead server", () => {
    const d = classifyNonJson({
      url: URL_UNDER_TEST,
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: "<!DOCTYPE html><html><head><title>ComfyUI</title></head><body><div id=app></div></body></html>",
    });
    expect(d.kind).toBe("html-page");
    expect(d.message).toContain("index.html");
    expect(d.message).toContain("reverse proxy");
    // It must NOT accuse the server of being down/unreachable — it answered.
    expect(d.message).not.toMatch(/unreachable|not running|could not reach/i);
  });

  it("calls a 401/403 an authentication gate and points the credential at the GATEWAY", () => {
    const d = classifyNonJson({
      url: URL_UNDER_TEST,
      status: 403,
      contentType: "text/html",
      body: "<html><body>Access denied</body></html>",
    });
    expect(d.kind).toBe("login");
    expect(d.message).toContain("COMFYUI_AUTH_TOKEN");
    expect(d.message).toContain("CF_ACCESS_CLIENT_ID");
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
    expect(d.message).toContain("reverse proxy");
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
});
