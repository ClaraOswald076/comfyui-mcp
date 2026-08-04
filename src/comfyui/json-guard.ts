// Detect — and NAME — a ComfyUI HTTP response that promised JSON and delivered
// something else (issue #828).
//
// On a remote/reverse-proxied target, `/api/workflow_templates`, `/system_stats`
// and `/object_info` routinely come back as an HTML document: a proxy error page,
// an SSO sign-in page, or the ComfyUI frontend's catch-all index.html for a route
// the proxy never forwarded to the API. Feeding that to `res.json()` produced
//
//     Unexpected token '<', "<!DOCTYPE "... is not valid JSON
//
// which tells the user nothing about what actually answered them, and pushed
// callers toward the wrong conclusion — check_workflow_runtime reported "could
// not reach the ComfyUI server" for a server that answered perfectly well.
//
// The fix is to DETECT and SAY WHICH, not to parse harder. We look at the status
// and the content type, then at the shape of the body, and produce a message
// that names the most likely thing in front of ComfyUI. Where the evidence does
// not single one out we say so rather than picking one — a confident wrong
// diagnosis costs more than an honest "the body is HTML; here is its first line".

import { ComfyUIError } from "../utils/errors.js";
import { getComfyUIAuthHeaders, getComfyUIBaseUrl } from "../config.js";
import { comfyuiFetch } from "./fetch.js";

/** What answered instead of the ComfyUI JSON API. */
export type NonJsonKind =
  /** 401/403, or an HTML page whose body looks like a sign-in form. */
  | "login"
  /** A gateway/proxy error page (502/503/504, or nginx/cloudflare/traefik markers). */
  | "proxy-error"
  /** A 2xx HTML document — almost always the frontend's SPA index.html served as
   *  a catch-all for a path the proxy did not route to the ComfyUI API. */
  | "html-page"
  /** 404 with an HTML body — the route does not exist on whatever is answering. */
  | "not-found"
  /** A body that is neither JSON nor HTML (or an empty one). */
  | "not-json";

export interface NonJsonDiagnosis {
  kind: NonJsonKind;
  url: string;
  status: number;
  contentType: string;
  /** First ~160 chars of the body, whitespace-collapsed. Diagnostic only. */
  bodyPrefix: string;
  /** Human-readable, actionable explanation. Contains no credential. */
  message: string;
}

/** A ComfyUI endpoint answered with something that is not the JSON it promised. */
export class NonJsonResponseError extends ComfyUIError {
  readonly diagnosis: NonJsonDiagnosis;
  constructor(diagnosis: NonJsonDiagnosis) {
    super(diagnosis.message, "NON_JSON_RESPONSE");
    this.name = "NonJsonResponseError";
    this.diagnosis = diagnosis;
  }
}

export function isNonJsonResponseError(err: unknown): err is NonJsonResponseError {
  return err instanceof NonJsonResponseError;
}

/** Collapse a body to a short single-line prefix for the message.
 *
 *  The prefix is diagnostic — it is what lets a user recognise the page that
 *  answered. But a gateway that REFLECTS the request (an "invalid token: …"
 *  page, a debug echo) could put our own ComfyUI credential in that body, and
 *  this prefix goes into an error the agent sees. Any configured auth header
 *  value found in the body is therefore replaced before the prefix is built:
 *  we know exactly which strings are secret, so this is redaction, not guessing. */
function bodyPrefixOf(body: string): string {
  let text = body;
  for (const value of Object.values(getComfyUIAuthHeaders())) {
    if (!value) continue;
    // The header value may be "Bearer <token>"; redact the whole thing and the
    // bare token part, so neither form survives.
    for (const candidate of [value, value.replace(/^\S+\s+/, "")]) {
      if (candidate.length >= 4) text = text.split(candidate).join("«redacted»");
    }
  }
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 160 ? `${flat.slice(0, 160)}…` : flat;
}

function looksLikeHtml(contentType: string, body: string): boolean {
  if (/\b(text\/html|application\/xhtml\+xml)\b/i.test(contentType)) return true;
  return /^\s*(<!doctype html|<html\b)/i.test(body);
}

function looksLikeLoginPage(body: string): boolean {
  return (
    /<input[^>]+type=["']?password/i.test(body) ||
    /\b(sign in|sign-in|log in|login|authenticate|single sign-on|sso)\b/i.test(body)
  );
}

/** Does this HTML actually carry ComfyUI's own frontend markers? Only then may
 *  we name the frontend as the responder rather than listing candidates. */
function looksLikeComfyFrontend(body: string): boolean {
  return /<title>[^<]*comfyui/i.test(body) || /\bid=["']?vue-app\b/i.test(body) || /comfyui[.-]frontend/i.test(body);
}

function looksLikeProxyErrorPage(body: string): boolean {
  return /\b(bad gateway|gateway time-?out|service unavailable|nginx|cloudflare|traefik|haproxy|envoy)\b/i.test(
    body,
  );
}

/**
 * Classify a non-JSON response body. Pure (no I/O) so the classification rules
 * are unit-testable without a server.
 */
export function classifyNonJson(args: {
  url: string;
  status: number;
  contentType: string;
  body: string;
}): NonJsonDiagnosis {
  const { url, status, contentType, body } = args;
  const bodyPrefix = bodyPrefixOf(body);
  const html = looksLikeHtml(contentType, body);

  // A STATUS alone never proves who produced it — ComfyUI, or an application
  // layer in front of it, can emit 401/403 and 502/503/504 alike. Assert a cause
  // only when the BODY carries the corresponding markers; otherwise name the
  // likely candidates and say the response does not settle it (codex gate,
  // round 2, finding 6).
  let kind: NonJsonKind;
  let cause: string;
  if (status === 401 || status === 403 || (html && looksLikeLoginPage(body))) {
    kind = "login";
    cause =
      html && looksLikeLoginPage(body)
        ? "an authentication gate answered with a SIGN-IN PAGE (its markers are in the body) rather than letting the request through to ComfyUI — typically an identity proxy such as Cloudflare Access or an SSO portal"
        : `the request was rejected with ${status} and the body is not JSON; this is most often an identity proxy or sign-in gate in front of ComfyUI, but ComfyUI behind your own auth layer can return it too, and this response does not distinguish them`;
  } else if (status === 502 || status === 503 || status === 504 || (html && looksLikeProxyErrorPage(body))) {
    kind = "proxy-error";
    cause =
      html && looksLikeProxyErrorPage(body)
        ? "a reverse proxy in front of ComfyUI returned its OWN error page (its markers are in the body) — the proxy is up but could not reach, or timed out talking to, ComfyUI itself"
        : `a gateway-class status (${status}) came back with a non-JSON body; ComfyUI does not normally emit these, so something between you and it most likely did, though this response does not identify what`;
  } else if (status === 404 && html) {
    kind = "not-found";
    cause = "whatever is answering this host does not serve that route at all";
  } else if (html) {
    kind = "html-page";
    // Do NOT assert which HTML this is. A generic 2xx HTML body is consistent
    // with the ComfyUI frontend's SPA catch-all, a reverse proxy that forwards
    // the UI but not the API routes, a maintenance page, a WAF, or an unrelated
    // web app on this host — and nothing in the response singles one out (codex
    // gate, round 1, finding 4). List the candidates; name one only when the
    // body actually carries ComfyUI's own frontend markers.
    cause = looksLikeComfyFrontend(body)
      ? "the ComfyUI web FRONTEND answered this path (its markers are in the body) instead of the ComfyUI HTTP API — typically a reverse proxy that forwards the UI but not the API routes, or a base URL pointing at the frontend's catch-all"
      : "some HTTP responder other than the ComfyUI JSON API answered this path; this body alone does not identify which. The usual candidates are the ComfyUI frontend's SPA catch-all, a reverse proxy that forwards the UI but not the API routes, a maintenance/WAF page, or an unrelated web app on this host";
  } else {
    kind = "not-json";
    cause = "the response body is not JSON at all";
  }

  const what = html ? "an HTML page" : contentType ? `a ${contentType} body` : "a non-JSON body";
  const message =
    `${url} answered ${status} with ${what} where JSON was expected. This means ${cause}. ` +
    `Content-Type: ${contentType || "(none)"}. Body starts: ${bodyPrefix || "(empty)"}. ` +
    `Confirm the configured ComfyUI base URL really is a ComfyUI API root — a URL that loads the ComfyUI UI in a browser is not proof, because the UI is served by the same catch-all that produced this page. ` +
    `The check is that ${getComfyUIBaseUrl()}/system_stats returns JSON with a "system"/"devices" shape; if it returns HTML too, the base URL, its path prefix, or the proxy's route map is wrong` +
    (kind === "login"
      ? `, and any credential must be supplied to the GATEWAY (COMFYUI_AUTH_TOKEN / COMFYUI_AUTH_HEADER, or the CF_ACCESS_CLIENT_ID + CF_ACCESS_CLIENT_SECRET pair), not to ComfyUI.`
      : `.`);

  return { kind, url, status, contentType, bodyPrefix, message };
}

/**
 * Read a ComfyUI response as JSON, or throw a NonJsonResponseError that says what
 * actually answered. Use instead of `await res.json()` on every endpoint whose
 * contract is JSON — the raw SyntaxError ("Unexpected token '<'") names neither
 * the URL nor the responder and is what #828 was reported as.
 *
 * `expectShape`, when given, is a predicate on the PARSED value: a 200 that
 * parses as JSON but is not the document this endpoint returns is also a failure
 * to report, not a value to hand on.
 */
export async function readComfyJson<T = unknown>(
  res: Response,
  opts: { url: string; expectShape?: (v: unknown) => boolean; shapeHint?: string },
): Promise<T> {
  const contentType = res.headers.get("content-type") ?? "";
  const body = await res.text();
  const jsonish = /\bjson\b/i.test(contentType);
  let parsed: unknown;
  try {
    // Trust the body over the header: some proxies serve JSON as text/plain, and
    // some serve HTML while claiming application/json. Parsing decides.
    parsed = JSON.parse(body);
  } catch {
    throw new NonJsonResponseError(
      classifyNonJson({ url: opts.url, status: res.status, contentType, body }),
    );
  }
  if (!res.ok) {
    // Valid JSON, but an error status — surface it verbatim rather than as a
    // shape failure; the server told us something specific.
    throw new ComfyUIError(
      `${opts.url} returned ${res.status}: ${bodyPrefixOf(body)}`,
      "HTTP_ERROR",
    );
  }
  if (opts.expectShape && !opts.expectShape(parsed)) {
    throw new NonJsonResponseError({
      kind: "not-json",
      url: opts.url,
      status: res.status,
      contentType,
      bodyPrefix: bodyPrefixOf(body),
      message:
        `${opts.url} answered ${res.status} with valid JSON that is not ${opts.shapeHint ?? "the expected document"}. ` +
        `Something other than ComfyUI is very likely answering this route (an API gateway's own JSON error envelope, or a different service on this host). ` +
        `Body starts: ${bodyPrefixOf(body)}.` +
        (jsonish ? "" : ` (Content-Type was ${contentType || "(none)"}.)`),
    });
  }
  return parsed as T;
}

/** Fetch a ComfyUI endpoint and parse it as JSON with the guard above. */
export async function fetchComfyJson<T = unknown>(
  url: string,
  opts: {
    init?: RequestInit;
    expectShape?: (v: unknown) => boolean;
    shapeHint?: string;
  } = {},
): Promise<T> {
  const res = await comfyuiFetch(url, opts.init ?? {});
  return readComfyJson<T>(res, {
    url,
    expectShape: opts.expectShape,
    shapeHint: opts.shapeHint,
  });
}

/**
 * True when an error looks like `JSON.parse` choking on a markup body — the
 * signature of a client library that called `res.json()` itself and so gave us
 * no URL, status, or content type to report.
 */
export function looksLikeHtmlParsedAsJson(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  // Require a MARKUP indicator, not merely "is not valid JSON" (codex gate,
  // round 1, finding 5): a bare JSON-syntax complaint can come from a truncated
  // or malformed JSON body, and triggering a speculative re-probe on it risks
  // replacing a truthful error with one about a DIFFERENT, later response.
  const markup = msg.includes("<");
  const jsonSyntax =
    /is not valid JSON/.test(msg) ||
    /in JSON at position/.test(msg) ||
    /Unexpected token/.test(msg);
  return markup && jsonSyntax;
}

/**
 * Re-probe `url` ONCE to turn an opaque JSON-parse failure into a diagnosis that
 * names the responder. Returns null when the probe cannot establish that the
 * body was non-JSON — an inconclusive probe must NOT be reported as a verdict,
 * so callers keep the original error in that case.
 *
 * Only called on the failure path, so the happy path costs nothing.
 */
export async function diagnoseComfyEndpoint(url: string): Promise<NonJsonDiagnosis | null> {
  try {
    const res = await comfyuiFetch(url, { signal: AbortSignal.timeout(8000) });
    const contentType = res.headers.get("content-type") ?? "";
    const body = await res.text();
    try {
      JSON.parse(body);
      return null; // it parses now — we cannot claim the earlier body was HTML
    } catch {
      return classifyNonJson({ url, status: res.status, contentType, body });
    }
  } catch {
    return null; // probe failed; we learned nothing and must not invent a cause
  }
}

/**
 * Wrap an error thrown by a client library that parsed JSON internally. When it
 * smells like markup-parsed-as-JSON, re-probe `url` and rethrow the precise
 * diagnosis; otherwise rethrow the original untouched.
 */
export async function rethrowWithJsonDiagnosis(err: unknown, url: string): Promise<never> {
  if (looksLikeHtmlParsedAsJson(err)) {
    const diagnosis = await diagnoseComfyEndpoint(url);
    if (diagnosis) {
      // The probe is a SEPARATE, later request — it does not prove it saw the
      // same response that failed. Say so, keep the original message, and chain
      // the original as `cause`, so a transient change between the two requests
      // cannot silently rewrite a truthful error into a speculative one (codex
      // gate, round 1, finding 5).
      const original = err instanceof Error ? err.message : String(err);
      throw new NonJsonResponseError({
        ...diagnosis,
        message:
          `The request failed while parsing the response as JSON: ${original} ` +
          `A follow-up probe of ${url} — a separate request, so not necessarily the same response — found: ${diagnosis.message}`,
      });
    }
  }
  throw err;
}
