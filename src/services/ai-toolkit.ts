// Drives the headless GPU trainer container (docker/trainer/Dockerfile) that runs
// ostris ai-toolkit's `run.py`. This is the runtime half of the trainer: preflight
// docker + GPU, build the image once, then `docker run --gpus all` a generated
// config and stream ai-toolkit's progress back out.
//
// Modeled on src/services/comfy-cli.ts (external-CLI wrapper): quick probes via
// execFile, the long training run via spawn with streamed stdout, and results
// normalized into a small envelope so callers/tools get a uniform shape.

import childProcess from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
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

/** The ai-toolkit commit every trainer surface pins to — the one the P1 E2E
 *  run was validated against. Single source of truth (Dockerfile ARG mirrors
 *  it; the bootstrap service clones it). */
export const AI_TOOLKIT_REF = "a0224793cef5d5073c8ed0b8cdb838a84fd1cba0";
export const AI_TOOLKIT_REPO = "https://github.com/ostris/ai-toolkit.git";

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
 *
 * A bare `<n>/<total>` is NOT trusted as training progress: ai-toolkit also
 * prints dataset-scan / download / weight-loading bars (e.g. `6/6`) that would
 * otherwise masquerade as steps (found by the first real E2E run). Step/total
 * is only assigned when the line also carries a loss reading.
 */
export function parseTrainingProgress(line: string): TrainingProgress | null {
  const raw = line.trim();
  if (!raw) return null;
  const stepMatch = raw.match(/(\d+)\s*\/\s*(\d+)/);
  const lossMatch = raw.match(/loss[:=]\s*([\d.eE+-]+)/);
  const sampleMatch = raw.match(/(?:saved|sample).*?([^\s'"]+\.(?:png|jpg|jpeg))/i);
  if (!stepMatch && !lossMatch && !sampleMatch) return null;
  const tick: TrainingProgress = { raw };
  if (stepMatch && lossMatch) {
    tick.step = Number(stepMatch[1]);
    tick.totalSteps = Number(stepMatch[2]);
  }
  if (lossMatch) {
    const n = Number(lossMatch[1]);
    if (Number.isFinite(n)) tick.loss = n;
  }
  if (sampleMatch) tick.sample = sampleMatch[1];
  // A line with ONLY a bare step/total (no loss, no sample) is not progress.
  if (tick.step === undefined && tick.loss === undefined && tick.sample === undefined) return null;
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
    // Dataset is mounted READ-WRITE: ai-toolkit writes cache files into it
    // (.aitk_size.json, latent caches) — a read-only mount fails the run
    // ([Errno 30] on .aitk_size.json, found by the first real E2E run).
    "-v", `${opts.datasetPath}:/dataset`,
    "-v", `${opts.outputDir}:/output`,
  ];
  if (opts.hfCacheDir) args.push("-v", `${opts.hfCacheDir}:/root/.cache/huggingface`);
  if (opts.hfToken) args.push("-e", `HF_TOKEN=${opts.hfToken}`);
  args.push(TRAINER_IMAGE, "/config.yml");

  return spawnTrainer(opts.containerName, resolveDocker(), args, { ...process.env } as Record<string, string>, opts);
}

// ---- native (dockerless) mode --------------------------------------------------
// Pods (RunPod) can't nest docker — the pod IS the container — and some Linux
// rigs have no docker at all. Native mode spawns ai-toolkit's run.py directly
// with the same streamed progress + handle shape, so the registry/finalize/
// cancel machinery is identical either way (P4).

/** The ai-toolkit checkout to run in native mode (bootstrap service populates
 *  it). Env override for development. */
export function resolveAiToolkitDir(): string {
  return (
    process.env.COMFYUI_MCP_AI_TOOLKIT_DIR?.trim() ||
    join(process.env.COMFYUI_MCP_DATA_DIR?.trim() || join(homedir(), ".comfyui-mcp"), "training", "ai-toolkit")
  );
}

/** The python of the ai-toolkit venv (bootstrap creates it). */
export function resolveAiToolkitPython(): string {
  if (process.env.COMFYUI_MCP_AI_TOOLKIT_PYTHON?.trim()) return process.env.COMFYUI_MCP_AI_TOOLKIT_PYTHON.trim();
  const dir = resolveAiToolkitDir();
  return process.platform === "win32"
    ? join(dir, "venv", "Scripts", "python.exe")
    : join(dir, "venv", "bin", "python");
}

/** Is a native training environment present AND complete? run.py + venv python
 *  alone are NOT enough: a bootstrap whose pip steps died midway still has both
 *  (codex finding — an incomplete env was selected, then failed asynchronously
 *  on missing imports). A completed bootstrap writes `.bootstrap-ok` — trusted
 *  ONLY for the bundled venv it was created against. Anything else (pre-marker
 *  envs, a COMFYUI_MCP_AI_TOOLKIT_PYTHON override) must show the full critical
 *  package set in the CONFIGURED interpreter's site-packages (codex findings:
 *  torch alone let a torch-but-no-requirements env through; the venv-only
 *  probe broke the override both ways). */
export async function nativeToolkitReady(): Promise<boolean> {
  try {
    const dir = resolveAiToolkitDir();
    const python = resolveAiToolkitPython();
    if (!existsSync(join(dir, "run.py")) || !existsSync(python)) return false;
    const bundled = process.platform === "win32" ? join(dir, "venv", "Scripts", "python.exe") : join(dir, "venv", "bin", "python");
    // Marker trusted ONLY when it was written for the CURRENT pinned ref — an
    // install that survives an app upgrade (new AI_TOOLKIT_REF) must re-verify
    // via the package probe below instead of inheriting "ready" (codex).
    if (python === bundled && existsSync(join(dir, ".bootstrap-ok"))) {
      try {
        const marker = readFileSync(join(dir, ".bootstrap-ok"), "utf-8").trim().split(/\s+/)[0];
        if (marker === AI_TOOLKIT_REF) return true;
      } catch { /* unreadable marker → fall through to the probe */ }
    }
    return pythonEnvComplete(python) && checkoutMatchesRef(dir);
  } catch {
    return false;
  }
}

/** Is the ai-toolkit checkout on the pinned ref? Unverifiable WITHOUT .git
 *  (a plain copy) → trust the package probe; a git checkout on the WRONG ref
 *  (stale after an app upgrade changed AI_TOOLKIT_REF) → not ready, so
 *  train_bootstrap re-pins it (codex finding: package-only probing selected
 *  the stale checkout). */
function checkoutMatchesRef(dir: string): boolean {
  if (!existsSync(join(dir, ".git"))) return true;
  try {
    const head = childProcess.execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf-8", timeout: 5_000 }).trim();
    return head === AI_TOOLKIT_REF;
  } catch {
    return false;
  }
}

/** The critical packages a native FLUX LoRA run imports — a pip step that died
 *  midway through ANY of torch / requirements / hf_transfer leaves at least one
 *  missing, so the set can't false-positive on an incomplete env. */
const REQUIRED_NATIVE_PACKAGES = ["torch", "diffusers", "transformers", "accelerate", "hf_transfer"];

/** Every REQUIRED_NATIVE_PACKAGES module resolvable by the CONFIGURED
 *  interpreter itself, via importlib find_spec (no module execution — ~200ms).
 *  Path-derived probes can't model sys.path for system pythons, pyenv shims,
 *  dist-packages or user-site layouts (codex finding). An interpreter that
 *  can't answer is not a usable trainer → false. */
function pythonEnvComplete(python: string): boolean {
  try {
    childProcess.execFileSync(
      python,
      ["-c", `import importlib.util as u, sys; sys.exit(0 if all(u.find_spec(m) for m in ${JSON.stringify(REQUIRED_NATIVE_PACKAGES)}) else 1)`],
      { timeout: 20_000, stdio: "ignore", windowsHide: true },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Native training run: `<venv-python> run.py config.yml` with cwd at the
 * ai-toolkit checkout. Config paths (dataset/output) are REAL host paths —
 * unlike docker mode, no mount-point rewrite. HF cache goes via HF_HOME.
 */
export function startNativeTraining(opts: {
  containerName: string; // kept for handle/registry compatibility (no container exists)
  configPath: string;
  datasetPath: string; // unused by the spawn (config already points here) — kept for parity
  outputDir: string;
  hfCacheDir?: string;
  hfToken?: string;
  onProgress?: (p: TrainingProgress) => void;
  onLog?: (line: string) => void;
}): TrainingHandle {
  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    PYTHONUNBUFFERED: "1",
    PYTHONUTF8: "1",
    HF_HUB_ENABLE_HF_TRANSFER: "1",
  };
  if (opts.hfCacheDir) env.HF_HOME = opts.hfCacheDir;
  if (opts.hfToken) env.HF_TOKEN = opts.hfToken;
  return spawnTrainer(opts.containerName, resolveAiToolkitPython(), ["run.py", opts.configPath], env, opts, resolveAiToolkitDir());
}

/** Stop a NATIVE training process (the handle's child). Best-effort group kill:
 *  SIGTERM the process group on posix, taskkill /T on Windows. Honest envelope
 *  like stopTraining. */
export async function stopNativeTraining(child: childProcess.ChildProcess): Promise<TrainerEnvelope<{ stopped: string }>> {
  try {
    if (process.platform === "win32" && child.pid) {
      childProcess.execSync(`taskkill /PID ${child.pid} /T /F`, { timeout: 10_000, windowsHide: true });
    } else if (child.pid) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        process.kill(child.pid, "SIGTERM");
      }
    }
    return ok("train_cancel", { stopped: String(child.pid ?? "unknown") });
  } catch (err) {
    return fail("train_cancel", "stop_failed", `could not stop native training (pid ${child.pid}): ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Escape a literal string for use inside a POSIX ERE (pgrep/pkill -f): config
 *  paths can contain regex metacharacters ([ ( . + …) from COMFYUI_MCP_TRAINING_DIR,
 *  which would otherwise make the pattern invalid or mis-match (codex finding). */
function escapeEre(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Escape a literal string for a PowerShell -like wildcard pattern (`*?[]`). */
function escapePsLike(s: string): string {
  return s.replace(/([[\]?*])/g, "`$1");
}

/** The process-image filter for Windows probes. We deliberately match the
 *  COMMAND LINE ONLY (no image-name filter): the configured interpreter may be
 *  python.exe, python3.exe, or a renamed launcher — and a DIFFERENT MCP process
 *  than the launcher may run this probe, so any name filter risks making a live
 *  trainer invisible (codex finding: cancelled-on-paper, still-burning-GPU).
 *  The cmdline match (run.py + the job's unique id dir) is already specific;
 *  the trade is a full-table CIM scan (~1s). */
function nativeCmdlinePredicate(jobKey: string): string {
  // `-ne $PID` excludes the probing PowerShell itself: its own command line
  // carries this predicate text (which contains "run.py" AND the job key), so
  // without the exclusion the probe ALWAYS matches itself (codex finding).
  return `($_.ProcessId -ne $PID) -and $_.CommandLine -like '*run.py*' -and $_.CommandLine -like '*${escapePsLike(jobKey)}*'`;
}

/** Stop a NATIVE training process WITHOUT a handle, by its config path (the
 *  cross-process cancel path — e.g. a second MCP process canceling a job whose
 *  owner died). Matches the run.py cmdline against the config's job-id dir
 *  (unique per job) so unrelated python/run.py processes survive. The [r]
 *  bracket keeps the probe's own cmdline from self-matching on posix. */
export async function stopNativeByConfig(configPath: string): Promise<TrainerEnvelope<{ stopped: string }>> {
  const jobKey = basename(dirname(configPath));
  try {
    if (process.platform === "win32") {
      const script =
        `Get-CimInstance Win32_Process | Where-Object { ${nativeCmdlinePredicate(jobKey)} } | ` +
        `ForEach-Object { & taskkill /PID $_.ProcessId /T /F | Out-Null; Write-Output $_.ProcessId }`;
      const out = childProcess.execFileSync("powershell.exe", ["-NoProfile", "-Command", script], { timeout: 15_000, windowsHide: true, encoding: "utf-8" });
      // taskkill is synchronous, but the CIM scan can lag the actual teardown —
      // confirm exit so an immediate liveness re-probe can't see a zombie
      // (codex finding: cancel reverted to running, then finalized as failed).
      await waitNativeGone(configPath, 7_000);
      return ok("train_cancel", { stopped: out.trim() || jobKey });
    }
    // POSIX: signal the trainer's whole PROCESS GROUP, not just cmdline
    // matches — spawnTrainer detaches (the trainer is its group leader) and
    // ai-toolkit workers carry different cmdlines, so a cmdline-only pkill
    // leaves them burning GPU after "cancel" (codex finding).
    const pg = childProcess.execFileSync("pgrep", ["-f", `[r]un.py ${escapeEre(configPath)}`], { timeout: 10_000, encoding: "utf-8" });
    const pids = pg.split(/\s+/).filter(Boolean);
    for (const pid of pids) {
      try {
        childProcess.execFileSync("kill", ["-TERM", `-${pid}`], { timeout: 5_000 }); // negative = the process group
      } catch {
        try { childProcess.execFileSync("kill", ["-TERM", pid], { timeout: 5_000 }); } catch { /* already gone */ }
      }
    }
    // SIGTERM delivery is not exit: a cancel that reports success while the
    // trainer is still dying gets probed as "still running" and wrongly
    // reverts to running (codex finding) — wait for disappearance.
    if (await waitNativeGone(configPath, 7_000)) {
      return ok("train_cancel", { stopped: jobKey });
    }
    return fail("train_cancel", "still_running", `SIGTERM sent but the trainer for ${jobKey} is still alive after 7s`);  } catch (err) {
    // pkill exits 1 on no match — that is success for an idempotent cancel.
    const code = (err as { status?: number })?.status;
    if (process.platform !== "win32" && code === 1) return ok("train_cancel", { stopped: `${jobKey} (already gone)` });
    return fail("train_cancel", "stop_failed", `could not stop native training for ${jobKey}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Poll until no native run.py for this config remains (true) or the budget
 *  runs out (false). Probe failures count as "gone" — matching the unknown-is-
 *  not-running semantics of the liveness probe's callers. */
async function waitNativeGone(configPath: string, budgetMs: number): Promise<boolean> {
  const start = Date.now();
  for (;;) {
    const alive = await nativeProcessRunning(configPath);
    if (alive !== true) return true;
    if (Date.now() - start > budgetMs) return false;
    await new Promise((r) => setTimeout(r, 400));
  }
}

/** Is a NATIVE training process for this config path still alive? Config-scoped
 *  like stopNativeByConfig (the job-id dir is the match key). Returns false only
 *  when the process is DEFINITIVELY gone — null on probe failure (unknown).
 *  Without this the registry's dead-owner recovery can never fire for native
 *  jobs (it recovers only on a definitive false) and a finished-but-orphaned
 *  run would sit "running" forever, never handing off its LoRA (codex finding). */
export async function nativeProcessRunning(configPath: string): Promise<boolean | null> {
  const jobKey = basename(dirname(configPath));
  try {
    if (process.platform === "win32") {
      const script =
        `@(Get-CimInstance Win32_Process | Where-Object { ${nativeCmdlinePredicate(jobKey)} }).Count`;
      const out = childProcess.execFileSync("powershell.exe", ["-NoProfile", "-Command", script], { timeout: 15_000, windowsHide: true, encoding: "utf-8" });
      return Number(out.trim()) > 0;
    }
    childProcess.execFileSync("pgrep", ["-f", `[r]un.py ${escapeEre(configPath)}`], { timeout: 10_000, stdio: "ignore" });
    return true;
  } catch (err) {
    const code = (err as { status?: number })?.status;
    if (process.platform !== "win32" && code === 1) return false; // pgrep: no match
    return null; // probe itself failed — unknown
  }
}

/** Shared spawn+stream+tail for docker and native trainers. */
function spawnTrainer(
  name: string,
  executable: string,
  args: string[],
  env: Record<string, string>,
  opts: {
    onProgress?: (p: TrainingProgress) => void;
    onLog?: (line: string) => void;
  },
  cwd?: string,
): TrainingHandle {
  // detached on posix so stopNativeTraining can kill the whole process group.
  const child = childProcess.spawn(executable, args, {
    windowsHide: true,
    env,
    cwd,
    detached: process.platform !== "win32",
  });
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
      logger.debug(`[ai-toolkit] trainer spawn error: ${err instanceof Error ? err.message : String(err)}`);
      resolve({ code: 1, tail: tailLines.slice(-40).join("\n") });
    });
  });
  return { containerName: name, done, child };
}

/** Stop a running training container. The envelope is honest about failure:
 *  a non-zero `docker stop` (daemon down, timeout) yields ok:false so callers
 *  don't report a container as stopped while it keeps burning GPU. An
 *  already-gone container counts as stopped. */
export async function stopTraining(containerName: string): Promise<TrainerEnvelope<{ stopped: string }>> {
  const r = await execDocker(["stop", "-t", "10", containerName], 30_000);
  if (r.code !== 0 && !/no such (object|container)/i.test(r.stderr)) {
    return fail("train_cancel", "stop_failed", `docker stop ${containerName} failed: ${r.stderr.trim() || `exit ${r.code}`}`, r.stderr);
  }
  return ok("train_cancel", { stopped: containerName });
}

/** Is this training container currently running? `false` when it definitively
 *  does not exist, `null` when we can't tell (docker daemon down, etc.) — the
 *  registry uses this to avoid mis-marking a live foreign-process job failed. */
export async function containerRunning(containerName: string): Promise<boolean | null> {
  const r = await execDocker(["inspect", "-f", "{{.State.Running}}", containerName]);
  if (r.code === 0) return r.stdout.trim() === "true";
  if (/no such (object|container)/i.test(r.stderr)) return false;
  return null;
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
