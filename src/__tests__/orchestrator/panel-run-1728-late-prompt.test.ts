// panel#1728 — a normal Panel queued_unknown reply can arrive before the
// scoped /prompt request has exposed its prompt id. The MCP consumer must use
// the existing bounded queue receipt path, then open the ordinary journal ticket.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildPanelToolDefs, makePanelToolCtx, type PanelToolCtx } from "../../orchestrator/panel-tools.js";
import { RunCompletions } from "../../orchestrator/run-completion-journal.js";
import { QueueMonitor } from "../../services/queue-monitor.js";

type QueueMonitorPrivate = {
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

const qm = QueueMonitor as unknown as QueueMonitorPrivate;

function panelRun() {
  const def = buildPanelToolDefs().find((candidate) => candidate.name === "panel_run");
  if (!def) throw new Error("panel_run tool not found");
  return def;
}

function textOf(res: { content?: Array<{ type: string; text?: string }> }): string {
  return res.content?.find((content) => content.type === "text")?.text ?? "";
}

beforeEach(() => {
  RunCompletions.reset();
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
  RunCompletions.reset();
  qm.selfQueuedIds.clear();
  qm.lastSelfQueueTs = null;
  qm.state.runningPromptId = null;
  qm.state.pendingPromptIds = [];
  qm.state.queueRemaining = 0;
});

describe("panel_run late prompt reconciliation (#1728)", () => {
  it("turns an id-less queued_unknown receipt into one ticket without redispatch", async () => {
    let calls = 0;
    let receiptTaken = false;
    const bridge = {
      send: async () => ({}),
      canReach: () => true,
      peekLateRunReceipt: (runRid: string) =>
        runRid === "run-rid-1728"
          ? { runRid, tabId: "panel-1728", promptIds: ["prompt-1728"], lateByMs: 25 }
          : undefined,
      takeLateRunReceipt: (runRid: string) => {
        if (runRid !== "run-rid-1728" || receiptTaken) return undefined;
        receiptTaken = true;
        return { runRid, tabId: "panel-1728", promptIds: ["prompt-1728"], lateByMs: 25 };
      },
    } as unknown as PanelToolCtx["bridge"];
    const ctx = makePanelToolCtx(bridge, "panel-1728");
    ctx.call = async (_cmd, _timeout, observeRid) => {
      calls++;
      observeRid?.("run-rid-1728");
      // This is the late watchdog observation: the Panel has already answered
      // queued_unknown, but a new prompt is now visible after this dispatch.
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              queued_unknown: true,
              indeterminate_count: 1,
              inFlight: 1,
              error: "scoped dispatch budget expired before prompt_id arrived",
            }),
          },
        ],
      };
    };

    const res = await panelRun().handler({ to_node_id: 38 }, ctx);
    const text = textOf(res);

    expect(calls).toBe(1);
    expect(res.isError).toBeFalsy();
    expect(text).toMatch(/"prompt_id"\s*:\s*"prompt-1728"/);
    expect(text).toContain("[RECOVERED]");
    expect(text).toContain("completion ticket");
    expect(RunCompletions.ticketFor("prompt-1728")?.promptId).toBe("prompt-1728");
    expect(receiptTaken).toBe(true);

    // The real journal path now correlates the later bridge executed frame to
    // the ticket, and its pending coalescer keeps duplicate frames to one entry.
    const ticket = RunCompletions.ticketFor("prompt-1728");
    const first = RunCompletions.record(
      "panel-1728",
      { kind: "executed", prompt_id: "prompt-1728", images: [{ filename: "out.png" }] },
      ticket?.conversation === undefined ? undefined : { conversation: ticket.conversation },
    );
    const second = RunCompletions.record(
      "panel-1728",
      { kind: "executed", prompt_id: "prompt-1728", images: [{ filename: "out.png" }] },
      ticket?.conversation === undefined ? undefined : { conversation: ticket.conversation },
    );
    expect(first.correlation.status).toBe("matched");
    expect(second.correlation.status).toBe("matched");
    const frames: unknown[] = [];
    RunCompletions.deliverPending("panel-1728", (payload) => {
      frames.push(payload);
      return true;
    });
    expect(frames).toHaveLength(1);
  });

  it("does not infer a full-graph queued_unknown result from a queue observation", async () => {
    const bridge = {
      send: async () => ({}),
      canReach: () => true,
    } as unknown as PanelToolCtx["bridge"];
    const ctx = makePanelToolCtx(bridge, "panel-1728-full");
    ctx.call = async () => {
      qm.state.runningPromptId = "prompt-full-foreign";
      qm.state.queueRemaining = 1;
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ queued_unknown: true, indeterminate_count: 1 }),
          },
        ],
      };
    };

    const res = await panelRun().handler({}, ctx);

    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toContain("no completion ticket can be opened");
    expect(RunCompletions.ticketFor("prompt-full-foreign")).toBeUndefined();
  });
});
