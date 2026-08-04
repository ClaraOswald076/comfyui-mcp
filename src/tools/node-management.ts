import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { isLocalMode } from "../config.js";
import {
  installCustomNode,
  updateCustomNode,
  reinstallCustomNode,
  fixCustomNode,
  disableCustomNode,
  enableCustomNode,
  uninstallCustomNode,
  listInstalledNodes,
  syncNodeDependencies,
  parseGitUrl,
  type InstalledNode,
} from "../services/node-management.js";
import { errorToToolResult } from "../utils/errors.js";
import { getComfyCliVersion, resolveComfyCliExecutable, shouldUseComfyCli } from "../services/comfy-cli.js";
import {
  assertPanelNotTargetedUnverifiable,
  targetsPanelPackExactly,
} from "../services/panel-pin-guard.js";
import { runPanelAction } from "../services/panel-installer.js";
import { SEMVER_RE } from "../services/ui-bridge.js";

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
/**
 * Can the verified panel path honour this git ref as a registry version?
 *
 * The verified path installs from the Comfy Registry, so the only refs it can
 * honour are the ones that ARE registry versions: the channel names, or a
 * strict semver (ui-bridge's canonical grammar; a leading-"v" tag means the
 * same version, and the registry spelling is the bare form). Anything else — a
 * branch, a sha — would silently become something other than what was asked.
 */
function registryInstallableRef(ref: string): string | undefined {
  if (ref === "nightly" || ref === "latest") return ref;
  if (!SEMVER_RE.test(ref)) return undefined;
  return ref.replace(/^v(?=\d)/, "");
}

async function runVerifiedPanelAction(
  action: "install" | "update" | "reinstall",
  id: string,
  opts: { version?: string; ref?: string; source?: string } = {},
) {
  // Options the verified path cannot honour are REFUSED, not dropped. Silently
  // ignoring a caller's `ref` and then reporting success would be doing
  // something other than what was asked — a smaller cousin of the exact lie this
  // whole feature guards against. (`version` IS honoured; it is threaded through.)
  if (opts.ref || opts.source === "git") {
    throw new Error(
      `"${id}" is the comfyui-mcp sidebar panel pack, which is managed through the ` +
        `verified panel path (it re-reads the pack from disk afterwards and fails ` +
        `closed on a ComfyUI-Manager no-op or a shadow copy). That path installs from ` +
        `the Comfy Registry, so a git \`ref\`/\`source: "git"\` cannot be honoured and ` +
        `will NOT be silently ignored. Drop the git options to install it normally, ` +
        `or manage a git checkout of the panel yourself (a symlinked dev install is ` +
        `never touched by these tools).`,
    );
  }

  // A ref EMBEDDED in the id itself ("...comfyui-mcp-panel.git@v0.11.28",
  // ".../tree/v0.11.28") is just as much a requested version as the `version`
  // option — and it used to DIE here: targetsPanelPackExactly matched the URL,
  // the redirect threaded only `version`, and the user got NIGHTLY while the
  // response implied success. Honour the refs the registry path can honour;
  // refuse the rest, exactly like the git options above.
  const embeddedRef = parseGitUrl(id).ref;
  let version = opts.version;
  if (embeddedRef) {
    const registryVersion = registryInstallableRef(embeddedRef);
    if (!registryVersion) {
      throw new Error(
        `"${id}" embeds git ref "${embeddedRef}", which the verified panel path ` +
          `cannot honour: it installs the comfyui-mcp sidebar panel pack from the ` +
          `Comfy Registry, where only a strict semver (e.g. v0.11.28), "nightly" or ` +
          `"latest" names a version. Use a release tag, or pass \`version\` instead.`,
      );
    }
    if (version && version !== registryVersion) {
      throw new Error(
        `Conflicting panel versions: the id embeds "@${embeddedRef}" but ` +
          `\`version\` says "${version}". Pick one — this tool will not guess.`,
      );
    }
    if (action === "update") {
      throw new Error(
        `"${id}" embeds git ref "${embeddedRef}", but update always pulls the ` +
          `channel tip — a ref cannot be honoured. Use install/reinstall with the ` +
          `ref to get a specific panel version.`,
      );
    }
    version = registryVersion;
  }

  const result = await runPanelAction(action, undefined, { version });
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
              `have failed instead of reporting success. ` +
              (version
                ? embeddedRef
                  ? `The ref embedded in the URL (@${embeddedRef}) was honoured as ` +
                    `the target version (${version}). `
                  : `Your requested version (${version}) was used as the target. `
                : `It targets the 'nightly' channel. `) +
              `The mode/channel/useCmCli options do not apply on this path. Use ` +
              `install_panel directly for status/sync/pin.`,
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
    "Prefer the official comfy-cli subprocess instead of the ComfyUI-Manager HTTP API. Local operations use comfy-cli by default; set false to force Manager HTTP. Requires a local ComfyUI install — when the CLI is unavailable, the operation falls back to Manager HTTP automatically (disclosed in the result).",
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
          return await runVerifiedPanelAction("install", args.id, {
            version: args.version,
            ref: args.ref,
            source: args.source,
          });
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
          return await runVerifiedPanelAction("reinstall", args.id, {
            version: args.version,
          });
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
    "Repair a ComfyUI custom node pack's install and Python dependencies, or pass 'all' to repair every pack. Local operations prefer official comfy-cli; remote single-pack repairs use Manager HTTP. REFUSES the comfyui-mcp sidebar panel pack — 'fix' has no verified on-disk check, so use install_panel for the panel — and refuses 'all' while the panel is version-pinned.",
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
        // `fix` has no verified equivalent (it reports success off the Manager
        // queue, which proves nothing — #639), so a panel target is refused
        // rather than redirected. Bulk "all" is handled by the pin guard inside
        // the service.
        if (targetsPanelPackExactly(args.id)) {
          assertPanelNotTargetedUnverifiable("fix_custom_node", args.id);
        }
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
    "disable_custom_node",
    "Disable an installed ComfyUI custom node pack WITHOUT removing it — the reversible first step of a cleanup (re-enable with enable_custom_node; uninstall_custom_node removes a pack outright). Uses the ComfyUI-Manager HTTP API (works against remote instances) or official comfy-cli locally, and re-reads the installed-pack list afterwards so a Manager no-op is reported as NOT disabled rather than as success. A ComfyUI restart is required for the change to take effect. REFUSES the comfyui-mcp sidebar panel pack.",
    {
      id: z
        .string()
        .describe("Registry id / module name of the installed pack to disable."),
      useCmCli: useCmCliSchema,
    },
    async (args) => {
      try {
        // Same refusal as fix_custom_node: this path's post-state check reads
        // the Manager list, which cannot see a ".bak" shadow copy (#641) — the
        // panel goes through the verified install_panel path only.
        if (targetsPanelPackExactly(args.id)) {
          assertPanelNotTargetedUnverifiable("disable_custom_node", args.id);
        }
        const result = await disableCustomNode({ ...args, useCmCli: preferLocalComfyCli(args.useCmCli) });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "enable_custom_node",
    "Re-enable a ComfyUI custom node pack previously disabled with disable_custom_node. Uses the ComfyUI-Manager HTTP API (works against remote instances) or official comfy-cli locally, and re-reads the installed-pack list afterwards so a Manager no-op is reported as NOT enabled rather than as success. A ComfyUI restart is required for the change to take effect. REFUSES the comfyui-mcp sidebar panel pack.",
    {
      id: z
        .string()
        .describe("Registry id / module name of the installed pack to enable."),
      useCmCli: useCmCliSchema,
    },
    async (args) => {
      try {
        if (targetsPanelPackExactly(args.id)) {
          assertPanelNotTargetedUnverifiable("enable_custom_node", args.id);
        }
        const result = await enableCustomNode({ ...args, useCmCli: preferLocalComfyCli(args.useCmCli) });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "uninstall_custom_node",
    "Uninstall a ComfyUI custom node pack (removes it). IRREVERSIBLE through this tool — for a cleanup audit prefer disable_custom_node, which is reversible. The pack must be one ComfyUI-Manager tracks: an id that resolves nowhere is REFUSED before anything is queued (a drained queue would otherwise read exactly like a success), and a pack that is on disk but unmanaged is named so you can remove its directory yourself. After the queue drains the installed-pack list is re-read and the pack must be GONE before anything claims 'uninstalled'. A ComfyUI restart is required to unload it fully. REFUSES the comfyui-mcp sidebar panel pack.",
    {
      id: z
        .string()
        .describe("Registry id / module name of the installed pack to uninstall."),
      useCmCli: useCmCliSchema,
    },
    async (args) => {
      try {
        if (targetsPanelPackExactly(args.id)) {
          assertPanelNotTargetedUnverifiable("uninstall_custom_node", args.id);
        }
        const result = await uninstallCustomNode({ ...args, useCmCli: preferLocalComfyCli(args.useCmCli) });
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
