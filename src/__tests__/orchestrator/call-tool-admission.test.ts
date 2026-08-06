import { describe, expect, it } from "vitest";
import {
  CALL_TOOL_ACTION_WHITELIST,
  CALL_TOOL_WHITELIST,
  callToolAdmission,
} from "../../orchestrator/call-tool-admission.js";
import { DEAD_NAMES, TOOL_NAMES, retiredToolMessage } from "../../tools/vocabulary.js";

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

  /**
   * 0.50.0 slice 14 folded ELEVEN workflow-library names into two, and only SEVEN
   * of them were whitelisted — five reads under `get_workflow` and the save under
   * `save_workflow`. Without an action scope the swap would admit the other four
   * for free, including `lock`, which WRITES a second file into the user library
   * and SHA-256s every model the workflow references.
   */
  describe("get_workflow / save_workflow: the fold admits only what was admitted", () => {
    it("get_workflow admits exactly the five read actions whose names were whitelisted", () => {
      for (const action of ["get", "list", "analyze", "query", "from_image"]) {
        expect(callToolAdmission("get_workflow", { action }), `action:"${action}"`).toBeNull();
      }
      // …with the arguments those entries forwarded.
      expect(callToolAdmission("get_workflow", { action: "get", filename: "a.json" })).toBeNull();
      expect(
        callToolAdmission("get_workflow", { action: "query", graph: {}, types: ["KSampler"] }),
      ).toBeNull();
    });

    it("get_workflow refuses the three actions no standalone entry ever covered", () => {
      for (const action of ["strip", "slice", "prompt_director"]) {
        expect(callToolAdmission("get_workflow", { action }), `action:"${action}"`).toBe(
          `tool "get_workflow" is not permitted for action "${action}"`,
        );
      }
      // Including the shapes a client would actually send, so the refusal cannot be
      // argued away as "only the bare action is blocked".
      expect(
        callToolAdmission("get_workflow", { action: "strip", path: "C:/wf/expert.json" }),
      ).toBe('tool "get_workflow" is not permitted for action "strip"');
      expect(
        callToolAdmission("get_workflow", { action: "slice", graph: {}, groups: "TXT" }),
      ).toBe('tool "get_workflow" is not permitted for action "slice"');
    });

    it("save_workflow admits SAVE only — lock writes, and verify_lock was never admitted", () => {
      expect(
        callToolAdmission("save_workflow", { action: "save", filename: "a.json", workflow: {} }),
      ).toBeNull();
      for (const action of ["lock", "verify_lock"]) {
        expect(callToolAdmission("save_workflow", { action }), `action:"${action}"`).toBe(
          `tool "save_workflow" is not permitted for action "${action}"`,
        );
      }
      expect(callToolAdmission("save_workflow", { action: "lock", filename: "a.json" })).toBe(
        'tool "save_workflow" is not permitted for action "lock"',
      );
    });

    it("refuses either tool with a missing or non-string action", () => {
      for (const tool of ["get_workflow", "save_workflow"]) {
        expect(callToolAdmission(tool, {})).toBe(
          `tool "${tool}" is not permitted for action "(missing)"`,
        );
        expect(callToolAdmission(tool, { action: 42 })).toBe(
          `tool "${tool}" is not permitted for action "(missing)"`,
        );
      }
    });

    it("the retired standalone names are no longer admitted under their own names", () => {
      // They are not registered tools any more, so the channel must refuse them at
      // the NAME level rather than silently accepting a name nothing serves.
      //
      // The REFUSAL is the invariant; its wording is not. This assertion used to
      // spell `tool "x" is not permitted`, which was the honest answer only while
      // admission ran ahead of the retirement ledger — it told a caller its
      // PERMISSION was wrong when the truth was that the tool had been RENAMED,
      // sending them to check tokens and whitelists instead of to the new name.
      // Admission now consults the ledger first, so the correct expectation is
      // the redirect. What must never change is that the result is non-null.
      for (const name of ["list_workflows", "analyze_workflow", "query_workflow"]) {
        expect(callToolAdmission(name, {}), `${name} must not be admitted`).not.toBeNull();
        expect(callToolAdmission(name, {}), name).toBe(retiredToolMessage(name));
      }
    });
  });

  // Read from the ledger rather than spelled: a consolidation that removes a
  // name from TOOL_NAMES but forgets to remove it from the whitelist would leave
  // a phantom entry admitting a tool that no longer exists, and every slice adds
  // more candidates. Slice-agnostic, so it keeps holding as 0.50.0 lands.
  it("no name the ledger declares dead is admitted by the whitelist", () => {
    for (const dead of DEAD_NAMES) {
      // NEVER ADMITTED is the property under test — assert that first and on its
      // own, so this keeps failing loudly if a future change makes a dead name
      // return null, regardless of how refusals are worded.
      expect(callToolAdmission(dead.name, {}), `${dead.name} must not be admitted`).not.toBeNull();
      // And the refusal must be the ledger's redirect rather than a permission
      // error: for a name that no longer exists, "not permitted" is a wrong
      // answer, not merely a terse one.
      //
      // Anchored on a LITERAL as well as on the helper. Comparing only against
      // `retiredToolMessage(...)` would be tautological for the wording — the
      // implementation calls that same helper, so the assertion would hold no
      // matter what the helper returned. vocabulary.test.ts owns the exact
      // phrasing against a literal; here we independently require that the
      // answer identifies the tool by name and does NOT claim a permission
      // problem, which is the specific wrong answer this change removes.
      const refusal = callToolAdmission(dead.name, {});
      expect(refusal, dead.name).toBe(retiredToolMessage(dead.name));
      expect(refusal, dead.name).toContain(`Unknown tool '${dead.name}'`);
      expect(refusal, dead.name).not.toContain("is not permitted");
    }
  });

  /**
   * The same trap a third time, with THIRD-PARTY CODE EXECUTION attached
   * (0.50.0 slice 12). Nine standalone custom-node lifecycle names folded into
   * `install_custom_node`, and only TWO of them were ever whitelisted:
   * install_custom_node itself (the panel's "install missing node" button) and
   * the installed-pack list (the dependency side-panel's read-only ✓ column).
   *
   * The seven that were not include uninstall (REMOVES an installed pack) and
   * update/reinstall/fix/sync_deps (each re-runs a pack's install/dependency
   * step, i.e. runs third-party code on the user's machine). Without an action
   * scope, a pure surface change would have made all of them reachable from a
   * confirmation-less mirrored/foreign tab.
   */
  describe("install_custom_node: the folded pack-code actions stay unreachable", () => {
    it("admits exactly the two actions whose standalone names were whitelisted", () => {
      expect(callToolAdmission("install_custom_node", { action: "install" })).toBeNull();
      expect(callToolAdmission("install_custom_node", { action: "list" })).toBeNull();
      // …with the arguments those entries forwarded: the panel's install button
      // sends a registry id, and the ✓ column sends list's own `mode`.
      expect(
        callToolAdmission("install_custom_node", { action: "install", id: "comfyui-kjnodes" }),
      ).toBeNull();
      expect(
        callToolAdmission("install_custom_node", { action: "list", mode: "imported" }),
      ).toBeNull();
    });

    it("refuses uninstall — a pack removal that was never reachable this way", () => {
      expect(callToolAdmission("install_custom_node", { action: "uninstall" })).toBe(
        'tool "install_custom_node" is not permitted for action "uninstall"',
      );
      // Including the shape a client would actually send, so the refusal cannot
      // be argued away as "only the bare action is blocked".
      expect(
        callToolAdmission("install_custom_node", {
          action: "uninstall",
          id: "comfyui-impact-pack",
        }),
      ).toBe('tool "install_custom_node" is not permitted for action "uninstall"');
    });

    it("refuses the actions that RUN third-party pack code", () => {
      for (const action of ["update", "reinstall", "fix", "sync_deps"]) {
        expect(
          callToolAdmission("install_custom_node", { action, id: "comfyui-impact-pack" }),
          `action:"${action}"`,
        ).toBe(`tool "install_custom_node" is not permitted for action "${action}"`);
      }
      // "all" is the shape that would have hit EVERY installed pack at once.
      expect(callToolAdmission("install_custom_node", { action: "update", id: "all" })).toBe(
        'tool "install_custom_node" is not permitted for action "update"',
      );
    });

    it("refuses enable/disable — neither was whitelisted", () => {
      for (const action of ["enable", "disable"]) {
        expect(
          callToolAdmission("install_custom_node", { action }),
          `action:"${action}"`,
        ).toBe(`tool "install_custom_node" is not permitted for action "${action}"`);
      }
    });

    /**
     * The registry-discovery pair is on a DIFFERENT tool after the owner's
     * split, and that tool was never whitelisted — neither `search_custom_nodes`
     * (which survives) nor the retired pack-details lookup it absorbs. Keeping
     * it out is preserving reachability; adding it would be inventing it, which
     * is the same defect as the broadening this whole describe block exists to
     * prevent, just pointing the other way. The refusal is NAME-level, so no
     * action scope is needed.
     */
    it("search_custom_nodes is not whitelisted at all — it was never reachable here", () => {
      for (const action of ["search", "details"]) {
        expect(callToolAdmission("search_custom_nodes", { action }), `action:"${action}"`).toBe(
          'tool "search_custom_nodes" is not permitted',
        );
      }
      // …including the shapes a client would actually send.
      expect(
        callToolAdmission("search_custom_nodes", { action: "search", query: "impact", limit: 5 }),
      ).toBe('tool "search_custom_nodes" is not permitted');
      expect(callToolAdmission("search_custom_nodes", {})).toBe(
        'tool "search_custom_nodes" is not permitted',
      );
    });

    it("refuses install_custom_node with a missing or non-string action", () => {
      // The pre-fold call shape: the retired list tool took no `action` at all,
      // so a client that merely swapped the NAME must be refused rather than
      // silently defaulting into one of the eleven actions.
      expect(callToolAdmission("install_custom_node", {})).toBe(
        'tool "install_custom_node" is not permitted for action "(missing)"',
      );
      expect(callToolAdmission("install_custom_node", { action: 42 })).toBe(
        'tool "install_custom_node" is not permitted for action "(missing)"',
      );
    });

    it("node_pack is not whitelisted at all — it writes files and runs git", () => {
      for (const action of ["scaffold", "verify", "publish", "list_files", "read", "search", "write", "patch", "git"]) {
        expect(callToolAdmission("node_pack", { action }), `action:"${action}"`).toBe(
          'tool "node_pack" is not permitted',
        );
      }
    });
  });

  it("name-level behavior is unchanged for everything else", () => {
    // A whitelisted tool with no action scope is admitted regardless of args…
    expect(callToolAdmission("list_output_images", {})).toBeNull();
    // …including a consolidated tool whose whole-tool posture was judged at
    // whitelist time (apps, 0.49.0 slice 2) — deliberately NOT rescoped here.
    expect(callToolAdmission("apps", { action: "run" })).toBeNull();
    // A genuinely unknown name — in no ledger and no registry, so neither live
    // nor retired — keeps the byte-identical pre-change string. Asserted to be
    // absent from the ledger first, so the case still means "unknown" rather
    // than quietly becoming a second retired-name case.
    expect(retiredToolMessage("not_a_real_tool")).toBeUndefined();
    expect(callToolAdmission("not_a_real_tool", {})).toBe(
      'tool "not_a_real_tool" is not permitted',
    );
  });

  /**
   * The refusal a LIVE, non-whitelisted tool gets, asserted over the whole live
   * surface rather than over two spelled names.
   *
   * This replaces the spelled `clear_vram` / `restart_comfyui` cases that stood
   * here. Making retirement win ahead of the whitelist is exactly what turns
   * "is this name still live?" into a load-bearing precondition for this string,
   * and a spelled live name is a name a later 0.50.0 slice may fold away at any
   * hour — at which point the assertion would fail for a reason that has nothing
   * to do with what it is testing. Derived from TOOL_NAMES it cannot rot, and it
   * covers the whole surface instead of a sample.
   */
  it("refuses every live non-whitelisted tool with the byte-identical legacy string", () => {
    const notWhitelisted = TOOL_NAMES.filter((n) => !CALL_TOOL_WHITELIST.has(n));
    expect(notWhitelisted.length).toBeGreaterThan(0);
    for (const name of notWhitelisted) {
      expect(callToolAdmission(name, {}), name).toBe(`tool "${name}" is not permitted`);
    }
  });

  /**
   * A retired name reports as RETIRED — the ledger's redirect, not a permission
   * refusal.
   *
   * "not permitted" reads as *you lack permission* and sends a developer to check
   * tokens, whitelists and trust boundaries; the truth is *this tool no longer
   * exists under that name*, which the ledger already knows how to say. The other
   * two call paths — the compact `call_tool` facade and the direct MCP
   * `tools/call` (#895) — have always answered a retired name from the ledger.
   * This channel overwrote it, and it is the channel the panel's RunPod control
   * panel and the mobile app use for the runpod_* names slice 8 folded away.
   *
   * Every case below DERIVES its subject from DEAD_NAMES rather than spelling
   * one. A literal retired name anywhere in `src/` is itself a dead-name-gate
   * violation (scripts/check-tool-vocabulary.mts), and this file holds no
   * `allowedIn` exemption — but the better reason is that deriving makes the
   * assertion exhaustive over the ledger and keeps it true as the remaining
   * slices append to it.
   */
  describe("a retired name reports as retired, not as unpermitted", () => {
    it("answers every ledger name with the ledger's own redirect", () => {
      expect(DEAD_NAMES.length).toBeGreaterThan(0);
      for (const { name, replacement } of DEAD_NAMES) {
        const answer = callToolAdmission(name, {});
        // The claim, stated the way it fails: NOT the permission refusal…
        expect(answer, name).not.toBe(`tool "${name}" is not permitted`);
        // …and not null either, because retirement is still a refusal — a name
        // that does not exist must never be dispatched.
        expect(answer, name).toBe(retiredToolMessage(name));
        // …and actionable: it names what to call instead.
        expect(answer, name).toContain(replacement);
        // The equality above is deliberately against retiredToolMessage(), the
        // helper the branch delegates to, so this file does not become a second
        // home for the ledger's wording — vocabulary.test.ts owns that contract
        // and pins the whole sentence against a literal. What that equality
        // alone cannot say is that the answer is a RETIREMENT rather than
        // whatever else the helper might one day return, so anchor the one token
        // that distinguishes the two answers, independently of the helper.
        expect(answer, name).toContain(`Unknown tool '${name}'`);
      }
    });

    it("keeps serving the redirect in the mcp__<server>__ prefixed form", () => {
      // The form tool names take in MCP clients that namespace them, which
      // findDeadName() already accepts — so the two must not disagree here.
      // Over the whole ledger, not just its first entry: prefix matching is
      // per-name regex construction, so a name with regex-significant characters
      // is exactly where it would come apart.
      for (const { name, replacement } of DEAD_NAMES) {
        const prefixed = `mcp__comfyui__${name}`;
        expect(callToolAdmission(prefixed, {}), prefixed).toBe(retiredToolMessage(prefixed));
        expect(callToolAdmission(prefixed, {}), prefixed).toContain(replacement);
      }
    });

    it("is not routed away by the arguments — including money-shaped ones", () => {
      // A retired name is retired whatever it is called with. Worth stating
      // explicitly because the branch sits ahead of the action scope: args must
      // not be able to steer a retired name onto some other answer, and in
      // particular a billing-shaped call on a retired runpod_* name must come
      // back as the redirect rather than anything that reads like progress.
      for (const { name } of DEAD_NAMES) {
        expect(callToolAdmission(name, { action: "create", pod_id: "pod123" }), name).toBe(
          retiredToolMessage(name),
        );
      }
    });
  });

  /**
   * THE MONEY GUARD, pinned structurally.
   *
   * The hazard in serving retirement early is the #839 pattern: an early return
   * placed slightly wrong turns a refusal into an admission, here on the one code
   * path that guards real money (`runpod` action:"create"/"start" both put a pod
   * into a billing state). The behavioural half is asserted above; these are the
   * invariants that make the early return unable to reach an action-scoped call
   * in the first place, and they fail loudly rather than silently if a later
   * slice breaks them.
   */
  describe("the retirement branch cannot swallow an action-scoped refusal", () => {
    it("never retires a whitelisted name, so the branch cannot shadow an admitted tool", () => {
      // The property that actually matters, stated against the thing the branch
      // tests. Membership in DEAD_NAMES is what makes it intercept — NOT absence
      // from TOOL_NAMES — and the two coincide only because vocabulary.test.ts
      // pins the ledgers disjoint, in another file. Asserting liveness here would
      // therefore be a guard that means what it says only by borrowing someone
      // else's invariant: a name in BOTH ledgers would pass it and still be
      // intercepted ahead of the whitelist, turning an admitted tool into a false
      // refusal.
      for (const tool of CALL_TOOL_WHITELIST) {
        expect(retiredToolMessage(tool), tool).toBeUndefined();
      }
    });

    it("carries only LIVE names in the whitelist", () => {
      // Separate failure, separate test: a whitelisted name that is not a
      // registered tool is unreachable whatever the retirement branch does — the
      // dispatch below admission would 404 it. Kept because it is the earlier
      // and more legible signal for a slice that swapped a name in one place and
      // not the other.
      const alive = new Set<string>(TOOL_NAMES);
      expect([...CALL_TOOL_WHITELIST].filter((n) => !alive.has(n))).toEqual([]);
    });

    it("never retires an action-scoped name, so the branch is never reached for one", () => {
      // This is the invariant, stated directly: control cannot return early for a
      // tool whose actions are individually judged, because retiredToolMessage()
      // is undefined for every one of them.
      for (const tool of CALL_TOOL_ACTION_WHITELIST.keys()) {
        expect(retiredToolMessage(tool), tool).toBeUndefined();
      }
    });

    it("whitelists every action-scoped name, so the scope is reachable at all", () => {
      // A scope on a name the whitelist does not carry is dead configuration:
      // the name-level refusal fires first and the scope never runs, so a later
      // widening of that set would look reviewed and mean nothing.
      for (const tool of CALL_TOOL_ACTION_WHITELIST.keys()) {
        expect(CALL_TOOL_WHITELIST.has(tool), tool).toBe(true);
      }
    });

    it("refuses every action outside a scoped tool's own set — over the whole map", () => {
      // Exhaustive rather than sampled: probe each scoped tool with every action
      // any scoped tool admits, plus the two BILLING actions and a nonsense one.
      // A retirement-shaped early return that let an action-scoped call through
      // (`if (…) return null` ahead of the action check, say) fails here for
      // every tool in the map at once, not just the one a test remembered.
      const probes = new Set<string>([
        ...[...CALL_TOOL_ACTION_WHITELIST.values()].flatMap((s) => [...s]),
        "create",
        "start",
        "__no_such_action__",
      ]);
      expect(CALL_TOOL_ACTION_WHITELIST.size).toBeGreaterThan(0);
      for (const [tool, allowed] of CALL_TOOL_ACTION_WHITELIST) {
        for (const action of probes) {
          if (allowed.has(action)) continue;
          expect(callToolAdmission(tool, { action }), `${tool} / ${action}`).toBe(
            `tool "${tool}" is not permitted for action "${action}"`,
          );
        }
      }
    });

    it("keeps the two BILLING actions refused independently of the map (#269/#278)", () => {
      // The probe above reads the map and SKIPS whatever a set allows, so it goes
      // quiet on exactly the actions a widening would expose: adding "create" to
      // runpod's set makes the loop above pass by skipping it. The two names that
      // spend money are therefore spelled here and asserted twice — that the set
      // does not carry them, and that the call is refused — so a slice that
      // widens the set fails rather than silently disarming the probe.
      //
      // Distinct from the slice-8 behavioural test above, which asserts the same
      // refusal to guard the whitelist SWAP. This one guards the probe.
      const runpod = CALL_TOOL_ACTION_WHITELIST.get("runpod");
      expect(runpod, "runpod must stay action-scoped").toBeDefined();
      for (const action of ["create", "start"]) {
        expect(runpod?.has(action), `${action} must stay out of the scope set`).toBe(false);
        expect(callToolAdmission("runpod", { action }), action).toBe(
          `tool "runpod" is not permitted for action "${action}"`,
        );
      }
    });
  });
});
