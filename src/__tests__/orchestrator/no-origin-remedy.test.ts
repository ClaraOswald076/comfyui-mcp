// comfyui-mcp-panel#1065 — A STALE REMEDY MANUFACTURED ITS OWN BUG REPORT.
//
// Two surfaces render the "this connection has no server-observed Origin" refusal:
// fence-refusal.ts's identityReason(), and the `rejected` branch of
// describeFenceRebind() in panel-tools.ts. #1077/#1240 gave the relay path the
// origin it already knows from COMFYUI_URL and updated the FIRST one. The second
// kept the pre-fix text, which told the user two wrong things:
//
//   * abandon the relay backend (unset COMFYUI_MCP_TUNNEL_BACKEND=relay), and
//   * "report it: the relay protocol has to forward the browser's handshake Origin
//     for this path to work at all".
//
// A user on 0.50.114 — a version that HAS the fix — did both, and panel#1065 quotes
// that sentence back verbatim. They were told to downgrade a working setup on the
// way, and the real remedy (set COMFYUI_URL) was never mentioned to them.
//
// So this file pins the property that failed, not just the wording: the two
// surfaces say the SAME thing, because they are the same string.

import { describe, expect, it } from "vitest";
import { NO_ORIGIN_REMEDY, identityReason } from "../../orchestrator/fence-refusal.js";

// (tabId, origin, workflowUuid, failure) — an ABSENT origin is the case here.
const NO_ORIGIN = identityReason("tab-1", undefined, "not-a-uuid", "none" as never);

describe("panel#1065 the no-origin remedy is the one that works", () => {
  it("names the thing that actually supplies the origin", () => {
    expect(NO_ORIGIN_REMEDY).toContain("Set COMFYUI_URL to the URL the panel is served from");
  });

  it("does NOT tell the user to abandon the relay backend", () => {
    // #1240 gave the relay path its origin. Sending a user off it is advice that
    // costs them a working remote setup and fixes nothing.
    expect(NO_ORIGIN_REMEDY).not.toMatch(/unset COMFYUI_MCP_TUNNEL_BACKEND/i);
    expect(NO_ORIGIN_REMEDY).not.toMatch(/rather than the relay backend/i);
    expect(NO_ORIGIN_REMEDY).toContain("switching away from the relay backend is");
  });

  it("does NOT ask for a report about a protocol gap that is closed", () => {
    // This is the sentence panel#1065 quotes. It must not be able to generate
    // another one.
    expect(NO_ORIGIN_REMEDY).not.toMatch(/forward the browser'?s handshake Origin/i);
    expect(NO_ORIGIN_REMEDY).not.toMatch(/report it/i);
  });

  it("still says what keeps working, so the session is not read as dead", () => {
    expect(NO_ORIGIN_REMEDY).toContain("Reads and non-graph tools keep working");
  });
});

describe("panel#1065 the refusal that shows it", () => {
  it("carries the shared remedy rather than a copy", () => {
    expect(NO_ORIGIN).toContain("no server-observed Origin");
    expect(NO_ORIGIN).toContain(NO_ORIGIN_REMEDY);
  });

  it("does not repeat the stale advice anywhere in the refusal", () => {
    expect(NO_ORIGIN).not.toMatch(/forward the browser'?s handshake Origin/i);
    expect(NO_ORIGIN).not.toMatch(/unset COMFYUI_MCP_TUNNEL_BACKEND/i);
  });
});
