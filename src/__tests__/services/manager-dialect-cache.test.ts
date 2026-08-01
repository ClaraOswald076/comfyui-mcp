import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as perfHooks from "node:perf_hooks";

// Regression for #646: detectManagerApi() cached the detected ComfyUI-Manager
// wire dialect keyed ONLY by base URL, for the whole process lifetime. After the
// user upgraded Manager 3.x → pip comfyui_manager 4.2.2 and restarted ComfyUI at
// the SAME URL, every later Manager call kept speaking the PRE-restart dialect:
// download_model routed through the v2-batch/legacy-UI path and failed with
// "400 Bad Request for /v2/manager/queue/install_model … LEGACY-UI mode" against
// a server that was demonstrably a normal Manager 4.2.2.
//
// Three self-healing mechanisms are asserted here:
//   1. explicit invalidation on the restart lifecycle (resetManagerApiCache(),
//      which process-control / the panel restart tools call alongside
//      resetObjectInfoCache());
//   2. a TTL backstop for an OUT-OF-BAND restart that no mcp tool observed
//      (mirrors the /object_info TTL added for the same class of bug in #528);
//   3. per-call self-heal — a pre-execution rejection re-probes ONCE and retries
//      the enqueue only when the live dialect actually changed.

// The TTL is read once at module load, so it must be set BEFORE the imports.
// Stash the caller's value and restore it after the suite: the variable is
// process-wide, and a worker that later loads another suite must not inherit it.
const PRIOR_TTL_ENV = process.env.COMFYUI_MCP_MANAGER_API_TTL_MS;
process.env.COMFYUI_MCP_MANAGER_API_TTL_MS = "5000";

vi.mock("../../config.js", () => {
  const config = {
    comfyuiPath: "/fake/comfy",
    resolvedPort: 8188,
    comfyuiHost: "127.0.0.1",
    comfyuiSsl: false,
    githubToken: undefined as string | undefined,
  };
  return {
    config,
    getComfyUIBaseUrl: () => "http://127.0.0.1:8188",
    getComfyUIAuthHeaders: () => ({}),
    // node-management's Manager self-update path (#424) imports this; the mock
    // must provide it or the named import fails at load.
    isLoopbackHost: (host?: string) => host === "127.0.0.1" || host === "localhost",
  };
});

// node-management pulls in comfy-cli → workspace-env, which calls
// promisify(execFile) at module load; keep the subprocess surface inert.
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
  execFileSync: vi.fn(),
  spawnSync: vi.fn(() => ({ status: 0, stdout: "{}", stderr: "" })),
}));
vi.mock("node:fs", () => ({ existsSync: vi.fn(() => true) }));

const {
  installModelViaManager,
  updateCustomNode,
  setQueueTimingForTests,
  resetManagerApiCacheForTests,
} = await import("../../services/node-management.js");
const { resetManagerApiCache, cacheManagerApi, getCachedManagerApi, managerApiEpoch } =
  await import("../../services/manager-api-cache.js");

const BASE = "http://127.0.0.1:8188";

interface Call {
  path: string;
  method: string;
  body: unknown;
}

/** Which Manager the (single, unchanging) URL is currently serving. */
type Persona = "v2-batch" | "v4" | "legacy";

const DRAINED = { total_count: 1, done_count: 1, in_progress_count: 0, is_processing: false };

function jsonResponse(obj: unknown): Response {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * One ComfyUI at ONE URL whose Manager persona can be swapped mid-test — exactly
 * what an in-place Manager upgrade + restart looks like from our side.
 *
 *   "v2-batch" = pip Manager in legacy-UI mode: is_legacy_manager_ui true, the
 *                3.x routes (queue/batch, queue/install_model) answer, and the
 *                unified task route does not exist.
 *   "v4"       = normal pip Manager 4.2.2: is_legacy_manager_ui false, the
 *                unified task route answers, and the 3.x-shaped install_model
 *                body is rejected 400 by Pydantic validation (the #646 report),
 *                while the unregistered batch route 405s via ComfyUI's catchall.
 */
function stubServer(opts: {
  persona: () => Persona;
  /** Gate resolution of the is_legacy_manager_ui probe (in-flight-race tests). */
  legacyUiGate?: () => Promise<void>;
  /** Override the response for the unified task route. */
  taskStatus?: () => number;
}) {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    const path = new URL(url).pathname;
    calls.push({ path, method, body });

    if (opts.persona() === "legacy") {
      // The 3.x custom-node Manager: no /v2/* at all (ComfyUI's frontend catchall
      // 405s an unregistered POST), per-operation routes under /manager/*.
      if (path === "/manager/queue/status") return jsonResponse(DRAINED);
      if (path === "/manager/version") return new Response("V3.41", { status: 200 });
      if (path.startsWith("/manager/queue/")) return new Response("", { status: 200 });
      return new Response("404: Not Found", { status: 404 });
    }

    if (path === "/v2/manager/queue/status") return jsonResponse(DRAINED);
    if (path === "/v2/manager/queue/start") return new Response("", { status: 200 });
    if (path === "/v2/manager/queue/update_all") return new Response("", { status: 200 });
    if (path === "/v2/manager/is_legacy_manager_ui") {
      if (opts.legacyUiGate) await opts.legacyUiGate();
      return jsonResponse({ is_legacy_manager_ui: opts.persona() === "v2-batch" });
    }

    if (opts.persona() === "v2-batch") {
      if (path === "/v2/manager/queue/install_model") return new Response("", { status: 200 });
      if (path === "/v2/manager/queue/batch") return jsonResponse({ failed: [] });
      // The unified task route does not exist on the bundled 3.x server.
      if (path === "/v2/manager/queue/task") return new Response("405", { status: 405 });
    } else {
      if (path === "/v2/manager/queue/task") {
        const status = opts.taskStatus?.() ?? 200;
        return new Response(status === 200 ? "" : String(status), { status });
      }
      // v4 registers install_model but validates a ModelMetadata envelope — the
      // 3.x-shaped body the v2-batch dialect sends is rejected 400 (#646).
      if (path === "/v2/manager/queue/install_model") {
        return new Response("400: Bad Request", { status: 400 });
      }
      if (path === "/v2/manager/queue/batch") return new Response("405", { status: 405 });
    }
    return new Response("", { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

const countOf = (calls: Call[], path: string, method = "POST"): number =>
  calls.filter((c) => c.path === path && c.method === method).length;
/** Each completed detection probes is_legacy_manager_ui exactly once. */
const detections = (calls: Call[]): number =>
  calls.filter((c) => c.path === "/v2/manager/is_legacy_manager_ui").length;

const downloadAModel = () =>
  installModelViaManager({
    name: "model.safetensors",
    url: "https://huggingface.co/foo/model.safetensors",
    filename: "model.safetensors",
    type: "checkpoints",
  });

// Controllable clocks. The freshness window is measured on the MONOTONIC clock
// (performance.now) while the queue-drain loop reads the wall clock (Date.now),
// and real timers must keep working (the drain sleeps) — so shift both sources by
// their own offset rather than switching to fake timers. Keeping them separate is
// what lets a test step the WALL clock backward while real time keeps elapsing.
let monotonicOffset = 0;
let wallOffset = 0;
const realNow = Date.now;
const realPerfNow = perfHooks.performance.now.bind(perfHooks.performance);
/** Real time passes (both clocks advance together). */
const elapse = (ms: number): void => {
  monotonicOffset += ms;
  wallOffset += ms;
};

describe("#646 Manager API dialect cache invalidation", () => {
  beforeEach(() => {
    monotonicOffset = 0;
    wallOffset = 0;
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + wallOffset);
    vi.spyOn(perfHooks.performance, "now").mockImplementation(
      () => realPerfNow() + monotonicOffset,
    );
    resetManagerApiCacheForTests();
    setQueueTimingForTests({ pollIntervalMs: 1, startupGraceMs: 0, timeoutMs: 5000 });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  afterAll(() => {
    if (PRIOR_TTL_ENV === undefined) delete process.env.COMFYUI_MCP_MANAGER_API_TTL_MS;
    else process.env.COMFYUI_MCP_MANAGER_API_TTL_MS = PRIOR_TTL_ENV;
  });

  it("re-detects after a restart at the SAME url (explicit invalidation)", async () => {
    let persona: Persona = "v2-batch";
    const calls = stubServer({ persona: () => persona });

    // 1. Legacy-UI Manager: the model install goes through the 3.x route.
    await downloadAModel();
    expect(countOf(calls, "/v2/manager/queue/install_model")).toBe(1);
    expect(countOf(calls, "/v2/manager/queue/task")).toBe(0);

    // 2. The user upgrades Manager and restarts ComfyUI on the SAME url. The
    //    restart lifecycle (process-control / the panel restart tools) drops the
    //    live-derived caches, the dialect among them.
    persona = "v4";
    resetManagerApiCache("comfyui restarted");

    // 3. The next Manager call re-probes and speaks v4 — no stale legacy-UI
    //    routing, no arbitrary-URL rejection.
    await downloadAModel();
    expect(countOf(calls, "/v2/manager/queue/task")).toBe(1);
    // The stale 3.x route was NOT attempted again.
    expect(countOf(calls, "/v2/manager/queue/install_model")).toBe(1);
  });

  it("serves the cached dialect within the freshness window (no per-call re-probe)", async () => {
    const calls = stubServer({ persona: () => "v2-batch" });
    await downloadAModel();
    expect(detections(calls)).toBe(1);

    elapse(4_000); // still inside the 5 s window
    await downloadAModel();
    expect(detections(calls)).toBe(1);
  });

  it("re-detects once the TTL lapses (OUT-OF-BAND restart, no mcp tool involved)", async () => {
    let persona: Persona = "v2-batch";
    const calls = stubServer({ persona: () => persona });

    await downloadAModel();
    expect(countOf(calls, "/v2/manager/queue/install_model")).toBe(1);

    // The user restarts ComfyUI themselves after upgrading Manager: nothing in
    // this process observed it, so no explicit invalidation ever fires.
    persona = "v4";
    elapse(6_000); // > the 5 s TTL

    await downloadAModel();
    // Re-probed and routed to the unified v4 envelope on the FIRST attempt —
    // the stale 3.x route was never touched again.
    expect(detections(calls)).toBe(2);
    expect(countOf(calls, "/v2/manager/queue/task")).toBe(1);
    expect(countOf(calls, "/v2/manager/queue/install_model")).toBe(1);
  });

  it("a backward wall-clock step neither extends nor resurrects the window", async () => {
    let persona: Persona = "v2-batch";
    const calls = stubServer({ persona: () => persona });

    await downloadAModel();
    expect(detections(calls)).toBe(1);

    // The wall clock is stepped BACK an hour (NTP step / VM snapshot restore)
    // while real time keeps running. Wall-clock arithmetic would read the age as
    // hugely negative here and, worse, read it as ~0 ("fresh") again once wall
    // time caught back up — so a Date.now()-based window could serve the
    // pre-restart dialect for another full TTL after a real restart.
    wallOffset -= 3_600_000;
    persona = "v4";

    // Only 4 s of REAL time has passed: still inside the window, still cached.
    elapse(4_000);
    expect(getCachedManagerApi(BASE)).toBe("v2-batch");

    // Past the window in REAL time — expired regardless of where the wall clock
    // sits, and the next call re-probes and speaks the live dialect.
    elapse(2_000);
    expect(getCachedManagerApi(BASE)).toBeUndefined();
    await downloadAModel();
    expect(detections(calls)).toBe(2);
    expect(countOf(calls, "/v2/manager/queue/task")).toBe(1);

    // And the wall clock catching back up cannot revive the (already re-stamped)
    // entry: freshness never depends on wall-clock arithmetic.
    wallOffset += 3_600_000;
    expect(getCachedManagerApi(BASE)).toBe("v2");
    elapse(6_000);
    expect(getCachedManagerApi(BASE)).toBeUndefined();
  });

  it("self-heals a stale entry: one re-detect, one retry, no duplicate enqueue", async () => {
    let persona: Persona = "v2-batch";
    const calls = stubServer({ persona: () => persona });

    // Pin the legacy-UI dialect, then swap the server underneath it WITHOUT any
    // restart signal and INSIDE the freshness window — the wedge from #646.
    await downloadAModel();
    persona = "v4";
    calls.length = 0;

    await expect(downloadAModel()).resolves.toMatchObject({ mechanism: "manager-http" });

    // Attempt 1 spoke the stale dialect and was rejected 400 BEFORE anything was
    // enqueued; one re-probe proved the dialect changed; attempt 2 succeeded.
    expect(countOf(calls, "/v2/manager/queue/install_model")).toBe(1);
    expect(detections(calls)).toBe(1);
    // Exactly ONE task enqueued — the retry must not double-submit the install.
    expect(countOf(calls, "/v2/manager/queue/task")).toBe(1);
  });

  it("heals update_all too (its dedicated route bypasses queueManagerTask)", async () => {
    let persona: Persona = "v4";
    const calls = stubServer({ persona: () => persona });

    await updateCustomNode({ id: "all" });
    expect(countOf(calls, "/v2/manager/queue/update_all")).toBe(1);

    // Same URL, now serving the 3.x custom-node Manager (a downgrade/rollback is
    // the mirror of the reported upgrade), still inside the freshness window.
    persona = "legacy";
    calls.length = 0;

    await expect(updateCustomNode({ id: "all" })).resolves.toMatchObject({
      mechanism: "manager-http",
    });
    // One rejected attempt on the stale prefix, one retry on the live one …
    expect(countOf(calls, "/v2/manager/queue/update_all")).toBe(1);
    expect(countOf(calls, "/manager/queue/update_all")).toBe(1);
    // … and the queue is started (drained) exactly once, on the live prefix.
    expect(countOf(calls, "/manager/queue/start")).toBe(1);
    expect(countOf(calls, "/v2/manager/queue/start")).toBe(0);
  });

  it("does NOT re-detect or retry on an unrelated failure (403 security gating)", async () => {
    const calls = stubServer({ persona: () => "v4", taskStatus: () => 403 });

    await expect(downloadAModel()).rejects.toThrow(/403/);

    // A 403 is a permission verdict from a route that exists — not a dialect
    // signal. No re-probe storm, no retry of the mutation.
    expect(detections(calls)).toBe(1);
    expect(countOf(calls, "/v2/manager/queue/task")).toBe(1);
  });

  it("re-detects at most once on a genuine 400, and does NOT retry when the dialect is unchanged", async () => {
    const calls = stubServer({ persona: () => "v4", taskStatus: () => 400 });

    await expect(downloadAModel()).rejects.toThrow(/400/);

    // The 400 could have been a stale dialect, so one re-probe is spent proving
    // otherwise — but the dialect is unchanged, so the enqueue is NOT repeated
    // and the caller's original error surfaces.
    expect(detections(calls)).toBe(2);
    expect(countOf(calls, "/v2/manager/queue/task")).toBe(1);

    // The re-probe re-populated the cache, so a second failing call costs one
    // more re-probe at most — it never degrades into per-call re-detection.
    calls.length = 0;
    await expect(downloadAModel()).rejects.toThrow(/400/);
    expect(detections(calls)).toBe(1);
  });

  it("drops a detection that completed across an invalidation (in-flight restart)", async () => {
    // Direct check of the epoch guard the async detection path relies on.
    const startEpoch = managerApiEpoch();
    resetManagerApiCache("comfyui restarted mid-detection");
    cacheManagerApi(BASE, "v2-batch", startEpoch);
    expect(getCachedManagerApi(BASE)).toBeUndefined();
    // A detection that started AFTER the reset still pins normally.
    cacheManagerApi(BASE, "v2-batch", managerApiEpoch());
    expect(getCachedManagerApi(BASE)).toBe("v2-batch");
  });

  it("a restart during an in-flight detection does not re-pin the pre-restart dialect", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let gated = true;
    const calls = stubServer({
      persona: () => "v2-batch",
      legacyUiGate: async () => {
        if (gated) await gate;
      },
    });

    // Park the detection mid-probe …
    const inflight = downloadAModel();
    while (!calls.some((c) => c.path === "/v2/manager/is_legacy_manager_ui")) {
      await new Promise((r) => setTimeout(r, 1));
    }
    // … then restart ComfyUI underneath it and let the probe answer.
    resetManagerApiCache("comfyui restarted mid-detection");
    gated = false;
    release();
    await inflight;

    // The parked detection concluded AFTER the invalidation, so its verdict
    // described a server that may no longer be there and must NOT be pinned over
    // the reset. The very next detection inside this same operation (the queue
    // drain resolves the route prefix) therefore has to probe again: two
    // detections, not one. Without the epoch guard the stale verdict would have
    // been re-pinned and the second detection served from cache.
    expect(detections(calls)).toBe(2);
  });
});
