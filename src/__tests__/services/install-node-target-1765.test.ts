// #1765, the recurrence reported against 0.52.35.
//
// The original issue asked for split code/data roots and got them: `COMFYUI_CODE_PATH`
// shipped in 0.52.11 via #1766. What came back is a different failure wearing the same
// title. On macOS with SIX local installs, the session targeted
// `http://127.0.0.1:8189` (the reporter's "krea-2"), and `install_custom_node` with
// `source:"git"` cloned an unregistered repository into a DIFFERENT install — the saved
// default workspace, serving :8188. The call reported `git-clone` SUCCESS; only the
// returned `nodeDir` named the wrong tree, and the configured :8189 install never
// received the pack.
//
// MEASURED, not reasoned (the first revision of this file was the reproduction, and it
// reproduced the reporter's outcome exactly): the destination came from
// `resolveEffectiveComfyUIBase()` — `COMFYUI_PATH` env, then auto-detection, then the
// saved default workspace — i.e. from CONFIGURATION ALONE. `resolveLiveServerRoot`, which
// workspace-env.ts documents as "the single notion every write-side caller (download
// destination, package install) must resolve through, so they can never disagree about
// which install is 'the live one'", was never consulted on this path: `/system_stats` was
// not called even once during the install.
//
// These tests drive the REAL `installCustomNode` — the call site, not a helper — through
// the REAL resolvers against two REAL directories on disk.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ── Two REAL installs on one machine ───────────────────────────────────────────
const SANDBOX = mkdtempSync(join(tmpdir(), "wrong-install-1765-"));
/** The install the session is CONNECTED to (the reporter's krea-2 on :8189). */
const CONNECTED = join(SANDBOX, "krea-2");
/** The install the saved default workspace names (the reporter's qwen-image-edit). */
const SAVED_DEFAULT = join(SANDBOX, "qwen-image-edit");
/** A third tree, used as a `--base-directory` data root. */
const DATA_ROOT = join(SANDBOX, "comfy-data");
for (const root of [CONNECTED, SAVED_DEFAULT, DATA_ROOT]) {
  mkdirSync(join(root, "custom_nodes"), { recursive: true });
  mkdirSync(join(root, "models"), { recursive: true });
  writeFileSync(join(root, "main.py"), "# ComfyUI\n");
}
const WORKSPACE_JSON = join(SANDBOX, "workspace.json");
writeFileSync(WORKSPACE_JSON, JSON.stringify({ defaultWorkspace: SAVED_DEFAULT }));
/** A stand-in comfy-cli executable, so the `useCmCli` branch is reachable. */
const FAKE_COMFY_CLI = join(SANDBOX, "comfy");
writeFileSync(FAKE_COMFY_CLI, "#!/bin/sh");

// ── config: a LOOPBACK target on :8189 (that is LOCAL mode, which is why the
//    filesystem fallback runs at all), with COMFYUI_PATH unset. ───────────────
const cfg = vi.hoisted(() => ({
  comfyuiPath: undefined as string | undefined,
  comfyuiCodePath: undefined as string | undefined,
  resolvedPort: 8189,
  comfyuiHost: "127.0.0.1",
  comfyuiSsl: false,
  githubToken: undefined as string | undefined,
}));
vi.mock("../../config.js", () => ({
  config: cfg,
  getComfyUIBaseUrl: () => `http://${cfg.comfyuiHost}:${cfg.resolvedPort}`,
  getComfyUIAuthHeaders: () => ({}),
  isLoopbackHost: (host: string | undefined) =>
    !host || ["127.0.0.1", "::1", "localhost", "0.0.0.0", "::"].includes(host),
  isForceRemoteFlagSet: () => false,
  isRemoteMode: () => false,
  isLocalMode: () => true,
  isCloudMode: () => false,
}));

// ── the LIVE server's self-report ─────────────────────────────────────────────
const live = vi.hoisted(() => ({
  argv: [] as string[],
  reachable: true,
  /** How many times the running server was asked to describe itself. Zero is the
   *  measurement that proves the shipped code never consulted it. */
  statsCalls: 0,
}));
vi.mock("../../comfyui/client.js", () => ({
  getSystemStats: async () => {
    live.statsCalls += 1;
    if (!live.reachable) throw new Error("connect ECONNREFUSED 127.0.0.1:8189");
    return { system: { argv: live.argv } };
  },
  getObjectInfo: vi.fn(),
  backfillObjectInfo: vi.fn(),
  resetClient: vi.fn(),
  resetObjectInfoCache: vi.fn(),
}));

// ── ComfyUI-Manager. BOTH roads to the direct-clone fallback are exercised:
//
//   "refuse-enqueue"  HTTP 403 on the enqueue — a 3.x security_level /
//                     allow_git_url_install gate; the #1129 divert.
//   "accept-enqueue"  the queue ACCEPTS and drains, but the pack is not in the
//                     installed list afterwards, because it is unregistered —
//                     the reporter's own shape ("reported git-clone success").
//
// They reach `cloneCustomNodeFallback` from two different call sites, and a
// guard on only one of them is a guard that is not there. ────────────────────
const http = vi.hoisted(() => ({
  mode: "refuse-enqueue" as "refuse-enqueue" | "accept-enqueue",
}));
vi.mock("../../comfyui/fetch.js", () => {
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  return {
    comfyuiFetch: async (url: string) => {
      if (http.mode === "refuse-enqueue") {
        return new Response("gated by security_level", {
          status: 403,
          statusText: "Forbidden",
        });
      }
      const { pathname } = new URL(url);
      if (pathname === "/manager/queue/install") return json({ ui_id: "queued" });
      if (pathname === "/manager/queue/start") return json({});
      if (pathname === "/manager/queue/status") {
        return json({ is_processing: false, done_count: 1, total_count: 1 });
      }
      // Unregistered: the Manager drained the task without installing anything.
      if (pathname === "/customnode/installed") return json([]);
      return new Response("no such route", { status: 404, statusText: "Not Found" });
    },
  };
});

// ── `git clone` stands in as a directory creation, so nothing hits the network
//    and the destination it was handed is observable. ────────────────────────
const git = vi.hoisted(() => ({ calls: [] as string[][] }));
vi.mock("node:child_process", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  return {
    execFile: vi.fn(),
    // `comfy --json --version`, so comfy-cli reads as installed and supported.
    spawnSync: vi.fn(() => ({
      status: 0,
      stdout: JSON.stringify({
        schema: "envelope/1",
        type: "envelope",
        ok: true,
        command: "version",
        version: "1.11.1",
        where: null,
        data: {},
        error: null,
      }),
      stderr: "",
    })),
    execFileSync: vi.fn((file: string, args: string[]) => {
      git.calls.push([file, ...args]);
      if (file === "git" && args[0] === "clone") {
        const dest = args[args.length - 1];
        fs.mkdirSync(dest, { recursive: true });
        fs.writeFileSync(path.join(dest, "__init__.py"), "NODE_CLASS_MAPPINGS = {}\n");
      }
      return "";
    }),
  };
});

const { installCustomNode } = await import("../../services/node-management.js");
const { configureWorkspace, resetWorkspaceConfig } = await import(
  "../../services/workspace-env.js"
);
const { setManagerApiCacheForTests } = await import("../../services/manager-api-cache.js");
const { setQueueTimingForTests } = await import("../../services/node-management.js");
setQueueTimingForTests({ pollIntervalMs: 1, startupGraceMs: 0, timeoutMs: 5_000 });

/** The reporter's shape: an unregistered repository, installed by git URL. */
const REPO = "https://github.com/someone/unregistered-pack";
const PACK_DIR = join("custom_nodes", "unregistered-pack");

/** Where did the clone actually land? `undefined` when no clone ran at all. */
function clonedInto(): string | undefined {
  const clone = git.calls.find((c) => c[0] === "git" && c[1] === "clone");
  return clone?.[clone.length - 1];
}

async function install(
  opts: Parameters<typeof installCustomNode>[0],
): Promise<{ ok?: unknown; error?: string }> {
  try {
    return { ok: await installCustomNode(opts) };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

let priorEnvPath: string | undefined;

beforeEach(() => {
  git.calls = [];
  http.mode = "refuse-enqueue";
  live.reachable = true;
  live.statsCalls = 0;
  live.argv = [join(CONNECTED, "main.py"), "--port", "8189"];
  cfg.comfyuiPath = undefined;
  priorEnvPath = process.env.COMFYUI_PATH;
  delete process.env.COMFYUI_PATH;
  configureWorkspace({ configPath: WORKSPACE_JSON });
  // The 403 below is the ENQUEUE refusal, not a dialect probe — pin the dialect
  // so detection does not consume it.
  setManagerApiCacheForTests("http://127.0.0.1:8189", "legacy");
});

afterEach(() => {
  resetWorkspaceConfig();
  if (priorEnvPath === undefined) delete process.env.COMFYUI_PATH;
  else process.env.COMFYUI_PATH = priorEnvPath;
  for (const root of [CONNECTED, SAVED_DEFAULT, DATA_ROOT]) {
    rmSync(join(root, "custom_nodes"), { recursive: true, force: true });
    mkdirSync(join(root, "custom_nodes"), { recursive: true });
  }
});

afterAll(() => rmSync(SANDBOX, { recursive: true, force: true }));

describe("#1765 — install_custom_node must not write into an install this session is not connected to", () => {
  it("REFUSES the reporter's case instead of reporting a success in the wrong tree", async () => {
    const { ok, error } = await install({ id: REPO, source: "git" });

    // NOTHING ran. Before this change the same inputs returned
    // { mechanism: "git-clone", details: { nodeDir: "<SAVED_DEFAULT>/custom_nodes/..." } }.
    expect(ok).toBeUndefined();
    expect(clonedInto()).toBeUndefined();
    expect(existsSync(join(SAVED_DEFAULT, PACK_DIR))).toBe(false);
    expect(existsSync(join(CONNECTED, PACK_DIR))).toBe(false);

    // And the refusal NAMES both installs, which selector produced each, and the
    // remedy — the reporter could only tell the write had gone astray by reading
    // `nodeDir` out of a success payload.
    expect(error).toContain(SAVED_DEFAULT);
    expect(error).toContain(CONNECTED);
    expect(error).toContain("http://127.0.0.1:8189");
    expect(error).toContain("SAVED DEFAULT WORKSPACE");
    expect(error).toMatch(/two DIFFERENT ComfyUI installs/);
    expect(error).toContain(`COMFYUI_PATH=${CONNECTED}`);
  });

  it("asks the running server which install it is — the shipped path never did", async () => {
    await install({ id: REPO, source: "git" });
    expect(live.statsCalls).toBeGreaterThan(0);
  });

  it("clones normally when the configured root IS the connected install", async () => {
    live.argv = [join(SAVED_DEFAULT, "main.py"), "--port", "8189"];

    const { ok, error } = await install({ id: REPO, source: "git" });

    expect(error).toBeUndefined();
    expect(ok).toMatchObject({ mechanism: "git-clone" });
    expect(clonedInto()).toBe(join(SAVED_DEFAULT, PACK_DIR));
  });

  it("REFUSES on the other road to the same clone — the Manager accepted, then had nothing", async () => {
    // The reporter's own shape: the queue takes the task, drains, and the pack is
    // still not installed because it is unregistered. That reaches
    // cloneCustomNodeFallback from a DIFFERENT call site than the 403 divert.
    http.mode = "accept-enqueue";

    const { ok, error } = await install({ id: REPO, source: "git" });

    expect(ok).toBeUndefined();
    expect(clonedInto()).toBeUndefined();
    expect(existsSync(join(SAVED_DEFAULT, PACK_DIR))).toBe(false);
    expect(error).toMatch(/two DIFFERENT ComfyUI installs/);
    expect(error).toContain(CONNECTED);
  });

  it("still clones on that road when the configured root IS the connected install", async () => {
    http.mode = "accept-enqueue";
    live.argv = [join(SAVED_DEFAULT, "main.py"), "--port", "8189"];

    const { ok, error } = await install({ id: REPO, source: "git" });

    expect(error).toBeUndefined();
    expect(ok).toMatchObject({ mechanism: "git-clone" });
    expect(clonedInto()).toBe(join(SAVED_DEFAULT, PACK_DIR));
  });

  it("refuses when the server's --base-directory names a different tree", async () => {
    live.argv = [join(CONNECTED, "main.py"), "--base-directory", DATA_ROOT];

    const { ok, error } = await install({ id: REPO, source: "git" });

    expect(ok).toBeUndefined();
    expect(clonedInto()).toBeUndefined();
    expect(error).toContain(DATA_ROOT);
    expect(error).toContain("--base-directory");
  });

  it("clones normally when the server's --base-directory IS the configured root", async () => {
    // The #1715/#1770 split shape: main.py in one tree, custom_nodes scanned from
    // the data root — which is exactly the root we were about to write into.
    live.argv = [join(CONNECTED, "main.py"), "--base-directory", SAVED_DEFAULT];

    const { ok, error } = await install({ id: REPO, source: "git" });

    expect(error).toBeUndefined();
    expect(ok).toMatchObject({ mechanism: "git-clone" });
    expect(clonedInto()).toBe(join(SAVED_DEFAULT, PACK_DIR));
  });

  it("leaves an EXPLICIT COMFYUI_PATH in charge — that is #1766's shipped contract", async () => {
    // A named COMFYUI_PATH is the user stating which install this session acts on
    // (and, on a split deployment, which DATA root packs belong in). Only a
    // machine-wide GUESS — the saved default workspace, or auto-detection across
    // six installs — may be overruled by the running server.
    process.env.COMFYUI_PATH = SAVED_DEFAULT;
    cfg.comfyuiPath = SAVED_DEFAULT;

    const { ok, error } = await install({ id: REPO, source: "git" });

    expect(error).toBeUndefined();
    expect(ok).toMatchObject({ mechanism: "git-clone" });
    expect(clonedInto()).toBe(join(SAVED_DEFAULT, PACK_DIR));
  });

  it("fails OPEN when the server cannot be reached — an outage is not evidence", async () => {
    live.reachable = false;

    const { ok, error } = await install({ id: REPO, source: "git" });

    expect(error).toBeUndefined();
    expect(ok).toMatchObject({ mechanism: "git-clone" });
    expect(clonedInto()).toBe(join(SAVED_DEFAULT, PACK_DIR));
  });

  it("fails OPEN when the server's main.py root cannot be resolved", async () => {
    // ComfyUI Desktop reports a RELATIVE main.py and no cwd. Nothing here is
    // provable, so nothing is refused.
    live.argv = ["ComfyUI/main.py", "--port", "8189"];

    const { ok, error } = await install({ id: REPO, source: "git" });

    expect(error).toBeUndefined();
    expect(ok).toMatchObject({ mechanism: "git-clone" });
    expect(clonedInto()).toBe(join(SAVED_DEFAULT, PACK_DIR));
  });

  it("refuses the comfy-cli branch too — --workspace has the identical hazard", async () => {
    const priorCli = process.env.COMFY_CLI_PATH;
    process.env.COMFY_CLI_PATH = FAKE_COMFY_CLI;
    try {
      const { ok, error } = await install({ id: REPO, source: "git", useCmCli: true });

      expect(ok).toBeUndefined();
      expect(error).toMatch(/two DIFFERENT ComfyUI installs/);
      expect(error).toContain("comfy-cli");
      // The subprocess never ran: no `comfy ... install` and no `git clone`.
      expect(git.calls.filter((c) => c[0] === FAKE_COMFY_CLI)).toHaveLength(0);
      expect(clonedInto()).toBeUndefined();
      expect(existsSync(join(SAVED_DEFAULT, PACK_DIR))).toBe(false);
    } finally {
      if (priorCli === undefined) delete process.env.COMFY_CLI_PATH;
      else process.env.COMFY_CLI_PATH = priorCli;
    }
  });

  it("does not touch the registry path, which the Manager routes to the connected server", async () => {
    // A plain CNR id is installed BY the connected ComfyUI-Manager: there is no
    // local destination to misdirect, so the guard must not fire (and must not
    // spend a /system_stats probe).
    const { error } = await install({ id: "comfyui-kjnodes" });

    expect(error).toBeDefined();
    expect(error).not.toMatch(/two DIFFERENT ComfyUI installs/);
    expect(live.statsCalls).toBe(0);
  });
});
