import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  argv0FromCommandLine,
  recordLaunchedInterpreter,
  clearLaunchedInterpreter,
  resolveLiveInterpreter,
} from "../../services/live-interpreter.js";

let dir: string;
beforeEach(async () => {
  clearLaunchedInterpreter();
  dir = await mkdtemp(join(tmpdir(), "comfyui-live-"));
});
afterEach(async () => {
  clearLaunchedInterpreter();
  await rm(dir, { recursive: true, force: true });
});

async function makeExe(name: string): Promise<string> {
  const p = join(dir, name);
  await writeFile(p, "", "utf-8");
  return p;
}

describe("argv0FromCommandLine", () => {
  it("takes the first token of an unquoted command line", () => {
    expect(argv0FromCommandLine("/usr/bin/python3 main.py --port 8188")).toBe("/usr/bin/python3");
  });

  it("honors a QUOTED interpreter path containing spaces", () => {
    // The Windows shape that a naive whitespace split would truncate.
    expect(
      argv0FromCommandLine('"C:\\Program Files\\ComfyUI\\.venv\\Scripts\\python.exe" -s main.py'),
    ).toBe("C:\\Program Files\\ComfyUI\\.venv\\Scripts\\python.exe");
  });

  it("returns undefined for empty or unterminated input", () => {
    expect(argv0FromCommandLine("")).toBeUndefined();
    expect(argv0FromCommandLine("   ")).toBeUndefined();
    expect(argv0FromCommandLine('"C:\\unterminated')).toBeUndefined();
  });
});

describe("resolveLiveInterpreter — ground truth only (#401)", () => {
  it("returns the interpreter WE launched, when it still owns the port", async () => {
    const exe = await makeExe("launched.exe");
    recordLaunchedInterpreter(4242, exe);

    const res = resolveLiveInterpreter({
      port: 8188,
      remote: false,
      findPid: () => 4242,
      readArgv0: () => undefined,
    });
    expect(res).toEqual({ python: exe, source: "launched-by-us", pid: 4242 });
  });

  it("DISCARDS the launch record when a different process now owns the port", async () => {
    const ours = await makeExe("ours.exe");
    const theirs = await makeExe("theirs.exe");
    recordLaunchedInterpreter(4242, ours);

    // Our child died; PID 9999 took the port. Reporting `ours` for it would be
    // exactly the confident-wrong-answer class this module exists to prevent.
    const res = resolveLiveInterpreter({
      port: 8188,
      remote: false,
      findPid: () => 9999,
      readArgv0: () => theirs,
    });
    expect(res).toEqual({ python: theirs, source: "process-table", pid: 9999 });
  });

  it("reads the interpreter from the OS when we did NOT launch the server", async () => {
    const exe = await makeExe("desktop-venv.exe");
    const res = resolveLiveInterpreter({
      port: 8188,
      remote: false,
      findPid: () => 777,
      readArgv0: () => exe,
    });
    expect(res).toEqual({ python: exe, source: "process-table", pid: 777 });
  });

  it("returns UNDEFINED when nothing is listening on the port", () => {
    expect(
      resolveLiveInterpreter({
        port: 8188,
        remote: false,
        findPid: () => null,
        readArgv0: () => "/usr/bin/python3",
      }),
    ).toBeUndefined();
  });

  it("returns UNDEFINED for a REMOTE server (no local process is it)", async () => {
    const exe = await makeExe("local.exe");
    recordLaunchedInterpreter(1, exe);
    expect(
      resolveLiveInterpreter({
        port: 8188,
        remote: true,
        findPid: () => 1,
        readArgv0: () => exe,
      }),
    ).toBeUndefined();
  });

  it("returns UNDEFINED for a RELATIVE or bare argv[0] (it names no file we can probe)", () => {
    for (const argv0 of ["python", "./python", "ComfyUI/main.py"]) {
      expect(
        resolveLiveInterpreter({
          port: 8188,
          remote: false,
          findPid: () => 5,
          readArgv0: () => argv0,
        }),
      ).toBeUndefined();
    }
  });

  it("returns UNDEFINED when argv[0] is absolute but does not exist on disk", () => {
    expect(
      resolveLiveInterpreter({
        port: 8188,
        remote: false,
        findPid: () => 5,
        readArgv0: () => join(dir, "gone.exe"),
      }),
    ).toBeUndefined();
  });

  it("never throws when the port lookup itself fails", () => {
    expect(
      resolveLiveInterpreter({
        port: 8188,
        remote: false,
        findPid: () => {
          throw new Error("netstat exploded");
        },
        readArgv0: () => "/usr/bin/python3",
      }),
    ).toBeUndefined();
  });
});
