/**
 * Coerce an unknown thrown/rejected value into readable text.
 *
 * `String(err)` on a plain object (e.g. a structured JSON-RPC / protocol error
 * frame that is not an `Error` instance) yields the literal "[object Object]",
 * which then surfaces in the panel chat as an unreadable bubble (#176). Extract
 * a string `message` field when present, otherwise JSON-serialize, and only
 * fall back to `String()` for true primitives.
 *
 * Every property read runs inside try/catch: a value may be a Proxy or carry a
 * throwing getter, and normalization must never itself throw.
 */
export function errorText(err: unknown): string {
  if (err instanceof Error) {
    try {
      // A subclass can carry a non-string `message` (e.g. an object) — that
      // would re-introduce "[object Object]", so coerce it.
      if (typeof err.message === "string" && err.message) return err.message;
      if (err.message != null) return errorText(err.message);
    } catch {
      // fall through to the generic object handling below
    }
  }
  if (err && typeof err === "object") {
    try {
      const message = (err as { message?: unknown }).message;
      if (typeof message === "string" && message.trim()) return message;
    } catch {
      // throwing getter/proxy — ignore and try to serialize instead
    }
    try {
      const json = JSON.stringify(err);
      if (typeof json === "string" && json && json !== "{}") return json;
    } catch {
      // circular / bigint / throwing toJSON — fall through
    }
    return "unknown error";
  }
  try {
    return String(err);
  } catch {
    return "unknown error";
  }
}

/**
 * Coerce a user-turn payload into prompt-safe text.
 *
 * A user turn's `text` is normally a string, but a structured/multi-part chat
 * part reaching a prompt template interpolates as "[object Object]", silently
 * losing the message context in the model prompt (#175). Extract a string
 * `text` field when the value is an object, otherwise JSON-serialize — never
 * rely on implicit object coercion, and never collapse a payload that still
 * carries `parts` to an empty prompt.
 */
export function promptText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  if (typeof value === "object") {
    let text: unknown;
    let hasParts = false;
    let readOk = true;
    try {
      text = (value as { text?: unknown }).text;
      const parts = (value as { parts?: unknown }).parts;
      hasParts = Array.isArray(parts) && parts.length > 0;
    } catch {
      // throwing getter/proxy — property access is untrustworthy, so DON'T take
      // the empty-`text` short-circuit below (a `.text` of "" with a throwing
      // `.parts` would otherwise return ""). Fall through to serialize/fallback.
      readOk = false;
    }
    // A non-empty text field is authoritative. An EMPTY text alongside `parts`
    // (or when the `.parts` read threw) must NOT win — that would drop content
    // and yield an empty prompt; fall through to serialize the whole payload.
    if (readOk && typeof text === "string" && (text || !hasParts)) return text;
    try {
      const json = JSON.stringify(value);
      if (typeof json === "string" && json && json !== "{}") return json;
    } catch {
      // circular / bigint / throwing toJSON — fall through
    }
    // Serialization failed but the payload was real content; never hand the
    // model an empty prompt that silently erases the user's turn.
    return "[unserializable message payload]";
  }
  try {
    return String(value);
  } catch {
    return "";
  }
}
