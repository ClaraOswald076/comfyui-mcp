// #1371 r2 — the refusal that shipped in v0.51.19 and had never once fired.
//
// `divergentInstallRefusal` is reached from ONE place, admitted by
// `if (!liveRootAtResolve)` — which holds exactly when
// `isLiveAuthoritativeModelsDir(source)` was FALSE. Its evidence comes from
// `isUnderLiveModelRoots`, which used to bail with `{inRoots: undefined}` unless
// `isLiveAuthoritativeModelsDir(dest.source)` was TRUE. Same predicate, opposite
// directions, same server moments apart — so the answer was always `undefined`,
// and `divergentInstallRefusal` returns null at its first line when it is.
//
// The existing suite could not see this: it tests `divergentInstallRefusal` as a
// PURE function with `inRoots: false` handed in, and its "#1371 WIRING" block is
// `readFileSync` + regex over source text. Both pass whether or not production
// can reach the branch — the "tested but unreachable" shape.
//
// THESE ARE CHARACTERIZATION TESTS. They pass on main today and are not a
// regression net for a fix — there is no fix here, and that is the finding.
//
// What they pin is the working half: `isUnderLiveModelRoots` answers `false`
// correctly whenever `dest.source` IS live-authoritative. Combined with the last
// test in this file, which pins the caller's gate as requiring the NEGATION of
// that condition, they document why the refusal cannot fire.
//
// I also tried the obvious repair — fall back to `snapshot.liveRoot` when the
// models dir is not live-derived — and it is a NO-OP. output-dir.ts adopts the
// live root as the models dir precisely when `live.root && existsSync(live.root)`,
// so "not live-authoritative" IMPLIES the live root is absent from this
// filesystem; the fallback path then fails `realpath`, `fullyCanonical` goes
// false, and the answer is `undefined` exactly as before. Reverted rather than
// shipped. See the issue thread for where a real fix would have to live.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { join, resolve } from "node:path";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

// REAL directories: a negative answer is only given when both the target and
// the live root can be canonicalized (realpath must succeed), which is also the
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

vi.mock("../../comfyui/client.js", () => ({
  getSystemStats: async () => {
    if (!reachable) throw new Error("ECONNREFUSED");
    return { system: { argv, cwd } };
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
  cwd = CONNECTED_ROOT;
  // `main.py` under the connected install, no --models-directory: the models dir
  // is NOT live-authoritative, but the install ROOT is derivable from argv.
  argv = [join(CONNECTED_ROOT, "main.py"), "--port", "8190"];
});

afterEach(() => {
  vi.resetModules();
});

afterAll(() => {
  rmSync(SANDBOX, { recursive: true, force: true });
});

describe("#1371 the divergent-install guard can actually answer", () => {
  it("a destination under the STALE install is reported OUTSIDE the live roots", async () => {
    // The working half. Called DIRECTLY like this — with a live-authoritative
    // source — the function answers correctly. That is exactly why the bug is so
    // easy to miss: nothing is wrong with this function. Its only caller just
    // never invokes it in a state where it can answer.
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
    //
    // The cwd has to be withheld too. With it present the resolver anchors on
    // the OS-observed process dir and CAN name the root, which is correct. An
    // earlier version of this test dropped only argv and asserted UNKNOWN — it
    // was wrong about the product rather than finding a bug.
    argv = ["main.py"];
    cwd = undefined;
    const m = await membershipFor(join(STALE_ROOT, "models", "checkpoints"), "checkpoints");
    expect(m.inRoots).toBeUndefined();
  });

  it("THE CONTRADICTION: the caller's gate requires the negation of what this needs", async () => {
    // The two conditions, read off the source rather than asserted from memory.
    // If someone repairs the gate, this test fails and points them here — which
    // is the only useful thing a test can do about dead code.
    const src = readFileSync(join(HERE, "../../services/model-resolver.ts"), "utf8");

    // The ONLY call site is admitted when liveRootAtResolve is falsy...
    expect(src).toMatch(/if \(!liveRootAtResolve\) \{[\s\S]{0,400}?divergentInstallRefusal\(\{/);
    // ...and liveRootAtResolve is set exactly when the source IS live-authoritative...
    expect(src).toMatch(
      /liveRootAtResolve: isLiveAuthoritativeModelsDir\(source\) \? modelsRoot : undefined/,
    );
    // ...while the evidence bails unless the source IS live-authoritative.
    expect(src).toMatch(
      /if \(!isLiveAuthoritativeModelsDir\(dest\.source\)\) return \{ inRoots: undefined \}/,
    );
    // Both `source` values come from resolveModelsDirWithBases() against the same
    // server, so they agree — making the admitting and answering conditions
    // mutually exclusive. inRoots is therefore always undefined on that path, and
    // divergentInstallRefusal returns null at its first line.
    const { divergentInstallRefusal } = await import(
      "../../services/download-root-correspondence.js"
    );
    expect(divergentInstallRefusal({ targetDir: "/anywhere", inRoots: undefined })).toBeNull();
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
