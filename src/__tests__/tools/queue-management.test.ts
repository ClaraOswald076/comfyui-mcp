import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { DEAD_NAMES, TOOL_NAMES } from "../../tools/vocabulary.js";

/**
 * The consolidated `queue` tool (0.49.0 slice 4): the eight queue/jobs tools
 * folded into one action-parameterized tool. Proves the consolidation did not
 * change behaviour — every action calls the identical queue-manager service the
 * old tool called, with the same arguments and the same content block — and
 * that the flat-enum shape actually EXPOSES its parameters (the
 * discriminated-union trap renders zero params).
 */

const mocks = vi.hoisted(() => ({
  getQueueSummary: vi.fn(),
  getJobStatus: vi.fn(),
  getQueuedWorkflow: vi.fn(),
  moveQueuedJob: vi.fn(),
  editQueuedJob: vi.fn(),
  cancelRunningJobEscalating: vi.fn(),
  cancelQueuedJob: vi.fn(),
  clearAllQueued: vi.fn(),
}));

vi.mock("../../services/queue-manager.js", () => ({
  getQueueSummary: (...args: unknown[]) => mocks.getQueueSummary(...args),
  getJobStatus: (...args: unknown[]) => mocks.getJobStatus(...args),
  getQueuedWorkflow: (...args: unknown[]) => mocks.getQueuedWorkflow(...args),
  moveQueuedJob: (...args: unknown[]) => mocks.moveQueuedJob(...args),
  editQueuedJob: (...args: unknown[]) => mocks.editQueuedJob(...args),
  cancelRunningJobEscalating: (...args: unknown[]) => mocks.cancelRunningJobEscalating(...args),
  cancelQueuedJob: (...args: unknown[]) => mocks.cancelQueuedJob(...args),
  clearAllQueued: (...args: unknown[]) => mocks.clearAllQueued(...args),
}));

import { registerQueueManagementTools } from "../../tools/queue-management.js";

type Handler = (args: Record<string, any>) => Promise<{
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
}>;

interface Registered {
  name: string;
  shape: z.ZodRawShape;
  handler: Handler;
}

function registered(): Registered[] {
  const tools: Registered[] = [];
  const server = {
    tool: (name: string, _desc: string, shape: z.ZodRawShape, handler: Handler) => {
      tools.push({ name, shape, handler });
    },
  };
  registerQueueManagementTools(server as never);
  return tools;
}

/** The whole queue/jobs surface is now ONE tool (0.49.0 slice 4). */
function handler(): Handler {
  const tools = registered();
  expect(tools).toHaveLength(1);
  expect(tools[0].name).toBe("queue");
  return tools[0].handler;
}

const text = (res: Awaited<ReturnType<Handler>>) => res.content.map((c) => c.text).join(" ");

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
});

describe("queue registration", () => {
  it("registers exactly one tool named `queue` (8→1)", () => {
    const tools = registered();
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("queue");
  });

  // The whole reason for the flat-enum shape rule: a z.discriminatedUnion renders
  // as ZERO parameters, hiding every input from the model.
  it("exposes a visible flat `action` enum with every per-action parameter", () => {
    const [{ shape }] = registered();
    // io: "input" — the conversion options the MCP SDK itself uses
    // (sdk/server/zod-json-schema-compat.js, asserted by docs-schema-parity.test.ts),
    // so this is the schema a client is actually given.
    const json = z.toJSONSchema(z.object(shape), { reused: "inline", io: "input" }) as {
      properties?: Record<string, { enum?: string[] }>;
      required?: string[];
    };
    expect(Object.keys(json.properties ?? {}).sort()).toEqual([
      "action",
      "clear_pending",
      "include_workflows",
      "node_inputs",
      "position",
      "prompt_id",
      "workflow",
    ]);
    expect(json.properties?.action.enum?.sort()).toEqual([
      "cancel",
      "cancel_queued",
      "clear",
      "edit",
      "get_workflow",
      "list",
      "move",
      "status",
    ]);
    // Only `action` can be required — the rest are per-action, enforced in the handler.
    expect(json.required).toEqual(["action"]);
  });

  it("an unknown action returns a clear error result", async () => {
    const res = await handler()({ action: "bogus" });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/unknown queue action/i);
    expect(text(res)).toMatch(/cancel_queued/);
  });
});

describe("queue actions call the same services with the same arguments", () => {
  it('action:"list" passes include_workflows through and returns the summary JSON', async () => {
    mocks.getQueueSummary.mockResolvedValueOnce({ pending: 2, running: 1 });
    const res = await handler()({ action: "list", include_workflows: true });
    expect(mocks.getQueueSummary).toHaveBeenCalledWith({ include_workflows: true });
    expect(JSON.parse(text(res))).toEqual({ pending: 2, running: 1 });

    mocks.getQueueSummary.mockResolvedValueOnce({ pending: 0, running: 0 });
    await handler()({ action: "list" });
    expect(mocks.getQueueSummary).toHaveBeenCalledWith({ include_workflows: undefined });
  });

  it('action:"status" returns the job status JSON for the prompt_id', async () => {
    mocks.getJobStatus.mockResolvedValueOnce({ running: true, pending: false, done: false });
    const res = await handler()({ action: "status", prompt_id: "p1" });
    expect(mocks.getJobStatus).toHaveBeenCalledWith("p1");
    expect(JSON.parse(text(res))).toEqual({ running: true, pending: false, done: false });
  });

  it('action:"get_workflow" returns the pending item JSON', async () => {
    mocks.getQueuedWorkflow.mockResolvedValueOnce({ prompt_id: "p1", workflow: {} });
    const res = await handler()({ action: "get_workflow", prompt_id: "p1" });
    expect(mocks.getQueuedWorkflow).toHaveBeenCalledWith("p1");
    expect(JSON.parse(text(res))).toEqual({ prompt_id: "p1", workflow: {} });
  });

  it('action:"move" requeues front/back and returns the result JSON', async () => {
    mocks.moveQueuedJob.mockResolvedValueOnce({ old_prompt_id: "p1", new_prompt_id: "p2" });
    const res = await handler()({ action: "move", prompt_id: "p1", position: "front" });
    expect(mocks.moveQueuedJob).toHaveBeenCalledWith("p1", "front");
    expect(JSON.parse(text(res))).toEqual({ old_prompt_id: "p1", new_prompt_id: "p2" });
  });

  it('action:"edit" forwards workflow/node_inputs/position exactly as before', async () => {
    mocks.editQueuedJob.mockResolvedValueOnce({ old_prompt_id: "p1", new_prompt_id: "p3" });
    const res = await handler()({
      action: "edit",
      prompt_id: "p1",
      node_inputs: { "2": { steps: 12 } },
      position: "back",
    });
    expect(mocks.editQueuedJob).toHaveBeenCalledWith({
      prompt_id: "p1",
      workflow: undefined,
      node_inputs: { "2": { steps: 12 } },
      position: "back",
    });
    expect(JSON.parse(text(res))).toEqual({ old_prompt_id: "p1", new_prompt_id: "p3" });
  });

  it('action:"cancel" returns the escalation message as text, and isError when wedged', async () => {
    mocks.cancelRunningJobEscalating.mockResolvedValueOnce({
      wedged: false,
      target_state: "stopped",
      message: "Job interrupted.",
    });
    const ok = await handler()({ action: "cancel", prompt_id: "p1", clear_pending: true });
    expect(mocks.cancelRunningJobEscalating).toHaveBeenCalledWith({
      prompt_id: "p1",
      clear_pending: true,
    });
    expect(ok.isError).toBeUndefined();
    expect(text(ok)).toBe("Job interrupted.");

    mocks.cancelRunningJobEscalating.mockResolvedValueOnce({
      wedged: true,
      target_state: "running",
      message: "WEDGED — restart.",
    });
    const wedged = await handler()({ action: "cancel" });
    expect(mocks.cancelRunningJobEscalating).toHaveBeenCalledWith({
      prompt_id: undefined,
      clear_pending: undefined,
    });
    expect(wedged.isError).toBe(true);
    expect(text(wedged)).toBe("WEDGED — restart.");
  });

  // The tri-state reached the service in #839 but not this consumer: `isError`
  // keyed off `wedged` alone, so an unreadable /queue — reported honestly by
  // the service as target_state:"unknown", wedged:false — came back as an MCP
  // SUCCESS. A caller reads that as permission to queue more work against a
  // queue whose state nobody established.
  describe('action:"cancel" only reports success for an outcome /queue settled', () => {
    it("an unreadable queue is NOT a success — and the disclosure survives", async () => {
      mocks.cancelRunningJobEscalating.mockResolvedValueOnce({
        wedged: false,
        unverified: true,
        target_state: "unknown",
        message: "⚠️ /queue did not answer during verification, so whether it is still running is UNKNOWN.",
      });
      const res = await handler()({ action: "cancel" });
      expect(res.isError).toBe(true);
      // isError marks the outcome unsettled; it must not swallow the detail,
      // which is the only thing telling the caller what to check.
      expect(text(res)).toMatch(/UNKNOWN/);
    });

    it("a clear_pending that FAILED is not a success either", async () => {
      mocks.cancelRunningJobEscalating.mockResolvedValueOnce({
        wedged: false,
        target_state: "stopped",
        pending_clear_failed: true,
        message: "Interrupted the running job. Clearing pending jobs FAILED — they may still be queued.",
      });
      const res = await handler()({ action: "cancel", clear_pending: true });
      expect(res.isError).toBe(true);
      expect(text(res)).toMatch(/FAILED/);
    });

    // THE INVERSE, which is how this fix would overshoot: `unverified` also
    // covers "it demonstrably stopped, we just cannot say our interrupt is
    // why". /queue was read and is empty. Failing that would refuse a caller
    // the queue it can see is free.
    it("a verifiably empty queue is a success even when the CAUSE is unverified", async () => {
      mocks.cancelRunningJobEscalating.mockResolvedValueOnce({
        wedged: false,
        unverified: true,
        target_state: "stopped",
        message:
          "Nothing is running now (verified via /queue), but the queue could not be read " +
          "BEFORE the interrupt, so what stopped it is UNKNOWN.",
      });
      const res = await handler()({ action: "cancel" });
      expect(res.isError).toBeUndefined();
      expect(text(res)).toMatch(/verified via \/queue/);
    });
  });

  it('action:"cancel_queued" returns the exact prose confirmation', async () => {
    const res = await handler()({ action: "cancel_queued", prompt_id: "p1" });
    expect(mocks.cancelQueuedJob).toHaveBeenCalledWith("p1");
    expect(text(res)).toBe("Queued job p1 removed successfully.");
  });

  it('action:"clear" returns the exact prose confirmation', async () => {
    const res = await handler()({ action: "clear" });
    expect(mocks.clearAllQueued).toHaveBeenCalled();
    expect(text(res)).toBe("All pending queue items cleared successfully.");
  });
});

describe("per-action presence guards (the flat shape cannot schema-require these)", () => {
  it("prompt_id-less status/get_workflow/move/edit/cancel_queued name the missing field and call nothing", async () => {
    for (const action of ["status", "get_workflow", "move", "edit", "cancel_queued"]) {
      const res = await handler()({ action });
      expect(res.isError).toBe(true);
      expect(text(res)).toContain(`action:"${action}" requires \`prompt_id\``);
    }
    for (const mock of Object.values(mocks)) expect(mock).not.toHaveBeenCalled();
  });

  it('action:"move" without a position names it and calls nothing', async () => {
    const res = await handler()({ action: "move", prompt_id: "p1" });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('action:"move" requires `position`');
    expect(mocks.moveQueuedJob).not.toHaveBeenCalled();
  });

  // The guard tests ABSENCE, not falsiness: an empty prompt_id passed z.string()
  // before this consolidation and reached the service, which answers with its own
  // not-found/validation error. A `!prompt_id` guard would swallow that path.
  it("an explicitly empty prompt_id still reaches the service, as before", async () => {
    mocks.getJobStatus.mockResolvedValueOnce({ running: false, pending: false, done: false });
    await handler()({ action: "status", prompt_id: "" });
    expect(mocks.getJobStatus).toHaveBeenCalledWith("");
  });
});

describe("the eight queue/jobs names are retired", () => {
  const old = [
    "get_queue",
    "get_queued_workflow",
    "move_queued_job",
    "edit_queued_job",
    "get_job_status",
    "cancel_job",
    "cancel_queued_job",
    "clear_queue",
  ];

  it("each old name is in DEAD_NAMES with replacement `queue`", () => {
    for (const name of old) {
      const entry = DEAD_NAMES.find((d) => d.name === name);
      expect(entry, `${name} must be declared dead`).toBeDefined();
      expect(entry!.since).toBe("0.49.0");
      expect(entry!.replacement).toContain("queue");
    }
  });

  it("no old name is still in the live ledger, and `queue` is", () => {
    for (const name of old) expect(TOOL_NAMES as readonly string[]).not.toContain(name);
    expect(TOOL_NAMES as readonly string[]).toContain("queue");
  });
});
