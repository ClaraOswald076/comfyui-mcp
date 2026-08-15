/**
 * "SOMETHING ANSWERED" — the fact that separates an ACKNOWLEDGED panel error from a
 * channel that never came back (#1560).
 *
 * ## Why this exists
 *
 * `ctx.call` flattens every failure into one shape: a ToolResult with `isError: true`
 * and some text. That is the right shape for a caller who only has to report the
 * failure, and the wrong shape for a caller who has to say WHY it failed — because
 * two opposite observations arrive identical:
 *
 *   the panel replied `ok:false`      the tab is alive and served the command
 *   the read never came back          the tab did not answer at all
 *
 * `panel_open_workflow`'s post-open probe (`observeActiveAfterOpen`) is exactly that
 * second kind of caller: on a silent read it prints `PANEL CHANNEL: NOT ANSWERING`
 * and sends the user to hard-refresh their ComfyUI tab. Told only `isError`, it makes
 * that claim about a panel that demonstrably ANSWERED — a false statement in the
 * bug's own direction, and a remedy for a problem the user does not have.
 *
 * ## Why it is not read out of the message
 *
 * The same reason `panel-refusal.ts` is not: acknowledged panel errors travel as
 * arbitrary `msg.error` text, so any sentence one class writes is a sentence the
 * other can also contain. Worse for a PROSE predicate specifically — the panel is
 * translated, so a rule matching English words is a rule that stops working for
 * eleven of twelve locales, silently, in whichever direction the default takes.
 *
 * So the bridge states it structurally at the ONE place that knows: the branch that
 * turns a received `ok:false` reply into a rejection. Nothing else mints it, and the
 * absence of the mark is not evidence of anything except that nothing said otherwise.
 *
 * ## The direction it fails in
 *
 * A missing mark reads as "did not answer", which is the direction #1560 exists to
 * report: the pre-#1560 code swallowed a silent probe entirely, and defaulting the
 * other way would restore that silence for every failure class nobody remembered to
 * mark. The cost of the mark being wrongly ABSENT is one over-stated note; the cost
 * of it being wrongly PRESENT is the reporter's original dead end. That asymmetry is
 * why the mark is attached only where a reply was genuinely received, and why it is
 * propagated (never re-derived) when an error is substituted downstream.
 */

import { hasOwnField } from "./panel-refusal.js";

/** The property the bridge attaches to an error it minted from a RECEIVED reply.
 *  Namespaced for the same reason `cmcpPanelRefusal` is: `code`/`cause` on an Error
 *  already mean other things to other catch blocks. */
export const PANEL_ANSWERED_PROP = "cmcpPanelAnswered";

/**
 * Mark an error as "the panel served this command and replied".
 *
 * `defineProperty`, not assignment — an assignment to a property that exists on the
 * prototype as non-writable throws in strict mode, which would replace a clear panel
 * error with an unrelated TypeError (the trap `attachPanelRefusal` documents). And
 * decorating an error must never be able to fail the command harder than it already
 * failed, so the whole thing is best-effort.
 */
export function attachPanelAnswered(err: Error): Error {
  try {
    Object.defineProperty(err, PANEL_ANSWERED_PROP, {
      value: true,
      writable: true,
      enumerable: false,
      configurable: true,
    });
  } catch {
    // Best effort: an un-markable error falls back to the honest default (unknown,
    // reported as "did not answer"), which is how every older path already behaves.
  }
  return err;
}

/**
 * Carry the mark from an error onto the error that REPLACES it.
 *
 * The bridge rewrites an old panel's "Unknown command" rejection into an actionable
 * update-your-panel error. That rewrite is still a REPLY — the panel answered, it
 * just answered that it does not know the command — so dropping the mark there would
 * label a talking panel silent, which is the whole defect. Propagated from the
 * source, never re-derived from the replacement's text.
 */
export function inheritPanelAnswered(from: unknown, to: Error): Error {
  return isPanelAnsweredError(from) ? attachPanelAnswered(to) : to;
}

/**
 * Did this error come from a reply the panel actually sent?
 *
 * OWN property, `true` exactly. An inherited `cmcpPanelAnswered` — from a polluted
 * prototype, or a library that decorates Error — would silence a genuine
 * NOT-ANSWERING report, which is the reporter's dead end restored. `hasOwnField`
 * binds `hasOwnProperty` at module load rather than reading it off the object under
 * test, so the check cannot be answered by the thing it distrusts (#1529 P0).
 */
export function isPanelAnsweredError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  if (!hasOwnField(err, PANEL_ANSWERED_PROP)) return false;
  return (err as Record<string, unknown>)[PANEL_ANSWERED_PROP] === true;
}
