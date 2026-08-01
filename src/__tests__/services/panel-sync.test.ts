// Decision-logic tests for the node-pack auto-sync.
//
// Two invariants are what these tests exist to protect:
//   1. A sync that did not move bytes is NEVER reported as a success.
//   2. A user who pinned the panel is NEVER moved off that pin.
// Everything else here is supporting detail.

import { afterEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";

// panel-installer pulls config in transitively; stub it so importing doesn't
// trigger real port detection (mirrors panel-installer.test.ts).
vi.mock("../../config.js", () => ({
  config: { comfyuiPath: undefined as string | undefined },
  isLocalMode: () => true,
}));

import {
  evaluatePanelSync,
  performPanelSync,
  requiredPanelVersion,
  type PanelSyncDecision,
} from "../../services/panel-sync.js";
import {
  PANEL_REGISTRY_ID,
  type PanelInstallerDeps,
  type PanelStatus,
} from "../../services/panel-installer.js";
import type { PanelPinState } from "../../services/panel-settings.js";

const REQUIRED = "0.11.28";
const ORCH = "0.48.32";
const UNPINNED: PanelPinState = { pinned: false, source: "none" };

function status(over: Partial<PanelStatus> = {}): PanelStatus {
  return {
    applicable: true,
    installed: true,
    dir: "/fake/comfy/custom_nodes/comfyui-mcp-panel",
    installedVersion: "0.11.28",
    isDevSymlink: false,
    targetVersion: "nightly",
    shadows: [],
    pin: UNPINNED,
    note: "",
    ...over,
  };
}

function decide(over: Partial<PanelStatus>): PanelSyncDecision {
  return evaluatePanelSync(status(over), {
    requiredVersion: REQUIRED,
    orchestratorVersion: ORCH,
  }).decision;
}

describe("requiredPanelVersion", () => {
  it("is the maximum of the bridge baseline and every per-command minimum", () => {
    // Derived from the orchestrator's own declared command minimums, so it can
    // never drift from the code that needs the newer panel.
    expect(requiredPanelVersion()).toBe(REQUIRED);
  });
});

describe("evaluatePanelSync — the four required outcomes", () => {
  it("mismatch + NO pin → sync", () => {
    const a = evaluatePanelSync(status({ installedVersion: "0.11.3" }), {
      requiredVersion: REQUIRED,
      orchestratorVersion: ORCH,
    });
    expect(a.decision).toBe("sync");
    expect(a.behind).toBe(true);
    expect(a.requiredPanelVersion).toBe(REQUIRED);
    expect(a.installedVersion).toBe("0.11.3");
  });

  it("mismatch + pin → pinned-warn: warns a newer panel exists, syncs nothing", () => {
    const pin: PanelPinState = { pinned: true, version: "0.11.3", source: "settings" };
    const a = evaluatePanelSync(status({ installedVersion: "0.11.3", pin }), {
      requiredVersion: REQUIRED,
      orchestratorVersion: ORCH,
    });
    expect(a.decision).toBe("pinned-warn");
    expect(a.behind).toBe(true);
    // The warning must actually say all three things the owner asked for.
    expect(a.summary).toContain(REQUIRED); // a newer panel matching the orchestrator
    expect(a.summary).toContain("0.11.3"); // what they're on
    expect(a.summary).toMatch(/pinned/i); // that they're pinned
    expect(a.summary).toMatch(/unpin/i); // how to get off it
  });

  it("pin cleared → the same mismatch now decides sync", () => {
    const pinned = status({
      installedVersion: "0.11.3",
      pin: { pinned: true, version: "0.11.3", source: "settings" },
    });
    expect(
      evaluatePanelSync(pinned, { requiredVersion: REQUIRED, orchestratorVersion: ORCH })
        .decision,
    ).toBe("pinned-warn");
    // Same install, pin removed — nothing else changed.
    const cleared = { ...pinned, pin: UNPINNED };
    expect(
      evaluatePanelSync(cleared, { requiredVersion: REQUIRED, orchestratorVersion: ORCH })
        .decision,
    ).toBe("sync");
  });

  it("versions equal → up-to-date (no-op)", () => {
    const a = evaluatePanelSync(status({ installedVersion: REQUIRED }), {
      requiredVersion: REQUIRED,
      orchestratorVersion: ORCH,
    });
    expect(a.decision).toBe("up-to-date");
    expect(a.behind).toBe(false);
  });

  it("installed NEWER than required → up-to-date, never a downgrade", () => {
    expect(decide({ installedVersion: "0.12.0" })).toBe("up-to-date");
  });
});

describe("evaluatePanelSync — a pin is honoured in every shape", () => {
  it("an env pin blocks the sync just like a settings pin", () => {
    const pin: PanelPinState = { pinned: true, version: "0.11.3", source: "env" };
    const a = evaluatePanelSync(status({ installedVersion: "0.11.3", pin }), {
      requiredVersion: REQUIRED,
      orchestratorVersion: ORCH,
    });
    expect(a.decision).toBe("pinned-warn");
    // Must tell the user unpin alone won't clear an env pin.
    expect(a.summary).toContain("COMFYUI_MCP_PANEL_PIN");
  });

  it("a pin while already current is simply up-to-date (no nagging)", () => {
    const pin: PanelPinState = { pinned: true, version: REQUIRED, source: "settings" };
    expect(decide({ installedVersion: REQUIRED, pin })).toBe("up-to-date");
  });

  it("a pin blocks even a FRESH install of a missing panel", () => {
    const pin: PanelPinState = { pinned: true, version: "0.11.3", source: "settings" };
    const a = evaluatePanelSync(
      status({ installed: false, installedVersion: undefined, pin }),
      { requiredVersion: REQUIRED, orchestratorVersion: ORCH },
    );
    expect(a.decision).toBe("pinned-warn");
  });

  it("an UNREADABLE pin is treated as pinned, never as unpinned", () => {
    const pin: PanelPinState = { pinned: true, source: "settings", indeterminate: true };
    const a = evaluatePanelSync(status({ installedVersion: "0.11.3", pin }), {
      requiredVersion: REQUIRED,
      orchestratorVersion: ORCH,
    });
    expect(a.decision).toBe("blocked");
    expect(a.decision).not.toBe("sync");
  });
});

describe("evaluatePanelSync — cases where we must not guess", () => {
  it("missing panel + no pin → sync (install it)", () => {
    const a = evaluatePanelSync(status({ installed: false, installedVersion: undefined }), {
      requiredVersion: REQUIRED,
      orchestratorVersion: ORCH,
    });
    expect(a.decision).toBe("sync");
    expect(a.behind).toBe(true);
  });

  it.each(["nightly", "dev", "", "not-a-version"])(
    "an uncomparable installed version (%j) → unknown, not a silent up-to-date",
    (v) => {
      // compareSemver returns 0 for junk, so an unscreened compare would report
      // "equal" and quietly claim the panel is current. It must not.
      expect(decide({ installedVersion: v })).toBe("unknown");
    },
  );

  it("an unreadable installed version → unknown", () => {
    expect(decide({ installed: true, installedVersion: undefined })).toBe("unknown");
  });

  it("a shadow copy → blocked (the served panel isn't the one on disk)", () => {
    const a = evaluatePanelSync(
      status({
        installedVersion: "0.11.3",
        shadows: [{ name: ".comfyui-agent-panel.bak-0.11.3", version: "0.11.3" }],
      }),
      { requiredVersion: REQUIRED, orchestratorVersion: ORCH },
    );
    expect(a.decision).toBe("blocked");
    expect(a.summary).toContain(".comfyui-agent-panel.bak-0.11.3");
  });

  it("a dev symlink → dev-install, never touched", () => {
    expect(decide({ isDevSymlink: true, installedVersion: "0.1.0" })).toBe("dev-install");
  });

  it("remote/cloud → not-applicable", () => {
    expect(decide({ applicable: false, installed: false })).toBe("not-applicable");
  });
});

// ---------------------------------------------------------------------------
// performPanelSync — execution guards
// ---------------------------------------------------------------------------

const COMFY = "/fake/comfy";
const CUSTOM_NODES = join(COMFY, "custom_nodes");
const PANEL_DIR = join(CUSTOM_NODES, "comfyui-mcp-panel");

function pyproject(version: string): string {
  return `[project]\nname = "${PANEL_REGISTRY_ID}"\nversion = "${version}"\n`;
}

interface Harness {
  deps: PanelInstallerDeps;
  updates: number;
  installs: number;
}

/**
 * Minimal on-disk simulation: `files` is the live view the installer re-reads
 * after the op, so `onUpdate` is how a test says what actually landed (or that
 * nothing did).
 */
function makeDeps(opts: {
  installedVersion?: string;
  pin?: PanelPinState;
  dirs?: string[];
  /** Mutate the live files map to simulate what the Manager actually did. */
  onUpdate?: (files: Record<string, string>) => void;
  updateDetails?: unknown;
}): Harness {
  const files: Record<string, string> = {};
  if (opts.installedVersion !== undefined) {
    files[join(PANEL_DIR, "pyproject.toml")] = pyproject(opts.installedVersion);
  }
  const dirs = opts.dirs ?? (opts.installedVersion !== undefined ? ["comfyui-mcp-panel"] : []);
  const h: Harness = { updates: 0, installs: 0, deps: undefined as never };

  h.deps = {
    isLocalMode: () => true,
    comfyuiPath: () => COMFY,
    env: () => ({}),
    existsSync: (p) => p === CUSTOM_NODES || p in files,
    probeFile: (p) => p in files,
    isSymlink: () => false,
    isDirectory: () => true,
    realPath: () => undefined,
    readdir: (p) => (p === CUSTOM_NODES ? dirs : []),
    readFile: (p) => files[p] ?? "",
    gitRevision: () => undefined,
    readPin: () => opts.pin ?? UNPINNED,
    isReachable: async () => true,
    install: async () => {
      h.installs++;
      opts.onUpdate?.(files);
      return { mechanism: "manager-http", message: "installed", details: opts.updateDetails };
    },
    update: async () => {
      h.updates++;
      opts.onUpdate?.(files);
      return { mechanism: "manager-http", message: "updated", details: opts.updateDetails };
    },
    reinstall: async () => {
      return { mechanism: "manager-http", message: "reinstalled" };
    },
  };
  return h;
}

const RUN = { requiredVersion: REQUIRED, orchestratorVersion: ORCH } as const;

describe("performPanelSync", () => {
  afterEach(() => vi.restoreAllMocks());

  it("syncs a behind, unpinned panel and reports the version RE-READ from disk", async () => {
    const h = makeDeps({
      installedVersion: "0.11.3",
      onUpdate: (files) => {
        files[join(PANEL_DIR, "pyproject.toml")] = pyproject("0.11.30");
      },
    });
    const r = await performPanelSync({ deps: h.deps, ...RUN });
    expect(h.updates).toBe(1);
    expect(r.synced).toBe(true);
    expect(r.previousVersion).toBe("0.11.3");
    // The reported version is the one observed on disk afterwards.
    expect(r.verifiedVersion).toBe("0.11.30");
    expect(r.restartRequired).toBe(true);
    expect(r.stillBehind).toBe(false);
  });

  it("does NOTHING and does not queue a mutation when the panel is pinned", async () => {
    const h = makeDeps({
      installedVersion: "0.11.3",
      pin: { pinned: true, version: "0.11.3", source: "settings" },
      onUpdate: (files) => {
        // If this ever runs the guard has failed.
        files[join(PANEL_DIR, "pyproject.toml")] = pyproject("0.11.30");
      },
    });
    const r = await performPanelSync({ deps: h.deps, ...RUN });
    expect(r.synced).toBe(false);
    expect(r.decision).toBe("pinned-warn");
    expect(h.updates).toBe(0);
    expect(h.installs).toBe(0);
    expect(r.verifiedVersion).toBeUndefined();
    expect(r.message).toMatch(/pinned/i);
  });

  it("proceeds once the pin is cleared — same install, same versions", async () => {
    const make = (pin?: PanelPinState) =>
      makeDeps({
        installedVersion: "0.11.3",
        pin,
        onUpdate: (files) => {
          files[join(PANEL_DIR, "pyproject.toml")] = pyproject("0.11.30");
        },
      });

    const pinned = make({ pinned: true, version: "0.11.3", source: "settings" });
    expect((await performPanelSync({ deps: pinned.deps, ...RUN })).synced).toBe(false);
    expect(pinned.updates).toBe(0);

    const cleared = make(undefined);
    const r = await performPanelSync({ deps: cleared.deps, ...RUN });
    expect(r.synced).toBe(true);
    expect(cleared.updates).toBe(1);
    expect(r.verifiedVersion).toBe("0.11.30");
  });

  it("no-ops without touching anything when already current", async () => {
    const h = makeDeps({ installedVersion: REQUIRED });
    const r = await performPanelSync({ deps: h.deps, ...RUN });
    expect(r.synced).toBe(false);
    expect(r.decision).toBe("up-to-date");
    expect(h.updates).toBe(0);
  });

  it("FAILS LOUDLY when the update did not move anything on disk", async () => {
    // The #639 silent no-op: ComfyUI-Manager drains its queue trivially and the
    // pack is untouched. This must be an error, never "synced".
    const h = makeDeps({
      installedVersion: "0.11.3",
      onUpdate: () => {
        /* nothing lands */
      },
      updateDetails: { total_count: 0, done_count: 2 },
    });
    await expect(performPanelSync({ deps: h.deps, ...RUN })).rejects.toThrow(
      /did NOT apply|NOT reporting success/i,
    );
    expect(h.updates).toBe(1);
  });

  it("FAILS LOUDLY when the pack disappears after the op", async () => {
    const h = makeDeps({
      installedVersion: "0.11.3",
      onUpdate: (files) => {
        delete files[join(PANEL_DIR, "pyproject.toml")];
      },
    });
    await expect(performPanelSync({ deps: h.deps, ...RUN })).rejects.toThrow(
      /Could not verify|NOT reporting/i,
    );
  });

  it("reports stillBehind honestly when the sync landed but did not close the gap", async () => {
    const h = makeDeps({
      installedVersion: "0.11.3",
      onUpdate: (files) => {
        files[join(PANEL_DIR, "pyproject.toml")] = pyproject("0.11.10");
      },
    });
    const r = await performPanelSync({ deps: h.deps, ...RUN });
    expect(r.synced).toBe(true);
    expect(r.verifiedVersion).toBe("0.11.10");
    expect(r.stillBehind).toBe(true);
    expect(r.message).toMatch(/still below/i);
  });

  it("refuses to sync a dev symlink", async () => {
    const h = makeDeps({ installedVersion: "0.11.3" });
    const deps: PanelInstallerDeps = { ...h.deps, isSymlink: (p) => p === PANEL_DIR };
    const r = await performPanelSync({ deps, ...RUN });
    expect(r.synced).toBe(false);
    expect(r.decision).toBe("dev-install");
    expect(h.updates).toBe(0);
  });
});
