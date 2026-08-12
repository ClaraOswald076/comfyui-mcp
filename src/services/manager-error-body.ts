/**
 * #1397 — the ComfyUI-Manager error body was captured and never shown.
 *
 * `panel_update_node` failed with "an opaque serialized ComfyUI-Manager
 * QueueTaskItem/OperationType exception and no actionable traceback". The body was
 * not missing: `managerFetch` stores it in the error's `details` as
 * `{ url, status, body }`. It simply never reached the human-readable message for
 * any status except 403. So the diagnosis existed, one layer down, and the reader
 * got `ComfyUI-Manager API 500 Internal Server Error for /v2/manager/queue/task`.
 *
 * For a Manager TASK failure the body is the whole point — it is where the
 * serialized Python exception, and often the actual cause (a missing dependency, in
 * the report), is written.
 *
 * ## Why it is bounded rather than passed through
 *
 * A Manager exception body can be a full traceback, and this repo has already paid
 * for a verbatim error payload: #664 carried tensor-sized `current_inputs` and
 * 41k-token tracebacks into a reply. An unbounded passthrough here would trade an
 * unreadable message for an unusable one.
 *
 * So: a head excerpt, whitespace-collapsed, with truncation MARKED. The mark matters
 * — a silently cut traceback reads as a complete one, and someone would conclude the
 * exception ended where the budget did.
 */

/** Characters of the Manager's body carried into the message. Enough for a Python
 *  exception's type and message line — which is the part that names the cause —
 *  without importing a traceback. */
export const MANAGER_BODY_EXCERPT_LIMIT = 600;

/**
 * A one-line, bounded excerpt of a Manager error body, or "" when there is nothing
 * worth showing.
 *
 * Returns "" for an empty/whitespace body so the caller can append unconditionally
 * without producing a dangling separator — an unreadable body must cost detail in
 * the text and never a wrong conclusion.
 */
export function managerBodyExcerpt(
  body: unknown,
  limit = MANAGER_BODY_EXCERPT_LIMIT,
): string {
  const raw =
    typeof body === "string"
      ? body
      : body === undefined || body === null
        ? ""
        : (() => {
            // A non-string body (already-parsed JSON) still carries the message.
            // Never let this throw: it is decorating an error that is already being
            // reported, and an error-path guard must not become the error.
            try {
              return JSON.stringify(body);
            } catch {
              return "";
            }
          })();
  // Collapse newlines and runs of whitespace: a traceback pasted verbatim into a
  // single-line error is harder to read than a dense one, and the caller may be
  // rendering this into a log line.
  const flat = raw.replace(/\s+/g, " ").trim();
  // No empty-string guard: an empty `flat` already falls through the ternary and is
  // returned as "". A mutation deleting one proved it changed nothing, and a line
  // that reads as a correctness gate while being dead is worse than its absence.
  return flat.length > limit ? `${flat.slice(0, limit)}… [truncated]` : flat;
}

/** The clause appended to a Manager failure message. Empty when the body is. */
export function managerBodyClause(body: unknown, limit = MANAGER_BODY_EXCERPT_LIMIT): string {
  const excerpt = managerBodyExcerpt(body, limit);
  return excerpt ? ` ComfyUI-Manager said: ${excerpt}` : "";
}
