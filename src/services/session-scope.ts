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
 * The connected panel tabs participating in a backend's shared conversation —
 * every tab whose selected backend matches. Agent output (say/stream/turn/…)
 * fans out to ALL of them: the same conversation is visible from every tab.
 */
export function conversationTabs(opts: {
  connected: string[];
  backendForTab: (tabId: string) => string;
  backend: string;
}): string[] {
  return opts.connected.filter((t) => opts.backendForTab(t) === opts.backend);
}

/**
 * Delivery targets for one shared-conversation frame. When no participating tab
 * is connected, the frame is addressed to the SCOPE id itself so the bridge
 * buffers it (missedFrames) and replays it to the first tab that hellos —
 * a backgrounded agent's turn survives a panel reload.
 */
export function conversationTargets(opts: {
  connected: string[];
  backendForTab: (tabId: string) => string;
  backend: string;
}): string[] {
  const tabs = conversationTabs(opts);
  return tabs.length ? tabs : [SHARED_SESSION_SCOPE];
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
