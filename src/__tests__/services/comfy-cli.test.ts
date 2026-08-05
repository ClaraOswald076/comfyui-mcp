import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Keep config.comfyuiPath deterministically unset so the saved-default-workspace
// resolution path (#506/#403) is what's under test, not any real auto-detected
// install on the host running the suite.
const cfg = vi.hoisted(() => ({
  comfyuiPath: undefined as string | undefined,
  remote: false,
}));
vi.mock("../../config.js", () => ({ config: cfg, isRemoteMode: () => cfg.remote }));

// The version probe SPAWNS a local `comfy`. A stub executable fails to spawn
// either way, so asserting on its return value cannot tell a guarded probe from
// an unguarded one — the observable difference is whether the process is
// launched at all.
const spawnSpy = vi.hoisted(() => ({ sync: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawnSync: (...args: unknown[]) => {
      spawnSpy.sync(...args);
      return (actual.spawnSync as (...a: unknown[]) => unknown)(...args);
    },
  };
});

// Control the saved default workspace resolveEffectiveComfyUIBase() returns.
const wsMock = vi.hoisted(() => ({ base: undefined as string | undefined }));
vi.mock("../../services/workspace-env.js", () => ({
  resolveEffectiveComfyUIBase: () => wsMock.base,
}));

import {
  assertComfyCliOk,
  getComfyCliVersion,
  awaitProcessWithIdleTimeout,
  isSupportedComfyCliVersion,
  normalizeComfyCliResult,
  parseComfyCliEnvelope,
  resolveComfyCliExecutable,
  runComfyCliSync,
  shouldUseComfyCli,
} from "../../services/comfy-cli.js";

const originalCliPath = process.env.COMFY_CLI_PATH;
const tempDirs: string[] = [];

afterEach(() => {
  if (originalCliPath === undefined) delete process.env.COMFY_CLI_PATH;
  else process.env.COMFY_CLI_PATH = originalCliPath;
  wsMock.base = undefined;
  cfg.comfyuiPath = undefined;
  cfg.remote = false;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("comfy-cli adapter", () => {
  it("parses the final envelope after NDJSON events", () => {
    const envelope = parseComfyCliEnvelope<{ jobs: number }>(
      '{"schema":"event/1","type":"progress"}\n' +
        '{"schema":"envelope/1","type":"envelope","ok":true,"command":"jobs ls","version":"1.11.1","where":"local","data":{"jobs":2},"error":null}\n',
    );
    expect(envelope.ok).toBe(true);
    expect(envelope.version).toBe("1.11.1");
    expect(envelope.data).toEqual({ jobs: 2 });
  });

  it("rejects non-envelope JSON", () => {
    expect(() => parseComfyCliEnvelope('{"ok":"yes"}')).toThrow(/envelope\/1/);
  });

  it("surfaces structured CLI errors", () => {
    const envelope = parseComfyCliEnvelope(
      '{"schema":"envelope/1","type":"envelope","ok":false,"command":"validate","version":"1.11.1","where":"local","data":null,"error":{"code":"workflow_invalid_json","message":"bad JSON","hint":"re-export"}}',
    );
    expect(() => assertComfyCliOk(envelope)).toThrow(/workflow_invalid_json: bad JSON \(re-export\)/);
  });

  it("honors COMFY_CLI_PATH", () => {
    const dir = mkdtempSync(join(tmpdir(), "comfy-cli-test-"));
    tempDirs.push(dir);
    const executable = join(dir, process.platform === "win32" ? "comfy.exe" : "comfy");
    writeFileSync(executable, "");
    process.env.COMFY_CLI_PATH = executable;
    expect(resolveComfyCliExecutable()).toBe(executable);
  });

  it("resolves the workspace-venv comfy-cli from the saved default workspace when COMFYUI_PATH is unset (#506/#403)", () => {
    delete process.env.COMFY_CLI_PATH;
    const workspace = mkdtempSync(join(tmpdir(), "comfy-cli-ws-"));
    tempDirs.push(workspace);
    const binDir = join(workspace, ".venv", process.platform === "win32" ? "Scripts" : "bin");
    mkdirSync(binDir, { recursive: true });
    const executable = join(binDir, process.platform === "win32" ? "comfy.exe" : "comfy");
    writeFileSync(executable, "");
    // No explicit workspace passed and COMFYUI_PATH unset — resolution must fall
    // through to the saved default workspace's venv rather than only scanning PATH.
    wsMock.base = workspace;
    expect(resolveComfyCliExecutable()).toBe(executable);
  });

  it("does NOT reach past the target resolver to COMFYUI_PATH when it declines (#490)", () => {
    // The #490 shape. `defaultWorkspace()` read `config.comfyuiPath ??
    // resolveEffectiveComfyUIBase()`, so a set COMFYUI_PATH short-circuited the resolver
    // entirely — meaning fixing the resolver could not fix this call site. In a remote
    // session the resolver declines, and this module runs `comfy-cli uninstall` and
    // `comfy-cli disable`: reaching past it targeted an unrelated LOCAL install while
    // the reply described only the remote server.
    delete process.env.COMFY_CLI_PATH;
    const localInstall = mkdtempSync(join(tmpdir(), "comfy-cli-local-"));
    tempDirs.push(localInstall);
    const binDir = join(localInstall, ".venv", process.platform === "win32" ? "Scripts" : "bin");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, process.platform === "win32" ? "comfy.exe" : "comfy"), "");

    cfg.comfyuiPath = localInstall; // a stale local COMFYUI_PATH…
    wsMock.base = undefined; // …and a resolver that says "not a local target"

    // It must not pick up that install's venv comfy. (PATH may still hold a system
    // comfy-cli — what matters is that the LOCAL INSTALL's binary is never chosen.)
    expect(resolveComfyCliExecutable()).not.toBe(
      join(binDir, process.platform === "win32" ? "comfy.exe" : "comfy"),
    );
  });

  it("still uses COMFYUI_PATH's venv when the resolver DOES name it", () => {
    // The other direction: the fix must not make a normal local session stop finding
    // its own comfy-cli. An over-strict refusal here would be its own bug.
    delete process.env.COMFY_CLI_PATH;
    const localInstall = mkdtempSync(join(tmpdir(), "comfy-cli-local-ok-"));
    tempDirs.push(localInstall);
    const binDir = join(localInstall, ".venv", process.platform === "win32" ? "Scripts" : "bin");
    mkdirSync(binDir, { recursive: true });
    const executable = join(binDir, process.platform === "win32" ? "comfy.exe" : "comfy");
    writeFileSync(executable, "");

    cfg.comfyuiPath = localInstall;
    wsMock.base = localInstall; // a local session: the resolver names the same install

    expect(resolveComfyCliExecutable()).toBe(executable);
  });

  it("normalizes successful legacy plain-text commands", () => {
    const result = normalizeComfyCliResult(
      ["stop"],
      { workspace: "/ws" },
      { stdout: "No ComfyUI is running in the background.\n", stderr: "", exitCode: 0 },
      "1.11.1",
    );
    expect(result).toMatchObject({
      schema: "envelope/1",
      type: "envelope",
      ok: true,
      command: "stop",
      version: "1.11.1",
      data: { stdout: "No ComfyUI is running in the background.", stderr: "" },
    });
  });

  it("normalizes failed legacy commands without losing stderr", () => {
    const result = normalizeComfyCliResult(
      ["model", "remove"],
      {},
      { stdout: "", stderr: "model not found", exitCode: 2 },
      "1.11.1",
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({ code: "legacy_command_failed", message: "model not found" });
  });

  it("treats stopping an already-stopped background server as idempotent success", () => {
    const result = normalizeComfyCliResult(
      ["stop"],
      {},
      { stdout: "", stderr: "No ComfyUI is running in the background.", exitCode: 1 },
      "1.11.1",
    );
    expect(result).toMatchObject({ ok: true, data: { already_stopped: true } });
  });

  it("requires comfy-cli 1.11.1 or newer for automatic adoption", () => {
    expect(isSupportedComfyCliVersion("1.11.0")).toBe(false);
    expect(isSupportedComfyCliVersion("1.11.1")).toBe(true);
    expect(isSupportedComfyCliVersion("2.0.0")).toBe(true);
    expect(isSupportedComfyCliVersion(null)).toBe(false);
  });

  it("falls back to Manager HTTP unless a supported local CLI is available", () => {
    expect(shouldUseComfyCli(undefined, true, "/bin/comfy", "1.11.1")).toBe(true);
    expect(shouldUseComfyCli(undefined, true, null, null)).toBe(false);
    expect(shouldUseComfyCli(undefined, true, "/bin/comfy", "1.11.0")).toBe(false);
    expect(shouldUseComfyCli(undefined, false, "/bin/comfy", "1.11.1")).toBe(false);
    expect(shouldUseComfyCli(true, false, null, null)).toBe(true);
    expect(shouldUseComfyCli(false, true, "/bin/comfy", "1.11.1")).toBe(false);
  });

  it("treats download progress output as liveness and does NOT kill a long-but-live download", async () => {
    vi.useFakeTimers();
    try {
      const stdout = new EventEmitter();
      const stderr = new EventEmitter();
      let killed = false;
      const child = {
        stdout,
        stderr,
        on(event: string, listener: (arg: unknown) => void) {
          proc.on(event, listener);
          return this;
        },
        kill() {
          killed = true;
          // A real SIGTERM ends the process; emit close so the promise settles.
          proc.emit("close", null);
          return true;
        },
      };
      const proc = new EventEmitter();

      const IDLE = 120_000;
      const promise = awaitProcessWithIdleTimeout(child, IDLE);

      // comfy-cli emits ONLY the "Start downloading" progress line, then keeps
      // emitting progress every 90s (< idle window) across a 450s download —
      // far longer than the old 60s hard wall-clock timeout.
      stderr.emit("data", "Start downloading URL ... into E:\\ComfyUI\\models\\text_encoders\\model.safetensors\n");
      for (let elapsed = 90_000; elapsed <= 450_000; elapsed += 90_000) {
        await vi.advanceTimersByTimeAsync(90_000);
        expect(killed).toBe(false); // never killed while progressing
        stderr.emit("data", `progress ${elapsed / 1000}s\n`);
      }
      // Download finishes: emit the final JSON envelope on stdout, then close.
      stdout.emit(
        "data",
        '{"schema":"envelope/1","type":"envelope","ok":true,"command":"model download","version":"1.12.0","where":"local","data":{"path":"model.safetensors"},"error":null}\n',
      );
      proc.emit("close", 0);

      const result = await promise;
      expect(killed).toBe(false);
      expect(result.timedOut).toBe(false);
      expect(result.exitCode).toBe(0);

      const envelope = parseComfyCliEnvelope(result.stdout);
      expect(envelope.ok).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("still terminates a TRULY idle/stalled download after the idle window elapses", async () => {
    vi.useFakeTimers();
    try {
      const stdout = new EventEmitter();
      const stderr = new EventEmitter();
      const proc = new EventEmitter();
      let killed = false;
      const child = {
        stdout,
        stderr,
        on(event: string, listener: (arg: unknown) => void) {
          proc.on(event, listener);
          return this;
        },
        kill() {
          killed = true;
          proc.emit("close", null);
          return true;
        },
      };

      const IDLE = 120_000;
      const promise = awaitProcessWithIdleTimeout(child, IDLE);

      // Same progress-only stderr as the real bug report, then goes silent.
      stderr.emit("data", "Start downloading URL ... into E:\\ComfyUI\\models\\text_encoders\\model.safetensors\n");
      await vi.advanceTimersByTimeAsync(IDLE - 1);
      expect(killed).toBe(false); // not yet
      await vi.advanceTimersByTimeAsync(2);

      const result = await promise;
      expect(killed).toBe(true);
      expect(result.timedOut).toBe(true);
      expect(result.exitCode).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects Windows command shims that execFile cannot launch directly", () => {
    if (process.platform !== "win32") return;
    const dir = mkdtempSync(join(tmpdir(), "comfy-cli-test-"));
    tempDirs.push(dir);
    const executable = join(dir, "comfy.cmd");
    writeFileSync(executable, "@echo off\n");
    process.env.COMFY_CLI_PATH = executable;
    expect(resolveComfyCliExecutable()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// #490's repair makes this MORE dangerous, not less: in remote mode the
// workspace resolver now correctly returns nothing, `buildArgs` therefore omits
// `--workspace`, the PATH fallback still finds a global `comfy`, and the CLI
// falls back to whatever install IT defaults to. "No workspace could be
// resolved" is not "no workspace will be used" — it hands the choice away.

describe("comfy-cli refuses to act locally while the session targets a remote ComfyUI", () => {
  it("does NOT run anything when remote and no workspace was resolved", () => {
    // A real `comfy` on PATH is the whole point of the case: executable
    // resolution succeeds, so nothing downstream stops it.
    const dir = mkdtempSync(join(tmpdir(), "cmcp-cli-"));
    tempDirs.push(dir);
    const exe = join(dir, process.platform === "win32" ? "comfy.exe" : "comfy");
    writeFileSync(exe, "");
    process.env.COMFY_CLI_PATH = exe;
    cfg.remote = true;

    // `models_remove` goes through this path. Deleting from an unrelated local
    // install while connected elsewhere is the harm.
    expect(() => runComfyCliSync(["model", "remove", "--name", "x"])).toThrow(
      /REMOTE ComfyUI/i,
    );
    expect(() => runComfyCliSync(["model", "remove", "--name", "x"])).toThrow(
      /Nothing was run/i,
    );
  });

  it("refuses EVEN WITH an explicit workspace — a named target is not a verified one", () => {
    // An earlier draft of this fix let an explicit `workspace` through, reasoning
    // that a caller naming its target had not left the choice to the CLI. That was
    // wrong (codex gate): `workspace` is an unverified caller-supplied string, so a
    // remote session could still pass `models_remove` a stale or simply mistaken
    // path and delete there. Naming a target is not evidence it is the right one,
    // and in remote mode there is no local install this session is about at all.
    const dir = mkdtempSync(join(tmpdir(), "cmcp-cli-"));
    tempDirs.push(dir);
    const exe = join(dir, process.platform === "win32" ? "comfy.exe" : "comfy");
    writeFileSync(exe, "");
    process.env.COMFY_CLI_PATH = exe;
    cfg.remote = true;

    expect(() => runComfyCliSync(["model", "remove", "--name", "x"], { workspace: dir })).toThrow(
      /REMOTE ComfyUI/i,
    );
  });

  it("reports NO usable comfy-cli in remote mode, rather than advertising a local one", () => {
    // `getComfyCliVersion` spawns a local `comfy` to read its version. Read-only,
    // but it still describes a CLI that must never be used from here — and
    // `isComfyCliUsable` would then advertise it as available, which is the same
    // claim the refusal above denies.
    const dir = mkdtempSync(join(tmpdir(), "cmcp-cli-"));
    tempDirs.push(dir);
    const exe = join(dir, process.platform === "win32" ? "comfy.exe" : "comfy");
    writeFileSync(exe, "");
    process.env.COMFY_CLI_PATH = exe;
    cfg.remote = true;

    spawnSpy.sync.mockClear();
    expect(getComfyCliVersion()).toBeNull();
    // The load-bearing assertion: no local CLI was launched at all.
    expect(spawnSpy.sync).not.toHaveBeenCalled();
  });
});
