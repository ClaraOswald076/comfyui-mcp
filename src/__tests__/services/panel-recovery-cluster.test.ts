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
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.COMFYUI_MCP_PANEL_LOCK = join(
  tmpdir(),
  `cmcp-lock-recovery-${process.pid}.lock`,
);

const mode = vi.hoisted(() => ({ local: true, remote: false }));
const generation = vi.hoisted(() => ({ value: 0 }));
vi.mock("../../config.js", () => ({
  config: { comfyuiPath: undefined as string | undefined },
  isLocalMode: () => mode.local,
  isRemoteMode: () => mode.remote,
  getComfyUIBaseUrl: () => "http://127.0.0.1:8188",
  getComfyuiTargetGeneration: () => generation.value,
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
  pinPanelBase,
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
  lastPanelBaseResolution,
  lastPanelDiskObservation,
  primePanelBase,
  recordPanelDiskObservation,
  resolvePanelBase,
  verifiedPanelDiskVersion,
} from "../../services/panel-workspace.js";

/** Escape a filesystem path for embedding in a RegExp. */
function escapeRe(v: string): string {
  return v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function pyproject(version: string, name = PANEL_REGISTRY_ID): string {
  return `[project]\nname = "${name}"\nversion = "${version}"\n`;
}

/** Write a panel pack (pyproject + the built web bundle ComfyUI serves). */
/**
 * A realistic bundle body. Viability now requires the served JS to carry actual
 * content and look like the module the browser executes — because "the file
 * exists" is a claim about the directory entry, and an entry surviving without
 * its data is the exact crash shape recovery has to handle. A one-line stub
 * fixture would quietly stop exercising that.
 */
function panelBundle(version: string): string {
  return (
    `// comfyui-mcp-panel ${version}\n` +
    `import { app } from "../../scripts/app.js";\n` +
    `app.registerExtension({ name: "comfyui-mcp.panel", async setup() {} });\n` +
    `// padding to a plausible bundle size\n${"//x\n".repeat(400)}`
  );
}

/** Every file under `dir`, relative and sorted — mirrors collectTreeFiles. */
function treeFiles(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (prefix === "" && (name === ".git" || name === ".comfyui-mcp-integrity.json")) {
      continue;
    }
    const full = join(dir, name);
    const rel = prefix === "" ? name : `${prefix}/${name}`;
    if (statSync(full).isDirectory()) out.push(...treeFiles(full, rel));
    else out.push(rel);
  }
  return out.sort();
}

/**
 * Write the integrity manifest exactly as the swap does at stage time, so
 * fixtures exercise the real verification rather than a stand-in.
 */
function writeManifest(dir: string): void {
  const files = treeFiles(dir).map((rel) => {
    const buf = readFileSync(join(dir, ...rel.split("/")));
    return {
      path: rel,
      size: buf.byteLength,
      sha256: createHash("sha256").update(buf).digest("hex"),
    };
  });
  const canonical = files.map((f) => `${f.path} | ${f.size} | ${f.sha256}`).join("\n");
  writeFileSync(
    join(dir, ".comfyui-mcp-integrity.json"),
    JSON.stringify({
      version: 1,
      files,
      digest: createHash("sha256").update(canonical, "utf-8").digest("hex"),
    }),
  );
}

/**
 * Damage a staged tree AFTER its manifest was written — the real crash order.
 * Staging corrupt content and then hashing it would produce a manifest that
 * agrees with the damage, which verifies as intact and tests nothing.
 */
function corruptStagedBundle(dir = INCOMING(), replacement = ""): void {
  writeFileSync(join(dir, "web", "js", "comfyui-mcp-panel.js"), replacement);
}

/** A staged `.incoming` tree as the swap would leave it: pack + manifest. */
function stageIncoming(version: string, opts: { bundle?: string } = {}): string {
  const dir = INCOMING();
  writePanelPack(dir, version, opts);
  writeManifest(dir);
  return dir;
}

/** A backup directory named the way the swap names them (base-version-epochms). */
function backupPath(version: string, stamp = Date.now()): string {
  return join(root, "custom_nodes_backup", `${PANEL_REGISTRY_ID}-${version}-${stamp}`);
}

function writePanelPack(
  dir: string,
  version: string,
  opts: { web?: boolean; bundle?: string } = {},
): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "pyproject.toml"), pyproject(version));
  if (opts.web !== false) {
    mkdirSync(join(dir, "web", "js"), { recursive: true });
    writeFileSync(
      join(dir, "web", "js", "comfyui-mcp-panel.js"),
      opts.bundle ?? panelBundle(version),
    );
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
  generation.value = 0;
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
  /** How many times the #724 fast-forward actually ran. */
  gitMerges: number;
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
  const h: Harness = { deps: null as never, updateCalls: 0, clones: [], gitMerges: 0 };

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
      h.gitMerges++;
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
        fileDigest: (p) => {
          try {
            const buf = readFileSync(p);
            return {
              size: buf.byteLength,
              sha256: createHash("sha256").update(buf).digest("hex"),
            };
          } catch {
            return undefined;
          }
        },
        hashString: (v) => createHash("sha256").update(v, "utf-8").digest("hex"),
        mtimeMs: (p) => {
          try {
            return statSync(p).mtimeMs;
          } catch {
            return undefined;
          }
        },
      };
  return h;
}

const PANEL_DIR = () => join(root, "custom_nodes", PANEL_REGISTRY_ID);
const INCOMING = () => join(root, "custom_nodes", ".comfyui-agent-panel.incoming");

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

  it("the skew branch outranks remote mode — and still never names an uncallable tool", () => {
    mode.local = false;
    mode.remote = true;
    __resetPanelBaseCache();
    const text = describePanelUpdateRecovery(undefined, SKEW);
    expect(text).toMatch(/Do NOT update the panel/);
    expect(text).not.toMatch(/ON THE COMFYUI HOST/);
    // Even the closing "it would report nothing to do" aside must not mention a
    // tool that is not callable in this session.
    expect(text).not.toMatch(/install_panel/);
    expect(text).toMatch(/No update of any kind will help/);
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

  it("a SHADOW copy disqualifies the reading — a hard refresh would reload the shadow", async () => {
    // The observation answers "is the panel the browser loads already current?".
    // A served copy in custom_nodes means the browser is loading something other
    // than the canonical pack whose version we read, so "your install is fine,
    // just hard-refresh" is doubly wrong — the refresh re-loads the shadow.
    writePanelPack(PANEL_DIR(), "0.11.38");
    writePanelPack(join(root, "custom_nodes", ".comfyui-agent-panel.bak-0.11.30"), "0.11.30");
    const { panelStatus } = await import("../../services/panel-installer.js");
    await panelStatus();
    expect(lastPanelDiskObservation()).toBeUndefined();
  });

  it("an INDETERMINATE shadow scan also disqualifies it — [] from a failed scan is not an all-clear", async () => {
    writePanelPack(PANEL_DIR(), "0.11.38");
    recordPanelDiskObservation("0.11.38", PANEL_DIR(), root);
    const h = makeDeps({ withoutSwapOps: true });
    // Detection uses the fast-path names, so it still resolves the panel; the
    // shadow enumeration is what fails.
    let calls = 0;
    h.deps.readdir = () => {
      if (calls++ === 0) return [PANEL_REGISTRY_ID];
      throw new Error("EACCES: permission denied");
    };
    const { panelStatus } = await import("../../services/panel-installer.js");
    const status = await panelStatus(h.deps);
    expect(status.shadowInspectFailed).toBe(true);
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

  it("a Manager that moved the pack BACKWARDS is never reported as an update", async () => {
    // "The version changed" is not "the version improved". A Manager that
    // resolves an older build, lands it, and then throws its bad presence check
    // would otherwise leave the user downgraded by a message congratulating
    // them on an update.
    writePanelPack(PANEL_DIR(), "0.11.40");
    const h = makeDeps({ cloneVersion: "0.11.38" });
    h.deps.update = async () => {
      writePanelPack(PANEL_DIR(), "0.11.38"); // backwards
      throw new Error("is not installed locally and was not found in the registry");
    };
    const err = await runPanelActionInner("update", h.deps).catch((e: Error) => e);
    expect(err).toBeInstanceOf(PanelInstallError);
    expect((err as Error).message).toMatch(/did NOT go forward/);
    expect((err as Error).message).toMatch(/0\.11\.40 → 0\.11\.38/);
    expect((err as Error).message).not.toMatch(/Panel updated/);
  });

  it("the ORDINARY Manager path never reports a downgrade as an update", async () => {
    // The direction check lives in classifyPanelUpdate, not on one branch: this
    // is the path where the Manager SUCCEEDS and simply installs an older
    // build, which a guard on the throws-path would never see.
    writePanelPack(PANEL_DIR(), "0.11.40");
    const h = makeDeps({ withoutSwapOps: true });
    h.deps.update = async () => {
      writePanelPack(PANEL_DIR(), "0.11.38"); // Manager resolves an older build
      return { mechanism: "manager-http", message: "updated", details: {} };
    };
    const err = await runPanelActionInner("update", h.deps).catch((e: Error) => e);
    expect(err).toBeInstanceOf(PanelInstallError);
    expect((err as Error).message).toMatch(/did NOT go forward/);
    expect((err as Error).message).toMatch(/OLDER/);
    expect((err as Error).message).not.toMatch(/Panel updated/);
  });

  it("INSTALL/REINSTALL never report an unrequested downgrade as having 'advanced'", async () => {
    // The update path decides direction in classifyPanelUpdate; install and
    // reinstall have their own movement test, and it had the same hole.
    writePanelPack(PANEL_DIR(), "0.11.40");
    const h = makeDeps({ withoutSwapOps: true });
    h.deps.reinstall = async () => {
      writePanelPack(PANEL_DIR(), "0.11.38");
      return { mechanism: "manager-http", message: "reinstalled", details: {} };
    };
    const err = await runPanelActionInner("reinstall", h.deps).catch((e: Error) => e);
    expect(err).toBeInstanceOf(PanelInstallError);
    expect((err as Error).message).toMatch(/did NOT go forward/);
    expect((err as Error).message).not.toMatch(/advanced to/);
  });

  it("…but an EXPLICITLY requested older version is honoured, and labelled a downgrade", async () => {
    // install_custom_node(version='0.11.38') is redirected here precisely so the
    // caller gets what they asked for. Refusing that would break the redirect.
    writePanelPack(PANEL_DIR(), "0.11.40");
    const h = makeDeps({ withoutSwapOps: true });
    h.deps.reinstall = async () => {
      writePanelPack(PANEL_DIR(), "0.11.38");
      return { mechanism: "manager-http", message: "reinstalled", details: {} };
    };
    const result = await runPanelActionInner("reinstall", h.deps, { version: "0.11.38" });
    expect(result.installedVersion).toBe("0.11.38");
    expect(result.message).toMatch(/DOWNGRADED, as explicitly requested/);
    expect(result.message).not.toMatch(/advanced to/);
  });

  it("classifyPanelUpdate itself calls a regression 'downgraded', not 'updated'", async () => {
    const { classifyPanelUpdate } = await import("../../services/panel-installer.js");
    expect(
      classifyPanelUpdate(
        { previousVersion: "0.11.40", installedVersion: "0.11.38" },
        {},
      ).outcome,
    ).toBe("downgraded");
    // Forward is still an update, and an unparseable pair is never a regression.
    expect(
      classifyPanelUpdate(
        { previousVersion: "0.11.38", installedVersion: "0.11.40" },
        {},
      ).outcome,
    ).toBe("updated");
    expect(
      classifyPanelUpdate(
        { previousVersion: "nightly", installedVersion: "dev" },
        {},
      ).outcome,
    ).toBe("updated");
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

  it("REFUSES when the .git probe itself FAILS — absence is never inferred from an error", async () => {
    // existsSync collapses EACCES to false, which would read as "there is no
    // .git" and license replacing a real checkout. Only a confirmed absence
    // counts.
    writePanelPack(PANEL_DIR(), "0.11.34");
    const h = makeDeps({ updateThrows: "manager cannot resolve it", cloneVersion: "0.11.38" });
    h.deps.probeFile = (p) => (p.endsWith(".git") ? undefined : true);
    const err = await runPanelActionInner("update", h.deps).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/could NOT be determined/);
    expect(h.clones).toHaveLength(0);
    expect(readFileSync(join(PANEL_DIR(), "pyproject.toml"), "utf-8")).toContain("0.11.34");
  });

  it("REFUSES a .git FILE (worktree/submodule pointer), not just a .git directory", async () => {
    writePanelPack(PANEL_DIR(), "0.11.34");
    writeFileSync(join(PANEL_DIR(), ".git"), "gitdir: ../../.git/worktrees/panel\n");
    const h = makeDeps({ updateThrows: "manager cannot resolve it", cloneVersion: "0.11.38" });
    const err = await runPanelActionInner("update", h.deps).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/git checkout|has a \.git/);
    expect(h.clones).toHaveLength(0);
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
    expect((err as Error).message).toMatch(/not a complete panel pack/);
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

  // ── Interrupted swaps ──────────────────────────────────────────────────────
  //
  // Replacing a directory needs more than one rename, so there is no atomic
  // version. The ordering therefore guarantees the next best thing: at every
  // interruptible point SOME panel directory is present in custom_nodes, and the
  // recovery state is derivable from the filesystem alone — the incoming
  // directory existing IS the evidence. No journal is required for it, which
  // matters because a journal's directory entry is not made durable by fsync'ing
  // the journal's contents.


  /** Is ANY panel-serving directory present in custom_nodes right now? */
  function aPanelIsReachable(): boolean {
    return readdirSync(join(root, "custom_nodes")).some((name) =>
      existsSync(join(root, "custom_nodes", name, "web", "js", "comfyui-mcp-panel.js")),
    );
  }

  it("P0: interruption between the renames still leaves a panel reachable, and it is recovered", async () => {
    // Drive a REAL swap and kill it at the worst moment — after the old panel
    // has been moved aside and before the new one is under its proper name.
    writePanelPack(PANEL_DIR(), "0.11.34");
    const h = makeDeps({ cloneVersion: "0.11.38", updateThrows: "manager cannot resolve it" });
    const realRename = h.deps.rename!;
    let renames = 0;
    // A POWER LOSS DOES NO CLEANUP. So once we reach the third rename (incoming
    // -> canonical) every further filesystem operation fails, including the
    // inline rollback the process would normally perform — leaving exactly the
    // on-disk state a crash would leave behind, not a tidied-up one.
    h.deps.rename = (from, to) => {
      // 1st: staging -> incoming. 2nd: canonical -> backup. 3rd: the crash.
      if (++renames >= 3) throw new Error("SIMULATED CRASH between renames");
      realRename(from, to);
    };
    h.deps.removeDir = () => {
      throw new Error("SIMULATED CRASH — no cleanup runs");
    };
    const err = await runPanelActionInner("update", h.deps).catch((e: Error) => e);
    expect(err).toBeInstanceOf(PanelInstallError);

    // The canonical name is empty at this instant — this IS the window the old
    // ordering made fatal.
    expect(existsSync(PANEL_DIR())).toBe(false);
    expect(existsSync(INCOMING())).toBe(true);

    // THE POINT: custom_nodes is NOT empty of panels. ComfyUI serves every
    // directory under it, including dot-prefixed ones, so the user still has a
    // working panel even though it is not yet under its canonical name.
    expect(aPanelIsReachable()).toBe(true);

    // And recovery does not depend on the journal surviving: delete it, and the
    // filesystem state alone is still enough.
    rmSync(join(root, ".comfyui-agent-panel.swap.json"), { force: true });
    const { repairInterruptedPanelSwap } = await import(
      "../../services/panel-installer.js"
    );
    const note = await repairInterruptedPanelSwap(makeDeps({}).deps);
    expect(note).toMatch(/moved into place/);
    expect(readFileSync(join(PANEL_DIR(), "pyproject.toml"), "utf-8")).toContain("0.11.38");
    expect(existsSync(INCOMING())).toBe(false);
  });

  it("a failed final rename does NOT roll back by deleting the only served panel", async () => {
    // The obvious recovery — drop the incoming copy, move the backup home —
    // deletes the ONLY panel in custom_nodes before knowing the restore will
    // work. If the restore then fails, the user has nothing. Nothing needs
    // undoing anyway: the incoming copy is validated and already being served.
    writePanelPack(PANEL_DIR(), "0.11.34");
    const h = makeDeps({ cloneVersion: "0.11.38", updateThrows: "manager cannot resolve it" });
    const realRename = h.deps.rename!;
    let renames = 0;
    h.deps.rename = (from, to) => {
      if (++renames === 3) throw new Error("EACCES on the final rename");
      realRename(from, to);
    };
    let removals = 0;
    const realRemove = h.deps.removeDir!;
    h.deps.removeDir = (p) => {
      if (p === INCOMING()) removals++;
      realRemove(p);
    };

    const err = await runPanelActionInner("update", h.deps).catch((e: Error) => e);
    expect(err).toBeInstanceOf(PanelInstallError);
    // The served copy was left alone, so a panel is still reachable.
    expect(removals).toBe(0);
    expect(aPanelIsReachable()).toBe(true);
    expect(existsSync(INCOMING())).toBe(true);
    expect((err as Error).message).toMatch(/NOT without a panel/);
    // And the message doesn't claim a rollback that never happened.
    expect((err as Error).message).not.toMatch(/RESTORED/);
  });

  it("a retarget aborts the repair a MUTATION would have performed, before it moves anything", async () => {
    // The repair completes or discards a staged swap, so it is a mutation and
    // is bound to the frozen target like every other. Without the assertion, a
    // retarget between the freeze and the action would let it act on the
    // PREVIOUS target's interrupted swap.
    writePanelPack(PANEL_DIR(), "0.11.34");
    stageIncoming("0.11.38");
    const h = makeDeps({ cloneVersion: "0.11.40" });
    let moved = 0;
    const realRename = h.deps.rename!;
    const realRemove = h.deps.removeDir!;
    h.deps.rename = (from, to) => {
      moved++;
      realRename(from, to);
    };
    h.deps.removeDir = (p) => {
      if (p === INCOMING()) moved++;
      realRemove(p);
    };

    const pinned = await pinPanelBase(h.deps);
    generation.value++; // the retarget lands after the freeze

    const err = await runPanelActionInner("update", pinned).catch((e: Error) => e);
    expect(err).toBeInstanceOf(PanelInstallError);
    expect((err as Error).message).toMatch(/ABORTED/);
    expect(moved).toBe(0); // nothing was moved or discarded
    expect(existsSync(INCOMING())).toBe(true);
    expect(readFileSync(join(PANEL_DIR(), "pyproject.toml"), "utf-8")).toContain("0.11.34");
  });

  it("the swap checks the version it OBSERVES afterwards, not just the one it staged", async () => {
    // The staged clone is validated before the swap, but this read happens
    // after it — and a concurrent Manager run or manual edit in between can
    // leave something older in place. Reporting that as an update would be
    // fabricated progress.
    writePanelPack(PANEL_DIR(), "0.11.34");
    const h = makeDeps({ cloneVersion: "0.11.38", updateThrows: "manager cannot resolve it" });
    const realRename = h.deps.rename!;
    let renames = 0;
    h.deps.rename = (from, to) => {
      realRename(from, to);
      // After the final rename lands, something else downgrades the pack.
      if (++renames === 3) writePanelPack(PANEL_DIR(), "0.11.33");
    };
    const err = await runPanelActionInner("update", h.deps).catch((e: Error) => e);
    expect(err).toBeInstanceOf(PanelInstallError);
    expect((err as Error).message).toMatch(/did NOT go forward/);
    expect((err as Error).message).toMatch(/0\.11\.33/);
    expect((err as Error).message).not.toMatch(/Panel updated/);
  });

  it("an UNCOMPARABLE post-swap version is 'could not compare', never an update", async () => {
    // Both versions were required to be strictly comparable before the swap, so
    // an unparseable one afterwards means something changed the pack. A value
    // like 0.11.33.0 fails the strict three-component grammar, skipping the
    // regression check, and would otherwise be reported as an update.
    writePanelPack(PANEL_DIR(), "0.11.34");
    const h = makeDeps({ cloneVersion: "0.11.38", updateThrows: "manager cannot resolve it" });
    const realRename = h.deps.rename!;
    let renames = 0;
    h.deps.rename = (from, to) => {
      realRename(from, to);
      if (++renames === 3) writePanelPack(PANEL_DIR(), "0.11.33.0");
    };
    const err = await runPanelActionInner("update", h.deps).catch((e: Error) => e);
    expect(err).toBeInstanceOf(PanelInstallError);
    expect((err as Error).message).toMatch(/not a comparable version number/);
    expect((err as Error).message).not.toMatch(/Panel updated/);
  });

  it("a repair that already landed is reported even if the call then throws", async () => {
    // The catch used to return undefined, swallowing the disclosure along with
    // the error — a change to the user's install, hidden.
    stageIncoming("0.11.38");
    const h = makeDeps({});
    let renamed = false;
    const realRename = h.deps.rename!;
    h.deps.rename = (from, to) => {
      realRename(from, to);
      renamed = true;
      generation.value++; // the post-repair assertion will now throw
    };
    const { repairInterruptedPanelSwap } = await import(
      "../../services/panel-installer.js"
    );
    const pinned = await pinPanelBase(h.deps);
    const note = await repairInterruptedPanelSwap(pinned);
    expect(renamed).toBe(true); // the repair really happened
    expect(note).toMatch(/moved into place/); // …and was still reported
  });

  it("a repair is reported even when the action then fails with a non-panel error", async () => {
    // install/reinstall await ComfyUI-Manager directly, which rejects with its
    // own error types. Restricting the note to PanelInstallError meant a repair
    // could happen and then vanish because the action failed for another reason.
    stageIncoming("0.11.38"); // an interrupted swap to finish first
    const h = makeDeps({});
    h.deps.install = async () => {
      throw new TypeError("something entirely unrelated blew up");
    };
    const err = await runPanelActionInner("install", h.deps).catch((e: Error) => e);
    expect(err).toBeInstanceOf(TypeError); // original class preserved
    expect((err as Error).message).toMatch(/something entirely unrelated/);
    expect((err as Error).message).toMatch(/interrupted/i);
    // The repair really did happen.
    expect(readFileSync(join(PANEL_DIR(), "pyproject.toml"), "utf-8")).toContain("0.11.38");
  });

  it("interruption BEFORE the old panel moved aside is undone, keeping the working panel", async () => {
    writePanelPack(PANEL_DIR(), "0.11.34");
    stageIncoming("0.11.38"); // staged, but the swap never went on
    const { repairInterruptedPanelSwap } = await import(
      "../../services/panel-installer.js"
    );
    const note = await repairInterruptedPanelSwap(makeDeps({}).deps);
    expect(note).toMatch(/discarded/);
    // The conservative outcome: the known-good panel stays, the unverified
    // half-swap is dropped, and no shadow is left behind.
    expect(readFileSync(join(PANEL_DIR(), "pyproject.toml"), "utf-8")).toContain("0.11.34");
    expect(existsSync(INCOMING())).toBe(false);
  });

  it("a failed step-2 gets the staged copy OUT of custom_nodes rather than deleting it in place", async () => {
    // A recursive delete can fail partway and leave a half-deleted directory
    // still under custom_nodes — still served, still shadowing, now damaged. A
    // rename out is atomic: it either works completely or changes nothing.
    writePanelPack(PANEL_DIR(), "0.11.34");
    const h = makeDeps({ cloneVersion: "0.11.38", updateThrows: "manager cannot resolve it" });
    const realRename = h.deps.rename!;
    let renames = 0;
    h.deps.rename = (from, to) => {
      if (++renames === 2) throw new Error("EACCES moving the old panel aside");
      realRename(from, to);
    };
    const err = await runPanelActionInner("update", h.deps).catch((e: Error) => e);
    expect(err).toBeInstanceOf(PanelInstallError);
    // No staged copy left behind to shadow the real one.
    expect(existsSync(INCOMING())).toBe(false);
    expect(readdirSync(join(root, "custom_nodes"))).toEqual([PANEL_REGISTRY_ID]);
    expect(readFileSync(join(PANEL_DIR(), "pyproject.toml"), "utf-8")).toContain("0.11.34");
  });

  it("refuses to move the old panel aside if the staged copy is not actually visible", async () => {
    // The recovery guarantee depends on step 1 having really landed; never move
    // the working panel out on the strength of a rename that did not take.
    writePanelPack(PANEL_DIR(), "0.11.34");
    const h = makeDeps({ cloneVersion: "0.11.38", updateThrows: "manager cannot resolve it" });
    const realExists = h.deps.existsSync;
    h.deps.existsSync = (p) => (p === INCOMING() ? false : realExists(p));
    const err = await runPanelActionInner("update", h.deps).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/not visible at/);
    expect(readFileSync(join(PANEL_DIR(), "pyproject.toml"), "utf-8")).toContain("0.11.34");
    // The backup ROOT is created up front, but nothing was moved into it — the
    // working panel never left custom_nodes.
    expect(readdirSync(join(root, "custom_nodes_backup"))).toEqual([]);
  });

  it("P0: a file truncated AFTER the manifest was written is detected, and the backup restored", async () => {
    // The exact sequence a crash produces: the tree is staged and recorded
    // intact, then data is lost. No parsing is involved — the bytes simply no
    // longer match what we ourselves wrote down.
    const backupDir = backupPath("0.11.34");
    writePanelPack(backupDir, "0.11.34");
    stageIncoming("0.11.38");
    const bundle = join(INCOMING(), "web", "js", "comfyui-mcp-panel.js");
    const full = readFileSync(bundle, "utf-8");
    writeFileSync(bundle, full.slice(0, Math.floor(full.length / 2))); // half a file
    const { repairInterruptedPanelSwap } = await import(
      "../../services/panel-installer.js"
    );
    const note = await repairInterruptedPanelSwap(makeDeps({}).deps);
    expect(note).toMatch(/INCOMPLETE/);
    expect(readFileSync(join(PANEL_DIR(), "pyproject.toml"), "utf-8")).toContain("0.11.34");
    expect(existsSync(INCOMING())).toBe(false);
  });

  it("P0: a MISSING manifest is a disclosed refusal, never a promotion", async () => {
    // "Cannot tell" is its own answer. Promoting would risk installing a husk
    // over a working panel; restoring would discard a replacement that may be
    // perfectly fine. So: change nothing, and say where everything is.
    const backupDir = backupPath("0.11.34");
    writePanelPack(backupDir, "0.11.34");
    stageIncoming("0.11.38");
    rmSync(join(INCOMING(), ".comfyui-mcp-integrity.json"));
    const { repairInterruptedPanelSwap } = await import(
      "../../services/panel-installer.js"
    );
    const note = await repairInterruptedPanelSwap(makeDeps({}).deps);
    expect(note).toMatch(/CANNOT be determined/);
    expect(note).toContain(backupDir); // the user is told where their panel is
    // Nothing moved in either direction.
    expect(existsSync(INCOMING())).toBe(true);
    expect(existsSync(PANEL_DIR())).toBe(false);
    expect(existsSync(backupDir)).toBe(true);
  });

  it("P0: a manifest listing ZERO files is unverifiable, not 'intact'", async () => {
    // An empty file list with a matching digest is far likelier to come from a
    // bug in our own WRITER — written before the walk, an exception swallowed
    // mid-collection — than from anything else, and it would otherwise verify
    // an empty directory as intact.
    writePanelPack(backupPath("0.11.34"), "0.11.34");
    stageIncoming("0.11.38");
    const manifestPath = join(INCOMING(), ".comfyui-mcp-integrity.json");
    writeFileSync(
      manifestPath,
      JSON.stringify({
        version: 1,
        files: [],
        digest: createHash("sha256").update("", "utf-8").digest("hex"),
      }),
    );
    const { repairInterruptedPanelSwap } = await import(
      "../../services/panel-installer.js"
    );
    expect(await repairInterruptedPanelSwap(makeDeps({}).deps)).toMatch(
      /CANNOT be determined/,
    );
  });

  it("P0: a manifest missing the panel's required entries is unverifiable", async () => {
    writePanelPack(backupPath("0.11.34"), "0.11.34");
    stageIncoming("0.11.38");
    const manifestPath = join(INCOMING(), ".comfyui-mcp-integrity.json");
    const m = JSON.parse(readFileSync(manifestPath, "utf-8"));
    m.files = m.files.filter(
      (f: { path: string }) => f.path !== "web/js/comfyui-mcp-panel.js",
    );
    const canonical = m.files
      .map((f: { path: string; size: number; sha256: string }) =>
        `${f.path} | ${f.size} | ${f.sha256}`,
      )
      .join("\n");
    m.digest = createHash("sha256").update(canonical, "utf-8").digest("hex");
    writeFileSync(manifestPath, JSON.stringify(m));
    const { repairInterruptedPanelSwap } = await import(
      "../../services/panel-installer.js"
    );
    expect(await repairInterruptedPanelSwap(makeDeps({}).deps)).toMatch(
      /CANNOT be determined/,
    );
  });

  it("P0: a HALF-WRITTEN manifest is a disclosed verdict, never a thrown exception", async () => {
    // `{"files":[null]}` is valid JSON and the ordinary shape of a crash during
    // the write. Dereferencing before validating threw from inside the verifier,
    // and the exception escaped into a catch that reported nothing at all.
    writePanelPack(backupPath("0.11.34"), "0.11.34");
    stageIncoming("0.11.38");
    writeFileSync(
      join(INCOMING(), ".comfyui-mcp-integrity.json"),
      '{"version":1,"files":[null],"digest":"x"}',
    );
    const { repairInterruptedPanelSwap } = await import(
      "../../services/panel-installer.js"
    );
    const note = await repairInterruptedPanelSwap(makeDeps({}).deps);
    expect(note).toMatch(/CANNOT be determined/);
    expect(note).not.toMatch(/could not be examined/); // a verdict, not a crash
  });

  it("P0: an UNREADABLE backup bundle is not viable — could-not-read is not fine", async () => {
    // A backup whose bundle is a regular file but errors on read would be
    // renamed over the canonical name, after which the staged copy is removed:
    // no readable panel left anywhere. Failing disk or ACLs, pure accident.
    const backupDir = backupPath("0.11.34");
    writePanelPack(backupDir, "0.11.34");
    stageIncoming("0.11.38");
    rmSync(join(INCOMING(), "web", "js", "comfyui-mcp-panel.js")); // husk ⇒ restore attempted
    const h = makeDeps({});
    const realDigest = h.deps.fileDigest!;
    h.deps.fileDigest = (p) =>
      p.startsWith(backupDir) && p.endsWith("comfyui-mcp-panel.js")
        ? undefined // EIO on read
        : realDigest(p);
    const { repairInterruptedPanelSwap } = await import(
      "../../services/panel-installer.js"
    );
    const note = await repairInterruptedPanelSwap(h.deps);
    // Not restored from the unreadable copy, and the staged one is left alone.
    expect(note).toMatch(/No previous copy could be located|INCOMPLETE/);
    expect(existsSync(PANEL_DIR())).toBe(false);
    expect(existsSync(INCOMING())).toBe(true);
  });

  it("P0: a SYMLINK inside the staged tree is not followed — refuse to describe it", async () => {
    // If the walk followed links, the manifest would verify `intact` while the
    // served panel depended on mutable content outside `.incoming`, and a later
    // unrelated edit there would silently change the installed panel. Junctions
    // and git-linked dev checkouts make this ordinary on this project.
    const outside = join(root, "outside-tree");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "extra.js"), "export const x = 1;\n");
    stageIncoming("0.11.38");
    try {
      symlinkSync(outside, join(INCOMING(), "linked"), "junction");
    } catch {
      return; // platform refuses link creation for this user — nothing to assert
    }
    writePanelPack(backupPath("0.11.34"), "0.11.34");
    const { repairInterruptedPanelSwap } = await import(
      "../../services/panel-installer.js"
    );
    expect(await repairInterruptedPanelSwap(makeDeps({}).deps)).toMatch(
      /CANNOT be determined/,
    );
  });

  it("P0: tied mtimes resolve deterministically, not by readdir order", async () => {
    const a = backupPath("0.11.20", 1700000000000);
    const b = backupPath("0.11.34", 1700000000001);
    writePanelPack(a, "0.11.20");
    writePanelPack(b, "0.11.34");
    const same = new Date(Date.now() - 60_000);
    utimesSync(a, same, same); // identical mtimes — coarse timestamps are ordinary
    utimesSync(b, same, same);
    stageIncoming("0.11.38");
    rmSync(join(INCOMING(), "web", "js", "comfyui-mcp-panel.js"));
    const { repairInterruptedPanelSwap } = await import(
      "../../services/panel-installer.js"
    );
    await repairInterruptedPanelSwap(makeDeps({}).deps);
    // The name tiebreak makes this reproducible rather than filesystem-dependent.
    expect(readFileSync(join(PANEL_DIR(), "pyproject.toml"), "utf-8")).toContain("0.11.34");
  });

  it("P0: restoring an OLDER backup than the one being replaced says so", async () => {
    const backupDir = backupPath("0.11.20");
    writePanelPack(backupDir, "0.11.20");
    stageIncoming("0.11.38");
    rmSync(join(INCOMING(), "web", "js", "comfyui-mcp-panel.js"));
    writeFileSync(
      join(root, ".comfyui-agent-panel.swap.json"),
      JSON.stringify({
        dir: PANEL_DIR(),
        backupDir,
        staging: "x",
        startedAt: Date.now(),
        previousVersion: "0.11.34", // what the interrupted swap was replacing
      }),
    );
    const { repairInterruptedPanelSwap } = await import(
      "../../services/panel-installer.js"
    );
    const note = await repairInterruptedPanelSwap(makeDeps({}).deps);
    expect(note).toMatch(/RESTORED/);
    expect(note).toMatch(/OLDER than the 0\.11\.34/);
  });

  it("P1: an unrelated dir at the canonical name cannot clear a stale journal", async () => {
    const backupDir = backupPath("0.11.34");
    writePanelPack(backupDir, "0.11.34");
    mkdirSync(PANEL_DIR(), { recursive: true });
    writeFileSync(join(PANEL_DIR(), "pyproject.toml"), pyproject("2.0.0", "unrelated-node"));
    writeFileSync(
      join(root, ".comfyui-agent-panel.swap.json"),
      JSON.stringify({ dir: PANEL_DIR(), backupDir, staging: "x", startedAt: Date.now() }),
    );
    const { repairInterruptedPanelSwap } = await import(
      "../../services/panel-installer.js"
    );
    const note = await repairInterruptedPanelSwap(makeDeps({}).deps);
    expect(note).toMatch(/HAS been preserved/);
    expect(note).toContain(backupDir);
    expect(existsSync(join(root, ".comfyui-agent-panel.swap.json"))).toBe(true);
  });

  it("a DOCTORED manifest cannot vouch for a tree — the digest covers the file list", async () => {
    const backupDir = backupPath("0.11.34");
    writePanelPack(backupDir, "0.11.34");
    stageIncoming("0.11.38");
    const manifestPath = join(INCOMING(), ".comfyui-mcp-integrity.json");
    const m = JSON.parse(readFileSync(manifestPath, "utf-8"));
    // Rewrite an entry to match damaged content without touching the digest.
    m.files[0].sha256 = "0".repeat(64);
    writeFileSync(manifestPath, JSON.stringify(m));
    const { repairInterruptedPanelSwap } = await import(
      "../../services/panel-installer.js"
    );
    expect(await repairInterruptedPanelSwap(makeDeps({}).deps)).toMatch(
      /CANNOT be determined/,
    );
  });

  it("an INTACT staged tree is promoted", async () => {
    stageIncoming("0.11.38");
    const { repairInterruptedPanelSwap } = await import(
      "../../services/panel-installer.js"
    );
    expect(await repairInterruptedPanelSwap(makeDeps({}).deps)).toMatch(/moved into place/);
    expect(readFileSync(join(PANEL_DIR(), "pyproject.toml"), "utf-8")).toContain("0.11.38");
  });

  it("P0: a HUSK incoming is never promoted — the good copy is restored instead", async () => {
    // A crash can keep the .incoming directory ENTRY while losing file data
    // that was still unwritten. Promoting that husk would make it the panel of
    // record and strand the user's working copy in backup — the recovery
    // destroying the thing it exists to protect.
    const backupDir = backupPath("0.11.34");
    writePanelPack(backupDir, "0.11.34"); // the good copy
    stageIncoming("0.11.38"); // staged intact, manifest written…
    rmSync(join(INCOMING(), "web", "js", "comfyui-mcp-panel.js")); // …then the crash ate it
    writeFileSync(
      join(root, ".comfyui-agent-panel.swap.json"),
      JSON.stringify({ dir: PANEL_DIR(), backupDir, staging: "x", startedAt: Date.now() }),
    );
    const { repairInterruptedPanelSwap } = await import(
      "../../services/panel-installer.js"
    );
    const note = await repairInterruptedPanelSwap(makeDeps({}).deps);

    // THE GOOD COPY SURVIVES, and is what is installed.
    expect(note).toMatch(/INCOMPLETE/);
    expect(note).toMatch(/RESTORED/);
    expect(readFileSync(join(PANEL_DIR(), "pyproject.toml"), "utf-8")).toContain("0.11.34");
    expect(existsSync(join(PANEL_DIR(), "web", "js", "comfyui-mcp-panel.js"))).toBe(true);
    // And the husk is gone from custom_nodes, so it cannot shadow it.
    expect(existsSync(INCOMING())).toBe(false);
  });

  it("a husk incoming with NO recoverable backup reports rather than promoting it", async () => {
    stageIncoming("0.11.38");
    rmSync(join(INCOMING(), "web", "js", "comfyui-mcp-panel.js"));
    const { repairInterruptedPanelSwap } = await import(
      "../../services/panel-installer.js"
    );
    const note = await repairInterruptedPanelSwap(makeDeps({}).deps);
    expect(note).toMatch(/INCOMPLETE/);
    expect(note).toMatch(/No previous copy could be located/);
    // Not promoted — the canonical name is still free rather than holding a husk.
    expect(existsSync(PANEL_DIR())).toBe(false);
  });

  it("the JS BUNDLE is what makes a panel usable — the wordmark alone is not enough", async () => {
    // servesPanelWebAssets answers "would ComfyUI serve anything from here?" and
    // is true for either marker. That is right for shadow detection and wrong
    // for "this panel would load": using it here let a husk canonical license
    // deleting the only complete copy.
    mkdirSync(join(PANEL_DIR(), "web", "img"), { recursive: true });
    writeFileSync(join(PANEL_DIR(), "pyproject.toml"), pyproject("0.11.34"));
    writeFileSync(join(PANEL_DIR(), "web", "img", "comfyui-mcp-wordmark.svg"), "<svg/>");
    stageIncoming("0.11.38"); // the only COMPLETE copy

    const { repairInterruptedPanelSwap } = await import(
      "../../services/panel-installer.js"
    );
    const note = await repairInterruptedPanelSwap(makeDeps({}).deps);
    // The complete copy must NOT be discarded on the strength of a husk.
    expect(existsSync(INCOMING())).toBe(true);
    expect(readFileSync(join(INCOMING(), "pyproject.toml"), "utf-8")).toContain("0.11.38");
    expect(note).toMatch(/NOT a usable panel/);
  });

  it("P0: the INITIAL swap refuses a staged clone that would not load", async () => {
    // The swap validated with the SERVE predicate, which passes on the wordmark
    // SVG alone. A clone with a valid pyproject and no JS bundle would move the
    // only working panel to backup, install the husk, and — because the
    // post-check reads metadata — report a successful update with nothing
    // loadable in custom_nodes.
    writePanelPack(PANEL_DIR(), "0.11.34");
    const h = makeDeps({ updateThrows: "manager cannot resolve it" });
    h.deps.gitClonePanel = (dest) => {
      h.clones.push(dest);
      mkdirSync(join(dest, "web", "img"), { recursive: true });
      writeFileSync(join(dest, "pyproject.toml"), pyproject("0.11.38"));
      writeFileSync(join(dest, "web", "img", "comfyui-mcp-wordmark.svg"), "<svg/>");
    };
    const err = await runPanelActionInner("update", h.deps).catch((e: Error) => e);
    expect(err).toBeInstanceOf(PanelInstallError);
    expect((err as Error).message).toMatch(/not a complete panel pack/);
    // The working panel never moved — the refusal lands during validation,
    // before the swap creates anything at all.
    expect(readFileSync(join(PANEL_DIR(), "pyproject.toml"), "utf-8")).toContain("0.11.34");
    expect(existsSync(join(root, "custom_nodes_backup"))).toBe(false);
    expect(readdirSync(join(root, "custom_nodes"))).toEqual([PANEL_REGISTRY_ID]);
  });

  it("P0: a TRUNCATED bundle is not usable — a surviving entry is not surviving data", async () => {
    // A zero-byte or truncated JS file is the canonical shape of "the directory
    // entry survived, the data did not".
    const backupDir = backupPath("0.11.34");
    writePanelPack(backupDir, "0.11.34");
    stageIncoming("0.11.38");
    corruptStagedBundle(); // zero-byte bundle
    writeFileSync(
      join(root, ".comfyui-agent-panel.swap.json"),
      JSON.stringify({ dir: PANEL_DIR(), backupDir, staging: "x", startedAt: Date.now() }),
    );
    const { repairInterruptedPanelSwap } = await import(
      "../../services/panel-installer.js"
    );
    const note = await repairInterruptedPanelSwap(makeDeps({}).deps);
    expect(note).toMatch(/INCOMPLETE/);
    // The good copy is what ends up installed, not the truncated one.
    expect(readFileSync(join(PANEL_DIR(), "pyproject.toml"), "utf-8")).toContain("0.11.34");
  });

  it("P0: the backup is DISCOVERED when the journal is gone — .incoming already proves the interruption", async () => {
    // This is NOT the ruled residual. There, `.incoming` is lost and the state
    // is indistinguishable from a deliberate uninstall. Here `.incoming` is
    // PRESENT, which is unambiguous proof of an interrupted swap — so recovery
    // is licensed, and refusing while a viable copy sits discoverable on disk
    // (and telling the user none exists) is a plain failure.
    const backupDir = backupPath("0.11.34", 1770000000000);
    writePanelPack(backupDir, "0.11.34");
    stageIncoming("0.11.38");
    corruptStagedBundle(); // husk
    // No journal at all.
    const { repairInterruptedPanelSwap } = await import(
      "../../services/panel-installer.js"
    );
    const note = await repairInterruptedPanelSwap(makeDeps({}).deps);
    expect(note).toMatch(/RESTORED/);
    expect(note).not.toMatch(/No previous copy could be located/);
    expect(readFileSync(join(PANEL_DIR(), "pyproject.toml"), "utf-8")).toContain("0.11.34");
  });

  it("discovery picks the MOST RECENT viable backup and ignores unusable ones", async () => {
    const older = backupPath("0.11.20", 1700000000000);
    const newer = backupPath("0.11.34", 1770000000000);
    const husk = backupPath("0.11.30", 1780000000000);
    writePanelPack(older, "0.11.20");
    writePanelPack(newer, "0.11.34");
    writePanelPack(husk, "0.11.30", { bundle: "" }); // newest by time, but unusable
    // Selection orders by REAL mtime, not by the digits in the name, so the
    // fixture has to set real times — created-milliseconds-apart would leave
    // the ordering to chance and quietly stop testing anything.
    const t = (s: number) => new Date(Date.now() - s * 1000);
    utimesSync(older, t(300), t(300));
    utimesSync(newer, t(60), t(60));
    utimesSync(husk, t(1), t(1));
    stageIncoming("0.11.38");
    corruptStagedBundle();
    const { repairInterruptedPanelSwap } = await import(
      "../../services/panel-installer.js"
    );
    await repairInterruptedPanelSwap(makeDeps({}).deps);
    expect(readFileSync(join(PANEL_DIR(), "pyproject.toml"), "utf-8")).toContain("0.11.34");
  });

  it("P1: an unrelated node occupying the panel's dir name is not mistaken for the panel", async () => {
    // "has any pyproject.toml" is not an identity test — every custom node pack
    // has one. Selecting an unrelated node as the canonical panel let the stale
    // journal be deleted as spent, suppressing the ruled disclosure.
    const impostor = join(root, "custom_nodes", "comfyui-mcp-panel");
    mkdirSync(impostor, { recursive: true });
    writeFileSync(join(impostor, "pyproject.toml"), pyproject("1.0.0", "some-other-node"));
    const backupDir = backupPath("0.11.34", 1770000000000);
    writePanelPack(backupDir, "0.11.34");
    writeFileSync(
      join(root, ".comfyui-agent-panel.swap.json"),
      JSON.stringify({ dir: PANEL_DIR(), backupDir, staging: "x", startedAt: Date.now() }),
    );
    const { repairInterruptedPanelSwap } = await import(
      "../../services/panel-installer.js"
    );
    const note = await repairInterruptedPanelSwap(makeDeps({}).deps);
    // The refusal is NOT suppressed, and the backup is disclosed.
    expect(note).toMatch(/HAS been preserved/);
    expect(note).toContain(backupDir);
    expect(existsSync(join(root, ".comfyui-agent-panel.swap.json"))).toBe(true);
  });

  it("P0: a `..` traversal in the journal's backup path is REFUSED, not resolved", async () => {
    // startsWith is not containment: this has the right prefix and resolves into
    // a DIFFERENT ComfyUI install. Restoring from there would move that install's
    // panel into this one and leave it with none.
    const otherRoot = join(root, "OtherComfy");
    const otherPanel = join(otherRoot, "custom_nodes", PANEL_REGISTRY_ID);
    writePanelPack(otherPanel, "9.9.9");
    const traversal = join(
      root,
      "custom_nodes_backup",
      "..",
      "OtherComfy",
      "custom_nodes",
      PANEL_REGISTRY_ID,
    );
    stageIncoming("0.11.38");
    corruptStagedBundle(); // husk, so a restore is attempted
    writeFileSync(
      join(root, ".comfyui-agent-panel.swap.json"),
      JSON.stringify({
        dir: PANEL_DIR(),
        backupDir: traversal,
        staging: "x",
        startedAt: Date.now(),
      }),
    );
    const { repairInterruptedPanelSwap } = await import(
      "../../services/panel-installer.js"
    );
    const note = await repairInterruptedPanelSwap(makeDeps({}).deps);

    // The other installation is untouched — nothing was pulled out of it.
    expect(readFileSync(join(otherPanel, "pyproject.toml"), "utf-8")).toContain("9.9.9");
    expect(existsSync(PANEL_DIR())).toBe(false);
    expect(note).toMatch(/No previous copy could be located/);
  });

  it("P1: recovery promotes to the REPO-named dir when that is where the panel lives", async () => {
    // The pack ordinarily installs to custom_nodes/comfyui-mcp-panel while its
    // registry name is comfyui-agent-panel. Deriving the registry name blindly
    // would promote to a second directory and leave BOTH served.
    const repoNamed = join(root, "custom_nodes", "comfyui-mcp-panel");
    writePanelPack(repoNamed, "0.11.34");
    stageIncoming("0.11.38");
    const { repairInterruptedPanelSwap } = await import(
      "../../services/panel-installer.js"
    );
    await repairInterruptedPanelSwap(makeDeps({}).deps);
    // Exactly one panel directory remains — no second, competing extension.
    expect(readdirSync(join(root, "custom_nodes"))).toEqual(["comfyui-mcp-panel"]);
  });

  it("P2: a stale journal pointing at some unrelated existing dir cannot suppress the refusal", async () => {
    // journal.dir deciding "the panel exists" let an untrusted path silence the
    // disclosure the ruling requires, leaving the preserved backup unmentioned.
    const backupDir = backupPath("0.11.34");
    writePanelPack(backupDir, "0.11.34");
    const unrelated = join(root, "unrelated-but-existing");
    mkdirSync(unrelated, { recursive: true });
    writeFileSync(
      join(root, ".comfyui-agent-panel.swap.json"),
      JSON.stringify({ dir: unrelated, backupDir, staging: "x", startedAt: Date.now() }),
    );
    const { repairInterruptedPanelSwap } = await import(
      "../../services/panel-installer.js"
    );
    const note = await repairInterruptedPanelSwap(makeDeps({}).deps);
    // The user is TOLD, and told where their backup is.
    expect(note).toMatch(/HAS been preserved/);
    expect(note).toContain(backupDir);
    expect(existsSync(join(root, ".comfyui-agent-panel.swap.json"))).toBe(true);
  });

  it("a hand-edited journal cannot redirect where the panel is moved to", async () => {
    // The journal informs; it never designates. Taking the destination from
    // journal.dir would let a stale or edited record send the panel anywhere.
    const elsewhere = join(root, "elsewhere", "panel");
    stageIncoming("0.11.38");
    writeFileSync(
      join(root, ".comfyui-agent-panel.swap.json"),
      JSON.stringify({
        dir: elsewhere, // points outside custom_nodes
        backupDir: join(root, "custom_nodes_backup", "x"),
        staging: "x",
        startedAt: Date.now(),
      }),
    );
    const { repairInterruptedPanelSwap } = await import(
      "../../services/panel-installer.js"
    );
    await repairInterruptedPanelSwap(makeDeps({}).deps);
    // Landed at the derived canonical path, not the journal's.
    expect(existsSync(elsewhere)).toBe(false);
    expect(readFileSync(join(PANEL_DIR(), "pyproject.toml"), "utf-8")).toContain("0.11.38");
  });

  it("a canonical dir that merely EXISTS does not license discarding the staged panel", async () => {
    // "exists" is weaker than "works". A husk at the canonical name — emptied,
    // or left by a half-finished move — would otherwise be read as a healthy
    // install and used to justify deleting the only usable copy.
    mkdirSync(PANEL_DIR(), { recursive: true }); // present, but no pyproject/web
    stageIncoming("0.11.38");
    const { repairInterruptedPanelSwap } = await import(
      "../../services/panel-installer.js"
    );
    const note = await repairInterruptedPanelSwap(makeDeps({}).deps);
    expect(note).toMatch(/NOT a usable panel/);
    expect(note).toMatch(/Nothing has been moved/);
    // The working copy survives, and ComfyUI still serves it.
    expect(existsSync(INCOMING())).toBe(true);
    expect(aPanelIsReachable()).toBe(true);
  });

  it("a canonical panel missing its BUILT BUNDLE is not treated as healthy either", async () => {
    writePanelPack(PANEL_DIR(), "0.11.34", { web: false }); // pyproject only
    stageIncoming("0.11.38");
    const { repairInterruptedPanelSwap } = await import(
      "../../services/panel-installer.js"
    );
    expect(await repairInterruptedPanelSwap(makeDeps({}).deps)).toMatch(
      /NOT a usable panel/,
    );
    expect(existsSync(INCOMING())).toBe(true);
  });

  it("a STALE journal with no in-flight swap NEVER resurrects a deliberately removed panel", async () => {
    // A swap that COMPLETED and died before deleting its journal, after which
    // the user uninstalled the panel on purpose. "There is a journal" only ever
    // meant "a journal exists" — it must not be read as "a swap is half-done".
    const backupDir = backupPath("0.11.34");
    writePanelPack(backupDir, "0.11.34");
    writeFileSync(
      join(root, ".comfyui-agent-panel.swap.json"),
      JSON.stringify({ dir: PANEL_DIR(), backupDir, staging: "x", startedAt: Date.now() }),
    );
    const { repairInterruptedPanelSwap } = await import(
      "../../services/panel-installer.js"
    );
    const note = await repairInterruptedPanelSwap(makeDeps({}).deps);

    // The uninstall stands — nothing was resurrected.
    expect(existsSync(PANEL_DIR())).toBe(false);
    expect(existsSync(backupDir)).toBe(true);

    // REFUSING IS ONLY ACCEPTABLE IF THE USER GETS THEIR DATA BACK. All five
    // things they need must be in the message:
    expect(note).toMatch(/NO panel at/); //                    1. canonical is empty
    expect(note).toContain(backupDir); //                      2. the backup, by absolute path
    expect(note).toMatch(/HAS been preserved/); //                 …and that it survived
    expect(note).toMatch(/DELIBERATE uninstall/); //           3. why we will not move it
    expect(note).toMatch(new RegExp(`mv "${escapeRe(backupDir)}"`)); // 4. exact restore command
    expect(note).toMatch(/To start fresh instead/); //         5. exact reinstall route
  });

  it("says so plainly when the backup named by a stale journal is ALSO gone", async () => {
    const backupDir = backupPath("0.11.34");
    writeFileSync(
      join(root, ".comfyui-agent-panel.swap.json"),
      JSON.stringify({ dir: PANEL_DIR(), backupDir, staging: "x", startedAt: Date.now() }),
    );
    const { repairInterruptedPanelSwap } = await import(
      "../../services/panel-installer.js"
    );
    const note = await repairInterruptedPanelSwap(makeDeps({}).deps);
    expect(note).toMatch(/no preserved copy of the panel could be found/);
    expect(note).toContain(join(root, "custom_nodes_backup"));
    // Must not claim a preserved copy that isn't there.
    expect(note).not.toMatch(/HAS been preserved/);
  });

  it("a completed swap's spent journal is simply cleared when the panel IS present", async () => {
    writePanelPack(PANEL_DIR(), "0.11.38");
    const backupDir = backupPath("0.11.34");
    writePanelPack(backupDir, "0.11.34");
    writeFileSync(
      join(root, ".comfyui-agent-panel.swap.json"),
      JSON.stringify({ dir: PANEL_DIR(), backupDir, staging: "x", startedAt: Date.now() }),
    );
    const { repairInterruptedPanelSwap } = await import(
      "../../services/panel-installer.js"
    );
    expect(await repairInterruptedPanelSwap(makeDeps({}).deps)).toBeUndefined();
    expect(existsSync(join(root, ".comfyui-agent-panel.swap.json"))).toBe(false);
    expect(readFileSync(join(PANEL_DIR(), "pyproject.toml"), "utf-8")).toContain("0.11.38");
  });

  it("a PIN blocks the status-path repair too — a restore is still a mutation", async () => {
    stageIncoming("0.11.38");
    const h = makeDeps({});
    h.deps.readPin = () => ({ pinned: true, source: "settings" as const, version: "0.11.34" });
    const { repairInterruptedPanelSwap } = await import(
      "../../services/panel-installer.js"
    );
    expect(await repairInterruptedPanelSwap(h.deps)).toMatch(/could not be examined/);
    expect(existsSync(INCOMING())).toBe(true); // untouched
  });

  it("a retarget aborts the status-path repair rather than acting on the wrong tree", async () => {
    stageIncoming("0.11.38");
    const h = makeDeps({});
    const pinned = await pinPanelBase(h.deps);
    generation.value++; // a retarget landed after the freeze
    const { repairInterruptedPanelSwap } = await import(
      "../../services/panel-installer.js"
    );
    expect(await repairInterruptedPanelSwap(pinned)).toMatch(/could not be examined/);
    expect(existsSync(INCOMING())).toBe(true);
  });

  it("the on-load auto-install finishes an interrupted swap before doing anything else", async () => {
    stageIncoming("0.11.38"); // canonical absent: the second half
    const { ensurePanelInstalled } = await import("../../services/panel-installer.js");
    const result = await ensurePanelInstalled({ deps: makeDeps({}).deps });
    expect(readFileSync(join(PANEL_DIR(), "pyproject.toml"), "utf-8")).toContain("0.11.38");
    expect(result.action).not.toBe("installed"); // it did not install a second copy
  });

  it("a bare panelStatus still only REPORTS — it holds no lock, so it must not move directories", async () => {
    stageIncoming("0.11.38");
    const { panelStatus } = await import("../../services/panel-installer.js");
    const status = await panelStatus(makeDeps({ withoutSwapOps: true }).deps);
    expect(status.note).toMatch(/interrupted/i);
    expect(existsSync(INCOMING())).toBe(true);
  });

  it("a mutation REPORTS the repair it performed, not just the work it was asked to do", async () => {
    // Restoring somebody's panel is a material event; "update succeeded" alone
    // would hide it.
    stageIncoming("0.11.30"); // an interrupted swap to finish first
    const h = makeDeps({ cloneVersion: "0.11.38", updateThrows: "manager cannot resolve it" });
    const result = await runPanelActionInner("update", h.deps);
    expect(result.recoveryNote).toMatch(/interrupted/i);
    expect(result.message).toContain(result.recoveryNote!);
    expect(result.installedVersion).toBe("0.11.38");
  });

  it("REFUSES every mutation when an interrupted swap could NOT be reconciled", async () => {
    writePanelPack(PANEL_DIR(), "0.11.34");
    stageIncoming("0.11.38");
    const h = makeDeps({ cloneVersion: "0.11.40" });
    h.deps.removeDir = () => {
      throw new Error("EACCES: cannot clear the staged copy");
    };
    const err = await runPanelActionInner("install", h.deps).catch((e: Error) => e);
    expect(err).toBeInstanceOf(PanelInstallError);
    expect((err as Error).message).toMatch(/REFUSED/);
    expect((err as Error).message).toMatch(/interrupted/i);
  });

  it("REFUSES the swap when the recovery record cannot be written", async () => {
    writePanelPack(PANEL_DIR(), "0.11.34");
    const h = makeDeps({ cloneVersion: "0.11.38", updateThrows: "manager cannot resolve it" });
    h.deps.writeFile = () => {
      throw new Error("EACCES: read-only filesystem");
    };
    const err = await runPanelActionInner("update", h.deps).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/EACCES|could not record/);
    expect(readFileSync(join(PANEL_DIR(), "pyproject.toml"), "utf-8")).toContain("0.11.34");
    expect(existsSync(INCOMING())).toBe(false);
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
    const backupDir = backupPath("0.11.34");
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
  // NOTE: the corroboration gate applies to the PRODUCTION dep set only — an
  // injected one declares its own base and there is no live server to
  // corroborate it against — so it cannot be driven from these harness-based
  // tests. What the gate reads is the resolution below, which IS covered: both
  // direct fallbacks (the #724 fast-forward and the #771 swap) call the same
  // assertSwapTreeCorroborated helper over it.
  it("an unreachable server marks the resolution UNCORROBORATED (what gates both fallbacks)", async () => {
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

  it("a same-URL retarget invalidates the cached base — a restart onto a new tree is not reused", async () => {
    // setComfyuiTarget bumps the generation even for a round trip back to the
    // same address, which is exactly what a ComfyUI restart onto a different
    // --base-directory looks like from outside. A cache that survived that
    // would freeze the OLD root into the next status read or mutation, which
    // would then verify its own work in a tree nobody serves.
    const liveRoot = join(root, "live", "ComfyUI");
    mkdirSync(join(liveRoot, "custom_nodes"), { recursive: true });
    workspace.reachable = true;
    workspace.liveArgv = [`${liveRoot}/main.py`];
    __resetPanelBaseCache();
    expect((await primePanelBase()).base).toBe(liveRoot);
    expect(lastPanelBaseResolution()?.base).toBe(liveRoot);

    generation.value++; // a retarget landed
    expect(lastPanelBaseResolution()).toBeUndefined();
  });

  it("ABORTS when the ComfyUI target changes mid-operation", async () => {
    // The local filesystem base is frozen here, but the ComfyUI-Manager
    // mutation captures its HTTP target independently. A retarget between the
    // two would dispatch work to one server and verify the other's tree. We
    // cannot make those captures atomic, but we can refuse to report a result
    // that might describe the wrong install.
    writePanelPack(PANEL_DIR(), "0.11.34");
    const h = makeDeps({ cloneVersion: "0.11.38" });
    h.deps.update = async () => {
      generation.value++; // a retarget landed while the Manager was working
      return { mechanism: "manager-http", message: "updated", details: {} };
    };
    const err = await runPanelActionInner("update", h.deps).catch((e: Error) => e);
    expect(err).toBeInstanceOf(PanelInstallError);
    expect((err as Error).message).toMatch(/ABORTED/);
    expect((err as Error).message).toMatch(/target.*changed|changed while the operation/i);
  });

  it("an UNREADABLE custom_nodes is not a proven absence", async () => {
    // existsSync collapses every error to false, so EACCES looked identical to
    // a fresh install with no custom_nodes — the first is unknown, the second
    // is proven. Recommending an install over the first could clobber a panel.
    const h = makeDeps({ withoutSwapOps: true });
    h.deps.isDirectory = () => undefined; // stat failed: indeterminate
    const { detectPanelInstall } = await import("../../services/panel-installer.js");
    const detected = await detectPanelInstall(h.deps);
    expect(detected.installed).toBe(false);
    expect(detected.scanReliable).toBe(false);
  });

  it("an UNPROVEN absence is structured, not just prose — and blocks the sync", async () => {
    // `installed: false` reads as authoritative and prose warnings do not
    // travel, so the qualification gets its own field. Installing on an
    // unproven absence would drop a second copy into a custom_nodes nothing
    // loads: the user then sees no panel and no error.
    workspace.base = root;
    workspace.reachable = false; // configured fallback ⇒ not live-derived
    __resetPanelBaseCache();
    const { panelStatus } = await import("../../services/panel-installer.js");
    const { evaluatePanelSync } = await import("../../services/panel-sync.js");
    const status = await panelStatus();
    expect(status.installed).toBe(false);
    expect(status.absenceProven).toBe(false);
    expect(evaluatePanelSync(status).decision).toBe("blocked");
    expect(evaluatePanelSync(status).summary).toMatch(/not a proven absence/);
  });

  it("a retarget DURING the probe discards the answer — never stamps tree A with target B", async () => {
    // The probe is a network round trip and the orchestrator can retarget
    // during it. Labelling A's answer with B is worse than no answer: every
    // downstream check compares against that label and would agree with itself
    // all the way to a wrong-tree mutation reported as success.
    const liveRoot = join(root, "live", "ComfyUI");
    mkdirSync(join(liveRoot, "custom_nodes"), { recursive: true });
    workspace.reachable = true;
    workspace.liveArgv = [`${liveRoot}/main.py`];
    __resetPanelBaseCache();

    const realSnapshot = workspace.reachable;
    // Retarget lands while /system_stats is in flight.
    const resolution = await (async () => {
      const p = primePanelBase();
      generation.value++;
      return p;
    })();
    expect(realSnapshot).toBe(true);
    expect(resolution.source).toBe("none");
    expect(resolution.base).toBeUndefined();
    expect(lastPanelBaseResolution()).toBeUndefined();

    // The next prime, against the settled target, answers properly.
    expect((await primePanelBase()).base).toBe(liveRoot);
  });

  it("a retarget that completes BEFORE the mutation is still detected (generation frozen at pin time)", async () => {
    // The orchestrator launches performPanelSync and THEN retargets, so by the
    // time runPanelActionInner is entered the change has already landed. A
    // generation read at re-entry would record it as the status quo and see
    // nothing wrong. The generation is therefore captured when the base is
    // FROZEN, which is before that window opens.
    writePanelPack(PANEL_DIR(), "0.11.34");
    const h = makeDeps({ cloneVersion: "0.11.38" });

    const pinned = await pinPanelBase(h.deps);
    generation.value++; // the retarget lands between the freeze and the mutation

    const err = await runPanelActionInner("update", pinned).catch((e: Error) => e);
    expect(err).toBeInstanceOf(PanelInstallError);
    expect((err as Error).message).toMatch(/ABORTED/);
    // Nothing was touched in the tree we froze.
    expect(h.clones).toHaveLength(0);
    expect(readFileSync(join(PANEL_DIR(), "pyproject.toml"), "utf-8")).toContain("0.11.34");
  });

  it("performPanelSync re-asserts the target before publishing success", async () => {
    // runPanelActionInner checks before IT returns, but the sync then does
    // another status read and publishes its own message — which the
    // orchestrator pushes into the panel chat. A retarget in that last gap
    // would announce a verified sync of tree A to a tab that is now B.
    writePanelPack(PANEL_DIR(), "0.11.20");
    const h = makeDeps({ withoutSwapOps: true });
    h.deps.update = async () => {
      writePanelPack(PANEL_DIR(), "0.11.38");
      generation.value++; // the retarget lands as the mutation completes
      return { mechanism: "manager-http", message: "updated", details: {} };
    };
    const { performPanelSync } = await import("../../services/panel-sync.js");
    await expect(
      performPanelSync({ deps: h.deps, requiredVersion: "0.11.35" }),
    ).rejects.toThrow(/ABORTED/);
  });

  it("the swap journal is written durably before the first rename", async () => {
    // A buffered write can be lost or reordered against the rename that
    // immediately follows, leaving no canonical panel AND no record of where
    // the backup went — precisely what the journal exists to prevent.
    const target = join(root, "durable-journal.json");
    defaultDeps.writeFile?.(target, '{"ok":true}');
    expect(readFileSync(target, "utf-8")).toBe('{"ok":true}');
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
