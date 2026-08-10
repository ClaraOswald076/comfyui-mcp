// #925 (panel) — "does NOT match any run you queued" was being said about a run
// the session DID queue.
//
// The reporter queued a render with panel_run, got prompt id 8812f71b…, and its
// re-delivered completion carried that exact id. ComfyUI's history confirmed the
// prompt succeeded. The orchestrator told the agent it was not theirs.
//
// The cause is a fold, not a lost ticket. `correlate()` returns `foreign` for
// every completion with no OPEN ticket, and `foreign` renders as a definite
// negative — "does NOT match any run you queued". But "no open ticket" covers
// two different facts:
//
//   never ours      a real run this session did not queue
//   ours, forgotten the ticket was evicted (the map is capped at 64), the entry
//                   was already delivered and acked, or the id was re-queued and
//                   now stands for more than one run
//
// Both are UNDETERMINED, both must be refused identically — a completion that
// cannot be proven to be yours must never satisfy an outstanding panel_run, and
// that rule does not move here. What changes is that the orchestrator stops
// asserting the one thing it does not know. The journal's own header says why
// this matters: it "does not merely mislabel it: it TELLS THE AGENT TO DISBELIEVE
// A CORRECT RESULT".

import { describe, expect, it } from "vitest";

import { RunCompletionJournalImpl } from "../../orchestrator/run-completion-journal.js";

const TAB = "wf:workflows/a.json";
const CONVO = "orchestrator::claude";
const PID = "8812f71b-50c1-4d4f-b8e7-dc35d0093c1f";

function journal() {
  return new RunCompletionJournalImpl();
}

/** Queue, deliver and ACK a completion — the real lifecycle, because the ack is
 *  what clears the ticket and produces the reporter's state. */
function queueDeliverAck(j: RunCompletionJournalImpl, tab: string, convo: string, pid: string) {
  j.openRun(pid, { tabId: tab, conversation: convo });
  const entry = j.record(tab, { prompt_id: pid, kind: "executed" }, { conversation: convo });
  const tokens: string[] = [];
  j.deliverPending(tab, (_payload: unknown, token: string) => {
    tokens.push(token);
    return true;
  });
  for (const t of tokens) j.ack(t);
  return { entry, tokens };
}

describe("a forgotten run is not reported as one you never queued (#925)", () => {
  it("an id this session NEVER queued stays a plain foreign — that claim is true", () => {
    const j = journal();
    const c = j.correlate(TAB, { prompt_id: PID }, CONVO);
    expect(c.status).toBe("foreign");
    expect((c as { priorHistory?: boolean }).priorHistory).toBeFalsy();
  });

  it("a run this session queued correlates as matched while the ticket is held", () => {
    const j = journal();
    j.openRun(PID, { tabId: TAB, conversation: CONVO });
    expect(j.correlate(TAB, { prompt_id: PID }, CONVO).status).toBe("matched");
  });

  it("an ack alone does NOT forget the run — measured, not assumed", () => {
    // Worth pinning, because it was my first theory for the reporter's case and
    // it is wrong: the ticket is marked settled but stays in the map, so a
    // re-delivery still correlates as the run it is. Nothing to fix on this path.
    const j = journal();
    const { entry } = queueDeliverAck(j, TAB, CONVO, PID);
    expect(entry.correlation.status).toBe("matched");
    expect(j.correlate(TAB, { prompt_id: PID }, CONVO).status).toBe("matched");
  });

  it("THE FORGOTTEN CASE: the ticket is evicted, and the id is still known to be ours", () => {
    // The ticket map is capped (MAX_TICKETS = 64) and eviction is documented as
    // making later completions read `foreign` — "the honest reading once we've
    // forgotten the run". Honest about UNDETERMINED; not honest about "does NOT
    // match any run you queued", which is what the agent was actually told.
    //
    // The delivered-memo deliberately outlives the tickets (512 pairs vs 64), so
    // the evidence needed to tell the two apart is already kept.
    const j = journal();
    queueDeliverAck(j, TAB, CONVO, PID);

    // Push the original ticket out with a batch of later runs.
    for (let i = 0; i < 80; i++) {
      j.openRun(`later-${i}-0000-4000-8000-00000000${String(i).padStart(4, "0")}`, {
        tabId: TAB,
        conversation: CONVO,
      });
    }

    const again = j.correlate(TAB, { prompt_id: PID }, CONVO);
    expect(again.status, "with no ticket it cannot be proven to be the awaited run").toBe("foreign");
    expect(
      (again as { priorHistory?: boolean }).priorHistory,
      "…but the journal KNOWS this id has been ours — that is the whole fix",
    ).toBe(true);
  });

  it("survives the tab id churning, because the conversation outlives it", () => {
    // A reconnecting panel re-registers under a new tab id (#704). The history
    // lookup is by conversation as well as tab, so the re-delivery under a NEW
    // address still knows the id was ours.
    const j = journal();
    queueDeliverAck(j, TAB, CONVO, PID);
    for (let i = 0; i < 80; i++) {
      j.openRun(`later-${i}-0000-4000-8000-00000000${String(i).padStart(4, "0")}`, {
        tabId: TAB,
        conversation: CONVO,
      });
    }

    const afterReconnect = j.correlate("tmp:brand-new-id", { prompt_id: PID }, CONVO);
    expect(afterReconnect.status).toBe("foreign");
    expect((afterReconnect as { priorHistory?: boolean }).priorHistory).toBe(true);
  });

  it("a DIFFERENT conversation's run is still plainly foreign — no over-reach", () => {
    // The fix must not start claiming other sessions' runs. Ownership is
    // unchanged; only the wording for our own forgotten ids moves.
    const j = journal();
    queueDeliverAck(j, TAB, CONVO, PID);
    for (let i = 0; i < 80; i++) {
      j.openRun(`later-${i}-0000-4000-8000-00000000${String(i).padStart(4, "0")}`, {
        tabId: TAB,
        conversation: CONVO,
      });
    }

    const other = j.correlate("wf:workflows/b.json", { prompt_id: PID }, "orchestrator::codex");
    expect(other.status).toBe("foreign");
    expect(
      (other as { priorHistory?: boolean }).priorHistory,
      "another conversation has no history for this id and must not be told it does",
    ).toBeFalsy();
  });

  it("an id with no prompt id at all is unchanged — still unidentified", () => {
    const j = journal();
    expect(j.correlate(TAB, {}, CONVO).status).toBe("unidentified");
  });
});

// ── THE WORDING ───────────────────────────────────────────────────────────
// `runIdentityPreamble` is module-private, so the sentence the agent actually
// reads is pinned at source. Without this the journal could carry the flag
// correctly while the message stayed wrong — and the message IS the defect.
describe("the sentence the agent reads (#925)", () => {
  it("stops claiming 'does NOT match any run you queued' for an id that was ours", async () => {
    const { readFile } = await import("node:fs/promises");
    const src = await readFile(
      new URL("../../orchestrator/panel-agent.ts", import.meta.url),
      "utf-8",
    );
    const fn = src.slice(src.indexOf("function runIdentityPreamble"));
    const body = fn.slice(0, fn.indexOf("\n}\n"));

    // The flag has to be READ here, or the journal's work never reaches anyone.
    expect(body).toContain("ev.run_correlation_prior");
    // The prior branch must come BEFORE the blanket negative, or the old
    // sentence wins and nothing changes for the caller.
    expect(body.indexOf("run_correlation_prior")).toBeLessThan(
      body.indexOf("does NOT match any run you queued"),
    );
    // It still refuses: UNDETERMINED, and do not treat it as the awaited render.
    const priorBranch = body.slice(
      body.indexOf("run_correlation_prior"),
      body.indexOf("does NOT match any run you queued"),
    );
    expect(priorBranch).toMatch(/UNDETERMINED/);
    expect(priorBranch).toMatch(/Do NOT treat it as that render/);
    // …and it does not tell the agent the id was not its own.
    expect(priorBranch).not.toMatch(/does NOT match/);
  });
});
