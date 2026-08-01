import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { probeRemoteModelPayload } from "../../services/download-cache.js";

// The #473 remote gate refuses a Manager dispatch ONLY when a credential FLIP proves the
// URL is authentication-gated: an unauthenticated fetch (what Manager does) returns a
// non-model auth/error page, but the SAME url fetched WITH the local credential (which
// Manager can never receive) returns a real model. A location-specific WAF/geo interstitial
// affects both fetches equally → no flip → never blocked (no false positive across the
// MCP-vs-host vantage gap).

const fetchMock = vi.fn();
const AUTH = { Authorization: "Bearer secret" };

function response(body: BodyInit, status: number, contentType?: string): Response {
  const headers: Record<string, string> = {};
  if (contentType) headers["content-type"] = contentType;
  return new Response(body, { status, headers });
}
function htmlPage(status = 200): Response {
  return response("<!doctype html><html><body>Please log in</body></html>", status, "text/html; charset=utf-8");
}
function jsonErr(status = 401): Response {
  return response(JSON.stringify({ error: "unauthorized" }), status, "application/json");
}
function modelBinary(status = 200): Response {
  // Leading bytes that are NOT `<`/`{`/`[` and not valid text → classifier "binary".
  return response(new Uint8Array([0x8c, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x7b]), status, "application/octet-stream");
}
/** unauth fetch (no Authorization) → `unauthResp`; credentialed fetch → `authedResp`. */
function flipMock(unauthResp: () => Response, authedResp: () => Response): void {
  fetchMock.mockImplementation((_url: string, opts?: { headers?: Record<string, string> }) => {
    const authed = !!opts?.headers?.Authorization;
    return Promise.resolve(authed ? authedResp() : unauthResp());
  });
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("probeRemoteModelPayload — #473 credential-flip gate", () => {
  it("verdict MODEL for a public url (unauthenticated fetch already returns binary) — one probe only", async () => {
    fetchMock.mockResolvedValue(modelBinary());
    const p = await probeRemoteModelPayload("https://x/pub.safetensors", ".safetensors", undefined, { authHeaders: AUTH });
    expect(p.verdict).toBe("model");
    // No need for the credentialed flip probe once the unauthenticated fetch is a model.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("verdict NON-MODEL when an HTML page flips to a real model with the credential (auth-gated)", async () => {
    flipMock(() => htmlPage(200), () => modelBinary());
    const p = await probeRemoteModelPayload("https://civitai.com/api/download/models/1", ".safetensors", undefined, { authHeaders: AUTH });
    expect(p.verdict).toBe("non-model");
    expect(p.kind).toBe("html");
    expect(fetchMock).toHaveBeenCalledTimes(2); // unauth + credentialed flip
  });

  it("verdict NON-MODEL when a 401 JSON flips to a real model with the credential", async () => {
    flipMock(() => jsonErr(401), () => modelBinary());
    const p = await probeRemoteModelPayload("https://x/gated.safetensors", ".safetensors", undefined, { authHeaders: AUTH });
    expect(p.verdict).toBe("non-model");
    expect(p.kind).toBe("json");
  });

  it("verdict INCONCLUSIVE for a bare 401 with NO html/json body (not a clear auth page — no cry wolf)", async () => {
    // A bare status with no HTML/JSON body is not a CLEAR auth page, so even if the
    // credentialed retry is a model we stay inconclusive (P2 — only warn on a clear page).
    flipMock(() => response(new Uint8Array([0x00, 0x11, 0x22]), 401, "application/octet-stream"), () => modelBinary());
    const p = await probeRemoteModelPayload("https://x/gated.safetensors", ".safetensors", undefined, { authHeaders: AUTH });
    expect(p.verdict).toBe("inconclusive");
  });

  it("verdict INCONCLUSIVE on a TRANSIENT 503 even if the credentialed retry is a model (no cry wolf)", async () => {
    // P2: a public URL that momentarily 503s (even with an HTML maintenance page) then serves
    // the model on retry must NOT fire the auth-gated warning. A 5xx is never a clear auth page.
    let calls = 0;
    fetchMock.mockImplementation((_url: string, opts?: { headers?: Record<string, string> }) => {
      calls += 1;
      return Promise.resolve(
        opts?.headers?.Authorization ? modelBinary() : response("<!doctype html>maintenance</html>", 503, "text/html"),
      );
    });
    const p = await probeRemoteModelPayload("https://x/m.safetensors", ".safetensors", undefined, { authHeaders: AUTH });
    expect(p.verdict).toBe("inconclusive");
    expect(calls).toBe(1); // transient unauth → NOT a clear auth page → no credentialed probe
  });

  it("verdict INCONCLUSIVE on a TRANSIENT 429 (rate limit) even if the credentialed retry is a model", async () => {
    fetchMock.mockImplementation((_url: string, opts?: { headers?: Record<string, string> }) =>
      Promise.resolve(opts?.headers?.Authorization ? modelBinary() : jsonErr(429)),
    );
    const p = await probeRemoteModelPayload("https://x/m.safetensors", ".safetensors", undefined, { authHeaders: AUTH });
    expect(p.verdict).toBe("inconclusive");
  });

  it("CREDENTIAL SAFETY: strips ALL auth (Authorization + custom headers) on a cross-origin redirect", async () => {
    // The credentialed flip probe must send auth ONLY to the original target host. When the
    // origin 302s cross-origin, Authorization AND any custom header (e.g. X-API-Key) are
    // dropped for the rest of the chain — only Range survives. Regression for a P0 leak.
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    fetchMock.mockImplementation((u: string, opts?: { headers?: Record<string, string> }) => {
      const headers = opts?.headers ?? {};
      calls.push({ url: u, headers });
      const authed = !!headers.Authorization || !!headers["X-API-Key"];
      if (u === "https://origin.example/m.safetensors") {
        // Unauthenticated → a clear auth page (drives the flip); authenticated → redirect off-origin.
        return Promise.resolve(
          authed
            ? new Response("", { status: 302, headers: { location: "https://cdn.other.example/signed/m.safetensors" } })
            : htmlPage(200),
        );
      }
      return Promise.resolve(modelBinary()); // the cross-origin CDN serves the model
    });
    const authHeaders = { Authorization: "Bearer secret", "X-API-Key": "custom-key" };
    const p = await probeRemoteModelPayload("https://origin.example/m.safetensors", ".safetensors", undefined, { authHeaders });
    expect(p.verdict).toBe("non-model"); // flip confirmed via the authed redirect→model chain
    // The cross-origin CDN hop must carry NO credential — only Range.
    const cdnCall = calls.find((c) => c.url.startsWith("https://cdn.other.example/"));
    expect(cdnCall).toBeDefined();
    expect(cdnCall!.headers.Authorization).toBeUndefined();
    expect(cdnCall!.headers["X-API-Key"]).toBeUndefined();
    expect(cdnCall!.headers.Range).toMatch(/^bytes=0-\d+$/);
    // …while the original-origin authed hop DID carry both.
    const originAuthed = calls.find((c) => c.url === "https://origin.example/m.safetensors" && !!c.headers.Authorization);
    expect(originAuthed!.headers["X-API-Key"]).toBe("custom-key");
  });

  it("verdict INCONCLUSIVE for a location interstitial that does NOT flip (WAF ignores the bearer)", async () => {
    // Both the unauth AND the credentialed fetch return the same HTML → NOT auth-gating →
    // must NOT block (the host could still get a real model). This is the Codex vantage P0.
    flipMock(() => htmlPage(200), () => htmlPage(200));
    const p = await probeRemoteModelPayload("https://x/model.safetensors", ".safetensors", undefined, { authHeaders: AUTH });
    expect(p.verdict).toBe("inconclusive");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("verdict INCONCLUSIVE when an HTML page appears but NO credential is available to flip", async () => {
    fetchMock.mockResolvedValue(htmlPage(200));
    const p = await probeRemoteModelPayload("https://x/model.safetensors", ".safetensors", undefined, { authHeaders: {} });
    expect(p.verdict).toBe("inconclusive");
    expect(fetchMock).toHaveBeenCalledTimes(1); // no credential → no second probe
  });

  it("verdict INCONCLUSIVE when the credential is present but does not flip (invalid token → still 401)", async () => {
    flipMock(() => jsonErr(401), () => jsonErr(401));
    const p = await probeRemoteModelPayload("https://x/model.safetensors", ".safetensors", undefined, { authHeaders: AUTH });
    expect(p.verdict).toBe("inconclusive");
  });

  it("verdict INCONCLUSIVE when the credentialed flip fetch itself errors (network)", async () => {
    fetchMock.mockImplementation((_url: string, opts?: { headers?: Record<string, string> }) =>
      opts?.headers?.Authorization ? Promise.reject(new Error("connreset")) : Promise.resolve(htmlPage(200)),
    );
    const p = await probeRemoteModelPayload("https://x/model.safetensors", ".safetensors", undefined, { authHeaders: AUTH });
    expect(p.verdict).toBe("inconclusive");
  });

  it("verdict INCONCLUSIVE on a network error on the first (unauthenticated) probe — never blocks", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNRESET"));
    const p = await probeRemoteModelPayload("https://x/model.safetensors", ".safetensors", undefined, { authHeaders: AUTH });
    expect(p.verdict).toBe("inconclusive");
  });

  it("verdict INCONCLUSIVE on a transient non-2xx that does not flip (403/429/5xx)", async () => {
    // A 403/5xx that returns the same non-model on both probes → cannot prove auth-gating.
    flipMock(() => response("<!doctype html><html>Just a moment…</html>", 403, "text/html"), () => response("upstream down", 503, "text/plain"));
    const p = await probeRemoteModelPayload("https://x/model.safetensors", ".safetensors", undefined, { authHeaders: AUTH });
    expect(p.verdict).toBe("inconclusive");
  });

  it("does NOT fetch or gate a non-model-binary extension (.zip)", async () => {
    const p = await probeRemoteModelPayload("https://x/pack.zip", ".zip", undefined, { authHeaders: AUTH });
    expect(p.verdict).toBe("inconclusive");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does NOT fetch when the extension is missing", async () => {
    const p = await probeRemoteModelPayload("https://x/model", undefined, undefined, { authHeaders: AUTH });
    expect(p.verdict).toBe("inconclusive");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("Range-limits the request and follows redirects (does not drain a large body)", async () => {
    const big = new Uint8Array(10 * 1024 * 1024);
    big[0] = 0x8c; // non-text lead → binary
    fetchMock.mockResolvedValue(response(big, 200, "application/octet-stream"));
    const p = await probeRemoteModelPayload("https://x/big.safetensors", ".safetensors", undefined, { authHeaders: AUTH });
    expect(p.verdict).toBe("model");
    const opts = fetchMock.mock.calls[0][1] as { headers: Record<string, string>; redirect?: string };
    expect(opts.headers.Range).toMatch(/^bytes=0-\d+$/);
    expect(opts.redirect).toBe("manual"); // manual redirects — never "follow" (credential safety)
  });

  it("TIMES OUT to inconclusive when the fetch stalls, even with a caller signal present (both signals apply)", async () => {
    // Regression for the compat-path P1: the manual timeout must fire independently of the
    // caller signal (never `signal ?? timeout`), so a stalled probe can't hang the dispatch.
    vi.useFakeTimers();
    fetchMock.mockImplementation(
      (_url: string, opts?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          opts?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    const callerSignal = new AbortController().signal; // present, but never aborts on its own
    const p = probeRemoteModelPayload("https://x/m.safetensors", ".safetensors", callerSignal, { authHeaders: AUTH });
    await vi.advanceTimersByTimeAsync(13_000); // past the 12s probe ceiling
    await expect(p).resolves.toMatchObject({ verdict: "inconclusive" });
    vi.useRealTimers();
  });

  it("treats a form-feed-prefixed HTML login page as html when it flips (matches the #473 classifier)", async () => {
    flipMock(() => response("\f<!doctype html><html>gated</html>", 200, "application/octet-stream"), () => modelBinary());
    const p = await probeRemoteModelPayload("https://x/model.safetensors", ".safetensors", undefined, { authHeaders: AUTH });
    expect(p.verdict).toBe("non-model");
    expect(p.kind).toBe("html");
  });
});
