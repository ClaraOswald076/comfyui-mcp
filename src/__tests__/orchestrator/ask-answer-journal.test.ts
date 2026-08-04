import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  AskAnswers,
  askFingerprint,
  ASK_RECOVER_MAX_AGE_MS,
  type AskAnswerEvent,
} from "../../orchestrator/ask-answer-journal.js";

// #486 — a VALIDATED panel_ask answer must survive the tool call that asked for
// it, and a recovered answer must never satisfy a different question.
//
// The journal is the durable half of that: it correlates an answer to its
// question ONCE, at arrival, replays what could not be delivered, and NEVER
// suppresses. These tests hold both directions: nothing the user answered is
// lost, and nothing they answered is presented as the answer to something else.

const TAB = "tab-aaaa1111";
const OTHER_TAB = "tab-bbbb2222";

const SAMPLER = {
  question: "Which sampler should I use?",
  options: [{ label: "euler" }, { label: "dpmpp_2m" }],
};
const SCHEDULER = {
  question: "Which scheduler should I use?",
  options: [{ label: "karras" }, { label: "normal" }],
};

function openAndAnswer(
  askId: string,
  ask: { question: string; options: unknown; header?: unknown; multi_select?: unknown },
  answer: string,
  opts: { tabId?: string; awaiting?: boolean } = {},
): void {
  const tabId = opts.tabId ?? TAB;
  AskAnswers.openAsk(askId, { tabId, fingerprint: askFingerprint(ask), question: ask.question });
  // The asking handler has already unwound (the tools/call died) unless the test
  // says otherwise — that is the #486 scenario.
  if (opts.awaiting !== true) AskAnswers.closeAsk(askId);
  AskAnswers.record(askId, answer, { tabId });
}

beforeEach(() => {
  AskAnswers.reset();
  AskAnswers.setFlusher(() => {});
});

describe("ask-answer journal — an answer survives its tool call (#486)", () => {
  it("journals an answer that arrives with NO handler waiting, and arms it for delivery", () => {
    openAndAnswer("ask-1", SAMPLER, "dpmpp_2m");
    const entries = AskAnswers.entriesFor(TAB);
    expect(entries).toHaveLength(1);
    expect(entries[0].answer).toBe("dpmpp_2m");
    expect(entries[0].correlation.status).toBe("matched");
    // Nobody received it, so it is an ORPHAN queued for the durable push.
    expect(entries[0].delivery).toBe("pending");
    expect(AskAnswers.hasOutstanding()).toBe(true);
  });

  it("recovers it for a re-ask of the IDENTICAL question", () => {
    openAndAnswer("ask-1", SAMPLER, "dpmpp_2m");
    const rec = AskAnswers.recover(TAB, askFingerprint(SAMPLER));
    expect(rec.status).toBe("recovered");
    if (rec.status !== "recovered") return;
    expect(rec.entry.answer).toBe("dpmpp_2m");
    expect(rec.entry.question).toBe(SAMPLER.question);
  });

  it("hands the SAME answer over only once", () => {
    openAndAnswer("ask-1", SAMPLER, "dpmpp_2m");
    const first = AskAnswers.recover(TAB, askFingerprint(SAMPLER));
    expect(first.status).toBe("recovered");
    if (first.status !== "recovered") return;
    AskAnswers.consume(first.entry.token);
    expect(AskAnswers.recover(TAB, askFingerprint(SAMPLER)).status).toBe("none");
  });

  it("an answer handed to a tool result is NOT pushed, but is still recoverable", () => {
    // The ordinary success path: the handler got the answer and returned it. It
    // may have gone into a dead request (unobservable), so it stays journaled —
    // but it must not ALSO be announced to the agent, or every ask would double.
    AskAnswers.openAsk("ask-1", {
      tabId: TAB,
      fingerprint: askFingerprint(SAMPLER),
      question: SAMPLER.question,
    });
    AskAnswers.record("ask-1", "euler", { tabId: TAB });
    AskAnswers.markReturned("ask-1");
    AskAnswers.closeAsk("ask-1");
    expect(AskAnswers.hasOutstanding()).toBe(false);
    expect(AskAnswers.orphansFor(TAB)).toHaveLength(0);
    expect(AskAnswers.recover(TAB, askFingerprint(SAMPLER)).status).toBe("recovered");
  });
});

describe("ask-answer journal — cross-question misattribution guard (#486)", () => {
  it("a journaled answer NEVER satisfies a different question", () => {
    openAndAnswer("ask-1", SAMPLER, "dpmpp_2m");
    const rec = AskAnswers.recover(TAB, askFingerprint(SCHEDULER));
    // Not "recovered", and not silently "none" either: the answer exists and is
    // handed back for DISCLOSURE, quoted with its own question.
    expect(rec.status).toBe("unattributed");
    if (rec.status !== "unattributed") return;
    expect(rec.others).toHaveLength(1);
    expect(rec.others[0].question).toBe(SAMPLER.question);
  });

  it("matches on the whole question identity — text, option set, order, and mode", () => {
    const base = askFingerprint(SAMPLER);
    expect(askFingerprint({ ...SAMPLER, question: "Which sampler should I use ?" })).not.toBe(base);
    expect(
      askFingerprint({ ...SAMPLER, options: [{ label: "dpmpp_2m" }, { label: "euler" }] }),
    ).not.toBe(base); // reordered options are a different card
    expect(askFingerprint({ ...SAMPLER, options: [{ label: "euler" }] })).not.toBe(base);
    expect(askFingerprint({ ...SAMPLER, multi_select: true })).not.toBe(base);
    expect(askFingerprint({ ...SAMPLER, header: "Sampler" })).not.toBe(base);
    // …but not on cosmetics the user's decision does not depend on.
    expect(
      askFingerprint({
        ...SAMPLER,
        question: "  Which sampler   should I use?\n",
        options: [{ label: "euler", description: "fast" }, { label: " dpmpp_2m " }],
      }),
    ).toBe(base);
  });

  it("a label cannot be smuggled to collide with a different question", () => {
    // The fingerprint escapes its own inputs, so no separator can be forged.
    const a = askFingerprint({ question: "Pick", options: [{ label: 'x","y' }] });
    const b = askFingerprint({ question: "Pick", options: [{ label: "x" }, { label: "y" }] });
    expect(a).not.toBe(b);
  });

  it("an answer given on ANOTHER tab never satisfies this tab's question", () => {
    openAndAnswer("ask-1", SAMPLER, "dpmpp_2m", { tabId: OTHER_TAB });
    expect(AskAnswers.recover(TAB, askFingerprint(SAMPLER)).status).toBe("none");
  });

  it("an answer too old to be presented as fresh is disclosed, never returned", () => {
    openAndAnswer("ask-1", SAMPLER, "dpmpp_2m");
    const entry = AskAnswers.entriesFor(TAB)[0];
    entry.answeredAt = Date.now() - ASK_RECOVER_MAX_AGE_MS - 1000;
    const rec = AskAnswers.recover(TAB, askFingerprint(SAMPLER));
    expect(rec.status).toBe("unattributed");
    if (rec.status !== "unattributed") return;
    expect(rec.others[0].answer).toBe("dpmpp_2m");
  });

  it("a replaced conversation revokes the licence to satisfy a re-ask, but keeps the answer", () => {
    openAndAnswer("ask-1", SAMPLER, "dpmpp_2m");
    AskAnswers.closeAsks(TAB); // New chat / resume of a historical session
    const rec = AskAnswers.recover(TAB, askFingerprint(SAMPLER));
    expect(rec.status).toBe("unattributed");
    if (rec.status !== "unattributed") return;
    // Still reported, still quoted with its question — downgraded, not deleted.
    expect(rec.others[0].answer).toBe("dpmpp_2m");
    expect(rec.others[0].question).toBe(SAMPLER.question);
    expect(rec.others[0].correlation.status).toBe("foreign");
  });

  it("an answer whose ask id this session never opened is UNATTRIBUTED, never matched", () => {
    AskAnswers.record("never-opened", "dpmpp_2m", { tabId: TAB });
    const entry = AskAnswers.entriesFor(TAB)[0];
    expect(entry.correlation.status).toBe("foreign");
    expect(entry.fingerprint).toBeNull();
    expect(entry.question).toBeNull();
    // It is delivered (labelled), but it can satisfy nothing.
    expect(entry.delivery).toBe("pending");
    expect(AskAnswers.recover(TAB, askFingerprint(SAMPLER)).status).toBe("unattributed");
  });
});

describe("ask-answer journal — durable delivery (#486, mirroring #468)", () => {
  function drain(key: string): AskAnswerEvent[] {
    const seen: AskAnswerEvent[] = [];
    AskAnswers.deliverPending(key, (payload) => {
      seen.push(payload);
      return true;
    });
    return seen;
  }

  it("delivers the answer WITH the question that it answers", () => {
    openAndAnswer("ask-1", SAMPLER, "dpmpp_2m");
    const [ev] = drain(TAB);
    expect(ev.ask_answer).toBe("dpmpp_2m");
    expect(ev.ask_question).toBe(SAMPLER.question);
    expect(ev.ask_correlation).toBe("matched");
  });

  it("an answer handed to an agent that then DIES comes back and is replayed", () => {
    openAndAnswer("ask-1", SAMPLER, "dpmpp_2m");
    const token = AskAnswers.entriesFor(TAB)[0].token;
    drain(TAB);
    expect(AskAnswers.pending(TAB)).toHaveLength(0);
    // The agent was torn down before its turn ran — nobody read it.
    AskAnswers.release(token, { carried: false });
    expect(AskAnswers.pending(TAB)).toHaveLength(1);
    const [again] = drain(TAB);
    expect(again.ask_answer).toBe("dpmpp_2m");
    expect(again.replayed).toBe(true);
  });

  it("teardown handbacks are UNBOUNDED; only turns that carried it are counted", () => {
    openAndAnswer("ask-1", SAMPLER, "dpmpp_2m");
    const token = AskAnswers.entriesFor(TAB)[0].token;
    for (let i = 0; i < 10; i += 1) {
      drain(TAB);
      AskAnswers.release(token, { carried: false });
    }
    expect(AskAnswers.pending(TAB)).toHaveLength(1); // never settled by shuffling
    for (let i = 0; i < 3; i += 1) {
      drain(TAB);
      AskAnswers.release(token, { carried: true });
    }
    // Three turns each put the text in front of the agent — settle rather than
    // loop forever (a duplicate at worst, never an endless replay).
    expect(AskAnswers.pending(TAB)).toHaveLength(0);
  });

  it("the turn that carried it ending clears the push but keeps it recoverable", () => {
    openAndAnswer("ask-1", SAMPLER, "dpmpp_2m");
    const token = AskAnswers.entriesFor(TAB)[0].token;
    drain(TAB);
    AskAnswers.ack(token);
    expect(AskAnswers.hasOutstanding()).toBe(false);
    // …the user's decision is still on file for a re-ask of the same question.
    expect(AskAnswers.recover(TAB, askFingerprint(SAMPLER)).status).toBe("recovered");
  });

  it("a tab that goes away drops its answers and its tickets", () => {
    openAndAnswer("ask-1", SAMPLER, "dpmpp_2m");
    AskAnswers.forget(TAB);
    expect(AskAnswers.entriesFor(TAB)).toHaveLength(0);
    expect(AskAnswers.hasOutstanding()).toBe(false);
  });

  it("a tab-id migration re-addresses the answer instead of stranding it", () => {
    openAndAnswer("ask-1", SAMPLER, "dpmpp_2m");
    AskAnswers.moveKey(TAB, OTHER_TAB);
    expect(AskAnswers.entriesFor(TAB)).toHaveLength(0);
    expect(AskAnswers.pending(OTHER_TAB)).toHaveLength(1);
    expect(AskAnswers.recover(OTHER_TAB, askFingerprint(SAMPLER)).status).toBe("recovered");
  });

  it("an orphan transition drives the flush itself", () => {
    const flushed: string[] = [];
    AskAnswers.setFlusher((k) => flushed.push(k));
    // Landed with no handler waiting → pushed immediately.
    openAndAnswer("ask-1", SAMPLER, "dpmpp_2m");
    expect(flushed).toContain(TAB);
    flushed.length = 0;
    // …and an answer that lands WHILE the handler is running is that handler's to
    // return, so it is not announced until the handler unwinds without it.
    AskAnswers.openAsk("ask-2", {
      tabId: TAB,
      fingerprint: askFingerprint(SCHEDULER),
      question: SCHEDULER.question,
    });
    AskAnswers.record("ask-2", "karras", { tabId: TAB });
    expect(flushed).toHaveLength(0);
    AskAnswers.closeAsk("ask-2");
    expect(flushed).toContain(TAB);
  });
});

describe("ask-answer journal — bounds may LABEL, never silently lose (#486)", () => {
  it("an evicted ORPHAN is counted and disclosed on the next delivery", () => {
    // 16 answers fit per tab; the 17th evicts one. Every one of these reached
    // nobody, so the eviction is a real loss and must be reported.
    for (let i = 0; i < 20; i += 1) {
      openAndAnswer(`ask-${i}`, { question: `Q${i}?`, options: [{ label: "a" }, { label: "b" }] }, `A${i}`);
    }
    expect(AskAnswers.droppedFor(TAB)).toBeGreaterThan(0);
    const seen: AskAnswerEvent[] = [];
    AskAnswers.deliverPending(TAB, (payload) => {
      seen.push(payload);
      return true;
    });
    expect(seen[0].dropped_answers).toBeGreaterThan(0);
  });

  it("an eviction disclosure is NOT spent by a hand-off that is later given back", () => {
    for (let i = 0; i < 20; i += 1) {
      openAndAnswer(`ask-${i}`, { question: `Q${i}?`, options: [{ label: "a" }, { label: "b" }] }, `A${i}`);
    }
    const carrier = AskAnswers.pending(TAB)[0];
    AskAnswers.deliverPending(TAB, () => true);
    AskAnswers.release(carrier.token, { carried: false });
    const seen: AskAnswerEvent[] = [];
    AskAnswers.deliverPending(TAB, (payload) => {
      seen.push(payload);
      return true;
    });
    expect(seen[0].dropped_answers).toBeGreaterThan(0);
  });

  it("an already-RETURNED answer is evicted before an orphan, and silently", () => {
    // Ordinary successful asks must not manufacture "answers were dropped"
    // warnings — they reached a caller. Only the orphan is a loss.
    openAndAnswer("orphan", SAMPLER, "dpmpp_2m");
    for (let i = 0; i < 30; i += 1) {
      const ask = { question: `Q${i}?`, options: [{ label: "a" }, { label: "b" }] };
      AskAnswers.openAsk(`ret-${i}`, {
        tabId: TAB,
        fingerprint: askFingerprint(ask),
        question: ask.question,
      });
      AskAnswers.record(`ret-${i}`, `A${i}`, { tabId: TAB });
      AskAnswers.markReturned(`ret-${i}`);
      AskAnswers.closeAsk(`ret-${i}`);
    }
    expect(AskAnswers.droppedFor(TAB)).toBe(0);
    // The orphan is still there — it was never a candidate for a quiet eviction.
    expect(AskAnswers.orphansFor(TAB).map((e) => e.answer)).toContain("dpmpp_2m");
  });

  it("a trimmed TICKET can only weaken a correlation, never drop the answer", () => {
    // `tracks()` is what the bridge sink filters on. If it were answered from the
    // (bounded) ticket map, an eviction would make a validated answer vanish —
    // a bounded store protecting against a bounded store.
    AskAnswers.openAsk("ask-old", {
      tabId: TAB,
      fingerprint: askFingerprint(SAMPLER),
      question: SAMPLER.question,
    });
    AskAnswers.closeAsk("ask-old"); // its tool call died; the ticket is evictable
    for (let i = 0; i < 200; i += 1) {
      const ask = { question: `Q${i}?`, options: [{ label: "a" }, { label: "b" }] };
      AskAnswers.openAsk(`ask-${i}`, {
        tabId: TAB,
        fingerprint: askFingerprint(ask),
        question: ask.question,
      });
      AskAnswers.closeAsk(`ask-${i}`);
    }
    expect(AskAnswers.ticketFor("ask-old")).toBeUndefined(); // ticket trimmed away
    expect(AskAnswers.tracks("ask-old")).toBe(true); // …but still one of ours
    AskAnswers.record("ask-old", "dpmpp_2m", { tabId: TAB });
    const entry = AskAnswers.entriesFor(TAB).find((e) => e.askId === "ask-old");
    expect(entry?.answer).toBe("dpmpp_2m");
    expect(entry?.correlation.status).toBe("foreign"); // weakened, not lost
  });

  it("the same answer observed twice collapses to one entry (identity, not suppression)", () => {
    // The grace poll and the bridge sink can both see one card's reply.
    AskAnswers.openAsk("ask-1", {
      tabId: TAB,
      fingerprint: askFingerprint(SAMPLER),
      question: SAMPLER.question,
    });
    const a = AskAnswers.record("ask-1", "dpmpp_2m", { tabId: TAB });
    const b = AskAnswers.record("ask-1", "dpmpp_2m", { tabId: TAB });
    expect(b.token).toBe(a.token);
    expect(AskAnswers.entriesFor(TAB)).toHaveLength(1);
  });

  it("two DIFFERENT answers are never merged, however alike", () => {
    openAndAnswer("ask-1", SAMPLER, "dpmpp_2m");
    openAndAnswer("ask-2", SAMPLER, "dpmpp_2m");
    expect(AskAnswers.entriesFor(TAB)).toHaveLength(2);
  });

  it("never throws when the flusher does", () => {
    AskAnswers.setFlusher(() => {
      throw new Error("no agent");
    });
    expect(() => openAndAnswer("ask-1", SAMPLER, "dpmpp_2m")).toThrow();
    // The entry is journaled regardless — the throw happens after the record.
    expect(AskAnswers.entriesFor(TAB)).toHaveLength(1);
    vi.restoreAllMocks();
  });
});
