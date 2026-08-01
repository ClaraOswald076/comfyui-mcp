// Node-pack auto-sync: decide whether the installed sidebar panel pack
// (comfyui-agent-panel) is behind what THIS orchestrator build needs, and — when
// it is, and only when the user has not pinned it — run the sync through the
// hardened, verified install_panel path.
//
// WHY THIS EXISTS. The orchestrator ships on npm; the panel ships on the Comfy
// Registry. Updating one does not update the other, so users end up running a
// new orchestrator against an old panel. The failures that produces are
// confusing and hard to diagnose (a bridge command the panel simply doesn't
// implement), which is exactly the report we got from the community.
//
// TWO RULES GOVERN EVERYTHING HERE:
//
//  1. NEVER REPORT A SYNC THAT DID NOT HAPPEN. This feature sits on top of the
//     #639/#641 fabricate-success fixes, so it inherits their discipline: the
//     mutation runs through `runPanelAction`, which fails closed unless the pack
//     provably MOVED on disk, and the version we report afterwards is RE-READ
//     from disk, never the version we intended to install.
//
//  2. NEVER MOVE A PINNED USER. A pin is a promise. `evaluatePanelSync` refuses
//     to recommend a sync while a pin is in force, `performPanelSync` refuses to
//     execute one, and `runPanelAction` itself refuses at the choke point. Every
//     "can't tell" (an unreadable pin, an unreadable installed version, a shadow
//     copy) resolves to "don't touch it", never to "probably fine".

import {
  panelStatus,
  runPanelAction,
  defaultDeps,
  type PanelInstallerDeps,
  type PanelStatus,
} from "./panel-installer.js";
import {
  describePanelPin,
  PANEL_PIN_ENV_VAR,
  type PanelPinState,
} from "./panel-settings.js";
import {
  BRIDGE_CMD_MIN_PANEL_VERSION,
  MIN_PANEL_VERSION_FOR_BRIDGE_COMMANDS,
} from "./ui-bridge.js";
import { compareSemver, detectInstallMode } from "./self-update.js";

/**
 * Strict semver screen. `compareSemver` returns 0 for anything it cannot parse,
 * so an unscreened "nightly" / "dev" / "" would compare EQUAL to the required
 * version and be reported as up to date — a silent wrong answer. Everything here
 * screens first and reports `unknown` rather than guessing.
 */
const SEMVER_RE = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function isComparableVersion(v: string | undefined): v is string {
  return typeof v === "string" && SEMVER_RE.test(v.trim());
}

/**
 * The highest panel version THIS orchestrator build is known to require.
 *
 * Derived, not hand-maintained: it is the maximum of the bridge baseline and
 * every per-command minimum the orchestrator declares. A release that adds a
 * command needing a newer panel raises this automatically, so the sync advice
 * can never drift from the code that actually needs the newer panel.
 */
export function requiredPanelVersion(): string {
  let best = MIN_PANEL_VERSION_FOR_BRIDGE_COMMANDS;
  for (const min of Object.values(BRIDGE_CMD_MIN_PANEL_VERSION)) {
    if (!isComparableVersion(min)) continue;
    if (!isComparableVersion(best) || compareSemver(min, best) > 0) best = min;
  }
  return best;
}

export type PanelSyncDecision =
  /** Behind, nothing pinned, nothing ambiguous → sync is safe to run. */
  | "sync"
  /** Behind, but the user pinned the panel → WARN ONLY. Never sync. */
  | "pinned-warn"
  /** The installed panel already meets what this orchestrator needs. */
  | "up-to-date"
  /** Something must be fixed by a human first (shadow copy, unreadable pin). */
  | "blocked"
  /** Can't read a comparable installed version → don't guess, don't touch. */
  | "unknown"
  /** Symlinked dev checkout — managed by its owner, never by us. */
  | "dev-install"
  /** Remote/cloud, or no local ComfyUI: panel sync doesn't apply here. */
  | "not-applicable";

export interface PanelSyncAssessment {
  decision: PanelSyncDecision;
  /** Highest panel version this orchestrator build is known to require. */
  requiredPanelVersion: string;
  /** On-disk panel version; undefined when absent or unreadable. */
  installedVersion?: string;
  /** This orchestrator's own npm version, when it can be read. */
  orchestratorVersion?: string;
  /** The active pin (see panel-settings). */
  pin: PanelPinState;
  /**
   * True only when we PROVED the panel is older than `requiredPanelVersion` (a
   * comparable installed version below it, or a confirmed absent pack). An
   * unreadable version is never "behind".
   */
  behind: boolean;
  /** Plain-language explanation for the user. */
  summary: string;
}

export interface EvaluateOptions {
  /** Override for tests; defaults to the running package's version. */
  orchestratorVersion?: string;
  /** Override for tests; defaults to the derived requirement. */
  requiredVersion?: string;
}

/**
 * Pure decision function over a `PanelStatus` snapshot. No I/O, no mutation —
 * every branch is directly testable, which is the point: this is the logic that
 * decides whether we are allowed to touch a user's install.
 */
export function evaluatePanelSync(
  status: PanelStatus,
  opts: EvaluateOptions = {},
): PanelSyncAssessment {
  const required = opts.requiredVersion ?? requiredPanelVersion();
  const orchestratorVersion =
    opts.orchestratorVersion ?? detectInstallMode().currentVersion ?? undefined;
  const pin = status.pin ?? { pinned: false, source: "none" as const };

  const base = {
    requiredPanelVersion: required,
    installedVersion: status.installedVersion,
    orchestratorVersion,
    pin,
  };
  const orch = orchestratorVersion ? `comfyui-mcp ${orchestratorVersion}` : "this orchestrator";

  if (!status.applicable) {
    return {
      ...base,
      decision: "not-applicable",
      behind: false,
      summary:
        `Panel sync does not apply here: ${status.note || "no local ComfyUI is configured"}. ` +
        `The panel pack is managed on the machine that runs ComfyUI.`,
    };
  }

  // A symlinked dev checkout belongs to whoever made it. Check this BEFORE the
  // pin: "we don't touch dev installs" is the stronger, older promise, and
  // telling a developer to unpin would be wrong advice.
  if (status.isDevSymlink) {
    return {
      ...base,
      decision: "dev-install",
      behind: false,
      summary:
        `The panel at ${status.dir ?? "custom_nodes"} is a dev symlink — update it ` +
        `through its own git checkout. Nothing here will modify it.`,
    };
  }

  // Can't prove there is no pin → behave as if there is one.
  if (pin.indeterminate) {
    return {
      ...base,
      decision: "blocked",
      behind: false,
      summary:
        `Cannot determine whether the panel is version-pinned (${describePanelPin(pin)}), ` +
        `so nothing will be changed. Fix or remove the settings file, or set ` +
        `${PANEL_PIN_ENV_VAR}=off, then re-check.`,
    };
  }

  // A shadow copy means the SERVED panel is not the one on disk, so neither the
  // "you are behind" reading nor any post-sync version claim would be true.
  if (status.shadows.length > 0) {
    const names = status.shadows.map((s) => `"${s.name}"`).join(", ");
    return {
      ...base,
      decision: "blocked",
      behind: false,
      summary:
        `A shadow copy of the panel is present in custom_nodes (${names}). ComfyUI ` +
        `serves it too, and a dot-prefixed dir wins by sort order, so the browser may ` +
        `be loading it instead of the real panel — the installed version below cannot ` +
        `be trusted. Move the shadow copy OUT of custom_nodes and hard-refresh the ` +
        `ComfyUI tab before syncing anything.`,
    };
  }

  if (!status.installed) {
    // Not installed at all. That is definitionally behind, but a pin still wins:
    // installing the nightly channel would land some version other than the
    // pinned one.
    if (pin.pinned) {
      return {
        ...base,
        decision: "pinned-warn",
        behind: true,
        summary:
          `The panel pack is not installed, and ${orch} needs panel ${required}+. ` +
          `You are ${describePanelPin(pin)}, so nothing will be installed automatically. ` +
          `Clear the pin (install_panel(action='unpin')) to let the sync install it.`,
      };
    }
    return {
      ...base,
      decision: "sync",
      behind: true,
      summary:
        `The panel pack is not installed and ${orch} needs panel ${required}+. ` +
        `Syncing will install it, then ComfyUI must be restarted.`,
    };
  }

  if (!isComparableVersion(status.installedVersion)) {
    return {
      ...base,
      decision: "unknown",
      behind: false,
      summary:
        `The panel is installed at ${status.dir ?? "custom_nodes"} but its version ` +
        `(${status.installedVersion ?? "unreadable"}) is not a comparable version ` +
        `number, so it cannot be compared against the ${required} this orchestrator ` +
        `needs. NOT syncing on a guess — check the pack's pyproject.toml, or run ` +
        `install_panel(action='update') deliberately.`,
    };
  }

  const behind = compareSemver(status.installedVersion, required) < 0;

  if (pin.pinned) {
    if (!behind) {
      return {
        ...base,
        decision: "up-to-date",
        behind: false,
        summary:
          `Panel ${status.installedVersion} already meets what ${orch} needs ` +
          `(${required}+). You are ${describePanelPin(pin)}; nothing to do.`,
      };
    }
    // THE WARN CASE. Say what exists, say they're pinned, change nothing.
    return {
      ...base,
      decision: "pinned-warn",
      behind: true,
      summary:
        `Heads up: ${orch} expects panel ${required}+, and you are on panel ` +
        `${status.installedVersion} — a newer panel that matches your orchestrator ` +
        `exists. You are ${describePanelPin(pin)}, so NOTHING has been changed and ` +
        `nothing will be. If you want the newer panel, clear the pin first ` +
        `(install_panel(action='unpin')` +
        (pin.source === "env"
          ? `, though this pin comes from ${PANEL_PIN_ENV_VAR} and must be unset in ` +
            `the environment`
          : ``) +
        `) and then sync.`,
    };
  }

  if (!behind) {
    return {
      ...base,
      decision: "up-to-date",
      behind: false,
      summary:
        `Panel ${status.installedVersion} already meets what ${orch} needs ` +
        `(${required}+). Nothing to do.`,
    };
  }

  return {
    ...base,
    decision: "sync",
    behind: true,
    summary:
      `Panel ${status.installedVersion} is older than the ${required}+ that ${orch} ` +
      `needs. Syncing will pull the latest panel via ComfyUI-Manager; ComfyUI must ` +
      `be restarted afterwards.`,
  };
}

export interface PanelSyncResult {
  /** True ONLY when the pack provably moved on disk and we re-read the result. */
  synced: boolean;
  /** The decision that was acted on (re-evaluated at execution time). */
  decision: PanelSyncDecision;
  /** On-disk version before the op, when it was readable. */
  previousVersion?: string;
  /**
   * The version RE-READ from disk after the op — the actual outcome, not the
   * intended one. Only ever set when `synced` is true.
   */
  verifiedVersion?: string;
  /** Highest panel version this orchestrator build needs. */
  requiredPanelVersion: string;
  /**
   * True when the sync landed but the resulting version is STILL below what the
   * orchestrator needs. The sync really happened, so `synced` is true — but the
   * mismatch is not resolved and the user must be told so.
   */
  stillBehind?: boolean;
  /** True when ComfyUI must be restarted to load what just landed. */
  restartRequired?: boolean;
  message: string;
}

export interface PerformSyncOptions {
  deps?: PanelInstallerDeps;
  orchestratorVersion?: string;
  requiredVersion?: string;
}

/**
 * Run the sync, honouring every guard.
 *
 * Contract, in order:
 *  - Re-evaluate the decision NOW (never act on a snapshot handed in from
 *    earlier — the pin may have been set in between).
 *  - Any decision other than `sync` returns `synced: false` WITHOUT queueing a
 *    mutation. In particular `pinned-warn` returns the warning and stops; this
 *    is a policy refusal, not an error.
 *  - `sync` delegates to `runPanelAction`, which THROWS unless the pack provably
 *    moved on disk (#639) and no shadow copy is serving (#641). That throw
 *    propagates: a verification failure is an explicit failure, never a
 *    downgraded "sync completed with warnings".
 *  - On success the installed version is RE-READ from disk and reported. If the
 *    re-read cannot confirm a version, we throw rather than claim a version we
 *    did not observe.
 */
export async function performPanelSync(
  opts: PerformSyncOptions = {},
): Promise<PanelSyncResult> {
  const deps = opts.deps ?? defaultDeps;
  const before = await panelStatus(deps);
  const assessment = evaluatePanelSync(before, {
    orchestratorVersion: opts.orchestratorVersion,
    requiredVersion: opts.requiredVersion,
  });

  if (assessment.decision !== "sync") {
    return {
      synced: false,
      decision: assessment.decision,
      previousVersion: before.installedVersion,
      requiredPanelVersion: assessment.requiredPanelVersion,
      message: assessment.summary,
    };
  }

  // `update` refreshes an existing pack; `install` is for a pack that isn't
  // there. Both go through the same verified path and both fail closed.
  const action = before.installed ? "update" : "install";
  const result = await runPanelAction(action, deps);

  // Re-read from disk. `runPanelAction` already proved movement, but the version
  // we hand back to the user must be one we OBSERVED after the fact, not the one
  // the installer intended or reported.
  const after = await panelStatus(deps);
  if (!after.installed || !after.installedVersion) {
    throw new Error(
      `Panel ${action} reported success, but re-reading the pack afterwards could ` +
        `not confirm an installed version${after.dir ? ` at ${after.dir}` : ""}. NOT ` +
        `reporting a completed sync. Check custom_nodes and re-run ` +
        `install_panel(action='status').`,
    );
  }
  if (after.shadows.length > 0) {
    throw new Error(
      `Panel ${action} applied on disk, but ${after.shadows.length} shadow copy/copies ` +
        `(${after.shadows.map((s) => `"${s.name}"`).join(", ")}) are still served from ` +
        `custom_nodes, so the browser may keep loading the OLD panel. NOT reporting a ` +
        `completed sync: move them out of custom_nodes and hard-refresh the ComfyUI tab.`,
    );
  }

  const stillBehind =
    isComparableVersion(after.installedVersion) &&
    compareSemver(after.installedVersion, assessment.requiredPanelVersion) < 0;

  return {
    synced: true,
    decision: "sync",
    previousVersion: result.previousVersion ?? before.installedVersion,
    verifiedVersion: after.installedVersion,
    requiredPanelVersion: assessment.requiredPanelVersion,
    stillBehind,
    restartRequired: true,
    message:
      `Panel synced: verified on disk as ${after.installedVersion}` +
      (result.previousVersion ? ` (was ${result.previousVersion})` : ``) +
      `. ` +
      (stillBehind
        ? `NOTE: that is still below the ${assessment.requiredPanelVersion} this ` +
          `orchestrator expects — the update applied but did not close the gap. `
        : ``) +
      `RESTART ComfyUI to load it.`,
  };
}
