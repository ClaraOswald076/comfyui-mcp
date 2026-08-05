// Restart must act on the instance it READ, not on whatever the config names by
// the time each step runs.
//
// `restartViaManagerReboot` reads the serving argv, dispatches a Manager reboot,
// records the dispatch, and polls readiness. Every one of those steps used to
// call `getComfyUIBaseUrl()` afresh, so a retarget landing in the gaps could
// send the reboot to one server, record a second, and report the health of a
// third — with the argv comparison describing a fourth. Two concurrent agents on
// one rig is the ordinary way that happens, and it is in scope.
//
// The tests below move the target DURING the call, which is why the base and the
// generation are mutable here rather than the constants the sibling suites use.

import { describe, expect, it, beforeEach, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  remoteMode: { value: true },
  base: { value: "http://alpha.example:8188" },
  generation: { value: 0 },
  fetchMock: vi.fn(),
  resetClient: vi.fn(),
  resetObjectInfoCache: vi.fn(),
  getSystemStats: vi.fn(async () => ({ system: { argv: [] as string[] } })),
  execSync: vi.fn(() => ""),
  spawn: vi.fn(),
}));

/** Move the configured target, exactly as a concurrent retarget would. */
const retargetTo = (url: string): void => {
  hoisted.base.value = url;
  hoisted.generation.value += 1;
};

vi.mock("../../config.js", () => ({
  config: { resolvedPort: 8188, comfyuiPath: "/fake/comfy", comfyuiBasePath: "" },
  getComfyUIBaseUrl: () => hoisted.base.value,
  getComfyuiTargetGeneration: () => hoisted.generation.value,
  isRemoteMode: () => hoisted.remoteMode.value,
}));

vi.mock("../../comfyui/fetch.js", () => ({
  comfyuiFetch: (url: string, init?: RequestInit) => hoisted.fetchMock(url, init),
}));

vi.mock("../../comfyui/client.js", () => ({
  getSystemStats: hoisted.getSystemStats,
  resetClient: hoisted.resetClient,
  resetObjectInfoCache: hoisted.resetObjectInfoCache,
}));

vi.mock("node:child_process", () => ({
  execSync: hoisted.execSync,
  spawn: hoisted.spawn,
  execFile: vi.fn(),
}));

import {
  restartComfyUI,
  startComfyUI,
  __processControlTestHooks,
} from "../../services/process-control.js";

type FetchCall = [string, RequestInit | undefined];
const calls = (): FetchCall[] => hoisted.fetchMock.mock.calls as FetchCall[];
const hostsHit = (pathSuffix: string): string[] =>
  calls()
    .filter(([u]) => new URL(u).pathname.includes(pathSuffix))
    .map(([u]) => new URL(u).host);

beforeEach(() => {
  hoisted.remoteMode.value = true;
  hoisted.base.value = "http://alpha.example:8188";
  hoisted.generation.value = 0;
  hoisted.fetchMock.mockReset();
  hoisted.resetClient.mockClear();
  hoisted.resetObjectInfoCache.mockClear();
  hoisted.getSystemStats.mockReset();
  hoisted.getSystemStats.mockImplementation(async () => ({ system: { argv: [] as string[] } }));
  hoisted.execSync.mockReset();
  hoisted.execSync.mockImplementation(() => "");
  __processControlTestHooks.reset();
});

describe("restart anchors to the instance it read", () => {
  it("REFUSES without dispatching when the target moves between the argv read and the reboot", async () => {
    __processControlTestHooks.setRemoteRebootTimingForTests({
      settleMs: 0,
      budgetMs: 200,
      intervalMs: 5,
    });
    // The retarget lands DURING our own argv read — the one window the fence
    // exists for. Everything before the dispatch is observation, so refusing is
    // strictly right here: nothing has happened yet, and proceeding would reboot
    // a machine the caller never named.
    hoisted.getSystemStats.mockImplementation(async () => {
      retargetTo("http://beta.example:8188");
      return { system: { argv: [] as string[] } };
    });
    hoisted.fetchMock.mockImplementation(async () => new Response("{}", { status: 200 }));

    const res = await restartComfyUI();

    expect(hostsHit("/reboot")).toEqual([]); // nothing dispatched, anywhere
    expect(res.started).toBe(false);
    expect(res.startup).toBe("not-attempted");
    expect(res.message).toContain("target changed");
    // The reader must not take this for "the restart failed" — nothing was tried.
    expect(res.message).toContain("Nothing was restarted");
  });

  it("sends the reboot, the readiness probe, and nothing else to the ANCHORED host when the target moves mid-flight", async () => {
    __processControlTestHooks.setRemoteRebootTimingForTests({
      settleMs: 0,
      budgetMs: 500,
      intervalMs: 5,
    });
    hoisted.fetchMock.mockImplementation(async (url: string) => {
      const path = new URL(url).pathname;
      if (path.includes("/reboot")) {
        // The retarget lands while the reboot request is in flight — past the
        // fence, so this call is committed to alpha and must stay on it.
        retargetTo("http://beta.example:8188");
        return new Response("ok", { status: 200 });
      }
      return new Response(JSON.stringify({ system: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    await restartComfyUI();

    // A reboot posted to alpha whose success is then confirmed by a healthy beta
    // is the failure this pins: beta was never rebooted and its health says
    // nothing about alpha.
    expect(hostsHit("/reboot")).toEqual(["alpha.example:8188"]);
    expect(new Set(hostsHit("/system_stats"))).toEqual(new Set(["alpha.example:8188"]));
    expect(calls().map(([u]) => new URL(u).host)).not.toContain("beta.example:8188");
  });
});

describe("startComfyUI's remote-mode refusal is for a DIRECT launch, not a relaunch", () => {
  it("still refuses a direct start while targeting remote", async () => {
    // The other direction: the refusal is real and must not be lost. Without
    // this, dropping the check entirely would leave the sibling test green.
    await expect(startComfyUI()).rejects.toThrow(/not\s+available when targeting a remote/i);
  });

  it("does NOT refuse an ANCHORED relaunch, so a mid-stop retarget cannot strand a stopped instance", async () => {
    // A local restart stops the instance and then calls this. Refusing here left
    // it killed and abandoned, with the exception unwinding past every report —
    // the caller learned nothing about their now-dead server.
    hoisted.spawn.mockImplementation(() => {
      throw new Error("spawn refused by this test harness");
    });
    // It RESOLVES with a StartResult rather than throwing — which is the point:
    // past a committed stop, a describable outcome is the whole deliverable, and
    // an exception is the one shape that cannot be reported.
    const res = await startComfyUI({
      port: 8188,
      probeUrl: "http://alpha.example:8188/system_stats",
    });
    expect(res.message).not.toMatch(/targeting a remote/i);
  });
});
