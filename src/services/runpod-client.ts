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

/** The public HTTPS URL RunPod proxies a pod's HTTP port at. For ComfyUI (8188)
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
  const key = process.env.RUNPOD_API_KEY?.trim();
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
 *  new desiredStatus (RUNNING) — the container still needs time to boot after. */
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
// here, while runpod_deploy_link onboards brand-new users. GPU availability is
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

export interface RunpodCreateOptions {
  /** GPU types to try in order (default RUNPOD_DEFAULT_GPU_TYPES). */
  gpuTypeIds?: string[];
  gpuCount?: number; // default 1
  /** Pin a cloud type. Omit to try COMMUNITY (cheaper) then SECURE (reliable). */
  cloudType?: "COMMUNITY" | "SECURE";
  name?: string; // default "comfyui-mcp"
  templateId?: string; // default RUNPOD_TEMPLATE_ID (our image)
  containerDiskInGb?: number; // default 20 (matches our template)
  volumeInGb?: number; // default 60 (matches our template; /workspace)
  /** SSH public key injected as PUBLIC_KEY (trainer drives the pod over ssh). */
  publicKey?: string;
  /** Arm the pod-side dead-man watchdog (default RUNPOD_DEADMAN_DEFAULT): adds
   *  a per-deploy heartbeat token + grace knobs as pod env and exposes the
   *  heartbeat port, so the pod can STOP ITSELF if comfyui-mcp stops minding
   *  it. The stop is authorized by RunPod's auto-injected POD-SCOPED key — the
   *  owner's account key is never added to the pod env. */
  deadman?: boolean;
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
        containerDiskInGb: opts.containerDiskInGb ?? 20,
        volumeInGb: opts.volumeInGb ?? 60,
        volumeMountPath: "/workspace",
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
 *  is fresh (runtime null — still booting; follow with getPod/runpod_pod_connect).
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
              `runpod_pod_status).` + suffix,
          );
        }
        throw new Error(
          `RunPod pod creation failed on ${cloudType}/${gpuTypeId} and it could not be confirmed ` +
            `whether a pod was created (${msg}). NOT retrying automatically — a retry could create ` +
            `a second billable pod. Check your pods at console.runpod.io (or runpod_pod_status) ` +
            `before trying again.` + suffix,
        );
      }
    }
  }
  throw new Error(
    `Could not deploy a pod on any of [${gpuTypeIds.join(", ")}] in ${cloudTypes.join("/")}. RunPod reported:\n` +
      attempts.map((a) => `  • ${a}`).join("\n") +
      `\nTry again shortly (capacity fluctuates), set RUNPOD_GPU_TYPES to other GPUs, ` +
      `or deploy from the console with runpod_deploy_link.`,
  );
}
