import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  saveNodeSnapshot,
  restoreNodeSnapshot,
  listNodeSnapshots,
} from "../services/node-snapshots.js";
import { errorToToolResult } from "../utils/errors.js";

/**
 * The three node-snapshot tools collapsed into one action-parameterized
 * `node_snapshot` tool (0.49.0 surface consolidation, slice 2).
 *
 * SHAPE: a FLAT object with an `action` enum — deliberately NOT a
 * z.discriminatedUnion, which the MCP SDK renders as a schema with ZERO visible
 * parameters, hiding every input from the model. A flat enum keeps `action` and
 * the per-action arguments visible and self-documenting.
 *
 * REQUIREDNESS: only `action` can be schema-required, because `name` is required
 * for restore, optional for save, and meaningless for list. The zod layer keeps
 * every VALUE constraint the old tools had (so a malformed name still fails at the
 * boundary) and the handler enforces per-action presence with the same message the
 * caller would previously have got from the schema. Each branch calls exactly the
 * service function the old tool called and returns the identical content block.
 */
export function registerNodeSnapshotsTools(server: McpServer): void {
  server.tool(
    "node_snapshot",
    "Custom-node snapshots via ComfyUI-Manager (mirrors `comfy node save-snapshot` / `restore-snapshot`). Driven by the `action` parameter:\n" +
      "- action:\"list\" — List the snapshots ComfyUI-Manager knows about. No other parameters. Read-only.\n" +
      '- action:"save" — Save the current custom-node and version state. With no `name`, Manager assigns a timestamped snapshot (works against remote instances). Providing `name` writes a custom-named snapshot file, which requires a local ComfyUI install root (COMFYUI_PATH or a saved default workspace — see the workspace tool) and is unavailable against a genuinely remote ComfyUI.\n' +
      '- action:"restore" — Restore a previously saved snapshot by `name` (required). ComfyUI-Manager applies the custom-node changes on the next ComfyUI restart; use action:"list" to find available names.',
    {
      action: z
        .enum(["list", "save", "restore"])
        .describe(
          'Which snapshot operation to perform. "list" takes no other parameters; "save" takes an optional `name`; "restore" requires `name`.',
        ),
      name: z
        .string()
        .optional()
        .describe(
          'Snapshot name (no extension, no path separators). REQUIRED for action:"restore" (as shown by action:"list"). ' +
            'OPTIONAL for action:"save" — omit to let ComfyUI-Manager assign a timestamped name. Ignored by action:"list".',
        ),
    },
    async (args) => {
      try {
        switch (args.action) {
          case "save": {
            const result = await saveNodeSnapshot(args.name);
            return {
              content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
            };
          }
          case "restore": {
            // ABSENCE only, never falsiness. `name: ""` passed z.string() before
            // and reached restoreNodeSnapshot(), which rejects blank names with a
            // structured NODE_SNAPSHOT_ERROR; a `!name` guard would swallow that
            // and answer with generic text instead. Only a genuinely OMITTED name
            // is the case the schema used to catch.
            if (args.name === undefined) {
              throw new Error(
                'node_snapshot action:"restore" requires `name` — the snapshot to restore (as shown by action:"list").',
              );
            }
            const result = await restoreNodeSnapshot(args.name);
            return {
              content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
            };
          }
          case "list": {
            const result = await listNodeSnapshots();
            const text = result.unsupported
              ? (result.message ??
                "Node snapshots are not supported on this ComfyUI-Manager build.")
              : result.snapshots.length === 0
                ? "No node snapshots found."
                : `Available node snapshots (${result.snapshots.length}):\n` +
                  result.snapshots.map((s) => `- ${s}`).join("\n");
            return { content: [{ type: "text" as const, text }] };
          }
          default: {
            // Unreachable given the zod enum, but a clear runtime guard beats a
            // silent undefined if the schema and switch ever drift apart.
            const exhaustive: never = args.action;
            throw new Error(
              `Unknown node_snapshot action "${String(exhaustive)}". Expected one of: list, save, restore.`,
            );
          }
        }
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}
