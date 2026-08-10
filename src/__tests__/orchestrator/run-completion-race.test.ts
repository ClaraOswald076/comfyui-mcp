// #1327 — a render that finished before its own ticket existed was disowned.
//
// The reporter queued `panel_run({to_node_id: 118})`, got back
// prompt e69d89b1-…, and the completion came back saying:
//
//   This run (prompt e69d89b1-…) does NOT match any run you queued with panel_run
//   — its origin is UNDETERMINED. Do NOT treat it as the render you are waiting on
//
// with the SAME id the call had just returned. That is not cosmetic: it tells the
// agent to distrust a correct result and to go poll get_history, which is exactly the
// behaviour the anti-poll guidance exists to prevent. Mid-A/B-comparison it invites
// discarding a valid measurement.
//
// THE MECHANISM IS AN ORDERING ONE, and not the one the report guessed (it supposed
// re-delivery consulted the registry — it does not; the verdict is frozen at arrival).
// A ticket CANNOT be opened before dispatch, because ComfyUI mints the prompt id when
// it accepts the run. Their render took 0.1s fully cached, so:
//
//   dispatch → ComfyUI runs → `executed` arrives → (no ticket yet) → journaled foreign
//                                                → reply gets back → openRun()
//
// The dispatch timestamp settles it without heuristics: the id did not exist before
// this call created it, so a completion carrying it that arrived at/after the dispatch
// is necessarily this run's.

import { beforeEach, describe, expect, it } from "vitest";

import { RunCompletionJournalImpl } from "../../orchestrator/run-completion-journal.js";

const TAB = "wf:workflows/a.json";
const CONV = "conv-1";
const PID = "e69d89b1-0705-4b3c-8e69-2f4d74c31e17";

let journal: RunCompletionJournalImpl;

beforeEach(() => {
  journal = new RunCompletionJournalImpl();
});

/** Deliver everything pending for the tab and return the payloads handed over. */
function drain(): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  journal.deliverPending(TAB, (payload) => {
    out.push(payload as unknown as Record<string, unknown>);
    return true;
  });
  return out;
}

describe("a completion that beats its own ticket is still OURS (#1327)", () => {
  it("the reporter's sequence: 0.1s cached render lands before openRun", () => {
    const dispatchedAt = Date.now();
    // The render finishes and the panel forwards `executed` BEFORE the /prompt reply
    // has made it back to us — so there is no ticket to correlate against yet.
    journal.record(TAB, { prompt_id: PID, duration_s: 0.1 }, CONV);
    // …and only now does panel_run learn the id and open the ticket.
    journal.openRun(PID, { tabId: TAB, conversation: CONV, toNodeId: 118, dispatchedAt });

    const [payload] = drain();
    expect(payload).toBeDefined();
    expect(payload.prompt_id).toBe(PID);
    // THE DEFECT: this used to be "foreign".
    expect(payload.run_correlation).toBe("matched");
    expect(payload.run_correlation_prior).toBeUndefined();
  });

  it("and the ticket is NOT poisoned as reused — the second-order harm", () => {
    // The already-journaled entry made hasHistoryFor() true, so the fresh ticket was
    // born `reused`, and EVERY later completion for that id read UNDETERMINED too.
    // One race therefore degraded the whole run, not just one notification.
    const dispatchedAt = Date.now();
    journal.record(TAB, { prompt_id: PID, duration_s: 0.1 }, CONV);
    journal.openRun(PID, { tabId: TAB, conversation: CONV, dispatchedAt });
    drain();

    // A second completion for the same run (a re-sent frame) must still correlate.
    const again = journal.correlate(TAB, { prompt_id: PID }, CONV);
    expect(again.status).toBe("matched");
  });

  it("a completion from BEFORE the dispatch is not claimed", () => {
    // The guard's over-broad direction. An id genuinely reused by ComfyUI carries a
    // completion that predates this dispatch, and claiming it would attribute an
    // older run's result to a new one — the misattribution the journal is built to
    // refuse, which is strictly worse than saying "undetermined".
    journal.record(TAB, { prompt_id: PID, duration_s: 9 }, CONV);
    const dispatchedAt = Date.now() + 5_000; // dispatch happens AFTER that arrival
    journal.openRun(PID, { tabId: TAB, conversation: CONV, dispatchedAt });

    const [payload] = drain();
    expect(payload.run_correlation).not.toBe("matched");
  });

  it("another party's completion for the same id is not claimed", () => {
    const dispatchedAt = Date.now();
    journal.record("wf:other.json", { prompt_id: PID }, "conv-2");
    journal.openRun(PID, { tabId: TAB, conversation: CONV, dispatchedAt });

    // Nothing landed on OUR tab…
    expect(drain()).toHaveLength(0);
    // …and theirs was left alone.
    const theirs: Array<Record<string, unknown>> = [];
    journal.deliverPending("wf:other.json", (p) => {
      theirs.push(p as unknown as Record<string, unknown>);
      return true;
    });
    expect(theirs[0]?.run_correlation).not.toBe("matched");
  });

  it("a verdict already HANDED to an agent is never rewritten under it", () => {
    // The journal's standing rule: a replay never re-correlates. The claim only ever
    // corrects an entry nobody has been told about yet.
    //
    // MY FIRST VERSION OF THIS TEST PROVED NOTHING. It handed the entry off and then
    // asserted over `deliverPending` again — but a handed-off entry is not in
    // `pending()`, so the loop ran over an EMPTY array and passed vacuously. Deleting
    // the guard left it green. The real path is a RELEASE (the carrying turn ended
    // without an ack), which puts the entry back to `pending` — which is also why the
    // guard is keyed on `attempts`, not on `state`.
    const tokens: string[] = [];
    journal.record(TAB, { prompt_id: PID }, CONV);
    journal.deliverPending(TAB, (payload, token) => {
      expect((payload as unknown as Record<string, unknown>).run_correlation).toBe("foreign");
      tokens.push(token);
      return true;
    });
    expect(tokens).toHaveLength(1);

    // The turn that carried it ended without acking → back to pending for replay.
    journal.release(tokens[0] as string, { carried: true });
    journal.openRun(PID, { tabId: TAB, conversation: CONV, dispatchedAt: Date.now() });

    const after = drain();
    expect(after).toHaveLength(1); // the replay really happened — not a vacuous pass
    expect(after[0]?.run_correlation).not.toBe("matched");
    expect(after[0]?.replayed).toBe(true);
  });

  it("without a dispatch timestamp nothing is claimed — no proof, no change", () => {
    // Callers that cannot supply the dispatch time keep exactly the old behaviour
    // rather than getting a timing guess.
    journal.record(TAB, { prompt_id: PID }, CONV);
    journal.openRun(PID, { tabId: TAB, conversation: CONV });

    const [payload] = drain();
    expect(payload.run_correlation).toBe("foreign");
  });

  it("an ID-LESS completion is never claimed on timing alone", () => {
    const dispatchedAt = Date.now();
    journal.record(TAB, { duration_s: 0.1 }, CONV); // no prompt_id at all
    journal.openRun(PID, { tabId: TAB, conversation: CONV, dispatchedAt });

    const [payload] = drain();
    expect(payload.run_correlation).toBe("unidentified");
  });
});

describe("WIRING: panel_run stamps the dispatch time before dispatching (#1327)", () => {
  it("captures it BEFORE ctx.call, and passes it to openRun", async () => {
    // Order is the entire fix. Stamping it after the call would put the timestamp
    // after the completion arrived, and the entry would fail the `arrivedAt >=
    // dispatchedAt` test it exists to pass — the bug, with extra code.
    const { readFile } = await import("node:fs/promises");
    const src = await readFile(new URL("../../orchestrator/panel-tools.ts", import.meta.url), "utf-8");

    const stamp = src.indexOf("const runDispatchedAt = Date.now();");
    const call = src.indexOf("let res = await ctx.call(runCmd", stamp);
    expect(stamp).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(stamp); // stamped first
    expect(src).toContain("dispatchedAt: runDispatchedAt,");
  });
});
