import { describe, it, expect, vi, beforeEach } from "vitest";

const hoisted = vi.hoisted(() => ({
  resolvers: [] as Array<{ resolve: (p: string) => void; reject: (e: Error) => void; url: string }>,
  calls: 0,
}));

vi.mock("../../services/model-resolver.js", () => ({
  downloadModel: vi.fn((url: string) => {
    hoisted.calls += 1;
    return new Promise<string>((resolve, reject) => {
      hoisted.resolvers.push({ resolve, reject, url });
    });
  }),
}));

import {
  startDownloadJob,
  getDownloadJob,
  listDownloadJobs,
  resetDownloadJobs,
  downloadIdFor,
} from "../../services/download-jobs.js";

const URL_A = "https://huggingface.co/org/repo/resolve/main/big.safetensors";
const URL_B = "https://huggingface.co/org/repo/resolve/main/other.safetensors";

describe("download job registry", () => {
  beforeEach(() => {
    hoisted.resolvers.length = 0;
    hoisted.calls = 0;
    resetDownloadJobs();
  });

  it("reports a download as in flight rather than finished or failed", () => {
    // The bug being fixed: an unfinished download must never read as failure.
    const { job } = startDownloadJob(URL_A, "checkpoints");
    expect(job.status).toBe("downloading");
    expect(job.path).toBeUndefined();
    expect(job.error).toBeUndefined();
  });

  it("uses the same id as the panel tray so both name one download", () => {
    const { job } = startDownloadJob(URL_A, "checkpoints");
    expect(job.id).toBe(downloadIdFor(URL_A));
    expect(job.id).toHaveLength(16);
  });

  it("adopts an in-flight download instead of starting a second copy", async () => {
    // Asking twice is the natural response to "the agent looks stuck". Without
    // adoption that means two streams writing one target path.
    const first = startDownloadJob(URL_A, "checkpoints");
    const second = startDownloadJob(URL_A, "checkpoints");
    expect(hoisted.calls).toBe(1);
    expect(second.job).toBe(first.job);
    expect(listDownloadJobs()).toHaveLength(1);
  });

  it("starts a genuinely different URL separately", () => {
    startDownloadJob(URL_A, "checkpoints");
    startDownloadJob(URL_B, "checkpoints");
    expect(hoisted.calls).toBe(2);
    expect(listDownloadJobs()).toHaveLength(2);
  });

  it("records the landed path on success", async () => {
    const { job, settled } = startDownloadJob(URL_A, "checkpoints");
    hoisted.resolvers[0].resolve("C:/models/checkpoints/big.safetensors");
    await settled;
    expect(job.status).toBe("done");
    expect(job.path).toBe("C:/models/checkpoints/big.safetensors");
    expect(job.finished_at).toBeGreaterThan(0);
  });

  it("captures a failure without rejecting the stored promise", async () => {
    // An unhandled rejection here would kill the process over a 404.
    const { job, settled } = startDownloadJob(URL_A, "checkpoints");
    hoisted.resolvers[0].reject(new Error("HTTP 404"));
    await expect(settled).resolves.toBeUndefined();
    expect(job.status).toBe("error");
    expect(job.error).toContain("404");
  });

  it("allows a retry once a download has failed", async () => {
    const first = startDownloadJob(URL_A, "checkpoints");
    hoisted.resolvers[0].reject(new Error("network reset"));
    await first.settled;
    // Adoption must not pin a dead job forever — a retry has to start a new one.
    startDownloadJob(URL_A, "checkpoints");
    expect(hoisted.calls).toBe(2);
    expect(getDownloadJob(downloadIdFor(URL_A))?.status).toBe("downloading");
  });

  it("lists newest first", async () => {
    startDownloadJob(URL_A, "checkpoints");
    await new Promise((r) => setTimeout(r, 2));
    startDownloadJob(URL_B, "loras");
    expect(listDownloadJobs()[0].url).toBe(URL_B);
  });
});
