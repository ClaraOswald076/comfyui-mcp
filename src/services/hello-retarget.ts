// Panel-`hello` ComfyUI-target retarget policy (#303 zombie-tab guard + #756
// restart-window fix + the codex-gate trust model), extracted from the
// orchestrator so the decision is unit-testable. Pure decision logic — the
// probe is injected, so no I/O lives here.
//
// Background: a panel tab's hello carries the ComfyUI URL the browser was
// SERVED from (window.location), and the orchestrator retargets to it — that
// is the auto-point-at-whatever-ComfyUI-the-user-has-open mechanism, and the
// ONLY refresh of the connected target after a ComfyUI restart (a connected
// panel never re-hellos). #303 added a liveness veto: probe the hello URL's
// /system_stats first and drop the retarget when it doesn't answer, because a
// STALE browser tab on a DEAD instance kept dragging the target to a corpse.
// #756: the veto was UNCONDITIONAL — it also dropped the correction back to a
// LOCAL target when that hello raced the local ComfyUI's own restart window,
// pinning a stale (possibly REMOTE) target forever.
//
// TRUST MODEL (codex gate on #756): hello.comfyui_url is page-JS-writable —
// a stale, confused, or malicious tab can CLAIM any instance. The ONLY
// unspoofable proof of which ComfyUI a real browser tab fronts is the
// server-observed WebSocket handshake Origin (ui-bridge's serverOrigin: the
// browser sets it and forbids page scripts from overriding it). So the
// decision is two-tiered:
//
//   TRUSTED (handshake origin canonically matches the claimed URL): the tab
//   provably fronts what it names. All #303/#756 semantics apply — the
//   same-target no-probe shortcut, the RunPod-proxy skip (booting pods answer
//   late), the healthy-current veto, and the #756 both-dead recovery.
//
//   UNTRUSTED (origin mismatches, or absent — a non-browser/relay client):
//   NOTHING is taken on the claim's word. No no-probe shortcut (the
//   same-target comparison keys on the observed origin, never the bare
//   claim), no proxy skip, and NO both-dead recovery — applying a
//   wrong-host retarget to an unverifiable claim is the wrong-workflow
//   hazard the gate closed. The claim may still apply on EVIDENCE: probe
//   the claimed instance, and a live, answering one earns the retarget; a
//   dead one fails closed.
//
// Locality is always classified from the target URL's host (durable), never
// from a probe reading (transient).

export type HelloRetargetReason =
  /** The hello carried no usable URL string — nothing to apply. */
  | "not-a-url"
  /** TRUSTED: the tab provably fronts the CURRENT target — a no-op retarget; never probed. */
  | "same-target"
  /** TRUSTED RunPod proxy: skips the probe (#303: booting pods answer late — readiness is the connector's job). */
  | "runpod-proxy"
  /** TRUSTED: the claimed instance answered /system_stats. */
  | "healthy"
  /** UNTRUSTED claim applied on EVIDENCE: the claimed instance answered /system_stats. */
  | "healthy-untrusted"
  /** TRUSTED #303 zombie-tab guard: claim dead, current target healthy — KEEP current. */
  | "vetoed-unreachable"
  /** UNTRUSTED and dead: refused — never retarget on an uncorroborated claim. */
  | "vetoed-untrusted"
  /** TRUSTED #756: claim dead but the current target reads dead too — trust the live tab's hello. */
  | "current-also-unreachable";

export interface HelloRetargetVerdict {
  /** Whether the caller should apply the hello's retarget. */
  apply: boolean;
  reason: HelloRetargetReason;
  /** The normalized hello base URL (trimmed, trailing slashes stripped), when usable. */
  base?: string;
  /** Whether the claimed URL was corroborated by the tab's server-observed
   *  handshake origin (the only unspoofable proof of which instance the tab
   *  fronts). Trust gates every no-probe shortcut and the #756 recovery. */
  trusted: boolean;
}

/**
 * Canonical form for same-target comparisons — scheme-aware but
 * DEFAULT-PORT-INSENSITIVE: strip only the scheme's actual default (:443 for
 * https, :80 for http); http://h:443 and http://h are NOT the same endpoint.
 * Trailing slashes stripped. Unparseable input is returned slash-stripped.
 * This is the single implementation the orchestrator's target dedupe and this
 * module's same-target check share, so the two can never drift apart.
 */
export function canonComfyuiTargetUrl(u: string): string {
  try {
    const p = new URL(u);
    if ((p.protocol === "https:" && p.port === "443") || (p.protocol === "http:" && p.port === "80")) p.port = "";
    return p.toString().replace(/\/+$/, "");
  } catch {
    return u.replace(/\/+$/, "");
  }
}

/** Loopback family canonicalization, mirroring loopbackFamily in
 *  orchestrator/panel-tools.ts (kept local so this leaf module doesn't import
 *  the heavyweight panel-tools unit): every IPv4-family loopback literal
 *  (127.0.0.1 / the 0.0.0.0 wildcard) → 127.0.0.1; every IPv6-family literal
 *  (::1 / the :: wildcard) → ::1. The families stay DISTINCT — a v4 and a v6
 *  instance at the same port are different instances — and `localhost` is
 *  deliberately NOT canonicalized: a DNS-ambiguous name can't be pinned to a
 *  family, so it never aliases a concrete loopback literal. */
function loopbackFamilyKey(host: string): "127.0.0.1" | "::1" | null {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "127.0.0.1" || h === "0.0.0.0") return "127.0.0.1";
  if (h === "::1" || h === "::" || h === "0000:0000:0000:0000:0000:0000:0000:0000") return "::1";
  return null;
}

/**
 * Canonical scheme://host:port key of a ComfyUI URL for instance-identity
 * comparison — path ignored (the WebSocket handshake Origin carries none; a
 * basePath on the claim is a mount on the proven instance), default ports made
 * explicit, loopback hosts family-canonicalized. null when unparseable.
 * Mirrors httpOriginOf in orchestrator/panel-tools.ts.
 */
export function comfyuiOriginKey(rawUrl: string): string | null {
  try {
    const u = new URL(rawUrl);
    const port = u.port || (u.protocol === "https:" ? "443" : "80");
    const host = u.hostname.toLowerCase();
    return `${u.protocol}//${loopbackFamilyKey(host) ?? host}:${port}`;
  } catch {
    return null;
  }
}

/**
 * Decide whether a panel hello's `comfyui_url` should be applied as the new
 * ComfyUI target.
 *
 * `observedOrigin` is the SERVER-OBSERVED WebSocket handshake Origin of the
 * tab that sent the hello (ui-bridge's tabServerOrigin) — the ONLY unspoofable
 * corroboration of the claim. Undefined for non-browser/relay clients, whose
 * claims are therefore always probed, never trusted.
 *
 * `probe` answers whether a given /system_stats URL responds (the caller
 * supplies the timeout); it must never throw — a probe failure reads as
 * unreachable.
 */
export async function judgeHelloRetarget(opts: {
  helloUrl: unknown;
  currentUrl: string;
  observedOrigin?: string;
  probe: (systemStatsUrl: string) => Promise<boolean>;
}): Promise<HelloRetargetVerdict> {
  const { helloUrl, currentUrl, probe } = opts;
  const observedOrigin = opts.observedOrigin?.trim() || undefined;
  if (typeof helloUrl !== "string") return { apply: false, reason: "not-a-url", trusted: false };
  const base = helloUrl.trim().replace(/\/+$/, "");
  if (!base) return { apply: false, reason: "not-a-url", trusted: false };

  // TRUST: the claim is page-JS-writable; only the browser-set handshake
  // Origin (unforgeable by page JS) proves which instance the tab fronts.
  // Compared canonically at origin granularity — the Origin carries no path.
  const claimKey = comfyuiOriginKey(base);
  const originKey = observedOrigin ? comfyuiOriginKey(observedOrigin) : null;
  const trusted = claimKey !== null && originKey !== null && claimKey === originKey;

  if (!trusted) {
    // Nothing is taken on the claim's word: no no-probe shortcut (the
    // same-target comparison keys on the observed origin, never the bare
    // claim — and a trusted same-target claim implies the observed origin
    // fronts the current target, so no trusted case is lost here), no RunPod
    // skip, and NO #756 both-dead recovery. The claim may apply on EVIDENCE
    // only: a live, answering instance earns the retarget; a dead or
    // unreachable one fails closed (#303's zombie-tab hazard in its general
    // form — a wrong-host retarget is a wrong-workflow hazard regardless of
    // adversary framing).
    if (await probe(`${base}/system_stats`)) {
      return { apply: true, reason: "healthy-untrusted", base, trusted };
    }
    return { apply: false, reason: "vetoed-untrusted", base, trusted };
  }

  // TRUSTED claim: the tab provably fronts the instance it names.
  // Same-target hello — the corroborated claim IS the current target, so the
  // observed origin fronts it too: a no-op retarget that must not stall on
  // probes during the target's own restart window.
  if (canonComfyuiTargetUrl(base) === canonComfyuiTargetUrl(currentUrl)) {
    return { apply: true, reason: "same-target", base, trusted };
  }
  // RunPod proxies skip the probe: a booting pod answers late — readiness is
  // the connector's job (#303). Trust-gated: the tab fronts the pod it names.
  if (/\.proxy\.runpod\.net/i.test(base)) {
    return { apply: true, reason: "runpod-proxy", base, trusted };
  }
  if (await probe(`${base}/system_stats`)) {
    return { apply: true, reason: "healthy", base, trusted };
  }
  // The claimed instance doesn't answer. Veto ONLY while the current target
  // is healthy (#303's zombie-tab guard: a stale tab on a dead instance must
  // not steal a GOOD target). When the current target doesn't answer EITHER,
  // both reads are dead — trust the live tab's corroborated hello: applying
  // keys locality on the claim's durable host (never on a transient probe)
  // and is the self-healing direction. #756: vetoing the LOCAL hello during
  // the ComfyUI restart window pinned a stale REMOTE target forever — a
  // connected panel never re-hellos — leaving every tool misclassified as
  // remote.
  const currentBase = currentUrl.trim().replace(/\/+$/, "");
  if (currentBase && (await probe(`${currentBase}/system_stats`))) {
    return { apply: false, reason: "vetoed-unreachable", base, trusted };
  }
  return { apply: true, reason: "current-also-unreachable", base, trusted };
}
