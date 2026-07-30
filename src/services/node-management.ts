import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { config, getComfyUIBaseUrl } from "../config.js";
import { comfyuiFetch } from "../comfyui/fetch.js";
import { resetObjectInfoCache } from "../comfyui/client.js";
import { progressEnabled, reportDownloadProgress } from "./download-progress.js";
import { resolveRootInterpreter } from "./workspace-env.js";
import { assertComfyCliOk, runComfyCliSync } from "./comfy-cli.js";
import { ComfyUIError, ProcessControlError, ValidationError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";

// ---------------------------------------------------------------------------
// Custom-node management — ports `comfy-cli node install|update|reinstall|fix|
// show|uv-sync` to MCP tools.
//
// Strategy (hybrid, confirmed with maintainer):
//   1. Prefer the ComfyUI-Manager HTTP API (works against remote instances).
//      TWO API GENERATIONS exist in the wild (issue #116), auto-detected per
//      target by detectManagerApi():
//        • v4 lineage (pip `comfyui_manager` ≥4.x, the `manager-v4` branch —
//          what the RunPod image bakes): unified queue — POST one task
//          envelope to /v2/manager/queue/task, then /v2/manager/queue/start,
//          then poll /v2/manager/queue/status until the queue drains.
//        • RELEASED Manager 3.x (`main`, the registry default): same queue
//          engine under /manager/queue/* with PER-OPERATION routes
//          (install/uninstall/update/fix/disable/install_model/update_all)
//          and different body shapes — see legacyTaskRequest().
//   2. Fall back to the cm-cli.py subprocess (against config.comfyuiPath) for
//      anything the HTTP API can't do, or when the user forces it (local
//      installs only — cm-cli needs the filesystem).
//
// API contract verified against the current Comfy-Org/ComfyUI-Manager (the
// `glob` server, codegen'd from openapi.yaml). Every operation now flows through
// ONE endpoint:
//   POST /v2/manager/queue/task   body: { ui_id, client_id, kind, params }
// where `kind` is an OperationType (install | uninstall | update | fix |
// enable | disable | update-comfyui | install-model) and `params` is the
// matching Pydantic model:
//   install  → InstallPackParams { id, version, selected_version, repository?,
//                                  pip?, mode, channel, skip_post_install? }
//              (do_install only reads `id` + `selected_version` → resolve_node_spec)
//   update   → UpdatePackParams  { node_name, node_ver? }
//   fix      → FixPackParams     { node_name, node_ver }
//   uninstall→ UninstallPackParams { node_name, is_unknown? }
//   disable  → DisablePackParams { node_name, is_unknown? }
//   enable   → EnablePackParams  { cnr_id }
// Dedicated (non-task) routes still exist for: /v2/manager/queue/update_all,
// /v2/manager/queue/start, /v2/manager/queue/status, /v2/customnode/installed.
// There is NO `reinstall` kind — reinstall is modeled as uninstall + install.
//
// NOTE: modern ComfyUI-Manager ships as the pip package `comfyui_manager`
// (site-packages), NOT a custom_nodes/ checkout, so it does not provide
// cm-cli.py. The cm-cli fallback therefore only works on legacy layouts; the
// HTTP API above covers every operation and is the primary path.
// ---------------------------------------------------------------------------

/** client_id reported to ComfyUI-Manager's task queue for our requests. */
const MANAGER_CLIENT_ID = "comfyui-mcp";

export class NodeManagementError extends ComfyUIError {
  constructor(message: string, details?: unknown) {
    super(message, "NODE_MANAGEMENT_ERROR", details);
    this.name = "NodeManagementError";
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type InstallSource = "registry" | "git" | "auto";
export type ManagerMode = "remote" | "local" | "cache";

export interface InstalledNode {
  /** Custom-node module/folder name (the key Manager uses internally). */
  module: string;
  /** ComfyUI Node Registry id, if the pack is CNR-registered. */
  cnrId?: string;
  /** GitHub/aux id for git-based packs. */
  auxId?: string;
  /** Installed version (semver, commit hash, "nightly", or "unknown"). */
  version?: string;
  /** Whether the pack is currently enabled. */
  enabled: boolean;
}

export interface NodeOpResult {
  /** Which mechanism handled the request. */
  mechanism: "manager-http" | "comfy-cli" | "git-clone";
  /** Human-readable summary. */
  message: string;
  /** Raw queue status (HTTP path) or subprocess output (cm-cli path). */
  details?: unknown;
}

export interface ParsedGitUrl {
  baseUrl: string;
  ref: string | null;
}

interface QueueStatus {
  total_count: number;
  done_count: number;
  in_progress_count: number;
  /** Present on the v2 status endpoint; not required by the drain logic. */
  pending_count?: number;
  is_processing: boolean;
}

/** OperationType values accepted by /v2/manager/queue/task. */
type ManagerTaskKind =
  | "install"
  | "uninstall"
  | "update"
  | "fix"
  | "enable"
  | "disable"
  | "install-model";

// ---------------------------------------------------------------------------
// Manager HTTP helper (local to this unit — do NOT extract to a shared client)
// ---------------------------------------------------------------------------

function managerBaseUrl(): string {
  return getComfyUIBaseUrl();
}

interface ManagerFetchOptions {
  method?: "GET" | "POST";
  body?: unknown;
  /** Treat a non-2xx response as a soft failure (return undefined) instead of throwing. */
  soft?: boolean;
}

async function managerFetch<T>(
  path: string,
  options: ManagerFetchOptions = {},
): Promise<T | undefined> {
  const { method = "GET", body, soft = false } = options;
  const url = `${managerBaseUrl()}${path}`;
  logger.debug("Manager API request", { url, method });

  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";

  let res: Response;
  try {
    res = await comfyuiFetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    if (soft) return undefined;
    throw new NodeManagementError(
      `ComfyUI-Manager API unreachable at ${url}. Is ComfyUI running with ComfyUI-Manager installed? (${
        err instanceof Error ? err.message : String(err)
      })`,
    );
  }

  if (!res.ok) {
    if (soft) return undefined;
    const text = await res.text().catch(() => "");
    throw new NodeManagementError(
      `ComfyUI-Manager API ${res.status} ${res.statusText} for ${path}`,
      { url, status: res.status, body: text },
    );
  }

  // Some endpoints return empty bodies (e.g. queue ops). Parse defensively.
  const raw = await res.text();
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return raw as unknown as T;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Manager API generation detection (issue #116)
//
// The /v2/manager/* routes exist ONLY on the Manager v4 lineage (the
// `manager-v4` branch / pip package, ≥4.x — what the RunPod image bakes).
// The RELEASED ComfyUI-Manager (3.x `main`, what ComfyUI-Manager installs by
// default) serves the same queue engine under /manager/* with PER-OPERATION
// routes and different body shapes. Probe once per target and adapt.
// ---------------------------------------------------------------------------

// Three dialects in the wild (issue #116 found the second; #235 the third):
//   "v2"       pip comfyui_manager (Manager v4) in its NORMAL mode — the
//              unified POST /v2/manager/queue/task envelope.
//   "v2-batch" pip comfyui_manager started with --enable-manager-legacy-ui
//              (what e.g. the yanwk/comfyui-boot images hardcode): the pip
//              package loads its BUNDLED 3.x server under the /v2 prefix.
//              GET /v2/manager/queue/status exists, but POST .../task does NOT
//              — mutations go through POST /v2/manager/queue/batch with 3.x
//              body shapes ({install:[body], uninstall:[body], ...}). And
//              because ComfyUI's frontend catchall matches every path for GET,
//              an unregistered POST returns 405 (never 404) — the exact
//              symptom of #235.
//   "legacy"   the 3.x custom-node Manager: per-operation /manager/queue/*.
type ManagerApi = "v2" | "v2-batch" | "legacy";

let managerApiCache: { base: string; api: ManagerApi } | null = null;

/** @internal — test hook so suites can pin/clear the detected generation. */
export function resetManagerApiCacheForTests(api?: ManagerApi): void {
  managerApiCache = api ? { base: managerBaseUrl(), api } : null;
}

/** A real queue/status payload — guards detection against servers that answer
 *  200 with HTML/junk for unknown GETs (SPA fallbacks, index catchalls). */
function looksLikeQueueStatus(s: unknown): boolean {
  return (
    !!s &&
    typeof s === "object" &&
    (typeof (s as QueueStatus).total_count === "number" ||
      typeof (s as QueueStatus).is_processing === "boolean")
  );
}

async function detectManagerApi(): Promise<ManagerApi> {
  const base = managerBaseUrl();
  if (managerApiCache?.base === base) return managerApiCache.api;
  const v2 = await managerFetch<QueueStatus>("/v2/manager/queue/status", { soft: true });
  if (looksLikeQueueStatus(v2)) {
    // Same /v2 surface, two servers: the pip package in legacy-UI mode swaps
    // in its bundled 3.x server (no task route). Both register
    // GET /v2/manager/is_legacy_manager_ui and answer truthfully; a missing
    // route (older pip) means the normal v4 server → task dialect.
    const legacyUi = await managerFetch<{ is_legacy_manager_ui?: boolean }>(
      "/v2/manager/is_legacy_manager_ui",
      { soft: true },
    );
    const api: ManagerApi =
      legacyUi && typeof legacyUi === "object" && legacyUi.is_legacy_manager_ui === true
        ? "v2-batch"
        : "v2";
    managerApiCache = { base, api };
    return api;
  }
  const legacy = await managerFetch<QueueStatus>("/manager/queue/status", { soft: true });
  if (looksLikeQueueStatus(legacy)) {
    managerApiCache = { base, api: "legacy" };
    return "legacy";
  }
  throw new NodeManagementError(
    "ComfyUI-Manager's queue API is not reachable (neither /v2/manager/queue/status " +
      "nor /manager/queue/status answered with a queue status). Is ComfyUI-Manager " +
      "installed and enabled on the connected ComfyUI? The pip comfyui_manager " +
      "package only activates when ComfyUI is started with --enable-manager.",
  );
}

/** Queue route prefix for the detected generation ("v2-batch" serves
 *  status/start under the /v2 prefix too — only the mutation routes differ). */
async function managerQueuePrefix(): Promise<string> {
  return (await detectManagerApi()) === "legacy" ? "/manager/queue" : "/v2/manager/queue";
}

/** Appended to every legacy-Manager operation failure so users know they're on
 *  the partial feature set and how to get off it. */
const MANAGER_UPGRADE_HINT =
  "NOTE: this ComfyUI runs the LEGACY ComfyUI-Manager 3.x. comfyui-mcp is optimized " +
  "for Manager v4+ — on 3.x some operations degrade or are unavailable (notably " +
  "arbitrary-URL model downloads, which 3.x whitelist-gates). Recommend upgrading: " +
  "`pip install -U comfyui_manager` in the ComfyUI python env, then disable the old " +
  "custom_nodes/ComfyUI-Manager clone and restart. " +
  "See https://comfyui-mcp.artokun.io/docs/troubleshooting";

/** Appended to v2-batch (pip Manager in legacy-UI mode) failures. */
const MANAGER_LEGACY_UI_HINT =
  "NOTE: this ComfyUI runs Manager v4 (pip comfyui_manager) in LEGACY-UI mode " +
  "(--enable-manager-legacy-ui), which serves the older 3.x API — some operations " +
  "degrade (notably arbitrary-URL model downloads, which the 3.x code whitelist-gates). " +
  "For the full v4 API, start ComfyUI without --enable-manager-legacy-ui (for " +
  "yanwk/comfyui-boot images that flag is hardcoded in the entrypoint). " +
  "See https://comfyui-mcp.artokun.io/docs/troubleshooting";

/** Wrap a legacy-Manager failure with the upgrade guidance (keeps details). */
function annotateLegacyError(
  err: unknown,
  kind: ManagerTaskKind,
  hint: string = MANAGER_UPGRADE_HINT,
): NodeManagementError {
  const base = err instanceof Error ? err.message : String(err);
  const extra =
    kind === "install-model"
      ? " Arbitrary-URL model installs REQUIRE Manager v4+ (3.x only accepts whitelisted catalog models)."
      : "";
  return new NodeManagementError(
    `${base}${extra}\n${hint}`,
    err instanceof NodeManagementError ? err.details : undefined,
  );
}

/**
 * Translate one unified-task call into the legacy per-operation route + body.
 * Body shapes verified against ComfyUI-Manager 3.41 glob/manager_server.py:
 * install/uninstall/update/fix/disable key on `version` ('unknown' → treat
 * `files[0]` as a git URL / folder name), and install (unlike v4) accepts a
 * REAL git URL natively via { version:'unknown', files:[url] }.
 */
function legacyTaskRequest(
  kind: ManagerTaskKind,
  params: Record<string, unknown>,
  uiId: string,
): { path: string; body: Record<string, unknown> } {
  const nodeName = (params.node_name ?? params.id) as string | undefined;
  const version = (params.node_ver as string) || (params.selected_version as string) || "latest";
  switch (kind) {
    case "install":
      return {
        path: "/manager/queue/install",
        body: {
          ui_id: uiId,
          id: params.id,
          version: params.version ?? version,
          selected_version: params.selected_version ?? version,
          ...(params.files ? { files: params.files } : {}),
          ...(params.repository ? { repository: params.repository } : {}),
          ...(params.pip ? { pip: params.pip } : {}),
          channel: params.channel ?? "default",
          mode: params.mode ?? "cache",
          ...(params.skip_post_install !== undefined
            ? { skip_post_install: params.skip_post_install }
            : {}),
        },
      };
    case "enable":
      // Legacy has no enable route — the UI re-installs with skip_post_install.
      return {
        path: "/manager/queue/install",
        body: {
          ui_id: uiId,
          id: nodeName,
          version,
          selected_version: version,
          skip_post_install: true,
          channel: "default",
          mode: "cache",
        },
      };
    case "uninstall":
      return {
        path: "/manager/queue/uninstall",
        body: { ui_id: uiId, id: nodeName, version },
      };
    case "update":
      return {
        path: "/manager/queue/update",
        body: { ui_id: uiId, id: nodeName, version },
      };
    case "fix":
      return {
        path: "/manager/queue/fix",
        body: { ui_id: uiId, id: nodeName, version },
      };
    case "disable":
      return {
        path: "/manager/queue/disable",
        body: { ui_id: uiId, id: nodeName, version },
      };
    case "install-model":
      // Same model-item body — but 3.x validates it against the model-list
      // whitelist, so arbitrary-URL installs are rejected (v4-only feature).
      return { path: "/manager/queue/install_model", body: { ...params, ui_id: uiId } };
  }
}

/**
 * Tunable timing for queue polling. Defaults are production values; tests
 * shrink these via setQueueTimingForTests to keep the suite fast.
 */
const queueTiming = {
  pollIntervalMs: 1500,
  // The worker thread is spawned asynchronously by /manager/queue/start, so a
  // poll taken immediately afterward can read is_processing=false /
  // in_progress_count=0 while the queued item is still pending (total_count
  // counts queued items). Give the worker a grace window to spin up before
  // treating an idle-looking status as "done".
  startupGraceMs: 8000,
  timeoutMs: 600_000,
};

/** @internal — test hook to shrink polling timings; not part of the tool API. */
export function setQueueTimingForTests(
  overrides: Partial<typeof queueTiming>,
): void {
  Object.assign(queueTiming, overrides);
}

/**
 * Kick off the Manager queue worker and poll until it drains.
 * Returns the final queue status.
 */
async function runManagerQueue(): Promise<QueueStatus> {
  const prefix = await managerQueuePrefix();
  // queue/start returns 200 (worker started) or 201 (already running) — both
  // are 2xx, so managerFetch accepts either. Same on both generations.
  await managerFetch(`${prefix}/start`, { method: "POST" });

  const start = Date.now();
  let lastStatus: QueueStatus | undefined;
  while (Date.now() - start < queueTiming.timeoutMs) {
    await sleep(queueTiming.pollIntervalMs);
    const status = await managerFetch<QueueStatus>(`${prefix}/status`, {
      soft: true,
    });
    if (status) {
      lastStatus = status;
      // Manager defines total_count = done + in_progress + queued. The queue
      // is fully drained only once nothing is processing AND every item that
      // was ever queued has completed (done_count >= total_count, which also
      // implies in_progress_count === 0 and no queued items remain).
      const drained =
        !status.is_processing && status.done_count >= status.total_count;
      if (drained && Date.now() - start >= queueTiming.startupGraceMs) {
        return status;
      }
    }
  }
  throw new NodeManagementError(
    `ComfyUI-Manager queue did not finish within ${queueTiming.timeoutMs / 1000}s`,
    lastStatus,
  );
}

/**
 * Enqueue one operation on ComfyUI-Manager's unified task queue and drain it.
 * Wraps the caller's per-kind `params` in the QueueTaskItem envelope the v2
 * endpoint validates ({ ui_id, client_id, kind, params }) and returns the final
 * queue status. `ui_id` is also threaded into params (Manager's models carry an
 * optional ui_id for correlation).
 */
async function queueManagerTask(
  kind: ManagerTaskKind,
  params: Record<string, unknown>,
): Promise<QueueStatus> {
  const uiId = randomUUID();
  const api = await detectManagerApi();
  if (api === "legacy") {
    // Released Manager 3.x: per-operation routes + different body shapes
    // (issue #116 — the unified /v2 task route 405s there).
    const { path, body } = legacyTaskRequest(kind, params, uiId);
    try {
      await managerFetch(path, { method: "POST", body });
    } catch (err) {
      throw annotateLegacyError(err, kind);
    }
    return runManagerQueue();
  }
  if (api === "v2-batch") {
    // pip Manager in legacy-UI mode (issue #235): the /v2 prefix serves the
    // BUNDLED 3.x server — no task route (POST there 405s via the frontend
    // catchall). Mutations take 3.x body shapes, wrapped in the batch
    // envelope {<op>: [body, ...]}; the batch runs its items synchronously
    // and reports failures as {failed: [id, ...]}. install-model keeps its
    // dedicated route (same path as v4, 3.x whitelist semantics).
    const { path, body } = legacyTaskRequest(kind, params, uiId);
    try {
      if (kind === "install-model") {
        await managerFetch("/v2/manager/queue/install_model", { method: "POST", body });
      } else {
        // legacyTaskRequest's path is "/manager/queue/<op>"; the batch key is
        // that trailing op ("enable" maps to an install body → key "install").
        const op = path.split("/").pop() as string;
        const res = await managerFetch<{ failed?: unknown[] }>("/v2/manager/queue/batch", {
          method: "POST",
          body: { [op]: [body] },
        });
        const failed = Array.isArray(res?.failed) ? res.failed : [];
        if (failed.length && (body.id === undefined || failed.includes(body.id))) {
          throw new NodeManagementError(
            `ComfyUI-Manager batch reported the ${op} of "${String(body.id ?? "?")}" as failed ` +
              "(check the ComfyUI server log for the underlying error — security_level " +
              "gating is a common cause).",
          );
        }
      }
    } catch (err) {
      throw annotateLegacyError(err, kind, MANAGER_LEGACY_UI_HINT);
    }
    return runManagerQueue();
  }
  await managerFetch("/v2/manager/queue/task", {
    method: "POST",
    body: {
      ui_id: uiId,
      client_id: MANAGER_CLIENT_ID,
      kind,
      params: { ...params, ui_id: uiId },
    },
  });
  return runManagerQueue();
}

// ---------------------------------------------------------------------------
// Official comfy-cli subprocess helper
// ---------------------------------------------------------------------------

const COMFY_CLI_TIMEOUT = 600_000;
// A real custom-node repo clones well under this; with prompts disabled a
// missing/private repo fails in ~1s rather than blocking the whole timeout.
const GIT_CLONE_TIMEOUT = 180_000;

/** Env for git network ops that must NEVER block on an interactive credential
 *  prompt. Without this, `git clone`/`fetch` of a missing or private repo waits
 *  on a stdin username/password prompt and hangs until the timeout (observed as a
 *  multi-minute "thinking" stall on a bad URL). GIT_ASKPASS=echo + the prompt
 *  flags make git fail fast instead. GITHUB_TOKEN is passed through when set. */
export function nonInteractiveGitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "echo",
    GCM_INTERACTIVE: "never",
    ...(config.githubToken ? { GITHUB_TOKEN: config.githubToken } : {}),
  };
}

/**
 * Run an official `comfy node` subcommand. Returns normalized JSON data.
 * Throws ProcessControlError if comfyuiPath is undefined (remote mode).
 */
function runCmCli(args: string[]): string {
  if (!config.comfyuiPath) {
    throw new ProcessControlError(
      "This operation requires a local ComfyUI install. Set COMFYUI_PATH or use the Manager HTTP API.",
    );
  }
  logger.info("Running comfy-cli", { args: ["node", ...args].join(" ") });
  try {
    const envelope = assertComfyCliOk(
      runComfyCliSync(["node", ...args], {
        workspace: config.comfyuiPath,
        timeoutMs: COMFY_CLI_TIMEOUT,
        env: config.githubToken ? { GITHUB_TOKEN: config.githubToken } : undefined,
      }),
    );
    return JSON.stringify(envelope.data ?? {}, null, 2);
  } catch (error) {
    const processError = error as NodeJS.ErrnoException & { stdout?: Buffer | string; stderr?: Buffer | string };
    if (processError.code === "ENOENT") {
      throw new ProcessControlError(
        "The comfy-cli executable could not be started. Check COMFY_CLI_PATH and PATH.",
      );
    }
    throw new NodeManagementError(`comfy-cli node ${args[0]} failed: ${processError.message}`, {
      stdout: processError.stdout?.toString() ?? "",
      stderr: processError.stderr?.toString() ?? "",
    });
  }
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

/**
 * Normalize the /customnode/installed response into InstalledNode[].
 * Manager returns an object keyed by module name (see manager_core
 * get_installed_node_packs), each value carrying { ver, cnr_id, aux_id, enabled }.
 * Older/variant builds may return an array; handle both.
 */
function parseInstalled(raw: unknown): InstalledNode[] {
  if (!raw || typeof raw !== "object") return [];

  const toNode = (module: string, v: Record<string, unknown>): InstalledNode => ({
    module,
    cnrId:
      typeof v.cnr_id === "string" && v.cnr_id.length > 0 ? v.cnr_id : undefined,
    auxId:
      typeof v.aux_id === "string" && v.aux_id.length > 0 ? v.aux_id : undefined,
    version: typeof v.ver === "string" ? v.ver : undefined,
    // `enabled` may be absent on some builds; treat missing as enabled,
    // but honor an explicit is_disabled flag if present.
    enabled:
      typeof v.enabled === "boolean"
        ? v.enabled
        : v.is_disabled === true
          ? false
          : true,
  });

  if (Array.isArray(raw)) {
    return raw
      .filter((entry): entry is Record<string, unknown> =>
        Boolean(entry && typeof entry === "object"),
      )
      .map((entry) => {
        const module =
          (typeof entry.title === "string" && entry.title) ||
          (typeof entry.module === "string" && entry.module) ||
          (typeof entry.cnr_id === "string" && entry.cnr_id) ||
          "unknown";
        return toNode(module, entry);
      });
  }

  return Object.entries(raw as Record<string, unknown>)
    .filter(([, v]) => Boolean(v && typeof v === "object"))
    .map(([module, v]) => toNode(module, v as Record<string, unknown>));
}

function stripUrlSuffix(value: string): string {
  return value.replace(/[?#].*$/, "").replace(/\/+$/, "");
}

function validateGitRef(ref: string): string {
  if (ref.length === 0) {
    throw new ValidationError("Git ref must be a non-empty string.");
  }
  if (ref.startsWith("-")) {
    throw new ValidationError("Git ref cannot start with '-'.");
  }
  if (/[\x00-\x1F\x7F]/.test(ref)) {
    throw new ValidationError("Git ref cannot contain ASCII control characters.");
  }
  if (/\s/.test(ref)) {
    throw new ValidationError("Git ref cannot contain whitespace.");
  }
  if (/[~^:?*[\\]/.test(ref)) {
    throw new ValidationError(
      "Git ref contains characters that are not valid in git refs.",
    );
  }
  if (
    ref.startsWith("/") ||
    ref.endsWith("/") ||
    ref.includes("//") ||
    ref.includes("..") ||
    ref.includes("@{") ||
    ref === "@" ||
    ref.endsWith(".") ||
    ref.endsWith(".lock")
  ) {
    throw new ValidationError("Git ref is not a valid git ref name.");
  }
  return ref;
}

function stripGitUrlRef(
  value: string,
  patterns: Array<{ re: RegExp; rejectSlashRef?: boolean }>,
): ParsedGitUrl | undefined {
  const normalized = stripUrlSuffix(value);
  for (const pattern of patterns) {
    const match = normalized.match(pattern.re);
    if (match) {
      const ref = decodeURIComponent(match[2]);
      if (pattern.rejectSlashRef && ref.includes("/")) {
        throw new ValidationError(
          "Ambiguous git tree URL contains a path after the ref. Pass the repository URL and explicit `ref` instead.",
        );
      }
      return { baseUrl: match[1], ref: validateGitRef(ref) };
    }
  }
  return undefined;
}

export function parseGitUrl(url: string): ParsedGitUrl {
  const input = url.trim();
  const withoutSuffix = stripUrlSuffix(input);

  // npm/pip style: repo@ref or repo.git@ref. Avoid treating the user part of
  // scp-like SSH URLs (git@github.com:owner/repo.git) as a ref.
  const atRef = withoutSuffix.match(/^(.+)@([^@/]+)$/);
  if (atRef && (!/^[^@]+@[^/:]+:/.test(withoutSuffix) || atRef[1].includes("@"))) {
    return { baseUrl: atRef[1], ref: validateGitRef(decodeURIComponent(atRef[2])) };
  }

  const matched = stripGitUrlRef(withoutSuffix, [
    { re: /^(.+?)\/-\/tree\/(.+)$/, rejectSlashRef: true },
    { re: /^(.+?)\/-\/commit\/(.+)$/ },
    { re: /^(.+?)\/tree\/(.+)$/, rejectSlashRef: true },
    { re: /^(.+?)\/commit\/(.+)$/ },
    { re: /^(.+?)\/releases\/tag\/(.+)$/ },
    { re: /^(.+?)\/src\/([^/]+)(?:\/.*)?$/ },
    { re: /^(.+?)\/commits\/(.+)$/ },
  ]);
  if (matched) return matched;

  return { baseUrl: input, ref: null };
}

function looksLikeGitUrl(id: string): boolean {
  return /^(https?:\/\/|git@|git\+)/i.test(id) || id.endsWith(".git");
}

function gitCheckoutDir(baseUrl: string): string {
  const pathPart = baseUrl.includes(":") && !baseUrl.includes("://")
    ? baseUrl.slice(baseUrl.lastIndexOf(":") + 1)
    : baseUrl;
  const clean = stripUrlSuffix(pathPart);
  return basename(clean).replace(/\.git$/i, "");
}

function runGitCheckout(baseUrl: string, ref: string, basePath?: string): void {
  // basePath is the CALL-SCOPED local ComfyUI root (apply_manifest threads an
  // adopted saved-default/live root WITHOUT mutating global config); fall back to
  // config.comfyuiPath. Either may be unset in remote mode → clear error.
  const comfyuiBase = basePath ?? config.comfyuiPath;
  if (!comfyuiBase) {
    throw new ProcessControlError(
      "Checking out a custom-node git ref requires a local ComfyUI install, " +
        "but no ComfyUI path is set.",
    );
  }

  // SECURITY: this is also reached by the forced-cm-cli git path, NOT just the
  // clone fallback, so validate here too before baseUrl / the derived dir reach
  // git or the filesystem (option injection + path traversal). Mirrors
  // cloneCustomNodeFallback's checks.
  assertSafeGitUrl(baseUrl);
  const repoName = gitCheckoutDir(baseUrl);
  assertSafeRepoName(repoName);
  const customNodesRoot = resolve(comfyuiBase, "custom_nodes");
  const nodeDir = resolve(customNodesRoot, repoName);
  const rel = relative(customNodesRoot, nodeDir);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new ValidationError(
      `Refusing to check out: resolved path "${nodeDir}" escapes ${customNodesRoot}.`,
    );
  }
  logger.info("Checking out custom-node git ref", {
    repository: baseUrl,
    ref,
    nodeDir,
  });

  try {
    execFileSync("git", ["-C", nodeDir, "fetch", "--all", "--tags"], {
      cwd: comfyuiBase,
      encoding: "utf-8",
      timeout: GIT_CLONE_TIMEOUT,
      env: nonInteractiveGitEnv(),
    });
    execFileSync("git", ["-C", nodeDir, "checkout", "--detach", "--end-of-options", ref], {
      cwd: comfyuiBase,
      encoding: "utf-8",
      timeout: GIT_CLONE_TIMEOUT,
      env: nonInteractiveGitEnv(),
    });
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stdout?: Buffer | string; stderr?: Buffer | string };
    throw new NodeManagementError(
      `Failed to check out git ref "${ref}" for custom node "${baseUrl}": ${e.message}`,
      {
        stdout: e.stdout ? e.stdout.toString() : "",
        stderr: e.stderr ? e.stderr.toString() : "",
      },
    );
  }
}

/**
 * Does an installed node match the wanted id/url? Mirrors manifest.ts's private
 * nodeAlreadyInstalled, but kept local to this unit. Normalizes (lowercase) and
 * matches an installed node's module/cnrId/auxId (and the basename of each — aux
 * ids are typically "owner/repo") against the wanted value and, when the wanted
 * value is a git URL, its derived repo name. This is how we VERIFY a Manager
 * install actually landed on disk (Manager marks the queue "done" even when it
 * resolved nothing).
 */
function nodeInstalledMatches(
  idOrUrl: string,
  installed: InstalledNode[],
): boolean {
  const wanted = idOrUrl.trim().toLowerCase();
  const repoName = looksLikeGitUrl(idOrUrl)
    ? gitCheckoutDir(parseGitUrl(idOrUrl).baseUrl).toLowerCase()
    : wanted;
  return installed.some((node) => {
    const candidates: string[] = [];
    for (const v of [node.module, node.cnrId, node.auxId]) {
      if (!v) continue;
      const norm = v.trim().toLowerCase();
      candidates.push(norm);
      candidates.push(basename(norm));
    }
    return candidates.includes(wanted) || candidates.includes(repoName);
  });
}

/**
 * Resolve the ComfyUI venv python for installing a cloned node's deps. Prefers
 * the install's own `.venv` (Windows Scripts/ or POSIX bin/), falling back to a
 * bare "python" on PATH. `basePath` is the CALL-SCOPED install root (apply_manifest
 * threads an adopted saved-default/live root without mutating global config); when
 * omitted it falls back to config.comfyuiPath. Passing it matters: otherwise a
 * cloned node's requirements.txt / install.py would run under a BARE system python
 * for an adopted workspace, corrupting/ missing the real ComfyUI environment while
 * the node is still reported installed (#463 codex review).
 */
function resolveVenvPython(basePath?: string): string {
  // Honors .venv/venv AND portable Windows layouts (python_embeded/standalone-env)
  // via the shared resolver, so a cloned node's deps target the install's OWN
  // interpreter rather than a bare system python (#463 codex review).
  return resolveRootInterpreter(basePath ?? config.comfyuiPath);
}

/**
 * Validate a git URL before it is handed to `git clone` as an argument.
 * Rejects an arg-injection vector (a URL parsed as a git option) and anything
 * that isn't a recognized git URL shape.
 */
function assertSafeGitUrl(gitId: string): void {
  if (gitId.startsWith("-")) {
    throw new ValidationError(
      `Refusing to clone git URL "${gitId}": it starts with '-' and would be ` +
        `interpreted as a git option.`,
    );
  }
  if (/[\x00-\x1F\x7F]/.test(gitId)) {
    throw new ValidationError("Git URL cannot contain ASCII control characters.");
  }
  if (!looksLikeGitUrl(gitId)) {
    throw new ValidationError(
      `Refusing to clone "${gitId}": not a recognized git URL (expected ` +
        `https://, ssh://, git@…, git+…, or a .git URL).`,
    );
  }
}

/**
 * Validate the repo name derived from a git URL before it is used as a
 * filesystem path segment under custom_nodes. Rejects empty, '.'/'..', names
 * starting with '-', and names containing path separators or control chars —
 * any of which could escape custom_nodes or be parsed as a git option.
 */
export function assertSafeRepoName(repoName: string): void {
  if (
    repoName.length === 0 ||
    repoName === "." ||
    repoName === ".." ||
    repoName.startsWith("-") ||
    /[/\\]/.test(repoName) ||
    /[\x00-\x1F\x7F]/.test(repoName)
  ) {
    throw new ValidationError(
      `Refusing to use "${repoName}" as a custom_nodes directory name (empty, ` +
        `'.'/'..', starts with '-', or contains a path separator/control char).`,
    );
  }
}

/**
 * Direct-clone fallback for an unregistered git repo the Manager can't resolve.
 * Clones into custom_nodes/<repoName>, checks out a ref if given, then makes a
 * best-effort attempt at installing python deps (requirements.txt + install.py).
 * Dep failures DON'T fail the install (clone succeeded) — they're surfaced as
 * warnings. A clone failure throws NodeManagementError.
 */
function cloneCustomNodeFallback(
  gitId: string,
  repoName: string,
  gitRef: string | undefined,
  managerStatus: unknown,
  basePath?: string,
): NodeOpResult {
  // basePath is the CALL-SCOPED local ComfyUI root (apply_manifest threads an
  // adopted saved-default/live root here WITHOUT mutating global config, so a
  // panel-connected local session with no COMFYUI_PATH can still clone an
  // unregistered git pack); fall back to config.comfyuiPath.
  const comfyuiBase = basePath ?? config.comfyuiPath;
  if (!comfyuiBase) {
    throw new ProcessControlError(
      `"${repoName}" is not in the ComfyUI-Manager registry and cloning it ` +
        `requires a local ComfyUI install, but no ComfyUI path is set ` +
        `(running in remote --comfyui-url mode). Install it on the ComfyUI host, ` +
        `or pass a registered pack id.`,
    );
  }

  // SECURITY: validate before either value becomes a `git clone` arg or a path
  // segment. gitId is checked for option-injection; repoName for path traversal.
  assertSafeGitUrl(gitId);
  assertSafeRepoName(repoName);

  // Resolve the target and ASSERT it stays inside <comfyuiBase>/custom_nodes,
  // mirroring manifest.ts's isWithinRoot containment check (defense in depth on
  // top of the repoName validation above).
  const customNodesRoot = resolve(comfyuiBase, "custom_nodes");
  const nodeDir = resolve(customNodesRoot, repoName);
  const rel = relative(customNodesRoot, nodeDir);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new ValidationError(
      `Refusing to clone: resolved path "${nodeDir}" escapes ${customNodesRoot}.`,
    );
  }

  const warnings: string[] = [];
  const alreadyPresent = existsSync(nodeDir);

  if (!alreadyPresent) {
    // A concrete ref needs the full history reachable; otherwise shallow-clone.
    // `--end-of-options` ensures gitId/nodeDir are never parsed as git options.
    const cloneArgs = gitRef
      ? ["clone", "--end-of-options", gitId, nodeDir]
      : ["clone", "--depth", "1", "--end-of-options", gitId, nodeDir];
    logger.info("Cloning unregistered custom node", { gitId, nodeDir, gitRef });
    try {
      execFileSync("git", cloneArgs, {
        cwd: comfyuiBase,
        encoding: "utf-8",
        timeout: GIT_CLONE_TIMEOUT,
        env: nonInteractiveGitEnv(),
      });
    } catch (err) {
      const e = err as NodeJS.ErrnoException & {
        stdout?: Buffer | string;
        stderr?: Buffer | string;
      };
      throw new NodeManagementError(
        `Failed to clone "${gitId}" into custom_nodes/${repoName}: ${e.message}`,
        {
          stdout: e.stdout ? e.stdout.toString() : "",
          stderr: e.stderr ? e.stderr.toString() : "",
        },
      );
    }
    if (gitRef) runGitCheckout(gitId, gitRef, comfyuiBase);
  }

  // VERIFY the clone landed before attempting deps.
  if (!existsSync(nodeDir)) {
    throw new NodeManagementError(
      `Clone of "${gitId}" reported success but ${nodeDir} is missing.`,
    );
  }

  // Best-effort python deps. Don't fail the install if these don't.
  const requirements = join(nodeDir, "requirements.txt");
  const installScript = join(nodeDir, "install.py");
  if (existsSync(requirements) || existsSync(installScript)) {
    const python = resolveVenvPython(comfyuiBase);
    if (existsSync(requirements)) {
      try {
        execFileSync(python, ["-m", "pip", "install", "-r", requirements], {
          cwd: nodeDir,
          encoding: "utf-8",
          timeout: COMFY_CLI_TIMEOUT,
        });
      } catch (err) {
        const e = err as Error;
        warnings.push(
          `Python dependencies (requirements.txt) failed to install (${e.message}); install them manually with "${python} -m pip install -r requirements.txt".`,
        );
      }
    }
    if (existsSync(installScript)) {
      try {
        execFileSync(python, [installScript], {
          cwd: nodeDir,
          encoding: "utf-8",
          timeout: COMFY_CLI_TIMEOUT,
        });
      } catch (err) {
        const e = err as Error;
        warnings.push(
          `install.py failed to run (${e.message}); the node may need manual setup.`,
        );
      }
    }
  }

  const base = alreadyPresent
    ? `"${repoName}" already exists in custom_nodes (${repoName}) — left it in place.`
    : `"${repoName}" is not in the ComfyUI-Manager registry — cloned it directly into custom_nodes (${repoName}).`;
  const warn = warnings.length ? ` ${warnings.join(" ")}` : "";
  return {
    mechanism: "git-clone",
    message: `${base}${warn} RESTART ComfyUI to load it.`,
    details: { nodeDir, warnings, managerStatus },
  };
}

// ---------------------------------------------------------------------------
// Public API — install
// ---------------------------------------------------------------------------

export interface InstallOptions {
  id: string;
  source?: InstallSource;
  version?: string;
  /** Git ref (commit, branch, or tag) to check out for git URL installs. */
  ref?: string;
  mode?: ManagerMode;
  channel?: string;
  /** Force the official comfy-cli subprocess instead of the HTTP API. */
  useCmCli?: boolean;
  /** CALL-SCOPED local ComfyUI root for the git-clone / ref-checkout fallback,
   *  threaded by callers (e.g. apply_manifest) that resolve an adopted
   *  saved-default/live root WITHOUT mutating global config.comfyuiPath. Falls
   *  back to config.comfyuiPath when omitted. */
  comfyuiPath?: string;
}

/**
 * Installing/updating/reinstalling/repairing a pack changes which node classes
 * this ComfyUI can register, so the orchestrator's memoized /object_info snapshot
 * (getObjectInfo) is now stale — validate_workflow / diagnose_run / get_node_info
 * would keep reporting the just-installed types as `missing_node_type` in their
 * top-level summaries until some later reboot bumped the epoch (#444, the residual
 * of the #235/#247/#352/#364 staleness cluster). Drop the cache the moment a
 * mutation succeeds so the next read refetches the live registry. Applied via a
 * single choke point (rather than at every early return) so every install branch —
 * cm-cli, Manager HTTP, and the git clone fallback — is covered.
 */
async function withObjectInfoInvalidation<T>(op: () => Promise<T>): Promise<T> {
  const result = await op();
  resetObjectInfoCache();
  return result;
}

export function installCustomNode(opts: InstallOptions): Promise<NodeOpResult> {
  return withObjectInfoInvalidation(() => installCustomNodeImpl(opts));
}

async function installCustomNodeImpl(
  opts: InstallOptions,
): Promise<NodeOpResult> {
  const { id, version, mode = "remote", channel = "default" } = opts;
  const basePath = opts.comfyuiPath ?? config.comfyuiPath;
  const parsedGit = parseGitUrl(id);
  const gitId = parsedGit.baseUrl;
  const gitRefCandidate = opts.ref ?? parsedGit.ref ?? version;
  const source =
    opts.source && opts.source !== "auto"
      ? opts.source
      : looksLikeGitUrl(gitId)
        ? "git"
        : "registry";
  const gitRef =
    source === "git" && gitRefCandidate
      ? validateGitRef(gitRefCandidate)
      : gitRefCandidate;

  // SECURITY: validate a git URL ONCE, up front, before it can reach ANY install
  // path — cm-cli (`cm-cli install <url>`), the Manager queue, or the clone
  // fallback. Rejects option-injection (leading "-") / non-git / control chars.
  // The repo-name + custom_nodes-containment checks live where the on-disk dir is
  // actually used (runGitCheckout, cloneCustomNodeFallback).
  if (source === "git") assertSafeGitUrl(gitId);

  if (opts.useCmCli) {
    // cm-cli install accepts registry ids and git urls alike.
    const installId = source === "git" ? gitId : id;
    const out = runCmCli(["install", installId, "--mode", mode, "--channel", channel]);
    if (source === "git" && gitRef) {
      runGitCheckout(gitId, gitRef, basePath);
    }
    return {
      mechanism: "comfy-cli",
      message: `Installed "${id}" via official comfy-cli.`,
      details: out.trim(),
    };
  }

  if (source === "git") {
    const repoName = gitCheckoutDir(gitId);
    let status: QueueStatus;
    if ((await detectManagerApi()) !== "v2") {
      // 3.x SEMANTICS (both the custom-node Manager AND pip Manager in
      // legacy-UI mode, whose /v2 batch runs the same 3.x handlers — codex
      // review on #235): a REAL git URL installs natively via
      // { version:'unknown', files:[url] }, cloning it as an unregistered
      // pack. (Gated server-side by security_level + allow_git_url_install
      // config — a rejection surfaces as a 403/404 from the queue route.)
      status = await queueManagerTask("install", {
        id: repoName,
        version: "unknown",
        selected_version: "unknown",
        files: [gitId],
        channel: opts.channel ?? "default",
        mode: opts.mode ?? "cache",
      });
    } else {
      // Manager v4: REGISTRY-FIRST, CLONE FALLBACK. The v4 backend resolves an
      // install by the pack's REPO NAME / CNR id — NOT a full git URL
      // (do_install splits `${id}@${selected_version}` and looks the result up
      // in its DB; a full URL matches nothing and the queue silently marks the
      // task "done"). So we mirror the frontend UI: id = repo name,
      // selected_version = ref or "nightly" (the git-HEAD channel for unclaimed
      // packs), channel "dev", mode "cache".
      const selected = gitRef ?? "nightly";
      status = await queueManagerTask("install", {
        id: repoName,
        version: selected,
        selected_version: selected,
        channel: opts.channel ?? "dev",
        mode: opts.mode ?? "cache",
      });
    }

    // VERIFY: /v2/customnode/installed reflects on-disk custom_nodes, so a
    // freshly-cloned pack shows up even before a reboot. If the Manager actually
    // installed it, we're done; otherwise it's unregistered → clone it directly.
    const installed = await listInstalledNodes().catch(
      () => [] as InstalledNode[],
    );
    if (nodeInstalledMatches(gitId, installed)) {
      return {
        mechanism: "manager-http",
        message: `Installed "${repoName}" via ComfyUI-Manager. Restart may be required to load new nodes.`,
        details: status,
      };
    }
    return cloneCustomNodeFallback(gitId, repoName, gitRef, status, basePath);
  }

  // Registry (plain CNR id). Keep the prior defaults channel "default" /
  // mode "remote" (overridable via opts) — forcing "dev"/"cache" risks resolving
  // a different build or failing for default-only packs. The UI-style
  // "dev"/"cache" is used ONLY for the git registry-first lookup above. Then
  // VERIFY the pack actually landed — a non-URL id can't be cloned, so an absent
  // pack is a hard error rather than a silent no-op.
  const status = await queueManagerTask("install", {
    id,
    version: version ?? "latest",
    selected_version: version ?? "latest",
    channel,
    mode,
  });
  const installed = await listInstalledNodes().catch(
    () => [] as InstalledNode[],
  );
  if (!nodeInstalledMatches(id, installed)) {
    throw new NodeManagementError(
      `"${id}" was queued but is not present afterward — it was not found in the ` +
        `ComfyUI-Manager registry. Check the pack id, or pass a git URL to clone ` +
        `it directly.`,
      status,
    );
  }
  return {
    mechanism: "manager-http",
    message: `Installed "${id}" via ComfyUI-Manager. Restart may be required to load new nodes.`,
    details: status,
  };
}

// ---------------------------------------------------------------------------
// update
// ---------------------------------------------------------------------------

export interface UpdateOptions {
  /** Registry id / module name, or "all" to update every installed pack. */
  id: string;
  mode?: ManagerMode;
  channel?: string;
  useCmCli?: boolean;
}

/** Does this update target refer to ComfyUI-Manager itself (any spelling)? */
function isManagerSelfTarget(id: string): boolean {
  const norm = basename(id.trim().toLowerCase()).replace(/[_\s]+/g, "-");
  return norm === "comfyui-manager" || norm === "comfy-manager";
}

/**
 * Directly git-pull the local custom_nodes/ComfyUI-Manager checkout as a
 * fallback for the one op the legacy 3.x queue can't do — update the running
 * Manager itself (#424). Returns undefined when there is no local install or no
 * on-disk Manager checkout (e.g. pip comfyui_manager, which has no custom_nodes
 * clone), so the caller can surface an actionable error. A NodeManagementError
 * from the git pull itself propagates.
 */
function updateManagerSelfLocally(): NodeOpResult | undefined {
  if (!config.comfyuiPath) return undefined;
  const customNodesRoot = resolve(config.comfyuiPath, "custom_nodes");
  const dir = ["ComfyUI-Manager", "comfyui-manager", "comfyui_manager"]
    .map((d) => join(customNodesRoot, d))
    .find((p) => existsSync(join(p, ".git")));
  if (!dir) return undefined;
  try {
    const out = execFileSync("git", ["-C", dir, "pull", "--ff-only"], {
      cwd: config.comfyuiPath,
      encoding: "utf-8",
      timeout: GIT_CLONE_TIMEOUT,
      env: nonInteractiveGitEnv(),
    });
    return {
      mechanism: "git-clone",
      message:
        `Updated ComfyUI-Manager itself via a direct git pull of ${dir} ` +
        `(the legacy 3.x queue can't self-update the running Manager). ` +
        `RESTART ComfyUI to load the new Manager.`,
      details: out.trim(),
    };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stdout?: Buffer | string; stderr?: Buffer | string };
    throw new NodeManagementError(
      `git pull of the local ComfyUI-Manager checkout (${dir}) failed: ${e.message}. ` +
        `Update it manually (git pull, or pip install -U comfyui_manager) then restart ComfyUI.`,
      { stdout: e.stdout?.toString() ?? "", stderr: e.stderr?.toString() ?? "" },
    );
  }
}

export function updateCustomNode(opts: UpdateOptions): Promise<NodeOpResult> {
  return withObjectInfoInvalidation(() => updateCustomNodeImpl(opts));
}

async function updateCustomNodeImpl(
  opts: UpdateOptions,
): Promise<NodeOpResult> {
  const { id, mode = "remote", channel = "default" } = opts;
  const all = id.trim().toLowerCase() === "all";

  if (opts.useCmCli) {
    const out = runCmCli(["update", id, "--mode", mode, "--channel", channel]);
    return {
      mechanism: "comfy-cli",
      message: all
        ? "Updated all installed node packs via official comfy-cli."
        : `Updated "${id}" via official comfy-cli.`,
      details: out.trim(),
    };
  }

  // Updating ComfyUI-Manager ITSELF through its own task queue is the one op the
  // queue can't reliably perform: legacy Manager 3.x 405s the update route for
  // the running Manager pack, so the in-panel 3.x→v4 upgrade path deadlocks
  // (#424). When the target IS the Manager pack and we have a LOCAL install, do
  // a direct `git pull` of the custom_nodes/ComfyUI-Manager checkout instead —
  // the only in-repo way to actually advance it (a restart then loads the new
  // code). Remote targets can't be git-controlled → clear, actionable error.
  if (!all && isManagerSelfTarget(id) && (await detectManagerApi()) === "legacy") {
    const local = updateManagerSelfLocally();
    if (local) return local;
    throw new NodeManagementError(
      `Updating ComfyUI-Manager itself is not supported over the LEGACY Manager 3.x queue ` +
        `API (it 405s the self-update route — #424), and no LOCAL custom_nodes/ComfyUI-Manager ` +
        `checkout was found to git-pull directly. Update ComfyUI-Manager on the host ` +
        `(git pull in custom_nodes/ComfyUI-Manager, or pip install -U comfyui_manager), then ` +
        `restart ComfyUI.`,
    );
  }

  let status: QueueStatus;
  if (all) {
    // update_all keeps its own dedicated route. The backend reads
    // UpdateAllQueryParams from the QUERY STRING (manager_server.py), NOT the
    // JSON body — a body-only request leaves mode defaulting to 'remote' and
    // drops client_id/ui_id. Send them as URL query params.
    const uiId = randomUUID();
    if ((await detectManagerApi()) === "legacy") {
      // 3.x reads {mode} from the JSON BODY (and ignores client_id/ui_id).
      await managerFetch("/manager/queue/update_all", {
        method: "POST",
        body: { mode, ui_id: uiId },
      });
    } else {
      const query = new URLSearchParams({
        mode,
        client_id: MANAGER_CLIENT_ID,
        ui_id: uiId,
      }).toString();
      await managerFetch(`/v2/manager/queue/update_all?${query}`, {
        method: "POST",
      });
    }
    status = await runManagerQueue();
  } else {
    // Single-pack update → unified task; UpdatePackParams uses node_name/node_ver.
    status = await queueManagerTask("update", { node_name: id });
  }
  return {
    mechanism: "manager-http",
    message: all
      ? "Queued + updated all installed node packs via ComfyUI-Manager."
      : `Queued + updated "${id}" via ComfyUI-Manager.`,
    details: status,
  };
}

// ---------------------------------------------------------------------------
// reinstall
// ---------------------------------------------------------------------------

export interface ReinstallOptions {
  id: string;
  version?: string;
  mode?: ManagerMode;
  channel?: string;
  useCmCli?: boolean;
}

export function reinstallCustomNode(opts: ReinstallOptions): Promise<NodeOpResult> {
  return withObjectInfoInvalidation(() => reinstallCustomNodeImpl(opts));
}

async function reinstallCustomNodeImpl(
  opts: ReinstallOptions,
): Promise<NodeOpResult> {
  const { id, version, mode = "remote", channel = "default" } = opts;

  if (opts.useCmCli) {
    const out = runCmCli(["reinstall", id, "--mode", mode, "--channel", channel]);
    return {
      mechanism: "comfy-cli",
      message: `Reinstalled "${id}" via official comfy-cli.`,
      details: out.trim(),
    };
  }

  // The unified queue has no `reinstall` kind, so model it as uninstall + a
  // fresh install of the same target. Each is its own drained queue cycle.
  await queueManagerTask("uninstall", { node_name: id });
  const status = await queueManagerTask("install", {
    id,
    version: version ?? "latest",
    selected_version: version ?? "latest",
    channel,
    mode,
  });
  return {
    mechanism: "manager-http",
    message: `Queued + reinstalled "${id}" (uninstall + install) via ComfyUI-Manager. A restart may be required.`,
    details: status,
  };
}

// ---------------------------------------------------------------------------
// fix
// ---------------------------------------------------------------------------

export interface FixOptions {
  /** Registry id / module name, or "all". */
  id: string;
  mode?: ManagerMode;
  channel?: string;
  useCmCli?: boolean;
}

export function fixCustomNode(opts: FixOptions): Promise<NodeOpResult> {
  return withObjectInfoInvalidation(() => fixCustomNodeImpl(opts));
}

async function fixCustomNodeImpl(opts: FixOptions): Promise<NodeOpResult> {
  const { id, mode = "remote", channel = "default" } = opts;
  const all = id.trim().toLowerCase() === "all";

  // The HTTP API has no "fix all"; cm-cli supports it. Route accordingly.
  if (opts.useCmCli || all) {
    const out = runCmCli(["fix", id, "--mode", mode, "--channel", channel]);
    return {
      mechanism: "comfy-cli",
      message: all
        ? "Repaired all installed node packs via official comfy-cli."
        : `Repaired "${id}" via official comfy-cli.`,
      details: out.trim(),
    };
  }

  // FixPackParams requires node_ver; "" lets Manager resolve the installed
  // version (do_fix looks the pack up by name).
  const status = await queueManagerTask("fix", { node_name: id, node_ver: "" });
  return {
    mechanism: "manager-http",
    message: `Queued + repaired "${id}" via ComfyUI-Manager.`,
    details: status,
  };
}

// ---------------------------------------------------------------------------
// list installed
// ---------------------------------------------------------------------------

export interface ListInstalledOptions {
  mode?: "default" | "imported";
  useCmCli?: boolean;
}

export async function listInstalledNodes(
  opts: ListInstalledOptions = {},
): Promise<InstalledNode[]> {
  const { mode = "default" } = opts;

  if (opts.useCmCli) {
    // cm-cli `show installed` prints a formatted table — return raw lines as
    // pseudo-nodes since structured data is HTTP-only.
    const out = runCmCli(["show", "installed"]);
    const lines = out
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("#"));
    return lines.map((line) => ({
      module: line,
      enabled: true,
      version: undefined,
    }));
  }

  // Both pip-Manager modes serve /v2/customnode/installed (the legacy-UI
  // module registers it too); only the 3.x custom-node Manager lacks /v2.
  const prefix = (await detectManagerApi()) === "legacy" ? "" : "/v2";
  const raw = await managerFetch<unknown>(
    `${prefix}/customnode/installed?mode=${encodeURIComponent(mode)}`,
  );
  return parseInstalled(raw);
}

// ---------------------------------------------------------------------------
// sync dependencies (comfy-cli `node uv-sync` analogue)
// ---------------------------------------------------------------------------

export interface SyncDepsResult {
  mechanism: "comfy-cli";
  message: string;
  details?: unknown;
}

/**
 * Reconcile installed-node Python dependencies. comfy-cli exposes this as
 * `node uv-sync`, but ComfyUI-Manager has no `uv-sync` subcommand or HTTP
 * endpoint; the equivalent reconciliation is cm-cli `restore-dependencies`,
 * which reinstalls each installed pack's requirements. Subprocess-only.
 */
export async function syncNodeDependencies(): Promise<SyncDepsResult> {
  const out = runCmCli(["restore-dependencies"]);
  return {
    mechanism: "comfy-cli",
    message:
      "Reconciled installed-node Python dependencies via official comfy-cli node restore-dependencies.",
    details: out.trim(),
  };
}

// ---------------------------------------------------------------------------
// install model (ComfyUI-Manager `install-model` task)
// ---------------------------------------------------------------------------

/**
 * Parameters for the ComfyUI-Manager `install-model` task. This mirrors the
 * Manager-side InstallModelParams Pydantic model used by
 * /v2/manager/queue/task (do_install_model): the backend downloads `url` to
 * `<models_dir>/<save_path or type>/<filename>` server-side. Because the
 * download happens ON THE COMFYUI HOST, this is the remote-mode equivalent of
 * our local downloadModel() — no local filesystem is touched.
 */
export interface InstallModelParams {
  /**
   * Display name for the model. REQUIRED, non-empty: Manager 4.2.2's
   * do_install_model reads `json_data['name']`. When omitted/blank we fall back
   * to `filename`. (Verified live: omitting this is a silent no-op.)
   */
  name: string;
  /** Direct download URL for the model file. */
  url: string;
  /** Saved filename under the target directory. */
  filename: string;
  /**
   * ComfyUI-Manager model `type` — MUST be a key in Manager's
   * `model_dir_name_map` (e.g. "checkpoints", "lora", "vae", "controlnet",
   * "clip_vision", "upscale", "embeddings", "text_encoders"/"clip",
   * "diffusion_model", "unet", "gligen", "unclip"). When `save_path` is
   * "default" Manager resolves the destination folder from this; an arbitrary
   * value (e.g. "vae_approx") resolves to None and the install silently no-ops.
   * Use managerModelDestination() to derive a valid value from our categories.
   */
  type: string;
  /**
   * Save path relative to models/. ALWAYS sent to Manager (defaults to the
   * literal "default" when blank). Manager's get_model_dir does
   * `if data["save_path"] != "default": <use it verbatim>` else it resolves the
   * folder from `type`; a missing/None save_path makes it bail (→ nothing
   * installs). Pass an explicit relative path (e.g. "loras/sub") for a nested
   * destination, or "default" for type-based resolution.
   */
  save_path?: string;
  /**
   * OUR canonical folder-paths category (e.g. "diffusion_models", "vae") —
   * used ONLY for panel download-tray progress. When set and the panel
   * progress channel is active, a background watcher reports an indeterminate
   * tray row until the file shows up in the server's /models/<category>
   * listing (in-progress files are hidden there, so "listed" = landed).
   */
  trayCategory?: string;
}

// Remote (Manager-dispatched) downloads run server-side: the queue reports
// "done" at dispatch/aria2-handoff while the host still streams gigabytes, so
// tray progress can't come from bytes we never see (issue #143). Instead, poll
// the server's /models/<category> listing — verified live: an in-progress file
// is NOT listed; it appears when the download completes.
const REMOTE_LANDING_POLL_MS = 5_000;
const REMOTE_LANDING_TIMEOUT_MS = 4 * 60 * 60 * 1000; // generous: multi-GB on slow links

/**
 * Background tray reporter for a server-side model download. Writes an
 * indeterminate "downloading" row immediately (and as a heartbeat, so the
 * orchestrator's 60s dead-writer sweep doesn't prune long downloads), then a
 * terminal "done" when the filename appears in /models/<category>, or "error"
 * if it never shows within the timeout. Fire-and-forget: the tool call returns
 * at dispatch; this keeps the tray honest afterwards. No-op outside the panel
 * (progress channel disabled).
 */
export function watchRemoteModelLanding(
  category: string,
  filename: string,
  url: string,
): void {
  if (!progressEnabled()) return;
  const id = createHash("sha256").update(url).digest("hex").slice(0, 16);
  const row = { id, name: filename, downloaded: 0, total: 0, bytes_per_sec: 0 };
  reportDownloadProgress({ ...row, status: "downloading" }, true);
  const started = Date.now();
  const timer = setInterval(() => {
    void (async () => {
      let listed = false;
      try {
        const res = await comfyuiFetch(
          `${getComfyUIBaseUrl()}/models/${encodeURIComponent(category)}`,
        );
        if (res.ok) {
          const names = (await res.json()) as unknown;
          // Entries are relative paths ("file.safetensors" or "sub/file.safetensors").
          listed =
            Array.isArray(names) &&
            names.some(
              (n) =>
                typeof n === "string" &&
                (n === filename || n.endsWith(`/${filename}`) || n.endsWith(`\\${filename}`)),
            );
        }
      } catch {
        // Server briefly unreachable (e.g. mid-reboot) — keep waiting.
      }
      if (listed) {
        clearInterval(timer);
        reportDownloadProgress({ ...row, status: "done" }, true);
      } else if (Date.now() - started > REMOTE_LANDING_TIMEOUT_MS) {
        clearInterval(timer);
        reportDownloadProgress({ ...row, status: "error" }, true);
      } else {
        reportDownloadProgress({ ...row, status: "downloading" }, true);
      }
    })();
  }, REMOTE_LANDING_POLL_MS);
  timer.unref?.();
}

/**
 * Install a model on the connected ComfyUI host via ComfyUI-Manager's unified
 * task queue (`install-model` kind). Wraps the same queue task + drain
 * (start → poll status) flow that custom-node installs use, so it works against
 * a REMOTE ComfyUI where the MCP has no local filesystem. The Manager backend
 * fetches `url` server-side into the target model directory.
 */
export async function installModelViaManager(
  params: InstallModelParams,
): Promise<NodeOpResult> {
  // Build the ModelMetadata params exactly as Manager 4.2.2 expects. ALL of
  // name/type/url/filename/save_path are load-bearing (verified live against a
  // RunPod pod): `name` and `save_path` were the two missing fields that made
  // the task dispatch but silently install nothing.
  const name =
    params.name && params.name.trim().length > 0 ? params.name : params.filename;
  const save_path =
    params.save_path && params.save_path.trim().length > 0
      ? params.save_path
      : "default";
  const taskParams: Record<string, unknown> = {
    name,
    url: params.url,
    filename: params.filename,
    type: params.type,
    save_path,
  };
  const status = await queueManagerTask("install-model", taskParams);
  // NOTE: the Manager queue reports the task "done" once it DRAINS, even when
  // the underlying OperationResult failed (e.g. a 404 download, or Manager's
  // security gate rejecting a network fetch) — and with an aria2 sidecar
  // (COMFYUI_MANAGER_ARIA2_SERVER) it drains at HANDOFF, while the host is
  // still streaming gigabytes. The v2 queue/status endpoint only exposes
  // aggregate counts (no per-task result), so a clean drain here does NOT
  // prove the file landed — phrase the result as "dispatched", not
  // "installed", and leave final verification to a list on the pod.
  //
  // DEPLOYMENT: remote model install requires the pod's ComfyUI-Manager to be
  // in network_mode=personal_cloud (or loopback) with permissive security; a
  // stricter security_level rejects the server-side download.
  if (params.trayCategory) {
    watchRemoteModelLanding(params.trayCategory, params.filename, params.url);
  }
  return {
    mechanism: "manager-http",
    message:
      `Dispatched model "${name}" (${params.filename}) to install into ` +
      `${params.type} on the connected ComfyUI via ComfyUI-Manager. The queue ` +
      `drained, but that only means the download was HANDED OFF (with an aria2 ` +
      `sidecar the host keeps streaming after the queue drains), and Manager ` +
      `reports tasks "done" even on failure with no per-task result — so ` +
      `success is NOT guaranteed. The file appears in the server's ` +
      `/models/<category> listing only once the download COMPLETES (in-progress ` +
      `files are hidden), and Manager may store it under its own type dir ` +
      `(e.g. unet/, clip/) which ComfyUI aliases to diffusion_models/` +
      `text_encoders — an empty canonical folder mid-download is NORMAL, not a ` +
      `failure. Wait and re-check before re-dispatching (duplicates waste ` +
      `bandwidth); a restart may be required for loaders to see the file. If ` +
      `nothing ever lands, confirm Manager runs with ` +
      `network_mode=personal_cloud (or loopback) and a permissive security ` +
      `level so server-side downloads aren't blocked.`,
    details: status,
  };
}
