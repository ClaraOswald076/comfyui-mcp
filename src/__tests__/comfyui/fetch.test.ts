import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the config layer so we can drive getComfyUIAuthHeaders per test.
const authHeaders = vi.fn<() => Record<string, string>>();
vi.mock("../../config.js", () => ({
  getComfyUIAuthHeaders: () => authHeaders(),
}));

import { comfyuiFetch } from "../../comfyui/fetch.js";

describe("comfyuiFetch", () => {
  const fetchMock = vi.fn(async () => new Response("ok"));

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockClear();
    authHeaders.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Passthrough for everything the caller supplied — plus a timeout ceiling the
  // caller did not. A call with no signal previously had NO limit at all and
  // could hang forever against a host that accepts the connection and never
  // answers; `init.signal` still always wins (see fetch-failure-diagnostics).
  it("passes the caller's init through when no auth is configured", async () => {
    authHeaders.mockReturnValue({});
    await comfyuiFetch("http://comfy/prompt", { method: "POST" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://comfy/prompt");
    expect((init as RequestInit).method).toBe("POST");
    expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal);
  });

  it("injects the configured auth header", async () => {
    authHeaders.mockReturnValue({ Authorization: "Bearer abc" });
    await comfyuiFetch("http://comfy/system_stats");
    const [, init] = fetchMock.mock.calls[0];
    expect(new Headers((init as RequestInit).headers).get("Authorization")).toBe("Bearer abc");
  });

  it("preserves caller headers (e.g. Content-Type) alongside auth", async () => {
    authHeaders.mockReturnValue({ "X-API-Key": "k" });
    await comfyuiFetch("http://comfy/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    const [, init] = fetchMock.mock.calls[0];
    const headers = new Headers((init as RequestInit).headers);
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.get("X-API-Key")).toBe("k");
  });

  it("does not clobber an explicit auth header set by the caller", async () => {
    authHeaders.mockReturnValue({ Authorization: "Bearer fromconfig" });
    await comfyuiFetch("http://comfy/prompt", {
      headers: { Authorization: "Bearer explicit" },
    });
    const [, init] = fetchMock.mock.calls[0];
    expect(new Headers((init as RequestInit).headers).get("Authorization")).toBe("Bearer explicit");
  });
});
