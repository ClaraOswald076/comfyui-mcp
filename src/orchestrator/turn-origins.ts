// #884 — TURN ORIGINS: which tab/workflow a shared conversation's CURRENT TURN
// was issued from, and therefore where its tool calls route and what workflow
// uuid its mutations are stamped with.
//
// One agent session spans every tab and workflow (the owner-stated invariant),
// so the tab id is only a ROUTING target — and mid-turn it must be the tab the
// turn was ISSUED from, never "whatever tab is active now" (a queued message
// from another tab moves last-active immediately, which is how a running turn's
// mutations were silently re-aimed — the P0 this machinery exists to prevent).
//
// This module owns the whole per-conversation origin state so the behavior is
// testable at the production seam (confirming gate 3, P2: the previous coverage
// asserted source strings against index.ts and could not fail):
//   - per-mid issue-time origins (recorded at receipt, applied at DEQUEUE);
//   - the dispatch-batch aggregation (one turn may batch several messages; only
//     an AGREEING batch pins/stamps — mixed or unknown fails closed);
//   - the turn-target pin + issue-time stamp + last-established origin;
//   - the explicit-repin recovery and the scope target resolver the UiBridge
//     consults (built here so tests drive the REAL handlers, not test stand-ins).
//
// BACKEND-BOUND ORIGINS (confirming gate 3, P0): every recorded origin carries
// the backend its tab belonged to when the origin was minted, and it is
// re-verified when the origin is APPLIED (dequeue / inheritance / repin). A tab
// that switched provider between mint and apply — tab A moves Claude→Codex
// while a queued Claude event still names A — must fail the turn closed, never
// hand the old conversation a tab that now belongs to another backend's
// conversation (the workflow fence alone cannot catch this: A's workflow uuid
// is unchanged, so the stamp would pass).

import { randomUUID } from "node:crypto";

export interface TurnOriginDeps {
  /** The backend a panel tab is CURRENTLY on (live tabBackends lookup). */
  backendForTab: (tabId: string) => string;
  /** The backend half of a composite agent key (`orchestrator::<backend>`). */
  backendOfKey: (key: string) => string;
  /** The trusted per-tab command workflow uuid (issue-time stamp source). */
  uuidOfTab: (tabId: string) => string | undefined;
  warn: (msg: string) => void;
}

interface MidOrigin {
  uuid: string | undefined;
  tab: string;
  /** The backend `tab` belonged to when this origin was recorded — verified
   *  again at dequeue (confirming gate 3, P0). */
  backend: string;
}

interface PendingBatch {
  known: Array<string | undefined>;
  tabs: Set<string>;
  unknown: boolean;
}

export class TurnOriginTracker {
  // The issue-time origin RIDES the message and is applied when the agent
  // DEQUEUES it (onSeen — the true start of its turn), not at receipt: a
  // message queued behind a busy turn, or held during a render, must not flip
  // the IN-FLIGHT turn's stamp the moment it arrives (codex round 2, P0).
  // Bounded: entries are consumed at dequeue and dropped on cancel; the cap is
  // a last-resort ceiling sized so it is effectively unreachable by live
  // queued messages (codex r3: evicting a LIVE mapping discards fail-closed
  // state — and even then, an unknown mid at dequeue fails the batch closed
  // rather than inheriting a stale stamp).
  private readonly turnUuidByMid = new Map<string, MidOrigin>();
  private static readonly TURN_UUID_BY_MID_CAP = 5000;

  // Mids that must contribute NOTHING to a batch without poisoning it: a
  // re-queued item whose stamp was already applied at a previous dequeue
  // (interrupt + send-now fires onSeen again), and deliberately ORIGIN-LESS
  // injected turns (mintInheritedOrigin — e.g. a coalesced download_done,
  // which has no originating tab and must INHERIT the conversation's last
  // established origin at batch close). A genuinely unknown mid (evicted,
  // foreign) still fails the batch closed.
  private readonly consumedTurnMids = new Set<string>();
  private static readonly CONSUMED_TURN_MIDS_CAP = 500;

  // Per-key aggregation of ONE dispatch batch's issue-time origins (the manager
  // fires onSeen synchronously per item; the microtask closes the batch before
  // any backend I/O can run a tool call).
  private readonly pendingBatchStamp = new Map<string, PendingBatch>();

  // PER CONVERSATION, the trusted workflow uuid of the workflow its CURRENT
  // TURN was issued for. This is what a scope-addressed command is STAMPED
  // with: #570's issue-time rule at conversation level — never re-resolved
  // from whatever tab happens to be active at dispatch (codex round 1, P0).
  private readonly lastTurnUuidByKey = new Map<string, string | undefined>();

  // Each conversation's IN-FLIGHT turn is PINNED to the tab it was issued
  // from, set at batch close and cleared at turn end. Value string = pinned
  // tab; null = ambiguous origin (refuse); absent = no turn in flight
  // (active-tab resolution).
  private readonly turnTargetTabByKey = new Map<string, string | null>();

  // Each conversation's LAST ESTABLISHED origin (the tab+uuid its most recent
  // origin-bearing turn agreed on). Origin-less turns inherit THIS, never the
  // active tab (confirming gate 2, P0) — re-verified against the tab's CURRENT
  // backend at inheritance time (confirming gate 3, P0). Written ONLY at batch
  // close (a MESSAGE origin the turn agreed on) and deleted at conversation
  // boundaries — deliberately NOT by the explicit repin recovery, whose target
  // is a mid-turn re-aim of the CURRENT turn, not a message origin: letting it
  // feed inheritance let a dying pre-rewind turn's late recovery re-establish
  // an inheritance source the rewind boundary had just cleared (codex delta
  // review, P1).
  private readonly lastOriginByKey = new Map<string, { tab: string; uuid: string | undefined }>();

  constructor(private readonly deps: TurnOriginDeps) {}

  /** Record a message's issue-time origin, keyed by its mid, to be applied at
   *  dequeue. Captures the tab's backend NOW so the application can verify the
   *  tab still belongs to the same conversation then. */
  recordForMid(mid: string, uuid: string | undefined, tab: string): void {
    this.turnUuidByMid.set(mid, { uuid, tab, backend: this.deps.backendForTab(tab) });
    while (this.turnUuidByMid.size > TurnOriginTracker.TURN_UUID_BY_MID_CAP) {
      const oldest = this.turnUuidByMid.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.turnUuidByMid.delete(oldest);
    }
  }

  /** Origin for an orchestrator-side INJECTED turn (run errors, completions,
   *  ask answers, panel events): a synthetic mid rides the queue item so the
   *  dequeue fires onSeen and the injected turn pins/stamps like any user turn
   *  (a run error on tab A must pin A — confirming gate 2, P0). */
  mintInjectionOrigin(originTab: string): string {
    const mid = `evt-${randomUUID()}`;
    this.recordForMid(mid, this.deps.uuidOfTab(originTab), originTab);
    return mid;
  }

  /** Origin for an injected turn that HAS no originating tab (a coalesced
   *  download_done — its row names the owning conversation, not a tab). The
   *  minted mid contributes nothing to its batch WITHOUT poisoning it, so the
   *  batch closes with zero origins and the turn INHERITS the conversation's
   *  last established origin — or refuses when there is none. Without a mid
   *  the dequeue fires no onSeen at all, no batch ever opens, and the turn
   *  routes to whatever tab is active (confirming gate 3, P1: the inherit
   *  branch was unreachable for the very case it documents). */
  mintInheritedOrigin(): string {
    const mid = `evt-${randomUUID()}`;
    this.noteConsumedTurnMid(mid);
    return mid;
  }

  /** A still-queued message was cancelled and REMOVED — its origin dies with it
   *  so the bounded map only ever holds live queued messages (codex r3/r4). */
  cancelMid(mid: string): void {
    this.turnUuidByMid.delete(mid);
  }

  private noteConsumedTurnMid(mid: string): void {
    this.consumedTurnMids.add(mid);
    while (this.consumedTurnMids.size > TurnOriginTracker.CONSUMED_TURN_MIDS_CAP) {
      const oldest = this.consumedTurnMids.values().next().value as string | undefined;
      if (oldest === undefined) break;
      this.consumedTurnMids.delete(oldest);
    }
  }

  /**
   * The agent dequeued a message — the true start of its turn. One dispatch may
   * batch SEVERAL messages: the batch's origins aggregate over a microtask and
   * pin/stamp only when they AGREE — a mixed or unknown-origin batch fails
   * closed (undefined stamp, null pin) instead of letting the last message
   * re-aim the whole turn's mutations (codex rounds 2–3). A batch with NO
   * origin contribution inherits the conversation's last established origin.
   */
  onSeen(key: string, mid: string): void {
    let batch = this.pendingBatchStamp.get(key);
    const opensBatch = !batch;
    if (!batch) {
      batch = { known: [], tabs: new Set<string>(), unknown: false };
      this.pendingBatchStamp.set(key, batch);
    }
    const rec = this.turnUuidByMid.get(mid);
    if (rec) {
      // BACKEND-BOUND (confirming gate 3, P0): the origin must still belong to
      // THIS conversation's backend — both as recorded at mint AND as the tab
      // stands now. A tab that switched provider in between (Claude→Codex on A
      // while a queued Claude event still names A) fails the batch closed: the
      // workflow fence cannot catch it (A's uuid is unchanged), and inheriting
      // would hand this conversation a tab that now belongs to another one.
      const backend = this.deps.backendOfKey(key);
      if (rec.backend !== backend || this.deps.backendForTab(rec.tab) !== backend) {
        // NOT marked consumed: a re-queue of this item must fail closed again,
        // not silently inherit the last established origin.
        this.turnUuidByMid.delete(mid);
        batch.unknown = true;
        this.deps.warn(
          `[panel-orchestrator] ${key} dequeued a message whose origin tab ${rec.tab.slice(0, 8)} ` +
            `no longer belongs to this conversation's backend (recorded ${rec.backend}, tab now ` +
            `${this.deps.backendForTab(rec.tab)}) — the turn FAILS CLOSED rather than pinning a ` +
            `tab another backend's conversation owns (#884 confirming gate 3)`,
        );
      } else {
        batch.known.push(rec.uuid);
        batch.tabs.add(rec.tab);
        this.turnUuidByMid.delete(mid);
        this.noteConsumedTurnMid(mid);
      }
    } else if (!this.consumedTurnMids.has(mid)) {
      // Unknown mid (evicted / foreign): its origin workflow cannot be known —
      // the batch must fail closed, never inherit a stale stamp.
      batch.unknown = true;
    }
    // A consumed mid (a re-queued item, or a deliberately origin-less injected
    // turn) contributes nothing: it either already applied its stamp at its
    // first dequeue, or it inherits at the batch close below.
    if (opensBatch) {
      const closed = batch;
      queueMicrotask(() => {
        this.pendingBatchStamp.delete(key);
        const distinct = new Set(closed.known);
        if (closed.unknown || closed.tabs.size > 1) {
          // Mixed/unknown-TAB batch: no single stamp or target is honest for
          // it — fail BOTH closed (the bridge refuses routing; the panel fence
          // refuses mutations) until an explicit target or the next
          // single-origin message.
          this.lastTurnUuidByKey.set(key, undefined);
          this.turnTargetTabByKey.set(key, null);
          this.deps.warn(
            `[panel-orchestrator] ${key} dispatched a mixed/unknown-origin batch — no single workflow stamp/target is honest for it, so scope routing and graph mutations FAIL CLOSED until the agent opens/pins a workflow or the next single-origin message (#884)`,
          );
        } else if (closed.tabs.size === 1) {
          // TURN-TARGET PIN (confirming gate P0): this turn's tool calls route
          // to the tab the turn was ISSUED from — never re-resolved mid-turn —
          // and its mutations are fenced to that tab's issue-time workflow.
          // This agreed origin becomes the conversation's LAST ESTABLISHED
          // origin for origin-less turns that follow.
          const tab = closed.tabs.values().next().value as string;
          const uuid = distinct.size === 1 ? distinct.values().next().value : undefined;
          this.lastTurnUuidByKey.set(key, uuid);
          this.turnTargetTabByKey.set(key, tab);
          this.lastOriginByKey.set(key, { tab, uuid });
        } else {
          // NO origin contribution (a pure re-queue, or a deliberately
          // origin-less injected turn such as a coalesced download_done): the
          // turn inherits the conversation's LAST ESTABLISHED origin — NEVER
          // "whatever tab is active" (confirming gate 2, P0). The inherited tab
          // must STILL belong to this conversation's backend (confirming gate
          // 3, P0); no established/valid origin at all → refuse.
          const last = this.lastOriginByKey.get(key);
          if (last && this.deps.backendForTab(last.tab) === this.deps.backendOfKey(key)) {
            this.lastTurnUuidByKey.set(key, last.uuid);
            this.turnTargetTabByKey.set(key, last.tab);
          } else {
            this.lastTurnUuidByKey.set(key, undefined);
            this.turnTargetTabByKey.set(key, null);
            this.deps.warn(
              last
                ? `[panel-orchestrator] ${key} dispatched an origin-less turn whose last established origin tab ${last.tab.slice(0, 8)} now belongs to another backend's conversation — scope routing FAILS CLOSED until an explicit target or an origin-bearing message (#884 confirming gate 3)`
                : `[panel-orchestrator] ${key} dispatched a turn with no origin and no established prior origin — scope routing FAILS CLOSED until an explicit target or an origin-bearing message (#884)`,
            );
          }
        }
      });
    }
  }

  /** The turn ended: release its routing pin so idle-time scope resolution
   *  follows the active tab again (the next turn re-pins). */
  turnEnded(key: string): void {
    this.turnTargetTabByKey.delete(key);
  }

  /** A conversation boundary (New chat / resume switch): the replaced
   *  conversation's issue-time stamp, turn pin AND last established origin die
   *  with it. The origin must go too (codex gate-3 confirm, P1): the inherit
   *  path re-establishes pin+stamp from it, so leaving it behind would let an
   *  origin-less turn (a download completing right after the boundary)
   *  resurrect the very binding the boundary just deleted. */
  forgetConversation(key: string): void {
    this.lastTurnUuidByKey.delete(key);
    this.turnTargetTabByKey.delete(key);
    this.lastOriginByKey.delete(key);
  }

  /** A rewind dropped the branch that established this conversation's stamp
   *  AND its last origin; the edited message that follows re-establishes both
   *  at its own dequeue (codex r2). Until then an origin-less turn REFUSES
   *  (null pin) rather than inheriting the dropped branch's origin — the
   *  rewind's whole point is that the dropped branch's bindings must not
   *  outlive it (codex gate-3 confirm, P1: the agent stays LIVE across a
   *  rewind, so a download_done landing before the edited message would have
   *  re-pinned the dropped branch's tab and resurrected its deleted stamp). */
  dropBranch(key: string): void {
    this.lastTurnUuidByKey.delete(key);
    this.lastOriginByKey.delete(key);
  }

  /** The in-flight turn's routing pin: string = pinned tab; null = ambiguous
   *  origin (refuse loudly); undefined = no turn in flight (active-tab
   *  resolution applies). */
  pinOf(key: string): string | null | undefined {
    return this.turnTargetTabByKey.has(key) ? this.turnTargetTabByKey.get(key)! : undefined;
  }

  /** The conversation's issue-time workflow stamp (what scope-addressed
   *  mutations carry). */
  stampOf(key: string): string | undefined {
    return this.lastTurnUuidByKey.get(key);
  }

  /** #716/#884 — an explicit, VALIDATED open/re-pin from the shared agent is
   *  the agent deliberately moving its turn to another workflow: refresh the
   *  conversation's issue-time stamp. */
  setStamp(key: string, uuid: string | undefined): void {
    this.lastTurnUuidByKey.set(key, uuid);
  }

  /** EXPLICIT repin recovery (see makeScopeRepinHandler, which gates this):
   *  re-pin the conversation's in-flight turn onto `tab` and re-derive the
   *  fence from it — a repin that left the OLD workflow's stamp in force would
   *  hand back a session whose very next mutation fails closed. Pin and stamp
   *  move together or neither does.
   *
   *  Deliberately does NOT write the LAST ESTABLISHED origin (codex delta
   *  review, P1): the recovery re-aims the CURRENT turn only. Inheritance for
   *  FUTURE origin-less turns derives solely from batch-close message origins,
   *  so a dying pre-rewind turn's late mode:"current" recovery — racing the
   *  rewind's dropBranch() — cannot re-establish an inheritance source the
   *  boundary just cleared; a post-boundary download turn refuses until the
   *  edited message establishes a real origin. */
  repinTo(key: string, tab: string): void {
    const uuid = this.deps.uuidOfTab(tab);
    this.turnTargetTabByKey.set(key, tab);
    this.lastTurnUuidByKey.set(key, uuid);
  }
}

/** The scope target resolver the UiBridge consults while resolving a
 *  scope-addressed command: the in-flight turn's pin (string), an ambiguous
 *  origin (`null` → refuse loudly), or no turn in flight (undefined →
 *  active-tab resolution). Built here so tests drive the REAL resolver. */
export function makeScopeTargetResolver(opts: {
  tracker: TurnOriginTracker;
  scopeAgentKeyOf: (scopeId: string) => string;
}): (scopeId: string) => string | null | undefined {
  return (scopeId) => opts.tracker.pinOf(opts.scopeAgentKeyOf(scopeId));
}

/** The slice of UiBridge the repin recovery consults. */
export interface ScopeRepinBridge {
  canReach(tabId: string): boolean;
  resolveActiveScopeTab(): string | undefined;
  isHeadless?(tabId: string): boolean;
  tabs(): Array<{ tab_id: string }>;
}

/**
 * EXPLICIT recovery from a DEAD or AMBIGUOUS pin — the only path that rewrites
 * an in-flight turn's pin, reached solely through the agent's explicit
 * panel_set_workflow_target({mode:"current"}) consent (panel_reload is NOT a
 * consent path — confirming gate 3, P0: it silently repinned a healthy turn).
 *
 * Fails closed (returns undefined, repinning nothing) unless ALL of:
 *  - the existing pin does NOT reach a live tab (a healthy binding is never
 *    displaced — recovery only; the consent caller re-checks this too, and
 *    this handler enforces it again so no other caller can hijack a live pin);
 *  - a target tab can be picked that is CANVAS-OWNING (a headless viewer can
 *    never host a graph session) and belongs to THIS conversation's backend
 *    (adopting another backend's tab would route this conversation's tool
 *    calls at a tab whose user is talking to a different provider — the same
 *    class as the backend-bound origin rule). The active tab is preferred;
 *    otherwise the backend's SOLE interactive tab; 2+ candidates without a
 *    clear active one refuse rather than guess.
 */
export function makeScopeRepinHandler(opts: {
  bridge: ScopeRepinBridge;
  tracker: TurnOriginTracker;
  scopeAgentKeyOf: (scopeId: string) => string;
  backendForTab: (tabId: string) => string;
  backendOfKey: (key: string) => string;
  info: (msg: string) => void;
}): (scopeId: string) => string | undefined {
  return (scopeId) => {
    const key = opts.scopeAgentKeyOf(scopeId);
    // RECOVERY ONLY: a pin that still reaches a live tab is healthy — never
    // displace it (null = ambiguous and absent = no pin are both recoverable).
    const existing = opts.tracker.pinOf(key);
    if (typeof existing === "string" && opts.bridge.canReach(existing)) {
      return undefined;
    }
    const backend = opts.backendOfKey(key);
    const eligible = opts.bridge
      .tabs()
      .map((t) => t.tab_id)
      .filter((t) => opts.bridge.isHeadless?.(t) !== true && opts.backendForTab(t) === backend);
    const active = opts.bridge.resolveActiveScopeTab();
    const tab =
      active && eligible.includes(active)
        ? active
        : eligible.length === 1
          ? eligible[0]
          : undefined;
    if (!tab) return undefined;
    opts.tracker.repinTo(key, tab);
    opts.info(
      `[panel-orchestrator] ${key} re-pinned onto ${tab.slice(0, 8)} by explicit target request (#884 recovery)`,
    );
    return tab;
  };
}
