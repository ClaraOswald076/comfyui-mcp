// The #771/#766/#769/#774/#784 cluster: one bug wearing five faces.
//
// comfyui-mcp 0.49.3 raised a hard floor — panel >= 0.11.35 for graph WRITES
// (#718) — and that gate is correct: a write delivered after a workflow switch
// cannot be retracted, so refusing to dispatch is the only server-side
// guarantee. Nothing here weakens it.
//
// What was broken is the REMEDY. Every refusal said "Run
// install_panel(action:'update')", and install_panel could not actually perform
// the update in most real deployments: it contradicted its own status on a
// Comfy Registry zip install (#771), scanned the wrong tree on a Comfy Desktop
// split install (#766), refused outright when only the live server knew where
// ComfyUI was (#769), and is a no-op in remote mode (#774) or absent from the
// tool set entirely (#784). A hard gate whose only escape hatch is broken leaves
// users with no path forward.
//
// These tests pin the four properties that make the remedy real:
//   1. no recovery message names a tool that cannot act in this session;
//   2. status and update resolve the install through the SAME evidence;
//   3. the registry-zip install shape has a verified update path, and that path
//      never reports success it did not observe on disk;
//   4. the panel's ComfyUI root is the RUNNING server's, not whatever happens to
//      be configured.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.COMFYUI_MCP_PANEL_LOCK = join(
  tmpdir(),
  `cmcp-lock-recovery-${process.pid}.lock`,
);

const mode = vi.hoisted(() => ({ local: true, remote: false }));
vi.mock("../../config.js", () => ({
  config: { comfyuiPath: undefined as string | undefined },
  isLocalMode: () => mode.local,
  isRemoteMode: () => mode.remote,
  getComfyUIBaseUrl: () => "http://127.0.0.1:8188",
}));

const workspace = vi.hoisted(() => ({
  base: undefined as string | undefined,
  liveArgv: undefined as string[] | undefined,
  liveCwd: undefined as string | undefined,
  reachable: false,
}));
vi.mock("../../services/workspace-env.js", () => ({
  resolveEffectiveComfyUIBase: () => workspace.base,
  liveRootFromArgv: (argv: string[] | undefined) => {
    // Minimal stand-in for the real argv→root derivation: the dir holding main.py.
    const main = argv?.find((a) => a.endsWith("main.py"));
    return main ? main.slice(0, main.length - "/main.py".length) : undefined;
  },
  getLiveServerSnapshot: async () => ({
    reachable: workspace.reachable,
    argv: workspace.liveArgv,
    cwd: workspace.liveCwd,
  }),
}));

import {
  defaultDeps,
  PanelInstallError,
  PANEL_REGISTRY_ID,
  runPanelActionInner,
  type PanelInstallerDeps,
} from "../../services/panel-installer.js";
import {
  describePanelManagementRedirect,
  describePanelUpdateRecovery,
  PANEL_REPO_URL,
} from "../../services/panel-recovery.js";
import {
  __resetPanelBaseCache,
  primePanelBase,
  resolvePanelBase,
} from "../../services/panel-workspace.js";

function pyproject(version: string, name = PANEL_REGISTRY_ID): string {
  return `[project]\nname = "${name}"\nversion = "${version}"\n`;
}

/** Write a panel pack (pyproject + the built web bundle ComfyUI serves). */
function writePanelPack(dir: string, version: string, opts: { web?: boolean } = {}): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "pyproject.toml"), pyproject(version));
  if (opts.web !== false) {
    mkdirSync(join(dir, "web", "js"), { recursive: true });
    writeFileSync(join(dir, "web", "js", "comfyui-mcp-panel.js"), `// ${version}\n`);
  }
}

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cmcp-recovery-"));
  mkdirSync(join(root, "custom_nodes"), { recursive: true });
  mode.local = true;
  mode.remote = false;
  workspace.base = root;
  workspace.reachable = false;
  workspace.liveArgv = undefined;
  workspace.liveCwd = undefined;
  __resetPanelBaseCache();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  __resetPanelBaseCache();
});

// ---------------------------------------------------------------------------
// Real-filesystem deps. The swap fallback MOVES directories, so mocking the
// filesystem would prove nothing about the thing most likely to go wrong.
// ---------------------------------------------------------------------------

interface Harness {
  deps: PanelInstallerDeps;
  updateCalls: number;
  clones: string[];
}

function makeDeps(opts: {
  /** Version a `git clone` of the panel repo lands. undefined ⇒ clone fails. */
  cloneVersion?: string;
  /** Omit the built web bundle from the clone (an update that would uninstall). */
  cloneWithoutWeb?: boolean;
  /** Error the generic Manager update throws (the #771 false claim). */
  updateThrows?: string;
  /** Manager queue counts returned when the update does NOT throw. */
  updateDetails?: unknown;
  /** Per-dir git HEAD. A registry-zip install has none. */
  revs?: Record<string, string>;
  /** Leave the swap primitives off the dep set (fallback unavailable). */
  withoutSwapOps?: boolean;
}): Harness {
  const revs = opts.revs ?? {};
  const h: Harness = { deps: null as never, updateCalls: 0, clones: [] };

  const base: PanelInstallerDeps = {
    isLocalMode: () => mode.local,
    comfyuiPath: () => root,
    env: () => ({}),
    existsSync,
    probeFile: (p) => {
      try {
        return statSync(p).isFile();
      } catch {
        return false;
      }
    },
    isSymlink: (p) => {
      try {
        return lstatSync(p).isSymbolicLink();
      } catch {
        return false;
      }
    },
    isDirectory: (p) => {
      try {
        return statSync(p).isDirectory();
      } catch {
        return undefined;
      }
    },
    realPath: () => undefined,
    readdir: (p) => readdirSync(p),
    readFile: (p) => readFileSync(p, "utf-8"),
    gitRevision: (dir) => revs[dir],
    gitStatusPorcelain: () => "",
    gitFetch: () => {},
    gitMergeFfOnly: () => {
      throw new Error("no upstream in this persona");
    },
    gitWorktreeRoot: (dir) => dir,
    gitUpstreamRev: (dir) => revs[dir] ?? "",
    gitIgnoredPullConflicts: () => [],
    readPin: () => ({ pinned: false, source: "none" as const }),
    isReachable: async () => true,
    detectManagerDialect: async () => "legacy",
    install: async () => ({ mechanism: "manager-http", message: "installed" }),
    reinstall: async () => ({ mechanism: "manager-http", message: "reinstalled" }),
    update: async () => {
      h.updateCalls++;
      if (opts.updateThrows) throw new Error(opts.updateThrows);
      return {
        mechanism: "manager-http",
        message: "updated",
        details: opts.updateDetails ?? { total_count: 0, done_count: 0 },
      };
    },
  };

  h.deps = opts.withoutSwapOps
    ? base
    : {
        ...base,
        gitClonePanel: (dest) => {
          h.clones.push(dest);
          if (!opts.cloneVersion) throw new Error("remote: Repository not found");
          writePanelPack(dest, opts.cloneVersion, { web: !opts.cloneWithoutWeb });
        },
        mkdirp: (p) => {
          mkdirSync(p, { recursive: true });
        },
        rename: (from, to) => renameSync(from, to),
        removeDir: (p) => rmSync(p, { recursive: true, force: true }),
      };
  return h;
}

const PANEL_DIR = () => join(root, "custom_nodes", PANEL_REGISTRY_ID);

// ---------------------------------------------------------------------------
// 1. Never recommend a tool the caller cannot invoke (#774, #784)
// ---------------------------------------------------------------------------

describe("recovery guidance depends on the session, not on a hardcoded string", () => {
  it("names install_panel in a LOCAL session — and still gives a host fallback", async () => {
    await primePanelBase();
    const text = describePanelUpdateRecovery();
    expect(text).toMatch(/install_panel\(action:'update'\)/);
    // Even here the caller may be on a surface that omits install_panel (#784),
    // so the concrete alternative travels with it. Never a single point of
    // failure.
    expect(text).toContain(PANEL_REPO_URL);
    expect(text).toMatch(/hard-refresh/i);
  });

  it("REMOTE: does not name install_panel as the remedy — gives host commands (#774)", async () => {
    mode.local = false;
    mode.remote = true;
    __resetPanelBaseCache();
    const text = describePanelUpdateRecovery();
    // The exact failure from #774: the message told a remote user to run a tool
    // that answers "not-applicable" and changes nothing.
    expect(text).not.toMatch(/Run install_panel/);
    expect(text).not.toMatch(/install_panel\(action:'update'\)/);
    expect(text).toMatch(/ON THE COMFYUI HOST/);
    expect(text).toMatch(/REMOTE ComfyUI/);
    expect(text).toContain(PANEL_REPO_URL);
    // Both install shapes are covered, because the user cannot be asked to
    // diagnose which one they have before they can act.
    expect(text).toMatch(/pull --ff-only/);
    expect(text).toMatch(/no \.git/);
  });

  it("CLOUD: same, and says why (no custom_nodes to write)", () => {
    mode.local = false;
    mode.remote = false; // cloud = not local, not a remote URL
    __resetPanelBaseCache();
    const text = describePanelUpdateRecovery();
    expect(text).not.toMatch(/Run install_panel/);
    expect(text).toMatch(/Comfy Cloud/);
  });

  it("the backup is moved OUT of custom_nodes — a copy left beside it shadows the panel (#641)", () => {
    mode.local = false;
    mode.remote = true;
    __resetPanelBaseCache();
    const text = describePanelUpdateRecovery();
    expect(text).toMatch(/\.\.\/custom_nodes_backup/);
    expect(text).toMatch(/OUT of custom_nodes/);
  });

  it("panel_update_node's redirect does not dead-end in remote mode either (#774/#784)", () => {
    mode.local = false;
    mode.remote = true;
    __resetPanelBaseCache();
    const text = describePanelManagementRedirect();
    expect(text).not.toMatch(/Use install_panel instead/);
    expect(text).toMatch(/cannot help here either/);
    expect(text).toContain(PANEL_REPO_URL);
  });
});

// ---------------------------------------------------------------------------
// 2 + 3. status and update must agree; the registry-zip shape gets a real path
// ---------------------------------------------------------------------------

describe("update no longer contradicts status on a registry-zip install (#771)", () => {
  it("does NOT propagate the Manager's false 'not installed locally' when the pack IS on disk", async () => {
    writePanelPack(PANEL_DIR(), "0.11.34");
    const h = makeDeps({
      // Verbatim shape of the #771 error: the generic gate reads ComfyUI-Manager's
      // registry list, never the disk, and then asserts an absence.
      updateThrows:
        `"comfyui-agent-panel" was queued for update but is not present afterward — ` +
        `it is not installed locally and was not found in the ComfyUI-Manager registry, ` +
        `so there was nothing to update.`,
      cloneVersion: "0.11.38",
    });

    const result = await runPanelActionInner("update", h.deps);

    // The Manager's claim was false and must not reach the user; the verified
    // reinstall took over and the version reported is the one re-read from disk.
    expect(result.message).not.toMatch(/not installed locally/);
    expect(result.installedVersion).toBe("0.11.38");
    expect(result.previousVersion).toBe("0.11.34");
    expect(result.restartRequired).toBe(true);
    expect(readFileSync(join(PANEL_DIR(), "pyproject.toml"), "utf-8")).toContain("0.11.38");
  });

  it("with no swap primitives available, the refusal says the panel IS installed", async () => {
    writePanelPack(PANEL_DIR(), "0.11.34");
    const h = makeDeps({
      updateThrows: `it is not installed locally and was not found in the ComfyUI-Manager registry`,
      withoutSwapOps: true,
    });
    const err = await runPanelActionInner("update", h.deps).catch((e: Error) => e);
    expect(err).toBeInstanceOf(PanelInstallError);
    // The contradiction is named explicitly rather than repeated.
    expect((err as Error).message).toMatch(/The panel IS installed/);
    expect((err as Error).message).toContain(PANEL_DIR());
    expect((err as Error).message).toMatch(/0\.11\.34/);
  });

  it("propagates the Manager error unchanged when the disk AGREES the pack is absent", async () => {
    const h = makeDeps({ updateThrows: "genuinely not installed anywhere" });
    const err = await runPanelActionInner("update", h.deps).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/genuinely not installed anywhere/);
  });

  it("a Manager no-op on a zip install falls back to a verified reinstall (#771)", async () => {
    writePanelPack(PANEL_DIR(), "0.11.34");
    const h = makeDeps({
      // The pack has no .git (registry zip), so #724's fast-forward cannot fire.
      updateDetails: { total_count: 0, done_count: 4 },
      cloneVersion: "0.11.38",
    });
    const result = await runPanelActionInner("update", h.deps);
    expect(result.installedVersion).toBe("0.11.38");
    expect(h.clones).toHaveLength(1);
    // Staged OUTSIDE custom_nodes: a half-written clone in there would be served.
    expect(h.clones[0].startsWith(join(root, "custom_nodes"))).toBe(false);
  });

  it("the replaced copy is parked OUTSIDE custom_nodes, never beside the panel (#641)", async () => {
    writePanelPack(PANEL_DIR(), "0.11.34");
    const h = makeDeps({ cloneVersion: "0.11.38", updateThrows: "manager cannot resolve it" });
    await runPanelActionInner("update", h.deps);

    // Nothing panel-shaped is left in custom_nodes except the panel itself.
    expect(readdirSync(join(root, "custom_nodes"))).toEqual([PANEL_REGISTRY_ID]);
    const backups = readdirSync(join(root, "custom_nodes_backup"));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(root, "custom_nodes_backup", backups[0], "pyproject.toml"), "utf-8"))
      .toContain("0.11.34");
  });
});

describe("the registry-zip reinstall refuses everything it cannot prove", () => {
  it("REFUSES on a real git checkout — a wholesale replace would destroy local work", async () => {
    writePanelPack(PANEL_DIR(), "0.11.34");
    const h = makeDeps({
      updateThrows: "manager cannot resolve it",
      revs: { [PANEL_DIR()]: "a".repeat(40) },
      cloneVersion: "0.11.38",
    });
    // With a HEAD present, the #724 fast-forward path owns this case; that
    // path's own git mock has no upstream, so it fails — the point is that the
    // wholesale replace never runs and nothing was cloned.
    await runPanelActionInner("update", h.deps).catch(() => {});
    expect(h.clones).toHaveLength(0);
    expect(readFileSync(join(PANEL_DIR(), "pyproject.toml"), "utf-8")).toContain("0.11.34");
  });

  it("REFUSES a downgrade — never moves the user backwards", async () => {
    writePanelPack(PANEL_DIR(), "0.11.40");
    const h = makeDeps({ updateThrows: "manager cannot resolve it", cloneVersion: "0.11.38" });
    const err = await runPanelActionInner("update", h.deps).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/OLDER than the one installed/);
    // Untouched: the swap never started.
    expect(readFileSync(join(PANEL_DIR(), "pyproject.toml"), "utf-8")).toContain("0.11.40");
    expect(existsSync(join(root, "custom_nodes_backup"))).toBe(false);
  });

  it("reports 'already at the published version' honestly, and touches nothing", async () => {
    writePanelPack(PANEL_DIR(), "0.11.38");
    const h = makeDeps({ updateThrows: "manager cannot resolve it", cloneVersion: "0.11.38" });
    const result = await runPanelActionInner("update", h.deps);
    expect(result.restartRequired).toBe(false);
    expect(result.message).toMatch(/already at the published version/);
    expect(existsSync(join(root, "custom_nodes_backup"))).toBe(false);
    // Staging cleaned up — no stray dirs left in the ComfyUI root.
    expect(readdirSync(root).some((e) => e.includes("staging"))).toBe(false);
  });

  it("REFUSES a clone with no built web bundle — that update would uninstall the panel", async () => {
    writePanelPack(PANEL_DIR(), "0.11.34");
    const h = makeDeps({
      updateThrows: "manager cannot resolve it",
      cloneVersion: "0.11.38",
      cloneWithoutWeb: true,
    });
    const err = await runPanelActionInner("update", h.deps).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/built web bundle/);
    // The working panel is still in place.
    expect(readFileSync(join(PANEL_DIR(), "pyproject.toml"), "utf-8")).toContain("0.11.34");
    expect(readdirSync(join(root, "custom_nodes"))).toEqual([PANEL_REGISTRY_ID]);
  });

  it("a failed clone leaves the install untouched and reports the real reason", async () => {
    writePanelPack(PANEL_DIR(), "0.11.34");
    const h = makeDeps({ updateThrows: "manager cannot resolve it" }); // no cloneVersion ⇒ clone throws
    const err = await runPanelActionInner("update", h.deps).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/Repository not found/);
    expect((err as Error).message).toMatch(/did NOT apply/);
    expect(readFileSync(join(PANEL_DIR(), "pyproject.toml"), "utf-8")).toContain("0.11.34");
  });

  it("REFUSES while a shadow copy is served — the swap would look like a no-op (#641)", async () => {
    writePanelPack(PANEL_DIR(), "0.11.34");
    writePanelPack(join(root, "custom_nodes", ".comfyui-agent-panel.bak-0.11.30"), "0.11.30");
    const h = makeDeps({ updateThrows: "manager cannot resolve it", cloneVersion: "0.11.38" });
    const err = await runPanelActionInner("update", h.deps).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/shadow/i);
    expect(h.clones).toHaveLength(0);
    expect(readFileSync(join(PANEL_DIR(), "pyproject.toml"), "utf-8")).toContain("0.11.34");
  });

  it("REFUSES while the panel is version-pinned — a pin is a promise", async () => {
    writePanelPack(PANEL_DIR(), "0.11.34");
    const h = makeDeps({ updateThrows: "manager cannot resolve it", cloneVersion: "0.11.38" });
    h.deps.readPin = () => ({ pinned: true, source: "settings" as const, version: "0.11.34" });
    await expect(runPanelActionInner("update", h.deps)).rejects.toThrow();
    expect(h.clones).toHaveLength(0);
    expect(readFileSync(join(PANEL_DIR(), "pyproject.toml"), "utf-8")).toContain("0.11.34");
  });
});

// ---------------------------------------------------------------------------
// 4. Target resolution (#766, #769)
// ---------------------------------------------------------------------------

describe("the panel's ComfyUI root is the RUNNING server's (#766, #769)", () => {
  it("#766: prefers the live --base-directory over a configured workspace", async () => {
    // Comfy Desktop: ComfyUI runs out of the program dir but derives
    // custom_nodes from --base-directory, so the configured workspace is the
    // wrong tree to scan (and the wrong tree to install into).
    const desktopData = join(root, "Documents", "ComfyUI");
    mkdirSync(join(desktopData, "custom_nodes"), { recursive: true });
    const programDir = join(root, "Program", "ComfyUI");
    mkdirSync(join(programDir, "custom_nodes"), { recursive: true });

    workspace.base = programDir;
    workspace.reachable = true;
    workspace.liveArgv = [`${programDir}/main.py`, "--base-directory", desktopData];

    const resolved = await resolvePanelBase();
    expect(resolved.base).toBe(desktopData);
    expect(resolved.source).toBe("live-base-directory");
    expect(resolved.overriddenConfiguredBase).toBe(programDir);
  });

  it("#769: resolves the live root when nothing at all is configured", async () => {
    const liveRoot = join(root, "D", "ComfyUI");
    mkdirSync(join(liveRoot, "custom_nodes"), { recursive: true });
    workspace.base = undefined;
    workspace.reachable = true;
    workspace.liveArgv = [`${liveRoot}/main.py`];

    const resolved = await resolvePanelBase();
    expect(resolved.base).toBe(liveRoot);
    expect(resolved.source).toBe("live-argv-root");
  });

  it("will NOT accept a live root with no custom_nodes — that would fake 'not installed'", async () => {
    const bogus = join(root, "no-custom-nodes");
    mkdirSync(bogus, { recursive: true });
    workspace.base = root;
    workspace.reachable = true;
    workspace.liveArgv = [`${bogus}/main.py`];

    const resolved = await resolvePanelBase();
    expect(resolved.base).toBe(root);
    expect(resolved.source).toBe("configured");
  });

  it("falls back to the configured workspace when the server is unreachable", async () => {
    workspace.base = root;
    workspace.reachable = false;
    const resolved = await resolvePanelBase();
    expect(resolved.base).toBe(root);
    expect(resolved.source).toBe("configured");
  });

  it("never hands back a local path in remote mode — that filesystem is not ours", async () => {
    mode.local = false;
    mode.remote = true;
    workspace.base = root;
    const resolved = await resolvePanelBase();
    expect(resolved.base).toBeUndefined();
    expect(resolved.source).toBe("none");
  });

  it("the real defaultDeps read through the live-first resolver", async () => {
    const liveRoot = join(root, "live", "ComfyUI");
    mkdirSync(join(liveRoot, "custom_nodes"), { recursive: true });
    workspace.base = undefined;
    workspace.reachable = true;
    workspace.liveArgv = [`${liveRoot}/main.py`];
    await primePanelBase();
    expect(defaultDeps.comfyuiPath()).toBe(liveRoot);
  });
});
