// #884 — the shared session scope: session identity (which conversation) is
// orchestrator-owned and backend-composed; the panel tab id is only a routing
// target. These pin the pure decisions the orchestrator wires inline.

import { describe, expect, it } from "vitest";
import {
  SHARED_SESSION_SCOPE,
  sharedAgentKey,
  isSharedScopeId,
  isScopeAddress,
  conversationTabs,
  shouldRetireSharedAgent,
  messageOrigin,
  workflowOriginNote,
  shortTabId,
} from "../../services/session-scope.js";

describe("shared session scope (#884)", () => {
  it("composes the agent key from the scope + backend — never a tab/workflow id", () => {
    expect(sharedAgentKey("claude")).toBe("orchestrator::claude");
    expect(sharedAgentKey("codex")).toBe("orchestrator::codex");
    // The scope contains no "::" so the composite splits cleanly on the LAST sep.
    expect(SHARED_SESSION_SCOPE.includes("::")).toBe(false);
  });

  it("isSharedScopeId matches ONLY the scope, never real tab ids", () => {
    expect(isSharedScopeId(SHARED_SESSION_SCOPE)).toBe(true);
    for (const id of ["wf:a.json", "tmp:1234", "orchestrator2", "", undefined, null]) {
      expect(isSharedScopeId(id)).toBe(false);
    }
  });

  it("isScopeAddress matches the bare scope AND backend-qualified agent keys, never tab ids", () => {
    expect(isScopeAddress(SHARED_SESSION_SCOPE)).toBe(true);
    expect(isScopeAddress(sharedAgentKey("claude"))).toBe(true);
    expect(isScopeAddress(sharedAgentKey("codex"))).toBe(true);
    for (const id of ["wf:a.json", "tmp:1234", "orchestrator2", "orchestrator2::claude", "", undefined, null]) {
      expect(isScopeAddress(id)).toBe(false);
    }
  });

  describe("conversationTabs/Targets — output fanout", () => {
    const backendForTab = (t: string): string => (t === "b-codex" ? "codex" : "claude");

    it("fans out to EVERY connected tab on the agent's backend (tabs share one conversation)", () => {
      expect(
        conversationTabs({ connected: ["a", "b-codex", "c"], backendForTab, backend: "claude" }),
      ).toEqual(["a", "c"]);
      expect(
        conversationTabs({ connected: ["a", "b-codex", "c"], backendForTab, backend: "codex" }),
      ).toEqual(["b-codex"]);
    });

    it("returns EMPTY (never another backend's tab) when no participating tab is connected — the orchestrator parks the frame per backend", () => {
      expect(conversationTabs({ connected: [], backendForTab, backend: "claude" })).toEqual([]);
      // A connected codex tab must NEVER receive the claude conversation's frames.
      expect(
        conversationTabs({ connected: ["b-codex"], backendForTab, backend: "claude" }),
      ).toEqual([]);
    });
  });

  describe("shouldRetireSharedAgent — one tab's provider switch must not stop others' agent", () => {
    const backendForTab = (t: string): string => (t.startsWith("c-") ? "claude" : "codex");

    it("retires when NO other connected tab still uses the outgoing backend", () => {
      expect(
        shouldRetireSharedAgent({
          switchingTab: "c-1",
          prevBackend: "claude",
          connected: ["c-1", "x-2"],
          backendForTab,
        }),
      ).toBe(true);
    });

    it("keeps the agent while ANOTHER connected tab still runs on it", () => {
      expect(
        shouldRetireSharedAgent({
          switchingTab: "c-1",
          prevBackend: "claude",
          connected: ["c-1", "c-2"],
          backendForTab,
        }),
      ).toBe(false);
    });
  });

  describe("workflowOriginNote — the agent's knowledge of which canvas it operates on", () => {
    it("silent on the first message and while the origin is unchanged", () => {
      const origin = messageOrigin("wf:a.json", "u-1");
      expect(workflowOriginNote({ prevOrigin: undefined, origin, tabId: "wf:a.json" })).toBeNull();
      expect(workflowOriginNote({ prevOrigin: origin, origin, tabId: "wf:a.json" })).toBeNull();
    });

    it("notes a move to a different workflow/tab, naming it, without ending the conversation", () => {
      const note = workflowOriginNote({
        prevOrigin: messageOrigin("wf:a.json", "u-1"),
        origin: messageOrigin("wf:b.json", "u-2"),
        tabId: "wf:b.json",
        title: "My Workflow B",
      });
      expect(note).toContain("My Workflow B");
      expect(note).toContain("wf:b.json");
      expect(note).toContain("conversation itself continues");
    });

    it("an in-place workflow change (same tab id, new uuid) still notes the move", () => {
      const note = workflowOriginNote({
        prevOrigin: messageOrigin("wf:a.json", "u-1"),
        origin: messageOrigin("wf:a.json", "u-2"),
        tabId: "wf:a.json",
      });
      expect(note).not.toBeNull();
    });
  });
});

// #934 — two DIFFERENT tabs rendered identically, in the middle of a wedge whose
// entire question was whether anything had changed.
//
// Tab ids come in two shapes. A browser tab is a uuid, where slice(0, 8) is a
// fine abbreviation. A workflow-keyed tab is `wf:workflows/<name>.json`, and
// there slice(0, 8) yields the literal "wf:workf" for EVERY workflow — so
// panel_set_workflow_target reported "Rebound this session from tab wf:workf
// onto the active tab wf:workf" for a rebind between two different workflows,
// which reads as a no-op and told the reporter nothing.
describe("shortTabId (#934)", () => {
  const UUID = "3f7a1c2e-9b4d-4e5f-8a01-7c6d5e4f3a2b";

  it("keeps the uuid behaviour — 8 hex chars separate any two live tabs", () => {
    expect(shortTabId(UUID)).toBe("3f7a1c2e");
  });

  // THE bug: the old rendering collapsed the entire workflows/ namespace.
  it("distinguishes two workflow tabs that used to render identically", () => {
    const a = "wf:workflows/Untitled 2026-08-06 03-58-41.json";
    const b = "wf:workflows/portrait-v3.json";
    expect(a.slice(0, 8)).toBe(b.slice(0, 8)); // the defect, stated
    expect(shortTabId(a)).not.toBe(shortTabId(b));
    expect(shortTabId(b)).toBe("wf:portrait-v3.json");
  });

  it("keeps the part that varies — the filename, not the shared directory", () => {
    expect(shortTabId("wf:workflows/deep/nested/clip.json")).toBe("wf:clip.json");
    // Windows separators too: a tab id can carry either. (The backslashes are
    // escaped — "\d" and "\c" are not escape sequences, so an unescaped fixture
    // silently becomes "workflowsdeepclip.json" and tests nothing.)
    expect(shortTabId("wf:workflows\\deep\\clip.json")).toBe("wf:clip.json");
  });

  it("stays bounded for an absurdly long name, keeping the END", () => {
    const long = `wf:workflows/${"x".repeat(120)}-final.json`;
    const out = shortTabId(long);
    expect(out.length).toBeLessThanOrEqual(44);
    // The tail is what disambiguates a set of same-prefixed names.
    expect(out.endsWith("-final.json")).toBe(true);
    expect(out).toContain("…");
  });

  it("does not throw on the empty / missing cases", () => {
    // A missing id renders as empty rather than the string "undefined" — this
    // goes into agent-facing prose, where the word "undefined" reads as a value.
    expect(shortTabId("")).toBe("");
    expect(shortTabId(undefined)).toBe("");
    expect(shortTabId(null)).toBe("");
    expect(shortTabId("wf:")).toBe("wf:");
  });
});
