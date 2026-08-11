// A user-hidden channel for operational status, so the walls of text stop landing in
// somebody's image conversation.
//
// The panel auto-sync failure is the motivating one. It is true, it is necessary, and it
// is addressed to the wrong reader:
//
//   ⚠️ Could not automatically sync the ComfyUI-MCP panel; no update was claimed. Run
//   install_comfyui(action:'panel', panel_action:'status') … (Timed out after 60000ms
//   waiting for the panel operation lock. The lock at …\panel-op.lock was taken 73 hours
//   ago by pid 4544 … To recover a proven abandoned lock, run install_comfyui(…
//
// The agent has to know that. The person who asked for a clothes swap does not, and
// printing it mid-conversation reads like the assistant lost its place.
//
// WHY THIS IS CAPABILITY-GATED RATHER THAN A STRAIGHT SWITCH. An older panel silently
// DROPS a frame type it does not recognise. Sending `agent_note` unconditionally would
// therefore turn "too loud" into "gone" for everyone who has not updated — and a notice
// nobody sees is worse than an ugly one. That fallback is the property most worth pinning
// here, because it is the one a future refactor would quietly delete.

import { describe, expect, it } from "vitest";

import { UiBridge } from "../../services/ui-bridge.js";

type Frame = { type?: string; text?: string };

/** A bridge with one connection whose hello did or did not advertise the capability. */
function bridgeWithConn(accepts: boolean): { bridge: UiBridge; sent: Frame[] } {
  const bridge = new UiBridge(0);
  const sent: Frame[] = [];
  // Reach past the socket: `push` serialises to a live WebSocket, and this test is about
  // WHICH FRAME is chosen, not about transport.
  (bridge as unknown as { push: (f: Frame, tabId?: string) => number }).push = (f) => {
    sent.push(f);
    return 1;
  };
  (bridge as unknown as { conns: Map<string, unknown> }).conns.set("tab-a", {
    acceptsAgentNotes: accepts,
  });
  return { bridge, sent };
}

const NOTE = "⚠️ Could not automatically sync the ComfyUI-MCP panel; no update was claimed.";

describe("operational status reaches the agent without reaching the user", () => {
  it("a CAPABLE panel gets the hidden frame", () => {
    const { bridge, sent } = bridgeWithConn(true);

    const used = bridge.pushAgentNote(NOTE, "tab-a");

    expect(used).toBe("agent_note");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.type).toBe("agent_note");
    // The text is carried verbatim — hiding it must not also trim it, since the agent
    // needs the lock path and the recovery command.
    expect(sent[0]?.text).toBe(NOTE);
  });

  it("an OLDER panel still gets a VISIBLE say — the notice is never lost", () => {
    // The direction that matters. An un-updated panel drops an unknown frame silently,
    // so falling back is what keeps this from being a regression dressed as a fix.
    const { bridge, sent } = bridgeWithConn(false);

    const used = bridge.pushAgentNote(NOTE, "tab-a");

    expect(used).toBe("say");
    expect(sent[0]?.type).toBe("say");
    expect(sent[0]?.text).toBe(NOTE);
  });

  it("an UNKNOWN tab falls back too, rather than assuming support", () => {
    // No connection to read the capability from. Fail toward the visible channel: a
    // notice shown unnecessarily is recoverable, one silently dropped is not.
    const { bridge, sent } = bridgeWithConn(true);

    const used = bridge.pushAgentNote(NOTE, "tab-does-not-exist");

    expect(used).toBe("say");
    expect(sent[0]?.type).toBe("say");
  });

  it("a MISSING capability field is treated as absent, not as truthy", () => {
    const bridge = new UiBridge(0);
    const sent: Frame[] = [];
    (bridge as unknown as { push: (f: Frame) => number }).push = (f) => {
      sent.push(f);
      return 1;
    };
    // A hello from a build predating the flag: the key simply is not there.
    (bridge as unknown as { conns: Map<string, unknown> }).conns.set("tab-a", {});

    expect(bridge.pushAgentNote(NOTE, "tab-a")).toBe("say");
  });
});

describe("WIRING: the panel-sync failure uses the hidden channel (#panel-noise)", () => {
  it("is sent with pushAgentNote, not a bare say", async () => {
    // Asserted on the source because reaching that emit needs a failed Manager sync
    // inside a hello handler. If someone reverts it to `bridge.push({type:"say"})` the
    // wall of text comes back and no unit test would otherwise notice.
    const { readFile } = await import("node:fs/promises");
    const src = await readFile(new URL("../../orchestrator/index.ts", import.meta.url), "utf-8");

    const at = src.indexOf("Could not automatically sync the ComfyUI-MCP panel");
    expect(at).toBeGreaterThan(-1);
    const before = src.slice(Math.max(0, at - 600), at);
    expect(before).toContain("bridge.pushAgentNote(");
    expect(before).not.toMatch(/bridge\.push\(\s*\{\s*type:\s*"say"/);
  });
});
