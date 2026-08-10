// #1300 — a bare status code cost a reporter four attempts.
//
// `download_model action:"download"` reported `Download failed: 404 ` and nothing
// else. The host had explained itself in the response body, and we discarded it;
// the CivitAI token hint existed but was gated on 401/403, and CivitAI answered
// the unauthenticated request with 404 (curl saw 401 for the same URL). So a
// missing-token failure and a wrong-URL failure arrived as the same sentence,
// and the one message that would have solved it on attempt one stayed silent.
//
// Both halves live here so the branches are testable without a network.

import { scrubSecretShapedText } from "../comfyui/json-guard.js";

/** Longest error body we will quote back. */
const MAX_BODY_CHARS = 400;

/**
 * The server's own explanation, bounded and safe to show.
 *
 * BOUNDED because this is an error path fed by a remote host: an unbounded read
 * during a failure is a second failure waiting to happen.
 *
 * SCRUBBED because an auth challenge is exactly the kind of body that echoes a
 * credential back, and this string lands in a tool result and the logs. The
 * scrubber already knows every credential this process is configured with,
 * including the CivitAI token.
 *
 * NEVER THROWS: a diagnostic that fails must not replace the status we already
 * have with an error about the diagnostic.
 */
export async function readErrorBody(res: { text?: () => Promise<string> }): Promise<string> {
  try {
    if (typeof res.text !== "function") return "";
    const raw = await res.text();
    if (typeof raw !== "string" || !raw.trim()) return "";
    const scrubbed = (scrubSecretShapedText(raw) ?? raw).replace(/\s+/g, " ").trim();
    if (!scrubbed) return "";
    return scrubbed.length > MAX_BODY_CHARS ? `${scrubbed.slice(0, MAX_BODY_CHARS)}…` : scrubbed;
  } catch {
    return "";
  }
}

/**
 * What to DO about it, keyed on the two facts that decide the answer: the host,
 * and whether a token is configured.
 *
 * WHY NOT GATE ON THE STATUS. The hint this replaces fired only on 401/403, and
 * the reporter got a 404 — so it never appeared. CivitAI requires a token for
 * EVERY model download, which makes "no token is configured" worth saying on any
 * failing status from that host. Note what that sentence is: a statement about
 * OUR configuration, which we know for certain, not a claim about what the
 * server meant by its status, which we do not.
 *
 * WHEN A TOKEN IS SET, do not send the reader back to auth — that was the
 * reporter's fourth attempt. Their residual 404 was a URL-FORM problem, and they
 * established the remedy by hand: a metadata-query downloadUrl
 * (`?type=…&format=…&fp=…`) 404s even with a valid token when a version
 * publishes several files, while `?fileId=…` downloads. That is quoted because
 * they measured it, not inferred from a status.
 */
export function downloadFailureHint(opts: {
  status: number;
  url: string;
  hasCivitaiToken: boolean;
}): string {
  let host = "";
  try {
    host = new URL(opts.url).hostname;
  } catch {
    return ""; // an unparseable url earns no host-specific advice
  }
  if (!/(^|\.)civitai\.com$/i.test(host)) return "";

  if (!opts.hasCivitaiToken) {
    return (
      " — NOTE: no CIVITAI_API_TOKEN is configured, and CivitAI requires a token for ALL model " +
      "downloads, so that is the most likely cause whatever status came back (an unauthenticated " +
      "download answers 401 or 404 depending on the URL form). Set it in panel Settings › " +
      "“Set CivitAI token…”, or the env var; create one at civitai.com/user/account. Do NOT retry " +
      "other model ids first — they will fail the same way until a token is set."
    );
  }

  const isMetadataQuery = /[?&](type|format|fp|size)=/i.test(opts.url);
  const fileIdTip = isMetadataQuery
    ? " This URL selects a file by METADATA (type/format/fp). CivitAI's own API returns that form, " +
      "but it can 404 even with a valid token when a version publishes several files — address the " +
      "file directly instead: https://civitai.com/api/download/models/<versionId>?fileId=<fileId>, " +
      "taking fileId from that version's `files[]` in the CivitAI API."
    : "";
  return ` — a CIVITAI_API_TOKEN IS configured, so this is probably not an auth failure.${fileIdTip}`;
}
