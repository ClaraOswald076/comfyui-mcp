import { describe, expect, it, beforeEach, vi } from "vitest";

// Mock the RunPod client the watcher polls/acts on.
const getPodMock = vi.fn();
const stopPodMock = vi.fn();
vi.mock("../../services/runpod-client.js", () => ({
  getPod: (...a: unknown[]) => getPodMock(...a),
  stopPod: (...a: unknown[]) => stopPodMock(...a),
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
    const w = createRunpodWatcher({ push: (f) => frames.push(f as RunpodStatusFrame), comfyuiIdle: () => false, idleStopMinutes: 0 });
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

  it("clears the frame on unwatch", async () => {
    getPodMock.mockResolvedValue(runningPod());
    const frames: RunpodStatusFrame[] = [];
    const w = createRunpodWatcher({ push: (f) => frames.push(f as RunpodStatusFrame), comfyuiIdle: () => false, idleStopMinutes: 0 });
    w.watch("pod1");
    await Promise.resolve();
    w.unwatch();
    expect(frames.at(-1)?.watching).toBe(false);
    expect(w.watchedPodId()).toBeNull();
  });

  it("unwatches when the pod vanishes", async () => {
    getPodMock.mockResolvedValue(null);
    const w = createRunpodWatcher({ push: () => {}, comfyuiIdle: () => false, idleStopMinutes: 0 });
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
    const w = createRunpodWatcher({ push: () => {}, comfyuiIdle: () => idle, idleStopMinutes: 15, now: c.now });
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

  it("never auto-stops when disabled (idleStopMinutes = 0)", async () => {
    getPodMock.mockResolvedValue(runningPod());
    const c = clock();
    const frames: RunpodStatusFrame[] = [];
    const w = createRunpodWatcher({ push: (f) => frames.push(f as RunpodStatusFrame), comfyuiIdle: () => true, idleStopMinutes: 0, now: c.now });
    w.watch("pod1");
    await w.poll();
    c.advance(60 * 60_000); // an hour idle
    await w.poll();
    expect(stopPodMock).not.toHaveBeenCalled();
    expect(frames.at(-1)?.autostop_minutes).toBeNull();
  });
});
