import { describe, expect, it } from "vitest";
import { callToolAdmission } from "../../orchestrator/call-tool-admission.js";

/**
 * The call_tool dispatcher authorizes by tool NAME and forwards arbitrary
 * action arguments, so whitelisting the consolidated `queue` name (0.49.0
 * slice 4) would have admitted every folded action — move/edit/cancel_queued
 * included — where the retired standalone cancel entry it replaced admitted
 * cancel semantics only. The action scope in call-tool-admission.ts closes
 * that: `queue` is admitted for exactly the action the old entry covered
 * (#699 re-gate).
 */
describe("call_tool admission", () => {
  it('admits queue for action:"cancel" — exactly what the retired standalone cancel entry covered', () => {
    expect(callToolAdmission("queue", { action: "cancel" })).toBeNull();
    // …with the arguments the old entry forwarded, clear_pending included (its
    // wipe-all-pending effect was already reachable before consolidation).
    expect(
      callToolAdmission("queue", { action: "cancel", prompt_id: "p1", clear_pending: true }),
    ).toBeNull();
  });

  it("refuses the queue actions the old whitelist entry never covered", () => {
    for (const action of ["move", "edit", "cancel_queued", "clear"]) {
      expect(callToolAdmission("queue", { action }), `action:"${action}"`).toBe(
        `tool "queue" is not permitted for action "${action}"`,
      );
    }
  });

  it("also refuses the read-only queue actions — never whitelisted before either", () => {
    for (const action of ["list", "status", "get_workflow"]) {
      expect(callToolAdmission("queue", { action }), `action:"${action}"`).toBe(
        `tool "queue" is not permitted for action "${action}"`,
      );
    }
  });

  it("refuses queue with a missing or non-string action", () => {
    expect(callToolAdmission("queue", {})).toBe(
      'tool "queue" is not permitted for action "(missing)"',
    );
    expect(callToolAdmission("queue", { action: 42 })).toBe(
      'tool "queue" is not permitted for action "(missing)"',
    );
  });

  it("name-level behavior is unchanged for everything else", () => {
    // A whitelisted tool with no action scope is admitted regardless of args…
    expect(callToolAdmission("list_workflows", {})).toBeNull();
    // …including a consolidated tool whose whole-tool posture was judged at
    // whitelist time (apps, 0.49.0 slice 2) — deliberately NOT rescoped here.
    expect(callToolAdmission("apps", { action: "run" })).toBeNull();
    // A non-whitelisted tool is refused with the byte-identical pre-change
    // string the dispatcher produced.
    expect(callToolAdmission("clear_vram", {})).toBe('tool "clear_vram" is not permitted');
    expect(callToolAdmission("restart_comfyui", {})).toBe(
      'tool "restart_comfyui" is not permitted',
    );
    expect(callToolAdmission("not_a_real_tool", {})).toBe(
      'tool "not_a_real_tool" is not permitted',
    );
  });
});
