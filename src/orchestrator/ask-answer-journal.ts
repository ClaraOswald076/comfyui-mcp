// Durable-across-a-tool-timeout delivery of a VALIDATED panel_ask answer
// (issue #486).
//
// THE FAILURE. `panel_ask` renders a choice card and BLOCKS on the user's pick.
// The user's answer has exactly one delivery channel: the return value of the
// enclosing MCP `tools/call`. That call has its own budget (~300s) and its own
// lifetime — a turn that ends, a client that gives up, a session torn down — and
// when it dies the answer dies with it, in three distinct ways:
//
//   1. ANSWERED IN TIME, NOBODY LEFT TO RETURN TO. `bridge.send` resolves with a
//      validated pick, `askUserWithGrace` returns it, and the ToolResult is
//      written to a request the client already abandoned. Nothing recorded it.
//   2. ANSWERED DURING THE GRACE POLL. Same, one layer down: the poll TAKES the
//      answer out of the bridge's late-reply buffer (destroying it there) and
//      returns it into the same dead request.
//   3. ANSWERED AFTER THE GRACE. The handler has already returned "not answered
//      in time". The answer lands in the bridge's late-reply buffer keyed by
//      `ask_id` and NOBODY EVER POLLS IT AGAIN — it is TTL-pruned five minutes
//      later, unread.
//
// In every case the user answered, the answer validated, and the agent either
// asked again or proceeded without it. That is the whole of #486.
//
// THE CONTRACT HERE — deliberately the one #468/PR #786 arrived at for run
// completions (see run-completion-journal.ts), because this is the same problem
// class and the same traps are waiting:
//
//  • Asks are TICKETED by their `ask_id`, opened when the card is dispatched.
//  • Every answer is CORRELATED ONCE, AT ARRIVAL, by EXACT ask-id equality
//    against an open ticket — never by recency, never re-derived later. The
//    ticket's QUESTION FINGERPRINT is frozen onto the entry at that moment.
//  • An answer that cannot be correlated is still journaled and still delivered,
//    labelled UNDETERMINED. It is never swallowed, and it can never be presented
//    as the answer to a question it isn't provably an answer to.
//  • THE JOURNAL NEVER MERGES AND NEVER SUPPRESSES — IT ONLY EVER LABELS. Every
//    "already delivered" proof available here (tickets, entries, the bridge's own
//    5-minute buffer) is BOUNDED, so any rule that SUPPRESSES on one becomes a
//    silent LOSS the moment it expires at the wrong time. #468 removed
//    suppression outright after five successive fixes were each defeated one
//    bound away; nothing here reintroduces it.
//  • Undelivered answers are REPLAYED at the next delivery opportunity, and an
//    entry is cleared only when the turn that CARRIED it ended (or when a
//    matching re-ask provably took it as its result).
//
// THE CROSS-QUESTION GUARD is the one rule this file adds over #468's, and it is
// strictly the more important direction. Losing an answer costs a re-ask;
// MISATTRIBUTING one makes the agent act on a decision the user never made about
// the thing at hand. So a recovered answer may only ever satisfy an ask whose
// QUESTION FINGERPRINT (question text + option labels, in order + multi-select +
// header) is EXACTLY equal to the fingerprint frozen on the entry at arrival, on
// the SAME panel tab. There is deliberately no fuzzy match, no "closest
// question", and no "the only outstanding ask" fallback: an answer that doesn't
// match exactly is reported as an unattributed answer to ITS OWN question —
// quoted with that question, so it cannot be read as an answer to anything else.
//
// LOCAL trust domain: this is accidental-loss bookkeeping, not a defence against
// a hostile panel. Everything is in-memory and process-scoped.

import { createHash } from "node:crypto";
import { logger } from "../utils/logger.js";

/** How an answer relates to the asks this session dispatched. Computed ONCE, at
 *  arrival, and frozen onto the journal entry — a replay never re-correlates, so
 *  an answer can never drift onto a question that was asked after it landed. */
export type AskCorrelation =
  /** Exact ask-id match with a card THIS session dispatched. The entry also
   *  carries that ticket's frozen question fingerprint. */
  | { status: "matched"; askId: string }
  /** A validated answer whose ask id belongs to no card this session has a
   *  ticket for (its ticket aged out, or it came from somewhere else). Real, but
   *  NOT provably an answer to any question we asked — it must never satisfy
   *  one. */
  | { status: "foreign"; askId: string };

/** A `panel_ask` card that was dispatched and may still be answered. */
export interface AskTicket {
  askId: string;
  /** Panel tab the card was rendered on. Part of every match: an answer given on
   *  one tab is not an answer for another tab's agent. */
  tabId: string;
  /** Exact identity of the QUESTION — see askFingerprint(). */
  fingerprint: string;
  /** The question text, for honest wording when this answer is reported. */
  question: string;
  openedAt: number;
  /**
   * Generation of THIS ticket. Bumped whenever the same ask id is opened again,
   * so an answer can only ever settle the exact generation it was correlated
   * against (ask ids are UUIDs so this is defence in depth, mirroring
   * RunTicket.seq).
   */
  seq: number;
  /**
   * The `panel_ask` handler that opened this ticket is STILL RUNNING and will
   * itself consume the answer if one arrives. False once it has returned — which
   * is what makes an answer arriving afterwards provably ORPHANED (nobody is
   * left to hand it to) and therefore worth pushing to the agent on its own.
   */
  awaiting: boolean;
  /**
   * This ask id was opened MORE THAN ONCE, so it no longer identifies a single
   * question.
   *
   * Nothing on the wire distinguishes the first card's reply from the second's —
   * the panel sends only the id — so once an id is reused, ANY answer for it is
   * genuinely unattributable. It is therefore correlated as `foreign`
   * (UNDETERMINED) rather than confidently matched: without this, the first
   * card's late click would be frozen with the SECOND question's fingerprint and
   * could then be recovered as the answer to a question it was never shown for.
   * (`panel_ask` mints a fresh UUID per card, so this is defence in depth — but
   * it is the difference between "unreachable" and "impossible".)
   */
  reused?: boolean;
}

/** Where an entry is in the PUSH pipeline (the durable agent-event delivery used
 *  for answers that were never handed back to any tool result). */
export type AskDeliveryState =
  /** Not queued for a push. Either the handler took it as its own tool result,
   *  or the handler is still running and may yet. */
  | "none"
  /** Orphaned: waiting for a delivery attempt to the tab's agent. */
  | "pending"
  /** Handed to a live agent's queue; NOT proven read. */
  | "handed_off";

export interface AskEntry {
  token: string;
  askId: string;
  /** Panel tab this answer belongs to; also the agent-delivery address. */
  key: string;
  /** The question identity frozen at ARRIVAL (null when unattributable). The
   *  ONLY thing a recovery is allowed to match on. */
  fingerprint: string | null;
  /** The question text as asked (null when unattributable). */
  question: string | null;
  /** The user's answer, verbatim. */
  answer: string;
  answeredAt: number;
  correlation: AskCorrelation;
  /** Generation of the ticket this entry was matched against (0 = none). */
  ticketSeq: number;
  /**
   * The ask handler put this answer into a ToolResult. A HAND-OFF, NOT A PROOF:
   * the enclosing `tools/call` may already have been abandoned, which is exactly
   * the bug. It only means we must not ALSO push it to the agent as an orphan
   * (that would double-report every ordinary ask); the entry stays journaled so
   * a re-ask of the identical question can still recover it.
   */
  returned: boolean;
  delivery: AskDeliveryState;
  attempts: number;
  /** How many turns carried this answer and then ended without a provable ack. */
  carriedReleases?: number;
  /** Evicted-answer count this entry is carrying out on the tab's behalf, so the
   *  disclosure rides a real delivery instead of a side map that could be
   *  discarded before it is ever reported. */
  disclose?: number;
  /** This answer was already handed to the agent once (as a tool result or a
   *  push) and is being surfaced again. A LABEL, never a veto. */
  replayHint?: boolean;
}

/** Cards tracked at once. Generous: real sessions have one or two. */
const MAX_TICKETS = 64;
/** Ask ids whose CONVERSATION was replaced, remembered so a late click on the
 *  old card is not announced to the replacement one. Bounded — and safely so:
 *  forgetting one only means the answer is treated as an ordinary unattributable
 *  answer (journaled, labelled), never that it is dropped. */
const MAX_CONVERSATION_GONE_IDS = 1024;

/**
 * Prefix every `panel_ask` card's ask id carries.
 *
 * The bridge's late-answer sink is fed by EVERY `ask_user` card — the confirm
 * gate, the 18+ consent card, the secret prompt — and only `panel_ask` answers
 * belong in this journal. Ownership therefore has to be decidable from the id
 * ITSELF: an earlier draft answered it from a bounded set of remembered ids,
 * which meant an eviction turned a validated answer into nothing. A bounded
 * store must never be what protects against loss, so the test is syntactic and
 * cannot expire, evict, or be raced.
 */
export const PANEL_ASK_ID_PREFIX = "pa-";
/**
 * How long a ticket is kept. The bridge only forwards a LATE answer for a card
 * whose rid→ask_id mapping is still alive, so this must OUTLIVE that mapping's
 * own TTL (UiBridge.LATE_ASK_MAP_TTL_MS, 60 minutes) or a ticket could be gone
 * while an answer for it can still arrive. Sized above it, so pruning here is
 * provably lossless rather than a bound we are hoping never bites — and losing
 * one anyway only weakens a correlation to UNDETERMINED, never drops an answer.
 */
const TICKET_MAX_AGE_MS = 65 * 60_000;
/** Undelivered/unconsumed answers held per panel tab. */
const MAX_ENTRIES_PER_KEY = 16;
/** …and across all tabs. */
const MAX_ENTRIES_TOTAL = 48;
/**
 * How long a journaled answer may still be RECOVERED as the result of a re-ask
 * of the identical question.
 *
 * This bound is a LABEL boundary, not a suppression: past it the answer is not
 * returned as "the user's answer to the question you just asked" (it is stale
 * enough that the user plausibly meant it for the earlier moment), but it is
 * still DISCLOSED, quoted with its own question, so it is never silently
 * discarded.
 */
const RECOVER_MAX_AGE_MS = 10 * 60_000;
/** Turns that may carry a pushed answer and end without a provable ack before we
 *  settle it anyway. Same rationale as MAX_CARRIED_RELEASES in #468: each of
 *  those put the text into a turn the agent read, so settling risks a duplicate,
 *  never a loss. */
const MAX_CARRIED_RELEASES = 3;
/** Tabs whose evicted-answer counter is retained. */
const MAX_DROPPED_KEYS = 64;

/**
 * EXACT identity of a question, and the whole of the cross-question guard.
 *
 * EVERYTHING THE USER READS ON THE CARD GOES IN, in order: the question text,
 * the header chip, the multi-select flag, and every option's LABEL **and
 * DESCRIPTION**. Two asks are "the same question" only when a user looking at
 * both cards would see the same thing.
 *
 * The descriptions are not decoration: they are the one-line explanations the
 * user reads to decide, so "euler / fast, lower quality" and "euler / now the
 * recommended default" are different decisions wearing the same label. Leaving
 * them out would let a re-worded card recover an answer the user gave to
 * different information. The guard errs strict in every direction: a stricter
 * fingerprint costs at most a re-ask, a looser one lets an answer satisfy a
 * question it was not given for.
 *
 * Deliberately NOT included: the tab id (an entry carries its tab separately, so
 * a tab-id migration re-keys it without invalidating every fingerprint) and any
 * timestamp.
 *
 * Whitespace is trimmed and internal runs collapsed on the text fields only,
 * because a re-ask is often the model re-emitting the same prompt with different
 * wrapping. Nothing else is normalized: case, punctuation and ordering are all
 * significant, so "Delete the file?" never matches "delete the file".
 */
export function askFingerprint(ask: {
  question: string;
  options?: unknown;
  header?: unknown;
  multi_select?: unknown;
}): string {
  const norm = (s: string): string => s.replace(/\s+/g, " ").trim();
  const labels = Array.isArray(ask.options)
    ? ask.options.map((o) => {
        const opt = o as { label?: unknown; description?: unknown } | null;
        if (typeof opt?.label !== "string") return JSON.stringify(o ?? null);
        // Label AND description — an option is the whole thing the user reads.
        return JSON.stringify([
          norm(opt.label),
          typeof opt.description === "string" ? norm(opt.description) : "",
        ]);
      })
    : [];
  // JSON.stringify is the delimiter: it escapes the payload itself, so no
  // separator character can ever be smuggled in by a question or an option label
  // to make two DIFFERENT questions hash the same. (And it keeps this file pure
  // ASCII — no control bytes, no exotic separators.)
  const parts = [
    norm(ask.question ?? ""),
    typeof ask.header === "string" ? norm(ask.header) : "",
    ask.multi_select === true ? "multi" : "single",
    ...labels,
  ];
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32);
}

/** Coerce a bridge reply into the answer text the user actually gave. Panel
 *  ask cards reply with a string; anything else is preserved verbatim as JSON so
 *  nothing the user chose is ever silently reshaped away. */
export function answerText(reply: unknown): string {
  if (typeof reply === "string") return reply;
  try {
    return JSON.stringify(reply);
  } catch {
    return String(reply);
  }
}

/** Why a recovery attempt produced no answer. NEVER collapsed into a single
 *  falsy value: "this tab has no answer to this question" and "an answer existed
 *  but could not be attributed / had been evicted" are different facts and the
 *  caller reports them differently (#796). */
export type AskRecovery =
  /** An answer to the IDENTICAL question, on this tab, within the window. */
  | { status: "recovered"; entry: AskEntry }
  /** Nothing journaled for this tab at all — a plain unanswered card. */
  | { status: "none" }
  /**
   * Answers exist for this tab but NONE of them is provably an answer to THIS
   * question (a different question, or too old to present as fresh). They are
   * handed back so the caller can disclose them, quoted with their own question.
   */
  | { status: "unattributed"; others: AskEntry[] };

export class AskAnswerJournalImpl {
  /** ask id → ticket. Ask ids are UUIDs, so exact equality is proof of identity. */
  private tickets = new Map<string, AskTicket>();
  /**
   * Ask ids this journal has EVER opened, kept long after their ticket is gone.
   *
   * This is what `tracks()` answers on, and it exists because the ticket map is
   * bounded: if "is this one of ours?" were answered from the tickets alone, an
   * eviction would make the bridge's late-answer sink DROP a validated answer
   * outright — a bounded store silently protecting against a bounded store,
   * which is the exact shape of every defect #468 kept re-growing. Losing a
   * ticket may only ever WEAKEN a correlation (matched → foreign, i.e.
   * UNDETERMINED); it must never turn an answer into nothing.
   */
  /**
   * Ask ids whose CONVERSATION was replaced (New chat / resume of a historical
   * session) while their card was still on screen.
   *
   * An answer that arrives for one of these is real and is journaled, but it is
   * addressed to a conversation that no longer exists, so it is never announced
   * to the replacement one — see closeAsks() for why this differs from #468's
   * treatment of run completions.
   */
  private conversationGone = new Set<string>();
  /** token → entry (insertion-ordered, which is also delivery order). */
  private entries = new Map<string, AskEntry>();
  /** Answers this tab lost to an eviction and has not yet been told about. */
  private dropped = new Map<string, number>();
  private seq = 0;
  private ticketSeq = 0;
  /** Deliver a tab's newly-orphaned answers (see setFlusher). */
  private flush: ((key: string) => void) | null = null;

  /**
   * Wire the push channel (#486).
   *
   * An answer becomes an ORPHAN at moments the tool layer cannot act on — the
   * bridge's late-answer sink, or an ask handler unwinding on an error without
   * having returned one. Whoever owns the agents registers here so those
   * transitions deliver immediately instead of waiting for some unrelated later
   * trigger (which is how "journaled" quietly becomes "never delivered").
   */
  setFlusher(flush: (key: string) => void): void {
    this.flush = flush;
  }

  /**
   * A `panel_ask` card is being dispatched. Opens the ticket that makes any
   * answer for `askId` attributable to THIS question.
   *
   * Must be called BEFORE the card is sent: the answer can come back on the
   * bridge's late-reply sink at any moment after that, and an answer that
   * arrives with no ticket is (correctly, but uselessly) foreign.
   */
  openAsk(askId: string, meta: { tabId: string; fingerprint: string; question: string }): void {
    this.pruneTickets();
    const existing = this.tickets.get(askId);
    if (existing) {
      // The same ask id dispatched AGAIN. Reopen rather than stack a second
      // ticket (one ask id always means one ticket) — but the id now stands for
      // MORE THAN ONE question, and the panel's reply carries only the id, so
      // nothing can ever say which card an answer for it came from. Mark it
      // reused: every answer for it is reported UNDETERMINED from here on, and
      // in particular the older card's late click can no longer be frozen with
      // the newer question's fingerprint and recovered as its answer.
      existing.tabId = meta.tabId;
      existing.fingerprint = meta.fingerprint;
      existing.question = meta.question;
      existing.openedAt = Date.now();
      existing.seq = ++this.ticketSeq;
      existing.awaiting = true;
      existing.reused = true;
      logger.warn(
        `[ask-answers] ask id ${askId.slice(0, 12)} was opened again — it no longer identifies one question, so every answer for it is reported as UNDETERMINED`,
      );
      return;
    }
    this.tickets.set(askId, {
      askId,
      tabId: meta.tabId,
      fingerprint: meta.fingerprint,
      question: meta.question,
      openedAt: Date.now(),
      seq: ++this.ticketSeq,
      awaiting: true,
    });
    this.trimTickets();
  }

  /** Does this journal know the ask id — i.e. is a late answer for it one of
   *  OURS? The bridge's late-answer sink is fed by every `ask_user` card
   *  (confirm/consent/secret gates included) and only `panel_ask` answers belong
   *  here; those other cards have their own, deliberately non-recoverable paths
   *  (a recovered "Yes, go ahead" must never authorise a different destructive
   *  operation). */
  tracks(askId: string): boolean {
    return askId.startsWith(PANEL_ASK_ID_PREFIX);
  }

  /**
   * The `panel_ask` handler that opened `askId` has RETURNED. Anything that
   * arrives from here on has nobody to be handed to, so it is orphaned on
   * arrival and pushed to the agent on its own.
   *
   * If an answer is already journaled and the handler never claimed it
   * (`markReturned` was not called), arm it for the push now.
   */
  closeAsk(askId: string): AskEntry | null {
    const ticket = this.tickets.get(askId);
    if (ticket) ticket.awaiting = false;
    let armed: AskEntry | null = null;
    for (const entry of this.entries.values()) {
      if (entry.askId !== askId) continue;
      if (!entry.returned && entry.delivery === "none") {
        entry.delivery = "pending";
        armed = entry;
      }
    }
    // It is an orphan NOW — deliver it now. Leaving it merely `pending` would
    // make it wait for an unrelated later flush, and this transition happens on
    // the ask handler's unwind, where there may never be one.
    if (armed) this.flush?.(armed.key);
    return armed;
  }

  /**
   * Journal a validated answer. Correlation is computed HERE, once, by exact ask
   * id.
   *
   * Idempotent per ask id: the same card can be observed twice (the handler's
   * grace poll takes it out of the bridge buffer while the bridge's sink has
   * already forwarded it), and both observations are the SAME answer to the SAME
   * question. Collapsing them is identity, not suppression — nothing is ever
   * dropped because it "looks like" something already seen.
   */
  record(askId: string, reply: unknown, meta: { tabId: string }): AskEntry {
    this.pruneTickets();
    const existing = [...this.entries.values()].find((e) => e.askId === askId);
    if (existing) return existing;
    const ticket = this.tickets.get(askId);
    // A REUSED id proves nothing: the panel sends only the id, so an answer for
    // it could belong to either card. Report it as foreign — real, but
    // UNDETERMINED — rather than claiming it answers the question now open.
    const attributable = ticket !== undefined && ticket.reused !== true;
    const correlation: AskCorrelation = attributable
      ? { status: "matched", askId }
      : { status: "foreign", askId };
    const entry: AskEntry = {
      token: `aa${++this.seq}`,
      askId,
      // The TICKET's tab is authoritative when we have one (that is the tab the
      // card was rendered on); otherwise the tab the reply physically arrived
      // from, so an unattributable answer is still addressed somewhere real
      // instead of being dropped for want of a key.
      key: ticket?.tabId ?? meta.tabId,
      // The fingerprint is the LICENCE to satisfy a re-ask, so a reused id gets
      // none — its answer may only ever be reported, never returned as an answer.
      // The question TEXT is still carried: it is what makes that report honest.
      fingerprint: attributable ? ticket.fingerprint : null,
      question: ticket?.question ?? null,
      answer: answerText(reply),
      answeredAt: Date.now(),
      correlation,
      ticketSeq: ticket?.seq ?? 0,
      returned: false,
      // An answer that lands while its own handler is still running is that
      // handler's to return; one that lands afterwards (or with no ticket at
      // all) has nobody left and is armed for the push immediately. An answer to
      // a card whose CONVERSATION was replaced is never pushed at all — see
      // closeAsks(); it is journaled for disclosure only.
      delivery:
        ticket?.awaiting === true || this.conversationGone.has(askId) ? "none" : "pending",
      attempts: 0,
    };
    this.entries.set(entry.token, entry);
    if (this.conversationGone.has(askId)) {
      logger.warn(
        `[ask-answers] an answer arrived for a card whose conversation was replaced (ask ${askId.slice(0, 8)}, tab ${entry.key.slice(0, 8)}): "${entry.answer}" — journaled for disclosure, NOT announced to the replacement conversation`,
      );
    } else if (!attributable) {
      logger.warn(
        `[ask-answers] a validated answer arrived for ask ${askId.slice(0, 8)} with ${ticket ? "a REUSED (ambiguous) ticket" : "no open ticket"} — journaled as UNATTRIBUTED; it can never satisfy a question, only be reported`,
      );
    }
    this.trimEntries(entry.key);
    // Born orphaned (no handler is waiting on this ask) — push it straight away.
    if (entry.delivery === "pending") this.flush?.(entry.key);
    return entry;
  }

  /** The ask handler put this answer into its ToolResult. A hand-off, not proof
   *  of consumption — see AskEntry.returned. */
  markReturned(askId: string): void {
    for (const entry of this.entries.values()) {
      if (entry.askId !== askId) continue;
      entry.returned = true;
      // It reached A caller. Do not ALSO push it as an orphan; a re-ask can
      // still recover it if that caller was already dead.
      //
      // DEFENCE IN DEPTH, not a live path: an ask handler only marks an answer
      // returned while its own ticket is still `awaiting`, and `record` never
      // arms one in that state — so nothing reachable enters this branch and no
      // test can fail on it. It is here because "a caller took this" and
      // "announce it to the agent as unclaimed" are contradictory states, and a
      // future caller marking an answer returned from outside the ask handler
      // would otherwise double-report it.
      if (entry.delivery === "pending") entry.delivery = "none";
    }
  }

  /**
   * Find the answer the user already gave to THIS EXACT question on THIS tab.
   *
   * The match is exact fingerprint equality and nothing else — see the
   * cross-question guard at the top of this file. When several qualify the
   * NEWEST wins: it is the user's most recent statement of intent about that
   * question.
   *
   * Returns a discriminated result: "no answer at all" and "answers exist but
   * none is provably for this question" are DIFFERENT facts and must not be
   * folded into one falsy value (#796).
   *
   * The CURRENT ask's own id is deliberately NOT excluded: an answer that landed
   * for the very card we just gave up on is the most direct answer there is, and
   * excluding it would re-open the race the grace poll cannot close (the sink
   * journals an answer microseconds after the last poll).
   */
  recover(key: string, fingerprint: string): AskRecovery {
    const now = Date.now();
    const mine = [...this.entries.values()].filter((e) => e.key === key);
    if (mine.length === 0) return { status: "none" };
    const eligible = mine
      .filter(
        (e) =>
          e.correlation.status === "matched" &&
          e.fingerprint !== null &&
          e.fingerprint === fingerprint &&
          now - e.answeredAt <= RECOVER_MAX_AGE_MS,
      )
      .sort((a, b) => b.answeredAt - a.answeredAt);
    if (eligible.length > 0) return { status: "recovered", entry: eligible[0] };
    return { status: "unattributed", others: mine };
  }

  /**
   * A recovery (or a push the agent provably consumed) took this answer. Drop
   * it so the same answer can never be handed over twice.
   *
   * Deleting an entry that was already pushed and is sitting unread in an
   * agent's queue is deliberate: the tool result the caller is about to return
   * carries the SAME answer with the SAME question attached, so the worst case
   * is the agent reading it twice — never acting on an answer it wasn't given.
   *
   * Any eviction disclosure the entry was CARRYING is handed back to the tab
   * first. The disclosure is a debt owed to the tab, not a property of whichever
   * entry happens to be carrying it: consuming the carrier without re-homing it
   * would let an eviction that the journal promised to report disappear because
   * an unrelated answer was recovered.
   */
  consume(token: string): void {
    const entry = this.entries.get(token);
    if (!entry) return;
    this.entries.delete(token);
    if (entry.disclose) this.noteDropped(entry.key, entry.disclose);
  }

  /** Every unconsumed ORPHAN answer for a tab — those that were never handed
   *  back to any tool result. These are what a failing ask discloses, so a
   *  validated answer is never silently dropped. */
  orphansFor(key: string): AskEntry[] {
    return [...this.entries.values()].filter((e) => e.key === key && !e.returned);
  }

  /**
   * Take the eviction debt that has NO other carrier — the count parked in the
   * side map because this tab had no pending entry to stamp it onto, i.e. no
   * push is coming to disclose it. The ask path reports it instead.
   *
   * Debt riding on an ENTRY is deliberately left alone: that copy goes out with
   * a real delivery and is cleared only when the turn carrying it ends, so
   * taking it here could drop a disclosure that push still owes.
   *
   * Reporting into a ToolResult is a hand-off, not a proof, so this can still be
   * lost with an abandoned call — but the eviction itself was already logged at
   * ERROR, and repeating the warning on every subsequent ask forever is worse
   * than reporting it once at the first opportunity.
   */
  takeDropped(key: string): number {
    const owed = this.dropped.get(key) ?? 0;
    this.dropped.delete(key);
    return owed;
  }

  /** Answers this tab lost to an eviction and has not yet been told about. */
  droppedFor(key: string): number {
    const carried = [...this.entries.values()]
      .filter((e) => e.key === key)
      .reduce((n, e) => n + (e.disclose ?? 0), 0);
    return carried + (this.dropped.get(key) ?? 0);
  }

  /** Entries awaiting a push attempt for this key, in arrival order. */
  pending(key: string): AskEntry[] {
    const out: AskEntry[] = [];
    for (const entry of this.entries.values()) {
      if (entry.key === key && entry.delivery === "pending") out.push(entry);
    }
    return out;
  }

  /**
   * Push every orphaned answer for `key` to the tab's agent, in ARRIVAL order,
   * stopping at the first refusal so a newer answer never overtakes an older one
   * that is still stuck.
   *
   * `inject` returns whether the agent TOOK the payload onto its queue — not
   * that it was read. The entry stays journaled either way; only `ack` (the turn
   * that carried it ended) removes it. That is the durability property: hand it
   * to an agent that then dies and it comes back here.
   *
   * NOTHING is re-correlated. The verdict and the question were frozen at
   * arrival, so a replay can never be re-attributed to a question asked later.
   */
  deliverPending(
    key: string,
    inject: (payload: AskAnswerEvent, token: string) => boolean,
  ): { delivered: number; blockedOn: AskEntry | null } {
    let delivered = 0;
    for (const entry of this.pending(key)) {
      const lost = (entry.disclose ?? 0) + (this.dropped.get(key) ?? 0);
      const payload: AskAnswerEvent = {
        kind: "ask_answer",
        ask_question: entry.question,
        ask_answer: entry.answer,
        ask_correlation: entry.correlation.status,
        ask_answered_at: entry.answeredAt,
        ...(entry.attempts > 0 ? { replayed: true } : {}),
        ...(entry.replayHint ? { possible_repeat: true } : {}),
        ...(lost > 0 ? { dropped_answers: lost } : {}),
      };
      const handedOff = inject(payload, entry.token);
      entry.attempts += 1;
      entry.delivery = handedOff ? "handed_off" : "pending";
      if (!handedOff) return { delivered, blockedOn: entry };
      if (lost > 0) {
        // CONSOLIDATE onto the entry; the disclosure is NOT spent by a hand-off.
        // If this agent dies before its turn runs, the entry is released and
        // replayed, and the warning must go with it. Only ack() clears it.
        entry.disclose = lost;
        this.dropped.delete(key);
      }
      delivered += 1;
    }
    return { delivered, blockedOn: null };
  }

  /** The turn that CARRIED this answer ended — it genuinely reached the agent. */
  ack(token: string): void {
    const entry = this.entries.get(token);
    if (!entry) return;
    // The push is done, but the ANSWER stays journaled while it is still within
    // the recovery window: a re-ask of the identical question must still be able
    // to return it as its result rather than making the user answer twice. It is
    // flagged so any later surfacing reads as "you have seen this".
    delete entry.disclose;
    entry.delivery = "none";
    entry.returned = true;
    entry.replayHint = true;
  }

  /**
   * An agent gave a push back undelivered. Re-arm it for replay.
   *
   * `carried` distinguishes the two causes, and ONLY the first is bounded:
   *  • carried: true  — a turn actually DISPATCHED with this answer in it and
   *    then ended, but its result could not be proven to be that turn's own. The
   *    agent read the text; after MAX_CARRIED_RELEASES we settle rather than
   *    loop (a duplicate at worst).
   *  • carried: false — a teardown handed it back (agent stopped, session died).
   *    NOBODY read it. These must never count toward the bound.
   */
  release(token: string, opts: { carried?: boolean } = {}): void {
    const entry = this.entries.get(token);
    if (!entry) return;
    if (opts.carried) {
      entry.carriedReleases = (entry.carriedReleases ?? 0) + 1;
      if (entry.carriedReleases >= MAX_CARRIED_RELEASES) {
        logger.warn(
          `[ask-answers] an answer was carried by ${entry.carriedReleases} turns that ended without a provable ack — settling it instead of replaying again`,
        );
        this.ack(token);
        return;
      }
    }
    entry.delivery = "pending";
  }

  /** Is ANY orphaned answer still awaiting a push? The orchestrator's
   *  self-restart gate reads this: the journal is in-memory, so restarting while
   *  one is outstanding silently drops an answer the user actually gave. */
  hasOutstanding(): boolean {
    // The eviction DEBT counts too. It is a promise to tell the agent that an
    // answer was lost, and it is destroyed by a teardown exactly as an entry is —
    // tearing down while one is owed turns a disclosed loss back into a silent
    // one, which is the whole thing this journal exists to prevent.
    if (this.dropped.size > 0) return true;
    return [...this.entries.values()].some(
      (e) => e.delivery !== "none" || (e.disclose ?? 0) > 0,
    );
  }

  /**
   * Everything the last-ditch, we-are-about-to-die disclosure must name.
   *
   * Broader than `hasOutstanding` on purpose. A restart is a CHOICE we can defer,
   * so it waits only on what is still deliverable; a fatal exit is not, so it
   * reports everything a validated answer might still have been needed for:
   *  • answers awaiting a push (nobody has them);
   *  • answers that went into a ToolResult RECENTLY — "returned" is a hand-off,
   *    not a receipt (that IS #486), and inside the recovery window a re-ask was
   *    still able to produce it. Deferring restarts on these would stall the
   *    self-restarter after every single ask; SAYING so on the way out costs
   *    nothing and keeps the loss from being silent.
   */
  allOutstanding(): AskEntry[] {
    const now = Date.now();
    return [...this.entries.values()].filter(
      (e) =>
        e.delivery !== "none" ||
        (e.disclose ?? 0) > 0 ||
        now - e.answeredAt <= RECOVER_MAX_AGE_MS,
    );
  }

  /** Tabs still owed an eviction disclosure, with the count — so a fatal exit can
   *  name a loss whose carrier is only a counter. */
  outstandingDebt(): Array<{ key: string; count: number }> {
    const byTab = new Map<string, number>();
    for (const [key, n] of this.dropped) byTab.set(key, (byTab.get(key) ?? 0) + n);
    for (const e of this.entries.values()) {
      if ((e.disclose ?? 0) > 0) byTab.set(e.key, (byTab.get(e.key) ?? 0) + e.disclose!);
    }
    return [...byTab].map(([key, count]) => ({ key, count }));
  }

  /** Move every entry AND every open ticket from `from` onto `to` — a panel
   *  tab-id migration re-keys the agent and both must move with it, or an answer
   *  for a card dispatched under the old id becomes unattributable. */
  moveKey(from: string, to: string): void {
    if (from === to) return;
    for (const entry of this.entries.values()) {
      if (entry.key === from) entry.key = to;
    }
    for (const ticket of this.tickets.values()) {
      if (ticket.tabId === from) ticket.tabId = to;
    }
    const lost = this.dropped.get(from);
    if (lost !== undefined) {
      this.dropped.delete(from);
      this.dropped.set(to, (this.dropped.get(to) ?? 0) + lost);
    }
  }

  /** Drop everything belonging to a tab that will never come back. Logs every
   *  answer that dies unconsumed; a loss must never be silent. */
  forget(key: string): void {
    for (const [token, entry] of [...this.entries]) {
      if (entry.key !== key) continue;
      this.entries.delete(token);
      // EVERY answer is logged, returned ones included: "it went into a
      // ToolResult" is not proof it was received, so a returned answer inside
      // the recovery window is still the only copy of a decision that may never
      // have reached the model.
      logger.warn(
        `[ask-answers] dropping a validated answer ("${entry.answer}") to "${preview(entry.question)}" — its tab (${key.slice(0, 8)}) is gone${entry.returned ? " (it had been handed to a tool result, which is not proof it was received)" : ""}`,
      );
    }
    for (const [id, ticket] of [...this.tickets]) {
      if (ticket.tabId !== key) continue;
      this.tickets.delete(id);
      // Its card may still be on screen. There is no agent left at this tab id,
      // so a late answer must not be armed for a push that can only fail (and
      // would sit pending until an eviction) — journal it for disclosure only,
      // exactly as for a replaced conversation.
      this.conversationGone.add(id);
    }
    const owed = this.dropped.get(key) ?? 0;
    if (owed > 0) {
      logger.error(
        `[ask-answers] tab ${key.slice(0, 8)} is gone still owed a disclosure for ${owed} evicted answer(s) — it will never be told`,
      );
    }
    this.dropped.delete(key);
  }

  /**
   * The CONVERSATION that asked this tab's questions is gone — New chat, or a
   * switch to a historical session.
   *
   * Drop the tab's TICKETS and DOWNGRADE its journaled answers to `foreign`, so
   * an answer given to the old conversation's question can never be returned to
   * the replacement agent as "the answer to the question YOU just asked". The
   * answers themselves are kept and still delivered — labelled UNDETERMINED,
   * quoted with their own question. A correlation may only ever get WEAKER.
   */
  closeAsks(key: string): void {
    for (const [id, ticket] of [...this.tickets]) {
      if (ticket.tabId !== key) continue;
      this.tickets.delete(id);
      // The CARD IS STILL ON SCREEN. The user can click it minutes from now, and
      // the bridge will happily deliver that answer — to a conversation that no
      // longer exists. Remember the id so `record` recognises it as belonging to
      // the retired conversation instead of treating it as an ordinary
      // unattributable answer and announcing it to the replacement agent.
      this.conversationGone.add(id);
    }
    while (this.conversationGone.size > MAX_CONVERSATION_GONE_IDS) {
      const oldest = this.conversationGone.values().next().value;
      if (oldest === undefined) break;
      this.conversationGone.delete(oldest);
    }
    for (const entry of this.entries.values()) {
      if (entry.key !== key) continue;
      if (entry.correlation.status === "matched") {
        entry.correlation = { status: "foreign", askId: entry.correlation.askId };
        // Its fingerprint was the licence to satisfy a matching re-ask; the
        // conversation that asked is gone, so revoke it. The QUESTION TEXT stays —
        // it is what makes the disclosure honest.
        entry.fingerprint = null;
      }
      // …and STOP PUSHING it. Its addressee is gone.
      //
      // This is where an ask answer parts company with a run completion (#468),
      // which is still delivered to the replacement conversation downgraded. A
      // completion's payload is independently useful — the images are on the
      // user's canvas either way. An answer to a question the replacement
      // conversation never asked is useful to nobody: pushing it injects an
      // unsolicited turn about a decision the new conversation has no context
      // for, which is a cross-conversation confusion with no upside.
      //
      // NOT a silent discard: the entry stays journaled (so a later ask on this
      // tab that times out still reports it as UNATTRIBUTED, quoted with its own
      // question) and the loss of the push is logged here.
      if (entry.delivery === "pending") {
        entry.delivery = "none";
        logger.warn(
          `[ask-answers] the conversation that asked "${preview(entry.question)}" on tab ${key.slice(0, 8)} was replaced — the user's answer ("${entry.answer}") will NOT be announced to the replacement conversation; it is kept only for disclosure`,
        );
      }
    }
  }

  /** Test/diagnostic helpers. */
  ticketFor(askId: string): AskTicket | undefined {
    return this.tickets.get(askId);
  }
  entriesFor(key: string): AskEntry[] {
    return [...this.entries.values()].filter((e) => e.key === key);
  }
  reset(): void {
    // NOTE: the flusher is deliberately NOT cleared — it belongs to the process's
    // orchestrator, not to any one test's fixture.
    this.tickets.clear();
    this.conversationGone.clear();
    this.entries.clear();
    this.dropped.clear();
    this.seq = 0;
    this.ticketSeq = 0;
  }

  /** Tickets whose card can no longer receive an answer (see TICKET_MAX_AGE_MS)
   *  and which no handler is still waiting on. */
  private pruneTickets(): void {
    const now = Date.now();
    for (const [id, t] of [...this.tickets]) {
      if (!t.awaiting && now - t.openedAt > TICKET_MAX_AGE_MS) this.tickets.delete(id);
    }
  }

  private trimTickets(): void {
    while (this.tickets.size > MAX_TICKETS) {
      // Prefer a ticket no handler is waiting on; otherwise the oldest. Losing a
      // ticket does not lose an answer — it makes a later answer for it read as
      // UNATTRIBUTED, which is the honest verdict once we have forgotten the
      // question — but say so, because it is a real degradation.
      let victim: string | null = null;
      for (const [id, t] of this.tickets) {
        if (!t.awaiting) {
          victim = id;
          break;
        }
      }
      if (!victim) victim = this.tickets.keys().next().value ?? null;
      if (!victim) return;
      logger.error(
        `[ask-answers] over ${MAX_TICKETS} question cards are tracked at once — forgetting ask ${victim.slice(0, 8)}; a late answer for it will be reported as UNATTRIBUTED`,
      );
      this.tickets.delete(victim);
    }
  }


  /**
   * Record that an answer for `key` was destroyed by an eviction, so the next
   * delivery to that tab can report it as UNDETERMINED. Stamped onto a surviving
   * PENDING entry when there is one — it then rides out on a real delivery and
   * cannot be discarded.
   */
  private noteDropped(key: string, count = 1): void {
    if (count <= 0) return;
    const carrier = [...this.entries.values()].find(
      (e) => e.key === key && e.delivery === "pending",
    );
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
        `[ask-answers] discarding the undelivered-answer count (${lost}) for tab ${victim.slice(0, 8)} — over ${MAX_DROPPED_KEYS} tabs are tracking one; that tab will not be told`,
      );
    }
  }

  /**
   * Enforce the per-tab and global ceilings.
   *
   * EVICTION ORDER matters and is the same judgement #468 makes: an answer that
   * was already RETURNED to a tool result has reached a caller, so forgetting it
   * costs at most a re-ask; an ORPHANED one has reached nobody, so evicting it
   * is a real loss — those go last, are logged at ERROR, and are COUNTED so the
   * next delivery tells the agent those answers are UNDETERMINED.
   */
  private trimEntries(key: string): void {
    const evict = (scope: (e: AskEntry) => boolean, limit: number, label: string): void => {
      let mine = [...this.entries.values()].filter(scope);
      while (mine.length > limit) {
        const victim = mine.find((e) => e.returned) ?? mine[0];
        this.entries.delete(victim.token);
        mine = mine.filter((e) => e !== victim);
        if (victim.returned) {
          // Logged, not counted as a loss for the agent: it DID reach a caller,
          // and counting every ordinary successful ask as an undetermined
          // dropped answer would cry wolf on every tab that asks a lot — the
          // warning would stop meaning anything, which is its own kind of
          // silence. The record is here, with the answer text, so a real loss is
          // still reconstructable.
          logger.warn(
            `[ask-answers] ${label} — forgetting an already-returned answer ("${victim.answer}") to "${preview(victim.question)}"; a re-ask can no longer recover it, and a tool result is not proof it was received`,
          );
          continue;
        }
        this.noteDropped(victim.key, 1 + (victim.disclose ?? 0));
        logger.error(
          `[ask-answers] ${label} — dropped a VALIDATED answer to "${preview(victim.question)}" that had reached nobody; the next delivery will report it as undetermined`,
        );
      }
    };
    if (key) {
      evict(
        (e) => e.key === key,
        MAX_ENTRIES_PER_KEY,
        `journal for tab ${key.slice(0, 8)} exceeded ${MAX_ENTRIES_PER_KEY} answers`,
      );
    }
    evict(() => true, MAX_ENTRIES_TOTAL, `journal exceeded ${MAX_ENTRIES_TOTAL} answers overall`);
  }
}

/** The agent-event payload a pushed (orphaned) answer becomes. */
export interface AskAnswerEvent {
  kind: "ask_answer";
  ask_question: string | null;
  ask_answer: string;
  ask_correlation: "matched" | "foreign";
  ask_answered_at: number;
  replayed?: boolean;
  possible_repeat?: boolean;
  dropped_answers?: number;
}

/** Short, log-safe rendering of a question. */
export function preview(question: string | null): string {
  if (!question) return "(an unattributed question)";
  const one = question.replace(/\s+/g, " ").trim();
  return one.length > 60 ? `${one.slice(0, 57)}…` : one;
}

/** How long a recovered answer may be presented as the result of a re-ask. */
export const ASK_RECOVER_MAX_AGE_MS = RECOVER_MAX_AGE_MS;

/** Process-wide journal (mirrors the RunCompletions singleton): the panel_ask
 *  tool opens tickets and consumes recoveries from the tool layer, while the
 *  orchestrator's bridge sink records late answers and pushes the orphans, with
 *  no ctx plumbing between them. */
export const AskAnswers = new AskAnswerJournalImpl();
