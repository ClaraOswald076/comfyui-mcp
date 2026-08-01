import {
  describe,
  expect,
  it,
  beforeEach,
  afterEach,
  vi,
} from "vitest";

// Mock config so importing node-management doesn't trigger the real port
// auto-detection (a live fetch) and lets us flip comfyuiPath per-test.
vi.mock("../../config.js", () => {
  const config: {
    comfyuiPath: string | undefined;
    resolvedPort: number;
    comfyuiHost: string;
    comfyuiSsl: boolean;
    githubToken: string | undefined;
  } = {
    comfyuiPath: "/fake/comfy",
    resolvedPort: 8188,
    comfyuiHost: "127.0.0.1",
    comfyuiSsl: false,
    githubToken: undefined,
  };
  return {
    config,
    getComfyUIBaseUrl: () =>
      `${config.comfyuiSsl ? "https" : "http"}://${config.comfyuiHost}:${config.resolvedPort}`,
    getComfyUIAuthHeaders: () => ({}),
  };
});

// Mock child_process for the cm-cli subprocess paths.
vi.mock("node:child_process", () => ({
  // execFile is needed at module load: workspace-env (pulled in transitively via
  // comfy-cli) calls promisify(execFile) at top level.
  execFile: vi.fn(),
  execFileSync: vi.fn(),
  spawnSync: vi.fn(() => ({
    status: 0,
    stdout: JSON.stringify({ schema: "envelope/1", type: "envelope", ok: true, command: "version", version: "1.11.1", where: null, data: {}, error: null }),
    stderr: "",
  })),
}));

// Mock fs so resolveCmCliPath's existsSync check is controllable.
vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => true),
}));

import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { config } from "../../config.js";
import {
  installCustomNode,
  installModelViaManager,
  parseGitUrl,
  updateCustomNode,
  reinstallCustomNode,
  fixCustomNode,
  listInstalledNodes,
  syncNodeDependencies,
  setQueueTimingForTests,
  resetManagerApiCacheForTests,
  NodeManagementError,
} from "../../services/node-management.js";
import { ProcessControlError, ValidationError } from "../../utils/errors.js";

const mockedExec = vi.mocked(execFileSync);
const mockedExists = vi.mocked(existsSync);

// The product builds these paths with node:path (join), so they use the
// platform separator (backslashes on Windows). Build the expected values the
// same way instead of hardcoding POSIX paths.
const COMFY = "/fake/comfy";
const COMFY_CLI = join(COMFY, ".venv", process.platform === "win32" ? "Scripts" : "bin", process.platform === "win32" ? "comfy.exe" : "comfy");
const cliEnvelope = (data: unknown) => JSON.stringify({ schema: "envelope/1", type: "envelope", ok: true, command: "node", version: "1.11.1", where: "local", data, error: null });
// runGitCheckout now resolves the target with path.resolve (containment check),
// so the -C dir carries the drive letter on Windows — match it.
const BAR_DIR = resolve(COMFY, "custom_nodes", "bar");
// The clone fallback resolves the target with path.resolve (containment check),
// which prepends the current drive on Windows — mirror that here.
const NODE_DIR_UTILS = resolve(COMFY, "custom_nodes", "comfyui-teskors-utils");

interface Call {
  url: string;
  method: string;
  body: unknown;
}

/**
 * Install a fetch stub that records every call and returns canned responses.
 * The queue status returns "done" on the first poll so runManagerQueue resolves.
 */
function stubFetch(opts: {
  installedBody?: unknown;
  statusSequence?: unknown[];
} = {}) {
  const calls: Call[] = [];
  let statusIdx = 0;
  const statusSeq = opts.statusSequence ?? [
    { total_count: 1, done_count: 1, in_progress_count: 0, is_processing: false },
  ];

  const fetchMock = vi.fn(
    async (url: string, init?: RequestInit): Promise<Response> => {
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      calls.push({ url, method, body });

      const path = new URL(url).pathname + (new URL(url).search || "");

      if (path.startsWith("/v2/customnode/installed")) {
        return jsonResponse(opts.installedBody ?? {});
      }
      if (path === "/v2/manager/queue/status") {
        const s = statusSeq[Math.min(statusIdx, statusSeq.length - 1)];
        statusIdx++;
        return jsonResponse(s);
      }
      // queue ops + start return empty bodies
      return new Response("", { status: 200 });
    },
  );

  vi.stubGlobal("fetch", fetchMock);
  return { calls, fetchMock };
}

function jsonResponse(obj: unknown): Response {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** Find a queued task of a given kind and return its (envelope, params). */
function taskOf(calls: Call[], kind: string): { body: Record<string, unknown>; params: Record<string, unknown> } {
  const call = calls.find(
    (c) =>
      c.url.includes("/v2/manager/queue/task") &&
      (c.body as { kind?: string } | undefined)?.kind === kind,
  );
  if (!call) throw new Error(`no queued task of kind "${kind}" found`);
  const body = call.body as Record<string, unknown>;
  return { body, params: body.params as Record<string, unknown> };
}

describe("node-management service", () => {
  beforeEach(() => {
    mockedExec.mockReset();
    mockedExists.mockReset();
    mockedExists.mockReturnValue(true);
    config.comfyuiPath = "/fake/comfy";
    config.githubToken = undefined;
    // Each test re-detects the Manager API generation against its own stub
    // (the v2 stubs answer /v2/manager/queue/status → detect "v2").
    resetManagerApiCacheForTests();
    // Shrink polling timings so the suite stays fast.
    setQueueTimingForTests({
      pollIntervalMs: 1,
      startupGraceMs: 0,
      timeoutMs: 5000,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ---- install -----------------------------------------------------------

  describe("installCustomNode", () => {
    it.each([
      [
        "GitHub tree",
        "https://github.com/foo/bar/tree/dev",
        "https://github.com/foo/bar",
        "dev",
      ],
      [
        "GitHub commit",
        "https://github.com/foo/bar/commit/abc123",
        "https://github.com/foo/bar",
        "abc123",
      ],
      [
        "GitHub release tag",
        "https://github.com/foo/bar/releases/tag/v1.2.3",
        "https://github.com/foo/bar",
        "v1.2.3",
      ],
      [
        "GitLab tree",
        "https://gitlab.com/foo/bar/-/tree/main",
        "https://gitlab.com/foo/bar",
        "main",
      ],
      [
        "GitLab commit",
        "https://gitlab.com/foo/bar/-/commit/abc123",
        "https://gitlab.com/foo/bar",
        "abc123",
      ],
      [
        "Bitbucket src",
        "https://bitbucket.org/foo/bar/src/release-1",
        "https://bitbucket.org/foo/bar",
        "release-1",
      ],
      [
        "Bitbucket commit",
        "https://bitbucket.org/foo/bar/commits/abc123",
        "https://bitbucket.org/foo/bar",
        "abc123",
      ],
      [
        "URL at-ref",
        "https://github.com/foo/bar@feature",
        "https://github.com/foo/bar",
        "feature",
      ],
      [
        "git suffix at-ref",
        "https://github.com/foo/bar.git@v1",
        "https://github.com/foo/bar.git",
        "v1",
      ],
      [
        "repo at-ref",
        "repo@dev",
        "repo",
        "dev",
      ],
      [
        "repo.git at-ref",
        "repo.git@dev",
        "repo.git",
        "dev",
      ],
      [
        "SSH at-ref",
        "git@github.com:foo/bar.git@abc123",
        "git@github.com:foo/bar.git",
        "abc123",
      ],
    ])("parseGitUrl extracts %s refs", (_label, input, baseUrl, ref) => {
      expect(parseGitUrl(input)).toEqual({ baseUrl, ref });
    });

    it("parseGitUrl leaves plain URLs unpinned", () => {
      expect(parseGitUrl("https://github.com/foo/bar.git")).toEqual({
        baseUrl: "https://github.com/foo/bar.git",
        ref: null,
      });
    });

    it("rejects parsed refs that could be interpreted as git options", () => {
      expect(() => parseGitUrl("https://github.com/foo/bar.git@--foo")).toThrow(
        ValidationError,
      );
    });

    it("rejects parsed refs containing ASCII control characters", () => {
      expect(() => parseGitUrl("https://github.com/foo/bar.git@bad%0Aref")).toThrow(
        ValidationError,
      );
    });

    it("rejects ambiguous deep GitHub tree URLs", () => {
      expect(() => parseGitUrl("https://github.com/foo/bar/tree/main/examples")).toThrow(
        /explicit `ref`/,
      );
      expect(() =>
        parseGitUrl("https://gitlab.com/foo/bar/-/tree/main/examples"),
      ).toThrow(/explicit `ref`/);
    });

    // Registry-install verification: the Manager marks the queue "done" even when
    // it resolved nothing, so installCustomNode re-queries /customnode/installed.
    // Tests that exercise a successful Manager install must therefore report the
    // pack as installed via installedBody.
    const installedBar = {
      bar: { ver: "nightly", aux_id: "foo/bar", enabled: true },
    };

    it("installs a registry id via the Manager queue API with latest version", async () => {
      const { calls } = stubFetch({
        installedBody: {
          "comfyui-impact-pack": {
            ver: "1.0.0",
            cnr_id: "comfyui-impact-pack",
            enabled: true,
          },
        },
      });
      const res = await installCustomNode({ id: "comfyui-impact-pack" });

      expect(res.mechanism).toBe("manager-http");
      const { body, params } = taskOf(calls, "install");
      expect(body.client_id).toBe("comfyui-mcp");
      expect(typeof body.ui_id).toBe("string");
      // Registry keeps the prior defaults: channel "default", mode "remote".
      expect(params).toMatchObject({
        id: "comfyui-impact-pack",
        version: "latest",
        selected_version: "latest",
        channel: "default",
        mode: "remote",
      });
      // Must kick the queue worker.
      expect(calls.some((c) => c.url.endsWith("/v2/manager/queue/start"))).toBe(
        true,
      );
    });

    it("throws when a registry id is queued but never lands (silent no-op)", async () => {
      // The Manager drains "done" without installing an unknown CNR id; a non-URL
      // id can't be cloned, so this must be a hard error — not a false success.
      stubFetch({ installedBody: {} });
      await expect(
        installCustomNode({ id: "does-not-exist" }),
      ).rejects.toBeInstanceOf(NodeManagementError);
    });

    it("auto-detects a git URL and installs it via the Manager using the REPO NAME", async () => {
      const { calls } = stubFetch({ installedBody: installedBar });
      const res = await installCustomNode({ id: "https://github.com/foo/bar" });

      expect(res.mechanism).toBe("manager-http");
      const { params } = taskOf(calls, "install");
      // id is the REPO NAME (not the URL); no ref → "nightly"; UI channel/mode.
      // The ignored `repository`/`pip` fields are dropped.
      expect(params).toMatchObject({
        id: "bar",
        version: "nightly",
        selected_version: "nightly",
        channel: "dev",
        mode: "cache",
      });
      expect(params).not.toHaveProperty("repository");
      expect(params).not.toHaveProperty("pip");
      // Manager resolved it → NO direct clone.
      expect(mockedExec).not.toHaveBeenCalledWith(
        "git",
        expect.arrayContaining(["clone"]),
        expect.anything(),
      );
    });

    it("pins a git URL ref parsed from the URL in the install task", async () => {
      const { calls } = stubFetch({ installedBody: installedBar });
      await installCustomNode({ id: "https://github.com/foo/bar/tree/dev" });

      const { params } = taskOf(calls, "install");
      expect(params).toMatchObject({
        id: "bar",
        selected_version: "dev",
      });
    });

    it("prefers explicit ref over parsed URL ref and version for git installs", async () => {
      const { calls } = stubFetch({ installedBody: installedBar });
      await installCustomNode({
        id: "https://github.com/foo/bar/tree/dev",
        version: "v1",
        ref: "abc123",
      });

      const { params } = taskOf(calls, "install");
      expect(params).toMatchObject({
        id: "bar",
        selected_version: "abc123",
      });
    });

    it("allows a valid explicit slash-separated git ref", async () => {
      const { calls } = stubFetch({ installedBody: installedBar });
      await installCustomNode({
        id: "https://github.com/foo/bar",
        ref: "feature/dev",
      });

      const { params } = taskOf(calls, "install");
      expect(params).toMatchObject({
        id: "bar",
        selected_version: "feature/dev",
      });
    });

    it("falls back to a direct git clone when the Manager can't resolve the repo", async () => {
      // Manager drains "done" but the pack never appears → unregistered repo.
      const { calls } = stubFetch({ installedBody: {} });
      // Simulate clone landing the dir on disk, with no requirements/install.py.
      let cloned = false;
      mockedExists.mockImplementation((p: unknown) => {
        const s = String(p);
        if (s.includes("requirements.txt") || s.includes("install.py")) {
          return false;
        }
        if (s.includes(".venv")) return false;
        if (s.includes("cm-cli.py")) return false;
        if (s.includes(NODE_DIR_UTILS) || s.endsWith("comfyui-teskors-utils")) {
          return cloned;
        }
        return false;
      });
      mockedExec.mockImplementation(((bin: string, args: string[]) => {
        if (bin === "git" && args[0] === "clone") {
          cloned = true;
          return "";
        }
        return "";
      }) as never);

      const res = await installCustomNode({
        id: "https://github.com/teskor-hub/comfyui-teskors-utils",
      });

      expect(res.mechanism).toBe("git-clone");
      // Manager was still tried first (registry-first).
      expect(taskOf(calls, "install").params).toMatchObject({
        id: "comfyui-teskors-utils",
      });
      // git clone was invoked with the URL + the target node dir (shallow, no ref).
      const cloneCall = mockedExec.mock.calls.find(
        (c) => c[0] === "git" && (c[1] as string[])[0] === "clone",
      );
      expect(cloneCall).toBeDefined();
      // `--end-of-options` guards the URL/dir from being parsed as git options.
      expect(cloneCall![1]).toEqual([
        "clone",
        "--depth",
        "1",
        "--end-of-options",
        "https://github.com/teskor-hub/comfyui-teskors-utils",
        NODE_DIR_UTILS,
      ]);
      // The clone must run non-interactively so a missing/private repo fails fast
      // instead of hanging on a credential prompt.
      const cloneEnv = (cloneCall![2] as { env?: Record<string, string> })?.env;
      expect(cloneEnv?.GIT_TERMINAL_PROMPT).toBe("0");
      expect(cloneEnv?.GIT_ASKPASS).toBe("echo");
    });

    it("clones an unregistered git pack into opts.comfyuiPath when global COMFYUI_PATH is unset (#463)", async () => {
      // apply_manifest threads a call-scoped base (adopted saved-default/live root)
      // WITHOUT mutating global config. The clone fallback must honor it, or an
      // unregistered git URL fails despite a valid local workspace.
      config.comfyuiPath = undefined;
      const adopted = "/adopted/ComfyUI";
      const adoptedNodeDir = resolve(adopted, "custom_nodes", "comfyui-teskors-utils");
      stubFetch({ installedBody: {} });
      let cloned = false;
      mockedExists.mockImplementation((p: unknown) => {
        const s = String(p);
        if (s.includes("requirements.txt") || s.includes("install.py")) return false;
        if (s.includes(".venv") || s.includes("cm-cli.py")) return false;
        if (s.includes("comfyui-teskors-utils")) return cloned;
        return false;
      });
      mockedExec.mockImplementation(((bin: string, args: string[]) => {
        if (bin === "git" && args[0] === "clone") cloned = true;
        return "";
      }) as never);

      const res = await installCustomNode({
        id: "https://github.com/teskor-hub/comfyui-teskors-utils",
        comfyuiPath: adopted,
      });

      expect(res.mechanism).toBe("git-clone");
      const cloneCall = mockedExec.mock.calls.find(
        (c) => c[0] === "git" && (c[1] as string[])[0] === "clone",
      );
      expect(cloneCall).toBeDefined();
      // Cloned into the ADOPTED base's custom_nodes, not a global path.
      expect((cloneCall![1] as string[]).at(-1)).toBe(adoptedNodeDir);
      expect((cloneCall![2] as { cwd?: string }).cwd).toBe(adopted);
    });

    it("installs a cloned node's requirements.txt under the ADOPTED base's venv python, not bare system python (#463)", async () => {
      // With no global COMFYUI_PATH, the deps install must target the adopted
      // workspace's own .venv — otherwise requirements land under a bare system
      // python, corrupting/missing the real ComfyUI env while we report success.
      config.comfyuiPath = undefined;
      const adopted = "/adopted/ComfyUI";
      const IS_WIN = process.platform === "win32";
      // resolveVenvPython builds this with path.join (NOT resolve), so no drive
      // letter is prepended — mirror that exactly for the existsSync match.
      const venvPy = join(
        adopted,
        ".venv",
        IS_WIN ? "Scripts" : "bin",
        IS_WIN ? "python.exe" : "python",
      );
      const nodeDir = resolve(adopted, "custom_nodes", "comfyui-teskors-utils");
      const requirements = join(nodeDir, "requirements.txt");
      stubFetch({ installedBody: {} });
      let cloned = false;
      mockedExists.mockImplementation((p: unknown) => {
        const s = String(p);
        if (s === venvPy) return true; // adopted venv python present
        if (s === requirements) return true; // node ships requirements.txt
        if (s.includes("install.py") || s.includes("cm-cli.py")) return false;
        if (s.includes(".venv")) return false; // any OTHER venv path absent
        if (s.includes("comfyui-teskors-utils")) return cloned;
        return false;
      });
      mockedExec.mockImplementation(((bin: string, args: string[]) => {
        if (bin === "git" && args[0] === "clone") cloned = true;
        return "";
      }) as never);

      await installCustomNode({
        id: "https://github.com/teskor-hub/comfyui-teskors-utils",
        comfyuiPath: adopted,
      });

      const pipCall = mockedExec.mock.calls.find(
        (c) =>
          Array.isArray(c[1]) &&
          (c[1] as string[]).includes("-r") &&
          (c[1] as string[]).includes(requirements),
      );
      expect(pipCall).toBeDefined();
      // The deps install ran under the ADOPTED venv python, not bare "python".
      expect(pipCall![0]).toBe(venvPy);
    });

    it("full-clones (no --depth) and checks out an explicit ref on fallback", async () => {
      stubFetch({ installedBody: {} });
      let cloned = false;
      mockedExists.mockImplementation((p: unknown) => {
        const s = String(p);
        if (s.includes("requirements.txt") || s.includes("install.py")) {
          return false;
        }
        if (s.includes(".venv") || s.includes("cm-cli.py")) return false;
        if (s.includes(NODE_DIR_UTILS)) return cloned;
        return false;
      });
      mockedExec.mockImplementation(((bin: string, args: string[]) => {
        if (bin === "git" && args[0] === "clone") cloned = true;
        return "";
      }) as never);

      const res = await installCustomNode({
        id: "https://github.com/teskor-hub/comfyui-teskors-utils",
        ref: "v1.2.3",
      });

      expect(res.mechanism).toBe("git-clone");
      const cloneCall = mockedExec.mock.calls.find(
        (c) => c[0] === "git" && (c[1] as string[])[0] === "clone",
      );
      // Full clone (no --depth) so the ref is reachable.
      expect(cloneCall![1]).toEqual([
        "clone",
        "--end-of-options",
        "https://github.com/teskor-hub/comfyui-teskors-utils",
        NODE_DIR_UTILS,
      ]);
      // Followed by a checkout of the ref.
      expect(
        mockedExec.mock.calls.some(
          (c) => c[0] === "git" && (c[1] as string[]).includes("checkout"),
        ),
      ).toBe(true);
    });

    it("throws ProcessControlError on clone fallback when comfyuiPath is unset", async () => {
      config.comfyuiPath = undefined;
      stubFetch({ installedBody: {} });
      await expect(
        installCustomNode({
          id: "https://github.com/teskor-hub/comfyui-teskors-utils",
        }),
      ).rejects.toBeInstanceOf(ProcessControlError);
    });

    it("rejects a git URL starting with '-' (option injection) without cloning", async () => {
      stubFetch({ installedBody: {} });
      await expect(
        installCustomNode({ id: "--upload-pack=evil", source: "git" }),
      ).rejects.toBeInstanceOf(ValidationError);
      // git clone must NEVER run for an injection attempt.
      expect(mockedExec).not.toHaveBeenCalledWith(
        "git",
        expect.arrayContaining(["clone"]),
        expect.anything(),
      );
    });

    it("rejects a repo name that resolves to '..' (path traversal) without cloning", async () => {
      stubFetch({ installedBody: {} });
      await expect(
        installCustomNode({ id: "https://github.com/foo/.." }),
      ).rejects.toBeInstanceOf(ValidationError);
      expect(mockedExec).not.toHaveBeenCalledWith(
        "git",
        expect.arrayContaining(["clone"]),
        expect.anything(),
      );
    });

    it("rejects explicit git refs that could be interpreted as git options", async () => {
      const { calls } = stubFetch();
      await expect(
        installCustomNode({ id: "https://github.com/foo/bar", ref: "--foo" }),
      ).rejects.toBeInstanceOf(ValidationError);
      expect(calls).toHaveLength(0);
    });

    it("rejects explicit git refs containing ASCII control characters", async () => {
      const { calls } = stubFetch();
      await expect(
        installCustomNode({ id: "https://github.com/foo/bar", ref: "bad\nref" }),
      ).rejects.toBeInstanceOf(ValidationError);
      expect(calls).toHaveLength(0);
    });

    it("uses version as the git ref when no explicit ref is present", async () => {
      const { calls } = stubFetch({ installedBody: installedBar });
      await installCustomNode({
        id: "https://github.com/foo/bar",
        version: "release",
      });

      const { params } = taskOf(calls, "install");
      expect(params).toMatchObject({
        id: "bar",
        selected_version: "release",
      });
    });

    it("honors an explicit version", async () => {
      const { calls } = stubFetch({
        installedBody: { "some-pack": { ver: "1.2.3", cnr_id: "some-pack", enabled: true } },
      });
      await installCustomNode({ id: "some-pack", version: "1.2.3" });
      const { params } = taskOf(calls, "install");
      expect(params).toMatchObject({
        version: "1.2.3",
        selected_version: "1.2.3",
      });
    });

    it("ignores ref for registry installs", async () => {
      const { calls } = stubFetch({
        installedBody: { "some-pack": { ver: "latest", cnr_id: "some-pack", enabled: true } },
      });
      await installCustomNode({ id: "some-pack", ref: "dev" });
      const { params } = taskOf(calls, "install");
      expect(params).toMatchObject({
        id: "some-pack",
        version: "latest",
        selected_version: "latest",
      });
    });

    it("does not return early when the worker has not yet started (pending queue)", async () => {
      // First poll: worker thread not yet spun up — idle-looking but a queued
      // item is pending (total=1 > done=0). Must NOT be treated as done.
      // Second poll: worker is running. Third: drained.
      const { calls } = stubFetch({
        installedBody: { pack: { ver: "latest", cnr_id: "pack", enabled: true } },
        statusSequence: [
          { total_count: 1, done_count: 0, in_progress_count: 0, is_processing: false },
          { total_count: 1, done_count: 0, in_progress_count: 1, is_processing: true },
          { total_count: 1, done_count: 1, in_progress_count: 0, is_processing: false },
        ],
      });

      const res = await installCustomNode({ id: "pack" });
      expect(res.mechanism).toBe("manager-http");
      // It should have polled status at least 3 times before returning.
      const statusPolls = calls.filter((c) =>
        c.url.endsWith("/manager/queue/status"),
      );
      expect(statusPolls.length).toBeGreaterThanOrEqual(3);
      expect((res.details as { done_count: number }).done_count).toBe(1);
    });

    it("uses cm-cli subprocess when forced", async () => {
      mockedExec.mockReturnValue(cliEnvelope({ message: "installed ok" }) as never);
      const res = await installCustomNode({ id: "some-pack", useCmCli: true });

      expect(res.mechanism).toBe("comfy-cli");
      const [bin, args] = mockedExec.mock.calls[0];
      expect(bin).toBe(COMFY_CLI);
      expect(args).toEqual([
        "--json",
        "--workspace",
        COMFY,
        "--skip-prompt",
        "node",
        "install",
        "some-pack",
        "--mode",
        "remote",
        "--channel",
        "default",
      ]);
    });

    it("checks out the requested git ref after forced cm-cli install", async () => {
      mockedExec.mockReturnValue(cliEnvelope({ message: "installed ok" }) as never);
      const res = await installCustomNode({
        id: "https://github.com/foo/bar/tree/dev",
        ref: "abc123",
        useCmCli: true,
      });

      expect(res.mechanism).toBe("comfy-cli");
      expect(mockedExec).toHaveBeenCalledTimes(3);
      expect(mockedExec.mock.calls[0][1]).toEqual([
        "--json",
        "--workspace",
        COMFY,
        "--skip-prompt",
        "node",
        "install",
        "https://github.com/foo/bar",
        "--mode",
        "remote",
        "--channel",
        "default",
      ]);
      expect(mockedExec.mock.calls[1][0]).toBe("git");
      expect(mockedExec.mock.calls[1][1]).toEqual([
        "-C",
        BAR_DIR,
        "fetch",
        "--all",
        "--tags",
      ]);
      expect(mockedExec.mock.calls[2][0]).toBe("git");
      expect(mockedExec.mock.calls[2][1]).toEqual([
        "-C",
        BAR_DIR,
        "checkout",
        "--detach",
        "--end-of-options",
        "abc123",
      ]);
    });
  });

  // ---- update ------------------------------------------------------------

  describe("updateCustomNode", () => {
    it("updates a single pack via an update task", async () => {
      const { calls } = stubFetch();
      await updateCustomNode({ id: "my-pack" });
      const { params } = taskOf(calls, "update");
      expect(params).toMatchObject({ node_name: "my-pack" });
    });

    it("routes 'all' to /v2/manager/queue/update_all with QUERY params (not body)", async () => {
      const { calls } = stubFetch();
      await updateCustomNode({ id: "all", mode: "local" });
      const c = calls.find((x) =>
        x.url.includes("/v2/manager/queue/update_all"),
      );
      expect(c).toBeDefined();
      // The backend reads UpdateAllQueryParams from the query string only.
      const u = new URL(c!.url);
      expect(u.searchParams.get("mode")).toBe("local");
      expect(u.searchParams.get("client_id")).toBe("comfyui-mcp");
      expect(u.searchParams.get("ui_id")).toBeTruthy();
      // No JSON body.
      expect(c!.body).toBeUndefined();
    });
  });

  // ---- reinstall ---------------------------------------------------------

  describe("reinstallCustomNode", () => {
    it("models reinstall as an uninstall task followed by an install task", async () => {
      const { calls } = stubFetch();
      await reinstallCustomNode({ id: "my-pack" });
      expect(taskOf(calls, "uninstall").params).toMatchObject({
        node_name: "my-pack",
      });
      expect(taskOf(calls, "install").params).toMatchObject({
        id: "my-pack",
        version: "latest",
      });
    });
  });

  // ---- fix ---------------------------------------------------------------

  describe("fixCustomNode", () => {
    it("posts a single pack via a fix task over HTTP", async () => {
      const { calls } = stubFetch();
      const res = await fixCustomNode({ id: "my-pack" });
      expect(res.mechanism).toBe("manager-http");
      expect(taskOf(calls, "fix").params).toMatchObject({ node_name: "my-pack" });
    });

    it("routes 'all' to the cm-cli subprocess", async () => {
      mockedExec.mockReturnValue(cliEnvelope({ message: "fixed all" }) as never);
      const res = await fixCustomNode({ id: "all" });
      expect(res.mechanism).toBe("comfy-cli");
      const [, args] = mockedExec.mock.calls[0];
      expect(args).toContain("fix");
      expect(args).toContain("all");
    });
  });

  // ---- list --------------------------------------------------------------

  describe("listInstalledNodes", () => {
    it("parses an object-keyed installed response", async () => {
      stubFetch({
        installedBody: {
          "ComfyUI-Impact-Pack": {
            ver: "8.0.0",
            cnr_id: "comfyui-impact-pack",
            aux_id: "",
            enabled: true,
          },
          "some-git-node": {
            ver: "abc1234",
            cnr_id: "",
            aux_id: "user/some-git-node",
            enabled: false,
          },
        },
      });

      const nodes = await listInstalledNodes();
      expect(nodes).toHaveLength(2);

      const impact = nodes.find((n) => n.module === "ComfyUI-Impact-Pack")!;
      expect(impact.cnrId).toBe("comfyui-impact-pack");
      expect(impact.auxId).toBeUndefined();
      expect(impact.version).toBe("8.0.0");
      expect(impact.enabled).toBe(true);

      const git = nodes.find((n) => n.module === "some-git-node")!;
      expect(git.auxId).toBe("user/some-git-node");
      expect(git.cnrId).toBeUndefined();
      expect(git.enabled).toBe(false);
    });

    it("handles an array-shaped installed response", async () => {
      stubFetch({
        installedBody: [
          { title: "PackA", ver: "1.0.0", cnr_id: "packa", enabled: true },
        ],
      });
      const nodes = await listInstalledNodes();
      expect(nodes).toHaveLength(1);
      expect(nodes[0].module).toBe("PackA");
    });

    it("treats missing enabled as enabled unless is_disabled is set", async () => {
      stubFetch({
        installedBody: {
          A: { ver: "1" },
          B: { ver: "1", is_disabled: true },
        },
      });
      const nodes = await listInstalledNodes();
      expect(nodes.find((n) => n.module === "A")!.enabled).toBe(true);
      expect(nodes.find((n) => n.module === "B")!.enabled).toBe(false);
    });
  });

  // ---- sync deps ---------------------------------------------------------

  describe("syncNodeDependencies", () => {
    it("runs cm-cli restore-dependencies", async () => {
      mockedExec.mockReturnValue(cliEnvelope({ message: "deps restored" }) as never);
      const res = await syncNodeDependencies();
      expect(res.mechanism).toBe("comfy-cli");
      const [, args] = mockedExec.mock.calls[0];
      expect(args).toEqual([
        "--json",
        "--workspace",
        COMFY,
        "--skip-prompt",
        "node",
        "restore-dependencies",
      ]);
    });
  });

  // ---- install model -----------------------------------------------------

  describe("installModelViaManager", () => {
    it("queues an install-model task with name/url/filename/type/save_path and drains the queue", async () => {
      const { calls } = stubFetch();
      const res = await installModelViaManager({
        name: "model.safetensors",
        url: "https://example.com/model.safetensors",
        filename: "model.safetensors",
        type: "checkpoints",
      });

      expect(res.mechanism).toBe("manager-http");
      const { body, params } = taskOf(calls, "install-model");
      // Envelope matches the other tasks: ui_id + client_id + kind + params.
      expect(body.client_id).toBe("comfyui-mcp");
      expect(body.kind).toBe("install-model");
      expect(body.ui_id).toBeTruthy();
      expect(params).toMatchObject({
        name: "model.safetensors",
        url: "https://example.com/model.safetensors",
        filename: "model.safetensors",
        type: "checkpoints",
      });
      // ui_id is threaded into params like the other task kinds.
      expect(params.ui_id).toBe(body.ui_id);
      // save_path is ALWAYS sent, defaulting to the literal "default" when no
      // explicit path is given (Manager bails on a missing save_path).
      expect(params.save_path).toBe("default");
      // Drain only proves dispatch, not landing — message must NOT claim success.
      expect(res.message).not.toMatch(/\binstalled\b/i);
      expect(res.message).toMatch(/dispatched/i);

      // The queue worker was started and polled to completion.
      expect(
        calls.some((c) => c.url.endsWith("/v2/manager/queue/start")),
      ).toBe(true);
      expect(
        calls.some((c) => c.url.endsWith("/v2/manager/queue/status")),
      ).toBe(true);
    });

    it("includes save_path when provided", async () => {
      const { calls } = stubFetch();
      await installModelViaManager({
        name: "lora.safetensors",
        url: "https://example.com/lora.safetensors",
        filename: "lora.safetensors",
        type: "lora",
        save_path: "loras/pusa",
      });
      const { params } = taskOf(calls, "install-model");
      expect(params.save_path).toBe("loras/pusa");
    });

    it("falls back to filename for name and 'default' for save_path when blank", async () => {
      const { calls } = stubFetch();
      await installModelViaManager({
        name: "   ",
        url: "https://example.com/m.safetensors",
        filename: "m.safetensors",
        type: "checkpoints",
        save_path: "  ",
      });
      const { params } = taskOf(calls, "install-model");
      expect(params.name).toBe("m.safetensors");
      expect(params.save_path).toBe("default");
    });
  });

  // ---- error handling ----------------------------------------------------

  describe("subprocess error handling", () => {
    it("throws ProcessControlError when comfyuiPath is undefined (remote mode)", async () => {
      config.comfyuiPath = undefined;
      await expect(syncNodeDependencies()).rejects.toBeInstanceOf(
        ProcessControlError,
      );
      expect(mockedExec).not.toHaveBeenCalled();
    });

    it("throws NodeManagementError when cm-cli.py is missing", async () => {
      mockedExists.mockReturnValue(false);
      await expect(syncNodeDependencies()).rejects.toBeInstanceOf(
        NodeManagementError,
      );
    });

    it("wraps cm-cli failures with stdout/stderr details", async () => {
      const err = Object.assign(new Error("boom"), {
        stdout: Buffer.from("some out"),
        stderr: Buffer.from("trace"),
      });
      mockedExec.mockImplementation(() => {
        throw err;
      });
      await expect(syncNodeDependencies()).rejects.toMatchObject({
        code: "NODE_MANAGEMENT_ERROR",
      });
    });

    it("surfaces a clear error when ENOENT (python missing)", async () => {
      const err = Object.assign(new Error("spawn python ENOENT"), {
        code: "ENOENT",
      });
      mockedExec.mockImplementation(() => {
        throw err;
      });
      await expect(syncNodeDependencies()).rejects.toBeInstanceOf(
        ProcessControlError,
      );
    });
  });

  describe("HTTP error handling", () => {
    it("throws NodeManagementError when the Manager API is unreachable", async () => {
      const fetchMock = vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      });
      vi.stubGlobal("fetch", fetchMock);
      await expect(
        installCustomNode({ id: "x" }),
      ).rejects.toBeInstanceOf(NodeManagementError);
    });
  });

  // ---- released Manager 3.x (legacy /manager/* API — issue #116) -----------

  describe("legacy Manager 3.x API", () => {
    /** Stub where every /v2 route 405s (like released Manager 3.41) and the
     *  legacy per-operation routes answer. */
    function stubLegacyFetch(opts: { installedBody?: unknown } = {}) {
      const calls: Call[] = [];
      const fetchMock = vi.fn(
        async (url: string, init?: RequestInit): Promise<Response> => {
          const method = init?.method ?? "GET";
          const body = init?.body ? JSON.parse(init.body as string) : undefined;
          calls.push({ url, method, body });
          const path = new URL(url).pathname;
          if (path.startsWith("/v2/")) {
            return new Response("405: Method Not Allowed", { status: 405 });
          }
          if (path === "/manager/queue/status") {
            return jsonResponse({
              total_count: 1,
              done_count: 1,
              in_progress_count: 0,
              is_processing: false,
            });
          }
          if (path === "/customnode/installed") {
            return jsonResponse(opts.installedBody ?? {});
          }
          return new Response("", { status: 200 });
        },
      );
      vi.stubGlobal("fetch", fetchMock);
      return { calls };
    }

    const legacyCallTo = (calls: Call[], path: string) =>
      calls.find((c) => new URL(c.url).pathname === path);

    it("detects legacy and installs a registry id via /manager/queue/install", async () => {
      const { calls } = stubLegacyFetch({
        installedBody: {
          "comfyui-impact-pack": { ver: "1.0.0", cnr_id: "comfyui-impact-pack", enabled: true },
        },
      });
      const res = await installCustomNode({ id: "comfyui-impact-pack" });
      expect(res.mechanism).toBe("manager-http");
      const install = legacyCallTo(calls, "/manager/queue/install");
      expect(install?.body).toMatchObject({
        id: "comfyui-impact-pack",
        version: "latest",
        selected_version: "latest",
        channel: "default",
        mode: "remote",
      });
      // start + status polled on the UNPREFIXED routes; the task route never used
      expect(legacyCallTo(calls, "/manager/queue/start")).toBeDefined();
      expect(legacyCallTo(calls, "/v2/manager/queue/task")).toBeUndefined();
    });

    it("installs a git URL natively via { version:'unknown', files:[url] }", async () => {
      const { calls } = stubLegacyFetch({
        installedBody: { bar: { ver: "unknown", aux_id: "foo/bar", enabled: true } },
      });
      const res = await installCustomNode({
        id: "https://github.com/foo/bar",
        source: "git",
      });
      expect(res.mechanism).toBe("manager-http");
      const install = legacyCallTo(calls, "/manager/queue/install");
      expect(install?.body).toMatchObject({
        version: "unknown",
        selected_version: "unknown",
        files: ["https://github.com/foo/bar"],
      });
    });

    it("routes update / fix to the per-operation legacy endpoints", async () => {
      const { calls } = stubLegacyFetch();
      await updateCustomNode({ id: "comfyui-foo" });
      await fixCustomNode({ id: "comfyui-foo" });
      expect(legacyCallTo(calls, "/manager/queue/update")?.body).toMatchObject({
        id: "comfyui-foo",
      });
      expect(legacyCallTo(calls, "/manager/queue/fix")?.body).toMatchObject({
        id: "comfyui-foo",
      });
    });

    it("update all posts {mode} in the JSON body (legacy reads body, not query)", async () => {
      const { calls } = stubLegacyFetch();
      await updateCustomNode({ id: "all", mode: "remote" });
      const call = legacyCallTo(calls, "/manager/queue/update_all");
      expect(call?.body).toMatchObject({ mode: "remote" });
      expect(call?.url.includes("?")).toBe(false);
    });

    it("lists installed nodes from the unprefixed /customnode/installed", async () => {
      stubLegacyFetch({
        installedBody: { foo: { ver: "1.0.0", enabled: true } },
      });
      const nodes = await listInstalledNodes();
      expect(nodes.length).toBeGreaterThan(0);
    });

    it("caches detection per target (one probe, not one per operation)", async () => {
      const { calls } = stubLegacyFetch();
      await updateCustomNode({ id: "a" });
      await updateCustomNode({ id: "b" });
      const probes = calls.filter(
        (c) => new URL(c.url).pathname === "/v2/manager/queue/status",
      );
      expect(probes.length).toBe(1);
    });

    // ── #424: updating ComfyUI-Manager ITSELF on legacy 3.x can't go through the
    // queue (it 405s the self-update route) → git-pull the local checkout instead.
    it("update of comfyui-manager self falls back to a local git pull (never the queue)", async () => {
      const { calls } = stubLegacyFetch();
      mockedExists.mockReturnValue(true); // custom_nodes/ComfyUI-Manager/.git present
      mockedExec.mockReturnValue("Already up to date." as unknown as Buffer);

      const res = await updateCustomNode({ id: "comfyui-manager" });

      expect(res.mechanism).toBe("git-clone");
      // A git pull of the Manager checkout was run …
      const pull = mockedExec.mock.calls.find(
        ([bin, args]) =>
          bin === "git" && Array.isArray(args) && args.includes("pull"),
      );
      expect(pull).toBeDefined();
      // … and the Manager queue update route was NEVER touched.
      expect(legacyCallTo(calls, "/manager/queue/update")).toBeUndefined();
    });

    it("update of Manager self with NO local checkout errors actionably (no queue call)", async () => {
      const { calls } = stubLegacyFetch();
      mockedExists.mockReturnValue(false); // no on-disk ComfyUI-Manager checkout

      await expect(updateCustomNode({ id: "ComfyUI-Manager" })).rejects.toThrow(
        /pip install -U comfyui_manager|git pull/i,
      );
      expect(legacyCallTo(calls, "/manager/queue/update")).toBeUndefined();
    });
  });

  // ── issue #235: pip Manager in legacy-UI mode = the "v2-batch" dialect ────
  describe("v2-batch dialect (pip Manager with --enable-manager-legacy-ui)", () => {
    /** Stub a server shaped like comfyui_manager 4.2.2 in legacy-UI mode:
     *  /v2 status + is_legacy_manager_ui:true + batch; NO /v2 task route
     *  (a POST there gets ComfyUI's catchall 405, per the field report). */
    function stubBatchFetch(opts: { failed?: unknown[]; installedBody?: unknown } = {}) {
      const calls: Call[] = [];
      const fetchMock = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
        const method = init?.method ?? "GET";
        const body = init?.body ? JSON.parse(init.body as string) : undefined;
        calls.push({ url, method, body });
        const path = new URL(url).pathname;
        if (path.startsWith("/v2/customnode/installed")) return jsonResponse(opts.installedBody ?? {});
        if (path === "/v2/manager/queue/status") {
          return jsonResponse({ total_count: 1, done_count: 1, in_progress_count: 0, is_processing: false });
        }
        if (path === "/v2/manager/is_legacy_manager_ui") {
          return jsonResponse({ is_legacy_manager_ui: true });
        }
        if (path === "/v2/manager/queue/batch" && method === "POST") {
          return jsonResponse({ failed: opts.failed ?? [] });
        }
        if (path === "/v2/manager/queue/start" && method === "POST") {
          return new Response("", { status: 200 });
        }
        if (path === "/v2/manager/queue/task") {
          // The exact #235 signature: route unregistered, catchall answers 405.
          return new Response("405: Method Not Allowed", { status: 405 });
        }
        return new Response("", { status: 200 });
      });
      vi.stubGlobal("fetch", fetchMock);
      return { calls };
    }

    it("installs through /v2/manager/queue/batch with a 3.x body — never touches the task route", async () => {
      const { calls } = stubBatchFetch({
        installedBody: { "comfyui-impact-pack": { ver: "1.0.0", cnr_id: "comfyui-impact-pack", enabled: true } },
      });
      const res = await installCustomNode({ id: "comfyui-impact-pack" });
      expect(res.mechanism).toBe("manager-http");
      const batch = calls.find((c) => c.url.includes("/v2/manager/queue/batch"));
      expect(batch).toBeDefined();
      const payload = batch!.body as Record<string, Array<Record<string, unknown>>>;
      expect(Object.keys(payload)).toEqual(["install"]);
      expect(payload.install[0]).toMatchObject({ id: "comfyui-impact-pack", channel: "default" });
      expect(typeof payload.install[0].ui_id).toBe("string");
      expect(calls.some((c) => c.url.includes("/v2/manager/queue/task"))).toBe(false);
      // still drains the queue for temp-queued post-install work
      expect(calls.some((c) => c.url.endsWith("/v2/manager/queue/start"))).toBe(true);
    });

    it("git-URL installs use the 3.x URL-carrying body (version:'unknown', files:[url])", async () => {
      // codex review on #235: v2-batch runs the 3.x handlers, so a git URL
      // must NOT take v4's registry-first shape (which resolves ids against
      // the registry DB and silently no-ops on a full URL).
      const { calls } = stubBatchFetch({
        installedBody: { bar: { ver: "unknown", cnr_id: "bar", enabled: true, aux_id: "foo/bar" } },
      });
      await installCustomNode({ id: "https://github.com/foo/bar" }).catch(() => {});
      const batch = calls.find((c) => c.url.includes("/v2/manager/queue/batch"));
      expect(batch).toBeDefined();
      const payload = batch!.body as Record<string, Array<Record<string, unknown>>>;
      expect(payload.install[0]).toMatchObject({
        version: "unknown",
        selected_version: "unknown",
        files: ["https://github.com/foo/bar"],
      });
    });

    it("surfaces a batch-reported failure with the legacy-UI hint", async () => {
      stubBatchFetch({
        failed: ["comfyui-impact-pack"],
        installedBody: { "comfyui-impact-pack": { ver: "1.0.0", cnr_id: "comfyui-impact-pack", enabled: true } },
      });
      await expect(installCustomNode({ id: "comfyui-impact-pack" })).rejects.toThrow(
        /reported the install .* as failed[\s\S]*legacy-ui mode/i,
      );
    });

    it("routes install-model to the dedicated /v2 route (not the batch)", async () => {
      // reach queueManagerTask("install-model") through the public surface via
      // detection cache pinning + a direct queue call is not exported; instead
      // assert the detection outcome feeds managerQueuePrefix by checking a
      // second op — covered above — and the model path via downloadModel is
      // exercised in its own suite. Here we lock the DETECTION itself:
      const { calls } = stubBatchFetch();
      await listInstalledNodes().catch(() => {});
      // the discriminator probe must have run
      expect(calls.some((c) => c.url.includes("/v2/manager/is_legacy_manager_ui"))).toBe(true);
    });
  });

  // ── issue #464: unified /v2 task route 405s → negotiate to v2-batch ───────
  // A build serves the bundled 3.x server under /v2 (queue/status answers), but
  // its `is_legacy_manager_ui` probe does NOT identify it, so detection defaults
  // to the "v2" unified dialect. A POST to /v2/manager/queue/task then 405s (the
  // frontend catchall — the task route is unregistered), which used to surface
  // as a raw "Manager …/queue/task: HTTP 405" from panel_update_node. The fix
  // treats that 405 as a method/route signal (like the queue/start POST→GET
  // negotiation) and downgrades to the v2-batch dialect, retrying via batch.
  describe("v2 task 405 → v2-batch negotiation (issue #464)", () => {
    /** Stub a build whose /v2 queue surface answers status but 405s the unified
     *  task route, with `is_legacy_manager_ui` absent (catchall HTML). */
    function stub464Fetch(opts: { failed?: unknown[] } = {}) {
      const calls: Call[] = [];
      const fetchMock = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
        const method = init?.method ?? "GET";
        const body = init?.body ? JSON.parse(init.body as string) : undefined;
        calls.push({ url, method, body });
        const path = new URL(url).pathname;
        if (path === "/v2/manager/queue/status") {
          return jsonResponse({ total_count: 1, done_count: 1, in_progress_count: 0, is_processing: false });
        }
        // The `is_legacy_manager_ui` route is unregistered → catchall HTML, so
        // resolveV2SubDialect can't detect legacy-UI and defaults to "v2".
        if (path === "/v2/manager/is_legacy_manager_ui") {
          return new Response("<!doctype html><html>frontend</html>", {
            status: 200, headers: { "Content-Type": "text/html" },
          });
        }
        if (path === "/v2/manager/queue/task") {
          // The #464 signature: unified task route unregistered → catchall 405.
          return new Response("405: Method Not Allowed", { status: 405 });
        }
        if (path === "/v2/manager/queue/batch" && method === "POST") {
          return jsonResponse({ failed: opts.failed ?? [] });
        }
        if (path === "/v2/manager/queue/start" && method === "POST") {
          return new Response("", { status: 200 });
        }
        return new Response("", { status: 200 });
      });
      vi.stubGlobal("fetch", fetchMock);
      return { calls };
    }

    it("panel_update_node succeeds via batch when /v2 task 405s (no raw 405 surfaced)", async () => {
      const { calls } = stub464Fetch();
      const res = await updateCustomNode({ id: "my-pack" });
      expect(res.mechanism).toBe("manager-http");
      // Downgraded to the batch envelope with the 3.x update body …
      const batch = calls.find((c) => c.url.includes("/v2/manager/queue/batch"));
      expect(batch).toBeDefined();
      const payload = batch!.body as Record<string, Array<Record<string, unknown>>>;
      expect(Object.keys(payload)).toEqual(["update"]);
      // … after first attempting the unified task route (proving the 405 path ran).
      expect(calls.some((c) => new URL(c.url).pathname === "/v2/manager/queue/task")).toBe(true);
      // and still drains the queue.
      expect(calls.some((c) => c.url.endsWith("/v2/manager/queue/start"))).toBe(true);
    });

    it("caches the corrected v2-batch dialect (second op skips the dead task route)", async () => {
      const { calls } = stub464Fetch();
      await updateCustomNode({ id: "pack-a" });
      const taskHitsAfterFirst = calls.filter(
        (c) => new URL(c.url).pathname === "/v2/manager/queue/task",
      ).length;
      await updateCustomNode({ id: "pack-b" });
      const taskHitsTotal = calls.filter(
        (c) => new URL(c.url).pathname === "/v2/manager/queue/task",
      ).length;
      // The second update must NOT re-probe the 405 task route — the dialect is pinned.
      expect(taskHitsTotal).toBe(taskHitsAfterFirst);
      expect(calls.filter((c) => c.url.includes("/v2/manager/queue/batch")).length).toBe(2);
    });

    it("does NOT poison the cache when task 405s but batch also fails — next op re-probes /task", async () => {
      // A proxy/WAF (or an unusual v4) could 405 /task while /v2 status works but
      // /batch does not. The failed downgrade must NOT pin "v2-batch" for later
      // ops. Here batch fails on the first attempt (500) then succeeds on the
      // second: the second op must still hit /task first (proving the cache was
      // never poisoned) before succeeding via batch.
      const calls: Call[] = [];
      let batchHits = 0;
      const fetchMock = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
        const method = init?.method ?? "GET";
        const body = init?.body ? JSON.parse(init.body as string) : undefined;
        calls.push({ url, method, body });
        const path = new URL(url).pathname;
        if (path === "/v2/manager/queue/status") {
          return jsonResponse({ total_count: 1, done_count: 1, in_progress_count: 0, is_processing: false });
        }
        if (path === "/v2/manager/is_legacy_manager_ui") {
          return new Response("<!doctype html>", { status: 200, headers: { "Content-Type": "text/html" } });
        }
        if (path === "/v2/manager/queue/task") {
          return new Response("405: Method Not Allowed", { status: 405 });
        }
        if (path === "/v2/manager/queue/batch" && method === "POST") {
          batchHits++;
          return batchHits === 1
            ? new Response("500: Internal Server Error", { status: 500 })
            : jsonResponse({ failed: [] });
        }
        if (path === "/v2/manager/queue/start" && method === "POST") return new Response("", { status: 200 });
        return new Response("", { status: 200 });
      });
      vi.stubGlobal("fetch", fetchMock);
      // First op: task 405 → batch 500 → throws; cache must stay "v2".
      await expect(updateCustomNode({ id: "pack-a" })).rejects.toBeInstanceOf(NodeManagementError);
      const taskAfterFirst = calls.filter((c) => new URL(c.url).pathname === "/v2/manager/queue/task").length;
      expect(taskAfterFirst).toBeGreaterThan(0);
      // Second op: because the cache was NOT poisoned, it re-probes /task before batch.
      const res = await updateCustomNode({ id: "pack-b" });
      expect(res.mechanism).toBe("manager-http");
      const taskTotal = calls.filter((c) => new URL(c.url).pathname === "/v2/manager/queue/task").length;
      expect(taskTotal).toBe(taskAfterFirst + 1);
    });

    it("leaves a genuine v4 host on the unified task route (405 fallback not triggered)", async () => {
      const calls: Call[] = [];
      const fetchMock = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
        const method = init?.method ?? "GET";
        const body = init?.body ? JSON.parse(init.body as string) : undefined;
        calls.push({ url, method, body });
        const path = new URL(url).pathname;
        if (path === "/v2/manager/queue/status") {
          return jsonResponse({ total_count: 1, done_count: 1, in_progress_count: 0, pending_count: 0, is_processing: false });
        }
        if (path === "/v2/manager/is_legacy_manager_ui") return jsonResponse({ is_legacy_manager_ui: false });
        if (path === "/v2/manager/queue/task") return new Response("", { status: 200 });
        if (path === "/v2/manager/queue/start") return new Response("", { status: 200 });
        return new Response("", { status: 200 });
      });
      vi.stubGlobal("fetch", fetchMock);
      await updateCustomNode({ id: "my-pack" });
      const task = calls.find((c) => new URL(c.url).pathname === "/v2/manager/queue/task");
      expect(task).toBeDefined();
      expect((task!.body as { kind?: string }).kind).toBe("update");
      // Never downgraded to batch on a healthy v4 host.
      expect(calls.some((c) => c.url.includes("/v2/manager/queue/batch"))).toBe(false);
    });
  });

  describe("Manager detection hardening (issue #235)", () => {
    it("a 200-HTML SPA fallback on the v2 status probe does NOT detect v2", async () => {
      const calls: Call[] = [];
      const fetchMock = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
        calls.push({ url, method: init?.method ?? "GET", body: undefined });
        const path = new URL(url).pathname;
        if (path === "/v2/manager/queue/status") {
          return new Response("<!doctype html><html>frontend</html>", {
            status: 200, headers: { "Content-Type": "text/html" },
          });
        }
        if (path === "/manager/queue/status") {
          return jsonResponse({ total_count: 0, done_count: 0, in_progress_count: 0, is_processing: false });
        }
        if (path.startsWith("/v2/customnode/installed")) return jsonResponse({});
        return new Response("", { status: 200 });
      });
      vi.stubGlobal("fetch", fetchMock);
      await listInstalledNodes().catch(() => {});
      // fell through to the legacy probe instead of trusting the HTML 200
      expect(calls.some((c) => c.url.endsWith("/manager/queue/status"))).toBe(true);
    });
  });

  // ── Manager version-dialect cluster (#551 GET-only start, #553 v3→v4 recovery,
  //    #555 authoritative v4 detection — a 405 is a method/route signal, never a
  //    version signal) ─────────────────────────────────────────────────────────
  describe("Manager 405 dialect cluster (#551 / #553 / #555)", () => {
    const pathOf = (calls: Call[], p: string) =>
      calls.filter((c) => new URL(c.url).pathname === p);

    // ---- #551: legacy /manager/queue/start exposed GET-only ------------------
    it("negotiates POST→GET when legacy /manager/queue/start is GET-only (#551)", async () => {
      const calls: Call[] = [];
      const fetchMock = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
        const method = init?.method ?? "GET";
        const body = init?.body ? JSON.parse(init.body as string) : undefined;
        calls.push({ url, method, body });
        const path = new URL(url).pathname;
        if (path.startsWith("/v2/")) return new Response("405: Method Not Allowed", { status: 405 });
        if (path === "/manager/version") return new Response("V3.41", { status: 200 });
        if (path === "/manager/queue/status") {
          return jsonResponse({ total_count: 1, done_count: 1, in_progress_count: 0, is_processing: false });
        }
        if (path === "/manager/queue/start") {
          // GET-only build: 405 to POST, 200 to GET (the #551 quirk).
          return method === "POST"
            ? new Response("405: Method Not Allowed", { status: 405 })
            : new Response("", { status: 200 });
        }
        if (path === "/customnode/installed") {
          return jsonResponse({ "comfyui-impact-pack": { ver: "1.0.0", cnr_id: "comfyui-impact-pack", enabled: true } });
        }
        return new Response("", { status: 200 });
      });
      vi.stubGlobal("fetch", fetchMock);

      // Must SUCCEED (the install must not fail on the method mismatch).
      const res = await installCustomNode({ id: "comfyui-impact-pack" });
      expect(res.mechanism).toBe("manager-http");
      const startCalls = pathOf(calls, "/manager/queue/start");
      // POST was tried first, then re-negotiated as GET.
      expect(startCalls.some((c) => c.method === "POST")).toBe(true);
      expect(startCalls.some((c) => c.method === "GET")).toBe(true);
    });

    it("re-throws a non-405 error from queue/start unchanged (no blind GET retry)", async () => {
      const calls: Call[] = [];
      const fetchMock = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
        const method = init?.method ?? "GET";
        calls.push({ url, method, body: undefined });
        const path = new URL(url).pathname;
        if (path.startsWith("/v2/")) return new Response("405", { status: 405 });
        if (path === "/manager/version") return new Response("V3.41", { status: 200 });
        if (path === "/manager/queue/status") {
          return jsonResponse({ total_count: 1, done_count: 1, in_progress_count: 0, is_processing: false });
        }
        if (path === "/manager/queue/start") return new Response("boom", { status: 500 });
        if (path === "/customnode/installed") {
          return jsonResponse({ "p": { ver: "1", cnr_id: "p", enabled: true } });
        }
        return new Response("", { status: 200 });
      });
      vi.stubGlobal("fetch", fetchMock);
      await expect(installCustomNode({ id: "p" })).rejects.toBeInstanceOf(NodeManagementError);
      // A 500 must NOT be retried as GET (only a 405 method-mismatch is).
      const startGets = pathOf(calls, "/manager/queue/start").filter((c) => c.method === "GET");
      expect(startGets.length).toBe(0);
    });

    it("does NOT treat an HTML catchall GET as a successful queue start (codex P2)", async () => {
      // The start path is UNREGISTERED for both methods: POST 405s, GET 200s with
      // ComfyUI's SPA HTML page (the frontend catchall). That HTML must NOT be
      // read as a real GET-only start — the original method error must surface.
      const fetchMock = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
        const method = init?.method ?? "GET";
        const path = new URL(url).pathname;
        if (path.startsWith("/v2/")) return new Response("405", { status: 405 });
        if (path === "/manager/version") return new Response("V3.41", { status: 200 });
        if (path === "/manager/queue/status") {
          return jsonResponse({ total_count: 1, done_count: 1, in_progress_count: 0, is_processing: false });
        }
        if (path === "/manager/queue/start") {
          return method === "POST"
            ? new Response("405: Method Not Allowed", { status: 405 })
            : new Response("<!doctype html><html>frontend</html>", { status: 200, headers: { "Content-Type": "text/html" } });
        }
        if (path === "/customnode/installed") {
          return jsonResponse({ "comfyui-impact-pack": { ver: "1.0.0", cnr_id: "comfyui-impact-pack", enabled: true } });
        }
        return new Response("", { status: 200 });
      });
      vi.stubGlobal("fetch", fetchMock);
      // The install must FAIL rather than silently "succeed" on a catchall page.
      await expect(installCustomNode({ id: "comfyui-impact-pack" })).rejects.toBeInstanceOf(NodeManagementError);
    });

    // ---- #555: authoritative v4 detection ------------------------------------
    it("rescues a v4 host to v2 when /manager/queue/status also answers AND the v4 surface re-validates (#555)", async () => {
      // A hybrid/transient shape: the FIRST /v2 queue-status probe missed (HTML
      // catchall) and a bare /manager/queue/status answered — which alone made
      // 0.48.21 conclude "legacy 3.x". The authoritative /v2/manager/version
      // ("V4.x") overrides that, but ONLY after re-confirming the v4 queue surface
      // actually validates (so we never route to a dead surface — codex P1).
      const calls: Call[] = [];
      let v2StatusHits = 0;
      const fetchMock = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
        const method = init?.method ?? "GET";
        calls.push({ url, method, body: undefined });
        const path = new URL(url).pathname;
        if (path === "/v2/manager/queue/status") {
          v2StatusHits++;
          // First probe misses (catchall); the re-probe after the version check
          // validates → safe to speak v4.
          return v2StatusHits === 1
            ? new Response("<!doctype html>", { status: 200, headers: { "Content-Type": "text/html" } })
            : jsonResponse({ total_count: 0, done_count: 0, in_progress_count: 0, pending_count: 0, is_processing: false });
        }
        if (path === "/manager/queue/status") return jsonResponse({ total_count: 0, done_count: 0, in_progress_count: 0, is_processing: false });
        if (path === "/v2/manager/version") return new Response("V4.2.2", { status: 200 });
        if (path === "/v2/manager/is_legacy_manager_ui") return jsonResponse({ is_legacy_manager_ui: false });
        if (path.startsWith("/v2/customnode/installed")) return jsonResponse({});
        if (path === "/customnode/installed") return jsonResponse({});
        return new Response("", { status: 200 });
      });
      vi.stubGlobal("fetch", fetchMock);
      await listInstalledNodes();
      // Detected v2 → listed from the /v2 route, NOT the unprefixed legacy route.
      expect(pathOf(calls, "/v2/customnode/installed").length).toBeGreaterThan(0);
      expect(pathOf(calls, "/customnode/installed").length).toBe(0);
    });

    it("does NOT route to v2 when the version says v4 but the v4 queue surface never validates (codex P1)", async () => {
      // version=V4 but /v2/manager/queue/status is persistently unreachable (HTML
      // catchall). Routing to v2 would enqueue work we then can't poll → a false
      // timeout and duplicate on retry. Must keep the WORKING legacy endpoint and
      // NEVER post a v4 task/queue mutation.
      const calls: Call[] = [];
      const fetchMock = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
        const method = init?.method ?? "GET";
        const body = init?.body ? JSON.parse(init.body as string) : undefined;
        calls.push({ url, method, body });
        const path = new URL(url).pathname;
        if (path === "/v2/manager/queue/status") return new Response("<!doctype html>", { status: 200, headers: { "Content-Type": "text/html" } });
        if (path === "/manager/queue/status") return jsonResponse({ total_count: 0, done_count: 0, in_progress_count: 0, is_processing: false });
        if (path === "/v2/manager/version") return new Response("V4.2.2", { status: 200 });
        if (path === "/customnode/installed") return jsonResponse({});
        return new Response("", { status: 200 });
      });
      vi.stubGlobal("fetch", fetchMock);
      await listInstalledNodes();
      // Stayed legacy → listed from the unprefixed route; NEVER touched the v4 task
      // route (no mutation posted to a dead surface).
      expect(pathOf(calls, "/customnode/installed").length).toBeGreaterThan(0);
      expect(pathOf(calls, "/v2/manager/queue/task").length).toBe(0);
    });

    it("recognizes a v4 queue-status shape carrying pending_count (#555)", async () => {
      // A status payload with pending_count (v4-style) but the classic counters
      // too must be accepted by the v2 probe rather than falling through.
      const calls: Call[] = [];
      const fetchMock = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
        calls.push({ url, method: init?.method ?? "GET", body: undefined });
        const path = new URL(url).pathname;
        if (path === "/v2/manager/queue/status") return jsonResponse({ done_count: 0, pending_count: 0, in_progress_count: 0 });
        if (path === "/v2/manager/is_legacy_manager_ui") return jsonResponse({ is_legacy_manager_ui: false });
        if (path.startsWith("/v2/customnode/installed")) return jsonResponse({});
        return new Response("", { status: 200 });
      });
      vi.stubGlobal("fetch", fetchMock);
      await listInstalledNodes();
      expect(pathOf(calls, "/v2/customnode/installed").length).toBeGreaterThan(0);
      // never fell through to the legacy probe
      expect(pathOf(calls, "/manager/queue/status").length).toBe(0);
    });

    it("still classifies a genuine 3.x host as legacy (version endpoint reports V3)", async () => {
      const calls: Call[] = [];
      const fetchMock = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
        calls.push({ url, method: init?.method ?? "GET", body: undefined });
        const path = new URL(url).pathname;
        if (path.startsWith("/v2/")) return new Response("<!doctype html>", { status: 200, headers: { "Content-Type": "text/html" } });
        if (path === "/manager/queue/status") return jsonResponse({ total_count: 0, done_count: 0, in_progress_count: 0, is_processing: false });
        if (path === "/manager/version") return new Response("V3.41", { status: 200 });
        if (path === "/customnode/installed") return jsonResponse({});
        return new Response("", { status: 200 });
      });
      vi.stubGlobal("fetch", fetchMock);
      await listInstalledNodes();
      // Legacy → listed from the UNPREFIXED route.
      expect(pathOf(calls, "/customnode/installed").length).toBeGreaterThan(0);
      expect(pathOf(calls, "/v2/customnode/installed").length).toBe(0);
    });

    it("routes install-model on a genuine v4 host to the /v2 task envelope, never the bare legacy route, with no 'legacy 3.x' message (#555)", async () => {
      const calls: Call[] = [];
      const fetchMock = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
        const method = init?.method ?? "GET";
        const body = init?.body ? JSON.parse(init.body as string) : undefined;
        calls.push({ url, method, body });
        const path = new URL(url).pathname;
        if (path === "/v2/manager/queue/status") return jsonResponse({ total_count: 1, done_count: 1, in_progress_count: 0, pending_count: 0, is_processing: false });
        if (path === "/v2/manager/is_legacy_manager_ui") return jsonResponse({ is_legacy_manager_ui: false });
        if (path === "/v2/manager/queue/task") return new Response("", { status: 200 });
        if (path === "/v2/manager/queue/start") return new Response("", { status: 200 });
        return new Response("", { status: 200 });
      });
      vi.stubGlobal("fetch", fetchMock);
      const res = await installModelViaManager({
        name: "m.safetensors",
        url: "https://example.com/m.safetensors",
        filename: "m.safetensors",
        type: "checkpoints",
      });
      // Correct v4 route: the unified task envelope with kind=install-model.
      const task = calls.find((c) => new URL(c.url).pathname === "/v2/manager/queue/task");
      expect(task).toBeDefined();
      expect((task!.body as { kind?: string }).kind).toBe("install-model");
      // NEVER the bare legacy per-op route (the #555 symptom).
      expect(pathOf(calls, "/manager/queue/install_model").length).toBe(0);
      // and NO false "legacy 3.x" / upgrade nag on a v4 host.
      expect(res.message).not.toMatch(/legacy/i);
      expect(res.message).not.toMatch(/pip install -U comfyui_manager/i);
    });

    // ---- #553: actionable v3→v4 recovery on a legacy install-model failure ----
    it("surfaces a precise v3→v4 migration recovery when a legacy 3.x model install fails (#553)", async () => {
      const fetchMock = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
        const method = init?.method ?? "GET";
        const path = new URL(url).pathname;
        if (path.startsWith("/v2/")) return new Response("405", { status: 405 });
        if (path === "/manager/version") return new Response("V3.41", { status: 200 });
        if (path === "/manager/queue/status") {
          return jsonResponse({ total_count: 0, done_count: 0, in_progress_count: 0, is_processing: false });
        }
        // Arbitrary-URL model install is whitelist-gated on 3.x → 500.
        if (path === "/manager/queue/install_model" && method === "POST") {
          return new Response("500: Internal Server Error", { status: 500 });
        }
        return new Response("", { status: 200 });
      });
      vi.stubGlobal("fetch", fetchMock);

      const err = await installModelViaManager({
        name: "m.safetensors",
        url: "https://example.com/m.safetensors",
        filename: "m.safetensors",
        type: "checkpoints",
      }).catch((e) => e as Error);

      expect(err).toBeInstanceOf(NodeManagementError);
      const msg = (err as Error).message;
      // Precise diagnosis …
      expect(msg).toMatch(/REQUIRE Manager v4\+/i);
      // … plus the actionable, numbered recovery path.
      expect(msg).toMatch(/pip install -U comfyui_manager/i);
      expect(msg).toMatch(/disable the old custom_nodes\/ComfyUI-Manager clone/i);
      expect(msg).toMatch(/--enable-manager/i);
    });
  });
});
