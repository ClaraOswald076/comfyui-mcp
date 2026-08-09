// #828 / #1160 — the client library's OWN error path was eating the response.
//
// `Client.fetchApi` calls `res.json()` on the ERROR body for any status outside
// [200, 400), so it can attach the parsed body to the error it is about to
// throw. When that body is not JSON — empty, an HTML login page, a proxy error
// document — `res.json()` rejects FIRST and its bare SyntaxError propagates in
// place of the library's error, taking the status, the statusText and the URL
// with it.
//
// That is one defect upstream of every `client.fetchApi` call site, which is why
// guarding the call sites one at a time kept missing it: `uploadImageHttp`
// already ran `readComfyJson` on its success path and STILL reported a bare
// "Unexpected end of JSON input" (#1160), because the library threw before that
// code ever saw the response.
//
// These tests drive the REAL library through the REAL wiring in getClient(), so
// reverting `fetch: guardClientFetch(comfyuiFetch)` to `fetch: comfyuiFetch`
// fails them.

import { describe, expect, it, beforeEach, vi } from "vitest";

vi.mock("../../config.js", () => ({
  config: { comfyuiSsl: false, comfyuiPath: "", comfyuiBasePath: "" },
  getComfyUIApiHost: () => "remote.example:8188",
  getComfyUIBasePath: () => "",
  getComfyUIBaseUrl: () => "http://remote.example:8188",
  getComfyUIAuthHeaders: () => ({}),
  isCloudMode: () => false,
  isRemoteMode: () => true,
}));

import {
  getLogs,
  getObjectInfo,
  resetClient,
  resetObjectInfoCache,
  uploadImageHttp,
} from "../../comfyui/client.js";
import {
  classifyNonJson,
  guardClientFetch,
  isNonJsonResponseError,
  redactUrlForDiagnosis,
} from "../../comfyui/json-guard.js";

/** Every response the fake server will give, in order. */
function serve(...responses: Array<() => Response>): void {
  let i = 0;
  global.fetch = vi.fn(async () => {
    const make = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return make();
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  vi.clearAllMocks();
  // getClient() memoises, and these tests each want a client built from the
  // wiring under test rather than one another's leftovers.
  resetClient();
  resetObjectInfoCache();
});

describe("the library's non-2xx path can no longer eat the response (#828)", () => {
  it("diagnoses an EMPTY error body instead of 'Unexpected end of JSON input'", async () => {
    // The reported shape: remote ComfyUI, post-reconnect, /internal/logs answers
    // a bodiless 404. getLogs retries once, so both attempts get it.
    serve(() => new Response(null, { status: 404, statusText: "Not Found" }));

    const err = await getLogs().then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    // The regression itself: the parser message must not be the whole answer.
    expect(message).not.toMatch(/^Unexpected end of JSON input$/);
    expect(message).not.toMatch(/Failed to fetch ComfyUI logs after reconnect retry: Unexpected end of JSON input/);
    expect(isNonJsonResponseError(err)).toBe(true);
    // What the reader actually needed: which endpoint, what status, what came back.
    expect(message).toContain("/internal/logs");
    expect(message).toContain("404");
    expect(message).toContain("EMPTY body");
  });

  it("does not recast a diagnosed server answer as a connection failure", async () => {
    // getLogs used to wrap EVERY second-attempt error in a ConnectionError
    // headed "Failed to fetch", which contradicted a diagnosis that had just
    // established the server answered.
    serve(() => new Response(null, { status: 404, statusText: "Not Found" }));

    const err = await getLogs().then(
      () => null,
      (e: unknown) => e,
    );

    expect((err as Error).message).not.toContain("Failed to fetch ComfyUI logs");
    expect((err as { code?: string }).code).toBe("NON_JSON_RESPONSE");
  });

  it("names the sign-in gate on an authenticated remote upload (#1160)", async () => {
    // uploadImageHttp's success path was already guarded; the 401 made the
    // library throw first, so that guard never ran.
    serve(
      () =>
        new Response(
          "<!DOCTYPE html><html><head><title>Sign in</title></head>" +
            '<body><form action="/login"><input type="password" name="p"></form></body></html>',
          { status: 401, statusText: "Unauthorized", headers: { "content-type": "text/html" } },
        ),
    );

    const err = await uploadImageHttp("cat.png", Buffer.from("x")).then(
      () => null,
      (e: unknown) => e,
    );

    expect(isNonJsonResponseError(err)).toBe(true);
    const message = (err as Error).message;
    expect(message).not.toMatch(/^Unexpected/);
    expect(message).toContain("/upload/image");
    expect(message).toContain("401");
    expect(message).toMatch(/SIGN-IN PAGE/);
  });

  it("still succeeds on a normal 2xx JSON response", async () => {
    // The guard must be invisible when nothing is wrong — a false positive here
    // would break every upload.
    serve(
      () =>
        new Response(JSON.stringify({ name: "cat.png", subfolder: "", type: "input" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    await expect(uploadImageHttp("cat.png", Buffer.from("x"))).resolves.toEqual({
      name: "cat.png",
      subfolder: "",
      type: "input",
    });
  });

  it("passes a plain-text 200 log body through untouched", async () => {
    // /internal/logs legitimately answers raw text on some versions, and getLogs
    // reads it with text(). The override must not disturb that path.
    serve(
      () =>
        new Response("line one\nline two\n", {
          status: 200,
          headers: { "content-type": "text/plain" },
        }),
    );

    await expect(getLogs()).resolves.toEqual(["line one", "line two"]);
  });
});

describe("guardClientFetch", () => {
  it("leaves text() and a valid json() alone", async () => {
    const wrapped = guardClientFetch(
      async () =>
        new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } }),
    );

    await expect((await wrapped("http://x/y")).json()).resolves.toEqual({ ok: true });
    await expect((await wrapped("http://x/y")).text()).resolves.toBe('{"ok":true}');
  });

  it("reports the request target when the response carries no url of its own", async () => {
    // A synthesised Response (a test double, a mock server shim) has url === "".
    const wrapped = guardClientFetch(async () => new Response("<html></html>", { status: 502 }));

    await expect(wrapped("http://remote.example:8188/prompt").then((r) => r.json())).rejects.toThrow(
      /http:\/\/remote\.example:8188\/prompt/,
    );
  });

  it("does not consume the body until json() is called", async () => {
    // Reading the body up front would break every caller that uses text() — the
    // guard has to be lazy, not eager.
    const wrapped = guardClientFetch(async () => new Response("not json", { status: 200 }));
    const res = await wrapped("http://x/y");
    expect(res.bodyUsed).toBe(false);
    await expect(res.text()).resolves.toBe("not json");
  });
});

describe("classifyNonJson on an empty body", () => {
  it("says the body was empty rather than that it failed to parse", () => {
    const d = classifyNonJson({
      url: "http://remote.example:8188/internal/logs",
      status: 404,
      contentType: "",
      body: "",
    });
    expect(d.kind).toBe("not-found");
    expect(d.message).toContain("EMPTY body");
    expect(d.message).toContain("NOTHING was sent back");
  });

  it("flags an empty 2xx as the stranger case that it is", () => {
    const d = classifyNonJson({
      url: "http://remote.example:8188/system_stats",
      status: 200,
      contentType: "application/json",
      body: "   \n ",
    });
    expect(d.kind).toBe("not-json");
    expect(d.message).toContain("EMPTY body");
    expect(d.message).toContain("SUCCESS one");
  });

  it("still prefers the gateway diagnosis for an empty 502", () => {
    // The status IS the evidence here, and "a proxy could not reach ComfyUI" is
    // more use than "the body was empty".
    const d = classifyNonJson({
      url: "http://remote.example:8188/prompt",
      status: 502,
      contentType: "",
      body: "",
    });
    expect(d.kind).toBe("proxy-error");
  });

  // Pins the empty branch's POSITION, not just its existence. Moving it above
  // the auth branch would turn "an auth gate rejected this" into a generic
  // "nothing came back", which sends the reader to the wrong layer entirely —
  // and the 404/200/502 cases above would all still pass (codex gate, finding 7).
  it.each([401, 403])("still prefers the auth diagnosis for an empty %i", (status) => {
    const d = classifyNonJson({
      url: "http://remote.example:8188/upload/image",
      status,
      contentType: "",
      body: "",
    });
    expect(d.kind).toBe("login");
    expect(d.message).toMatch(/needs the credential/);
  });
});

// The guard changes the SHAPE of the error the library throws, from a raw
// SyntaxError to a NonJsonResponseError. Any predicate written against the old
// shape silently answers "no" for the strongest evidence available — and
// getObjectInfo has one, picking which of two failed attempts to report.
describe("a first-hand diagnosis still wins over a retry blip", () => {
  it("reports attempt 1's HTML diagnosis, not the retry's transport failure", async () => {
    // Round 8 of the original #828 gate established this rule: when the first
    // request PROVED a non-JSON answer and the retry merely hit a blip,
    // surfacing the retry downgrades a known diagnosis to "server unavailable"
    // and sends the user to check whether ComfyUI is running. The guard broke
    // the predicate that enforced it.
    let call = 0;
    global.fetch = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        return new Response("<!DOCTYPE html><html><body>gateway</body></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      }
      throw Object.assign(new TypeError("fetch failed"), { code: "ECONNREFUSED" });
    }) as unknown as typeof fetch;

    const err = await getObjectInfo().then(
      () => null,
      (e: unknown) => e,
    );

    expect(isNonJsonResponseError(err)).toBe(true);
    expect((err as Error).message).toContain("HTML page");
    expect((err as Error).message).not.toContain("fetch failed");
  });
});

describe("the diagnosis URL is redacted (codex gate, finding 6)", () => {
  it("redacts an OAuth redirect target without mangling the route", () => {
    // Response.url is the url AFTER redirects, so an identity proxy that bounces
    // the request to its SSO endpoint puts a live authorization code in it.
    const out = redactUrlForDiagnosis(
      "https://sso.example.com/callback?code=4/0AY0e-g7xQ&state=abc123&redirect_uri=/api",
    );
    expect(out).not.toContain("4/0AY0e-g7xQ");
    expect(out).not.toContain("abc123");
    // The part that identifies the route must survive — that is the whole point
    // of the message.
    expect(out).toContain("sso.example.com/callback");
    expect(out).toContain("redirect_uri");
  });

  it("redacts a presigned-URL signature and userinfo", () => {
    const signed = redactUrlForDiagnosis(
      "https://s3.example.com/bucket/model.safetensors?X-Amz-Signature=deadbeefcafe&X-Amz-Expires=60",
    );
    expect(signed).not.toContain("deadbeefcafe");
    expect(signed).toContain("X-Amz-Expires=60");

    expect(redactUrlForDiagnosis("http://bob:hunter2@comfy.example.com/prompt")).not.toContain(
      "hunter2",
    );
  });

  it("redacts a token that rides in the PATH, per segment", () => {
    const out = redactUrlForDiagnosis(
      "https://gw.example.com/t/AbCdEf0123456789AbCdEf0123456789/internal/logs",
    );
    expect(out).not.toContain("AbCdEf0123456789AbCdEf0123456789");
    expect(out).toContain("/internal/logs");
  });

  it("leaves an ordinary URL byte-identical", () => {
    // The body scrubber's opaque-run pass would collapse this whole URL to
    // "https:«redacted»" — a host+path IS a long run of the credential
    // alphabet. Structural redaction is what makes the diagnosis survivable.
    for (const clean of [
      "https://comfy.example.com/api/v1/internal/logs",
      "http://127.0.0.1:8188/internal/logs?clientId=comfyui-mcp",
      "http://remote.example:8188/system_stats",
    ]) {
      expect(redactUrlForDiagnosis(clean)).toBe(clean);
    }
  });

  it("withholds the query of an unparsable target rather than printing it", () => {
    expect(redactUrlForDiagnosis("/internal/logs?token=secretvalue")).not.toContain("secretvalue");
  });

  it("reaches the message built by the live guard", () => {
    // Wiring: the redaction must be applied where the diagnosis is BUILT, not
    // only when a caller remembers to ask for it.
    const d = classifyNonJson({
      url: "https://gw.example.com/internal/logs?access_token=sk-live-abcdef123456",
      status: 500,
      contentType: "text/plain",
      body: "boom",
    });
    expect(d.message).not.toContain("sk-live-abcdef123456");
    expect(d.url).not.toContain("sk-live-abcdef123456");
    expect(d.message).toContain("gw.example.com/internal/logs");
  });
});

describe("the status reason phrase is carried (codex gate, finding 1)", () => {
  it("keeps a CUSTOM phrase, which is often the most useful token present", () => {
    const d = classifyNonJson({
      url: "http://remote.example:8188/system_stats",
      status: 503,
      statusText: "Origin warming up",
      contentType: "text/html",
      body: "<html><body>please wait</body></html>",
    });
    expect(d.message).toContain("503 Origin warming up");
  });

  it("drops a STANDARD phrase, which only restates the code", () => {
    const d = classifyNonJson({
      url: "http://remote.example:8188/internal/logs",
      status: 404,
      statusText: "Not Found",
      contentType: "",
      body: "",
    });
    expect(d.message).toContain("answered 404 with");
    expect(d.message).not.toContain("404 Not Found");
  });

  it("scrubs a credential a hostile proxy put in the reason phrase", () => {
    const d = classifyNonJson({
      url: "http://remote.example:8188/prompt",
      status: 400,
      statusText: "rejected token=sk-live-abcdef123456",
      contentType: "",
      body: "x",
    });
    expect(d.message).not.toContain("sk-live-abcdef123456");
  });
});
