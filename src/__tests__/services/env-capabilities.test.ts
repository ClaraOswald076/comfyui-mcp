import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir, platform } from "node:os";
import { join } from "node:path";
import {
  formatEnvBlock,
  applyStats,
  buildPanelSystemAppend,
  resolveComfyuiPython,
  reconcileProbeState,
  resolveBackends,
  readInstalledPanelVersion,
  type EnvCapabilities,
} from "../../services/env-capabilities.js";

const IS_WIN = platform() === "win32";

describe("formatEnvBlock", () => {
  it("renders the full compact block from a complete caps object", () => {
    const caps: EnvCapabilities = {
      os: "Windows 11",
      gpu: "NVIDIA RTX 4090",
      vramTotalGb: 24,
      ramGb: 64,
      cuda: "13.0",
      torch: "2.10.0",
      python: "3.13",
      comfyui: "0.26.1",
      location: "LOCAL",
      triton: "not-installed",
      sageattention: "not-installed",
      backend: "Codex",
      otherBackendAvailable: true,
      mcpVersion: "0.48.4",
      panelVersion: "0.11.3",
    };
    const out = formatEnvBlock(caps);
    expect(out).toContain("ENVIRONMENT (live, this machine):");
    expect(out).toContain("comfyui-mcp 0.48.4 · panel 0.11.3");
    expect(out).toContain("OS Windows 11");
    expect(out).toContain("GPU NVIDIA RTX 4090 (24 GB VRAM)");
    expect(out).toContain("64 GB RAM");
    expect(out).toContain("CUDA 13.0");
    expect(out).toContain("torch 2.10.0");
    expect(out).toContain("python 3.13");
    expect(out).toContain("ComfyUI 0.26.1 (LOCAL)");
    expect(out).toContain("Triton: not installed");
    expect(out).toContain("SageAttention: not installed");
    expect(out).toContain("Backend: Codex; other providers available");
    // The guidance tail (acceleration decision) is always appended.
    expect(out).toContain("default to sdpa + no");
    expect(out).toContain("triton-sageattention skill");
  });

  it("omits unknown fields cleanly (no empty separators / placeholders)", () => {
    const caps: EnvCapabilities = {
      os: "Linux",
      ramGb: 32,
      location: "REMOTE",
      // gpu, cuda, torch, python, comfyui, triton, sageattention all unknown
      backend: "Claude",
      otherBackendAvailable: false,
    };
    const out = formatEnvBlock(caps);
    expect(out).toContain("OS Linux");
    expect(out).toContain("32 GB RAM");
    expect(out).toContain("(REMOTE)");
    expect(out).toContain("Backend: Claude");
    // Other provider not available → no "also available" clause.
    expect(out).not.toContain("also available");
    // Unknown fields are absent entirely. We check the field SEGMENTS (which sit
    // between " · " separators) rather than bare words, since the static guidance
    // tail legitimately mentions e.g. "torch.compile" / "Triton/SageAttention".
    const segments = out
      .replace(/^ENVIRONMENT \(live, this machine\): /, "")
      .split(". ")[0]
      .split(" · ");
    expect(segments.some((s) => s.startsWith("GPU "))).toBe(false);
    expect(segments.some((s) => s.startsWith("CUDA "))).toBe(false);
    expect(segments.some((s) => s.startsWith("torch "))).toBe(false);
    expect(segments.some((s) => s.startsWith("python "))).toBe(false);
    expect(segments.some((s) => s.startsWith("Triton:"))).toBe(false);
    expect(segments.some((s) => s.startsWith("SageAttention:"))).toBe(false);
    // No double separators or trailing junk.
    expect(out).not.toContain("··");
    expect(out).not.toContain(" · .");
  });

  it("treats triton/sageattention 'unknown' as omitted", () => {
    const out = formatEnvBlock({
      os: "Windows 11",
      triton: "unknown",
      sageattention: "unknown",
    });
    // The field labels ("Triton: …" / "SageAttention: …") must be absent — the
    // guidance tail's "Triton/SageAttention" mention is fine.
    expect(out).not.toContain("Triton:");
    expect(out).not.toContain("SageAttention:");
  });

  it("renders only the known build version, and omits the segment when neither is set", () => {
    expect(formatEnvBlock({ os: "Linux", mcpVersion: "0.48.4" })).toContain("comfyui-mcp 0.48.4");
    expect(formatEnvBlock({ os: "Linux", mcpVersion: "0.48.4" })).not.toContain("panel ");
    expect(formatEnvBlock({ os: "Linux", panelVersion: "nightly" })).toContain("panel nightly");
    // Neither version → no version segment at all (no stray separators).
    const bare = formatEnvBlock({ os: "Linux" });
    expect(bare).not.toContain("comfyui-mcp ");
    expect(bare).not.toContain("panel ");
  });

  it("renders ComfyUI location even when the version is unknown", () => {
    const out = formatEnvBlock({ location: "LOCAL" });
    expect(out).toContain("ComfyUI (LOCAL)");
    expect(out).not.toContain("ComfyUI ? ");
  });

  it("returns an empty string when nothing is known", () => {
    expect(formatEnvBlock({})).toBe("");
  });
});

describe("resolveBackends (#358 — report the ACTUAL backend, never a wrong specific)", () => {
  it("labels non-Claude backends by their real identity, not 'Claude'", () => {
    // The regression: a Grok turn was reported as "Backend: Claude". Every known
    // backend id must map to its own label.
    expect(resolveBackends("grok").backend).toBe("Grok");
    expect(resolveBackends("codex").backend).toBe("Codex");
    expect(resolveBackends("gemini").backend).toBe("Gemini");
    expect(resolveBackends("ollama").backend).toBe("Ollama");
    expect(resolveBackends("copilot").backend).toBe("Copilot");
    expect(resolveBackends("minimax").backend).toBe("MiniMax");
    expect(resolveBackends("claude").backend).toBe("Claude");
    // Case-insensitive.
    expect(resolveBackends("GROK").backend).toBe("Grok");
  });

  it("degrades an unrecognized id to 'unknown' rather than mislabeling it Claude", () => {
    expect(resolveBackends("some-future-provider").backend).toBe("unknown");
    expect(resolveBackends("").backend).toBe("unknown");
  });

  it("degrades prototype-key ids to 'unknown' (no inherited-property leak)", () => {
    // A plain object index would resolve these to Object.prototype members
    // (a function/object) rather than "unknown".
    for (const id of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      expect(resolveBackends(id).backend).toBe("unknown");
    }
  });

  it("the rendered Backend line reflects the real provider for the turn", () => {
    const grok = resolveBackends("grok");
    const out = formatEnvBlock({ backend: grok.backend, otherBackendAvailable: grok.otherBackendAvailable });
    expect(out).toContain("Backend: Grok");
    expect(out).not.toContain("Backend: Claude");
  });
});

describe("applyStats", () => {
  it("derives torch, CUDA line, GPU and VRAM from a /system_stats payload", () => {
    const caps: EnvCapabilities = {};
    applyStats(caps, {
      system: {
        os: "nt",
        python_version: "3.13.12 (main)",
        comfyui_version: "0.26.1",
        pytorch_version: "2.10.0+cu130",
      },
      devices: [
        {
          name: "cuda:0 NVIDIA GeForce RTX 4090",
          type: "cuda",
          vram_total: 24 * 1024 * 1024 * 1024,
          vram_free: 20 * 1024 * 1024 * 1024,
        },
      ],
    });
    expect(caps.python).toBe("3.13");
    expect(caps.comfyui).toBe("0.26.1");
    expect(caps.torch).toBe("2.10.0");
    expect(caps.cuda).toBe("13.0");
    expect(caps.gpu).toBe("NVIDIA GeForce RTX 4090");
    expect(caps.vramTotalGb).toBe(24);
    expect(caps.vramFreeGb).toBe(20);
    // "nt" normalizes to a friendly OS rather than passing through literally.
    expect(caps.os).not.toBe("nt");
  });

  it("tidies ComfyUI's verbose device name to just the model", () => {
    const caps: EnvCapabilities = {};
    applyStats(caps, {
      devices: [
        {
          name: "cuda:0 NVIDIA GeForce RTX 4090 : cudaMallocAsync",
          type: "cuda",
          vram_total: 24 * 1024 ** 3,
        },
      ],
    });
    expect(caps.gpu).toBe("NVIDIA GeForce RTX 4090");
  });

  it("derives the cu128 line correctly", () => {
    const caps: EnvCapabilities = {};
    applyStats(caps, { system: { pytorch_version: "2.9.1+cu128" } });
    expect(caps.cuda).toBe("12.8");
    expect(caps.torch).toBe("2.9.1");
  });

  it("prefers a non-CPU device for GPU fields", () => {
    const caps: EnvCapabilities = {};
    applyStats(caps, {
      devices: [
        { name: "cpu", type: "cpu", vram_total: 0 },
        { name: "NVIDIA RTX 4090", type: "cuda", vram_total: 24 * 1024 ** 3 },
      ],
    });
    expect(caps.gpu).toBe("NVIDIA RTX 4090");
    expect(caps.vramTotalGb).toBe(24);
  });
});

describe("resolveComfyuiPython (#401)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "comfyui-py-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns the on-disk venv interpreter as VERIFIED", async () => {
    const venvBin = IS_WIN ? join(dir, ".venv", "Scripts") : join(dir, ".venv", "bin");
    await mkdir(venvBin, { recursive: true });
    const exe = join(venvBin, IS_WIN ? "python.exe" : "python3");
    await writeFile(exe, "", "utf-8");

    const res = resolveComfyuiPython(dir, undefined);
    expect(res.verified).toBe(true);
    expect(res.python).toBe(exe);
    // No argv → this is NOT the live interpreter (just the pinned workspace's venv).
    expect(res.live).toBe(false);
  });

  it("finds the embedded python of a portable install as VERIFIED (not just .venv)", async () => {
    if (!IS_WIN) return; // python_embeded is a Windows-portable layout
    const embedded = join(dir, "python_embeded");
    await mkdir(embedded, { recursive: true });
    const exe = join(embedded, "python.exe");
    await writeFile(exe, "", "utf-8");

    const res = resolveComfyuiPython(dir, undefined);
    expect(res.verified).toBe(true);
    expect(res.python).toBe(exe);
  });

  it("falls back to a bare PATH name as UNVERIFIED when no venv exists", () => {
    // A directory with no interpreter under it — the wrong-python scenario.
    const res = resolveComfyuiPython(dir, undefined);
    expect(res.verified).toBe(false);
    expect(res.live).toBe(false);
    expect(res.python).toBe(IS_WIN ? "python.exe" : "python3");
  });

  it("prefers the LIVE running instance's argv root over a pinned/saved workspace (PR #433 review)", async () => {
    // Both installs exist with a venv on the same Python major.minor, but only the
    // LIVE server (root B, from argv main.py) has the package. If we resolved the
    // pinned/saved root A first, A's negative would survive as a false 'not-installed'
    // AND process-control could relaunch B's main.py with A's python. The live argv
    // root must win.
    const mkVenv = async (root: string): Promise<string> => {
      const bin = IS_WIN ? join(root, ".venv", "Scripts") : join(root, ".venv", "bin");
      await mkdir(bin, { recursive: true });
      const exe = join(bin, IS_WIN ? "python.exe" : "python3");
      await writeFile(exe, "", "utf-8");
      return exe;
    };
    const rootA = join(dir, "A"); // pinned COMFYUI_PATH / saved default
    const rootB = join(dir, "B"); // the LIVE running server
    await mkVenv(rootA);
    const exeB = await mkVenv(rootB);

    const res = resolveComfyuiPython(rootA, [
      IS_WIN ? "python.exe" : "python3",
      join(rootB, "main.py"),
    ]);
    expect(res.verified).toBe(true);
    expect(res.live).toBe(true);
    expect(res.liveRoot).toBe(rootB);
    expect(res.python).toBe(exeB); // B, not A
  });

  it("marks the pinned workspace UNTRUSTED (live:false) when the LIVE root has no on-disk venv", async () => {
    // Live root B (from argv) has no interpreter on disk; only pinned A does. A must
    // NOT be reported as the live interpreter — its negative would be a false report.
    const binA = IS_WIN ? join(dir, "A", ".venv", "Scripts") : join(dir, "A", ".venv", "bin");
    await mkdir(binA, { recursive: true });
    const exeA = join(binA, IS_WIN ? "python.exe" : "python3");
    await writeFile(exeA, "", "utf-8");
    const rootB = join(dir, "B"); // live root, but no venv created under it

    const res = resolveComfyuiPython(join(dir, "A"), [join(rootB, "main.py")]);
    expect(res.python).toBe(exeA); // A is the only interpreter we can probe …
    expect(res.verified).toBe(true);
    expect(res.live).toBe(false); // … but it is NOT the live interpreter
    expect(res.liveRoot).toBe(rootB); // live root was resolvable, just not populated
  });

  // -- ComfyUI Desktop: RELATIVE argv main.py, no cwd (#401 recurrence) --------
  //
  // Desktop reports argv[0] = "ComfyUI\\main.py" with no cwd, so the live root is
  // UNRESOLVED and resolution used to fall back to COMFYUI_PATH (the bundle root),
  // picking the launcher's standalone-env python — an environment the running server
  // never imports from. Anchoring the relative dir on the base fixes the selection.
  const mkVenvAt = async (root: string): Promise<string> => {
    const bin = IS_WIN ? join(root, ".venv", "Scripts") : join(root, ".venv", "bin");
    await mkdir(bin, { recursive: true });
    const exe = join(bin, IS_WIN ? "python.exe" : "python3");
    await writeFile(exe, "", "utf-8");
    return exe;
  };

  it("anchors a RELATIVE argv main.py on the configured base and picks the SERVER's venv", async () => {
    const base = join(dir, "Desktop"); // COMFYUI_PATH — the bundle root
    const server = join(base, "ComfyUI"); // where main.py + the server venv live
    await mkdir(server, { recursive: true });
    await writeFile(join(server, "main.py"), "", "utf-8");
    const wrong = await mkVenvAt(base); // the launcher's env (must NOT win)
    const right = await mkVenvAt(server);

    const res = resolveComfyuiPython(base, [IS_WIN ? "ComfyUI\\main.py" : "ComfyUI/main.py"]);
    expect(res.python).toBe(right);
    expect(res.python).not.toBe(wrong);
    expect(res.live).toBe(true);
    expect(res.anchored).toBe(true); // inferred, not read straight off argv
    expect(res.proven).toBe(false); // …so its negatives are never authoritative
    expect(res.liveRoot).toBe(server);
  });

  it("marks a live root holding SEVERAL environments as ambiguous, not proven", async () => {
    // `.venv` and `venv` side by side: both are plausible, nothing says which ComfyUI
    // runs. We still probe one, but it must not be able to say "not installed".
    const root = join(dir, "twoenvs");
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "main.py"), "", "utf-8");
    await mkVenvAt(root);
    const otherBin = IS_WIN ? join(root, "venv", "Scripts") : join(root, "venv", "bin");
    await mkdir(otherBin, { recursive: true });
    await writeFile(join(otherBin, IS_WIN ? "python.exe" : "python3"), "", "utf-8");

    const res = resolveComfyuiPython(undefined, [join(root, "main.py")]);
    expect(res.live).toBe(true); // the ROOT is certain …
    expect(res.ambiguous).toBe(true); // … the interpreter under it is not
    expect(res.proven).toBe(false);
  });

  it("treats a standalone-env beside a .venv as ambiguous (embedded_python can't split them)", async () => {
    if (!IS_WIN) return; // standalone-env is a Windows bundle layout
    const root = join(dir, "stand");
    await mkdir(join(root, "standalone-env"), { recursive: true });
    await writeFile(join(root, "main.py"), "", "utf-8");
    await writeFile(join(root, "standalone-env", "python.exe"), "", "utf-8");
    await mkVenvAt(root);

    // embedded_python:false rules out `python_embeded` but says nothing about
    // .venv vs standalone-env — so this stays ambiguous, never proven.
    const res = resolveComfyuiPython(undefined, [join(root, "main.py")], {
      embeddedPython: false,
    });
    expect(res.ambiguous).toBe(true);
    expect(res.proven).toBe(false);
  });

  it("is PROVEN when the server's own argv root holds exactly one interpreter", async () => {
    const root = join(dir, "single");
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "main.py"), "", "utf-8");
    const exe = await mkVenvAt(root);

    const res = resolveComfyuiPython(undefined, [join(root, "main.py")], {
      embeddedPython: false,
    });
    expect(res.python).toBe(exe);
    expect(res.proven).toBe(true);
    expect(res.ambiguous).toBe(false);
  });

  it("prefers a nested ComfyUI/ server root over the bundle root even without argv", async () => {
    const base = join(dir, "Bundle");
    const server = join(base, "ComfyUI");
    await mkdir(server, { recursive: true });
    await writeFile(join(server, "main.py"), "", "utf-8");
    await mkVenvAt(base);
    const right = await mkVenvAt(server);

    const res = resolveComfyuiPython(base, undefined);
    expect(res.python).toBe(right);
    expect(res.verified).toBe(true);
    expect(res.live).toBe(false); // no argv → nothing proves it is the live one
    expect(res.anchored).toBe(false);
  });

  it("never lets a nested ComfyUI/ tree outrank a root that is itself the server root", async () => {
    // The live argv root X has its own main.py; a stray X/ComfyUI checkout also has one.
    // X's interpreter must win — X is exactly what the running server told us.
    const rootX = join(dir, "X");
    await mkdir(join(rootX, "ComfyUI"), { recursive: true });
    await writeFile(join(rootX, "main.py"), "", "utf-8");
    await writeFile(join(rootX, "ComfyUI", "main.py"), "", "utf-8");
    const exeX = await mkVenvAt(rootX);
    await mkVenvAt(join(rootX, "ComfyUI"));

    const res = resolveComfyuiPython(undefined, [join(rootX, "main.py")]);
    expect(res.python).toBe(exeX);
    expect(res.live).toBe(true);
    expect(res.anchored).toBe(false);
  });

  it("uses the server's embedded_python self-report to break a venv/python_embeded tie", async () => {
    if (!IS_WIN) return; // python_embeded is a Windows-portable layout
    const bundle = join(dir, "portable");
    const server = join(bundle, "ComfyUI");
    await mkdir(server, { recursive: true });
    await writeFile(join(server, "main.py"), "", "utf-8");
    const venvExe = await mkVenvAt(server);
    const embDir = join(bundle, "python_embeded");
    await mkdir(embDir, { recursive: true });
    const embExe = join(embDir, "python.exe");
    await writeFile(embExe, "", "utf-8");
    const argv = [join(server, "main.py")];

    // The server says it runs an embedded python → the bundle's python_embeded wins.
    expect(resolveComfyuiPython(bundle, argv, { embeddedPython: true }).python).toBe(embExe);
    // It says it does NOT → the install's own .venv wins.
    expect(resolveComfyuiPython(bundle, argv, { embeddedPython: false }).python).toBe(venvExe);
  });

  it("drops the live claim when the embedded_python hint matches NO candidate we can see", async () => {
    const root = join(dir, "onlyvenv");
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "main.py"), "", "utf-8");
    const venvExe = await mkVenvAt(root);

    // The server runs a python_embeded we cannot find — so this .venv is provably NOT
    // its interpreter and must never be reported as live (its negatives are worthless).
    const res = resolveComfyuiPython(root, [join(root, "main.py")], { embeddedPython: true });
    expect(res.python).toBe(venvExe);
    expect(res.live).toBe(false);
    expect(res.anchored).toBe(false);
    expect(res.proven).toBe(false);
  });

  it("refuses to anchor when the relative argv dir has no main.py on disk", async () => {
    const base = join(dir, "Plain");
    await mkdir(join(base, "ComfyUI"), { recursive: true }); // dir exists but NO main.py
    const baseExe = await mkVenvAt(base);

    const res = resolveComfyuiPython(base, [IS_WIN ? "ComfyUI\\main.py" : "ComfyUI/main.py"]);
    expect(res.python).toBe(baseExe); // the only interpreter we can see …
    expect(res.live).toBe(false); // … and it is NOT provably the server's
    expect(res.anchored).toBe(false);
    expect(res.liveRoot).toBeUndefined();
  });
});

describe("reconcileProbeState (#401 — no false 'not installed')", () => {
  it("keeps 'not-installed' only when the interpreter is PROVEN and versions match", () => {
    expect(
      reconcileProbeState("not-installed", {
        proven: true,
        runningPython: "3.12",
        probePython: "3.12",
      }),
    ).toBe("not-installed");
  });

  it("degrades 'not-installed' to 'unknown' when the interpreter is NOT the live one", () => {
    expect(
      reconcileProbeState("not-installed", {
        proven: false,
        runningPython: "3.12",
        probePython: "3.12",
      }),
    ).toBe("unknown");
  });

  it("degrades 'not-installed' to 'unknown' when probe python DISAGREES with the running instance", () => {
    // The exact issue: running ComfyUI is 3.12, but we probed a 3.11 python.
    expect(
      reconcileProbeState("not-installed", {
        proven: true,
        runningPython: "3.12",
        probePython: "3.11",
      }),
    ).toBe("unknown");
  });

  it("passes a positive 'installed' through untouched even from an untrusted interpreter", () => {
    expect(
      reconcileProbeState("installed", { proven: false, runningPython: "3.12", probePython: "3.11" }),
    ).toBe("installed");
  });

  it("treats undefined as 'unknown'", () => {
    expect(reconcileProbeState(undefined, { proven: true })).toBe("unknown");
  });

  it("never emits a definitive negative from an UNPROVEN interpreter (anchored/ambiguous)", () => {
    // `proven:false` covers a bare PATH fallback, a different workspace, an INFERRED
    // (anchored) root and an AMBIGUOUS one. None of them may claim "not installed" —
    // even when the python versions agree, since sibling envs usually share a version.
    for (const probePython of ["3.13", undefined]) {
      expect(
        reconcileProbeState("not-installed", {
          proven: false,
          runningPython: "3.13",
          probePython,
        }),
      ).toBe("unknown");
    }
    // A positive still passes through — it can never be a harmful false negative.
    expect(
      reconcileProbeState("installed", { proven: false, runningPython: "3.13" }),
    ).toBe("installed");
  });
});

describe("buildPanelSystemAppend", () => {
  const STATIC = "STATIC PROMPT BODY";

  it("prepends the env block above the static prompt", () => {
    const out = buildPanelSystemAppend(STATIC, {
      os: "Windows 11",
      backend: "Claude",
      otherBackendAvailable: true,
    });
    expect(out.startsWith("ENVIRONMENT (live, this machine):")).toBe(true);
    expect(out).toContain(STATIC);
    // env block comes first, static prompt after.
    expect(out.indexOf("ENVIRONMENT")).toBeLessThan(out.indexOf(STATIC));
  });

  it("returns the static prompt unchanged when caps is undefined", () => {
    expect(buildPanelSystemAppend(STATIC, undefined)).toBe(STATIC);
  });

  it("returns the static prompt unchanged when the env block is empty", () => {
    expect(buildPanelSystemAppend(STATIC, {})).toBe(STATIC);
  });
});

describe("readInstalledPanelVersion (disk fallback)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cmcp-panelver-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // Write a pyproject.toml under a specific custom_nodes subdir.
  async function writePanel(dirName: string, body: string) {
    const d = join(dir, "custom_nodes", dirName);
    await mkdir(d, { recursive: true });
    await writeFile(join(d, "pyproject.toml"), body, "utf8");
  }

  it("reads the panel's [project].version (authoritative by [project].name)", async () => {
    await writePanel(
      "comfyui-mcp-panel",
      `[project]\nname = "comfyui-agent-panel"\nversion = "0.11.20"\n`,
    );
    expect(readInstalledPanelVersion(dir)).toBe("0.11.20");
  });

  it("mirrors the shipped parsePyproject reader (single-line description, then version)", async () => {
    // Shape mirrors the real panel pyproject.toml (long single-line description).
    await writePanel(
      "comfyui-mcp-panel",
      `[project]\n` +
        `name = "comfyui-agent-panel"\n` +
        `description = "Autonomous AI agent in the ComfyUI sidebar - drive the canvas, browse CivitAI, generate."\n` +
        `version = "0.11.20"\n` +
        `license = { file = "LICENSE" }\n` +
        `[tool.comfy]\nPublisherId = "artokun"\n`,
    );
    expect(readInstalledPanelVersion(dir)).toBe("0.11.20");
  });

  it("finds the panel under the alternate registry dir name", async () => {
    await writePanel(
      "comfyui-agent-panel",
      `[project]\nname = "comfyui-agent-panel"\nversion = "0.12.0"\n`,
    );
    expect(readInstalledPanelVersion(dir)).toBe("0.12.0");
  });

  it("returns undefined for a non-panel pyproject squatting a known dir (wrong project name)", async () => {
    // Authoritative guard: only [project].name == comfyui-agent-panel is trusted,
    // so a different node at the same dir name never yields a WRONG version.
    await writePanel(
      "comfyui-mcp-panel",
      `[project]\nname = "some-other-node"\nversion = "9.9.9"\n`,
    );
    expect(readInstalledPanelVersion(dir)).toBeUndefined();
  });

  it("returns undefined when the panel pyproject declares no version", async () => {
    await writePanel("comfyui-mcp-panel", `[project]\nname = "comfyui-agent-panel"\n`);
    expect(readInstalledPanelVersion(dir)).toBeUndefined();
  });

  it("returns undefined when the file/dir is missing or comfyuiPath is undefined", () => {
    expect(readInstalledPanelVersion(undefined)).toBeUndefined();
    expect(readInstalledPanelVersion(join(dir, "does-not-exist"))).toBeUndefined();
    // custom_nodes exists but the panel is not installed.
    expect(readInstalledPanelVersion(dir)).toBeUndefined();
  });
});
