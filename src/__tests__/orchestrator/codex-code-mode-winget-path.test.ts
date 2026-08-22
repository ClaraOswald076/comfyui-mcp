// #2045 — WinGet's versioned Node dir (`node-vX.Y.Z-win-x64`) is deleted on
// update while a live Codex app-server still points at
// `...\codex-code-mode-host.exe` there. These tests drive the shipped path
// helpers: resolve the host from the active package, skip a gone WinGet path,
// and keep a stable copy when the dest is locked.

import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  codeModeHostPathFromError,
  ensureStableCodexVendor,
  isVolatileCodexPackagePath,
  resolveCodexCodeModeHostPath,
  resolveCodexLaunchBin,
} from "../../orchestrator/codex-backend.js";

const WINGET_HOST =
  "C:\\Users\\x\\AppData\\Local\\Microsoft\\WinGet\\Packages\\OpenJS.NodeJS.LTS_8wekyb3d8bbwe\\node-v24.19.0-win-x64\\node_modules\\comfyui-mcp\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex-code-mode-host.exe";

const NVM_HOST =
  "C:\\Users\\x\\AppData\\Roaming\\nvm\\v22.22.3\\node_modules\\comfyui-mcp\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex-code-mode-host.exe";

describe("codeModeHostPathFromError (#2045)", () => {
  it("pulls the executable path out of the reporter's spawn error", () => {
    const message =
      `failed to spawn code-mode host ${WINGET_HOST}: The system cannot find the path specified. (os error 3)`;
    expect(codeModeHostPathFromError(message)).toBe(WINGET_HOST);
  });
});

describe("isVolatileCodexPackagePath (#2045)", () => {
  it("matches the reporter's WinGet node-v* package dir", () => {
    expect(isVolatileCodexPackagePath(WINGET_HOST)).toBe(true);
  });

  it("matches the #1929 nvm-windows package dir", () => {
    expect(isVolatileCodexPackagePath(NVM_HOST)).toBe(true);
  });

  it("does not match a stable user-data vendor copy", () => {
    expect(isVolatileCodexPackagePath("C:\\Users\\x\\.comfyui-mcp\\codex-vendor\\codex.exe")).toBe(
      false,
    );
  });
});

describe("resolveCodexCodeModeHostPath (#2045)", () => {
  it("returns the host next to the active platform package", () => {
    const pkgJson =
      "C:\\app\\node_modules\\@openai\\codex-win32-x64\\package.json";
    const host = resolveCodexCodeModeHostPath({
      platform: "win32",
      arch: "x64",
      resolve: (id) => {
        expect(id).toBe("@openai/codex-win32-x64/package.json");
        return pkgJson;
      },
      existsSync: (p) => p.endsWith("codex-code-mode-host.exe"),
    });
    expect(host).toBe(
      path.join(
        path.dirname(pkgJson),
        "vendor",
        "x86_64-pc-windows-msvc",
        "bin",
        "codex-code-mode-host.exe",
      ),
    );
  });

  it("returns null when the WinGet package path is gone", () => {
    const host = resolveCodexCodeModeHostPath({
      platform: "win32",
      arch: "x64",
      resolve: () =>
        path.join(
          path.dirname(WINGET_HOST),
          "..",
          "..",
          "..",
          "package.json",
        ),
      existsSync: () => false,
    });
    expect(host).toBeNull();
  });
});

describe("ensureStableCodexVendor (#2045)", () => {
  const destDir = "C:\\stable-vendor";
  const destHost = path.join(destDir, "codex-code-mode-host.exe");
  const destExe = path.join(destDir, "codex.exe");
  const srcExe = path.join(path.dirname(WINGET_HOST), "codex.exe");

  it("copies the vendor pair out of a live WinGet dir", () => {
    const present = new Set([WINGET_HOST, srcExe]);
    const copied: Array<[string, string]> = [];
    const host = ensureStableCodexVendor(WINGET_HOST, {
      destDir,
      existsSync: (p) => present.has(p),
      mkdirSync: () => undefined,
      copyFileSync: (src, dest) => {
        copied.push([src, dest]);
        present.add(dest);
      },
    });
    expect(host).toBe(destHost);
    expect(copied).toEqual([
      [srcExe, destExe],
      [WINGET_HOST, destHost],
    ]);
  });

  it("reuses the stable host when the WinGet src path is gone", () => {
    const present = new Set([destHost, destExe]);
    const host = ensureStableCodexVendor(WINGET_HOST, {
      destDir,
      existsSync: (p) => present.has(p),
      mkdirSync: () => {
        throw new Error("should not mkdir");
      },
      copyFileSync: () => {
        throw new Error("should not copy");
      },
    });
    expect(host).toBe(destHost);
  });

  it("keeps the dest copy when replacement hits a sharing violation", () => {
    const present = new Set([WINGET_HOST, srcExe, destHost, destExe]);
    const host = ensureStableCodexVendor(WINGET_HOST, {
      destDir,
      existsSync: (p) => present.has(p),
      mkdirSync: () => undefined,
      copyFileSync: () => {
        const err = new Error(
          "The process cannot access the file because it is being used by another process. (os error 32)",
        );
        throw err;
      },
    });
    expect(host).toBe(destHost);
  });
});

describe("resolveCodexLaunchBin (#2045)", () => {
  it("spawns the stable vendor exe for a volatile WinGet host", () => {
    const destDir = "C:\\stable-vendor";
    const destHost = path.join(destDir, "codex-code-mode-host.exe");
    const destExe = path.join(destDir, "codex.exe");
    const bin = resolveCodexLaunchBin({
      resolveHost: () => WINGET_HOST,
      existsSync: (p) => p === destExe || p === destHost || p === WINGET_HOST,
      ensureStable: () => destHost,
      resolveJs: () => {
        throw new Error("JS launcher must not be used for a volatile host");
      },
    });
    expect(bin).toBe(destExe);
  });

  it("falls through to the JS launcher when the host is not a volatile path", () => {
    const js = "C:\\app\\node_modules\\@openai\\codex\\bin\\codex.js";
    const bin = resolveCodexLaunchBin({
      resolveHost: () =>
        "C:\\app\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex-code-mode-host.exe",
      existsSync: (p) => p === js,
      resolveJs: () => js,
      ensureStable: () => {
        throw new Error("must not copy a non-volatile package");
      },
    });
    expect(bin).toBe(js);
  });
});
