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
    const bridge = {
      send: async () => ({}),
      canReach: () => true,
    } as unknown as PanelToolCtx["bridge"];
    const ctx = makePanelToolCtx(bridge, "panel-1728");
    ctx.call = async () => {
      calls++;
      // This is the late watchdog observation: the Panel has already answered
      // queued_unknown, but a new prompt is now visible after this dispatch.
      qm.state.runningPromptId = "prompt-1728";
      qm.state.queueRemaining = 1;
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
    expect(text).toContain("opening its completion ticket");
    expect(RunCompletions.ticketFor("prompt-1728")?.promptId).toBe("prompt-1728");
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
