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
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

  it("does NOT refuse when the target is REAFFIRMED to the same URL mid-read", async () => {
    // `setComfyuiTarget` bumps the generation on every successful call, including
    // a same-URL reaffirmation that moves nothing. Fencing on the generation
    // therefore refused a restart that was never in danger — this defect class
    // pointed the other way, a bucket ("the target was touched") standing in for
    // the question that matters ("is this the server whose argv I read?").
    __processControlTestHooks.setRemoteRebootTimingForTests({
      settleMs: 0,
      budgetMs: 500,
      intervalMs: 5,
    });
    hoisted.getSystemStats.mockImplementation(async () => {
      hoisted.generation.value += 1; // reaffirmed, NOT moved
      return { system: { argv: [] as string[] } };
    });
    hoisted.fetchMock.mockImplementation(async (url: string) =>
      new URL(url).pathname.includes("/reboot")
        ? new Response("ok", { status: 200 })
        : new Response(JSON.stringify({ system: {} }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
    );

    const res = await restartComfyUI();

    expect(hostsHit("/reboot")).toEqual(["alpha.example:8188"]);
    expect(res.message ?? "").not.toContain("target changed");
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

describe("a local restart never abandons the instance it stopped", () => {
  // Real on-disk paths: the restart REFUSES before stopping if the resolved
  // interpreter or script is missing, which is correct behaviour and would mask
  // the post-stop window this test is about.
  const PY = process.execPath;
  const MAIN = join(mkdtempSync(join(tmpdir(), "anchor-")), "main.py");
  writeFileSync(MAIN, "# placeholder");

  /** A live local server on 8188 that goes quiet once killed. */
  const liveThenFree = (pid = 4321): { killed: () => boolean } => {
    let killed = false;
    hoisted.execSync.mockImplementation((cmd: string) => {
      if (/taskkill|pkill|\bkill\b/i.test(cmd)) {
        killed = true;
        return "";
      }
      if (/netstat/i.test(cmd)) {
        return killed ? "" : `  TCP    0.0.0.0:8188   0.0.0.0:0   LISTENING       ${pid}`;
      }
      if (/lsof/i.test(cmd)) {
        if (killed) throw Object.assign(new Error("no listener"), { status: 1 });
        return `p${pid}\nn127.0.0.1:8188\n`;
      }
      return "";
    });
    return { killed: () => killed };
  };

  it("reports the stop honestly instead of throwing when another agent retargets to REMOTE mid-stop", async () => {
    // The P0 in full: the stop commits, then the relaunch used to hit the
    // remote-mode refusal and throw — unwinding past every report and leaving
    // the caller with an exception where the fact "your server is down" should
    // have been. This drives `restartComfyUI`, not the unit below it, so it
    // fails if the refusal is reinstated OR if the post-stop catch is removed
    // and something else throws past the same point.
    hoisted.remoteMode.value = false;
    hoisted.getSystemStats.mockResolvedValue({ system: { argv: [PY, MAIN, "--port", "8188"] } });
    const port = liveThenFree();
    __processControlTestHooks.setProcessIdentityResolver(() => ({
      startedAt: "stable-stamp",
      commandLine: `${PY} ${MAIN} --port 8188`,
      argv: [PY, MAIN, "--port", "8188"],
      argvFidelity: "exact" as const,
    }));
    __processControlTestHooks.setProcessExistsProbe(() => true);
    // The retarget lands during the post-stop window, exactly as a second agent
    // on this rig would do it.
    hoisted.spawn.mockImplementation(() => {
      hoisted.remoteMode.value = true;
      hoisted.base.value = "http://beta.example:8188";
      throw new Error("relaunch could not be spawned");
    });
    // Nothing is listening after the failed relaunch — the ordinary case.
    hoisted.fetchMock.mockImplementation(async () => {
      throw new Error("ECONNREFUSED");
    });

    // The whole assertion is that this RESOLVES. A rejection here is the bug.
    const res = await restartComfyUI();

    expect(port.killed()).toBe(true); // the stop really did happen
    expect(res.stopped).toBe(true); // ...and the report says so
    expect(res.started).toBe(false);
    // The relaunch WAS attempted and threw partway, so what we cannot say is
    // whether it took effect. "not-attempted" would be a different claim, and a
    // false one.
    expect(res.startup).toBe("unconfirmed");
    expect(res.message).toMatch(/relaunch failed partway/i);
    // NOT a bare "ComfyUI is NOT running": nothing answered when asked, which is
    // one observation, and this branch exists to stop exactly that becoming a
    // verdict. The wording must keep the two apart.
    expect(res.message).toMatch(/most likely down/i);
    expect(res.message).toMatch(/not a settled fact/i);
    // The one thing it must never say is the remote-mode refusal, which would be
    // a bucket narrated as the cause of a dead local server.
    expect(res.message).not.toMatch(/targeting a remote/i);
  });

  it("does NOT say nothing answered when the endpoint returns 503 — not healthy is not not-there", async () => {
    // `waitForApiReady` counts a 502/503/504 as not-ready, which is right for
    // readiness and wrong as evidence of absence. Reading `ready:false` as
    // "nothing is listening" is the same fold one level down: a proxy answering
    // 503 in front of a starting server would be reported as a dead machine.
    hoisted.remoteMode.value = false;
    hoisted.getSystemStats.mockResolvedValue({ system: { argv: [PY, MAIN, "--port", "8188"] } });
    liveThenFree();
    __processControlTestHooks.setProcessIdentityResolver(() => ({
      startedAt: "stable-stamp",
      commandLine: `${PY} ${MAIN} --port 8188`,
      argv: [PY, MAIN, "--port", "8188"],
      argvFidelity: "exact" as const,
    }));
    __processControlTestHooks.setProcessExistsProbe(() => true);
    hoisted.spawn.mockImplementation(() => {
      throw new Error("relaunch could not be spawned");
    });
    hoisted.fetchMock.mockImplementation(
      async () => new Response("service unavailable", { status: 503 }),
    );

    const res = await restartComfyUI();

    expect(res.startup).toBe("unconfirmed");
    expect(res.message).not.toMatch(/nothing answered/i);
    // It may still say "most likely down" — that is a hedge, not a claim — but it
    // must carry the caveat that something could be listening.
    expect(res.message).toMatch(/not "?not there"?|may well be listening/i);
  });

  it("does NOT report down when something IS answering after a failed relaunch", async () => {
    // The other half of the same finding: a supervisor may have brought the
    // instance back while we were unwinding, or the throw may have landed after
    // a spawn. Reporting "down" over a live server is the unverified negative in
    // its most misleading form — the user goes looking for a dead process.
    hoisted.remoteMode.value = false;
    hoisted.getSystemStats.mockResolvedValue({ system: { argv: [PY, MAIN, "--port", "8188"] } });
    liveThenFree();
    __processControlTestHooks.setProcessIdentityResolver(() => ({
      startedAt: "stable-stamp",
      commandLine: `${PY} ${MAIN} --port 8188`,
      argv: [PY, MAIN, "--port", "8188"],
      argvFidelity: "exact" as const,
    }));
    __processControlTestHooks.setProcessExistsProbe(() => true);
    hoisted.spawn.mockImplementation(() => {
      throw new Error("relaunch could not be spawned");
    });
    // The post-failure probe finds a live server.
    hoisted.fetchMock.mockImplementation(
      async () =>
        new Response(JSON.stringify({ system: {} }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    const res = await restartComfyUI();

    expect(res.startup).toBe("unconfirmed");
    expect(res.message).toMatch(/IS answering/i);
    expect(res.message).not.toMatch(/most likely down/i);
    // And it must not claim that server either — this call did not start it.
    expect(res.started).toBe(false);
    expect(res.message).toMatch(/cannot claim that server as its own/i);
  });
});
