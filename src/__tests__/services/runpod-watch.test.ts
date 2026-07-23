import { describe, expect, it, beforeEach, vi } from "vitest";

// Mock the RunPod client the watcher polls/acts on.
const getPodMock = vi.fn();
const stopPodMock = vi.fn();
const beatMock = vi.fn(() => true);
vi.mock("../../services/runpod-client.js", () => ({
  getPod: (...a: unknown[]) => getPodMock(...a),
  stopPod: (...a: unknown[]) => stopPodMock(...a),
  beatDeadman: (...a: unknown[]) => beatMock(...a),
  comfyuiPortExposed: (pod: { runtime?: { ports?: Array<{ privatePort: number; type: string }> } }) =>
    (pod.runtime?.ports ?? []).some((p) => p.privatePort === 8188 && p.type === "http"),
  runpodProxyUrl: (id: string) => `https://${id}-8188.proxy.runpod.net`,
}));

import { createRunpodWatcher, type RunpodStatusFrame } from "../../services/runpod-watch.js";

const runningPod = (over: Record<string, unknown> = {}) => ({
  id: "pod1",
  name: "c",
  desiredStatus: "RUNNING",
  costPerHr: 0.4,
  machine: { gpuDisplayName: "RTX 4090" },
  runtime: {
    uptimeInSeconds: 60,
    ports: [{ privatePort: 8188, type: "http", ip: "1", isIpPublic: true, publicPort: 8188 }],
    gpus: [{ id: "g", gpuUtilPercent: 5, memoryUtilPercent: 10 }],
  },
  ...over,
});

/** A controllable clock. */
function clock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("runpod-watch — status broadcast", () => {
  it("broadcasts a status frame for the watched pod (change-only)", async () => {
    getPodMock.mockResolvedValue(runningPod());
    const frames: RunpodStatusFrame[] = [];
    const w = createRunpodWatcher({ push: (f) => frames.push(f as RunpodStatusFrame), comfyuiIdle: () => false, renderingOnPod: () => true, idleStopMinutes: 0 });
    w.watch("pod1");
    await w.poll(); // watch() also kicks one poll; this is a second, identical → no new frame
    await Promise.resolve();
    expect(frames.length).toBeGreaterThanOrEqual(1);
    const f = frames[0];
    expect(f.pod_id).toBe("pod1");
    expect(f.status).toBe("RUNNING");
    expect(f.comfyui_url).toBe("https://pod1-8188.proxy.runpod.net");
    // second identical poll shouldn't add a frame
    const before = frames.length;
    await w.poll();
    expect(frames.length).toBe(before);
  });

  it("feeds the pod's dead-man watchdog while it RUNS under our watch (#269), not when stopped", async () => {
    getPodMock.mockResolvedValue(runningPod());
    const w = createRunpodWatcher({ push: () => {}, comfyuiIdle: () => false, renderingOnPod: () => true, idleStopMinutes: 0 });
    w.watch("pod1");
    await w.poll();
    expect(beatMock).toHaveBeenCalledWith(expect.objectContaining({ id: "pod1", name: "c" }));
    // A stopped pod gets no beat (its watchdog is down with the pod anyway).
    beatMock.mockClear();
    getPodMock.mockResolvedValue(runningPod({ desiredStatus: "EXITED", runtime: null }));
    await w.poll();
    expect(beatMock).not.toHaveBeenCalled();
  });

  it("keeps heartbeating a managed pod after unwatch — use_local must not self-stop it (#269 codex)", async () => {
    getPodMock.mockResolvedValue(runningPod());
    const w = createRunpodWatcher({ push: () => {}, comfyuiIdle: () => false, renderingOnPod: () => true, idleStopMinutes: 0 });
    w.watch("pod1");
    await w.poll();
    expect(beatMock).toHaveBeenCalledTimes(1);
    w.unwatch(); // UI stops watching; the pod is still OUR managed billing pod
    beatMock.mockClear();
    // The janitor (every ~10 polls) owes it beats even with nothing watched.
    for (let i = 0; i < 10; i++) await w.poll();
    expect(beatMock).toHaveBeenCalledWith(expect.objectContaining({ id: "pod1", name: "c" }));
  });

  it("drops a pod from the managed set once it exits (no beats for a dead pod)", async () => {
    getPodMock.mockResolvedValue(runningPod());
    const w = createRunpodWatcher({ push: () => {}, comfyuiIdle: () => false, renderingOnPod: () => true, idleStopMinutes: 0 });
    w.watch("pod1");
    await w.poll();
    getPodMock.mockResolvedValue(runningPod({ desiredStatus: "EXITED", runtime: null }));
    await w.poll(); // poll path sees EXITED → unwatch + managed-set delete
    beatMock.mockClear();
    for (let i = 0; i < 10; i++) await w.poll();
    expect(beatMock).not.toHaveBeenCalled();
  });

  it("drops a never-acking managed pod after 25min — console/deadman:false pods don't chatter forever (codex r2)", async () => {
    const clk = clock(0);
    getPodMock.mockResolvedValue(runningPod());
    beatMock.mockReturnValue(false); // no watchdog answering anywhere
    const w = createRunpodWatcher({ push: () => {}, comfyuiIdle: () => false, renderingOnPod: () => true, idleStopMinutes: 0, now: clk.now });
    w.watch("pod1");
    await w.poll(); // first beat fails at t=0 → leash starts
    w.unwatch(); // still managed (beats owed) — janitor path now
    for (let i = 0; i < 10; i++) await w.poll(); // first janitor sweep beats (fail)
    const sweeps1 = beatMock.mock.calls.length;
    expect(sweeps1).toBeGreaterThan(0);
    // 26 min of straight failures → the leash drops it from managed.
    clk.advance(26 * 60_000);
    beatMock.mockClear();
    for (let i = 0; i < 10; i++) await w.poll();
    expect(beatMock.mock.calls.length).toBe(1); // the beat that triggered the drop
    beatMock.mockClear();
    getPodMock.mockClear();
    for (let i = 0; i < 10; i++) await w.poll();
    expect(getPodMock).not.toHaveBeenCalled(); // unmanaged → janitor done with it
    expect(beatMock).not.toHaveBeenCalled();
  });

  it("a late heartbeat ack RE-MANAGES a leash-dropped pod (boot-window recovery, codex r3)", async () => {
    const clk = clock(0);
    getPodMock.mockResolvedValue(runningPod());
    beatMock.mockReturnValue(false);
    const w = createRunpodWatcher({ push: () => {}, comfyuiIdle: () => false, renderingOnPod: () => true, idleStopMinutes: 0, now: clk.now });
    w.watch("pod1");
    await w.poll(); // first beat fails at t=0 → leash starts
    clk.advance(26 * 60_000);
    await w.poll(); // leash drops it from managed
    // Endpoint comes up (still inside the boot window): the next beat succeeds
    // → the pod must be re-managed, or a later unwatch leaves it unfed (r3).
    beatMock.mockReturnValue(true);
    await w.poll();
    w.unwatch();
    beatMock.mockClear();
    for (let i = 0; i < 10; i++) await w.poll();
    expect(beatMock).toHaveBeenCalledWith(expect.objectContaining({ id: "pod1" }));
  });

  it("clears the frame on unwatch", async () => {
    getPodMock.mockResolvedValue(runningPod());
    const frames: RunpodStatusFrame[] = [];
    const w = createRunpodWatcher({ push: (f) => frames.push(f as RunpodStatusFrame), comfyuiIdle: () => false, renderingOnPod: () => true, idleStopMinutes: 0 });
    w.watch("pod1");
    await Promise.resolve();
    w.unwatch();
    expect(frames.at(-1)?.watching).toBe(false);
    expect(w.watchedPodId()).toBeNull();
  });

  it("unwatches when the pod vanishes", async () => {
    getPodMock.mockResolvedValue(null);
    const w = createRunpodWatcher({ push: () => {}, comfyuiIdle: () => false, renderingOnPod: () => true, idleStopMinutes: 0 });
    w.watch("gone");
    await w.poll();
    expect(w.watchedPodId()).toBeNull();
  });
});

describe("runpod-watch — idle auto-stop", () => {
  it("auto-stops after the pod's ComfyUI is idle past the timeout", async () => {
    getPodMock.mockResolvedValue(runningPod());
    const c = clock();
    const frames: RunpodStatusFrame[] = [];
    const w = createRunpodWatcher({
      push: (f) => frames.push(f as RunpodStatusFrame),
      comfyuiIdle: () => true, // always idle
      renderingOnPod: () => true, // connected to the pod
      idleStopMinutes: 15,
      now: c.now,
    });
    w.watch("pod1");
    await w.poll(); // t=0: idle clock starts
    c.advance(10 * 60_000);
    await w.poll(); // t=10m: still under 15m, countdown shown, not stopped
    expect(stopPodMock).not.toHaveBeenCalled();
    const mid = frames.at(-1)!;
    expect(mid.idle_seconds).toBe(600);
    expect(mid.autostop_in_seconds).toBe(5 * 60); // 5 min left
    c.advance(6 * 60_000);
    await w.poll(); // t=16m: past 15m → auto-stop
    expect(stopPodMock).toHaveBeenCalledWith("pod1");
    expect(frames.at(-1)?.status).toBe("EXITED");
    expect(w.watchedPodId()).toBeNull(); // stopped watching after auto-stop
  });

  it("does NOT auto-stop while ComfyUI is busy (idle clock resets)", async () => {
    getPodMock.mockResolvedValue(runningPod());
    const c = clock();
    let idle = false;
    const w = createRunpodWatcher({ push: () => {}, comfyuiIdle: () => idle, renderingOnPod: () => true, idleStopMinutes: 15, now: c.now });
    w.watch("pod1");
    idle = true; await w.poll(); // idle starts
    c.advance(10 * 60_000);
    idle = false; await w.poll(); // busy → reset
    c.advance(10 * 60_000);
    idle = true; await w.poll(); // idle again, but clock reset so only just started
    c.advance(6 * 60_000);
    await w.poll();
    expect(stopPodMock).not.toHaveBeenCalled(); // never reached 15m of continuous idle
  });

  it("a FAILED auto-stop keeps watching, broadcasts the TRUE status + autostop_failed, and retries next tick", async () => {
    getPodMock.mockResolvedValue(runningPod());
    stopPodMock.mockRejectedValueOnce(new Error("RunPod API HTTP 500")); // first stop attempt fails
    stopPodMock.mockResolvedValueOnce({ id: "pod1", desiredStatus: "EXITED" }); // retry succeeds
    const c = clock();
    const frames: RunpodStatusFrame[] = [];
    const w = createRunpodWatcher({
      push: (f) => frames.push(f as RunpodStatusFrame),
      comfyuiIdle: () => true,
      renderingOnPod: () => true,
      idleStopMinutes: 15,
      now: c.now,
    });
    w.watch("pod1");
    await w.poll(); // t=0: idle clock starts
    c.advance(16 * 60_000);
    await w.poll(); // t=16m: auto-stop fires → stopPod FAILS
    expect(stopPodMock).toHaveBeenCalledTimes(1);
    // MONEY SAFETY: the pod is still running/billing — we must NOT lie that it
    // exited, and we must NOT stop watching.
    const failed = frames.at(-1)!;
    expect(failed.status).toBe("RUNNING"); // the TRUE status, not a fake EXITED
    expect(failed.autostop_failed).toBe(true); // the UI gets the failure hint
    expect(w.watchedPodId()).toBe("pod1"); // still watching
    // Next tick retries the stop; this time it succeeds → EXITED + unwatch.
    c.advance(15_000);
    await w.poll();
    expect(stopPodMock).toHaveBeenCalledTimes(2);
    expect(frames.at(-1)?.status).toBe("EXITED");
    expect(frames.at(-1)?.autostop_failed).toBeUndefined();
    expect(w.watchedPodId()).toBeNull();
  });

  it("does not overlap polls: ticks during an in-flight poll join it instead of re-requesting", async () => {
    let resolveGet: ((p: unknown) => void) | null = null;
    getPodMock.mockImplementationOnce(() => new Promise((res) => (resolveGet = res)));
    getPodMock.mockResolvedValue(runningPod()); // subsequent polls resolve normally
    const w = createRunpodWatcher({ push: () => {}, comfyuiIdle: () => false, renderingOnPod: () => false, idleStopMinutes: 0 });
    w.watch("pod1"); // kicks poll #1 — hangs on getPod
    expect(getPodMock).toHaveBeenCalledTimes(1);
    const joined = w.poll(); // tick while #1 in flight → joins, NO second getPod
    void w.poll(); // and another
    expect(getPodMock).toHaveBeenCalledTimes(1);
    resolveGet!(runningPod());
    await joined; // resolves when poll #1 finishes
    await w.poll(); // previous poll done → this one runs a fresh request
    expect(getPodMock).toHaveBeenCalledTimes(2);
  });

  it("drops a stale poll result when the watched pod changed mid-flight (no republish of A over B)", async () => {
    // poll(A) is in flight; watch(B) lands before it resolves. When A's getPod
    // finally returns, its frame must be DROPPED (generation guard) — otherwise
    // it republishes pod A's status after B was selected, leaving B unwatched.
    let resolveA: ((p: unknown) => void) | null = null;
    getPodMock.mockImplementationOnce(() => new Promise((res) => (resolveA = res)));
    const podB = runningPod({ id: "podB", name: "B" });
    getPodMock.mockResolvedValue(podB); // every later getPod → B
    const frames: RunpodStatusFrame[] = [];
    const w = createRunpodWatcher({
      push: (f) => frames.push(f as RunpodStatusFrame),
      comfyuiIdle: () => false,
      renderingOnPod: () => false,
      idleStopMinutes: 0,
    });
    w.watch("podA"); // poll #1 (A) — hangs
    expect(getPodMock).toHaveBeenCalledTimes(1);
    w.watch("podB"); // switch target while A in flight
    expect(w.watchedPodId()).toBe("podB");
    // Resolve A's stale getPod with A's data — it must be dropped, not published.
    resolveA!(runningPod({ id: "podA", name: "A" }));
    await Promise.resolve();
    await Promise.resolve();
    expect(frames.some((f) => f.pod_id === "podA")).toBe(false); // A never published
    expect(w.watchedPodId()).toBe("podB"); // still watching B
    // The chained poll for B (kicked after A settled) publishes B.
    await w.poll();
    expect(frames.at(-1)?.pod_id).toBe("podB");
  });

  it("never auto-stops when disabled (idleStopMinutes = 0)", async () => {
    getPodMock.mockResolvedValue(runningPod());
    const c = clock();
    const frames: RunpodStatusFrame[] = [];
    const w = createRunpodWatcher({ push: (f) => frames.push(f as RunpodStatusFrame), comfyuiIdle: () => true, renderingOnPod: () => true, idleStopMinutes: 0, now: c.now });
    w.watch("pod1");
    await w.poll();
    c.advance(60 * 60_000); // an hour idle
    await w.poll();
    expect(stopPodMock).not.toHaveBeenCalled();
    expect(frames.at(-1)?.autostop_minutes).toBeNull();
  });

  // Regression (live-caught): a pod we WATCH but haven't connected to must never
  // auto-stop on the LOCAL rig's idleness — else a booting pod gets killed at the
  // timeout while we wait for it. Only a pod we're rendering on accrues idle time.
  it("does NOT auto-stop a watched pod we're not rendering on (local idle)", async () => {
    getPodMock.mockResolvedValue(runningPod());
    const c = clock();
    const frames: RunpodStatusFrame[] = [];
    const w = createRunpodWatcher({
      push: (f) => frames.push(f as RunpodStatusFrame),
      comfyuiIdle: () => true, // the LOCAL ComfyUI is idle
      renderingOnPod: () => false, // …but we haven't connected to the pod
      idleStopMinutes: 15,
      now: c.now,
    });
    w.watch("pod1");
    await w.poll();
    c.advance(30 * 60_000); // half an hour of local idle
    await w.poll();
    expect(stopPodMock).not.toHaveBeenCalled(); // pod stays up while it boots
    expect(w.watchedPodId()).toBe("pod1");
    expect(frames.at(-1)?.idle_seconds).toBeNull(); // no idle accrued against the pod
    expect(frames.at(-1)?.autostop_in_seconds).toBeNull();
  });
});

it("passes the watched pod's id to comfyuiIdle (per-pod idle veto, #274)", async () => {
  getPodMock.mockResolvedValue(runningPod());
  const seen: string[] = [];
  const w = createRunpodWatcher({
    push: () => {},
    comfyuiIdle: (podId: string) => { seen.push(podId); return false; },
    renderingOnPod: () => true,
    idleStopMinutes: 15,
  });
  w.watch("podXYZ");
  await w.poll();
  expect(seen).toContain("podXYZ");
});

it("fires onPodUnavailable when the watched pod vanishes (#269 dead-target)", async () => {
  getPodMock.mockResolvedValue(null);
  const gone: string[] = [];
  const w = createRunpodWatcher({
    push: () => {},
    comfyuiIdle: () => false,
    renderingOnPod: () => true,
    idleStopMinutes: 0,
    onPodUnavailable: (id) => gone.push(id),
  });
  w.watch("podGone");
  await w.poll();
  expect(gone).toEqual(["podGone"]);
  expect(w.watchedPodId()).toBeNull();
});

it("fires onPodUnavailable after a successful auto-stop (#269 dead-target)", async () => {
  getPodMock.mockResolvedValue(runningPod());
  stopPodMock.mockResolvedValue({ id: "podIdle", desiredStatus: "EXITED" });
  const c = clock();
  const gone: string[] = [];
  const w = createRunpodWatcher({
    push: () => {},
    comfyuiIdle: () => true,
    renderingOnPod: () => true,
    idleStopMinutes: 15,
    now: c.now,
    onPodUnavailable: (id) => gone.push(id),
  });
  w.watch("podIdle");
  await w.poll(); // idle clock starts
  c.advance(16 * 60_000);
  await w.poll(); // auto-stop fires
  expect(stopPodMock).toHaveBeenCalledWith("podIdle");
  expect(gone).toEqual(["podIdle"]);
});

it("fires onPodUnavailable when a watched pod is EXITED externally (retained pod, runtime null)", async () => {
  getPodMock.mockResolvedValue({ id: "podStop", name: "s", desiredStatus: "EXITED", costPerHr: 0.4, machine: null, runtime: null });
  const gone: string[] = [];
  const w = createRunpodWatcher({
    push: () => {},
    comfyuiIdle: () => false,
    renderingOnPod: () => true,
    idleStopMinutes: 15,
    onPodUnavailable: (id) => gone.push(id),
  });
  w.watch("podStop");
  await w.poll();
  expect(gone).toEqual(["podStop"]);
  expect(w.watchedPodId()).toBeNull();
});
