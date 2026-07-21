// RunPod connector — a thin client over RunPod's GraphQL API for managing a live
// pod (status / start / stop / troubleshoot / connect), plus the referral deploy
// link so a user creating their own pod credits our account.
//
// Auth: RUNPOD_API_KEY (loaded from ~/.comfyui-mcp/.env into process.env by
// src/config.ts). The key goes in the endpoint query string exactly as RunPod's
// API expects (`?api_key=…`) — NEVER logged.
//
// Referral: RunPod's referral attaches at signup/deploy via a `?ref=` link, NOT as
// a per-pod API parameter — so we surface the deploy link for pod CREATION while
// managing EXISTING pods over the API. Configurable via RUNPOD_TEMPLATE_ID /
// RUNPOD_REF_CODE for other deployments; defaults are this project's.

const RUNPOD_GRAPHQL_ENDPOINT = "https://api.runpod.io/graphql";

/** The RunPod template a fresh pod deploys from (our comfyui-mcp image). */
export const RUNPOD_TEMPLATE_ID = process.env.RUNPOD_TEMPLATE_ID?.trim() || "bnqtkvcer3";
/** Our RunPod referral code — a user deploying via the link below credits us. */
export const RUNPOD_REF_CODE = process.env.RUNPOD_REF_CODE?.trim() || "dkx71w9b";
/** ComfyUI's port inside the pod (RunPod HTTP-proxies it at <podId>-<port>). */
export const RUNPOD_COMFYUI_PORT = 8188;

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

/** POST a GraphQL query to RunPod. Throws RunpodAuthError on 401, a descriptive
 *  Error on GraphQL/HTTP errors. The api_key never appears in thrown messages. */
export async function runpodGql<T = unknown>(
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const key = getApiKey();
  let res: Response;
  try {
    res = await fetch(`${RUNPOD_GRAPHQL_ENDPOINT}?api_key=${encodeURIComponent(key)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, variables: variables ?? {} }),
    });
  } catch (err) {
    throw new Error(`Could not reach RunPod (${RUNPOD_GRAPHQL_ENDPOINT}): ${err instanceof Error ? err.message : String(err)}`);
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

// ── Typed shapes (only the fields we use) ────────────────────────────────────

export interface RunpodPort {
  ip: string;
  isIpPublic: boolean;
  privatePort: number;
  publicPort: number;
  type: string; // "http" | "tcp"
}

export interface RunpodGpuRuntime {
  id: string;
  gpuUtilPercent: number;
  memoryUtilPercent: number;
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
  return data.pod ?? null;
}

/** List every pod on the account (for "which pod?" when no id is given). */
export async function listPods(): Promise<RunpodPod[]> {
  const data = await runpodGql<{ myself: { pods: RunpodPod[] } | null }>(
    `query { myself { pods { ${POD_FIELDS} } } }`,
  );
  return data.myself?.pods ?? [];
}

/** Resume (start) a stopped/exited pod. gpuCount defaults to 1. Returns the pod's
 *  new desiredStatus (RUNNING) — the container still needs time to boot after. */
export async function resumePod(podId: string, gpuCount = 1): Promise<{ id: string; desiredStatus: string }> {
  const data = await runpodGql<{ podResume: { id: string; desiredStatus: string } }>(
    `mutation Resume($input: PodResumeInput!) { podResume(input: $input) { id desiredStatus } }`,
    { input: { podId, gpuCount } },
  );
  return data.podResume;
}

/** Stop a running pod (keeps the pod + its disk; billing for GPU-time stops).
 *  Returns the new desiredStatus (EXITED). */
export async function stopPod(podId: string): Promise<{ id: string; desiredStatus: string }> {
  const data = await runpodGql<{ podStop: { id: string; desiredStatus: string } }>(
    `mutation Stop($input: PodStopInput!) { podStop(input: $input) { id desiredStatus } }`,
    { input: { podId } },
  );
  return data.podStop;
}

/** True when the pod exposes ComfyUI's port as an HTTP proxy port and is running. */
export function comfyuiPortExposed(pod: RunpodPod): boolean {
  const ports = pod.runtime?.ports ?? [];
  return ports.some((p) => p.privatePort === RUNPOD_COMFYUI_PORT && p.type === "http");
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
    "NVIDIA GeForce RTX 4090",
    "NVIDIA RTX A5000",
    "NVIDIA A40",
  ]
);

export interface RunpodCreateOptions {
  /** GPU types to try in order (default RUNPOD_DEFAULT_GPU_TYPES). */
  gpuTypeIds?: string[];
  gpuCount?: number; // default 1
  /** COMMUNITY (cheaper, default) or SECURE. */
  cloudType?: "COMMUNITY" | "SECURE";
  name?: string; // default "comfyui-mcp"
  templateId?: string; // default RUNPOD_TEMPLATE_ID (our image)
  containerDiskInGb?: number; // default 20 (matches our template)
  volumeInGb?: number; // default 60 (matches our template; /workspace)
}

/** Deploy a fresh on-demand pod from our template. Tries each GPU type until one
 *  has capacity; throws a descriptive error listing what RunPod rejected if none
 *  do. The returned pod is freshly created (runtime null — it still needs to boot;
 *  follow with getPod/runpod_pod_connect which waits for ComfyUI). */
export async function createPod(opts: RunpodCreateOptions = {}): Promise<RunpodPod> {
  const gpuTypeIds = opts.gpuTypeIds?.length ? opts.gpuTypeIds : RUNPOD_DEFAULT_GPU_TYPES;
  const attempts: string[] = [];
  for (const gpuTypeId of gpuTypeIds) {
    try {
      const data = await runpodGql<{ podFindAndDeployOnDemand: RunpodPod | null }>(
        `mutation Deploy($input: PodFindAndDeployOnDemandInput!) {
           podFindAndDeployOnDemand(input: $input) {
             id name desiredStatus costPerHr machine { gpuDisplayName }
           }
         }`,
        {
          input: {
            cloudType: opts.cloudType ?? "COMMUNITY",
            gpuCount: opts.gpuCount ?? 1,
            gpuTypeId,
            templateId: opts.templateId ?? RUNPOD_TEMPLATE_ID,
            name: opts.name ?? "comfyui-mcp",
            containerDiskInGb: opts.containerDiskInGb ?? 20,
            volumeInGb: opts.volumeInGb ?? 60,
            volumeMountPath: "/workspace",
            // Guarantee ComfyUI is reachable through RunPod's HTTP proxy even if
            // the template's port config drifts.
            ports: `${RUNPOD_COMFYUI_PORT}/http`,
          },
        },
      );
      const pod = data.podFindAndDeployOnDemand;
      if (pod?.id) {
        // Ensure the runtime shape is present (deploy returns it null).
        return { ...pod, runtime: pod.runtime ?? null } as RunpodPod;
      }
      attempts.push(`${gpuTypeId}: no capacity available`);
    } catch (err) {
      attempts.push(`${gpuTypeId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new Error(
    `Could not deploy a pod on any of [${gpuTypeIds.join(", ")}]. RunPod reported:\n` +
      attempts.map((a) => `  • ${a}`).join("\n") +
      `\nTry again shortly (capacity fluctuates), set RUNPOD_GPU_TYPES to other GPUs, ` +
      `or deploy from the console with runpod_deploy_link.`,
  );
}
