// Per-MODEL tool-mode selection (issue #788).
//
// Compact tool mode -- an on-demand router in front of the catalog -- has
// existed since #97 and became the DEFAULT in #667. #788's original
// complaint — "a small local model gets the full surface and nobody tells you
// --compact exists" — is therefore already half-answered: nothing gets the full
// surface by accident any more. What is still missing, and what this module
// adds, is the OTHER direction and the visibility:
//
//   • a large local model is needlessly held behind the router,
//   • an explicit user choice must win in BOTH directions,
//   • and whichever mode is active must be SAID, not inferred.
//
// The issue's binding constraint: key it on the MODEL, not the provider.
// "Ollama ⇒ compact" is wrong both ways — a 70B local model handles the full
// surface, and some small hosted models would benefit from compact. So the
// signal here is the parameter count carried in the model id, with an explicit
// documented fallback when there isn't one.
//
// Deliberately NOT keyed on the tool COUNT or on any list of tool names: the
// ~30-tool consolidation (#726) rewrites both, and a policy that hard-codes
// either would silently become wrong the day it lands. Callers that want to
// SHOW the surface size read it from the live catalog and append it themselves.

import type { ToolMode } from "../transport/cli.js";

/**
 * Smallest parameter count (in billions) at which a model is given the FULL
 * tool surface by default.
 *
 * 70 is not a tuned number and is not presented as one — it is the only figure
 * anyone has actually asserted about this axis (#788: "a 70B local model
 * handles the full surface fine and would be needlessly crippled"). The other
 * end is #97's qwen3:4b, which needed compact. Everything between is untested,
 * so the default promotes only what we have a claim for and leaves the rest on
 * today's behaviour — no regression, and no invented capability curve.
 *
 * `COMFYUI_MCP_FULL_SURFACE_MIN_PARAMS_B` moves it, so someone with a 32B can
 * try the full surface without patching the source (and can tell us where it
 * actually falls off — see #792's quantization/VRAM ladder).
 */
export const DEFAULT_FULL_SURFACE_MIN_PARAMS_B = 70;

export function fullSurfaceMinParamsB(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.COMFYUI_MCP_FULL_SURFACE_MIN_PARAMS_B;
  if (raw === undefined) return DEFAULT_FULL_SURFACE_MIN_PARAMS_B;
  const n = Number(raw);
  // A garbage value must not silently reshape the tool surface.
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_FULL_SURFACE_MIN_PARAMS_B;
}

/**
 * WHY the mode is what it is. Kept separate from `mode` because "compact was
 * applied" and "compact was applied because of the model" are different results
 * — an override that silently fell through to the default would otherwise be
 * indistinguishable from an override that was honoured.
 */
export type ToolModeSource =
  /** The user set COMFYUI_MCP_TOOL_MODE (or --compact/--full, which exports it). */
  | "user-explicit"
  /** A per-spawn override supplied by the caller, above the user env. */
  | "caller-explicit"
  /** No user choice; the model's parameter count decided it. */
  | "model-parameters"
  /** No user choice and no parameter count in the model id — documented fallback. */
  | "unknown-model-fallback"
  /** No user choice and no model known at all — documented fallback. */
  | "no-model-fallback";

export interface ToolModeDecision {
  mode: ToolMode;
  source: ToolModeSource;
  /** The model id the decision was made for, when one was supplied. */
  model?: string;
  /** Parameter count in billions parsed out of the model id, when parseable. */
  paramsB?: number;
  /** One user-facing sentence: which mode, why, and how to override it. */
  explain: string;
}

/**
 * Parameter count in BILLIONS parsed from a model id, or null when the id
 * carries no such marker.
 *
 * Handles the shapes that actually appear in Ollama / OpenRouter / LM Studio
 * ids: `qwen3:4b`, `llama3.3:70b`, `gpt-oss:120b`, `deepseek-r1:1.5b`,
 * `mixtral:8x7b` (MoE — total, not per-expert), and Gemma's `e2b`/`e4b`
 * "effective parameter" tags. Ids with no marker at all (`moonshotai/kimi-k2.5`,
 * `claude-opus-4`) return null — which is a real answer, not a failure, and the
 * caller must treat it as "unknown", never as "small".
 */
export function parseModelParamsB(model: string): number | null {
  const id = model.toLowerCase();

  // Mixture-of-experts: "8x7b" is 8 experts of 7B ≈ 56B of weights resident.
  const moe = id.match(/(\d+(?:\.\d+)?)\s*x\s*(\d+(?:\.\d+)?)\s*b(?![a-z0-9])/);
  if (moe) {
    const total = Number(moe[1]) * Number(moe[2]);
    if (Number.isFinite(total) && total > 0) return total;
  }

  // Gemma's effective-parameter tags (e2b / e4b): the RESIDENT cost is the
  // effective count, which is the number that matters for how much surface the
  // model can hold. Matched before the generic rule so "e4b" is read as 4, not
  // as whatever a looser pattern would take.
  const eff = id.match(/(?:^|[^a-z0-9])e(\d+(?:\.\d+)?)b(?![a-z0-9])/);
  if (eff) {
    const n = Number(eff[1]);
    if (Number.isFinite(n) && n > 0) return n;
  }

  // Generic "<n>b" markers. Take the LARGEST: a tag can carry several numbers
  // (`llama-3.3-70b-instruct-q4`), and the parameter count is the big one.
  let best: number | null = null;
  for (const m of id.matchAll(/(?:^|[^a-z0-9.])(\d+(?:\.\d+)?)b(?![a-z0-9])/g)) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > 0 && (best === null || n > best)) best = n;
  }
  return best;
}

/** Read an explicit tool mode out of an env bag. Anything other than the two
 *  exact lowercase tokens is NOT an explicit choice (matches cli.ts, which
 *  treats "FULL" and "verbose" as unset rather than guessing at intent). */
export function explicitToolMode(env: Record<string, string | undefined>): ToolMode | null {
  const v = env.COMFYUI_MCP_TOOL_MODE;
  return v === "full" || v === "compact" ? v : null;
}

export interface ResolveToolModeOptions {
  /** The model the turn will actually run on, when known. */
  model?: string;
  /** Process env — where a user's --compact/--full/COMFYUI_MCP_TOOL_MODE lands. */
  env?: NodeJS.ProcessEnv;
  /** A per-spawn env bag that outranks the user env (e.g. an MCP server spec). */
  callerEnv?: Record<string, string | undefined>;
}

/**
 * Decide the tool mode for one model, and say why.
 *
 * Precedence, both directions honoured:
 *   1. caller-supplied explicit mode  (a spawn spec that pinned it)
 *   2. user explicit mode             (COMFYUI_MCP_TOOL_MODE / --compact / --full)
 *   3. the model's parameter count
 *   4. the documented fallback (compact — today's behaviour)
 *
 * An explicit choice at 1 or 2 is never overridden by 3, in EITHER direction:
 * forcing `full` on a 4B model works, and forcing `compact` on a 405B model
 * works. That is the whole point of #788's "manual override in both directions".
 */
export function resolveToolModeForModel(opts: ResolveToolModeOptions = {}): ToolModeDecision {
  const env = opts.env ?? process.env;
  const model = opts.model?.trim() || undefined;

  const callerChoice = opts.callerEnv ? explicitToolMode(opts.callerEnv) : null;
  if (callerChoice) {
    return {
      mode: callerChoice,
      source: "caller-explicit",
      model,
      explain: `Tool mode: ${callerChoice} — pinned for this agent by an explicit COMFYUI_MCP_TOOL_MODE in its spawn config.`,
    };
  }

  const userChoice = explicitToolMode(env as Record<string, string | undefined>);
  if (userChoice) {
    return {
      mode: userChoice,
      source: "user-explicit",
      model,
      explain: `Tool mode: ${userChoice} — you set it (COMFYUI_MCP_TOOL_MODE=${userChoice} / --${userChoice}). Auto-selection is not overriding your choice.`,
    };
  }

  if (!model) {
    return {
      mode: "compact",
      source: "no-model-fallback",
      explain:
        "Tool mode: compact — no model is known at this point, so this lane falls back to the small-model-safe choice. " +
        "(The server's own default is full since 0.50.0; auto-selection is deliberately more conservative, because it " +
        "cannot rule out a model that would drown in the full surface.) Set COMFYUI_MCP_TOOL_MODE=full to override.",
    };
  }

  const paramsB = parseModelParamsB(model);
  if (paramsB === null) {
    return {
      mode: "compact",
      source: "unknown-model-fallback",
      model,
      explain:
        `Tool mode: compact — "${model}" carries no parameter count I can read, so this lane falls back to the ` +
        `small-model-safe choice rather than the server's full default. ` +
        `Set COMFYUI_MCP_TOOL_MODE=full if this model can hold the full tool surface.`,
    };
  }

  const threshold = fullSurfaceMinParamsB(env);
  const mode: ToolMode = paramsB >= threshold ? "full" : "compact";
  return {
    mode,
    source: "model-parameters",
    model,
    paramsB,
    explain:
      mode === "full"
        ? `Tool mode: full — chosen for this MODEL: "${model}" is ~${paramsB}B parameters, at or above the ${threshold}B full-surface threshold. Set COMFYUI_MCP_TOOL_MODE=compact to force the on-demand router instead.`
        : `Tool mode: compact — chosen for this MODEL: "${model}" is ~${paramsB}B parameters, below the ${threshold}B full-surface threshold, so tools load on demand instead of all at once. Set COMFYUI_MCP_TOOL_MODE=full to force the full surface (or raise COMFYUI_MCP_FULL_SURFACE_MIN_PARAMS_B).`,
  };
}
