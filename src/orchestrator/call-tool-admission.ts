/**
 * Admission for the orchestrator's direct tool channel (call_tool frames from a
 * mobile/canvas-less client). Extracted from src/orchestrator/index.ts so the
 * decision is a pure, unit-testable function — the dispatcher is a one-line
 * call site.
 */

/** The direct tool channel: a mobile client can invoke these READ/DOWNLOAD backend
 *  tools without an agent turn (structured nav data + rig downloads). The
 *  bridge is already token-gated; this whitelist keeps call_tool to non-destructive
 *  tools (no restart/remove/clear/install). */
const CALL_TOOL_WHITELIST = new Set<string>([
  "list_workflows",
  "get_workflow",
  "analyze_workflow",
  "query_workflow",
  "workflow_from_image",
  "list_output_images",
  "get_image",
  "list_local_models",
  // Read-only CivitAI lookups (creator-search feature): let a client browse
  // models/creators through the rig without an agent turn.
  "search_civitai_models",
  "search_civitai_creators",
  "download_civitai_model",
  "download_model",
  "enqueue_workflow",
  // Persist a workflow to the ComfyUI library (mobile "pull workflow from a
  // CivitAI example" → save_workflow). Writes a workflow file (auto-converts
  // API-format graphs to canvas-openable UI format); overwrites same-filename,
  // so the client generates a unique name. No model/system mutation.
  "save_workflow",
  // One-tap cancel of the RUNNING render (the mobile queue monitor's stop
  // button). User-initiated and narrowly scoped: the client passes the
  // prompt_id it saw in `queue_status`, and action:"cancel" only interrupts
  // when the running job still matches — it can never kill a job that started
  // after the tap, and (without clear_pending, which the mobile client never
  // sends) it never touches other pending jobs in a shared queue. 0.49.0
  // slice 4 folded the eight queue/jobs tools into this one name, so admission
  // is ACTION-scoped below to exactly what its retired single-purpose
  // predecessor entry covered — see CALL_TOOL_ACTION_WHITELIST.
  "queue",
  // "Why did my render fail?" for canvas-less clients. The panel answers this from
  // live canvas state (panel_get_errors); a phone has no canvas, so it reads
  // the same story server-side from history + re-validating the graph that ran.
  // Read-only.
  "diagnose_run",
  // The training surface for the panel/mobile Training tab: flow/model
  // discovery, progress polling, dataset curation, job introspection and
  // cleanup, plus the user-initiated ops (stage a dataset, launch a run, cancel
  // one). All validation lives in the tools themselves (dataset checks,
  // docker/image preflight, liveness-verified cancel); the whitelist only gates
  // reachability.
  //
  // 0.50.0 slice 10 folded eighteen train_* tools into these three names. Every
  // action `train_prepare_dataset` and `train_start` now carry already had its
  // own whitelist entry before the fold, so those two are admitted whole. The
  // third is NOT: `train_doctor` also swallowed the two SETUP tools, which were
  // deliberately absent from this list — hence the action scoping below.
  "train_prepare_dataset",
  "train_start",
  "train_doctor",
  // RunPod control panel (desktop + mobile): the one-tap pod lifecycle + the
  // local⇄pod host switch. Read-only status/list/troubleshoot, the COST-SAVING
  // actions (stop/use_local), connect (retarget only — a pod must already be
  // RUNNING, so it neither spins nor keeps one billing), watch/unwatch, and the
  // referral deploy link. Each action validates its own pod state; the whitelist
  // only gates reachability from a canvas-less client.
  // NOTE: the create AND start actions are deliberately EXCLUDED (#269/#278) —
  // both put a pod into a BILLING state (create deploys; start RESUMES billing
  // on a stopped pod). A confirmation-less mirrored/foreign tab must not be able
  // to spend money, so both go through an agent turn / explicit UI action. stop
  // is kept (it SAVES money).
  //
  // 0.50.0 slice 8 folded eleven runpod_* names into these two, so the exclusion
  // can no longer be expressed by simply omitting a name: `runpod` carries
  // create and start as ACTIONS. It is therefore ACTION-scoped below to exactly
  // the six actions whose retired standalone names were whitelisted — see
  // CALL_TOOL_ACTION_WHITELIST.
  "runpod",
  // `runpod_watch` is NOT action-scoped: all three of its actions (watch,
  // unwatch, troubleshoot) map 1:1 onto three names that were each already
  // whitelisted here, and none of them starts, stops or bills a pod — they only
  // change what the control panel DISPLAYS, plus a read-only diagnosis. Its
  // whitelist entry therefore covers the same ground it always did.
  "runpod_watch",
  // Micro-Apps (panel "Apps" feature): the canvas-less client's list/run/poll
  // surface, plus registry install. One tool since 0.49.0 slice 2, so the
  // whitelist can no longer distinguish the actions — the risk posture is judged
  // over the whole tool. Run queues a job the user explicitly tapped (same as
  // enqueue_workflow, already whitelisted); list/get/run_status are read-only;
  // import (mobile Explore) has the rig fetch a bundle from the public registry
  // and write it locally, the same risk as save_workflow + download_model
  // (already whitelisted) — no model/system mutation, and deps install stays a
  // separate consented action.
  "apps",
  // App dependency side-panel (Explore/detail): the ✓/download panel reads what
  // an app needs vs what's installed and offers per-item fetches. Reads are safe
  // (missing-model detection + candidate resolution, node-pack presence); model
  // downloads reuse the already-whitelisted download_civitai_model/download_model.
  // install_custom_node is a MUTATION that runs the pack's code on install —
  // reachable for the panel's "install missing node" button, gated behind an
  // explicit themed confirm client-side. (Revisit if a canvas-less/foreign tab
  // must not be able to trigger a node install.)
  "resolve_missing_models",
  // 0.50.0 slice 9 folded the nine knowledge tools into this one name, and the
  // entry it replaces was the READ-ONLY dependency EXTRACTOR (see DEAD_NAMES).
  // The fold brings install_deps — which installs custom node packs through
  // ComfyUI-Manager, i.e. downloads and runs third-party code — under the same
  // name, so admission is ACTION-scoped below to exactly what the retired entry
  // covered. Whitelisting the bare name would turn a read into an install.
  "list_packs",
  "list_installed_nodes",
  "install_custom_node",
]);

/**
 * ACTION-scoped admission, layered on top of the name whitelist.
 *
 * The whitelist predates the 0.49.0 consolidation, which folds tool FAMILIES
 * into single action-parameterized names — and the call_tool dispatcher
 * authorizes by tool NAME only, then forwards arbitrary action arguments.
 * Whitelisting a consolidated name would therefore silently admit EVERY action
 * the family folds, including ones the retired per-tool entry never covered. A
 * tool listed here is admitted only when args.action names one of these
 * actions; a tool NOT listed here keeps plain name-level admission (its
 * whitelist entry was already judged over the whole tool).
 *
 * Wired ONLY where a slice's whitelist swap would otherwise broaden admission.
 */
const CALL_TOOL_ACTION_WHITELIST: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  // The `queue` entry above replaces the retired standalone cancel entry
  // (0.49.0 slice 4), which admitted CANCEL semantics only: interrupt the
  // running job, optionally prompt_id-matched, optionally with clear_pending —
  // and that is exactly action:"cancel", clear_pending included (its
  // wipe-all-pending effect the old entry already admitted). Every other
  // action stays refused, because none was reachable before:
  // move/edit/cancel_queued mutate pending
  // jobs the old entry couldn't touch individually; clear drops pending while
  // SPARING the running job, a combination the old entry could not express;
  // and list/status/get_workflow, though read-only, were never whitelisted.
  ["queue", new Set(["cancel"])],
  // The `runpod` entry above replaces NINE standalone entries (0.50.0 slice 8),
  // of which SIX were whitelisted: status, list, stop, connect, use_local and
  // deploy_link. The two that were not — create and start — are the two that
  // SPEND MONEY, and they are the whole reason this scope exists: without it,
  // swapping the nine names for the folded one would hand a canvas-less client
  // the ability to deploy a pod and start billing with no agent turn and no
  // confirmation. That is a money regression, not a permissions nicety.
  //
  // troubleshoot is absent here because it now lives on `runpod_watch`, whose
  // own (unscoped) whitelist entry covers it.
  ["runpod", new Set(["status", "list", "stop", "connect", "use_local", "deploy_link"])],
  // The `list_packs` entry above replaces the retired standalone
  // dependency-extractor entry (0.50.0 slice 9), which admitted exactly
  // one thing: READ which custom node packs a workflow needs and which are
  // missing. That is action:"extract_deps" and nothing else. In particular
  // action:"install_deps" stays REFUSED — it queues ComfyUI-Manager installs,
  // which download and execute third-party code on the rig, and no
  // confirmation-less call_tool frame ever had that reach. The remaining actions
  // (list/read_workflow/list_templates/check_runtime/skill_list/skill_read),
  // though read-only, were never whitelisted either, and generate_skill writes a
  // file when `install_in` is set.
  ["list_packs", new Set(["extract_deps"])],
  // `train_doctor` above kept the retired standalone train_doctor entry's
  // admission — a READ-ONLY preflight (docker daemon reachable? GPU passthrough?
  // image built?). 0.50.0 slice 10 folded the two SETUP tools into the same
  // name, and NEITHER was ever whitelisted: action:"bootstrap" runs a ~10 minute
  // git clone + torch/pip install on this machine or on a billed pod, and
  // action:"build_image" runs a multi-GB CUDA docker build. Admitting them by name alone
  // would let a canvas-less client start either without an agent turn — a false
  // ACCEPTANCE created by the fold, which is exactly what this map exists to
  // prevent (#839). Both stay reachable through an agent turn / explicit UI
  // action, as before.
  ["train_doctor", new Set(["doctor"])],
]);

/**
 * The admission decision for one call_tool frame: null when admitted,
 * otherwise the refusal reason (pushed as the tool_result error and logged).
 *
 * The name-level refusal string is byte-identical to what the dispatcher
 * produced before this extraction, so a client that was refused for a
 * non-whitelisted tool sees no change.
 */
export function callToolAdmission(
  tool: string,
  args: Record<string, unknown>,
): string | null {
  if (!CALL_TOOL_WHITELIST.has(tool)) return `tool "${tool}" is not permitted`;
  const actions = CALL_TOOL_ACTION_WHITELIST.get(tool);
  if (actions !== undefined) {
    const action = typeof args.action === "string" ? args.action : undefined;
    if (action === undefined || !actions.has(action)) {
      return `tool "${tool}" is not permitted for action "${action ?? "(missing)"}"`;
    }
  }
  return null;
}
