import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AssetRegistry, applyOverrides } from "../services/asset-registry.js";
import { enqueueWorkflow } from "../services/workflow-executor.js";
import { errorToToolResult } from "../utils/errors.js";

/**
 * What is left of the asset tool group after the 0.50.0 slice 15 fold.
 *
 * The three READ tools that lived here — the inline viewer, the registry
 * listing and the provenance reader — became actions on `get_image`
 * (src/tools/image-management.ts), which is where the rest of the image/asset
 * read surface already was. `regenerate` stays: it ENQUEUES a render, so it
 * belongs to the generation family (slice 16), not to the image readers.
 *
 * Its registration slot is unchanged — the three names ahead of it were
 * removed, not reordered, so every surviving name keeps its position in
 * tools/list.
 */
export function registerAssetTools(server: McpServer): void {
  server.tool(
    "regenerate",
    "Re-enqueue the workflow that produced an existing asset, optionally applying parameter overrides. Overrides are applied to any node input matching the key name (e.g. cfg, steps, sampler_name, scheduler, seed, denoise, text). Seeds are re-randomized by default so each regenerate yields a fresh image unless seed is explicitly passed in overrides.",
    {
      asset_id: z.string().describe("Asset id of the source generation"),
      overrides: z
        .record(z.string(), z.any())
        .optional()
        .describe(
          "Map of input-name → new value applied to every node that already has that input. " +
            "Common keys: cfg, steps, sampler_name, scheduler, seed, denoise, text.",
        ),
      disable_random_seed: z
        .boolean()
        .optional()
        .describe(
          "If true, do not randomize seed fields. Combine with `overrides.seed` to reproduce the exact original image.",
        ),
    },
    async ({ asset_id, overrides, disable_random_seed }) => {
      try {
        const record = AssetRegistry.get(asset_id);
        if (!record) {
          return errorToToolResult(
            new Error(
              `No asset found for id "${asset_id}". It may have expired or never been registered.`,
            ),
          );
        }
        const next = applyOverrides(record.workflow, overrides);
        // An override like overrides.seed is a caller-fixed value; keep it
        // while the other seeds re-randomize (issue #865).
        const result = await enqueueWorkflow(next, {
          disable_random_seed,
          preserve_seed_inputs: Object.keys(overrides ?? {}),
        });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  status: "enqueued",
                  prompt_id: result.prompt_id,
                  queue_remaining: result.queue_remaining,
                  source_asset_id: asset_id,
                  overrides_applied: overrides ?? {},
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}
