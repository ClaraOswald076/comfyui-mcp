import { describe, it, expect, vi, beforeEach } from "vitest";

const hoisted = vi.hoisted(() => ({
  resolvers: [] as Array<{ resolve: (p: string) => void; reject: (e: Error) => void; url: string }>,
  calls: 0,
}));

// startDownloadJob resolves the canonical destination with the SHARED
// resolveDownloadTarget (so the job is keyed by the exact on-disk targetPath the
// write lands at) and then streams via downloadModel. Mock both: the resolver
// deterministically maps (url, subfolder, filename) → targetPath and REJECTS an
// invalid filename exactly as the real one does, so these tests exercise
// startDownloadJob's keying/adoption/rejection without a live server. The real
// resolveDownloadTarget resolution semantics (trim, "..", url-not-in-identity,
// blank/path-ful rejection) are covered against the real code in
// model-resolver.test.ts.
vi.mock("../../services/model-resolver.js", () => ({
  downloadModel: vi.fn((url: string) => {
    hoisted.calls += 1;
    return new Promise<string>((resolve, reject) => {
      hoisted.resolvers.push({ resolve, reject, url });
    });
  }),
  resolveDownloadTarget: vi.fn(async (url: string, sub: string, filename?: string) => {
    const s = String(sub ?? "").trim();
    if (filename !== undefined) {
      if (filename === "" || filename.includes("/") || filename.includes("\\")) {
        throw new Error("Invalid model filename");
      }
      return { targetDir: `/M/${s}`, filename, targetPath: `/M/${s}/${filename}` };
    }
    const base = String(url).split("/").pop() || "model.safetensors";
    return { targetDir: `/M/${s}`, filename: base, targetPath: `/M/${s}/${base}` };
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

  it("reports a download as in flight rather than finished or failed", async () => {
    // The bug being fixed: an unfinished download must never read as failure.
    const { job } = await startDownloadJob(URL_A, "checkpoints");
    expect(job.status).toBe("downloading");
    expect(job.path).toBeUndefined();
    expect(job.error).toBeUndefined();
  });

  it("exposes the URL-only tray id plus a destination-keyed job id", async () => {
    const { job } = await startDownloadJob(URL_A, "checkpoints");
    // trayId matches the panel tray / progress-file row (URL-only hash).
    expect(job.trayId).toBe(downloadIdFor(URL_A));
    // The public job id is keyed by the resolved destination, still 16 hex.
    expect(job.id).toHaveLength(16);
    expect(getDownloadJob(job.id)?.trayId).toBe(job.trayId);
  });

  it("adopts an in-flight download to the same destination instead of a second copy", async () => {
    const first = await startDownloadJob(URL_A, "checkpoints");
    const second = await startDownloadJob(URL_A, "checkpoints");
    expect(hoisted.calls).toBe(1);
    expect(second.job).toBe(first.job);
    expect(listDownloadJobs()).toHaveLength(1);
  });

  it("starts a genuinely different destination separately", async () => {
    await startDownloadJob(URL_A, "checkpoints"); // → /M/checkpoints/big.safetensors
    await startDownloadJob(URL_B, "checkpoints"); // → /M/checkpoints/other.safetensors
    expect(hoisted.calls).toBe(2);
    expect(listDownloadJobs()).toHaveLength(2);
  });

  it("keys by destination, not URL — different subfolder/filename → distinct pollable jobs", async () => {
    const a = await startDownloadJob(URL_A, "checkpoints");
    const b = await startDownloadJob(URL_A, "loras", "renamed.safetensors");
    expect(hoisted.calls).toBe(2);
    expect(listDownloadJobs()).toHaveLength(2);
    // Distinct public ids (different destinations), shared URL-only trayId.
    expect(a.job.id).not.toBe(b.job.id);
    expect(a.job.trayId).toBe(b.job.trayId);
    expect(getDownloadJob(a.job.id)).toBe(a.job);
    expect(getDownloadJob(b.job.id)).toBe(b.job);
  });

  it("treats TWO different URLs writing the SAME destination as one job (one writer)", async () => {
    // Identity is the resolved targetPath, NOT the URL — two URLs aimed at one
    // file must serialize to a single writer, not race.
    const first = await startDownloadJob(URL_A, "checkpoints", "model.safetensors");
    const second = await startDownloadJob(URL_B, "checkpoints", "model.safetensors");
    expect(second.job).toBe(first.job);
    expect(second.job.id).toBe(first.job.id);
    expect(hoisted.calls).toBe(1);
    expect(listDownloadJobs()).toHaveLength(1);
  });

  it("rejects an invalid filename up front (as downloadModel would), not a silent merge", async () => {
    await expect(startDownloadJob(URL_A, "checkpoints", "dir/x.safetensors")).rejects.toThrow();
    await expect(startDownloadJob(URL_A, "checkpoints", "")).rejects.toThrow();
    // Nothing was registered for the rejected inputs.
    expect(listDownloadJobs()).toHaveLength(0);
    expect(hoisted.calls).toBe(0);
  });

  it("records the landed path on success", async () => {
    const { job, settled } = await startDownloadJob(URL_A, "checkpoints");
    hoisted.resolvers[0].resolve("C:/models/checkpoints/big.safetensors");
    await settled;
    expect(job.status).toBe("done");
    expect(job.path).toBe("C:/models/checkpoints/big.safetensors");
    expect(job.finished_at).toBeGreaterThan(0);
  });

  it("captures a failure without rejecting the stored promise", async () => {
    // An unhandled rejection here would kill the process over a 404.
    const { job, settled } = await startDownloadJob(URL_A, "checkpoints");
    hoisted.resolvers[0].reject(new Error("HTTP 404"));
    await expect(settled).resolves.toBeUndefined();
    expect(job.status).toBe("error");
    expect(job.error).toContain("404");
  });

  it("allows a retry once a download has failed", async () => {
    const first = await startDownloadJob(URL_A, "checkpoints");
    hoisted.resolvers[0].reject(new Error("network reset"));
    await first.settled;
    // Adoption must not pin a dead job forever — a retry has to start a new one.
    const retry = await startDownloadJob(URL_A, "checkpoints");
    expect(hoisted.calls).toBe(2);
    expect(getDownloadJob(retry.job.id)?.status).toBe("downloading");
  });

  it("lists newest first", async () => {
    await startDownloadJob(URL_A, "checkpoints");
    await new Promise((r) => setTimeout(r, 2));
    await startDownloadJob(URL_B, "loras");
    expect(listDownloadJobs()[0].url).toBe(URL_B);
  });
});
