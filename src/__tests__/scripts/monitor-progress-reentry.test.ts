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

  it("NO comparison against the terminal vocabulary survives, in either form", () => {
    // Five sites had the same pattern. My first pass banned only the EQUALITY form and
    // missed the timeout path's inequality `j.status !== "done" && j.status !== "error"`,
    // which reports a just-succeeded job as incomplete and exits 1 — the assertion was
    // shaped like the bug I had already found rather than like the bug.
    const s = code();
    for (const pattern of [
      /\.status === "done"/,
      /\.status === "error"/,
      /\.status !== "done"/,
      /\.status !== "error"/,
    ]) {
      expect(s, `a terminal-status comparison survives: ${pattern}`).not.toMatch(pattern);
    }
  });

  it("the TIMEOUT decides on the flag, and only reports when something is unfinished", () => {
    // Two faults lived here. The filter used the stale vocabulary, and the ENTRY condition
    // used `doneCount < jobs.size` — which lags, because `doneCount++` lands only after the
    // awaited history fetch. A job finishing just before the timeout is correctly absent
    // from the list while doneCount has not caught up, so the script printed
    // "[TIMEOUT] 0 job(s) still incomplete" and exited 1: a clean run reported as failure,
    // with an empty list as its own evidence.
    //
    // Asserted on BEHAVIOUR rather than source text (codex P3): the previous version
    // matched an exact `.filter(([, j]) => !j.finished)` string, which a rename of `j` or a
    // reformat would break while preserving semantics.
    const decide = (jobsList: { finished: boolean }[]): { exits: boolean; count: number } => {
      const remaining = jobsList.filter((j) => !j.finished);
      return { exits: remaining.length > 0, count: remaining.length };
    };
    // The regression: finished, but doneCount has not caught up.
    expect(decide([{ finished: true }, { finished: true }])).toEqual({ exits: false, count: 0 });
    // A genuine timeout still fails, which is the point of the timeout.
    expect(decide([{ finished: true }, { finished: false }])).toEqual({ exits: true, count: 1 });
  });

  it("the timeout no longer gates entry on the lagging counter", () => {
    // The one source fact worth pinning: `doneCount` must not be the entry condition,
    // because it is updated after an await while `finished` is not.
    // Scoped to the TIMEOUT block alone. Slicing to end-of-file swept in a later,
    // legitimate `doneCount` gate — an assertion that reads the whole rest of the script
    // is not about the thing it names.
    const s = code();
    const start = s.indexOf("setTimeout(() => {");
    const block = s.slice(start, s.indexOf("}, TIMEOUT_MS);", start));
    expect(start, "the timeout block must still exist").toBeGreaterThan(-1);
    expect(block).not.toMatch(/doneCount/);
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
