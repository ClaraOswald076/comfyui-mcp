/**
 * #1963 — periodic panel version check, with APPLY gated the same way as the
 * orchestrator self-update.
 *
 * Hello-time panel-sync is a FLOOR check (the minimum this orchestrator
 * needs). Most panel fixes never raise that floor, so a pack three versions
 * behind still reads "healthy". This path asks the published pyproject for
 * the newest panel, which is a few KB and safe on a metered link, and only
 * runs the verified `runPanelAction("update")` when the caller says APPLY.
 *
 * Pin / dev-symlink / auto-install-off / remote still refuse to touch the
 * pack. A failed latest-version probe never applies — we do not churn nightly
 * just because GitHub did not answer.
 */

import { parsePyproject } from "./node-authoring.js";
import {
  isPanelAutoInstallDisabled,
  PANEL_REGISTRY_ID,
  panelStatus,
  runPanelAction,
  type PanelStatus,
} from "./panel-installer.js";
import { isNewer } from "./self-update.js";
import { unreachableHostMessage } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { deferredAutoUpdateNote } from "./auto-update-gate.js";

/** Raw pyproject — the pack's published version, not GitHub Releases (those lag). */
export const PANEL_PYPROJECT_RAW_URL =
  "https://raw.githubusercontent.com/artokun/comfyui-mcp-panel/main/pyproject.toml";

const LATEST_TIMEOUT_MS = 5_000;

export type PanelAutoUpdateAction =
  | "up-to-date"
  | "deferred"
  | "updated"
  | "skipped-disabled"
  | "skipped-dev"
  | "skipped-pin"
  | "unavailable";

export interface PanelAutoUpdateResult {
  action: PanelAutoUpdateAction;
  from?: string;
  to?: string;
  note?: string;
}

export interface PanelAutoUpdateDeps {
  env: () => NodeJS.ProcessEnv;
  panelStatus: () => Promise<PanelStatus>;
  latestVersion: () => Promise<string | undefined>;
  updatePanel: () => Promise<{ installedVersion?: string }>;
}

async function defaultLatestVersion(): Promise<string | undefined> {
  return getLatestPublishedPanelVersion();
}

const defaultDeps: PanelAutoUpdateDeps = {
  env: () => process.env,
  panelStatus: () => panelStatus(),
  latestVersion: defaultLatestVersion,
  updatePanel: async () => {
    await runPanelAction("update");
    const after = await panelStatus();
    return { installedVersion: after.installedVersion };
  },
};

/**
 * Published panel version from the pack's pyproject on main. Never throws.
 * Refuses a body that is not this pack — a hijacked / wrong-repo response
 * must not become "latest".
 */
export async function getLatestPublishedPanelVersion(
  fetchImpl: typeof fetch = fetch,
): Promise<string | undefined> {
  let res: Response;
  try {
    res = await fetchImpl(PANEL_PYPROJECT_RAW_URL, {
      signal: AbortSignal.timeout(LATEST_TIMEOUT_MS),
      headers: { accept: "text/plain" },
    });
  } catch (err) {
    logger.debug(
      `[panel-auto-update] latest-version probe unreachable: ${
        unreachableHostMessage(err, PANEL_PYPROJECT_RAW_URL, "the panel version check").message
      }`,
    );
    return undefined;
  }
  if (!res.ok) {
    logger.debug(
      `[panel-auto-update] latest-version probe HTTP ${res.status} (host answered)`,
    );
    return undefined;
  }
  try {
    const toml = await res.text();
    const parsed = parsePyproject(toml);
    if (parsed.projectName !== PANEL_REGISTRY_ID) return undefined;
    const v = parsed.version?.trim();
    return v || undefined;
  } catch {
    return undefined;
  }
}

/**
 * One periodic tick: CHECK always (when we can), APPLY only when `apply` is
 * true. The caller owns the transport gate — this function must not re-derive
 * it, or the two will drift.
 */
export async function tickPanelAutoUpdate(
  opts: { apply: boolean; deps?: Partial<PanelAutoUpdateDeps> } = { apply: true },
): Promise<PanelAutoUpdateResult> {
  const deps: PanelAutoUpdateDeps = { ...defaultDeps, ...opts.deps };
  try {
    if (isPanelAutoInstallDisabled(deps.env())) {
      return { action: "skipped-disabled", note: "Panel auto-update disabled via COMFYUI_MCP_PANEL_AUTOINSTALL." };
    }

    const status = await deps.panelStatus();
    if (!status.applicable) {
      return { action: "unavailable", note: status.note || "Panel auto-update does not apply here." };
    }
    if (status.isDevSymlink) {
      return {
        action: "skipped-dev",
        from: status.installedVersion,
        note: "Dev symlink — panel auto-update will not modify it.",
      };
    }
    if (status.pin?.pinned) {
      return {
        action: "skipped-pin",
        from: status.installedVersion,
        note: "Panel is pinned — auto-update will not move it.",
      };
    }

    const latest = await deps.latestVersion();
    const current = status.installedVersion;
    if (!latest || !current) {
      return {
        action: "unavailable",
        from: current,
        to: latest,
        note: "Could not determine the latest published panel version. This is NOT evidence that you are up to date.",
      };
    }
    if (!isNewer(latest, current)) {
      return { action: "up-to-date", from: current, to: latest };
    }

    if (!opts.apply) {
      return {
        action: "deferred",
        from: current,
        to: latest,
        note: deferredAutoUpdateNote({ component: "panel", from: current, to: latest }),
      };
    }

    const after = await deps.updatePanel();
    return {
      action: "updated",
      from: current,
      to: after.installedVersion ?? latest,
      note:
        `Updated ComfyUI-MCP panel ${current} → ${after.installedVersion ?? latest}. ` +
        `Restart ComfyUI to load it.`,
    };
  } catch (err) {
    logger.debug(
      `[panel-auto-update] tick failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return {
      action: "unavailable",
      note: err instanceof Error ? err.message : String(err),
    };
  }
}
