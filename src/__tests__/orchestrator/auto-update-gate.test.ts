// #1963 — auto-update is check+apply at the desk, check-only on a mobile tunnel.
//
// The reporter's formula, not a heuristic:
//   applyUpdate = updateAvailable && !(activeTransport === "quick-tunnel" && pairingActive)
//
// These tests drive the shipped gate. They do not reimplement it.

import { describe, expect, it } from "vitest";
import {
  autoUpdateApplyAllowed,
  deferredAutoUpdateNote,
  pairAutoUpdateDisclosure,
  pairingActiveOf,
  pairingTransportOf,
  DEFER_WHILE_PAIRED_TOGGLE_LABEL,
  type AutoUpdateApplyInput,
} from "../../services/auto-update-gate.js";

describe("autoUpdateApplyAllowed — the reporter's table (#1963)", () => {
  it("applies at the desk with no pairing tunnel", () => {
    expect(
      autoUpdateApplyAllowed({ activeTransport: undefined, pairingActive: false }),
    ).toBe(true);
  });

  it("applies on LAN even while a phone is paired — a LAN URL survives a restart", () => {
    expect(
      autoUpdateApplyAllowed({ activeTransport: "lan", pairingActive: true }),
    ).toBe(true);
  });

  it("applies on relay — a stable URL is not rotated by a restart", () => {
    expect(
      autoUpdateApplyAllowed({ activeTransport: "relay", pairingActive: true }),
    ).toBe(true);
  });

  it("does NOT apply while paired over a quick-tunnel — that is the disconnect", () => {
    expect(
      autoUpdateApplyAllowed({ activeTransport: "quick-tunnel", pairingActive: true }),
    ).toBe(false);
  });

  it("applies on a leftover quick-tunnel handle that is no longer paired", () => {
    expect(
      autoUpdateApplyAllowed({ activeTransport: "quick-tunnel", pairingActive: false }),
    ).toBe(true);
  });

  it("the pair-time toggle OFF opens the gate even under a live quick-tunnel", () => {
    expect(
      autoUpdateApplyAllowed({
        activeTransport: "quick-tunnel",
        pairingActive: true,
        deferWhilePaired: false,
      }),
    ).toBe(true);
  });

  it("the toggle defaults ON — omitting it is the same as true", () => {
    const base: AutoUpdateApplyInput = {
      activeTransport: "quick-tunnel",
      pairingActive: true,
    };
    expect(autoUpdateApplyAllowed(base)).toBe(
      autoUpdateApplyAllowed({ ...base, deferWhilePaired: true }),
    );
    expect(autoUpdateApplyAllowed(base)).toBe(false);
  });
});

describe("pairingActive is sticky on the tunnel handle, not a live socket (#1963)", () => {
  it("a minted tunnel is paired — a locked-screen phone has no socket, but is still paired", () => {
    expect(pairingActiveOf({ url: "https://rand.trycloudflare.com", stop: () => {} })).toBe(true);
    expect(pairingTransportOf({ url: "https://rand.trycloudflare.com" })).toBe("quick-tunnel");
  });

  it("no tunnel handle means desk/LAN — APPLY is allowed", () => {
    expect(pairingActiveOf(null)).toBe(false);
    expect(pairingTransportOf(null)).toBeUndefined();
    expect(
      autoUpdateApplyAllowed({
        activeTransport: pairingTransportOf(null),
        pairingActive: pairingActiveOf(null),
      }),
    ).toBe(true);
  });
});

describe("pairAutoUpdateDisclosure — what the QR modal is told", () => {
  it("check is always true; apply follows the gate; toggle defaults ON", () => {
    const d = pairAutoUpdateDisclosure({
      activeTransport: "quick-tunnel",
      pairingActive: true,
    });
    expect(d.check).toBe(true);
    expect(d.apply).toBe(false);
    expect(d.defer_while_paired).toBe(true);
    expect(d.toggle_default_on).toBe(true);
    expect(d.toggle_label).toBe(DEFER_WHILE_PAIRED_TOGGLE_LABEL);
  });

  it("LAN pairing still checks AND applies", () => {
    const d = pairAutoUpdateDisclosure({
      activeTransport: "lan",
      pairingActive: true,
    });
    expect(d.check).toBe(true);
    expect(d.apply).toBe(true);
  });
});

describe("deferredAutoUpdateNote names why the desk is not moving", () => {
  it("names the versions and the tunnel, and points at Update now", () => {
    const note = deferredAutoUpdateNote({
      component: "orchestrator",
      from: "0.52.41",
      to: "0.52.42",
    });
    expect(note).toContain("0.52.41");
    expect(note).toContain("0.52.42");
    expect(note).toMatch(/mobile tunnel/i);
    expect(note).toMatch(/Update now/);
    expect(note).toContain(DEFER_WHILE_PAIRED_TOGGLE_LABEL.slice(0, 20));
  });

  it("the panel path names the panel, not the npm package", () => {
    const note = deferredAutoUpdateNote({
      component: "panel",
      from: "0.15.28",
      to: "0.15.31",
    });
    expect(note).toMatch(/panel/i);
    expect(note).toContain("0.15.28");
    expect(note).toContain("0.15.31");
  });
});
