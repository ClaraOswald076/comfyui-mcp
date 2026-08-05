import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { applyManifest } from "../services/manifest.js";

/**
 * `install_comfyui (action:"apply_manifest")` — what the retired
 * `install_comfyui (action:"apply_manifest")` tool did (0.50.0 slice 13). `manifest` and `path` keep their
 * names and their exactly-one-of contract; the service resolves and validates
 * them as before, so an empty/absent pair still produces the service's own
 * error rather than a substitute.
 */
export async function applyManifestAction(args: {
  manifest?: unknown;
  path?: string;
}): Promise<CallToolResult> {
  const result = await applyManifest(args as Parameters<typeof applyManifest>[0]);
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
  };
}
