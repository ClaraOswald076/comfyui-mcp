// Dataset + job-config readers behind the training surfaces (panel Jobs/
// Datasets tabs, the mobile monitor). READ-ONLY, and bounded to the training
// root: dataset names are basename-checked, train_file paths are realpath-
// contained, and inlining is size-capped (a phone is the other end).

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, extname, join, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { datasetsRoot, getJob, trainingRoot } from "./training-jobs.js";

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
/** train_file inlining cap — a sample/dataset photo, not a checkpoint. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;

export interface DatasetSummary {
  name: string;
  imageCount: number;
  captionedCount: number;
  /** Latest file mtime in the dir (ISO string). */
  modified: string;
}

export interface DatasetDetail extends DatasetSummary {
  datasetPath: string;
  items: Array<{ file: string; caption: string | null }>;
}

/** Containment on REAL paths — a symlinked dir must not smuggle reads across
 *  the root (same lesson as the ref resolver, #302). Missing paths resolve
 *  lexically and fail later with an honest not-found. */
function realOrLexical(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

function contained(child: string, root: string): boolean {
  const c = realOrLexical(child);
  const r = realOrLexical(root);
  const norm = (x: string) => (process.platform === "win32" ? x.toLowerCase() : x);
  return norm(c) === norm(r) || norm(c).startsWith(norm(r) + sep);
}

/** Resolve a dataset dir by NAME, with traversal + existence checks. */
function datasetDir(name: string): string {
  const clean = name.trim();
  if (!clean || clean !== basename(clean) || clean.startsWith(".")) {
    throw new Error(`invalid dataset name "${name}"`);
  }
  const dir = join(datasetsRoot(), clean);
  if (!contained(dir, datasetsRoot())) {
    throw new Error(`dataset "${name}" escapes the datasets root`);
  }
  if (!existsSync(dir)) throw new Error(`no dataset "${clean}" (looked in ${datasetsRoot()})`);
  return dir;
}

function summarize(dir: string, name: string): DatasetSummary {
  const files = readdirSync(dir);
  const images = files.filter((f) => IMAGE_EXTS.has(extname(f).toLowerCase()));
  const captioned = images.filter((f) =>
    existsSync(join(dir, `${basename(f, extname(f))}.txt`)),
  );
  const modified = Math.max(
    0,
    ...files.map((f) => {
      try {
        return statSync(join(dir, f)).mtimeMs;
      } catch {
        return 0;
      }
    }),
  );
  return {
    name,
    imageCount: images.length,
    captionedCount: captioned.length,
    modified: new Date(modified || 0).toISOString(),
  };
}

/** Every staged dataset, newest first. */
export function listDatasets(): DatasetSummary[] {
  const root = datasetsRoot();
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => summarize(join(root, d.name), d.name))
    .filter((s) => s.imageCount > 0)
    .sort((a, b) => b.modified.localeCompare(a.modified));
}

/** One dataset's items with their captions (null when uncaptioned). */
export function getDataset(name: string): DatasetDetail {
  const dir = datasetDir(name);
  const files = readdirSync(dir)
    .filter((f) => IMAGE_EXTS.has(extname(f).toLowerCase()))
    .sort();
  const items = files.map((f) => {
    const capPath = join(dir, `${basename(f, extname(f))}.txt`);
    let caption: string | null = null;
    try {
      caption = readFileSync(capPath, "utf-8").trim() || null;
    } catch {
      /* uncaptioned */
    }
    return { file: f, caption };
  });
  return { ...summarize(dir, name), datasetPath: dir, items };
}

// ── train_file: bounded inline reads under the training root ───────────────

/** Read an image under the training root (dataset images, job samples) as
 *  base64 for the MCP image channel. Contained, image-only, size-capped. */
export function readTrainingFile(absPath: string): { data: string; mimeType: string } {
  if (!contained(absPath, trainingRoot())) {
    throw new Error("path escapes the training root");
  }
  const p = realOrLexical(absPath);
  const ext = extname(p).toLowerCase();
  if (!IMAGE_EXTS.has(ext)) {
    throw new Error(`only image files are served (${[...IMAGE_EXTS].join("/")}), not ${ext || "(none)"}`);
  }
  const st = statSync(p); // ENOENT surfaces honestly as "no such file"
  if (st.size > MAX_FILE_BYTES) {
    throw new Error(`file too large to inline (${(st.size / 1024 / 1024).toFixed(1)} MB > 2 MB) — fetch it on the rig instead`);
  }
  const mimeType = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
  return { data: readFileSync(p).toString("base64"), mimeType };
}

// ── train_job_config: "what settings did this run use?" ────────────────────

export interface JobConfigView {
  id: string;
  name: string;
  flow: string;
  model: string;
  trigger?: string;
  datasetPath: string;
  params: {
    steps?: number;
    lr?: number;
    rank?: number;
    resolution?: number[];
    batchSize?: number;
    saveEvery?: number;
    sampleEvery?: number;
    quantize?: boolean;
  };
  /** Where params were read from. "config.yml" covers every job incl. records
   *  written before any params-persistence; "unknown" when unreadable. */
  source: "config.yml" | "unknown";
}

/** Read a job's effective settings back from the ai-toolkit config.yml we
 *  wrote for it (the single source of truth run.py consumed). */
export async function getJobConfig(id: string): Promise<JobConfigView> {
  const job = await getJob(id);
  if (!job) throw new Error(`no training job ${id}`);
  const params: JobConfigView["params"] = {};
  let source: JobConfigView["source"] = "unknown";
  try {
    const doc = parseYaml(readFileSync(join(job.jobDir, "config.yml"), "utf-8")) as {
      config?: { process?: Array<Record<string, unknown>> };
    };
    const proc = (doc?.config?.process?.[0] ?? {}) as Record<string, Record<string, unknown> & { datasets?: Array<Record<string, unknown>> }>;
    const train = proc.train ?? {};
    const network = proc.network ?? {};
    const save = proc.save ?? {};
    const sample = proc.sample ?? {};
    const model = proc.model ?? {};
    const ds = Array.isArray(proc.datasets) ? (proc.datasets[0] ?? {}) : {};
    if (typeof train.steps === "number") params.steps = train.steps;
    if (typeof train.lr === "number") params.lr = train.lr;
    if (typeof network.linear === "number") params.rank = network.linear;
    if (Array.isArray(ds.resolution)) params.resolution = ds.resolution as number[];
    if (typeof train.batch_size === "number") params.batchSize = train.batch_size;
    if (typeof save.save_every === "number") params.saveEvery = save.save_every;
    if (typeof sample.sample_every === "number") params.sampleEvery = sample.sample_every;
    if (typeof model.quantize === "boolean") params.quantize = model.quantize;
    source = "config.yml";
  } catch {
    // config.yml missing/unreadable — return the record fields, empty params
  }
  return {
    id: job.id,
    name: job.name,
    flow: job.flow,
    model: job.model,
    trigger: job.trigger,
    datasetPath: job.datasetPath,
    params,
    source,
  };
}
