import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  submitBatch,
  batchStatus,
  batchOutput,
  waitForBatch,
  WAIT_HARD_CAP_S,
} from "../services/batch-manager.js";
import type { WorkflowJSON } from "../comfyui/types.js";
import { errorToToolResult } from "../utils/errors.js";

const json = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
});

/**
 * The four batch tools collapsed into one action-parameterized `batch` tool
 * (0.49.0 surface consolidation, slice 2).
 *
 * SHAPE: a FLAT object with an `action` enum — deliberately NOT a
 * z.discriminatedUnion, which the MCP SDK renders as a schema with ZERO visible
 * parameters, hiding every input from the model.
 *
 * REQUIREDNESS: only `action` can be schema-required — `batch_id` is required for
 * status/output/wait and meaningless for submit, and the submit inputs are the
 * other way round. Every VALUE constraint the old tools had is unchanged at the
 * zod layer; the handler enforces per-action presence. The submit branch still
 * delegates its "workflows XOR workflow+sweep" check to submitBatch(), which is
 * where it always lived. Each branch calls the same service function the old tool
 * called and returns the identical JSON block.
 */
export function registerBatchTools(server: McpServer): void {
  server.tool(
    "batch",
    "Run MANY ComfyUI workflows under one durable batch_id. Driven by the `action` parameter:\n" +
      '- action:"submit" — Enqueue a batch. Provide EITHER `workflows` (array of API-format workflows) OR one `workflow` plus a `sweep` (array of flat input-override sets — each set produces one job, applied to every node that already has that input, like create_workflow (action:"modify")). Reuses the enqueue_workflow path (seeds re-randomized unless disable_random_seed). Returns { batch_id, count, prompt_ids }; the mapping is persisted to disk and stays valid across server restarts.\n' +
      '- action:"status" — Per-job status for `batch_id`: each prompt_id\'s state (pending/running/done/error/unknown) plus rollup counts and all_terminal. Same status source as queue (action:"status").\n' +
      '- action:"output" — Collected outputs for the batch\'s COMPLETED jobs: for each done prompt_id, the raw ComfyUI history `outputs` (node id → images/videos/audio filenames, same data get_history reports — feed filenames to get_image). Jobs still pending/running are listed with their state; errored jobs carry the error message. Safe to call before the batch finishes.\n' +
      `- action:"wait" — Block until every job is terminal (done or error) or \`timeout_s\` elapses, then return the same rollup as action:"status" plus timed_out/waited_s. Default timeout 300s, hard cap ${WAIT_HARD_CAP_S}s — it can never hang; if timed_out is true, call it again or poll action:"status".\n` +
      "Batch ids are durable — they survive server restarts.",
    {
      action: z
        .enum(["submit", "status", "output", "wait"])
        .describe(
          'Which batch operation to perform. "submit" takes workflows | workflow+sweep; "status"/"output"/"wait" each require `batch_id` ("wait" also takes `timeout_s`).',
        ),
      workflows: z
        .array(z.record(z.string(), z.any()))
        .optional()
        .describe('action:"submit" — array of ComfyUI workflows in API format (node ID -> {class_type, inputs}). Mutually exclusive with workflow+sweep.'),
      workflow: z
        .record(z.string(), z.any())
        .optional()
        .describe('action:"submit" — one base workflow in API format, used with `sweep`.'),
      sweep: z
        .array(z.record(z.string(), z.any()))
        .optional()
        .describe('action:"submit" — param sweep: one job per override set, e.g. [{"cfg":6},{"cfg":8,"steps":30}]. Each key is set on every node that already has that input.'),
      disable_random_seed: z
        .boolean()
        .optional()
        .describe('action:"submit" — if true, do not randomize seed values (default randomizes per job).'),
      batch_id: z
        .string()
        .optional()
        .describe('The batch_id returned by action:"submit". Required for actions "status", "output" and "wait".'),
      timeout_s: z
        .number()
        .optional()
        .describe(`action:"wait" — max seconds to wait (default 300, hard cap ${WAIT_HARD_CAP_S}).`),
    },
    async (args) => {
      try {
        // The three polling actions all key off batch_id, which the flat schema
        // cannot mark required. Same message the schema used to produce, so a
        // caller that omits it is told exactly what to add.
        //
        // ABSENCE only, never falsiness: `batch_id: ""` passed z.string() before
        // and reached loadBatch(), which rejects it with a structured
        // ValidationError naming the expected batch_<uuid> shape. A `!batch_id`
        // guard would replace that with generic text. Only an OMITTED batch_id is
        // the case the schema used to catch.
        const requireBatchId = (action: string): string => {
          if (args.batch_id === undefined) {
            throw new Error(
              `batch action:"${action}" requires \`batch_id\` — the id returned by action:"submit".`,
            );
          }
          return args.batch_id;
        };

        switch (args.action) {
          case "submit":
            return json(
              await submitBatch({
                workflows: args.workflows as WorkflowJSON[] | undefined,
                workflow: args.workflow as WorkflowJSON | undefined,
                sweep: args.sweep,
                disable_random_seed: args.disable_random_seed,
              }),
            );
          case "status":
            return json(await batchStatus(requireBatchId("status")));
          case "output":
            return json(await batchOutput(requireBatchId("output")));
          case "wait":
            return json(await waitForBatch(requireBatchId("wait"), args.timeout_s));
          default: {
            // Unreachable given the zod enum, but a clear runtime guard beats a
            // silent undefined if the schema and switch ever drift apart.
            const exhaustive: never = args.action;
            throw new Error(
              `Unknown batch action "${String(exhaustive)}". Expected one of: submit, status, output, wait.`,
            );
          }
        }
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}
