// NEVER LEAVE THE CALLER WITH ONLY A TOOL THEY CANNOT INVOKE. (#774, #784)
//
// When the bridge refuses a graph WRITE because the connected panel is too old
// to fence the command against the active workflow (#718), the refusal has
// always ended with "Run install_panel(action:'update')". In a local session
// with a resolvable ComfyUI that is exactly right. In the two sessions that
// filed #774 and #784 it is a dead end:
//
//  - REMOTE/CLOUD (#774): install_panel is deliberately local-only. It answers
//    `decision: "not-applicable"` and changes nothing, because the panel lives
//    on someone else's filesystem. panel_update_node then refuses too — it
//    cannot verify an on-disk move (#639/#641) — and points BACK at
//    install_panel. Two tools, one circle, no way out.
//
//  - EMBEDDED PANEL SESSION (#784): the sidebar surface is the disjoint
//    `panel_*` tool set. install_panel was never in it, so the recommendation
//    named a tool that was not merely unhelpful but absent.
//
// A hard version gate is only defensible while its escape hatch works. So the
// recovery text is built HERE, from the session's actual context, under two
// rules:
//
//  1. Where install_panel provably CANNOT do the job — remote, cloud, or a
//     local install we have positively determined does not exist — it is not
//     named at all. The text gives the commands to run on the ComfyUI host.
//
//  2. Where it can, it is named AND the host-side commands are given as the
//     alternative, because whether install_panel is actually in the caller's
//     advertised tool set is a property of the client's surface, not of this
//     process, and is therefore not knowable from here. Offering both costs a
//     sentence and removes the only way this message can dead-end.
//
// Note what is deliberately NOT done: nothing here weakens the write gate. The
// panel still cannot make an unfenced write. This module only fixes the remedy.
//
// It is the SINGLE source of that advice — the bridge refusal, the install_panel
// status note, the sync assessment and panel_update_node's refusal all render
// it, so they cannot drift apart and contradict each other.

import { isLocalMode, isRemoteMode } from "../config.js";
import { lastPanelBaseResolution, panelBaseSync } from "./panel-workspace.js";

/** Upstream source of truth for the panel pack — the manual-recovery clone URL. */
export const PANEL_REPO_URL = "https://github.com/artokun/comfyui-mcp-panel.git";

/** Canonical custom_nodes directory name for the panel pack. */
export const PANEL_DIR_NAME = "comfyui-agent-panel";

/** Why install_panel provably cannot perform the update in this session. */
export type PanelRecoveryBlocker =
  /** A non-loopback COMFYUI_URL — the pack is on the remote host's disk. */
  | "remote"
  /** Comfy Cloud — there is no custom_nodes we can touch at all. */
  | "cloud"
  /** Local, but we RESOLVED that there is no ComfyUI root to act on. */
  | "no-local-workspace";

export interface PanelRecoveryContext {
  /**
   * False ONLY when we have positively established that install_panel cannot
   * act here. "We haven't checked yet" resolves to true — recommending a tool
   * that turns out to be a no-op is a much smaller failure than withholding the
   * one remedy that would have worked.
   */
  installPanelUsable: boolean;
  /** Set whenever `installPanelUsable` is false. */
  blocker?: PanelRecoveryBlocker;
  /** Resolved ComfyUI root, when known — used to make the commands concrete. */
  comfyuiPath?: string;
}

/** Resolve the recovery context from the live deployment mode. */
export function panelRecoveryContext(): PanelRecoveryContext {
  if (!isLocalMode()) {
    // Not local. `isRemoteMode()` distinguishes a non-loopback COMFYUI_URL from
    // Comfy Cloud (an API key), which get different host-side advice.
    return {
      installPanelUsable: false,
      blocker: isRemoteMode() ? "remote" : "cloud",
    };
  }
  // Local. Only a RESOLVED "there is no local ComfyUI" counts as a blocker —
  // an unprimed cache means we have not looked, not that there is nothing
  // there, and must not suppress the tool that would have fixed it.
  const resolution = lastPanelBaseResolution();
  if (resolution && !resolution.base) {
    return { installPanelUsable: false, blocker: "no-local-workspace" };
  }
  return { installPanelUsable: true, comfyuiPath: panelBaseSync() };
}

function blockerPhrase(blocker: PanelRecoveryBlocker | undefined): string {
  switch (blocker) {
    case "remote":
      return (
        "this session targets a REMOTE ComfyUI, so the panel pack is on that host's " +
        "disk and no tool here can move it"
      );
    case "cloud":
      return (
        "this session targets Comfy Cloud, which has no custom_nodes this " +
        "orchestrator can write"
      );
    case "no-local-workspace":
      return "no local ComfyUI install could be resolved from here";
    default:
      return "install_panel cannot perform the update from here";
  }
}

/**
 * The manual, host-side update. Written as a real command sequence because the
 * caller may be an agent with no ability to ask a human to "use the Manager UI",
 * and it covers BOTH install shapes: a git checkout fast-forwards, while a Comfy
 * Registry zip install has no `.git` to pull and must be replaced (#771).
 *
 * The BACKUP LEAVES custom_nodes on purpose. ComfyUI serves every directory
 * under custom_nodes as a web extension — including dot-prefixed ones — so a
 * copy parked next to the panel would shadow it in the browser and the update
 * would look like it did nothing (#641). Moving it to a sibling of custom_nodes
 * is the difference between a fix and a confusing non-fix.
 */
export function manualPanelUpdateCommands(comfyuiPath?: string): string {
  const root = comfyuiPath ?? "<ComfyUI>";
  return (
    `cd "${root}/custom_nodes" && git -C ${PANEL_DIR_NAME} pull --ff-only` +
    ` — or, if ${PANEL_DIR_NAME} has no .git (a Comfy Registry zip install, so there is ` +
    `nothing to pull), replace it instead: ` +
    `git clone --depth 1 ${PANEL_REPO_URL} ../.agent-panel-new && ` +
    `mkdir -p ../custom_nodes_backup && ` +
    `mv ${PANEL_DIR_NAME} ../custom_nodes_backup/ && ` +
    `mv ../.agent-panel-new ${PANEL_DIR_NAME}` +
    ` (keep the old copy OUT of custom_nodes — ComfyUI serves every directory in ` +
    `there, so a leftover copy would shadow the new panel in the browser)`
  );
}

/** The trailing "and then" every variant shares. */
const RESTART_AND_REFRESH =
  `restart ComfyUI, then hard-refresh the ComfyUI browser tab (Ctrl+Shift+R) so it ` +
  `loads the updated bundle — a restart alone leaves the tab running its cached old ` +
  `panel JS; rebinding cannot add the missing capability`;

/**
 * The recovery sentence for a panel that is too old for the write gate. Names
 * install_panel only where install_panel can really do it, and ALWAYS carries a
 * host-side command sequence so the caller is never left without a next step.
 */
export function describePanelUpdateRecovery(
  ctx: PanelRecoveryContext = panelRecoveryContext(),
): string {
  if (ctx.installPanelUsable) {
    return (
      `Run install_panel(action:'update') — or, if install_panel is not in this ` +
      `session's tool set, update the pack on the ComfyUI host: ` +
      `${manualPanelUpdateCommands(ctx.comfyuiPath)} — then ${RESTART_AND_REFRESH}`
    );
  }
  return (
    `Update the panel ON THE COMFYUI HOST — ${blockerPhrase(ctx.blocker)}. On the host ` +
    `run: ${manualPanelUpdateCommands(ctx.comfyuiPath)}. Then ${RESTART_AND_REFRESH}`
  );
}

/**
 * The same advice as a redirect for tools that REFUSE to manage the panel
 * themselves (panel_update_node, fix_custom_node). Those refusals used to end
 * with a flat "Use install_panel instead", which is the #774/#784 dead end in
 * miniature.
 */
export function describePanelManagementRedirect(
  ctx: PanelRecoveryContext = panelRecoveryContext(),
): string {
  if (ctx.installPanelUsable) {
    return (
      `Use install_panel instead: install_panel(action='sync') brings the panel in line ` +
      `with this orchestrator and re-reads the installed version from disk, and ` +
      `action='status' reports it. If install_panel is not in this session's tool set, ` +
      `update the pack on the ComfyUI host instead: ` +
      `${manualPanelUpdateCommands(ctx.comfyuiPath)}.`
    );
  }
  return (
    `install_panel cannot help here either — ${blockerPhrase(ctx.blocker)}. Update the ` +
    `panel ON THE COMFYUI HOST: ${manualPanelUpdateCommands(ctx.comfyuiPath)}. Then ` +
    `restart ComfyUI and hard-refresh the ComfyUI browser tab (Ctrl+Shift+R).`
  );
}
