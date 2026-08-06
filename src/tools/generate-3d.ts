import { generate3d, type Generate3dArgs } from "../services/generate-3d.js";

/**
 * `generate_image (action:"3d")` — the handler the standalone 3D tool used to
 * carry (0.50.0 slice 16), unchanged apart from losing its own registration.
 *
 * 3D model generation via the connected ComfyUI's hosted partner 3D nodes
 * (Tripo / Meshy / Rodin / Hunyuan3D), reusing the same machinery as
 * list_api_nodes (action:"generate"). See ../services/generate-3d.ts for the
 * path-selection rationale and capability detection. Same service call, same
 * JSON payload; only the `next:` hint names the new call forms. The try/catch
 * moved OUT to the dispatcher in generate-image.ts.
 */
export async function generate3dAction(
  args: Generate3dArgs,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const result = await generate3d(args);
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            status: "enqueued",
            prompt_id: result.prompt_id,
            queue_remaining: result.queue_remaining,
            node: result.class_type,
            display_name: result.display_name,
            category: result.category,
            formats: result.formats,
            alternatives: result.alternatives,
            notes: result.notes,
            workflow: result.workflow,
            next: 'Poll queue (action:"status") / get_history (action:"list") with the prompt_id; the 3D model file is written to the ComfyUI output directory when the job completes.',
          },
          null,
          2,
        ),
      },
    ],
  };
}
