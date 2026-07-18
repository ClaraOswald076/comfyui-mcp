// Drives the headless GPU trainer container (docker/trainer/Dockerfile) that runs
// ostris ai-toolkit's `run.py`. This is the runtime half of the trainer: preflight
// docker + GPU, build the image once, then `docker run --gpus all` a generated
// config and stream ai-toolkit's progress back out.
//
// Modeled on src/services/comfy-cli.ts (external-CLI wrapper): quick probes via
// execFile, the long training run via spawn with streamed stdout, and results
// normalized into a small envelope so callers/tools get a uniform shape.

import childProcess from "node:child_process";
import { logger } from "../utils/logger.js";

/** Uniform result shape for trainer operations (mirrors the comfy-cli envelope). */
export interface TrainerEnvelope<T = unknown> {
  ok: boolean;
  command: string;
  data?: T;
  error?: { code: string; message: string };
  stderr?: string;
}

/** Image tag we build/run. */
export const TRAINER_IMAGE = process.env.COMFYUI_MCP_TRAINER_IMAGE?.trim() || "comfyui-mcp-trainer:latest";

/** Docker executable — env override, else PATH. */
export function resolveDocker(): string {
  return process.env.COMFYUI_MCP_DOCKER?.trim() || "docker";
}

function ok<T>(command: string, data?: T): TrainerEnvelope<T> {
  return { ok: true, command, data };
}
function fail(command: string, code: string, message: string, stderr?: string): TrainerEnvelope<never> {
  return { ok: false, command, error: { code, message }, stderr };
}

/** Run a short docker command, capturing stdout/stderr. Never throws. */
function execDocker(args: string[], timeoutMs = 20_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    childProcess.execFile(
      resolveDocker(),
      args,
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024, env: { ...process.env } },
      (err, stdout, stderr) => {
        const code = err && typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : err ? 1 : 0;
        resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
      },
    );
  });
}

/** Is the docker daemon reachable? */
export async function dockerAvailable(): Promise<boolean> {
  const r = await execDocker(["version", "--format", "{{.Server.Version}}"]);
  return r.code === 0 && r.stdout.trim().length > 0;
}

/** Is `--gpus all` usable (NVIDIA Container Toolkit present)? Runs a tiny CUDA
 *  image's `nvidia-smi`; slower, so callers cache the result. */
export async function gpuDockerAvailable(): Promise<boolean> {
  const r = await execDocker(
    ["run", "--rm", "--gpus", "all", "nvidia/cuda:12.8.1-base-ubuntu24.04", "nvidia-smi", "-L"],
    120_000,
  );
  return r.code === 0 && /GPU \d+/.test(r.stdout);
}

/** Does our trainer image exist locally? */
export async function trainerImageExists(): Promise<boolean> {
  const r = await execDocker(["image", "inspect", TRAINER_IMAGE]);
  return r.code === 0;
}

/**
 * Preflight report for `train_doctor`: docker daemon, GPU passthrough, image
 * presence. Returns an envelope with a per-check breakdown so the UI/LLM can
 * give the user precise setup guidance instead of a cryptic run failure.
 */
export async function trainerDoctor(): Promise<TrainerEnvelope<{
  docker: boolean;
  gpu: boolean;
  image: boolean;
  image_tag: string;
  hints: string[];
}>> {
  const docker = await dockerAvailable();
  const hints: string[] = [];
  if (!docker) {
    hints.push("Docker daemon not reachable — install/start Docker Desktop (Windows) or the docker engine.");
    return ok("train_doctor", { docker, gpu: false, image: false, image_tag: TRAINER_IMAGE, hints });
  }
  const [gpu, image] = await Promise.all([gpuDockerAvailable(), trainerImageExists()]);
  if (!gpu) hints.push("`docker run --gpus all` failed — install the NVIDIA Container Toolkit and enable GPU support in Docker.");
  if (!image) hints.push(`Trainer image ${TRAINER_IMAGE} not built yet — run train_build_image (one-time, several minutes).`);
  return ok("train_doctor", { docker, gpu, image, image_tag: TRAINER_IMAGE, hints });
}

/**
 * Build the trainer image from docker/trainer/Dockerfile. Long-running; streams
 * build output via onLog. `contextDir` is the docker/trainer dir.
 */
export function buildTrainerImage(opts: {
  contextDir: string;
  aiToolkitRef?: string;
  onLog?: (line: string) => void;
}): Promise<TrainerEnvelope<{ image: string }>> {
  const args = ["build", "-t", TRAINER_IMAGE];
  if (opts.aiToolkitRef) args.push("--build-arg", `AI_TOOLKIT_REF=${opts.aiToolkitRef}`);
  args.push(opts.contextDir);
  return streamDocker(args, opts.onLog).then((r) =>
    r.code === 0 ? ok("train_build_image", { image: TRAINER_IMAGE }) : fail("train_build_image", "build_failed", `docker build exited ${r.code}`, r.tail),
  );
}

/** Handle to a running training container. */
export interface TrainingHandle {
  /** `--name` we assigned (also used to stop it). */
  containerName: string;
  /** The spawned `docker run` child (resolves when training exits). */
  done: Promise<{ code: number; tail: string }>;
  child: childProcess.ChildProcess;
}

/** A parsed progress tick from ai-toolkit's training stdout. */
export interface TrainingProgress {
  step?: number;
  totalSteps?: number;
  loss?: number;
  /** A saved sample-image path/line, when seen. */
  sample?: string;
  /** The raw line (always present). */
  raw: string;
}

/**
 * Parse one stdout line from ai-toolkit into a progress tick. ai-toolkit prints a
 * tqdm-style bar with the job name, `<step>/<total>` and a `loss: <n>` postfix,
 * e.g. `my_lora:  12%|#2 | 240/2000 [01:03<07:41, ... loss: 3.9e-01]`.
 */
export function parseTrainingProgress(line: string): TrainingProgress | null {
  const raw = line.trim();
  if (!raw) return null;
  const stepMatch = raw.match(/(\d+)\s*\/\s*(\d+)/);
  const lossMatch = raw.match(/loss[:=]\s*([\d.eE+-]+)/);
  const sampleMatch = raw.match(/(?:saved|sample).*?([^\s'"]+\.(?:png|jpg|jpeg))/i);
  if (!stepMatch && !lossMatch && !sampleMatch) return null;
  const tick: TrainingProgress = { raw };
  if (stepMatch) {
    tick.step = Number(stepMatch[1]);
    tick.totalSteps = Number(stepMatch[2]);
  }
  if (lossMatch) {
    const n = Number(lossMatch[1]);
    if (Number.isFinite(n)) tick.loss = n;
  }
  if (sampleMatch) tick.sample = sampleMatch[1];
  return tick;
}

/**
 * Start a training run: `docker run --gpus all` with the config/dataset/output/HF
 * mounts. Returns immediately with a handle; caller awaits `handle.done`. Progress
 * ticks are delivered via onProgress. Paths are host paths; the container sees the
 * fixed mount points `/config.yml`, `/dataset`, `/output`.
 */
export function startTraining(opts: {
  containerName: string;
  configPath: string;
  datasetPath: string;
  outputDir: string;
  hfCacheDir?: string;
  hfToken?: string;
  onProgress?: (p: TrainingProgress) => void;
  onLog?: (line: string) => void;
}): TrainingHandle {
  const args = [
    "run", "--rm", "--gpus", "all", "--name", opts.containerName,
    "-v", `${opts.configPath}:/config.yml:ro`,
    "-v", `${opts.datasetPath}:/dataset:ro`,
    "-v", `${opts.outputDir}:/output`,
  ];
  if (opts.hfCacheDir) args.push("-v", `${opts.hfCacheDir}:/root/.cache/huggingface`);
  if (opts.hfToken) args.push("-e", `HF_TOKEN=${opts.hfToken}`);
  args.push(TRAINER_IMAGE, "/config.yml");

  const child = childProcess.spawn(resolveDocker(), args, { windowsHide: true, env: { ...process.env } });
  const tailLines: string[] = [];
  const pushTail = (s: string) => {
    tailLines.push(s);
    if (tailLines.length > 200) tailLines.shift();
  };
  const onLine = (line: string) => {
    pushTail(line);
    opts.onLog?.(line);
    const tick = parseTrainingProgress(line);
    if (tick && opts.onProgress) opts.onProgress(tick);
  };
  lineStream(child.stdout, onLine);
  lineStream(child.stderr, onLine);

  const done = new Promise<{ code: number; tail: string }>((resolve) => {
    child.on("close", (code) => resolve({ code: code ?? 0, tail: tailLines.slice(-40).join("\n") }));
    child.on("error", (err) => {
      logger.debug(`[ai-toolkit] docker run spawn error: ${err instanceof Error ? err.message : String(err)}`);
      resolve({ code: 1, tail: tailLines.slice(-40).join("\n") });
    });
  });
  return { containerName: opts.containerName, done, child };
}

/** Stop a running training container (best-effort). `docker stop` on an
 *  already-gone container is idempotent success for us. */
export async function stopTraining(containerName: string): Promise<TrainerEnvelope<{ stopped: string }>> {
  await execDocker(["stop", "-t", "10", containerName], 30_000);
  return ok("train_cancel", { stopped: containerName });
}

// ---- helpers ---------------------------------------------------------------

/** Spawn a docker command, streaming output through onLog, resolving on close. */
function streamDocker(
  args: string[],
  onLog?: (line: string) => void,
): Promise<{ code: number; tail: string }> {
  const child = childProcess.spawn(resolveDocker(), args, { windowsHide: true, env: { ...process.env } });
  const tail: string[] = [];
  const onLine = (line: string) => {
    tail.push(line);
    if (tail.length > 200) tail.shift();
    onLog?.(line);
  };
  lineStream(child.stdout, onLine);
  lineStream(child.stderr, onLine);
  return new Promise((resolve) => {
    child.on("close", (code) => resolve({ code: code ?? 0, tail: tail.slice(-40).join("\n") }));
    child.on("error", () => resolve({ code: 1, tail: tail.slice(-40).join("\n") }));
  });
}

/** Split a readable stream into trimmed lines. */
function lineStream(stream: NodeJS.ReadableStream | null, onLine: (line: string) => void): void {
  if (!stream) return;
  let buf = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    buf += chunk;
    // ai-toolkit's tqdm bar uses \r; treat both \r and \n as line breaks.
    const parts = buf.split(/\r\n|\r|\n/);
    buf = parts.pop() ?? "";
    for (const line of parts) if (line.trim()) onLine(line);
  });
  stream.on("end", () => {
    if (buf.trim()) onLine(buf);
  });
}
