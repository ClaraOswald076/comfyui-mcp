import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/**
 * The tool vocabulary — the single seam the whole 0.49.0 consolidation keys off.
 *
 * This is a LEDGER, not a derived artefact. It is deliberately hand-maintained
 * and deliberately duplicates what the registry produces, because that is the
 * entire point: `registry-surface.test.ts` asserts the two match EXACTLY, in
 * both directions and in order. A generated list could not catch an unintended
 * change — it would just regenerate to match the mistake.
 *
 * Adding, renaming, or removing a tool is therefore a visible edit to this file
 * in the diff, reviewed on its own terms, rather than a silent side effect of a
 * refactor. During the consolidation, `MAX_TOOLS` ratchets DOWN with each slice
 * and every removed name lands in `DEAD_NAMES`.
 *
 * Order matters: registration order is what `tools/list` returns, and
 * src/tools/index.ts documents it as observable (models read the surface
 * top-down). Nothing enforced it before this file existed.
 */

/**
 * Every tool a client can see, in registration order.
 *
 * The "before" side of the consolidation, re-frozen at the 0.48.32 surface when
 * this branch was rebased onto current main: the 0.48.6 surface plus the tools
 * that shipped in the intervening week — cancel_download (core), and on the panel
 * side panel_refresh_nodes / panel_resize_node / panel_set_property. Appending
 * newly shipped tools to the frozen surface is the intended workflow (see
 * BASELINE_SHA256); the ratchet's guarantee is unchanged, its anchor just moved
 * forward to the surface the consolidation actually starts from.
 */
export const TOOL_NAMES = [
  "comfy_cli",
  "enqueue_workflow",
  "rerun_generation",
  "get_system_stats",
  "visualize_workflow",
  "mermaid_to_workflow",
  "visualize_workflow_hierarchical",
  "create_workflow",
  "modify_workflow",
  "get_node_info",
  "validate_workflow",
  "queue",
  "search_custom_nodes",
  "get_node_pack_details",
  "search_models",
  "download_model",
  "download_status",
  "cancel_download",
  "list_local_models",
  "generate_node_skill",
  "get_logs",
  "get_history",
  "diagnose_run",
  "runpod_pod_status",
  "runpod_list_pods",
  "runpod_pod_start",
  "runpod_pod_stop",
  "runpod_pod_create",
  "runpod_use_local",
  "runpod_watch",
  "runpod_unwatch",
  "runpod_pod_troubleshoot",
  "runpod_pod_connect",
  "runpod_deploy_link",
  "list_workflows",
  "get_workflow",
  "strip_workflow",
  "query_workflow",
  "slice_workflow",
  "save_workflow",
  "analyze_workflow",
  "run_workflow_url",
  "stop_comfyui",
  "start_comfyui",
  "restart_comfyui",
  "get_image",
  "upload_image",
  "upload_video",
  "upload_audio",
  "stage_output_as_input",
  "workflow_from_image",
  "list_output_images",
  "clear_vram",
  "get_embeddings",
  "suggest_settings",
  "generation_stats",
  "view_image",
  "list_assets",
  "get_asset_metadata",
  "regenerate",
  "get_defaults",
  "set_defaults",
  "generate_image",
  "generate_audio",
  "generate_3d",
  "generate_video",
  "remove_background",
  "upscale_image",
  "generate_with_controlnet",
  "generate_with_ip_adapter",
  "workflow_to_dsl",
  "dsl_to_workflow",
  "node_snapshot",
  "bisect",
  "install_custom_node",
  "update_custom_node",
  "reinstall_custom_node",
  "fix_custom_node",
  "list_installed_nodes",
  "sync_node_dependencies",
  "report_issue",
  "extract_workflow_dependencies",
  "install_workflow_dependencies",
  "resolve_missing_models",
  "install_comfyui",
  "update_comfyui",
  "update_all",
  "remove_model",
  "search_civitai_models",
  "search_civitai_creators",
  "download_civitai_model",
  "model_metadata",
  "prompt_director_inspect",
  "list_extra_paths",
  "add_extra_path",
  "remove_extra_path",
  "get_workspace",
  "set_default_workspace",
  "list_workspaces",
  "get_environment",
  "list_api_nodes",
  "get_api_node_schema",
  "generate_with_api_node",
  "configure_manager",
  "scaffold_custom_node",
  "publish_custom_node",
  "verify_custom_node",
  "apply_manifest",
  "convert_image",
  "analyze_color",
  "upload_output",
  "health_check",
  "lock_workflow",
  "verify_workflow_lock",
  "list_skills",
  "read_skill",
  "list_packs",
  "list_workflow_templates",
  "read_pack_workflow",
  "check_workflow_runtime",
  "install_panel",
  "self_update",
  "calculate",
  "get_comfyui_settings",
  "set_comfyui_setting",
  "list_node_pack_files",
  "read_node_file",
  "search_node_packs",
  "write_node_file",
  "apply_node_patch",
  "node_pack_git",
  "train_list_flows",
  "train_prepare_dataset",
  "train_start",
  "train_bootstrap",
  "train_status",
  "train_list_datasets",
  "train_dataset_detail",
  "train_job_config",
  "train_file",
  "train_dataset_update",
  "train_dataset_delete",
  "train_preview_config",
  "train_caption_image",
  "train_caption_dataset",
  "train_delete_job",
  "train_cancel",
  "train_build_image",
  "train_doctor",
  "apps",
  "get_template_schema",
  "run_template",
  "batch",
] as const;

/** A name that is actually registered today. A typo is a compile error. */
export type ToolName = (typeof TOOL_NAMES)[number];

/**
 * The consolidation's "before" surface, frozen — re-anchored at 0.48.32 on rebase
 * (0.48.6 plus cancel_download; see the TOOL_NAMES header).
 *
 * This is what makes the guardrails an actual RATCHET rather than a promise.
 * registry-surface.test.ts compares the live registry against TOOL_NAMES, but both
 * are edited in the SAME commit as a removal, so on their own they cannot notice
 * that a name vanished: delete `get_queue`, drop it from TOOL_NAMES, leave it out of
 * DEAD_NAMES, and every gate passes while 21 stale references live on in prose and
 * hints. The dead-name gate only hunts names already IN the ledger, so an omission
 * disarms it silently.
 *
 * Against a frozen baseline the invariant becomes mechanical:
 *
 *     RETIREMENT_BASELINE \ TOOL_NAMES  ⊆  DEAD_NAMES
 *
 * i.e. every name that has ever existed and no longer does must be declared dead.
 * Forgetting is a build failure, not a silent hole, and the baseline never needs
 * updating — it is history, not state.
 *
 * Read from docs/design/tool-surface.txt so there is exactly one copy of the
 * baseline names (189: the 182 frozen at 0.48.32 plus the seven consolidated tools
 * appended as they shipped — `bisect` in 0.49.0 slice 1, then `node_snapshot`,
 * `apps` and `batch` in slice 2, then `comfy_cli` in slice 3, then `queue` in
 * slice 4, then `model_metadata` in slice 5), and so the file committed
 * as the P0 evidence is load-bearing rather than
 * decorative.
 */
const BASELINE_URL = new URL("../../docs/design/tool-surface.txt", import.meta.url);

/**
 * SHA-256 of the baseline file, so "frozen" is ENFORCED rather than asserted.
 *
 * Without this the ratchet was bypassable in one step: retire a tool, drop it from
 * TOOL_NAMES, and ALSO delete its line from the baseline — the difference set goes
 * empty and every gate passes. The baseline was an ordinary tracked file that the
 * very same commit could edit.
 *
 * Pinning the hash makes shrinking history require deliberately changing this
 * constant: a visible, reviewable line in the diff instead of a deletion buried in a
 * 200-line rename. APPENDING is legitimate — new tools join the baseline when they
 * ship — so the workflow is: append, update this hash, say why in the message.
 */
export const BASELINE_SHA256 = "a022d6ddff680234f7da1ba09f2fd3a0a827e99e07c18853726938afb25c94d0";

/**
 * LAZY on purpose, and this is not a micro-optimisation.
 *
 * Reading at module scope meant that merely IMPORTING this file opened
 * docs/design/tool-surface.txt — and production imports it (workflow-autoload.ts needs
 * TOOL_NAMES and DEAD_NAMES for its collision guard). docs/ is not in package.json's
 * `files` allowlist, so the PUBLISHED package threw ENOENT on import and the server
 * would not start for any user. scripts/smoke-install.mjs caught it, which is precisely
 * why that gate exists.
 *
 * Only the vocabulary gate and its tests need the baseline, and both run from a
 * checkout where the file is present. The files are shipped anyway (see `files`), so a
 * future production caller degrades to a clear error rather than a missing file.
 */
function readBaseline(url: URL): { names: readonly string[]; text: string } {
  const text = readFileSync(url, "utf8");
  return { names: text.split("\n").map((l) => l.trim()).filter(Boolean), text };
}

export function retirementBaseline(): readonly string[] {
  return readBaseline(BASELINE_URL).names;
}

/** Non-throwing, so callers can report it as one finding among others. */
export function baselineIntegrity(): { ok: boolean; actual: string } {
  const actual = createHash("sha256").update(readBaseline(BASELINE_URL).text).digest("hex");
  return { ok: actual === BASELINE_SHA256, actual };
}

const PANEL_BASELINE_URL = new URL("../../docs/design/panel-surface.txt", import.meta.url);

/**
 * The PANEL surface, frozen, with its own hash — re-anchored at 0.48.32 on rebase
 * (the 0.48.6 panel surface plus panel_refresh_nodes / panel_resize_node /
 * panel_set_property, which shipped in the intervening week).
 *
 * The core ratchet covered the core tools and zero of the (now 90) panel tools,
 * because both TOOL_NAMES and RETIREMENT_BASELINE are core-only while panel names are
 * regenerated live from buildPanelToolDefs(). Renaming panel_add_node and forgetting
 * its DEAD_NAMES entry therefore produced no ratchet error at all — while 14
 * model-facing strings, PANEL_SYSTEM_APPEND among them, went on naming it. Phase 6
 * renames ALL of them to canvas_*, so a core-only ratchet would have been silent
 * through the larger of the two migrations.
 *
 * Sorted rather than in registration order: unlike tools/list, the panel surface has
 * no observable ordering, so sorting keeps the diff readable as names are added.
 */
export const PANEL_BASELINE_SHA256 = "581d56282cc1a9154dd68e78c5607f249b5345261b8b5c3bc07b3fc4b412445d";

/** Lazy for the same reason as the core baseline — see readBaseline(). */
export function panelRetirementBaseline(): readonly string[] {
  return readBaseline(PANEL_BASELINE_URL).names;
}

export function panelBaselineIntegrity(): { ok: boolean; actual: string } {
  const actual = createHash("sha256").update(readBaseline(PANEL_BASELINE_URL).text).digest("hex");
  return { ok: actual === PANEL_BASELINE_SHA256, actual };
}

/**
 * Hard ceiling on the registered tool count.
 *
 * Glama scores "Tool Count" 1/5 at 148+ tools ("most MCP servers operate
 * effectively with 10-30"), so this is a score input, not hygiene. It starts at
 * Asserted EQUAL to TOOL_NAMES.length, not merely >=. As a loose ceiling it did
 * nothing: collapsing ten tools to 172 while leaving this at 181 passed, expanding
 * back to 181 passed, and raising it to 999 passed — so "each slice lowers it and it
 * can never drift back up" was unenforced. Equality makes the count an explicit
 * number that must be edited, and therefore reviewed, in the same diff as any change
 * to the surface. That is the ratchet: not that it cannot rise, but that it cannot
 * rise silently.
 */
export const MAX_TOOLS = 153;

/** Where this is headed, for reference in review. A goal, not enforced. */
export const TOOL_BUDGET_TARGET = 30;

/**
 * A name that no longer exists, and the paths where naming it anyway is still
 * correct.
 *
 * The distinction the gate has to make is between ROT (prose that tells a model
 * to CALL a tool that will 404) and HISTORY (prose that accurately says a tool
 * was removed). Both contain the same string, so matching alone cannot tell them
 * apart — hence per-name exceptions, each with a reason, reviewed in the diff.
 * Anything outside them fails.
 */
export interface DeadName {
  /** The removed tool name, matched on word boundaries. */
  name: string;
  /** Version that removed it — quoted in the failure message. */
  since: string;
  /** What to call instead. This is the actionable half of the error. */
  replacement: string;
  /**
   * Specific OCCURRENCES where a mention is legitimate history, not rot.
   *
   * Both fields are matched: `path` exactly (never a glob — a glob would quietly
   * cover files added later) AND `context`, a substring that must appear on the
   * same line as the name.
   *
   * `context` is not decoration. Without it an exemption is whole-FILE, so one
   * legitimate historical sentence in src/orchestrator/panel-tools.ts — thousands of
   * lines of model-facing tool descriptions — would leave every future live
   * instruction in that file pre-approved. Per-occurrence means a real instruction
   * added to an exempted file still fails.
   */
  allowedIn?: Array<{ path: string; context: string; why: string }>;
}

/**
 * Matches a tool name standing on its own, optionally behind an
 * `mcp__<server>__` prefix.
 *
 * Lives here rather than in the checker script because it IS the matching
 * contract, and because scripts/ is outside `tsconfig.json`'s include — here it
 * is type-checked and unit-testable (see vocabulary.test.ts).
 *
 * `\b` is WRONG for these names: it treats `_` as a word character, so
 * `\bpanel_get_graph\b` fails to match inside `mcp__comfyui__panel_get_graph` —
 * the exact form tool names take in agent transcripts and skill files. Explicit
 * `[A-Za-z0-9_]` lookarounds fix that while still rejecting the inverse case, a
 * name embedded in a longer identifier: `get_image` must not match
 * `retarget_image` (real data at packs/artokun-flow/workflow.json:5130) and
 * `panel_get_graph` must not match its own sibling `panel_get_graph_outline`.
 */
export function deadNameRe(name: string): RegExp {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9_])(?:mcp__[A-Za-z0-9_]+__)?${escaped}(?![A-Za-z0-9_])`);
}

/**
 * Seeded with real rot rather than a hypothetical, so the gate proves itself on
 * day one: `panel_get_graph` was removed upstream but survives in FIVE live
 * hint strings in the panel repo (comfyui-mcp-panel.js:3733,3737,4659,5328,5704)
 * — strings that instruct the model to call a tool that does not exist. The
 * mirrored gate in the panel repo is what catches those; here the same ledger
 * entry documents the two mentions in this repo that are correct.
 */
export const DEAD_NAMES: readonly DeadName[] = [
  // 0.49.0 slice 5: the three model-metadata tools folded into one
  // action-parameterized `model_metadata` tool. Same Model Explorer proxy routes,
  // same 404 degradations, same return shapes — only the surface changed, so
  // every mention of the old names is now rot pointing at a 404.
  {
    name: "model_metadata_read",
    since: "0.49.0",
    replacement: 'model_metadata (action:"read")',
  },
  {
    name: "model_metadata_propose",
    since: "0.49.0",
    replacement: 'model_metadata (action:"propose")',
  },
  {
    name: "model_metadata_fetch_civitai",
    since: "0.49.0",
    replacement: 'model_metadata (action:"fetch_civitai")',
  },
  // 0.49.0 slice 4: the eight queue/jobs tools folded into one action-parameterized
  // `queue` tool. Same queue-manager services, same return shapes (JSON for the
  // query actions, prose for the cancels) — only the surface changed, so every
  // mention of the old names is now rot pointing at a 404.
  {
    name: "get_queue",
    since: "0.49.0",
    replacement: 'queue (action:"list")',
  },
  {
    name: "get_queued_workflow",
    since: "0.49.0",
    replacement: 'queue (action:"get_workflow")',
  },
  {
    name: "move_queued_job",
    since: "0.49.0",
    replacement: 'queue (action:"move")',
  },
  {
    name: "edit_queued_job",
    since: "0.49.0",
    replacement: 'queue (action:"edit")',
  },
  {
    name: "get_job_status",
    since: "0.49.0",
    replacement: 'queue (action:"status")',
  },
  {
    name: "cancel_job",
    since: "0.49.0",
    replacement: 'queue (action:"cancel")',
    allowedIn: [
      {
        path: "docs/blog/comfyui-mcp-tdqs-case-study.mdx",
        context: "our single weakest tool, `cancel_job`,",
        why: "A DATED case study of a tool-description audit, narrating what the score was when the tool still had this name. Rewriting the score narrative to the new name would falsify the record of what was measured.",
      },
      {
        path: "docs/blog/comfyui-mcp-tdqs-case-study.mdx",
        context: "Here's `cancel_job`, our 3.1, before and after:",
        why: "Same post, introducing a verbatim quote of the tool's description at audit time — the quote is the artifact under analysis.",
      },
      {
        path: "docs/blog/comfyui-mcp-tdqs-case-study.mdx",
        context: "Raising the floor — `cancel_job`,",
        why: "Same post, past-tense recap of which tools were rewritten in that audit.",
      },
    ],
  },
  {
    name: "cancel_queued_job",
    since: "0.49.0",
    replacement: 'queue (action:"cancel_queued")',
    allowedIn: [
      {
        path: "docs/blog/comfyui-mcp-tdqs-case-study.mdx",
        context: "use `cancel_queued_job` to remove one specific pending job",
        why: "Inside a verbatim > quote of cancel_job's description AS WRITTEN at audit time — the before/after quote is the post's evidence, so editing it would misquote the artifact.",
      },
    ],
  },
  {
    name: "clear_queue",
    since: "0.49.0",
    replacement: 'queue (action:"clear")',
    allowedIn: [
      {
        path: "docs/blog/comfyui-mcp-tdqs-case-study.mdx",
        context: "`clear_queue` to drop all pending jobs",
        why: "Same verbatim quote of the audited description — a historical artifact in a dated post, not live guidance.",
      },
    ],
  },
  // 0.49.0 slice 3: the eight comfy_cli_* tools folded into one action-parameterized
  // `comfy_cli` tool. Same services, same envelope/1 return shapes, same CLI command
  // construction — only the surface changed, so every mention of the old names is now
  // rot pointing at a 404. The replacements name the action family because each old
  // tool covered several actions (comfy_cli_jobs alone was five).
  {
    name: "comfy_cli_status",
    since: "0.49.0",
    replacement: 'comfy_cli (action:"status")',
  },
  {
    name: "comfy_cli_server",
    since: "0.49.0",
    replacement: 'comfy_cli (action:"server_start"|"server_stop"|"server_restart")',
  },
  {
    name: "comfy_cli_jobs",
    since: "0.49.0",
    replacement: 'comfy_cli (action:"jobs_list"|"jobs_status"|"jobs_wait"|"jobs_watch"|"jobs_cancel")',
  },
  {
    name: "comfy_cli_search_nodes",
    since: "0.49.0",
    replacement: 'comfy_cli (action:"search_nodes")',
  },
  {
    name: "comfy_cli_workflow",
    since: "0.49.0",
    replacement: 'comfy_cli (action:"workflow_validate"|"workflow_run")',
  },
  {
    name: "comfy_cli_transfer",
    since: "0.49.0",
    replacement: 'comfy_cli (action:"transfer_upload"|"transfer_download")',
  },
  {
    name: "comfy_cli_models",
    since: "0.49.0",
    replacement: 'comfy_cli (action:"models_list_folders"|"models_list_folder"|"models_search"|"models_show"|"models_download"|"models_remove")',
  },
  {
    name: "comfy_cli_skills",
    since: "0.49.0",
    replacement: 'comfy_cli (action:"skills_list"|"skills_show"|"skills_validate"|"skills_install"|"skills_status"|"skills_uninstall")',
  },
  // 0.49.0 slice 2: three more families folded into action-parameterized tools —
  // the three node-snapshot tools into `node_snapshot`, the four batch tools into
  // `batch`, and the five apps_* tools into `apps`. Same services, same return
  // shapes; only the surface changed, so every mention of the old names is now rot
  // pointing at a 404.
  {
    name: "save_node_snapshot",
    since: "0.49.0",
    replacement: 'node_snapshot (action:"save")',
  },
  {
    name: "restore_node_snapshot",
    since: "0.49.0",
    replacement: 'node_snapshot (action:"restore")',
  },
  {
    name: "list_node_snapshots",
    since: "0.49.0",
    replacement: 'node_snapshot (action:"list")',
  },
  {
    name: "submit_batch",
    since: "0.49.0",
    replacement: 'batch (action:"submit")',
  },
  {
    name: "get_batch_status",
    since: "0.49.0",
    replacement: 'batch (action:"status")',
  },
  {
    name: "get_batch_output",
    since: "0.49.0",
    replacement: 'batch (action:"output")',
  },
  {
    name: "wait_for_batch",
    since: "0.49.0",
    replacement: 'batch (action:"wait")',
  },
  {
    name: "apps_list",
    since: "0.49.0",
    replacement: 'apps (action:"list")',
  },
  {
    name: "apps_get",
    since: "0.49.0",
    replacement: 'apps (action:"get")',
  },
  {
    name: "apps_run",
    since: "0.49.0",
    replacement: 'apps (action:"run")',
  },
  {
    name: "apps_run_status",
    since: "0.49.0",
    replacement: 'apps (action:"run_status")',
  },
  {
    name: "apps_import",
    since: "0.49.0",
    replacement: 'apps (action:"import")',
  },
  // 0.49.0 slice 1: the five bisect_* tools folded into one action-parameterized
  // `bisect` tool. Same state machine, same return shapes — only the surface
  // changed, so every mention of the old names is now rot pointing at a 404.
  {
    name: "bisect_start",
    since: "0.49.0",
    replacement: 'bisect (action:"start")',
  },
  {
    name: "bisect_good",
    since: "0.49.0",
    replacement: 'bisect (action:"good")',
  },
  {
    name: "bisect_bad",
    since: "0.49.0",
    replacement: 'bisect (action:"bad")',
  },
  {
    name: "bisect_reset",
    since: "0.49.0",
    replacement: 'bisect (action:"reset")',
  },
  {
    name: "bisect_status",
    since: "0.49.0",
    replacement: 'bisect (action:"status")',
  },
  {
    name: "panel_view_errored_nodes",
    since: "removed upstream before 0.48.0",
    replacement: "panel_get_errors",
    // Found by review, not by the ratchet, and that is the point: this name was retired
    // BEFORE docs/design/panel-surface.txt was frozen, so `BASELINE \ live` could never
    // contain it. The ratchet's guarantee is bounded by when the baseline was taken —
    // it catches everything retired FROM 0.48.6 ONWARD, and nothing retired before.
    // Names from earlier eras only enter the ledger when something finds them, which is
    // why the dead-name scan has to keep running over prose rather than being replaced
    // by the ratchet.
  },
  {
    name: "panel_get_graph",
    since: "removed upstream before 0.48.0",
    replacement: "panel_query_graph (token-bounded) or panel_graph_outline",
    allowedIn: [
      {
        path: "src/orchestrator/panel-tools.ts",
        context: "replaces the old panel_get_graph full-JSON dump",
        why: "panel_query_graph's own description, saying what it replaced — accurate, and useful orientation for a model that saw the old name in training data.",
      },
      {
        path: "src/__tests__/orchestrator/panel-tools.test.ts",
        context: "Upstream replaced panel_get_graph",
        why: "Comment recording WHY the test asserts panel_query_graph. Deleting it would lose the rationale.",
      },
      {
        path: "docs/blog/panel-workflow-layout.mdx",
        context: "New panel tools: richer `panel_get_graph`",
        why: "A DATED post about the release that shipped this tool. Rewriting it to name a tool that did not exist yet would falsify the record, so the post carries a <Note> stating what replaced it. docs/blog is NOT blanket-historical: it is published and navigable, and treating it as an archive hid this exact line advertising a dead tool as new, with CI green.",
      },
      {
        path: "docs/blog/panel-workflow-layout.mdx",
        context: "The old `panel_get_graph` returned ids",
        why: "Same post, explicitly narrating the OLD behaviour in the past tense.",
      },
    ],
  },
];

/**
 * deadNameRe's contract anchored to the WHOLE string — it answers "is this
 * exact name retired?", the question call_tool has to answer when a client
 * invokes a name that no longer exists (#659), where deadNameRe answers "does
 * this prose mention one?".
 *
 * The `mcp__<server>__` prefix rides along because that is the form names take
 * in MCP clients that namespace tools, so `apps_list` and
 * `mcp__comfyui__apps_list` resolve to the same entry. Anchoring is the safety
 * property: a merely-similar name (`apps_list_v2`, `my_apps_list`) returns
 * undefined and falls through to the fuzzy unknown-tool path, so a ledger entry
 * can never shadow the suggestions for a partial name.
 */
export function findDeadName(name: string): DeadName | undefined {
  return DEAD_NAMES.find((d) => {
    const escaped = d.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`^(?:mcp__[A-Za-z0-9_]+__)?${escaped}$`).test(name);
  });
}

/**
 * The error a caller gets for invoking a RETIRED name: which version removed it
 * and what to call instead, straight from the ledger — turning every
 * consolidation from a silent break into a self-explaining one (#659). Undefined
 * for names the ledger does not know, so callers fall through to their ordinary
 * unknown-tool handling.
 *
 * `since` is usually a bare version ("0.49.0") but the pre-baseline entries carry
 * a clause ("removed upstream before 0.48.0"), so only the version form is
 * conjugated — "removed in ${since}" would mangle the clause into "removed in
 * removed upstream before 0.48.0".
 */
export function retiredToolMessage(name: string): string | undefined {
  const dead = findDeadName(name);
  if (!dead) return undefined;
  const removed = dead.since.startsWith("removed") ? dead.since : `removed in ${dead.since}`;
  return `Unknown tool '${name}' — ${removed}. Call ${dead.replacement} instead.`;
}
