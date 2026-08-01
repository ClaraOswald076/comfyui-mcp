import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { isLocalMode } from "../config.js";
import {
  installCustomNode,
  updateCustomNode,
  reinstallCustomNode,
  fixCustomNode,
  listInstalledNodes,
  syncNodeDependencies,
  type InstalledNode,
} from "../services/node-management.js";
import { errorToToolResult } from "../utils/errors.js";
import { getComfyCliVersion, resolveComfyCliExecutable, shouldUseComfyCli } from "../services/comfy-cli.js";
import { targetsPanelPackExactly } from "../services/panel-pin-guard.js";
import { runPanelAction } from "../services/panel-installer.js";

/**
 * The sidebar panel pack is an ordinary custom node pack, so `install_custom_node`
 * / `update_custom_node` / `reinstall_custom_node` can target it by id. The
 * generic services report success straight off the ComfyUI-Manager queue result,
 * which a stale Manager 3.x drains WITHOUT doing any work (#639) — and they know
 * nothing about `.bak` shadow copies (#641). Reaching the panel through them
 * would therefore reintroduce both bugs through a side door.
 *
 * So a call that names the panel is REDIRECTED into the verified path, which
 * re-reads the pack from disk and fails closed unless it provably moved. (The pin
 * is enforced deeper still, in the services themselves — see panel-pin-guard.ts —
 * so bulk targets like "all" are covered even though they cannot be redirected.)
 */
async function runVerifiedPanelAction(
  action: "install" | "update" | "reinstall",
  id: string,
) {
  const result = await runPanelAction(action);
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            ...result,
            routedVia: "install_panel",
            note:
              `"${id}" is the comfyui-mcp sidebar panel pack, so this ${action} ran ` +
              `through the verified panel path: the version above was RE-READ from ` +
              `disk after the operation, and a Manager no-op or a shadow copy would ` +
              `have failed instead of reporting success. Use install_panel directly ` +
              `for status/sync/pin.`,
          },
          null,
          2,
        ),
      },
    ],
  };
}

/** Graceful "not supported remotely" tool result (no isError), matching the
 *  degrade-don't-throw pattern list_local_models uses. */
function remoteUnsupported(message: string) {
  return { content: [{ type: "text" as const, text: message }] };
}

function preferLocalComfyCli(explicit: boolean | undefined): boolean {
  if (explicit !== undefined) return explicit;
  if (!isLocalMode()) return false;
  const executable = resolveComfyCliExecutable();
  if (!executable) return false;
  return shouldUseComfyCli(
    undefined,
    true,
    executable,
    getComfyCliVersion(),
  );
}

const modeSchema = z
  .enum(["remote", "local", "cache"])
  .optional()
  .describe(
    "ComfyUI-Manager data source mode (default 'remote'): 'remote' fetches the live node list, 'local'/'cache' use bundled/cached data.",
  );

const useCmCliSchema = z
  .boolean()
  .optional()
  .describe(
    "Force the official comfy-cli subprocess instead of the ComfyUI-Manager HTTP API. Local operations use comfy-cli by default; set false to force Manager HTTP. Requires a local ComfyUI install.",
  );

const channelSchema = z
  .string()
  .optional()
  .describe("ComfyUI-Manager channel name (default 'default').");

function formatInstalledNodes(nodes: InstalledNode[]): string {
  if (nodes.length === 0) return "No custom nodes installed.";
  return nodes
    .map((n, i) => {
      const idParts = [
        n.cnrId ? `cnr:${n.cnrId}` : null,
        n.auxId ? `git:${n.auxId}` : null,
      ].filter(Boolean);
      const idStr = idParts.length ? ` [${idParts.join(", ")}]` : "";
      return (
        `${i + 1}. ${n.module}${idStr}\n` +
        `   version: ${n.version ?? "unknown"} | ${n.enabled ? "enabled" : "disabled"}`
      );
    })
    .join("\n");
}

export function registerNodeManagementTools(server: McpServer): void {
  server.tool(
    "install_custom_node",
    "Install a ComfyUI custom node pack by registry id, git URL, or name. Local installs prefer official comfy-cli when available; remote or CLI-unavailable installs use the ComfyUI-Manager HTTP API. A ComfyUI restart may be required. Targeting the comfyui-mcp sidebar panel pack ('comfyui-agent-panel' / 'comfyui-mcp-panel') is routed through the verified install_panel path (the version is re-read from disk afterwards) and is REFUSED while the panel is version-pinned.",
    {
      id: z
        .string()
        .describe("Registry id, git URL, or node-pack name to install."),
      source: z
        .enum(["registry", "git", "auto"])
        .optional()
        .describe(
          "How to interpret `id` (default 'auto', which detects git URLs vs registry ids).",
        ),
      version: z
        .string()
        .optional()
        .describe(
          "Version to install (e.g. 'latest', 'nightly', or a semver). For git installs, this is treated as a git ref unless `ref` is also provided. Registry installs default to 'latest'.",
        ),
      ref: z
        .string()
        .optional()
        .describe(
          "Git ref (commit SHA, branch, or tag) to pin when installing a git URL. Overrides any ref parsed from the URL and any `version` value. Ignored for registry-id installs.",
        ),
      mode: modeSchema,
      channel: channelSchema,
      useCmCli: useCmCliSchema,
    },
    async (args) => {
      try {
        if (targetsPanelPackExactly(args.id)) {
          return await runVerifiedPanelAction("install", args.id);
        }
        const result = await installCustomNode({ ...args, useCmCli: preferLocalComfyCli(args.useCmCli) });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "update_custom_node",
    "Update an installed ComfyUI custom node pack, or pass 'all' to update every installed pack. Local operations prefer official comfy-cli; remote operations use Manager HTTP. Targeting the comfyui-mcp sidebar panel pack ('comfyui-agent-panel' / 'comfyui-mcp-panel') is routed through the verified install_panel path (the version is re-read from disk afterwards). While the panel is version-pinned, BOTH a direct panel target and 'all' are REFUSED — 'all' would move the pinned panel too; clear the pin with install_panel(action='unpin') or update other packs individually.",
    {
      id: z
        .string()
        .describe("Registry id / module name to update, or 'all' for every pack."),
      mode: modeSchema,
      channel: channelSchema,
      useCmCli: useCmCliSchema,
    },
    async (args) => {
      try {
        if (targetsPanelPackExactly(args.id)) {
          return await runVerifiedPanelAction("update", args.id);
        }
        const result = await updateCustomNode({ ...args, useCmCli: preferLocalComfyCli(args.useCmCli) });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "reinstall_custom_node",
    "Reinstall a ComfyUI custom node pack. Local operations prefer official comfy-cli; remote operations use Manager HTTP. A ComfyUI restart may be required. Targeting the comfyui-mcp sidebar panel pack ('comfyui-agent-panel' / 'comfyui-mcp-panel') is routed through the verified install_panel path (the version is re-read from disk afterwards) and is REFUSED while the panel is version-pinned.",
    {
      id: z.string().describe("Registry id / module name to reinstall."),
      version: z
        .string()
        .optional()
        .describe("Version to reinstall (default 'latest')."),
      mode: modeSchema,
      channel: channelSchema,
      useCmCli: useCmCliSchema,
    },
    async (args) => {
      try {
        if (targetsPanelPackExactly(args.id)) {
          return await runVerifiedPanelAction("reinstall", args.id);
        }
        const result = await reinstallCustomNode({ ...args, useCmCli: preferLocalComfyCli(args.useCmCli) });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "fix_custom_node",
    "Repair a ComfyUI custom node pack's install and Python dependencies, or pass 'all' to repair every pack. Local operations prefer official comfy-cli; remote single-pack repairs use Manager HTTP.",
    {
      id: z
        .string()
        .describe("Registry id / module name to repair, or 'all' for every pack."),
      mode: modeSchema,
      channel: channelSchema,
      useCmCli: useCmCliSchema,
    },
    async (args) => {
      // "all" repairs every pack via the cm-cli subprocess, which needs a local
      // ComfyUI install. Single-pack repair uses the Manager HTTP API and works
      // remotely, so only guard the "all" case here.
      if (args.id.trim().toLowerCase() === "all" && !isLocalMode()) {
        return remoteUnsupported(
          "fix_custom_node id=\"all\" is not supported against a remote ComfyUI. " +
            "Repairing every pack runs the cm-cli subprocess, which requires a " +
            "local ComfyUI install (COMFYUI_PATH). Repair a single pack by id " +
            "instead (that uses the ComfyUI-Manager HTTP API and works remotely).",
        );
      }
      try {
        const result = await fixCustomNode({ ...args, useCmCli: preferLocalComfyCli(args.useCmCli) });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "list_installed_nodes",
    "List installed ComfyUI custom node packs with their version and enabled/disabled state. Uses the ComfyUI-Manager HTTP API (works against remote instances); the cm-cli fallback returns names only.",
    {
      mode: z
        .enum(["default", "imported"])
        .optional()
        .describe(
          "'default' lists all installed packs; 'imported' lists only those successfully imported this session.",
        ),
      useCmCli: useCmCliSchema,
    },
    async (args) => {
      try {
        const nodes = await listInstalledNodes(args);
        return {
          content: [{ type: "text" as const, text: formatInstalledNodes(nodes) }],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "sync_node_dependencies",
    "Reconcile the Python dependencies of all installed custom node packs through official `comfy node restore-dependencies`. Requires a local ComfyUI install and comfy-cli.",
    {},
    async () => {
      if (!isLocalMode()) {
        return remoteUnsupported(
          "sync_node_dependencies is not supported against a remote ComfyUI. It " +
            "runs the cm-cli restore-dependencies subprocess, which requires a " +
            "local ComfyUI install (COMFYUI_PATH). Reconcile dependencies on the " +
            "ComfyUI host instead.",
        );
      }
      try {
        const result = await syncNodeDependencies();
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}
