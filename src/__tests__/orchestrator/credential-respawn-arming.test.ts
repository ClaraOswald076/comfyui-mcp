// #1567 — the orphan check only runs when the CREDENTIAL path arms it, and that arming is
// a single line in the secrets subscriber in index.ts.
//
// A line like that is invisible to behavioural tests: delete it and every unit test still
// passes, because the manager-level tests arm the watch themselves. The feature simply
// never fires in production. So this asserts the wiring at its source, and the mutation
// harness deletes the line to prove the assertion is load-bearing.
//
// It also pins the two properties review found missing in the first version, both of which
// live at THIS call site rather than in the manager:
//
//   * it is armed BEFORE restartAllForMcpEnv, because an idle tab respawns inside that call
//     — arming afterwards would miss exactly the case that fires immediately;
//   * it is armed with the CHANGE'S tab, matching the retry nudge, so the note is delivered
//     once rather than once per restarted tab.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../../orchestrator/index.ts", import.meta.url), "utf-8");

describe("the credential respawn arms the orphan check (#1567)", () => {
  it("arms it, scoped to the change's tab", () => {
    expect(SRC).toMatch(/manager\.armCredentialRespawnOrphanWatch\(change\.tabId \?\? null\);/);
  });

  it("arms it BEFORE the restart, not after", () => {
    const arm = SRC.indexOf("manager.armCredentialRespawnOrphanWatch(");
    expect(arm, "the arming call must exist").toBeGreaterThan(-1);
    const restart = SRC.indexOf("const tally = manager.restartAllForMcpEnv();");
    expect(restart, "the credential restart must still be recognisable").toBeGreaterThan(-1);
    // An idle tab is respawned synchronously inside restartAllForMcpEnv, so arming after
    // it would silently skip the immediate case.
    expect(arm).toBeLessThan(restart);
  });

  it("is armed on the SECRETS path only", () => {
    // The other restartAllForMcpEnv caller is the base_path recovery respawn (#296), which
    // is not a credential save. Arming there would attach a note claiming a credential
    // "was saved earlier" to an unrelated restart — and would hand an idle tab a turn.
    const armCount = (SRC.match(/armCredentialRespawnOrphanWatch\(/g) ?? []).length;
    expect(armCount, "exactly one arming site").toBe(1);
    const arm = SRC.indexOf("manager.armCredentialRespawnOrphanWatch(");
    const before = SRC.slice(Math.max(0, arm - 2000), arm);
    expect(before, "the arming site must be inside the secrets subscriber").toMatch(
      /onComfyuiSecretsChanged/,
    );
  });
});
