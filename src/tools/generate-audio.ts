// The audio-generation tool originally contributed by @x-yahya997 in
// `x-yahya997/comfyui-mcp@c2ff7a9` and merged here with thanks.
import {
  generateAudio as generateAudioService,
  type GenerateAudioArgs,
} from "../services/generate-audio.js";
import { enqueueWorkflow } from "../services/workflow-executor.js";
import { listLocalModels } from "../services/model-resolver.js";

async function resolveFirstModel(type: string): Promise<string | undefined> {
  try {
    const models = await listLocalModels(type);
    return models[0]?.name;
  } catch {
    return undefined;
  }
}

const deps = {
  resolveFirstModel,
  enqueue: (workflow: Parameters<typeof enqueueWorkflow>[0]) => enqueueWorkflow(workflow),
};

/**
 * `generate_image (action:"audio")` — the handler the standalone audio tool
 * used to carry (0.50.0 slice 16), unchanged apart from losing its own
 * registration.
 *
 * The service call, its deps and the returned JSON (status/model_family/
 * prompt_id/queue_remaining/note) are identical. The try/catch moved OUT to the
 * dispatcher in generate-image.ts, which applies the same `errorToToolResult`.
 * The args object is built FIELD BY FIELD rather than spread from the shared
 * flat schema, so no parameter belonging to another action can reach this
 * service.
 */
export async function generateAudioAction(
  args: GenerateAudioArgs,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const result = await generateAudioService(args, deps);
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            status: "enqueued",
            model_family: result.model_family,
            prompt_id: result.prompt_id,
            queue_remaining: result.queue_remaining,
            note: "asset_id will be available in the completion notification; the SaveAudioMP3 node writes the output file to ComfyUI's output directory.",
          },
          null,
          2,
        ),
      },
    ],
  };
}
