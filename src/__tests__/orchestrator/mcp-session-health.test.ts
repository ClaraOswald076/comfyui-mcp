// #1524 — a session that comes up WITHOUT one of its MCP servers must say so.
//
// The reported failure: mid-session both MCP servers dropped, `comfyui` came back,
// and all 92 `panel_*` tools did not. The orchestrator stayed up and kept its
// ports, the panel looked healthy, and the agent spent the rest of a six-hour
// session unable to touch the user's canvas — with no error anywhere. The reporter
// established it by hand: they noticed a tool-list diff and then probed with
// `ToolSearch` twice.
//
// The harness had already told us. Every Claude session opens with a `system`/`init`
// message carrying `mcp_servers: {name, status}[]`; `route()` read the session id
// off it and discarded the rest. Verified against the installed agent SDK (0.3.197)
// with one server of each kind configured, the report covers BOTH transports the
// panel uses:
//
//   [{"name":"deadstdio","status":"failed"},{"name":"panel","status":"connected"}]
//
// — the in-process `createSdkMcpServer` panel server included. That is what makes
// this worth wiring: it fires on the reporter's symptom without needing to know the
// cause, which is still open.
//
// The direction that matters most here is the QUIET one. A false "your tools are
// gone" on a healthy session is worse than the silence it replaces, so every
// ambiguity resolves to saying nothing.

import { describe, expect, it } from "vitest";
import {
  degradedMcpNotice,
  degradedMcpServers,
} from "../../orchestrator/mcp-session-health.js";

const CONFIGURED = ["comfyui", "panel"];

describe("degradedMcpServers — what the session reports vs what it was given", () => {
  it("says nothing when every configured server connected", () => {
    expect(
      degradedMcpServers(CONFIGURED, [
        { name: "comfyui", status: "connected" },
        { name: "panel", status: "connected" },
      ]),
    ).toEqual([]);
  });

  it("names a server the session reports as failed", () => {
    // The reporter's shape: one half of the pair back, the other not.
    expect(
      degradedMcpServers(CONFIGURED, [
        { name: "comfyui", status: "connected" },
        { name: "panel", status: "failed" },
      ]),
    ).toEqual([{ name: "panel", status: "failed" }]);
  });

  it("names a server MISSING from a populated report", () => {
    // A connection that fails before the server is advertised is absent, not
    // failed. Both readings of the reporter's evidence land here: their
    // `ToolSearch` found the panel server genuinely gone from the session, not
    // merely un-indexed.
    expect(
      degradedMcpServers(CONFIGURED, [{ name: "comfyui", status: "connected" }]),
    ).toEqual([{ name: "panel", status: null }]);
  });

  it("says nothing when the report is absent or empty", () => {
    // A harness that does not populate the field tells us nothing about our
    // servers. Reading its silence as failure would fire on EVERY healthy
    // session — the one outcome worse than the bug being fixed.
    expect(degradedMcpServers(CONFIGURED, undefined)).toEqual([]);
    expect(degradedMcpServers(CONFIGURED, [])).toEqual([]);
  });

  it("treats an unrecognized status as connected", () => {
    // The status vocabulary belongs to the CLI and can grow. A new value must
    // not become an alarm here; only the ones that DO mean unusable are alarms.
    expect(
      degradedMcpServers(CONFIGURED, [
        { name: "comfyui", status: "connected" },
        { name: "panel", status: "some-future-status" },
      ]),
    ).toEqual([]);
  });

  it("catches the failure vocabulary the CLI actually uses", () => {
    for (const status of ["failed", "needs-auth", "error", "disabled", "FAILED"]) {
      expect(degradedMcpServers(["panel"], [{ name: "panel", status }])).toHaveLength(1);
    }
  });

  it("ignores servers we did not configure", () => {
    // `strictMcpConfig: true` means the set should be exactly ours, but a report
    // naming something else is not this message's business either way.
    expect(
      degradedMcpServers(["comfyui"], [
        { name: "comfyui", status: "connected" },
        { name: "somebody-elses", status: "failed" },
      ]),
    ).toEqual([]);
  });
});

describe("degradedMcpNotice — states the observation, and stops", () => {
  it("is empty when nothing is degraded", () => {
    expect(degradedMcpNotice([])).toBe("");
  });

  it("names each server and its reported state", () => {
    const note = degradedMcpNotice([
      { name: "panel", status: "failed" },
      { name: "comfyui", status: null },
    ]);
    expect(note).toContain("panel");
    expect(note).toContain("failed");
    expect(note).toContain("comfyui");
    expect(note).toContain("not reported");
  });

  it("says the loss lasts the session, without promising a restart fixes it", () => {
    // Same discipline as NO_PANEL_TOOLS_OVERRIDE: a cause that persists survives
    // a restart, so "reconnecting restores them" is a claim this cannot make.
    const note = degradedMcpNotice([{ name: "panel", status: "failed" }]);
    expect(note).toMatch(/rest of this session/);
    expect(note).toMatch(/whether it succeeds depends on why this one did not/);
    expect(note).not.toMatch(/will fix|will restore|restores them/);
  });

  it("does not diagnose a cause it does not know", () => {
    // WHY a server goes missing is still open on #1524, and the candidates need
    // different fixes. Guessing here would be the same defect this replaces,
    // wearing the fix's clothes.
    const note = degradedMcpNotice([{ name: "panel", status: "failed" }]);
    expect(note).not.toMatch(/because|caused by|due to/i);
  });
});
