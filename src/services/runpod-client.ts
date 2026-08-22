// RunPod connector — a thin client over RunPod's GraphQL API for managing a live
// pod (status / start / stop / troubleshoot / connect), plus the referral deploy
// link so a user creating their own pod credits our account.
//
// Auth: RUNPOD_API_KEY (loaded from ~/.comfyui-mcp/.env into process.env by
// src/config.ts). The key is sent as an `Authorization: Bearer` header — NEVER
// in the URL (query strings leak into proxy/server logs) and NEVER logged.
//
// Referral: RunPod's referral attaches at signup/deploy via a `?ref=` link, NOT as
// a per-pod API parameter — so we surface the deploy link for pod CREATION while
// managing EXISTING pods over the API. Configurable via RUNPOD_TEMPLATE_ID /
// RUNPOD_REF_CODE for other deployments; defaults are this project's.

import { createHash } from "node:crypto";
import { z } from "zod";
import { freshSecretValue } from "../env-file.js";

const RUNPOD_GRAPHQL_ENDPOINT = "https://api.runpod.io/graphql";

/** The RunPod template a fresh pod deploys from (our comfyui-mcp image). */
const DEFAULT_TEMPLATE_ID = "bnqtkvcer3";
export const RUNPOD_TEMPLATE_ID = process.env.RUNPOD_TEMPLATE_ID?.trim() || DEFAULT_TEMPLATE_ID;
/** Our RunPod referral code — a user deploying via the link below credits us. */
export const RUNPOD_REF_CODE = process.env.RUNPOD_REF_CODE?.trim() || "dkx71w9b";
/** ComfyUI's external port on a RunPod pod. RunPod ComfyUI templates front ComfyUI
 *  via nginx on port 3000 BY CONVENTION (ComfyUI itself runs on 3001 inside; 3000 is
 *  the proxied entrypoint) — NOT 8188. RunPod HTTP-proxies it at <podId>-<port>.
 *  Override with RUNPOD_COMFYUI_PORT for a template that uses a different port. */
export const RUNPOD_COMFYUI_PORT = (() => {
  const v = Number(process.env.RUNPOD_COMFYUI_PORT);
  return Number.isInteger(v) && v > 0 ? v : 3000;
})();

/** Attribution — this connector's pod-lifecycle + idle-auto-stop UX is modeled on
 *  gpu-cli (https://gpu-cli.sh), a great cloud-GPU CLI. Surfaced in the control
 *  panels + deploy flow to credit them and send traffic their way. */
export const GPU_CLI_URL = "https://gpu-cli.sh";
export const GPU_CLI_CREDIT = `Pod control inspired by gpu-cli.sh (${GPU_CLI_URL}) — a cloud-GPU CLI worth checking out.`;

/** The referral deploy link — hand this to a user who needs to CREATE a pod so
 *  their signup/spend credits our referral. Carries the template + ref code. */
export function runpodDeployLink(): string {
  return `https://console.runpod.io/deploy?template=${RUNPOD_TEMPLATE_ID}&ref=${RUNPOD_REF_CODE}`;
}

/** The public HTTPS URL RunPod proxies a pod's HTTP port at. For ComfyUI (3000)
 *  this is the URL to point comfyui-mcp at. Only reachable while the pod RUNS and
 *  the port is exposed as an HTTP port on the pod/template. */
export function runpodProxyUrl(podId: string, port: number = RUNPOD_COMFYUI_PORT): string {
  return `https://${podId}-${port}.proxy.runpod.net`;
}

/** Thrown when RUNPOD_API_KEY is absent — the caller turns this into a clear,
 *  actionable tool error (how to set it) rather than a raw crash. */
export class RunpodAuthError extends Error {
  constructor(
    message = "RUNPOD_API_KEY is not set. Add it to ~/.comfyui-mcp/.env (get a key at console.runpod.io → Settings → API Keys) so the RunPod connector can manage your pods.",
  ) {
    super(message);
    this.name = "RunpodAuthError";
  }
}

function getApiKey(): string {
  // Resolved at ACCESS time from the canonical ~/.comfyui-mcp/.env (#826): a key
  // the panel saved AFTER this process started is otherwise invisible for the
  // whole life of the process, so every RunPod call keeps reporting "not set"
  // while a valid key sits on disk.
  const key = freshSecretValue("RUNPOD_API_KEY")?.trim();
  if (!key) throw new RunpodAuthError();
  return key;
}

/** Per-request timeout for RunPod API calls — a hung network must not pile up
 *  poller ticks or wedge a tool call forever. Override with RUNPOD_HTTP_TIMEOUT_MS. */
export const RUNPOD_HTTP_TIMEOUT_MS = (() => {
  const v = Number(process.env.RUNPOD_HTTP_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : 10_000;
})();

/** POST a GraphQL query to RunPod. Throws RunpodAuthError on 401, a descriptive
 *  Error on GraphQL/HTTP errors. The api_key never appears in thrown messages. */
export async function runpodGql<T = unknown>(
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const key = getApiKey();
  let res: Response;
  try {
    res = await fetch(RUNPOD_GRAPHQL_ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // Bearer header, NOT `?api_key=` in the URL — URLs land in logs.
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({ query, variables: variables ?? {} }),
      signal: AbortSignal.timeout(RUNPOD_HTTP_TIMEOUT_MS),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    throw new Error(
      timedOut
        ? `RunPod API request timed out after ${RUNPOD_HTTP_TIMEOUT_MS / 1000}s (${RUNPOD_GRAPHQL_ENDPOINT}).`
        : `Could not reach RunPod (${RUNPOD_GRAPHQL_ENDPOINT}): ${msg}`,
    );
  }
  if (res.status === 401) throw new RunpodAuthError("RunPod rejected the API key (401). Check RUNPOD_API_KEY in ~/.comfyui-mcp/.env.");
  const body = (await res.json().catch(() => ({}))) as { data?: T; errors?: unknown };
  if (body.errors) {
    // RunPod returns a generic message for an unknown podId; surface it plainly.
    throw new Error(`RunPod API error: ${JSON.stringify(body.errors)}`);
  }
  if (!res.ok) throw new Error(`RunPod API HTTP ${res.status}`);
  return body.data as T;
}

// ── Response validation (#269) ──────────────────────────────────────────────
// GraphQL responses used to be blind-cast (`as T`): a RunPod shape change then
// silently produced WRONG values (a null uptime reading as "idle", a renamed
// status field disabling auto-stop). Parse what we read instead — a mismatch
// throws loudly at the boundary. Schemas are LOOSE (extra fields pass through)
// so additive API changes never break us; only changes to fields we USE do.

const PortSchema = z.looseObject({
  // Every leaf nullable: RunPod's GraphQL declares these WITHOUT `!` — a null
  // port field or GPU reading is API-VALID and must not throw (#269 r2).
  ip: z.string().nullable(),
  isIpPublic: z.boolean().nullable(),
  privatePort: z.number().nullable(),
  publicPort: z.number().nullable(),
  type: z.string().nullable(),
});

const GpuRuntimeSchema = z.looseObject({
  id: z.string().nullable(),
  gpuUtilPercent: z.number().nullable(),
  memoryUtilPercent: z.number().nullable(),
});

const PodSchema = z.looseObject({
  id: z.string(),
  name: z.string().nullable(),
  desiredStatus: z.string(),
  costPerHr: z.number().nullable(),
  machine: z.looseObject({ gpuDisplayName: z.string().nullable() }).nullable(),
  // Absent on fresh deploys (still booting) → optional as well as nullable.
  runtime: z
    .looseObject({
      uptimeInSeconds: z.number().nullable(),
      ports: z.array(PortSchema).nullable(),
      gpus: z.array(GpuRuntimeSchema).nullable(),
    })
    .nullish(),
});

const PodStatusSchema = z.looseObject({ id: z.string(), desiredStatus: z.string() });

/** Parse `data` against `schema`; on mismatch throw an error that NAMES the
 *  operation and shows the first few issues, instead of returning garbage. */
function validate<S extends z.ZodType>(schema: S, data: unknown, what: string): z.output<S> {
  const r = schema.safeParse(data);
  if (r.success) return r.data;
  const issues = r.error.issues
    .slice(0, 3)
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
  throw new Error(`RunPod API returned an unexpected shape for ${what} — the API may have changed (${issues}).`);
}

// ── Typed shapes (only the fields we use) ────────────────────────────────────

export interface RunpodPort {
  ip: string | null;
  isIpPublic: boolean | null;
  privatePort: number | null;
  publicPort: number | null;
  type: string | null; // "http" | "tcp"
}

export interface RunpodGpuRuntime {
  id: string | null;
  gpuUtilPercent: number | null;
  memoryUtilPercent: number | null;
}

export interface RunpodPod {
  id: string;
  name: string | null;
  /** RUNNING | EXITED | TERMINATED | … (desired state RunPod is driving toward). */
  desiredStatus: string;
  costPerHr: number | null;
  machine: { gpuDisplayName: string | null } | null;
  /** Present only while the pod is actually up. null when stopped/booting. */
  runtime: {
    uptimeInSeconds: number | null;
    ports: RunpodPort[] | null;
    gpus: RunpodGpuRuntime[] | null;
  } | null;
}

const POD_FIELDS = `
  id
  name
  desiredStatus
  costPerHr
  machine { gpuDisplayName }
  runtime {
    uptimeInSeconds
    ports { ip isIpPublic privatePort publicPort type }
    gpus { id gpuUtilPercent memoryUtilPercent }
  }
`;

/** Fetch one pod by id. Returns null when RunPod has no such pod on this account. */
export async function getPod(podId: string): Promise<RunpodPod | null> {
  const data = await runpodGql<{ pod: RunpodPod | null }>(
    `query Pod($input: PodFilter!) { pod(input: $input) { ${POD_FIELDS} } }`,
    { input: { podId } },
  );
  validate(z.looseObject({ pod: PodSchema.nullable() }), data, `getPod(${podId})`);
  return data.pod ?? null;
}

/** List every pod on the account (for "which pod?" when no id is given). */
export async function listPods(): Promise<RunpodPod[]> {
  const data = await runpodGql<{ myself: { pods: RunpodPod[] } | null }>(
    `query { myself { pods { ${POD_FIELDS} } } }`,
  );
  // Nullable-but-REQUIRED wrappers: an ABSENT property is an API shape change
  // and must throw (never read as "no such pod" — codex r2), while an explicit
  // null is a legitimate answer.
  validate(z.looseObject({ myself: z.looseObject({ pods: z.array(PodSchema) }).nullable() }), data, "listPods");
  return data.myself?.pods ?? [];
}

/** Resume (start) a stopped/exited pod. gpuCount defaults to 1. Returns the pod's
 *  new desiredStatus (RUNNING) — the container still needs time to boot after.
 *
 *  NO CUDA FILTER HERE, DELIBERATELY (#2016). A resumed pod can be placed on
 *  different hardware than it was created on, so the CUDA floor createPod
 *  enforces does NOT carry across a stop/start — but RunPod's API exposes no
 *  lever to re-assert it: `PodResumeInput` has NO CUDA field under any name.
 *  Probed against the live api.runpod.io schema on 2026-08-21 by sending each
 *  candidate with a wrong-typed `podId`, so variable coercion failed and the
 *  resolver never ran (no pod was resumed):
 *
 *    allowedCudaVersions → Field "allowedCudaVersions" is not defined by type "PodResumeInput".
 *    cudaVersion / cudaVersions / allowedCudaVersion / minCudaVersion → same
 *    gpuCount → accepted (control: a KNOWN field draws no such error)
 *
 *  runpod-python's `generate_pod_resume_mutation` agrees — it sends only podId
 *  and gpuCount. docs.runpod.io/sdks/graphql/manage-pods shows an example with
 *  `allowedCudaVersions` on podResume; that example is WRONG, and copying it
 *  turns every start into a GraphQL validation failure. Adding the field here
 *  BREAKS `runpod action:"start"` outright — the test
 *  "sends NO CUDA filter on resume — PodResumeInput has no such field" pins it. */
export async function resumePod(podId: string, gpuCount = 1): Promise<{ id: string; desiredStatus: string }> {
  const data = await runpodGql<{ podResume: { id: string; desiredStatus: string } }>(
    `mutation Resume($input: PodResumeInput!) { podResume(input: $input) { id desiredStatus } }`,
    { input: { podId, gpuCount } },
  );
  validate(z.looseObject({ podResume: PodStatusSchema }), data, `resumePod(${podId})`);
  return data.podResume;
}

/** Stop a running pod (keeps the pod + its disk; billing for GPU-time stops).
 *  Returns the new desiredStatus (EXITED). */
export async function stopPod(podId: string): Promise<{ id: string; desiredStatus: string }> {
  const data = await runpodGql<{ podStop: { id: string; desiredStatus: string } }>(
    `mutation Stop($input: PodStopInput!) { podStop(input: $input) { id desiredStatus } }`,
    { input: { podId } },
  );
  validate(z.looseObject({ podStop: PodStatusSchema }), data, `stopPod(${podId})`);
  return data.podStop;
}

/** True when the pod exposes ComfyUI's port as an HTTP proxy port and is running. */
export function comfyuiPortExposed(pod: RunpodPod): boolean {
  const ports = pod.runtime?.ports ?? [];
  return ports.some((p) => p.privatePort === RUNPOD_COMFYUI_PORT && p.type === "http");
}

// ── Dead-man switch (#269) ───────────────────────────────────────────────────
// The in-process idle auto-stop dies with the orchestrator: a crash (or a closed
// laptop) used to leave a pod RUNNING — and billing — forever. Pods we CREATE
// now carry a pod-side watchdog (docker/runpod/deadman_*): a heartbeat server on
// DEADMAN_PORT plus a loop that stops the pod itself when our heartbeats stop.
// Semantics: while comfyui-mcp minds a pod it beats every poll; if it vanishes
// (crash/offline) the pod STOPS ITSELF after the beat grace — a managed pod is
// never orphaned into infinite billing.
// CREDENTIALS: the watchdog stops the pod with the POD-SCOPED RunPod API key
// that RunPod auto-injects into every pod (docs.runpod.io/pods/templates/
// environment-variables) — the owner's account-wide key NEVER leaves the
// orchestrator. No key injection, nothing to opt out of on credential grounds;
// `deadman:false` / RUNPOD_DEADMAN=0 / pod env DEADMAN_DISABLE=1 simply leave
// the watchdog unarmed.

/** The pod's heartbeat-server port (exposed as an HTTP proxy port at create). */
export const RUNPOD_DEADMAN_PORT = 8189;

/** Default for the deadman create option; RUNPOD_DEADMAN=0/false/off opts out. */
export const RUNPOD_DEADMAN_DEFAULT = (() => {
  const v = process.env.RUNPOD_DEADMAN?.trim().toLowerCase();
  return !(v === "0" || v === "false" || v === "off");
})();

function graceEnv(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 60 ? Math.floor(v) : fallback;
}
/** Seconds a fresh pod may run with NO heartbeat before self-stopping (must
 *  cover boot + the user's connect window; beats only start once we manage it). */
export const DEADMAN_BOOT_GRACE_S = graceEnv("RUNPOD_DEADMAN_BOOT_GRACE_S", 2700);
/** Seconds without a heartbeat after which a MANAGED pod self-stops. Poll is
 *  15s by default, so 20min tolerates long network outages + restarts. */
export const DEADMAN_BEAT_GRACE_S = graceEnv("RUNPOD_DEADMAN_BEAT_GRACE_S", 1200);

/** The heartbeat token for a pod. Derived from the API key + pod NAME (which
 *  createPod makes unique per deploy) so it is per-deploy unguessable yet needs
 *  NO local storage — any process holding the key (watcher after a restart, a
 *  respawned child) recomputes it. It authorizes heartbeats ONLY (not the API);
 *  it rides the proxy URL's query string, which is acceptable for exactly that
 *  reason — it is not the API key and cannot stop the pod. */
export function deadmanToken(podName: string): string {
  return createHash("sha256").update(`deadman:${getApiKey()}:${podName}`).digest("hex");
}

/** Feed a pod's dead-man watchdog. BEST-EFFORT: returns false on any failure
 *  (pod has no watchdog — old image/console deploy — proxy down, etc.); the
 *  caller must never let a failed beat break the poll path it rides on. */
export async function beatDeadman(pod: { id: string; name: string | null }): Promise<boolean> {
  if (!pod.name) return false;
  try {
    const res = await fetch(`${runpodProxyUrl(pod.id, RUNPOD_DEADMAN_PORT)}/heartbeat?token=${deadmanToken(pod.name)}`, {
      signal: AbortSignal.timeout(3_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ── Pod creation (deploy our template via the API) ───────────────────────────
// The referral in runpodDeployLink() attaches a NEW signup to our account; once
// a user is a referred signup, EVERY pod they create — API or console — credits
// us. So a user with a RunPod account + API key can one-tap deploy our template
// here, while runpod action:"deploy_link" onboards brand-new users. GPU availability is
// spotty on-demand, so createPod tries a list of GPU types in order until one
// deploys (all 24GB+, enough for krea2 etc.).

/** GPU types tried in order by createPod (24GB+, community-common). Override via
 *  RUNPOD_GPU_TYPES (comma-separated) for other budgets/regions. */
export const RUNPOD_DEFAULT_GPU_TYPES: string[] = (
  process.env.RUNPOD_GPU_TYPES?.split(",").map((s) => s.trim()).filter(Boolean) || [
    // Ordered by rough preference; createPod tries each (× COMMUNITY then SECURE)
    // until one has capacity, so a crunch on one card falls through to the next.
    "NVIDIA GeForce RTX 4090",
    "NVIDIA RTX A6000",
    "NVIDIA RTX PRO 4500 Blackwell",
    "NVIDIA A40",
    "NVIDIA RTX A5000",
  ]
);

// ── Stock-image deploy floors (#2014, #2016) ─────────────────────────────────
// Both of these describe OUR image, so both apply only when the deploy targets
// the STOCK template — same scoping rule the dead-man switch uses below. A user
// pointing RUNPOD_TEMPLATE_ID / opts.templateId at their own image may
// legitimately want a smaller disk or a different CUDA floor, and we cannot
// verify what their image needs.

/** Container disk (GB) a STOCK-template deploy gets. docker/runpod/README.md's
 *  "Deploy on RunPod" table requires **>= 30 GB** ("the baked ComfyUI + venv +
 *  cu128 torch + any runtime-installed nodes/caches, which are ephemeral").
 *  We used to send 20 — matching the RunPod template's own setting, which is
 *  ALSO below the documented floor — and the pod was created, billed, and never
 *  came up: desiredStatus RUNNING, `runtime` null, no ports, unreachable. */
export const RUNPOD_STOCK_CONTAINER_DISK_GB = 30;

/** Container disk (GB) sent for a NON-stock template. Unchanged from the value
 *  every deploy used before #2014 — raising it for images we did not build
 *  would silently bill those users for disk they may not need. */
export const RUNPOD_DEFAULT_CONTAINER_DISK_GB = 20;

/** The host CUDA floor the STOCK image needs: driver >= 570 == CUDA 12.8. Set
 *  by docker/runpod/Dockerfile (`MIN_DRIVER_DEFAULT=570`, cu128 torch) and
 *  enforced pod-side by docker/runpod/post_start.sh's driver preflight, which
 *  refuses to launch and holds the pod open on an older host. */
const STOCK_MIN_CUDA_MAJOR = 12;
const STOCK_MIN_CUDA_MINOR = 8;

/** RunPod matches `allowedCudaVersions` as an ALLOW-LIST of exact "major.minor"
 *  strings against the host's CUDA version — there is no ">=" form and no way
 *  to enumerate what the fleet reports (GraphQL introspection is disabled;
 *  Query/GpuType/PodMachineInfo expose no CUDA field). So the list is GENERATED
 *  from the floor rather than pinned to the versions that happen to exist today.
 *
 *  Why generate past 13.x: an OVER-NARROW list is the dangerous direction. Too
 *  broad reproduces #2016 (a pod on an incompatible host); too narrow matches
 *  NO host, every GPU/cloud slot comes back "no capacity", and one-tap deploy
 *  stops working entirely the day RunPod's fleet moves to a CUDA we did not
 *  foresee. Version strings that do not exist are inert, not an error — probed
 *  against the live schema, `allowedCudaVersions` is a free-form [String] that
 *  accepts "banana" without complaint, and an unmatched entry simply never
 *  selects a host. Padding forward therefore costs nothing and buys durability. */
const CUDA_ALLOWLIST_MAX_MAJOR = 14;
function cudaVersionsAtLeast(minMajor: number, minMinor: number): string[] {
  const out: string[] = [];
  for (let major = minMajor; major <= CUDA_ALLOWLIST_MAX_MAJOR; major++) {
    // CUDA has never shipped a minor above 9 (12.0-12.9, then 13.0).
    for (let minor = major === minMajor ? minMinor : 0; minor <= 9; minor++) out.push(`${major}.${minor}`);
  }
  return out;
}

/** Host CUDA versions a STOCK-template deploy will accept (>= 12.8). */
export const RUNPOD_STOCK_ALLOWED_CUDA_VERSIONS: string[] = cudaVersionsAtLeast(
  STOCK_MIN_CUDA_MAJOR,
  STOCK_MIN_CUDA_MINOR,
);

/** What a CONSOLE deploy must set BY HAND, for anywhere we hand out
 *  runpodDeployLink() (codex gate, #2014/#2016).
 *
 *  createPod sends both floors on the API path, but the console path does not
 *  go through createPod: the user fills RunPod's own deploy form, seeded by the
 *  template — and the template itself is still registered at containerDiskInGb
 *  20 with no CUDA constraint, so following the link with its defaults
 *  reproduces BOTH defects on a pod the user pays for. RunPod documents no
 *  query parameters that would let the link carry overrides, and the template
 *  lives on the RunPod account rather than in this repo, so the only thing that
 *  closes the gap from here is saying so. Built from the SAME constants the API
 *  path sends, so the advice can never drift from the behaviour. */
export function runpodDeployRequirements(): string {
  // Scoped to the stock template exactly like the API-path defaults are: the
  // link carries RUNPOD_TEMPLATE_ID, and if that points at someone else's
  // image these are not our floors to state. Empty string = nothing to add;
  // callers must not render a stray blank block for it.
  if (RUNPOD_TEMPLATE_ID !== DEFAULT_TEMPLATE_ID) return "";
  return (
    `Two settings on that page are NOT optional for this image — the template's own defaults ` +
    `are below both, and a pod that misses either boots into an unusable state you still pay for:\n` +
    `  • Container disk: at least ${RUNPOD_STOCK_CONTAINER_DISK_GB} GB (the template still defaults to ` +
    `${RUNPOD_DEFAULT_CONTAINER_DISK_GB} GB).\n` +
    `  • CUDA version: ${RUNPOD_STOCK_ALLOWED_CUDA_VERSIONS[0]} or newer — filter by "CUDA Version" on the ` +
    `deploy screen. The image is a cu128 build and refuses to start on an older host.`
  );
}

/** Escape hatch for a fleet whose CUDA strings we guessed wrong, and the only
 *  way to widen/narrow the filter without a code change. Comma-separated
 *  ("12.8,12.9"); set it EMPTY to send no filter at all. Unset = use the
 *  stock default above (and no filter for a custom template). An explicit
 *  value applies to custom templates too — the user is asserting it. */
export const RUNPOD_ALLOWED_CUDA_VERSIONS: string[] | undefined =
  process.env.RUNPOD_ALLOWED_CUDA_VERSIONS === undefined
    ? undefined
    : process.env.RUNPOD_ALLOWED_CUDA_VERSIONS.split(",").map((s) => s.trim()).filter(Boolean);

export interface RunpodCreateOptions {
  /** GPU types to try in order (default RUNPOD_DEFAULT_GPU_TYPES). */
  gpuTypeIds?: string[];
  gpuCount?: number; // default 1
  /** Pin a cloud type. Omit to try COMMUNITY (cheaper) then SECURE (reliable). */
  cloudType?: "COMMUNITY" | "SECURE";
  name?: string; // default "comfyui-mcp"
  templateId?: string; // default RUNPOD_TEMPLATE_ID (our image)
  /** default RUNPOD_STOCK_CONTAINER_DISK_GB (30) on the stock template — the
   *  floor docker/runpod/README.md documents — and 20 on a custom template. */
  containerDiskInGb?: number;
  volumeInGb?: number; // default 60 (/workspace; README states no minimum — "size for your models")
  /** Host CUDA versions RunPod may schedule this pod onto. Defaults to
   *  RUNPOD_STOCK_ALLOWED_CUDA_VERSIONS on the stock template (whose image
   *  needs CUDA >= 12.8) and to NO filter on a custom template. Pass `[]` to
   *  send no filter. Create-only: RunPod's podResume takes no CUDA field. */
  allowedCudaVersions?: string[];
  /** SSH public key injected as PUBLIC_KEY (trainer drives the pod over ssh). */
  publicKey?: string;
  /** Arm the pod-side dead-man watchdog (default RUNPOD_DEADMAN_DEFAULT): adds
   *  a per-deploy heartbeat token + grace knobs as pod env and exposes the
   *  heartbeat port, so the pod can STOP ITSELF if comfyui-mcp stops minding
   *  it. The stop is authorized by RunPod's auto-injected POD-SCOPED key — the
   *  owner's account key is never added to the pod env. */
  deadman?: boolean;
}

/** Which template a deploy targets — the stock-only defaults key off this. */
function targetTemplateId(opts: RunpodCreateOptions): string {
  return opts.templateId ?? RUNPOD_TEMPLATE_ID;
}

/** Container disk (GB) this deploy will request (#2014). ONE source of truth:
 *  deployOnce sends it and the tests assert against it. */
function effectiveContainerDiskGb(opts: RunpodCreateOptions): number {
  if (opts.containerDiskInGb !== undefined) return opts.containerDiskInGb;
  return targetTemplateId(opts) === DEFAULT_TEMPLATE_ID
    ? RUNPOD_STOCK_CONTAINER_DISK_GB
    : RUNPOD_DEFAULT_CONTAINER_DISK_GB;
}

/** The CUDA allow-list this deploy will send, or undefined/[] for no filter
 *  (#2016). ONE source of truth: deployOnce sends it AND createPod's
 *  everything-failed error explains it, so the two can never disagree. */
function effectiveAllowedCudaVersions(opts: RunpodCreateOptions): string[] | undefined {
  if (opts.allowedCudaVersions !== undefined) return opts.allowedCudaVersions;
  if (RUNPOD_ALLOWED_CUDA_VERSIONS !== undefined) return RUNPOD_ALLOWED_CUDA_VERSIONS;
  return targetTemplateId(opts) === DEFAULT_TEMPLATE_ID ? RUNPOD_STOCK_ALLOWED_CUDA_VERSIONS : undefined;
}

async function deployOnce(
  cloudType: "COMMUNITY" | "SECURE",
  gpuTypeId: string,
  opts: RunpodCreateOptions,
): Promise<RunpodPod | null> {
  const podName = opts.name ?? "comfyui-mcp";
  const templateId = opts.templateId ?? RUNPOD_TEMPLATE_ID;
  // Dead-man defaults ON only for OUR stock template — a template override
  // (RUNPOD_TEMPLATE_ID / opts.templateId) points at an image we can't verify
  // SHIPS the watchdog (arming one without it would silently grant nothing).
  // Overrides need an explicit deadman:true — the caller is asserting their
  // image ships the watchdog.
  const deadman = opts.deadman ?? (templateId === DEFAULT_TEMPLATE_ID && RUNPOD_DEADMAN_DEFAULT);
  const containerDiskInGb = effectiveContainerDiskGb(opts);
  const allowedCudaVersions = effectiveAllowedCudaVersions(opts);
  const data = await runpodGql<{ podFindAndDeployOnDemand: RunpodPod | null }>(
    `mutation Deploy($input: PodFindAndDeployOnDemandInput!) {
       podFindAndDeployOnDemand(input: $input) {
         id name desiredStatus costPerHr machine { gpuDisplayName }
       }
     }`,
    {
      input: {
        cloudType,
        gpuCount: opts.gpuCount ?? 1,
        gpuTypeId,
        templateId,
        name: podName,
        containerDiskInGb,
        volumeInGb: opts.volumeInGb ?? 60,
        volumeMountPath: "/workspace",
        // Keep RunPod off hosts the image cannot run on (#2016). Omitted
        // entirely when empty — sending `allowedCudaVersions: []` would match
        // no host and make the pod unschedulable.
        ...(allowedCudaVersions?.length ? { allowedCudaVersions } : {}),
        // Guarantee ComfyUI is reachable through RunPod's HTTP proxy even if
        // the template's port config drifts — AND expose ssh (22/tcp) so the
        // pod-native trainer can drive ai-toolkit over it (codex finding:
        // one-tap pods had no SSH endpoint and rejected every pod job).
        // The deadman port only matters on images that ship the watchdog.
        ports: `${RUNPOD_COMFYUI_PORT}/http,22/tcp${deadman ? `,${RUNPOD_DEADMAN_PORT}/http` : ""}`,
        env: [
          // SSH auth for the trainer: the template injects this at boot.
          ...(opts.publicKey ? [{ key: "PUBLIC_KEY", value: opts.publicKey }] : []),
          // Dead-man switch (#269): heartbeat token + grace knobs. NO API key
          // here — the watchdog self-stops with the POD-SCOPED key RunPod
          // auto-injects; the owner's account key never leaves this process.
          ...(deadman
            ? [
                { key: "DEADMAN_TOKEN", value: deadmanToken(podName) },
                { key: "DEADMAN_BOOT_GRACE_S", value: String(DEADMAN_BOOT_GRACE_S) },
                { key: "DEADMAN_BEAT_GRACE_S", value: String(DEADMAN_BEAT_GRACE_S) },
              ]
            : []),
        ],
      },
    },
  );
  // Nullable-but-REQUIRED: explicit null = "no capacity for this slot" (try
  // the next), but an ABSENT property is a shape change → validate THROWS →
  // createPod's generic catch treats the create as AMBIGUOUS and reconciles
  // instead of falling through to another billed attempt (codex r2).
  validate(z.looseObject({ podFindAndDeployOnDemand: PodSchema.nullable() }), data, "createPod(deploy)");
  const pod = data.podFindAndDeployOnDemand;
  return pod?.id ? ({ ...pod, runtime: pod.runtime ?? null } as RunpodPod) : null;
}

/** Does this createPod failure PROVE RunPod did NOT create (and bill) a pod?
 *  Only an explicit capacity/availability/quota rejection from RunPod's own
 *  GraphQL layer qualifies — the server processed the mutation and refused it.
 *  Everything else (network drop, timeout, 5xx, parse failure, rate limit) is
 *  AMBIGUOUS: the billed mutation may have landed even though we never saw the
 *  response, so blindly retrying could spawn a second billable pod. */
export function isProvablyNotCreatedError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return NOT_CREATED_RE.test(msg);
}

// CONSERVATIVE by design: match ONLY RunPod's explicit capacity/availability/
// quota REJECTION clauses. An error we don't specifically recognize is treated
// as AMBIGUOUS (a pod MAY have been created) → the caller must NOT retry.
//
// The "…capacity" clauses carry a negative lookahead that EXCLUDES the "capacity
// information / details / data / status" wording used by AMBIGUOUS "status
// unknown" messages — e.g. "response contained no capacity information, so
// creation status is unknown" must NOT be read as a capacity rejection, or a
// lost-but-landed create would be retried and double-bill. Likewise the
// availability clauses require the concrete "instances available" phrasing, not
// any sentence containing "there are no …".
const CAP_NOISE = "(?!\\s+(?:information|informations|data|details?|info|status|unknown))";
const NOT_CREATED_RE = new RegExp(
  [
    "no longer any instances? available",
    "there are no (?:longer any )?(?:gpu )?instances? available",
    "no (?:gpu )?instances? (?:currently )?available",
    `\\bno capacity${CAP_NOISE}`,
    `(?:not enough|insufficient) (?:gpu )?capacity${CAP_NOISE}`,
    "(?:not enough|insufficient) (?:gpu instances|gpus|instances)",
    "out of stock",
    "quota (?:exceeded|reached)",
  ].join("|"),
  "i",
);

/** Outcome of reconciling an AMBIGUOUS create failure against the live pod list.
 *  - `unknown`: we couldn't determine (no snapshot, or the reconcile list failed)
 *  - `none`:    no NEW same-named pod appeared (the mutation likely didn't land)
 *  - `one`:     exactly ONE new same-named pod → this call created it; return it
 *  - `ambiguous`: MULTIPLE new same-named pods → cannot attribute one to THIS
 *                 call (a concurrent create raced us); fail closed, do NOT guess. */
type ReconcileResult =
  | { kind: "unknown" }
  | { kind: "none" }
  | { kind: "one"; pod: RunpodPod }
  | { kind: "ambiguous"; count: number };

/** Reconcile after an AMBIGUOUS create failure: did a NEW pod with the requested
 *  name appear (i.e. did the lost mutation actually land)? `priorIds` is the set
 *  of same-named pod ids that existed BEFORE this createPod call — null when we
 *  couldn't snapshot them, in which case we cannot tell new from pre-existing.
 *
 *  CONCURRENCY HAZARD: pod name is NOT unique, so two concurrent createPod calls
 *  for the same default name ("comfyui-mcp") each see the OTHER's pod as "new".
 *  We therefore only attribute a pod to THIS call when EXACTLY ONE new same-named
 *  pod appeared; if several did, we fail closed (kind:"ambiguous") rather than
 *  risk claiming (and then managing/auto-stopping) a pod a different caller made.
 *
 *  RESIDUAL LIMITATION (mis-attribution, NOT extra billing): the single-new-pod
 *  path can still claim a pod created by a CONCURRENT caller if THIS call failed
 *  before creating anything AND, in the same window, exactly one other same-named
 *  pod appeared. The claimed pod exists regardless (no extra spend); the only
 *  harm is that the wrong caller manages/auto-stops it. A fully correct fix needs
 *  a per-create idempotency token or a unique deploy name (a RunPod-API design
 *  change owned by the connector author). Tracked in issue #276 — see the note at
 *  the createPod call site (~line 400). Not blocking: the common single-caller
 *  path is correct and the multi-new-pod case is already fail-closed. */
async function reconcileCreatedPod(
  name: string,
  priorIds: Set<string> | null,
): Promise<ReconcileResult> {
  if (!priorIds) return { kind: "unknown" };
  let created: RunpodPod[];
  try {
    const pods = await listPods();
    created = pods.filter((p) => p.name === name && !priorIds.has(p.id));
  } catch {
    return { kind: "unknown" }; // reconcile list failed — never retry blindly
  }
  if (created.length === 0) return { kind: "none" };
  if (created.length === 1) return { kind: "one", pod: created[0] };
  return { kind: "ambiguous", count: created.length };
}

/** Deploy a fresh on-demand pod from our template. Community GPU capacity is
 *  spotty, so unless a cloud type is pinned we try COMMUNITY (cheap) across each
 *  GPU type, then SECURE (reliable, pricier) — the first slot with capacity wins,
 *  so one-tap deploy survives community supply constraints. Throws a descriptive
 *  error listing what RunPod rejected if nothing is available. The returned pod
 *  is fresh (runtime null — still booting; follow with getPod / runpod action:"connect").
 *
 *  BILLING SAFETY: podFindAndDeployOnDemand is a non-idempotent, BILLED mutation.
 *  We only move on to the next cloud/GPU slot when RunPod EXPLICITLY rejected the
 *  deploy (capacity/quota — provably nothing was created). On any AMBIGUOUS
 *  failure (network/timeout/5xx/parse — the pod may exist even though the
 *  response was lost) we reconcile by listing pods under the requested name: if
 *  this call's pod appeared, return it; otherwise fail WITHOUT retrying so a
 *  lost-response create can never fan out into extra billable pods. Auth errors
 *  surface immediately. */
export async function createPod(opts: RunpodCreateOptions = {}): Promise<RunpodPod> {
  const gpuTypeIds = opts.gpuTypeIds?.length ? opts.gpuTypeIds : RUNPOD_DEFAULT_GPU_TYPES;
  const cloudTypes: Array<"COMMUNITY" | "SECURE"> = opts.cloudType ? [opts.cloudType] : ["COMMUNITY", "SECURE"];
  // Mis-attribution mitigation (#276): pod name is NOT unique, so a shared
  // default ("comfyui-mcp") let a lost-response reconcile claim a CONCURRENT
  // caller's same-named pod. RunPod exposes no per-create idempotency token, so
  // instead we default to a UNIQUE deploy name — then reconcileCreatedPod's
  // `name` filter attributes exactly THIS call's pod and concurrent creates no
  // longer collide. An explicitly-passed name keeps its old (shared) semantics:
  // the caller opted in.
  const name = opts.name ?? `comfyui-mcp-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  // Ensure deployOnce sends the SAME name we reconcile against (its own default
  // would otherwise be the shared "comfyui-mcp").
  opts = { ...opts, name };
  // Snapshot the ids of pods ALREADY carrying the requested name, so post-failure
  // reconciliation can tell a pod THIS call created apart from a pre-existing one.
  let priorIds: Set<string> | null = null;
  try {
    priorIds = new Set((await listPods()).filter((p) => p.name === name).map((p) => p.id));
  } catch {
    priorIds = null; // snapshot unavailable → ambiguous failures become terminal
  }
  const attempts: string[] = [];
  for (const cloudType of cloudTypes) {
    for (const gpuTypeId of gpuTypeIds) {
      try {
        const pod = await deployOnce(cloudType, gpuTypeId, opts);
        if (pod) return pod;
        attempts.push(`${cloudType}/${gpuTypeId}: no capacity available`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Auth rejection happens before any pod is created — surface it directly
        // (retrying other slots with the same bad key is pointless).
        if (err instanceof RunpodAuthError) throw err;
        if (isProvablyNotCreatedError(err)) {
          // RunPod itself said "no capacity/quota" → nothing was created; the
          // next cloud/GPU slot is safe to try.
          attempts.push(`${cloudType}/${gpuTypeId}: ${msg}`);
          continue;
        }
        // AMBIGUOUS failure: the billed mutation may have landed. Reconcile first.
        const rec = await reconcileCreatedPod(name, priorIds);
        // Exactly one new same-named pod → attribute it to this call. NOTE: a
        // concurrent same-name create can make this mis-attribute (harm =
        // wrong owner manages the pod, NOT extra billing); a proper fix needs a
        // per-create idempotency key / unique deploy name — tracked in issue #276.
        if (rec.kind === "one") return rec.pod;
        const suffix = attempts.length ? `\nEarlier attempts:\n${attempts.map((a) => `  • ${a}`).join("\n")}` : "";
        if (rec.kind === "ambiguous") {
          throw new Error(
            `RunPod pod creation on ${cloudType}/${gpuTypeId} failed ambiguously (${msg}) and ` +
              `${rec.count} new pods named "${name}" appeared — likely a concurrent create raced ` +
              `this one, so which pod belongs to this call can't be determined. NOT retrying and ` +
              `NOT claiming any of them automatically (a wrong guess could auto-stop someone else's ` +
              `pod or leak a billable one). Reconcile manually at console.runpod.io (or ` +
              `runpod action:"status").` + suffix,
          );
        }
        throw new Error(
          `RunPod pod creation failed on ${cloudType}/${gpuTypeId} and it could not be confirmed ` +
            `whether a pod was created (${msg}). NOT retrying automatically — a retry could create ` +
            `a second billable pod. Check your pods at console.runpod.io (or runpod action:"status") ` +
            `before trying again.` + suffix,
        );
      }
    }
  }
  // Name the CUDA filter when one was applied (#2016). It restricts which hosts
  // can match, so "no capacity everywhere" has a second possible cause now — and
  // an unschedulable pod would otherwise look exactly like a capacity crunch.
  const cuda = effectiveAllowedCudaVersions(opts);
  const cudaNote = cuda?.length
    ? `\nThis deploy also required host CUDA ${cuda[0]}+ (allowedCudaVersions), which our image needs — ` +
      `if RunPod reports a CUDA version outside [${cuda.join(", ")}], set RUNPOD_ALLOWED_CUDA_VERSIONS ` +
      `to the versions your fleet offers (empty to send no filter).`
    : "";
  throw new Error(
    `Could not deploy a pod on any of [${gpuTypeIds.join(", ")}] in ${cloudTypes.join("/")}. RunPod reported:\n` +
      attempts.map((a) => `  • ${a}`).join("\n") +
      `\nTry again shortly (capacity fluctuates), set RUNPOD_GPU_TYPES to other GPUs, ` +
      `or deploy from the console with runpod action:"deploy_link".` +
      cudaNote,
  );
}
