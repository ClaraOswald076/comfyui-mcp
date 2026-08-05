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

const REDACTED = "«redacted»";

/**
 * Collapse a body to a short single-line prefix for the message.
 *
 * The prefix is diagnostic — it is what lets a user recognise the page that
 * answered. But a gateway that REFLECTS the request (an "invalid token: …"
 * page, a debug echo) can put our own ComfyUI credential in that body, and this
 * prefix goes into an error the agent sees.
 *
 * Matching the KNOWN VALUE is a blocklist, and a proxy can percent-encode,
 * HTML-entity-encode, case-fold or line-wrap what it echoes — so a reflected
 * `Bearer abc/def` comes back as `?token=abc%2Fdef` and no known-value match
 * fires. `scrubSecretShapedText` therefore redacts by SHAPE as well as by
 * value: anything credential-shaped goes, whether or not we can prove it is
 * ours. A diagnostic that can print a secret is not worth the diagnosis.
 */
export function bodyPrefixOf(body: string): string {
  const redacted = scrubSecretShapedText(body);
  if (redacted === null) {
    // A configured credential is present in the body but too short to replace
    // without mangling unrelated text. FAIL CLOSED: withhold the prefix rather
    // than hand the credential back through a tool result.
    return "(body withheld: it contains the configured ComfyUI credential)";
  }
  const flat = redacted.replace(/\s+/g, " ").trim();
  return flat.length > 160 ? `${flat.slice(0, 160)}…` : flat;
}

/**
 * Every encoding of `value` a responder might plausibly echo it back in.
 *
 * Each encoding here is a FAMILY with independent axes, and the way this list
 * has failed by enumerating some members of a family by hand and missing one.
 * Base64 has two axes — alphabet (standard / url-safe) and padding (kept /
 * stripped) — so it has four members, and all four are generated here.
 *
 * This matters precisely because the shape passes below cannot cover these: a
 * short, punctuation-bearing credential encodes to a short opaque string, under
 * the 24-char run threshold and carrying no `token=` label. We HOLD the secret;
 * we do not have to infer it.
 *
 * PERCENT-ENCODING AND HEX ARE NOT HERE. Their axis is the CASE of each hex
 * digit, which is per-digit, not per-string: enumerating "all upper" and "all
 * lower" leaves every mixed-case spelling — `%2F%3f`, `6a7B` — uncovered, and
 * enumerating all of them is 2^n strings (codex gate). Those two families are
 * matched by PATTERN instead, in `reflectionPatterns`, which is the only form of
 * the answer that has no members to miss.
 */
function reflectionVariants(value: string): string[] {
  const html = value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

  // BASE64 family: axes = alphabet × padding, i.e. four members, all generated.
  // (Base64's alphabet is case-SENSITIVE — `a` and `A` are different bytes — so
  // unlike hex it genuinely is a fixed set of strings.)
  const b64 = Buffer.from(value, "utf8").toString("base64");
  const urlSafe = (s: string) => s.replace(/\+/g, "-").replace(/\//g, "_");
  const stripPad = (s: string) => s.replace(/=+$/, "");
  const base64Forms = [b64, stripPad(b64), urlSafe(b64), stripPad(urlSafe(b64))];

  return [value, html, value.toLowerCase(), value.toUpperCase(), ...base64Forms];
}

/** Regex-escape a literal. */
function reEscape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A regex atom matching `c` in either case when it is a letter, else literally. */
function eitherCase(c: string): string {
  const lower = c.toLowerCase();
  const upper = c.toUpperCase();
  return lower === upper ? reEscape(c) : `[${lower}${upper}]`;
}

/**
 * The encodings whose spelling is case-INSENSITIVE per hex digit, as patterns.
 *
 * `%2F` and `%2f` are the same byte, and so are `6A` and `6a` in hex — the case
 * of each digit is an independent choice the responder makes, so a fixed list of
 * strings would have to contain 2^(digits) members to be complete. A pattern has
 * none to miss. The NON-hex parts of a percent-encoded value stay case-SENSITIVE,
 * because there they are the credential's own characters.
 *
 * Every returned pattern matches text of exactly `length` characters, so the
 * caller can apply the same "too short to substitute safely" rule it applies to
 * the literal candidates.
 */
function reflectionPatterns(value: string): { pattern: RegExp; length: number }[] {
  const out: { pattern: RegExp; length: number }[] = [];

  // PERCENT-ENCODING: only the two digits after each `%` are case-free.
  for (const encoded of [encodeURIComponent(value), encodeURI(value)]) {
    let source = "";
    for (let i = 0; i < encoded.length; i++) {
      const esc = /^%[0-9A-Fa-f]{2}/.exec(encoded.slice(i, i + 3));
      if (esc) {
        source += `%${eitherCase(encoded[i + 1])}${eitherCase(encoded[i + 2])}`;
        i += 2;
      } else {
        source += reEscape(encoded[i]);
      }
    }
    out.push({ pattern: new RegExp(source, "g"), length: encoded.length });
  }

  // HEX: every character is a hex digit, so the whole string is case-free.
  const hex = Buffer.from(value, "utf8").toString("hex");
  if (hex) {
    out.push({
      pattern: new RegExp([...hex].map(eitherCase).join(""), "g"),
      length: hex.length,
    });
  }
  return out;
}

/**
 * Remove anything credential-shaped from text that is about to be shown.
 *
 * Three passes, in order:
 *   1. KNOWN values — every configured ComfyUI auth header value, and its bare
 *      token, in each encoding a responder might echo. Returns `null` when one
 *      occurs but is too SHORT (< 8 chars) to substitute without mangling
 *      unrelated text: the caller must then withhold the text entirely.
 *   2. KEYED assignments — `token=…`, `api_key: …`, `Authorization: Bearer …`.
 *      A secret introduced by its own name is a secret whoever it belongs to.
 *   3. OPAQUE RUNS — any long unbroken run of credential alphabet characters.
 *      This is what catches an encoding we did not anticipate, and it is why the
 *      redaction is a shape rule rather than a list of known strings.
 *
 * Passes 2 and 3 run whether or not a credential is configured: a reflected
 * body can carry someone else's secret too, and this text goes to an agent.
 */
export function scrubSecretShapedText(text: string): string | null {
  let out = text;

  // 1. Known configured values, in every encoding we can anticipate.
  for (const headerValue of Object.values(getComfyUIAuthHeaders())) {
    if (!headerValue) continue;
    // The header value may be "Bearer <token>"; handle the whole thing and the
    // bare token, so neither form survives.
    for (const base of [headerValue, headerValue.replace(/^\S+\s+/, "")]) {
      if (!base) continue;
      for (const candidate of reflectionVariants(base)) {
        if (!candidate || !out.includes(candidate)) continue;
        if (candidate.length < 8) return null; // too short to replace safely
        out = out.split(candidate).join(REDACTED);
      }
      // The case-insensitive families (percent-encoding, hex), matched by
      // pattern rather than by an enumeration that could never be complete.
      for (const { pattern, length } of reflectionPatterns(base)) {
        // A fresh regex per use: `lastIndex` on a /g pattern makes `test` and
        // `replace` interfere otherwise, and a guard that mis-fires because of
        // its own bookkeeping is not a guard.
        if (!new RegExp(pattern.source, "g").test(out)) continue;
        if (length < 8) return null; // too short to replace safely
        out = out.replace(new RegExp(pattern.source, "g"), REDACTED);
      }
    }
  }

  // 2. Anything introduced BY NAME as a credential, however short.
  out = out.replace(
    /\b(authorization|auth[-_]?token|access[-_]?token|api[-_]?key|apikey|client[-_]?secret|secret|password|passwd|token|key)\b(\s*(?:[:=]|&#61;|%3D)\s*)(?:(bearer|token|basic)(\s+))?["']?([^"'\s&<>,;)]{3,})/gi,
    (_m, name: string, sep: string, scheme: string | undefined, gap: string | undefined, _v: string) =>
      `${name}${sep}${scheme ? `${scheme}${gap ?? " "}` : ""}${REDACTED}`,
  );

  // 3. Long opaque runs of the credential alphabet (base64 / hex / url-safe /
  //    percent-encoded). Ordinary prose and HTML break well before 24 chars —
  //    tags, spaces and punctuation are all outside this class.
  out = out.replace(/[A-Za-z0-9\-._~+/=%]{24,}/g, REDACTED);

  return out;
}

/** Back-compat alias: the known-value redaction is now one pass of the
 *  shape-based scrubber. Callers that only want "is this safe to print" should
 *  use `scrubSecretShapedText`/`bodyPrefixOf`. */
export function redactComfyAuthValues(text: string): string | null {
  return scrubSecretShapedText(text);
}

/**
 * Is the BODY actually markup?
 *
 * The Content-Type header is a CLAIM, not evidence — a `200 text/html` carrying
 * a truncated `{"devices":[` was reported as "an HTML page" from "some HTTP
 * responder other than the ComfyUI JSON API", sending the user to blame their
 * base URL or their proxy when the real problem was a cut-off response
 * (coordinator finding). A truncated body and a proxy error page have entirely
 * different remedies, so the header alone must never pick one.
 */
function looksLikeHtml(body: string): boolean {
  return /^\s*(<!doctype\b|<html\b|<\?xml\b|<[a-z!/])/i.test(body);
}

/**
 * The body BEGINS like JSON and does not parse.
 *
 * That is the WHOLE of what this predicate establishes: the body is malformed
 * JSON. It does NOT establish truncation. A complete gateway payload such as
 * `{"error": invalid}` satisfies it exactly as a cut-off body does, and so does
 * a JSON-shaped body from a responder that is not the ComfyUI API. Naming it
 * `looksLikeTruncatedJson` and narrating it as "a truncated or cut-off response
 * rather than a different responder" handed one candidate's remedy to all three
 * and explicitly ruled out another — the same defect as inferring HTML from the
 * Content-Type header, relocated to the body (codex gate).
 */
function looksLikeMalformedJson(body: string): boolean {
  const t = body.trim();
  if (!t.startsWith("{") && !t.startsWith("[")) return false;
  try {
    JSON.parse(t);
    return false; // it parses; not our case
  } catch {
    return true;
  }
}

/**
 * Is this body ACTUALLY a sign-in page?
 *
 * A bare `login` / `authenticate` anywhere in the body is not evidence — an
 * nginx 502 with a "login" link in its footer would be reported as a
 * body-CONFIRMED auth gate, sending the user to configure gateway credentials
 * instead of diagnosing a proxy failure. Require something only a sign-in page
 * has: a password field, a form that posts to a sign-in route, or a title that
 * says so.
 */
function looksLikeLoginPage(body: string): boolean {
  return (
    /<input[^>]+type=["']?password/i.test(body) ||
    /<form[^>]+action=["'][^"']*(?:login|signin|sign-in|auth|sso|saml|oauth)/i.test(body) ||
    /<title>[^<]*\b(sign[- ]?in|log[- ]?in|authentication required|single sign-on)\b/i.test(body)
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
  // EVIDENCE, not the header's claim. `claimsHtml` is reported as a claim; only
  // `html` (the body really is markup) may drive a diagnosis.
  const html = looksLikeHtml(body);
  const claimsHtml = /\b(text\/html|application\/xhtml\+xml)\b/i.test(contentType);
  const malformedJson = looksLikeMalformedJson(body);

  // A STATUS alone never proves who produced it — ComfyUI, or an application
  // layer in front of it, can emit 401/403 and 502/503/504 alike. Assert a cause
  // only when the BODY carries the corresponding markers; otherwise name the
  // likely candidates and say the response does not settle it (codex gate,
  // round 2, finding 6).
  // BODY EVIDENCE OUTRANKS STATUS, and a confirmed PROXY page outranks a
  // status-only auth guess. An nginx 502 whose footer happens to link to a
  // login page must be diagnosed as the proxy failure it is, not as a
  // "body-confirmed" auth gate that sends the user to configure gateway
  // credentials (coordinator finding).
  const proxyPage = html && looksLikeProxyErrorPage(body);
  const loginPage = html && looksLikeLoginPage(body);
  const gatewayStatus = status === 502 || status === 503 || status === 504;
  const authStatus = status === 401 || status === 403;

  let kind: NonJsonKind;
  let cause: string;
  if (proxyPage || (gatewayStatus && !loginPage)) {
    kind = "proxy-error";
    cause = proxyPage
      ? "a reverse proxy in front of ComfyUI returned its OWN error page (its markers are in the body) — the proxy is up but could not reach, or timed out talking to, ComfyUI itself"
      : `a gateway-class status (${status}) came back with a non-JSON body; ComfyUI does not normally emit these, so something between you and it most likely did, though this response does not identify what`;
  } else if (authStatus || loginPage) {
    kind = "login";
    cause = loginPage
      ? "an authentication gate answered with a SIGN-IN PAGE (a password field, a sign-in form action, or a sign-in title is in the body) rather than letting the request through to ComfyUI — typically an identity proxy such as Cloudflare Access or an SSO portal"
      : `the request was rejected with ${status} and the body is not JSON; this is most often an identity proxy or sign-in gate in front of ComfyUI, but ComfyUI behind your own auth layer can return it too, and this response does not distinguish them`;
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
  } else if (malformedJson) {
    kind = "not-json";
    // OBSERVED: the body starts with `{` or `[` and JSON.parse rejects it. That
    // is malformed JSON and nothing more. Calling it "a truncated or cut-off
    // response rather than a different responder" asserted BOTH a cause and the
    // exclusion of a rival cause from a predicate that supports neither (codex
    // gate). Name what was seen, list every candidate it is consistent with, and
    // assert none of them.
    cause =
      "the body BEGINS like JSON and does not parse — that is all this response establishes. " +
      "It is equally consistent with a body cut off mid-document (a dropped connection, a proxy read/body-size or buffer limit, a stream that ended early), " +
      "with a COMPLETE but invalid JSON payload (a gateway, WAF or error handler that emits malformed JSON), " +
      "and with a JSON-shaped body from a responder that is not the ComfyUI API. " +
      "Nothing in this response distinguishes them, so compare the body prefix below against the length the response declared, and check whatever sits between you and ComfyUI, before assuming truncation";
  } else {
    kind = "not-json";
    cause =
      `the body did not parse as JSON and is not markup either` +
      (claimsHtml
        ? ", although the response DECLARES itself text/html — the declaration and the body disagree, so neither settles what answered" : "") +
      ". The candidates are a truncated response, a non-JSON error payload, or a responder that is not the ComfyUI JSON API; this response does not identify which";
  }

  const what = html
    ? "an HTML page"
    : malformedJson
      ? "a body that begins like JSON but does not parse"
      : contentType
        ? `a ${contentType} body that did not parse as JSON`
        : "a body that did not parse as JSON";
  const message =
    `${url} answered ${status} with ${what} where JSON was expected. This means ${cause}. ` +
    `Content-Type: ${contentType || "(none)"}. Body starts: ${bodyPrefix || "(empty)"}. ` +
    `Confirm the configured ComfyUI base URL really is a ComfyUI API root — a URL that loads the ComfyUI UI in a browser is not proof, because the UI is served by the same catch-all that produced this page. ` +
    `The check is that ${getComfyUIBaseUrl()}/system_stats returns JSON with a "system"/"devices" shape; if it returns HTML too, the base URL, its path prefix, or the proxy's route map is wrong` +
    // The credential instruction must follow the same evidence rule as the
    // diagnosis above. Only a body-confirmed sign-in page justifies "give it to
    // the gateway"; a bare 401/403 could equally be ComfyUI's own auth layer, and
    // sending the user to configure the wrong side wastes the round trip (codex
    // gate, round 5, finding 4).
    (kind === "login"
      ? loginPage
        ? `, and the credential belongs to that GATEWAY, not to ComfyUI: set COMFYUI_AUTH_TOKEN / COMFYUI_AUTH_HEADER, or the CF_ACCESS_CLIENT_ID + CF_ACCESS_CLIENT_SECRET pair.`
        : `. Whichever layer rejected the request is the one that needs the credential — this response does not say which; the connector sends COMFYUI_AUTH_TOKEN / COMFYUI_AUTH_HEADER (and the CF_ACCESS_CLIENT_ID + CF_ACCESS_CLIENT_SECRET pair) on every ComfyUI request, so configure them for whichever layer is doing the rejecting.`
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
 * An error's message with any configured ComfyUI credential removed — for the
 * parser errors that QUOTE the body they choked on, which a reflecting gateway
 * can have filled with our own token. Falls back to a placeholder when the
 * credential is too short to substitute safely: a message is never worth
 * handing a credential back through.
 */
export function redactErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return (
    redactComfyAuthValues(raw) ??
    "(message withheld: it contains the configured ComfyUI credential)"
  );
}

/**
 * The error itself, safe to propagate: the SAME object when its message carries
 * no configured credential (so identity, type and stack survive for callers that
 * match on them), and a redacted copy when it does.
 *
 * Every rethrow path must go through this. Redacting only the branch that builds
 * a diagnosis left the inconclusive-probe branch rethrowing the library's raw
 * parse message — which quotes the body — straight into a tool result (codex
 * gate, round 6, finding 2).
 */
export function redactedError(err: unknown): unknown {
  const raw = err instanceof Error ? err.message : String(err);
  const safe = redactErrorMessage(err);
  if (safe === raw) return err;
  const copy = new Error(safe);
  if (err instanceof Error) {
    copy.name = err.name;
    // A Node stack EMBEDS the message in its first line, so copying it verbatim
    // would carry the credential straight past the redaction and into any
    // unhandled-rejection log (codex gate, round 8, finding 3). Redact the stack
    // with the same substitution, and drop it entirely when that is not safe —
    // a stack trace is never worth handing a credential back through.
    const stack = err.stack ? redactComfyAuthValues(err.stack) : undefined;
    if (stack) copy.stack = stack;
  }
  return copy;
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
 * diagnosis; otherwise rethrow the original, unchanged except that a configured
 * credential is redacted out of its message (the message quotes the body, and
 * the body may reflect our own token — that must not depend on whether the probe
 * happened to be conclusive).
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
      // The library's raw parse message quotes the body it choked on, so it can
      // carry a credential a reflecting gateway echoed back. Redact it like any
      // other body text, and withhold it entirely when redaction cannot be done
      // safely (codex gate, round 5, finding 5).
      const original = redactErrorMessage(err);
      throw new NonJsonResponseError({
        ...diagnosis,
        message:
          `The request failed while parsing the response as JSON: ${original} ` +
          `A follow-up probe of ${url} — a separate request, so not necessarily the same response — found: ${diagnosis.message}`,
      });
    }
  }
  throw redactedError(err);
}
