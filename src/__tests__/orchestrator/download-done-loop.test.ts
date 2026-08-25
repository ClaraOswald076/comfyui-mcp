import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  reconcileDownloadDoneBatch,
  type DownloadDoneInjection,
} from "../../orchestrator/download-done-loop.js";
import { DownloadProgressSnapshots } from "../../orchestrator/index.js";
import { failureRecordDisposition } from "../../orchestrator/download-done-guard.js";
import { listDownloadJobs } from "../../services/download-jobs.js";
import { listPersistedDownloadJobs, setProgressDir } from "../../services/download-progress.js";

const URL = "https://huggingface.co/org/repo/resolve/main/active.safetensors";
const LOCAL_TARGET = "http://127.0.0.1:8188";
const POD_TARGET = "https://pod-3000.proxy.runpod.net";

async function writeRecord(
  dir: string,
  rec: {
    id: string;
    trayId: string;
    progressId: string;
    owner: string;
    target?: string;
    status: "downloading" | "error";
    updated: number;
    error?: string;
  },
): Promise<void> {
  await writeFile(
    join(dir, `control-job-${rec.id}-${rec.owner}.json`),
    JSON.stringify({
      ...rec,
      url: URL,
      target: rec.target ?? LOCAL_TARGET,
      target_subfolder: "checkpoints",
      filename: "active.safetensors",
      started_at: rec.updated - 1_000,
      finished_at: rec.status === "downloading" ? undefined : rec.updated,
    }),
  );
}

describe("download_done production poll reconciliation (#2057)", () => {
  it("does not suppress a real terminal failure for a six-hour-retained stale stream", async () => {
    const dir = await mkdtemp(join(tmpdir(), "download-done-loop-"));
    setProgressDir(dir);
    try {
      const now = Date.now();
      const id = "loop-stale-terminal";
      const trayId = "loop-stale-tray";
      const progressId = "loop-stale-progress";
      await writeRecord(dir, {
        id,
        trayId,
        progressId,
        owner: "terminal",
        status: "error",
        updated: now,
        error: "HTTP 503 upstream reset",
      });
      await writeRecord(dir, {
        id,
        trayId,
        progressId,
        owner: "stale-stream",
        status: "downloading",
        updated: now - 90_000,
      });

      const row = {
        id: progressId,
        target: LOCAL_TARGET,
        name: "active.safetensors",
        status: "error",
      };
      const failedDisagreeing = reconcileDownloadDoneBatch([row]);

      expect(listDownloadJobs().find((job) => job.id === id)).toMatchObject({ status: "error" });
      expect(failedDisagreeing).toEqual([]);
      expect(row.recordDisagrees).toBeUndefined();
      expect(row.error).toBe("HTTP 503 upstream reset");
    } finally {
      setProgressDir("");
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reconciles a fresh advancing stream and bounds its tray error before injection", async () => {
    const dir = await mkdtemp(join(tmpdir(), "download-done-loop-"));
    setProgressDir(dir);
    try {
      const now = Date.now();
      const id = "loop-fresh-stream";
      const trayId = "loop-fresh-tray";
      const progressId = "loop-fresh-progress";
      await writeRecord(dir, {
        id,
        trayId,
        progressId,
        owner: "older-terminal",
        status: "error",
        updated: now - 30_000,
      });
      await writeRecord(dir, {
        id,
        trayId,
        progressId,
        owner: "active-stream",
        status: "downloading",
        updated: now,
      });

      const row = {
        id: progressId,
        target: LOCAL_TARGET,
        name: "active.safetensors",
        status: "error",
        downloaded: 220_000_000,
        total: 19_530_000_000,
        error: "E".repeat(800),
      };
      const progress = new DownloadProgressSnapshots();
      progress.record([
        { id: progressId, target: LOCAL_TARGET, status: "downloading", downloaded: 140_000_000, total: 19_530_000_000 },
      ]);
      progress.record([
        { id: progressId, target: LOCAL_TARGET, status: "downloading", downloaded: 220_000_000, total: 19_530_000_000 },
      ]);
      let injected: DownloadDoneInjection<typeof row> | undefined;
      const failedDisagreeing = reconcileDownloadDoneBatch(
        [row],
        listDownloadJobs(),
        progress,
        (event) => {
          injected = event;
        },
      );

      expect(failedDisagreeing).toEqual([row]);
      expect(injected).toEqual({ kind: "download_done", downloads: [row] });
      expect(row.recordDisagrees).toBe(true);
      expect(row).not.toHaveProperty("progressAdvanced");
      expect(row.error).toBe("E".repeat(400));
    } finally {
      setProgressDir("");
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("promotes a fresh heartbeat with frozen bytes before injecting failure", async () => {
    const dir = await mkdtemp(join(tmpdir(), "download-done-loop-"));
    setProgressDir(dir);
    try {
      const now = Date.now();
      const id = "loop-stalled-stream";
      const trayId = "loop-stalled-tray";
      const progressId = "loop-stalled-progress";
      await writeRecord(dir, {
        id,
        trayId,
        progressId,
        owner: "active-stream",
        status: "downloading",
        updated: now,
      });

      const progress = new DownloadProgressSnapshots();
      const heartbeat = { id: progressId, status: "downloading", downloaded: 220, total: 1_000 };
      progress.record([heartbeat]);
      progress.record([{ ...heartbeat, updated: now + 1 }]);
      const row = {
        id: progressId,
        target: LOCAL_TARGET,
        name: "active.safetensors",
        status: "error",
        error: "HTTP 503 upstream reset",
      };
      let injected: DownloadDoneInjection<typeof row> | undefined;
      expect(failureRecordDisposition(row, listDownloadJobs()).disposition).toBe("stalled");
      const failedDisagreeing = reconcileDownloadDoneBatch(
        [row],
        listDownloadJobs(),
        progress,
        (event) => {
          injected = event;
        },
      );

      expect(failedDisagreeing).toEqual([]);
      expect(injected).toEqual({ kind: "download_done", downloads: [row] });
      expect(listDownloadJobs().find((job) => job.id === id)).toMatchObject({
        status: "error",
        error: "HTTP 503 upstream reset",
      });
      expect(listPersistedDownloadJobs().find((job) => job.id === id)).toMatchObject({
        owner: "active-stream",
        status: "error",
        error: "HTTP 503 upstream reset",
      });
      expect(row.recordDisagrees).toBeUndefined();
      expect(row.error).toBe("HTTP 503 upstream reset");
    } finally {
      setProgressDir("");
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("promotes a stale-only downloading record before injecting its terminal failure", async () => {
    const dir = await mkdtemp(join(tmpdir(), "download-done-loop-"));
    setProgressDir(dir);
    try {
      const now = Date.now();
      const id = "loop-stale-only";
      const trayId = "loop-stale-only-tray";
      const progressId = "loop-stale-only-progress";
      await writeRecord(dir, {
        id,
        trayId,
        progressId,
        owner: "stale-stream",
        target: LOCAL_TARGET,
        status: "downloading",
        updated: now - 90_000,
      });

      const row = {
        id: progressId,
        target: LOCAL_TARGET,
        name: "active.safetensors",
        status: "error",
        error: "HTTP 503 upstream reset",
      };
      let injected: DownloadDoneInjection<typeof row> | undefined;
      const failedDisagreeing = reconcileDownloadDoneBatch(
        [row],
        listDownloadJobs(),
        undefined,
        (event) => {
          injected = event;
        },
      );

      expect(failedDisagreeing).toEqual([]);
      expect(injected).toEqual({ kind: "download_done", downloads: [row] });
      expect(listDownloadJobs().find((job) => job.id === id)).toMatchObject({
        status: "error",
        target: LOCAL_TARGET,
        error: "HTTP 503 upstream reset",
      });
      expect(listPersistedDownloadJobs().find((job) => job.id === id)).toMatchObject({
        owner: "stale-stream",
        status: "error",
      });
      expect(row.recordDisagrees).toBeUndefined();
    } finally {
      setProgressDir("");
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reconciles the matching local record when a pod record shares id and progress identity", async () => {
    const dir = await mkdtemp(join(tmpdir(), "download-done-loop-"));
    setProgressDir(dir);
    try {
      const now = Date.now();
      const id = "loop-local-pod";
      const trayId = "loop-local-pod-tray";
      const progressId = "loop-local-pod-progress";
      await writeRecord(dir, {
        id,
        trayId,
        progressId,
        owner: "local-stream",
        target: LOCAL_TARGET,
        status: "downloading",
        updated: now,
      });
      await writeRecord(dir, {
        id,
        trayId,
        progressId,
        owner: "pod-stream",
        target: POD_TARGET,
        status: "downloading",
        updated: now,
      });

      const records = listDownloadJobs();
      expect(records.filter((job) => job.id === id)).toHaveLength(2);
      expect(new Set(records.filter((job) => job.id === id).map((job) => job.target))).toEqual(
        new Set([LOCAL_TARGET, POD_TARGET]),
      );

      const row = {
        id: progressId,
        target: LOCAL_TARGET,
        name: "active.safetensors",
        status: "error",
        error: "HTTP 503 upstream reset",
      };
      const progress = new DownloadProgressSnapshots();
      progress.record([
        { id: progressId, target: LOCAL_TARGET, status: "downloading", downloaded: 100, total: 1_000 },
      ]);
      progress.record([
        { id: progressId, target: LOCAL_TARGET, status: "downloading", downloaded: 200, total: 1_000 },
      ]);
      let injected: DownloadDoneInjection<typeof row> | undefined;
      const failedDisagreeing = reconcileDownloadDoneBatch(
        [row],
        records,
        progress,
        (event) => {
          injected = event;
        },
      );

      expect(failedDisagreeing).toEqual([row]);
      expect(row.recordDisagrees).toBe(true);
      expect(injected).toEqual({ kind: "download_done", downloads: [row] });
    } finally {
      setProgressDir("");
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not use a pod-only record for a local terminal row at the poll seam", async () => {
    const dir = await mkdtemp(join(tmpdir(), "download-done-loop-"));
    setProgressDir(dir);
    try {
      const now = Date.now();
      const id = "loop-pod-only";
      const trayId = "loop-pod-only-tray";
      const progressId = "loop-pod-only-progress";
      await writeRecord(dir, {
        id,
        trayId,
        progressId,
        owner: "pod-stream",
        target: POD_TARGET,
        status: "downloading",
        updated: now,
      });

      const records = listDownloadJobs();
      const row = {
        id: progressId,
        target: LOCAL_TARGET,
        name: "active.safetensors",
        status: "error",
        error: "HTTP 503 upstream reset",
      };
      const progress = new DownloadProgressSnapshots();
      progress.record([
        { id: progressId, target: LOCAL_TARGET, status: "downloading", downloaded: 100, total: 1_000 },
      ]);
      progress.record([
        { id: progressId, target: LOCAL_TARGET, status: "downloading", downloaded: 200, total: 1_000 },
      ]);
      let injected: DownloadDoneInjection<typeof row> | undefined;
      const failedDisagreeing = reconcileDownloadDoneBatch(
        [row],
        records,
        progress,
        (event) => {
          injected = event;
        },
      );

      expect(failedDisagreeing).toEqual([]);
      expect(injected).toEqual({ kind: "download_done", downloads: [row] });
      expect(row.recordDisagrees).toBeUndefined();
      expect(listDownloadJobs().find((job) => job.id === id)).toMatchObject({
        target: POD_TARGET,
        status: "downloading",
      });
    } finally {
      setProgressDir("");
      await rm(dir, { recursive: true, force: true });
    }
  });
});
