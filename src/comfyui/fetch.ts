import { getComfyUIAuthHeaders } from "../config.js";
import { describeFetchFailure, isBareFetchFailure } from "../utils/errors.js";

/** The request target, for the diagnostic. Never throws on an odd input. */
function targetOf(input: string | URL | Request): string {
  try {
    if (typeof input === "string") return input;
    if (input instanceof URL) return input.href;
    return (input as Request).url ?? String(input);
  } catch {
    return String(input);
  }
}

/**
 * Turn a network-layer throw into a diagnostic that says WHAT was attempted.
 *
 * `TypeError: fetch failed` was reaching tool results verbatim: #954 saw it from
 * the workflow-templates listing (now `list_packs` action:"list_templates") and
 * could not tell which host was tried, and #952 saw it from the readonly tools
 * while the panel bridge was working fine — reading it, reasonably, as "the tool
 * is broken" when the headless target was simply a different (unreachable)
 * address than the one the panel is bound to.
 *
 * The two ARE separate targets by design: the panel talks to whichever ComfyUI
 * the browser is on, while these calls go to the configured COMFYUI_URL. That is
 * not a bug, but it is invisible unless the failure names the address.
 */
function describeComfyFetchFailure(err: unknown, target: string): Error {
  const { message, code } = describeFetchFailure(err);
  const wrapped = new Error(
    `${message} — while requesting ${target}. ` +
      `That is the headless ComfyUI target (COMFYUI_URL); a CONNECTED sidebar panel does not imply this address is reachable, ` +
      `because the panel talks to whichever ComfyUI its browser tab is on. ` +
      `Check the target with install_comfyui (action:"environment"), and confirm the server is up with get_system_stats (action:"health").`,
    { cause: err },
  );
  if (code) (wrapped as { code?: string }).code = code;
  return wrapped;
}

/**
 * `fetch` wrapper for ComfyUI HTTP requests that injects the configured generic
 * auth header(s) (COMFYUI_AUTH_* — for self-hosted ComfyUI behind a reverse
 * proxy / API gateway). A no-op when no auth is configured. Explicit headers on
 * the call always win, so it never clobbers a per-request `Content-Type`.
 *
 * Use this instead of the global `fetch` for every call to the user's ComfyUI
 * server. Non-ComfyUI requests (HuggingFace, Civitai, Comfy Cloud) keep using
 * plain `fetch` — Comfy Cloud has its own X-API-Key path in cloud-client.ts.
 */
export async function comfyuiFetch(
  input: string | URL | Request,
  init: RequestInit = {},
): Promise<Response> {
  const auth = getComfyUIAuthHeaders();
  let request: Promise<Response>;
  if (Object.keys(auth).length === 0) {
    request = fetch(input, init);
  } else {
    const headers = new Headers(init.headers);
    for (const [name, value] of Object.entries(auth)) {
      if (!headers.has(name)) headers.set(name, value);
    }
    request = fetch(input, { ...init, headers });
  }
  try {
    return await request;
  } catch (err) {
    // ONLY the opaque undici failure is rewritten. An AbortError, a timeout with
    // its own message, or anything else already says what happened, and
    // replacing that text would be a downgrade.
    if (!isBareFetchFailure(err)) throw err;
    throw describeComfyFetchFailure(err, targetOf(input));
  }
}
