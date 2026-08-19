// #1789 — `panel_run` promised "you WILL be notified … end your turn now and
// wait", the panel's `executed` frame never arrived, and the agent sat idle
// through a clean 28.77s render until a human broke the silence.
//
// Two halves are pinned here:
//   1. DELIVERY. The orchestrator already observes every completion on the
//      monitored ComfyUI (QueueMonitor's 1 Hz /history tail diff). The watchdog
//      joins that observation to the open panel_run ticket and synthesises the
//      completion the panel never sent — into the SAME journal, so it is
//      correlated as the run the agent queued, replayed if no agent takes it,
//      and acked like any other.
//   2. THE PROMISE. panel_run's rider no longer forbids ever looking; it names
//      ONE bounded check with the prompt id.
//
// The journal-level tests drive the REAL RunCompletions singleton, so a
// regression in `awaitingCompletion` (the predicate the whole fallback is gated
// on) fails here rather than shipping.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createRunCompletionWatchdog,
  synthesizeCompletionPayload,
  DEFAULT_SYNTHESIS_GRACE_MS,
} from "../../orchestrator/run-completion-watchdog.js";
import { RunCompletions, type CompletionPayload, type RunTicket } from "../../orchestrator/run-completion-journal.js";

const TAB = "tab-1789";
const CONV = "orchestrator::claude";
const PID = "d5e14286-b746-4817-9ce5-45fc052b6a8f";

beforeEach(() => RunCompletions.reset());
afterEach(() => RunCompletions.reset());

/** A watchdog wired to the real journal, with a controllable clock. */
function makeWatchdog(clock: { t: number }) {
  const delivered: Array<{ payload: CompletionPayload; ticket: RunTicket }> = [];
  const wd = createRunCompletionWatchdog({
    awaiting: (id) => RunCompletions.awaitingCompletion(id),
    deliver: (payload, ticket) => {
      delivered.push({ payload, ticket });
      RunCompletions.record(ticket.tabId, payload, {
        ...(ticket.conversation !== undefined ? { conversation: ticket.conversation } : {}),
      });
    },
    now: () => clock.t,
  });
  return { wd, delivered };
}

describe("#1789: a completion the panel never reported is filled in from ComfyUI's history", () => {
  it("synthesises the completion for an open ticket once the grace elapses", () => {
    const clock = { t: 1_000_000 };
    const { wd, delivered } = makeWatchdog(clock);
    expect(RunCompletions.openRun(PID, { tabId: TAB, conversation: CONV })).toBe(true);

    wd.observe([{ promptId: PID, status: "success" }]);
    expect(wd.armedCount()).toBe(1);

    // Inside the grace: stay quiet — the panel's own frame is still the better
    // one and its reconcile sweep has not even run yet.
    clock.t += DEFAULT_SYNTHESIS_GRACE_MS - 1;
    wd.tick();
    expect(delivered).toHaveLength(0);

    clock.t += 2;
    wd.tick();
    expect(delivered).toHaveLength(1);
    expect(delivered[0].payload.prompt_id).toBe(PID);
    expect(delivered[0].ticket.tabId).toBe(TAB);
    expect(wd.armedCount()).toBe(0);
  });

  it("the synthesised completion is CORRELATED as the run the agent queued, and reaches an agent", () => {
    const clock = { t: 2_000_000 };
    const { wd } = makeWatchdog(clock);
    RunCompletions.openRun(PID, { tabId: TAB, conversation: CONV });
    wd.observe([{ promptId: PID, status: "success" }]);
    clock.t += DEFAULT_SYNTHESIS_GRACE_MS;
    wd.tick();

    const outstanding = RunCompletions.outstanding(TAB);
    expect(outstanding).toHaveLength(1);
    // NOT "foreign"/UNDETERMINED: the agent must be told this is ITS render.
    expect(outstanding[0].correlation).toEqual({ status: "matched", promptId: PID });

    const seen: CompletionPayload[] = [];
    const { delivered: n } = RunCompletions.deliverPending(TAB, (p) => {
      seen.push(p);
      return true;
    });
    expect(n).toBe(1);
    expect(seen[0].run_correlation).toBe("matched");
    expect(String(seen[0].note)).toContain("finished SUCCESSFULLY");
  });

  it("stays SILENT when the panel's real frame lands inside the grace", () => {
    const clock = { t: 3_000_000 };
    const { wd, delivered } = makeWatchdog(clock);
    RunCompletions.openRun(PID, { tabId: TAB, conversation: CONV });
    wd.observe([{ promptId: PID, status: "success" }]);

    // The panel reports it — the normal path — while the arm is still held.
    RunCompletions.record(TAB, { kind: "executed", prompt_id: PID, images: [{ filename: "a.png" }] }, { conversation: CONV });

    clock.t += DEFAULT_SYNTHESIS_GRACE_MS + 1;
    wd.tick();
    expect(delivered).toHaveLength(0);
    // …and the agent still gets exactly ONE completion: the panel's, with pixels.
    expect(RunCompletions.outstanding(TAB)).toHaveLength(1);
    expect(RunCompletions.outstanding(TAB)[0].payload.images).toHaveLength(1);
  });

  it("stays silent for a run this session never queued (a render the USER started)", () => {
    const clock = { t: 4_000_000 };
    const { wd, delivered } = makeWatchdog(clock);
    // No openRun at all — there is no promise to keep, and waking the agent for
    // a foreign render is the failure #889/#559 already paid for.
    wd.observe([{ promptId: "p-foreign", status: "success" }]);
    expect(wd.armedCount()).toBe(0);
    clock.t += DEFAULT_SYNTHESIS_GRACE_MS + 1;
    wd.tick();
    expect(delivered).toHaveLength(0);
  });

  it("stays silent once the run's completion has already been ACKED", () => {
    const clock = { t: 5_000_000 };
    const { wd, delivered } = makeWatchdog(clock);
    RunCompletions.openRun(PID, { tabId: TAB, conversation: CONV });
    const entry = RunCompletions.record(TAB, { kind: "executed", prompt_id: PID }, { conversation: CONV });
    RunCompletions.deliverPending(TAB, () => true);
    RunCompletions.ack(entry.token); // the turn that carried it ended

    wd.observe([{ promptId: PID, status: "success" }]);
    expect(wd.armedCount()).toBe(0); // settled ticket ⇒ nothing is owed
    clock.t += DEFAULT_SYNTHESIS_GRACE_MS + 1;
    wd.tick();
    expect(delivered).toHaveLength(0);
  });

  it("a re-observation does NOT push the deadline out", () => {
    const clock = { t: 6_000_000 };
    const { wd, delivered } = makeWatchdog(clock);
    RunCompletions.openRun(PID, { tabId: TAB, conversation: CONV });
    wd.observe([{ promptId: PID, status: "success" }]);
    // A repeated observation every second, forever, must not make the arm
    // immortal — that would reproduce the very "waits indefinitely" bug.
    for (let i = 0; i < 60; i++) {
      clock.t += 1000;
      wd.observe([{ promptId: PID, status: "success" }]);
    }
    wd.tick();
    expect(delivered).toHaveLength(1);
  });

  it("a FAILED run is reported as a failure — and NOT as an urgent run_error", () => {
    const clock = { t: 7_000_000 };
    const { wd, delivered } = makeWatchdog(clock);
    RunCompletions.openRun(PID, { tabId: TAB, conversation: CONV });
    wd.observe([{ promptId: PID, status: "error" }]);
    clock.t += DEFAULT_SYNTHESIS_GRACE_MS;
    wd.tick();
    expect(delivered).toHaveLength(1);
    // `run_error` INTERRUPTS the live turn; a status read out of a history
    // record a minute later does not warrant that blast radius (#1489).
    expect(delivered[0].payload.kind).toBe("executed");
    expect(String(delivered[0].payload.note)).toContain("FAILED");
    expect(String(delivered[0].payload.note)).toContain("Do NOT report the run as successful");
  });

  it("a deliver() that throws does not re-fire on every later tick", () => {
    const clock = { t: 8_000_000 };
    let calls = 0;
    const wd = createRunCompletionWatchdog({
      awaiting: (id) => RunCompletions.awaitingCompletion(id),
      deliver: () => {
        calls++;
        throw new Error("boom");
      },
      now: () => clock.t,
    });
    RunCompletions.openRun(PID, { tabId: TAB, conversation: CONV });
    wd.observe([{ promptId: PID, status: "success" }]);
    clock.t += DEFAULT_SYNTHESIS_GRACE_MS;
    wd.tick();
    wd.tick();
    wd.tick();
    expect(calls).toBe(1);
  });
});

describe("#1789: awaitingCompletion answers 'is this run still owed its notification?'", () => {
  it("true for a fresh ticket, false once ANY completion for it is journaled", () => {
    RunCompletions.openRun(PID, { tabId: TAB, conversation: CONV });
    expect(RunCompletions.awaitingCompletion(PID)?.promptId).toBe(PID);
    RunCompletions.record(TAB, { kind: "executed", prompt_id: PID }, { conversation: CONV });
    expect(RunCompletions.awaitingCompletion(PID)).toBeUndefined();
  });

  it("false while the completion is merely HANDED OFF (the journal owns the replay from there)", () => {
    RunCompletions.openRun(PID, { tabId: TAB, conversation: CONV });
    RunCompletions.record(TAB, { kind: "executed", prompt_id: PID }, { conversation: CONV });
    RunCompletions.deliverPending(TAB, () => true); // state → handed_off, not acked
    expect(RunCompletions.awaitingCompletion(PID)).toBeUndefined();
  });

  it("false for a REUSED prompt id — a synthesised notice could not say WHICH run finished", () => {
    RunCompletions.openRun(PID, { tabId: TAB, conversation: CONV });
    RunCompletions.openRun(PID, { tabId: TAB, conversation: CONV }); // queued again
    expect(RunCompletions.ticketFor(PID)?.reused).toBe(true);
    expect(RunCompletions.awaitingCompletion(PID)).toBeUndefined();
  });

  it("false for an id with no ticket at all", () => {
    expect(RunCompletions.awaitingCompletion("nobody-queued-this")).toBeUndefined();
  });
});

describe("#1789: the synthesised note claims only what was observed", () => {
  it("names the prompt id, the delay, and where the images actually are", () => {
    const payload = synthesizeCompletionPayload(
      { promptId: PID, status: "success", observedAt: 1000 },
      { deliveredAt: 1000 + 46_000 },
    );
    const note = String(payload.note);
    expect(note).toContain(PID);
    expect(note).toContain("46s");
    expect(note).toContain("the panel never delivered its completion");
    // It must NOT pretend to carry pixels it never fetched.
    expect(payload.images).toEqual([]);
    expect(note).toContain('get_image (action:"list_outputs")');
    // Machine-readable provenance, so a consumer can tell this from a panel frame.
    expect(payload.completion_source).toBe("orchestrator-history-watchdog");
    expect(payload.run_status).toBe("success");
  });

  it("an INTERRUPTED run is not described as a crash", () => {
    const note = String(
      synthesizeCompletionPayload(
        { promptId: PID, status: "interrupted", observedAt: 0 },
        { deliveredAt: 45_000 },
      ).note,
    );
    expect(note).toContain("INTERRUPTED");
    expect(note).toContain("Nothing crashed");
  });
});
