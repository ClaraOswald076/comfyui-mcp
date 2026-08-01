// panel_run backpressure note (#559) + panel_screenshot DOM-overlay note (#567).
//
// #559: queuing a batch is normal. A queue made of the agent's OWN recent jobs must
//       be reported NEUTRALLY, never as a "[QUEUE WARNING] … cancel_job
//       clear_pending:true" that would wipe the whole batch. A job we did NOT queue
//       still drives a (softened) warning.
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
    expect(text).toContain("Only use cancel_job with clear_pending:true if a render is ACTUALLY wedged");
    // The successful queue registered p-batch-2 for the NEXT run's attribution.
    expect(qm.selfQueuedIds.has("p-batch-2")).toBe(true);
  });

  it("a job we did NOT queue running ahead → softened warning that leads with inspection", async () => {
    qm.state.runningPromptId = "p-foreign";
    qm.state.queueRemaining = 1; // just the foreign running job

    const ctx = makeCtx({ queued: true, prompt_id: "p-mine" });
    const res = await defByName("panel_run").handler({}, ctx);
    const text = firstText(res);

    expect(text).toContain("[QUEUE]");
    expect(text).toContain("didn't queue");
    expect(text).toContain("get_queue"); // lead with inspection
    expect(text).not.toContain("your own");
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
