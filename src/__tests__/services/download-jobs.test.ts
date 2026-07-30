import { describe, it, expect, vi, beforeEach } from "vitest";

const hoisted = vi.hoisted(() => ({
  resolvers: [] as Array<{ resolve: (p: string) => void; reject: (e: Error) => void; url: string }>,
  calls: 0,
  remote: false,
  resolveTargetCalls: 0,
  // Routing-predicate instrumentation. `dispatchQueue` lets a test make the
  // predicate FLIP between evaluations; `dispatchEvals` counts how many times it
  // was actually evaluated; `lastDispatchArg` records the decision threaded into
  // downloadModel — together they prove the route is decided ONCE and the writer
  // follows it (#420 codex round 1 split-brain guard).
  dispatchQueue: [] as boolean[],
  dispatchEvals: 0,
  lastDispatchArg: undefined as boolean | undefined,
}));

// isRemoteMode gates the identity branch in startDownloadJob. Keep every other
// real config export (logger etc. depend on them); only the flag is controlled.
vi.mock("../../config.js", async () => {
  const actual = await vi.importActual<typeof import("../../config.js")>("../../config.js");
  return { ...actual, isRemoteMode: () => hoisted.remote };
});

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
  // The single routing decision startDownloadJob now consults to choose the job
  // identity: manager-dispatch (remote OR #420 reconnect-fallback) skips local
  // target resolution; local streams key by the resolved targetPath. `dispatchQueue`
  // (when non-empty) supplies successive return values so a test can FLIP the
  // predicate between evaluations; otherwise it mirrors `hoisted.remote`.
  shouldDispatchDownloadToManager: vi.fn(async () => {
    hoisted.dispatchEvals += 1;
    return hoisted.dispatchQueue.length ? hoisted.dispatchQueue.shift()! : hoisted.remote;
  }),
  // Capture the routing decision THREADED IN by startDownloadJob (5th arg) so a
  // test can assert the writer used the job's decision, not a fresh evaluation.
  downloadModel: vi.fn(
    (url: string, _sub?: string, _fn?: string, _auth?: unknown, dispatchToManager?: boolean) => {
      hoisted.calls += 1;
      hoisted.lastDispatchArg = dispatchToManager;
      return new Promise<string>((resolve, reject) => {
        hoisted.resolvers.push({ resolve, reject, url });
      });
    },
  ),
  resolveDownloadTarget: vi.fn(async (url: string, sub: string, filename?: string) => {
    hoisted.resolveTargetCalls += 1;
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
    hoisted.remote = false;
    hoisted.resolveTargetCalls = 0;
    hoisted.dispatchQueue.length = 0;
    hoisted.dispatchEvals = 0;
    hoisted.lastDispatchArg = undefined;
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

  it("in remote mode keys WITHOUT resolving a local target and dispatches to the Manager", async () => {
    // Regression guard: the shared resolver throws when no local models dir exists
    // (COMFYUI_PATH unset). Remote downloads go straight to the Manager, so
    // startDownloadJob must NOT resolve a local targetPath in remote mode.
    hoisted.remote = true;
    const { job } = await startDownloadJob(URL_A, "checkpoints");
    expect(job.status).toBe("downloading");
    expect(hoisted.resolveTargetCalls).toBe(0); // no local resolution attempted
    expect(hoisted.calls).toBe(1); // downloadModel invoked (takes the Manager path)
    // A repeated identical remote request still adopts the in-flight job.
    const again = await startDownloadJob(URL_A, "checkpoints");
    expect(again.job).toBe(job);
    expect(hoisted.calls).toBe(1);
  });

  it("#420: a reconnect-fallback Manager route keys WITHOUT resolving a local target", async () => {
    // After a reconnect drops the effective base, shouldDispatchDownloadToManager
    // returns true for a nominally-local session (driven here by hoisted.remote).
    // startDownloadJob must then take the Manager path and NOT resolve a local
    // targetPath (which would throw "no local ComfyUI path configured") — the exact
    // #420 immediate failure. Adoption of a repeated request must still hold.
    hoisted.remote = true;
    const { job } = await startDownloadJob(URL_A, "loras");
    expect(job.status).toBe("downloading");
    expect(hoisted.resolveTargetCalls).toBe(0);
    expect(hoisted.calls).toBe(1);
    const again = await startDownloadJob(URL_A, "loras");
    expect(again.job).toBe(job);
    expect(hoisted.calls).toBe(1);
  });

  it("#420 split-brain guard: the writer follows the job's ONE routing decision even if reachability would flip", async () => {
    // The predicate awaits live /system_stats + mutable base config, so it could
    // return DIFFERENT answers at the two points it used to be evaluated (job-id
    // keying, then the writer). Model that flip: first eval → Manager, a hypothetical
    // second eval → local. The fix evaluates ONCE and threads the result through, so:
    hoisted.dispatchQueue.push(true, false); // [job-eval → true, would-be writer-eval → false]
    const { job } = await startDownloadJob(URL_A, "loras");
    // Keyed as a Manager job off the FIRST (only) evaluation — no local target resolved.
    expect(hoisted.resolveTargetCalls).toBe(0);
    // The predicate was evaluated EXACTLY ONCE (the "false" in the queue is untouched)…
    expect(hoisted.dispatchEvals).toBe(1);
    expect(hoisted.dispatchQueue).toEqual([false]);
    // …and the writer received that SAME decision (true), NOT a fresh re-evaluation.
    expect(hoisted.lastDispatchArg).toBe(true);
    // One request → one writer, one job. No split, no duplicate.
    expect(hoisted.calls).toBe(1);
    expect(listDownloadJobs()).toHaveLength(1);
  });

  it("threads the LOCAL decision into the writer too (not just the Manager case)", async () => {
    // Symmetric guard: a local job must hand downloadModel dispatchToManager=false
    // so the writer streams to the same targetPath the id was keyed on.
    hoisted.remote = false;
    await startDownloadJob(URL_A, "checkpoints");
    expect(hoisted.resolveTargetCalls).toBe(1); // local id keyed by resolved target
    expect(hoisted.dispatchEvals).toBe(1);
    expect(hoisted.lastDispatchArg).toBe(false);
  });

  it("#420 cross-call dedup: a Manager→local flip BETWEEN two calls still finds the one in-flight job", async () => {
    // The registry index must be ROUTE-INDEPENDENT (#420 codex round 2). Two
    // SEPARATE calls for the SAME request, with a reachability flip between them
    // (call 1 → Manager, call 2 → local), used to compute DIFFERENT keys (remote
    // tuple vs resolved local path) — so call 2 missed the in-flight entry and
    // started a SECOND writer onto one file. With a stable request key, call 2
    // adopts call 1.
    hoisted.dispatchQueue.push(true, false);
    const first = await startDownloadJob(URL_A, "loras");
    const second = await startDownloadJob(URL_A, "loras");
    expect(second.job).toBe(first.job); // same in-flight job, no duplicate
    expect(hoisted.calls).toBe(1); // exactly ONE writer for the request
    expect(listDownloadJobs()).toHaveLength(1); // one registry entry, not two
  });

  it("#420 cross-call dedup: a local→Manager flip BETWEEN two calls also finds the one job", async () => {
    // The reverse flip direction must dedup too.
    hoisted.dispatchQueue.push(false, true);
    const first = await startDownloadJob(URL_A, "loras");
    const second = await startDownloadJob(URL_A, "loras");
    expect(second.job).toBe(first.job);
    expect(hoisted.calls).toBe(1);
    expect(listDownloadJobs()).toHaveLength(1);
  });

  it("lists newest first", async () => {
    await startDownloadJob(URL_A, "checkpoints");
    await new Promise((r) => setTimeout(r, 2));
    await startDownloadJob(URL_B, "loras");
    expect(listDownloadJobs()[0].url).toBe(URL_B);
  });
});
