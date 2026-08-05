// Claude Agent SDK backend — the provider-specific adapter behind the
// AgentBackend port. It owns everything that knows about
// `@anthropic-ai/claude-agent-sdk`: the lazy SDK import, the `query()` call,
// Claude `Options` building (including forkSession/resumeSessionAt/resume),
// model/command enumeration, the live model setter, interrupt, and the
// normalization of `SDKMessage` → canonical `AgentEvent`.
//
// PanelAgent keeps all provider-agnostic orchestration (queue, turn-gate, bridge
// push, rewind-anchor tracking, self-restart) and drives this backend via
// `for await (const ev of backend.run({...}))`. See
// docs/design/agent-backend-injection.md.

import type {
  Query,
  SDKMessage,
  SDKUserMessage,
  Options,
  ModelInfo,
  SlashCommand,
  McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import { logger } from "../utils/logger.js";
import { errorText } from "./error-text.js";
import { buildAgentSpawnEnv } from "../services/panel-secrets.js";
import {
  type AgentBackend,
  type AgentEvent,
  type BackendStartOptions,
  type ModelChoice,
  type NeutralTurn,
  CLAUDE_CAPABILITIES,
} from "./agent-backend.js";
import type { Effort, ImageRef } from "./panel-agent.js";

// ---- reasoning effort mapping ----
// Effort is now a provider-neutral union (it must survive a provider switch — see
// panel-agent.ts Effort). The Agent SDK only accepts the Claude scale
// (low|medium|high|xhigh|max), so map any off-scale neutral value (Codex's
// "none"/"minimal") to the nearest valid Claude level. Shared levels pass through.
const CLAUDE_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
function toClaudeEffort(effort: string | undefined): Effort | undefined {
  if (!effort) return undefined;
  const e = effort.toLowerCase();
  if (CLAUDE_EFFORTS.has(e)) return e as Effort;
  if (e === "none" || e === "minimal") return "low"; // Codex's sub-low → Claude's floor
  return undefined; // unknown → SDK default
}

// The Agent SDK is an OPTIONAL dependency (it pulls in ~100 packages and is only
// needed for the panel orchestrator), so load it lazily and fail with a clear
// message rather than at import time for everyone.
let queryFn: typeof import("@anthropic-ai/claude-agent-sdk").query | null = null;
export async function loadQuery(): Promise<NonNullable<typeof queryFn>> {
  if (queryFn) return queryFn;
  try {
    const mod = await import("@anthropic-ai/claude-agent-sdk");
    queryFn = mod.query;
  } catch {
    throw new Error(
      "The panel orchestrator requires the optional dependency @anthropic-ai/claude-agent-sdk. Install it with: npm i @anthropic-ai/claude-agent-sdk",
    );
  }
  return queryFn;
}

function msgOf(err: unknown): string {
  return errorText(err);
}

/**
 * Ask the SDK which models the current account can actually use — so the panel's
 * picker reflects the live subscription instead of a hardcoded list. This is the
 * only model-enumeration path that works on the subscription/OAuth lane:
 * `query.supportedModels()` (the public Models API and `claude` CLI both require
 * an API key, which we deliberately don't have here).
 *
 * Runs a minimal throwaway session — no MCP servers, no plugins/skills — so it's
 * cheap; the control request resolves right after init, then we tear it down.
 * Returns [] on any failure so the panel can fall back gracefully.
 */
export async function fetchSupportedModels(model: string): Promise<ModelInfo[]> {
  const query = await loadQuery();
  let stop = false;
  let wake: (() => void) | null = null;
  // An idle channel: keeps the control connection open without ever consuming a
  // turn, until we tear it down.
  async function* idle(): AsyncGenerator<SDKUserMessage> {
    while (!stop) {
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  }
  const q = query({
    prompt: idle(),
    options: {
      model,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      strictMcpConfig: true,
      mcpServers: {},
      // SECURITY: the SDK spawns a Claude Code subprocess; `env` REPLACES its
      // environment entirely. Pass the agent env (process.env MINUS tool-only
      // secrets) so RunPod/HF/CivitAI tokens never reach the LLM subprocess.
      // Claude auth is OAuth-file-based (ANTHROPIC_API_KEY is deliberately unset).
      env: buildAgentSpawnEnv(),
    } as Options,
  });
  // The transport is pumped by iterating the query — do it in the background so
  // the control request (supportedModels) gets its response.
  const drain = (async () => {
    try {
      for await (const _ of q) {
        void _;
      }
    } catch {
      // torn down below
    }
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Never hang forever: a stuck probe would leave a permanently-pending
    // cached promise and the panel would never get its model list.
    const models = await Promise.race([
      q.supportedModels(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("supportedModels timed out")), 20000);
      }),
    ]);
    logger.info(`[panel-orchestrator] supportedModels: ${models.map((m) => m.value).join(", ") || "(none)"}`);
    return models;
  } catch (err) {
    logger.warn(`[panel-orchestrator] supportedModels probe failed: ${msgOf(err)}`);
    return [];
  } finally {
    if (timer) clearTimeout(timer);
    stop = true;
    // Cast re-widens: TS narrows the closure-mutated local back to its init value.
    (wake as (() => void) | null)?.();
    try {
      await q.interrupt();
    } catch {
      // already winding down
    }
    void drain;
  }
}

/**
 * Probe the SDK for the slash commands this account/session exposes (built-ins
 * like /compact, plus any loaded skills) so the panel can surface them in the
 * composer's completion menu. Same throwaway-session pattern as
 * fetchSupportedModels; returns [] on any failure so the panel degrades cleanly.
 */
export async function fetchSupportedCommands(model: string): Promise<SlashCommand[]> {
  const query = await loadQuery();
  let stop = false;
  let wake: (() => void) | null = null;
  async function* idle(): AsyncGenerator<SDKUserMessage> {
    while (!stop) {
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  }
  const q = query({
    prompt: idle(),
    options: {
      model,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      strictMcpConfig: true,
      mcpServers: {},
      // SECURITY: agent env only (no tool-only secrets) — see fetchSupportedModels.
      env: buildAgentSpawnEnv(),
    } as Options,
  });
  const drain = (async () => {
    try {
      for await (const _ of q) {
        void _;
      }
    } catch {
      // torn down below
    }
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const commands = await Promise.race([
      q.supportedCommands(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("supportedCommands timed out")), 20000);
      }),
    ]);
    logger.info(
      `[panel-orchestrator] supportedCommands: ${commands.map((c) => "/" + c.name).join(", ") || "(none)"}`,
    );
    return commands;
  } catch (err) {
    logger.warn(`[panel-orchestrator] supportedCommands probe failed: ${msgOf(err)}`);
    return [];
  } finally {
    if (timer) clearTimeout(timer);
    stop = true;
    (wake as (() => void) | null)?.();
    try {
      await q.interrupt();
    } catch {
      // already winding down
    }
    void drain;
  }
}

/** Provider config the Claude backend needs to build the SDK session — the
 *  subset of PanelAgentDeps that maps onto Claude `Options`. */
export interface ClaudeBackendDeps {
  /** mcpServers config for the spawned agent (the comfyui MCP). */
  mcpServers: Options["mcpServers"];
  /** Base URL of the ComfyUI instance, for fetching image bytes (/view). */
  comfyuiUrl?: string;
  /** Persona appended to the claude_code system-prompt preset. */
  systemAppend: string;
  /** In-process MCP server giving the agent LIVE control of this tab's graph. */
  panelServer?: McpSdkServerConfigWithInstance;
  /** Absolute path to the bundled comfyui-mcp plugin dir (skills), if found. */
  pluginPath?: string;
}

/** Bound on unresolved turn traces (wedged turns whose result never arrives).
 *  Overflow evicts the oldest trace — and POISONS classification rather than
 *  silently realigning it: the pop that crosses the evicted gap (and any
 *  traceless result) fails closed as unverifiable, never ok:true (#745 r3). */
const MAX_UNRESOLVED_TURNS = 16;

/**
 * The Claude Agent SDK adapter. One instance per PanelAgent; it holds the live
 * `Query` for the current session and re-creates it on each `run()`.
 */
export class ClaudeBackend implements AgentBackend {
  readonly id = "claude" as const;
  readonly capabilities = CLAUDE_CAPABILITIES;
  private deps: ClaudeBackendDeps;
  private q: Query | null = null;
  // #740 turn-truthfulness, with TURN IDENTITY (#745 r2 review): every submitted
  // turn gets a trace; stream messages accrue to the LATEST trace, and each
  // terminal result is classified against the trace it belongs to (results
  // arrive in submission order, possibly with a turn's result missing or LATE —
  // the panel's no-result fallback releases the next turn and tolerates the
  // late result, panel-agent.ts:671 — so the backend must too). A late result
  // from a superseded turn therefore classifies by ITS OWN flags and never
  // resets or consumes the in-flight turn's state. A turn that produced NO
  // user-visible content is never a successful turn, and a blocking SDK
  // informational message (prevent_continuation — e.g. a UserPromptSubmit hook
  // denied the prompt) fails its turn even when the SDK's own result still
  // arrives with subtype "success". `interrupted` mirrors PanelAgent's
  // interruptRequested: an interrupted turn's empty result is the interrupt
  // landing, not an empty-turn failure — and only the turn that was in flight
  // when interrupt() landed may be marked.
  //
  // FAIL CLOSED (#745 r3/r4 review): classification must never produce ok:true
  // without positive evidence. A normal successful turn ALWAYS has a trace, so
  // a result whose trace is missing (stray from a dead session, or pushed off
  // by the MAX_UNRESOLVED_TURNS bound) or whose id crosses an evicted-turn gap
  // is UNVERIFIABLE → ok:false, never a forwarded success. The gap case is
  // additionally STICKY: once a pop crosses an evicted-turn gap the FIFO
  // alignment is unrecoverable (content accrued to a mismatched trace is not
  // proof of ITS turn's success), so `classificationPoisoned` fails every later
  // result in the session closed — cleared only by a genuine run() restart.
  private turnSeq = 0;
  private lastResultTurnId = 0;
  private classificationPoisoned = false;
  /** Run-relative zero for turn MARKERS (#728): set at every run() entry to the
   *  backend-wide lastResultTurnId, so event stamps are 1-based per run and
   *  match PanelAgent's per-dispatch mirror. */
  private markerBase = 0;
  /** Interrupted traces PARKED by subtype-aware correlation (#728 r5): an
   *  interrupted turn ends with an INTERRUPTED-subtype result, so when a result
   *  with any other subtype arrives while the oldest trace is interrupted and a
   *  newer trace exists, that turn's result is permanently LOST and the arriving
   *  result belongs to the newer turn — the interrupted trace is skipped
   *  (parked) rather than popped. The park legitimizes the resulting forward
   *  jump in lastResultTurnId, and lets a genuinely interrupted late landing
   *  still pop its OWN trace (a backward pop) and classify/stamp by its flags. */
  private parkedInterrupted = new Set<number>();
  /** Interrupted traces whose late landing already HAPPENED (moved out of
   *  parkedInterrupted on the pop) — consumption tracking so a SECOND
   *  interrupted landing can never re-consume a landed trace; with no
   *  unconsumed candidate it fails closed as traceless (#728 r6). */
  private consumedInterrupted = new Set<number>();
  private turns: Array<{
    id: number;
    hasContent: boolean;
    blockReason: string | null;
    interrupted: boolean;
  }> = [];

  constructor(deps: ClaudeBackendDeps) {
    this.deps = deps;
  }

  /** Preflight: lazy-load the Agent SDK once so a missing optional dependency
   *  fails fast (a clear "install @anthropic-ai/claude-agent-sdk" reject) rather
   *  than being retried as a dropped session inside the restart loop. Idempotent. */
  async prepare(): Promise<void> {
    await loadQuery();
  }

  /** Fetch a ComfyUI image and wrap it as an Anthropic base64 image block, or
   *  null on any failure (the text reference still names it as a fallback). */
  private async fetchImageBlock(ref: ImageRef): Promise<unknown | null> {
    if (!this.deps.comfyuiUrl || !ref?.filename) return null;
    try {
      const u = new URL("/view", this.deps.comfyuiUrl);
      u.searchParams.set("filename", ref.filename);
      u.searchParams.set("type", ref.type || "input");
      if (ref.subfolder) u.searchParams.set("subfolder", ref.subfolder);
      const res = await fetch(u, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) return null;
      let mt = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
      if (!["image/png", "image/jpeg", "image/gif", "image/webp"].includes(mt)) {
        mt = "image/png"; // Anthropic-supported set; ComfyUI outputs are PNG by default
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > 12 * 1024 * 1024) return null; // keep context sane
      return { type: "image", source: { type: "base64", media_type: mt, data: buf.toString("base64") } };
    } catch {
      return null;
    }
  }

  /** Shape one provider-neutral turn into a Claude `SDKUserMessage`, resolving
   *  image refs to inline base64 blocks so the agent SEES them in this turn (no
   *  get_image view/fetch round-trip). */
  private async shapeTurn(turn: NeutralTurn): Promise<SDKUserMessage> {
    const text = turn.text;
    const images = turn.images ?? [];
    let content: unknown = text;
    if (images.length) {
      const blocks: unknown[] = [];
      for (const ref of images) {
        const b = await this.fetchImageBlock(ref);
        if (b) blocks.push(b);
      }
      if (blocks.length) content = [{ type: "text", text }, ...blocks];
    }
    return {
      type: "user",
      message: { role: "user", content } as SDKUserMessage["message"],
      parent_tool_use_id: null,
    };
  }

  private buildOptions(opts: BackendStartOptions): Options {
    const model = opts.model;
    const effort = toClaudeEffort(opts.effort);
    const resume = opts.resume;
    const rewindAnchor = opts.rewindAnchor;
    // Rewind: fork the conversation at the anchor (resume up to that message, then
    // branch into a new session id) so everything after it is dropped. A null
    // anchor means "fresh session" (handled by clearing resume below).
    const rewindOpts = rewindAnchor
      ? { resume: opts.sessionId ?? resume, resumeSessionAt: rewindAnchor, forkSession: true }
      : null;
    return {
      model,
      permissionMode: "bypassPermissions",
      // Required alongside bypassPermissions (intentional, isolated background agent).
      allowDangerouslySkipPermissions: true,
      // Stream partial assistant messages so the panel can show thinking + reply
      // text live (token-by-token) instead of only the final block. route() turns
      // these into onStream deltas; the final assistant message still commits the
      // authoritative text via onSay (reconciled by message id).
      includePartialMessages: true,
      mcpServers: {
        ...this.deps.mcpServers,
        // Live-graph control of THIS tab's open workflow (in-process; talks to
        // the bridge). Lets the agent build on what the user sees.
        ...(this.deps.panelServer ? { panel: this.deps.panelServer } : {}),
      },
      // Only our comfyui MCP — never inherit the user's project/user MCP config
      // (which may run a second comfyui that grabs the bridge port).
      strictMcpConfig: true,
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: this.deps.systemAppend,
      },
      // Reasoning effort, when the picker has set one.
      ...(effort ? { effort } : {}),
      // Load the bundled comfyui-mcp plugin so the agent has model expertise
      // (IDEOGRAM/WAN/LTX/Qwen/… skills) out of the box — "install the package
      // = expert agent". Omitted if the plugin dir can't be found.
      ...(this.deps.pluginPath
        ? {
            plugins: [{ type: "local" as const, path: this.deps.pluginPath }],
            skills: "all" as const,
          }
        : {}),
      ...(rewindOpts ?? (resume ? { resume } : {})),
      // SECURITY: the SDK spawns a Claude Code subprocess; `env` REPLACES its
      // environment entirely. Pass the agent env (process.env MINUS tool-only
      // secrets — RunPod/HF/CivitAI tokens) so tool credentials never reach the
      // LLM subprocess. Claude auth is OAuth-file-based (no env key needed).
      env: buildAgentSpawnEnv(),
    } as Options;
  }

  /**
   * Open the Claude session and yield canonical AgentEvents. The user channel
   * (PanelAgent's gated queue) is shaped turn-by-turn into `SDKUserMessage`s by
   * `shapeTurn`; the SDK's `SDKMessage`s are normalized into `AgentEvent`s.
   */
  async *run(opts: BackendStartOptions): AsyncGenerator<AgentEvent> {
    const query = await loadQuery();
    const self = this;
    // A (re)started session can never produce results for turns submitted to a
    // PREVIOUS session — drop any dead traces and advance the result sequence
    // past EVERY turn stamped so far (turnSeq), whether or not traces remain:
    // in a FULLY DRAINED (e.g. poisoned) session the FIFO is already empty, but
    // the sequence must still move past the old ids or the new session's first
    // result re-crosses the old gap and falsely re-poisons (#745 r5). Stray
    // late results from the dead session then arrive TRACELESS and fail closed
    // instead. This genuine restart boundary is also the ONLY reset of the
    // sticky classification poison (#745 r4). Done here, at run() entry (BEFORE
    // the new query exists), rather than on system/init: the SDK's prompt drain
    // legitimately pulls the first batch before init is processed, and an
    // init-time clear would unmark that genuinely in-flight turn (#745).
    this.turns.length = 0;
    this.lastResultTurnId = this.turnSeq;
    this.classificationPoisoned = false;
    this.parkedInterrupted.clear(); // dead session's parks die with it
    this.consumedInterrupted.clear(); // …and its landing history
    this.markerBase = this.lastResultTurnId; // turn markers are run-relative (#728)
    // Wrap the neutral channel: shape each turn into the SDK's native form right
    // before it's read, so PanelAgent never deals in SDKUserMessage.
    async function* prompt(): AsyncGenerator<SDKUserMessage> {
      for await (const turn of opts.channel) {
        const msg = await self.shapeTurn(turn);
        // The batch is handed to the SDK: stamp the turn's identity. Its trace
        // accrues this turn's content/block/interrupt flags until its terminal
        // result pops it (FIFO) for classification. Bounded: wedged turns whose
        // result never arrives would otherwise grow the queue without limit.
        // Eviction is recorded via the id sequence — the pop that crosses the
        // evicted gap fails closed as unverifiable (#745 r3), it does NOT
        // silently realign classification onto the wrong turn.
        self.turns.push({ id: ++self.turnSeq, hasContent: false, blockReason: null, interrupted: false });
        if (self.turns.length > MAX_UNRESOLVED_TURNS) {
          const evicted = self.turns.shift();
          logger.warn(
            `[claude-backend] over ${MAX_UNRESOLVED_TURNS} unresolved turns — evicted turn ${evicted?.id}'s trace; its result will fail closed as unverifiable (#740)`,
          );
        }
        yield msg;
      }
    }
    const q = query({ prompt: prompt(), options: this.buildOptions(opts) });
    this.q = q;
    // TURN MARKERS (#728): stamp every event with the marker of the turn it
    // BELONGS to, derived from the #745 per-turn trace FIFO (the SDK's input
    // pump and output reader are independent streams, so the marker can't ride
    // the input side). RESULT-message events are stamped by route() itself with
    // the trace it popped (the result's OWN turn, subtype-aware — #728 r5);
    // every other message is stamped here with the NEWEST in-flight trace (the
    // turn currently producing output). markerBase re-zeroes the backend-wide
    // trace ids per run (1 = this run's first turn), matching PanelAgent's
    // per-dispatch mirror (Nth submitted turn = marker N).
    for await (const message of q) {
      // LIVENESS: every SDKMessage — including the ones route() doesn't translate
      // (tool-progress, rate-limit, etc.) — is a sign the session is alive, so
      // re-arm PanelAgent's idle watchdog. Claude already streams continuously, so
      // this is effectively a no-op for behavior here; it keeps the watchdog's
      // re-arm source uniform across both backends via the port.
      opts.onActivity?.();
      const streamTurn = this.turns[this.turns.length - 1]?.id;
      for (const ev of this.route(message)) {
        // Session init arrives OUTSIDE any turn — leave it unstamped (an
        // unmarked event is never dead-lettered). Result-message events arrive
        // pre-stamped by route().
        if (ev.type === "session" || message.type === "result") {
          yield ev;
          continue;
        }
        yield streamTurn === undefined ? ev : { ...ev, turn: streamTurn - this.markerBase };
      }
    }
  }

  /** Switch the model live (the SDK applies it to the next turn). */
  async setModel(model: string): Promise<void> {
    try {
      // setModel is live: no session restart, the next turn uses it.
      await (this.q as unknown as { setModel?: (m: string) => Promise<void> })?.setModel?.(model);
    } catch (err) {
      logger.debug(`[claude-backend] setModel: ${msgOf(err)}`);
    }
  }

  async interrupt(): Promise<void> {
    // Scope the empty-turn blessing to the turn actually in flight (the latest
    // unresolved submission): an interrupt() with NO turn in flight leaves no
    // state behind, and a superseded turn's trace keeps whatever mark IT earned
    // (#745 review).
    const active = this.turns[this.turns.length - 1];
    if (active) active.interrupted = true;
    await this.q?.interrupt();
  }

  /** Permanently dispose of the live SDK query. The Agent SDK has no explicit
   *  "dispose" beyond interrupt(), which both stops the in-flight turn and lets
   *  the underlying transport wind down once the prompt generator is no longer
   *  iterated (PanelAgent.stop() closes the channel before calling this). We then
   *  drop our reference so the query can be GC'd. Idempotent + safe when never
   *  started (q is null) — and a true no-op for Claude's behavior: stop() already
   *  called interrupt(), so this only releases the reference. */
  async close(): Promise<void> {
    const q = this.q;
    this.q = null;
    if (!q) return;
    try {
      await q.interrupt();
    } catch {
      // already winding down / never fully started
    }
  }

  async listModels(): Promise<ModelChoice[]> {
    return [];
  }

  /** Normalize one SDK message into zero or more canonical AgentEvents. */
  private *route(message: SDKMessage): Generator<AgentEvent> {
    switch (message.type) {
      case "system":
        if (message.subtype === "init") {
          // New session (or a restarted one). No turn state is reset here: all
          // of it is per-turn (the `turns` FIFO), and dead traces from a
          // previous session are dropped at run() entry — an init-time clear
          // could unmark a turn the prompt drain already handed to the SDK
          // before this init was processed (#745 review).
          yield {
            type: "session",
            sessionId: message.session_id,
            ...(message.model ? { model: message.model } : {}),
          };
          logger.info(
            `[panel-agent] init model=${message.model} session=${message.session_id.slice(0, 8)} apiKeySource=${message.apiKeySource} skills=${message.skills?.length ?? 0}`,
          );
        } else if (message.subtype === "thinking_tokens") {
          // Live extended-thinking token count → drives a "thinking… (N)" meter
          // so the user can see the agent reasoning (not stuck) before any text.
          const t = (message as unknown as { estimated_tokens?: number }).estimated_tokens;
          if (typeof t === "number") {
            yield { type: "thinking", tokens: t };
          }
        } else if (message.subtype === "informational") {
          // #740: SDK informational banners are host-rendered plaintext (hook
          // feedback, status lines, slash-command notices) — never drop one the
          // turn logic depends on. A BLOCKING one (prevent_continuation, e.g. a
          // UserPromptSubmit hook denied the prompt) means execution stops here,
          // yet the SDK still ends the turn with a result whose subtype is
          // "success". Record the reason on the CURRENT turn's trace so that
          // turn's result is classified as the failure it actually is, and
          // surface the reason now so the user never watches a turn silently
          // produce nothing.
          const prevent =
            message.prevent_continuation === true ||
            (message as unknown as { preventContinuation?: unknown }).preventContinuation === true;
          const content = typeof message.content === "string" ? message.content.trim() : "";
          if (prevent) {
            const reason = content || "blocked by a hook";
            const turn = this.turns[this.turns.length - 1];
            if (turn) turn.blockReason = reason;
            logger.warn(`[claude-backend] turn blocked: ${reason}`);
            yield {
              type: "error",
              message: content || "The turn was blocked before it could produce a reply.",
            };
          } else if (content) {
            // Non-blocking notices don't affect turn classification — the panel
            // doesn't render them, but keep them visible in the log.
            logger.info(`[claude-backend] informational (${message.level ?? "info"}): ${content}`);
          }
        } else if (message.subtype === "local_command_output") {
          // Slash-command output (/usage, /voice, …) IS the turn's visible
          // payload, so the turn counts as having content and is not
          // misclassified as an empty one. (The panel doesn't render these
          // banners today — unchanged.)
          const turn = this.turns[this.turns.length - 1];
          if (turn) turn.hasContent = true;
        }
        break;
      case "stream_event": {
        // Live partial output (includePartialMessages). Turn the raw Anthropic
        // stream events into thinking/reply deltas the panel renders token-by-
        // token. The authoritative text still commits via the `assistant` case.
        const ev = (message as unknown as { event?: Record<string, unknown> }).event;
        if (!ev) break;
        const evType = ev.type as string | undefined;
        if (evType === "message_start") {
          const mid = (ev.message as { id?: string } | undefined)?.id;
          yield { type: "stream_start", id: typeof mid === "string" ? mid : null };
        } else if (evType === "content_block_delta") {
          const d = ev.delta as { type?: string; text?: string; thinking?: string } | undefined;
          if (!d) break;
          if (d.type === "thinking_delta" && typeof d.thinking === "string" && d.thinking) {
            yield { type: "assistant_delta", text: d.thinking, thinking: true };
          } else if (d.type === "text_delta" && typeof d.text === "string" && d.text) {
            yield { type: "assistant_delta", text: d.text };
          }
        } else if (evType === "message_stop") {
          yield { type: "stream_end" };
        }
        break;
      }
      case "assistant": {
        // An assistant message means the model actually responded — the CURRENT
        // (latest submitted, still unresolved) turn counts as having content
        // (#740). In-stream messages always belong to the newest in-flight turn:
        // a superseded turn's output ends with its own result, which pops it.
        const turn = this.turns[this.turns.length - 1];
        if (turn) turn.hasContent = true;
        // Remember this message's UUID — it's the rewind anchor for the turn.
        const auid = (message as unknown as { uuid?: string }).uuid;
        // Each assistant API response carries the CURRENT context size — report
        // it live so the meter updates throughout the turn, not just at the end.
        const u = (message.message as unknown as { usage?: Record<string, number> })?.usage;
        // Commit the authoritative reply text as ONE message. With streaming on,
        // the panel already showed a live preview (matched by this message id);
        // the commit replaces it with the final text. Without streaming (or for
        // injected events), it just renders a normal bubble.
        const content = (message.message?.content ?? []) as Array<{
          type: string;
          text?: string;
          name?: string;
        }>;
        const text = content
          .filter((b) => b.type === "text" && typeof b.text === "string")
          .map((b) => b.text as string)
          .join("\n\n")
          .trim();
        const id = (message.message as unknown as { id?: string })?.id;
        yield {
          type: "assistant",
          text,
          ...(typeof auid === "string" ? { uuid: auid } : {}),
          ...(id ? { id } : {}),
          ...(u ? { usage: u } : {}),
        };
        // TOOL VISIBILITY: surface each tool the agent invoked as a tool_call
        // event, so a canvas-less mobile client can show the agent's actions
        // (not just a spinner). The panel infers these from its live canvas.
        for (const b of content) {
          if (b.type === "tool_use" && typeof b.name === "string") {
            yield { type: "tool_call", name: b.name, phase: "start" };
          }
        }
        break;
      }
      case "result": {
        // Cache the context window + cost from the result, then re-report using
        // the last assistant usage (the true current context).
        const m = message as unknown as {
          modelUsage?: Record<string, { contextWindow?: number }>;
          total_cost_usd?: number;
        };
        let contextWindow: number | undefined;
        for (const mu of Object.values(m.modelUsage ?? {})) {
          if (mu?.contextWindow && (contextWindow === undefined || mu.contextWindow > contextWindow)) {
            contextWindow = mu.contextWindow;
          }
        }
        // #740: classify the result truthfully, against the trace of the turn it
        // BELONGS to (#745 r2). Results arrive in submission order, so the oldest
        // unresolved trace is this result's turn — even when the result is LATE
        // (an earlier turn was interrupted, produced nothing, and the panel's
        // fallback already released the next turn; panel-agent.ts:671 tolerates
        // that late result, and so does this FIFO: popping the old trace leaves
        // the in-flight turn's state untouched). The SDK reports subtype
        // "success" even for a turn a blocking hook prevented from producing ANY
        // output, and for a turn that simply ended with no assistant message —
        // the panel must never present either as a silent empty success.
        //
        // FAIL CLOSED (#745 r3/r4): ok:true requires positive evidence. A normal
        // successful turn ALWAYS has a trace (stamped at submission), so a
        // result that is TRACELESS (stray from a dead session, or pushed off by
        // the MAX_UNRESOLVED_TURNS bound) or whose id crosses an EVICTED-turn
        // gap is anomalous by construction — unverifiable, never a forwarded
        // success. (The panel consumes every result as completion/done, so a
        // pass-through would NOT be inert.) The gap case is STICKY: alignment
        // is unrecoverable once crossed, so the poison is terminal for the
        // session — content evidence must not rescue it (it accrued to a
        // mismatched trace, which is not proof of ITS turn's success).
        // SUBTYPE-AWARE correlation on the SDK's REAL result vocabulary
        // (#728 r5–r10): results arrive as `success` or `error_*` — an
        // interrupted turn ends with an error_during_execution result (the
        // interrupt landing); there is no "interrupted" result subtype.
        //
        // UNIFORM write-off (r10): an interrupted turn the PANEL killed (its
        // trace is marked) that was then SUPERSEDED by a newer submission never
        // delivers — the turn gate only submits newer work after the older
        // turn's result was written off. So for EVERY landing (success or
        // error_*): any interrupted-marked trace OLDER than the oldest LIVE
        // non-interrupted trace is written off (parked as lost), and the
        // landing pops that oldest live non-interrupted trace — a healthy
        // turn's genuine success or error classifies by ITS flags (a genuine
        // error_during_execution from a healthy newer turn is NOT blessed and
        // is NOT attributed to the killed older turn). With NO live
        // non-interrupted trace, the landing is an interrupt landing and pops
        // the oldest LIVE interrupted trace (kills settle in submission order —
        // the older turn's legitimate landing still pops the older trace, even
        // when a newer interrupted turn's trace exists from queued input), else
        // the oldest PARKED-but-unconsumed interrupted trace (a late landing
        // for a written-off turn — the r6 tolerance), else nothing (anomalous
        // → traceless fail-closed below). Each trace still lands at most once
        // (landed parks move to consumedInterrupted).
        const resultSubtype: string = message.subtype;
        const oldestLive = this.turns.findIndex((t) => !t.interrupted);
        if (oldestLive > 0) {
          for (let i = 0; i < oldestLive; i++) {
            if (this.turns[i].interrupted) this.parkedInterrupted.add(this.turns[i].id);
          }
        }
        let idx = oldestLive;
        if (idx < 0) {
          idx = this.turns.findIndex((t) => t.interrupted && !this.parkedInterrupted.has(t.id));
        }
        if (idx < 0) {
          idx = this.turns.findIndex(
            (t) => t.interrupted && this.parkedInterrupted.has(t.id) && !this.consumedInterrupted.has(t.id),
          );
        }
        const trace = idx >= 0 ? (this.turns.splice(idx, 1)[0] ?? null) : null;
        let unverifiable: string | null = null;
        if (this.classificationPoisoned) {
          unverifiable = "Turn bookkeeping was poisoned by an earlier overflow — no result in this session can be verified";
        } else if (!trace) {
          unverifiable = "The result could not be matched to any submitted turn";
          logger.warn(`[claude-backend] ${unverifiable} — unverifiable, failing closed (#740)`);
        } else {
          let crossesGap = false;
          if (trace.id > this.lastResultTurnId + 1) {
            // Forward jump: legit only when EVERY skipped id is a parked
            // interrupted trace; anything else is an evicted-turn gap.
            for (let id = this.lastResultTurnId + 1; id < trace.id && !crossesGap; id++) {
              if (!this.parkedInterrupted.has(id)) crossesGap = true;
            }
          } else if (trace.id <= this.lastResultTurnId) {
            // Backward pop: legit only for a parked (or landed-once) interrupted
            // trace's deferred landing.
            crossesGap = !(this.parkedInterrupted.has(trace.id) || this.consumedInterrupted.has(trace.id));
          }
          if (crossesGap) {
            // The pop crossed an evicted-turn gap → poison the session (do NOT
            // advance lastResultTurnId to the wrong trace's id — alignment is
            // unrecoverable, so resyncing would just hide the next mismatch).
            this.classificationPoisoned = true;
            unverifiable = "Turn bookkeeping overflowed, so the result cannot be matched to its turn";
            logger.warn(
              `[claude-backend] result crosses an evicted-turn gap (popped turn ${trace.id}, expected ${this.lastResultTurnId + 1}) — unverifiable; classification poisoned for the rest of the session (#740)`,
            );
          } else {
            // A legitimately popped park is now LANDED — consumed once, so a
            // second landing for it finds no candidate (#728 r6).
            if (this.parkedInterrupted.delete(trace.id)) this.consumedInterrupted.add(trace.id);
            if (trace.id > this.lastResultTurnId) this.lastResultTurnId = trace.id;
          }
        }
        // The result's OWN turn marker (#728): stamped here, where the trace it
        // popped is known (a per-message stamp in run() could not see the
        // subtype-aware skip). A traceless result stays UNMARKED so its
        // fail-closed error and gate completion still reach the panel.
        const stamp = trace ? { turn: trace.id - this.markerBase } : {};
        // An interrupted turn's terminal (an error_during_execution landing for
        // its own interrupted-marked trace) is the interrupt LANDING, not a
        // failure — blessed like a success; the empty-turn guard below still
        // spares it. Any other error_* subtype classifies by the trace's own
        // flags (a genuine failure for a non-interrupted turn).
        let ok =
          resultSubtype === "success" ||
          (resultSubtype === "error_during_execution" && trace !== null && trace.interrupted);
        if (unverifiable !== null) {
          // Fail closed with the reason VISIBLE — including an anomalous
          // interrupted landing with no unconsumed candidate (#728 r6), whose
          // ok is already false.
          ok = false;
          yield {
            type: "error",
            message: `${unverifiable} — reporting the turn as unverifiable rather than a success.`,
            ...stamp,
          };
        } else if (ok && trace !== null && trace.blockReason !== null) {
          // The blocking informational already yielded the visible error above.
          ok = false;
        } else if (ok && trace !== null && !trace.hasContent && !trace.interrupted) {
          ok = false;
          logger.warn("[claude-backend] result/success with no assistant content — reporting a failed turn (#740)");
          yield {
            type: "error",
            message: "The model ended the turn without producing a reply.",
            ...stamp,
          };
        }
        yield {
          type: "result",
          ok,
          subtype: message.subtype,
          ...(contextWindow !== undefined ? { contextWindow } : {}),
          ...(typeof m.total_cost_usd === "number" ? { costUsd: m.total_cost_usd } : {}),
          ...stamp,
        };
        break;
      }
      default:
        // Parity with the original route(): other SDK message types (incl. SDK
        // rate-limit and tool-progress events) are not surfaced — the panel never
        // consumed them. The canonical AgentEvent union still declares `rate_limit`
        // and `tool_call` for other backends / a future Claude enhancement to emit.
        break;
    }
  }
}
