import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  argv0FromCommandLine,
  commandLineMatchesArgv,
  recordLaunchedInterpreter,
  clearLaunchedInterpreter,
  getLaunchedInterpreterRecord,
  resolveLiveInterpreter,
} from "../../services/live-interpreter.js";

/** ComfyUI Desktop's real shape, as measured on the machine that filed #401. */
const COMFY_ARGV = [
  "ComfyUI\\main.py",
  "--feature-flag",
  "show_signin_button=true",
  "--enable-manager",
  "--extra-model-paths-config",
  "C:\\Users\\A\\AppData\\Roaming\\Comfy Desktop\\shared_model_paths.yaml",
];

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

describe("commandLineMatchesArgv — correlate the process against the server's own argv", () => {
  const comfyCmd =
    'C:\\ComfyUI\\.venv\\Scripts\\python.exe -s ComfyUI\\main.py --feature-flag show_signin_button=true ' +
    '--enable-manager --extra-model-paths-config "C:\\Users\\A\\AppData\\Roaming\\Comfy Desktop\\shared_model_paths.yaml"';

  it("matches the real ComfyUI command line against its reported argv", () => {
    expect(commandLineMatchesArgv(comfyCmd, COMFY_ARGV)).toBe(true);
  });

  it("does NOT match a python reverse PROXY sitting on the same port", () => {
    // The P1 hazard: a proxy on 127.0.0.1:8188 forwarding to the real ComfyUI. Same
    // python family, different program — its argv shares nothing with ComfyUI's.
    const proxyCmd = "C:\\proxies\\.venv\\Scripts\\python.exe -m myproxy --listen 8188 --upstream 8189";
    expect(commandLineMatchesArgv(proxyCmd, COMFY_ARGV)).toBe(false);
  });

  it("does NOT match a DIFFERENT ComfyUI instance launched with other arguments", () => {
    const otherCmd = "C:\\Other\\.venv\\Scripts\\python.exe -s ComfyUI\\main.py --listen 0.0.0.0";
    expect(commandLineMatchesArgv(otherCmd, COMFY_ARGV)).toBe(false);
  });

  it("fails closed when the argv or the command line is missing/empty", () => {
    expect(commandLineMatchesArgv(comfyCmd, undefined)).toBe(false);
    expect(commandLineMatchesArgv(comfyCmd, [])).toBe(false);
    expect(commandLineMatchesArgv(undefined, COMFY_ARGV)).toBe(false);
    expect(commandLineMatchesArgv("", COMFY_ARGV)).toBe(false);
  });

  it("does NOT let an ABSOLUTE argv path anchor to a different instance's absolute path", () => {
    // Two local installs, both with ComfyUI\main.py: an absolute argv[0] is an
    // exact claim and must not suffix-match the other instance's root.
    const argv = ["C:\\ComfyUI\\main.py", "--port", "8188"];
    const otherInstance = "D:\\Other\\ComfyUI\\main.py --port 8188";
    expect(commandLineMatchesArgv(otherInstance, argv)).toBe(false);
  });

  it("tolerates the quoting the OS adds around paths containing spaces", () => {
    const argv = ["main.py", "--config", "/opt/my configs/models.yaml"];
    expect(commandLineMatchesArgv('/usr/bin/python3 main.py --config "/opt/my configs/models.yaml"', argv)).toBe(
      true,
    );
  });
});

describe("resolveLiveInterpreter — ground truth only (#401)", () => {
  it("returns the interpreter WE launched, when PID and start time both match", async () => {
    const exe = await makeExe("launched.exe");
    recordLaunchedInterpreter(4242, exe);
    const startedAt = getLaunchedInterpreterRecord()?.startedAt;

    const res = resolveLiveInterpreter({
      port: 8188,
      remote: false,
      findPid: () => 4242,
      readIdentity: () => ({ commandLine: `${exe} main.py`, startedAt }),
    });
    // On a platform where the start time is unreadable the tier fails closed, which
    // is the correct behavior — assert the identity-confirmed path only when we
    // actually captured a start time.
    if (startedAt) {
      expect(res).toEqual({ python: exe, source: "launched-by-us", pid: 4242 });
    } else {
      expect(res?.source).not.toBe("launched-by-us");
    }
  });

  it("REJECTS the launch record when the PID was REUSED by another process", async () => {
    const ours = await makeExe("ours.exe");
    recordLaunchedInterpreter(4242, ours);

    // Our child died; the OS handed 4242 to an unrelated python that grabbed the
    // port before cleanup ran. Same PID, DIFFERENT creation time → the stale
    // interpreter must not be served for the replacement server.
    const res = resolveLiveInterpreter({
      port: 8188,
      remote: false,
      serverArgv: COMFY_ARGV,
      findPid: () => 4242,
      readIdentity: () => ({
        commandLine: "/usr/bin/python3 -m someone_else",
        startedAt: "an-utterly-different-start-time",
      }),
    });
    expect(res).toBeUndefined();
  });

  it("fails closed when the launch record has NO start time to compare", async () => {
    const ours = await makeExe("ours2.exe");
    recordLaunchedInterpreter(4242, ours);
    // Simulate a platform that could not read a creation time at record OR read time.
    const res = resolveLiveInterpreter({
      port: 8188,
      remote: false,
      findPid: () => 4242,
      readIdentity: () => ({ commandLine: `${ours} main.py` }), // no startedAt
    });
    expect(res?.source).not.toBe("launched-by-us");
  });

  it("reads the interpreter from the OS when its command line matches the server's argv", async () => {
    const exe = await makeExe("desktop-venv.exe");
    const res = resolveLiveInterpreter({
      port: 8188,
      remote: false,
      serverArgv: COMFY_ARGV,
      findPid: () => 777,
      readIdentity: () => ({
        commandLine: `${exe} -s ${COMFY_ARGV.join(" ")}`,
        startedAt: "t1",
      }),
    });
    expect(res).toEqual({ python: exe, source: "process-table", pid: 777 });
  });

  it("returns UNKNOWN for a PROXY on the port whose command line does not match argv", async () => {
    // P1: the proxy's venv may lack Triton entirely. Reporting its packages as the
    // server's is exactly the false capability report #401 is about.
    const proxyExe = await makeExe("proxy-venv.exe");
    const res = resolveLiveInterpreter({
      port: 8188,
      remote: false,
      serverArgv: COMFY_ARGV,
      findPid: () => 999,
      readIdentity: () => ({
        commandLine: `${proxyExe} -m myproxy --listen 8188 --upstream 8189`,
        startedAt: "t1",
      }),
    });
    expect(res).toBeUndefined();
  });

  it("fails closed when the server reported NO argv to correlate against", async () => {
    const exe = await makeExe("some-python.exe");
    for (const serverArgv of [undefined, [] as string[]]) {
      expect(
        resolveLiveInterpreter({
          port: 8188,
          remote: false,
          serverArgv,
          findPid: () => 777,
          readIdentity: () => ({ commandLine: `${exe} -s ComfyUI/main.py`, startedAt: "t1" }),
        }),
      ).toBeUndefined();
    }
  });

  it("passes the HOST through to the port lookup", () => {
    let sawHost: string | undefined = "unset";
    resolveLiveInterpreter({
      port: 8188,
      host: "127.0.0.1",
      remote: false,
      serverArgv: COMFY_ARGV,
      findPid: (_p, host) => {
        sawHost = host;
        return null;
      },
      readIdentity: () => undefined,
    });
    expect(sawHost).toBe("127.0.0.1");
  });

  it("returns UNDEFINED when nothing is listening on the port", () => {
    expect(
      resolveLiveInterpreter({
        port: 8188,
        remote: false,
        serverArgv: COMFY_ARGV,
        findPid: () => null,
        readIdentity: () => ({ commandLine: "/usr/bin/python3 ComfyUI/main.py" }),
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
        serverArgv: COMFY_ARGV,
        findPid: () => 1,
        readIdentity: () => ({ commandLine: `${exe} main.py`, startedAt: "t1" }),
      }),
    ).toBeUndefined();
  });

  it("returns UNDEFINED for a RELATIVE or bare argv[0] (it names no file we can probe)", () => {
    for (const exe of ["python", "./python"]) {
      expect(
        resolveLiveInterpreter({
          port: 8188,
          remote: false,
          serverArgv: ["main.py"],
          findPid: () => 5,
          readIdentity: () => ({ commandLine: `${exe} main.py`, startedAt: "t1" }),
        }),
      ).toBeUndefined();
    }
  });

  it("returns UNDEFINED when argv[0] is absolute but does not exist on disk", () => {
    const gone = join(dir, "gone.exe");
    expect(
      resolveLiveInterpreter({
        port: 8188,
        remote: false,
        serverArgv: ["main.py"],
        findPid: () => 5,
        readIdentity: () => ({ commandLine: `${gone} main.py`, startedAt: "t1" }),
      }),
    ).toBeUndefined();
  });

  it("never throws when the port lookup or the process read fails", () => {
    expect(
      resolveLiveInterpreter({
        port: 8188,
        remote: false,
        serverArgv: COMFY_ARGV,
        findPid: () => {
          throw new Error("netstat exploded");
        },
        readIdentity: () => undefined,
      }),
    ).toBeUndefined();

    expect(
      resolveLiveInterpreter({
        port: 8188,
        remote: false,
        serverArgv: COMFY_ARGV,
        findPid: () => 5,
        readIdentity: () => {
          throw new Error("wmi exploded");
        },
      }),
    ).toBeUndefined();
  });
});
