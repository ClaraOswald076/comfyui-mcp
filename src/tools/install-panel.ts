import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  panelStatus,
  runPanelAction,
  withPanelOpLock,
} from "../services/panel-installer.js";
import {
  classifyPinWrite,
  evaluatePanelSync,
  performPanelSync,
  requiredPanelVersion,
} from "../services/panel-sync.js";
import {
  clearPanelVersionPin,
  describePanelPin,
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
          // Serialized with panel mutations: a pin must not commit halfway
          // through an in-flight install/update (see withPanelOpLock). The
          // RESOLVED state is read INSIDE the same critical section — reading it
          // after releasing the lock let a concurrent pin/unpin land in between,
          // so the response could describe a pin that was no longer the real one.
          const { pin, resolved } = await withPanelOpLock(async () => {
            const written = setPanelVersionPin(target, reason);
            return { pin: written, resolved: getPanelPinState() };
          });
          // What actually governs is NOT necessarily what we just wrote:
          // COMFYUI_MCP_PANEL_PIN takes precedence (so the saved pin can be inert,
          // or the panel left unpinned outright by `=off`), and a concurrent write
          // may have superseded ours. Reporting the write as protection without
          // checking is the fabricated-success failure this feature exists to
          // prevent, so each outcome is named distinctly.
          const outcome = classifyPinWrite(resolved, pin.version);
          // panelStatus is advisory here (it only supplies installedVersion for
          // the message); the authoritative pin is `resolved`, captured above.
          const status = await panelStatus();
          return json({
            action: "pin",
            pin: resolved,
            outcome,
            /** Is the pin we just SAVED the one actually in force? */
            active: outcome === "active",
            requestedVersion: pin.version,
            installedVersion: status.installedVersion,
            requiredPanelVersion: requiredPanelVersion(),
            // A pin records intent; it does NOT move the panel. Saying so
            // prevents "pinned to 0.11.20" being read as "now on 0.11.20".
            note:
              outcome === "active"
                ? `Pinned to ${pin.version}. This records intent only — it does NOT change ` +
                  `what is installed (currently ${status.installedVersion ?? "unknown"}). ` +
                  `install/update/reinstall/sync and the on-load auto-install will now ` +
                  `refuse until the pin is cleared with install_panel(action='unpin').`
                : outcome === "env-overrides-with-pin"
                  ? `Saved a pin at ${pin.version}, but it is NOT the pin in force: the ` +
                    `${PANEL_PIN_ENV_VAR} environment variable takes precedence and the ` +
                    `panel is ${describePanelPin(resolved)}. The panel IS protected — ` +
                    `just at the env pin's version, not yours. Unset ${PANEL_PIN_ENV_VAR} ` +
                    `and restart the orchestrator for the saved ${pin.version} to govern.`
                  : outcome === "superseded"
                    ? `Saved a pin at ${pin.version}, but another pin was written at the ` +
                      `same time and won: the panel is ${describePanelPin(resolved)}. The ` +
                      `panel IS pinned, just not at ${pin.version} — re-run the pin if you ` +
                      `meant yours to stand.`
                    : `WARNING — the pin was saved to disk but is NOT IN FORCE, and the ` +
                      `panel is NOT protected: ${PANEL_PIN_ENV_VAR} is set to an explicit ` +
                      `"no pin" value, which overrides the saved pin. ` +
                      `install/update/reinstall/sync will still proceed. Unset ` +
                      `${PANEL_PIN_ENV_VAR} in the environment / ~/.comfyui-mcp/.env and ` +
                      `restart the orchestrator for the saved pin to take effect.`,
          });
        }

        if (action === "unpin") {
          // Same critical section as the pin path: the post-state is captured
          // WITH the write, so a concurrent pin can't be misreported as ours.
          const { removed, after } = await withPanelOpLock(async () => {
            const gone = clearPanelVersionPin();
            return { removed: gone, after: getPanelPinState() };
          });
          return json({
            action: "unpin",
            removed: removed ?? null,
            pin: after,
            note: after.pinned
              ? after.source === "env"
                ? `The persisted pin was ${removed ? "removed" : "already absent"}, but a ` +
                  `pin is STILL in force via the ${PANEL_PIN_ENV_VAR} environment variable. ` +
                  `Unset ${PANEL_PIN_ENV_VAR} (or set it to 'off') in the environment / ` +
                  `~/.comfyui-mcp/.env and restart the orchestrator before syncing.`
                : `The persisted pin was ${removed ? "removed" : "already absent"}, but the ` +
                  `panel is pinned again: ${describePanelPin(after)}. Something wrote a new ` +
                  `pin at the same time — re-run unpin if you still want it cleared.`
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
