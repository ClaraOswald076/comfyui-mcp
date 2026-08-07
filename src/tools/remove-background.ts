import {
  removeBackground,
  type RemoveBackgroundDeps,
} from "../services/remove-background.js";
import { enqueueWorkflow } from "../services/workflow-executor.js";
import { getObjectInfo } from "../comfyui/client.js";

async function isNodeInstalled(classType: string): Promise<boolean | undefined> {
  try {
    const objectInfo = await getObjectInfo();
    return Object.prototype.hasOwnProperty.call(objectInfo, classType);
  } catch {
    // Can't reach the server / object_info — let execution surface any problem.
    return undefined;
  }
}

const deps: RemoveBackgroundDeps = {
  isNodeInstalled,
  enqueue: (workflow) => enqueueWorkflow(workflow),
};

/**
 * `generate_image (action:"remove_background")` — the handler the standalone
 * background-removal tool used to carry (0.50.0 slice 16), unchanged apart from
 * losing its own registration.
 *
 * Same service, same deps (isNodeInstalled returns undefined when the server is
 * unreachable, so a missing-node claim is never invented from a failed probe),
 * same returned JSON; only the `tool` label changed, to the live call form — see
 * generateVideoAction for why. The try/catch moved OUT to the dispatcher in
 * generate-image.ts.
 */
export async function removeBackgroundAction(args: {
  image: string;
  model?: string;
  filename_prefix?: string;
}): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const result = await removeBackground(args, deps);
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            status: "enqueued",
            tool: 'generate_image (action:"remove_background")',
            prompt_id: result.prompt_id,
            queue_remaining: result.queue_remaining,
            // #1037 — a 200 from /prompt does not mean every output was accepted;
            // ComfyUI queues the branches that validate and reports the rest.
            ...(result.rejectedOutputs
              ? { rejected_outputs: result.rejectedOutputs }
              : {}),
            model: result.model,
            note: 'Transparent cutout asset_id arrives in the completion notification; use get_image (action:"view") with it.',
          },
          null,
          2,
        ),
      },
    ],
  };
}
