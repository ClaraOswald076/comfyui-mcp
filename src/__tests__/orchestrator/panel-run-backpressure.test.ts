// panel_run duplicate fence (#862) + backpressure note (#559) + panel_screenshot
// DOM-overlay note (#567).
//
// #862: after a reconnect the resumed agent has no running-state signal, and the
//       self-queue ledger is in-memory — its own still-running render reads as
//       unaccounted-for. panel_run must REFUSE to stack a duplicate BEFORE the
//       queue call (naming the in-flight prompt), not queue first and warn after;
//       allow_duplicate:true is the explicit override.
// #559: queuing a batch is normal. A queue made of the agent's OWN recent jobs must
//       be reported NEUTRALLY, never as a "[QUEUE WARNING] … cancel with
//       clear_pending:true" that would wipe the whole batch. Unaccounted-for work
//       in flight is now fenced pre-dispatch (#862); the softened post-queue warning
//       remains as the TOCTOU / explicit-override disclosure.
// #567: a canvas screenshot cannot show DOM-overlay widget content (MarkdownNote
//       renders as an empty body). panel_screenshot must FLAG such nodes so the
//       agent doesn't read the blank body as missing content.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildPanelToolDefs,
  makePanelToolCtx,
  domOverlayScreenshotNote,
  type PanelToolCtx,
} from "../../orchestrator/panel-tools.js";
import { QueueMonitor } from "../../services/queue-monitor.js";
import { runErrorNotice } from "../../orchestrator/cli-remedy.js";

type QMPriv = {
  url: string | null;
  stopped: boolean;
  selfQueuedIds: Set<string>;
  lastSelfQueueTs: number | null;
  state: {
    connected: boolean;
    runningPromptId: string | null;
    pendingPromptIds: string[];
    queueRemaining: number;
    lastServerAliveTs: number | null;
    lastFrameTs: number | null;
  };
};
const qm = QueueMonitor as unknown as QMPriv;

function defByName(name: string) {
  const def = buildPanelToolDefs().find((d) => d.name === name);
  if (!def) throw new Error(`tool ${name} not found`);
  return def;
}

/** A ctx whose graph_run reply is the given JSON object (as text), and whose raw
 *  bridge.send returns `bridgeReply`. */
function makeCtx(runReply: Record<string, unknown>, bridgeReply?: unknown): PanelToolCtx {
  const bridge = {
    send: async () => bridgeReply ?? {},
    push: () => 1,
    canReach: () => true,
  } as unknown as PanelToolCtx["bridge"];
  const ctx = makePanelToolCtx(bridge, "test-tab");
  // Override `call` so panel_run's graph_run gets our scripted reply.
  (ctx as { call: PanelToolCtx["call"] }).call = async () => ({
    content: [{ type: "text", text: JSON.stringify(runReply) }],
  });
  return ctx;
}

function firstText(res: { content?: Array<{ type: string; text?: string }> }): string {
  return res.content?.find((c) => c.type === "text")?.text ?? "";
}

beforeEach(() => {
  qm.url = "http://127.0.0.1:9999";
  qm.stopped = false;
  qm.selfQueuedIds.clear();
  qm.lastSelfQueueTs = null;
  qm.state.connected = true;
  qm.state.runningPromptId = null;
  qm.state.pendingPromptIds = [];
  qm.state.queueRemaining = 0;
  qm.state.lastServerAliveTs = Date.now();
  qm.state.lastFrameTs = Date.now();
});

afterEach(() => {
  qm.selfQueuedIds.clear();
  qm.lastSelfQueueTs = null;
  qm.stopped = true;
  qm.url = null;
});

describe("panel_run backpressure note (#559)", () => {
  it("a batch queued behind the agent's OWN running job → NEUTRAL note, no destructive headline", async () => {
    // Simulate a prior batch item already running + pending, all ours.
    QueueMonitor.markSelfQueued("p-batch-1");
    QueueMonitor.markSelfQueued("p-batch-a");
    QueueMonitor.markSelfQueued("p-batch-b");
    qm.state.runningPromptId = "p-batch-1";
    qm.state.pendingPromptIds = ["p-batch-a", "p-batch-b"];
    qm.state.queueRemaining = 3; // 1 running + 2 pending, all ours

    const ctx = makeCtx({ queued: true, prompt_id: "p-batch-2" });
    const res = await defByName("panel_run").handler({}, ctx);
    const text = firstText(res);

    expect(text).toContain("[QUEUE]");
    expect(text).toContain("your own");
    // Must NOT be the old destructive warning, and must NOT lead with clear_pending.
    expect(text).not.toContain("[QUEUE WARNING]");
    expect(text).not.toContain("ALREADY RUNNING");
    // clear_pending is only mentioned as a conditional last resort, never the headline.
    expect(text).toContain('Only use queue (action:"cancel") with clear_pending:true if a render is ACTUALLY wedged');
    // The successful queue registered p-batch-2 for the NEXT run's attribution.
    expect(qm.selfQueuedIds.has("p-batch-2")).toBe(true);
  });

  it("an unaccounted-for job running ahead → REFUSED before dispatch, running prompt named (#862)", async () => {
    // The reconnect-duplicate case: the self-queue ledger is in-memory, so after
    // an orchestrator restart the agent's OWN still-running render reads as
    // unaccounted-for. The fence must fire BEFORE any graph_run goes out.
    qm.state.runningPromptId = "p-foreign";
    qm.state.queueRemaining = 1; // just the unaccounted running job

    let dispatched = 0;
    const bridge = {
      send: async () => {
        dispatched++;
        return {};
      },
      push: () => 1,
      canReach: () => true,
    } as unknown as PanelToolCtx["bridge"];
    const ctx = makePanelToolCtx(bridge, "test-tab");
    (ctx as { call: PanelToolCtx["call"] }).call = async () => {
      dispatched++;
      return { content: [{ type: "text", text: JSON.stringify({ queued: true, prompt_id: "p-mine" }) }] };
    };

    const res = await defByName("panel_run").handler({}, ctx);
    const text = firstText(res);

    // Nothing was dispatched — the fence fired before the queue call.
    expect(dispatched).toBe(0);
    expect(res.isError).toBe(true);
    expect(text).toContain("refused to queue");
    expect(text).toContain("p-foreign"); // the running prompt id is returned
    expect(text).toContain("Nothing was queued");
    // The reason is stated honestly: CANNOT CONFIRM it as this session's own —
    // not "you didn't queue it" (the ledger does not survive a restart).
    expect(text).toContain("cannot confirm it as its own");
    // Actionable remedies: inspect, deliberate override, wedge escape.
    expect(text).toContain('queue (action:"list")');
    expect(text).toContain("allow_duplicate:true");
    expect(text).toContain("clear_pending:true");
  });

  it("a RECENT self-queue with no recorded ids does NOT wave a foreign render through (strict attribution, #862 codex gate)", async () => {
    // The coarse #559 fallback ("we queued SOMETHING in the last 10 minutes")
    // would call this self-attributed — but the in-flight job's id is visible
    // and is NOT ours. A fence that refuses dispatches needs the strict warrant.
    QueueMonitor.markSelfQueued(null); // a queue whose reply carried no prompt_id
    qm.state.runningPromptId = "p-foreign";
    qm.state.queueRemaining = 1;

    let dispatched = 0;
    const ctx = makeCtx({ queued: true, prompt_id: "p-mine" });
    (ctx as { call: PanelToolCtx["call"] }).call = async () => {
      dispatched++;
      return { content: [{ type: "text", text: "{}" }] };
    };

    const res = await defByName("panel_run").handler({}, ctx);
    expect(dispatched).toBe(0);
    expect(res.isError).toBe(true);
    expect(firstText(res)).toContain("refused to queue");
  });

  it("an own batch whose depth the poll has NOT fully accounted for is refused — the documented burst tradeoff (#862)", async () => {
    // We queued two jobs, but the 1 Hz poll has only captured one of them
    // (queueRemaining is live; pendingPromptIds lags). Not PROVABLY ours → the
    // fence refuses and names the override, rather than risk a blind duplicate.
    QueueMonitor.markSelfQueued("p-own-1");
    QueueMonitor.markSelfQueued("p-own-2");
    qm.state.runningPromptId = "p-own-1";
    qm.state.pendingPromptIds = []; // poll hasn't captured p-own-2 yet
    qm.state.queueRemaining = 2;

    let dispatched = 0;
    const ctx = makeCtx({ queued: true, prompt_id: "p-own-3" });
    (ctx as { call: PanelToolCtx["call"] }).call = async () => {
      dispatched++;
      return { content: [{ type: "text", text: "{}" }] };
    };

    const res = await defByName("panel_run").handler({}, ctx);
    expect(dispatched).toBe(0);
    expect(res.isError).toBe(true);
    expect(firstText(res)).toContain("allow_duplicate:true");
  });

  it("unaccounted-for PENDING-only work (nothing running yet) → also refused (#862)", async () => {
    qm.state.runningPromptId = null;
    qm.state.pendingPromptIds = ["p-pending-1", "p-pending-2"];
    qm.state.queueRemaining = 2;

    let dispatched = 0;
    const ctx = makeCtx({ queued: true, prompt_id: "p-mine" });
    (ctx as { call: PanelToolCtx["call"] }).call = async () => {
      dispatched++;
      return { content: [{ type: "text", text: "{}" }] };
    };

    const res = await defByName("panel_run").handler({}, ctx);
    const text = firstText(res);

    expect(dispatched).toBe(0);
    expect(res.isError).toBe(true);
    expect(text).toContain("refused to queue");
    expect(text).toContain("2 job(s)");
  });

  it("allow_duplicate:true stacks behind the unaccounted-for job — with the inspection warning after", async () => {
    qm.state.runningPromptId = "p-foreign";
    qm.state.queueRemaining = 1;

    const ctx = makeCtx({ queued: true, prompt_id: "p-mine" });
    const res = await defByName("panel_run").handler({ allow_duplicate: true }, ctx);
    const text = firstText(res);

    // The explicit override queued — and the post-queue disclosure still names
    // the work this session didn't queue (now the TOCTOU/override net).
    expect(res.isError).not.toBe(true);
    expect(qm.selfQueuedIds.has("p-mine")).toBe(true);
    expect(text).toContain("[QUEUE]");
    expect(text).toContain("didn't queue");
    expect(text).toContain('queue (action:"list")'); // leads with inspection
    expect(text).not.toContain("your own");
  });

  it("a disconnected watchdog proves nothing → the run proceeds (no fence on unknown state)", async () => {
    qm.state.connected = false;
    qm.state.runningPromptId = "p-stale"; // stale last-known state, unverifiable
    qm.state.queueRemaining = 1;

    const ctx = makeCtx({ queued: true, prompt_id: "p-solo" });
    const res = await defByName("panel_run").handler({}, ctx);
    const text = firstText(res);

    expect(res.isError).not.toBe(true);
    expect(qm.selfQueuedIds.has("p-solo")).toBe(true);
    expect(text).toContain("notified automatically");
  });

  it("nothing running → no backpressure note at all", async () => {
    qm.state.runningPromptId = null;
    qm.state.queueRemaining = 0;

    const ctx = makeCtx({ queued: true, prompt_id: "p-solo" });
    const res = await defByName("panel_run").handler({}, ctx);
    const text = firstText(res);

    expect(text).not.toContain("[QUEUE]");
    expect(text).toContain("notified automatically"); // the anti-poll note still appended
  });
});

describe("panel_screenshot DOM-overlay note (#567)", () => {
  it("flags a MarkdownNote in view as content the capture cannot show", async () => {
    const bridgeReply = (cmd: unknown): unknown => {
      const c = cmd as { cmd?: string };
      if (c.cmd === "graph_screenshot") return { image: "iVBORw0KGgo=", mimeType: "image/png" };
      if (c.cmd === "graph_serialize") {
        return { nodes: [{ id: 1, type: "MarkdownNote" }, { id: 2, type: "KSampler" }] };
      }
      return {};
    };
    const bridge = {
      send: async (cmd: unknown) => bridgeReply(cmd),
      push: () => 1,
      canReach: () => true,
    } as unknown as PanelToolCtx["bridge"];
    const ctx = makePanelToolCtx(bridge, "test-tab");

    const res = await defByName("panel_screenshot").handler({}, ctx);
    // The image still comes back…
    expect(res.content?.[0]?.type).toBe("image");
    // …plus a text note naming the DOM-overlay node.
    const note = res.content?.find((c: { type: string }) => c.type === "text")?.text ?? "";
    expect(note).toContain("MarkdownNote #1");
    expect(note).toContain("panel_query_graph");
    expect(note).toContain("EMPTY");
  });

  it("no DOM-overlay node in view → image only, no note", async () => {
    const bridge = {
      send: async (cmd: unknown) => {
        const c = cmd as { cmd?: string };
        if (c.cmd === "graph_screenshot") return { image: "iVBORw0KGgo=", mimeType: "image/png" };
        if (c.cmd === "graph_serialize") return { nodes: [{ id: 1, type: "KSampler" }] };
        return {};
      },
      push: () => 1,
      canReach: () => true,
    } as unknown as PanelToolCtx["bridge"];
    const ctx = makePanelToolCtx(bridge, "test-tab");

    const res = await defByName("panel_screenshot").handler({}, ctx);
    expect(res.content).toHaveLength(1);
    expect(res.content?.[0]?.type).toBe("image");
  });

  it("a failed graph_serialize never breaks the screenshot (note simply omitted)", async () => {
    const bridge = {
      send: async (cmd: unknown) => {
        const c = cmd as { cmd?: string };
        if (c.cmd === "graph_screenshot") return { image: "iVBORw0KGgo=", mimeType: "image/png" };
        throw new Error("serialize boom");
      },
      push: () => 1,
      canReach: () => true,
    } as unknown as PanelToolCtx["bridge"];
    const ctx = makePanelToolCtx(bridge, "test-tab");

    const res = await defByName("panel_screenshot").handler({}, ctx);
    expect(res.content?.[0]?.type).toBe("image");
  });
});

describe("domOverlayScreenshotNote (pure)", () => {
  it("is empty when no overlay nodes are present", () => {
    expect(domOverlayScreenshotNote([])).toBe("");
  });
  it("lists every overlay node and gives an id-scoped read hint", () => {
    const note = domOverlayScreenshotNote([
      { id: 1, type: "MarkdownNote" },
      { id: 5, type: "MarkdownNote" },
    ]);
    expect(note).toContain("MarkdownNote #1");
    expect(note).toContain("MarkdownNote #5");
    expect(note).toContain("ids:[1, 5]");
  });
});

// #889 — the run-error notification asserted "the workflow run you just queued"
// unconditionally, and reached a session whose agent had never called panel_run.
// Attribution is the fact the wording depends on, so it is pinned here against
// the same private state the rest of this file drives.
describe("#889: attributeRun answers three ways, and refuses to guess", () => {
  beforeEach(() => {
    qm.selfQueuedIds.clear();
    qm.lastSelfQueueTs = null;
  });

  // THE reported case: nothing queued this session, so no run can be ours.
  it("a session that has queued NOTHING owns nothing", () => {
    expect(QueueMonitor.attributeRun("9d70fd9d-1c2b-4e3f-8a01-7c6d5e4f3a2b")).toBe("not-mine");
    // …and with no id either — still provable, because the proof is about US.
    expect(QueueMonitor.attributeRun(undefined)).toBe("not-mine");
    expect(QueueMonitor.attributeRun(null)).toBe("not-mine");
  });

  it("a recorded id is ours", () => {
    QueueMonitor.markSelfQueued("p-mine");
    expect(QueueMonitor.attributeRun("p-mine")).toBe("mine");
    // Whitespace from prose extraction must not defeat the match.
    expect(QueueMonitor.attributeRun("  p-mine  ")).toBe("mine");
  });

  // The honest middle. We queued SOMETHING, so this run might be ours; our id
  // record is bounded (200) and a panel reply may carry no id at all, so an
  // unrecognised id is genuinely undecidable — not evidence of a foreign run.
  it("an unrecognised id is UNKNOWN once this session has queued anything", () => {
    QueueMonitor.markSelfQueued("p-mine");
    expect(QueueMonitor.attributeRun("p-someone-elses")).toBe("unknown");
    expect(QueueMonitor.attributeRun(undefined)).toBe("unknown");
  });

  // A queue whose reply carried no prompt_id still marks the timestamp — so the
  // session HAS queued, and must not then claim a run is not its own.
  it("an id-less self-queue still blocks the 'not-mine' claim", () => {
    QueueMonitor.markSelfQueued(null);
    expect(qm.selfQueuedIds.size).toBe(0);
    expect(QueueMonitor.attributeRun("9d70fd9d-1c2b-4e3f-8a01-7c6d5e4f3a2b")).toBe("unknown");
  });
});

// #889 — the COMPOSITION, which is what PanelAgent.injectRunError actually calls.
// Left inline in the agent it was reachable only through a full agent harness,
// and a mutation hardcoding the attribution back to "mine" (the exact regression)
// broke no test at all.
describe("#889: runErrorNotice picks its wording from real attribution", () => {
  const ERR = "Render status for prompt 9d70fd9d-1c2b-4e3f-8a01-7c6d5e4f3a2b could not be confirmed";

  beforeEach(() => {
    qm.selfQueuedIds.clear();
    qm.lastSelfQueueTs = null;
  });

  // The reported session: reads and graph edits only, never a panel_run.
  it("a session that never queued gets the non-attributing wording", () => {
    const t = runErrorNotice(ERR);
    expect(t).toMatch(/You did NOT queue this run/);
    expect(t).not.toMatch(/you just queued/);
    expect(t).not.toMatch(/STOP —/);
  });

  it("the agent's OWN failed render still gets the urgent wording", () => {
    QueueMonitor.markSelfQueued("9d70fd9d-1c2b-4e3f-8a01-7c6d5e4f3a2b");
    const t = runErrorNotice(ERR);
    expect(t).toMatch(/run you queued ERRORED/);
    expect(t).toMatch(/STOP/);
  });

  it("an unrecognised run, after this session HAS queued, is reported as undetermined", () => {
    QueueMonitor.markSelfQueued("p-something-else");
    const t = runErrorNotice(ERR);
    expect(t).toMatch(/could NOT be determined/);
    expect(t).not.toMatch(/You did NOT queue this run/);
  });
});

// #1011 — the duplicate fence made the retry token inert.
//
// After a reconnect, panel_run timed out waiting for graph_run and returned a
// retry_of rid. Re-issuing with that token hit the fence FIRST, so the panel's
// dedupe — the only thing that can settle whether the timed-out dispatch created
// the pending job — was never reached. The caller was left holding a token for
// exactly this situation with no way to spend it.
//
// The fence's own comment claims it "composes with #694's retry_of". In the order
// they actually ran, it did not: refusing before dispatch means the token cannot
// travel.
describe("#1011: an explicit retry is not a blind re-issue", () => {
  beforeEach(() => {
    qm.selfQueuedIds.clear();
    qm.lastSelfQueueTs = null;
    qm.state.connected = true;
    qm.state.runningPromptId = "p-unaccountable";
    qm.state.pendingPromptIds = [];
    qm.state.queueRemaining = 1;
  });

  it("still REFUSES a blind re-issue — the fence is unchanged without the token", async () => {
    const ctx = makeCtx({ queued: true, prompt_id: "p-new" });
    const res = await defByName("panel_run").handler({}, ctx);
    expect(res.isError).toBe(true);
    expect(firstText(res)).toMatch(/refused to queue: a render is already in flight/);
  });

  it("lets a retry_of THROUGH so the panel can reconcile it", async () => {
    const ctx = makeCtx({ queued: true, prompt_id: "p-reconciled" });
    const res = await defByName("panel_run").handler({ retry_of: "rid-abc" }, ctx);
    expect(res.isError).toBeFalsy();
    expect(firstText(res)).not.toMatch(/refused to queue/);
  });

  // Riding past a duplicate guard silently would hide the one risk the caller
  // took. The note says what was skipped and how to check it actually deduped.
  it("DISCLOSES that the fence was skipped, and how to verify", async () => {
    const ctx = makeCtx({ queued: true, prompt_id: "p-reconciled" });
    const t = firstText(await defByName("panel_run").handler({ retry_of: "rid-abc" }, ctx));
    expect(t).toMatch(/\[RETRY\]/);
    expect(t).toMatch(/duplicate fence was SKIPPED/);
    expect(t).toContain("p-unaccountable");
    // Expected, not guaranteed — the token might not match.
    expect(t).toMatch(/VERIFY that before assuming/);
    expect(t).toMatch(/one MORE job than you intended/);
  });

  it("says nothing when there was no fence to skip", async () => {
    qm.state.runningPromptId = null;
    qm.state.queueRemaining = 0;
    const ctx = makeCtx({ queued: true, prompt_id: "p-quiet" });
    const t = firstText(await defByName("panel_run").handler({ retry_of: "rid-abc" }, ctx));
    expect(t).not.toMatch(/\[RETRY\]/);
  });

  it("an empty retry_of is not an assertion and does not bypass", async () => {
    const ctx = makeCtx({ queued: true, prompt_id: "p-new" });
    const res = await defByName("panel_run").handler({ retry_of: "" }, ctx);
    expect(res.isError).toBe(true);
    expect(firstText(res)).toMatch(/refused to queue/);
  });
});
