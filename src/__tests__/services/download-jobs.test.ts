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

  it("exposes the URL-only tray id for progress correlation, plus a distinct job id", () => {
    const { job } = startDownloadJob(URL_A, "checkpoints");
    // trayId matches the panel tray / progress-file row (URL-only hash).
    expect(job.trayId).toBe(downloadIdFor(URL_A));
    // The public job id is distinct (keyed by URL+destination) but still 16 hex.
    expect(job.id).toHaveLength(16);
    expect(getDownloadJob(job.id)?.trayId).toBe(job.trayId);
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

  it("keys jobs by URL AND destination so different targets don't collapse", () => {
    // Same URL fetched to two different destinations must be two downloads —
    // collapsing them wrote only the first destination while reporting both done.
    const a = startDownloadJob(URL_A, "checkpoints");
    const b = startDownloadJob(URL_A, "loras", "renamed.safetensors");
    expect(hoisted.calls).toBe(2);
    expect(listDownloadJobs()).toHaveLength(2);
    // Each has a DISTINCT public id and is individually pollable via that id,
    // even though they share the URL-only trayId.
    expect(a.job.id).not.toBe(b.job.id);
    expect(a.job.trayId).toBe(b.job.trayId);
    expect(getDownloadJob(a.job.id)).toBe(a.job);
    expect(getDownloadJob(b.job.id)).toBe(b.job);
    expect(getDownloadJob(a.job.id)?.target_subfolder).toBe("checkpoints");
    expect(getDownloadJob(b.job.id)?.target_subfolder).toBe("loras");
  });

  it("does not collide on ambiguous field boundaries (JSON-encoded id)", () => {
    // A naive space-join would hash ("loras foo","bar.safetensors") and
    // ("loras","foo bar.safetensors") to the SAME id → wrong-destination adopt.
    const a = startDownloadJob(URL_A, "loras foo", "bar.safetensors");
    const b = startDownloadJob(URL_A, "loras", "foo bar.safetensors");
    expect(a.job.id).not.toBe(b.job.id);
    expect(hoisted.calls).toBe(2);
    expect(listDownloadJobs()).toHaveLength(2);
  });

  it("treats an omitted filename and the explicit URL-derived name as one job", () => {
    // URL basename is big.safetensors; passing it explicitly must resolve to the
    // SAME id so a repeat request adopts the in-flight job (one writer, one file).
    const first = startDownloadJob(URL_A, "checkpoints"); // omitted
    const second = startDownloadJob(URL_A, "checkpoints", "big.safetensors"); // explicit == URL basename
    expect(second.job).toBe(first.job);
    expect(second.job.id).toBe(first.job.id);
    expect(hoisted.calls).toBe(1);
    expect(listDownloadJobs()).toHaveLength(1);
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
    const retry = startDownloadJob(URL_A, "checkpoints");
    expect(hoisted.calls).toBe(2);
    expect(getDownloadJob(retry.job.id)?.status).toBe("downloading");
  });

  it("lists newest first", async () => {
    startDownloadJob(URL_A, "checkpoints");
    await new Promise((r) => setTimeout(r, 2));
    startDownloadJob(URL_B, "loras");
    expect(listDownloadJobs()[0].url).toBe(URL_B);
  });
});
