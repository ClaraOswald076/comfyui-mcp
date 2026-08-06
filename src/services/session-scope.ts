// Orchestrator-scoped agent sessions (#884).
//
// THE INVARIANT (owner-stated, absolute): agents are SESSION-bound, not
// workflow-bound. One agent session spans every panel, every browser tab and
// every open workflow served by this orchestrator; the sessions are stored and
// managed by the orchestrator and persisted on disk (~/.comfyui-mcp/sessions),
// not in the browser. A workflow-scoped, tab-scoped or panel-scoped agent is a
// bug, never the design.
//
// This module separates the two jobs the panel `tab_id` used to do at once:
//   (a) SESSION IDENTITY — which conversation/agent a message belongs to. That
//       is now the orchestrator-owned shared scope below plus the backend name
//       (switching provider already restarts the agent, so the backend half of
//       the composite key is legitimately part of agent identity — the
//       workflow half was the regression).
//   (b) ROUTING TARGET — which panel/workflow a tool call acts on and where
//       frames fan back out to. That job keeps the real per-tab ids: commands
//       addressed to the shared scope resolve to the ACTIVE tab at dispatch
//       time (UiBridge.resolveTarget), and conversation frames fan out to every
//       connected tab participating in the backend's conversation.
//
// The scope constant deliberately contains no "::" (the agent-key separator)
// and can never collide with a panel tab id (those are `wf:<path>` /
// `tmp:<uuid>` / test `e2e-*`/`spike-*` ids).

/** The single orchestrator-owned session scope. `agentKeyFor` composes it with
 *  the tab's backend: `orchestrator::claude`, `orchestrator::codex`, … */
export const SHARED_SESSION_SCOPE = "orchestrator";

/** The composite agent key for a backend's shared conversation. */
export function sharedAgentKey(backend: string, sep = "::"): string {
  return SHARED_SESSION_SCOPE + sep + backend;
}

/** Is this id the shared session scope (as opposed to a real panel tab id)? */
export function isSharedScopeId(id: string | undefined | null): boolean {
  return id === SHARED_SESSION_SCOPE;
}

/**
 * Is this id a scope ADDRESS — the bare scope, or a backend-qualified scope
 * (`orchestrator::<backend>`, i.e. an agent key used as a routing address)?
 * The panel MCP servers bind the QUALIFIED form so the workflow-stamp resolver
 * can answer per CONVERSATION (two backends' concurrently in-flight turns must
 * not share one issue-time stamp); the bridge routes both forms to the active
 * tab. A real panel tab id (`wf:…`/`tmp:…`) never matches.
 */
export function isScopeAddress(id: string | undefined | null): id is string {
  return (
    typeof id === "string" &&
    (id === SHARED_SESSION_SCOPE || id.startsWith(SHARED_SESSION_SCOPE + "::"))
  );
}

/**
 * The connected panel tabs participating in a backend's shared conversation —
 * every tab whose selected backend matches. Agent output (say/stream/turn/…)
 * fans out to ALL of them: the same conversation is visible from every tab.
 * When this is EMPTY the orchestrator PARKS the frame per agent key (backend-
 * qualified — a claude turn finishing while only a codex tab is open must never
 * leak into the codex conversation) and flushes it to the next hello /
 * set_backend join on that backend.
 */
export function conversationTabs(opts: {
  connected: string[];
  backendForTab: (tabId: string) => string;
  backend: string;
}): string[] {
  return opts.connected.filter((t) => opts.backendForTab(t) === opts.backend);
}

/**
 * May a provider switch RETIRE the outgoing backend's shared agent? Only when
 * no OTHER connected tab still runs on that backend — the conversation is
 * shared, so one tab switching provider must never stop an agent other tabs
 * are actively using. (retire() preserves the durable session either way, so a
 * wrongly-kept agent is merely idle, and a retired one resumes on demand.)
 */
export function shouldRetireSharedAgent(opts: {
  switchingTab: string;
  prevBackend: string;
  connected: string[];
  backendForTab: (tabId: string) => string;
}): boolean {
  return !opts.connected.some(
    (t) => t !== opts.switchingTab && opts.backendForTab(t) === opts.prevBackend,
  );
}

/**
 * Map a hello frame's raw `backend` field to the conversation it JOINS: a
 * known backend name (case-insensitive), else the default. This one function
 * is used BOTH by the orchestrator's hello handler (deciding which
 * conversation the tab joins) and by the bridge's backend-qualified mailbox
 * drain (deciding whose buffers it receives) — confirming gate 2, P1: when
 * those two mappings disagreed, a tab joined one conversation and stranded
 * another's mailbox, so they now share this single implementation (and the
 * ui-bridge tests drive it, not a test-local approximation — gate 3, P2).
 */
export function normalizeHelloBackend(
  raw: unknown,
  knownBackends: ReadonlySet<string>,
  defaultBackend: string,
): string {
  const named = typeof raw === "string" ? raw.toLowerCase() : undefined;
  return named && knownBackends.has(named) ? named : defaultBackend;
}

/** A message's workflow origin, for detecting that the conversation's focus
 *  moved to a different workflow/tab between two user messages. */
export function messageOrigin(tabId: string, workflowUuid?: string): string {
  return `${tabId}|${workflowUuid ?? ""}`;
}

/**
 * The context line prepended to a user message when its ORIGIN workflow/tab
 * differs from the previous message's in the same conversation — this is how
 * one session keeps "knowledge of all open workflows": the agent is told,
 * mechanically and only on a change, which canvas it is now operating on.
 * Returns null when the origin is unchanged (or on the conversation's very
 * first message, where there is nothing to contrast with).
 */
export function workflowOriginNote(opts: {
  prevOrigin: string | undefined;
  origin: string;
  tabId: string;
  title?: string;
}): string | null {
  if (!opts.prevOrigin || opts.prevOrigin === opts.origin) return null;
  const label = opts.title?.trim() ? `“${opts.title.trim()}” (${opts.tabId})` : opts.tabId;
  return (
    `[panel: this message was sent from a different workflow than the previous one — ` +
    `you are now operating on ${label}. Panel/graph tools target THIS workflow now; ` +
    `the conversation itself continues (one session spans all open workflows).]`
  );
}
