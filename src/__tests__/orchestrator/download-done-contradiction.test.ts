// #1574 — the tray announced "transfer completed" while the transfer was still streaming.
//
// The reporter checked three independent things immediately after the event arrived:
//
//   download_model action:"status" {id}  → **downloading** … still streaming, started 634s ago
//   list_local_models                    → the file was ABSENT
//   get_system_stats a few minutes later → the category count went 8 → 9
//
// So the file landed AFTER the completion event. They also read the formatting code and
// correctly concluded it is not at fault: it emits `transfer completed` for rows where
// `d.status === "done"`, so something upstream had already put the row in that state.
//
// ## What this pins
//
// The completion event is driven by a PROGRESS ROW read off disk, while
// `download_model action:"status"` answers from the JOB RECORD. Two stores, and the event
// consults only one of them. A false `done` is the dangerous direction — the natural next
// action is to USE the file — and #1150 was the same disagreement on the `error` side, where
// the wording at least warns the reader.
//
// This does not require knowing which writer set the row: whatever did, the orchestrator
// holds the authoritative record in the same tick and can decline to announce a completion
// that its own status tool would contradict.
import { describe, expect, it } from "vitest";

import { completionContradictedByRecord } from "../../orchestrator/download-done-guard.js";

const row = (over: Record<string, unknown> = {}) => ({
  id: "6226e26ba97f8527",
  name: "model.safetensors",
  status: "done",
  ...over,
});

const job = (over: Record<string, unknown> = {}) => ({
  id: "6226e26ba97f8527",
  filename: "model.safetensors",
  status: "downloading",
  ...over,
});

describe("a completion the record contradicts is not announced (#1574)", () => {
  it("REFUSES the reported case: row says done, the job record still says downloading", () => {
    expect(completionContradictedByRecord(row(), [job()])).toBe(true);
  });

  it("allows a completion the record agrees with", () => {
    expect(completionContradictedByRecord(row(), [job({ status: "done" })])).toBe(false);
  });

  it("allows a completion when the record has no opinion", () => {
    // The record store is reset by an orchestrator respawn — which is exactly the session
    // the reporter hit. An ABSENT record is not evidence the transfer is still running, and
    // suppressing every completion after a respawn would lose the events entirely.
    expect(completionContradictedByRecord(row(), [])).toBe(false);
    expect(completionContradictedByRecord(row(), [job({ id: "someone-else" })])).toBe(false);
  });

  it("matches on ID, not on filename", () => {
    // A retry of a 404 is a DIFFERENT id writing the SAME filename (#1150). Matching by name
    // would let an unrelated live attempt suppress a genuine completion.
    expect(
      completionContradictedByRecord(row({ id: "attempt-2" }), [
        job({ id: "attempt-1", status: "downloading" }),
      ]),
    ).toBe(false);
  });

  it("only guards COMPLETIONS — a failure row is never suppressed", () => {
    // #1150's direction. A FAILED event carries its own hedged wording and must keep
    // firing; silencing it would strand the user with no signal at all.
    expect(completionContradictedByRecord(row({ status: "error" }), [job()])).toBe(false);
  });

  it("a terminal record other than done does not contradict", () => {
    // cancelled / error in the record are terminal too. The guard exists for the one
    // disagreement that matters: the record says the bytes are STILL MOVING.
    for (const status of ["error", "cancelled"]) {
      expect(completionContradictedByRecord(row(), [job({ status })]), status).toBe(false);
    }
  });

  it("junk never throws — this runs on the event path", () => {
    for (const bad of [null, undefined, {}, { status: "done" }]) {
      expect(() => completionContradictedByRecord(bad as never, [job()])).not.toThrow();
    }
    expect(completionContradictedByRecord(row(), null as never)).toBe(false);
  });
});
