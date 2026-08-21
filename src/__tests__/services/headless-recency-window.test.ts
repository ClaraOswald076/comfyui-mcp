// #1176 / #1961 — a BACKGROUNDED phone is not a departed phone.
//
// #875 defers a self-restart while a paired phone is present, because a restart
// mints a NEW cloudflared quick-tunnel hostname and the old one stops resolving.
// The gate asked `hasLiveHeadlessClient()`, which reads currently-OPEN sockets —
// and a phone at work with its screen off has had its socket suspended or closed
// by the mobile OS. So the gate opened, the orchestrator self-updated, and the
// reporter picked up their phone to:
//
//   Failed host lookup: 'cameron-timing-face-spies.trycloudflare.com'
//   (No address associated with hostname, errno = 7)
//
// A DNS failure, not a timeout or a refusal: the hostname no longer existed.
//
// #1176 folded a recency window into `hasLiveHeadlessClient`. That left
// `tunnelPairingLive` looking live-only (the reading #1961 verified against
// 0.52.41's dist) and chose thirty minutes — shorter than the hourly auto-update
// check, so a pocketed phone still had its hostname rotated.
//
// The shipped function is `tunnelPairingLive`. These tests drive it.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { UiBridge, HEADLESS_RECENCY_MS } from "../../services/ui-bridge.js";
import { tunnelPairingLive } from "../../orchestrator/tunnel-pairing-live.js";

const TUNNEL = { url: "wss://test.trycloudflare.com", stop: () => {} };

/** A bridge with its headless-disconnect clock placed at a chosen age. */
function bridgeWithHeadlessGoneFor(ms: number | null): UiBridge {
  const b = new UiBridge() as UiBridge & {
    markHeadlessDisconnectForTests(at: number): void;
  };
  // Monotonic, matching the field — the recency window measures ELAPSED time,
  // which the wall clock does not (codex review: an NTP step could skip it).
  if (ms !== null) b.markHeadlessDisconnectForTests(performance.now() - ms);
  return b;
}

describe("the restart-deferral gate covers a pocketed phone (#1176, #1961)", () => {
  it("still defers seconds after the socket closed — the reported case", () => {
    // The mobile OS suspends a backgrounded socket within seconds.
    expect(tunnelPairingLive(TUNNEL, bridgeWithHeadlessGoneFor(5_000))).toBe(true);
  });

  it("still defers across a meeting", () => {
    expect(tunnelPairingLive(TUNNEL, bridgeWithHeadlessGoneFor(20 * 60_000))).toBe(true);
  });

  it("still defers across a work morning", () => {
    // #1961: a phone in a pocket at work is hours, not minutes. Thirty minutes
    // lapsed before the hourly auto-update check, and the hostname rotated.
    expect(tunnelPairingLive(TUNNEL, bridgeWithHeadlessGoneFor(3 * 60 * 60_000))).toBe(true);
  });

  it("stops deferring once the phone has genuinely been gone", () => {
    // The property that killed the sticky option: this happens on its own, with
    // no unpairing step and no user action, so an install that lost its phone
    // still gets its updates.
    expect(tunnelPairingLive(TUNNEL, bridgeWithHeadlessGoneFor(HEADLESS_RECENCY_MS + 1))).toBe(false);
  });

  it("never defers on an install that has never seen a headless client", () => {
    // The clock is undefined until a headless socket actually disconnects, so a
    // desktop-only install can never be held back by this.
    expect(tunnelPairingLive(TUNNEL, bridgeWithHeadlessGoneFor(null))).toBe(false);
  });

  it("never defers when there is no tunnel, even if a phone was seen recently", () => {
    // LAN pairing survives a restart (persisted token). Recency is only for the
    // hostname that cannot be pinned.
    expect(tunnelPairingLive(null, bridgeWithHeadlessGoneFor(5_000))).toBe(false);
  });

  it("does not fold recency into hasLiveHeadlessClient", () => {
    // Folding it in is how the gate kept looking live-only (#1961). Recency is
    // a separate signal the GATE composes.
    const gone = bridgeWithHeadlessGoneFor(5_000);
    expect(gone.hasLiveHeadlessClient()).toBe(false);
    expect(gone.headlessSeenWithin(HEADLESS_RECENCY_MS)).toBe(true);
    expect(tunnelPairingLive(TUNNEL, gone)).toBe(true);
  });

  it("uses a window measured in hours, not minutes", () => {
    // The duration IS the fix. Thirty minutes (#1176) still lapsed while a phone
    // was in a pocket, before the hourly check — the bug wearing the fix's shape.
    // The cost of being generous is only a delayed update; the cost of being
    // stingy is a phone that cannot get back in. A few hours is the floor #1961
    // asked for.
    expect(HEADLESS_RECENCY_MS).toBeGreaterThanOrEqual(4 * 60 * 60_000);
  });

  it("SOURCE: the restarter gate calls tunnelPairingLive(pairTunnel, bridge)", () => {
    // Recency composed only inside hasLiveHeadlessClient is how #1961 read as
    // unfixed: grepping the gate still showed the live-only one-liner.
    const src = readFileSync(new URL("../../orchestrator/index.ts", import.meta.url), "utf8");
    expect(src).toContain('from "./tunnel-pairing-live.js"');
    expect(src).toMatch(/!tunnelPairingLive\(\s*pairTunnel,\s*bridge\s*\)/);
    expect(src).not.toMatch(
      /const tunnelPairingLive = \(\)(?:: boolean)? => pairTunnel !== null && bridge\.hasLiveHeadlessClient\(\)/,
    );
  });
});
