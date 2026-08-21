// #1963 — the restarter APPLY gate must be the sticky pairing handle, not a
// live socket. A backgrounded phone has no socket; keying on one is how a
// locked screen used to rotate the tunnel hostname.
//
// The behaviour is tested through autoUpdateApplyAllowed / SelfRestarter.
// This file pins the WIRING so a later edit cannot silently put
// hasLiveHeadlessClient back on the restart path.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX = join(HERE, "../../orchestrator/index.ts");

describe("orchestrator wires the #1963 gate, not the live-socket predicate", () => {
  const src = readFileSync(INDEX, "utf-8");

  it("APPLY is autoUpdateApplyAllowed over the sticky pairTunnel handle", () => {
    expect(src).toContain("pairingActiveOf(pairTunnel)");
    expect(src).toContain("pairingTransportOf(pairTunnel)");
    expect(src).toContain("applyAllowed: applyAutoUpdateAllowed");
    expect(src).toContain("tickPanelAutoUpdate");
  });

  it("does not put hasLiveHeadlessClient on the restarter path", () => {
    expect(src).not.toMatch(/hasLiveHeadlessClient/);
  });

  it("exposes the pair-time toggle and Update now", () => {
    expect(src).toContain("set_pair_update_pref");
    expect(src).toContain("apply_updates_now");
    expect(src).toContain("pairAutoUpdateDisclosure");
  });
});
