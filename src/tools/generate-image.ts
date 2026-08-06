import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { generateImage } from "../services/generate-image.js";
import { enqueueWorkflow } from "../services/workflow-executor.js";
import {
  listLocalModels,
  type LocalModel,
} from "../services/model-resolver.js";
import { selectTxt2ImgCheckpoint } from "../services/checkpoint-capability.js";
import { errorToToolResult, ValidationError } from "../utils/errors.js";

async function resolveCheckpoint(): Promise<string | undefined> {
  let models: LocalModel[];
  try {
    models = await listLocalModels("checkpoints");
  } catch {
    // Listing failed (server unreachable, …) — the caller's generic
    // "no checkpoint found" error is the accurate report for that.
    return undefined;
  }
  if (models.length === 0) return undefined;
  // Skip checkpoints that cannot drive a txt2img graph (video models without
  // a text encoder, GGUF files) instead of taking the alphabetically-first
  // entry and failing at CLIPTextEncode every time (issue #892).
  const choice = await selectTxt2ImgCheckpoint(models);
  if (choice) return choice.name;
  const MAX_LISTED = 5;
  const listed = models
    .slice(0, MAX_LISTED)
    .map((m) => m.name)
    .join(", ");
  const more =
    models.length > MAX_LISTED ? `, … and ${models.length - MAX_LISTED} more` : "";
  throw new ValidationError(
    `Found ${models.length} local checkpoint(s), but none appears txt2img-capable: ` +
      `every one lacks text-encoder weights in its safetensors header (a video or ` +
      `UNet-only model) or is a GGUF file CheckpointLoaderSimple cannot load ` +
      `(${listed}${more}). Pass \`checkpoint\` explicitly to use one anyway, set a ` +
      `default with get_defaults (action:"set"), or download an image checkpoint ` +
      `with download_model.`,
  );
}

export function registerGenerateImageTool(server: McpServer): void {
  server.tool(
    "generate_image",
    "Generate an image from a text prompt — the high-level entry point. Builds a txt2img workflow, " +
      "filling any unspecified parameter from your configured defaults (get_defaults (action:\"set\") / COMFYUI_DEFAULT_* / config file), " +
      "auto-selecting a txt2img-capable local checkpoint when none is given (checkpoints without a text " +
      "encoder, e.g. video models, are skipped). Returns the prompt_id immediately; the resulting " +
      "asset_id arrives in the completion notification and can be passed to view_image or regenerate. " +
      "For full control over the node graph, use create_workflow + enqueue_workflow instead.",
    {
      prompt: z.string().describe("Positive text prompt"),
      negative_prompt: z.string().optional().describe("Negative prompt (default: empty / from defaults)"),
      width: z.number().int().positive().optional().describe("Image width"),
      height: z.number().int().positive().optional().describe("Image height"),
      steps: z.number().int().positive().optional().describe("Sampling steps"),
      cfg: z.number().positive().optional().describe("CFG scale"),
      sampler: z.string().optional().describe("Sampler name (e.g. euler, dpmpp_2m)"),
      scheduler: z.string().optional().describe("Scheduler (e.g. normal, karras)"),
      seed: z.number().int().optional().describe("Seed (omit to randomize)"),
      checkpoint: z
        .string()
        .optional()
        .describe("Checkpoint filename; auto-selected from local models if omitted"),
      batch_size: z.number().int().positive().optional().describe("Number of images to generate"),
    },
    async (args) => {
      try {
        const result = await generateImage(args, {
          resolveCheckpoint,
          // The workflow composer already draws a random seed when none is
          // given, so executor-side re-randomization would only ever clobber
          // the seed this tool just resolved — including an explicit one
          // (issue #865).
          enqueue: (workflow) =>
            enqueueWorkflow(workflow, { disable_random_seed: true }),
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
                  checkpoint: result.checkpoint,
                  note: "asset_id will be available in the completion notification; use view_image or regenerate with it.",
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
