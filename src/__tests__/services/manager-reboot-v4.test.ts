// Issue #2320: restart_comfyui returns false negatives when Manager v4.2.2 is running.
// These tests verify that the reboot probing correctly handles the response patterns
// from Manager v4.2.2 and similar versions that return 405 on POST or 200 HTML on GET.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock comfyuiFetch to return controlled responses
const mockFetch = vi.hoisted(() => vi.fn());

vi.mock("../../comfyui/fetch.js", () => ({
  comfyuiFetch: mockFetch,
}));

vi.mock("../../utils/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Import after all mocks are set up
import { __rebootViaManagerTestHooks } from "../../services/process-control.js";

describe("Manager v4.2.2 reboot endpoint probing (issue #2320)", () => {
  beforeEach(() => {
    mockFetch.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("accepts GET /v2/manager/reboot when POST fails with 405", async () => {
    // POST /v2/manager/reboot returns 405 (route exists, wrong verb)
    mockFetch.mockImplementation(async (url: string, opts?: { method?: string }) => {
      const method = opts?.method ?? "GET";
      if (url.endsWith("/v2/manager/reboot") && method === "POST") {
        return new Response("Method Not Allowed", { status: 405 });
      }
      if (url.endsWith("/v2/manager/reboot") && method === "GET") {
        return new Response("OK", { status: 200 });
      }
      // Should not reach here in this test
      return new Response("Not Found", { status: 404 });
    });

    const result = await __rebootViaManagerTestHooks.rebootViaManager("http://127.0.0.1:3000");

    expect(result.rebooting).toBe(true);
    expect(result.acked).toBe(true); // Direct 200 is acknowledged
    expect(result.endpoint).toBe("/v2/manager/reboot");
    expect(result.method).toBe("GET");
  });

  it("uses fallback when GET /manager/reboot returns 200 HTML (cannot confirm but polls to verify)", async () => {
    // Simulate Manager v4.2.2 behavior:
    // POST /v2/manager/reboot → 405
    // GET /v2/manager/reboot → 404 (legacy endpoint)
    // GET /manager/reboot → 200 with HTML (still reboots but looks like catchall)
    // POST /manager/reboot → 405
    mockFetch.mockImplementation(async (url: string, opts?: { method?: string }) => {
      const method = opts?.method ?? "GET";
      if (url.endsWith("/v2/manager/reboot")) {
        return new Response("Method Not Allowed", { status: 405 });
      }
      if (url.endsWith("/manager/reboot") && method === "GET") {
        // Return 200 HTML that looks like SPA catchall
        return new Response("<!DOCTYPE html><html><body>ComfyUI</body></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      }
      if (url.endsWith("/manager/reboot") && method === "POST") {
        return new Response("Method Not Allowed", { status: 405 });
      }
      return new Response("Not Found", { status: 404 });
    });

    const result = await __rebootViaManagerTestHooks.rebootViaManager("http://127.0.0.1:3000");

    // Should return rebooting:true with acked:false because the 200 looked like
    // catchall but we saved it as a fallback. The readiness poll will confirm.
    expect(result.rebooting).toBe(true);
    expect(result.acked).toBe(false);
    expect(result.endpoint).toBe("/manager/reboot");
    expect(result.method).toBe("GET");
    expect(result.note).toMatch(/readiness poll/i);
  });

  it("tries both POST and GET on v2 endpoint before legacy route", async () => {
    const calls: Array<{ path: string; method: string }> = [];
    mockFetch.mockImplementation(async (url: string, opts?: { method?: string }) => {
      const method = opts?.method ?? "GET";
      calls.push({ path: new URL(url).pathname, method });

      // All routes fail
      return new Response("Not Found", { status: 404 });
    });

    const result = await __rebootViaManagerTestHooks.rebootViaManager("http://127.0.0.1:3000");

    // Verify the order: POST /v2, GET /v2, GET /manager, POST /manager
    expect(calls).toContainEqual({ path: "/v2/manager/reboot", method: "POST" });
    expect(calls).toContainEqual({ path: "/v2/manager/reboot", method: "GET" });
    expect(calls).toContainEqual({ path: "/manager/reboot", method: "GET" });
    expect(calls).toContainEqual({ path: "/manager/reboot", method: "POST" });

    expect(result.rebooting).toBe(false);
    expect(result.reason).toBe("no-endpoint");
  });

  it("returns 403 immediately without trying further routes", async () => {
    mockFetch.mockImplementation(async (url: string, opts?: { method?: string }) => {
      const method = opts?.method ?? "GET";
      if (url.endsWith("/v2/manager/reboot") && method === "POST") {
        return new Response("Forbidden", { status: 403 });
      }
      return new Response("Should not reach here", { status: 999 });
    });

    const result = await __rebootViaManagerTestHooks.rebootViaManager("http://127.0.0.1:3000");

    expect(result.rebooting).toBe(false);
    expect(result.reason).toBe("manager-security");
    expect(result.note).toMatch(/403/);
    expect(mockFetch).toHaveBeenCalledTimes(1); // Only one call (POST /v2)
  });

  it("treats connection drop as successful reboot inference", async () => {
    mockFetch.mockImplementation(async (url: string, opts?: { method?: string }) => {
      const method = opts?.method ?? "GET";
      if (url.endsWith("/v2/manager/reboot") && method === "POST") {
        const err = new Error("socket hang up");
        throw err;
      }
      return new Response("Not Found", { status: 404 });
    });

    const result = await __rebootViaManagerTestHooks.rebootViaManager("http://127.0.0.1:3000");

    expect(result.rebooting).toBe(true);
    expect(result.acked).toBe(false); // Inferred, not acknowledged
    expect(result.note).toMatch(/dropped/i);
  });

  it("treats 502/503/504 as successful reboot inference (proxy signals)", async () => {
    mockFetch.mockImplementation(async (url: string, opts?: { method?: string }) => {
      const method = opts?.method ?? "GET";
      if (url.endsWith("/v2/manager/reboot") && method === "POST") {
        return new Response("Bad Gateway", { status: 502 });
      }
      return new Response("Not Found", { status: 404 });
    });

    const result = await __rebootViaManagerTestHooks.rebootViaManager("http://127.0.0.1:3000");

    expect(result.rebooting).toBe(true);
    expect(result.acked).toBe(false);
    expect(result.note).toMatch(/502/);
  });
});
