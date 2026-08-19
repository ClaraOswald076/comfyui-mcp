// #1656 — the CALL SITES for the carried-stamp provenance.
//
// The behaviour lives in UiBridge.send()'s agreement gate and is driven over a real
// socket in services/carried-stamp-agreement.test.ts. That suite installs the
// predicate itself, so it stays green if production never installs one — and an
// uninstalled predicate is defined to mean "proven", i.e. the exact pre-#1656
// behaviour with the bug intact. Four one-line wirings decide whether the fix runs at
// all, and every one of them is invisible to a behavioural test:
//
//   1. the hello handler RECORDING that a carry happened,
//   2. the hello handler CLEARING it when this hello proves an identity,
//   3. the validated-refresh path CLEARING it (the documented way out), and
//   4. `bridge.setCarriedTabStampPredicate(...)` being called at all.
//
// The hello handler is inline in the orchestrator start function, so — as with the
// other index.ts boundary guards (shared-session-invariant.test.ts,
// agent-identity-wiring.test.ts) — the wiring is pinned at source level.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const indexSrc = (): string =>
  readFileSync(new URL("../../orchestrator/index.ts", import.meta.url), "utf8");
const bridgeSrc = (): string =>
  readFileSync(new URL("../../services/ui-bridge.ts", import.meta.url), "utf8");

describe("#1656 — carried-stamp provenance is WIRED, not merely available", () => {
  it("SOURCE: the orchestrator installs the predicate on the bridge", () => {
    const src = indexSrc();
    expect(src).toContain("bridge.setCarriedTabStampPredicate(");
    // …and it answers from the provenance set, resolved through panelTabOf exactly
    // like the uuid resolver beside it (an agent-key address must give the same
    // verdict as the bare tab id).
    const start = src.indexOf("bridge.setCarriedTabStampPredicate(");
    const block = src.slice(start, start + 400);
    expect(block).toContain("panelTabOf(tabId)");
    expect(block).toContain("tabStampCarried.has(");
    // A scope address is the conversation's issue-time stamp, never a tab
    // advertisement, so it can never be "carried".
    expect(block).toContain("isScopeAddress(tabId)");
  });

  it("SOURCE: the hello handler records the carry and clears it on a proven identity", () => {
    const src = indexSrc();
    const start = src.indexOf("if (migratedFrom && migratedFrom !== panelTab) {");
    expect(start, "migration block not found").toBeGreaterThan(-1);
    const end = src.indexOf("Record this tab's trusted per-workflow COMMAND STAMP", start);
    expect(end, "post-migration anchor not found").toBeGreaterThan(start);
    const block = src.slice(start, end);
    // The carry's RETURN VALUE decides the provenance — not a re-derivation of what
    // the carry "ought" to have done.
    expect(block).toMatch(/if \(carryWorkflowCommandStamp\(tabCommandWorkflowUuid, migratedFrom, panelTab\)\)/);
    expect(block).toContain("tabStampCarried.add(panelTab)");
    // The retiring id keeps no provenance entry, exactly as it keeps no stamp.
    expect(block).toContain("tabStampCarried.delete(migratedFrom)");

    // The stamp-recording branch below the block clears the provenance: an identity
    // this tab advertised under THIS id supersedes anything inherited.
    const setIdx = src.indexOf("tabCommandWorkflowUuid.set(panelTab, newIdentity.uuid);");
    expect(setIdx, "hello stamp-set not found").toBeGreaterThan(-1);
    expect(src.slice(setIdx, setIdx + 300)).toContain("tabStampCarried.delete(panelTab)");
  });

  it("SOURCE: a VALIDATED refresh clears the provenance — the documented rebind is the way out", () => {
    const src = indexSrc();
    const setIdx = src.indexOf("tabCommandWorkflowUuid.set(panelTab, identity.uuid);");
    expect(setIdx, "refresh stamp-set not found").toBeGreaterThan(-1);
    expect(src.slice(setIdx, setIdx + 400)).toContain("tabStampCarried.delete(panelTab)");
  });

  it("SOURCE: the gate consults the predicate, and the recovery probe stays exempt", () => {
    const src = bridgeSrc();
    // The gate reads provenance for the CONNECTION's canonical id — the tab the
    // frame would actually land on — not for the caller's address.
    expect(src).toContain("this.isCarriedTabStamp?.(conn.tabId) === true");
    // The refusal is pre-dispatch and typed, like #1682's.
    const idx = src.indexOf("if (issuedFor && landedOn && carried) {");
    expect(idx, "carried refusal branch not found").toBeGreaterThan(-1);
    const branch = src.slice(idx, idx + 1200);
    expect(branch).toContain("markDispatched(");
    expect(branch).toContain("has not re-established its workflow identity");
    expect(branch).toContain('panel_set_workflow_target({mode:"current"})');
    // It sits INSIDE requiresStampTargetAgreement's guard, so workflow_list /
    // workflow_open / workflow_new / canvas-independent ops are untouched and the
    // rebind that clears this state is not gated on the state being already correct
    // (panel #932's circularity).
    const gate = src.indexOf("requiresStampTargetAgreement(cmd)) {");
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(idx);
  });
});
