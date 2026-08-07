// #948 — a correct instruction delivered to the wrong place is a wrong instruction.
//
// A user saw `Not logged in, please run /login` in the PANEL CHAT and reported
// that `/login` "doesn't exist as a command". They were right: `/login` is typed
// at the `pi` CLI's own prompt. It is not a panel command, not a ComfyUI command,
// and not a shell command — and the message named none of that.
//
// In a chat box a leading `/` reads as "type this here". That is the whole defect:
// the remedy was accurate and unusable at the same time, and it points the reader
// at the one place it cannot work.
//
// It also misleads ACROSS providers. A user on the Claude or Codex chip has no
// `/login` at all (`claude setup-token`, `codex login`), so a passed-through
// string naming it is not merely unhelpful there — it is false.
//
// Two rules follow, and both are about the reader's location rather than the
// text's accuracy:
//   1. Never let a bare `/command` reach chat. Say where its prompt is.
//   2. When we wrap a provider's auth failure, name the tool, the place, and the
//      follow-up — not just the keystrokes.

/** The CLI whose prompt a backend's slash commands belong to, when it has one. */
const SLASH_CLI_BY_BACKEND: Record<string, string> = {
  pi: "pi",
  grok: "grok",
};

/**
 * Rewrite bare `/command` mentions so they cannot read as "type this here".
 *
 * Only touches a slash-command that stands as its own word — `/login`,
 * `/status` — and leaves paths (`/usr/bin/pi`), URLs and dates alone, since
 * those are not instructions and rewriting them would corrupt real values.
 *
 * The first occurrence gets the full "at <cli>'s prompt" qualification; later
 * ones in the same message get a shorter form, because repeating the whole
 * clause reads as noise and noise is what gets skimmed past.
 */
export function qualifySlashCommands(text: string, cli: string): string {
  if (!text) return text;
  let seen = 0;
  return text.replace(/(^|[\s("'`])\/([a-z][a-z0-9-]{1,24})\b(?!\/)/gi, (match, lead: string, cmd: string) => {
    // A path segment (`/foo/bar`) or a URL is not an instruction.
    seen += 1;
    const qualified =
      seen === 1
        ? `\`${cli}\`, then type \`/${cmd}\` at its prompt`
        : `\`/${cmd}\` (at the \`${cli}\` prompt)`;
    return `${lead}${qualified}`;
  });
}

/** True when a CLI's failure text is about missing/expired credentials. */
export function looksLikeAuthFailure(text: string): boolean {
  return /sign.?in|log.?in|logged.?out|auth|credential|unauthoriz|api.?key|no provider/i.test(text);
}

/**
 * OUR wrapper for a provider's not-authenticated failure.
 *
 * Names the tool, WHERE to run it, and the follow-up — a raw CLI string assumes
 * the reader is already standing in that CLI, which from a panel chat is exactly
 * the assumption that fails.
 *
 * `detail` is the CLI's own tail, kept because it often carries the real reason
 * (an expired token vs a missing file) — but passed through `qualifySlashCommands`
 * first, so the child's phrasing can never smuggle a bare `/login` into chat.
 */
export function providerAuthRemedy(backend: string, detail?: string): string {
  const cli = SLASH_CLI_BY_BACKEND[backend];
  const tail = detail?.trim()
    ? ` (${cli ? qualifySlashCommands(detail.trim(), cli) : detail.trim()})`
    : "";

  switch (backend) {
    case "pi":
      return (
        `pi has no usable provider credentials. Fix it in a TERMINAL, not here: either set a provider ` +
        `API key (ANTHROPIC_API_KEY / OPENAI_API_KEY / …), or run \`pi\` once and type \`/login\` at its ` +
        `prompt — that writes ~/.pi/agent/auth.json. Then Disconnect → Connect and send your message ` +
        `again.${tail}`
      );
    case "codex":
      return (
        `Codex is not logged in. In a TERMINAL run \`codex login\` (ChatGPT sign-in) or set CODEX_API_KEY, ` +
        `then Disconnect → Connect.${tail}`
      );
    case "claude":
      return (
        `Claude has no usable credentials. In a TERMINAL run \`claude setup-token\`, or set ANTHROPIC_API_KEY, ` +
        `then Disconnect → Connect.${tail}`
      );
    case "gemini":
      return (
        `Gemini is not authenticated. In a TERMINAL run \`gemini\` once and complete its sign-in, or set ` +
        `GEMINI_API_KEY, then Disconnect → Connect.${tail}`
      );
    default:
      return (
        `${backend} has no usable credentials. Set the provider's API key in the API Keys card, or complete ` +
        `its CLI sign-in in a TERMINAL, then Disconnect → Connect.${tail}`
      );
  }
}
