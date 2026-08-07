import {
  generateVideo,
  type GenerateVideoArgs,
  type GenerateVideoDeps,
} from "../services/generate-video.js";
import { enqueueWorkflow } from "../services/workflow-executor.js";
import { listLocalModels } from "../services/model-resolver.js";

// The service requires SPECIFIC LTX deps (checkpoint / gemma encoder / LoRAs) and
// builds its own actionable "missing dependency" errors from the full per-category
// listing. It wraps this in safeList (throw → null = "can't determine, don't
// block"), so DON'T swallow errors here — let listLocalModels throw when there's
// no server, otherwise an empty list would read as "determined empty" and falsely
// report every dependency missing.
async function listModels(type: string): Promise<string[]> {
  const models = await listLocalModels(type);
  return models.map((m) => m.name);
}

const deps: GenerateVideoDeps = {
  listModels,
  enqueue: (workflow) => enqueueWorkflow(workflow),
};

/**
 * `generate_image (action:"video")` — the handler the standalone video tool
 * used to carry (0.50.0 slice 16), unchanged apart from losing its own
 * registration.
 *
 * Same service, same deps (listModels deliberately does NOT swallow errors — see
 * the note above it), and the same returned JSON. Its `tool` label is the one
 * field that had to change: it named a tool that no longer exists, and a model
 * reading a payload is exactly the reader the retirement ledger protects, so it
 * now spells the live call form. Nothing keys on it. The try/catch moved OUT to
 * the dispatcher in generate-image.ts.
 */
export async function generateVideoAction(
  args: GenerateVideoArgs,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const result = await generateVideo(args, deps);
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            status: "enqueued",
            tool: 'generate_image (action:"video")',
            mode: result.mode,
            prompt_id: result.prompt_id,
            queue_remaining: result.queue_remaining,
            // #1037 — a 200 from /prompt does not mean every output was accepted;
            // ComfyUI queues the branches that validate and reports the rest.
            ...(result.rejectedOutputs
              ? { rejected_outputs: result.rejectedOutputs }
              : {}),
            checkpoint: result.checkpoint,
            width: result.width,
            height: result.height,
            length_frames: result.length,
            fps: result.fps,
            note: 'Video is written under output/video/. VHS/SaveVideo outputs may not show in /history — use get_image (action:"list_outputs") to find it.',
          },
          null,
          2,
        ),
      },
    ],
  };
}
