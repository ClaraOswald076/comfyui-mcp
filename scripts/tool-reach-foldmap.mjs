// The 0.50.0 consolidation fold map, as benchmark DATA.
//
// A tool-reach benchmark has to ask the same question of three different tool
// surfaces (154 flat names, 3 compact meta-tools, 33 action-parameterized
// tools). The only thing stable across all three is the CAPABILITY — "cancel a
// download", "file a bug" — so every request in
// scripts/tool-reach-requests.mjs names its target by the ORIGINAL flat tool
// name, and this map is what turns that into the (tool, action) pair a given
// surface actually expects.
//
// Source of truth: the orchestrator's slices.json fold map (slices 7–16),
// transcribed verbatim. Verified against the live surfaces:
//   146 folded names + 8 already-consolidated names = 154 (the d9e8971 surface)
//   25 survivors      + 8 already-consolidated names =  33 (the final surface)
// `npm run reach:selfcheck` re-asserts both against a captured surface, so a
// transcription slip fails loudly instead of silently mis-scoring one family.

/**
 * Old flat tool name → the (tool, action) it becomes on the FINAL 33-tool
 * surface. Keys are exactly the 146 names slices 7–16 retire.
 */
export const FOLD_MAP = {
  // slice 7 — warmup: process control, API nodes, defaults
  "restart_comfyui": { tool: "restart_comfyui", action: "restart" },
  "start_comfyui": { tool: "restart_comfyui", action: "start" },
  "stop_comfyui": { tool: "restart_comfyui", action: "stop" },
  "list_api_nodes": { tool: "list_api_nodes", action: "list" },
  "get_api_node_schema": { tool: "list_api_nodes", action: "schema" },
  "generate_with_api_node": { tool: "list_api_nodes", action: "generate" },
  "get_defaults": { tool: "get_defaults", action: "get" },
  "set_defaults": { tool: "get_defaults", action: "set" },
  "get_comfyui_settings": { tool: "get_defaults", action: "get_ui" },
  "set_comfyui_setting": { tool: "get_defaults", action: "set_ui" },
  // slice 8 — RunPod
  "runpod_pod_create": { tool: "runpod", action: "create" },
  "runpod_pod_start": { tool: "runpod", action: "start" },
  "runpod_pod_stop": { tool: "runpod", action: "stop" },
  "runpod_pod_status": { tool: "runpod", action: "status" },
  "runpod_list_pods": { tool: "runpod", action: "list" },
  "runpod_pod_connect": { tool: "runpod", action: "connect" },
  "runpod_use_local": { tool: "runpod", action: "use_local" },
  "runpod_deploy_link": { tool: "runpod", action: "deploy_link" },
  "runpod_watch": { tool: "runpod_watch", action: "watch" },
  "runpod_unwatch": { tool: "runpod_watch", action: "unwatch" },
  "runpod_pod_troubleshoot": { tool: "runpod_watch", action: "troubleshoot" },
  // slice 9 — knowledge: skills, packs, workflow readiness
  "list_packs": { tool: "list_packs", action: "list" },
  "read_pack_workflow": { tool: "list_packs", action: "read_workflow" },
  "list_workflow_templates": { tool: "list_packs", action: "list_templates" },
  "check_workflow_runtime": { tool: "list_packs", action: "check_runtime" },
  "extract_workflow_dependencies": { tool: "list_packs", action: "extract_deps" },
  "install_workflow_dependencies": { tool: "list_packs", action: "install_deps" },
  "list_skills": { tool: "list_packs", action: "list_skills" },
  "read_skill": { tool: "list_packs", action: "read_skill" },
  "generate_node_skill": { tool: "list_packs", action: "generate_skill" },
  // slice 10 — training
  "train_start": { tool: "train_start", action: "start" },
  "train_status": { tool: "train_start", action: "status" },
  "train_cancel": { tool: "train_start", action: "cancel" },
  "train_delete_job": { tool: "train_start", action: "delete" },
  "train_list_flows": { tool: "train_start", action: "list_flows" },
  "train_job_config": { tool: "train_start", action: "job_config" },
  "train_preview_config": { tool: "train_start", action: "preview_config" },
  "train_prepare_dataset": { tool: "train_prepare_dataset", action: "prepare" },
  "train_list_datasets": { tool: "train_prepare_dataset", action: "list" },
  "train_dataset_detail": { tool: "train_prepare_dataset", action: "detail" },
  "train_dataset_update": { tool: "train_prepare_dataset", action: "update" },
  "train_dataset_delete": { tool: "train_prepare_dataset", action: "delete" },
  "train_file": { tool: "train_prepare_dataset", action: "file" },
  "train_caption_image": { tool: "train_prepare_dataset", action: "caption_image" },
  "train_caption_dataset": { tool: "train_prepare_dataset", action: "caption_dataset" },
  "train_doctor": { tool: "train_doctor", action: "doctor" },
  "train_bootstrap": { tool: "train_doctor", action: "bootstrap" },
  "train_build_image": { tool: "train_doctor", action: "build_image" },
  // slice 11 — models
  "download_model": { tool: "download_model", action: "download" },
  "download_status": { tool: "download_model", action: "status" },
  "cancel_download": { tool: "download_model", action: "cancel" },
  "search_models": { tool: "download_model", action: "search" },
  "search_civitai_models": { tool: "download_model", action: "search_civitai" },
  "search_civitai_creators": { tool: "download_model", action: "search_creators" },
  "download_civitai_model": { tool: "download_model", action: "download_civitai" },
  "resolve_missing_models": { tool: "download_model", action: "resolve_missing" },
  "list_local_models": { tool: "list_local_models", action: "list" },
  "remove_model": { tool: "list_local_models", action: "remove" },
  "get_embeddings": { tool: "list_local_models", action: "embeddings" },
  "list_extra_paths": { tool: "list_local_models", action: "list_paths" },
  "add_extra_path": { tool: "list_local_models", action: "add_path" },
  "remove_extra_path": { tool: "list_local_models", action: "remove_path" },
  // slice 12 — custom nodes and node authoring
  "install_custom_node": { tool: "install_custom_node", action: "install" },
  "update_custom_node": { tool: "install_custom_node", action: "update" },
  "reinstall_custom_node": { tool: "install_custom_node", action: "reinstall" },
  "fix_custom_node": { tool: "install_custom_node", action: "fix" },
  "uninstall_custom_node": { tool: "install_custom_node", action: "uninstall" },
  "enable_custom_node": { tool: "install_custom_node", action: "enable" },
  "disable_custom_node": { tool: "install_custom_node", action: "disable" },
  "list_installed_nodes": { tool: "install_custom_node", action: "list" },
  "sync_node_dependencies": { tool: "install_custom_node", action: "sync_deps" },
  "scaffold_custom_node": { tool: "node_pack", action: "scaffold" },
  "verify_custom_node": { tool: "node_pack", action: "verify" },
  "publish_custom_node": { tool: "node_pack", action: "publish" },
  "list_node_pack_files": { tool: "node_pack", action: "list_files" },
  "read_node_file": { tool: "node_pack", action: "read" },
  "search_node_packs": { tool: "node_pack", action: "search" },
  "write_node_file": { tool: "node_pack", action: "write" },
  "apply_node_patch": { tool: "node_pack", action: "patch" },
  "node_pack_git": { tool: "node_pack", action: "git" },
  "search_custom_nodes": { tool: "search_custom_nodes", action: "search" },
  "get_node_pack_details": { tool: "search_custom_nodes", action: "details" },
  // slice 13 — install, environment and diagnostics
  "install_comfyui": { tool: "install_comfyui", action: "install" },
  "update_comfyui": { tool: "install_comfyui", action: "update" },
  "update_all": { tool: "install_comfyui", action: "update_all" },
  "install_panel": { tool: "install_comfyui", action: "panel" },
  "self_update": { tool: "install_comfyui", action: "self_update" },
  "get_environment": { tool: "install_comfyui", action: "environment" },
  "configure_manager": { tool: "install_comfyui", action: "configure_manager" },
  "apply_manifest": { tool: "install_comfyui", action: "apply_manifest" },
  "get_system_stats": { tool: "get_system_stats", action: "stats" },
  "get_logs": { tool: "get_system_stats", action: "logs" },
  "health_check": { tool: "get_system_stats", action: "health" },
  "clear_vram": { tool: "get_system_stats", action: "clear_vram" },
  "report_issue": { tool: "get_system_stats", action: "report_issue" },
  "calculate": { tool: "get_system_stats", action: "calculate" },
  // slice 14 — workflow authoring and library
  "create_workflow": { tool: "create_workflow", action: "create" },
  "modify_workflow": { tool: "create_workflow", action: "modify" },
  "validate_workflow": { tool: "create_workflow", action: "validate" },
  "get_node_info": { tool: "create_workflow", action: "node_info" },
  "visualize_workflow": { tool: "visualize_workflow", action: "render" },
  "visualize_workflow_hierarchical": { tool: "visualize_workflow", action: "render_hierarchical" },
  "mermaid_to_workflow": { tool: "visualize_workflow", action: "mermaid" },
  "workflow_to_dsl": { tool: "visualize_workflow", action: "to_dsl" },
  "dsl_to_workflow": { tool: "visualize_workflow", action: "from_dsl" },
  "get_workflow": { tool: "get_workflow", action: "get" },
  "list_workflows": { tool: "get_workflow", action: "list" },
  "strip_workflow": { tool: "get_workflow", action: "strip" },
  "slice_workflow": { tool: "get_workflow", action: "slice" },
  "workflow_from_image": { tool: "get_workflow", action: "from_image" },
  "analyze_workflow": { tool: "get_workflow", action: "analyze" },
  "query_workflow": { tool: "get_workflow", action: "query" },
  "prompt_director_inspect": { tool: "get_workflow", action: "prompt_director" },
  "save_workflow": { tool: "save_workflow", action: "save" },
  "lock_workflow": { tool: "save_workflow", action: "lock" },
  "verify_workflow_lock": { tool: "save_workflow", action: "verify_lock" },
  // slice 15 — images and assets
  "get_image": { tool: "get_image", action: "get" },
  "view_image": { tool: "get_image", action: "view" },
  "list_output_images": { tool: "get_image", action: "list_outputs" },
  "convert_image": { tool: "get_image", action: "convert" },
  "analyze_color": { tool: "get_image", action: "analyze_color" },
  "list_assets": { tool: "get_image", action: "list_assets" },
  "get_asset_metadata": { tool: "get_image", action: "asset_metadata" },
  "upload_image": { tool: "upload_image", action: "image" },
  "upload_video": { tool: "upload_image", action: "video" },
  "upload_audio": { tool: "upload_image", action: "audio" },
  "upload_output": { tool: "upload_image", action: "output" },
  "stage_output_as_input": { tool: "upload_image", action: "stage" },
  // slice 16 — execution, generation, observability
  "enqueue_workflow": { tool: "enqueue_workflow", action: "enqueue" },
  "rerun_generation": { tool: "enqueue_workflow", action: "rerun" },
  "run_workflow_url": { tool: "enqueue_workflow", action: "run_url" },
  "get_template_schema": { tool: "enqueue_workflow", action: "template_schema" },
  "run_template": { tool: "enqueue_workflow", action: "run_template" },
  "generate_image": { tool: "generate_image", action: "image" },
  "generate_audio": { tool: "generate_image", action: "audio" },
  "generate_video": { tool: "generate_image", action: "video" },
  "generate_3d": { tool: "generate_image", action: "3d" },
  "generate_with_controlnet": { tool: "generate_image", action: "controlnet" },
  "generate_with_ip_adapter": { tool: "generate_image", action: "ip_adapter" },
  "regenerate": { tool: "generate_image", action: "regenerate" },
  "upscale_image": { tool: "generate_image", action: "upscale" },
  "remove_background": { tool: "generate_image", action: "remove_background" },
  "get_history": { tool: "get_history", action: "list" },
  "generation_stats": { tool: "get_history", action: "stats" },
  "suggest_settings": { tool: "get_history", action: "suggest" },
  "diagnose_run": { tool: "get_history", action: "diagnose" },
};

/**
 * The eight tools slices 1–6 already consolidated (0.49.x). They are untouched
 * by slices 7–16, so they are their own capability on every arm and their
 * action vocabulary is deliberately NOT modelled here — requests targeting them
 * are scored tool-only, which `resolveExpectation` expresses as `action: null`.
 */
export const ALREADY_CONSOLIDATED = [
  "comfy_cli",
  "queue",
  "node_snapshot",
  "bisect",
  "model_metadata",
  "workspace",
  "apps",
  "batch",
];

/** The 33 names the final surface should carry: 25 survivors + the 8 above. */
export const FINAL_SURFACE = [
  ...new Set([...Object.values(FOLD_MAP).map((f) => f.tool), ...ALREADY_CONSOLIDATED]),
].sort();

/**
 * What a given SURFACE expects when the user wants `capability`.
 *
 * The rule is deliberately surface-driven rather than arm-driven, because main
 * is mid-consolidation: some families have folded and some have not, and an
 * arm-keyed table would go stale the moment the next slice lands. If the flat
 * name is still registered, that flat name IS the right answer and there is no
 * action to get right (`action: null`); once it is gone, the fold map says what
 * replaced it. A capability that is in neither is a bug in the request set or a
 * surface this map has not been updated for — it throws rather than silently
 * scoring every model wrong on that row.
 *
 * @param {string} capability original flat tool name, e.g. "report_issue"
 * @param {Set<string>|string[]} surfaceNames names the arm actually advertises
 *   (for compact: the CATALOG names behind call_tool, not the 3 meta-tools)
 * @returns {{tool: string, action: string|null}}
 */
export function resolveExpectation(capability, surfaceNames) {
  const names = surfaceNames instanceof Set ? surfaceNames : new Set(surfaceNames);
  if (names.has(capability)) return { tool: capability, action: null };
  const folded = FOLD_MAP[capability];
  if (folded && names.has(folded.tool)) return { tool: folded.tool, action: folded.action };
  throw new Error(
    `tool-reach: capability "${capability}" is neither registered on this surface nor ` +
      `foldable onto a registered tool (fold target: ${folded ? folded.tool : "none"}). ` +
      `Either the request set names a tool that never existed, or FOLD_MAP is stale.`,
  );
}
