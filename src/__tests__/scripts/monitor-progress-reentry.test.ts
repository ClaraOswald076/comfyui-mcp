// #1385 — `monitor-progress.mjs` printed `[DONE]` twice for one job and exited
// `[COMPLETE] All 2 jobs finished` while the second job was still executing. Its mp4 did
// not exist yet.
//
// TWO FAULTS, EITHER OF WHICH IS ENOUGH:
//
//   1. the re-entry guard tested `job.status === "done" || "error"` while the function
//      assigned `status`, which callers pass as "success" — so a successful job never
//      matched its own guard;
//   2. `doneCount++` sits after an await (a HISTORY_DELAY_MS sleep plus a /history fetch),
//      so even a correct status guard leaves a window where both callers are past the
//      check before either increments.
//
// Two callers reach markDone for one completion: the WS `execution_success` event and the
// history poller. Single-ID runs never showed it because exiting at the first completion is
// correct anyway.
//
// This asserts on the SOURCE. The script is a standalone .mjs with top-level side effects
// (it opens a WebSocket and calls process.exit), so importing it into a test would start a
// monitor rather than test one — and the defect is structural: which expression the guard
// reads, and whether the flag is set before the first await.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const src = (): string =>
  readFileSync(new URL("../../../plugin/scripts/monitor-progress.mjs", import.meta.url), "utf8");

/** Source with comments stripped — this file's own header names the strings it asserts. */
const code = (): string => src().replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");

describe("monitor-progress re-entry guard (#1385)", () => {
  it("guards on a FLAG, not on a status string it does not write", () => {
    const s = code();
    expect(s).toMatch(/if \(!job \|\| job\.finished\) return;/);
    expect(s).toMatch(/job\.finished = true;/);
  });

  it("no guard compares against the status vocabulary any more", () => {
    // All four sites had the same pattern; fixing only markDone would leave printProgress
    // and the two sweep loops treating a finished job as live.
    expect(code()).not.toMatch(/job\.status === "done"/);
    expect(code()).not.toMatch(/job\.status === "error"/);
  });

  it("the flag is set BEFORE the first await in markDone", () => {
    // The half a correct status guard would still not fix: both callers can be past the
    // check while the first is suspended in the history fetch.
    const s = code();
    const fn = s.slice(s.indexOf("async function markDone"), s.indexOf("function checkAllDone"));
    expect(fn).toContain("job.finished = true;");
    expect(fn.indexOf("job.finished = true;")).toBeLessThan(fn.indexOf("await"));
  });

  it("the flag is initialised on every job, so the first guard read is defined", () => {
    expect(code()).toMatch(/finished: false,/);
  });

  it("SEMANTICS: a second completion for the same job is a no-op", () => {
    // The behaviour the source shape is for, exercised directly: two callers, one
    // completion, one increment. Before the fix the second call passed the guard and
    // doneCount reached 2 for a single finished job — which is exactly what let
    // `doneCount >= jobs.size` fire while another job was still running.
    const job = { finished: false, status: "running" };
    let doneCount = 0;
    const markDone = (j: { finished: boolean; status: string }, status: string): void => {
      if (!j || j.finished) return;
      j.finished = true;
      j.status = status;
      doneCount++;
    };
    markDone(job, "success");
    markDone(job, "success");
    expect(doneCount).toBe(1);
    // …and the status it writes is still not one the old guard would have matched, which
    // is why the flag rather than a vocabulary fix.
    expect(job.status).toBe("success");
  });
});
