import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Force local mode and stub the underlying SDK Client so getNodeDefs is
// countable without a network.
vi.mock("../../config.js", async () => {
  const actual = await vi.importActual<typeof import("../../config.js")>(
    "../../config.js",
  );
  return {
    ...actual,
    isCloudMode: () => false,
    getComfyUIApiHost: () => "127.0.0.1:8188",
  };
});

const getNodeDefs = vi.fn();
vi.mock("@stable-canvas/comfyui-client", () => ({
  Client: class {
    getNodeDefs = getNodeDefs;
    close() {}
  },
}));

const { getObjectInfo, resetObjectInfoCache } = await import(
  "../../comfyui/client.js"
);

describe("getObjectInfo memoization", () => {
  beforeEach(() => {
    getNodeDefs.mockReset();
    resetObjectInfoCache();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("fetches once and serves subsequent calls from cache", async () => {
    getNodeDefs.mockResolvedValue({ KSampler: { input: {} } });
    const a = await getObjectInfo();
    const b = await getObjectInfo();
    expect(getNodeDefs).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
  });

  it("coalesces concurrent first fetches into one request", async () => {
    let release!: (v: unknown) => void;
    getNodeDefs.mockReturnValue(new Promise((r) => (release = r)));
    const p1 = getObjectInfo();
    const p2 = getObjectInfo();
    release({ KSampler: {} });
    const [a, b] = await Promise.all([p1, p2]);
    expect(getNodeDefs).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
  });

  it("refetches after resetObjectInfoCache()", async () => {
    getNodeDefs.mockResolvedValue({ KSampler: {} });
    await getObjectInfo();
    resetObjectInfoCache();
    await getObjectInfo();
    expect(getNodeDefs).toHaveBeenCalledTimes(2);
  });

  it("does not cache a failed fetch (both the call and its one-shot retry fail)", async () => {
    // A transport failure now triggers one client-reset + retry (#376); when the
    // retry also fails the call rejects and nothing is cached.
    getNodeDefs.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    getNodeDefs.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await expect(getObjectInfo()).rejects.toThrow("ECONNREFUSED");
    expect(getNodeDefs).toHaveBeenCalledTimes(2);
    // Failure was not cached — a later call refetches and can succeed.
    getNodeDefs.mockResolvedValueOnce({ KSampler: {} });
    await expect(getObjectInfo()).resolves.toEqual({ KSampler: {} });
  });

  it("recovers a stale post-restart client by resetting and retrying once (#376)", async () => {
    // First call fails on the stale (torn-down) client; the retry against a
    // fresh client succeeds, so the caller never sees the bare "fetch failed".
    getNodeDefs.mockRejectedValueOnce(new Error("fetch failed"));
    getNodeDefs.mockResolvedValueOnce({ KSampler: {} });
    await expect(getObjectInfo()).resolves.toEqual({ KSampler: {} });
    expect(getNodeDefs).toHaveBeenCalledTimes(2);
  });
});
