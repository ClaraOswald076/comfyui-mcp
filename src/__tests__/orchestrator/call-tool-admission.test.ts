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

  /**
   * The same trap, with money attached (0.50.0 slice 8). Nine standalone
   * runpod_* entries folded into `runpod`, and the two the whitelist
   * deliberately never contained — the pod DEPLOY and the pod RESUME, the two
   * that put a pod into a billing state — are now merely actions on a name that
   * IS whitelisted. Without an action scope, swapping the names would hand a
   * confirmation-less mirrored/foreign tab the ability to spend money.
   */
  describe("runpod: the folded billing actions stay unreachable (#269/#278)", () => {
    it("admits exactly the six actions whose standalone names were whitelisted", () => {
      for (const action of ["status", "list", "stop", "connect", "use_local", "deploy_link"]) {
        expect(callToolAdmission("runpod", { action }), `action:"${action}"`).toBeNull();
      }
      // …with the arguments those entries forwarded.
      expect(callToolAdmission("runpod", { action: "stop", pod_id: "pod123" })).toBeNull();
    });

    it("refuses the two actions that BILL — deploying and resuming a pod", () => {
      for (const action of ["create", "start"]) {
        expect(callToolAdmission("runpod", { action }), `action:"${action}"`).toBe(
          `tool "runpod" is not permitted for action "${action}"`,
        );
      }
      // Including the create shape a client would actually send, so the refusal
      // cannot be argued away as "only the bare action is blocked".
      expect(
        callToolAdmission("runpod", { action: "create", gpu_type: "NVIDIA A40", connect: true }),
      ).toBe('tool "runpod" is not permitted for action "create"');
      expect(callToolAdmission("runpod", { action: "start", pod_id: "pod123", gpu_count: 8 })).toBe(
        'tool "runpod" is not permitted for action "start"',
      );
    });

    it("refuses runpod with a missing or non-string action", () => {
      expect(callToolAdmission("runpod", {})).toBe(
        'tool "runpod" is not permitted for action "(missing)"',
      );
      expect(callToolAdmission("runpod", { action: 42 })).toBe(
        'tool "runpod" is not permitted for action "(missing)"',
      );
    });

    it("runpod_watch stays name-admitted — none of its actions bills", () => {
      // watch/unwatch/troubleshoot each replaced a name that was already
      // whitelisted, so the folded tool covers the same ground it always did.
      for (const action of ["watch", "unwatch", "troubleshoot"]) {
        expect(callToolAdmission("runpod_watch", { action }), `action:"${action}"`).toBeNull();
      }
    });
  });

  /**
   * The same trap, one slice later and with money-free but machine-changing
   * stakes: 0.50.0 slice 9 folded the nine knowledge tools into `list_packs`,
   * replacing a whitelist entry that admitted the READ-ONLY dependency
   * extractor. The fold brings action:"install_deps" — ComfyUI-Manager installs,
   * i.e. downloading and running third-party code — under the same name, so the
   * bare name must NOT be admitted.
   */
  it('admits list_packs for action:"extract_deps" — exactly what the retired read-only entry covered', () => {
    expect(callToolAdmission("list_packs", { action: "extract_deps" })).toBeNull();
    expect(
      callToolAdmission("list_packs", { action: "extract_deps", workflow: { "1": {} } }),
    ).toBeNull();
  });

  it("REFUSES list_packs action:\"install_deps\" — a read entry must never become an install", () => {
    expect(callToolAdmission("list_packs", { action: "install_deps" })).toBe(
      'tool "list_packs" is not permitted for action "install_deps"',
    );
    // Not reachable by omitting or fuzzing the action, either.
    expect(callToolAdmission("list_packs", {})).toBe(
      'tool "list_packs" is not permitted for action "(missing)"',
    );
    expect(callToolAdmission("list_packs", { action: 42 })).toBe(
      'tool "list_packs" is not permitted for action "(missing)"',
    );
  });

  it("refuses every other list_packs action — none was whitelisted before either", () => {
    for (const action of [
      "list",
      "read_workflow",
      "list_templates",
      "check_runtime",
      "skill_list",
      "skill_read",
      "generate_skill",
    ]) {
      expect(callToolAdmission("list_packs", { action }), `action:"${action}"`).toBe(
        `tool "list_packs" is not permitted for action "${action}"`,
      );
    }
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
