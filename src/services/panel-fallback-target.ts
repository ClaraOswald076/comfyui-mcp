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
 * May a DIFFERENT server be asked because of this failure?
 *
 * True only for NEVER_CONNECTED_CODES: this process never established a
 * connection to the address it was configured to use, so nothing there answered
 * and nothing there can have acted.
 *
 * An UNRECOGNISED or absent code answers false. That default is the whole point —
 * the trigger this replaces allowed every error it did not specifically name, so
 * an ECONNRESET on an established connection (the server was plainly there) sent
 * the question to a second machine.
 *
 * Aborts are rejected explicitly rather than by omission from the set, because
 * they carry no code to look up: a caller's own deadline says only that we
 * stopped waiting, and the connection may well have been accepted.
 */
export function mayAskAnotherServer(err: unknown): boolean {
  if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
    return false;
  }
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
export function describeDeclinedPanelFallback(choice: PanelFallbackChoice): string {
  if (choice.kind !== "ambiguous") return "";
  return (
    ` I did NOT retry against a connected panel: ${choice.origins.length} different ComfyUI ` +
    `origins are connected (${choice.origins.join(", ")}), and choosing one of them would risk ` +
    `answering from a server you did not mean. Point COMFYUI_URL at the one you want.`
  );
}
