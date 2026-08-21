/**
 * #1963 — auto-update is conditional on how the user is currently connected.
 *
 * A restart severs a cloudflared quick-tunnel with certainty (the hostname
 * rotates per run). A restart does not sever a LAN session with a stable pair
 * token, and a relay URL is stable too. That is a property of the transport,
 * not a guess about intent, so the gate is exact:
 *
 *   applyUpdate = updateAvailable && !(activeTransport === "quick-tunnel" && pairingActive)
 *
 * Checking is always allowed (a few KB, safe on a metered link). Applying —
 * writing the new package and restarting — is what must be gated.
 *
 * pairingActive is STICKY: it is "a tunnel was opened for this process and has
 * not been torn down", not "a socket is open right now". A backgrounded phone
 * has no live socket (#1961 / #1176); keying the gate on the socket is how a
 * locked screen and a 5G/wifi handoff used to rotate the hostname anyway.
 *
 * The pair-time toggle `deferWhilePaired` (default ON) is the user-facing
 * override: turning it off, or sending apply_updates_now, lets an update
 * through even while the tunnel is up.
 */

export type AutoUpdateTransport = "lan" | "quick-tunnel" | "relay";

export interface AutoUpdateApplyInput {
  /**
   * How the phone is paired right now. Undefined = no pairing tunnel (desk /
   * LAN listener only). Pairing always uses a quick tunnel today; `relay` is
   * in the type so a future pairing backend that actually honours
   * COMFYUI_MCP_TUNNEL_BACKEND=relay is treated as safe without rewriting the
   * formula.
   */
  activeTransport: AutoUpdateTransport | undefined;
  /**
   * Sticky pairing intent. True once a quick-tunnel has been minted for this
   * process and until it is torn down — survives a locked screen.
   */
  pairingActive: boolean;
  /**
   * Pair-time toggle, default ON: "Don't update while my phone is paired".
   * Explicit `false` is the only way this gate opens under a live quick-tunnel
   * pairing (besides apply_updates_now, which bypasses the gate at the
   * restarter).
   */
  deferWhilePaired?: boolean;
}

/** Pair-time checkbox copy. English, and the identifier the panel renders. */
export const DEFER_WHILE_PAIRED_TOGGLE_LABEL =
  "Don't update while my phone is paired — updating restarts the orchestrator, which changes your tunnel address and disconnects this device.";

/**
 * May we APPLY (disk mutate + restart) this update?
 *
 * Check is not this function's job and is always allowed. `updateAvailable` is
 * the caller's: this answers only the transport half of the formula.
 */
export function autoUpdateApplyAllowed(input: AutoUpdateApplyInput): boolean {
  if (input.deferWhilePaired === false) return true;
  return !(input.activeTransport === "quick-tunnel" && input.pairingActive);
}

/**
 * pairingActive from the pairing tunnel handle. STICKY on purpose: the handle
 * exists from the moment the URL is minted until process exit (nothing stops
 * the tunnel earlier). A live-socket test is exactly the hole a pocketed phone
 * falls through.
 */
export function pairingActiveOf(pairTunnel: unknown): boolean {
  return pairTunnel != null;
}

/** Phone pairing's tunnel is always a quick tunnel today (startQuickTunnel). */
export function pairingTransportOf(pairTunnel: unknown): AutoUpdateTransport | undefined {
  return pairTunnel != null ? "quick-tunnel" : undefined;
}

export interface PairAutoUpdateDisclosure {
  check: true;
  apply: boolean;
  defer_while_paired: boolean;
  toggle_default_on: true;
  toggle_label: string;
}

/** What the pair_url frame carries so the panel can paint the toggle. */
export function pairAutoUpdateDisclosure(input: AutoUpdateApplyInput): PairAutoUpdateDisclosure {
  const deferWhilePaired = input.deferWhilePaired !== false;
  return {
    check: true,
    apply: autoUpdateApplyAllowed({ ...input, deferWhilePaired }),
    defer_while_paired: deferWhilePaired,
    toggle_default_on: true,
    toggle_label: DEFER_WHILE_PAIRED_TOGGLE_LABEL,
  };
}

export function deferredAutoUpdateNote(opts: {
  component: "orchestrator" | "panel";
  from?: string;
  to?: string;
}): string {
  const who = opts.component === "panel" ? "ComfyUI-MCP panel" : "comfyui-mcp";
  const versions =
    opts.from && opts.to ? ` ${opts.from} → ${opts.to}` : opts.to ? ` ${opts.to}` : "";
  return (
    `⬆️ ${who}${versions} is available but not applied — a phone is paired over a mobile ` +
    `tunnel, and applying would change the tunnel address and disconnect it. Update from ` +
    `the desk, turn off “Don't update while my phone is paired”, or choose Update now.`
  );
}
