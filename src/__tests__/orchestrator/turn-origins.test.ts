// #884 — behavioral coverage for the turn-origin machinery at its REAL seam
// (confirming gate 3, P2: the previous coverage asserted index.ts source
// strings and passed even though the behavior it described was unreachable).
// TurnOriginTracker here is the SAME object index.ts constructs and wires; the
// resolver/repin factories are the SAME handlers it installs on the bridge.

import { describe, expect, it, vi } from "vitest";
import {
  TurnOriginTracker,
  makeScopeRepinHandler,
  makeScopeTargetResolver,
  type ScopeRepinBridge,
} from "../../orchestrator/turn-origins.js";

const KEY = "orchestrator::claude";

/** A tracker over a mutable backend map — mirrors index.ts's wiring exactly:
 *  backendForTab reads the live tabBackends map, backendOfKey splits the
 *  composite key, uuidOfTab reads the live command-stamp map. */
function makeTracker(opts?: { defaultBackend?: string }) {
  const tabBackends = new Map<string, string>();
  const tabUuids = new Map<string, string>();
  // Retired id → the live id it currently ROUTES to (mirrors the bridge's
  // path-compressed migration aliases; ids not listed resolve to themselves;
  // `null` marks an id that resolves to NOTHING — a disconnected surface).
  const tabAliases = new Map<string, string | null>();
  const warnings: string[] = [];
  const def = opts?.defaultBackend ?? "claude";
  const tracker = new TurnOriginTracker({
    backendForTab: (tab) => tabBackends.get(tab) ?? def,
    backendOfKey: (key) => {
      const i = key.lastIndexOf("::");
      return i >= 0 ? key.slice(i + 2) : def;
    },
    uuidOfTab: (tab) => tabUuids.get(tab),
    liveTabOf: (tab) => {
      const a = tabAliases.get(tab);
      return a === null ? undefined : (a ?? tab);
    },
    warn: (msg) => warnings.push(msg),
  });
  return { tracker, tabBackends, tabUuids, tabAliases, warnings };
}

const flushMicrotasks = () => new Promise<void>((r) => setTimeout(r, 0));

describe("TurnOriginTracker — pins and stamps land at dequeue (#884)", () => {
  it("a single-origin batch pins its tab, stamps its uuid, and records the last established origin", async () => {
    const { tracker } = makeTracker();
    tracker.recordForMid("m1", "uuid-a", "tab-a");
    tracker.onSeen(KEY, "m1");
    await flushMicrotasks();
    expect(tracker.pinOf(KEY)).toBe("tab-a");
    expect(tracker.stampOf(KEY)).toBe("uuid-a");
    // Turn end releases the PIN (active-tab resolution between turns) but the
    // stamp and the last established origin survive for inheritance.
    tracker.turnEnded(KEY);
    expect(tracker.pinOf(KEY)).toBeUndefined();
  });

  it("a mixed-tab batch fails BOTH closed (null pin, undefined stamp) — last message never wins", async () => {
    const { tracker, warnings } = makeTracker();
    tracker.recordForMid("m1", "uuid-a", "tab-a");
    tracker.recordForMid("m2", "uuid-b", "tab-b");
    tracker.onSeen(KEY, "m1");
    tracker.onSeen(KEY, "m2");
    await flushMicrotasks();
    expect(tracker.pinOf(KEY)).toBeNull();
    expect(tracker.stampOf(KEY)).toBeUndefined();
    expect(warnings.join("\n")).toMatch(/mixed\/unknown-origin/);
  });

  it("an unknown (evicted/foreign) mid fails the batch closed rather than inheriting", async () => {
    const { tracker } = makeTracker();
    tracker.recordForMid("known", "uuid-a", "tab-a");
    tracker.onSeen(KEY, "known");
    await flushMicrotasks();
    tracker.turnEnded(KEY);
    tracker.onSeen(KEY, "never-recorded");
    await flushMicrotasks();
    expect(tracker.pinOf(KEY)).toBeNull();
    expect(tracker.stampOf(KEY)).toBeUndefined();
  });

  it("a re-queued (already applied) mid RE-CONTRIBUTES its own origin — its re-run pins its own tab", async () => {
    const { tracker } = makeTracker();
    tracker.recordForMid("m1", "uuid-a", "tab-a");
    tracker.onSeen(KEY, "m1");
    await flushMicrotasks();
    tracker.turnEnded(KEY);
    // Interrupt + send-now re-dispatches the same mid. The request is still
    // about tab-a's workflow, so its origin applies again — DIRECTLY, not via
    // inheritance ("already applied" means "no NEW stamp of its own", never
    // "origin-less" — independent gate on gate 3, P0-2).
    tracker.onSeen(KEY, "m1");
    await flushMicrotasks();
    expect(tracker.pinOf(KEY)).toBe("tab-a");
    expect(tracker.stampOf(KEY)).toBe("uuid-a");
  });

  it("send-now cannot LAUNDER a mixed batch: a re-queued item merged with another tab's message fails BOTH closed (gate-3 confirm P0-2)", async () => {
    const { tracker, warnings } = makeTracker();
    // Message A (tab-a) dequeues and its turn runs…
    tracker.recordForMid("m-a", "uuid-a", "tab-a");
    tracker.onSeen(KEY, "m-a");
    await flushMicrotasks();
    expect(tracker.pinOf(KEY)).toBe("tab-a");
    // …the user interrupts with send-now from tab B: A's original item is
    // restored to the queue and B's new message lands behind it, so the next
    // turn drains BOTH into ONE batch. Before this fix A's applied mid
    // contributed nothing, so ONLY B counted — the merged A+B turn was pinned
    // and stamped entirely to B, and A's requested edit landed on B's graph.
    tracker.recordForMid("m-b", "uuid-b", "tab-b");
    tracker.onSeen(KEY, "m-a"); // the re-queued item
    tracker.onSeen(KEY, "m-b"); // the send-now message
    await flushMicrotasks();
    expect(tracker.pinOf(KEY)).toBeNull(); // MIXED — refuse routing
    expect(tracker.stampOf(KEY)).toBeUndefined(); // …and mutations
    expect(warnings.join("\n")).toMatch(/mixed\/unknown-origin/);
  });

  it("same-tab send-now keeps the routing pin (one tab), with the stamp per the distinct-uuid rule", async () => {
    const { tracker } = makeTracker();
    tracker.recordForMid("m-a", "uuid-1", "tab-a");
    tracker.onSeen(KEY, "m-a");
    await flushMicrotasks();
    // Send-now from the SAME tab, same workflow: the merged batch agrees.
    tracker.recordForMid("m-b", "uuid-1", "tab-a");
    tracker.onSeen(KEY, "m-a");
    tracker.onSeen(KEY, "m-b");
    await flushMicrotasks();
    expect(tracker.pinOf(KEY)).toBe("tab-a");
    expect(tracker.stampOf(KEY)).toBe("uuid-1");
  });

  it("a re-queued item's origin is BACKEND-verified on re-application too", async () => {
    const { tracker, tabBackends, tabUuids } = makeTracker();
    tabBackends.set("tab-a", "claude");
    tabUuids.set("tab-a", "uuid-a");
    tracker.recordForMid("m-a", "uuid-a", "tab-a");
    tracker.onSeen(KEY, "m-a");
    await flushMicrotasks();
    expect(tracker.pinOf(KEY)).toBe("tab-a");
    tracker.turnEnded(KEY);
    // tab-a joins Codex before the re-queued item re-dispatches: its applied
    // origin must fail the batch closed, exactly like a live record would.
    tabBackends.set("tab-a", "codex");
    tracker.onSeen(KEY, "m-a");
    await flushMicrotasks();
    expect(tracker.pinOf(KEY)).toBeNull();
    expect(tracker.stampOf(KEY)).toBeUndefined();
  });
});

describe("TurnOriginTracker — inherited origins for tab-less turns (gate 3, P1)", () => {
  it("a download_done turn (mintInheritedOrigin) inherits the conversation's last established origin", async () => {
    const { tracker } = makeTracker();
    // An earlier user turn established the origin…
    tracker.recordForMid("m1", "uuid-a", "tab-a");
    tracker.onSeen(KEY, "m1");
    await flushMicrotasks();
    tracker.turnEnded(KEY);
    // …then a tab-less injected turn dequeues. Its minted mid opens the batch
    // (without a mid, onSeen never fires and NO pin would land at all — the
    // unreachable-branch defect this exists to fix) and contributes nothing,
    // so the close inherits tab-a — not whatever tab is "active".
    const mid = tracker.mintInheritedOrigin();
    tracker.onSeen(KEY, mid);
    await flushMicrotasks();
    expect(tracker.pinOf(KEY)).toBe("tab-a");
    expect(tracker.stampOf(KEY)).toBe("uuid-a");
  });

  it("with NO established origin, an inherited-origin turn refuses (null pin) instead of following the active tab", async () => {
    const { tracker, warnings } = makeTracker();
    const mid = tracker.mintInheritedOrigin();
    tracker.onSeen(KEY, mid);
    await flushMicrotasks();
    expect(tracker.pinOf(KEY)).toBeNull();
    expect(tracker.stampOf(KEY)).toBeUndefined();
    expect(warnings.join("\n")).toMatch(/no origin and no established prior origin/);
  });

  it("a REWIND kills the last established origin — a download landing before the edited message REFUSES, never resurrects the dropped branch (gate-3 confirm P1)", async () => {
    const { tracker } = makeTracker();
    // The dropped branch established an origin…
    tracker.recordForMid("m1", "uuid-old-branch", "tab-a");
    tracker.onSeen(KEY, "m1");
    await flushMicrotasks();
    tracker.turnEnded(KEY);
    // …then the user rewinds. The agent stays LIVE across a rewind, so an
    // origin-less injected turn (a coalesced download) can dequeue before the
    // edited replacement message. Inheriting here would re-pin the dropped
    // branch's tab and resurrect the very stamp the rewind just deleted.
    tracker.dropBranch(KEY);
    const mid = tracker.mintInheritedOrigin();
    tracker.onSeen(KEY, mid);
    await flushMicrotasks();
    expect(tracker.pinOf(KEY)).toBeNull(); // refuse loudly
    expect(tracker.stampOf(KEY)).toBeUndefined(); // the dropped stamp stays dead
  });

  it("a CONVERSATION BOUNDARY (new chat / resume switch) kills the last established origin too", async () => {
    const { tracker } = makeTracker();
    tracker.recordForMid("m1", "uuid-old-convo", "tab-a");
    tracker.onSeen(KEY, "m1");
    await flushMicrotasks();
    tracker.turnEnded(KEY);
    tracker.forgetConversation(KEY);
    const mid = tracker.mintInheritedOrigin();
    tracker.onSeen(KEY, mid);
    await flushMicrotasks();
    expect(tracker.pinOf(KEY)).toBeNull();
    expect(tracker.stampOf(KEY)).toBeUndefined();
  });

  it("a LATE explicit repin racing a rewind cannot re-establish the inheritance source the boundary cleared (codex delta P1)", async () => {
    const { tracker, tabUuids } = makeTracker();
    tabUuids.set("tab-b", "uuid-b");
    // The pre-rewind branch established an origin, and its turn is still in
    // flight (ambiguous pin) when the user rewinds…
    tracker.recordForMid("m1", "u1", "tab-a");
    tracker.recordForMid("m2", "u2", "tab-b");
    tracker.onSeen(KEY, "m1");
    tracker.onSeen(KEY, "m2");
    await flushMicrotasks();
    expect(tracker.pinOf(KEY)).toBeNull(); // mixed batch — dead/ambiguous pin
    tracker.dropBranch(KEY);
    // …then the DYING turn's mode:"current" recovery lands AFTER the boundary
    // (manager.rewind does not await the backend interruption). It may re-aim
    // its own remaining lifetime (pin+stamp)…
    tracker.repinTo(KEY, "tab-b");
    expect(tracker.pinOf(KEY)).toBe("tab-b");
    expect(tracker.stampOf(KEY)).toBe("uuid-b");
    // …but when that turn ends, NOTHING it did survives as an inheritance
    // source: a download landing before the edited post-rewind message REFUSES
    // instead of inheriting the recovery target.
    tracker.turnEnded(KEY);
    const mid = tracker.mintInheritedOrigin();
    tracker.onSeen(KEY, mid);
    await flushMicrotasks();
    expect(tracker.pinOf(KEY)).toBeNull();
    expect(tracker.stampOf(KEY)).toBeUndefined();
  });

  it("a repin never masquerades as a MESSAGE origin: inheritance still derives from the last batch-close origin", async () => {
    const { tracker, tabUuids } = makeTracker();
    tabUuids.set("tab-b", "uuid-b");
    // tab-a established the conversation's message origin; its tab then died
    // mid-turn and the agent explicitly repinned onto live tab-b.
    tracker.recordForMid("m1", "uuid-a", "tab-a");
    tracker.onSeen(KEY, "m1");
    await flushMicrotasks();
    tracker.repinTo(KEY, "tab-b");
    tracker.turnEnded(KEY);
    // A later origin-less turn inherits the MESSAGE origin (tab-a — whose
    // dead routing fails loudly at resolution, the documented behavior for a
    // gone pin), never the recovery target.
    const mid = tracker.mintInheritedOrigin();
    tracker.onSeen(KEY, mid);
    await flushMicrotasks();
    expect(tracker.pinOf(KEY)).toBe("tab-a");
    expect(tracker.stampOf(KEY)).toBe("uuid-a");
  });
});

describe("TurnOriginTracker — origins are BACKEND-BOUND (gate 3, P0)", () => {
  it("a queued event whose tab switched provider before dequeue fails the turn closed, not pinned", async () => {
    const { tracker, tabBackends, tabUuids, warnings } = makeTracker();
    tabBackends.set("tab-a", "claude");
    tabUuids.set("tab-a", "uuid-a");
    // A Claude-conversation event minted while tab-a was a Claude tab…
    const mid = tracker.mintInjectionOrigin("tab-a");
    // …then tab-a switches provider to Codex BEFORE the event dequeues. The
    // workflow fence cannot catch this (tab-a's uuid is unchanged), so the
    // backend binding must: pinning tab-a would let an old Claude turn mutate
    // a tab that now belongs to the Codex conversation.
    tabBackends.set("tab-a", "codex");
    tracker.onSeen(KEY, mid);
    await flushMicrotasks();
    expect(tracker.pinOf(KEY)).toBeNull();
    expect(tracker.stampOf(KEY)).toBeUndefined();
    expect(warnings.join("\n")).toMatch(/no longer belongs to this conversation's backend/);
  });

  it("a tab that switched provider and back is accepted again (verify-at-use, not a permanent taint)", async () => {
    const { tracker, tabBackends, tabUuids } = makeTracker();
    tabBackends.set("tab-a", "claude");
    tabUuids.set("tab-a", "uuid-a");
    const mid = tracker.mintInjectionOrigin("tab-a");
    tabBackends.set("tab-a", "codex");
    tabBackends.set("tab-a", "claude");
    tracker.onSeen(KEY, mid);
    await flushMicrotasks();
    expect(tracker.pinOf(KEY)).toBe("tab-a");
  });

  it("an INHERITED origin whose tab has since switched provider refuses instead of inheriting", async () => {
    const { tracker, tabBackends, warnings } = makeTracker();
    tabBackends.set("tab-a", "claude");
    tracker.recordForMid("m1", "uuid-a", "tab-a");
    tracker.onSeen(KEY, "m1");
    await flushMicrotasks();
    tracker.turnEnded(KEY);
    // tab-a joins Codex; a later tab-less turn must NOT inherit it into the
    // Claude conversation.
    tabBackends.set("tab-a", "codex");
    const mid = tracker.mintInheritedOrigin();
    tracker.onSeen(KEY, mid);
    await flushMicrotasks();
    expect(tracker.pinOf(KEY)).toBeNull();
    expect(warnings.join("\n")).toMatch(/now belongs to another backend's conversation/);
  });

  it("a mid-turn provider switch INVALIDATES a live pin on that tab — closes the post-dequeue door (gate-3 confirm P0-1)", async () => {
    const { tracker, tabBackends, tabUuids, warnings } = makeTracker();
    tabBackends.set("tab-a", "claude");
    tabUuids.set("tab-a", "uuid-a");
    // A Claude turn is RUNNING, pinned to tab-a (dequeue-time check passed —
    // the tab was Claude's then)…
    tracker.recordForMid("m-a", "uuid-a", "tab-a");
    tracker.onSeen(KEY, "m-a");
    await flushMicrotasks();
    expect(tracker.pinOf(KEY)).toBe("tab-a");
    // …then tab-a switches to Codex MID-TURN while another Claude tab keeps
    // the agent alive. The pin was validated only when SET; nothing re-checked
    // it at resolution, and the workflow uuid is unchanged by a provider
    // switch, so a late Claude mutation would land on Codex's tab and pass
    // the fence. The switch must invalidate the pin NOW.
    tabBackends.set("tab-a", "codex");
    tracker.tabChangedBackend("tab-a");
    expect(tracker.pinOf(KEY)).toBeNull(); // refuse loudly
    expect(tracker.stampOf(KEY)).toBeUndefined(); // mutations refuse too
    expect(warnings.join("\n")).toMatch(/switched to the codex conversation/);
  });

  it("a MULTI-HOP migrated pin routing onto the switched tab is invalidated (path-compressed aliases — codex gate 4)", async () => {
    const { tracker, tabBackends, tabUuids, tabAliases, warnings } = makeTracker();
    tabBackends.set("tmp:id-A", "claude");
    tabUuids.set("tmp:id-A", "uuid-a");
    // A Claude turn pinned to the tab's ORIGINAL id A…
    tracker.recordForMid("m-a", "uuid-a", "tmp:id-A");
    tracker.onSeen(KEY, "m-a");
    await flushMicrotasks();
    expect(tracker.pinOf(KEY)).toBe("tmp:id-A");
    // …then the surface re-hellos A→B (no switch), then B→C WITH a provider
    // switch. The bridge path-compresses the chain, so the pin naming A
    // resolves straight onto C — and no single hello ever reported A as
    // migrated_from. The invalidation must judge the pin by where it ROUTES.
    tabAliases.set("tmp:id-A", "wf:id-C");
    tabAliases.set("wf:id-B", "wf:id-C");
    tabBackends.delete("tmp:id-A");
    tabBackends.set("wf:id-C", "codex");
    tracker.tabChangedBackend("wf:id-C");
    expect(tracker.pinOf(KEY)).toBeNull();
    expect(tracker.stampOf(KEY)).toBeUndefined();
    expect(warnings.join("\n")).toMatch(/switched to the codex conversation/);
  });

  it("a REVIVED pin id is refused AT RESOLUTION — ownership is checked at use, not only at the switch event (codex gate-4 delta P0)", async () => {
    const { tracker, tabBackends, tabUuids, tabAliases, warnings } = makeTracker();
    tabBackends.set("wf:recurring-id", "claude");
    tabUuids.set("wf:recurring-id", "uuid-a");
    // A Claude turn pins the tab…
    tracker.recordForMid("m-a", "uuid-a", "wf:recurring-id");
    tracker.onSeen(KEY, "m-a");
    await flushMicrotasks();
    expect(tracker.resolvedPinOf(KEY)).toBe("wf:recurring-id"); // healthy
    // …then the surface migrates away (its backend record dies with the old
    // id) and disconnects (its alias is pruned): the pin is unroutable and
    // passes through — the bridge fails loudly for it, nothing to invalidate.
    tabBackends.delete("wf:recurring-id");
    tabAliases.set("wf:recurring-id", null);
    expect(tracker.resolvedPinOf(KEY)).toBe("wf:recurring-id");
    expect(tracker.pinOf(KEY)).toBe("wf:recurring-id");
    // …then a NEW socket hellos under the SAME deterministic id on Codex. No
    // switch event fires (`prev` was deleted with the old id), so the
    // event-driven invalidation never sees it — the USE-time check must.
    tabAliases.delete("wf:recurring-id");
    tabBackends.set("wf:recurring-id", "codex");
    expect(tracker.resolvedPinOf(KEY)).toBeNull(); // refused at resolution
    expect(tracker.pinOf(KEY)).toBeNull(); // persisted — the stamp dies with it
    expect(tracker.stampOf(KEY)).toBeUndefined();
    expect(warnings.join("\n")).toMatch(/verified at resolution/);
  });

  it("the provider-switch invalidation touches ONLY cross-backend pins on THAT tab", async () => {
    const { tracker, tabBackends, tabUuids } = makeTracker();
    tabBackends.set("tab-a", "claude");
    tabBackends.set("tab-b", "claude");
    tabUuids.set("tab-b", "uuid-b");
    // A Claude turn pinned to tab-b, and a Codex turn pinned to tab-a.
    tracker.recordForMid("m-b", "uuid-b", "tab-b");
    tracker.onSeen(KEY, "m-b");
    tabBackends.set("tab-a", "codex");
    tracker.recordForMid("m-a", "uuid-a", "tab-a");
    tracker.onSeen("orchestrator::codex", "m-a");
    await flushMicrotasks();
    expect(tracker.pinOf(KEY)).toBe("tab-b");
    expect(tracker.pinOf("orchestrator::codex")).toBe("tab-a");
    // tab-a switching (again) to codex is a no-op for BOTH: the codex pin
    // matches the tab's backend, and the claude pin names a different tab.
    tracker.tabChangedBackend("tab-a");
    expect(tracker.pinOf(KEY)).toBe("tab-b"); // untouched
    expect(tracker.pinOf("orchestrator::codex")).toBe("tab-a"); // same-backend pin stands
  });

  it("a backend-mismatched origin is NOT marked consumed: its re-queue fails closed again rather than inheriting", async () => {
    const { tracker, tabBackends, tabUuids } = makeTracker();
    tabBackends.set("tab-a", "claude");
    tabBackends.set("tab-b", "claude");
    tabUuids.set("tab-b", "uuid-b");
    // Establish a valid origin on tab-b first.
    tracker.recordForMid("mb", "uuid-b", "tab-b");
    tracker.onSeen(KEY, "mb");
    await flushMicrotasks();
    tracker.turnEnded(KEY);
    // Mint on tab-a, switch tab-a away, dequeue → fails closed.
    tabUuids.set("tab-a", "uuid-a");
    const mid = tracker.mintInjectionOrigin("tab-a");
    tabBackends.set("tab-a", "codex");
    tracker.onSeen(KEY, mid);
    await flushMicrotasks();
    expect(tracker.pinOf(KEY)).toBeNull();
    tracker.turnEnded(KEY);
    // A re-dispatch of the SAME mid must fail closed again — if the mismatch
    // had been marked "consumed", the re-queue would contribute nothing and
    // silently inherit tab-b's origin, laundering the refused event.
    tracker.onSeen(KEY, mid);
    await flushMicrotasks();
    expect(tracker.pinOf(KEY)).toBeNull();
  });
});

describe("makeScopeTargetResolver — the real resolver the bridge consults", () => {
  it("answers the pin (string), ambiguity (null), and no-turn (undefined) states", async () => {
    const { tracker } = makeTracker();
    const resolve = makeScopeTargetResolver({
      tracker,
      scopeAgentKeyOf: (id) => (id === "orchestrator" ? KEY : id),
    });
    expect(resolve("orchestrator")).toBeUndefined();
    tracker.recordForMid("m1", "uuid-a", "tab-a");
    tracker.onSeen(KEY, "m1");
    await flushMicrotasks();
    expect(resolve("orchestrator")).toBe("tab-a");
    expect(resolve(KEY)).toBe("tab-a");
    tracker.recordForMid("m2", "u", "tab-a");
    tracker.recordForMid("m3", "u", "tab-b");
    tracker.onSeen(KEY, "m2");
    tracker.onSeen(KEY, "m3");
    await flushMicrotasks();
    expect(resolve("orchestrator")).toBeNull();
  });
});

describe("makeScopeRepinHandler — explicit recovery gates (gate 3, P0)", () => {
  function makeRepinHarness(opts: {
    tabs: Array<{ id: string; backend?: string; headless?: boolean }>;
    active?: string;
    reachable?: (tab: string) => boolean;
  }) {
    const { tracker, tabBackends, tabUuids } = makeTracker();
    for (const t of opts.tabs) {
      tabBackends.set(t.id, t.backend ?? "claude");
      tabUuids.set(t.id, `uuid-${t.id}`);
    }
    const bridge: ScopeRepinBridge = {
      canReach: (tab) => opts.reachable?.(tab) ?? opts.tabs.some((t) => t.id === tab),
      resolveActiveScopeTab: () => opts.active,
      isHeadless: (tab) => opts.tabs.find((t) => t.id === tab)?.headless === true,
      tabs: () => opts.tabs.map((t) => ({ tab_id: t.id })),
    };
    const info = vi.fn();
    const repin = makeScopeRepinHandler({
      bridge,
      tracker,
      scopeAgentKeyOf: (id) => (id === "orchestrator" ? KEY : id),
      backendForTab: (tab) => tabBackends.get(tab) ?? "claude",
      backendOfKey: (key) => key.slice(key.lastIndexOf("::") + 2),
      info,
    });
    return { tracker, bridge, repin, info };
  }

  it("REFUSES to displace a HEALTHY pin — even when another tab is last-active", async () => {
    const { tracker, repin } = makeRepinHarness({
      tabs: [{ id: "tab-a" }, { id: "tab-b" }],
      active: "tab-b",
    });
    tracker.recordForMid("m1", "uuid-a", "tab-a");
    tracker.onSeen(KEY, "m1");
    await flushMicrotasks();
    expect(repin("orchestrator")).toBeUndefined();
    expect(tracker.pinOf(KEY)).toBe("tab-a"); // untouched
  });

  it("escapes a DEAD pin onto the active tab, moving pin+stamp together", async () => {
    const { tracker, repin } = makeRepinHarness({
      tabs: [{ id: "tab-b" }],
      active: "tab-b",
      reachable: (tab) => tab !== "tab-gone",
    });
    tracker.recordForMid("m1", "uuid-gone", "tab-gone");
    tracker.onSeen(KEY, "m1");
    await flushMicrotasks();
    expect(tracker.pinOf(KEY)).toBe("tab-gone");
    expect(repin("orchestrator")).toBe("tab-b");
    expect(tracker.pinOf(KEY)).toBe("tab-b");
    expect(tracker.stampOf(KEY)).toBe("uuid-tab-b"); // fence re-derived from the adopted tab
  });

  it("escapes an AMBIGUOUS (null) pin the same way", async () => {
    const { tracker, repin } = makeRepinHarness({ tabs: [{ id: "tab-b" }], active: "tab-b" });
    tracker.recordForMid("m1", "u", "tab-a");
    tracker.recordForMid("m2", "u", "tab-b");
    tracker.onSeen(KEY, "m1");
    tracker.onSeen(KEY, "m2");
    await flushMicrotasks();
    expect(tracker.pinOf(KEY)).toBeNull();
    expect(repin("orchestrator")).toBe("tab-b");
    expect(tracker.pinOf(KEY)).toBe("tab-b");
  });

  it("never adopts a tab belonging to ANOTHER backend's conversation", () => {
    const { tracker, repin } = makeRepinHarness({
      tabs: [{ id: "codex-tab", backend: "codex" }],
      active: "codex-tab",
    });
    expect(repin("orchestrator")).toBeUndefined();
    expect(tracker.pinOf(KEY)).toBeUndefined();
  });

  it("falls back to the backend's SOLE interactive tab when the active tab is foreign or headless", () => {
    const { tracker, repin } = makeRepinHarness({
      tabs: [
        { id: "claude-tab" },
        { id: "codex-tab", backend: "codex" },
        { id: "phone", headless: true },
      ],
      active: "codex-tab",
    });
    expect(repin("orchestrator")).toBe("claude-tab");
    expect(tracker.pinOf(KEY)).toBe("claude-tab");
  });

  it("refuses to guess among 2+ candidate tabs when none is the active one", () => {
    const { repin } = makeRepinHarness({
      tabs: [{ id: "tab-a" }, { id: "tab-b" }],
      active: undefined,
    });
    expect(repin("orchestrator")).toBeUndefined();
  });

  it("never adopts a headless viewer", () => {
    const { repin } = makeRepinHarness({
      tabs: [{ id: "phone", headless: true }],
      active: "phone",
    });
    expect(repin("orchestrator")).toBeUndefined();
  });
});
