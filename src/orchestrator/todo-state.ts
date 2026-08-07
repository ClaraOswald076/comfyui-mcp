// #977 — the orchestrator had no idea a multi-step plan was in flight.
//
// `panel_set_todo` was a pure pass-through to the panel UI: the checklist went to
// the browser and nothing here retained it. So when a render finished, the
// completion notification could only speak one way — "Reply with ONE short
// sentence … you do NOT need to call any tools" — which reads as "stop now".
//
// Combined with panel_run's own "just end your turn now and wait", the emergent
// default became: queue → end turn → render → one sentence → end turn again. A
// user running a five-variant sweep had to send a message to advance every step,
// while the orchestrator's system prompt was simultaneously telling the agent to
// treat a todo list as a loop and "keep going … Do NOT stop between steps". The
// per-event wording won because it is the most recent and most specific text in
// context.
//
// The checklist was the machine-readable signal all along — the agent had already
// declared the plan. Retaining it lets the completion notice distinguish "this
// was the last thing you were doing" from "you are three of five renders into a
// sweep you told the user about", which are different situations that deserve
// different instructions.

/** One checklist entry as `panel_set_todo` accepts it. */
export interface TodoItem {
  text?: unknown;
  status?: unknown;
}

/** What the last `panel_set_todo` on a tab declared. */
export interface TodoSnapshot {
  items: TodoItem[];
  /** Entries not yet finished — the ones that make a plan "in flight". */
  pending: number;
}

/** Statuses that mean "still to do". Anything else (done/completed/cancelled,
 *  or an unrecognised value) counts as settled — a plan is only treated as
 *  in-flight on POSITIVE evidence, so an unknown status can never manufacture
 *  one and suppress the yield nudge forever. */
const PENDING_STATUSES = new Set(["pending", "in_progress", "in-progress", "todo", "active"]);

const byTab = new Map<string, TodoSnapshot>();

/** Bounded: one snapshot per tab, and tabs are few. Guards against a pathological
 *  churn of synthetic tab ids retaining memory forever. */
const MAX_TABS = 64;

export function recordTodo(tabId: string | undefined, items: unknown): void {
  if (!tabId) return;
  if (!Array.isArray(items)) {
    // A malformed payload tells us nothing about the plan. Forgetting is safer
    // than keeping a stale snapshot that would keep claiming work remains.
    byTab.delete(tabId);
    return;
  }
  const list = items as TodoItem[];
  const pending = list.filter(
    (i) => typeof i?.status === "string" && PENDING_STATUSES.has(i.status.trim().toLowerCase()),
  ).length;
  byTab.set(tabId, { items: list, pending });
  while (byTab.size > MAX_TABS) {
    const oldest = byTab.keys().next().value;
    if (oldest === undefined) break;
    byTab.delete(oldest);
  }
}

/** The last checklist this tab declared, or undefined if it never did. */
export function todoFor(tabId: string | undefined): TodoSnapshot | undefined {
  return tabId ? byTab.get(tabId) : undefined;
}

/**
 * Is a multi-step plan still running on this tab?
 *
 * Requires POSITIVE evidence — a retained checklist with at least one unfinished
 * entry. No checklist, an empty one, or one whose entries are all settled all
 * answer false, so the ordinary "acknowledge and stop" wording remains the
 * default and only a declared, unfinished plan changes it.
 */
export function planInFlight(tabId: string | undefined): boolean {
  return (todoFor(tabId)?.pending ?? 0) > 0;
}

/** Test seam — the map is module state. */
export function __resetTodoState(): void {
  byTab.clear();
}

/**
 * The closing instruction on a render-completion notice (#977).
 *
 * Named and exported rather than inlined in PanelAgent.injectEvent, because
 * inline it was reachable only through a full agent harness — and a mutation
 * that ignored the plan entirely (the exact regression) broke no test at all.
 *
 * The wording is the whole fix: a fixed "you do NOT need to call any tools"
 * reads as "stop now", and an agent three renders into a sweep it announced will
 * obey the most recent, most specific instruction over the system prompt telling
 * it to keep going.
 */
export function runCompletionDirective(tabId: string | undefined): string {
  return planInFlight(tabId)
    ? `Acknowledge the result in ONE short sentence, then CONTINUE your plan — you have unfinished items on your todo list, so do NOT stop here or wait for the user. Carry straight on with the next step (queue it now if that is what the plan says). Don't repeat an earlier comment.`
    : `Reply with ONE short sentence acknowledging the result and suggesting a sensible next step — you do NOT need to call any tools. Don't repeat an earlier comment.`;
}
