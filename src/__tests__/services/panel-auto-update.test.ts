// #1963 — panel auto-update: CHECK always, APPLY only when the caller says so.
//
// The reporter sat on panel 0.15.28 vs 0.15.31 while the floor-only sync
// reported healthy. This path asks the published pyproject, not the floor.

import { describe, expect, it, vi } from "vitest";
import {
  getLatestPublishedPanelVersion,
  tickPanelAutoUpdate,
  PANEL_PYPROJECT_RAW_URL,
  type PanelAutoUpdateDeps,
} from "../../services/panel-auto-update.js";
import { PANEL_REGISTRY_ID, type PanelStatus } from "../../services/panel-installer.js";
import { deferredAutoUpdateNote } from "../../services/auto-update-gate.js";
import type { PanelPinState } from "../../services/panel-settings.js";

const UNPINNED: PanelPinState = { pinned: false, source: "none" };

function status(over: Partial<PanelStatus> = {}): PanelStatus {
  return {
    applicable: true,
    installed: true,
    dir: "/fake/comfy/custom_nodes/comfyui-mcp-panel",
    installedVersion: "0.15.28",
    isDevSymlink: false,
    targetVersion: "nightly",
    shadows: [],
    pin: UNPINNED,
    note: "",
    ...over,
  };
}

function makeDeps(opts: {
  status?: PanelStatus;
  latest?: string | undefined;
  env?: NodeJS.ProcessEnv;
  updateTo?: string;
}): { deps: PanelAutoUpdateDeps; updates: number } {
  const updates = { n: 0 };
  const deps: PanelAutoUpdateDeps = {
    env: () => opts.env ?? {},
    panelStatus: async () => opts.status ?? status(),
    latestVersion: async () => opts.latest,
    updatePanel: async () => {
      updates.n += 1;
      return { installedVersion: opts.updateTo ?? opts.latest };
    },
  };
  return {
    deps,
    get updates() {
      return updates.n;
    },
  } as { deps: PanelAutoUpdateDeps; updates: number };
}

describe("tickPanelAutoUpdate — check vs apply (#1963)", () => {
  it("the reported case: 0.15.28 vs 0.15.31, APPLY off → deferred, pack untouched", async () => {
    const h = makeDeps({ latest: "0.15.31" });
    const res = await tickPanelAutoUpdate({ apply: false, deps: h.deps });
    expect(res.action).toBe("deferred");
    expect(res.from).toBe("0.15.28");
    expect(res.to).toBe("0.15.31");
    expect(h.updates).toBe(0);
    expect(res.note).toBe(
      deferredAutoUpdateNote({ component: "panel", from: "0.15.28", to: "0.15.31" }),
    );
  });

  it("the same versions at the desk (APPLY on) → update runs", async () => {
    const h = makeDeps({ latest: "0.15.31", updateTo: "0.15.31" });
    const res = await tickPanelAutoUpdate({ apply: true, deps: h.deps });
    expect(res.action).toBe("updated");
    expect(h.updates).toBe(1);
    expect(res.from).toBe("0.15.28");
    expect(res.to).toBe("0.15.31");
    expect(res.note).toMatch(/Restart ComfyUI/);
  });

  it("already current → no mutation", async () => {
    const h = makeDeps({
      status: status({ installedVersion: "0.15.31" }),
      latest: "0.15.31",
    });
    const res = await tickPanelAutoUpdate({ apply: true, deps: h.deps });
    expect(res.action).toBe("up-to-date");
    expect(h.updates).toBe(0);
  });

  it("a pin is a promise — never moves the pack, even at the desk", async () => {
    const h = makeDeps({
      status: status({ pin: { pinned: true, source: "settings", version: "0.15.28" } }),
      latest: "0.15.31",
    });
    const res = await tickPanelAutoUpdate({ apply: true, deps: h.deps });
    expect(res.action).toBe("skipped-pin");
    expect(h.updates).toBe(0);
  });

  it("a dev symlink is never touched", async () => {
    const h = makeDeps({
      status: status({ isDevSymlink: true }),
      latest: "0.15.31",
    });
    const res = await tickPanelAutoUpdate({ apply: true, deps: h.deps });
    expect(res.action).toBe("skipped-dev");
    expect(h.updates).toBe(0);
  });

  it("COMFYUI_MCP_PANEL_AUTOINSTALL=0 disables unattended apply", async () => {
    const h = makeDeps({
      latest: "0.15.31",
      env: { COMFYUI_MCP_PANEL_AUTOINSTALL: "0" },
    });
    const res = await tickPanelAutoUpdate({ apply: true, deps: h.deps });
    expect(res.action).toBe("skipped-disabled");
    expect(h.updates).toBe(0);
  });

  it("an unknown latest version does NOT churn nightly just in case", async () => {
    const h = makeDeps({ latest: undefined });
    const res = await tickPanelAutoUpdate({ apply: true, deps: h.deps });
    expect(res.action).toBe("unavailable");
    expect(h.updates).toBe(0);
    expect(res.note).toMatch(/NOT evidence that you are up to date/);
  });
});

describe("getLatestPublishedPanelVersion drives parsePyproject on the real URL", () => {
  it("accepts this pack's pyproject and returns its version", async () => {
    const toml = `[project]\nname = "${PANEL_REGISTRY_ID}"\nversion = "0.15.31"\n`;
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe(PANEL_PYPROJECT_RAW_URL);
      return {
        ok: true,
        text: async () => toml,
      } as Response;
    }) as unknown as typeof fetch;
    await expect(getLatestPublishedPanelVersion(fetchImpl)).resolves.toBe("0.15.31");
  });

  it("refuses a body that is not this pack — a wrong-repo response is not latest", async () => {
    const toml = `[project]\nname = "some-other-pack"\nversion = "9.9.9"\n`;
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      text: async () => toml,
    })) as unknown as typeof fetch;
    await expect(getLatestPublishedPanelVersion(fetchImpl)).resolves.toBeUndefined();
  });

  it("an HTTP error is undetermined, not a version", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 500,
    })) as unknown as typeof fetch;
    await expect(getLatestPublishedPanelVersion(fetchImpl)).resolves.toBeUndefined();
  });
});
