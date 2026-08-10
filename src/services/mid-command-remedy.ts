// #952 (panel) — an interactive question card was told to go and check the
// render queue.
//
// `panel_ask` was interrupted by a tab disconnect, and the OUTCOME UNKNOWN error
// ended with the only remedy this path has ever offered:
//
//   Verify before retrying (e.g. check queue action:"list" /
//   get_image (action:"list_outputs")) instead of re-issuing it blindly.
//
// The reporter's objection is exact: "The suggested verification examples concern
// render queues/media and do not apply to an ask card." Neither of those tools
// can tell you whether a question is currently on a human's screen.
//
// WHY THIS IS NOT COSMETIC. The panel-side trace on that issue established that
// for THIS trigger a blind retry really does duplicate the card: the dedupe
// ledger is keyed by the socket's bridge epoch, a reconnect mints a new one, so
// the retry lands in a different scope, `lookupRetry` misses, and it fails open
// and re-executes. Failing open is right for a read or an idempotent write —
// re-running one is cheaper than refusing. It is wrong for a question, because
// the cost is a second card in front of a person and there is no way to withdraw
// the first.
//
// So the remedy has to say what actually applies. What it must NOT do is invent
// a recovery: there is no pending-card query today, and `retry_of` does not help
// across a reconnect for the reason above. Both of those are open design
// questions on the issue and this does not pre-empt them.

/** Panel commands that put something in front of a HUMAN and wait. */
const INTERACTIVE_COMMANDS = new Set(["ask_user", "request_secret"]);

export function isInteractiveCommand(cmd: string): boolean {
  return INTERACTIVE_COMMANDS.has(String(cmd ?? "").trim());
}

/**
 * The "verify before retrying" clause, chosen by what the command actually did.
 *
 * Two kinds, because they have different evidence and different costs:
 *
 *  • an INTERACTIVE card — nothing in the tool surface can observe it, and a
 *    retry is known to duplicate it after a reconnect. Say both, and say what
 *    the caller can do instead: wait for the answer to arrive, or ask the user
 *    directly in conversation.
 *  • anything else — the existing queue/output check, which is real evidence for
 *    a run or a write.
 */
export function midCommandVerifyClause(cmd: string): string {
  if (isInteractiveCommand(cmd)) {
    return (
      `The panel may already be SHOWING this card to the user. Nothing in the tool surface can ` +
      `check that — there is no pending-card query — and re-issuing it is NOT safe here: the ` +
      `panel's duplicate-suppression is keyed to the socket that dropped, so a retry after a ` +
      `reconnect is treated as a new command and paints a SECOND card, which cannot be withdrawn. ` +
      `Prefer to wait: if the user answers the card that is already up, the answer still arrives. ` +
      `If you cannot wait, ask the question directly in conversation rather than re-issuing this ` +
      `tool, and do not assume the card was never shown.`
    );
  }
  return (
    `Verify before retrying (e.g. check queue action:"list" / get_image (action:"list_outputs")) ` +
    `instead of re-issuing it blindly.`
  );
}

/** The full OUTCOME UNKNOWN sentence for a mid-command disconnect. */
export function midCommandDisconnectMessage(opts: { short: string; cmd: string }): string {
  const interactive = isInteractiveCommand(opts.cmd);
  const applied = interactive
    ? `the command was already sent, so the card may already be on screen`
    : `the command was already sent, so the panel may have applied it (for a run, ComfyUI may already be rendering)`;
  return (
    `panel tab ${opts.short} disconnected mid-command ("${opts.cmd}") — OUTCOME UNKNOWN: ` +
    `${applied}. ${midCommandVerifyClause(opts.cmd)}`
  );
}
