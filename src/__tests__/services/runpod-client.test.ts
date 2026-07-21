import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  createPod,
  runpodDeployLink,
  runpodProxyUrl,
  comfyuiPortExposed,
  RUNPOD_DEFAULT_GPU_TYPES,
  type RunpodPod,
} from "../../services/runpod-client.js";

// createPod loops over GPU types until one deploys. Mock fetch to control which
// attempt succeeds; assert the fallback + the referral link / proxy helpers.
let savedKey: string | undefined;
beforeEach(() => {
  savedKey = process.env.RUNPOD_API_KEY;
  process.env.RUNPOD_API_KEY = "rp-test-key";
});
afterEach(() => {
  if (savedKey === undefined) delete process.env.RUNPOD_API_KEY;
  else process.env.RUNPOD_API_KEY = savedKey;
  vi.restoreAllMocks();
});

function gqlResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

describe("runpod-client helpers", () => {
  it("builds the referral deploy link with our template + ref code", () => {
    expect(runpodDeployLink()).toBe("https://console.runpod.io/deploy?template=bnqtkvcer3&ref=dkx71w9b");
  });
  it("builds the pod proxy URL for ComfyUI's port", () => {
    expect(runpodProxyUrl("abc123")).toBe("https://abc123-8188.proxy.runpod.net");
  });
  it("detects an exposed ComfyUI http port", () => {
    const pod = { runtime: { ports: [{ privatePort: 8188, type: "http" }] } } as unknown as RunpodPod;
    expect(comfyuiPortExposed(pod)).toBe(true);
    expect(comfyuiPortExposed({ runtime: { ports: [{ privatePort: 22, type: "tcp" }] } } as unknown as RunpodPod)).toBe(false);
  });
});

describe("createPod (GPU fallback)", () => {
  it("returns the pod on the FIRST GPU type that has capacity", async () => {
    global.fetch = vi.fn(async () =>
      gqlResponse({ data: { podFindAndDeployOnDemand: { id: "pod1", name: "comfyui-mcp", desiredStatus: "RUNNING", costPerHr: 0.44, machine: { gpuDisplayName: "RTX 4090" } } } }),
    ) as unknown as typeof fetch;
    const pod = await createPod();
    expect(pod.id).toBe("pod1");
    expect(pod.runtime).toBeNull(); // deploy returns no runtime yet
    expect(global.fetch).toHaveBeenCalledTimes(1); // first GPU succeeded → no fallback
  });

  it("falls through to the NEXT GPU when the first has no capacity", async () => {
    let call = 0;
    global.fetch = vi.fn(async () => {
      call++;
      if (call === 1) return gqlResponse({ errors: [{ message: "no instances available" }] });
      return gqlResponse({ data: { podFindAndDeployOnDemand: { id: "pod2", name: "comfyui-mcp", desiredStatus: "RUNNING", costPerHr: 0.3, machine: { gpuDisplayName: "RTX A5000" } } } });
    }) as unknown as typeof fetch;
    const pod = await createPod();
    expect(pod.id).toBe("pod2");
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it("throws a descriptive error listing every GPU tried when all fail", async () => {
    global.fetch = vi.fn(async () => gqlResponse({ errors: [{ message: "no capacity" }] })) as unknown as typeof fetch;
    await expect(createPod({ gpuTypeIds: ["GPU-A", "GPU-B"] })).rejects.toThrow(/GPU-A[\s\S]*GPU-B/);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it("sends our template id + community cloud + the ComfyUI port in the deploy input", async () => {
    const fetchMock = vi.fn(async () => gqlResponse({ data: { podFindAndDeployOnDemand: { id: "p", desiredStatus: "RUNNING" } } }));
    global.fetch = fetchMock as unknown as typeof fetch;
    await createPod({ gpuTypeIds: ["NVIDIA A40"] });
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(body.variables.input.templateId).toBe("bnqtkvcer3");
    expect(body.variables.input.cloudType).toBe("COMMUNITY");
    expect(body.variables.input.gpuTypeId).toBe("NVIDIA A40");
    expect(body.variables.input.ports).toBe("8188/http");
  });

  it("has sane default GPU types (24GB+ cards)", () => {
    expect(RUNPOD_DEFAULT_GPU_TYPES.length).toBeGreaterThan(0);
    expect(RUNPOD_DEFAULT_GPU_TYPES).toContain("NVIDIA GeForce RTX 4090");
  });
});
