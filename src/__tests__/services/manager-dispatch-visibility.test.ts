// #1374 — A COMFYUI-MANAGER DISPATCH IS ASKED ABOUT, NOT ASSUMED.
//
// The recurrence that motivated this: a Linux install whose ComfyUI-Manager
// REFUSED the fetch outright (security_level / network_mode=personal_cloud).
// `download_model action:"status"` reported the 13.2 GB job `done`; the target
// directory and a filesystem-wide search found no file.
//
// The mechanism is not a mystery and the code already said so in prose: a
// Manager job settles when the Manager QUEUE DRAINS, and Manager increments its
// done counter for a rejected item exactly as for a fetched one — the v2 status
// endpoint carries aggregate counts only, with no per-item result. So the drain
// is not evidence, and nothing ever looked for evidence that was.
//
// `verifyManagerVisibility` (#1086) is that evidence and already existed: it asks
// the CONNECTED server whether it now lists the entry, which is answerable
// remotely where `verifyLandedModel`'s on-disk stat is not. This pins that it now
// runs on the Manager route, that its baseline is captured, and — just as
// importantly — the two things it must NOT do.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const hoisted = vi.hoisted(() => ({
  /** Resolves the mocked downloadModel, standing in for the Manager dispatch
   *  returning once its queue drained. Never a real transfer. */
  resolveDispatch: undefined as ((s: string) => void) | undefined,
  /** What the server answers BEFORE the dispatch (the baseline), and what it
   *  answers AFTER. They are separate on purpose: with one value, "the file
   *  appeared" and "the file was always there" are the same fixture, and the
   *  `listedBefore` guard this suite exists to pin becomes untestable. undefined
   *  = could not be asked. */
  baseline: undefined as boolean | undefined,
  after: undefined as boolean | undefined,
  /** Every (subfolder, filename) the listing probe was asked about, in order —
   *  so a test can prove the BASELINE was taken before the dispatch. */
  probed: [] as Array<{ sub: string; name: string }>,
  visibilityCalls: 0,
  landedCalls: 0,
  remote: true,
}));

vi.mock("../../config.js", async () => {
  const actual = await vi.importActual<typeof import("../../config.js")>("../../config.js");
  return { ...actual, isRemoteMode: () => hoisted.remote };
});

vi.mock("../../services/model-resolver.js", async () => {
  // The REAL verifyManagerVisibility, driven by an injected probe. Using the real
  // one is the point: a hand-written stub would let this suite pass while the
  // shipped verdict logic (including its `listedBefore` guard) did something else.
  const actual = await vi.importActual<typeof import("../../services/model-resolver.js")>(
    "../../services/model-resolver.js",
  );
  return {
    shouldDispatchDownloadToManager: vi.fn(async () => hoisted.remote),
    downloadModel: vi.fn(
      () =>
        new Promise<string>((resolve) => {
          hoisted.resolveDispatch = resolve;
        }),
    ),
    resolveDownloadTarget: vi.fn(async (_u: string, sub: string, filename?: string) => ({
      targetDir: `/M/${sub}`,
      filename: filename ?? "model.safetensors",
      targetPath: `/M/${sub}/${filename ?? "model.safetensors"}`,
    })),
    liveListingHasEntry: vi.fn(async (sub: string, name: string) => {
      hoisted.probed.push({ sub, name });
      return hoisted.baseline;
    }),
    managerJobFilename: actual.managerJobFilename,
    verifyManagerVisibility: vi.fn(
      async (sub: string, name: string, opts?: Record<string, unknown>) => {
        hoisted.visibilityCalls += 1;
        return actual.verifyManagerVisibility(sub, name, {
          ...opts,
          attempts: 1,
          retryMs: 0,
          probe: async () => hoisted.after,
        });
      },
    ),
    verifyLandedModel: vi.fn(async (targetPath: string) => {
      hoisted.landedCalls += 1;
      return { verifiedPath: targetPath, liveVisible: "unknown" as const, note: "n/a" };
    }),
  };
});

import {
  startDownloadJob,
  getDownloadJob,
  resetDownloadJobs,
  describePlacement,
  type DownloadJob,
} from "../../services/download-jobs.js";


const URL_ = "https://huggingface.co/org/repo/resolve/main/te.safetensors";
const SUB = "text_encoders";
const NAME = "te.safetensors";

/** Run one Manager-routed download to completion and return the settled job. */
async function runManagerDownload(): Promise<DownloadJob> {
  const started = await startDownloadJob(URL_, SUB, NAME);
  // The dispatch "returns" the descriptor string the Manager route produces.
  hoisted.resolveDispatch?.(`${SUB}/${NAME} (dispatched via ComfyUI-Manager)`);
  await started.settled;
  const job = getDownloadJob(started.job.id);
  if (!job) throw new Error("job vanished");
  return job;
}

beforeEach(() => {
  resetDownloadJobs();
  hoisted.resolveDispatch = undefined;
  hoisted.baseline = undefined;
  hoisted.after = undefined;
  hoisted.probed = [];
  hoisted.visibilityCalls = 0;
  hoisted.landedCalls = 0;
  hoisted.remote = true;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("#1374 — a drained Manager queue is not evidence the file landed", () => {
  it("records NOT-VISIBLE when the connected server does not list the file", async () => {
    hoisted.baseline = false;
    hoisted.after = false;

    const job = await runManagerDownload();

    expect(job.viaManager).toBe(true);
    expect(job.live_visible).toBe("not-visible");
    expect(job.verify_note).toMatch(/does NOT list/);

    // And the RENDERER turns that into a positive finding, which is what
    // `action:"status"` prints. Before this, every Manager outcome printed one
    // static caveat and the reporter read `done`.
    const r = describePlacement(job);
    expect(r.confirmed).toBe(false);
    expect(r.wrongPlace).toBe(true);
    expect(r.warning).toMatch(/does NOT list/);
    // Names the cause the reporter actually hit, so the next one does not have to
    // discover it.
    expect(r.warning).toMatch(/security_level/);
  });

  it("records VISIBLE when the server lists it — and still refuses to call it confirmed", async () => {
    // Not there before, there after — the only shape that credits a landing to
    // THIS dispatch.
    hoisted.baseline = false;
    hoisted.after = true;

    const job = await runManagerDownload();

    expect(job.live_visible).toBe("visible");
    const r = describePlacement(job);
    // A listing proves a file of that NAME exists somewhere the server reads.
    // That is placement, never validity (#473).
    expect(r.confirmed).toBe(false);
    expect(r.warning).toMatch(/PLACEMENT, not validity/);
  });

  it("stays UNKNOWN, with the original caveat, when the server cannot be asked", async () => {
    hoisted.baseline = undefined;
    hoisted.after = undefined;

    const job = await runManagerDownload();

    expect(job.live_visible).toBe("unknown");
    expect(describePlacement(job).warning).toMatch(/NOT verified as landed/);
  });

  it("takes the BASELINE before dispatching, so a pre-existing file cannot read as a landing", async () => {
    // The trap `listedBefore` exists for on the local path (#369), and the Manager
    // path had no baseline at all: a file of the same name that was already there
    // would answer "visible" and be credited to a dispatch that fetched nothing.
    hoisted.baseline = true;
    hoisted.after = true;

    const job = await runManagerDownload();

    // The probe ran BEFORE the dispatch (that is the baseline) and again after.
    expect(hoisted.probed[0]).toEqual({ sub: SUB, name: NAME });
    // A pre-existing entry makes the post-check inconclusive, NOT successful.
    expect(job.live_visible).toBe("unknown");
    expect(job.verify_note).toMatch(/BEFORE this dispatch/);
  });

  it("NEVER demotes the job's status on a not-listed verdict", async () => {
    // Deliberate limit, and the reason it is a limit: a Manager dispatch returns
    // on ACCEPTANCE, so a large file is still arriving for minutes afterwards.
    // "not there yet" and "landed where the server cannot read" are
    // indistinguishable from here, and turning the first into an error would
    // break every slow download. The REPORT carries the finding; the status does
    // not pretend to a certainty nothing established.
    hoisted.baseline = false;
    hoisted.after = false;

    const job = await runManagerDownload();

    expect(job.status).toBe("done");
  });

  it("does not run the Manager check on a LOCAL download", async () => {
    hoisted.remote = false;
    hoisted.baseline = false;
    hoisted.after = false;

    const started = await startDownloadJob(URL_, SUB, NAME);
    hoisted.resolveDispatch?.(`/M/${SUB}/${NAME}`);
    await started.settled;

    expect(hoisted.visibilityCalls).toBe(0);
    // The local route's own verification still runs — this changed nothing there.
    expect(hoisted.landedCalls).toBe(1);
  });
});

describe("#1374 — verifyManagerVisibility's own contract, exercised directly", () => {
  // Through `importActual`, NOT the module-level import. The mock above wraps
  // this function and OVERRIDES its `probe`, so calling the mocked binding here
  // would have measured the fixture instead of the function — the first version
  // of these two tests did exactly that and reported "unknown" for a probe that
  // said no. A harness that answers its own question is worse than no test.
  const real = async () =>
    (await vi.importActual<typeof import("../../services/model-resolver.js")>(
      "../../services/model-resolver.js",
    )).verifyManagerVisibility;

  it("answers not-listed only after actually being told no", async () => {
    const r = await (await real())(SUB, NAME, {
      attempts: 1,
      retryMs: 0,
      probe: async () => false,
    });
    expect(r.visibility).toBe("not-listed");
  });

  it("answers unknown — never not-listed — when the probe cannot answer", async () => {
    // The distinction the whole fix rests on: "the server says no" and "the
    // server could not be asked" must never collapse into one verdict.
    const r = await (await real())(SUB, NAME, {
      attempts: 1,
      retryMs: 0,
      probe: async () => undefined,
    });
    expect(r.visibility).toBe("unknown");
  });
});
