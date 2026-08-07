# Tool-reach benchmark

100 realistic user requests against the consolidated **37-tool** surface, to answer the
question the 0.50.0 consolidation raises: *folding 154 tools into 37 makes the list
easier to hold in a context window — but can an agent still reach the RIGHT one?*

`tool-reach.jsonl` — one request per line:

```json
{"id":17,"request":"Find me a good anime LoRA","expect":"search_custom_nodes",
 "alt":["download_model"],"why":"AMBIGUOUS: model search vs node search"}
```

`expect` is the tool I judge correct. `alt` lists tools a reasonable agent could pick
instead — its presence is the interesting signal, not a scoring detail.

## Coverage (checked, not asserted)

- 100 rows; **every one of the 37 tools is exercised at least once** (no blind spots);
- every `expect` value exists in the live `TOOL_NAMES` — the corpus cannot silently rot
  against a rename, because the check fails loudly;
- 11 rows carry an `alt`; 7 are explicitly flagged AMBIGUOUS or CONTROL.

## How to run an arm

Give a model ONLY the 37 tool names + descriptions and each `request`, ask which single
tool it would call first, and compare to `expect`. Treat a hit on `alt` as a partial,
not a miss — those rows are ambiguous **by construction** and are there to measure the
ambiguity, not the model.

## Why my own arm is weak evidence, and what to trust instead

I wrote both the requests and the answer key, so scoring myself measures agreement with
my own intuitions. It is not blind and should not be quoted as an accuracy number. The
corpus exists so the **Kimi and local-Ollama arms are blind** — those are the real test,
and the comparison across model sizes is the point (does a 4B model still land the right
tool with 37 choices, where it could not with 154?).

## What the ambiguity map already shows

Three gaps surfaced while building the corpus. None is a consolidation regression — each
is a request users make that the 37-tool surface has no clean home for:

1. **No error/log retrieval.** *"Show the last error from the server"* (#86), *"my image
   came out black"* (#77). An agent's best move is `get_history`, which is not what was
   asked. Everything else routes through a live panel session.
2. **"Which models is this workflow missing?"** (#92) needs a join of `get_workflow` and
   `list_local_models`, done by hand every time. It is one of the most common real
   questions and has no single tool.
3. **Capability discovery.** *"What can you do?"* (#100) has no answer in the surface —
   `list_packs` is the nearest and is about packs, not capabilities.

Separately, **live-canvas editing is deliberately absent from these 37** (#75, #76):
adding a node or setting a widget on the open canvas is a `panel_*` tool. That is by
design, but it means an agent holding only the core surface cannot edit a graph, and the
descriptions do not say so — a caller reaching for `create_workflow` to "change the seed
on my sampler" is being sent to build a new workflow instead of editing the open one.
