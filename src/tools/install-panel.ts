import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  panelStatus,
  runPanelAction,
} from "../services/panel-installer.js";
import {
  evaluatePanelSync,
  performPanelSync,
  requiredPanelVersion,
} from "../services/panel-sync.js";
import {
  clearPanelVersionPin,
  getPanelPinState,
  PANEL_PIN_ENV_VAR,
  setPanelVersionPin,
} from "../services/panel-settings.js";
import { errorToToolResult } from "../utils/errors.js";

function json(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

export function registerInstallPanelTools(server: McpServer): void {
  server.tool(
    "install_panel",
    "Install, update, reinstall, sync, pin, or report status of the ComfyUI sidebar " +
      "panel ('comfyui-agent-panel' on the Comfy Registry; repo comfyui-mcp-panel) in " +
      "the LOCAL ComfyUI's custom_nodes. Uses the same ComfyUI-Manager path as " +
      "install_custom_node and always targets the 'nightly' (git-HEAD) channel. " +
      "Local-only (no-op/refuses in remote/cloud mode) and NEVER modifies a dev " +
      "install (a symlinked panel dir). After install/update/reinstall/sync, ComfyUI " +
      "must be RESTARTED to load the new/updated node — this tool does not " +
      "auto-restart. The panel is also auto-installed-if-missing when the MCP server " +
      "loads. A version PIN (action='pin') holds the panel where it is: while a pin " +
      "is set, install/update/reinstall/sync and the auto-install all refuse, and " +
      "'sync' only warns that a newer panel exists.",
    {
      action: z
        .enum([
          "status",
          "install",
          "update",
          "reinstall",
          "sync",
          "pin",
          "unpin",
        ])
        .default("status")
        .describe(
          "status: report installed/version/dev-symlink/pin plus a sync assessment " +
            "(never errors). sync: bring the panel up to what this orchestrator " +
            "needs — no-ops when already current, WARNS ONLY when pinned, and " +
            "reports the version re-read from disk afterwards. install: add the " +
            "panel (nightly). update: pull the latest nightly. reinstall: uninstall " +
            "+ reinstall (nightly). pin: hold the panel at a version (requires " +
            "`version`). unpin: clear the pin so a sync can proceed. " +
            "install/update/reinstall/sync refuse on a dev symlink or an active " +
            "pin, and require a local COMFYUI_PATH.",
        ),
      version: z
        .string()
        .optional()
        .describe(
          "action='pin' only: the panel version to hold at, e.g. '0.11.20'. Use the " +
            "installedVersion from action='status' to pin where you already are.",
        ),
      reason: z
        .string()
        .optional()
        .describe("action='pin' only: why the user is pinning (stored with the pin)."),
    },
    async ({ action, version, reason }) => {
      try {
        if (action === "status") {
          const status = await panelStatus();
          return json({ ...status, sync: evaluatePanelSync(status) });
        }

        if (action === "sync") {
          return json(await performPanelSync());
        }

        if (action === "pin") {
          const target = (version ?? "").trim();
          if (!target) {
            // Refuse rather than guess a version for them — a pin the user did
            // not choose is worse than no pin.
            throw new Error(
              "install_panel(action='pin') needs a `version` (e.g. '0.11.20'). Run " +
                "install_panel(action='status') and pass its installedVersion to pin " +
                "where you are now.",
            );
          }
          const pin = setPanelVersionPin(target, reason);
          const status = await panelStatus();
          return json({
            action: "pin",
            pin: status.pin,
            requestedVersion: pin.version,
            installedVersion: status.installedVersion,
            requiredPanelVersion: requiredPanelVersion(),
            // A pin records intent; it does NOT move the panel. Saying so
            // prevents "pinned to 0.11.20" being read as "now on 0.11.20".
            note:
              `Pinned to ${pin.version}. This records intent only — it does NOT change ` +
              `what is installed (currently ${status.installedVersion ?? "unknown"}). ` +
              `install/update/reinstall/sync and the on-load auto-install will now ` +
              `refuse until the pin is cleared with install_panel(action='unpin').`,
          });
        }

        if (action === "unpin") {
          const removed = clearPanelVersionPin();
          const after = getPanelPinState();
          return json({
            action: "unpin",
            removed: removed ?? null,
            pin: after,
            note: after.pinned
              ? `The persisted pin was ${removed ? "removed" : "already absent"}, but a ` +
                `pin is STILL in force via the ${PANEL_PIN_ENV_VAR} environment variable. ` +
                `Unset ${PANEL_PIN_ENV_VAR} (or set it to 'off') in the environment / ` +
                `~/.comfyui-mcp/.env and restart the orchestrator before syncing.`
              : removed
                ? `Pin removed (was ${removed.version}). install_panel(action='sync') can ` +
                  `now proceed.`
                : `No pin was set; nothing to clear. install_panel(action='sync') can ` +
                  `proceed.`,
          });
        }

        return json(await runPanelAction(action));
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}
