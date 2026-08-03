import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AssetRegistry, applyOverrides } from "../services/asset-registry.js";
import { reconcileAssetsFromHistory } from "../services/asset-reconcile.js";
import { enqueueWorkflow } from "../services/workflow-executor.js";
import { viewAssetImage } from "../services/view-image.js";
import { errorToToolResult } from "../utils/errors.js";
import { logger } from "../utils/logger.js";

function summarizeRecord(record: ReturnType<typeof AssetRegistry.get>) {
  if (!record) return null;
  return {
    asset_id: record.assetId,
    prompt_id: record.promptId,
    node_id: record.nodeId,
    filename: record.filename,
    subfolder: record.subfolder,
    type: record.type,
    url: record.url,
    source: record.source,
    created_at: new Date(record.createdAt).toISOString(),
  };
}

export function registerAssetTools(server: McpServer): void {
  server.tool(
    "view_image",
    "Fetch a registered asset's bytes and return them as an inline image so the agent can see the result. Use this after enqueue_workflow completes (asset_id is included in the completion notification) to inspect, critique, or compare generated images. Only supports image mime types (PNG/JPEG/WebP); audio/video assets must be saved to disk via get_image.",
    {
      asset_id: z.string().describe("Asset id returned by list_assets or job completion"),
    },
    async ({ asset_id }) => {
      try {
        const result = await viewAssetImage(asset_id);
        return {
          content: result.content.map((block) =>
            block.type === "image"
              ? { type: "image" as const, data: block.data, mimeType: block.mimeType }
              : { type: "text" as const, text: block.text },
          ),
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "list_assets",
    "List recently generated assets, newest-first. Each call first reconciles ComfyUI's /history, so outputs are listed even when this session did not watch the render complete (e.g. queued via panel_run, by an earlier session, or before a server restart) — those are tagged source:'history-reconcile', versus source:'watched' for renders this server saw finish. Returns count + assets (asset_id, prompt_id, filename, url, source, created_at). The registry is ephemeral and clears on server restart; records expire after COMFYUI_ASSET_TTL_HOURS (default 24h), and only the most recent completed runs are reconciled — use get_history / get_image by filename for anything older.",
    {
      limit: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Max records to return (default: all)"),
      since: z
        .string()
        .datetime()
        .optional()
        .describe("ISO timestamp — only return assets created at or after this time"),
    },
    async (args) => {
      try {
        const since = args.since ? Date.parse(args.since) : undefined;
        // Close the #751 gap: outputs whose completion this process didn't
        // watch (panel_run dispatches, earlier sessions, pre-restart runs)
        // register from history on demand. Best-effort — the registry still
        // answers when ComfyUI is unreachable.
        let note: string | undefined;
        try {
          await reconcileAssetsFromHistory();
        } catch (reconcileErr) {
          const message =
            reconcileErr instanceof Error
              ? reconcileErr.message
              : String(reconcileErr);
          logger.warn("list_assets history reconcile failed", { error: message });
          // Truthful degradation: previously reconciled records stay listed
          // (they name real outputs) — the note must not claim watched-only.
          note =
            `Could not refresh from ComfyUI history (${message}); results may be stale — ` +
            "they still include assets reconciled from history earlier, and very recent completions may be missing.";
        }
        const records = AssetRegistry.list({ limit: args.limit, since });
        if (records.length === 0 && note === undefined) {
          note =
            "No assets found — nothing completed under this server's watch and no recent successfully completed outputs in ComfyUI history. " +
            "Use get_history to inspect past runs and get_image to fetch an output by filename.";
        }
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  count: records.length,
                  assets: records.map(summarizeRecord),
                  ...(note !== undefined ? { note } : {}),
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

  server.tool(
    "get_asset_metadata",
    "Get full provenance for a registered asset including the workflow snapshot that produced it. Use this to inspect the parameters that generated an image before calling regenerate with overrides.",
    {
      asset_id: z.string().describe("Asset id returned by list_assets or job completion"),
    },
    async ({ asset_id }) => {
      try {
        const record = AssetRegistry.get(asset_id);
        if (!record) {
          return errorToToolResult(
            new Error(
              `No asset found for id "${asset_id}". It may have expired or never been registered.`,
            ),
          );
        }
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  ...summarizeRecord(record),
                  workflow: record.workflow,
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
        const result = await enqueueWorkflow(next, { disable_random_seed });
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
