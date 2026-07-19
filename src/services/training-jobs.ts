// Training job registry for the LoRA trainer — the state layer between the
// train_* MCP tools and the ai-toolkit container driver.
//
// A job ties together: a dataset dir (staged by prepareDataset), a generated
// ai-toolkit config (training-config.ts), and a running docker container
// (ai-toolkit.ts). Jobs persist a small JSON record under
// <trainingRoot>/jobs/<id>.json so `train_status`/`train_cancel` still work
// after an MCP restart (the container keeps running; we re-read the record).
//
// On success the final `.safetensors` is copied into ComfyUI models/loras/ and
// upserted into the LoRA catalog (trigger keyword + base model) so it shows in
// the mobile LoRA hub immediately. Live step/loss progress is also mirrored
// onto the cross-process download-progress channel for the panel/mobile tray.

import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import {
  containerRunning,
  startTraining,
  stopTraining,
  type TrainingHandle,
  type TrainingProgress,
} from "./ai-toolkit.js";
import {
  buildTrainingConfig,
  type TrainParams,
  type TrainerFlow,
  type TrainerModel,
} from "./training-config.js";
import { reportDownloadProgress } from "./download-progress.js";
import { getLoraCatalog } from "./lora-catalog.js";
import { resolveModelSubfolder } from "./model-resolver.js";
import { getInstanceSlug } from "../config.js";
import { logger } from "../utils/logger.js";

export type TrainingJobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface TrainingJob {
  id: string;
  /** Job/LoRA name — becomes the output folder + .safetensors basename. */
  name: string;
  flow: TrainerFlow;
  model: TrainerModel;
  trigger?: string;
  status: TrainingJobStatus;
  progress: {
    step?: number;
    totalSteps?: number;
    loss?: number;
    /** Host paths of the most recent sample images (max 4). */
    samples: string[];
  };
  containerName?: string;
  /** Host dataset dir mounted at /dataset (writable — ai-toolkit caches into it). */
  datasetPath: string;
  /** Per-job dir holding config.yml, train.log, output/. */
  jobDir: string;
  /** Host output dir mounted at /output. */
  outputDir: string;
  /** Recent log lines (ring buffer, max 50) for train_status. */
  log: string[];
  error?: string;
  /** models/loras dir resolved at START — persisted so a mid-run ComfyUI
   *  retarget can't redirect the handoff to the wrong instance. */
  lorasDir?: string;
  /** ComfyUI instance slug at START — the catalog upsert is skipped when the
   *  active instance at handoff time differs (retargeted mid-run). */
  instanceSlug?: string;
  result?: {
    /** Absolute path of the LoRA copied into models/loras/. */
    loraPath: string;
    /** models/-relative path, e.g. "loras/my_lora.safetensors". */
    loraRelPath: string;
    /** Absent when the catalog upsert was skipped (instance changed mid-run). */
    catalogId?: string;
    previewFile?: string;
  };
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
}

/** Injectable seams so tests can run without docker / a ComfyUI install. */
export interface TrainingJobDeps {
  startTraining?: typeof startTraining;
  stopTraining?: typeof stopTraining;
  /** Container liveness probe (false = definitively gone, null = unknown). */
  containerRunning?: typeof containerRunning;
  /** Where the finished LoRA is copied. Default: ComfyUI models/loras. */
  lorasDir?: () => string;
  catalog?: Pick<ReturnType<typeof getLoraCatalog>, "upsert" | "setPreview">;
  now?: () => number;
}

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const LOG_RING = 50;
/** Container-side mount points (must match ai-toolkit.ts startTraining). */
const CONTAINER_DATASET = "/dataset";
const CONTAINER_OUTPUT = "/output";

// ---- paths -----------------------------------------------------------------

function dataBaseDir(): string {
  return process.env.COMFYUI_MCP_DATA_DIR?.trim() || join(homedir(), ".comfyui-mcp");
}

/** Root for datasets, job dirs, and the shared HF cache. */
export function trainingRoot(): string {
  return process.env.COMFYUI_MCP_TRAINING_DIR?.trim() || join(dataBaseDir(), "training");
}

export function datasetsRoot(): string {
  return join(trainingRoot(), "datasets");
}

export function jobsRoot(): string {
  return join(trainingRoot(), "jobs");
}

/** Shared HF cache mounted into every training container (models persist
 *  across runs so Flux isn't re-downloaded each job). */
export function hfCacheRoot(): string {
  return join(trainingRoot(), "hf-cache");
}

// ---- registry ---------------------------------------------------------------

const jobs = new Map<string, TrainingJob>();
const handles = new Map<string, TrainingHandle>();
/** Throttle for persisting live progress (codex finding: cross-process readers
 *  only see what's on disk, so running jobs must snapshot, not just finalize). */
const lastProgressPersistAt = new Map<string, number>();
const PROGRESS_PERSIST_MS = 5000;

function jobFile(id: string): string {
  return join(jobsRoot(), `${id}.json`);
}

function persist(job: TrainingJob): void {
  try {
    mkdirSync(jobsRoot(), { recursive: true });
    writeFileSync(jobFile(job.id), JSON.stringify(job, null, 2));
  } catch (err) {
    logger.warn(`[training-jobs] could not persist ${job.id}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** True when the ON-DISK record says cancelled — i.e. another process issued a
 *  cancel this process hasn't seen (its memory still says running). */
function diskCancelled(job: TrainingJob): boolean {
  try {
    const disk = JSON.parse(readFileSync(jobFile(job.id), "utf-8")) as TrainingJob;
    return disk?.status === "cancelled";
  } catch {
    return false;
  }
}

/**
 * Persist a live progress/log snapshot WITHOUT clobbering a foreign cancel:
 * if the disk record was cancelled by another process since we last looked,
 * adopt that state into memory and skip the write (codex finding: the owner's
 * throttled persist overwrote the cross-process cancel, then finalize ran the
 * handoff anyway).
 */
function persistLiveState(job: TrainingJob): void {
  if (job.status === "cancelled") return;
  if (diskCancelled(job)) {
    job.status = "cancelled";
    job.finishedAt = new Date().toISOString();
    job.updatedAt = job.finishedAt;
    return;
  }
  persist(job);
}

/**
 * Merge the on-disk records into the in-memory map. Runs on EVERY read: the
 * orchestrator's long-lived in-process client (mobile `train_status`) is a
 * different process from the one running `train_start`, so a load-once
 * registry would show stale/empty state forever (codex finding #1).
 *
 * Merge rules:
 *  - A job with a live in-process handle is authoritative in memory (fresher
 *    than disk between throttled persists) — disk never overwrites it.
 *  - Anything else takes the disk record (new, updated, or absent in memory).
 *  - A record persisted as running/queued with NO live handle here belongs to
 *    another process (or a crashed one): probe the container. Definitively
 *    gone → mark failed; running or unknown → report as recorded, never
 *    mislabel a live foreign job as failed (codex finding #2).
 */
async function refreshRegistry(deps: TrainingJobDeps = {}): Promise<void> {
  let files: string[] = [];
  try {
    files = readdirSync(jobsRoot()).filter((f) => f.endsWith(".json"));
  } catch {
    return; // no jobs dir yet
  }
  for (const f of files) {
    let job: TrainingJob;
    try {
      job = JSON.parse(readFileSync(join(jobsRoot(), f), "utf-8")) as TrainingJob;
    } catch {
      continue; // skip a garbled record
    }
    if (!job || typeof job.id !== "string") continue;
    if (handles.has(job.id)) continue; // live in this process — memory wins
    if ((job.status === "running" || job.status === "queued") && job.containerName) {
      const probe = deps.containerRunning ?? containerRunning;
      const running = await probe(job.containerName).catch(() => null);
      if (running === false) {
        // Container gone with no live handle anywhere: the owning process died.
        // Recover ONLY a proven-successful run — artifact presence alone is not
        // enough (a crashed run leaves periodic checkpoints behind, and handing
        // those off would publish partial weights as a finished LoRA; codex
        // finding). Proof = the FINAL save exists AND ai-toolkit's own summary
        // in train.log reports completed jobs.
        try {
          if (recoveredSuccessfully(job)) {
            handoffToComfyUI(job, deps);
            job.status = "completed";
            const samples = findSamples(job.outputDir, job.name, 4);
            if (samples.length > 0) job.progress.samples = samples;
            if (job.progress.totalSteps !== undefined) job.progress.step = job.progress.totalSteps;
            job.finishedAt = new Date().toISOString();
            persist(job);
            jobs.set(job.id, job);
            continue;
          }
        } catch (err) {
          job.status = "failed";
          job.error = `recovered output but handoff failed: ${err instanceof Error ? err.message : String(err)}`;
          job.finishedAt = new Date().toISOString();
          persist(job);
          jobs.set(job.id, job);
          continue;
        }
        job.status = "failed";
        job.error = "training container is no longer running (the MCP process that started it exited or the container died); any output (checkpoints, samples) is under the job's output/ dir.";
        job.finishedAt = new Date().toISOString();
        persist(job);
      }
    }
    jobs.set(job.id, job);
  }
}

export async function getJob(id: string, deps: TrainingJobDeps = {}): Promise<TrainingJob | null> {
  await refreshRegistry(deps);
  return jobs.get(id) ?? null;
}

export async function listJobs(deps: TrainingJobDeps = {}): Promise<TrainingJob[]> {
  await refreshRegistry(deps);
  return [...jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// ---- dataset staging ----------------------------------------------------------

export interface DatasetItem {
  /** Host path to a source image. */
  path: string;
  /** Caption text. Falls back to defaultCaption (usually the trigger word). */
  caption?: string;
}

export interface PreparedDataset {
  datasetPath: string;
  imageCount: number;
  captionedCount: number;
  warnings: string[];
}

function sanitizeDirName(name: string): string {
  const cleaned = name.trim().replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  if (!cleaned || /^\.+$/.test(cleaned)) return "dataset";
  return cleaned;
}

/**
 * Stage images + same-basename .txt captions into a dataset dir ai-toolkit can
 * consume. Images are copied in as img_00001.<ext> etc. (stable, caption-safe
 * names); a missing caption falls back to defaultCaption, and if that's also
 * absent the image is staged uncaptioned with a warning (ai-toolkit trains on
 * it with an empty caption).
 *
 * Re-staging the same name REPLACES the old dir — but refuses when a
 * non-terminal job currently trains from it (the dir is bind-mounted into the
 * running container; wiping it mid-run would corrupt the job — codex finding).
 */
export async function prepareDataset(opts: {
  name: string;
  items: DatasetItem[];
  defaultCaption?: string;
}, deps: TrainingJobDeps = {}): Promise<PreparedDataset> {
  if (!Array.isArray(opts.items) || opts.items.length === 0) {
    throw new Error("dataset needs at least one image");
  }
  const dir = join(datasetsRoot(), sanitizeDirName(opts.name));
  const resolvedDir = resolve(dir);
  const active = await listJobs(deps);
  const inUse = active.find(
    (j) => (j.status === "running" || j.status === "queued") && resolve(j.datasetPath) === resolvedDir,
  );
  if (inUse) {
    throw new Error(`dataset "${opts.name}" is in use by ${inUse.status} job ${inUse.id} — pick another name or cancel the job first`);
  }
  // Validate EVERY item first and stage into a temp sibling, then swap — an
  // invalid item or a copy failure must not destroy the previously valid
  // dataset or leave a partial replacement (codex finding).
  const resolvedItems = opts.items.map((item) => {
    const src = item.path?.trim();
    if (!src || !existsSync(src)) throw new Error(`image not found: ${item.path}`);
    const ext = extname(src).toLowerCase();
    if (!IMAGE_EXTS.has(ext)) throw new Error(`not a supported image (${[...IMAGE_EXTS].join("/")}): ${src}`);
    return { src, ext, caption: (item.caption ?? opts.defaultCaption)?.trim() };
  });
  const tmp = `${dir}.staging-${process.pid}`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  const warnings: string[] = [];
  let captionedCount = 0;
  try {
    resolvedItems.forEach((item, i) => {
      const base = `img_${String(i + 1).padStart(5, "0")}`;
      copyFileSync(item.src, join(tmp, `${base}${item.ext}`));
      if (item.caption) {
        writeFileSync(join(tmp, `${base}.txt`), item.caption);
        captionedCount++;
      } else {
        warnings.push(`${basename(item.src)}: no caption (defaultCaption not set)`);
      }
    });
  } catch (err) {
    rmSync(tmp, { recursive: true, force: true });
    throw err;
  }
  rmSync(dir, { recursive: true, force: true });
  renameSync(tmp, dir);
  return { datasetPath: dir, imageCount: resolvedItems.length, captionedCount, warnings };
}

// ---- job lifecycle ------------------------------------------------------------

export interface StartJobInput {
  name: string;
  flow: TrainerFlow;
  model: TrainerModel;
  /** Host dataset dir (images + .txt captions). */
  datasetPath: string;
  trigger?: string;
  params?: Partial<TrainParams>;
  device?: string;
}

function countDatasetImages(datasetPath: string): number {
  try {
    return readdirSync(datasetPath).filter((f) => IMAGE_EXTS.has(extname(f).toLowerCase())).length;
  } catch {
    return 0;
  }
}

function pushLog(job: TrainingJob, line: string): void {
  job.log.push(line);
  if (job.log.length > LOG_RING) job.log.shift();
  try {
    appendFileSync(join(job.jobDir, "train.log"), line + "\n");
  } catch {
    // log file is best-effort
  }
}

/** Map a container-side /output path (from a sample line) back to its host path. */
function toHostOutputPath(job: TrainingJob, p: string): string {
  if (p.startsWith(CONTAINER_OUTPUT + "/")) return join(job.outputDir, p.slice(CONTAINER_OUTPUT.length + 1));
  return p;
}

function reportProgress(job: TrainingJob, status: "downloading" | "done" | "error", force = false): void {
  reportDownloadProgress(
    {
      id: `train-${job.id}`,
      name: `LoRA ${job.name}`,
      downloaded: job.progress.step ?? 0,
      total: job.progress.totalSteps ?? 0,
      bytes_per_sec: 0,
      status,
    },
    force,
  );
}

/** Pick the LoRA ai-toolkit produced: the exact <name>.safetensors final save,
 *  else the highest-step <name>_NNNNNNN.safetensors checkpoint. */
export function findProducedLora(outputDir: string, jobName: string): string | null {
  const dir = join(outputDir, jobName);
  if (!existsSync(dir)) return null;
  const finalPath = join(dir, `${jobName}.safetensors`);
  if (existsSync(finalPath)) return finalPath;
  let best: { step: number; path: string } | null = null;
  for (const f of readdirSync(dir)) {
    const m = f.match(new RegExp(`^${jobName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}_(\\d+)\\.safetensors$`));
    if (m) {
      const step = Number(m[1]);
      if (!best || step > best.step) best = { step, path: join(dir, f) };
    }
  }
  return best?.path ?? null;
}

/**
 * Durable proof an owner-less job actually FINISHED training: the FINAL save
 * (<name>.safetensors) exists. ai-toolkit writes it only after the training
 * loop completes — periodic <name>_NNNN.safetensors checkpoints prove nothing
 * (a crash leaves those too), and stdout markers can't help: after the owner
 * process dies, nothing appends its end-of-run summary to train.log (codex
 * finding). The residual risk — a crash in the sampling phase AFTER the final
 * save — still yields a complete LoRA, so handing it off is correct.
 */
export function recoveredSuccessfully(job: TrainingJob): boolean {
  return existsSync(join(job.outputDir, job.name, `${job.name}.safetensors`));
}

/** Latest sample images from <output>/<name>/samples/, newest first. */
function findSamples(outputDir: string, jobName: string, limit = 4): string[] {
  const dir = join(outputDir, jobName, "samples");
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((f) => IMAGE_EXTS.has(extname(f).toLowerCase()))
      .map((f) => ({ f, mtime: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, limit)
      .map((x) => join(dir, x.f));
  } catch {
    return [];
  }
}

/**
 * Success handoff: copy the produced LoRA into models/loras/ and upsert the
 * catalog (trigger as keyword, base model from the trained arch) so the LoRA
 * is immediately usable in workflows and visible in the mobile LoRA hub.
 */
function handoffToComfyUI(job: TrainingJob, deps: TrainingJobDeps): void {
  const produced = findProducedLora(job.outputDir, job.name);
  if (!produced) {
    throw new Error(`training exited cleanly but no .safetensors found under ${join(job.outputDir, job.name)}`);
  }
  // The destination resolved at job START wins (codex finding): if the ComfyUI
  // target changed mid-run, re-resolving now would copy the LoRA to the new
  // instance's models dir.
  const lorasDir = job.lorasDir ?? (deps.lorasDir ? deps.lorasDir() : resolveModelSubfolder("loras"));
  mkdirSync(lorasDir, { recursive: true });
  const dest = join(lorasDir, `${job.name}.safetensors`);
  copyFileSync(produced, dest);

  // The catalog is per-instance: after a mid-run retarget, upserting here
  // would register the LoRA in the WRONG instance's catalog. Copy still
  // happened (into the original dir, above); skip the catalog honestly.
  if (job.instanceSlug && job.instanceSlug !== getInstanceSlug()) {
    logger.warn(
      `[training-jobs] ComfyUI instance changed mid-run (${job.instanceSlug} → ${getInstanceSlug()}); ` +
        `LoRA copied to ${dest} but the catalog upsert was skipped — re-run lora_catalog_upsert on the original instance.`,
    );
    job.result = { loraPath: dest, loraRelPath: `loras/${job.name}.safetensors` };
    return;
  }

  const catalog = deps.catalog ?? getLoraCatalog();
  const entry = catalog.upsert({
    relPath: `loras/${job.name}.safetensors`,
    displayName: job.name.replace(/_/g, " "),
    description: `Character LoRA trained locally on FLUX.1-dev via ostris ai-toolkit (comfyui-mcp trainer, job ${job.id}).`,
    setupInstructions:
      "Load with LoraLoaderModelOnly on a FLUX.1-dev checkpoint" +
      (job.trigger ? ` and include the trigger word "${job.trigger}" in the prompt.` : "."),
    keywords: job.trigger ? [job.trigger] : [],
    baseModels: ["FLUX.1-dev"],
    strengthDefault: 1.0,
    tags: ["trained-locally", "character"],
    // Explicitly clear the flag — retraining a LoRA whose entry was marked
    // missing must become visible again (upsert otherwise preserves it).
    missing: false,
  });

  // Best-effort: newest sample image becomes the catalog preview.
  let previewFile: string | undefined;
  const samples = findSamples(job.outputDir, job.name, 1);
  if (samples.length > 0) {
    try {
      previewFile = catalog.setPreview(entry.id, samples[0]).previewFile;
    } catch (err) {
      logger.debug(`[training-jobs] preview copy skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  job.result = { loraPath: dest, loraRelPath: `loras/${job.name}.safetensors`, catalogId: entry.id, previewFile };
}

async function finalizeJob(job: TrainingJob, code: number, tail: string, deps: TrainingJobDeps): Promise<void> {
  // A cancel marks the job before the container exits — don't overwrite it.
  // Check BOTH this process's memory and the on-disk record: a cancel issued
  // from another process (e.g. the orchestrator's call_tool client) only shows
  // up on disk (codex finding: cross-process cancel was clobbered by finalize).
  if (job.status === "cancelled") {
    if (diskCancelled(job)) return;
    // Memory says cancelled but disk doesn't: the cancel was rolled back after
    // a failed stop — reconcile and finalize normally (codex finding).
    job.status = "running";
    job.finishedAt = undefined;
    job.error = undefined;
  }
  if (diskCancelled(job)) {
    job.status = "cancelled";
    job.finishedAt = new Date().toISOString();
    job.updatedAt = job.finishedAt;
    return;
  }
  job.finishedAt = new Date().toISOString();
  // Surface the generated samples in train_status regardless of outcome —
  // ai-toolkit prints only "Generating Images" bars (no saved-file lines), so
  // onProgress never sees sample paths (codex finding; confirmed by the E2E).
  const samples = findSamples(job.outputDir, job.name, 4);
  if (samples.length > 0) job.progress.samples = samples;
  if (code === 0) {
    try {
      handoffToComfyUI(job, deps);
      job.status = "completed";
      // The last training bar can read e.g. 199/200 before the final save +
      // sampling phases — normalize so a completed job shows a complete count
      // (codex finding).
      if (job.progress.totalSteps !== undefined) job.progress.step = job.progress.totalSteps;
      reportProgress(job, "done", true);
    } catch (err) {
      job.status = "failed";
      job.error = `output handoff failed: ${err instanceof Error ? err.message : String(err)}`;
      reportProgress(job, "error", true);
    }
  } else {
    job.status = "failed";
    job.error = `training container exited ${code}${tail ? ` — last output:\n${tail}` : ""}`;
    reportProgress(job, "error", true);
  }
  job.updatedAt = new Date().toISOString();
  persist(job);
}

/**
 * Build the config, launch the container, and register the job. Returns as
 * soon as the container is up; completion is handled by the handle's `done`
 * promise (finalizeJob). Preflight (docker/image) belongs to the caller — the
 * train_start tool runs trainerDoctor checks first.
 *
 * The LoRA handoff destination is resolved BEFORE launch (codex finding): in
 * remote mode / with no local workspace, resolveModelSubfolder throws — better
 * here than after an hours-long run.
 */
export async function startTrainingJob(input: StartJobInput, deps: TrainingJobDeps = {}): Promise<TrainingJob> {
  const start = deps.startTraining ?? startTraining;
  const now = deps.now ?? (() => Date.now());
  const datasetPath = resolve(input.datasetPath);
  if (!existsSync(datasetPath)) throw new Error(`dataset not found: ${input.datasetPath}`);
  const imageCount = countDatasetImages(datasetPath);
  if (imageCount === 0) throw new Error(`dataset has no images (${[...IMAGE_EXTS].join("/")}): ${datasetPath}`);
  // Pre-launch handoff check — throws early when no local ComfyUI is resolvable.
  const lorasDir = deps.lorasDir ?? (() => resolveModelSubfolder("loras"));
  const resolvedLorasDir = lorasDir();
  const effDeps: TrainingJobDeps = { ...deps, lorasDir };

  const id = `t${now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const jobDir = join(jobsRoot(), id);
  const outputDir = join(jobDir, "output");
  mkdirSync(outputDir, { recursive: true });

  // Config sees CONTAINER paths; the driver bind-mounts the host dirs there.
  const built = buildTrainingConfig({
    name: input.name,
    flow: input.flow,
    model: input.model,
    datasetPath: CONTAINER_DATASET,
    outputDir: CONTAINER_OUTPUT,
    trigger: input.trigger,
    device: input.device,
    params: input.params,
  });
  const configPath = join(jobDir, "config.yml");
  writeFileSync(configPath, built.yaml);

  const job: TrainingJob = {
    id,
    name: built.jobName,
    flow: input.flow,
    model: input.model,
    trigger: input.trigger,
    status: "queued",
    progress: { samples: [] },
    containerName: `comfyui-train-${id}`,
    datasetPath,
    jobDir,
    outputDir,
    log: [],
    lorasDir: resolvedLorasDir,
    instanceSlug: getInstanceSlug(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  jobs.set(id, job);
  persist(job);

  const handle = start({
    containerName: job.containerName!,
    configPath,
    datasetPath,
    outputDir,
    hfCacheDir: hfCacheRoot(),
    hfToken: process.env.HF_TOKEN?.trim() || undefined,
    onProgress: (p: TrainingProgress) => {
      // Terminal jobs ignore ticks — a progress line arriving while a cancel's
      // docker stop is in flight must not resurrect the job (codex finding).
      if (job.status === "cancelled") {
        // …but a FOREIGN cancel can be rolled back: the cancelling process
        // reverts the disk record to running when its docker stop fails. If the
        // disk no longer says cancelled, resume — otherwise stay cancelled
        // (codex finding: permanent adoption suppressed a later completion).
        if (!diskCancelled(job)) {
          job.status = "running";
          job.finishedAt = undefined;
          job.error = undefined;
        } else {
          return;
        }
      }
      if (job.status === "completed" || job.status === "failed") return;
      if (job.status !== "running") {
        job.status = "running";
        reportProgress(job, "downloading", true);
      }
      if (p.step !== undefined) job.progress.step = p.step;
      if (p.totalSteps !== undefined) job.progress.totalSteps = p.totalSteps;
      if (p.loss !== undefined) job.progress.loss = p.loss;
      if (p.sample) {
        job.progress.samples.unshift(toHostOutputPath(job, p.sample));
        job.progress.samples = job.progress.samples.slice(0, 4);
      }
      job.updatedAt = new Date().toISOString();
      reportProgress(job, "downloading");
      // Throttled disk snapshot so OTHER processes (orchestrator call_tool
      // client → mobile train_status) see live progress, not just the final
      // state (codex finding: progress was memory-only until finalize).
      const last = lastProgressPersistAt.get(id) ?? 0;
      if (Date.now() - last >= PROGRESS_PERSIST_MS) {
        lastProgressPersistAt.set(id, Date.now());
        persistLiveState(job);
      }
    },
    onLog: (line) => {
      pushLog(job, line);
      // Log lines also snapshot (same throttle): during the long first-run
      // model download there are NO progress ticks, so without this a
      // cross-process train_status sees an empty, apparently stalled record
      // (codex finding).
      const last = lastProgressPersistAt.get(id) ?? 0;
      if (Date.now() - last >= PROGRESS_PERSIST_MS) {
        lastProgressPersistAt.set(id, Date.now());
        persistLiveState(job);
      }
    },
  });
  handles.set(id, handle);

  handle.done
    .then(({ code, tail }) => finalizeJob(job, code, tail, effDeps))
    .catch((err) => {
      logger.warn(`[training-jobs] finalize ${id} failed: ${err instanceof Error ? err.message : String(err)}`);
    })
    .finally(() => {
      handles.delete(id);
      lastProgressPersistAt.delete(id);
      // NOTE: the terminal download-progress row is intentionally NOT cleared —
      // the orchestrator watcher lingers done/error rows ~8s (so completion is
      // visible in the tray) and then prunes them itself (codex finding).
    });

  job.status = "running";
  job.updatedAt = new Date().toISOString();
  persist(job);
  return job;
}

/** Stop the container and mark the job cancelled. Idempotent. Works
 *  cross-process: the container name is persisted, so a cancel from another
 *  process (orchestrator call_tool) still reaches `docker stop`.
 *
 *  Ordering matters (codex findings): the cancelled state is persisted BEFORE
 *  awaiting `docker stop` — otherwise a clean-exit container can finalize
 *  (handoff + catalog) while the stop is in flight. After the stop we verify
 *  with a liveness probe; if the container is genuinely still alive the job
 *  reverts to running with an error instead of lying about being cancelled. */
export async function cancelJob(id: string, deps: TrainingJobDeps = {}): Promise<TrainingJob> {
  const job = await getJob(id, deps);
  if (!job) throw new Error(`no training job ${id}`);
  if (job.status === "completed" || job.status === "failed") return job;
  if (job.status === "cancelled") {
    // Already cancelled — but if a previous cancel died between persisting the
    // state and finishing `docker stop`, the container may still be alive.
    // Retry the stop instead of blindly returning (codex finding).
    if (!job.containerName) return job;
    const probe = deps.containerRunning ?? containerRunning;
    const alive = await probe(job.containerName).catch(() => null);
    // Only a definitive "gone" short-circuits; unknown (daemon temporarily
    // unreachable) still attempts the stop so a live container can't keep
    // burning GPU behind a stale cancelled record (codex finding).
    if (alive === false) return job;
    const stop = deps.stopTraining ?? stopTraining;
    const res = await stop(job.containerName);
    // Always probe after a stop attempt: a CLI timeout can fire AFTER the
    // daemon honored the stop (codex finding). Only when liveness is unknown
    // do we fall back to the stop command's own result.
    const probed = await probe(job.containerName).catch(() => null);
    const stillRunning = probed ?? res.ok === false;
    if (stillRunning === true) {
      job.status = "running";
      job.finishedAt = undefined;
      job.updatedAt = new Date().toISOString();
      job.error = `cancel retry failed — container ${job.containerName} is still running${res.error ? `: ${res.error.message}` : ""}`;
      persist(job);
    }
    return job;
  }

  job.status = "cancelled";
  job.finishedAt = new Date().toISOString();
  job.updatedAt = job.finishedAt;
  job.error = undefined;
  persist(job);

  if (job.containerName) {
    const stop = deps.stopTraining ?? stopTraining;
    const res = await stop(job.containerName);
    const probe = deps.containerRunning ?? containerRunning;
    // Probe after the stop regardless of its exit status (see above).
    const probed = await probe(job.containerName).catch(() => null);
    const stillRunning = probed ?? res.ok === false;
    if (stillRunning === true) {
      // Stop genuinely failed — the container is still training.
      job.status = "running";
      job.finishedAt = undefined;
      job.updatedAt = new Date().toISOString();
      job.error = `cancel failed — container ${job.containerName} is still running${res.error ? `: ${res.error.message}` : ""}`;
      persist(job);
      return job;
    }
  }
  reportProgress(job, "error", true);
  persist(job);
  return job;
}

/** Public, JSON-safe view of a job (drops nothing — TrainingJob is already
 *  plain data; exposed so tools/tests have one obvious shape). */
export function toJobSummary(job: TrainingJob): TrainingJob {
  return job;
}
