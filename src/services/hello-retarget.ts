// Panel-`hello` ComfyUI-target retarget policy (#303 zombie-tab guard + #756
// restart-window fix), extracted from the orchestrator so the decision is
// unit-testable. Pure decision logic — the probe is injected, so no I/O lives
// here.
//
// Background: a panel tab's hello carries the ComfyUI URL the browser was
// SERVED from (window.location), and the orchestrator retargets to it — that
// is the auto-point-at-whatever-ComfyUI-the-user-has-open mechanism, and the
// ONLY refresh of the connected target after a ComfyUI restart (a connected
// panel never re-hellos). #303 added a liveness veto: probe the hello URL's
// /system_stats first and drop the retarget when it doesn't answer, because a
// STALE browser tab on a DEAD instance kept dragging the target to a corpse.
//
// #756: the veto was UNCONDITIONAL — it also dropped the correction back to a
// LOCAL target when that hello raced the local ComfyUI's own restart window
// (the one moment /system_stats is guaranteed to read dead). With the stale
// (possibly REMOTE) target kept and no re-hello ever arriving, the
// orchestrator — and every tool child respawned against it — stayed pinned to
// the dead remote: asset tools returned `fetch failed`, local-only ref inputs
// were rejected ("ref items need a LOCAL ComfyUI"), and Manager probes
// reported the queue API unreachable while the local server answered 200. A
// durable decision — the connected target, hence the local/remote
// classification — was keyed on a transient signal (one 3s probe taken
// mid-restart).
//
// The policy below keeps the #303 protection where it matters and removes the
// #756 pin: the veto protects a HEALTHY current target from a dead hello, and
// can never KEEP a dead one. Locality is always classified from the target
// URL's host (durable), never from a probe reading (transient).

export type HelloRetargetReason =
  /** The hello carried no usable URL string — nothing to apply. */
  | "not-a-url"
  /** The hello IS the current target — a no-op retarget; never probed. */
  | "same-target"
  /** RunPod proxies skip the probe (#303: booting pods answer late — readiness is the connector's job). */
  | "runpod-proxy"
  /** The hello's instance answered /system_stats. */
  | "healthy"
  /** #303 zombie-tab guard: hello dead, current target healthy — KEEP current. */
  | "vetoed-unreachable"
  /** #756: hello dead but the current target reads dead too — trust the live tab's hello. */
  | "current-also-unreachable";

export interface HelloRetargetVerdict {
  /** Whether the caller should apply the hello's retarget. */
  apply: boolean;
  reason: HelloRetargetReason;
  /** The normalized hello base URL (trimmed, trailing slashes stripped), when usable. */
  base?: string;
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

/**
 * Decide whether a panel hello's `comfyui_url` should be applied as the new
 * ComfyUI target. `probe` answers whether a given /system_stats URL responds
 * (the caller supplies the timeout); it must never throw — a probe failure
 * reads as unreachable.
 */
export async function judgeHelloRetarget(opts: {
  helloUrl: unknown;
  currentUrl: string;
  probe: (systemStatsUrl: string) => Promise<boolean>;
}): Promise<HelloRetargetVerdict> {
  const { helloUrl, currentUrl, probe } = opts;
  if (typeof helloUrl !== "string") return { apply: false, reason: "not-a-url" };
  const base = helloUrl.trim().replace(/\/+$/, "");
  if (!base) return { apply: false, reason: "not-a-url" };
  // RunPod proxies skip the probe: a booting pod answers late — readiness is
  // the connector's job (#303).
  if (/\.proxy\.runpod\.net/i.test(base)) {
    return { apply: true, reason: "runpod-proxy", base };
  }
  // A hello for the CURRENT target is a no-op retarget (applyComfyuiUrl dedupes
  // it) — never probe: during the target's OWN restart window the probe reads
  // dead, stalling every reconnect for seconds to decide nothing.
  if (canonComfyuiTargetUrl(base) === canonComfyuiTargetUrl(currentUrl)) {
    return { apply: true, reason: "same-target", base };
  }
  if (await probe(`${base}/system_stats`)) {
    return { apply: true, reason: "healthy", base };
  }
  // The hello's instance doesn't answer. Veto ONLY while the current target is
  // healthy (#303's zombie-tab guard: a stale tab on a dead instance must not
  // steal a GOOD target). When the current target doesn't answer EITHER, both
  // reads are dead — trust the live tab's hello: it reflects the browser
  // session the user actually has open, applying keys locality on the hello
  // URL's durable host (never on a transient probe), and it is the
  // self-healing direction. #756: vetoing the LOCAL hello during the ComfyUI
  // restart window pinned a stale REMOTE target forever — a connected panel
  // never re-hellos — leaving every tool misclassified as remote.
  const currentBase = currentUrl.trim().replace(/\/+$/, "");
  if (currentBase && (await probe(`${currentBase}/system_stats`))) {
    return { apply: false, reason: "vetoed-unreachable", base };
  }
  return { apply: true, reason: "current-also-unreachable", base };
}
