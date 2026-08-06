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
    // The reason is stated honestly: NO RECORD of queueing it — not "you didn't
    // queue it" (the ledger does not survive a restart).
    expect(text).toContain("NO record of having queued it");
    // Actionable remedies: inspect, deliberate override, wedge escape.
    expect(text).toContain('queue (action:"list")');
    expect(text).toContain("allow_duplicate:true");
    expect(text).toContain("clear_pending:true");
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
