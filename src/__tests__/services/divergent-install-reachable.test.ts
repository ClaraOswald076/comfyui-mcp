// #1371 r4 — the divergent-install refusal is GONE from the write path, and these
// tests pin what replaced it.
//
// HISTORY, briefly. The refusal added for this issue lived in `resolveDownloadTarget`
// and took a SECOND, fresh server observation (`isUnderLiveModelRoots` re-resolved the
// models dir) after `resolveModelSubfolderWithLiveRoot` had already resolved the
// destination. Nothing pinned the server across that await. The r3 characterization
// tests measured the outcome:
//
//   - STEADY STATE (one server, both observations agreeing — the reporter's case): the
//     refusal could not fire. A source that ADMITTED the guard (destination not derived
//     from the server) could never be one that ANSWERED it (the evidence bails unless
//     the server NAMED the root).
//   - RACE (the server changes between the two observations): it COULD fire — judging
//     the destination against a DIFFERENT server than the one that produced it.
//
// Nondeterministic exactly where it was needed, unsound where it fired. The fix
// resolves the destination ONCE and reuses that single observation; the racy guard is
// removed, because with one observation it is provably inert and a dead check beside
// the live ones is worse than none. The deterministic coverage for the report lives
// with the resolution itself:
//
//   - `resolveModelsDirWithBases` REFUSES a configured base the server's own listing
//     positively contradicts (output-dir.ts), and refuses an unanchorable
//     relative-main.py server unless the configured base corroborates it;
//   - `assertDestinationVisibleToLiveServer` (same snapshot) refuses the #369
//     signature — a POPULATED on-disk category the live listing does not account for;
//   - the writer binds to `liveRootAtResolve` and re-checks `currentLiveModelsRoot`
//     before any bytes move;
//   - `verifyLandedModel` confirms the landed file against the connected server AFTER
//     the write — so a residual wrong destination is REPORTED, never a silent success.
//
// What these tests pin:
//   - the working half: `isUnderLiveModelRoots` still answers correctly for its
//     remaining callers (the POST-write verification), whenever the source IS one the
//     server named.
//   - the STEADY STATE: `resolveDownloadTarget` in the reporter's shape proceeds with
//     NO second server observation — the destination is only ever judged by the
//     observation that produced it.
//   - the RACE, closed: NO interleaving of a changing server produces the old racy
//     refusal, because there is no second observation for it to disagree with.
//   - the DETERMINISTIC refusal: a configured base the live listing contradicts is
//     still refused through the same entry point the reporter's download used.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { join, resolve, sep } from "node:path";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";

// REAL directories: a negative membership answer is only given when both the target
// and the live root can be canonicalized (realpath must succeed), which is also the
// reporter's situation — two ComfyUI installs that both exist.
const SANDBOX = mkdtempSync(join(tmpdir(), "divergent-"));
const CONNECTED_ROOT = join(SANDBOX, "comfy-running");
const STALE_ROOT = join(SANDBOX, "comfy-other");
for (const r of [CONNECTED_ROOT, STALE_ROOT]) {
  mkdirSync(join(r, "models", "checkpoints"), { recursive: true });
}

/** What `/system_stats` reports for the CONNECTED server. */
let argv: string[] = [];
/** Whether the server answers at all (an outage must not fabricate a refusal). */
let reachable = true;
/** The cwd `/system_stats` reports. Undefined = the server cannot anchor itself. */
let cwd: string | undefined = CONNECTED_ROOT;

/** How many times the running server was asked to describe itself. A second
 *  observation inside the destination resolution costs one extra `/system_stats`,
 *  which is how the tests below observe that NO such observation is taken. */
let statsCalls = 0;

/** Lets a test rewrite what the server reports BETWEEN calls, by call number —
 *  the only way to simulate a server that changes across an await boundary. */
let onStats: ((call: number) => void) | undefined;

/** Per-category listing the LIVE server answers with; undefined → not ok. */
let liveListings: Record<string, string[] | undefined> = {};

vi.mock("../../comfyui/client.js", () => ({
  getSystemStats: async () => {
    statsCalls += 1;
    onStats?.(statsCalls);
    if (!reachable) throw new Error("ECONNREFUSED");
    return { system: { argv, cwd } };
  },
  comfyApiFetch: async (path: string) => {
    const category = path.replace(/^\/models\//, "");
    const listing = liveListings[category];
    if (listing === undefined) return { ok: false, status: 404, json: async () => null };
    return { ok: true, status: 200, json: async () => listing };
  },
  resetClient: () => {},
  resetObjectInfoCache: () => {},
}));

vi.mock("../../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config.js")>();
  return {
    ...actual,
    // COMFYUI_PATH points at the OTHER install — the reporter's exact mistake.
    config: { ...actual.config, comfyuiPath: STALE_ROOT },
    getComfyUIBaseUrl: () => "http://127.0.0.1:8190",
    isRemoteMode: () => false,
  };
});

async function membershipFor(targetDir: string, category?: string) {
  vi.resetModules();
  const mod = await import("../../services/model-resolver.js");
  return mod.isUnderLiveModelRoots(targetDir, category);
}

beforeEach(() => {
  reachable = true;
  onStats = undefined;
  cwd = CONNECTED_ROOT;
  liveListings = {};
  // An ABSOLUTE `main.py` under the connected install, no --models-directory. The
  // install root resolves from argv and EXISTS here, so output-dir adopts
  // `<root>/models` with `source = "live-root"` — server-named, and therefore the
  // one state in which `isUnderLiveModelRoots` is allowed to answer at all.
  argv = [join(CONNECTED_ROOT, "main.py"), "--port", "8190"];
});

afterEach(() => {
  vi.resetModules();
});

afterAll(() => {
  rmSync(SANDBOX, { recursive: true, force: true });
});

describe("#1371 the divergent-install guard: one observation, deterministic", () => {
  it("a destination under the STALE install is reported OUTSIDE the live roots", async () => {
    // The working half, preserved: the post-write verification still calls this
    // directly with a live-authoritative source, and it must keep answering.
    const m = await membershipFor(join(STALE_ROOT, "models", "checkpoints"), "checkpoints");
    expect(m.inRoots).toBe(false);
    expect(m.liveRoot).toBe(resolve(join(CONNECTED_ROOT, "models")));
  });

  it("a destination under the CONNECTED install is reported inside", async () => {
    // The other direction, and the one that must not regress: a correct
    // placement must never be refused.
    const m = await membershipFor(join(CONNECTED_ROOT, "models", "checkpoints"), "checkpoints");
    expect(m.inRoots).toBe(true);
  });

  it("says UNKNOWN when the server is unreachable, rather than accusing", async () => {
    // An outage makes the resolver fall back to COMFYUI_PATH. Reporting that as
    // "a different install" would refuse a correct download during a blip.
    reachable = false;
    const m = await membershipFor(join(STALE_ROOT, "models", "checkpoints"), "checkpoints");
    expect(m.inRoots).toBeUndefined();
  });

  it("says UNKNOWN when the server cannot name its own root", async () => {
    // A bare relative `main.py` AND no reported cwd: nothing to anchor against,
    // so the honest answer is unknown — NOT a refusal built on COMFYUI_PATH.
    argv = ["main.py"];
    cwd = undefined;
    const m = await membershipFor(join(STALE_ROOT, "models", "checkpoints"), "checkpoints");
    expect(m.inRoots).toBeUndefined();
  });

  it("STEADY STATE: the reporter's shape proceeds with ONE observation, not two", async () => {
    // The reporter's case: ONE server, answering consistently, whose install root
    // is known but NOT present on this filesystem (Docker / a port-forward), so the
    // models dir falls back to the stale COMFYUI_PATH. No local evidence can
    // distinguish that from a stale install (COMFYUI_PATH may legitimately be the
    // mapped host path), so by ruling the download proceeds with the existing
    // unconfirmed-visibility disclosure — and the post-write verification reports
    // what landed.
    //
    // What changed with the fix: the destination is resolved ONCE. The removed
    // guard's second `/system_stats` observation is gone, so the count pins it.
    const containerRoot = join(SANDBOX, "container-only", "ComfyUI"); // never created
    argv = [join(containerRoot, "main.py"), "--port", "8190"];
    cwd = containerRoot;

    vi.resetModules();
    const mod = await import("../../services/model-resolver.js");
    const before = statsCalls;
    const res = await mod.resolveDownloadTarget(
      "https://example.invalid/m.safetensors",
      "vae",
      "m.safetensors",
    );
    const consultedDuring = statsCalls - before;

    // The destination is NOT live-authoritative (it fell back to local config)...
    expect(res.liveRootAtResolve).toBeUndefined();
    // ...and it is inside the STALE install — the disclosed residual, unchanged.
    // `+ sep`, so a sibling like "comfy-other-2" cannot satisfy this by prefix.
    expect(resolve(res.targetDir).startsWith(resolve(STALE_ROOT) + sep)).toBe(true);

    // ONE observation for the resolution itself, ONE for the symlink-ancestor
    // guard's extra-root authorization — and NONE for a divergent-install guard.
    // On the pre-fix main this measured 3 (the third was the removed guard's
    // fresh resolution). A future change that reintroduces a second observation
    // fails here and re-opens the race the r3 tests measured.
    expect(consultedDuring).toBe(2);
  });

  /**
   * Drive the production entry point with a server whose self-report CHANGES between
   * `/system_stats` calls, swapping after call `swapAfter`. Returns the refusal
   * message, or null when the download was allowed.
   */
  async function refusalWithServerSwap(
    swapAfter: number,
    category: string,
  ): Promise<string | null> {
    const containerRoot = join(SANDBOX, "container-only", "ComfyUI"); // never created
    vi.resetModules();
    reachable = true;
    // Per-scenario, or `swapAfter` would be compared against an ever-growing counter
    // and every sweep iteration after the first would silently run the SAME
    // (post-swap) server.
    statsCalls = 0;
    onStats = (n) => {
      if (n <= swapAfter) {
        argv = [join(containerRoot, "main.py"), "--port", "8190"];
        cwd = containerRoot;
      } else {
        argv = [join(CONNECTED_ROOT, "main.py"), "--port", "8190"];
        cwd = CONNECTED_ROOT;
      }
    };
    const mod = await import("../../services/model-resolver.js");
    try {
      await mod.resolveDownloadTarget(
        "https://example.invalid/m.safetensors",
        category,
        "m.safetensors",
      );
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  }

  it("RACE CLOSED: no interleaving of a changing server produces the old racy refusal", async () => {
    // The r3 tests measured that SOME interleaving fired the refusal — the second
    // observation disagreeing with the first. With the destination now resolved
    // once, there is no second observation to disagree, so EVERY interleaving must
    // proceed (the writer's liveRootAtResolve binding and the post-write
    // verification are what a genuine mid-flight swap is reported through).
    // Swept rather than pinned to one call index, so a changed call count cannot
    // silently stop exercising the swap.
    for (const swapAfter of [0, 1, 2, 3, 4, 5]) {
      for (const category of ["checkpoints", "vae"]) {
        const msg = await refusalWithServerSwap(swapAfter, category);
        expect(msg?.startsWith("NOT downloaded: the connected ComfyUI") ?? false).toBe(false);
      }
    }
  });

  it("DETERMINISTIC COVERAGE: a configured base the live listing contradicts is REFUSED", async () => {
    // The guard that actually covers the reporter's case when positive evidence
    // exists: the server POPULATES a category listing that names nothing under the
    // configured base, while the base holds a model of its own there — a second
    // full install, demonstrably not a root the server reads. This refusal is
    // taken from the SAME observation that resolved the destination, so it fires
    // in the steady state, not just in a race.
    const containerRoot = join(SANDBOX, "container-only", "ComfyUI"); // never created
    argv = [join(containerRoot, "main.py"), "--port", "8190"];
    cwd = containerRoot;
    liveListings = { checkpoints: ["live-a.safetensors", "live-b.safetensors"] };
    const ownModel = join(STALE_ROOT, "models", "checkpoints", "stale.safetensors");
    writeFileSync(ownModel, "not really a model");
    try {
      vi.resetModules();
      const mod = await import("../../services/model-resolver.js");
      await expect(
        mod.resolveDownloadTarget(
          "https://example.invalid/m.safetensors",
          "checkpoints",
          "m.safetensors",
        ),
      ).rejects.toThrow(/Refusing to download into/);
    } finally {
      unlinkSync(ownModel);
    }
  });

  it("prefers an explicit --models-directory over the install root", async () => {
    // When the server DOES name its models dir, that is the authority, even if
    // it sits outside the install root.
    const explicit = join(SANDBOX, "explicit-models");
    mkdirSync(join(explicit, "checkpoints"), { recursive: true });
    argv = [join(CONNECTED_ROOT, "main.py"), "--models-directory", explicit];
    const inside = await membershipFor(join(explicit, "checkpoints"), "checkpoints");
    expect(inside.inRoots).toBe(true);
    const outside = await membershipFor(join(STALE_ROOT, "models", "checkpoints"), "checkpoints");
    expect(outside.inRoots).toBe(false);
  });
});
