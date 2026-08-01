# Fine-tune 2.0 — a better in-house panel model, trained on the community's own successful sessions (plan / RFC)

**Status:** DRAFT — start-the-conversation RFC (branch `spec/finetune-v2`). Opens the discussion; **nothing here is built, no training is started by this PR.** · **Folds in:** [#642](https://github.com/artokun/comfyui-mcp/issues/642) (vision-retaining base) · **Builds on the existing `finetune-v2/` tree** (Heretic-Gemma-4 + Unsloth QLoRA + arena ladder) — this doc is the *design layer* that code never had, and it proposes some pointed changes to it.

> Living doc. Casual "run it by a smart friend" framing up top; concrete
> architecture, pipeline, and phases below. Opinionated on purpose — react to it.

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

| Concern | Lives in | Notes |
|---|---|---|
| Current recipe | `finetune-v2/finetune/README.md`, `train/config.yaml`, `train/train_qlora.py` | TOUCAN-style synth → **Unsloth QLoRA** → arena → GGUF. Size ladder `e2b / e4b / 12b / 31b` on **Heretic-abliterated Gemma 4** (`coder3101/gemma-4-*-it-heretic`). LoRA r=32/α=32, 2 epochs, lr 2e-4, seq 16384, per-example tool-menu rendering. |
| Base was chosen by a bake-off | `finetune-v2/finetune/README.md` (2026-07-04) | Heretic-12B scored 13/20, beat a manual huihui build at 6/20. **That bake-off predates #642 and did not weight vision** — a reason to re-run it. |
| Eval ladder | `finetune-v2/finetune/arena/arena-scenarios.mjs` (+ `scripts/arena-scenarios.mjs`) | Tiered scenarios with harness-side `verify()` that **never trusts the model** (re-queries `/history`, reads PNG dims, polls `get_job_status`). Tiers: **Base** (health/models/registry/queue/generate) → **Gauntlet** (precision/breakfix/provenance) → **Crucible** (multiout/pipeline). |
| Verdict / gating | `finetune-v2/finetune/arena/panel-arena.mjs` (~L335) | Per-run `PASS / PARTIAL / UNVERIFIED-OK / FAIL`; only `PASS`/`UNVERIFIED-OK` trajectories are harvested. Release gates: **100% parseable tool calls**, **beats stock `gemma4:12b`**, **no BFCL-v3 collapse vs base**. |
| Secret/PII scrubber | `src/services/oauth-flow.ts` → **`redactTokens(s)`** (L68) | Covers `access_token`/`refresh_token`/`client_secret`/`Bearer …`/prefixed keys (`ghp_ ya29. sk- xai-`) → `<redacted>`. Policy contract in `plugin/skills/report-bug/SKILL.md` Step 5. **Reuse this; do not build a new scrubber.** |
| "Session succeeded" signal | `src/services/job-watcher.ts` → `CompletionNotification.status === "success"` (L36, built L132) | Derived from ComfyUI `execution_success` vs `execution_error` (`src/comfyui/events.ts`). Fanned out as `queue_status`/`lastCompleted` (`src/services/queue-status-broadcast.ts`). This is our ground-truth "the render actually happened." |
| Teacher routing | `src/orchestrator/kimi-backend.ts`; `src/services/openai-provider-registry.ts` (`OPENAI_KEY_PROVIDERS`, L74) | `moonshot` → default model **`kimi-k3`**; `kimi` → `kimi-for-coding`. Teacher allowlist already exists in datagen: `finetune-v2/finetune/datagen/lib.mjs` `ALLOWED_TEACHER_PREFIXES` includes `moonshotai/`; **blocks** `anthropic/ openai/ google/ x-ai/` for ToS. |
| Submission channel | `src/tools/report-issue.ts` → `submitAndPoll()` | `POST` to `comfyui-mcp-issue-worker.artokun.workers.dev`, `X-Client-Key` gate, `X-Triage-Async` marker, poll `GET /status/<job_id>`. Natural channel to extend for transcript upload. |
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

| Model (Ollama) | Params / size @ Q4_K_M | Vision | Tool-calling | Abliteration & publisher | Notes for us |
|---|---|---|---|---|---|
| `huihui_ai/gemma-4-abliterated` `:e2b/:e4b/:12b/:26b/:31b` (+`-qat`) | e2b ~4.6 GB · e4b ~5 GB · 12b ~8 GB · 31b ~17 GB · 26b MoE (4B active) | **Yes** (proj. retained) + audio | Yes (`<tool_call>` XML) | **huihui-ai** (abliteration) | Same family we ship, but the **vision-retaining** build (#642). Gemma tool-calling rated *weaker* than Qwen. |
| `coder3101/gemma-4-*-it-heretic` (current base) | matches size ladder | **No** (projector dropped) | Yes | Heretic method | What we ship now — the #642 regression. |
| `huihui_ai/qwen3-abliterated`, `qwen3.5-abliterated`, `Qwen3.6-abliterated` | 8B ~8 GB (Q4); 14B ~9 GB; 27B/35B-A3B MoE larger | text (base) | **Yes, strong** (Hermes `<tool_call>`, `qwen3_coder` parser) | **huihui-ai** | Qwen 3 8B = "best local agent model 2026", cleanest tool calls. |
| `huihui_ai/qwen3-vl-abliterated` | ~ VL tier | **Yes** | Yes | huihui-ai | Vision **and** strong tool-calling in one family — the both-worlds option. |
| `richardyoung/qwen3.6-14b-abliterated:agent` | ~9 GB, fits 12 GB | **Yes** | Yes (`:agent` tag) | community | Concrete 14B vision+tools that fits mid-range cards. |
| `huihui_ai/qwen3-coder-next-abliterated` | coder tier | text | **Yes (coder-tuned)** | huihui-ai | Strongest raw tool/coding, no vision — a "tool-only sibling" candidate. |
| Llama-3.x-Groq-Tool-Use (8B/70B) | 8B ~5.7 GB | No | **Yes, top BFCL** (89–90%) | Groq (not abliterated) | Reference ceiling for tool-calling; not uncensored. |

Kimi K3 itself (2.8T, released 2026-07-16, frontier agentic — Terminal-Bench 2.1
88.3) is **not** a local base — it's the **teacher** (§3–4).

### Reading of the evidence

- **Tool-calling quality** — the panel's #1 job — favors **Qwen 3**. Multiple
  independent 2026 evaluations say Gemma tool-calling is comparatively weak and
  Qwen 3 emits clean, argument-complete calls. This directly matches the
  *complaints* we get.
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

- **Default lean → Qwen 3 (vision-capable), abliterated by huihui-ai.**
  Concretely: `huihui_ai/qwen3-vl-abliterated` (or Qwen3.5) at a **~8–9B** default
  tier for the 4090, a **~4–5B** small sibling for wide adoption, and optionally a
  **larger MoE** for headroom. Rationale: it wins on the panel's dominant axis
  (tool-calling) *and* clears #642 (vision), from a maintained abliteration
  publisher, with a well-supported Ollama tool template.
- **Co-primary → `huihui_ai/gemma-4-abliterated` (vision-retaining).** If we stay
  Gemma, this is the build — it *directly fixes #642* by keeping the projector,
  reuses everything the current pipeline already knows about Gemma templates, and
  keeps the size ladder we've validated. The single change from today is
  **swap the Heretic base for the vision-retaining huihui base.**
- **Tool-only sibling (optional) → `huihui_ai/qwen3-coder-next-abliterated`** for
  users who explicitly opt out of sending pixels (the panel's "Blind" toggle) and
  just want the strongest tool driver.

**Decision rule:** re-run the 2026-07-04 bake-off methodology on the arena ladder
(§5), this time **weighting vision-verification scenarios**, head-to-head:
`qwen3-vl-abliterated` vs `huihui gemma-4-abliterated` at the e4b/12b-equivalent
tiers. Ship whichever wins the extended ladder; my money is on Qwen, but the
number decides.

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

**distilabel as the agentic cleaning backbone, Argilla as the human-in-the-loop
review UI, with an optional data-juicer heuristic pre-pass.** Why:

- distilabel's core primitive is exactly what we need — an **LLM-as-judge** step
  that scores each candidate trajectory and keeps only top-K, plus **MinHash
  dedup** out of the box. It's the most widely adopted OSS framework for this,
  HF-integrated, "based on verified research papers."
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

1. **Base:** Qwen 3 (my lean — best tool-calling + vision via `qwen3-vl`) or
   vision-retaining Gemma 4 huihui (fixes #642 with least pipeline churn)? The
   ladder decides — but which do you *want* to win?
2. **Teacher parity threshold:** how close to Kimi K3 must a candidate be to
   ship (proposed within 15%)? And do we allow other allowlisted teachers
   (`glm`, `minimax`, `xiaomi`) to contribute too, or Kimi-only for consistency?
3. **Contribution incentive & trust:** what makes contributors comfortable
   sending transcripts — the double-scrub + review UI + revocable token, or do we
   need more (e.g. fully local pre-review, published dataset transparency,
   contributor credit)? How do we keep low-quality/poisoned contributions out
   beyond the LLM judges (§3)?
4. **Vision cost:** do we ship vision on *every* tier, or a vision tier + a
   tool-only sibling (`qwen3-coder-next-abliterated`) for the "Blind" crowd?
5. **WSL2-4090 recipe:** pull the external local-training recipe into the repo so
   community members can reproduce small-tier LoRA runs on consumer GPUs?

---

## Appendix — sources (Aug 2026)

- Issue [#642](https://github.com/artokun/comfyui-mcp/issues/642) — vision/audio dropped by the current fine-tune; huihui base retains it.
- huihui-ai abliterated models (Ollama): [`gemma-4-abliterated`](https://ollama.com/huihui_ai/gemma-4-abliterated), [`qwen3-abliterated`](https://ollama.com/huihui_ai/qwen3-abliterated), [`qwen3.5-abliterated`](https://ollama.com/huihui_ai/qwen3.5-abliterated), [`qwen3-vl-abliterated`](https://ollama.com/huihui_ai/qwen3-vl-abliterated), [`qwen3-coder-next-abliterated`](https://ollama.com/huihui_ai/qwen3-coder-next-abliterated), [`Qwen3.6-abliterated`](https://ollama.com/huihui_ai/Qwen3.6-abliterated).
- Abliterated model guides: [Abliterated Models 2026 by VRAM (locallyuncensored)](https://locallyuncensored.com/blog/abliterated-models-guide.html), [Abliterated Models Guide (dev.to)](https://dev.to/purpledoubled/abliterated-models-guide-qwen-36-gemma-4-heretic-llama-31-uncensored-download-links-1f4e).
- Tool-calling comparisons: [Best Ollama Models for AI Agents 2026 (Local AI Master)](https://localaimaster.com/blog/best-ollama-models-for-agents), [Best Local LLMs for Tool & Function Calling 2026 (Local AI Master)](https://localaimaster.com/blog/best-ollama-models-tool-calling), [Function Calling Local LLMs: Qwen 3.6, Gemma 4 (InsiderLLM)](https://insiderllm.com/guides/function-calling-local-llms/), [Hermes Agent + Gemma 4 & Qwen 3.5 (Lushbinary)](https://lushbinary.com/blog/hermes-agent-gemma-4-qwen-3-5-local-ai-guide/).
- Kimi K3 (teacher): [Simon Willison](https://simonwillison.net/2026/Jul/16/kimi-k3/), [Northflank self-hosting](https://northflank.com/blog/what-is-kimi-k3-self-hosting), [CometAPI benchmarks](https://www.cometapi.com/what-is-kimi-k3-benchmarks-capabilities-access-guide-in-2026/).
- Data cleaning: [distilabel (GitHub)](https://github.com/argilla-io/distilabel), [distilabel docs](https://distilabel.argilla.io/latest/), [Clean a dataset with LLMs-as-judges (HF cookbook)](https://huggingface.co/learn/cookbook/clean_dataset_judges_distilabel), [Data-Juicer 2.0](https://arxiv.org/html/2501.14755v2), [NeMo Curator](https://developer.nvidia.com/nemo-curator), [Synthetic data pipelines: distilabel/Augmentoolkit/Nemotron (Spheron)](https://www.spheron.network/blog/synthetic-data-generation-pipelines-gpu-cloud-distilabel-augmentoolkit-nemotron/).
