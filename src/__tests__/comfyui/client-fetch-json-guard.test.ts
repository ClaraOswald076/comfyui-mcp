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

import { getLogs, resetClient, uploadImageHttp } from "../../comfyui/client.js";
import {
  classifyNonJson,
  guardClientFetch,
  isNonJsonResponseError,
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
});
