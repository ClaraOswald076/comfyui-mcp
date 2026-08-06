import { describe, expect, it, beforeEach, vi } from "vitest";

const enqueueWorkflowMock = vi.fn(async () => ({
  prompt_id: "pid-1",
  queue_remaining: 0,
}));
vi.mock("../../services/workflow-executor.js", () => ({
  enqueueWorkflow: (...a: unknown[]) => enqueueWorkflowMock(...a),
  getSystemInfo: vi.fn(),
}));

// generation-tracker is used by enqueue_workflow; stub it so registering the
// tools doesn't pull in real tracker state.
vi.mock("../../services/generation-tracker.js", () => ({
  getTracker: () => ({
    fileHasher: {},
    logGeneration: () => ({ settingsHash: "x", reuseCount: 0 }),
  }),
}));
vi.mock("../../services/workflow-settings-extractor.js", () => ({
  extractSettings: async () => null,
}));

import { registerWorkflowExecuteTools } from "../../tools/workflow-execute.js";

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
}>;

function getHandler(name: string): ToolHandler {
  let handler: ToolHandler | undefined;
  const server = {
    tool: (n: string, _d: string, _s: unknown, h: ToolHandler) => {
      if (n === name) handler = h;
    },
  };
  registerWorkflowExecuteTools(server as never);
  if (!handler) throw new Error(`tool ${name} not registered`);
  return handler;
}

beforeEach(() => {
  enqueueWorkflowMock.mockClear();
});

describe("enqueue_workflow seed handling (#865)", () => {
  it("never re-randomizes the caller's seeds, with no flag set", async () => {
    const workflow = {
      "1": { class_type: "ClaudeNode", inputs: { prompt: "hi", seed: 1 } },
    };
    const res = await getHandler("enqueue_workflow")({ workflow });
    expect(res.isError).toBeFalsy();
    // Every seed in a caller-built workflow is caller-fixed: the executor is
    // told to leave all values exactly as supplied.
    expect(enqueueWorkflowMock).toHaveBeenCalledWith(workflow, {
      disable_random_seed: true,
    });
  });
});
