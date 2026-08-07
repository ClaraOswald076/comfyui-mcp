// #1005 — a ComfyUI under a non-ASCII path could not be restarted.
//
// PowerShell encodes REDIRECTED stdout with the console's legacy OEM codepage,
// not UTF-8, while this output is decoded as UTF-8. Any character the codepage
// cannot represent arrives as `?` or U+FFFD, so a Cyrillic Windows profile (or
// an accented folder, or CJK) yields a MANGLED command line.
//
// That is not cosmetic. `commandLineMatchesArgv` compares this against
// /system_stats argv to corroborate ownership before a restart, so a mangled
// path never matches and restart_comfyui refuses to control the very process it
// just identified — telling the user it "is not running the ComfyUI that
// answered /system_stats" about the one that is.
//
// Measured on Windows 11 before the fix:
//   without the preamble:  "CMD=??????-caf?-??"
//   with it:               "CMD=Пример-café-日本"

import { describe, expect, it, vi, beforeEach } from "vitest";

const execFileSync = vi.fn();
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFileSync: (...a: unknown[]) => execFileSync(...a),
}));

// The module reads platform() ONCE at load, so it must be pinned before import
// or this suite passes vacuously on Linux/macOS CI (the IS_WIN branch never runs).
vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  platform: () => "win32",
}));

const { readProcessIdentity } = await import("../../services/live-interpreter.js");

/** A path with characters no single OEM codepage covers. */
const CYRILLIC_PATH = "C:\Users\Пример\ComfyUI\main.py";

beforeEach(() => execFileSync.mockReset());

describe("#1005: the identity probe asks PowerShell for UTF-8", () => {
  it("sets OutputEncoding before anything that can emit a path", () => {
    execFileSync.mockReturnValue("START=1\nPPID=2\nEXE=x\nCMD=y\n");
    readProcessIdentity(1234);

    const [exe, args] = execFileSync.mock.calls[0] as [string, string[]];
    expect(exe).toMatch(/powershell/);
    const command = args[args.indexOf("-Command") + 1];
    expect(command).toContain("[Console]::OutputEncoding");
    expect(command).toContain("UTF8Encoding");
    // Order is load-bearing: the encoding must be set BEFORE the query that
    // produces the path, or the first line is already mangled.
    expect(command.indexOf("OutputEncoding")).toBeLessThan(command.indexOf("Get-CimInstance"));
  });

  // A BOM would land at the head of stdout and corrupt the first field parsed.
  it("asks for UTF-8 WITHOUT a BOM", () => {
    execFileSync.mockReturnValue("START=1\nCMD=y\n");
    readProcessIdentity(1234);
    const [, args] = execFileSync.mock.calls[0] as [string, string[]];
    expect(args[args.indexOf("-Command") + 1]).toContain("UTF8Encoding]::new($false)");
  });

  it("carries a non-ASCII command line through intact", () => {
    execFileSync.mockReturnValue(
      `START=133000000000000000\nPPID=42\nEXE=C:\Python\python.exe\nCMD=${CYRILLIC_PATH}\n`,
    );
    const id = readProcessIdentity(1234);
    expect(id?.commandLine).toBe(CYRILLIC_PATH);
    // …and the tokenised argv keeps it too, since that is what ownership
    // corroboration actually compares.
    expect(id?.argv?.[0]).toContain("Пример");
    expect(id?.argvFidelity).toBe("exact");
  });

  // The failure this produced: a replacement char makes the OS command line
  // differ from the argv the server reported, so ownership never corroborates.
  it("a MANGLED line does not match the argv it should have matched", async () => {
    const { commandLineMatchesArgv } = await import("../../services/live-interpreter.js");
    const argv = [CYRILLIC_PATH, "--listen"];
    expect(commandLineMatchesArgv(`${CYRILLIC_PATH} --listen`, argv)).toBe(true);
    // What the OEM codepage produced before the fix.
    expect(commandLineMatchesArgv("C:\Users\??????\ComfyUI\main.py --listen", argv)).toBe(false);
  });
});
