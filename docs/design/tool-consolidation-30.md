# 0.50.0 tool consolidation: 151 → ~30

## Problem

The core surface is 151 tools (`TOOL_NAMES`, `MAX_TOOLS = 151`). Glama scores "Tool
Count" 1/5 at 148+ ("most MCP servers operate effectively with 10-30"), the full
surface costs a client ~200KB (~50k tokens) per `tools/list`, and compact mode
(3 meta-tools) is the default only because the full surface is too big to ship.
`TOOL_BUDGET_TARGET = 30` has been sitting in `vocabulary.ts` as an unenforced
goal since the ratchet landed.

0.49.0 proved the mechanics in six merged slices — bisect (#644),
snapshots/batch/apps (#658), comfy_cli (#684), queue/jobs (#699), model-metadata
(#701), workspace (#703) — and stalled at 151 with the eight biggest families
still flat. This is the plan for the rest: 143 remaining names → 24
action-parameterized tools, landing the core surface at **32** (24 new + the 8
already shipped), then flipping the default back to full per the owner's
directive: *"get the tool count down, then make --compact the optional one."*

## Rules

Carried over from the 0.49.0 slices, plus the owner's additions for 0.50.0:

1. **Pure surface change.** Services, return shapes, and error paths are
   untouched. Each action calls the identical function the old tool called.
2. **Flat `z.enum` actions, never `z.discriminatedUnion`** — the MCP SDK renders
   a discriminated union as zero visible params, hiding every input from the
   model. `action` is the only schema-required field; per-action presence is
   enforced in the handler and names the missing field. Guards test absence,
   not falsiness.
3. **One tool per coherent work-domain.** No cross-domain grab-bags.
4. **Cap ~8 actions per tool.** No god-objects. `comfy_cli` (26 actions) is the
   grandfathered exception, not a precedent — see "What must not consolidate".
5. **Keep the highest-traffic existing name as the tool name** where the family
   has one, so the name models already reach for survives unretired. Traffic =
   standalone-word mentions across `packs/`, `plugin/`, `docs/`, `README.md`
   (measured 2026-08-02 with the `deadNameRe` lookaround pattern; full counts in
   the appendix). Where no member name fits a multi-action tool, introduce the
   clean family noun — the 0.49.0 precedent (`queue`, `batch`, `apps`,
   `workspace`).
6. **Every retired name gets a `DEAD_NAMES` entry** with
   `replacement: '<tool> (action:"…")'`, so a stale call returns
   `Unknown tool 'x' — removed in 0.50.0. Call <tool> (action:"…") instead.`
   (#659) instead of a bare 404. Retirement is self-explaining; that is what
   makes retiring even high-traffic names acceptable.
7. **The ratchet artifacts ride every slice**, unchanged from 0.49.0:
   `TOOL_NAMES` same-slot replacement, `MAX_TOOLS === TOOL_NAMES.length`
   ratcheted down, `tool-surface.txt` append + `BASELINE_SHA256` bump,
   dead-name-gate prose sweep, `gen-tool-docs` CATEGORIES regen, panel repo
   re-vendors the regenerated vocabulary, `registry-surface.test.ts` pins it
   all.

8. **Every slice ships the queue-slice test contract** (the pattern
   `src/__tests__/tools/queue-management.test.ts` established in #699, now
   required rather than exemplary): (a) a schema assertion that `action` is the
   *only* schema-required field; (b) at least one dispatch test per action,
   proving it reaches the same service call the retired tool made; (c) for every
   per-action required field, a test that the missing-field error **names the
   field** and calls nothing; (d) an unknown-action test. This is not optional
   polish: the registration layer these slices rewrite is the thinnest-tested
   layer in the repo (measured ~15% of handlers exercised pre-0.49), and the
   consolidation moves handlers *mostly unchanged* — dispatch and
   per-action-presence is exactly where the new bugs can live.

## The target surface: 32 tools

### Already shipped in 0.49.0 (8 — frozen, do not re-open)

| tool | actions |
|---|---|
| `bisect` | start, good, bad, reset, status |
| `node_snapshot` | list, save, restore |
| `apps` | list, get, run, run_status, import |
| `batch` | submit, status, output, wait |
| `comfy_cli` | 26 actions (grandfathered exception to the cap) |
| `queue` | list, get_workflow, move, edit, status, cancel, cancel_queued, clear |
| `model_metadata` | read, propose, fetch_civitai |
| `workspace` | get, set_default, list |

### New (24)

Survivor names in **bold** stay unretired. Every other name in the "folds in"
column is retired with the shown `DEAD_NAMES` replacement. The traffic counts
that chose the survivors (rule 5) are in the appendix.

**Execution & observability**

| tool | actions | folds in (→ action) |
|---|---|---|
| **`enqueue_workflow`** | 5: enqueue, rerun, run_url, template_schema, run_template | rerun_generation→rerun, run_workflow_url→run_url, get_template_schema→template_schema, run_template→run_template |
| **`get_history`** | 4: list, stats, suggest, diagnose | generation_stats→stats, suggest_settings→suggest, diagnose_run→diagnose |
| **`get_system_stats`** | 6: stats, logs, health, clear_vram, report_issue, calculate | get_logs→logs, health_check→health, clear_vram→clear_vram ⚠, report_issue→report_issue, calculate→calculate |
| **`restart_comfyui`** | 3: start, stop, restart | start_comfyui→start, stop_comfyui→stop |

**Workflow authoring & library**

| tool | actions | folds in (→ action) |
|---|---|---|
| **`create_workflow`** | 4: create, modify, validate, node_info | modify_workflow→modify, validate_workflow→validate, get_node_info→node_info |
| **`visualize_workflow`** | 5: render, render_hierarchical, mermaid, to_dsl, from_dsl | visualize_workflow_hierarchical→render_hierarchical, mermaid_to_workflow→mermaid, workflow_to_dsl→to_dsl, dsl_to_workflow→from_dsl |
| **`get_workflow`** | 8 ⚠at cap: get, list, strip, slice, from_image, analyze, query, prompt_director | list_workflows→list, strip_workflow→strip, slice_workflow→slice, workflow_from_image→from_image, analyze_workflow→analyze, query_workflow→query, prompt_director_inspect→prompt_director |
| **`save_workflow`** | 3: save, lock, verify_lock | lock_workflow→lock, verify_workflow_lock→verify_lock |

**Images, assets & generation**

| tool | actions | folds in (→ action) |
|---|---|---|
| **`get_image`** | 7: get, view, list_outputs, convert, analyze_color, list_assets, asset_metadata | view_image→view, list_output_images→list_outputs, convert_image→convert, analyze_color→analyze_color, list_assets→list_assets, get_asset_metadata→asset_metadata |
| **`upload_image`** | 5: image, video, audio, output, stage | upload_video→video, upload_audio→audio, upload_output→output, stage_output_as_input→stage |
| **`generate_image`** | 9 ⚠over cap: image, audio, video, 3d, controlnet, ip_adapter, regenerate, upscale, remove_background | generate_audio→audio, generate_video→video, generate_3d→3d, generate_with_controlnet→controlnet, generate_with_ip_adapter→ip_adapter, regenerate→regenerate, upscale_image→upscale, remove_background→remove_background |

**Models**

| tool | actions | folds in (→ action) |
|---|---|---|
| **`download_model`** | 8 ⚠at cap: download, status, cancel, search, search_civitai, search_creators, download_civitai, resolve_missing | download_status→status, cancel_download→cancel, search_models→search, search_civitai_models→search_civitai, search_civitai_creators→search_creators, download_civitai_model→download_civitai, resolve_missing_models→resolve_missing |
| **`list_local_models`** | 6: list, remove, embeddings, list_paths, add_path, remove_path | remove_model→remove, get_embeddings→embeddings, list_extra_paths→list_paths, add_extra_path→add_path, remove_extra_path→remove_path |

**Custom nodes**

| tool | actions | folds in (→ action) |
|---|---|---|
| **`install_custom_node`** | 8 ⚠at cap: install, update, reinstall, fix, list, sync_deps, search, details | update_custom_node→update, reinstall_custom_node→reinstall, fix_custom_node→fix, list_installed_nodes→list, sync_node_dependencies→sync_deps, search_custom_nodes→search, get_node_pack_details→details |
| `node_pack` *(new name)* | 9 ⚠over cap: scaffold, verify, publish, list_files, read, search, write, patch, git | scaffold_custom_node→scaffold, verify_custom_node→verify, publish_custom_node→publish, list_node_pack_files→list_files, read_node_file→read, search_node_packs→search, write_node_file→write, apply_node_patch→patch, node_pack_git→git |

**Install, environment & API nodes**

| tool | actions | folds in (→ action) |
|---|---|---|
| **`install_comfyui`** | 8 ⚠at cap: install, update, update_all, panel, self_update, environment, configure_manager, apply_manifest | update_comfyui→update, update_all→update_all, install_panel→panel, self_update→self_update, get_environment→environment, configure_manager→configure_manager, apply_manifest→apply_manifest ⚠ |
| **`list_api_nodes`** | 3: list, schema, generate | get_api_node_schema→schema, generate_with_api_node→generate |
| **`get_defaults`** | 4: get, set, get_ui, set_ui | set_defaults→set, get_comfyui_settings→get_ui, set_comfyui_setting→set_ui |

**Knowledge (skills, packs, workflow readiness)**

| tool | actions | folds in (→ action) |
|---|---|---|
| **`list_packs`** | 9 ⚠over cap: list, read_workflow, list_templates, check_runtime, extract_deps, install_deps, list_skills, read_skill, generate_skill | read_pack_workflow→read_workflow, list_workflow_templates→list_templates, check_workflow_runtime→check_runtime, extract_workflow_dependencies→extract_deps, install_workflow_dependencies→install_deps, list_skills→list_skills, read_skill→read_skill, generate_node_skill→generate_skill |

**RunPod & training**

| tool | actions | folds in (→ action) |
|---|---|---|
| `runpod` *(new name)* | 8 ⚠at cap: create, start, stop, status, list, connect, use_local, deploy_link | runpod_pod_create→create, runpod_pod_start→start, runpod_pod_stop→stop, runpod_pod_status→status, runpod_list_pods→list, runpod_pod_connect→connect, runpod_use_local→use_local, runpod_deploy_link→deploy_link |
| **`runpod_watch`** | 3: watch, unwatch, troubleshoot | runpod_unwatch→unwatch, runpod_pod_troubleshoot→troubleshoot |
| **`train_start`** | 7: start, status, cancel, delete, list_flows, job_config, preview_config | train_status→status, train_cancel→cancel, train_delete_job→delete, train_list_flows→list_flows, train_job_config→job_config, train_preview_config→preview_config |
| **`train_prepare_dataset`** | 8 ⚠at cap: prepare, list, detail, update, delete, file, caption_image, caption_dataset | train_list_datasets→list, train_dataset_detail→detail, train_dataset_update→update, train_dataset_delete→delete, train_file→file, train_caption_image→caption_image, train_caption_dataset→caption_dataset |
| **`train_doctor`** | 3: doctor, bootstrap, build_image | train_bootstrap→bootstrap, train_build_image→build_image |

Arithmetic: 143 covered names (22 survivors + 121 retired) → 24 tools; 24 + 8
shipped = **32**. Six tools sit exactly at the 8-action cap; three sit at 9 and
are flagged below with their fallback splits.

## Slice plan

Ten slices, numbered 7–16 as a continuation of the 0.49.0 series (1–6 shipped).
**Order: cheapest first, most-used last.** Not the reverse, for three reasons:

- **The redirect contract earns trust on cheap targets.** The dead-name gate,
  `retiredToolMessage` (#659), the docs regen, and the panel re-vendor all have
  to work eight more times before anyone believes in them at scale. A mistake
  in slice 7 (process control, ~55 combined mentions) is a patch release; the
  same mistake in the generation family is a bad week.
- **High-traffic names stay alive as long as possible.** Every week
  `enqueue_workflow` (40 mentions) and `generate_image` keep working is a week
  no user or skill author has to move. Folding them last also means their prose
  sweep lands once, immediately before the flip, instead of rotting across
  several releases.
- **Count drops bank early anyway.** The biggest single-slice win (training,
  −15) ships in slice 10, and the surface is below 100 by slice 11 — the Glama
  148+ cliff is cleared long before the risky slices land.

| slice | folds | names → tools | surface after |
|---|---|---|---|
| 7 — warmup: process, API nodes, defaults | restart_comfyui (3→1), list_api_nodes (3→1), get_defaults (4→1) | 10 → 3 | 151 → 144 |
| 8 — RunPod | runpod (8←8), runpod_watch (3→1) | 11 → 2 | 144 → 135 |
| 9 — knowledge & workflow readiness | list_packs (9←9) | 9 → 1 | 135 → 127 |
| 10 — training | train_start (7←7), train_prepare_dataset (8←8), train_doctor (3→1) | 18 → 3 | 127 → 112 |
| 11 — models | download_model (8←8), list_local_models (6←6) | 14 → 2 | 112 → 100 |
| 12 — custom nodes & node authoring | install_custom_node (8←8), node_pack (9←9) | 17 → 2 | 100 → 85 |
| 13 — install/env & diagnostics | install_comfyui (8←8), get_system_stats (6←6) | 14 → 2 | 85 → 73 |
| 14 — workflow authoring & library | create_workflow (4←4), visualize_workflow (5←5), get_workflow (8←8), save_workflow (3→1) | 20 → 4 | 73 → 57 |
| 15 — images & assets | get_image (7←7), upload_image (5←5) | 12 → 2 | 57 → 47 |
| 16 — execution, generation, observability | enqueue_workflow (5←5), generate_image (9←9), get_history (4←4) | 18 → 3 | 47 → **32** |

Each slice is one PR with the full ratchet checklist from rule 7, exactly as
0.49.0 did it. `MAX_TOOLS` walks 151 → 144 → 135 → 127 → 112 → 100 → 85 → 73 →
57 → 47 → 32.

Registration-order convention, unchanged from the shipped slices: the
consolidated tool takes the registration slot of its surviving member (for
`node_pack`/`runpod`: the slot of the family's first member in current
registration order). Removals shift the tail of `tools/list` up — unavoidable
and already accepted in 0.49.0 — but **surviving names never change their
relative order**, which `registry-surface.test.ts` continues to pin.

### Slice recipe (the rule-7/rule-8 checklist, in commit order)

1. Consolidated tool: flat `z.enum` actions, per-action presence guards in the
   handler (absence, not falsiness), each action calling the identical service
   function its retired predecessor called.
2. `TOOL_NAMES`: same-slot replacement for the survivor; delete the folded
   names; `MAX_TOOLS` set to the new `TOOL_NAMES.length` (equality is asserted,
   so a stale value fails).
3. `DEAD_NAMES`: one entry per retired name,
   `replacement: '<tool> (action:"…")'`.
4. `docs/design/tool-surface.txt`: **append** any new tool name (`runpod`,
   `node_pack`); never delete a line; bump `BASELINE_SHA256` (on mismatch the
   gate prints the expected digest).
5. Tests per rule 8.
6. `scripts/gen-tool-docs.ts` CATEGORIES updated; `npm run docs:gen` until it
   is a no-op (unmapped tools and orphaned pages are both fatal).
7. `npm run vocab:export` (the artifact and its `vocabularyHash` change);
   commit the regenerated `docs/design/tool-vocabulary.json`.
8. Panel repo: re-vendor `vendor/tool-vocabulary.json` and run its gate — the
   new dead names surface any panel-side prose that still recommends them.
9. Prose sweep until `npm run check:vocabulary` is green over the whole tree —
   the gate output *is* the sweep worklist.
10. Full local gate run before the PR: lint, build, test, `check:vocabulary`,
    `vocab:export -- --check`, `asset-counts --check`, docs no-op,
    `smoke-install`. The release workflow enforces the same set, so a red gate
    here is a red publish there.

## The flip: full becomes default, `--compact` becomes the opt-in

**When:** the release that lands slice 16 (0.50.0), as its own final PR — not
riders on the slice PRs. The flip is a one-line default change plus docs, and
it should review like one.

**Why then:** compact mode exists because 151 schemas cost ~200KB / ~50k tokens
per `tools/list` (#97). At 32 tools with union-parameter schemas the same read
is roughly 35–50KB / ~10k tokens — about what a mid-size server costs today and
a reasonable default for frontier harnesses, while remaining large enough to
matter for local models. So the default flips with the surface, per the owner's
directive, not before it.

**Mechanics:**

- `src/transport/cli.ts`: the default `toolMode` resolves `"compact"` →
  `"full"`; `COMFYUI_MCP_TOOL_MODE=compact` and the existing `--compact` flag
  become the opt-in. `--full` stays as an accepted no-op so existing scripts
  and docs snippets don't break. The `toolModeExplicit` child-spawn export
  logic is unchanged in mechanism, inverted in default.
- **The compact facade is not removed — it survives twice.** `call_tool` /
  `list_tools` / `describe_tool` remain (a) the entire compact mode, now
  opt-in, and (b) the facade layered onto the full surface by default
  (`registerFullTools`, #616), which is the reconnect escape hatch for
  code-execution clients whose cached direct bindings go stale. Removing
  `call_tool` would re-break both #616 clients and the small-model users compact
  was built for (#97); keeping it costs 3 slots. The only visible change:
  full-mode `tools/list` shows 35 entries (32 direct + 3 facade), and
  `COMFYUI_MCP_NO_FACADE=1` remains the opt-out for purists.
- **The flip PR must add an unknown-tool interceptor, or rule 6 silently
  breaks at the worst possible moment.** Probed against 0.49.3 with an
  in-memory client: a retired name called through the facade returns the #659
  redirect ("removed in 0.49.0. Call batch (action:"submit") instead."), but the
  same name called *directly* via `tools/call` returns the SDK's bare
  `MCP error -32602: Tool <name> not found`. Today that asymmetry is invisible
  because compact is the default and everything routes through `call_tool`.
  After the flip, **direct is the default path** — so every stale skill,
  script, and cached binding would get the bare 404, in the very release that
  retires the highest-traffic names. The flip PR therefore intercepts unknown
  `tools/call` names and answers with `retiredToolMessage(name)` before
  falling through to method-not-found. A regression test pins both paths.
- One accounting note, stated so nobody rediscovers it as a hole: the three
  facade names live in no ledger or baseline — `TOOL_NAMES`,
  `tool-surface.txt`, and `registry-surface.test.ts` all pin the *direct*
  surface, and the facade rides on top unpinned. That is deliberate (the facade
  is transport furniture, not vocabulary), but it means the served default
  surface contains 3 tools no vocabulary gate sees. The flip PR's regression
  test asserts the served count is exactly `MAX_TOOLS + 3`.
- Docs ride the flip PR: README's "151 MCP tools" badge, the tool-mode docs
  page, and every "compact is the default" sentence invert in the same diff.

## Release & rollback

The reason slices can ship continuously while the flip cannot: **retirement is
soft under the compact default.** While compact remains the default, a retired
name still "resolves" — `call_tool` answers with the #659 redirect and the
model self-corrects in one turn. So slices 7–15 ship as ordinary releases on
`latest`, exactly as the 0.49.0 slices did, each independently green and each
independently revertable-by-fix-forward.

The flip is the one hard break, and it gets the prerelease channel built for
exactly this in #447:

- **Slice 16 + flip release as `0.50.0-rc.N` on the `next` dist-tag** first
  (`npx comfyui-mcp@next` to soak). `latest` stays on the last pre-flip
  release, so the auto-updater keeps existing users on the soft-retirement
  world until promotion.
- **Promotion is deliberate and effectively irreversible**:
  `npm dist-tag add comfyui-mcp@0.50.0 latest`. Auto-update only moves forward
  (`isNewer` gates at self-update.ts), so moving `latest` back does not recover
  updated users — the release notes say so, and the escape hatch is version
  pinning (`npx comfyui-mcp@0.49.x`).
- **The last pre-flip line stays alive** as the fallback lane: a `release/0.49.x`
  branch off the final pre-flip tag, so a critical fix can ship to the
  compact-default world without dragging the flip along.

## What must NOT consolidate, and why

- **The eight shipped 0.49.0 tools.** Frozen. Re-opening them re-retires names
  that skills and docs just moved to, for zero count gain.
- **`comfy_cli` (26 actions) is the grandfathered god-object.** It ships as-is
  because it mirrors the CLI's own command tree, and splitting it now would
  retire 26 action names that were introduced one release ago. It is also not
  a precedent: the ~8-action cap holds for every new tool in this plan, with
  the three 9-action exceptions individually flagged below.
- **The panel surface (`panel_*`, 91 tools).** Out of scope. It has its own
  frozen baseline and hash (`panel-surface.txt`, `PANEL_BASELINE_SHA256`), its
  own rename plan (phase 6, `canvas_*`), and a mirrored vocabulary gate in the
  panel repo. Folding it into this plan would couple two migrations and double
  every slice's blast radius. Note for the flip's token math: a connected panel
  adds its ~90 schemas to `tools/list` regardless of core count.
- **Autoloaded workflow tools.** User-defined names registered by
  `registerAutoloadedWorkflows`; the facade collision guard (#616) stays as-is.
- **`enqueue_workflow` must remain a named entry point.** It folds its four
  satellite entry points (rerun, run_url, template_schema, run_template) but is
  not itself subsumed into any wider "execute" god-tool. It is the single
  highest-stakes call on the surface and the name models reach for first (40
  mentions, #1 among unambiguous pre-consolidation names).
- **Nothing else is left standalone in the base plan.** The thin/thorny
  candidates people expect to be exempt — `calculate` (pure utility),
  `report_issue` (outward-facing: files a GitHub issue), `clear_vram` (the OOM
  panic button), `apply_manifest` (the most-referenced name on the surface) —
  are all *folded*, because the dead-name redirect makes retirement
  self-healing and the prose sweep is mechanical. Three of the four have
  documented fallbacks below if review disagrees. The bar for a new standalone
  holdout is high: every one costs a slot the budget doesn't have.

## Controversial groupings (flagged for review)

1. **`apply_manifest` → `install_comfyui` (action:"apply_manifest").** The most
   mentioned name on the surface (93), concentrated in pack READMEs, blog
   posts, and the installer-packs skill — i.e. model-facing prose that every
   pack consumer reads. Folding keeps the budget at 32 but touches the widest
   prose footprint of any retirement. *Fallback:* leave `apply_manifest`
   standalone → 33 tools.
2. **`clear_vram` → `get_system_stats` (action:"clear_vram").** 35 mentions and
   a genuine panic button; there is a real UX argument that the name a model
   reaches for mid-OOM should stay a bare call. *Fallback:* standalone → 33.
3. **Three 9-action tools** (`generate_image`, `node_pack`, `list_packs`) sit
   one over the ~8 cap. Each has a clean split if the cap is enforced strictly:
   `upscale_image` (upscale, remove_background) back out of `generate_image`;
   `scaffold_custom_node` (scaffold, verify, publish) back out of `node_pack`;
   `list_skills` (list, read, generate) back out of `list_packs`. Taking all
   three fallbacks → 35 tools, still "~30".
4. **`regenerate` (19 mentions) folds into `generate_image`.** Highest-traffic
   retirement in the generation family; folded because it is literally a
   generation entry point, and splitting it back out buys one slot at the cost
   of a fourth generation-adjacent tool.
5. **`search_custom_nodes` (20) folds into `install_custom_node`
   (action:"search")** rather than living in a discovery tool. Registry search
   and install are one flow ("find pack → install it"), and `download_model`
   already pairs search with download the same way — but discovery-in-a-
   lifecycle-tool reads oddly to some reviewers.
6. **`get_system_stats` absorbs `report_issue` and `calculate`.** Correct by
   registration group (both are `diagnostics` today) but the name fit is the
   weakest in the plan; the alternative clean noun (`diagnostics`) retires the
   22-mention `get_system_stats` for a name nobody knows. Kept-name wins per
   rule 5.
7. **Six tools at exactly 8 actions** (`get_workflow`, `download_model`,
   `install_custom_node`, `install_comfyui`, `runpod`, `train_prepare_dataset`)
   have zero headroom: any future action forces a split or a cap exception.
   Acceptable — the cap exists to be enforced at review time, and these six are
   the natural ceiling of their domains.

### Disposition

The base plan stands as written: all seven items above ship as specified, and
each fallback remains exercisable at its own slice's PR review without
re-planning — the slice order was chosen so every controversial fold lands
late, after the redirect contract has proven itself on seven cheaper families.
One item gets an explicit checkpoint rather than a default: **`clear_vram`
(item 2) is re-evaluated at slice 13 review** against redirect telemetry from
slices 7–12 — mid-OOM, the redirect costs one extra model turn, and whether
that is acceptable is an empirical question about how reliably models recover
from the redirect in a single step, not a taste question. If they don't, take
the fallback and ship 33.

## Appendix: traffic measurement

Standalone-word mention counts across `packs/`, `plugin/`, `docs/`, `README.md`
(2026-08-02, pattern `(?<![A-Za-z0-9_])name(?![A-Za-z0-9_])` — the same
lookarounds as `deadNameRe`). Survivors chosen by rule 5 are the highest-count
member *that can plausibly umbrella the family*; where a narrower name
out-counts the umbrella (apply_manifest 93 under install_comfyui, clear_vram 35
under get_system_stats, analyze_color 22 under get_image, search_custom_nodes
20 under install_custom_node, regenerate 19 under generate_image), the umbrella
won on rule 3 and the retirement is flagged in the controversies section. Key
numbers:

- Kept names: enqueue_workflow 40, get_history 36, get_system_stats 22,
  restart_comfyui 27, create_workflow 20, visualize_workflow 17, get_workflow
  27, save_workflow 13, get_image 15, upload_image 30, generate_image 13,
  download_model 32, list_local_models 31, install_custom_node 15,
  install_comfyui 7, list_api_nodes 11, get_defaults 9, list_packs 20,
  runpod_watch 4, train_start 23, train_prepare_dataset 13, train_doctor 13.
- Retired names over 15 mentions (the painful set): apply_manifest 93,
  clear_vram 35, analyze_color 22, modify_workflow 21, install_panel 21,
  analyze_workflow 21, search_custom_nodes 20, get_logs 20, regenerate 19,
  list_output_images 19, validate_workflow 18, strip_workflow 17,
  search_civitai_models 17, check_workflow_runtime 16, train_status 15,
  start_comfyui 15 (full counts reproducible with the pattern above).
- Already-consolidated names that read as English words (`queue` 184,
  `workspace` 150, `batch` 95, `apps` 53) are inflated by prose usage and were
  not used for decisions.

### Per-slice prose-sweep reminder

Every retirement above lands in `DEAD_NAMES` with
`replacement: '<tool> (action:"…")'`, and the dead-name gate then fails CI on
every live mention in `src/`, `docs/`, `packs/`, `plugin/` until the slice's
prose sweep updates them — that is the ratchet working as designed, and the
reason the high-mention families are scheduled late: their sweeps are the
largest and benefit from the tooling having absorbed seven prior families.
