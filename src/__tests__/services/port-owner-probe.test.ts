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
  // ENOENT, not a bare Error: the probe classifies a failed table read from its
  // ERRNO. "The table does not exist" (this host has no /proc) hides nothing and
  // leaves lsof as the only source; "I could not open it" (EACCES) is a blind spot
  // lsof may share. A bare Error carries no errno and so reads as the latter.
  readFileSync: vi.fn(() => {
    throw Object.assign(new Error("no /proc in test"), { code: "ENOENT" });
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

  it("the absence marker is VOID when lsof also admits it could not look everywhere", async () => {
    // The two can appear together: lsof reports what it skipped AND still names what
    // it failed to locate. "I searched and did not find it" is a claim about the whole
    // machine; a run that could not stat part of /proc searched only what it could
    // see. Reading that combination as free certifies a release from an enumeration
    // that admits it was partial.
    mockExecSync.mockImplementation(() => {
      const err = exitWith(1) as Error & {
        status: number;
        stdout: string;
        stderr: string;
      };
      err.stdout = "lsof: Internet address not located: TCP:8188";
      err.stderr =
        "lsof: WARNING: can't stat() /proc/1234: Permission denied\nOutput information may be incomplete.";
      throw err;
    });
    const { probePortOwner } = await loadProbe();

    // The REASON is asserted, not just the state. lsof plainly DID report an empty
    // search here — we declined to spend it — so a message saying it "did not report
    // an empty search" would name the one cause that did not apply, and a caller that
    // waits out its budget could not tell the refusal came from the warning.
    const probe = probePortOwner(8188);
    expect(probe.state).toBe("unknown");
    expect(probe).toMatchObject({
      reason: expect.stringMatching(/could not enumerate everything/i),
    });
    expect(probe).not.toMatchObject({
      reason: expect.stringMatching(/did not report an empty search/i),
    });
  });

  it("the absence marker is VOID alongside a warning on the exit-0 path too", async () => {
    mockExecSync.mockReturnValue(
      "lsof: WARNING: can't stat() /proc/1234: Permission denied\nlsof: Internet address not located: TCP:8188",
    );
    const { probePortOwner } = await loadProbe();

    const probe = probePortOwner(8188);
    expect(probe.state).toBe("unknown");
    expect(probe).toMatchObject({
      reason: expect.stringMatching(/could not enumerate everything/i),
    });
    expect(probe).not.toMatchObject({
      reason: expect.stringMatching(/did not report an empty search/i),
    });
  });

  it("a diagnostic that says neither WARNING nor 'permission denied' still voids it", async () => {
    // The set of complaints lsof can make is open — `lsof: can't read proc table
    // info` is documented and matches none of the words I would have listed. So the
    // rule is inverted: any `lsof:` line that is not part of the `-V` "not located"
    // report is a complaint, whatever it says.
    mockExecSync.mockReturnValue(
      "lsof: can't read proc table info\nlsof: Internet address not located: TCP:8188",
    );
    const { probePortOwner } = await loadProbe();

    const probe = probePortOwner(8188);
    expect(probe.state).toBe("unknown");
    expect(probe).toMatchObject({
      reason: expect.stringMatching(/could not enumerate everything/i),
    });
  });

  it("the -V report's OWN lines are not complaints — a clean absence is still FREE", async () => {
    // The control for the inversion. A real `-V` run on a free port emits TWO
    // `lsof:` lines, captured verbatim from a live lsof 4.99.4. If the rule counted
    // those as complaints, no port could ever be certified free through lsof.
    mockExecSync.mockImplementation(() => {
      const err = exitWith(1) as Error & { status: number; stdout: string };
      err.stdout =
        "lsof: Internet address not located: TCP:8188\nlsof: TCP state not located: LISTEN";
      throw err;
    });
    const { probePortOwner } = await loadProbe();

    expect(probePortOwner(8188)).toEqual({ state: "free" });
  });

  it("a SILENT exit-0 still reports the silent cause, not the warning one", async () => {
    // The counterpart, so the two causes cannot both drift onto one string: lsof
    // exited 0, named nobody, and said nothing about an empty search.
    mockExecSync.mockReturnValue("");
    const { probePortOwner } = await loadProbe();

    const probe = probePortOwner(8188);
    expect(probe.state).toBe("unknown");
    expect(probe).toMatchObject({
      reason: expect.stringMatching(/did not report an empty search/i),
    });
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

  it("CAPTURES stderr, or a success-path warning would never be seen", async () => {
    // lsof reports an incomplete enumeration on stderr, and on the success path
    // `execSync` returns stdout only. Without the redirect, a marker on stdout beside
    // a warning on stderr reads as a clean absence — the classification below cannot
    // reject what it was never handed, so the ACQUISITION has to be pinned here.
    mockExecSync.mockReturnValue("");
    const { probePortOwner } = await loadProbe();
    probePortOwner(8188);

    expect(String(mockExecSync.mock.calls[0][0])).toMatch(/2>&1/);
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

describe("probePortOwner — POSIX (kernel socket table, consulted before lsof)", () => {
  // The real column headers, captured from a live kernel. IPv4 says `rem_address`,
  // IPv6 says `remote_address`; both end at `inode`. Kept verbatim and shared so a
  // fixture cannot accidentally supply a TRUNCATED header, which is itself one of
  // the states under test.
  const HEADER_V4 =
    "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode";
  const HEADER_V6 =
    "  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode";

  /** A `/proc/net/tcp` body; `state` is the kernel's hex code (`0A` = LISTEN). */
  function table(port: number, state = "0A"): string {
    const hexPort = port.toString(16).toUpperCase().padStart(4, "0");
    return [
      HEADER_V4,
      `   0: 0100007F:${hexPort} 00000000:0000 ${state} 00000000:00000000 00:00000000 00000000  1000        0 54321 1`,
      "",
    ].join("\n");
  }
  /**
   * A `/proc/net/tcp6` body. The local address is THIRTY-TWO hex digits, not eight
   * — this is `::1` exactly as a real kernel prints it, captured from a live IPv6
   * listener. Using an IPv4-width row here would let a regression that narrowed the
   * endpoint pattern to IPv4-only still pass.
   */
  function table6(port: number, state = "0A"): string {
    const hexPort = port.toString(16).toUpperCase().padStart(4, "0");
    return [
      HEADER_V6,
      `   0: 00000000000000000000000001000000:${hexPort} 00000000000000000000000000000000:0000 ${state} 00000000:00000000 00:00000000 00000000  1000        0 22454 1`,
      "",
    ].join("\n");
  }
  /**
   * A table with NO sockets at all — a header and nothing else. This is what an idle
   * host really serves, and it must stay a CLEAN NEGATIVE. Using `""` as a stand-in
   * would instead model a table that came back as nothing, which is damage.
   */
  function emptyTable(path: string): string {
    return `${path === "/proc/net/tcp6" ? HEADER_V6 : HEADER_V4}\n`;
  }
  const enoent = (): NodeJS.ErrnoException =>
    Object.assign(new Error("ENOENT"), { code: "ENOENT" });

  it("reports FREE from the kernel table WITHOUT running lsof at all", async () => {
    // The whole point of consulting /proc first: it sees every socket regardless of
    // owner, so "nothing is listening" is a real answer here where lsof can only
    // give an ambiguous one. lsof must not even be spawned.
    const { probePortOwner, __portOwnerTestHooks } = await loadProbe();
    const reader = vi.fn((t: string) => (t === "/proc/net/tcp" ? table(9999) : emptyTable(t)));
    __portOwnerTestHooks.setProcNetReader(reader);

    expect(probePortOwner(8188)).toEqual({ state: "free" });
    expect(reader).toHaveBeenCalledWith("/proc/net/tcp");
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  it("a non-LISTEN socket on the port is not a listener", async () => {
    // `01` is ESTABLISHED: an outbound connection whose local side happens to use
    // the port does not mean anything is accepting on it.
    const { probePortOwner, __portOwnerTestHooks } = await loadProbe();
    __portOwnerTestHooks.setProcNetReader((t) =>
      t === "/proc/net/tcp" ? table(8188, "01") : emptyTable(t),
    );

    expect(probePortOwner(8188)).toEqual({ state: "free" });
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  it("falls through to lsof to NAME the owner when the kernel says something listens", async () => {
    // The kernel table settles free-vs-occupied but cannot name a pid, so a LISTEN
    // row must not short-circuit: lsof still has to run. Asserting the table was
    // read AND lsof was spawned is what distinguishes this from lsof answering on
    // its own with /proc never consulted.
    const { probePortOwner, __portOwnerTestHooks } = await loadProbe();
    const reader = vi.fn((t: string) => (t === "/proc/net/tcp" ? table(8188) : emptyTable(t)));
    __portOwnerTestHooks.setProcNetReader(reader);
    mockExecSync.mockReturnValue("p4321\nn127.0.0.1:8188\n");

    expect(probePortOwner(8188)).toEqual({ state: "owned", pid: 4321 });
    expect(reader).toHaveBeenCalledWith("/proc/net/tcp");
    expect(mockExecSync).toHaveBeenCalled();
  });

  it("a listening socket whose owner lsof cannot name is UNKNOWN, never free", async () => {
    // Both sources ran and disagree in the one direction that matters: something IS
    // accepting on the port. Calling that "free" is what would certify a release
    // that never happened.
    //
    // The REASON is asserted, not just the state: this wording is reachable only
    // when the kernel table positively reported a listener. The same lsof output
    // with /proc unread yields "listed no owner and did not report an empty
    // search" — so this pins that the kernel evidence actually reached the verdict.
    const { probePortOwner, __portOwnerTestHooks } = await loadProbe();
    __portOwnerTestHooks.setProcNetReader((t) =>
      t === "/proc/net/tcp" ? table(8188) : emptyTable(t),
    );
    mockExecSync.mockReturnValue("");

    const probe = probePortOwner(8188);
    expect(probe.state).toBe("unknown");
    expect(probe).toMatchObject({ reason: expect.stringMatching(/socket is listening/i) });
  });

  it("reads tcp6 when only that table is available — a REAL 32-hex-digit row", async () => {
    // End-to-end IPv6: the kernel row carries a 32-hex-digit address and lsof
    // reports the listener in its bracketed form, both exactly as captured from a
    // live `::1` listener.
    const { probePortOwner, __portOwnerTestHooks } = await loadProbe();
    const reader = vi.fn((t: string) => {
      if (t === "/proc/net/tcp6") return table6(8188);
      throw enoent();
    });
    __portOwnerTestHooks.setProcNetReader(reader);
    mockExecSync.mockReturnValue("p4321\nn[::1]:8188\n");

    expect(probePortOwner(8188)).toEqual({ state: "owned", pid: 4321 });
    expect(reader).toHaveBeenCalledWith("/proc/net/tcp6");
  });

  it("an IPv6-only listener is seen even when the IPv4 table is clean", async () => {
    // The reason a negative needs BOTH tables: nothing is on IPv4, the listener is
    // on IPv6, and only reading tcp6 reveals it. Reported as a kernel positive, so
    // lsof's inability to name it can never downgrade this to free.
    const { probePortOwner, __portOwnerTestHooks } = await loadProbe();
    __portOwnerTestHooks.setProcNetReader((t) =>
      t === "/proc/net/tcp" ? table(9999) : table6(8188),
    );
    mockExecSync.mockImplementation(() => {
      const err = exitWith(1) as Error & { status: number; stdout: string };
      err.stdout = "lsof: Internet address not located: TCP:8188";
      throw err;
    });

    const probe = probePortOwner(8188);
    expect(probe.state).toBe("unknown");
    expect(probe).toMatchObject({
      reason: expect.stringMatching(/socket is listening/i),
    });
  });

  it("a PARTIAL read is not a negative — an unreadable tcp6 may hold the listener", async () => {
    // IPv4 has no row for the port and the IPv6 table cannot be opened. That is
    // "I did not finish looking", not "nothing is listening": an IPv6 listener may
    // still hold the port. Short-circuiting to `free` here would certify a release
    // that never happened, so the verdict must fall through to lsof.
    const { probePortOwner, __portOwnerTestHooks } = await loadProbe();
    __portOwnerTestHooks.setProcNetReader((t) => {
      if (t === "/proc/net/tcp") return table(9999);
      throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    });
    mockExecSync.mockReturnValue("p4321\nn127.0.0.1:8188\n");

    expect(probePortOwner(8188)).toEqual({ state: "owned", pid: 4321 });
    expect(mockExecSync).toHaveBeenCalled();
  });

  it("a PARTIAL read plus an lsof that cannot look is UNKNOWN, never free", async () => {
    const { probePortOwner, __portOwnerTestHooks } = await loadProbe();
    __portOwnerTestHooks.setProcNetReader((t) => {
      if (t === "/proc/net/tcp") return table(9999);
      throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    });
    mockExecSync.mockImplementation(() => {
      throw exitWith(1);
    });

    expect(probePortOwner(8188).state).toBe("unknown");
  });

  it("lsof STATING absence does NOT override a listener the kernel can see (error path)", async () => {
    // The unprivileged case: /proc sees the socket, lsof cannot enumerate it and
    // exits 1 with its `-V` "Internet address not located" marker. Believing lsof
    // would make waitForPortFree report a release while the socket is still bound.
    // The weaker source's negative must not beat the stronger source's positive.
    const { probePortOwner, __portOwnerTestHooks } = await loadProbe();
    __portOwnerTestHooks.setProcNetReader((t) =>
      t === "/proc/net/tcp" ? table(8188) : emptyTable(t),
    );
    mockExecSync.mockImplementation(() => {
      const err = exitWith(1) as Error & { status: number; stdout: string };
      err.stdout = "lsof: Internet address not located: TCP:8188";
      throw err;
    });

    const probe = probePortOwner(8188);
    expect(probe.state).toBe("unknown");
    expect(probe).toMatchObject({
      reason: expect.stringMatching(/socket is listening/i),
    });
  });

  it("lsof STATING absence does NOT override a listener the kernel can see (exit-0 path)", async () => {
    // Same rule on the branch where lsof exits 0 and prints the marker.
    const { probePortOwner, __portOwnerTestHooks } = await loadProbe();
    __portOwnerTestHooks.setProcNetReader((t) =>
      t === "/proc/net/tcp" ? table(8188) : emptyTable(t),
    );
    mockExecSync.mockReturnValue("lsof: Internet address not located: TCP:8188");

    expect(probePortOwner(8188).state).toBe("unknown");
  });

  it("a PARTIAL read plus lsof's -V absence marker is UNKNOWN, never free", async () => {
    // The blind spots COMPOSE: tcp6 is unreadable, and an unprivileged lsof cannot
    // enumerate another user's socket either — it reports exactly this marker while
    // being unable to see. Neither source can rule out an IPv6 listener, so the
    // marker must not be spent as proof of release against the table we could not
    // finish reading.
    const { probePortOwner, __portOwnerTestHooks } = await loadProbe();
    __portOwnerTestHooks.setProcNetReader((t) => {
      if (t === "/proc/net/tcp") return table(9999);
      throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    });
    mockExecSync.mockImplementation(() => {
      const err = exitWith(1) as Error & { status: number; stdout: string };
      err.stdout = "lsof: Internet address not located: TCP:8188";
      throw err;
    });

    const probe = probePortOwner(8188);
    expect(probe.state).toBe("unknown");
    expect(probe).toMatchObject({
      reason: expect.stringMatching(/could not be read in full/i),
    });
  });

  it("an UNPARSEABLE row makes the table incomplete, not a clean negative", async () => {
    // A truncated/garbled row is a row we cannot rule out. Skipping it and then
    // reporting "no listener found" would certify free on a table we did not fully
    // understand — so the read is incomplete and lsof's absence cannot settle it.
    const { probePortOwner, __portOwnerTestHooks } = await loadProbe();
    __portOwnerTestHooks.setProcNetReader((t) => {
      if (t === "/proc/net/tcp") {
        return [HEADER_V4, "   0: 0100007F", ""].join("\n");
      }
      return emptyTable(t);
    });
    mockExecSync.mockImplementation(() => {
      const err = exitWith(1) as Error & { status: number; stdout: string };
      err.stdout = "lsof: Internet address not located: TCP:8188";
      throw err;
    });

    expect(probePortOwner(8188).state).toBe("unknown");
  });

  it("the single terminating newline is structure, not damage", async () => {
    // The guard on the rule above: /proc tables end with a newline, so the blank
    // final split element must stay an ordinary clean negative. Otherwise EVERY read
    // would degrade to "incomplete" and no port could ever be certified free.
    const { probePortOwner, __portOwnerTestHooks } = await loadProbe();
    __portOwnerTestHooks.setProcNetReader((t) =>
      t === "/proc/net/tcp" ? table(9999) : emptyTable(t),
    );

    expect(probePortOwner(8188)).toEqual({ state: "free" });
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  it("an INTERIOR blank line is an empty record the kernel never wrote", async () => {
    // The kernel emits exactly one non-empty line per entry, so a gap between rows is
    // not "nothing was there" — it is a record that went missing. Only the final
    // split element may be blank.
    const { probePortOwner, __portOwnerTestHooks } = await loadProbe();
    const row = (slot: number, port: number): string => {
      const hexPort = port.toString(16).toUpperCase().padStart(4, "0");
      return `   ${slot}: 0100007F:${hexPort} 00000000:0000 01 00000000:00000000 00:00000000 00000000  1000        0 5432${slot} 1`;
    };
    __portOwnerTestHooks.setProcNetReader((t) =>
      t === "/proc/net/tcp"
        ? `${HEADER_V4}\n${row(0, 9998)}\n\n${row(1, 9999)}\n`
        : emptyTable(t),
    );
    mockExecSync.mockImplementation(() => {
      const err = exitWith(1) as Error & { status: number; stdout: string };
      err.stdout = "lsof: Internet address not located: TCP:8188";
      throw err;
    });

    expect(probePortOwner(8188).state).toBe("unknown");
  });

  it("the HIGHEST state these tables print (0B, TCP_CLOSING) is accepted", async () => {
    // The boundary from the legitimate side — a bound has two ways to be wrong, and
    // rejecting real data is the one that fails silently rather than safely.
    const { probePortOwner, __portOwnerTestHooks } = await loadProbe();
    __portOwnerTestHooks.setProcNetReader((t) =>
      t === "/proc/net/tcp"
        ? `${HEADER_V4}\n   0: 0100007F:270F 00000000:0000 0B 00000000:00000000 00:00000000 00000000  1000        0 54321 1\n`
        : emptyTable(t),
    );

    expect(probePortOwner(8188)).toEqual({ state: "free" });
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  // The two enum values ABOVE the printable range. Both are real states; neither
  // reaches this column, so both are damage here rather than sockets.
  for (const [state, why] of [
    ["0C", "TCP_NEW_SYN_RECV — a request socket prints as SYN_RECV (03) instead"],
    ["0D", "TCP_BOUND_INACTIVE — an inet_diag pseudo-state; these files never bind-walk"],
  ] as const) {
    it(`${state} is never printed here (${why})`, async () => {
      const { probePortOwner, __portOwnerTestHooks } = await loadProbe();
      __portOwnerTestHooks.setProcNetReader((t) =>
        t === "/proc/net/tcp"
          ? `${HEADER_V4}\n   0: 0100007F:270F 00000000:0000 ${state} 00000000:00000000 00:00000000 00000000  1000        0 54321 1\n`
          : emptyTable(t),
      );
      mockExecSync.mockImplementation(() => {
        const err = exitWith(1) as Error & { status: number; stdout: string };
        err.stdout = "lsof: Internet address not located: TCP:8188";
        throw err;
      });

      expect(probePortOwner(8188).state).toBe("unknown");
    });
  }

  it("an IMPOSSIBLE TCP state is not a socket we may reason about", async () => {
    // The state enum is bounded and starts at 1. `FF` is two valid hex digits and no
    // kernel state at all, so a row carrying it cannot help certify free.
    const { probePortOwner, __portOwnerTestHooks } = await loadProbe();
    __portOwnerTestHooks.setProcNetReader((t) =>
      t === "/proc/net/tcp"
        ? `${HEADER_V4}\n   0: 0100007F:270F 00000000:0000 FF 00000000:00000000 00:00000000 00000000  1000        0 54321 1\n`
        : emptyTable(t),
    );
    mockExecSync.mockImplementation(() => {
      const err = exitWith(1) as Error & { status: number; stdout: string };
      err.stdout = "lsof: Internet address not located: TCP:8188";
      throw err;
    });

    expect(probePortOwner(8188).state).toBe("unknown");
  });

  // A row's endpoint width is fixed by the table it appears in — one 32-bit word for
  // IPv4, four for IPv6 — so an IPv4-width row inside tcp6 is impossible. It must
  // fabricate neither a listener (`0A`) nor a clean negative (`01`).
  for (const [state, label] of [
    ["0A", "a listener"],
    ["01", "a clean negative"],
  ] as const) {
    it(`an IPv4-width row inside tcp6 cannot produce ${label}`, async () => {
      const { probePortOwner, __portOwnerTestHooks } = await loadProbe();
      const hexPort = (8188).toString(16).toUpperCase().padStart(4, "0");
      __portOwnerTestHooks.setProcNetReader((t) =>
        t === "/proc/net/tcp6"
          ? `${HEADER_V6}\n   0: 0100007F:${hexPort} 00000000:0000 ${state} 00000000:00000000 00:00000000 00000000  1000        0 54321 1\n`
          : emptyTable(t),
      );
      mockExecSync.mockImplementation(() => {
        const err = exitWith(1) as Error & { status: number; stdout: string };
        err.stdout = "lsof: Internet address not located: TCP:8188";
        throw err;
      });

      const probe = probePortOwner(8188);
      expect(probe.state).toBe("unknown");
      expect(probe).toMatchObject({
        reason: expect.stringMatching(/could not be read in full/i),
      });
    });
  }

  it("BOTH tables EACCES plus lsof's marker is UNKNOWN — unreadable is not absent", async () => {
    // A restricted Linux container: /proc/net exists but neither table can be
    // opened, and the same lack of privilege is why lsof reports nothing. "Every
    // read failed" is NOT evidence the source is absent — the two blind spots are
    // the same blind spot, and certifying free here is the exact fold this rule
    // exists to reject. Distinguished from macOS purely by the errno.
    const { probePortOwner, __portOwnerTestHooks } = await loadProbe();
    __portOwnerTestHooks.setProcNetReader(() => {
      throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    });
    mockExecSync.mockImplementation(() => {
      const err = exitWith(1) as Error & { status: number; stdout: string };
      err.stdout = "lsof: Internet address not located: TCP:8188";
      throw err;
    });

    expect(probePortOwner(8188).state).toBe("unknown");
  });

  // Only a pathname that resolves to nothing proves absence. These two describe a
  // failed OPERATION, so they cannot rule out a listener in the table they failed
  // to read — they must behave like EACCES, not like ENOENT.
  for (const code of ["ENOSYS", "ENXIO"]) {
    it(`${code} on tcp6 is a blind spot, not an absent table`, async () => {
      const { probePortOwner, __portOwnerTestHooks } = await loadProbe();
      __portOwnerTestHooks.setProcNetReader((t) => {
        if (t === "/proc/net/tcp") return table(9999);
        throw Object.assign(new Error(code), { code });
      });
      mockExecSync.mockImplementation(() => {
        const err = exitWith(1) as Error & { status: number; stdout: string };
        err.stdout = "lsof: Internet address not located: TCP:8188";
        throw err;
      });

      expect(probePortOwner(8188).state).toBe("unknown");
    });
  }

  it("a table TRUNCATED after its header is not a clean negative", async () => {
    // "The header parsed" is not "the body was read". A header cut short — here to
    // just `sl local_address` — with no rows after it looks, by row count alone,
    // exactly like an idle table. Requiring the COMPLETE header (through its final
    // `inode` column) is what tells them apart: a truncated one is not a header, so
    // it counts as damage and the read is incomplete.
    const { probePortOwner, __portOwnerTestHooks } = await loadProbe();
    __portOwnerTestHooks.setProcNetReader((t) =>
      t === "/proc/net/tcp" ? "  sl  local_address\n" : emptyTable(t),
    );
    mockExecSync.mockImplementation(() => {
      const err = exitWith(1) as Error & { status: number; stdout: string };
      err.stdout = "lsof: Internet address not located: TCP:8188";
      throw err;
    });

    expect(probePortOwner(8188).state).toBe("unknown");
  });

  it("a header missing its MIDDLE columns is truncation one level in", async () => {
    // Pinning only the two ends and allowing anything between would accept this:
    // the first two column names and the last, with every intervening column gone.
    // That is the same truncation, just not at the tail, so the whole column
    // sequence has to be spelled out.
    const { probePortOwner, __portOwnerTestHooks } = await loadProbe();
    __portOwnerTestHooks.setProcNetReader((t) =>
      t === "/proc/net/tcp" ? "  sl  local_address rem_address inode\n" : emptyTable(t),
    );
    mockExecSync.mockImplementation(() => {
      const err = exitWith(1) as Error & { status: number; stdout: string };
      err.stdout = "lsof: Internet address not located: TCP:8188";
      throw err;
    });

    expect(probePortOwner(8188).state).toBe("unknown");
  });

  it("a ROW truncated after `st` is damage, however well-formed its prefix", async () => {
    // The same truncation as the header case, in the body. Four valid leading tokens
    // is a valid PREFIX, not a complete row: EOF may have cut this row short and
    // taken later listener rows with it. Validating through `inode` is what makes a
    // partial read fail to look like a clean "nothing is listening".
    const { probePortOwner, __portOwnerTestHooks } = await loadProbe();
    __portOwnerTestHooks.setProcNetReader((t) =>
      t === "/proc/net/tcp"
        ? `${HEADER_V4}\n   0: 0100007F:270F 00000000:0000 01\n`
        : emptyTable(t),
    );
    mockExecSync.mockImplementation(() => {
      const err = exitWith(1) as Error & { status: number; stdout: string };
      err.stdout = "lsof: Internet address not located: TCP:8188";
      throw err;
    });

    expect(probePortOwner(8188).state).toBe("unknown");
  });

  it("a row truncated AFTER its state still proves the LISTENER it showed", async () => {
    // The asymmetry pointed at the case that nearly inverted it. This row is cut off
    // short of `inode`, so it cannot support a negative — but its local endpoint and
    // its LISTEN state are both intact and visible. Truncation after the state
    // cannot unmake what precedes it, so this is a positive observation.
    //
    // lsof is given its absence marker, so the two candidate verdicts differ only in
    // REASON: "a socket is listening" (the positive was extracted) versus "could not
    // be read in full" (the completeness gate swallowed it). Asserting the state
    // alone would pass either way.
    const { probePortOwner, __portOwnerTestHooks } = await loadProbe();
    const hexPort = (8188).toString(16).toUpperCase().padStart(4, "0");
    __portOwnerTestHooks.setProcNetReader((t) =>
      t === "/proc/net/tcp"
        ? `${HEADER_V4}\n   0: 0100007F:${hexPort} 00000000:0000 0A\n`
        : emptyTable(t),
    );
    mockExecSync.mockImplementation(() => {
      const err = exitWith(1) as Error & { status: number; stdout: string };
      err.stdout = "lsof: Internet address not located: TCP:8188";
      throw err;
    });

    const probe = probePortOwner(8188);
    expect(probe.state).toBe("unknown");
    expect(probe).toMatchObject({
      reason: expect.stringMatching(/socket is listening/i),
    });
  });

  it("a GARBLED row cannot fabricate a listener from two intact fields", async () => {
    // The positive-first rule pointed at its own risk. `cols[1]` and `cols[3]` here
    // are individually well-shaped and say "LISTEN on 8188", but the slot and the
    // remote endpoint around them are junk — these are bytes we have every reason to
    // distrust, and untrustworthy input must not become a definite finding in EITHER
    // direction. This must read as damage, not as a listener.
    const { probePortOwner, __portOwnerTestHooks } = await loadProbe();
    const hexPort = (8188).toString(16).toUpperCase().padStart(4, "0");
    __portOwnerTestHooks.setProcNetReader((t) =>
      t === "/proc/net/tcp"
        ? `${HEADER_V4}\n   corrupt 0100007F:${hexPort} garbage 0A\n`
        : emptyTable(t),
    );
    mockExecSync.mockImplementation(() => {
      const err = exitWith(1) as Error & { status: number; stdout: string };
      err.stdout = "lsof: Internet address not located: TCP:8188";
      throw err;
    });

    const probe = probePortOwner(8188);
    expect(probe.state).toBe("unknown");
    expect(probe).toMatchObject({
      reason: expect.stringMatching(/could not be read in full/i),
    });
  });

  it("mismatched address FAMILIES are a row no kernel wrote", async () => {
    // Every token here is individually well-shaped, but an IPv4 local endpoint beside
    // an IPv6 remote one cannot occur in a single table. Four valid tokens is not the
    // same as a valid row, in either direction: this must not read as a listener, and
    // with state `01` it must not help certify free either.
    const { probePortOwner, __portOwnerTestHooks } = await loadProbe();
    const hexPort = (8188).toString(16).toUpperCase().padStart(4, "0");
    __portOwnerTestHooks.setProcNetReader((t) =>
      t === "/proc/net/tcp"
        ? `${HEADER_V4}\n   0: 0100007F:${hexPort} 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 54321 1\n`
        : emptyTable(t),
    );
    mockExecSync.mockImplementation(() => {
      const err = exitWith(1) as Error & { status: number; stdout: string };
      err.stdout = "lsof: Internet address not located: TCP:8188";
      throw err;
    });

    const probe = probePortOwner(8188);
    expect(probe.state).toBe("unknown");
    expect(probe).toMatchObject({
      reason: expect.stringMatching(/could not be read in full/i),
    });
  });

  it("a LISTEN row with a PEER is not a listener", async () => {
    // A listening socket has no peer — its remote endpoint is all zeros on port 0.
    // A row claiming state `0A` while naming a peer is self-contradictory, so it is
    // damage rather than a listener we may report.
    const { probePortOwner, __portOwnerTestHooks } = await loadProbe();
    const hexPort = (8188).toString(16).toUpperCase().padStart(4, "0");
    __portOwnerTestHooks.setProcNetReader((t) =>
      t === "/proc/net/tcp"
        ? `${HEADER_V4}\n   0: 0100007F:${hexPort} 0200007F:1F90 0A 00000000:00000000 00:00000000 00000000  1000        0 54321 1\n`
        : emptyTable(t),
    );
    mockExecSync.mockImplementation(() => {
      const err = exitWith(1) as Error & { status: number; stdout: string };
      err.stdout = "lsof: Internet address not located: TCP:8188";
      throw err;
    });

    const probe = probePortOwner(8188);
    expect(probe.state).toBe("unknown");
    expect(probe).toMatchObject({
      reason: expect.stringMatching(/could not be read in full/i),
    });
  });

  it("a table that does not OPEN with its header cannot support a negative", async () => {
    // A leading blank line, then a perfectly good header. The contract is that a real
    // table OPENS with its header; "somewhere after some blank lines" is not that,
    // and whatever stood before it is exactly what we cannot see.
    const { probePortOwner, __portOwnerTestHooks } = await loadProbe();
    __portOwnerTestHooks.setProcNetReader((t) =>
      t === "/proc/net/tcp" ? `\n${HEADER_V4}\n` : emptyTable(t),
    );
    mockExecSync.mockImplementation(() => {
      const err = exitWith(1) as Error & { status: number; stdout: string };
      err.stdout = "lsof: Internet address not located: TCP:8188";
      throw err;
    });

    expect(probePortOwner(8188).state).toBe("unknown");
  });

  it("a row standing BEFORE the header cannot support a negative either", async () => {
    // The same contract from the other side: the header is not merely present, it is
    // where the table begins. A row above it means rows above THAT may be missing.
    const { probePortOwner, __portOwnerTestHooks } = await loadProbe();
    __portOwnerTestHooks.setProcNetReader((t) =>
      t === "/proc/net/tcp"
        ? `   0: 0100007F:270F 00000000:0000 01 00000000:00000000 00:00000000 00000000  1000        0 54321 1\n${HEADER_V4}\n`
        : emptyTable(t),
    );
    mockExecSync.mockImplementation(() => {
      const err = exitWith(1) as Error & { status: number; stdout: string };
      err.stdout = "lsof: Internet address not located: TCP:8188";
      throw err;
    });

    expect(probePortOwner(8188).state).toBe("unknown");
  });

  it("a table that comes back as NOTHING is damage, not an idle table", async () => {
    // The extreme of the same truncation: zero bytes. A real table always carries at
    // least its header, so recognising neither a header nor a single row means we
    // did not read the table, whatever the read returned.
    const { probePortOwner, __portOwnerTestHooks } = await loadProbe();
    __portOwnerTestHooks.setProcNetReader((t) =>
      t === "/proc/net/tcp" ? "" : emptyTable(t),
    );
    mockExecSync.mockImplementation(() => {
      const err = exitWith(1) as Error & { status: number; stdout: string };
      err.stdout = "lsof: Internet address not located: TCP:8188";
      throw err;
    });

    expect(probePortOwner(8188).state).toBe("unknown");
  });

  it("a legitimately EMPTY table — header, no sockets — is still FREE", async () => {
    // The other direction, and the constraint that makes this subtle: an idle Linux
    // host serves a header and zero rows. That must remain a decisive negative and
    // answer WITHOUT lsof, or every idle host burns its whole release budget on
    // every stop — the same always-unknown failure the macOS split exists to avoid.
    const { probePortOwner, __portOwnerTestHooks } = await loadProbe();
    __portOwnerTestHooks.setProcNetReader((t) => emptyTable(t));

    expect(probePortOwner(8188)).toEqual({ state: "free" });
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  it("an IPv4-form header over tcp6 is a table we did not really read", async () => {
    // `rem_address` and `remote_address` are not interchangeable: the IPv4 spelling
    // standing over /proc/net/tcp6 means what came back is not that table, so it
    // cannot be certified idle.
    const { probePortOwner, __portOwnerTestHooks } = await loadProbe();
    __portOwnerTestHooks.setProcNetReader((t) =>
      t === "/proc/net/tcp6" ? `${HEADER_V4}\n` : emptyTable(t),
    );
    mockExecSync.mockImplementation(() => {
      const err = exitWith(1) as Error & { status: number; stdout: string };
      err.stdout = "lsof: Internet address not located: TCP:8188";
      throw err;
    });

    expect(probePortOwner(8188).state).toBe("unknown");
  });

  it("a damaged row that merely MENTIONS local_address is not the header", async () => {
    // The header is recognised by its anchored shape. A garbled row that happens to
    // contain the word must still count as damage, or the skip becomes a hole in
    // the "every unparseable row is incomplete" rule.
    const { probePortOwner, __portOwnerTestHooks } = await loadProbe();
    __portOwnerTestHooks.setProcNetReader((t) => {
      if (t === "/proc/net/tcp") {
        return [
          HEADER_V4,
          "   0: corrupted local_address garbage",
          "",
        ].join("\n");
      }
      return emptyTable(t);
    });
    mockExecSync.mockImplementation(() => {
      const err = exitWith(1) as Error & { status: number; stdout: string };
      err.stdout = "lsof: Internet address not located: TCP:8188";
      throw err;
    });

    expect(probePortOwner(8188).state).toBe("unknown");
  });

  // The counterweight to the blind-spot rule: a pathname that resolves to nothing
  // proves the table does not exist (a Linux kernel without IPv6 has no tcp6), so
  // the IPv4 read alone is a COMPLETE answer and the port is free without consulting
  // lsof. Treating this as a blind spot would cost every such host its fast path.
  // Both codes in the absent set are driven, so dropping either is a test failure.
  for (const code of ["ENOENT", "ENOTDIR"]) {
    it(`an ABSENT tcp6 table (${code}) still allows a clean negative`, async () => {
      const { probePortOwner, __portOwnerTestHooks } = await loadProbe();
      __portOwnerTestHooks.setProcNetReader((t) => {
        if (t === "/proc/net/tcp") return table(9999);
        throw Object.assign(new Error(code), { code });
      });

      expect(probePortOwner(8188)).toEqual({ state: "free" });
      expect(mockExecSync).not.toHaveBeenCalled();
    });
  }

  it("a row with four columns but a GARBLED endpoint is damage, not a clean skip", async () => {
    // `cols.length >= 4` is not "parsed". A row whose address/port is not hex, or
    // whose state is not a two-digit code, was silently skipped and the table then
    // reported "no listener" — certifying free on data we did not understand.
    const { probePortOwner, __portOwnerTestHooks } = await loadProbe();
    __portOwnerTestHooks.setProcNetReader((t) => {
      if (t === "/proc/net/tcp") {
        return [
          HEADER_V4,
          "   0: junk:ZZZZ garbage QQ 00000000:00000000",
          "",
        ].join("\n");
      }
      return emptyTable(t);
    });
    mockExecSync.mockImplementation(() => {
      const err = exitWith(1) as Error & { status: number; stdout: string };
      err.stdout = "lsof: Internet address not located: TCP:8188";
      throw err;
    });

    expect(probePortOwner(8188).state).toBe("unknown");
  });

  it("a headerless table cannot support a clean NEGATIVE", async () => {
    // A real table always opens with its header, so its absence means we did not see
    // where the table starts — rows before the point we picked it up may be gone.
    // A well-formed row proves only that the bytes we got were well-formed.
    const { probePortOwner, __portOwnerTestHooks } = await loadProbe();
    const hexPort = (9999).toString(16).toUpperCase().padStart(4, "0");
    __portOwnerTestHooks.setProcNetReader((t) =>
      t === "/proc/net/tcp"
        ? `   0: 0100007F:${hexPort} 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 54321 1\n`
        : emptyTable(t),
    );
    mockExecSync.mockImplementation(() => {
      const err = exitWith(1) as Error & { status: number; stdout: string };
      err.stdout = "lsof: Internet address not located: TCP:8188";
      throw err;
    });

    expect(probePortOwner(8188).state).toBe("unknown");
  });

  it("a GAP in the kernel's row counter means a record went missing", async () => {
    // Slots 0 and 2, with 1 absent. Every row here is individually well-formed and
    // the table has both boundaries — only the SEQUENCE shows that a record between
    // them is gone, and that record could have been the listener.
    const { probePortOwner, __portOwnerTestHooks } = await loadProbe();
    const row = (slot: number, port: number): string => {
      const hexPort = port.toString(16).toUpperCase().padStart(4, "0");
      return `   ${slot}: 0100007F:${hexPort} 00000000:0000 01 00000000:00000000 00:00000000 00000000  1000        0 5432${slot} 1`;
    };
    __portOwnerTestHooks.setProcNetReader((t) =>
      t === "/proc/net/tcp"
        ? `${HEADER_V4}\n${row(0, 9998)}\n${row(2, 9999)}\n`
        : emptyTable(t),
    );
    mockExecSync.mockImplementation(() => {
      const err = exitWith(1) as Error & { status: number; stdout: string };
      err.stdout = "lsof: Internet address not located: TCP:8188";
      throw err;
    });

    expect(probePortOwner(8188).state).toBe("unknown");
  });

  it("a first row numbered above 0 means the table was picked up mid-way", async () => {
    const { probePortOwner, __portOwnerTestHooks } = await loadProbe();
    __portOwnerTestHooks.setProcNetReader((t) =>
      t === "/proc/net/tcp"
        ? `${HEADER_V4}\n   1: 0100007F:270F 00000000:0000 01 00000000:00000000 00:00000000 00000000  1000        0 54321 1\n`
        : emptyTable(t),
    );
    mockExecSync.mockImplementation(() => {
      const err = exitWith(1) as Error & { status: number; stdout: string };
      err.stdout = "lsof: Internet address not located: TCP:8188";
      throw err;
    });

    expect(probePortOwner(8188).state).toBe("unknown");
  });

  it("consecutive slots are NOT damage — a normal multi-row table stays free", async () => {
    // The control for the two above: an ordinary busy host has many rows, and they
    // must read as a clean negative or no such host ever gets its fast path.
    const { probePortOwner, __portOwnerTestHooks } = await loadProbe();
    const row = (slot: number, port: number): string => {
      const hexPort = port.toString(16).toUpperCase().padStart(4, "0");
      return `   ${slot}: 0100007F:${hexPort} 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 5432${slot} 1`;
    };
    __portOwnerTestHooks.setProcNetReader((t) =>
      t === "/proc/net/tcp"
        ? `${HEADER_V4}\n${row(0, 9997)}\n${row(1, 9998)}\n${row(2, 9999)}\n`
        : emptyTable(t),
    );

    expect(probePortOwner(8188)).toEqual({ state: "free" });
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  it("a table whose FINAL NEWLINE is missing is truncated at its end", async () => {
    // The other boundary. A complete header and a well-formed non-matching row still
    // do not prove the table ended where the bytes did.
    const { probePortOwner, __portOwnerTestHooks } = await loadProbe();
    const hexPort = (9999).toString(16).toUpperCase().padStart(4, "0");
    __portOwnerTestHooks.setProcNetReader((t) =>
      t === "/proc/net/tcp"
        ? `${HEADER_V4}\n   0: 0100007F:${hexPort} 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 54321 1`
        : emptyTable(t),
    );
    mockExecSync.mockImplementation(() => {
      const err = exitWith(1) as Error & { status: number; stdout: string };
      err.stdout = "lsof: Internet address not located: TCP:8188";
      throw err;
    });

    expect(probePortOwner(8188).state).toBe("unknown");
  });

  it("a LISTEN row in a headerless table is a POSITIVE, not merely an incomplete read", async () => {
    // The asymmetry, pinned where it can actually be seen. lsof is given its absence
    // marker so it cannot name anyone, which makes the two candidate verdicts differ
    // only in their REASON: "a socket is listening" (the kernel positive survived the
    // incomplete read) versus "could not be read in full" (it did not). Asserting the
    // state alone would pass either way.
    const { probePortOwner, __portOwnerTestHooks } = await loadProbe();
    const hexPort = (8188).toString(16).toUpperCase().padStart(4, "0");
    __portOwnerTestHooks.setProcNetReader((t) =>
      t === "/proc/net/tcp"
        ? `   0: 0100007F:${hexPort} 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 54321 1\n`
        : emptyTable(t),
    );
    mockExecSync.mockImplementation(() => {
      const err = exitWith(1) as Error & { status: number; stdout: string };
      err.stdout = "lsof: Internet address not located: TCP:8188";
      throw err;
    });

    const probe = probePortOwner(8188);
    expect(probe.state).toBe("unknown");
    expect(probe).toMatchObject({
      reason: expect.stringMatching(/socket is listening/i),
    });
  });

  it("lsof STATING absence IS believed when there is no kernel table AT ALL (macOS)", async () => {
    // The positive control, and the reason "no source" and "blind spot" are kept
    // apart: on every non-Linux POSIX host /proc/net does not exist, so lsof is the
    // only evidence there has ever been. Gating `free` on a kernel negative alone
    // would leave macOS permanently unable to observe a release — the rule must not
    // have degraded every free verdict into "unknown".
    const { probePortOwner, __portOwnerTestHooks } = await loadProbe();
    __portOwnerTestHooks.setProcNetReader(() => {
      throw enoent();
    });
    mockExecSync.mockImplementation(() => {
      const err = exitWith(1) as Error & { status: number; stdout: string };
      err.stdout = "lsof: Internet address not located: TCP:8188";
      throw err;
    });

    expect(probePortOwner(8188)).toEqual({ state: "free" });
  });

  it("an ABSENT source leaves lsof as the only judge — and it IS consulted", async () => {
    // ENOENT is the ABSENT case, not the inaccessible one (EACCES has its own test
    // above): with no kernel table anywhere, lsof is the only evidence there is, so
    // it must actually be run. Asserting the call is what distinguishes this from
    // skipping the probe altogether. lsof here cannot look either — a bare exit 1 —
    // so "could not look" must not be spent as "nothing is listening".
    const { probePortOwner, __portOwnerTestHooks } = await loadProbe();
    __portOwnerTestHooks.setProcNetReader(() => {
      throw enoent();
    });
    mockExecSync.mockImplementation(() => {
      throw exitWith(1);
    });

    expect(probePortOwner(8188).state).toBe("unknown");
    expect(mockExecSync).toHaveBeenCalled();
    expect(String(mockExecSync.mock.calls[0][0])).toMatch(/lsof/);
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
