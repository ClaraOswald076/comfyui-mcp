import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { getSystemStats, comfyApiFetch } from "../comfyui/client.js";
import type { SystemStats } from "../comfyui/types.js";
import { ComfyUIError, errorToToolResult } from "../utils/errors.js";
import { bodyPrefixOf, describeStatus } from "../comfyui/json-guard.js";
import { logger } from "../utils/logger.js";

/** Poll interval between /system_stats reads after /free (#2050). */
export const CLEAR_VRAM_SETTLE_INTERVAL_MS = 250;
/** Do not treat an unchanged first reading as settled — CUDA may not have started releasing yet. */
export const CLEAR_VRAM_SETTLE_MIN_MS = 1_000;
/** Hard cap so a card that never plateaus still returns a number. */
export const CLEAR_VRAM_SETTLE_TIMEOUT_MS = 5_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The counters `clear_vram` prints — device 0's VRAM + torch pool. */
function vramSignature(stats: SystemStats): string {
  const gpu = stats.devices?.[0];
  if (!gpu) return "";
  return `${gpu.vram_free}:${gpu.torch_vram_free}`;
}

function formatVramStats(stats: SystemStats): string {
  const gpu = stats.devices?.[0];
  if (!gpu) return "";
  const vramFreeMB = (gpu.vram_free / 1024 / 1024).toFixed(0);
  const vramTotalMB = (gpu.vram_total / 1024 / 1024).toFixed(0);
  const torchFreeMB = (gpu.torch_vram_free / 1024 / 1024).toFixed(0);
  const torchTotalMB = (gpu.torch_vram_total / 1024 / 1024).toFixed(0);
  return `\n\nCurrent VRAM: ${vramFreeMB}/${vramTotalMB} MB free | Torch: ${torchFreeMB}/${torchTotalMB} MB free`;
}

/**
 * /free answers when ComfyUI drops model refs; CUDA/driver release can lag.
 * Poll until the displayed counters stop changing (or we hit the cap) so the
 * printed value matches a follow-up get_system_stats (action:"stats") (#2050).
 */
async function readSettledSystemStats(): Promise<SystemStats | null> {
  const started = Date.now();
  const deadline = started + CLEAR_VRAM_SETTLE_TIMEOUT_MS;
  let last: SystemStats | null = null;
  let lastSig: string | null = null;
  let sawChange = false;

  for (;;) {
    let current: SystemStats;
    try {
      current = await getSystemStats();
    } catch {
      // A prior sample is not a valid substitute for the current one: /free may
      // have released memory between the two reads, so returning `last` would
      // print a known-stale VRAM figure as if it were current.
      return null;
    }

    const sig = vramSignature(current);
    const elapsed = Date.now() - started;
    if (lastSig !== null && sig !== lastSig) sawChange = true;
    const stable = lastSig !== null && sig === lastSig;
    last = current;
    lastSig = sig;

    if (stable && (sawChange || elapsed >= CLEAR_VRAM_SETTLE_MIN_MS)) {
      return current;
    }
    if (elapsed >= CLEAR_VRAM_SETTLE_TIMEOUT_MS) {
      return current;
    }

    const wait = Math.min(CLEAR_VRAM_SETTLE_INTERVAL_MS, Math.max(0, deadline - Date.now()));
    if (wait <= 0) return current;
    await sleep(wait);
  }
}

export function registerMemoryManagementTools(server: McpServer): void {
  server.tool(
    "clear_vram",
    "Free GPU VRAM by unloading cached models from ComfyUI. Use this between generation runs with different model families (e.g. switching from SDXL to Flux) or when running low on VRAM. Optionally unload only models or only memory.",
    {
      unload_models: z
        .boolean()
        .optional()
        .default(true)
        .describe("Unload all cached models (default: true)"),
      free_memory: z
        .boolean()
        .optional()
        .default(true)
        .describe("Free cached memory/intermediates (default: true)"),
    },
    async (args) => {
      try {

        // ComfyUI's /free endpoint accepts POST with JSON body
        const res = await comfyApiFetch("/free", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            unload_models: args.unload_models,
            free_memory: args.free_memory,
          }),
        });

        if (!res.ok) {
          // unknown-ok: "" is interpolated into an ERROR MESSAGE and nothing else — the
          // HTTP status is reported either way, so an unreadable body costs detail in the
          // text, never a wrong conclusion. Verified there is no branch on this value.
          //
          // #385 made this branch REACHABLE. A gateway that reflects the request
          // can put our own credential in the body it answers with, so it is
          // scrubbed like every other body this codebase prints (#828).
          const text = await res.text().catch(() => "");
          return {
            content: [
              {
                type: "text" as const,
                text: `Failed to free VRAM: ${describeStatus(res.status, res.statusText)}${text ? `\n${bodyPrefixOf(text)}` : ""}`,
              },
            ],
          };
        }

        // Get updated stats — after CUDA release settles, not the first post-/free sample.
        let statsText = "";
        try {
          const stats = await readSettledSystemStats();
          if (stats) statsText = formatVramStats(stats);
        } catch {
          // Best effort
        }

        const actions: string[] = [];
        if (args.unload_models) actions.push("models unloaded");
        if (args.free_memory) actions.push("memory freed");

        return {
          content: [
            {
              type: "text" as const,
              text: `VRAM cleared successfully (${actions.join(", ")}).${statsText}`,
            },
          ],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

}

/**
 * The embeddings listing, no longer a tool of its own.
 *
 * 0.50.0 slice 11 folded it into `list_local_models` (action:"embeddings") —
 * both read what the connected ComfyUI has installed, so they belong on the same
 * tool. The body is the old handler verbatim: same /api/embeddings read, same
 * rendering, same "No embeddings installed." degradation.
 */
export async function getEmbeddingsAction(): Promise<CallToolResult> {
      try {
        const res = await comfyApiFetch("/api/embeddings");
        // This site had NO status check, because none could ever run — fetchApi
        // threw first (#385). Converting it without adding one would hand a 4xx
        // body to the parser, and a JSON-shaped error envelope parses fine and
        // is not an array — landing on "No embeddings installed." That is the
        // #796 defect exactly: "could not determine" reported as "determined
        // not", and here it would tell a user with a full embeddings folder that
        // they have none. Say what actually happened instead.
        if (!res.ok) {
          throw new ComfyUIError(
            `ComfyUI /api/embeddings answered ${describeStatus(res.status, res.statusText)}, so the installed ` +
              `embeddings could NOT be listed. This is not a report that none are installed — ` +
              `nothing was read. Confirm the server is up and exposes this route with ` +
              `get_system_stats (action:"health").`,
            "HTTP_ERROR",
          );
        }
        const embeddings = (await res.json()) as string[];

        if (!Array.isArray(embeddings) || embeddings.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: "No embeddings installed.",
              },
            ],
          };
        }

        const lines = embeddings.map((e, i) => `${i + 1}. ${e}`);

        return {
          content: [
            {
              type: "text" as const,
              text: `Found ${embeddings.length} embedding(s):\n\n${lines.join("\n")}\n\nUsage in prompts: \`embedding:name\` (e.g. \`embedding:${embeddings[0]}\`)`,
            },
          ],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
}
