// The port-owner probe's TRI-STATE contract (#776).
//
// `findPidByPort` answers `null` both for "nothing is listening" and for "the
// lookup itself failed". That is fine for "find me a pid", and dangerous for "has
// the port been released?" — a failed lookup would certify that a still-running
// server had gone. `probePortOwner` separates them, and this file pins the exact
// signals it classifies from.
//
// It exists because that contract broke in CI in a way no test could see: the
// suite's port fixtures modelled "nothing is listening" as a bare `throw new
// Error(...)`, which carries neither an exit status nor an errno. On Windows the
// netstat branch runs and never reaches it; on POSIX the lsof branch does, read it
// as "I could not look", and the caller waited out its whole budget. Green on one
// platform, hung on the other. Both branches are therefore driven explicitly here.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockExecSync = vi.hoisted(() => vi.fn());
const mockPlatform = vi.hoisted(() => vi.fn(() => "linux"));

vi.mock("node:child_process", () => ({ execSync: mockExecSync }));
vi.mock("node:os", () => ({ platform: mockPlatform }));
// The kernel socket table is consulted before lsof on Linux. These tests drive the
// LSOF contract specifically, so make /proc unreadable and let it fall through
// deterministically (a real Linux runner would otherwise answer from
// /proc/net/tcp first and never reach the code under test).
vi.mock("node:fs", () => ({
  readFileSync: vi.fn(() => {
    throw new Error("no /proc in test");
  }),
}));

/** `execSync` throws with `status` (the exit code) for a command that RAN and
 *  failed, and with `code` (an errno) only for a spawn-level failure. */
function exitWith(status: number): Error {
  const err = new Error(`exited ${status}`) as Error & { status: number };
  err.status = status;
  return err;
}
function spawnFailure(code: string): NodeJS.ErrnoException {
  const err = new Error(code) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  mockPlatform.mockReturnValue("linux");
});

afterEach(() => {
  vi.resetModules();
});

/** Import fresh so the module-level `IS_WIN` picks up the mocked platform. */
async function loadProbe() {
  const mod = await import("../../services/port-owner.js");
  return mod;
}

describe("probePortOwner — POSIX (lsof)", () => {
  it("reports OWNED when lsof names a listener", async () => {
    mockExecSync.mockReturnValue("p4321\nn127.0.0.1:8188\n");
    const { probePortOwner } = await loadProbe();

    expect(probePortOwner(8188)).toEqual({ state: "owned", pid: 4321 });
  });

  it("reports FREE only when lsof STATES the address was not located", async () => {
    // Verified against lsof(8) and by experiment: exit 1 means "an error was
    // detected, INCLUDING failure to locate", so it cannot distinguish "searched
    // and found nothing" from "could not search". `-V` makes lsof say which it was,
    // and that statement is the only thing treated as evidence of a free port.
    mockExecSync.mockImplementation(() => {
      const err = exitWith(1) as Error & { status: number; stdout: string };
      err.stdout = "lsof: Internet address not located: TCP:8188";
      throw err;
    });
    const { probePortOwner } = await loadProbe();

    expect(probePortOwner(8188)).toEqual({ state: "free" });
  });

  it("reports UNKNOWN for a BARE exit 1 with no such statement", async () => {
    mockExecSync.mockImplementation(() => {
      throw exitWith(1);
    });
    const { probePortOwner } = await loadProbe();

    expect(probePortOwner(8188).state).toBe("unknown");
  });

  it("reports FREE when lsof exits 0 and states the address was not located", async () => {
    mockExecSync.mockReturnValue("lsof: Internet address not located: TCP:8188");
    const { probePortOwner } = await loadProbe();

    expect(probePortOwner(8188)).toEqual({ state: "free" });
  });

  it("reports UNKNOWN when lsof exits 0 but names nobody and states nothing", async () => {
    mockExecSync.mockReturnValue("");
    const { probePortOwner } = await loadProbe();

    expect(probePortOwner(8188).state).toBe("unknown");
  });

  it("reports UNKNOWN when the command is MISSING (shell exit 127), not free", async () => {
    // A container without lsof. "I could not look" must never be spent as "nobody
    // is listening" — that is what would certify a live server as gone.
    mockExecSync.mockImplementation(() => {
      throw exitWith(127);
    });
    const { probePortOwner } = await loadProbe();

    const probe = probePortOwner(8188);
    expect(probe.state).toBe("unknown");
  });

  it("reports UNKNOWN when lsof exits 1 but COMPLAINS on stderr", async () => {
    // A permission-restricted lsof exits 1 having enumerated nothing and says so on
    // stderr. Exit status alone would read that as "the port is free" — certifying
    // a release that never happened, and tearing down supervision under a server
    // that may still be serving.
    mockExecSync.mockImplementation(() => {
      const err = exitWith(1) as Error & { status: number; stderr: string };
      err.stderr = "lsof: WARNING: can't stat() /proc/1234: Permission denied";
      throw err;
    });
    const { probePortOwner } = await loadProbe();

    expect(probePortOwner(8188).state).toBe("unknown");
  });

  it("reports UNKNOWN when lsof exits 1 with partial output on stdout", async () => {
    mockExecSync.mockImplementation(() => {
      const err = exitWith(1) as Error & { status: number; stdout: string };
      err.stdout = "p999\n";
      throw err;
    });
    const { probePortOwner } = await loadProbe();

    expect(probePortOwner(8188).state).toBe("unknown");
  });

  it("reports UNKNOWN for a QUIET exit 1 — silence is not a finding", async () => {
    // MEASURED on Linux: an enumeration that cannot see another user's sockets
    // exits 1 with EMPTY stdout and EMPTY stderr, with or without `-w`. Reading
    // that as "free" is what would certify a release that never happened.
    mockExecSync.mockImplementation(() => {
      const err = exitWith(1) as Error & { status: number; stdout: string; stderr: string };
      err.stdout = "";
      err.stderr = "";
      throw err;
    });
    const { probePortOwner } = await loadProbe();

    expect(probePortOwner(8188).state).toBe("unknown");
  });

  it("passes -V so lsof STATES what it failed to locate", async () => {
    mockExecSync.mockReturnValue("");
    const { probePortOwner } = await loadProbe();
    probePortOwner(8188);

    expect(String(mockExecSync.mock.calls[0][0])).toMatch(/lsof -V /);
    // `-w` would SUPPRESS warnings, making silence less informative, not more.
    expect(String(mockExecSync.mock.calls[0][0])).not.toMatch(/ -w /);
  });

  it("reports UNKNOWN for a spawn-level failure (errno), not free", async () => {
    mockExecSync.mockImplementation(() => {
      throw spawnFailure("ENOENT");
    });
    const { probePortOwner } = await loadProbe();

    expect(probePortOwner(8188).state).toBe("unknown");
  });

  it("reports UNKNOWN for an error carrying NEITHER a status nor an errno", async () => {
    // Exactly the shape the suite's own fixtures used to throw. Classifying it as
    // "free" is the bug this module guards; classifying it as "unknown" is correct,
    // and is why those fixtures had to start modelling lsof's real contract.
    mockExecSync.mockImplementation(() => {
      throw new Error("not listening");
    });
    const { probePortOwner } = await loadProbe();

    expect(probePortOwner(8188).state).toBe("unknown");
  });

  it("findPidByPort keeps its null-for-anything-but-owned contract", async () => {
    mockExecSync.mockImplementation(() => {
      throw exitWith(1);
    });
    const { findPidByPort } = await loadProbe();

    expect(findPidByPort(8188)).toBeNull();
  });
});

describe("probePortOwner — Windows (netstat, then Get-NetTCPConnection)", () => {
  beforeEach(() => {
    mockPlatform.mockReturnValue("win32");
  });

  it("reports OWNED from netstat", async () => {
    mockExecSync.mockReturnValue(
      "  TCP    0.0.0.0:8188   0.0.0.0:0   LISTENING       4321",
    );
    const { probePortOwner } = await loadProbe();

    expect(probePortOwner(8188)).toEqual({ state: "owned", pid: 4321 });
  });

  it("reports FREE when a probe RAN and matched nothing", async () => {
    mockExecSync.mockReturnValue("");
    const { probePortOwner } = await loadProbe();

    expect(probePortOwner(8188)).toEqual({ state: "free" });
  });

  it("reports UNKNOWN only when EVERY probe failed", async () => {
    mockExecSync.mockImplementation(() => {
      throw spawnFailure("ENOENT");
    });
    const { probePortOwner } = await loadProbe();

    expect(probePortOwner(8188).state).toBe("unknown");
  });

  it("reports FREE when netstat fails but the PowerShell fallback runs", async () => {
    // One probe failing is not "I could not look" — the other one looked.
    mockExecSync.mockImplementation((cmd: string) => {
      if (/netstat/i.test(cmd)) throw spawnFailure("ENOENT");
      return "";
    });
    const { probePortOwner } = await loadProbe();

    expect(probePortOwner(8188)).toEqual({ state: "free" });
  });
});
