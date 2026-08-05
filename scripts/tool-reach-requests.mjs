// The tool-reach request set — 100 user-phrased requests, deliberately
// stratified.
//
// Sits ALONGSIDE scripts/arena-scenarios.mjs rather than extending it, and
// answers a different question. `SCENARIOS` asks "can this model complete the
// task against a real ComfyUI"; these ask only "does it reach for the right
// tool", and are scored WITHOUT executing anything (see
// scripts/tool-reach-bench.mts). They therefore need no `verify` callback, no
// running server, and no checkpoint — and they can safely name capabilities
// like remove_model, uninstall_custom_node, runpod create/start and
// report_issue, which an executing harness must never touch.
//
// SHAPE
//   id       stable key; the confusion matrix and the per-request table use it
//   tier     "neutral" | "hypothesis" | "ambiguity" | "negative"
//   task     what the USER types. See PHRASING below.
//   target   the CAPABILITY, named by its original flat tool name — resolved
//            per-arm through scripts/tool-reach-foldmap.mjs. `null` means the
//            correct behaviour is to reach for NO tool.
//   accept   other capabilities that are genuinely defensible for this request.
//            Kept deliberately tight: every name added here raises every
//            model's score, so an inflated accept set is the easiest way to
//            manufacture a flattering number.
//   why      one line on why this row is here / why the accept set is what it is
//   leakOk   set when the task unavoidably contains a domain noun that also
//            appears in the tool name ("vram", "mermaid", "skills"). The gate in
//            checkRequestSet() forbids the tool NAME (snake/space/hyphen form);
//            this field documents the residual overlap for review rather than
//            hiding it.
//
// PHRASING RULE (non-negotiable, gated by checkRequestSet)
//   Write what a user would say. NEVER name the tool or the action. A benchmark
//   that leaks the answer measures the leak, not the surface. The gate rejects
//   any task containing a target-or-accept tool name as snake_case,
//   space-separated or hyphen-separated, and likewise the folded
//   `<tool> <action>` form.
//
// STRATIFICATION (why not a uniform sample)
//   57 neutral      — spread over the surface roughly by plausible real usage:
//                     generation/queue/images/models/workflows carry weight,
//                     training and RunPod carry little. This is the unbiased
//                     headline number.
//   30 hypothesis   — H1..H7, the specific reach failures the review of the
//                     final 33-tool surface predicts. ~4 phrasings each so a
//                     single unlucky wording cannot make or break a hypothesis.
//    9 ambiguity    — pairs/triples where two tools legitimately compete and
//                     telling them apart is the whole point.
//    4 negative     — the right move is to use no tool at all. Without these,
//                     a model that reaches for something on every turn looks
//                     identical to one that reaches correctly.
//
// A good average hides the specific failures, and the specific failures are the
// ones that decide whether a name needs renaming.

/** @type {ReadonlyArray<{id:string,tier:string,hypothesis?:string,task:string,target:string|null,accept?:string[],why:string,leakOk?:string}>} */
export const REQUESTS = [
  // ───────────────────────────── neutral: generation & execution (12)
  {
    id: "gen-01",
    tier: "neutral",
    task: "Make me a picture of a red barn in a snowy field, 768 by 768.",
    target: "generate_image",
    why: "The single most common request there is; the floor for any surface.",
  },
  {
    id: "gen-02",
    tier: "neutral",
    task: "I've got a graph ready to go — send it to the server and start it.",
    target: "enqueue_workflow",
    why: "Run an existing graph rather than compose a new one.",
  },
  {
    id: "gen-03",
    tier: "neutral",
    task: "That last render came out too dark. Do it again, but give it more steps.",
    target: "regenerate",
    accept: ["generate_image"],
    why: "Re-running a previous job with an override; composing it afresh is defensible if you still know the prompt.",
  },
  {
    id: "gen-04",
    tier: "neutral",
    task: "Blow this one up to four times the size without it going mushy.",
    target: "upscale_image",
    why: "Distinct capability from a plain render.",
  },
  {
    id: "gen-05",
    tier: "neutral",
    task: "Cut the subject out of this photo — I need it sitting on transparency.",
    target: "remove_background",
    why: "Matting; a plain render would not do it.",
  },
  {
    id: "gen-06",
    tier: "neutral",
    task: "Show me what I've rendered recently.",
    target: "get_history",
    accept: ["list_output_images", "list_assets"],
    why: "Run history and the output listing are both honest readings of 'what I've rendered'.",
  },
  {
    id: "gen-07",
    tier: "neutral",
    task: "How many images have I made this month, and how long do they take on average?",
    target: "generation_stats",
    accept: ["get_history"],
    why: "Aggregates; deriving them from raw history is slower but not wrong.",
  },
  {
    id: "gen-08",
    tier: "neutral",
    task: "My last run died and I can't tell why. Work out what went wrong.",
    target: "diagnose_run",
    accept: ["get_logs", "get_history"],
    why: "Purpose-built diagnosis vs reading the raw log — both defensible first moves.",
  },
  {
    id: "gen-09",
    tier: "neutral",
    task: "What sampler and cfg should I be using for a photoreal portrait on SDXL?",
    target: "suggest_settings",
    why: "Advice from the tool, not from the model's own priors.",
  },
  {
    id: "gen-10",
    tier: "neutral",
    task: "Is anything still churning away right now, or is it idle?",
    target: "queue",
    accept: ["get_system_stats"],
    why: "Already-consolidated tool: scored tool-only on every arm.",
  },
  {
    id: "gen-11",
    tier: "neutral",
    task: "Draw a cat, but make it hold the exact pose in this reference photo.",
    target: "generate_with_controlnet",
    accept: ["generate_image"],
    why: "Pose conditioning; a plain render with a good prompt is a weaker but real answer.",
  },
  {
    id: "gen-12",
    tier: "neutral",
    task: "There's a stock Flux recipe that ships with ComfyUI — use that one to make me a picture of a paper lantern.",
    target: "run_template",
    accept: ["enqueue_workflow", "generate_image"],
    why: "Running a shipped recipe; enqueueing it by hand reaches the same place.",
  },

  // ───────────────────────────── neutral: images & assets (7)
  {
    id: "img-01",
    tier: "neutral",
    task: "Pull the picture down off that job so I can have a look at it.",
    target: "get_image",
    accept: ["view_image", "list_output_images"],
    why: "Fetch vs display — genuinely close.",
  },
  {
    id: "img-02",
    tier: "neutral",
    task: "Just put it on screen, I want to actually see it.",
    target: "view_image",
    accept: ["get_image"],
    why: "The display half of the pair above.",
  },
  {
    id: "img-03",
    tier: "neutral",
    task: "What's landed in my outputs folder today?",
    target: "list_output_images",
    accept: ["list_assets"],
    why: "Output listing vs asset registry.",
  },
  {
    id: "img-04",
    tier: "neutral",
    task: "This came out as a PNG and I need a JPEG at about 80 percent quality.",
    target: "convert_image",
    why: "Format conversion, nothing to do with rendering.",
  },
  {
    id: "img-05",
    tier: "neutral",
    task: "I've got a photo on my desktop I want to work from — get it onto the server.",
    target: "upload_image",
    why: "Ingest.",
  },
  {
    id: "img-06",
    tier: "neutral",
    task: "Take what that job just produced and set it up as the starting point for the next one.",
    target: "stage_output_as_input",
    accept: ["upload_output"],
    why: "Staging an output back as an input; re-uploading it is the manual equivalent.",
  },
  {
    id: "img-07",
    tier: "neutral",
    task: "Which run made this file, and what settings did it use?",
    target: "get_asset_metadata",
    accept: ["list_assets", "get_history"],
    why: "Provenance lookup; history search gets there too.",
  },

  // ───────────────────────────── neutral: models (9)
  {
    id: "mdl-01",
    tier: "neutral",
    task: "What checkpoints have I actually got on disk?",
    target: "list_local_models",
    why: "The most common model question.",
  },
  {
    id: "mdl-02",
    tier: "neutral",
    task: "Grab that SDXL Turbo checkpoint off Hugging Face for me.",
    target: "download_model",
    why: "Fetch by URL/repo.",
  },
  {
    id: "mdl-03",
    tier: "neutral",
    task: "Is that big file I started still coming down? How far along is it?",
    target: "download_status",
    why: "Progress on an in-flight fetch — distinct from starting one.",
  },
  {
    id: "mdl-04",
    tier: "neutral",
    task: "Forget that one, kill it — I don't want it after all.",
    target: "cancel_download",
    why: "Abort in-flight.",
  },
  {
    id: "mdl-05",
    tier: "neutral",
    task: "Find me a decent anime-style LoRA on Civitai.",
    target: "search_civitai_models",
    accept: ["search_models"],
    why: "Named source, but the generic search is a fair first move.",
  },
  {
    id: "mdl-06",
    tier: "neutral",
    task: "I'm out of disk. Get rid of that 7GB checkpoint I never use.",
    target: "remove_model",
    why: "Destructive by nature — exactly why nothing here is executed.",
  },
  {
    id: "mdl-07",
    tier: "neutral",
    task: "What textual inversions can I actually reference in a prompt?",
    target: "get_embeddings",
    accept: ["list_local_models"],
    why: "Embeddings are a model class, so the general listing is defensible.",
  },
  {
    id: "mdl-08",
    tier: "neutral",
    task: "I keep half my stuff on the D: drive — make ComfyUI look there too.",
    target: "add_extra_path",
    why: "Search-path config.",
  },
  {
    id: "mdl-09",
    tier: "neutral",
    task: "This graph wants three things I haven't got. Sort that out for me.",
    target: "resolve_missing_models",
    accept: ["download_model", "search_models"],
    why: "The purpose-built resolver, or doing it by hand.",
  },

  // ───────────────────────────── neutral: workflows (10)
  {
    id: "wf-01",
    tier: "neutral",
    task: "What have I got saved in my library?",
    target: "list_workflows",
    why: "Library listing.",
  },
  {
    id: "wf-02",
    tier: "neutral",
    task: "Open the one called portrait-v3 and show me its JSON.",
    target: "get_workflow",
    why: "Fetch one by name.",
  },
  {
    id: "wf-03",
    tier: "neutral",
    task: "Keep what's on the canvas under the name lighthouse-final.",
    target: "save_workflow",
    why: "Persist.",
  },
  {
    id: "wf-04",
    tier: "neutral",
    task: "Build me a plain text-to-image graph from scratch on SD1.5.",
    target: "create_workflow",
    accept: ["dsl_to_workflow"],
    why: "Authoring; the DSL route builds the same thing.",
  },
  {
    id: "wf-05",
    tier: "neutral",
    task: "Change the seed on the sampler in this graph to 12345.",
    target: "modify_workflow",
    why: "Edit an existing graph.",
  },
  {
    id: "wf-06",
    tier: "neutral",
    task: "Will this thing actually run, or have I wired something wrong?",
    target: "validate_workflow",
    accept: ["check_workflow_runtime"],
    why: "Structural validity vs runtime readiness — close enough to accept both.",
  },
  {
    id: "wf-07",
    tier: "neutral",
    task: "Walk me through what this graph does, node by node.",
    target: "analyze_workflow",
    accept: ["query_workflow"],
    why: "Explanation vs targeted query.",
  },
  {
    id: "wf-08",
    tier: "neutral",
    task: "Draw me a diagram of how this graph is wired up.",
    target: "visualize_workflow",
    accept: ["visualize_workflow_hierarchical"],
    why: "Two renderers of the same thing.",
  },
  {
    id: "wf-09",
    tier: "neutral",
    task: "Someone sent me a PNG that came out of ComfyUI — get the graph back out of it.",
    target: "workflow_from_image",
    why: "Extract embedded graph metadata.",
  },
  {
    id: "wf-10",
    tier: "neutral",
    task: "Which node in here is the one deciding the resolution?",
    target: "query_workflow",
    accept: ["analyze_workflow"],
    why: "Targeted query vs full explanation.",
  },

  // ───────────────────────────── neutral: custom nodes (6)
  {
    id: "cn-01",
    tier: "neutral",
    task: "Is there an extension out there that does face restoration?",
    target: "search_custom_nodes",
    why: "Registry search.",
  },
  {
    id: "cn-02",
    tier: "neutral",
    task: "Put ComfyUI-Impact-Pack on my machine.",
    target: "install_custom_node",
    why: "Install by name.",
  },
  {
    id: "cn-03",
    tier: "neutral",
    task: "What extensions have I currently got?",
    target: "list_installed_nodes",
    why: "Local inventory, not registry search.",
  },
  {
    id: "cn-04",
    tier: "neutral",
    task: "That pack has been broken since the last update. Take it off.",
    target: "uninstall_custom_node",
    accept: ["fix_custom_node", "reinstall_custom_node"],
    why: "'Take it off' is removal, but repairing it is a defensible reading of the complaint.",
  },
  {
    id: "cn-05",
    tier: "neutral",
    task: "Bring all my extensions up to date.",
    target: "update_custom_node",
    accept: ["update_all"],
    why: "Per-pack update vs the everything update.",
  },
  {
    id: "cn-06",
    tier: "neutral",
    task: "I want to write my own node that inverts an image — set the project skeleton up for me.",
    target: "scaffold_custom_node",
    why: "Authoring, not installing.",
  },

  // ───────────────────────────── neutral: install, env, diagnostics (6)
  {
    id: "env-01",
    tier: "neutral",
    task: "Tell me about this machine — Python version, torch build, which card.",
    target: "get_environment",
    accept: ["get_system_stats"],
    why: "Environment report vs live server stats — both carry some of this.",
  },
  {
    id: "env-02",
    tier: "neutral",
    task: "How much VRAM have I got free right now?",
    target: "get_system_stats",
    why: "Live device stats.",
    leakOk: "'VRAM' is the user's own word for the thing; the tool name is not in the text.",
  },
  {
    id: "env-03",
    tier: "neutral",
    task: "Something's off. Show me what the server has been printing lately.",
    target: "get_logs",
    why: "Raw log tail.",
  },
  {
    id: "env-04",
    tier: "neutral",
    task: "Is the server up and answering?",
    target: "health_check",
    accept: ["get_system_stats"],
    why: "A stats call proves reachability too.",
  },
  {
    id: "env-05",
    tier: "neutral",
    task: "ComfyUI itself is a few versions behind. Bring it current.",
    target: "update_comfyui",
    accept: ["update_all"],
    why: "Core update vs everything.",
  },
  {
    id: "env-06",
    tier: "neutral",
    task: "I haven't got ComfyUI on this box at all yet. Set it up.",
    target: "install_comfyui",
    why: "First-run install.",
  },

  // ───────────────────────────── neutral: process control & defaults (2)
  {
    id: "pc-01",
    tier: "neutral",
    task: "Bounce the server for me, it's gone weird.",
    target: "restart_comfyui",
    why: "Restart. Also the survivor whose own name is the tool name post-fold.",
  },
  {
    id: "pc-02",
    tier: "neutral",
    task: "From now on I want everything to use 30 steps and dpmpp_2m unless I say otherwise.",
    target: "set_defaults",
    why: "Persisted preference, not a one-off render parameter.",
  },

  // ───────────────────────────── neutral: packs & readiness (2)
  {
    id: "pk-01",
    tier: "neutral",
    task: "What ready-made bundles can I install?",
    target: "list_packs",
    accept: ["list_workflow_templates"],
    why: "Packs vs shipped templates — a user does not distinguish these.",
  },
  {
    id: "pk-02",
    tier: "neutral",
    task: "Before I set this going, make sure I've actually got every extension and model it needs.",
    target: "check_workflow_runtime",
    accept: ["extract_workflow_dependencies", "validate_workflow"],
    why: "Readiness check; listing the dependencies first is a fair route.",
  },

  // ───────────────────────────── neutral: training (2)
  {
    id: "tr-01",
    tier: "neutral",
    task: "Kick off a LoRA run on my folder of 40 cat photos.",
    target: "train_start",
    accept: ["train_prepare_dataset"],
    why: "Preparing the data first is the correct real workflow, so it is accepted.",
  },
  {
    id: "tr-02",
    tier: "neutral",
    task: "How's my LoRA run getting on?",
    target: "train_status",
    why: "Progress on a training job.",
  },

  // ───────────────────────────── neutral: runpod (1)
  {
    id: "rp-01",
    tier: "neutral",
    task: "Spin me up a GPU box in the cloud with ComfyUI on it.",
    target: "runpod_pod_create",
    why: "Low weight on purpose — and it spends real money, so it is never executed.",
  },

  // ═════════════════════════════ H1: filing a bug (4)
  // Predicted MISS on the consolidated surface: nothing about a tool called
  // get_system_stats suggests it also files GitHub issues.
  {
    id: "h1-01",
    tier: "hypothesis",
    hypothesis: "H1",
    task: "File a bug about the panel dropping its connection every few minutes.",
    target: "report_issue",
    why: "H1 — the plainest phrasing.",
  },
  {
    id: "h1-02",
    tier: "hypothesis",
    hypothesis: "H1",
    task: "This falls over every single time I load a video graph. Let the maintainer know.",
    target: "report_issue",
    why: "H1 — phrased as telling a person rather than filing anything.",
  },
  {
    id: "h1-03",
    tier: "hypothesis",
    hypothesis: "H1",
    task: "Found a defect: the counter never goes back to zero after a run finishes. Raise it upstream.",
    target: "report_issue",
    why: "H1 — 'raise it upstream'.",
  },
  {
    id: "h1-04",
    tier: "hypothesis",
    hypothesis: "H1",
    task: "Open a ticket on the project tracker — uploads fail on Windows paths that contain spaces.",
    target: "report_issue",
    why: "H1 — 'open a ticket'.",
  },

  // ═════════════════════════════ H2: arithmetic (4)
  {
    id: "h2-01",
    tier: "hypothesis",
    hypothesis: "H2",
    task: "What's 1024 times 0.68?",
    target: "calculate",
    why: "H2 — bare arithmetic. Answering from the model's head is the predicted behaviour.",
  },
  {
    id: "h2-02",
    tier: "hypothesis",
    hypothesis: "H2",
    task: "If I render 1536 wide and want 16:9, what height do I need?",
    target: "calculate",
    why: "H2 — arithmetic wearing a domain hat.",
  },
  {
    id: "h2-03",
    tier: "hypothesis",
    hypothesis: "H2",
    task: "I've got 24GB on the card, the model takes 6.5 and each batch item eats 1.8. How many fit?",
    target: "calculate",
    why: "H2 — multi-step arithmetic.",
  },
  {
    id: "h2-04",
    tier: "hypothesis",
    hypothesis: "H2",
    task: "Work out 37 times 1.375 and round it to the nearest multiple of 8.",
    target: "calculate",
    why: "H2 — explicit 'work out'.",
  },

  // ═════════════════════════════ H3: non-image generation (7)
  // Predicted MISS: models hunt for a tool literally named after the medium.
  {
    id: "h3-01",
    tier: "hypothesis",
    hypothesis: "H3",
    task: "Make me a five-second clip of a paper boat drifting down a stream.",
    target: "generate_video",
    why: "H3/video — 'clip' rather than the medium noun.",
  },
  {
    id: "h3-02",
    tier: "hypothesis",
    hypothesis: "H3",
    task: "I want a short animated video — a neon sign flickering in the rain, about three seconds.",
    target: "generate_video",
    why: "H3/video — the plain phrasing.",
    leakOk: "'video' is the user's own noun; the tool name 'generate_video' is not present.",
  },
  {
    id: "h3-03",
    tier: "hypothesis",
    hypothesis: "H3",
    task: "Take this still photo and give it a few seconds of motion.",
    target: "generate_video",
    accept: ["generate_image"],
    why: "H3/video — image-to-motion; a still-image tool is a wrong but understandable reach.",
  },
  {
    id: "h3-04",
    tier: "hypothesis",
    hypothesis: "H3",
    task: "Give me ten seconds of ambient rain-on-a-tin-roof sound.",
    target: "generate_audio",
    why: "H3/audio.",
  },
  {
    id: "h3-05",
    tier: "hypothesis",
    hypothesis: "H3",
    task: "I need a short bluesy guitar riff as a sound file.",
    target: "generate_audio",
    why: "H3/audio — second phrasing.",
  },
  {
    id: "h3-06",
    tier: "hypothesis",
    hypothesis: "H3",
    task: "Give me a 3D model of a coffee mug I can drop straight into Blender.",
    target: "generate_3d",
    why: "H3/3d.",
  },
  {
    id: "h3-07",
    tier: "hypothesis",
    hypothesis: "H3",
    task: "Turn this product photo into a mesh I can spin around.",
    target: "generate_3d",
    why: "H3/3d — second phrasing.",
  },

  // ═════════════════════════════ H4: skills (4)
  // Predicted MISS: packs and skills are different nouns to a user.
  {
    id: "h4-01",
    tier: "hypothesis",
    hypothesis: "H4",
    task: "What skills are available?",
    target: "list_skills",
    why: "H4 — the plainest phrasing.",
    leakOk: "'skills' is the domain noun; the tool name 'list_skills' is not present.",
  },
  {
    id: "h4-02",
    tier: "hypothesis",
    hypothesis: "H4",
    task: "What canned know-how have you got bundled in here for me?",
    target: "list_skills",
    why: "H4 — deliberately avoids the noun entirely.",
  },
  {
    id: "h4-03",
    tier: "hypothesis",
    hypothesis: "H4",
    task: "Is there any built-in guidance on driving the Impact pack properly?",
    target: "list_skills",
    accept: ["read_skill"],
    why: "H4 — reading a specific one straight off is defensible.",
  },
  {
    id: "h4-04",
    tier: "hypothesis",
    hypothesis: "H4",
    task: "Show me the reference material that ships with this thing.",
    target: "list_skills",
    accept: ["list_packs"],
    why: "H4 — genuinely close to the packs listing, so packs is accepted.",
  },

  // ═════════════════════════════ H5: node introspection (4)
  // Predicted MISS: introspection filed under a tool named for CREATION.
  {
    id: "h5-01",
    tier: "hypothesis",
    hypothesis: "H5",
    task: "What inputs does KSampler take?",
    target: "get_node_info",
    why: "H5 — the plainest phrasing.",
  },
  {
    id: "h5-02",
    tier: "hypothesis",
    hypothesis: "H5",
    task: "What are the legal values for the scheduler field on the sampler?",
    target: "get_node_info",
    why: "H5 — enum lookup.",
  },
  {
    id: "h5-03",
    tier: "hypothesis",
    hypothesis: "H5",
    task: "Tell me the parameters on LoadImage.",
    target: "get_node_info",
    why: "H5 — third phrasing.",
  },
  {
    id: "h5-04",
    tier: "hypothesis",
    hypothesis: "H5",
    task: "Does CheckpointLoaderSimple hand back a VAE, and what else comes out of it?",
    target: "get_node_info",
    why: "H5 — outputs rather than inputs.",
  },

  // ═════════════════════════════ H6: mermaid → workflow (4)
  // Predicted MISS: conversion INTO a workflow living under a *visualize* tool.
  {
    id: "h6-01",
    tier: "hypothesis",
    hypothesis: "H6",
    task: "Turn this mermaid diagram into a runnable graph: flowchart TD; A[Load checkpoint] --> B[Encode prompt] --> C[Sample] --> D[Save];",
    target: "mermaid_to_workflow",
    why: "H6 — with an actual diagram in the request.",
    leakOk: "'mermaid' is the format the user names; the tool name is not present.",
  },
  {
    id: "h6-02",
    tier: "hypothesis",
    hypothesis: "H6",
    task: "I sketched the pipeline out in mermaid — build me the real thing from it.",
    target: "mermaid_to_workflow",
    why: "H6 — no diagram body, just the reference.",
    leakOk: "'mermaid' is the format the user names.",
  },
  {
    id: "h6-03",
    tier: "hypothesis",
    hypothesis: "H6",
    task: "Here's a flowchart in mermaid syntax. Make it into something I can actually run.",
    target: "mermaid_to_workflow",
    accept: ["create_workflow"],
    why: "H6 — authoring from scratch is a wrong-but-reasonable reach, so it is accepted.",
    leakOk: "'mermaid' is the format the user names.",
  },
  {
    id: "h6-04",
    tier: "hypothesis",
    hypothesis: "H6",
    task: "Convert my mermaid sketch into something ComfyUI can execute.",
    target: "mermaid_to_workflow",
    why: "H6 — fourth phrasing.",
    leakOk: "'mermaid' is the format the user names.",
  },

  // ═════════════════════════════ H7: freeing VRAM mid-OOM (3)
  {
    id: "h7-01",
    tier: "hypothesis",
    hypothesis: "H7",
    task: "I keep getting out-of-memory halfway through a render. Free up the VRAM.",
    target: "clear_vram",
    why: "H7 — the plainest phrasing.",
    leakOk: "'VRAM' is the user's own noun; 'clear_vram' / 'clear vram' is not present.",
  },
  {
    id: "h7-02",
    tier: "hypothesis",
    hypothesis: "H7",
    task: "The card's memory is all still held by the last model. Dump it.",
    target: "clear_vram",
    why: "H7 — avoids the noun.",
  },
  {
    id: "h7-03",
    tier: "hypothesis",
    hypothesis: "H7",
    task: "OOM again. Flush whatever's sitting on the GPU.",
    target: "clear_vram",
    why: "H7 — terse, mid-incident.",
  },

  // ═════════════════════════════ ambiguity pairs (9)
  // Same verb, different object. Getting these wrong is expensive.
  {
    id: "amb-01",
    tier: "ambiguity",
    task: "Get rid of my training job.",
    target: "train_delete_job",
    why: "Pair A — the JOB. Deleting the dataset instead destroys the wrong thing.",
  },
  {
    id: "amb-02",
    tier: "ambiguity",
    task: "Get rid of my training dataset.",
    target: "train_dataset_delete",
    why: "Pair A — the DATASET. Same verb, different tool, and post-fold a different tool AND action.",
  },
  {
    id: "amb-03",
    tier: "ambiguity",
    task: "Shut ComfyUI down for now.",
    target: "stop_comfyui",
    why: "Pair B — the local server. Post-fold: restart_comfyui action:'stop'.",
  },
  {
    id: "amb-04",
    tier: "ambiguity",
    task: "Shut my cloud box down, I don't want to keep paying for it.",
    target: "runpod_pod_stop",
    why: "Pair B — the rented pod. Confusing these costs money in one direction and uptime in the other.",
  },
  {
    id: "amb-05",
    tier: "ambiguity",
    task: "Find me an extension that does face detailing.",
    target: "search_custom_nodes",
    why: "Triple C — discover.",
  },
  {
    id: "amb-06",
    tier: "ambiguity",
    task: "Right, go ahead and put that one on my machine.",
    target: "install_custom_node",
    why: "Triple C — install.",
  },
  {
    id: "amb-07",
    tier: "ambiguity",
    task: "Open up that pack's source and change the default threshold to 0.4.",
    target: "write_node_file",
    accept: ["apply_node_patch", "read_node_file"],
    why: "Triple C — author. Reading it first is the correct careful move.",
  },
  {
    id: "amb-08",
    tier: "ambiguity",
    task: "Have a look around for a good realistic-skin LoRA I could pull down.",
    target: "search_models",
    accept: ["search_civitai_models"],
    why: "Pair D — searching a remote catalogue.",
  },
  {
    id: "amb-09",
    tier: "ambiguity",
    task: "What have I already got sitting locally?",
    target: "list_local_models",
    why: "Pair D — the local inventory. Post-fold these are the SAME tool, different actions.",
  },

  // ═════════════════════════════ negative / distractor (4)
  // The correct move is no tool at all. Without these, a model that reaches on
  // every single turn is indistinguishable from one that reaches correctly.
  {
    id: "neg-01",
    tier: "negative",
    task: "Just explain something to me, don't touch anything: what's the actual difference between a LoRA and a full fine-tune?",
    target: null,
    why: "Pure knowledge, with an explicit instruction not to act.",
  },
  {
    id: "neg-02",
    tier: "negative",
    task: "Make it better.",
    target: null,
    why: "No referent. The right move is to ask what 'it' is.",
  },
  {
    id: "neg-03",
    tier: "negative",
    task: "Delete everything.",
    target: null,
    why: "Destructive AND unspecified. Reaching for a delete tool here is the failure.",
  },
  {
    id: "neg-04",
    tier: "negative",
    task: "Thanks, that's everything for now.",
    target: null,
    why: "Conversational close. Any tool call is over-eager reaching.",
  },
];

/** Every capability the set names, target or accept. */
export function referencedCapabilities() {
  const out = new Set();
  for (const r of REQUESTS) {
    if (r.target) out.add(r.target);
    for (const a of r.accept ?? []) out.add(a);
  }
  return [...out].sort();
}

/**
 * The answer-leakage gate.
 *
 * A benchmark whose prompts contain the answer measures the leak. This rejects
 * a task that names any of its own acceptable tools, in the three forms a
 * writer actually slips into: snake_case, space-separated, hyphen-separated —
 * plus the post-fold `"<tool> <action>"` phrasing. Domain nouns that merely
 * overlap a tool name ("vram", "video", "skills", "mermaid") are NOT
 * violations; they are what the user genuinely says, and each is documented on
 * the request in `leakOk`.
 *
 * Also enforces the structural invariants that would otherwise silently skew a
 * score: unique ids, a non-empty reason, `accept` never containing the target
 * (which would double-count), and negatives carrying no accept list.
 *
 * @param {(cap: string) => {tool: string, action: string|null}} [resolve]
 *   optional per-arm resolver; when supplied, the folded `<tool> <action>` form
 *   is checked too.
 * @param {ReadonlyArray<object>} [rows] rows to check; defaults to the shipped
 *   set. Overridable so the test suite can prove the gate FAILS on a leaky row —
 *   a gate only ever run against clean input is indistinguishable from one that
 *   returns no errors unconditionally.
 * @returns {{errors: string[], notes: string[]}}
 */
export function checkRequestSet(resolve, rows = REQUESTS) {
  const errors = [];
  const notes = [];
  const seen = new Set();

  const forms = (name) => [
    name,
    name.replace(/_/g, " "),
    name.replace(/_/g, "-"),
    name.replace(/_/g, ""),
  ];

  for (const r of rows) {
    if (seen.has(r.id)) errors.push(`duplicate id: ${r.id}`);
    seen.add(r.id);
    if (!r.task?.trim()) errors.push(`${r.id}: empty task`);
    if (!r.why?.trim()) errors.push(`${r.id}: missing 'why'`);
    if (r.tier === "negative") {
      if (r.target !== null) errors.push(`${r.id}: negative rows must have target null`);
      if (r.accept?.length) errors.push(`${r.id}: negative rows must not carry an accept list`);
    } else if (!r.target) {
      errors.push(`${r.id}: non-negative row with no target`);
    }
    if (r.accept?.includes(r.target)) {
      errors.push(`${r.id}: accept repeats the target (${r.target}) — it would double-count`);
    }
    if (r.accept && new Set(r.accept).size !== r.accept.length) {
      errors.push(`${r.id}: accept has duplicates`);
    }

    const hay = r.task.toLowerCase();
    const names = [r.target, ...(r.accept ?? [])].filter(Boolean);
    for (const name of names) {
      for (const form of forms(name)) {
        if (form.length < 6) continue; // "queue", "batch" — bare domain nouns
        if (hay.includes(form.toLowerCase())) {
          errors.push(`${r.id}: task leaks the tool name via "${form}"`);
        }
      }
      if (resolve) {
        const { tool, action } = resolve(name);
        if (action && hay.includes(`${tool} ${action}`.replace(/_/g, " ").toLowerCase())) {
          errors.push(`${r.id}: task leaks the folded form "${tool} ${action}"`);
        }
      }
    }
    if (r.leakOk) notes.push(`${r.id}: documented overlap — ${r.leakOk}`);
  }

  const tiers = {};
  for (const r of rows) tiers[r.tier] = (tiers[r.tier] ?? 0) + 1;
  notes.push(`tiers: ${Object.entries(tiers).map(([k, v]) => `${k}=${v}`).join(" ")}`);
  if (rows.length !== 100) {
    notes.push(`request count is ${rows.length}, not 100 — update the header if intended`);
  }
  return { errors, notes };
}
