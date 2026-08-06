import { AssetRegistry, applyOverrides } from "../services/asset-registry.js";
import { enqueueWorkflow } from "../services/workflow-executor.js";

/**
 * `generate_image (action:"regenerate")` — the handler the standalone
 * re-enqueue-an-asset tool used to carry (0.50.0 slice 16), unchanged apart from
 * losing its own registration.
 *
 * 0.50.0 slice 15 emptied the rest of this module: the inline viewer, the
 * registry listing and the provenance reader became actions on `get_image`, and
 * it left this one behind with a note that it ENQUEUES a render and so belongs
 * to the generation family — which is this slice. The module now holds exactly
 * that handler, and `registerAssetTools` is gone.
 *
 * Same AssetRegistry lookup, the same not-found error text, the same
 * applyOverrides + enqueue — including #865's `preserve_seed_inputs`, so an
 * override like `{ seed: 42 }` still survives while the other seeds
 * re-randomize — and the same JSON payload. It stays here rather than moving
 * into generate-image.ts because the asset registry is this module's concern;
 * the dispatcher imports it. The try/catch moved OUT to that dispatcher, which
 * applies the identical `errorToToolResult` — including for the not-found case,
 * which was already an errorToToolResult RETURN and is now a throw of the same
 * Error carrying the same message.
 */
export async function regenerateAction(args: {
  asset_id: string;
  overrides?: Record<string, unknown>;
  disable_random_seed?: boolean;
}): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const { asset_id, overrides, disable_random_seed } = args;
  const record = AssetRegistry.get(asset_id);
  if (!record) {
    throw new Error(
      `No asset found for id "${asset_id}". It may have expired or never been registered.`,
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
}
