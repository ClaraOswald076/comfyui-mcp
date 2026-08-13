// #742 (the 2026-08-12 recurrence) — the restart guard decided "not ours" from
// "not loopback", and those are different questions.
//
// A Pinokio ComfyUI on the SAME machine, addressed through that machine's own
// LAN address (`COMFYUI_URL=http://192.168.x.x:5000`), classified as remote.
// `preflightLocalRestart` opens with `if (isRemoteMode()) return { ok: true }`,
// so the refuse-safe check waved it through without assessing anything; the
// Manager reboot stopped the server, and Pinokio only relaunches on the
// dependency-install message, so it stayed down. The user's session was
// unrecoverable until they started Pinokio by hand.
//
// The original report's parts 1 and 2 (a misleading "Cancelled", and no
// failed-relaunch detection) were fixed, and the refuse-safe preflight already
// exists with its own suite. Nothing was missing. The guard was UNREACHABLE for
// this target — which is why these tests are about the classification, not the
// guard.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// One fake NIC set for every test: a real-looking LAN address, a loopback pair,
// and a link-local v6 with the zone suffix `networkInterfaces()` omits but URLs
// carry.
const FAKE_IFACES = {
  Ethernet: [
    { address: "192.168.1.179", family: "IPv4", internal: false },
    { address: "fe80::5f10:6918:84e6:1873", family: "IPv6", internal: false },
    { address: "2600:1700:5892:bc10::22", family: "IPv6", internal: false },
  ],
  "Loopback Pseudo-Interface 1": [
    { address: "127.0.0.1", family: "IPv4", internal: true },
    { address: "::1", family: "IPv6", internal: true },
  ],
  "vEthernet (Default Switch)": [{ address: "172.30.64.1", family: "IPv4", internal: false }],
  // A down/unconfigured adapter reporting an empty address. Present so the
  // empty-host guard is OBSERVABLE: without it, any host that normalizes to ""
  // would match this entry and be called ours.
  "Bluetooth Network Connection": [{ address: "", family: "IPv4", internal: false }],
};

let ifacesThrow = false;

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const networkInterfaces = () => {
    if (ifacesThrow) throw new Error("EPERM: locked-down container");
    return FAKE_IFACES as unknown as ReturnType<typeof actual.networkInterfaces>;
  };
  return { ...actual, networkInterfaces, default: { ...actual, networkInterfaces } };
});

const OLD_ENV = process.env;
const OLD_ARGV = process.argv;

beforeEach(() => {
  ifacesThrow = false;
  vi.resetModules();
  process.env = { ...OLD_ENV };
  delete process.env.COMFYUI_URL;
  delete process.env.COMFYUI_MCP_FORCE_REMOTE;
  process.argv = ["node", "cli"];
});

afterEach(() => {
  process.env = OLD_ENV;
  process.argv = OLD_ARGV;
  vi.resetModules();
});

async function loadConfig() {
  return await import("../config.js");
}

describe("isOwnHostAddress — loopback is a SUBSET of 'this machine' (#742)", () => {
  it("accepts the loopback names it always did", async () => {
    const { isOwnHostAddress } = await loadConfig();
    for (const h of ["127.0.0.1", "localhost", "::1", "[::1]", "0.0.0.0"]) {
      expect(isOwnHostAddress(h), h).toBe(true);
    }
  });

  it("accepts THIS machine's own LAN address — the case that caused the loss", async () => {
    const { isOwnHostAddress, isLoopbackHost } = await loadConfig();
    // The precise gap: not loopback, but unquestionably this machine.
    expect(isLoopbackHost("192.168.1.179")).toBe(false);
    expect(isOwnHostAddress("192.168.1.179")).toBe(true);
  });

  it("accepts an own IPv6 address, bracketed and with a zone suffix", async () => {
    const { isOwnHostAddress } = await loadConfig();
    expect(isOwnHostAddress("[2600:1700:5892:bc10::22]")).toBe(true);
    // A URL can carry `%eth0`; networkInterfaces() reports the address without it.
    expect(isOwnHostAddress("fe80::5f10:6918:84e6:1873%eth0")).toBe(true);
  });

  it("rejects a LAN address on the same subnet that is NOT ours", async () => {
    // The neighbouring machine. Refusing here is what keeps this from becoming a
    // guard that fires on other people's servers.
    const { isOwnHostAddress } = await loadConfig();
    expect(isOwnHostAddress("192.168.1.180")).toBe(false);
    expect(isOwnHostAddress("10.0.0.5")).toBe(false);
  });

  it("rejects a HOSTNAME, even one that would resolve to us", async () => {
    // Deliberate: resolving would mean DNS on a path that must not block, and a
    // name can resolve differently — or be made to — between this check and the
    // action it authorizes. This gates a REFUSAL, so "cannot prove" must mean
    // "leave today's behaviour alone".
    const { isOwnHostAddress } = await loadConfig();
    for (const h of ["my-desktop.local", "comfy.lan", "example.com"]) {
      expect(isOwnHostAddress(h), h).toBe(false);
    }
  });

  it("rejects rather than throws when interfaces cannot be enumerated", async () => {
    ifacesThrow = true;
    const { isOwnHostAddress } = await loadConfig();
    expect(isOwnHostAddress("192.168.1.179")).toBe(false);
    // Loopback is decided without touching the interface list at all.
    expect(isOwnHostAddress("127.0.0.1")).toBe(true);
  });

  it("rejects a host that normalizes to nothing, even against an empty interface address", async () => {
    // `[]` and `%eth0` both normalize to "" while NOT being loopback, so they
    // reach the comparison. An adapter reporting an empty address would then
    // match them. This is what makes the empty-host guard load-bearing rather
    // than decorative — remove it and these become true.
    const { isOwnHostAddress } = await loadConfig();
    expect(isOwnHostAddress("[]")).toBe(false);
    expect(isOwnHostAddress("%eth0")).toBe(false);
  });

  it("rejects addresses that merely look like ours", async () => {
    // No DNS and no range logic — plain equality against what the interfaces
    // report. A malformed or near-miss address simply fails to match.
    const { isOwnHostAddress } = await loadConfig();
    expect(isOwnHostAddress("999.1.1.1")).toBe(false);
    expect(isOwnHostAddress("192.168.1")).toBe(false);
    expect(isOwnHostAddress("192.168.1.17")).toBe(false); // prefix of ours
  });
});

describe("targetIsOnThisMachine — the classification vs the physical fact (#742)", () => {
  it("is TRUE for a local install addressed by our own LAN address, while remote mode is also true", async () => {
    process.env.COMFYUI_URL = "http://192.168.1.179:5000";
    const { targetIsOnThisMachine, isRemoteMode } = await loadConfig();
    // Both hold at once. That combination IS the bug, and the preflight now
    // keys on the second rather than the first.
    expect(isRemoteMode()).toBe(true);
    expect(targetIsOnThisMachine()).toBe(true);
  });

  it("is FALSE for a genuinely remote host", async () => {
    process.env.COMFYUI_URL = "http://192.168.1.180:8188";
    const { targetIsOnThisMachine, isRemoteMode } = await loadConfig();
    expect(isRemoteMode()).toBe(true);
    expect(targetIsOnThisMachine()).toBe(false);
  });

  it("--force-remote WINS over our own address", async () => {
    // A tunnel or port-forward makes the address say "here" about an instance
    // that is elsewhere; the flag is the user saying so. An inference must not
    // overrule an explicit statement of intent.
    process.env.COMFYUI_URL = "http://192.168.1.179:5000";
    process.env.COMFYUI_MCP_FORCE_REMOTE = "1";
    const { targetIsOnThisMachine } = await loadConfig();
    expect(targetIsOnThisMachine()).toBe(false);
  });

  it("is TRUE for an ordinary loopback target, so the local path is unchanged", async () => {
    process.env.COMFYUI_URL = "http://127.0.0.1:8188";
    const { targetIsOnThisMachine } = await loadConfig();
    expect(targetIsOnThisMachine()).toBe(true);
  });
});
