// Choosing a CONNECTED-PANEL origin to retry a failed headless read against (#1415).
//
// The reported failure: `list_packs (action:"list_templates")` addresses
// `getComfyUIBaseUrl()` — the headless COMFYUI_URL — while the sidebar panel is
// connected to a different, live ComfyUI. Every panel_* graph tool worked and
// this one failed, because the two use different transports by design.
//
// #952 built the drift COMPARISON and #1553 (0.51.42) made it reachable from the
// spawned stdio child, which is where these calls actually run. Both stop at
// DESCRIBING the drift. This module is the smallest step past that: when the
// headless address could not be reached at all, decide whether there is exactly
// one other ComfyUI we already know a browser is sitting on, and may therefore
// ask instead.
//
// ## What a published origin does and does NOT establish
//
// It is UiBridge's `serverOrigin` — the Origin header the browser set on the
// WebSocket upgrade, which page JS cannot forge. So it establishes: a tab
// connected to this orchestrator was serving a page from this origin. That is a
// real, server-observed fact, and it is the strongest thing available here.
//
// It establishes NOTHING about:
//   - whether THIS process can reach that origin (a tunnel or a container
//     boundary is exactly the case where the browser can and we cannot);
//   - whether a ComfyUI answers there rather than some other server on the same
//     host:port;
//   - whether that ComfyUI is mounted at the root (an Origin carries no path, so
//     a basePath mount is invisible here).
//
// The caller must therefore treat a chosen origin as a THING TO TRY, never as a
// resolved target: it may only be used for a read whose own response is checked
// for shape, the result must NAME which server answered, and no configured
// credential may be sent to it (see the caller — the fallback request carries no
// auth headers, because COMFYUI_AUTH_* was configured for the headless target
// and an origin we did not configure must not receive it).
//
// ## Why AMBIGUOUS refuses instead of picking
//
// Two tabs on two different ComfyUIs is an ordinary state (a second pod, a LAN
// rig, a Desktop install alongside a portable one). With two candidates there is
// no rule here that can identify the one the caller meant — neither "first
// connected" nor "the one that looks local" is evidence — and answering a
// question about templates from the wrong install is a silently wrong answer,
// which is worse than the loud failure it replaced. So the ambiguity is
// reported, both candidates are named, and the caller keeps failing.

import { describeFetchFailure } from "../utils/errors.js";
import { canonicalOrigin } from "../utils/origin.js";

/**
 * Failure codes that establish NO CONNECTION TO THE FAILED ADDRESS WAS EVER
 * ESTABLISHED — so no HTTP server there received this request.
 *
 * That sentence is the entire contract, and it is deliberately much narrower
 * than "the request failed". Member by member:
 *
 *   - ECONNREFUSED             the host answered the SYN with a RST: something is
 *                              at that address, nothing is listening on that port.
 *   - ENOTFOUND                the name did not resolve, so nothing was dialled.
 *   - EAI_AGAIN                the resolver itself failed; again no address, so
 *                              no connection was attempted.
 *   - EHOSTUNREACH/ENETUNREACH the stack could not route there at all.
 *   - UND_ERR_CONNECT_TIMEOUT  undici's CONNECT phase expired with no completed
 *                              handshake.
 *
 * What it does NOT establish, and must not be read as: that no ComfyUI exists
 * there. A firewall dropping SYNs, a stopped container and a genuinely empty
 * address are identical from here. It establishes only that THIS PROCESS did not
 * talk to a server — which is the precondition for asking a different one, and
 * nothing more.
 *
 * ## Why this is NOT comfyui/fetch.ts's NEVER_DELIVERED_CODES
 *
 * The two sets look interchangeable and answer OPPOSITE questions. Sharing one
 * would be exactly the failure this project has already paid for once — a
 * loopback test that stood in for "this machine", kept its name after the
 * question changed, and silently un-shipped #742.
 *
 * NEVER_DELIVERED_CODES asks "could the server have ACTED on my POST?". A TLS
 * handshake failure counts as never-delivered there, and correctly so: no
 * application byte was ever written.
 *
 * This set asks "was there no server at that address at all?". To THAT question a
 * TLS handshake failure is the opposite answer — the TCP connection completed and
 * a peer answered the ClientHello, so a server IS there and the problem is trust
 * configuration. Falling back on it would hide a fixable local misconfiguration
 * behind an answer from a different machine.
 *
 * So the TLS codes are present there and absent here on purpose, and the two sets
 * must not be merged. A test pins them apart.
 *
 * Also deliberately absent:
 *   - ECONNRESET, EPIPE, UND_ERR_SOCKET, "socket hang up" — an ESTABLISHED
 *     connection died. A server was there and completed the handshake.
 *   - ETIMEDOUT — AMBIGUOUS. The OS raises it both for an unanswered SYN and for
 *     an idle established socket, and "unambiguous" is the bar.
 *   - UND_ERR_HEADERS_TIMEOUT / UND_ERR_BODY_TIMEOUT — connected; the server was
 *     merely slow to answer.
 *   - ERR_INVALID_URL, ERR_UNSUPPORTED_PROTOCOL — a malformed COMFYUI_URL says
 *     nothing about any server and must be reported rather than routed around.
 *     (choosePanelFallbackOrigin already answers `none` for a target it cannot
 *     parse, so these would be dead weight even under a different policy.)
 */
export const NEVER_CONNECTED_CODES: ReadonlySet<string> = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
]);

/**
 * Ports `fetch` REFUSES BEFORE DIALING — the Fetch standard's "bad port" list.
 *
 * ## Why this exists at all: the code-only predicate shipped DEAD
 *
 * #1415's reporter had `COMFYUI_URL=http://127.0.0.1:9`. Port 9 is on this list,
 * so node never opens a socket: it rejects with `TypeError: fetch failed` whose
 * cause is a bare `Error: "bad port"` carrying **no `code`**. A predicate that
 * asks only "is there a never-connected error code?" therefore answered NO for
 * the exact configuration the feature was written for, and the fallback never
 * ran — while a suite full of synthesized `ECONNREFUSED` stayed green. Green
 * tests proved the code matched the tests; they could not prove production
 * reached it.
 *
 * ## Why a pre-dial refusal BELONGS in a "never connected" predicate
 *
 * It satisfies the contract more strongly than `ECONNREFUSED` does. On
 * ECONNREFUSED a packet left this machine and something answered with a RST; on
 * a bad port nothing is sent at all — the request dies in the URL check. So "no
 * connection to that address was ever established" is not merely true, it is
 * true by construction, and no server can possibly have acted.
 *
 * ## Why the PORT is checked and not the error text
 *
 * The refusal carries no code, so the only thing undici hands over is the string
 * "bad port". Gating production behaviour on a library's internal prose is the
 * shape of predicate this project has been burned by. The port is structural: if
 * a URL names a blocked port, `fetch` can never dial it, so ANY failure on that
 * URL is necessarily pre-dial — which is why the check below does not need to
 * inspect the error at all.
 *
 * ## This list is MEASURED, not remembered
 *
 * Every entry was driven through a real `fetch` on this runtime and confirmed to
 * answer "bad port", and a control set (80, 443, 3000, 8000, 8080, 8188, 8199,
 * 11434, …) was confirmed NOT to be refused. `fetch-bad-port-list.test.ts` re-runs
 * that measurement against the live runtime, so if node's list ever diverges from
 * this one the suite says so instead of the feature quietly dying again.
 */
export const FETCH_BLOCKED_PORTS: ReadonlySet<number> = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102,
  103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465,
  512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993,
  995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668,
  6669, 6679, 6697, 10080,
]);

/** Schemes `fetch` will actually dial. Anything else dies in the URL check with
 *  "unknown scheme" — measured — and again carries no code. */
const DIALABLE_PROTOCOLS: ReadonlySet<string> = new Set(["http:", "https:"]);

/**
 * Can `fetch` not even ATTEMPT this URL?
 *
 * True when the target names a blocked port or a scheme fetch does not dial. In
 * both cases the request is refused during the URL check, before any socket
 * exists — so the answer is a property of the ADDRESS, independent of whatever
 * error came back.
 *
 * An unparseable URL answers false: "I cannot read this" is not evidence about a
 * server, and choosePanelFallbackOrigin already declines a target it cannot
 * parse.
 */
export function isUndialableTarget(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (!DIALABLE_PROTOCOLS.has(parsed.protocol)) return true;
  // `port` is "" for a default port (80/443), neither of which is blocked.
  if (parsed.port === "") return false;
  return FETCH_BLOCKED_PORTS.has(Number(parsed.port));
}

/**
 * May a DIFFERENT server be asked because of this failure?
 *
 * Establishes exactly one thing, by either of two independent routes:
 *
 *   **NO CONNECTION TO `failedUrl` WAS EVER ESTABLISHED.**
 *
 *   1. STRUCTURAL — `fetch` cannot dial that address at all (a blocked port, a
 *      scheme it does not speak). Then no socket was opened whatever the error
 *      says, which is why this route ignores `err` entirely. This is the route
 *      the #1415 reporter's `http://127.0.0.1:9` takes, and the route whose
 *      absence made the first version of this fix a no-op for them.
 *   2. BY CODE — the transport reported a failure that happens before any byte
 *      reaches an application (NEVER_CONNECTED_CODES).
 *
 * An UNRECOGNISED or absent code still answers false on route 2. That default is
 * the point: the trigger this replaced allowed every error it did not name, so an
 * ECONNRESET on an established connection (the server was plainly there) sent the
 * question to a second machine. Route 1 is not a loosening of that — it is a
 * stronger proof of the same claim, established from the address rather than from
 * the error.
 *
 * Aborts are rejected first and explicitly, because they carry no code to look up:
 * a caller's own deadline says only that we stopped waiting, and the connection
 * may well have been accepted. (An abort cannot in practice reach route 1 — a
 * blocked-port fetch rejects before there is anything to wait for — but the order
 * is fixed here rather than left to that argument holding.)
 */
export function mayAskAnotherServer(err: unknown, failedUrl: string): boolean {
  if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
    return false;
  }
  if (isUndialableTarget(failedUrl)) return true;
  const { code } = describeFetchFailure(err);
  return code !== undefined && NEVER_CONNECTED_CODES.has(code);
}

/**
 * What to do about a connected panel after a headless read failed at the network
 * layer.
 *
 *  - `none`       — nothing published (a plain MCP server, no panel, or a
 *                   handshake that carried no Origin), or the failed target does
 *                   not parse. Say nothing; an absent comparison is not a
 *                   negative result.
 *  - `same`       — every connected panel is on the origin that just failed.
 *                   There is no different address to try, and the drift text
 *                   already says so.
 *  - `ambiguous`  — two or more DIFFERENT origins are connected. Refuse to pick.
 *  - `use`        — exactly one different origin. `origin` is the ORIGINAL
 *                   published spelling, not the canonical one: the canonical
 *                   form exists to compare with, and connecting to a rewritten
 *                   host would be addressing something the browser never named.
 */
export type PanelFallbackChoice =
  | { kind: "none" }
  | { kind: "same"; origin: string }
  | { kind: "ambiguous"; origins: string[] }
  | { kind: "use"; origin: string };

/**
 * Pick the one connected-panel origin worth retrying `failedTarget` against.
 *
 * Pure and total: never throws, never performs I/O, and makes no claim about
 * reachability. `origins` is what the orchestrator published
 * (services/panel-origin-channel.ts) or injected (comfyui/fetch.ts).
 */
export function choosePanelFallbackOrigin(
  failedTarget: string,
  origins: readonly string[],
): PanelFallbackChoice {
  // Keep the FIRST spelling seen for each canonical origin, so `use` returns
  // something the browser actually reported. Insertion order is connection
  // order, which is not evidence of anything — it is used only to make the
  // single-candidate case deterministic, never to break a tie between two.
  const byCanonical = new Map<string, string>();
  for (const raw of origins) {
    if (typeof raw !== "string" || raw.trim() === "") continue;
    const canon = canonicalOrigin(raw);
    if (canon === undefined) continue;
    if (!byCanonical.has(canon)) byCanonical.set(canon, raw.trim());
  }
  if (byCanonical.size === 0) return { kind: "none" };
  // An unparseable target cannot be compared, and "different from something I
  // cannot read" is not a finding. Fail to `none` rather than treat every
  // candidate as different.
  const want = canonicalOrigin(failedTarget);
  if (want === undefined) return { kind: "none" };

  const different: string[] = [];
  let sameAs: string | undefined;
  for (const [canon, spelling] of byCanonical) {
    if (canon === want) sameAs = spelling;
    else different.push(spelling);
  }
  if (different.length === 0) {
    // `sameAs` is necessarily set here: the map is non-empty and nothing landed
    // in `different`. Asserted through a fallback rather than a `!` so a future
    // edit that breaks the partition degrades to "say nothing".
    return sameAs === undefined ? { kind: "none" } : { kind: "same", origin: sameAs };
  }
  if (different.length > 1) return { kind: "ambiguous", origins: different };
  return { kind: "use", origin: different[0] };
}

/**
 * The sentence explaining why a connected panel did NOT get asked, or "" when
 * there is nothing to add.
 *
 * Only the `ambiguous` case produces text. `none` and `same` are already covered
 * by describeTargetDrift (comfyui/fetch.ts), which the thrown error carries —
 * repeating them would be noise, and re-deriving them here would be a second
 * comparison that can disagree with the first.
 */
export function describeDeclinedPanelFallback(
  choice: PanelFallbackChoice,
  ageMs?: number,
): string {
  if (choice.kind !== "ambiguous") return "";
  return (
    ` I did NOT retry against a connected panel: ${choice.origins.length} different ComfyUI ` +
    `origins were published${describeOriginAge(ageMs)} as connected sidebar panel origins ` +
    `(${choice.origins.join(", ")}), and choosing one of them would risk answering from a server ` +
    `you did not mean. Point COMFYUI_URL at the one you want.`
  );
}

/**
 * The age of the published origin evidence, as a phrase (#1415 review r2,
 * finding 2).
 *
 * This sentence used to say the origins "are connected" — the same present-tense
 * claim about panels, from the same up-to-two-minutes-old record, that round one
 * retired from four other messages. It survived here because the declined path is
 * the one branch that never reaches them, and the sweep that proved the others
 * used a single origin, so the ambiguous case it guards could not arise.
 *
 * Kept next to the only sentence that uses it rather than shared with
 * skills-access's observedAgo: this module is a leaf that must not import a tool,
 * and one duplicated four-line formatter is cheaper than the dependency. A test
 * pins the two spellings together.
 */
function describeOriginAge(ageMs: number | undefined): string {
  if (ageMs === undefined) return "";
  if (ageMs < 1000) return " a moment ago";
  return ` about ${Math.round(ageMs / 1000)}s ago`;
}
