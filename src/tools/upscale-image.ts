import { upscaleImage, type UpscaleImageDeps } from "../services/upscale-image.js";
import { enqueueWorkflow } from "../services/workflow-executor.js";
import { listLocalModels } from "../services/model-resolver.js";

async function resolveUpscaleModel(): Promise<string | undefined> {
  try {
    const models = await listLocalModels("upscale_models");
    return models[0]?.name;
  } catch {
    return undefined;
  }
}

const deps: UpscaleImageDeps = {
  resolveUpscaleModel,
  enqueue: (workflow) => enqueueWorkflow(workflow),
};

/**
 * `generate_image (action:"upscale")` — the handler the standalone upscale tool
 * used to carry (0.50.0 slice 16), unchanged apart from losing its own
 * registration.
 *
 * Same service, same deps, same returned JSON; only the `tool` label changed, to
 * the live call form — see generateVideoAction for why. The try/catch moved OUT
 * to the dispatcher in generate-image.ts.
 */
export async function upscaleImageAction(args: {
  image: string;
  scale?: 2 | 4;
  model?: string;
}): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const result = await upscaleImage(args, deps);
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            status: "enqueued",
            tool: 'generate_image (action:"upscale")',
            prompt_id: result.prompt_id,
            queue_remaining: result.queue_remaining,
            model: result.model,
            scale: result.scale,
            note: 'Upscaled asset_id arrives in the completion notification; use get_image (action:"view") with it.',
          },
          null,
          2,
        ),
      },
    ],
  };
}
