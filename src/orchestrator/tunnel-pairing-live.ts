/**
 * #875 / #1176 / #1961 — should the self-restarter defer because a phone is
 * paired over a TUNNEL?
 *
 * A tunnel URL cannot survive a restart: cloudflared mints a fresh quick-tunnel
 * hostname per run and there is no way to pin it. Restarting under a live tunnel
 * therefore breaks a phone that is using that URL. A LAN URL is fine (the token
 * persists), which is why this is narrowed to the tunnel rather than to pairing
 * in general.
 *
 * Requires BOTH a tunnel AND a headless client that is live-or-recent.
 * `pairTunnel` alone is not liveness — nothing stops the tunnel until the
 * process exits, so gating on it would postpone every future update after a
 * single pairing.
 *
 * Live-socket-only (`hasLiveHeadlessClient`) is the wrong half of that AND.
 * A phone in a pocket drops its socket (screen off, app backgrounded, wifi/5G
 * handoff) and is still the user of this URL. #1176 folded a recency window
 * *into* `hasLiveHeadlessClient`, which left this gate looking like the original
 * live-only check — the exact reading #1961 verified against 0.52.41's dist —
 * and chose thirty minutes, which is shorter than the hourly auto-update check,
 * so a pocketed phone still had its hostname rotated.
 *
 * Recency belongs HERE, next to the tunnel, with a window measured in hours.
 */

import { HEADLESS_RECENCY_MS } from "../services/ui-bridge.js";

export interface HeadlessLiveness {
  hasLiveHeadlessClient(): boolean;
  headlessSeenWithin(ms: number): boolean;
}

/** True when a tunnel exists AND a headless client is connected now, or was
 *  within `HEADLESS_RECENCY_MS`. */
export function tunnelPairingLive(
  pairTunnel: unknown,
  bridge: HeadlessLiveness,
): boolean {
  return (
    pairTunnel !== null &&
    (bridge.hasLiveHeadlessClient() || bridge.headlessSeenWithin(HEADLESS_RECENCY_MS))
  );
}
