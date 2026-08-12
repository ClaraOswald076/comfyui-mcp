/**
 * comfyui-mcp-panel#1097 — HOW LONG the panel has been refusing for.
 *
 * The panel refuses commands while it is switching or reloading the canvas
 * workflow, which is right: a command that landed mid-switch could apply to the
 * wrong graph. The orchestrator retries once and then explains, and it already
 * names the stuck case — "a load dialog or an unsaved-changes prompt can hold it
 * open awaiting the user".
 *
 * What it could not say is how long. A switch holding for 200ms and one holding
 * for four minutes produced the identical refusal, ending in "it normally clears
 * in well under a second, so simply retry". The reporter retried, and retried, and
 * the tool never had a way to notice it was telling them to do something that was
 * not working. "Never clears" was invisible to the only thing in a position to see
 * it.
 *
 * The orchestrator sees every one of those refusals, so it can time the RUN of
 * them per tab without the panel changing at all. Nothing here decides anything —
 * no guard is bypassed and no command is retried differently. It only lets the
 * message distinguish "wait a moment" from "this has been held for four minutes,
 * go and look at the canvas".
 */

/** A run of consecutive switch-guard refusals for one tab. */
interface Hold {
  /** When the FIRST refusal of this run was seen. */
  since: number;
  /** How many have been seen since — a fast retry loop is worth naming too. */
  count: number;
}

const holds = new Map<string, Hold>();

/**
 * Record a switch-guard refusal for `tabId` and return the run so far.
 *
 * `now` is injected so the wording is testable without faking a clock.
 */
export function recordSwitchHold(tabId: string, now: number = Date.now()): Hold {
  const prev = holds.get(tabId);
  // A clock that jumped backwards must not produce a negative age: restart the run
  // rather than report something that cannot be true.
  const next: Hold =
    prev && now >= prev.since ? { since: prev.since, count: prev.count + 1 } : { since: now, count: 1 };
  holds.set(tabId, next);
  return next;
}

/**
 * Forget a tab's run.
 *
 * Called when a command SUCCEEDS on that tab: the switch cleared, so the next
 * refusal starts a fresh run rather than inheriting an age from an unrelated one.
 * Without this the elapsed time would only ever grow, and a message built on it
 * would eventually be as misleading as no message at all.
 */
export function clearSwitchHold(tabId: string): void {
  holds.delete(tabId);
}

/** Test seam. */
export function switchHoldFor(tabId: string): Hold | undefined {
  return holds.get(tabId);
}

/** Test seam: drop all state between tests. */
export function resetSwitchHolds(): void {
  holds.clear();
}

/**
 * How long a switch has been holding, in words, or "" when it is too brief to be
 * worth saying — which is the common case and must not be cluttered.
 *
 * The threshold is deliberately low: the refusal itself claims a switch "normally
 * clears in well under a second", so anything past a few seconds already
 * contradicts that claim and is worth surfacing.
 */
export function describeSwitchHold(hold: Hold | undefined, now: number = Date.now()): string {
  if (!hold) return "";
  const ms = now - hold.since;
  if (!Number.isFinite(ms) || ms < 3000 || hold.count < 2) return "";
  const secs = Math.round(ms / 1000);
  const howLong = secs < 90 ? `${secs}s` : `${Math.round(secs / 60)}m`;
  return (
    ` THIS HAS BEEN HELD FOR ${howLong} across ${hold.count} attempts, which is far longer than a ` +
    `switch takes — treat the canvas as waiting for a person, not as busy. A load dialog, an ` +
    `unsaved-changes prompt, or a modal on the ComfyUI tab will hold it open indefinitely, and no ` +
    `number of retries will clear it.`
  );
}
