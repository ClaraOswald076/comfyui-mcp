import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFile } from "node:fs/promises";
import {
  createPod,
  resumePod,
  RUNPOD_STOCK_CONTAINER_DISK_GB,
  getPod,
  isProvablyNotCreatedError,
  runpodDeployLink,
  runpodProxyUrl,
  comfyuiPortExposed,
  deadmanToken,
  beatDeadman,
  RUNPOD_DEADMAN_PORT,
  RUNPOD_DEFAULT_GPU_TYPES,
  type RunpodPod,
} from "../../services/runpod-client.js";

// createPod loops over GPU types until one deploys. Mock fetch to control which
// attempt succeeds; assert the fallback + the referral link / proxy helpers.
let savedKey: string | undefined;
beforeEach(() => {
  savedKey = process.env.RUNPOD_API_KEY;
  process.env.RUNPOD_API_KEY = "rp-test-key";
});
afterEach(() => {
  if (savedKey === undefined) delete process.env.RUNPOD_API_KEY;
  else process.env.RUNPOD_API_KEY = savedKey;
  vi.restoreAllMocks();
});

function gqlResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

type GqlBody = { query: string; variables: Record<string, unknown> };

/** Mock fetch with a per-request handler keyed on the GraphQL body. The handler
 *  may throw to simulate a network failure. Returns counters for assertions. */
function mockGql(handler: (body: GqlBody, callIndex: number) => unknown) {
  const counts = { total: 0, deploys: 0, lists: 0, inits: [] as RequestInit[] };
  const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse((init as { body: string }).body) as GqlBody;
    const i = counts.total++;
    if (body.query.includes("podFindAndDeployOnDemand")) counts.deploys++;
    if (body.query.includes("myself")) counts.lists++;
    counts.inits.push(init as RequestInit);
    return gqlResponse(handler(body, i));
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return { counts, fetchMock };
}

const emptyList = { data: { myself: { pods: [] } } };
const listOf = (pods: unknown[]) => ({ data: { myself: { pods } } });
const deployed = (id: string, gpu = "RTX 4090") => ({
  data: { podFindAndDeployOnDemand: { id, name: "comfyui-mcp", desiredStatus: "RUNNING", costPerHr: 0.44, machine: { gpuDisplayName: gpu } } },
});

describe("runpod-client helpers", () => {
  it("builds the referral deploy link with our template + ref code", () => {
    expect(runpodDeployLink()).toBe("https://console.runpod.io/deploy?template=bnqtkvcer3&ref=dkx71w9b");
  });
  it("builds the pod proxy URL for ComfyUI's port", () => {
    expect(runpodProxyUrl("abc123")).toBe("https://abc123-3000.proxy.runpod.net");
  });
  it("detects an exposed ComfyUI http port", () => {
    const pod = { runtime: { ports: [{ privatePort: 3000, type: "http" }] } } as unknown as RunpodPod;
    expect(comfyuiPortExposed(pod)).toBe(true);
    expect(comfyuiPortExposed({ runtime: { ports: [{ privatePort: 22, type: "tcp" }] } } as unknown as RunpodPod)).toBe(false);
  });
});

describe("runpodGql auth + timeout", () => {
  it("sends the API key as an Authorization: Bearer header, NEVER in the URL", async () => {
    const fetchMock = vi.fn(async () => gqlResponse(emptyList));
    global.fetch = fetchMock as unknown as typeof fetch;
    const { listPods } = await import("../../services/runpod-client.js");
    await listPods();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).not.toContain("api_key");
    expect(String(url)).not.toContain("rp-test-key");
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer rp-test-key");
    // Hung-network protection: every request carries an abort signal.
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("createPod (GPU fallback + billing safety)", () => {
  it("returns the pod on the FIRST GPU type that has capacity", async () => {
    const { counts } = mockGql((b) => (b.query.includes("myself") ? emptyList : deployed("pod1")));
    const pod = await createPod();
    expect(pod.id).toBe("pod1");
    expect(pod.runtime).toBeNull(); // deploy returns no runtime yet
    expect(counts.deploys).toBe(1); // first GPU succeeded → no fallback
  });

  it("falls through to the NEXT GPU when RunPod explicitly reports no capacity", async () => {
    let deployCall = 0;
    const { counts } = mockGql((b) => {
      if (b.query.includes("myself")) return emptyList;
      deployCall++;
      if (deployCall === 1) return { errors: [{ message: "no instances available" }] };
      return deployed("pod2", "RTX A5000");
    });
    const pod = await createPod();
    expect(pod.id).toBe("pod2");
    expect(counts.deploys).toBe(2);
  });

  it("throws a descriptive error listing every GPU tried when all lack capacity", async () => {
    const { counts } = mockGql((b) =>
      b.query.includes("myself") ? emptyList : { errors: [{ message: "no capacity" }] },
    );
    await expect(createPod({ gpuTypeIds: ["GPU-A", "GPU-B"] })).rejects.toThrow(/GPU-A[\s\S]*GPU-B/);
    // 2 GPU types × 2 cloud types (COMMUNITY then SECURE) = 4 deploy attempts.
    expect(counts.deploys).toBe(4);
  });

  it("pins the cloud type when one is given (no SECURE fallback)", async () => {
    const { counts } = mockGql((b) =>
      b.query.includes("myself") ? emptyList : { errors: [{ message: "no capacity" }] },
    );
    await expect(createPod({ gpuTypeIds: ["GPU-A"], cloudType: "SECURE" })).rejects.toThrow(/SECURE\/GPU-A/);
    expect(counts.deploys).toBe(1);
  });

  it("sends our template id + community cloud + the ComfyUI port in the deploy input", async () => {
    const { fetchMock } = mockGql((b) => (b.query.includes("myself") ? emptyList : deployed("p", "A40")));
    await createPod({ gpuTypeIds: ["NVIDIA A40"] });
    const deployCall = fetchMock.mock.calls
      .map((c) => JSON.parse((c[1] as { body: string }).body))
      .find((b) => b.query.includes("podFindAndDeployOnDemand"));
    expect(deployCall.variables.input.templateId).toBe("bnqtkvcer3");
    expect(deployCall.variables.input.cloudType).toBe("COMMUNITY");
    expect(deployCall.variables.input.gpuTypeId).toBe("NVIDIA A40");
    // Deadman watchdog (default on) adds its heartbeat port (#269).
    expect(deployCall.variables.input.ports).toBe("3000/http,22/tcp,8189/http");
  });

  it("has sane default GPU types (24GB+ cards)", () => {
    expect(RUNPOD_DEFAULT_GPU_TYPES.length).toBeGreaterThan(0);
    expect(RUNPOD_DEFAULT_GPU_TYPES).toContain("NVIDIA GeForce RTX 4090");
  });

  // ── billing safety: a lost create response must NEVER create a second pod ──

  it("an AMBIGUOUS deploy failure where the pod actually EXISTS returns the existing pod (no second create)", async () => {
    // Sequence: list-before → [], deploy → network drop AFTER the pod was
    // created server-side, reconcile-list → the new pod appears.
    let deployAttempts = 0;
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse((init as { body: string }).body) as GqlBody;
      if (body.query.includes("podFindAndDeployOnDemand")) {
        deployAttempts++;
        throw new Error("socket hang up"); // response lost — pod fate unknown
      }
      // list-before is call 1 (empty); reconcile list returns the created pod.
      return gqlResponse(
        deployAttempts === 0 ? emptyList : listOf([{ id: "ghost-pod", name: "comfyui-mcp", desiredStatus: "RUNNING", costPerHr: 0.44, machine: null, runtime: null }]),
      );
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    // Explicit name → the shared-name reconcile path (the default name is now
    // unique per create; #276). reconcileCreatedPod matches on this name.
    const pod = await createPod({ gpuTypeIds: ["GPU-A", "GPU-B"], name: "comfyui-mcp" });
    expect(pod.id).toBe("ghost-pod"); // reconciled, not re-created
    expect(deployAttempts).toBe(1); // NEVER retried the billed mutation
  });

  it("an AMBIGUOUS deploy failure with NO pod found fails WITHOUT trying more GPU types", async () => {
    let deployAttempts = 0;
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse((init as { body: string }).body) as GqlBody;
      if (body.query.includes("podFindAndDeployOnDemand")) {
        deployAttempts++;
        throw new Error("socket hang up");
      }
      return gqlResponse(emptyList);
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    await expect(createPod({ gpuTypeIds: ["GPU-A", "GPU-B"] })).rejects.toThrow(/could not be confirmed|NOT retrying/i);
    expect(deployAttempts).toBe(1); // ambiguous → stop; do NOT try GPU-B or SECURE
  });

  it("an AMBIGUOUS failure with MULTIPLE new same-named pods fails closed (concurrent-create race)", async () => {
    // Pod NAME is not unique: a concurrent createPod for the same default name
    // races this one, so >1 new same-named pod may appear. We must NOT guess
    // which is ours (a wrong guess could auto-stop someone else's pod) → throw.
    // list-before must be empty so BOTH pods count as "new"; first call is the snapshot.
    let call = 0;
    global.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse((init as { body: string }).body) as GqlBody;
      if (body.query.includes("podFindAndDeployOnDemand")) throw new Error("socket hang up");
      const i = call++;
      return gqlResponse(
        i === 0
          ? emptyList
          : listOf([
              { id: "pod-a", name: "comfyui-mcp", desiredStatus: "RUNNING", costPerHr: 0.44, machine: null, runtime: null },
              { id: "pod-b", name: "comfyui-mcp", desiredStatus: "RUNNING", costPerHr: 0.44, machine: null, runtime: null },
            ]),
      );
    }) as unknown as typeof fetch;
    // Explicit shared name reproduces the concurrent same-name race (the default
    // is unique now, #276). Both pods carry this name → ambiguous, fail closed.
    await expect(createPod({ gpuTypeIds: ["GPU-A"], name: "comfyui-mcp" })).rejects.toThrow(/concurrent create|2 new pods|can't be determined/i);
  });

  it("reconciliation ignores same-named pods that existed BEFORE the call", async () => {
    // A pre-existing "comfyui-mcp" pod must not be mistaken for the one this
    // call may have created.
    const preExisting = { id: "old-pod", name: "comfyui-mcp", desiredStatus: "EXITED", costPerHr: 0, machine: null, runtime: null };
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse((init as { body: string }).body) as GqlBody;
      if (body.query.includes("podFindAndDeployOnDemand")) throw new Error("socket hang up");
      return gqlResponse(listOf([preExisting])); // same list before and after
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    await expect(createPod({ gpuTypeIds: ["GPU-A"], name: "comfyui-mcp" })).rejects.toThrow(/could not be confirmed|NOT retrying/i);
  });

  it("defaults to a UNIQUE deploy name so concurrent creates don't mis-attribute (#276)", async () => {
    const names: string[] = [];
    const { fetchMock } = mockGql((b) => {
      if (b.query.includes("podFindAndDeployOnDemand")) {
        const name = (b.variables.input as { name: string }).name;
        names.push(name);
        return { data: { podFindAndDeployOnDemand: { id: `p${names.length}`, name, desiredStatus: "RUNNING", costPerHr: 0.44, machine: null } } };
      }
      return emptyList;
    });
    await createPod({ gpuTypeIds: ["GPU-A"] });
    await createPod({ gpuTypeIds: ["GPU-A"] });
    expect(names).toHaveLength(2);
    // Neither is the bare shared default, and the two differ.
    expect(names[0]).not.toBe("comfyui-mcp");
    expect(names[0]).toMatch(/^comfyui-mcp-/);
    expect(names[0]).not.toBe(names[1]);
    void fetchMock;
  });

  it("classifies errors: capacity/quota are provably-not-created; network/HTTP are not", () => {
    expect(isProvablyNotCreatedError(new Error("There are no longer any instances available with the requested specifications."))).toBe(true);
    expect(isProvablyNotCreatedError(new Error("no capacity"))).toBe(true);
    expect(isProvablyNotCreatedError(new Error("quota exceeded"))).toBe(true);
    expect(isProvablyNotCreatedError(new Error("socket hang up"))).toBe(false);
    expect(isProvablyNotCreatedError(new Error("RunPod API HTTP 500"))).toBe(false);
    expect(isProvablyNotCreatedError(new Error("RunPod API request timed out after 10s"))).toBe(false);
    // CONSERVATIVE: an unrelated error that merely contains the words "there are
    // no" (e.g. a vague server message) must NOT be treated as safe-to-retry.
    expect(isProvablyNotCreatedError(new Error("there are no response details available"))).toBe(false);
    expect(isProvablyNotCreatedError(new Error("Internal error: there are no results"))).toBe(false);
    // CONSERVATIVE: "no capacity INFORMATION … status is unknown" is AMBIGUOUS —
    // it must NOT match the capacity-rejection pattern (that would trigger a
    // billed retry of a possibly-landed create).
    expect(
      isProvablyNotCreatedError(
        new Error("RunPod response contained no capacity information, so creation status is unknown."),
      ),
    ).toBe(false);
    expect(isProvablyNotCreatedError(new Error("insufficient capacity details returned"))).toBe(false);
    // Still TRUE for the real rejection phrasings.
    expect(isProvablyNotCreatedError(new Error("no capacity available for this GPU"))).toBe(true);
    expect(isProvablyNotCreatedError(new Error("insufficient capacity"))).toBe(true);
  });
});

describe("response validation (#269 — no more blind casts)", () => {
  const goodPod = {
    id: "pod1",
    name: "c",
    desiredStatus: "RUNNING",
    costPerHr: 0.4,
    machine: { gpuDisplayName: "RTX 4090" },
    runtime: {
      uptimeInSeconds: 60,
      ports: [{ ip: "1", isIpPublic: true, privatePort: 3000, publicPort: 3000, type: "http" }],
      gpus: [{ id: "g", gpuUtilPercent: 5, memoryUtilPercent: 10 }],
    },
  };

  it("accepts a well-formed pod (and ignores ADDITIVE new fields)", async () => {
    global.fetch = vi.fn(async () =>
      gqlResponse({ data: { pod: { ...goodPod, brandNewField: { nested: [1, 2] } } } }),
    ) as unknown as typeof fetch;
    const pod = await getPod("pod1");
    expect(pod?.id).toBe("pod1");
  });

  it("throws LOUDLY when a field we read changes shape (was: silent wrong values)", async () => {
    global.fetch = vi.fn(async () =>
      gqlResponse({ data: { pod: { ...goodPod, desiredStatus: { code: "RUNNING" } } } }),
    ) as unknown as typeof fetch;
    await expect(getPod("pod1")).rejects.toThrow(/unexpected shape.*getPod/);
  });

  it("throws when a required field vanishes (a null cast would have read as idle/exited)", async () => {
    const { desiredStatus: _omit, ...noStatus } = goodPod;
    global.fetch = vi.fn(async () => gqlResponse({ data: { pod: noStatus } })) as unknown as typeof fetch;
    await expect(getPod("pod1")).rejects.toThrow(/unexpected shape/);
  });

  it("throws when the pod PROPERTY is absent entirely (must never read as 'pod vanished')", async () => {
    global.fetch = vi.fn(async () => gqlResponse({ data: {} })) as unknown as typeof fetch;
    await expect(getPod("pod1")).rejects.toThrow(/unexpected shape/);
    // …while an EXPLICIT null is the legitimate "no such pod" answer.
    global.fetch = vi.fn(async () => gqlResponse({ data: { pod: null } })) as unknown as typeof fetch;
    await expect(getPod("pod1")).resolves.toBeNull();
  });

  it("accepts API-valid NULL telemetry (port fields, GPU readings are nullable in RunPod's schema)", async () => {
    global.fetch = vi.fn(async () =>
      gqlResponse({
        data: {
          pod: {
            ...goodPod,
            runtime: {
              uptimeInSeconds: null,
              ports: [{ ip: null, isIpPublic: null, privatePort: null, publicPort: null, type: null }],
              gpus: [{ id: null, gpuUtilPercent: null, memoryUtilPercent: null }],
            },
          },
        },
      }),
    ) as unknown as typeof fetch;
    const pod = await getPod("pod1");
    expect(pod?.runtime?.gpus?.[0]?.gpuUtilPercent).toBeNull();
  });

  it("an ABSENT deploy-result property is AMBIGUOUS — never a billed retry (codex r2)", async () => {
    let deployAttempts = 0;
    global.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse((init as { body: string }).body) as GqlBody;
      if (body.query.includes("podFindAndDeployOnDemand")) {
        deployAttempts++;
        return gqlResponse({ data: {} }); // shape change: property missing
      }
      return gqlResponse(emptyList);
    }) as unknown as typeof fetch;
    await expect(createPod({ gpuTypeIds: ["GPU-A", "GPU-B"], name: "x" })).rejects.toThrow(/could not be confirmed|unexpected shape|NOT retrying/i);
    expect(deployAttempts).toBe(1); // NO blind billed retry on a malformed response
  });
});

describe("deadman switch (#269)", () => {
  const deployInput = (fetchMock: ReturnType<typeof vi.fn>) =>
    fetchMock.mock.calls
      .map((c) => JSON.parse((c[1] as { body: string }).body))
      .find((b) => b.query.includes("podFindAndDeployOnDemand")).variables.input;

  it("derives a deterministic per-name token from the API key (no storage needed)", () => {
    expect(deadmanToken("pod-a")).toBe(deadmanToken("pod-a"));
    expect(deadmanToken("pod-a")).not.toBe(deadmanToken("pod-b"));
    expect(deadmanToken("pod-a")).toMatch(/^[0-9a-f]{64}$/);
    expect(deadmanToken("pod-a")).not.toContain("rp-test-key"); // derived, never the raw key
  });

  it("injects the watchdog token + grace + heartbeat port by default — and NEVER the account key", async () => {
    const { fetchMock } = mockGql((b) => (b.query.includes("myself") ? emptyList : deployed("pod1")));
    await createPod({ gpuTypeIds: ["GPU-A"], name: "dm-pod" });
    const input = deployInput(fetchMock);
    expect(input.ports).toContain(`${RUNPOD_DEADMAN_PORT}/http`);
    const env = Object.fromEntries((input.env as Array<{ key: string; value: string }>).map((e) => [e.key, e.value]));
    // The watchdog self-stops with RunPod's auto-injected POD-SCOPED key —
    // the owner's account-wide key must never leave this process (codex r2).
    expect(env.RUNPOD_API_KEY).toBeUndefined();
    expect(env.DEADMAN_TOKEN).toBe(deadmanToken("dm-pod"));
    expect(Number(env.DEADMAN_BOOT_GRACE_S)).toBeGreaterThanOrEqual(60);
    expect(Number(env.DEADMAN_BEAT_GRACE_S)).toBeGreaterThanOrEqual(60);
  });

  it("deadman:false deploys WITHOUT the watchdog token/grace env or heartbeat port", async () => {
    const { fetchMock } = mockGql((b) => (b.query.includes("myself") ? emptyList : deployed("pod1")));
    await createPod({ gpuTypeIds: ["GPU-A"], name: "plain-pod", deadman: false });
    const input = deployInput(fetchMock);
    expect(input.ports).toBe("3000/http,22/tcp");
    expect(input.env ?? []).toHaveLength(0);
  });

  it("a custom template is NOT armed by default (unverified image may lack the watchdog)", async () => {
    const { fetchMock } = mockGql((b) => (b.query.includes("myself") ? emptyList : deployed("pod1")));
    await createPod({ gpuTypeIds: ["GPU-A"], name: "custom-tpl-pod", templateId: "some-other-template" });
    const input = deployInput(fetchMock);
    expect(input.templateId).toBe("some-other-template");
    expect(input.ports).toBe("3000/http,22/tcp");
    const keys = ((input.env ?? []) as Array<{ key: string }>).map((e) => e.key);
    expect(keys).not.toContain("RUNPOD_API_KEY");
    expect(keys).not.toContain("DEADMAN_TOKEN");
  });

  it("a custom template CAN be armed explicitly with deadman:true (caller asserts the image ships the watchdog)", async () => {
    const { fetchMock } = mockGql((b) => (b.query.includes("myself") ? emptyList : deployed("pod1")));
    await createPod({ gpuTypeIds: ["GPU-A"], name: "custom-tpl-armed", templateId: "my-rebuild", deadman: true });
    const input = deployInput(fetchMock);
    expect(input.ports).toContain("8189/http");
    const env = Object.fromEntries((input.env as Array<{ key: string; value: string }>).map((e) => [e.key, e.value]));
    expect(env.DEADMAN_TOKEN).toBe(deadmanToken("custom-tpl-armed"));
  });

  it("beatDeadman heartbeats the pod's proxy URL with the derived token", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true }) as Response);
    global.fetch = fetchMock as unknown as typeof fetch;
    const ok = await beatDeadman({ id: "abc123", name: "dm-pod" });
    expect(ok).toBe(true);
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toBe(`https://abc123-${RUNPOD_DEADMAN_PORT}.proxy.runpod.net/heartbeat?token=${deadmanToken("dm-pod")}`);
  });

  it("beatDeadman is best-effort: network failure / missing name → false, never throws", async () => {
    global.fetch = vi.fn(async () => {
      throw new Error("dns");
    }) as unknown as typeof fetch;
    await expect(beatDeadman({ id: "abc123", name: "dm-pod" })).resolves.toBe(false);
    await expect(beatDeadman({ id: "abc123", name: null })).resolves.toBe(false);
  });
});

// ── #2014 / #2016 — the stock image's deploy floors ──────────────────────────
// Both defects shipped a pod that RunPod created and BILLED and that never
// became usable (desiredStatus RUNNING, `runtime` null, no ports). They are
// independent — an undersized container disk and an unconstrained CUDA host —
// so they keep independent tests.
const deployInputs = (fetchMock: ReturnType<typeof vi.fn>) =>
  fetchMock.mock.calls
    .map((c) => JSON.parse((c[1] as { body: string }).body))
    .filter((b) => b.query.includes("podFindAndDeployOnDemand"))
    .map((b) => b.variables.input as Record<string, unknown>);
const firstDeployInput = (fetchMock: ReturnType<typeof vi.fn>) => deployInputs(fetchMock)[0];

describe("#2014 — stock deploys get the container disk the image documents", () => {
  it("sends 30 GB on the stock template (docker/runpod/README.md requires >= 30 GB)", async () => {
    const { fetchMock } = mockGql((b) => (b.query.includes("myself") ? emptyList : deployed("pod1")));
    await createPod({ gpuTypeIds: ["GPU-A"], name: "disk-stock" });
    // The literal floor, NOT a value recomputed from the code under test — an
    // assertion derived from the constant would move with a mutation of it.
    expect(firstDeployInput(fetchMock).containerDiskInGb).toBe(30);
    expect(RUNPOD_STOCK_CONTAINER_DISK_GB).toBe(30);
  });

  it("leaves a CUSTOM template on the pre-#2014 default — we cannot size an image we did not build", async () => {
    const { fetchMock } = mockGql((b) => (b.query.includes("myself") ? emptyList : deployed("pod1")));
    await createPod({ gpuTypeIds: ["GPU-A"], name: "disk-custom", templateId: "some-other-template" });
    expect(firstDeployInput(fetchMock).containerDiskInGb).toBe(20);
  });

  it("an explicit containerDiskInGb still wins on the stock template", async () => {
    const { fetchMock } = mockGql((b) => (b.query.includes("myself") ? emptyList : deployed("pod1")));
    await createPod({ gpuTypeIds: ["GPU-A"], name: "disk-explicit", containerDiskInGb: 50 });
    expect(firstDeployInput(fetchMock).containerDiskInGb).toBe(50);
  });
});

describe("#2016 — stock deploys pin the host CUDA version", () => {
  it("sends allowedCudaVersions covering 12.8+ and NOTHING below the image's floor", async () => {
    const { fetchMock } = mockGql((b) => (b.query.includes("myself") ? emptyList : deployed("pod1")));
    await createPod({ gpuTypeIds: ["GPU-A"], name: "cuda-stock" });
    const sent = firstDeployInput(fetchMock).allowedCudaVersions as string[];
    expect(sent).toContain("12.8"); // driver >= 570 == CUDA 12.8 (Dockerfile MIN_DRIVER_DEFAULT)
    // The incident host was CUDA 12.6; every version below the floor must be absent.
    for (const bad of ["11.8", "12.0", "12.4", "12.6", "12.7"]) expect(sent).not.toContain(bad);
    // Over-narrow is the dangerous direction: a list matching no host makes the
    // pod unschedulable. Newer CUDA than we knew about at build time must pass.
    for (const good of ["12.9", "13.0", "13.5", "14.0"]) expect(sent).toContain(good);
  });

  it("sends NO CUDA filter for a CUSTOM template — its image may need a different one", async () => {
    const { fetchMock } = mockGql((b) => (b.query.includes("myself") ? emptyList : deployed("pod1")));
    await createPod({ gpuTypeIds: ["GPU-A"], name: "cuda-custom", templateId: "some-other-template" });
    expect(firstDeployInput(fetchMock)).not.toHaveProperty("allowedCudaVersions");
  });

  it("an explicit list wins, and [] OMITS the field entirely (never sends an empty allow-list)", async () => {
    const { fetchMock } = mockGql((b) => (b.query.includes("myself") ? emptyList : deployed("pod1")));
    await createPod({ gpuTypeIds: ["GPU-A"], name: "cuda-explicit", allowedCudaVersions: ["12.8", "12.9"] });
    expect(firstDeployInput(fetchMock).allowedCudaVersions).toEqual(["12.8", "12.9"]);

    const { fetchMock: fm2 } = mockGql((b) => (b.query.includes("myself") ? emptyList : deployed("pod2")));
    await createPod({ gpuTypeIds: ["GPU-A"], name: "cuda-none", allowedCudaVersions: [] });
    // `allowedCudaVersions: []` would match NO host — worse than no filter.
    expect(firstDeployInput(fm2)).not.toHaveProperty("allowedCudaVersions");
  });

  it("RUNPOD_ALLOWED_CUDA_VERSIONS overrides the built-in list (escape hatch for a fleet we guessed wrong)", async () => {
    vi.resetModules();
    process.env.RUNPOD_ALLOWED_CUDA_VERSIONS = "12.8, 12.9";
    try {
      const mod = await import("../../services/runpod-client.js");
      const { fetchMock } = mockGql((b) => (b.query.includes("myself") ? emptyList : deployed("pod1")));
      await mod.createPod({ gpuTypeIds: ["GPU-A"], name: "cuda-env" });
      expect(firstDeployInput(fetchMock).allowedCudaVersions).toEqual(["12.8", "12.9"]);
    } finally {
      delete process.env.RUNPOD_ALLOWED_CUDA_VERSIONS;
      vi.resetModules();
    }
  });

  it("an EMPTY RUNPOD_ALLOWED_CUDA_VERSIONS disables the filter (opt out without editing code)", async () => {
    vi.resetModules();
    process.env.RUNPOD_ALLOWED_CUDA_VERSIONS = "";
    try {
      const mod = await import("../../services/runpod-client.js");
      const { fetchMock } = mockGql((b) => (b.query.includes("myself") ? emptyList : deployed("pod1")));
      await mod.createPod({ gpuTypeIds: ["GPU-A"], name: "cuda-env-off" });
      expect(firstDeployInput(fetchMock)).not.toHaveProperty("allowedCudaVersions");
    } finally {
      delete process.env.RUNPOD_ALLOWED_CUDA_VERSIONS;
      vi.resetModules();
    }
  });

  it("names the CUDA filter when every slot came back empty (unschedulable is not a capacity crunch)", async () => {
    mockGql((b) => (b.query.includes("myself") ? emptyList : { errors: [{ message: "no capacity" }] }));
    await expect(createPod({ gpuTypeIds: ["GPU-A"], name: "cuda-starved" })).rejects.toThrow(
      /RUNPOD_ALLOWED_CUDA_VERSIONS/,
    );
  });

  it("sends NO CUDA filter on resume — PodResumeInput has no such field (#2016)", async () => {
    // Probed against the live api.runpod.io schema on 2026-08-21 (wrong-typed
    // podId, so coercion failed and the resolver never ran): every candidate
    // name — allowedCudaVersions, cudaVersion, cudaVersions, allowedCudaVersion,
    // minCudaVersion — came back `is not defined by type "PodResumeInput"`,
    // while the known field gpuCount drew no such error. runpod-python agrees.
    // docs.runpod.io shows a podResume example WITH allowedCudaVersions; that
    // example is wrong, and adopting it turns every runpod action:"start" into
    // a GraphQL validation failure. This test is the guard against that.
    const { fetchMock } = mockGql(() => ({ data: { podResume: { id: "pod1", desiredStatus: "RUNNING" } } }));
    await resumePod("pod1", 1);
    const input = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body).variables.input;
    expect(input).toEqual({ podId: "pod1", gpuCount: 1 });
    for (const k of Object.keys(input)) expect(k.toLowerCase()).not.toContain("cuda");
  });
});

describe("#2014/#2016 wiring — EVERY deploy attempt adopts the floors, not just the first", () => {
  it("applies both floors on every GPU x cloud slot the fallback loop tries", async () => {
    // The fallback loop calls deployOnce once per (cloudType x gpuType). A fix
    // applied at one call site only would pass a spot-check of attempt #1 and
    // still ship an undersized/unconstrained pod on the slot that wins.
    const gpuTypeIds = ["GPU-A", "GPU-B", "GPU-C"];
    const { fetchMock } = mockGql((b) =>
      b.query.includes("myself") ? emptyList : { errors: [{ message: "no capacity" }] },
    );
    await expect(createPod({ gpuTypeIds, name: "wiring" })).rejects.toThrow();
    const inputs = deployInputs(fetchMock);
    // 3 GPU types x 2 cloud types — count the ADOPTING sites, never spot-check one.
    expect(inputs).toHaveLength(gpuTypeIds.length * 2);
    const adoptingDisk = inputs.filter((i) => i.containerDiskInGb === 30);
    const adoptingCuda = inputs.filter((i) => (i.allowedCudaVersions as string[] | undefined)?.includes("12.8"));
    expect(adoptingDisk).toHaveLength(inputs.length);
    expect(adoptingCuda).toHaveLength(inputs.length);
  });

  it("only ONE code path issues podFindAndDeployOnDemand — a second must be wired too", async () => {
    // Behavioural coverage above rides on createPod being the sole deploy path.
    // If someone adds another, this fails and forces them to extend that test
    // rather than silently shipping a deploy that skips both floors.
    const src = await readFile(new URL("../../services/runpod-client.ts", import.meta.url), "utf8");
    const deployMutations = src.match(/podFindAndDeployOnDemand\s*\(/g) ?? [];
    expect(deployMutations).toHaveLength(1);
  });
});
