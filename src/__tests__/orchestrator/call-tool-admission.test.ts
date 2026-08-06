import { describe, expect, it } from "vitest";
import { callToolAdmission } from "../../orchestrator/call-tool-admission.js";
import { DEAD_NAMES } from "../../tools/vocabulary.js";

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

  /**
   * The same trap, with a machine's disk and ~10 minutes attached (0.50.0 slice
   * 10). Eighteen train_* tools folded into three. Two of the three are safe to
   * admit at NAME level because every action they absorbed already had its own
   * whitelist entry — 8/8 for train_prepare_dataset, 7/7 for train_start.
   * train_doctor is 1/3: it also absorbed the two SETUP tools, and NEITHER was
   * ever whitelisted. Admitting them by name would turn a read-only preflight
   * entry into "a canvas-less client can kick off a ~10 minute git clone +
   * torch/pip install (locally or on a BILLED pod) or a multi-GB CUDA docker
   * build" — a fold turning a false refusal into a false acceptance (#839).
   */
  describe("training: the folded SETUP actions stay unreachable", () => {
    it('admits train_doctor for action:"doctor" — the read-only preflight the old entry covered', () => {
      expect(callToolAdmission("train_doctor", { action: "doctor" })).toBeNull();
    });

    it("refuses the two SETUP actions train_doctor absorbed — neither was ever whitelisted", () => {
      for (const action of ["bootstrap", "build_image"]) {
        expect(callToolAdmission("train_doctor", { action }), `action:"${action}"`).toBe(
          `tool "train_doctor" is not permitted for action "${action}"`,
        );
      }
      // Including the shapes a client would actually send, so the refusal cannot
      // be argued away as "only the bare action is blocked".
      expect(callToolAdmission("train_doctor", { action: "bootstrap", target: "pod", pod_id: "pod123" })).toBe(
        'tool "train_doctor" is not permitted for action "bootstrap"',
      );
      expect(callToolAdmission("train_doctor", { action: "build_image", aiToolkitRef: "deadbeef" })).toBe(
        'tool "train_doctor" is not permitted for action "build_image"',
      );
    });

    it("refuses train_doctor with a missing or non-string action", () => {
      expect(callToolAdmission("train_doctor", {})).toBe(
        'tool "train_doctor" is not permitted for action "(missing)"',
      );
      expect(callToolAdmission("train_doctor", { action: 42 })).toBe(
        'tool "train_doctor" is not permitted for action "(missing)"',
      );
    });

    it("admits every action train_prepare_dataset and train_start absorbed — each had its own entry", () => {
      // The other direction, and just as important: whole-tool admission must
      // not have DROPPED a capability the panel's Training tab still needs. All
      // fifteen of these had their own pre-fold entry. If a future action is
      // ADDED to either tool it does not inherit that judgement — rescope it,
      // the way train_doctor is rescoped above.
      for (const action of ["prepare", "list", "detail", "update", "delete", "file", "caption_image", "caption_dataset"]) {
        expect(callToolAdmission("train_prepare_dataset", { action }), `dataset action:"${action}"`).toBeNull();
      }
      for (const action of ["start", "status", "cancel", "delete", "list_flows", "job_config", "preview_config"]) {
        expect(callToolAdmission("train_start", { action }), `job action:"${action}"`).toBeNull();
      }
    });
  });

  /**
   * 0.50.0 slice 11 folded six inventory tools into `list_local_models`. The
   * retired entry was a READ-ONLY listing; the folded name also carries
   * action:"remove", which UNLINKS a model file with no undo. Admitting the name
   * unscoped would have handed a confirmation-less mobile/mirrored client a
   * delete button it never had — the #839 shape, a fold turning a refusal into
   * an acceptance.
   */
  it('admits list_local_models for action:"list" only — the delete is refused', () => {
    expect(callToolAdmission("list_local_models", { action: "list" })).toBeNull();
    expect(
      callToolAdmission("list_local_models", { action: "list", model_type: "checkpoints" }),
    ).toBeNull();
    for (const action of ["remove", "remove_path", "add_path", "embeddings", "list_paths"]) {
      expect(
        callToolAdmission("list_local_models", { action, path: "loras/x.safetensors" }),
        `action:"${action}"`,
      ).toBe(`tool "list_local_models" is not permitted for action "${action}"`);
    }
    // An omitted action cannot fall through to the delete either.
    expect(callToolAdmission("list_local_models", { path: "loras/x.safetensors" })).toBe(
      'tool "list_local_models" is not permitted for action "(missing)"',
    );
  });

  /**
   * Same for `download_model`, which folded eight tools. It admits exactly the
   * five actions whose retired single-purpose tools were whitelisted.
   */
  it("admits download_model for the five actions its retired entries covered", () => {
    for (const action of [
      "download",
      "download_civitai",
      "search_civitai",
      "search_creators",
      "resolve_missing",
    ]) {
      expect(callToolAdmission("download_model", { action }), `action:"${action}"`).toBeNull();
    }
  });

  it("refuses the download_model actions no retired entry covered", () => {
    // "cancel" is the one with teeth: a wrong id from a canvas-less client would
    // abort a transfer the user is watching.
    for (const action of ["search", "status", "cancel"]) {
      expect(callToolAdmission("download_model", { action }), `action:"${action}"`).toBe(
        `tool "download_model" is not permitted for action "${action}"`,
      );
    }
    expect(callToolAdmission("download_model", {})).toBe(
      'tool "download_model" is not permitted for action "(missing)"',
    );
  });

  // Read from the ledger rather than spelled: a consolidation that removes a
  // name from TOOL_NAMES but forgets to remove it from the whitelist would leave
  // a phantom entry admitting a tool that no longer exists, and every slice adds
  // more candidates. Slice-agnostic, so it keeps holding as 0.50.0 lands.
  it("no name the ledger declares dead is admitted by the whitelist", () => {
    for (const dead of DEAD_NAMES) {
      expect(callToolAdmission(dead.name, {}), dead.name).toBe(
        `tool "${dead.name}" is not permitted`,
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
