// #908 — "not permitted" was a dead end.
//
// PR #278 correctly removed pod create/start (now `runpod` actions) from the direct
// call_tool whitelist: both put a pod into a BILLING state, and a
// confirmation-less mirrored tab must not be able to spend money. The exclusion
// is right and stays. What was wrong is that the panel's RunPod Deploy/Start
// buttons then returned the bare refusal verbatim for ~2 weeks, which reads as
// "the panel is broken" rather than "this channel deliberately does not carry
// this tool, ask the agent".
//
// A tool that EXISTS but is withheld from one channel, and a tool that does not
// exist at all, are different facts and must not produce the same sentence.

import { describe, expect, it } from "vitest";
import {
  callToolAdmission,
  CALL_TOOL_ACTION_WHITELIST,
  CALL_TOOL_WHITELIST,
} from "../../orchestrator/call-tool-admission.js";
import { TOOL_NAMES } from "../../tools/vocabulary.js";

/** The refusal string, or undefined when admitted. */
const refuse = (tool: string, args: Record<string, unknown> = {}) =>
  callToolAdmission(tool, args as never);

describe("admission: excluded is not the same as unknown (#908)", () => {
  // #278 withheld pod create/start because both START BILLING and this channel
  // cannot confirm with the user. 0.50.0 folded those names into
  // runpod(action:"create"|"start"), so the protection now lives at ACTION level —
  // and it survived the fold intact. If this ever flips, someone re-admitted a
  // money-spending action on a confirmation-less channel.
  it("the billing-sensitive RunPod ACTIONS are still excluded after the 0.50.0 fold", () => {
    const actions = CALL_TOOL_ACTION_WHITELIST.get("runpod");
    expect(actions, "runpod must be action-scoped, or create/start ride in free").toBeDefined();
    expect(actions!.has("create")).toBe(false);
    expect(actions!.has("start")).toBe(false);
    // ...while the read-only / non-billing ones stay usable.
    expect(actions!.has("status")).toBe(true);
    expect(actions!.has("stop")).toBe(true);
  });

  it("an EXISTING but excluded tool is told it exists, and where to go instead", () => {
    const msg = refuse("generate_image");
    expect(msg).toBeTruthy();
    expect(String(msg)).toMatch(/exists but is not available/i);
    expect(String(msg)).toMatch(/deliberate exclusion, not a missing tool/i);
    // The remedy has to be named, or it is still a dead end.
    expect(String(msg)).toMatch(/ask the agent/i);
  });

  it("an UNKNOWN tool does NOT claim to exist", () => {
    const msg = String(refuse("definitely_not_a_real_tool_xyz"));
    expect(msg).toMatch(/not permitted/);
    expect(msg).not.toMatch(/exists but is not available/i);
  });

  // The distinction is only meaningful if it tracks the real tool list rather
  // than a hardcoded pair — otherwise the next excluded tool regresses silently.
  it("the distinction is driven by the actual tool surface, not a hardcoded name", () => {
    const excluded = (TOOL_NAMES as readonly string[]).filter((t) => !CALL_TOOL_WHITELIST.has(t));
    expect(excluded.length).toBeGreaterThan(0);
    for (const t of excluded.slice(0, 5)) {
      expect(String(refuse(t)), `${t} should be reported as existing-but-excluded`).toMatch(
        /exists but is not available/i,
      );
    }
  });

  it("admitted tools are still admitted — the message change refuses nothing new", () => {
    const admitted = [...CALL_TOOL_WHITELIST].filter((t) => (TOOL_NAMES as readonly string[]).includes(t));
    expect(admitted.length).toBeGreaterThan(0);
    // Admission may still refuse on ACTION grounds; what must not happen is the
    // whitelist itself rejecting a tool it contains.
    for (const t of admitted.slice(0, 5)) {
      expect(String(refuse(t, { action: "status" }) ?? "")).not.toMatch(/is not permitted$/);
    }
  });
});
