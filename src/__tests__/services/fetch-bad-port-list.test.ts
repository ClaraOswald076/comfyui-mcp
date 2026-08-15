// #1415 review r2, finding 1 — keep FETCH_BLOCKED_PORTS honest against the
// runtime that actually enforces it.
//
// The reporter's `COMFYUI_URL=http://127.0.0.1:9` is refused by `fetch` before a
// socket is opened, with a cause of `Error("bad port")` and NO error code. The
// panel fallback therefore cannot classify that failure from the error at all —
// it classifies from the ADDRESS, using the list this file guards.
//
// A hardcoded list of 82 numbers is exactly the kind of constant that rots
// silently: if node's list gains or loses a port, nothing in the product would
// notice, and the failure mode is the one this whole review round exists to
// undo — the feature quietly not running for somebody's configuration. So the
// list is not trusted, it is MEASURED, every run, against the real `fetch`.
//
// Nothing here touches the network: a blocked port is rejected during the URL
// check, and the control ports use a closed local address that refuses
// immediately.

import { describe, expect, it } from "vitest";
import { FETCH_BLOCKED_PORTS, isUndialableTarget } from "../../services/panel-fallback-target.js";

/** The reason string node attaches, or "" when the call somehow succeeded. */
async function refusalReason(url: string): Promise<string> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(3000) });
    return "";
  } catch (err) {
    let cur: unknown = err;
    let last: unknown = err;
    const seen = new Set<unknown>();
    while (cur instanceof Error && !seen.has(cur)) {
      seen.add(cur);
      last = cur;
      cur = (cur as { cause?: unknown }).cause;
    }
    return last instanceof Error ? last.message : String(last);
  }
}

describe("FETCH_BLOCKED_PORTS matches this runtime", () => {
  it("every port in the list is really refused as a bad port", async () => {
    const notRefused: number[] = [];
    for (const port of FETCH_BLOCKED_PORTS) {
      if ((await refusalReason(`http://127.0.0.1:${port}/x`)) !== "bad port") notRefused.push(port);
    }
    // A port listed here but NOT refused means the address-based route would
    // allow a fallback on a target fetch was willing to dial — the over-broad
    // direction, and the one that could answer from the wrong server.
    expect(notRefused, "listed as blocked but this runtime dials them").toEqual([]);
  }, 60_000);

  it("ordinary ComfyUI-ish ports are NOT refused, so the list is not over-broad", async () => {
    const wronglyRefused: number[] = [];
    for (const port of [80, 443, 3000, 5000, 7860, 8000, 8080, 8188, 8189, 8199, 9000, 11434]) {
      if ((await refusalReason(`http://127.0.0.1:${port}/x`)) === "bad port") {
        wronglyRefused.push(port);
      }
    }
    expect(wronglyRefused, "a real ComfyUI port must never read as undialable").toEqual([]);
  }, 30_000);

  it("the reporter's port 9 is in the list", () => {
    // The whole reason this file exists. Pinned by itself so a list edit that
    // drops it fails with the right name on it.
    expect(FETCH_BLOCKED_PORTS.has(9)).toBe(true);
    expect(isUndialableTarget("http://127.0.0.1:9/api/workflow_templates")).toBe(true);
  });

  it("classifies dialable targets, default ports and junk correctly", () => {
    expect(isUndialableTarget("http://127.0.0.1:8188/api/workflow_templates")).toBe(false);
    // Default ports (80/443) are not blocked and `URL.port` is "" for them.
    expect(isUndialableTarget("http://comfy.test/api")).toBe(false);
    expect(isUndialableTarget("https://comfy.test/api")).toBe(false);
    // A scheme fetch will not dial.
    expect(isUndialableTarget("ftp://127.0.0.1/api")).toBe(true);
    // Unparseable is NOT a finding about a server.
    expect(isUndialableTarget("::::")).toBe(false);
    expect(isUndialableTarget("")).toBe(false);
  });
});
