import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DEAD_NAMES, TOOL_NAMES } from "../../tools/vocabulary.js";

// ── Mock the shared services the batch tools MUST reuse ─────────────────────
// enqueue path, status source, and history/output retrieval are all mocked at
// the same module seams the real enqueue_workflow / get_job_status /
// get_history tools use — proving batches.ts shares those services.

const state = vi.hoisted(() => ({
  enqueued: [] as Array<Record<string, unknown>>,
  nextPromptId: 0,
  statuses: new Map<string, { running: boolean; pending: boolean; done: boolean; status_str?: string; error?: { node_id: string; node_type: string; exception_message: string } }>(),
  histories: new Map<string, Record<string, unknown>>(),
}));

vi.mock("../../services/workflow-executor.js", () => ({
  enqueueWorkflow: vi.fn(async (workflow: Record<string, unknown>) => {
    state.enqueued.push(workflow);
    const prompt_id = `prompt-${++state.nextPromptId}`;
    state.statuses.set(prompt_id, { running: false, pending: true, done: false });
    return { prompt_id, queue_remaining: state.nextPromptId };
  }),
}));

vi.mock("../../services/queue-manager.js", () => ({
  getJobStatus: vi.fn(async (promptId: string) => {
    const s = state.statuses.get(promptId);
    if (!s) return { running: false, pending: false, done: false };
    return s;
  }),
}));

vi.mock("../../comfyui/client.js", () => ({
  getHistory: vi.fn(async (promptId: string) => {
    const outputs = state.histories.get(promptId);
    if (!outputs) return {};
    return {
      [promptId]: {
        prompt: {},
        outputs,
        status: { status_str: "success", completed: true, messages: [] },
      },
    };
  }),
}));

// ── Fake McpServer that captures tool handlers ───────────────────────────────

type ToolHandler = (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }>;

interface Registered {
  name: string;
  shape: Record<string, unknown>;
  handler: ToolHandler;
}

function fakeServer(): { server: McpServer; tools: Registered[] } {
  const tools: Registered[] = [];
  const server = {
    tool: (name: string, _desc: string, shape: Record<string, unknown>, handler: ToolHandler) => {
      tools.push({ name, shape, handler });
    },
  } as unknown as McpServer;
  return { server, tools };
}

function parse(result: { content: Array<{ type: string; text?: string }> }): Record<string, unknown> {
  return JSON.parse(result.content[0].text ?? "{}") as Record<string, unknown>;
}

const WF = { "3": { class_type: "KSampler", inputs: { cfg: 7, seed: 1 } } };

describe("batch tools", () => {
  let dataDir: string;
  const OLD_ENV = process.env;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "batches-test-"));
    process.env = { ...OLD_ENV, COMFYUI_MCP_DATA_DIR: dataDir };
    state.enqueued = [];
    state.nextPromptId = 0;
    state.statuses.clear();
    state.histories.clear();
  });

  afterEach(() => {
    process.env = OLD_ENV;
    rmSync(dataDir, { recursive: true, force: true });
  });

  /** The whole batch surface is now ONE tool (0.49.0 slice 2), so registering
   *  yields a single action-dispatching handler. */
  async function registerTools(): Promise<Registered[]> {
    const { registerBatchTools } = await import("../../tools/batches.js");
    const { server, tools } = fakeServer();
    registerBatchTools(server);
    return tools;
  }

  async function handler(): Promise<ToolHandler> {
    const tools = await registerTools();
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("batch");
    return tools[0].handler;
  }

  it("submit → status → output round-trip with mocked ComfyUI", async () => {
    const batch = await handler();

    // submit: array-of-workflows form
    const submitted = parse(await batch({ action: "submit", workflows: [WF, WF, WF] }));
    expect(submitted.count).toBe(3);
    expect((submitted.prompt_ids as string[]).length).toBe(3);
    const batchId = submitted.batch_id as string;
    expect(batchId).toMatch(/^batch_/);
    expect(state.enqueued.length).toBe(3);

    // status: all pending initially
    let status = parse(await batch({ action: "status", batch_id: batchId }));
    expect((status.rollup as Record<string, number>).pending).toBe(3);
    expect(status.all_terminal).toBe(false);

    // advance: 1 done with outputs, 1 error, 1 running
    const [p1, p2, p3] = submitted.prompt_ids as string[];
    state.statuses.set(p1, { running: false, pending: false, done: true, status_str: "success" });
    state.histories.set(p1, { "9": { images: [{ filename: "out_00001.png", subfolder: "", type: "output" }] } });
    state.statuses.set(p2, {
      running: false, pending: false, done: true,
      error: { node_id: "3", node_type: "KSampler", exception_message: "OOM" },
    });
    state.statuses.set(p3, { running: true, pending: false, done: false });

    status = parse(await batch({ action: "status", batch_id: batchId }));
    const rollup = status.rollup as Record<string, number>;
    expect(rollup.done).toBe(1);
    expect(rollup.error).toBe(1);
    expect(rollup.running).toBe(1);
    expect(status.all_terminal).toBe(false);

    // output: only the done job carries outputs; error job carries the message
    const output = parse(await batch({ action: "output", batch_id: batchId }));
    expect(output.completed).toBe(1);
    const jobs = output.outputs as Array<Record<string, unknown>>;
    const doneJob = jobs.find((j) => j.prompt_id === p1)!;
    expect(JSON.stringify(doneJob.outputs)).toContain("out_00001.png");
    const errJob = jobs.find((j) => j.prompt_id === p2)!;
    expect(errJob.state).toBe("error");
    expect(errJob.error_message).toBe("OOM");
  });

  it("param sweep applies each override set to nodes that have the input", async () => {
    const batch = await handler();
    const submitted = parse(await batch({
      action: "submit",
      workflow: WF,
      sweep: [{ cfg: 4 }, { cfg: 9, nonexistent_input: 1 }],
      disable_random_seed: true,
    }));
    expect(submitted.count).toBe(2);
    expect(state.enqueued.length).toBe(2);
    const cfg = (i: number) => (state.enqueued[i]["3"] as { inputs: Record<string, unknown> }).inputs.cfg;
    expect(cfg(0)).toBe(4);
    expect(cfg(1)).toBe(9);
    // override for an input no node has must not create it
    expect("nonexistent_input" in (state.enqueued[1]["3"] as { inputs: Record<string, unknown> }).inputs).toBe(false);
  });

  it("rejects bad input shapes", async () => {
    const batch = await handler();
    const r1 = await batch({ action: "submit" });
    expect(r1.isError).toBe(true);
    const r2 = await batch({ action: "submit", workflows: [WF], workflow: WF, sweep: [{}] });
    expect(r2.isError).toBe(true);
    const r3 = await batch({ action: "status", batch_id: "batch_nope" });
    expect(r3.isError).toBe(true);
    // batch_id cannot be schema-required in a flat enum shape, so the handler
    // enforces it for every polling action.
    for (const action of ["status", "output", "wait"]) {
      const missing = await batch({ action });
      expect(missing.isError).toBe(true);
      expect(missing.content[0].text).toContain("requires `batch_id`");
    }
  });

  it("DURABILITY: batch_id persisted to disk and valid after a module reload (simulated restart)", async () => {
    const batch = await handler();
    const submitted = parse(await batch({ action: "submit", workflows: [WF, WF] }));
    const batchId = submitted.batch_id as string;

    // Real file on disk, valid JSON (one file per batch, atomic rename)
    const file = join(dataDir, "batches", `${batchId}.json`);
    expect(existsSync(file)).toBe(true);
    const onDisk = JSON.parse(readFileSync(file, "utf8"));
    expect(onDisk.prompt_ids).toEqual(submitted.prompt_ids);

    // Simulate a server restart: drop all module state, re-register tools
    vi.resetModules();
    const batch2 = await handler();
    const status = parse(await batch2({ action: "status", batch_id: batchId }));
    expect(status.batch_id).toBe(batchId);
    expect(status.count).toBe(2);
  });

  it("concurrent submits don't clobber each other's persisted record", async () => {
    const batch = await handler();
    const [a, b, c] = await Promise.all([
      batch({ action: "submit", workflows: [WF] }),
      batch({ action: "submit", workflows: [WF] }),
      batch({ action: "submit", workflows: [WF] }),
    ]);
    for (const r of [a, b, c]) {
      const id = parse(r).batch_id as string;
      const onDisk = JSON.parse(readFileSync(join(dataDir, "batches", `${id}.json`), "utf8"));
      expect(onDisk.prompt_ids).toHaveLength(1);
    }
  });

  // timeout_s must reach the service: a caller-supplied 0.5s has to win over the
  // 300s default, and the wait branch has to return the status rollup plus the
  // wait fields. Asserted behaviourally (a dropped parameter would hang here for
  // five minutes rather than return in under a second).
  it('action:"wait" forwards timeout_s and returns the rollup + wait fields', async () => {
    const batch = await handler();
    const submitted = parse(await batch({ action: "submit", workflows: [WF] }));
    const id = submitted.batch_id as string;

    const start = Date.now();
    const timedOut = parse(await batch({ action: "wait", batch_id: id, timeout_s: 0.5 }));
    expect(Date.now() - start).toBeLessThan(10_000);
    expect(timedOut.timed_out).toBe(true);
    expect(timedOut.waited_s).toBeDefined();
    expect(timedOut.rollup).toBeDefined();

    state.statuses.set((submitted.prompt_ids as string[])[0], {
      running: false, pending: false, done: true,
    });
    const done = parse(await batch({ action: "wait", batch_id: id, timeout_s: 5 }));
    expect(done.timed_out).toBe(false);
    expect(done.all_terminal).toBe(true);
  });

  it('action:"wait" returns when all terminal, and cannot exceed its timeout (hard cap)', async () => {
    const { submitBatch, waitForBatch } = await import("../../services/batch-manager.js");
    const submitted = await submitBatch({ workflows: [WF] });
    const [p1] = submitted.prompt_ids;

    // Case 1: job never finishes → returns timed_out at the (tiny) timeout
    const start = Date.now();
    const timedOut = await waitForBatch(submitted.batch_id, 0.3, 50);
    expect(timedOut.timed_out).toBe(true);
    expect(Date.now() - start).toBeLessThan(5000);

    // Case 2: job finishes mid-wait → returns promptly with all_terminal
    setTimeout(() => {
      state.statuses.set(p1, { running: false, pending: false, done: true });
    }, 100);
    const doneResult = await waitForBatch(submitted.batch_id, 10, 50);
    expect(doneResult.timed_out).toBe(false);
    expect(doneResult.all_terminal).toBe(true);
    expect(doneResult.rollup.done).toBe(1);
  });

  it('action:"wait" hard cap holds even when a status fetch stalls forever', async () => {
    const { submitBatch, waitForBatch } = await import("../../services/batch-manager.js");
    const { getJobStatus } = await import("../../services/queue-manager.js");
    const submitted = await submitBatch({ workflows: [WF] });

    // Simulate a wedged ComfyUI: status calls never resolve.
    vi.mocked(getJobStatus).mockImplementation(() => new Promise(() => undefined));

    const start = Date.now();
    const result = await waitForBatch(submitted.batch_id, 0.3, 50);
    expect(Date.now() - start).toBeLessThan(5000);
    expect(result.timed_out).toBe(true);
    expect(result.rollup.unknown).toBe(1);
  });

  // The whole reason for the flat-enum shape rule: a z.discriminatedUnion renders
  // as ZERO parameters, hiding every input from the model.
  it("exposes a visible flat `action` enum with every per-action parameter", async () => {
    const tools = await registerTools();
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("batch");
    const json = z.toJSONSchema(z.object(tools[0].shape as z.ZodRawShape)) as {
      properties?: Record<string, { enum?: string[] }>;
      required?: string[];
    };
    expect(Object.keys(json.properties ?? {}).sort()).toEqual([
      "action", "batch_id", "disable_random_seed", "sweep", "timeout_s", "workflow", "workflows",
    ]);
    expect(json.properties?.action.enum?.sort()).toEqual(["output", "status", "submit", "wait"]);
    // Only `action` can be required — the rest are per-action, enforced in the handler.
    expect(json.required).toEqual(["action"]);
  });

  it("an unknown action returns a clear error result", async () => {
    const batch = await handler();
    const res = await batch({ action: "bogus" });
    expect(res.isError).toBe(true);
    const text = res.content.map((c) => c.text).join(" ");
    expect(text).toMatch(/unknown batch action/i);
    expect(text).toMatch(/submit, status, output, wait/);
  });

});

describe("the four batch names are retired", () => {
  const old = ["submit_batch", "get_batch_status", "get_batch_output", "wait_for_batch"];

  it("each old name is in DEAD_NAMES with replacement `batch`", () => {
    for (const name of old) {
      const entry = DEAD_NAMES.find((d) => d.name === name);
      expect(entry, `${name} must be declared dead`).toBeDefined();
      expect(entry!.since).toBe("0.49.0");
      expect(entry!.replacement).toContain("batch");
    }
  });

  it("no old name is still in the live ledger, and `batch` is", () => {
    for (const name of old) expect(TOOL_NAMES as readonly string[]).not.toContain(name);
    expect(TOOL_NAMES as readonly string[]).toContain("batch");
  });
});
