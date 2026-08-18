import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapToolkit, resolveGitExecutable } from "../../services/trainer-bootstrap.js";

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "trainer-bootstrap-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("resolveGitExecutable", () => {
  it("finds git on PATH (win32 name)", () => {
    const bin = tempDir();
    const exe = join(bin, "git.exe");
    writeFileSync(exe, "");
    expect(resolveGitExecutable({ PATH: bin }, "win32")).toBe(exe);
  });

  it("finds git on PATH (posix name)", () => {
    const bin = tempDir();
    const exe = join(bin, "git");
    writeFileSync(exe, "");
    expect(resolveGitExecutable({ PATH: bin }, "linux")).toBe(exe);
  });

  it("strips quotes around PATH entries", () => {
    const bin = tempDir();
    const exe = join(bin, "git.exe");
    writeFileSync(exe, "");
    expect(resolveGitExecutable({ PATH: `"${bin}"` }, "win32")).toBe(exe);
  });

  it("falls back to %ProgramFiles%\\Git when PATH has no git (issue #1640)", () => {
    const programFiles = tempDir();
    const exe = join(programFiles, "Git", "cmd", "git.exe");
    mkdirSync(join(programFiles, "Git", "cmd"), { recursive: true });
    writeFileSync(exe, "");
    expect(resolveGitExecutable({ PATH: "", ProgramFiles: programFiles }, "win32")).toBe(exe);
  });

  it("falls back to %LOCALAPPDATA%\\Programs\\Git (user install)", () => {
    const localAppData = tempDir();
    const exe = join(localAppData, "Programs", "Git", "cmd", "git.exe");
    mkdirSync(join(localAppData, "Programs", "Git", "cmd"), { recursive: true });
    writeFileSync(exe, "");
    expect(
      resolveGitExecutable(
        { PATH: "", ProgramFiles: tempDir(), "ProgramFiles(x86)": tempDir(), LOCALAPPDATA: localAppData },
        "win32",
      ),
    ).toBe(exe);
  });

  it("prefers PATH over the install-root fallback", () => {
    const bin = tempDir();
    const onPath = join(bin, "git.exe");
    writeFileSync(onPath, "");
    const programFiles = tempDir();
    mkdirSync(join(programFiles, "Git", "cmd"), { recursive: true });
    writeFileSync(join(programFiles, "Git", "cmd", "git.exe"), "");
    expect(resolveGitExecutable({ PATH: bin, ProgramFiles: programFiles }, "win32")).toBe(onPath);
  });

  it("returns undefined on Windows when neither PATH nor the standard roots have git", () => {
    expect(
      resolveGitExecutable(
        { PATH: "", ProgramFiles: tempDir(), "ProgramFiles(x86)": tempDir(), LOCALAPPDATA: tempDir() },
        "win32",
      ),
    ).toBeUndefined();
  });

  it("never consults the Windows install roots on other platforms", () => {
    const programFiles = tempDir();
    mkdirSync(join(programFiles, "Git", "cmd"), { recursive: true });
    writeFileSync(join(programFiles, "Git", "cmd", "git.exe"), "");
    expect(resolveGitExecutable({ PATH: "", ProgramFiles: programFiles }, "linux")).toBeUndefined();
  });
});

describe("bootstrapToolkit git preflight (issue #1640)", () => {
  const saved: Record<string, string | undefined> = {};
  const KEYS = ["PATH", "ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA", "COMFYUI_MCP_DATA_DIR"] as const;

  afterEach(() => {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
      delete saved[key];
    }
  });

  it("fails closed with git_not_found and the restart remedy when git is unfindable", async () => {
    for (const key of KEYS) saved[key] = process.env[key];
    // An empty PATH with no git anywhere + install roots pointed at empty temp
    // dirs: the exact world the issue's orchestrator lives in — Git installed
    // after startup, so the inherited PATH cannot see it.
    process.env.PATH = tempDir();
    process.env["ProgramFiles"] = tempDir();
    process.env["ProgramFiles(x86)"] = tempDir();
    process.env["LOCALAPPDATA"] = tempDir();
    process.env.COMFYUI_MCP_DATA_DIR = tempDir();

    const result = await bootstrapToolkit();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error?.code).toBe("git_not_found");
    if (process.platform === "win32") {
      expect(result.error?.message).toContain("restart the orchestrator");
      expect(result.error?.message).toContain("panel_reload is not enough");
    } else {
      expect(result.error?.message).toContain("restart");
    }
  });
});
