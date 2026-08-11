// #1398 — a code-mode agent was told, by the INJECTED steering, to look for tools it
// could never see under that name. It scanned its direct declarations, found no bare
// `panel_` name, concluded the live-canvas tools were missing, and started
// investigating a rollback of the product — while the panel MCP endpoint was
// answering tools/list with 91 tools and HTTP 200.
//
// #1353 fixed the message you get when you CALL a missing tool (v0.50.104). The
// reporter had that fix; it is a different surface from the one they followed.
//
// These assert on the RENDERED strings, not on the source. A template literal whose
// `${…}` silently failed to interpolate would type-check, build, and ship the
// placeholder text to the agent — the exact failure this guidance exists to prevent,
// and one no source-grep test can see.

import { describe, expect, it } from "vitest";
import {
  DEFERRED_PANEL_QUALIFIED_NAME,
  DEFERRED_PANEL_TOOLS_NOTE,
  DEFERRED_PANEL_TOOLS_STEERING,
} from "../../deferred-panel-tools.js";
import { PANEL_SYSTEM_APPEND } from "../../orchestrator/index.js";

describe("#1398 the injected steering says where the tools actually are", () => {
  it("names the prefixed spelling a deferred catalog holds", () => {
    // Not "check your deferred tools" — the reporter's agent DID inspect its tools.
    // What it needed was the spelling.
    expect(PANEL_SYSTEM_APPEND).toContain("mcp__panel__panel_graph_outline");
  });

  it("names the catalog to search", () => {
    expect(PANEL_SYSTEM_APPEND).toContain("ALL_TOOLS");
  });

  it("requires BOTH surfaces to be empty before absence may be concluded", () => {
    expect(PANEL_SYSTEM_APPEND).toMatch(/BOTH your direct declarations and your\s+deferred catalog/);
  });

  it("tells the agent not to treat apparent absence as a product fault", () => {
    // The reported harm was not the wrong belief — it was what the agent did next.
    expect(PANEL_SYSTEM_APPEND.toLowerCase()).toContain("roll back");
  });

  it("INTERPOLATED — no un-rendered placeholder reaches the agent", () => {
    // The assertion that catches the silent failure: `${DEFERRED_PANEL_TOOLS_STEERING}`
    // inside a non-template string compiles and ships the literal text.
    expect(PANEL_SYSTEM_APPEND).not.toContain("${");
    expect(PANEL_SYSTEM_APPEND).toContain(DEFERRED_PANEL_TOOLS_STEERING);
  });
});

describe("#1398 both surfaces share one source of truth", () => {
  it("the steering is built from the same note the unknown-tool message uses", () => {
    // Two surfaces phrasing this in their own words is how one ends up a version
    // behind the other — which is exactly what #1398 reported after #1353.
    expect(DEFERRED_PANEL_TOOLS_STEERING).toContain(DEFERRED_PANEL_TOOLS_NOTE);
  });

  it("the qualified name is assembled from the prefix, not written out twice", () => {
    expect(DEFERRED_PANEL_QUALIFIED_NAME).toBe("mcp__panel__panel_graph_outline");
    expect(DEFERRED_PANEL_TOOLS_NOTE).toContain(DEFERRED_PANEL_QUALIFIED_NAME);
  });

  it("the note distinguishes the two spellings rather than mentioning one", () => {
    // "look for mcp__panel__panel_graph_outline" alone leaves a reader unsure whether
    // the bare name was wrong or merely absent.
    expect(DEFERRED_PANEL_TOOLS_NOTE).toContain("not `panel_graph_outline`");
  });
});
