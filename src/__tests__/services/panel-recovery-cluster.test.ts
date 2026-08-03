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
  __setPanelBaseForTests,
  lastPanelDiskObservation,
  primePanelBase,
  recordPanelDiskObservation,
  resolvePanelBase,
  verifiedPanelDiskVersion,
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
        writeFile: (p, contents) => writeFileSync(p, contents, "utf-8"),
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
// 1b. A stale BROWSER BUNDLE is not a stale INSTALL
//
// Verified on a live rig: an up-to-date panel DOES advertise both capabilities,
// the capability lives in js/lib/session-rebind.js (which also builds `hello`),
// and the panel's module URLs carry no cache-busting key. So a tab holding that
// one file from before 0.11.35 announces the old capability set while the pack
// on disk is current — same refusal, opposite remedy.
// ---------------------------------------------------------------------------

describe("disk-current but handshake-old is diagnosed as a stale tab, not a stale install", () => {
  const SKEW = { diskVersion: "0.11.38", requiredVersion: "0.11.35" };

  it("tells the user to hard-refresh, and NOT to update anything", () => {
    const text = describePanelUpdateRecovery(undefined, {
      ...SKEW,
      handshakeVersion: "0.11.34",
    });
    expect(text).toMatch(/Do NOT update the panel/);
    expect(text).toMatch(/HARD-REFRESH/);
    expect(text).toMatch(/Ctrl\+Shift\+R/);
    expect(text).toMatch(/0\.11\.38/); // what is really on disk
    expect(text).toMatch(/0\.11\.34/); // what the tab announced
    // Crucially it does not send them round the loop again.
    expect(text).not.toMatch(/Run install_panel\(action:'update'\)/);
    expect(text).not.toContain(PANEL_REPO_URL);
  });

  it("handles the 'version unknown' handshake from #784", () => {
    const text = describePanelUpdateRecovery(undefined, SKEW);
    expect(text).toMatch(/advertised no version/);
    expect(text).toMatch(/HARD-REFRESH/);
  });

  it("the skew branch outranks remote mode — no update helps either way", () => {
    mode.local = false;
    mode.remote = true;
    __resetPanelBaseCache();
    const text = describePanelUpdateRecovery(undefined, SKEW);
    expect(text).toMatch(/Do NOT update the panel/);
    expect(text).not.toMatch(/ON THE COMFYUI HOST/);
  });

  it("without a skew, the ordinary update guidance is unchanged", async () => {
    await primePanelBase();
    const text = describePanelUpdateRecovery(undefined, undefined);
    expect(text).toMatch(/install_panel\(action:'update'\)/);
    expect(text).not.toMatch(/Do NOT update the panel/);
  });

  it("panelStatus records the on-disk version so the bridge can see it", async () => {
    writePanelPack(PANEL_DIR(), "0.11.38");
    const { panelStatus } = await import("../../services/panel-installer.js");
    await panelStatus();
    const observed = lastPanelDiskObservation();
    expect(observed?.version).toBe("0.11.38");
    expect(observed?.dir).toBe(PANEL_DIR());
  });

  it("an ABSENT pack clears the observation — never a stale 'your install is fine'", async () => {
    recordPanelDiskObservation("0.11.38", PANEL_DIR());
    const { panelStatus } = await import("../../services/panel-installer.js");
    await panelStatus(); // custom_nodes is empty in this fixture
    expect(lastPanelDiskObservation()).toBeUndefined();
  });

  // The failure direction that matters: telling a genuinely-behind user their
  // install is fine sends them straight back into the loop. The recorded
  // version is therefore never trusted on its own — it is only a POINTER, and
  // the version is re-read at the moment of use.
  it("the recorded version is re-read from disk, not replayed", async () => {
    writePanelPack(PANEL_DIR(), "0.11.38");
    __setPanelBaseForTests(root);
    recordPanelDiskObservation("0.11.38", PANEL_DIR(), root);
    expect(verifiedPanelDiskVersion()).toBe("0.11.38");

    // The pack is downgraded behind our back — the stale record must not stand.
    writePanelPack(PANEL_DIR(), "0.11.20");
    expect(verifiedPanelDiskVersion()).toBe("0.11.20");
  });

  it("a pack REMOVED after the observation yields no version at all", () => {
    writePanelPack(PANEL_DIR(), "0.11.38");
    __setPanelBaseForTests(root);
    recordPanelDiskObservation("0.11.38", PANEL_DIR(), root);
    rmSync(PANEL_DIR(), { recursive: true, force: true });
    expect(verifiedPanelDiskVersion()).toBeUndefined();
  });

  it("a dir that is no longer the PANEL yields no version", () => {
    mkdirSync(PANEL_DIR(), { recursive: true });
    writeFileSync(
      join(PANEL_DIR(), "pyproject.toml"),
      `[project]\nname = "something-else"\nversion = "9.9.9"\n`,
    );
    __setPanelBaseForTests(root);
    recordPanelDiskObservation("0.11.38", PANEL_DIR(), root);
    expect(verifiedPanelDiskVersion()).toBeUndefined();
  });

  it("an observation from ANOTHER ComfyUI tree is never replayed for this one", () => {
    // A server restart at the same address with a different --base-directory is
    // a different custom_nodes, so the old reading proves nothing about the new
    // one. Being wrong here tells a behind user their install is fine.
    const otherRoot = join(root, "other");
    const otherPanel = join(otherRoot, "custom_nodes", PANEL_REGISTRY_ID);
    writePanelPack(otherPanel, "0.11.38");
    recordPanelDiskObservation("0.11.38", otherPanel, otherRoot);
    // The live base now resolves elsewhere.
    __setPanelBaseForTests(root);
    expect(verifiedPanelDiskVersion()).toBeUndefined();
  });

  it("an UNRESOLVED base yields no claim — an expired cache is not a match", () => {
    writePanelPack(PANEL_DIR(), "0.11.38");
    recordPanelDiskObservation("0.11.38", PANEL_DIR(), root);
    __setPanelBaseForTests(undefined);
    expect(verifiedPanelDiskVersion()).toBeUndefined();
  });

  it("a merely CONFIGURED base yields no claim — reachable is not live-derived", () => {
    // A /system_stats response with unusable argv proves something answered on
    // the URL, not that COMFYUI_PATH is the tree it serves. On a split install
    // it is not, and certifying "your install is fine" off a dormant copy is
    // the wrong failure direction.
    writePanelPack(PANEL_DIR(), "0.11.38");
    __setPanelBaseForTests(root, "configured");
    recordPanelDiskObservation("0.11.38", PANEL_DIR(), root);
    expect(verifiedPanelDiskVersion()).toBeUndefined();
    // The same reading through a live-derived base IS accepted.
    __setPanelBaseForTests(root, "live-argv-root");
    recordPanelDiskObservation("0.11.38", PANEL_DIR(), root);
    expect(verifiedPanelDiskVersion()).toBe("0.11.38");
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

  it("re-reads after a swallowed Manager error — a Manager that DID work is not undone", async () => {
    // The Manager's post-op check is what failed, not necessarily the update.
    // Falling back on the pre-call reading would compare the clone against a
    // stale version and could swap a just-installed 0.11.40 out for a published
    // 0.11.38 — a downgrade, reported as an update.
    writePanelPack(PANEL_DIR(), "0.11.34");
    const h = makeDeps({ cloneVersion: "0.11.38" });
    h.deps.update = async () => {
      // The update lands, then the presence check throws.
      writePanelPack(PANEL_DIR(), "0.11.40");
      throw new Error("is not installed locally and was not found in the registry");
    };
    const result = await runPanelActionInner("update", h.deps);
    expect(result.installedVersion).toBe("0.11.40");
    expect(h.clones).toHaveLength(0); // no swap — nothing needed replacing
    expect(readFileSync(join(PANEL_DIR(), "pyproject.toml"), "utf-8")).toContain("0.11.40");
  });

  it("an UNRELIABLE scan never propagates the Manager's absence claim", async () => {
    // A failed custom_nodes enumeration also yields installed:false. That is
    // "we could not look", not "it is not there", and accepting it would put
    // the #771 contradiction straight back.
    const h = makeDeps({ updateThrows: "it is not installed locally" });
    h.deps.readdir = () => {
      throw new Error("EACCES: permission denied");
    };
    const err = await runPanelActionInner("update", h.deps).catch((e: Error) => e);
    expect(err).toBeInstanceOf(PanelInstallError);
    // The Manager's text may be QUOTED as an attributed report, but the verdict
    // must be "unknown", never "absent".
    expect((err as Error).message).toMatch(/UNKNOWN/);
    expect((err as Error).message).toMatch(/ComfyUI-Manager reported an error/);
    expect((err as Error).message).toMatch(/NOT accepting "not installed" from a scan that did not run/);
  });

  it("status reports an unreliable scan as UNKNOWN, never as 'Not installed'", async () => {
    const h = makeDeps({ withoutSwapOps: true });
    h.deps.readdir = () => {
      throw new Error("EACCES: permission denied");
    };
    const { panelStatus } = await import("../../services/panel-installer.js");
    const status = await panelStatus(h.deps);
    expect(status.note).toMatch(/UNKNOWN/);
    expect(status.note).not.toMatch(/Not installed\./);
    expect(status.note).not.toMatch(/action='install'/);
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

  it("REFUSES when .git exists but its revision is UNREADABLE — cannot prove it is not a checkout", async () => {
    // resolveGitRevision returns undefined for both "no .git" and "a .git that
    // could not be read". Treating the second as the first would rename a
    // developer's working repo out of custom_nodes and replace it.
    writePanelPack(PANEL_DIR(), "0.11.34");
    mkdirSync(join(PANEL_DIR(), ".git"), { recursive: true }); // present but unreadable
    const h = makeDeps({
      updateThrows: "manager cannot resolve it",
      cloneVersion: "0.11.38",
      // no `revs` entry ⇒ gitRevision(dir) is undefined despite the .git
    });
    const err = await runPanelActionInner("update", h.deps).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/revision could not be read|may be\) a git checkout/);
    expect(h.clones).toHaveLength(0);
    expect(readFileSync(join(PANEL_DIR(), "pyproject.toml"), "utf-8")).toContain("0.11.34");
    expect(existsSync(join(root, "custom_nodes_backup"))).toBe(false);
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

  it("an INTERRUPTED swap is repaired on the next operation — never leaves the user with no panel", async () => {
    // Replacing a directory takes two renames and cannot be made atomic, so a
    // crash between them leaves custom_nodes empty and the working copy in
    // custom_nodes_backup. The journal written before the first rename is what
    // makes that recoverable.
    const backupDir = join(root, "custom_nodes_backup", `${PANEL_REGISTRY_ID}-0.11.34-1`);
    writePanelPack(backupDir, "0.11.34");
    expect(existsSync(PANEL_DIR())).toBe(false); // mid-swap: no panel served
    writeFileSync(
      join(root, ".comfyui-agent-panel.swap.json"),
      JSON.stringify({
        dir: PANEL_DIR(),
        backupDir,
        staging: join(root, ".comfyui-agent-panel.staging-dead"),
        startedAt: Date.now(),
        previousVersion: "0.11.34",
      }),
    );

    const h = makeDeps({ cloneVersion: "0.11.38", updateThrows: "manager cannot resolve it" });
    const result = await runPanelActionInner("update", h.deps);

    // The working copy was put back first, then the update proceeded normally.
    expect(result.previousVersion).toBe("0.11.34");
    expect(result.installedVersion).toBe("0.11.38");
    expect(readFileSync(join(PANEL_DIR(), "pyproject.toml"), "utf-8")).toContain("0.11.38");
    // The spent journal is gone.
    expect(existsSync(join(root, ".comfyui-agent-panel.swap.json"))).toBe(false);
  });

  it("a status read REPORTS an interrupted swap but does not repair it (it holds no lock)", async () => {
    const backupDir = join(root, "custom_nodes_backup", `${PANEL_REGISTRY_ID}-0.11.34-1`);
    writePanelPack(backupDir, "0.11.34");
    writeFileSync(
      join(root, ".comfyui-agent-panel.swap.json"),
      JSON.stringify({ dir: PANEL_DIR(), backupDir, staging: "x", startedAt: Date.now() }),
    );
    const { panelStatus } = await import("../../services/panel-installer.js");
    const status = await panelStatus(makeDeps({ withoutSwapOps: true }).deps);
    expect(status.note).toMatch(/interrupted/i);
    expect(status.note).toContain(backupDir);
    // Untouched — repairing from an unlocked read could cut across another
    // process's in-flight swap.
    expect(existsSync(PANEL_DIR())).toBe(false);
    expect(existsSync(join(root, ".comfyui-agent-panel.swap.json"))).toBe(true);
  });

  it("REFUSES every mutation when an interrupted swap could NOT be repaired", async () => {
    // Otherwise an install would drop a fresh panel into the empty canonical
    // path, report success, and leave the user's real one stranded — after
    // which the next reconcile, seeing a directory there, deletes the journal
    // that recorded where it went.
    writeFileSync(
      join(root, ".comfyui-agent-panel.swap.json"),
      JSON.stringify({
        dir: PANEL_DIR(),
        backupDir: join(root, "custom_nodes_backup", "gone"), // not there
        staging: "x",
        startedAt: Date.now(),
      }),
    );
    const h = makeDeps({ cloneVersion: "0.11.38" });
    const err = await runPanelActionInner("install", h.deps).catch((e: Error) => e);
    expect(err).toBeInstanceOf(PanelInstallError);
    expect((err as Error).message).toMatch(/REFUSED/);
    expect((err as Error).message).toMatch(/interrupted/i);
    expect(existsSync(PANEL_DIR())).toBe(false);
  });

  it("REFUSES the swap when the recovery journal cannot be written", async () => {
    writePanelPack(PANEL_DIR(), "0.11.34");
    const h = makeDeps({ cloneVersion: "0.11.38", updateThrows: "manager cannot resolve it" });
    h.deps.writeFile = () => {
      throw new Error("EACCES: read-only filesystem");
    };
    const err = await runPanelActionInner("update", h.deps).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/recovery journal/);
    // An unrecoverable swap is worse than no swap: nothing moved.
    expect(readFileSync(join(PANEL_DIR(), "pyproject.toml"), "utf-8")).toContain("0.11.34");
    expect(existsSync(join(root, "custom_nodes_backup", PANEL_REGISTRY_ID))).toBe(false);
  });

  it("REFUSES while the panel is version-pinned — a pin is a promise", async () => {
    writePanelPack(PANEL_DIR(), "0.11.34");
    const h = makeDeps({ updateThrows: "manager cannot resolve it", cloneVersion: "0.11.38" });
    h.deps.readPin = () => ({ pinned: true, source: "settings" as const, version: "0.11.34" });
    await expect(runPanelActionInner("update", h.deps)).rejects.toThrow();
    expect(h.clones).toHaveLength(0);
    expect(readFileSync(join(PANEL_DIR(), "pyproject.toml"), "utf-8")).toContain("0.11.34");
  });

  it("a PIN also blocks the interrupted-swap repair — no mutation means no mutation", async () => {
    // The repair moves directories too. A pinned user who was interrupted gets
    // the state reported, never silently rearranged.
    const backupDir = join(root, "custom_nodes_backup", `${PANEL_REGISTRY_ID}-0.11.34-1`);
    writePanelPack(backupDir, "0.11.34");
    writeFileSync(
      join(root, ".comfyui-agent-panel.swap.json"),
      JSON.stringify({ dir: PANEL_DIR(), backupDir, staging: "x", startedAt: Date.now() }),
    );
    const h = makeDeps({ cloneVersion: "0.11.38", updateThrows: "manager cannot resolve it" });
    h.deps.readPin = () => ({ pinned: true, source: "settings" as const, version: "0.11.34" });
    await expect(runPanelActionInner("update", h.deps)).rejects.toThrow();
    expect(existsSync(PANEL_DIR())).toBe(false); // untouched, still where it was
    expect(existsSync(backupDir)).toBe(true);
  });

  it("REFUSES an unparseable staged version — it cannot be shown to be newer", async () => {
    // compareSemver returns 0 for anything it cannot parse, so skipping the
    // comparison would let a `dev` clone overwrite a working release and report
    // "Panel updated (0.11.40 → dev)".
    writePanelPack(PANEL_DIR(), "0.11.40");
    const h = makeDeps({ updateThrows: "manager cannot resolve it", cloneVersion: "dev" });
    const err = await runPanelActionInner("update", h.deps).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/not a comparable version number/);
    expect(readFileSync(join(PANEL_DIR(), "pyproject.toml"), "utf-8")).toContain("0.11.40");
    expect(existsSync(join(root, "custom_nodes_backup"))).toBe(false);
  });

  it("REFUSES an unparseable INSTALLED version — replacing it could move you backwards", async () => {
    writePanelPack(PANEL_DIR(), "nightly");
    const h = makeDeps({ updateThrows: "manager cannot resolve it", cloneVersion: "0.11.38" });
    const err = await runPanelActionInner("update", h.deps).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/not a comparable version number/);
    expect(readFileSync(join(PANEL_DIR(), "pyproject.toml"), "utf-8")).toContain("nightly");
  });
});

describe("a wholesale replacement needs the RUNNING server to have chosen the tree (#766)", () => {
  it("an unreachable server marks the resolution UNCORROBORATED (what gates the swap)", async () => {
    // The fallback to COMFYUI_PATH is fine for a read and is labelled as such,
    // but on a Desktop split install it is the tree the server does NOT read.
    // Replacing a panel there would update a copy nobody serves and report it as
    // verified, so the destructive path refuses on this flag.
    workspace.base = root;
    workspace.reachable = false;
    __resetPanelBaseCache();
    const resolution = await primePanelBase();
    expect(resolution.source).toBe("configured");
    expect(resolution.liveProbeFailed).toBe(true);
  });

  it("a live-resolved base is corroborated", async () => {
    const liveRoot = join(root, "live", "ComfyUI");
    mkdirSync(join(liveRoot, "custom_nodes"), { recursive: true });
    workspace.base = undefined;
    workspace.reachable = true;
    workspace.liveArgv = [`${liveRoot}/main.py`];
    __resetPanelBaseCache();
    const resolution = await primePanelBase();
    expect(resolution.base).toBe(liveRoot);
    expect(resolution.liveProbeFailed).toBeFalsy();
  });

  it("a reachable server that simply offers no better root is NOT flagged", async () => {
    workspace.base = root;
    workspace.reachable = true;
    workspace.liveArgv = []; // reachable, but argv yields nothing usable
    __resetPanelBaseCache();
    const resolution = await primePanelBase();
    expect(resolution.source).toBe("configured");
    expect(resolution.liveProbeFailed).toBe(false);
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

  it("the base is FROZEN for the whole operation — it cannot drift mid-update", async () => {
    // The live-base resolution is cached with a short TTL and falls back to the
    // configured base when it expires. A ComfyUI-Manager operation can easily
    // outlive that. If the base were re-read per call, the pre-op detection
    // could inspect tree A and the post-op verification tree B — and if B held
    // a newer panel, the "did the pack move?" proof would compare two different
    // directories and bless a success that never happened. That is the
    // fabricated-success class this file exists to prevent.
    const treeA = join(root, "A");
    const treeB = join(root, "B");
    mkdirSync(join(treeA, "custom_nodes"), { recursive: true });
    mkdirSync(join(treeB, "custom_nodes"), { recursive: true });
    writePanelPack(join(treeA, "custom_nodes", PANEL_REGISTRY_ID), "0.11.34");
    // Tree B already holds a NEWER panel — the trap. Nothing touches it, so any
    // "updated" verdict read from it would be pure fiction.
    writePanelPack(join(treeB, "custom_nodes", PANEL_REGISTRY_ID), "0.11.99");

    const h = makeDeps({ withoutSwapOps: true, updateThrows: "manager cannot resolve it" });
    // A dep set whose base MOVES on every read, simulating the cache expiring.
    let reads = 0;
    h.deps.comfyuiPath = () => (reads++ === 0 ? treeA : treeB);

    const err = await runPanelActionInner("update", h.deps).catch((e: Error) => e);
    // Pinned: everything after the first read still describes tree A, so the
    // op fails honestly instead of claiming tree B's 0.11.99 as an update.
    expect(err).toBeInstanceOf(PanelInstallError);
    expect((err as Error).message).toContain(treeA);
    expect((err as Error).message).not.toContain("0.11.99");
    expect(readFileSync(join(treeA, "custom_nodes", PANEL_REGISTRY_ID, "pyproject.toml"), "utf-8"))
      .toContain("0.11.34");
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
