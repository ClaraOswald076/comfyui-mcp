// Durable-across-the-turn delivery of a render COMPLETION to the panel agent
// (issue #468).
//
// THE FAILURE. `panel_run` queues a render on the user's canvas and tells the
// agent — in so many words — "end your turn, you WILL be notified when it
// finishes". That promise is kept by exactly one mechanism: the panel's
// `agent_event` frame → PanelAgentManager.injectEvent → PanelAgent.queue. That
// path used to be fire-and-forget in three independent ways:
//
//   1. UNCORRELATED. The completion carried no run identity the orchestrator
//      ever looked at. `panel_run` learns ComfyUI's `prompt_id` (it already
//      hands it to QueueMonitor.markSelfQueued) but nothing downstream used it,
//      so a completion could not be tied to the run that was outstanding — and
//      an outstanding run could never be known to be unanswered.
//   2. SILENTLY DROPPED with no live agent. injectEvent returns false for a
//      missing/stopped agent and the caller only logged on success. Nothing
//      recorded the loss.
//   3. DIED WITH A QUEUED-BUT-UNREAD ITEM. The event is only really delivered
//      when channel() splices it into a turn. Everything before that — a
//      stop()/retire(), a stall-abandoned turn, a takePending() race — discards
//      it.
//
// AUTOMATIC GOAL CONTINUATION is what turns those windows from theoretical into
// routine. An ordinary single run ends the agent's turn and leaves it idle, so
// the completion lands in an empty queue and is drained immediately. A
// continuation keeps the agent BUSY for the whole render: the completion sits in
// `queue` (window 3) for minutes, and the continuation's own turn churn is
// exactly what fires the deferred session restarts (effort/model change,
// comfyui-MCP-env respawn) that applyPendingRestarts defers "until idle" and the
// self-restart loop — each of which tears the listener down (windows 2 and 3)
// underneath the very render whose completion is in flight.
//
// THE CONTRACT HERE.
//  • Runs are ticketed by ComfyUI's `prompt_id`, opened by `panel_run`.
//  • Every completion is CORRELATED ONCE, AT ARRIVAL, by EXACT prompt-id
//    equality against an open ticket — never by recency, never re-derived later.
//  • An uncorrelatable completion is still delivered, labelled UNDETERMINED. It
//    is never swallowed and never allowed to answer for a run it can't be proven
//    to belong to.
//  • Undelivered completions are JOURNALED and replayed at the next delivery
//    opportunity (a fresh agent spawn, a later completion for the same tab).
//  • An entry is cleared only on a positive ack — the turn that CARRIED it
//    ended. Handed to an agent that then died, it comes back and is replayed.
//
// LOCAL trust domain: this is accidental-loss bookkeeping, not a defense against
// a hostile panel. Everything is in-memory and process-scoped; an orchestrator
// restart drops the journal along with the agents it was addressing.

import { logger } from "../utils/logger.js";

/** How a completion relates to the runs this session queued. Computed ONCE, at
 *  arrival, and frozen onto the journal entry — a replay never re-correlates,
 *  so a completion can never drift onto a run that started after it landed. */
export type RunCorrelation =
  /** Exact prompt-id match with a run `panel_run` queued from this session. */
  | { status: "matched"; promptId: string }
  /** Carries a prompt id, but no run this session queued has that id. Real, but
   *  NOT ours — it must never satisfy an outstanding `panel_run`. */
  | { status: "foreign"; promptId: string }
  /** No prompt id at all. Unattributable in principle; reported as such. */
  | { status: "unidentified" };

/** The completion payload as it arrives from the panel (the `agent_event` frame
 *  minus the routing fields). Kept loose on purpose — the panel is free to add
 *  fields and we forward what we're given. */
export interface CompletionPayload {
  kind?: string;
  images?: Array<{ filename: string; subfolder?: string; type?: string }>;
  error?: string;
  note?: string;
  prompt_id?: string;
  [k: string]: unknown;
}

/** A run `panel_run` queued and is waiting on. */
export interface RunTicket {
  promptId: string;
  /** Panel tab the run was queued from. Part of the MATCH: a completion is only
   *  "the run YOU queued" for the tab that queued it, so a workflow switch or a
   *  cross-tab completion reads as foreign instead of being misattributed. A
   *  proven tab-id migration moves it (moveKey) so the tab's own runs still
   *  match. */
  tabId: string;
  queuedAt: number;
  toNodeId?: number;
  /** True once a completion for this exact prompt id was acked as delivered. */
  settled: boolean;
}

export type EntryState =
  /** Waiting for a delivery attempt. */
  | "pending"
  /** Handed to a live agent; not proven consumed yet. */
  | "handed_off";

export interface JournalEntry {
  token: string;
  /** Composite agent key this completion is addressed to. An entry is only ever
   *  replayed to THIS key (moved wholesale by `moveKey` on a tab-id migration) —
   *  it is never broadcast or re-targeted. */
  key: string;
  payload: CompletionPayload;
  correlation: RunCorrelation;
  arrivedAt: number;
  attempts: number;
  state: EntryState;
  /** Content fingerprint — set only for ID-LESS completions, which have no run
   *  identity to dedupe on. See idlessFingerprint(). */
  fingerprint?: string;
  /** How many turns carried this completion and then ended without a provable
   *  ack. Bounds the replay loop — see release(). */
  carriedReleases?: number;
  /** ID-LESS only: an identical completion was delivered recently, so this may be
   *  the same frame re-sent. Delivered anyway (never swallowed) but FLAGGED, so
   *  the agent doesn't double-count it. */
  possibleRepeat?: boolean;
  /** This entry's prompt id was queued AGAIN while it was still undelivered, so
   *  it belongs to the older run. Still delivered, but it can no longer be merged
   *  into, settle a ticket, or memoize a delivery. */
  superseded?: boolean;
  /** Evicted-completion count this entry is carrying out on the tab's behalf, so
   *  the disclosure rides a real delivery instead of a side map that could be
   *  discarded before it is ever reported. */
  disclose?: number;
}

/** Runs tracked at once. Ample for any real batch; bounded so a long session
 *  can't grow the map without limit. */
const MAX_TICKETS = 64;
/** Undelivered completions held per panel tab. */
const MAX_ENTRIES_PER_KEY = 32;
/** Undelivered completions held across ALL tabs — a global ceiling so a session
 *  that opens and abandons many tabs can't grow the journal without limit. */
const MAX_ENTRIES_TOTAL = 96;
/** (tab, run) pairs remembered as already delivered, to suppress a re-sent frame
 *  after its entry was acked and removed. */
const MAX_DELIVERED_MEMO = 256;
/** Tabs whose evicted-completion counter is retained. */
const MAX_DROPPED_KEYS = 64;
/** How many times a completion may be CARRIED BY A TURN THAT THEN ENDED without a
 *  provable ack before the journal settles it anyway.
 *
 *  Counts turns, NOT queue hand-offs. A hand-off only means the event was queued;
 *  an agent torn down before it drained its queue never showed the text to
 *  anyone, so counting those would settle — and lose — a completion that three
 *  ordinary provider/session replacements had merely shuffled around. The only
 *  cycle that needs bounding is "dispatched into a turn → that turn ended → its
 *  result could not be proven to be its own → replay", which a backend that
 *  declares turn markers but never stamps its results would otherwise repeat
 *  forever. Each of THOSE put the completion's text into a turn the agent read,
 *  so settling risks a duplicate, never a loss. */
const MAX_CARRIED_RELEASES = 3;
/**
 * ID-LESS completions have no run identity, so content is the only evidence of
 * sameness — and identical content is NOT proof: ComfyUI reuses temp output names
 * (`ComfyUI_temp_*_00001_`) after a restart, so two genuinely different renders
 * can look the same. The policy therefore splits by how much a mistake costs:
 *
 *  • STILL JOURNALED, UNDELIVERED, within IDLESS_COLLAPSE_MS — collapse onto the
 *    one entry. This is a transport-retry timescale, not a render timescale: two
 *    real renders finishing with byte-identical output lists AND both still
 *    undelivered inside 30s is not a case that occurs, while a panel re-sending a
 *    frame is. Collapsing here is what stops one output producing two turns.
 *  • ALREADY DELIVERED, within IDLESS_REPEAT_HINT_MS — do NOT suppress. Swallow
 *    the wrong one and a real render is silently lost, which is the failure this
 *    whole file exists to prevent. Deliver it FLAGGED as a possible repeat so the
 *    agent can decline to double-count it, and let the agent judge.
 */
const IDLESS_COLLAPSE_MS = 30_000;
const IDLESS_REPEAT_HINT_MS = 10 * 60_000;

/** Memo key for an already-delivered (tab, run). "|" separates them; a ComfyUI
 *  prompt id is a fixed-format UUID, so the pair can't alias another. */
function deliveredKey(key: string, promptId: string): string {
  return `${key}|${promptId}`;
}

/**
 * Fingerprint for an ID-LESS completion (a panel that forwarded no `prompt_id`).
 * With no run identity, content is all we have to tell "the panel re-sent the
 * same frame" from "a second render finished": kind + note + error + the exact
 * output list. Combined with IDLESS_DEDUPE_WINDOW_MS this collapses a repeat
 * without letting a later, genuinely different render inherit the suppression.
 * Filenames are NOT sorted — the panel emits them in output order, and a
 * different order is a different batch.
 */
function idlessFingerprint(key: string, payload: CompletionPayload): string {
  const files = (payload.images ?? [])
    .map((i) => `${i.subfolder ?? ""}/${i.type ?? ""}/${i.filename}`)
    .join(",");
  return `${key}|~idless~|${payload.kind ?? ""}|${payload.note ?? ""}|${payload.error ?? ""}|${files}`;
}

export class RunCompletionJournalImpl {
  /** prompt id → ticket. Keyed globally: ComfyUI prompt ids are UUIDs, so an
   *  exact match is proof of identity on its own and survives a session's tab
   *  id being rebound between the queue and the completion. */
  private tickets = new Map<string, RunTicket>();
  /** token → entry (insertion-ordered, which is also delivery order). */
  private entries = new Map<string, JournalEntry>();
  /** (tab, run) pairs whose completion was ACKED — a bounded FIFO memo so a
   *  panel that re-sends the frame after the entry was removed can't produce a
   *  second delivery. */
  private delivered = new Set<string>();
  /** Content fingerprint → delivery time, for ID-LESS completions (which have no
   *  run identity to memoize). Bounded FIFO + a time window, so an identical
   *  re-send is suppressed but a later genuinely-different render is not. */
  private idlessSeen = new Map<string, number>();
  private seq = 0;

  /** `panel_run` queued a render. Returns false when ComfyUI/the panel gave us
   *  no prompt id — the caller MUST then tell the agent its completion cannot be
   *  correlated rather than promising a notification it may not be able to
   *  attribute. */
  openRun(promptId: string | null | undefined, meta: { tabId: string; toNodeId?: number }): boolean {
    if (typeof promptId !== "string" || !promptId) return false;
    const existing = this.tickets.get(promptId);
    if (existing) {
      // Same prompt id queued again (a re-run of an id ComfyUI reused, or a
      // duplicate reply): reopen it rather than stacking a second ticket, so one
      // prompt id always means one run.
      existing.settled = false;
      existing.tabId = meta.tabId;
      existing.queuedAt = Date.now();
      // SUPERSEDE any entry still carrying the PREVIOUS run's completion for this
      // id. Without this, the new run's completion merges into an entry that is
      // already sitting in an agent queue holding the OLD completion's text: when
      // that turn ends, ack() removes the shared entry and settles the REOPENED
      // ticket — the old result is presented as the new run's, and the new run's
      // real completion is never delivered. A superseded entry is skipped by the
      // dedupe scan and can no longer settle a ticket or memoize a delivery.
      for (const entry of this.entries.values()) {
        if (
          entry.correlation.status !== "unidentified" &&
          entry.correlation.promptId === promptId &&
          !entry.superseded
        ) {
          entry.superseded = true;
          logger.warn(
            `[run-completions] prompt ${promptId} was queued again while its previous completion was still undelivered — the older entry is superseded and can no longer answer for the new run`,
          );
        }
      }
      // …and CLEAR the already-delivered memo for it. Reopening the ticket while
      // the memo stood meant the reopened run's completion was suppressed as a
      // duplicate of the PREVIOUS run's: `panel_run` promised automatic delivery
      // and the journal then swallowed it. The memo only ever means "we already
      // reported THIS run", which a genuine re-queue makes false.
      this.delivered.delete(deliveredKey(meta.tabId, promptId));
      return true;
    }
    this.tickets.set(promptId, {
      promptId,
      tabId: meta.tabId,
      queuedAt: Date.now(),
      ...(typeof meta.toNodeId === "number" ? { toNodeId: meta.toNodeId } : {}),
      settled: false,
    });
    this.trimTickets();
    return true;
  }

  /**
   * Classify a completion that arrived for panel tab `key` against the open runs.
   *
   * TWO conditions, both required: EXACT prompt-id equality AND the ticket must
   * belong to THIS panel tab. There is deliberately no "the newest outstanding
   * run" fallback and no cross-tab match, because attributing a completion to
   * the wrong run — or to a different workflow's agent — is worse than not
   * attributing it at all. A run whose ticket belongs to another tab reads as
   * `foreign`, i.e. UNDETERMINED, which is the honest answer.
   */
  correlate(key: string, payload: CompletionPayload): RunCorrelation {
    const pid = typeof payload.prompt_id === "string" ? payload.prompt_id.trim() : "";
    if (!pid) return { status: "unidentified" };
    const ticket = this.tickets.get(pid);
    return ticket && ticket.tabId === key
      ? { status: "matched", promptId: pid }
      : { status: "foreign", promptId: pid };
  }

  /**
   * Journal a completion addressed to `key`. Correlation is computed here, once.
   *
   * DEDUPE, in both directions:
   *  • IDENTIFIED (matched or foreign) — collapses onto any existing undelivered
   *    entry for the same key + prompt id, and is suppressed outright once that
   *    (tab, run) has been acked. One run can never produce two deliveries,
   *    however many times the panel re-sends it.
   *  • ID-LESS — there is no run identity, so it dedupes on a CONTENT
   *    fingerprint within IDLESS_DEDUPE_WINDOW_MS. That is enough to stop a
   *    re-sent frame producing two turns (the agent double-reporting, or acting
   *    twice on one output), while a later genuinely different render — or the
   *    same content long afterwards — is still delivered.
   * Returns null when the completion is a suppressed duplicate.
   */
  record(key: string, payload: CompletionPayload): JournalEntry | null {
    const correlation = this.correlate(key, payload);
    let idlessRepeat = false;
    if (correlation.status !== "unidentified") {
      // Already DELIVERED once (its carrying turn ended, so the entry is gone).
      // A panel that re-sends the frame must not produce a second delivery — the
      // dedupe below can't see an entry that no longer exists.
      if (this.delivered.has(deliveredKey(key, correlation.promptId))) {
        logger.info(
          `[run-completions] ignoring a re-sent completion for ${describe(correlation)} — already delivered to tab ${key.slice(0, 8)}`,
        );
        return null;
      }
      for (const entry of this.entries.values()) {
        if (
          entry.key === key &&
          !entry.superseded && // a re-queued run never merges into the old one's entry
          entry.correlation.status !== "unidentified" &&
          entry.correlation.promptId === correlation.promptId
        ) {
          // Freshen the payload, but do NOT re-open a hand-off. The copy already
          // sitting in an agent's queue cannot be recalled, so re-arming here
          // would deliver the same completion twice (and the first ack would
          // then drop the entry, leaving the second delivery untracked). If the
          // hand-off fails, the release path re-arms it — that is the only way
          // back to `pending`.
          entry.payload = payload;
          return entry;
        }
      }
    } else {
      const print = idlessFingerprint(key, payload);
      const now = Date.now();
      // COLLAPSE only onto a twin that is STILL PENDING — not yet handed to any
      // agent. That is the whole safety argument: neither copy has reached
      // anyone, so one delivery instead of two cannot lose news the agent
      // already has. `handed_off` does NOT qualify: that copy is sitting unread
      // in a busy agent's queue and will be acked when its turn ends, so merging
      // a second real render into it would delete the second render outright —
      // the exact silent swallow this design splits to avoid.
      for (const entry of this.entries.values()) {
        if (
          entry.key === key &&
          entry.state === "pending" &&
          entry.correlation.status === "unidentified" &&
          entry.fingerprint === print &&
          now - entry.arrivedAt < IDLESS_COLLAPSE_MS
        ) {
          entry.payload = payload;
          return entry;
        }
      }
      // An identical twin that is already handed off (or delivered) falls
      // through to a NEW entry below, flagged `possible_repeat` — never merged.
      const twinInFlight = [...this.entries.values()].some(
        (e) =>
          e.key === key &&
          e.state === "handed_off" &&
          e.correlation.status === "unidentified" &&
          e.fingerprint === print,
      );
      // Already DELIVERED an identical id-less completion recently. Deliberately
      // NOT suppressed: identical content is not proof of identity, and swallowing
      // a second real render is a silent loss. Deliver it flagged instead.
      const seenAt = this.idlessSeen.get(print);
      const repeatHint = seenAt !== undefined && now - seenAt < IDLESS_REPEAT_HINT_MS;
      if (seenAt !== undefined && !repeatHint) this.idlessSeen.delete(print); // stale
      idlessRepeat = repeatHint || twinInFlight;
      if (idlessRepeat) {
        logger.info(
          `[run-completions] tab ${key.slice(0, 8)}: an id-less completion with identical content was already delivered — forwarding it FLAGGED as a possible repeat (never suppressed: content is not identity)`,
        );
      }
    }
    const entry: JournalEntry = {
      token: `rc${++this.seq}`,
      key,
      payload,
      correlation,
      arrivedAt: Date.now(),
      attempts: 0,
      state: "pending",
      ...(correlation.status === "unidentified"
        ? { fingerprint: idlessFingerprint(key, payload), ...(idlessRepeat ? { possibleRepeat: true } : {}) }
        : {}),
    };
    this.entries.set(entry.token, entry);
    this.trimEntries(key);
    return entry;
  }

  /** Completions this tab lost to an eviction and has not yet been told about.
   *  Surfaced on the next delivery so a dropped completion is never silent. */
  private dropped = new Map<string, number>();

  /** Count a lost completion for a tab, bounding the map so a churn of one-off
   *  tabs can't grow it forever (the oldest unreported count is discarded — it
   *  was already logged at ERROR when it happened). */
  /**
   * Record that a completion for `key` was destroyed by an eviction, so the next
   * delivery to that tab can report it as UNDETERMINED.
   *
   * The count is stamped onto a SURVIVING entry for the same tab whenever one
   * exists — it then rides out on a real delivery and cannot be discarded. The
   * side map is only for a tab with nothing left to carry it, i.e. a tab whose
   * next delivery is hypothetical anyway; that is the only thing the bound can
   * ever discard, and it is logged.
   */
  private noteDropped(key: string, count = 1): void {
    if (count <= 0) return;
    const carrier = [...this.entries.values()].find((e) => e.key === key);
    if (carrier) {
      carrier.disclose = (carrier.disclose ?? 0) + count;
      return;
    }
    this.dropped.set(key, (this.dropped.get(key) ?? 0) + count);
    while (this.dropped.size > MAX_DROPPED_KEYS) {
      const victim = this.dropped.keys().next().value;
      if (victim === undefined) break;
      const lost = this.dropped.get(victim) ?? 0;
      this.dropped.delete(victim);
      logger.error(
        `[run-completions] discarding the undelivered-completion count (${lost}) for tab ${victim.slice(0, 8)} — over ${MAX_DROPPED_KEYS} agentless tabs are tracking one; that tab will not be told`,
      );
    }
  }

  /** Entries awaiting a delivery attempt for this key, in arrival order. */
  pending(key: string): JournalEntry[] {
    const out: JournalEntry[] = [];
    for (const entry of this.entries.values()) {
      if (entry.key === key && entry.state === "pending") out.push(entry);
    }
    return out;
  }

  /**
   * Deliver every pending entry for `key`, in ARRIVAL order, stopping at the
   * first refusal so a newer completion can never overtake an older one that is
   * still stuck.
   *
   * `inject` returns whether the agent TOOK the payload onto its queue — not
   * that it was read. The entry stays journaled either way; only `ack` (the turn
   * that carried it ended) removes it. That is the whole durability property:
   * hand it to an agent that then dies and it comes back here.
   *
   * NOTHING is re-correlated: the payload is stamped with the verdict frozen at
   * arrival, so a replay can never be re-attributed to a run that started later.
   */
  deliverPending(
    key: string,
    inject: (payload: CompletionPayload, token: string) => boolean,
  ): { delivered: number; blockedOn: JournalEntry | null } {
    let delivered = 0;
    for (const entry of this.pending(key)) {
      // Any completion this tab lost to an eviction rides out on the next one
      // that DOES get through, so an evicted completion is reported rather than
      // silently forgotten.
      // The tab's evicted-completion count: whatever this entry is carrying, plus
      // anything stranded in the side map from a period when the tab had no entry
      // to carry it.
      const lost = (entry.disclose ?? 0) + (this.dropped.get(key) ?? 0);
      const payload: CompletionPayload = {
        ...entry.payload,
        run_correlation: entry.correlation.status,
        ...(entry.correlation.status === "unidentified"
          ? {}
          : { prompt_id: entry.correlation.promptId }),
        // Second and later attempts ARE re-deliveries — say so, so the agent
        // reads a replay as "this landed late", not as another render.
        ...(entry.attempts > 0 ? { replayed: true } : {}),
        ...(lost > 0 ? { dropped_completions: lost } : {}),
        ...(entry.possibleRepeat ? { possible_repeat: true } : {}),
      };
      const handedOff = inject(payload, entry.token);
      this.noteAttempt(entry.token, handedOff);
      if (!handedOff) return { delivered, blockedOn: entry };
      if (lost > 0) {
        this.dropped.delete(key);
        delete entry.disclose;
      }
      delivered += 1;
    }
    return { delivered, blockedOn: null };
  }

  /** All still-unacked entries for a key (pending OR handed off) — diagnostics. */
  outstanding(key: string): JournalEntry[] {
    return [...this.entries.values()].filter((e) => e.key === key);
  }

  /** Is ANY completion still undelivered anywhere? The orchestrator's
   *  self-restart gate reads this: the journal is in-memory, so restarting while
   *  an entry is outstanding would silently drop a render result the agent was
   *  promised. */
  hasOutstanding(): boolean {
    return this.entries.size > 0;
  }

  /** Every still-unacked entry, across all tabs — for the last-ditch disclosure
   *  the orchestrator makes when a fatal self-exit is about to destroy them. */
  allOutstanding(): JournalEntry[] {
    return [...this.entries.values()];
  }

  /** Record the outcome of a delivery attempt. `handedOff` true = an agent took
   *  it onto its queue (not yet proof it was read). */
  noteAttempt(token: string, handedOff: boolean): void {
    const entry = this.entries.get(token);
    if (!entry) return;
    entry.attempts += 1;
    entry.state = handedOff ? "handed_off" : "pending";
  }

  /** The turn that CARRIED this completion ended — it genuinely reached the
   *  agent. Drop the entry and settle its run. */
  ack(token: string): void {
    const entry = this.entries.get(token);
    if (!entry) return;
    this.entries.delete(token);
    // A SUPERSEDED entry belongs to a run whose prompt id was queued again. It
    // was still delivered (its text reached the agent), but it must not settle
    // the REOPENED ticket — that would present the old result as the new run's —
    // and must not memoize the id as delivered, which would then suppress the new
    // run's real completion.
    if (entry.superseded) return;
    if (entry.correlation.status !== "unidentified") {
      // Remember (tab, run) so a later re-send of the same frame is suppressed
      // rather than delivered a second time. Bounded FIFO — old ids age out; a
      // re-send that late is not a real case.
      this.delivered.add(deliveredKey(entry.key, entry.correlation.promptId));
      while (this.delivered.size > MAX_DELIVERED_MEMO) {
        const oldest = this.delivered.values().next().value;
        if (oldest === undefined) break;
        this.delivered.delete(oldest);
      }
    } else if (entry.fingerprint) {
      // ID-LESS: memoize the CONTENT so a re-sent identical frame after the ack
      // doesn't produce a second turn. Windowed in record(), bounded here.
      this.idlessSeen.set(entry.fingerprint, Date.now());
      while (this.idlessSeen.size > MAX_DELIVERED_MEMO) {
        const oldest = this.idlessSeen.keys().next().value;
        if (oldest === undefined) break;
        this.idlessSeen.delete(oldest);
      }
    }
    if (entry.correlation.status === "matched") {
      const ticket = this.tickets.get(entry.correlation.promptId);
      if (ticket) ticket.settled = true;
    }
  }

  /**
   * An agent gave a hand-off back undelivered. Re-arm it for replay.
   *
   * `carried` distinguishes the two causes, and ONLY the first is bounded:
   *  • carried: true  — a turn actually DISPATCHED with this completion in it and
   *    then ended, but its result could not be proven to be that turn's own. The
   *    agent read the text. A backend that declares turn markers yet never stamps
   *    its results would bounce the entry here on every single turn, so after
   *    MAX_CARRIED_RELEASES we settle rather than loop: a duplicate at worst.
   *  • carried: false — a teardown handed it back (agent stopped, held mail
   *    discarded, session died). NOBODY read it. These must never count toward
   *    the bound, or three ordinary provider/session replacements would settle —
   *    and lose — a completion that was only ever shuffled between queues.
   */
  release(token: string, opts: { carried?: boolean } = {}): void {
    const entry = this.entries.get(token);
    if (!entry) return;
    if (opts.carried) {
      entry.carriedReleases = (entry.carriedReleases ?? 0) + 1;
      if (entry.carriedReleases >= MAX_CARRIED_RELEASES) {
        logger.warn(
          `[run-completions] ${describe(entry.correlation)} was carried by ${entry.carriedReleases} turns that ended without a provable ack — settling it instead of replaying again`,
        );
        this.ack(token);
        return;
      }
    }
    entry.state = "pending";
  }

  /** Move every entry AND every open run ticket from `from` onto `to` — a panel
   *  tab-id migration re-keys the agent, and both must move WITH it or a later
   *  completion for a run queued under the old id reads as foreign. This
   *  re-addresses, it never broadens: other tabs' state is untouched. */
  moveKey(from: string, to: string): void {
    if (from === to) return;
    for (const entry of this.entries.values()) {
      if (entry.key === from) entry.key = to;
    }
    for (const ticket of this.tickets.values()) {
      if (ticket.tabId === from) ticket.tabId = to;
    }
    // ALL per-tab state moves, not just the visible two. Leaving the delivered
    // memo behind would let a post-migration re-send be delivered a SECOND time
    // (its settled ticket moved, so it still correlates as matched); leaving the
    // eviction counter behind would silently swallow the "these runs are
    // undetermined" disclosure it exists to carry.
    for (const memo of [...this.delivered]) {
      if (!memo.startsWith(`${from}|`)) continue;
      this.delivered.delete(memo);
      this.delivered.add(`${to}|${memo.slice(from.length + 1)}`);
    }
    const lost = this.dropped.get(from);
    if (lost !== undefined) {
      this.dropped.delete(from);
      this.dropped.set(to, (this.dropped.get(to) ?? 0) + lost);
    }
    // The id-less content memo and every entry's fingerprint embed the tab key,
    // so they must be re-keyed too or a post-migration re-send is delivered
    // twice — the same defect as the delivered memo above.
    const fromPrefix = `${from}|~idless~|`;
    for (const [print, at] of [...this.idlessSeen]) {
      if (!print.startsWith(fromPrefix)) continue;
      this.idlessSeen.delete(print);
      this.idlessSeen.set(`${to}|~idless~|${print.slice(fromPrefix.length)}`, at);
    }
    for (const entry of this.entries.values()) {
      if (entry.fingerprint?.startsWith(fromPrefix)) {
        entry.fingerprint = `${to}|~idless~|${entry.fingerprint.slice(fromPrefix.length)}`;
      }
    }
  }

  /**
   * Drop everything belonging to a tab that will never come back — a closed tab,
   * or the workflow being switched AWAY from.
   *
   * Tickets go too, not just entries: a run queued under the old workflow that
   * finishes AFTER the switch would otherwise still `correlate` as matched (the
   * ticket map is global) and be delivered to the NEW workflow's agent as "the
   * run YOU queued". Forgetting the ticket makes that completion read as
   * foreign — i.e. UNDETERMINED — which is the honest answer.
   *
   * Logs every completion that dies unacked; a loss must never be silent.
   */
  forget(key: string): void {
    for (const [token, entry] of [...this.entries]) {
      if (entry.key !== key) continue;
      this.entries.delete(token);
      logger.warn(
        `[run-completions] dropping an undelivered completion for ${describe(entry.correlation)} — its tab (${key.slice(0, 8)}) is gone`,
      );
    }
    for (const [pid, ticket] of [...this.tickets]) {
      if (ticket.tabId === key) this.tickets.delete(pid);
    }
    this.dropped.delete(key);
    for (const memo of [...this.delivered]) {
      if (memo.startsWith(`${key}|`)) this.delivered.delete(memo);
    }
    for (const print of [...this.idlessSeen.keys()]) {
      if (print.startsWith(`${key}|~idless~|`)) this.idlessSeen.delete(print);
    }
  }

  /**
   * The CONVERSATION that queued this tab's outstanding runs is gone — New chat,
   * a switch to a historical session, or a workflow replaced in place.
   *
   * Drop the tab's run TICKETS but keep its journal entries. A render queued by
   * the old conversation is still real and its completion is still delivered;
   * it just can no longer be introduced to the replacement agent as "the run YOU
   * queued" — it correlates as foreign, i.e. UNDETERMINED. Entries that already
   * arrived keep the verdict frozen at THEIR arrival, so a completion the old
   * conversation was owed is still reported to it correctly if it is still
   * deliverable.
   */
  closeRuns(key: string): void {
    for (const [pid, ticket] of [...this.tickets]) {
      if (ticket.tabId === key) this.tickets.delete(pid);
    }
    // Entries still undelivered were addressed to the conversation that just
    // went away, so their `matched` verdict no longer holds for whoever receives
    // them next: DOWNGRADE to foreign. This does not violate "correlated once at
    // arrival" — a correlation may only ever get WEAKER (matched → foreign),
    // never stronger, and only in response to an explicit "that conversation is
    // gone" event. Without it a completion journaled before New chat would be
    // replayed to the replacement agent as "the run YOU queued".
    for (const entry of this.entries.values()) {
      if (entry.key === key && entry.correlation.status === "matched") {
        entry.correlation = { status: "foreign", promptId: entry.correlation.promptId };
      }
    }
  }

  /** Test/diagnostic helpers. */
  ticketFor(promptId: string): RunTicket | undefined {
    return this.tickets.get(promptId);
  }
  reset(): void {
    this.tickets.clear();
    this.entries.clear();
    this.dropped.clear();
    this.delivered.clear();
    this.idlessSeen.clear();
    this.seq = 0;
  }
  /** Evicted completions this tab has not been told about yet — wherever the
   *  count currently lives (riding an entry, or the agentless side map). */
  droppedFor(key: string): number {
    const carried = [...this.entries.values()]
      .filter((e) => e.key === key)
      .reduce((n, e) => n + (e.disclose ?? 0), 0);
    return carried + (this.dropped.get(key) ?? 0);
  }

  private trimTickets(): void {
    while (this.tickets.size > MAX_TICKETS) {
      // Prefer evicting a settled ticket; otherwise the oldest. An evicted OPEN
      // ticket means a later completion for it correlates as "foreign" — i.e.
      // UNDETERMINED, which is the honest reading once we've forgotten the run.
      let victim: string | null = null;
      for (const [pid, t] of this.tickets) {
        if (t.settled) {
          victim = pid;
          break;
        }
      }
      if (!victim) victim = this.tickets.keys().next().value ?? null;
      if (!victim) return;
      this.tickets.delete(victim);
    }
  }

  /**
   * Enforce the per-tab and global ceilings.
   *
   * EVICTION ORDER matters: an entry already HANDED OFF is sitting in a live
   * agent's queue and will most likely be read, so it is the cheapest thing to
   * forget; a still-PENDING entry has reached nobody, so evicting one is a real
   * loss. Pending entries are therefore evicted last, logged at ERROR, and
   * COUNTED — the count rides out on the next completion that does get through
   * (`dropped_completions`), so the agent is told those runs are undetermined
   * instead of the loss being silent.
   */
  private trimEntries(key: string): void {
    const evict = (scope: (e: JournalEntry) => boolean, limit: number, label: string): void => {
      let mine = [...this.entries.values()].filter(scope);
      while (mine.length > limit) {
        // Prefer an already-handed-off entry: it is at least sitting in a live
        // agent's queue, so it is the likeliest to land anyway. But a hand-off is
        // explicitly NOT proof of consumption, so an evicted hand-off is counted
        // and reported exactly like an evicted pending one — evicting it removes
        // our ability to replay it if that agent dies first.
        const victim = mine.find((e) => e.state === "handed_off") ?? mine[0];
        this.entries.delete(victim.token);
        mine = mine.filter((e) => e !== victim);
        // Its own loss PLUS any disclosure it was carrying for the tab — moved to
        // whatever survives, so an eviction can never drop the disclosure itself.
        this.noteDropped(victim.key, 1 + (victim.disclose ?? 0));
        logger.error(
          `[run-completions] ${label} — dropped a ${victim.state === "pending" ? "still-undelivered" : "handed-off-but-unconfirmed"} completion for ${describe(victim.correlation)}; the next delivery will report it as undetermined`,
        );
      }
    };
    evict(
      (e) => e.key === key,
      MAX_ENTRIES_PER_KEY,
      `journal for tab ${key.slice(0, 8)} exceeded ${MAX_ENTRIES_PER_KEY} undelivered completions`,
    );
    evict(() => true, MAX_ENTRIES_TOTAL, `journal exceeded ${MAX_ENTRIES_TOTAL} undelivered completions overall`);
  }
}

/** Short human label for a correlation, for logs. */
export function describe(correlation: RunCorrelation): string {
  return correlation.status === "unidentified"
    ? "an unidentified run"
    : `${correlation.status === "matched" ? "run" : "foreign run"} ${correlation.promptId}`;
}

/** Process-wide journal (mirrors the QueueMonitor singleton): `panel_run` opens
 *  tickets from the tool layer while the orchestrator's panel-event handler
 *  records and replays completions, with no ctx plumbing between them. */
export const RunCompletions = new RunCompletionJournalImpl();
