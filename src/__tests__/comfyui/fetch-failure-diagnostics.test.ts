// #954 / #952 — `fetch failed` is not a diagnostic.
//
// undici gives every network-layer failure the same four characters. Not the
// host, not the port, not whether it was DNS, a refused connection, a timeout,
// or a certificate. The real reason sits one level down on `.cause`, and
// `errorToToolResult` kept only `err.message`.
//
// #954 saw it from list_workflow_templates and could not tell which target was
// tried. #952 saw it from the readonly tools while the panel bridge was working
// fine — and read it, reasonably, as "these tools are broken". They weren't: the
// panel talks to whichever ComfyUI its browser tab is on, while these calls go to
// the configured COMFYUI_URL, and those two addresses are allowed to differ. That
// distinction is invisible unless the failure names the address it used.
//
// Same defect had already been fixed once for HuggingFace downloads (#411) in a
// private helper. It is now shared, which is why this file also pins that the
// original message survives at the FRONT of the expansion: transient-error
// matchers elsewhere test for /fetch failed/.

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../config.js", () => ({
  getComfyUIAuthHeaders: () => ({}),
}));

const { comfyuiFetch } = await import("../../comfyui/fetch.js");
const { describeFetchFailure, isBareFetchFailure, errorToToolResult, ComfyUIError } =
  await import("../../utils/errors.js");

/** The exact shape undici throws: an opaque top-level, detail on `.cause`. */
function undiciFailure(code: string, detail: string): Error {
  const cause = new Error(detail);
  (cause as { code?: string }).code = code;
  return new TypeError("fetch failed", { cause });
}

afterEach(() => vi.restoreAllMocks());

describe("describeFetchFailure", () => {
  it("unwraps the cause chain and surfaces the syscall code", () => {
    const { message, code } = describeFetchFailure(
      undiciFailure("ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:8188"),
    );
    expect(code).toBe("ECONNREFUSED");
    expect(message).toContain("connect ECONNREFUSED 127.0.0.1:8188");
  });

  // Load-bearing: process-control classifies transient network errors with a
  // /fetch failed/ regex. Expanding the message must not break that.
  it("keeps the ORIGINAL message at the front", () => {
    const { message } = describeFetchFailure(undiciFailure("ENOTFOUND", "getaddrinfo ENOTFOUND gpu.local"));
    expect(message.startsWith("fetch failed")).toBe(true);
    expect(message).toMatch(/fetch failed/);
  });

  it("survives a self-referential cause chain", () => {
    const err = new Error("boom") as Error & { cause?: unknown };
    err.cause = err;
    expect(describeFetchFailure(err).message).toBe("boom");
  });

  it("handles a non-Error throw", () => {
    expect(describeFetchFailure("just a string").message).toBe("just a string");
  });

  it("recognises only the bare opaque failure", () => {
    expect(isBareFetchFailure(new TypeError("fetch failed"))).toBe(true);
    expect(isBareFetchFailure(new Error("  fetch failed  "))).toBe(true);
    // Anything that already says something is left alone.
    expect(isBareFetchFailure(new Error("fetch failed to parse the manifest"))).toBe(false);
    expect(isBareFetchFailure(new Error("The operation was aborted"))).toBe(false);
    expect(isBareFetchFailure("fetch failed")).toBe(false);
  });
});

describe("errorToToolResult", () => {
  it("expands a bare fetch failure instead of printing four useless words", () => {
    const res = errorToToolResult(undiciFailure("ECONNREFUSED", "connect ECONNREFUSED 10.0.0.4:8188"));
    const text = String(res.content[0].text);
    expect(res.isError).toBe(true);
    expect(text).not.toBe("fetch failed");
    expect(text).toContain("ECONNREFUSED");
    expect(text).toContain("10.0.0.4:8188");
  });

  it("leaves an error that already explains itself untouched", () => {
    expect(String(errorToToolResult(new Error("Workflow node 7 is missing")).content[0].text)).toBe(
      "Workflow node 7 is missing",
    );
  });

  it("still routes a ComfyUIError through its own envelope", () => {
    const res = errorToToolResult(new ComfyUIError("nope", "SOME_CODE"));
    expect(String(res.content[0].text)).toContain("SOME_CODE");
  });
});

describe("comfyuiFetch names the target it could not reach", () => {
  it("reports the URL, the cause, and that a live panel proves nothing about it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(undiciFailure("ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:8188")),
    );
    await expect(comfyuiFetch("http://127.0.0.1:8188/api/workflow_templates")).rejects.toThrow(
      /http:\/\/127\.0\.0\.1:8188\/api\/workflow_templates/,
    );
    // The #952 misreading, addressed directly.
    await expect(comfyuiFetch("http://127.0.0.1:8188/api/x")).rejects.toThrow(
      /CONNECTED sidebar panel does not imply/,
    );
    // Remedies must be NAMED, or the reader is still guessing. (The vocabulary
    // gate keeps these two names live — it caught an earlier draft pointing at
    // get_environment, retired in 0.50.0.)
    await expect(comfyuiFetch("http://127.0.0.1:8188/api/x")).rejects.toThrow(
      /install_comfyui \(action:"environment"\)/,
    );
    await expect(comfyuiFetch("http://127.0.0.1:8188/api/x")).rejects.toThrow(/get_system_stats/);
  });

  it("preserves the original error as `cause` and the syscall code", async () => {
    const original = undiciFailure("ENOTFOUND", "getaddrinfo ENOTFOUND gpu.local");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(original));
    const err = await comfyuiFetch("http://gpu.local:8188/x").catch((e) => e);
    expect((err as { cause?: unknown }).cause).toBe(original);
    expect((err as { code?: string }).code).toBe("ENOTFOUND");
  });

  // Rewriting an error that ALREADY carries information would be a downgrade —
  // the same class of mistake in the other direction.
  it("does NOT rewrite an error that already says what happened", async () => {
    const abort = new Error("The operation was aborted due to timeout");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(abort));
    await expect(comfyuiFetch("http://127.0.0.1:8188/x")).rejects.toBe(abort);
  });

  it("passes a successful response straight through", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("[]", { status: 200 })));
    const res = await comfyuiFetch("http://127.0.0.1:8188/x");
    expect(res.status).toBe(200);
  });

  // An HTTP error status is NOT a fetch failure — it must reach the caller as a
  // Response so the existing #828 HTML/proxy classification still runs.
  it("does not touch a non-OK response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html>", { status: 502 })));
    const res = await comfyuiFetch("http://127.0.0.1:8188/x");
    expect(res.status).toBe(502);
  });
});
