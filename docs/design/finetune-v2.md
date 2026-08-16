# Fine-tune 2.0 — a better in-house panel model, trained on the community's own successful sessions (plan / RFC)

**Status:** DRAFT — start-the-conversation RFC (branch `spec/finetune-v2`). Opens the discussion; **nothing here is built, no training is started by this PR.** · **Folds in:** [#642](https://github.com/artokun/comfyui-mcp/issues/642) (vision-retaining base) · **Builds on the existing `finetune-v2/` tree** (Heretic-Gemma-4 + Unsloth QLoRA + arena ladder) — this doc is the *design layer* that code never had, and it proposes some pointed changes to it.

> Living doc. Casual "run it by a smart friend" framing up top; concrete
> architecture, pipeline, and phases below. Opinionated on purpose — react to it.

---

> ### ⚠️ Freshness check — re-verified 2026-08-14 (written 2026-08-01)
>
> This RFC names external models and libraries, which go stale fast. Everything
> below was re-checked against live Ollama / GitHub listings on **2026-08-14**.
> Read this box before acting on §1 or §3.
>
> **Still true.** [#642](https://github.com/artokun/comfyui-mcp/issues/642) is
> **still open**; the shipped model is **still `artokun/gemma4-comfyui-mcp`**
> (`:e4b` default — see `docs/local-llms.mdx`); every in-repo anchor in the
> grounding table below still exists. **No part of this plan has been built** —
> Phases 0–5 are all unstarted (details in §7).
>
> **Corrected since writing** (all marked inline):
> - **One candidate does not exist as named.** `richardyoung/qwen3.6-14b-abliterated:agent`
>   is not a real model — see §1.
> - **`huihui_ai/Qwen3.6-abliterated` is vision-capable**, not text-only as the
>   original table claimed — which changes the Qwen shortlist.
> - **`huihui_ai/qwen3-coder-next-abliterated` is ~52 GB**, so it cannot serve as
>   the local "tool-only sibling" this doc proposes.
> - **The default lean is no longer safe to assert** on freshness grounds — the
>   proposed pick is the *oldest* build on the shortlist. See §1.
> - **distilabel and Argilla both lost their original maintainers.** Neither is
>   archived; neither is getting new features. See §3.
>
> Claims that could not be checked against a primary source are labelled
> **`[unverified]`** rather than guessed at.

---

## The pitch

We ship an in-house model (`artokun/gemma4-comfyui-mcp` in `e2b / e4b / 12b`)
whose entire job is to drive the panel: read live ComfyUI state, emit **correct
tool calls**, look at the image the panel hands back, confirm it matches the
ask. We get **a steady stream of complaints** about it. Two root causes stand
out from our own issue tracker and the current landscape:

1. **It's the wrong base for the workload.** The panel loop is (a) tool-calling
   and (b) *visual verification*. The current fine-tune is built on a
   **Heretic-abliterated Gemma 4** merge that **drops the vision + audio
   projector** ([#642](https://github.com/artokun/comfyui-mcp/issues/642)) — so
   the "panel specialist" is the one model that structurally **cannot look at
   its own renders**, while the generic `huihui_ai/gemma-4-abliterated` build of
   the same family, same size, same quant, *keeps* vision. And independent of
   vision: across 2026 write-ups, **Gemma-family tool-calling is consistently
   rated weaker than Qwen / Llama / Mistral**, while **Qwen 3 is repeatedly
   called the best local agent model of 2026** for clean, argument-complete tool
   calls. We may be optimizing the wrong horse.

2. **It's trained on synthetic self-play, not real successful work.** Today's
   dataset is TOUCAN-style synthesis against a mock/real MCP server plus arena
   trajectories. That's a fine bootstrap, but the best training signal in the
   world for "drive *this* panel well" is **real sessions where a strong model
   already drove this panel well** — and we have a fleet of community members
   running exactly that, with **Kimi K3** (our `moonshot` backend, the current
   frontier agentic coder) as the teacher. We should ask them, opt-in, for their
   **scrubbed successful transcripts**, distill those into the small local
   model, and close the loop.

So Fine-tune 2.0 is three moves at once:

- **Re-pick the base** from the current uncensored/abliterated field with
  tool-calling *and vision* as first-class criteria — Gemma 4 huihui vs Qwen 3,
  decided by our own arena ladder, not vibes.
- **Open a community transcript pipeline** — opt-in, consent-first, PII-scrubbed
  (reusing the scrubber we already ship), so "I chose Kimi K3 and it worked"
  becomes a training pair.
- **Make cleaning agentic** with a popular open-source curation framework
  (distilabel), and **gate every candidate** through an automated, extended
  version of the arena eval ladder before anything is published to Ollama.

artokun will hand-produce a few reference sessions first to nail the capture +
scrub + format contract before we ask anyone else to contribute.

This doc is deliberately opinionated so there's something to argue with. The
**default lean is a Qwen-3 pivot**, but the eval ladder gets the final vote.

---

## Where we are today (grounding — read before proposing changes)

This is not greenfield. The relevant machinery already exists; Fine-tune 2.0
mostly *re-points and extends* it.

> **Reviewer warning — half this table is not in the repo.** `/finetune-v2/` is
> **gitignored** (`.gitignore` L56, alongside `/finetune/` L55: "multi-GB, never
> committed"). It exists on the maintainer's machine — verified 2026-08-14, all
> files dated 2026-07-09, and every path cited below was confirmed present
> there — but **it is not on GitHub**, so a reviewer reading this PR in a browser
> cannot open `train_qlora.py`, `panel-arena.mjs`, `datagen/lib.mjs` or the
> `Modelfile.template` to check any claim made about them. Rows below are marked
> **(local-only)** where this applies. The tracked `scripts/arena-*.mjs` files are
> a *different, smaller* surface — do not confuse the two. Making the pipeline
> reviewable at all may be a prerequisite for the community phases (§2–§3), since
> contributors cannot match a format spec they cannot read.

| Concern | Lives in | Notes |
|---|---|---|
| Current recipe | **(local-only)** `finetune-v2/finetune/README.md`, `train/config.yaml`, `train/train_qlora.py` | TOUCAN-style synth → **Unsloth QLoRA** → arena → GGUF. Size ladder `e2b / e4b / 12b / 31b` on **Heretic-abliterated Gemma 4** (`coder3101/gemma-4-*-it-heretic`). LoRA r=32/α=32, 2 epochs, lr 2e-4, seq 16384, per-example tool-menu rendering. |
| Base was chosen by a bake-off | **(local-only)** `finetune-v2/finetune/README.md` (2026-07-04) | Heretic-12B scored 13/20, beat a manual huihui build at 6/20. **That bake-off predates #642 and did not weight vision** — a reason to re-run it. |
| Eval ladder | **(local-only)** `finetune-v2/finetune/arena/arena-scenarios.mjs` · **(tracked)** `scripts/arena-scenarios.mjs` | Tiered scenarios with harness-side `verify()` that **never trusts the model** (re-queries `/history`, reads PNG dims, polls `queue (action:"status")`). Tiers: **Base** (health/models/registry/queue/generate) → **Gauntlet** (precision/breakfix/provenance) → **Crucible** (multiout/pipeline). *Verified 2026-08-14: the tracked copy contains the Gauntlet tier; it has **no** VISION or FORMAT tier, and there is no `arena:gate` npm script — only `arena` (`scripts/llm-arena.mjs`). §5 is unbuilt.* |
| Verdict / gating | **(local-only)** `finetune-v2/finetune/arena/panel-arena.mjs` (~L335) | Per-run `PASS / PARTIAL / UNVERIFIED-OK / FAIL`; only `PASS`/`UNVERIFIED-OK` trajectories are harvested. Release gates: **100% parseable tool calls**, **beats stock `gemma4:12b`**, **no BFCL-v3 collapse vs base**. |
| Secret/PII scrubber | **(tracked)** `src/services/oauth-flow.ts` → **`redactTokens(s)`** (L68 — ✅ still exact) | Verified 2026-08-14. Covers `access_token`/`refresh_token`/`id_token`/`code`/`code_verifier`/`client_secret`/`token` key-value pairs, prefixed keys (`ghu_ gho_ ghp_ ya29. sk- xai-`), `Bearer …` and bare `token …` → `<redacted>`. Slightly *broader* than this doc originally claimed. Policy contract in `plugin/skills/report-bug/SKILL.md` Step 5. **Reuse this; do not build a new scrubber.** |
| "Session succeeded" signal | **(tracked)** `src/services/job-watcher.ts` → `CompletionNotification.status === "success"` (~~L36, built L132~~ → **now L38, built L150**) | Verified 2026-08-14 — type and `status: "success" \| "error" \| "interrupted"` unchanged; line numbers drifted. Derived from ComfyUI `execution_success` vs `execution_error` (`src/comfyui/events.ts`). Fanned out as `queue_status`/`lastCompleted` (`src/services/queue-status-broadcast.ts`). This is our ground-truth "the render actually happened." |
| Teacher routing | **(tracked)** `src/orchestrator/kimi-backend.ts`; `src/services/openai-provider-registry.ts` | Verified 2026-08-14: `moonshot` → default model **`kimi-k3`** (registry L141); `kimi` → **`kimi-for-coding`** (`KIMI_DEFAULT_MODEL`, L8–9). Both still exact. Registry provider ids are **`glm \| kimi \| moonshot \| minimax`** (L33) — note **there is no `xiaomi` backend**, which bears on open question #2. Teacher allowlist **(local-only)** `finetune-v2/finetune/datagen/lib.mjs` `ALLOWED_TEACHER_PREFIXES` (L18–25) = `deepseek/ z-ai/ moonshotai/ minimax/ xiaomi/ qwen/`; **blocks** `anthropic/ openai/ google/ x-ai/` for ToS. |
| Submission channel | **(tracked)** `src/tools/report-issue.ts` → `submitAndPoll()` (L127) | Verified 2026-08-14: `POST` to `comfyui-mcp-issue-worker.artokun.workers.dev` (L22), `X-Client-Key` gate (L175), `X-Triage-Async` marker (L187), polls `GET /status/<job_id>` (L234). Natural channel to extend for transcript upload. |
| **Not this** | `src/tools/train.ts`, `src/services/ai-toolkit.ts`, `docker/trainer/` | The `train_*` MCP tools are **image/LoRA (diffusion) training** (ostris ai-toolkit). Unrelated to the LLM fine-tune. Don't conflate. |

**Implication:** the teacher allowlist, the scrubber, the success signal, the
arena ladder, and an async submit-and-poll worker channel already exist. Fine-tune
2.0 is mostly *connective tissue + a base-model decision*, not a from-scratch build.

---

## 1. Base-model research (Aug 2026) — Gemma 4 huihui vs Qwen 3 vs the new field

The landscape moved since the 2026-07-04 bake-off. Verified against current
Ollama / HF listings and 2026 write-ups (sources at the bottom). **Hard
constraints:** must run local via Ollama; default tier fits a **24 GB 4090**;
smaller siblings (~4–9 GB) for wide adoption; **tool-calling is non-negotiable**;
**vision strongly preferred** (that's the #642 lesson).

### The field

**All rows re-verified against live listings 2026-08-14.** Capability strings in
quotes are the publisher's own chips, copied verbatim. "Updated" is the age the
listing reported on that date — it is the freshness signal the original draft
lacked, and it changes the recommendation.

| Model | Params / size | Vision | Tool-calling | Publisher | Updated | Notes for us |
|---|---|---|---|---|---|---|
| `huihui_ai/gemma-4-abliterated` `:e2b/:e4b/:12b/:26b/:31b`/**`:48b`** | 12b = 11.9B params · e2b ~4.6 GB · e4b ~5 GB · 12b ~8 GB · 31b ~17 GB · 26b MoE (4B active) | **Yes** | **Yes** | **huihui-ai** | **~2 mo** | ✅ Verified. Chips read **"vision tools thinking audio"** — so the vision *and* audio claim holds. **Correction: a `:48b` tier exists** that this doc omitted. Same family we ship, but the **vision-retaining** build (#642). **Freshest build on the shortlist.** |
| `coder3101/gemma-4-*-it-heretic` (current base) | matches size ladder | **No** (projector dropped) | Yes | Heretic method | — | ⚠️ **Correction: this is not an Ollama model.** `ollama.com/coder3101` and `.../coder3101/gemma-4-12b-it-heretic` both **404**; the weights live on **Hugging Face** (`coder3101/gemma-4-31B-it-heretic` confirmed). Per-tier siblings below 31B **[unverified]**. What we ship now — the #642 regression. |
| `huihui_ai/qwen3-abliterated`, `qwen3.5-abliterated` | 8B ~8 GB (Q4); 14B ~9 GB | text (base) | **Yes, strong** (Hermes `<tool_call>`, `qwen3_coder` parser) | **huihui-ai** | **[unverified]** | Qwen 3 8B = "best local agent model 2026", cleanest tool calls. |
| `huihui_ai/Qwen3.6-abliterated` `:27b/:35b` | 27b **17 GB** · 35b **24 GB** · 256K ctx | ⚠️ **Yes — correction** | **Yes** | **huihui-ai** | **~3 mo** | ⚠️ **This doc originally filed it as text-only. That was wrong.** Chips read **"vision tools thinking"**. It is the **newest vision+tools Qwen** available and belongs in the bake-off. Caveat: **no small sibling** — 17 GB is the floor, so it cannot serve the "~4–5 GB wide adoption" tier. |
| `huihui_ai/qwen3-vl-abliterated` `:2b/:4b/:8b/:30b/:32b` | 2b 1.9 GB · 4b 3.3 GB · **8b 6.1 GB** · 30b 20 GB · 32b 21 GB | **Yes** | **Yes** | huihui-ai | **~9 mo** ⚠️ | ✅ Exists; chips read **"vision tools thinking"**. Concrete tiers now filled in (the draft said only "~ VL tier"): `:8b` is the 4090 pick, `:4b` the wide-adoption sibling. **But it is the *oldest* build on this shortlist** — this is the doc's "default lean", and its freshness is now its weakest point. |
| ~~`richardyoung/qwen3.6-14b-abliterated:agent`~~ | — | — | — | — | — | ❌ **Does not exist as named — struck.** No `qwen3.6-14b` under that publisher. The real model is **`richardyoung/qwen3-14b-abliterated`** (Qwen**3**, not 3.6; tags `latest/IQ3_M/Q4_K_M/Q5_K_M/q8_0/iq4_xs`, 6.9–16 GB, updated ~8 mo), whose page lists input **"Text"** only — **no vision chip, no tools chip, and no `:agent` tag among its 6 tags**. Secondary write-ups assert an `:agent` tag; the model page does not show one **[unverified — treat the write-ups as wrong until the tag is seen]**. The draft's "concrete 14B vision+tools" row was mistaken on the name, the vision claim and the tag. |
| `huihui_ai/qwen3-coder-next-abliterated` | ⚠️ **q4_K ~52 GB** · q8_0 85 GB · fp16 159 GB · 256K ctx | text | **Yes (coder-tuned)** | huihui-ai | ~6 mo | ⚠️ **Correction: this blows the hard constraint.** At **~52 GB quantised** it does not fit a 24 GB 4090, let alone the ~4–9 GB adoption tier — so it **cannot be the local "tool-only sibling"** §1 and open question #4 propose. Either drop that proposal or name a different, smaller text-only model **[no verified replacement — do not substitute one without checking]**. |
| Llama-3.x-Groq-Tool-Use (8B/70B) | 8B ~5.7 GB | No | **Yes, top BFCL** (89–90%) **[unverified]** | Groq (not abliterated) | — | Reference ceiling for tool-calling; not uncensored. |

**Not surveyed, but our own docs recommend it:** `docs/local-llms.mdx` (L25)
names **Xiaomi MiMo-V2.5** (vision + tools + long context) as the mid-2026 pick
that "fits the full experience", and `xiaomi/` is already on the teacher
allowlist. The field survey above omits it entirely. Worth adding to the bake-off
before the base is decided — capabilities and sizes **[unverified here]**.

Kimi K3 itself (2.8T, multimodal, ~1M context) is **not** a local base — it's the
**teacher** (§3–4). *Re-checked 2026-08-14: K3 is real and frontier-class, but
the draft's "**the** current frontier agentic coder" now overstates it — on
Artificial Analysis' AA-Briefcase agentic benchmark it sits **2nd (1,527) behind
Fable 5 Max (1,587)**, and 2nd to Fable 5 on most real-world automation
benchmarks. The specific "Terminal-Bench 2.1 88.3" and the 2026-07-16 release
date are **[unverified]** — sources disagree on the date.* **This does not change
the teacher choice:** the stronger models are all on the ToS **blocklist**
(`anthropic/ openai/ google/ x-ai/`), so K3 remains the best *allowlisted*
teacher. Ranking is not the reason we picked it — licensing is.

### Reading of the evidence

- **Tool-calling quality** — the panel's #1 job — favors **Qwen 3**. Multiple
  independent 2026 evaluations say Gemma tool-calling is comparatively weak and
  Qwen 3 emits clean, argument-complete calls. This directly matches the
  *complaints* we get. ⚠️ *2026-08-14: those "evaluations" are blog round-ups,
  **[unverified]** and not re-checked this pass — and one of them was shown wrong
  on a checkable detail (see Appendix). Note also that `huihui_ai/gemma-4-abliterated`
  does advertise a `tools` capability chip. This bullet is the main argument for
  the Qwen pivot and it currently rests on the weakest sources in the doc.*
- **Vision** — the #642 lesson — is satisfiable in *both* families **if we pick
  the vision-retaining build**: `huihui_ai/gemma-4-abliterated` (retains
  proj.+audio) or `huihui_ai/qwen3-vl-abliterated` / Qwen3.6-14B-`:agent`.
- **Template fragility** — where past complaints actually bit (§4) — is a
  *format* problem, not a base problem, and is solvable for either family by
  **never hand-authoring the chat/tool template** (derive it from the base's
  stock Modelfile).
- **Abliteration doesn't cost us tool-calling** — both the current bake-off
  ("abliteration didn't hurt tool calling") and #642 corroborate. So "uncensored"
  and "good agent" are not in tension here.

### Recommended shortlist + default pick

> Framed as *start the conversation* — artokun is explicitly undecided
> Gemma-4-huihui vs Qwen 3 vs new. This is the lean, not the verdict; the arena
> ladder (§5) casts the deciding vote in a re-run bake-off.

> **⚠️ 2026-08-14 — the default lean no longer follows from the evidence.**
> The draft leaned Qwen partly on *recency*, but the freshness column added above
> inverts that: `qwen3-vl-abliterated` (**~9 mo**) is the **oldest** build on the
> shortlist, while the Gemma co-primary (**~2 mo**) is the newest, and
> `Qwen3.6-abliterated` (**~3 mo**) — which this doc wrongly filed as text-only —
> is a vision+tools Qwen that was never actually considered. **Treat "default
> lean: Qwen 3" as unsettled** until the bake-off runs; the three viable entrants
> are listed below. No verdict is asserted here.

- **Lean, now qualified → Qwen 3 (vision-capable), abliterated by huihui-ai.**
  Concretely: `huihui_ai/qwen3-vl-abliterated` at **`:8b`** (6.1 GB) for the 4090
  and **`:4b`** (3.3 GB) as the wide-adoption sibling — tiers verified 2026-08-14.
  Rationale as written: it wins on the panel's dominant axis (tool-calling) *and*
  clears #642 (vision), with a well-supported Ollama tool template. **Caveat: the
  build is ~9 months old**, so "from a maintained abliteration publisher" is the
  claim to re-check before committing — the publisher is active, but *this
  particular model* has not moved.
- **New entrant the draft missed → `huihui_ai/Qwen3.6-abliterated` `:27b`.**
  Vision + tools, 256K context, ~3 months old. The strongest *current* Qwen
  option. **Blocker:** at 17 GB it fits the 4090 but has **no small sibling**, so
  shipping it means either dropping the wide-adoption tier or pairing it with a
  different family for the small rungs.
- **Co-primary → `huihui_ai/gemma-4-abliterated` (vision-retaining).** If we stay
  Gemma, this is the build — it *directly fixes #642* by keeping the projector,
  reuses everything the current pipeline already knows about Gemma templates, and
  keeps the size ladder we've validated. The single change from today is
  **swap the Heretic base for the vision-retaining huihui base.**
- ~~**Tool-only sibling (optional) → `huihui_ai/qwen3-coder-next-abliterated`**~~
  ❌ **Withdrawn 2026-08-14 — it is ~52 GB quantised** and cannot run on the
  hardware this doc targets. The *use case* (users who opt out of sending pixels
  via the panel's "Blind" toggle and just want the strongest tool driver) is still
  legitimate; it needs a different, smaller model. **No verified replacement is
  proposed here** — picking one is now an open question, not a recommendation.

**Decision rule:** re-run the 2026-07-04 bake-off methodology on the arena ladder
(§5), this time **weighting vision-verification scenarios**. Given the
2026-08-14 corrections the head-to-head should be **three-way**, at the
e4b/12b-equivalent tiers:

1. `huihui_ai/qwen3-vl-abliterated:8b` — the draft's lean (oldest build)
2. `huihui_ai/gemma-4-abliterated:12b` — least pipeline churn, fixes #642 directly (newest build)
3. `huihui_ai/Qwen3.6-abliterated:27b` — newest vision+tools Qwen (no small sibling)

Ship whichever wins the extended ladder. The draft said "my money is on Qwen";
with the freshness and vision corrections above, **that prior is no longer
well-founded** — run the ladder and let the number decide.

---

## 2. Community transcript-collection pipeline (opt-in, consent-first)

Goal: turn "a community member ran the panel with Kimi K3 and it worked" into a
scrubbed training pair, **without ever auto-harvesting anything.**

### What counts as a "successful session"

Tie strictly to signals we already emit — no new "success" heuristic:

- **Atomic render success:** `CompletionNotification.status === "success"`
  (`src/services/job-watcher.ts`) — the render actually executed and produced
  outputs (derived from ComfyUI `execution_success`, not the model's say-so).
- **Session success:** the arena-style aggregate — the session reached a completed
  render (or the user's stated goal) with **no unrecovered `execution_error`**,
  and the agent used a **teacher backend on the allowlist** (`moonshot`/`kimi`).
  Sessions where the teacher hit a wall and gave up are *not* eligible.
- **Optional human confirm:** a one-tap "this session was good — contribute it?"
  in the panel, so the contributor, not a heuristic, has the final say.

Rejecting failed sessions matters: we're distilling *competence*, and negative
trajectories would teach the small model to imitate the teacher's give-ups.

### Consent / opt-in (never auto-harvest)

- **Off by default.** A panel setting **"Contribute successful sessions to the
  fine-tune dataset"** (three states: off / ask-each-time / on) — mirrors the
  existing image-feed "Blind" opt-out pattern, inverted to opt-*in*.
- **Per-session review before anything leaves the machine.** On an eligible
  session, the panel shows the **already-scrubbed** transcript for review with an
  explicit "Send" — same "scrub first, human confirms, then submit" shape as
  `report_issue`.
- **Teacher ToS respected by construction.** Only allowlisted teachers
  (`moonshotai/`, `kimi`) are eligible; Anthropic/OpenAI/Google/xAI transcripts
  are refused *before* the offer is even shown — reusing
  `ALLOWED_TEACHER_PREFIXES` / `isAllowedTeacher()` from
  `finetune-v2/finetune/datagen/lib.mjs`.
- **Provenance + revocability.** Each submission carries an opaque contributor
  token so a contributor can later request deletion of their contributions.

### The scrub step — reuse what we ship

**Do not build a new scrubber.** Two layers, both already in the repo:

1. **Client-side, before display/submit:** `redactTokens()` from
   `src/services/oauth-flow.ts` over the whole transcript (tool args, tool
   results, assistant text), plus the `report-bug/SKILL.md` Step-5 policy
   (home paths → `~/…`, strip `.env`/`Authorization:`/`?token=`/`?key=`). Extend
   `redactTokens` coverage if transcript-specific leaks show up (e.g. absolute
   output paths, civitai URLs) — but extend *that* function, don't fork it.
2. **Server-side backstop:** the issue-worker already runs a second secret-scrub
   pass; the transcript endpoint runs the same backstop before persistence. A
   submission that still trips the secret detector server-side is **dropped, not
   stored**.

### Submission path — extend the worker we already have

Reuse `report_issue`'s transport (`src/tools/report-issue.ts` `submitAndPoll()`):
same `X-Client-Key` anti-spam gate, same async submit→poll shape, a new
`X-Transcript-Contribution: 1` marker and a dedicated worker route (e.g.
`POST /contribute` on `comfyui-mcp-issue-worker`). The worker validates, runs the
backstop scrub, and writes to dataset storage. **No new client auth system.**

### Dataset storage & format

- **Storage:** an R2/object bucket behind the worker (private), one JSONL shard
  per accepted submission, keyed by contributor token + timestamp.
- **Format:** normalized to the training schema the existing pipeline already
  reads — the tool-schema-aware trajectory JSONL used by
  `finetune-v2/finetune/train/prepare_dataset.py` (system prompt + per-turn
  messages + tool calls/results, teacher-labeled). Capture the **complete
  assistant message including `reasoning_content`** for Kimi K3 (Moonshot's API
  requires the full message be replayed across tool turns — dropping it
  destabilizes multi-turn tool calls, so we must store it, not strip it).

### Bootstrap (artokun-first)

Before asking the community, artokun hand-produces a handful of Kimi-K3 panel
sessions to lock the contract end-to-end: capture → `redactTokens` scrub →
review UI → `/contribute` submit → worker backstop → JSONL shard → it loads
cleanly in `prepare_dataset.py`. Those few sessions become the **golden reference
shards** and the format spec everyone else's contributions must match. Only after
that round-trips do we surface the opt-in setting broadly.

---

## 3. Agentic data-cleaning — recommend **distilabel** (+ Argilla)

We need raw scrubbed transcripts turned into clean, deduped, correctly-formatted
tool-calling training pairs, curated by an LLM rather than by hand.

### Options considered

| Framework | What it's for | Agentic-LLM curation | Fit for us |
|---|---|---|---|
| **distilabel** (Argilla) | Synthetic data + AI-feedback pipelines: LLM generators **and LLM judges** as typed steps; MinHash dedup (datasketch); Argilla export for human review | **First-class** (LLM-as-judge is the core primitive) | **Best fit** — purpose-built for "LLM scores/dedupes/reformats into training pairs" |
| data-juicer 2.0 | 100+ composable cleaning/filtering operators, config recipes, cloud-scale, multimodal | Partial (recommendation agent) | Great for a **bulk heuristic pre-filter** pass; less "LLM curates" |
| NeMo-Curator | GPU-accelerated web-scale curation, dedup, privacy filtering | Minimal LLM integration | Overkill — built for 100 PB, not a boutique transcript set |
| DataFlow | Newer LLM-driven synthesis framework | High, but younger/less adopted | Watch, not base a pipeline on yet |

### Recommendation & justification

> **⚠️ 2026-08-14 — both halves of this recommendation lost their original
> maintainers.** Neither project is archived and neither is broken, but the
> "most widely adopted, actively developed" framing below is now too strong:
> - **distilabel** — README: *"The original authors have moved on to other
>   projects. A group of community members have recently joined the GitHub
>   project as collaborators to maintain the project and are actively working
>   towards the next release. Check out the `develop` branch for access to the
>   latest fixes."* Community-maintained; ~3.4k stars.
> - **Argilla** — README: *"The original authors have moved on to exciting new
>   projects! … While we won't be adding new features going forward, we're
>   committed to solve bug fixes and publish patches as needed."* Explicit
>   **maintenance mode, no new features**; ~5.1k stars.
>
> This does not invalidate the choice — a mature, stable, feature-frozen curation
> library is a defensible dependency for a boutique pipeline, and the primitives
> we need (LLM-as-judge, MinHash dedup, Argilla export) already exist and work.
> But **"most widely adopted OSS framework, actively developed" is no longer the
> reason to pick it**, and a reviewer should weigh the handover risk before this
> becomes load-bearing. The alternatives in the table above were **not**
> re-verified on 2026-08-14 **[unverified]** — if distilabel's community
> maintenance is judged too thin, that comparison needs redoing, not guessing.

**distilabel as the agentic cleaning backbone, Argilla as the human-in-the-loop
review UI, with an optional data-juicer heuristic pre-pass.** Why:

- distilabel's core primitive is exactly what we need — an **LLM-as-judge** step
  that scores each candidate trajectory and keeps only top-K, plus **MinHash
  dedup** out of the box. It is widely adopted and HF-integrated. *(The draft
  called it "the most widely adopted … actively developed" — see the maintenance
  note above; the primitives are what justify it now, not the momentum.)*
- Argilla gives us the **review surface** the opt-in pipeline wants anyway — a
  place to spot-check contributed transcripts before they train anything.
- It composes cleanly with our reality: contributions arrive as JSONL shards;
  distilabel Steps map over them.

### The agentic cleaning flow

```
raw scrubbed shards (from §2)
  └─(optional) data-juicer heuristic pre-pass: dedupe exact/near dupes,
     drop empty/degenerate turns, language/format filters
  └─ distilabel pipeline (LLM-curated):
       1. SCRUB-VERIFY judge  — LLM confirms no residual PII/secret survived
                                 the code scrubber; quarantine on any hit
       2. SUCCESS judge       — LLM confirms the trajectory truly solved the
                                 stated task (guards against false "success"
                                 that slipped the run-completion filter)
       3. TOOL-CALL-FORMAT normalizer — reshape every tool call/result into the
                                 chosen base model's exact tool schema/template;
                                 drop malformed calls (this is where format bugs die)
       4. QUALITY judge (LLM-as-judge, reward score) — dedupe via MinHash,
                                 rank, keep top-K, discard bottom percentile
       5. Argilla export      — human spot-review of a sampled slice
  └─ curated train/val JSONL → prepare_dataset.py (existing)
```

Steps 1–2 are the cleanup safety net; step 3 is the one that fixes the historical
"wrong tool template" complaints *in the data*; step 4 is quality/dedup.

---

## 4. Model generation with model-appropriate Ollama syntax

Where prior in-house models drew complaints. **The rule: never hand-author the
chat/tool template — derive it from the base model's stock Modelfile.**

### Training

- **Method:** LoRA/QLoRA via **Unsloth**, reusing `finetune-v2/finetune/train/`
  (`train_qlora.py`, `config.yaml`). No full fine-tune — LoRA keeps the size
  ladder cheap and preserves the base's (now vision-capable) behavior.
- **Preserve the projector.** The #642 fix is a *training* discipline: fine-tune
  on top of the **vision-retaining** base and **do not merge/drop the multimodal
  projector**. Publish `capabilities` including `vision` so hosts route correctly.
- **Hardware.** The in-repo config targets rented A100/H200-class GPUs for the
  full ladder; the **24 GB 4090** covers the small/e-tier LoRA runs locally.
  (There's a WSL2-4090 recipe referenced in an external plan file, not in-tree —
  **open question: pull that recipe into the repo** so local runs are reproducible.)

### Correct Ollama Modelfile + tool TEMPLATE (the part that must not be fumbled)

Generalize the rule already written in `finetune-v2/finetune/package/Modelfile.template`:

- **Capture, don't compose.** Get the base model's exact template from its stock
  Modelfile (`ollama show <base> --modelfile`) and use the model-family
  **RENDERER/PARSER**, never a hand-written `TEMPLATE`. For Gemma:
  `RENDERER gemma4` / `PARSER gemma4`. For Qwen 3: the Hermes/`qwen3`
  renderer+parser that handle `<tool_call>` XML — Ollama ships native Qwen 3
  tool parsing; use it, don't reinvent the `<tool_call>` grammar by hand.
- **Per-family Modelfile templates** checked into `finetune-v2/finetune/package/`
  (`Modelfile.gemma4`, `Modelfile.qwen3`), each pinning `num_ctx` (currently
  65536), `temperature 0`, and the captured renderer/parser for that family.
- **A gate that proves tool calls parse** before publish — see §5's
  "100% parseable" gate. The template is only "done" when the eval harness emits
  and re-parses tool calls with zero malformed calls.

Output: per-tier GGUF (Q4_K_M) + matching Modelfile, published to
`artokun/<family>-comfyui-mcp:<tier>` with honest `capabilities`.

---

## 5. Automated eval suite — extend the arena ladder into a release gate

Extend, don't reinvent, `finetune-v2/finetune/arena/arena-scenarios.mjs`. The
existing harness already re-verifies against the live server; we add
vision + regression + teacher-parity and wire it as an automated gate.

### Scenario tiers (existing + new)

- **Base / Gauntlet / Crucible** — keep as-is (health, models, registry, queue,
  generate; precision, breakfix, provenance; multiout, pipeline).
- **New — VISION tier (the #642-driven addition):** scenarios that are
  *unpassable without looking*: "generate, then confirm the image matches the
  ask before declaring success"; `debug-render` (tap a wire with `PreviewImage`,
  run-to-node, report what's actually in the intermediate); reject-and-retry when
  the render doesn't match. A vision-blind model must **fail** these — which is
  exactly the signal #642 says we're missing today.
- **New — FORMAT tier:** adversarial tool-call scenarios (nested args, optional
  params, multi-call turns) whose only pass condition is **every emitted tool
  call parses and round-trips** under the model's Ollama parser.

### Metrics + pass thresholds (release gate)

A candidate is **blocked from publish** unless it clears all of:

| Gate | Threshold | Source of truth |
|---|---|---|
| **Tool-call parse rate** | **100%** parseable/round-trippable | FORMAT tier + harness parser |
| **Arena PASS rate** | **≥ stock base** on full ladder, and **> current `gemma4-comfyui-mcp`** at same tier | server-verified `verify()` |
| **Vision-verification** | **passes** VISION tier (blind model fails by design) | `verify()` + image checks |
| **Teacher parity** | within **X%** of **Kimi K3** PASS rate on the ladder (X = open decision, propose 15%) | same harness vs `moonshot`/`kimi-k3` |
| **No capability collapse** | no regression on a **BFCL-v3 subset** vs the abliterated base | BFCL subset |
| **No refusal regression** | uncensored behavior preserved (abliteration intact) | small refusal probe set |

Regression baselines to run every candidate against, automatically: **stock
base**, **current shipped `gemma4-comfyui-mcp:<tier>`**, and **Kimi K3 teacher**
(the ceiling). Wire it as a script (`arena:gate`) that exits non-zero on any
failed gate, so "publish" is mechanically blocked on a red ladder.

---

## 6. Phasing + open questions

### Build status — re-checked 2026-08-14

**Nothing in this plan has been built.** Every phase below is still open; no part
of it needs to be re-scoped as "already shipped". Evidence:

| Phase | Status | Evidence (verified 2026-08-14) |
|---|---|---|
| 0 — Bootstrap & contract | **Not started** | No golden reference shards; no `/contribute` path anywhere in `src/`. |
| 1 — Base bake-off | **Not started** | Shipped model is still `artokun/gemma4-comfyui-mcp` (`:e4b` default, `:e2b`, `:12b`) per `README.md` L657, `docs/local-llms.mdx` L257–259 and `locales/*/main.json` L157. No re-based build exists. |
| 2 — Community pipeline | **Not started** | No transcript/contribution setting, no `X-Transcript-Contribution` marker, no `/contribute` worker route in the repo. |
| 3 — Agentic cleaning | **Not started** | No distilabel/Argilla dependency or pipeline in the repo. |
| 4 — Train & gate | **Not started** | `scripts/arena-scenarios.mjs` has the Gauntlet tier but **no VISION or FORMAT tier**; the only arena npm script is `arena` → `scripts/llm-arena.mjs`. **No `arena:gate` exists.** |
| 5 — Iterate | **Not started** | — |

**The driving issue is also still open:** [#642](https://github.com/artokun/comfyui-mcp/issues/642)
(`enhancement`, `severity:P3`, `models`, `via-panel`) — last updated 2026-08-03,
**not closed**. So the premise of §1 still holds: the model we ship today still
cannot see its own renders.

Note also that the repo is under a **feature freeze** (stabilisation first), which
is the likeliest reason none of this has moved — not a judgement on the plan.

### Phasing

- **Phase 0 — Bootstrap & contract (artokun).** Hand-produce a few Kimi-K3 panel
  sessions; lock capture → `redactTokens` → review → `/contribute` → worker
  backstop → JSONL; land the golden reference shards + format spec. *No base
  decision needed yet.*
- **Phase 1 — Base bake-off.** Extend the arena ladder with the VISION + FORMAT
  tiers; re-run the head-to-head (`qwen3-vl-abliterated` vs vision-retaining
  `gemma-4-abliterated`) weighting vision. **Output: the base decision.**
- **Phase 2 — Community pipeline.** Ship the opt-in setting + review UI + worker
  `/contribute` route + dataset bucket. Announce; start collecting.
- **Phase 3 — Agentic cleaning.** Stand up the distilabel (+Argilla, +optional
  data-juicer) pipeline; produce the first curated train/val from contributed +
  synthetic data.
- **Phase 4 — Train & gate.** LoRA the chosen base per tier; build per-family
  Modelfiles; run `arena:gate`; publish only on a green ladder.
- **Phase 5 — Iterate.** Contributions keep flowing; periodic re-train; watch for
  drift; re-open the base question when the field moves again.

### Open questions for the community (react here)

1. **Base:** now a **three-way** question (updated 2026-08-14) — `qwen3-vl-abliterated:8b`
   (the original lean, but the oldest build), vision-retaining
   `gemma-4-abliterated:12b` (fixes #642 with least pipeline churn, newest build),
   or `Qwen3.6-abliterated:27b` (newest vision+tools Qwen, but no small sibling)?
   And should **Xiaomi MiMo-V2.5** — which our own `docs/local-llms.mdx` already
   recommends — be entered too? The ladder decides; which do you *want* to win?
2. **Teacher parity threshold:** how close to Kimi K3 must a candidate be to
   ship (proposed within 15%)? And do we allow other allowlisted teachers
   (`glm`, `minimax`, `xiaomi`) to contribute too, or Kimi-only for consistency?
   *Note: `xiaomi/` is on the datagen allowlist but there is **no `xiaomi`
   backend** in `OPENAI_KEY_PROVIDERS` (`glm | kimi | moonshot | minimax`), so
   allowing it as a teacher means shipping a backend first.*
3. **Contribution incentive & trust:** what makes contributors comfortable
   sending transcripts — the double-scrub + review UI + revocable token, or do we
   need more (e.g. fully local pre-review, published dataset transparency,
   contributor credit)? How do we keep low-quality/poisoned contributions out
   beyond the LLM judges (§3)?
4. **Vision cost:** do we ship vision on *every* tier, or a vision tier + a
   tool-only sibling for the "Blind" crowd? *(Updated 2026-08-14: the proposed
   sibling `qwen3-coder-next-abliterated` is ~52 GB and is withdrawn — if we want
   this tier, **which small text-only model?** Unanswered.)*
5. **WSL2-4090 recipe:** pull the external local-training recipe into the repo so
   community members can reproduce small-tier LoRA runs on consumer GPUs?
6. **New (2026-08-14) — does `/finetune-v2/` need to become reviewable?** It is
   gitignored, so the training code, arena harness, teacher allowlist and
   Modelfile template that this plan builds on are invisible to everyone but the
   maintainer. Phases 2–3 ask outsiders to match a format spec they cannot read.
   Do we commit the code (excluding the multi-GB artifacts that motivated the
   ignore), publish it separately, or keep the community role limited to
   *submitting* transcripts and not inspecting the pipeline?

---

## Appendix — sources (Aug 2026)

> **Verification note (2026-08-14).** The Ollama model pages below were re-fetched
> and their capability chips / tag lists copied verbatim into §1 — those are
> primary sources and are reliable. The **blog-style "best model of 2026"
> round-ups** (locallyuncensored, dev.to, localaimaster, insiderllm, lushbinary)
> were **not** re-verified, and at least one secondary source was **contradicted**
> by a primary page this pass: write-ups describing an `:agent` tag on
> `richardyoung/qwen3-14b-abliterated` are not borne out by the model page.
> Treat the ranking claims sourced from those round-ups — including "Gemma
> tool-calling is weaker than Qwen" and "Qwen 3 8B is the best local agent model
> of 2026", which are load-bearing for §1's argument — as **[unverified]**. The
> bake-off (§5) exists precisely so we don't have to trust them.

- Issue [#642](https://github.com/artokun/comfyui-mcp/issues/642) — vision/audio dropped by the current fine-tune; huihui base retains it.
- huihui-ai abliterated models (Ollama): [`gemma-4-abliterated`](https://ollama.com/huihui_ai/gemma-4-abliterated), [`qwen3-abliterated`](https://ollama.com/huihui_ai/qwen3-abliterated), [`qwen3.5-abliterated`](https://ollama.com/huihui_ai/qwen3.5-abliterated), [`qwen3-vl-abliterated`](https://ollama.com/huihui_ai/qwen3-vl-abliterated), [`qwen3-coder-next-abliterated`](https://ollama.com/huihui_ai/qwen3-coder-next-abliterated), [`Qwen3.6-abliterated`](https://ollama.com/huihui_ai/Qwen3.6-abliterated).
- Abliterated model guides: [Abliterated Models 2026 by VRAM (locallyuncensored)](https://locallyuncensored.com/blog/abliterated-models-guide.html), [Abliterated Models Guide (dev.to)](https://dev.to/purpledoubled/abliterated-models-guide-qwen-36-gemma-4-heretic-llama-31-uncensored-download-links-1f4e).
- Tool-calling comparisons: [Best Ollama Models for AI Agents 2026 (Local AI Master)](https://localaimaster.com/blog/best-ollama-models-for-agents), [Best Local LLMs for Tool & Function Calling 2026 (Local AI Master)](https://localaimaster.com/blog/best-ollama-models-tool-calling), [Function Calling Local LLMs: Qwen 3.6, Gemma 4 (InsiderLLM)](https://insiderllm.com/guides/function-calling-local-llms/), [Hermes Agent + Gemma 4 & Qwen 3.5 (Lushbinary)](https://lushbinary.com/blog/hermes-agent-gemma-4-qwen-3-5-local-ai-guide/).
- Kimi K3 (teacher): [Simon Willison](https://simonwillison.net/2026/Jul/16/kimi-k3/), [Northflank self-hosting](https://northflank.com/blog/what-is-kimi-k3-self-hosting), [CometAPI benchmarks](https://www.cometapi.com/what-is-kimi-k3-benchmarks-capabilities-access-guide-in-2026/).
- Data cleaning: [distilabel (GitHub)](https://github.com/argilla-io/distilabel), [distilabel docs](https://distilabel.argilla.io/latest/), [Clean a dataset with LLMs-as-judges (HF cookbook)](https://huggingface.co/learn/cookbook/clean_dataset_judges_distilabel), [Data-Juicer 2.0](https://arxiv.org/html/2501.14755v2), [NeMo Curator](https://developer.nvidia.com/nemo-curator), [Synthetic data pipelines: distilabel/Augmentoolkit/Nemotron (Spheron)](https://www.spheron.network/blog/synthetic-data-generation-pipelines-gpu-cloud-distilabel-augmentoolkit-nemotron/).
