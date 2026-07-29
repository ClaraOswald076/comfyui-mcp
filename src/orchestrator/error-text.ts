/**
 * Coerce an unknown thrown/rejected value into readable text.
 *
 * `String(err)` on a plain object (e.g. a structured JSON-RPC / protocol error
 * frame that is not an `Error` instance) yields the literal "[object Object]",
 * which then surfaces in the panel chat as an unreadable bubble (#176). Extract
 * a string `message` field when present, otherwise JSON-serialize, and only
 * fall back to `String()` for true primitives.
 */
export function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object") {
    const message = (err as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message;
    try {
      const json = JSON.stringify(err);
      if (typeof json === "string" && json && json !== "{}") return json;
    } catch {
      // fall through to the primitive coercion below
    }
    return "unknown error";
  }
  return String(err);
}

/**
 * Coerce a user-turn payload into prompt-safe text.
 *
 * A user turn's `text` is normally a string, but a structured/multi-part chat
 * part reaching a prompt template interpolates as "[object Object]", silently
 * losing the message context in the model prompt (#175). Extract a string
 * `text` field when the value is an object, otherwise JSON-serialize — never
 * rely on implicit object coercion.
 */
export function promptText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  if (typeof value === "object") {
    const text = (value as { text?: unknown }).text;
    if (typeof text === "string") return text;
    try {
      const json = JSON.stringify(value);
      if (typeof json === "string" && json && json !== "{}") return json;
    } catch {
      // fall through
    }
    return "";
  }
  return String(value);
}
