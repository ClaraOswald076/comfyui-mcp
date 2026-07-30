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
    // A non-empty text field is ALWAYS authoritative (even if the `.parts` read
    // threw — the text itself is valid content). An EMPTY text may win only when
    // the read succeeded AND there are no parts; otherwise fall through to
    // serialize the whole payload rather than emit an empty prompt.
    if (typeof text === "string" && (text || (readOk && !hasParts))) return text;
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

/**
 * Coerce an assistant/agent-message payload into readable display text.
 *
 * A provider's run-finished commit (e.g. Codex app-server `item/completed` for an
 * `agentMessage`) is normally `{ text: "…" }` with a string `text`, but newer
 * structured content can nest the reply as an array of parts or an object under
 * `text` / `content` / `value` / `output_text` / `message`. Blindly coercing that
 * with `String()` yields the literal "[object Object]", which then OVERWRITES the
 * already-streamed reply in the sidebar (#421, #422 — the orchestrator-side
 * sibling of the WS-9 panel cluster).
 *
 * Recursively extract the first readable string, joining array parts. Return ""
 * (never "[object Object]") when nothing readable is found, so callers can detect
 * the empty/malformed case and fall back to their buffered stream text instead of
 * clobbering it. Every property read runs inside try/catch — a value may be a
 * Proxy or carry a throwing getter, and normalization must never itself throw.
 */
export function messageText(value: unknown): string {
  return coerceMessageText(value, 0);
}

const MESSAGE_TEXT_KEYS = ["text", "content", "value", "output_text", "message"] as const;

function coerceMessageText(value: unknown, depth: number): string {
  if (typeof value === "string") {
    // The literal sentinel is never real content — treat it as empty so the
    // caller falls back to the streamed text rather than displaying it.
    return value === "[object Object]" ? "" : value;
  }
  if (value == null) return "";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (depth > 6) return ""; // defend against adversarial / cyclic nesting
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (const part of value) {
      const t = coerceMessageText(part, depth + 1);
      if (t) parts.push(t);
    }
    return parts.join("");
  }
  if (typeof value === "object") {
    for (const key of MESSAGE_TEXT_KEYS) {
      let inner: unknown;
      try {
        inner = (value as Record<string, unknown>)[key];
      } catch {
        continue; // throwing getter/proxy — try the next candidate key
      }
      if (inner == null) continue;
      const t = coerceMessageText(inner, depth + 1);
      if (t) return t;
    }
    return "";
  }
  return "";
}
