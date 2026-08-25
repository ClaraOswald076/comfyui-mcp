/**
 * comfy-kitchen: see what the kernel library can do on this GPU, find where the
 * open graph leaves it on the table, and apply the faster path with proof.
 *
 * Every recommendation is a conjunction of facts. A failed probe is `unknown`,
 * never a "no" — a recommendation fires only when every input it needs is known.
 */

import { execFile } from "node:child_process";
import { open, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { config, getComfyUIBaseUrl, isRemoteMode } from "../config.js";
import { getLogs, getSystemStats } from "../comfyui/client.js";
import { comfyuiFetch } from "../comfyui/fetch.js";
import type { SystemStats } from "../comfyui/types.js";
import { isApiFormat, isUiFormat } from "./workflow-converter.js";
import { resolveComfyuiPython } from "./workspace-env.js";
import { logger } from "../utils/logger.js";

// ---------------------------------------------------------------------------
// Facts — known or unknown, never a guessed negative
// ---------------------------------------------------------------------------

export type Fact<T> =
  | { status: "known"; value: T }
  | { status: "unknown"; reason: string };

export function known<T>(value: T): Fact<T> {
  return { status: "known", value };
}

export function unknown<T = never>(reason: string): Fact<T> {
  return { status: "unknown", reason };
}

export function isKnown<T>(f: Fact<T>): f is { status: "known"; value: T } {
  return f.status === "known";
}

export const KITCHEN_BACKENDS = ["hip", "cuda", "triton", "eager"] as const;
export type KitchenBackendName = (typeof KITCHEN_BACKENDS)[number];

export type KitchenQuant = "none" | "fp8_e4m3fn" | "fp8_e5m2" | "nvfp4" | "mxfp8";

export type KitchenRecKind = "fp8_unet_fast" | "ck_attention" | "nvfp4_swap" | "triton_backend";

export interface KitchenBackendState {
  name: KitchenBackendName;
  available: Fact<boolean>;
  disabled?: boolean;
  unavailable_reason?: string;
  capabilities?: string[];
}

export interface KitchenFlags {
  useCkAttention: boolean;
  useSageAttention: boolean;
  enableTritonBackend: boolean;
  disableTritonBackend: boolean;
  fastFp8MatrixMult: boolean;
  fastCublasOps: boolean;
  argvKnown: boolean;
}

export interface KitchenStatus {
  location: "LOCAL" | "REMOTE";
  present: Fact<boolean>;
  version: Fact<string>;
  backends: Record<KitchenBackendName, KitchenBackendState>;
  attention: {
    /** Conjunction: flag in argv AND "Using Comfy Kitchen attention" in the log. */
    ck: Fact<boolean>;
    ckFlag: Fact<boolean>;
    ckLog: Fact<boolean>;
    sageFlag: Fact<boolean>;
  };
  gpu: {
    name?: string;
    type?: string;
    sm: Fact<number>;
    fp8: Fact<boolean>;
    nvfp4: Fact<boolean>;
    mxfp8: Fact<boolean>;
    int8Attention: Fact<boolean>;
  };
  flags: KitchenFlags;
  flagSupport: {
    ckAttention: Fact<boolean>;
    tritonBackend: Fact<boolean>;
  };
  sageattentionInstalled: Fact<boolean>;
  tritonVersion: Fact<string>;
  host: "cuda" | "rocm" | "mps" | "cpu" | "unknown";
  sources: {
    log: boolean;
    stats: boolean;
    probe: boolean;
    cliArgs: boolean;
  };
}

export interface KitchenLoader {
  node_id: string;
  node_type: string;
  unet_name: Fact<string>;
  weight_dtype: Fact<string>;
  quant: Fact<KitchenQuant>;
}

export interface KitchenRecommendation {
  id: string;
  kind: KitchenRecKind;
  node_id?: string;
  node_type?: string;
  why: string;
  safe: string;
  restart: boolean;
  download: boolean;
  change: {
    type: "widget" | "flag" | "model_swap";
    widget?: string;
    value?: string;
    previous?: string;
    flag?: string;
    filename?: string;
    variant?: string;
  };
}

export interface ProofSample {
  seed: number;
  secondsPerIteration?: number;
  peakVramGb?: number;
  outputBlack: boolean;
  outputNan: boolean;
}

export interface KitchenApplyResult {
  applied: boolean;
  needs_confirm?: boolean;
  reverted?: boolean;
  revert_reason?: string;
  recommendation: KitchenRecommendation;
  proof: {
    status: "proven" | "not_run" | "queued" | "reverted" | "failed";
    before?: ProofSample;
    after?: ProofSample;
    summary?: string;
  };
  flag_note?: string;
  restart?: unknown;
  previous?: unknown;
}

export interface KitchenFlagApplyOutcome {
  applied: boolean;
  note: string;
  restart?: unknown;
}

export interface KitchenLogParse {
  version: Fact<string>;
  backends: Partial<Record<KitchenBackendName, { available: boolean; raw: string }>>;
  ckAttentionLog: Fact<boolean>;
  tritonEnabledLog: Fact<boolean>;
  tritonVersion: Fact<string>;
  sageLog: Fact<boolean>;
  /** Known-false only when the log reports the import failed — silence is unknown. */
  sageMissingLog: Fact<boolean>;
}

/**
 * The python source the kitchen import-probe runs. Exported so a test can assert
 * the NEGATIVE that matters: we never `import torch` inside the probe budget.
 */
export const KITCHEN_PROBE_SOURCE = [
  "import importlib.util as u, json, sys",
  "print('present', u.find_spec('comfy_kitchen') is not None)",
  "ver = ''",
  "try:",
  "    import importlib.metadata as md",
  "    ver = md.version('comfy-kitchen')",
  "except Exception:",
  "    ver = ''",
  "print('version', ver)",
  "if u.find_spec('comfy_kitchen') is not None:",
  "    try:",
  "        import comfy_kitchen as ck",
  "        try:",
  "            print('backends', json.dumps(ck.list_backends(), default=str))",
  "        except Exception as e:",
  "            print('backends_error', type(e).__name__)",
  "        try:",
  "            print('int8', ck.int8_attention_is_available())",
  "        except Exception:",
  "            print('int8', 'unknown')",
  "    except Exception as e:",
  "        print('import_error', type(e).__name__)",
].join("\n");

const CK_ATTENTION_FLAG = "--use-ck-attention";
const SAGE_ATTENTION_FLAG = "--use-sage-attention";
const ENABLE_TRITON_FLAG = "--enable-triton-backend";
const DISABLE_TRITON_FLAG = "--disable-triton-backend";
const FP8_FAST = "fp8_e4m3fn_fast";

let hintEmittedThisProcess = false;

/** Test hook: the proactive hint is once per process. */
export function resetKitchenHintSession(): void {
  hintEmittedThisProcess = false;
}

// ---------------------------------------------------------------------------
// Log / argv / GPU parsers (pure)
// ---------------------------------------------------------------------------

/** Join /internal/logs payload shapes the same way env-capabilities does. */
export function logTextFromPayload(data: unknown): string {
  const entries = (data as { entries?: unknown[] })?.entries;
  if (Array.isArray(entries)) {
    return entries
      .map((e) => (typeof e === "string" ? e : ((e as { m?: string })?.m ?? "")))
      .join("\n");
  }
  if (typeof data === "string") return data;
  if (Array.isArray(data)) return data.map(String).join("\n");
  try {
    return JSON.stringify(data);
  } catch {
    return String(data ?? "");
  }
}

function matchingClose(open: string, close: string): boolean {
  return (open === "{" && close === "}") || (open === "[" && close === "]") || (open === "(" && close === ")");
}

function splitTopLevelDictionary(raw: string): string[] | undefined {
  const text = raw.trim();
  if (text.length < 2 || text[0] !== "{" || text[text.length - 1] !== "}") return undefined;

  const members: string[] = [];
  const stack: string[] = [];
  let quote: "'" | '"' | undefined;
  let escaped = false;
  let start = 1;

  for (let i = 1; i < text.length - 1; i++) {
    const ch = text[i]!;
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (ch === "{" || ch === "[" || ch === "(") {
      stack.push(ch);
    } else if (ch === "}" || ch === "]" || ch === ")") {
      const open = stack.pop();
      if (!open || !matchingClose(open, ch)) return undefined;
    } else if (ch === "," && stack.length === 0) {
      const member = text.slice(start, i).trim();
      if (!member) return undefined;
      members.push(member);
      start = i + 1;
    }
  }

  if (quote || stack.length > 0) return undefined;
  const last = text.slice(start, -1).trim();
  if (last) members.push(last);
  return members;
}

function topLevelColon(member: string): number {
  const stack: string[] = [];
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (let i = 0; i < member.length; i++) {
    const ch = member[i]!;
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (ch === "{" || ch === "[" || ch === "(") {
      stack.push(ch);
    } else if (ch === "}" || ch === "]" || ch === ")") {
      const open = stack.pop();
      if (!open || !matchingClose(open, ch)) return -1;
    } else if (ch === ":" && stack.length === 0) {
      return i;
    }
  }
  return -1;
}

function parseKitchenDictionaryAvailable(raw: string): boolean | undefined {
  const members = splitTopLevelDictionary(raw);
  if (!members) return undefined;

  let available: boolean | undefined;
  for (const member of members) {
    const colon = topLevelColon(member);
    if (colon < 0) return undefined;
    const key = member.slice(0, colon).trim();
    const value = member.slice(colon + 1).trim();
    if (!key || !value) return undefined;
    if (!/^(?:"available"|'available'|available)$/i.test(key)) continue;

    if (!/^true$/i.test(value) && !/^false$/i.test(value)) return undefined;
    if (available !== undefined) return undefined;
    available = /^true$/i.test(value);
  }
  return available;
}

export function parseKitchenLog(text: string): KitchenLogParse {
  const versionMatch = text.match(/comfy-kitchen version:\s*(\S+)/i);
  const backends: KitchenLogParse["backends"] = {};
  const backendRe = /Found comfy_kitchen backend\s+(\w+)\s*:\s*([^\r\n]+)/gi;
  for (const m of text.matchAll(backendRe)) {
    const name = m[1]!.toLowerCase();
    if ((KITCHEN_BACKENDS as readonly string[]).includes(name)) {
      const raw = m[2]!.trim();
      const dictionaryAvailable = parseKitchenDictionaryAvailable(raw);
      // Older logs used "available (cached)" rather than a bare status.
      const available =
        dictionaryAvailable ?? /^(?:available|enabled|ok|loaded|true|ready)(?:\s+\(cached\))?$/i.test(raw);
      backends[name as KitchenBackendName] = { available, raw };
    }
  }
  const tritonEnable = /Found triton\s+(\S+)\.\s*Enabling comfy-kitchen triton backend/i.exec(
    text,
  );
  const tritonFound = /Found triton\s+(\S+)/i.exec(text);
  const ckAttn = /Using Comfy Kitchen attention/i.test(text);
  const sage = /Using sage attention/i.test(text);
  return {
    version: versionMatch ? known(versionMatch[1]!) : unknown("no comfy-kitchen version line in log"),
    backends,
    ckAttentionLog: ckAttn
      ? known(true)
      : unknown("log has no 'Using Comfy Kitchen attention' line (absence is not a no)"),
    tritonEnabledLog: /Enabling comfy-kitchen triton backend/i.test(text)
      ? known(true)
      : unknown("log has no kitchen triton-enable line"),
    tritonVersion: tritonEnable
      ? known(tritonEnable[1]!)
      : tritonFound
        ? known(tritonFound[1]!)
        : unknown("no 'Found triton' line"),
    sageLog: sage ? known(true) : unknown("log has no 'Using sage attention' line"),
    sageMissingLog: /No module named ['"]sageattention['"]|Could not load sageattention/i.test(text)
      ? known(true)
      : unknown("log does not report a sageattention import failure"),
  };
}

export function parseKitchenArgv(argv: string[] | undefined): KitchenFlags {
  if (!Array.isArray(argv)) {
    return {
      useCkAttention: false,
      useSageAttention: false,
      enableTritonBackend: false,
      disableTritonBackend: false,
      fastFp8MatrixMult: false,
      fastCublasOps: false,
      argvKnown: false,
    };
  }
  const tokens = argv.filter((t): t is string => typeof t === "string");
  const has = (flag: string) => tokens.includes(flag);
  // `--fast fp8_matrix_mult` is a flag + value; also accept `--fast=fp8_matrix_mult`
  // and a bare `--fast` that turns every PerformanceFeature on.
  let fastFp8 = false;
  let fastCublas = false;
  let bareFast = false;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t === "--fast") {
      const next = tokens[i + 1];
      if (!next || next.startsWith("-")) {
        bareFast = true;
      } else if (next === "fp8_matrix_mult") fastFp8 = true;
      else if (next === "cublas_ops") fastCublas = true;
    } else if (t.startsWith("--fast=")) {
      const v = t.slice("--fast=".length);
      if (v === "fp8_matrix_mult") fastFp8 = true;
      if (v === "cublas_ops") fastCublas = true;
    }
  }
  return {
    useCkAttention: has(CK_ATTENTION_FLAG),
    useSageAttention: has(SAGE_ATTENTION_FLAG),
    enableTritonBackend: has(ENABLE_TRITON_FLAG),
    disableTritonBackend: has(DISABLE_TRITON_FLAG),
    fastFp8MatrixMult: bareFast || fastFp8,
    fastCublasOps: bareFast || fastCublas,
    argvKnown: true,
  };
}

/**
 * Map a GPU marketing name to a compute capability. Unrecognized names stay
 * unknown — a filename or a close spelling is not an SM number.
 */
export function inferComputeFromGpu(
  gpuName: string | undefined,
  deviceType?: string,
): {
  sm: Fact<number>;
  fp8: Fact<boolean>;
  nvfp4: Fact<boolean>;
  mxfp8: Fact<boolean>;
  host: KitchenStatus["host"];
} {
  const type = (deviceType ?? "").toLowerCase();
  let host: KitchenStatus["host"] = "unknown";
  if (/^(hip|rocm)$/.test(type) || /radeon|instinct|\bamd\b/i.test(gpuName ?? "")) host = "rocm";
  else if (/^cuda$/.test(type) || /nvidia|geforce|rtx|tesla|quadro/i.test(gpuName ?? ""))
    host = "cuda";
  else if (/^mps$/.test(type) || /apple|metal/i.test(gpuName ?? "")) host = "mps";
  else if (/^cpu$/.test(type)) host = "cpu";

  const n = (gpuName ?? "").replace(/^(?:cuda|cpu|mps|xpu|hip|rocm):\d+\s+/i, "");
  let sm: number | undefined;
  // Blackwell consumer is sm_120; datacenter B100/B200 is sm_100. Both are ≥ 10.0.
  if (/\b(?:RTX\s*50\d{2}|GeForce\s*RTX\s*50\d{2})\b/i.test(n) || /Blackwell/i.test(n)) sm = 12.0;
  else if (/\b(?:B100|B200|GB200)\b/i.test(n)) sm = 10.0;
  else if (
    /\b(?:RTX\s*40\d{2}|GeForce\s*RTX\s*40\d{2}|L40S?\b|L4\b|RTX\s*6000\s*Ada|Ada)\b/i.test(n)
  )
    sm = 8.9;
  else if (/\b(?:H100|H200|GH200)\b/i.test(n)) sm = 9.0;
  else if (/\b(?:RTX\s*30\d{2}|GeForce\s*RTX\s*30\d{2}|A6000|A40)\b/i.test(n)) sm = 8.6;
  else if (/\bA100\b/i.test(n)) sm = 8.0;
  else if (/\b(?:RTX\s*20\d{2}|GeForce\s*RTX\s*20\d{2}|T4\b)\b/i.test(n)) sm = 7.5;

  if (sm === undefined) {
    const reason = gpuName
      ? `GPU name "${gpuName}" is not in the known SM table`
      : "no GPU name to map to a compute capability";
    return {
      sm: unknown(reason),
      fp8: unknown(reason),
      nvfp4: unknown(reason),
      mxfp8: unknown(reason),
      host,
    };
  }
  return {
    sm: known(sm),
    fp8: known(sm >= 8.9),
    nvfp4: known(sm >= 10.0),
    mxfp8: known(sm >= 10.0),
    host,
  };
}

export function parseKitchenProbe(stdout: string): {
  present: Fact<boolean>;
  version: Fact<string>;
  backends: Partial<Record<KitchenBackendName, { available: boolean }>>;
  int8: Fact<boolean>;
} {
  const out = stdout || "";
  if (!out.trim()) {
    return {
      present: unknown("kitchen import-probe produced no output"),
      version: unknown("kitchen import-probe produced no output"),
      backends: {},
      int8: unknown("kitchen import-probe produced no output"),
    };
  }
  const presentLine = out.match(/^present\s+(True|False)/m);
  const present: Fact<boolean> = presentLine
    ? known(presentLine[1] === "True")
    : unknown("probe did not print a present line");
  const ver = out.match(/^version\s+(\S+)/m)?.[1];
  const backends: Partial<Record<KitchenBackendName, { available: boolean }>> = {};
  const backendsJson = out.match(/^backends\s+(.+)$/m)?.[1];
  if (backendsJson && backendsJson !== "") {
    try {
      const parsed = JSON.parse(backendsJson) as Record<string, unknown>;
      for (const name of KITCHEN_BACKENDS) {
        const entry = parsed[name];
        if (entry && typeof entry === "object") {
          const rec = entry as { available?: unknown };
          if (typeof rec.available === "boolean") backends[name] = { available: rec.available };
        } else if (typeof entry === "boolean") {
          backends[name] = { available: entry };
        }
      }
    } catch {
      /* leave backends empty — unknown, not a no */
    }
  }
  const int8Line = out.match(/^int8\s+(True|False|unknown|True|False)/m);
  let int8: Fact<boolean> = unknown("probe did not print int8");
  if (int8Line) {
    if (int8Line[1] === "True") int8 = known(true);
    else if (int8Line[1] === "False") int8 = known(false);
    else int8 = unknown("int8_attention_is_available raised");
  }
  return {
    present,
    version: ver && ver.length > 0 ? known(ver) : unknown("probe printed no comfy-kitchen version"),
    backends,
    int8,
  };
}

export function parseCliArgsFlagSupport(source: string | undefined): {
  ckAttention: Fact<boolean>;
  tritonBackend: Fact<boolean>;
} {
  if (!source) {
    return {
      ckAttention: unknown("comfy/cli_args.py was not readable"),
      tritonBackend: unknown("comfy/cli_args.py was not readable"),
    };
  }
  return {
    ckAttention: known(/use-ck-attention|use_ck_attention/.test(source)),
    tritonBackend: known(/enable-triton-backend|enable_triton_backend/.test(source)),
  };
}

export function packageVersionFromStats(
  stats: { system?: { comfy_package_versions?: unknown } } | undefined,
  name: string,
): Fact<string> {
  const pkgs = stats?.system?.comfy_package_versions;
  if (!Array.isArray(pkgs)) return unknown("system_stats has no comfy_package_versions");
  const hit = pkgs.find((p) => p && typeof p === "object" && (p as { name?: string }).name === name);
  const installed = (hit as { installed?: unknown } | undefined)?.installed;
  if (typeof installed === "string" && installed.trim()) return known(installed.trim());
  return unknown(`${name} is not in comfy_package_versions`);
}

export function quantFromSafetensorsHeader(header: Record<string, unknown>): Fact<KitchenQuant> {
  const meta = header.__metadata__;
  const blobs: unknown[] = [header._quantization_metadata, header];
  if (meta && typeof meta === "object") blobs.unshift(meta);
  const asText = (v: unknown): string => {
    if (typeof v === "string") return v;
    try {
      return JSON.stringify(v) ?? "";
    } catch {
      return "";
    }
  };
  for (const blob of blobs) {
    const s = asText(blob).toLowerCase();
    if (!s) continue;
    if (s.includes("nvfp4")) return known("nvfp4");
    if (s.includes("mxfp8")) return known("mxfp8");
    if (s.includes("fp8_e5m2") || s.includes("e5m2")) return known("fp8_e5m2");
    if (s.includes("fp8_e4m3fn") || s.includes("e4m3") || s.includes("fp8")) return known("fp8_e4m3fn");
  }
  // A successfully-read header with no quant metadata is an unquantized file.
  return known("none");
}

/** Sibling NVFP4 file of the same stem, if one is listed. Filename only — not a guess. */
export function findNvfp4Variant(filename: string, localNames: string[]): string | undefined {
  if (!filename || localNames.length === 0) return undefined;
  const base = filename.replace(/\.(safetensors|sft|gguf)$/i, "");
  const stem = base.replace(/[-_.]?(fp8|bf16|fp16|nvfp4|mxfp8)[^/]*$/i, "");
  const hit = localNames.find((n) => {
    if (n === filename) return false;
    const lower = n.toLowerCase();
    if (!lower.includes("nvfp4")) return false;
    const nBase = n.replace(/\.(safetensors|sft|gguf)$/i, "");
    return nBase.toLowerCase().startsWith(stem.toLowerCase()) || n.toLowerCase().includes(stem.toLowerCase());
  });
  return hit;
}

export function tritonAtLeast(version: string, minMinor: number): boolean {
  const m = version.trim().match(/^(\d+)\.(\d+)/);
  if (!m) return false;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  if (major > 3) return true;
  if (major < 3) return false;
  return minor >= minMinor;
}

// ---------------------------------------------------------------------------
// Graph walking
// ---------------------------------------------------------------------------

function asRecord(v: unknown): Record<string, unknown> | undefined {
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  return undefined;
}

function namedWidgets(node: Record<string, unknown>): Record<string, unknown> {
  const captured = asRecord(node.capturedWidgetValues) ?? asRecord(node.resolvedWidgetValues);
  if (captured) return captured;
  const widgets = node.widgets;
  if (widgets && typeof widgets === "object" && !Array.isArray(widgets)) {
    return widgets as Record<string, unknown>;
  }
  if (Array.isArray(widgets)) {
    const out: Record<string, unknown> = {};
    for (const w of widgets) {
      const rec = asRecord(w);
      if (rec && typeof rec.name === "string") out[rec.name] = rec.value;
    }
    return out;
  }
  return {};
}

function isUnetLoaderType(type: string): boolean {
  return type === "UNETLoader" || /UNETLoader$/i.test(type);
}

/**
 * Loaders we can name-read. Positional widgets_values are used ONLY for the
 * stock UNETLoader (unet_name, weight_dtype) — any other packing is unknown.
 */
export function extractLoaders(
  graph: unknown,
  quantOf?: (filename: string) => Fact<KitchenQuant>,
): KitchenLoader[] {
  const out: KitchenLoader[] = [];
  const push = (
    node_id: string,
    node_type: string,
    unet_name: Fact<string>,
    weight_dtype: Fact<string>,
  ) => {
    const quant =
      isKnown(unet_name) && quantOf
        ? quantOf(unet_name.value)
        : unknown<KitchenQuant>(
            isKnown(unet_name)
              ? "model.quant was not probed (remote, or no local path)"
              : "loader filename unknown, so quant is unknown",
          );
    out.push({ node_id, node_type, unet_name, weight_dtype, quant });
  };

  if (isApiFormat(graph)) {
    for (const [id, node] of Object.entries(graph)) {
      const type = node.class_type;
      if (!isUnetLoaderType(type)) continue;
      const inputs = node.inputs ?? {};
      const name =
        typeof inputs.unet_name === "string"
          ? known(inputs.unet_name)
          : unknown<string>("UNETLoader.unet_name is not a string in this graph");
      const dtype =
        typeof inputs.weight_dtype === "string"
          ? known(inputs.weight_dtype)
          : unknown<string>("UNETLoader.weight_dtype is not a string in this graph");
      push(String(id), type, name, dtype);
    }
    return out;
  }

  if (isUiFormat(graph)) {
    for (const node of graph.nodes ?? []) {
      const type = node.type;
      if (!isUnetLoaderType(type)) continue;
      const rec = node as unknown as Record<string, unknown>;
      const named = namedWidgets(rec);
      let name: Fact<string> =
        typeof named.unet_name === "string"
          ? known(named.unet_name)
          : unknown("UNETLoader.unet_name is not a named widget on this node");
      let dtype: Fact<string> =
        typeof named.weight_dtype === "string"
          ? known(named.weight_dtype)
          : unknown("UNETLoader.weight_dtype is not a named widget on this node");
      // Stock UNETLoader widgets_values is [unet_name, weight_dtype].
      if ((!isKnown(name) || !isKnown(dtype)) && type === "UNETLoader") {
        const wv = node.widgets_values;
        if (Array.isArray(wv) && wv.length === 2 && typeof wv[0] === "string" && typeof wv[1] === "string") {
          if (!isKnown(name)) name = known(wv[0]);
          if (!isKnown(dtype)) dtype = known(wv[1]);
        }
      }
      push(String(node.id), type, name, dtype);
    }
    return out;
  }

  // graph_query detail rows, or a { nodes: [...] } live-state document.
  const rows = Array.isArray((graph as { nodes?: unknown })?.nodes)
    ? ((graph as { nodes: unknown[] }).nodes as unknown[])
    : Array.isArray(graph)
      ? (graph as unknown[])
      : [];
  for (const row of rows) {
    const rec = asRecord(row);
    if (!rec) continue;
    const type = typeof rec.type === "string" ? rec.type : typeof rec.class_type === "string" ? rec.class_type : "";
    if (!isUnetLoaderType(type)) continue;
    const id = rec.id ?? rec.node_id;
    const named = namedWidgets(rec);
    const name =
      typeof named.unet_name === "string"
        ? known(named.unet_name)
        : unknown<string>("loader filename is not on this node summary");
    const dtype =
      typeof named.weight_dtype === "string"
        ? known(named.weight_dtype)
        : unknown<string>("weight_dtype is not on this node summary");
    push(String(id), type, name, dtype);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Assess — recommendations fire only when every input is known
// ---------------------------------------------------------------------------

export function assessKitchen(
  status: KitchenStatus,
  graph: unknown,
  opts: {
    localFilenames?: string[];
    quantOf?: (filename: string) => Fact<KitchenQuant>;
  } = {},
): KitchenRecommendation[] {
  const recs: KitchenRecommendation[] = [];
  const loaders = extractLoaders(graph, opts.quantOf);

  if (isKnown(status.present) && status.present.value === true && isKnown(status.gpu.fp8) && status.gpu.fp8.value) {
    for (const loader of loaders) {
      if (!isKnown(loader.weight_dtype) || !isKnown(loader.quant)) continue;
      if (loader.weight_dtype.value !== "default") continue;
      if (loader.quant.value !== "none") continue;
      recs.push({
        id: `fp8_unet_fast:${loader.node_id}`,
        kind: "fp8_unet_fast",
        node_id: loader.node_id,
        node_type: loader.node_type,
        why: `UNETLoader ${loader.node_id} is on weight_dtype=default with an unquantized (bf16) file, this GPU has fp8 compute, and kitchen is present.`,
        safe: "Reversible widget edit. No restart. fp8_e4m3fn_fast turns on ComfyUI's fp8_optimizations.",
        restart: false,
        download: false,
        change: {
          type: "widget",
          widget: "weight_dtype",
          value: FP8_FAST,
          previous: loader.weight_dtype.value,
        },
      });
    }
  }

  const sageAbsent =
    status.flags.argvKnown &&
    !status.flags.useSageAttention &&
    isKnown(status.sageattentionInstalled) &&
    status.sageattentionInstalled.value === false;
  if (
    sageAbsent &&
    isKnown(status.present) &&
    status.present.value === true &&
    isKnown(status.gpu.int8Attention) &&
    status.gpu.int8Attention.value === true &&
    status.flags.argvKnown &&
    !status.flags.useCkAttention
  ) {
    recs.push({
      id: "ck_attention",
      kind: "ck_attention",
      why: "sageattention is not installed, --use-sage-attention is absent, kitchen is present, and INT8 attention is available on this GPU.",
      safe: "Kitchen's --use-ck-attention does not need a sageattention wheel. Restart required; consent-gated.",
      restart: true,
      download: false,
      change: { type: "flag", flag: CK_ATTENTION_FLAG },
    });
  }

  if (isKnown(status.gpu.nvfp4) && status.gpu.nvfp4.value === true && opts.localFilenames) {
    for (const loader of loaders) {
      if (!isKnown(loader.unet_name) || !isKnown(loader.quant)) continue;
      if (loader.quant.value !== "none" && loader.quant.value !== "fp8_e4m3fn" && loader.quant.value !== "fp8_e5m2")
        continue;
      const variant = findNvfp4Variant(loader.unet_name.value, opts.localFilenames);
      if (!variant) continue;
      recs.push({
        id: `nvfp4_swap:${loader.node_id}`,
        kind: "nvfp4_swap",
        node_id: loader.node_id,
        node_type: loader.node_type,
        why: `Blackwell GPU and an NVFP4 sibling of ${loader.unet_name.value} is already on disk (${variant}).`,
        safe: "Widget swap to the local NVFP4 file. Download is not required because the variant is already listed.",
        restart: false,
        download: false,
        change: {
          type: "model_swap",
          widget: "unet_name",
          value: variant,
          previous: loader.unet_name.value,
          filename: loader.unet_name.value,
          variant,
        },
      });
    }
  }

  if (
    status.host === "rocm" &&
    isKnown(status.present) &&
    status.present.value === true &&
    isKnown(status.tritonVersion) &&
    tritonAtLeast(status.tritonVersion.value, 7) &&
    status.flags.argvKnown &&
    !status.flags.enableTritonBackend &&
    !status.flags.disableTritonBackend
  ) {
    recs.push({
      id: "triton_backend",
      kind: "triton_backend",
      why: `ROCm host, kitchen present, triton ${status.tritonVersion.value} (≥ 3.7), and --enable-triton-backend is not on argv.`,
      safe: "ComfyUI flag. Restart required; consent-gated. On master this is a ComfyUI flag, not a SwarmUI-only flag.",
      restart: true,
      download: false,
      change: { type: "flag", flag: ENABLE_TRITON_FLAG },
    });
  }

  return recs;
}

/**
 * One sentence naming the gap and the tool. Empty when the conjunction is not
 * certain, or when this process has already hinted.
 */
export function kitchenProactiveHint(
  status: KitchenStatus,
  recs: KitchenRecommendation[],
): string | undefined {
  if (hintEmittedThisProcess) return undefined;
  const fire = recs.filter((r) => r.kind === "fp8_unet_fast" || r.kind === "ck_attention");
  if (fire.length === 0) return undefined;
  if (!(isKnown(status.present) && status.present.value)) return undefined;
  hintEmittedThisProcess = true;
  const names = fire.map((r) => r.kind).join(", ");
  return `Kitchen is present and ${names} is certain on this machine — call kitchen (action:"assess") or panel_kitchen to see the faster path.`;
}

export function formatKitchenEnvSnippet(status: KitchenStatus): string | undefined {
  if (!isKnown(status.present)) return undefined;
  if (!status.present.value) return "Kitchen: not installed";
  const ver = isKnown(status.version) ? status.version.value : "?";
  const loaded = KITCHEN_BACKENDS.filter((b) => {
    const s = status.backends[b].available;
    return isKnown(s) && s.value;
  });
  const backendBit = loaded.length ? ` (${loaded.join(",")})` : "";
  return `Kitchen: ${ver}${backendBit}`;
}

// ---------------------------------------------------------------------------
// Merge status from the independent sources
// ---------------------------------------------------------------------------

function emptyBackends(): Record<KitchenBackendName, KitchenBackendState> {
  const out = {} as Record<KitchenBackendName, KitchenBackendState>;
  for (const name of KITCHEN_BACKENDS) {
    out[name] = { name, available: unknown("no log line and no import-probe for this backend") };
  }
  return out;
}

export function mergeKitchenStatus(parts: {
  location: "LOCAL" | "REMOTE";
  log?: KitchenLogParse;
  flags: KitchenFlags;
  gpuName?: string;
  gpuType?: string;
  pkgVersion?: Fact<string>;
  probe?: ReturnType<typeof parseKitchenProbe>;
  flagSupport?: ReturnType<typeof parseCliArgsFlagSupport>;
  sageInstalled?: Fact<boolean>;
}): KitchenStatus {
  const log = parts.log;
  const probe = parts.probe;
  const compute = inferComputeFromGpu(parts.gpuName, parts.gpuType);

  let present: Fact<boolean> = unknown("no log version, no comfy_package_versions, no import-probe");
  if (log && isKnown(log.version)) present = known(true);
  else if (parts.pkgVersion && isKnown(parts.pkgVersion)) present = known(true);
  else if (probe && isKnown(probe.present)) present = probe.present;

  let version: Fact<string> = unknown("kitchen version not in log, packages, or probe");
  if (log && isKnown(log.version)) version = log.version;
  else if (parts.pkgVersion && isKnown(parts.pkgVersion)) version = parts.pkgVersion;
  else if (probe && isKnown(probe.version)) version = probe.version;

  const backends = emptyBackends();
  for (const name of KITCHEN_BACKENDS) {
    const fromLog = log?.backends[name];
    const fromProbe = probe?.backends[name];
    if (fromLog) backends[name] = { name, available: known(fromLog.available) };
    else if (fromProbe) backends[name] = { name, available: known(fromProbe.available) };
  }

  const ckFlag: Fact<boolean> = parts.flags.argvKnown
    ? known(parts.flags.useCkAttention)
    : unknown("argv was not reported");
  const sageFlag: Fact<boolean> = parts.flags.argvKnown
    ? known(parts.flags.useSageAttention)
    : unknown("argv was not reported");
  const ckLog = log?.ckAttentionLog ?? unknown<boolean>("log was not read");
  let ck: Fact<boolean> = unknown("need both argv --use-ck-attention and the log line");
  if (isKnown(ckFlag) && !ckFlag.value) ck = known(false);
  else if (isKnown(ckFlag) && ckFlag.value && isKnown(ckLog) && ckLog.value) ck = known(true);

  let sageInstalled = parts.sageInstalled ?? unknown<boolean>("sageattention was not probed");
  if (log && isKnown(log.sageLog) && log.sageLog.value) sageInstalled = known(true);
  else if (log && isKnown(log.sageMissingLog) && log.sageMissingLog.value) sageInstalled = known(false);

  let int8 = probe?.int8 ?? unknown<boolean>("int8_attention_is_available was not probed");
  // A server that is up with --use-ck-attention has already imported kitchen attention.
  if (parts.flags.argvKnown && parts.flags.useCkAttention) int8 = known(true);

  let flagSupport = parts.flagSupport ?? {
    ckAttention: unknown<boolean>("ComfyUI-side flag support was not probed"),
    tritonBackend: unknown<boolean>("ComfyUI-side flag support was not probed"),
  };
  if (parts.flags.argvKnown && parts.flags.useCkAttention) flagSupport = { ...flagSupport, ckAttention: known(true) };
  if (parts.flags.argvKnown && (parts.flags.enableTritonBackend || parts.flags.disableTritonBackend)) {
    flagSupport = { ...flagSupport, tritonBackend: known(true) };
  }

  let tritonVersion = log?.tritonVersion ?? unknown<string>("triton version not in log");
  if (log && isKnown(log.tritonEnabledLog) && log.tritonEnabledLog.value && !isKnown(tritonVersion)) {
    tritonVersion = unknown("triton backend enabled in log but version token missing");
  }

  return {
    location: parts.location,
    present,
    version,
    backends,
    attention: { ck, ckFlag, ckLog, sageFlag },
    gpu: {
      name: parts.gpuName,
      type: parts.gpuType,
      sm: compute.sm,
      fp8: compute.fp8,
      nvfp4: compute.nvfp4,
      mxfp8: compute.mxfp8,
      int8Attention: int8,
    },
    flags: parts.flags,
    flagSupport,
    sageattentionInstalled: sageInstalled,
    tritonVersion,
    host: compute.host,
    sources: {
      log: !!log,
      stats: parts.flags.argvKnown || !!parts.gpuName,
      probe: !!probe,
      cliArgs: !!parts.flagSupport && isKnown(parts.flagSupport.ckAttention),
    },
  };
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

export function compareProof(before: ProofSample, after: ProofSample): { ok: boolean; reason?: string } {
  if (after.outputBlack) return { ok: false, reason: "after-run output is black" };
  if (after.outputNan) return { ok: false, reason: "after-run output is NaN" };
  if (
    typeof before.secondsPerIteration === "number" &&
    typeof after.secondsPerIteration === "number" &&
    after.secondsPerIteration > before.secondsPerIteration
  ) {
    return {
      ok: false,
      reason: `after-run is slower (s/it ${before.secondsPerIteration} → ${after.secondsPerIteration})`,
    };
  }
  return { ok: true };
}

export function formatProofSummary(before: ProofSample, after: ProofSample, rec: KitchenRecommendation): string {
  const sit =
    typeof before.secondsPerIteration === "number" && typeof after.secondsPerIteration === "number"
      ? `s/it ${before.secondsPerIteration} → ${after.secondsPerIteration}`
      : "s/it unknown";
  const vram =
    typeof before.peakVramGb === "number" && typeof after.peakVramGb === "number"
      ? `peak VRAM ${before.peakVramGb} → ${after.peakVramGb} GB`
      : "peak VRAM unknown";
  const widgets = rec.change.type === "widget" || rec.change.type === "model_swap" ? 1 : 0;
  const flags = rec.change.type === "flag" ? 1 : 0;
  const color = after.outputBlack ? "output black" : after.outputNan ? "output NaN" : "output non-black";
  return `${sit}, ${vram}, ${color}, ${widgets} widget changed, ${flags} flags changed`;
}

export async function applyKitchenRecommendation(opts: {
  rec: KitchenRecommendation;
  confirm?: boolean;
  applyFlag?: (flag: string) => Promise<KitchenFlagApplyOutcome>;
  applyWidget?: (nodeId: string, widget: string, value: string) => Promise<unknown>;
  revertWidget?: (nodeId: string, widget: string, value: string) => Promise<unknown>;
  runProof?: (phase: "before" | "after") => Promise<ProofSample>;
  seed?: number;
}): Promise<KitchenApplyResult> {
  const { rec } = opts;
  if ((rec.restart || rec.download) && !opts.confirm) {
    return {
      applied: false,
      needs_confirm: true,
      recommendation: rec,
      proof: { status: "not_run" },
    };
  }

  if (rec.change.type === "flag") {
    const flag = rec.change.flag;
    if (!flag) {
      return {
        applied: false,
        recommendation: rec,
        proof: { status: "failed" },
        flag_note: "This flag recommendation is malformed: it has no launch flag.",
      };
    }
    if (opts.applyFlag) {
      try {
        const outcome = await opts.applyFlag(flag);
        return {
          applied: outcome.applied,
          recommendation: rec,
          proof: { status: "not_run" },
          flag_note: outcome.note,
          restart: outcome.restart,
        };
      } catch (err) {
        return {
          applied: false,
          recommendation: rec,
          proof: { status: "failed" },
          flag_note:
            `Could not apply ${flag}: ${err instanceof Error ? err.message : String(err)} ` +
            "The launch outcome is not confirmed; verify ComfyUI's current launch arguments before retrying.",
        };
      }
    }
    // restart_comfyui replays the previous argv; without a bound flag mutator this
    // process does not inject flags and must not claim that it did.
    return {
      applied: false,
      needs_confirm: false,
      recommendation: rec,
      proof: { status: "not_run" },
      flag_note:
        `Add ${flag} to the ComfyUI launch line, then restart_comfyui / panel_restart_comfyui. ` +
        `Those tools replay the previous argv and do not compose a new one — applying the flag here would claim a restart that did not change argv.`,
    };
  }

  const widget = rec.change.widget;
  const value = rec.change.value;
  const nodeId = rec.node_id;
  if (!widget || value === undefined || !nodeId) {
    return {
      applied: false,
      recommendation: rec,
      proof: { status: "failed" },
    };
  }
  if (!opts.applyWidget) {
    return {
      applied: false,
      recommendation: rec,
      proof: { status: "not_run" },
      flag_note: "No widget mutator is bound (use panel_kitchen apply on the live graph, or pass a workflow and apply locally).",
    };
  }

  let before: ProofSample | undefined;
  if (opts.runProof) before = await opts.runProof("before");

  const previous = await opts.applyWidget(nodeId, widget, value);

  if (!opts.runProof) {
    return {
      applied: true,
      recommendation: rec,
      previous,
      proof: { status: "not_run", summary: "change applied; proof requires a before/after run on the same seed" },
    };
  }

  const after = await opts.runProof("after");
  const verdict = before ? compareProof(before, after) : { ok: !after.outputBlack && !after.outputNan };
  if (!verdict.ok) {
    if (opts.revertWidget && rec.change.previous !== undefined) {
      await opts.revertWidget(nodeId, widget, rec.change.previous);
    }
    return {
      applied: false,
      reverted: true,
      revert_reason: verdict.reason,
      recommendation: rec,
      previous,
      proof: {
        status: "reverted",
        before,
        after,
        summary: before ? formatProofSummary(before, after, rec) : verdict.reason,
      },
    };
  }
  return {
    applied: true,
    recommendation: rec,
    previous,
    proof: {
      status: "proven",
      before,
      after,
      summary: before ? formatProofSummary(before, after, rec) : "after-run output non-black",
    },
  };
}

// ---------------------------------------------------------------------------
// Gather (I/O, injectable)
// ---------------------------------------------------------------------------

export interface GatherKitchenOptions {
  location?: "LOCAL" | "REMOTE";
  comfyuiPath?: string;
  pythonExe?: string;
  logText?: string;
  stats?: SystemStats | Record<string, unknown>;
  probeStdout?: string;
  cliArgsSource?: string;
  sageInstalled?: Fact<boolean>;
  fetchLog?: () => Promise<string>;
  fetchStats?: () => Promise<SystemStats | Record<string, unknown> | undefined>;
  runProbe?: (pythonExe: string) => Promise<string>;
  readCliArgs?: (comfyuiPath: string) => Promise<string | undefined>;
  probeTimeoutMs?: number;
}

function locationOf(): "LOCAL" | "REMOTE" {
  return isRemoteMode() ? "REMOTE" : "LOCAL";
}

async function defaultFetchLog(): Promise<string> {
  try {
    const lines = await getLogs({ maxLines: 2000 });
    return lines.join("\n");
  } catch (err) {
    logger.info("kitchen: /internal/logs unreadable", {
      error: err instanceof Error ? err.message : String(err),
    });
    // Fall back to the same endpoint env-capabilities uses, so a client-library
    // failure is not the only path.
    try {
      const res = await comfyuiFetch(`${getComfyUIBaseUrl().replace(/\/+$/, "")}/internal/logs`, {
        signal: AbortSignal.timeout(4000),
      });
      if (!res.ok) return "";
      return logTextFromPayload(await res.json());
    } catch {
      return "";
    }
  }
}

async function defaultFetchStats(): Promise<SystemStats | undefined> {
  try {
    return await getSystemStats();
  } catch (err) {
    logger.info("kitchen: /system_stats unreadable", {
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

function runKitchenProbe(pythonExe: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    let done = false;
    const child = execFile(
      pythonExe,
      ["-u", "-c", KITCHEN_PROBE_SOURCE],
      { timeout: timeoutMs, windowsHide: true },
      (_err, stdout) => {
        if (done) return;
        done = true;
        resolve((stdout || "").toString());
      },
    );
    child.on?.("error", () => {
      if (done) return;
      done = true;
      resolve("");
    });
  });
}

const SAFETENSORS_HEADER_MAX = 64 * 1024 * 1024;

async function readSafetensorsHeaderObject(filePath: string): Promise<Record<string, unknown> | undefined> {
  let fh: Awaited<ReturnType<typeof open>> | undefined;
  try {
    fh = await open(filePath, "r");
    const lenBuf = Buffer.alloc(8);
    if ((await fh.read(lenBuf, 0, 8, 0)).bytesRead < 8) return undefined;
    const headerLen = Number(lenBuf.readBigUInt64LE(0));
    if (!Number.isSafeInteger(headerLen) || headerLen <= 0 || headerLen > SAFETENSORS_HEADER_MAX) {
      return undefined;
    }
    const headerBuf = Buffer.alloc(headerLen);
    if ((await fh.read(headerBuf, 0, headerLen, 8)).bytesRead < headerLen) return undefined;
    const header = JSON.parse(headerBuf.toString("utf8")) as unknown;
    if (!header || typeof header !== "object" || Array.isArray(header)) return undefined;
    return header as Record<string, unknown>;
  } catch {
    return undefined;
  } finally {
    await fh?.close().catch(() => undefined);
  }
}

async function findLocalModelFile(filename: string, comfyuiPath: string): Promise<string | undefined> {
  const dirs = ["diffusion_models", "unet", "checkpoints", "text_encoders", "vae"];
  for (const dir of dirs) {
    const p = join(comfyuiPath, "models", dir, filename);
    try {
      const header = await readSafetensorsHeaderObject(p);
      if (header) return p;
    } catch {
      /* try next */
    }
  }
  return undefined;
}

export async function readQuantForFilename(
  filename: string,
  opts: { location?: "LOCAL" | "REMOTE"; comfyuiPath?: string } = {},
): Promise<Fact<KitchenQuant>> {
  if ((opts.location ?? locationOf()) === "REMOTE") {
    return unknown("model.quant is unknown on a remote ComfyUI (the file is not on this machine)");
  }
  const root = opts.comfyuiPath ?? config.comfyuiPath;
  if (!root) return unknown("model.quant is unknown without COMFYUI_PATH");
  const filePath = await findLocalModelFile(filename, root);
  if (!filePath) return unknown(`no local safetensors file named ${filename} under models/`);
  const header = await readSafetensorsHeaderObject(filePath);
  if (!header) return unknown(`could not read safetensors header of ${filename}`);
  return quantFromSafetensorsHeader(header);
}

export async function listLocalUnetFilenames(
  opts: { location?: "LOCAL" | "REMOTE"; comfyuiPath?: string } = {},
): Promise<string[] | undefined> {
  if ((opts.location ?? locationOf()) === "REMOTE") return undefined;
  const root = opts.comfyuiPath ?? config.comfyuiPath;
  if (!root) return undefined;
  const names: string[] = [];
  for (const dir of ["diffusion_models", "unet", "checkpoints"]) {
    try {
      const entries = await readdir(join(root, "models", dir));
      for (const e of entries) names.push(e);
    } catch {
      /* missing dir is not a no */
    }
  }
  return names;
}

export async function assessKitchenGraph(
  status: KitchenStatus,
  graph: unknown,
  opts: { location?: "LOCAL" | "REMOTE"; comfyuiPath?: string } = {},
): Promise<KitchenRecommendation[]> {
  const loaders = extractLoaders(graph);
  const quantMap = new Map<string, Fact<KitchenQuant>>();
  for (const loader of loaders) {
    if (!isKnown(loader.unet_name)) continue;
    if (!quantMap.has(loader.unet_name.value)) {
      quantMap.set(loader.unet_name.value, await readQuantForFilename(loader.unet_name.value, opts));
    }
  }
  const localFilenames = await listLocalUnetFilenames(opts);
  return assessKitchen(status, graph, {
    localFilenames,
    quantOf: (filename) => quantMap.get(filename) ?? unknown("model.quant was not probed"),
  });
}

export async function gatherKitchenStatus(opts: GatherKitchenOptions = {}): Promise<KitchenStatus> {
  const location = opts.location ?? locationOf();
  const stats = (opts.stats ?? (await (opts.fetchStats ?? defaultFetchStats)())) as
    | (SystemStats & { system?: { comfy_package_versions?: unknown; argv?: string[] } })
    | undefined;
  const logText = opts.logText ?? (await (opts.fetchLog ?? defaultFetchLog)());
  const log = logText.trim() ? parseKitchenLog(logText) : undefined;
  const argv = stats?.system?.argv;
  const flags = parseKitchenArgv(argv);
  const gpu = stats?.devices?.find((d) => (d.type ?? "").toLowerCase() !== "cpu") ?? stats?.devices?.[0];
  const pkgVersion = packageVersionFromStats(stats, "comfy-kitchen");

  let probe: ReturnType<typeof parseKitchenProbe> | undefined;
  const remote = location === "REMOTE";
  if (!remote) {
    const python =
      opts.pythonExe ??
      resolveComfyuiPython(opts.comfyuiPath ?? config.comfyuiPath, argv).python;
    const stdout =
      opts.probeStdout !== undefined
        ? opts.probeStdout
        : python
          ? await (opts.runProbe ?? ((p: string) => runKitchenProbe(p, opts.probeTimeoutMs ?? 5000)))(python)
          : "";
    if (stdout) probe = parseKitchenProbe(stdout);
  }

  let flagSupport: ReturnType<typeof parseCliArgsFlagSupport> | undefined;
  const comfyuiPath = opts.comfyuiPath ?? config.comfyuiPath;
  if (opts.cliArgsSource !== undefined) {
    flagSupport = parseCliArgsFlagSupport(opts.cliArgsSource);
  } else if (!remote && comfyuiPath) {
    const reader =
      opts.readCliArgs ??
      (async (p: string) => {
        try {
          return await readFile(join(p, "comfy", "cli_args.py"), "utf8");
        } catch {
          return undefined;
        }
      });
    flagSupport = parseCliArgsFlagSupport(await reader(comfyuiPath));
  }

  return mergeKitchenStatus({
    location,
    log,
    flags,
    gpuName: gpu?.name,
    gpuType: gpu?.type,
    pkgVersion,
    probe,
    flagSupport,
    sageInstalled: opts.sageInstalled,
  });
}
