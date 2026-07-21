import { describe, expect, it, beforeEach, vi } from "vitest";

// Mock the RunPod client so the tools are tested in isolation. Pure helpers
// (port check, URL/link builders, the port constant) keep their real behavior;
// the network calls are stubbed.
const getPodMock = vi.fn();
const listPodsMock = vi.fn();
const resumePodMock = vi.fn();
const stopPodMock = vi.fn();
const createPodMock = vi.fn();
vi.mock("../../services/runpod-client.js", () => ({
  getPod: (...a: unknown[]) => getPodMock(...a),
  listPods: (...a: unknown[]) => listPodsMock(...a),
  resumePod: (...a: unknown[]) => resumePodMock(...a),
  stopPod: (...a: unknown[]) => stopPodMock(...a),
  createPod: (...a: unknown[]) => createPodMock(...a),
  RUNPOD_COMFYUI_PORT: 8188,
  RUNPOD_DEFAULT_GPU_TYPES: ["NVIDIA GeForce RTX 4090", "NVIDIA RTX A5000", "NVIDIA A40"],
  comfyuiPortExposed: (pod: { runtime?: { ports?: Array<{ privatePort: number; type: string }> } }) =>
    (pod.runtime?.ports ?? []).some((p) => p.privatePort === 8188 && p.type === "http"),
  runpodProxyUrl: (id: string, port = 8188) => `https://${id}-${port}.proxy.runpod.net`,
  runpodDeployLink: () => "https://console.runpod.io/deploy?template=bnqtkvcer3&ref=dkx71w9b",
  GPU_CLI_CREDIT: "Pod control inspired by gpu-cli.sh (https://gpu-cli.sh) — a cloud-GPU CLI worth checking out.",
}));

// runpod tools also import the watcher singleton — stub it with a controllable
// fake so we can assert watch/unwatch and the "was this pod connected?" branch.
const watcherState = { watched: null as string | null };
const watchMock = vi.fn((id: string) => { watcherState.watched = id; });
const unwatchMock = vi.fn(() => { watcherState.watched = null; });
vi.mock("../../services/runpod-watch.js", () => ({
  getRunpodWatcher: () => ({
    watch: (id: string) => watchMock(id),
    unwatch: () => unwatchMock(),
    watchedPodId: () => watcherState.watched,
  }),
}));

const setComfyuiTargetMock = vi.fn(() => true);
vi.mock("../../config.js", () => ({
  setComfyuiTarget: (...a: unknown[]) => setComfyuiTargetMock(...a),
  getLocalComfyuiUrl: () => "http://127.0.0.1:8188",
}));
const resetClientMock = vi.fn();
vi.mock("../../comfyui/client.js", () => ({ resetClient: () => resetClientMock() }));

import { registerRunpodTools } from "../../tools/runpod.js";

type ToolHandler = (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>;
function getHandler(name: string): ToolHandler {
  let handler: ToolHandler | undefined;
  const server = { tool: (n: string, _d: string, _s: unknown, h: ToolHandler) => { if (n === name) handler = h; } };
  registerRunpodTools(server as never);
  if (!handler) throw new Error(`tool ${name} not registered`);
  return handler;
}

const runningPod = (over: Record<string, unknown> = {}) => ({
  id: "pod123",
  name: "my-comfy",
  desiredStatus: "RUNNING",
  costPerHr: 0.44,
  machine: { gpuDisplayName: "RTX 4090" },
  runtime: {
    uptimeInSeconds: 3720,
    ports: [{ ip: "1.2.3.4", isIpPublic: true, privatePort: 8188, publicPort: 8188, type: "http" }],
    gpus: [{ id: "g0", gpuUtilPercent: 12, memoryUtilPercent: 30 }],
  },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  watcherState.watched = null;
  setComfyuiTargetMock.mockReturnValue(true);
  // default probe: ComfyUI answers
  global.fetch = vi.fn(async () => ({ ok: true, status: 200 })) as unknown as typeof fetch;
});

describe("runpod_pod_status", () => {
  it("summarizes a running pod incl. the ComfyUI proxy URL", async () => {
    getPodMock.mockResolvedValue(runningPod());
    const t = (await getHandler("runpod_pod_status")({ pod_id: "pod123" })).content[0].text;
    expect(t).toContain("pod123");
    expect(t).toContain("RUNNING");
    expect(t).toContain("RTX 4090");
    expect(t).toContain("https://pod123-8188.proxy.runpod.net");
    expect(t).toContain("$0.440/hr");
  });
  it("reports cleanly when the pod doesn't exist", async () => {
    getPodMock.mockResolvedValue(null);
    const t = (await getHandler("runpod_pod_status")({ pod_id: "ghost" })).content[0].text;
    expect(t).toContain("No pod");
    expect(t).toContain("runpod_deploy_link");
  });
});

describe("runpod_list_pods", () => {
  it("lists pods", async () => {
    listPodsMock.mockResolvedValue([runningPod(), runningPod({ id: "pod999", desiredStatus: "EXITED", name: "idle" })]);
    const t = (await getHandler("runpod_list_pods")({})).content[0].text;
    expect(t).toContain("2 pod(s)");
    expect(t).toContain("pod999");
    expect(t).toContain("EXITED");
  });
  it("points to the referral deploy link when there are no pods", async () => {
    listPodsMock.mockResolvedValue([]);
    const t = (await getHandler("runpod_list_pods")({})).content[0].text;
    expect(t).toContain("No pods");
    expect(t).toContain("runpod_deploy_link");
  });
});

describe("runpod_pod_start / stop", () => {
  it("resumes with the requested gpu_count", async () => {
    resumePodMock.mockResolvedValue({ id: "pod123", desiredStatus: "RUNNING" });
    const t = (await getHandler("runpod_pod_start")({ pod_id: "pod123", gpu_count: 2 })).content[0].text;
    expect(resumePodMock).toHaveBeenCalledWith("pod123", 2);
    expect(t).toContain("Started");
    expect(t).toContain("RUNNING");
  });
  it("defaults gpu_count to 1", async () => {
    resumePodMock.mockResolvedValue({ id: "pod123", desiredStatus: "RUNNING" });
    await getHandler("runpod_pod_start")({ pod_id: "pod123" });
    expect(resumePodMock).toHaveBeenCalledWith("pod123", 1);
  });
  it("stops a pod", async () => {
    stopPodMock.mockResolvedValue({ id: "pod123", desiredStatus: "EXITED" });
    const t = (await getHandler("runpod_pod_stop")({ pod_id: "pod123" })).content[0].text;
    expect(t).toContain("Stopped");
    expect(t).toContain("EXITED");
  });
  it("falls back to local ComfyUI when stopping the CONNECTED pod (the swap)", async () => {
    watcherState.watched = "pod123"; // we were connected to it
    stopPodMock.mockResolvedValue({ id: "pod123", desiredStatus: "EXITED" });
    const t = (await getHandler("runpod_pod_stop")({ pod_id: "pod123" })).content[0].text;
    expect(unwatchMock).toHaveBeenCalled();
    expect(setComfyuiTargetMock).toHaveBeenCalledWith("http://127.0.0.1:8188");
    expect(resetClientMock).toHaveBeenCalled();
    expect(t).toContain("switched back to local");
  });
  it("does NOT retarget when stopping a pod we weren't connected to", async () => {
    watcherState.watched = "otherpod";
    stopPodMock.mockResolvedValue({ id: "pod123", desiredStatus: "EXITED" });
    await getHandler("runpod_pod_stop")({ pod_id: "pod123" });
    expect(setComfyuiTargetMock).not.toHaveBeenCalled();
  });
});

describe("runpod_pod_create", () => {
  it("deploys our template and watches the new pod", async () => {
    createPodMock.mockResolvedValue({ id: "newpod", name: "comfyui-mcp", costPerHr: 0.44, machine: { gpuDisplayName: "RTX 4090" }, runtime: null });
    const t = (await getHandler("runpod_pod_create")({})).content[0].text;
    expect(createPodMock).toHaveBeenCalled();
    expect(watchMock).toHaveBeenCalledWith("newpod");
    expect(t).toContain("newpod");
    expect(t).toContain("RTX 4090");
    expect(t).toContain("$0.440/hr");
    expect(t).toContain("runpod_pod_connect");
  });
  it("passes a specific gpu_type through as a single-element preference", async () => {
    createPodMock.mockResolvedValue({ id: "p", name: "x", costPerHr: null, machine: null, runtime: null });
    await getHandler("runpod_pod_create")({ gpu_type: "NVIDIA A40", cloud_type: "SECURE" });
    expect(createPodMock).toHaveBeenCalledWith(expect.objectContaining({ gpuTypeIds: ["NVIDIA A40"], cloudType: "SECURE" }));
  });
  it("surfaces a no-capacity deploy failure", async () => {
    createPodMock.mockRejectedValue(new Error("Could not deploy a pod on any of [RTX 4090]"));
    const t = (await getHandler("runpod_pod_create")({})).content[0].text;
    expect(t).toContain("Could not deploy");
  });
});

describe("runpod_use_local", () => {
  it("retargets to local and unwatches the pod without stopping it", async () => {
    watcherState.watched = "pod123";
    const t = (await getHandler("runpod_use_local")({})).content[0].text;
    expect(unwatchMock).toHaveBeenCalled();
    expect(setComfyuiTargetMock).toHaveBeenCalledWith("http://127.0.0.1:8188");
    expect(resetClientMock).toHaveBeenCalled();
    expect(t).toContain("local ComfyUI");
    expect(t).toContain("still running"); // reminds you the pod bills until stopped
  });
});

describe("runpod_pod_troubleshoot", () => {
  it("tells you to start a stopped pod", async () => {
    getPodMock.mockResolvedValue(runningPod({ desiredStatus: "EXITED", runtime: null }));
    const t = (await getHandler("runpod_pod_troubleshoot")({ pod_id: "pod123" })).content[0].text;
    expect(t).toContain("not RUNNING");
    expect(t).toContain("runpod_pod_start");
  });
  it("flags a still-booting pod (RUNNING, no runtime)", async () => {
    getPodMock.mockResolvedValue(runningPod({ runtime: null }));
    const t = (await getHandler("runpod_pod_troubleshoot")({ pod_id: "pod123" })).content[0].text;
    expect(t).toContain("still booting");
  });
  it("flags an unexposed ComfyUI port", async () => {
    getPodMock.mockResolvedValue(runningPod({ runtime: { uptimeInSeconds: 60, ports: [{ privatePort: 22, type: "tcp" }], gpus: [] } }));
    const t = (await getHandler("runpod_pod_troubleshoot")({ pod_id: "pod123" })).content[0].text;
    expect(t).toContain("not exposed");
    expect(t).toContain("8188");
  });
  it("flags exposed-but-not-answering ComfyUI", async () => {
    getPodMock.mockResolvedValue(runningPod());
    global.fetch = vi.fn(async () => ({ ok: false, status: 502 })) as unknown as typeof fetch;
    const t = (await getHandler("runpod_pod_troubleshoot")({ pod_id: "pod123" })).content[0].text;
    expect(t).toContain("did not answer");
  });
  it("reports healthy when ComfyUI answers", async () => {
    getPodMock.mockResolvedValue(runningPod());
    const t = (await getHandler("runpod_pod_troubleshoot")({ pod_id: "pod123" })).content[0].text;
    expect(t).toContain("healthy");
    expect(t).toContain("runpod_pod_connect");
  });
});

describe("runpod_pod_connect", () => {
  it("retargets comfyui-mcp when the pod is healthy", async () => {
    getPodMock.mockResolvedValue(runningPod());
    const t = (await getHandler("runpod_pod_connect")({ pod_id: "pod123" })).content[0].text;
    expect(setComfyuiTargetMock).toHaveBeenCalledWith("https://pod123-8188.proxy.runpod.net");
    expect(resetClientMock).toHaveBeenCalled();
    expect(t).toContain("Connected");
  });
  it("refuses to connect a stopped pod", async () => {
    getPodMock.mockResolvedValue(runningPod({ desiredStatus: "EXITED", runtime: null }));
    const t = (await getHandler("runpod_pod_connect")({ pod_id: "pod123" })).content[0].text;
    expect(t).toContain("not RUNNING");
    expect(setComfyuiTargetMock).not.toHaveBeenCalled();
  });
  it("doesn't retarget if ComfyUI isn't answering yet", async () => {
    getPodMock.mockResolvedValue(runningPod());
    global.fetch = vi.fn(async () => ({ ok: false, status: 502 })) as unknown as typeof fetch;
    const t = (await getHandler("runpod_pod_connect")({ pod_id: "pod123" })).content[0].text;
    expect(t).toContain("isn't answering");
    expect(setComfyuiTargetMock).not.toHaveBeenCalled();
  });
});

describe("runpod_deploy_link", () => {
  it("returns the referral deploy link", async () => {
    const t = (await getHandler("runpod_deploy_link")({})).content[0].text;
    expect(t).toContain("console.runpod.io/deploy?template=bnqtkvcer3&ref=dkx71w9b");
  });
});
