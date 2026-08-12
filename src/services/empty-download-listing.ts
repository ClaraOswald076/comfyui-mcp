/**
 * #1420 — what an EMPTY download listing is allowed to claim.
 *
 * `download_model action:"status"` with no selector answered `No downloads are
 * being tracked.` — a bare fact, with nothing to distinguish it from proof — while
 * two multi-GB transfers were mid-flight. The reporter concluded ~24 GB had been
 * lost and told their user so, before re-issuing and finding both jobs alive under
 * their original ids. Their own evidence shows the answer was TRANSIENT: the same
 * call ~40s later listed both.
 *
 * Two things conspire to make the empty case look like proof:
 *
 *   * the record store is nonced per orchestrator start and earlier ones are reaped
 *     (#1148), so a restart or reconnect hands the session a brand-new empty store
 *     while transfers keep streaming inside the processes that own them; and
 *   * in-flight bytes are staged outside `models/<subfolder>` and only moved on
 *     completion, so the obvious corroborating check — look at the destination
 *     folder — is ALSO empty.
 *
 * Between them the state is indistinguishable from "the downloads died and their
 * partials were cleaned up", which is exactly the wrong conclusion this text exists
 * to prevent.
 *
 * Every NEIGHBOURING branch of this message already reasons this way — the id/url
 * miss enumerates its causes and says outright to treat it as not-found rather than
 * as finished (#1183, #1148). This is the one branch that was left bare.
 */

/** How long a store may have existed and still be a plausible explanation for an
 *  empty listing. Generous on purpose: the cost of mentioning a fresh store when it
 *  is irrelevant is a sentence, and the cost of omitting it is the reported harm. */
const FRESH_STORE_MS = 10 * 60 * 1000;

function describeAge(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s ago`;
  const m = Math.round(s / 60);
  return m < 90 ? `${m}m ago` : `${Math.round(m / 60)}h ago`;
}

/**
 * The reply for "list everything" when everything is nothing.
 *
 * `storeCreatedMs`/`now` are passed in rather than read here so the wording is
 * testable without a filesystem, and so a caller that cannot determine the store's
 * age simply omits it — unknown is reported as unknown, never as old.
 */
export function emptyDownloadListingNote(opts?: {
  storeCreatedMs?: number;
  now?: number;
}): string {
  const now = opts?.now ?? Date.now();
  const created = opts?.storeCreatedMs;
  const age = typeof created === "number" && created > 0 ? now - created : undefined;
  // A clock that jumped, or a store stamped in the future, must not render as
  // "created -60s ago" — an age that cannot be true reads as a bug in the tool and
  // costs the sentence its credibility just when it is being relied on.
  const fresh =
    age !== undefined && age >= 0 && age < FRESH_STORE_MS
      ? `This session's record store was created ${describeAge(age)}, so anything ` +
        `started before then was never in it. `
      : "";

  return (
    `No downloads are tracked in THIS session's record store. That is NOT the same as ` +
    `"nothing is downloading", and this listing cannot tell the two apart.\n\n` +
    `${fresh}The store is created fresh on each orchestrator start and earlier ones are ` +
    `reaped; the carry-over that migrates still-running records into the new one (#1148) is ` +
    `best-effort by design. A transfer streams inside the process that started it, so it can ` +
    `be running at full speed with nothing here to show for it.\n\n` +
    `DO NOT conclude from this that a transfer died or that partial data was lost — and do ` +
    `not tell the user so. In-flight bytes are staged OUTSIDE models/<subfolder> and only ` +
    `moved on completion, so the destination folder looks empty too, which makes these two ` +
    `very different states look identical.\n\n` +
    `TO FIND OUT: the panel's download tray shows live transfers regardless of this store. ` +
    `Or re-issue download_model action:"download" with the SAME url — an in-flight transfer ` +
    `is ADOPTED, not duplicated, and the reply carries its real progress. That is the cheap, ` +
    `safe check; starting over is not.`
  );
}
