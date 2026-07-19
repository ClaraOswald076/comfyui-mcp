import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The registry is module-level state keyed off COMFYUI_MCP_TRAINING_DIR, so each
// test gets a fresh module (vi.resetModules) pointed at a fresh temp dir. All
// docker/catalog seams are injected fakes — no docker daemon or ComfyUI needed.

let root: string;
let mod: typeof import("../../services/training-jobs.js");

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function fakeHandle(d: ReturnType<typeof deferred<{ code: number; tail: string }>>) {
  return {
    containerName: "fake",
    done: d.promise,
    child: {} as never,
  };
}

/** A catalog fake capturing upsert/setPreview calls. */
function fakeCatalog() {
  const upserts: unknown[] = [];
  const previews: { id: string; src: string }[] = [];
  return {
    upserts,
    previews,
    upsert(partial: Record<string, unknown>) {
      upserts.push(partial);
      return { id: "loras-test-job", previewFile: undefined, ...partial } as never;
    },
    setPreview(id: string, src: string) {
      previews.push({ id, src });
      return { id, previewFile: `${id}.png` } as never;
    },
  };
}

beforeEach(async () => {
  vi.resetModules();
  root = mkdtempSync(join(tmpdir(), "training-jobs-test-"));
  process.env.COMFYUI_MCP_TRAINING_DIR = join(root, "training");
  mod = await import("../../services/training-jobs.js");
});

afterEach(() => {
  delete process.env.COMFYUI_MCP_TRAINING_DIR;
  rmSync(root, { recursive: true, force: true });
});

function makeImage(dir: string, name: string): string {
  const p = join(dir, name);
  writeFileSync(p, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  return p;
}

describe("prepareDataset", () => {
  it("stages images with captions and a defaultCaption fallback", async () => {
    const src = join(root, "src");
    mkdirSync(src);
    const a = makeImage(src, "a photo.png");
    const b = makeImage(src, "b.jpg");
    const out = await mod.prepareDataset({
      name: "My Character!",
      items: [{ path: a, caption: "ohwx smiling, park" }, { path: b }],
      defaultCaption: "ohwx person",
    });
    expect(out.imageCount).toBe(2);
    expect(out.captionedCount).toBe(2);
    expect(out.warnings).toHaveLength(0);
    expect(existsSync(join(out.datasetPath, "img_00001.png"))).toBe(true);
    expect(readFileSync(join(out.datasetPath, "img_00001.txt"), "utf-8")).toBe("ohwx smiling, park");
    expect(readFileSync(join(out.datasetPath, "img_00002.txt"), "utf-8")).toBe("ohwx person");
  });

  it("warns when neither item caption nor defaultCaption is set", async () => {
    const src = join(root, "src");
    mkdirSync(src);
    const a = makeImage(src, "a.png");
    const out = await mod.prepareDataset({ name: "d", items: [{ path: a }] });
    expect(out.captionedCount).toBe(0);
    expect(out.warnings).toHaveLength(1);
    expect(existsSync(join(out.datasetPath, "img_00001.png"))).toBe(true);
  });

  it("rejects empty items, missing files, and non-image extensions", async () => {
    await expect(mod.prepareDataset({ name: "d", items: [] })).rejects.toThrow(/at least one image/);
    await expect(mod.prepareDataset({ name: "d", items: [{ path: join(root, "nope.png") }] })).rejects.toThrow(/image not found/);
    const txt = join(root, "notes.txt");
    writeFileSync(txt, "hi");
    await expect(mod.prepareDataset({ name: "d", items: [{ path: txt }] })).rejects.toThrow(/not a supported image/);
  });

  it("replaces a previously staged dataset of the same name (no stale files)", async () => {
    const src = join(root, "src");
    mkdirSync(src);
    const a = makeImage(src, "a.png");
    const b = makeImage(src, "b.png");
    const first = await mod.prepareDataset({ name: "same", items: [{ path: a }, { path: b }], defaultCaption: "ohwx" });
    expect(readdirSync(first.datasetPath).filter((f) => f.endsWith(".png"))).toHaveLength(2);
    const second = await mod.prepareDataset({ name: "same", items: [{ path: a }], defaultCaption: "ohwx" });
    expect(second.datasetPath).toBe(first.datasetPath);
    const files = readdirSync(second.datasetPath);
    expect(files.filter((f) => f.endsWith(".png"))).toHaveLength(1);
    expect(files).not.toContain("img_00002.png");
    expect(files).not.toContain("img_00002.txt");
  });

  it("keeps the previous dataset intact when the replacement has a bad item", async () => {
    const src = join(root, "src");
    mkdirSync(src);
    const a = makeImage(src, "a.png");
    const b = makeImage(src, "b.png");
    const first = await mod.prepareDataset({ name: "swap", items: [{ path: a }, { path: b }], defaultCaption: "ohwx" });
    await expect(
      mod.prepareDataset({ name: "swap", items: [{ path: a }, { path: join(root, "gone.png") }] }),
    ).rejects.toThrow(/image not found/);
    // Old staging untouched, no staging temp left behind.
    expect(readdirSync(first.datasetPath).filter((f) => f.endsWith(".png"))).toHaveLength(2);
    expect(existsSync(`${first.datasetPath}.staging-${process.pid}`)).toBe(false);
  });

  it("refuses to restage a dataset a running job is training from", async () => {
    const src = join(root, "src");
    mkdirSync(src);
    const a = makeImage(src, "a.png");
    const staged = await mod.prepareDataset({ name: "busy", items: [{ path: a }] });
    // A running job pointing at this dataset dir (persisted record, foreign process).
    mkdirSync(mod.jobsRoot(), { recursive: true });
    const jobFile = join(mod.jobsRoot(), "tbusy1.json");
    writeFileSync(jobFile, JSON.stringify({
      id: "tbusy1", name: "busy_lora", flow: "character", model: "flux1-dev",
      status: "running", progress: { samples: [] }, containerName: "comfyui-train-tbusy1",
      datasetPath: staged.datasetPath, jobDir: join(mod.jobsRoot(), "tbusy1"),
      outputDir: join(mod.jobsRoot(), "tbusy1", "output"), log: [],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }));
    await expect(
      mod.prepareDataset({ name: "busy", items: [{ path: a }] }, { containerRunning: async () => true }),
    ).rejects.toThrow(/in use by running job tbusy1/);
    // Once the job is terminal, restaging works again.
    writeFileSync(jobFile, JSON.stringify({ ...JSON.parse(readFileSync(jobFile, "utf-8")), status: "completed" }));
    await expect(mod.prepareDataset({ name: "busy", items: [{ path: a }] })).resolves.toMatchObject({ imageCount: 1 });
  });
});

describe("findProducedLora", () => {
  it("prefers the exact final save over checkpoints", () => {
    const dir = join(root, "output", "job1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "job1_000000250.safetensors"), "a");
    writeFileSync(join(dir, "job1.safetensors"), "b");
    expect(mod.findProducedLora(join(root, "output"), "job1")).toBe(join(dir, "job1.safetensors"));
  });

  it("falls back to the highest-step checkpoint", () => {
    const dir = join(root, "output", "job1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "job1_000000250.safetensors"), "a");
    writeFileSync(join(dir, "job1_000001000.safetensors"), "b");
    expect(mod.findProducedLora(join(root, "output"), "job1")).toBe(join(dir, "job1_000001000.safetensors"));
  });

  it("returns null when nothing was produced", () => {
    expect(mod.findProducedLora(join(root, "output"), "ghost")).toBeNull();
  });
});

describe("startTrainingJob", () => {
  async function startWith(deps: Parameters<typeof mod.startTrainingJob>[1], name = "test_job") {
    const dataset = join(root, "dataset");
    mkdirSync(dataset, { recursive: true });
    makeImage(dataset, "img_00001.png");
    writeFileSync(join(dataset, "img_00001.txt"), "ohwx person");
    return mod.startTrainingJob(
      { name, flow: "character", model: "flux1-dev", datasetPath: dataset, trigger: "ohwx", params: { steps: 200 } },
      deps,
    );
  }

  it("runs to completion: config written, progress tracked, LoRA handed off + cataloged", async () => {
    const d = deferred<{ code: number; tail: string }>();
    const catalog = fakeCatalog();
    const lorasDir = join(root, "loras");
    const seen: { containerName?: string; configPath?: string } = {};
    const job = await startWith({
      startTraining: (opts) => {
        seen.containerName = opts.containerName;
        seen.configPath = opts.configPath;
        // Simulate ai-toolkit writing its outputs, then exiting 0.
        const outDir = join(opts.outputDir, "test_job");
        mkdirSync(join(outDir, "samples"), { recursive: true });
        writeFileSync(join(outDir, "test_job.safetensors"), "weights");
        writeFileSync(join(outDir, "samples", "0001.png"), "sample");
        opts.onProgress?.({ step: 199, totalSteps: 200, loss: 0.12, raw: "199/200 loss: 0.12" });
        // Resolve on a timer (not a microtask) so the job is still running when
        // startTrainingJob returns, matching real long-running behavior.
        setTimeout(() => d.resolve({ code: 0, tail: "" }), 5);
        return fakeHandle(d);
      },
      lorasDir: () => lorasDir,
      catalog,
    });

    expect(job.status).toBe("running");
    expect(job.progress.step).toBe(199);
    expect(job.containerName).toMatch(/^comfyui-train-/);
    // The generated config exists and points at the container mount points.
    const yaml = readFileSync(seen.configPath!, "utf-8");
    expect(yaml).toContain("folder_path: /dataset");
    expect(yaml).toContain("training_folder: /output");
    expect(yaml).toContain("trigger_word: ohwx");

    // Let handle.done + finalizeJob run.
    await new Promise((r) => setTimeout(r, 20));
    const done = (await mod.getJob(job.id))!;
    expect(done.status).toBe("completed");
    // Completed jobs normalize the last bar (199/200) to the full count.
    expect(done.progress.step).toBe(200);
    // Samples are picked up from the output dir at finalize (ai-toolkit prints
    // no saved-sample lines for onProgress to catch).
    expect(done.progress.samples).toHaveLength(1);
    expect(done.progress.samples[0]).toContain("0001.png");
    expect(done.result!.loraPath).toBe(join(lorasDir, "test_job.safetensors"));
    expect(existsSync(done.result!.loraPath)).toBe(true);
    expect(done.result!.loraRelPath).toBe("loras/test_job.safetensors");
    expect(catalog.upserts).toHaveLength(1);
    const upsert = catalog.upserts[0] as Record<string, unknown>;
    expect(upsert.keywords).toEqual(["ohwx"]);
    expect(upsert.baseModels).toEqual(["FLUX.1-dev"]);
    expect(upsert.missing).toBe(false);
    expect(catalog.previews).toHaveLength(1);
    expect(done.result!.previewFile).toBe("loras-test-job.png");
  });

  it("marks the job failed when the container exits non-zero", async () => {
    const d = deferred<{ code: number; tail: string }>();
    const job = await startWith({
      startTraining: () => {
        queueMicrotask(() => d.resolve({ code: 1, tail: "CUDA OOM" }));
        return fakeHandle(d);
      },
      lorasDir: () => join(root, "loras"),
      catalog: fakeCatalog(),
    });
    await new Promise((r) => setTimeout(r, 20));
    const done = (await mod.getJob(job.id))!;
    expect(done.status).toBe("failed");
    expect(done.error).toContain("exited 1");
    expect(done.error).toContain("CUDA OOM");
  });

  it("fails the job when training succeeded but produced no LoRA", async () => {
    const d = deferred<{ code: number; tail: string }>();
    const job = await startWith({
      startTraining: () => {
        queueMicrotask(() => d.resolve({ code: 0, tail: "" }));
        return fakeHandle(d);
      },
      lorasDir: () => join(root, "loras"),
      catalog: fakeCatalog(),
    });
    await new Promise((r) => setTimeout(r, 20));
    expect((await mod.getJob(job.id))!.status).toBe("failed");
    expect((await mod.getJob(job.id))!.error).toContain("handoff");
  });

  it("rejects a dataset with no images", async () => {
    const empty = join(root, "empty");
    mkdirSync(empty);
    await expect(
      mod.startTrainingJob({ name: "x", flow: "character", model: "flux1-dev", datasetPath: empty }),
    ).rejects.toThrow(/no images/);
  });

  it("fails BEFORE launching the container when the loras destination is unresolvable", async () => {
    const dataset = join(root, "dataset");
    mkdirSync(dataset, { recursive: true });
    makeImage(dataset, "img_00001.png");
    let containerStarted = false;
    await expect(
      mod.startTrainingJob(
        { name: "x", flow: "character", model: "flux1-dev", datasetPath: dataset },
        {
          startTraining: () => {
            containerStarted = true;
            return fakeHandle(deferred<{ code: number; tail: string }>());
          },
          lorasDir: () => {
            throw new Error("No local ComfyUI path configured");
          },
          catalog: fakeCatalog(),
        },
      ),
    ).rejects.toThrow(/No local ComfyUI path/);
    expect(containerStarted).toBe(false);
  });

  it("persists throttled progress snapshots so other processes see live state", async () => {
    vi.useFakeTimers();
    try {
      const d = deferred<{ code: number; tail: string }>();
      let tick: ((p: { step?: number; totalSteps?: number; raw: string }) => void) | undefined;
      const dataset = join(root, "dataset");
      mkdirSync(dataset, { recursive: true });
      makeImage(dataset, "img_00001.png");
      const job = await mod.startTrainingJob(
        { name: "snap_me", flow: "character", model: "flux1-dev", datasetPath: dataset, params: { steps: 200 } },
        {
          startTraining: (opts) => {
            tick = opts.onProgress;
            return fakeHandle(d);
          },
          lorasDir: () => join(root, "loras"),
          catalog: fakeCatalog(),
        },
      );
      const file = join(mod.jobsRoot(), `${job.id}.json`);
      const readStep = () => (JSON.parse(readFileSync(file, "utf-8")) as { progress: { step?: number } }).progress.step;

      tick!({ step: 10, totalSteps: 200, raw: "10/200" });
      expect(readStep()).toBe(10); // first tick always persists
      tick!({ step: 20, totalSteps: 200, raw: "20/200" });
      expect(readStep()).toBe(10); // inside the 5s throttle window
      vi.setSystemTime(Date.now() + 6000);
      tick!({ step: 30, totalSteps: 200, raw: "30/200" });
      expect(readStep()).toBe(30); // past the window → snapshot written
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("cancelJob", () => {
  it("stops the container and keeps 'cancelled' even when done resolves later", async () => {
    const d = deferred<{ code: number; tail: string }>();
    const stopped: string[] = [];
    const dataset = join(root, "dataset");
    mkdirSync(dataset, { recursive: true });
    makeImage(dataset, "img_00001.png");
    const job = await mod.startTrainingJob(
      { name: "cancel_me", flow: "character", model: "flux1-dev", datasetPath: dataset },
      {
        startTraining: () => fakeHandle(d),
        stopTraining: async (name) => {
          stopped.push(name);
          return { ok: true, command: "train_cancel", data: { stopped: name } };
        },
        lorasDir: () => join(root, "loras"),
        catalog: fakeCatalog(),
      },
    );
    const cancelled = await mod.cancelJob(job.id, {
      stopTraining: async (name) => {
        stopped.push(name);
        return { ok: true, command: "train_cancel", data: { stopped: name } };
      },
      containerRunning: async () => false,
    });
    expect(cancelled.status).toBe("cancelled");
    expect(stopped).toEqual([job.containerName]);
    // Container exits (killed) afterwards — finalize must not resurrect it.
    d.resolve({ code: 0, tail: "" });
    await new Promise((r) => setTimeout(r, 20));
    expect((await mod.getJob(job.id))!.status).toBe("cancelled");
  });

  it("ignores progress ticks that arrive after a cancel (no resurrection)", async () => {
    const d = deferred<{ code: number; tail: string }>();
    let tick: ((p: { step?: number; totalSteps?: number; raw: string }) => void) | undefined;
    const dataset = join(root, "dataset");
    mkdirSync(dataset, { recursive: true });
    makeImage(dataset, "img_00001.png");
    const job = await mod.startTrainingJob(
      { name: "zombie", flow: "character", model: "flux1-dev", datasetPath: dataset },
      {
        startTraining: (opts) => {
          tick = opts.onProgress;
          return fakeHandle(d);
        },
        lorasDir: () => join(root, "loras"),
        catalog: fakeCatalog(),
      },
    );
    await mod.cancelJob(job.id, {
      stopTraining: async (name) => ({ ok: true, command: "train_cancel", data: { stopped: name } }),
      containerRunning: async () => false,
    });
    // A late tqdm line flushes while docker stop is in flight — must be ignored.
    tick!({ step: 42, totalSteps: 200, loss: 0.3, raw: "42/200 loss: 0.3" });
    expect(job.status).toBe("cancelled");
    expect(job.progress.step).toBeUndefined();
    const disk = JSON.parse(readFileSync(join(mod.jobsRoot(), `${job.id}.json`), "utf-8")) as { status: string };
    expect(disk.status).toBe("cancelled");
  });

  it("adopts a foreign cancel seen on disk instead of clobbering it at persist", async () => {
    vi.useFakeTimers();
    try {
      const d = deferred<{ code: number; tail: string }>();
      let tick: ((p: { step?: number; totalSteps?: number; raw: string }) => void) | undefined;
      const dataset = join(root, "dataset");
      mkdirSync(dataset, { recursive: true });
      makeImage(dataset, "img_00001.png");
      const job = await mod.startTrainingJob(
        { name: "foreign_cancel", flow: "character", model: "flux1-dev", datasetPath: dataset },
        {
          startTraining: (opts) => {
            tick = opts.onProgress;
            return fakeHandle(d);
          },
          lorasDir: () => join(root, "loras"),
          catalog: fakeCatalog(),
        },
      );
      // Another process cancels: only the DISK record shows it; our memory
      // still says running. The next throttled persist must adopt, not clobber.
      const file = join(mod.jobsRoot(), `${job.id}.json`);
      const record = JSON.parse(readFileSync(file, "utf-8")) as { status: string; finishedAt?: string };
      record.status = "cancelled";
      record.finishedAt = new Date().toISOString();
      writeFileSync(file, JSON.stringify(record, null, 2));
      vi.setSystemTime(Date.now() + 6000); // past the persist throttle window
      tick!({ step: 10, totalSteps: 200, loss: 0.5, raw: "10/200 loss: 0.5" });
      expect(job.status).toBe("cancelled");
      const disk = JSON.parse(readFileSync(file, "utf-8")) as { status: string };
      expect(disk.status).toBe("cancelled");
      // And when the container finally exits, no handoff happens.
      d.resolve({ code: 0, tail: "" });
      await Promise.resolve();
      vi.useRealTimers();
      await new Promise((r) => setTimeout(r, 20));
      expect((await mod.getJob(job.id))!.status).toBe("cancelled");
    } finally {
      vi.useRealTimers();
    }
  });

  it("resumes when a foreign cancel is rolled back after a failed stop", async () => {
    vi.useFakeTimers();
    try {
      const d = deferred<{ code: number; tail: string }>();
      let tick: ((p: { step?: number; totalSteps?: number; raw: string }) => void) | undefined;
      const catalog = fakeCatalog();
      const lorasDir = join(root, "loras");
      const dataset = join(root, "dataset");
      mkdirSync(dataset, { recursive: true });
      makeImage(dataset, "img_00001.png");
      const job = await mod.startTrainingJob(
        { name: "rollback", flow: "character", model: "flux1-dev", datasetPath: dataset },
        {
          startTraining: (opts) => {
            tick = opts.onProgress;
            return fakeHandle(d);
          },
          lorasDir: () => lorasDir,
          catalog,
        },
      );
      const file = join(mod.jobsRoot(), `${job.id}.json`);
      const record = JSON.parse(readFileSync(file, "utf-8")) as { status: string };
      record.status = "cancelled";
      writeFileSync(file, JSON.stringify(record, null, 2));
      vi.setSystemTime(Date.now() + 6000);
      tick!({ step: 10, totalSteps: 200, loss: 0.5, raw: "10/200 loss: 0.5" });
      expect(job.status).toBe("cancelled"); // adopted from disk
      // The cancelling process's docker stop FAILED → it reverts the record.
      record.status = "running";
      writeFileSync(file, JSON.stringify(record, null, 2));
      tick!({ step: 11, totalSteps: 200, loss: 0.4, raw: "11/200 loss: 0.4" });
      expect(job.status).toBe("running"); // reconciled, not stuck cancelled
      // A later successful completion now finalizes + hands off normally.
      const outDir = join(job.outputDir, "rollback");
      mkdirSync(outDir, { recursive: true });
      writeFileSync(join(outDir, "rollback.safetensors"), "weights");
      d.resolve({ code: 0, tail: "" });
      await Promise.resolve();
      vi.useRealTimers();
      await new Promise((r) => setTimeout(r, 20));
      const final = (await mod.getJob(job.id))!;
      expect(final.status).toBe("completed");
      expect(final.result!.loraPath).toBe(join(lorasDir, "rollback.safetensors"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("reverts to running when the container genuinely fails to stop", async () => {
    const d = deferred<{ code: number; tail: string }>();
    const dataset = join(root, "dataset");
    mkdirSync(dataset, { recursive: true });
    makeImage(dataset, "img_00001.png");
    const job = await mod.startTrainingJob(
      { name: "cant_stop", flow: "character", model: "flux1-dev", datasetPath: dataset },
      { startTraining: () => fakeHandle(d), lorasDir: () => join(root, "loras"), catalog: fakeCatalog() },
    );
    const after = await mod.cancelJob(job.id, {
      stopTraining: async () => ({ ok: false, command: "train_cancel", error: { code: "stop_failed", message: "daemon unreachable" } }),
      containerRunning: async () => true,
    });
    expect(after.status).toBe("running");
    expect(after.error).toContain("cancel failed");
    // And a later successful finalize still completes the job normally.
    const outDir = join(job.outputDir, "cant_stop");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "cant_stop.safetensors"), "weights");
    d.resolve({ code: 0, tail: "" });
    await new Promise((r) => setTimeout(r, 20));
    expect((await mod.getJob(job.id))!.status).toBe("completed");
  });

  it("respects a cancel written by ANOTHER process (disk record) at finalize", async () => {
    const d = deferred<{ code: number; tail: string }>();
    const dataset = join(root, "dataset");
    mkdirSync(dataset, { recursive: true });
    makeImage(dataset, "img_00001.png");
    const catalog = fakeCatalog();
    const job = await mod.startTrainingJob(
      { name: "cross_cancel", flow: "character", model: "flux1-dev", datasetPath: dataset },
      { startTraining: () => fakeHandle(d), lorasDir: () => join(root, "loras"), catalog },
    );
    // Another process (e.g. orchestrator call_tool client) cancels via disk:
    // its cancelJob persists status=cancelled, unseen by this process's memory.
    const file = join(mod.jobsRoot(), `${job.id}.json`);
    const record = JSON.parse(readFileSync(file, "utf-8")) as { status: string; finishedAt?: string };
    record.status = "cancelled";
    record.finishedAt = new Date().toISOString();
    writeFileSync(file, JSON.stringify(record, null, 2));
    // The killed container then exits 0 (docker stop can be a clean exit) —
    // finalize must keep 'cancelled' and skip the handoff.
    d.resolve({ code: 0, tail: "" });
    await new Promise((r) => setTimeout(r, 20));
    const final = (await mod.getJob(job.id))!;
    expect(final.status).toBe("cancelled");
    expect(final.result).toBeUndefined();
    expect(catalog.upserts).toHaveLength(0);
  });

  it("retries docker stop for an already-cancelled job whose container is still alive", async () => {
    const dataset = join(root, "dataset");
    mkdirSync(dataset, { recursive: true });
    makeImage(dataset, "img_00001.png");
    mkdirSync(mod.jobsRoot(), { recursive: true });
    // A cancelled-on-disk job left behind by a process that died mid-stop.
    const file = join(mod.jobsRoot(), "tzombie1.json");
    writeFileSync(file, JSON.stringify({
      id: "tzombie1", name: "zombie_lora", flow: "character", model: "flux1-dev",
      status: "cancelled", progress: { samples: [] }, containerName: "comfyui-train-tzombie1",
      datasetPath: dataset, jobDir: join(mod.jobsRoot(), "tzombie1"),
      outputDir: join(mod.jobsRoot(), "tzombie1", "output"), log: [],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    }));
    const stopped: string[] = [];
    let alive = true;
    const after = await mod.cancelJob("tzombie1", {
      containerRunning: async () => alive, // still burning GPU until stopped
      stopTraining: async (name) => {
        stopped.push(name);
        alive = false;
        return { ok: true, command: "train_cancel", data: { stopped: name } };
      },
    });
    expect(stopped).toEqual(["comfyui-train-tzombie1"]);
    expect(after.status).toBe("cancelled");

    // And when the retry ALSO fails, the job goes back to running (honest).
    const after2 = await mod.cancelJob("tzombie1", {
      containerRunning: async () => true,
      stopTraining: async () => ({ ok: false, command: "train_cancel", error: { code: "stop_failed", message: "timeout" } }),
    });
    expect(after2.status).toBe("running");
    expect(after2.error).toContain("cancel retry failed");
  });

  it("leaves an already-cancelled job alone when its container is gone", async () => {
    const dataset = join(root, "dataset");
    mkdirSync(dataset, { recursive: true });
    makeImage(dataset, "img_00001.png");
    mkdirSync(mod.jobsRoot(), { recursive: true });
    const file = join(mod.jobsRoot(), "tgone1.json");
    writeFileSync(file, JSON.stringify({
      id: "tgone1", name: "gone_lora", flow: "character", model: "flux1-dev",
      status: "cancelled", progress: { samples: [] }, containerName: "comfyui-train-tgone1",
      datasetPath: dataset, jobDir: join(mod.jobsRoot(), "tgone1"),
      outputDir: join(mod.jobsRoot(), "tgone1", "output"), log: [],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    }));
    let stops = 0;
    const after = await mod.cancelJob("tgone1", {
      containerRunning: async () => false,
      stopTraining: async (name) => {
        stops++;
        return { ok: true, command: "train_cancel", data: { stopped: name } };
      },
    });
    expect(after.status).toBe("cancelled");
    expect(stops).toBe(0);
  });

  it("attempts the stop when cancelled-job liveness is UNKNOWN (daemon flapping)", async () => {
    const dataset = join(root, "dataset");
    mkdirSync(dataset, { recursive: true });
    makeImage(dataset, "img_00001.png");
    mkdirSync(mod.jobsRoot(), { recursive: true });
    const file = join(mod.jobsRoot(), "tunknown1.json");
    writeFileSync(file, JSON.stringify({
      id: "tunknown1", name: "unknown_lora", flow: "character", model: "flux1-dev",
      status: "cancelled", progress: { samples: [] }, containerName: "comfyui-train-tunknown1",
      datasetPath: dataset, jobDir: join(mod.jobsRoot(), "tunknown1"),
      outputDir: join(mod.jobsRoot(), "tunknown1", "output"), log: [],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    }));
    let stops = 0;
    const after = await mod.cancelJob("tunknown1", {
      containerRunning: async () => null, // daemon unreachable — can't tell
      stopTraining: async (name) => {
        stops++;
        return { ok: false, command: "train_cancel", error: { code: "stop_failed", message: "daemon unreachable" } };
      },
    });
    expect(stops).toBe(1); // stop attempted, not skipped on "unknown"
    expect(after.status).toBe("running"); // unconfirmed → honest revert
  });
});

describe("registry persistence", () => {
  async function startRestartedJob() {
    const d = deferred<{ code: number; tail: string }>();
    const dataset = join(root, "dataset");
    mkdirSync(dataset, { recursive: true });
    makeImage(dataset, "img_00001.png");
    const job = await mod.startTrainingJob(
      { name: "restart_me", flow: "character", model: "flux1-dev", datasetPath: dataset },
      { startTraining: () => fakeHandle(d), lorasDir: () => join(root, "loras"), catalog: fakeCatalog() },
    );
    expect(existsSync(join(mod.jobsRoot(), `${job.id}.json`))).toBe(true);
    // Simulate an MCP restart: fresh module, same training dir, no live handle.
    vi.resetModules();
    const mod2 = await import("../../services/training-jobs.js");
    return { job, mod2 };
  }

  it("marks an in-flight job failed when its container is definitively gone", async () => {
    const { job, mod2 } = await startRestartedJob();
    const revived = (await mod2.getJob(job.id, { containerRunning: async () => false }))!;
    expect(revived).not.toBeNull();
    expect(revived.status).toBe("failed");
    expect(revived.error).toContain("no longer running");
  });

  it("does NOT mislabel another process's live job as failed", async () => {
    const { job, mod2 } = await startRestartedJob();
    const revived = (await mod2.getJob(job.id, { containerRunning: async () => true }))!;
    expect(revived.status).toBe("running");
  });

  it("keeps status when liveness is unknown (docker daemon down)", async () => {
    const { job, mod2 } = await startRestartedJob();
    const revived = (await mod2.getJob(job.id, { containerRunning: async () => null }))!;
    expect(revived.status).toBe("running");
  });

  it("recovers a FINISHED run whose owner died (handoff runs on next read)", async () => {
    const { job, mod2 } = await startRestartedJob();
    // ai-toolkit finished and wrote the final save before the owner died. No
    // log marker exists (nothing streams after owner death) — the final
    // <name>.safetensors is the durable success signal.
    const outDir = join(job.outputDir, "restart_me");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "restart_me.safetensors"), "weights");
    const lorasDir = join(root, "loras");
    const catalog = fakeCatalog();
    const revived = (await mod2.getJob(job.id, {
      containerRunning: async () => false,
      lorasDir: () => lorasDir,
      catalog,
    }))!;
    expect(revived.status).toBe("completed");
    expect(revived.result!.loraPath).toBe(join(lorasDir, "restart_me.safetensors"));
    expect(existsSync(revived.result!.loraPath)).toBe(true);
    expect(catalog.upserts).toHaveLength(1);
  });

  it("does NOT recover a crashed run that left only checkpoints behind", async () => {
    const { job, mod2 } = await startRestartedJob();
    const outDir = join(job.outputDir, "restart_me");
    mkdirSync(outDir, { recursive: true });
    // A periodic checkpoint without the final save = training never finished.
    writeFileSync(join(outDir, "restart_me_000000100.safetensors"), "partial");
    const lorasDir = join(root, "loras");
    const revived = (await mod2.getJob(job.id, {
      containerRunning: async () => false,
      lorasDir: () => lorasDir,
      catalog: fakeCatalog(),
    }))!;
    expect(revived.status).toBe("failed");
    expect(revived.result).toBeUndefined();
    expect(existsSync(join(lorasDir, "restart_me.safetensors"))).toBe(false);
  });

  it("on retarget: copies the LoRA to the ORIGINAL loras dir but skips the catalog", async () => {
    const { job, mod2 } = await startRestartedJob();
    const outDir = join(job.outputDir, "restart_me");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "restart_me.safetensors"), "weights");
    // Job was started against a DIFFERENT ComfyUI instance than this process
    // currently targets (simulating a mid-run retarget).
    const originalLoras = join(root, "original-loras");
    const record = JSON.parse(readFileSync(join(mod2.jobsRoot(), `${job.id}.json`), "utf-8")) as Record<string, unknown>;
    record.lorasDir = originalLoras;
    record.instanceSlug = "some_other_instance_9000";
    writeFileSync(join(mod2.jobsRoot(), `${job.id}.json`), JSON.stringify(record, null, 2));
    const catalog = fakeCatalog();
    const revived = (await mod2.getJob(job.id, {
      containerRunning: async () => false,
      lorasDir: () => join(root, "WRONG-new-instance-loras"),
      catalog,
    }))!;
    expect(revived.status).toBe("completed");
    // File lands in the ORIGINAL dir; the (new-instance) catalog stays untouched.
    expect(revived.result!.loraPath).toBe(join(originalLoras, "restart_me.safetensors"));
    expect(existsSync(revived.result!.loraPath)).toBe(true);
    expect(revived.result!.catalogId).toBeUndefined();
    expect(catalog.upserts).toHaveLength(0);
  });

  it("re-reads disk on every poll so a fresh process sees later jobs", async () => {
    const { mod2 } = await startRestartedJob();
    // A SECOND job created after mod2's first read must appear on the next one.
    await mod2.listJobs({ containerRunning: async () => true });
    const d2 = deferred<{ code: number; tail: string }>();
    const job2 = await mod.startTrainingJob(
      { name: "created_later", flow: "character", model: "flux1-dev", datasetPath: join(root, "dataset") },
      { startTraining: () => fakeHandle(d2), lorasDir: () => join(root, "loras"), catalog: fakeCatalog() },
    );
    const jobs = await mod2.listJobs({ containerRunning: async () => true });
    expect(jobs.some((j) => j.id === job2.id)).toBe(true);
  });
});
