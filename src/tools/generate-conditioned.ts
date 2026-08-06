import {
  generateWithControlNet,
  generateWithIpAdapter,
  type ConditionedDeps,
  type ControlNetArgs,
  type IpAdapterArgs,
} from "../services/generate-conditioned.js";
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

const deps: ConditionedDeps = {
  resolveCheckpoint: () => resolveFirstModel("checkpoints"),
  resolveControlNetModel: () => resolveFirstModel("controlnet"),
  enqueue: (workflow) => enqueueWorkflow(workflow),
};


function enqueuedResult(result: { prompt_id: string; queue_remaining?: number; checkpoint: string }, tool: string) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            status: "enqueued",
            tool,
            prompt_id: result.prompt_id,
            queue_remaining: result.queue_remaining,
            checkpoint: result.checkpoint,
            note: 'asset_id will be available in the completion notification; use get_image (action:"view") or generate_image (action:"regenerate") with it.',
          },
          null,
          2,
        ),
      },
    ],
  };
}

/**
 * `generate_image (action:"controlnet")` — the handler the standalone ControlNet
 * tool used to carry (0.50.0 slice 16), unchanged apart from losing its own
 * registration.
 *
 * Same service, same shared `deps`, same enqueuedResult payload; its `tool`
 * label now spells the live call form rather than a name that no longer exists.
 * The try/catch moved OUT to the dispatcher in generate-image.ts.
 */
export async function generateWithControlNetAction(
  args: ControlNetArgs,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  return enqueuedResult(await generateWithControlNet(args, deps), 'generate_image (action:"controlnet")');
}

/**
 * `generate_image (action:"ip_adapter")` — the handler the standalone
 * IP-Adapter tool used to carry (0.50.0 slice 16). Same service, same deps, same
 * payload; see generateWithControlNetAction above for the `tool` label.
 */
export async function generateWithIpAdapterAction(
  args: IpAdapterArgs,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  return enqueuedResult(await generateWithIpAdapter(args, deps), 'generate_image (action:"ip_adapter")');
}
