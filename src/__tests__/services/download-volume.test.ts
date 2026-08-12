import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  freeBytesFor,
  checkCacheVolumeSpace,
  insufficientCacheSpaceMessage,
  headroomFor,
  VOLUME_HEADROOM_BYTES,
} from "../../services/download-volume.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const GB = 1024 ** 3;

// Exercised against the REAL filesystem rather than a mocked `statfs`. The behaviour
// that matters here IS the platform's: that statfs throws ENOENT for a path that does
// not exist yet (so the walk up to an existing ancestor is load-bearing), and that a
// missing drive letter cannot be measured at all. A mock would only assert my model of
// those semantics, which is the thing most likely to be wrong.
//
// `MISSING_VOLUME` is a drive letter with no volume mounted; verified unmeasurable.
const MISSING_VOLUME = "M:/models/diffusion_models";

describe("#1477 freeBytesFor", () => {
  it("reports free bytes for a real volume", async () => {
    const free = await freeBytesFor(tmpdir());
    expect(typeof free).toBe("number");
    expect(free as number).toBeGreaterThan(0);
  });

  it("walks UP to an existing ancestor - the cache dir may not exist yet", async () => {
    // On a first run ~/.comfyui-mcp/cache does not exist and statfs throws ENOENT.
    // Without the walk, every fresh install would silently skip the space check.
    const nested = join(homedir(), ".comfyui-mcp-does-not-exist", "cache", "deeper");
    const free = await freeBytesFor(nested);
    expect(typeof free).toBe("number");
    expect(free as number).toBeGreaterThan(0);
  });

  it("returns null for a volume that cannot be measured", async () => {
    expect(await freeBytesFor(MISSING_VOLUME)).toBeNull();
  });
});

describe("#1477 checkCacheVolumeSpace refuses only when it is sure", () => {
  it("refuses a download the staging volume cannot possibly hold", async () => {
    const refusal = await checkCacheVolumeSpace({
      needBytes: 1e15, // a petabyte: larger than any volume on this machine
      cacheDir: join(homedir(), ".comfyui-mcp", "cache"),
    });
    expect(refusal).toBeTruthy();
    expect(refusal).toMatch(/NOT downloaded/);
  });

  it("proceeds when the volume plainly has room", async () => {
    expect(await checkCacheVolumeSpace({ needBytes: 1024, cacheDir: tmpdir() })).toBeNull();
  });

  it("FAILS SOFT when free space cannot be read", async () => {
    // An unmeasurable volume must not become an unusable one: this exists to stop a
    // known-bad write, never to invent a new way for a good one to be blocked.
    expect(
      await checkCacheVolumeSpace({ needBytes: 1e15, cacheDir: MISSING_VOLUME }),
    ).toBeNull();
  });

  it("proceeds when the size is unknown - it must not guess", async () => {
    for (const needBytes of [undefined, 0, Number.NaN]) {
      expect(await checkCacheVolumeSpace({ needBytes, cacheDir: tmpdir() })).toBeNull();
    }
  });

  it("keeps headroom rather than letting a volume land on exactly zero", async () => {
    // Free space EQUAL to the download fits arithmetically and is still a bad outcome
    // on a system drive - the page-file case this issue is about.
    const free = (await freeBytesFor(tmpdir())) as number;
    expect(free).toBeGreaterThan(2 * VOLUME_HEADROOM_BYTES);
    // Exactly the free space: refused, because it would leave zero.
    expect(await checkCacheVolumeSpace({ needBytes: free, cacheDir: tmpdir() })).toBeTruthy();
    // Comfortably inside the headroom: allowed.
    expect(
      await checkCacheVolumeSpace({
        needBytes: free - 2 * VOLUME_HEADROOM_BYTES,
        cacheDir: tmpdir(),
      }),
    ).toBeNull();
  });
});

describe("#1477 the refusal explains the split between staging and destination", () => {
  const msg = (destFree: number | null) =>
    insufficientCacheSpaceMessage({
      needBytes: 32.29 * GB,
      cacheDir: "C:/Users/x/.comfyui-mcp/cache",
      cacheFree: 0.7 * GB,
      destDir: "F:/ComfyUI/models/diffusion_models",
      destFree,
    });

  it("names both numbers, so the contradiction is legible", () => {
    expect(msg(1000 * GB)).toMatch(/32\.29 GB/);
    expect(msg(1000 * GB)).toMatch(/0\.70 GB free/);
  });

  it('says the destination HAS room — the fact that makes this fixable', () => {
    // Without this the reader concludes their disk is full and deletes things.
    const m = msg(1000 * GB);
    expect(m).toMatch(/DESTINATION has room/);
    expect(m).toMatch(/not a "your disk is full" problem/);
    expect(m).toMatch(/staged in the cache/);
  });

  it("does NOT claim the destination has room when it does not", () => {
    const m = msg(1 * GB);
    expect(m).not.toMatch(/DESTINATION has room/);
    expect(m).toMatch(/destination volume does not have room either/);
  });

  it("names the lever", () => {
    expect(msg(1000 * GB)).toMatch(/COMFYUI_DOWNLOAD_CACHE_DIR/);
  });

  it("says nothing was written, so no cleanup is implied", () => {
    // The reporter was left with a 22.62 GB .partial. A refusal that happens before
    // the first byte must say so, or the reader goes looking for one.
    expect(msg(1000 * GB)).toMatch(/Nothing was written/);
    expect(msg(1000 * GB)).toMatch(/before the\s+first byte/);
  });
});

describe("#1477 WIRING: the streaming path refuses before opening a handle", () => {
  const src = readFileSync(join(HERE, "../../services/download-cache.ts"), "utf8");

  it("imports and calls the check", () => {
    expect(src).toMatch(
      /import \{ checkCacheVolumeSpace \} from "\.\/download-volume\.js";/,
    );
    expect(src).toMatch(/await checkCacheVolumeSpace\(\{/);
  });

  it("the check runs BEFORE the write stream is created", () => {
    // Order is the whole point: a refusal after createWriteStream would already have
    // opened (and on some paths truncated) the target.
    const check = src.indexOf("await checkCacheVolumeSpace({");
    const open = src.indexOf("createWriteStream(targetPath");
    expect(check).toBeGreaterThan(-1);
    expect(open).toBeGreaterThan(-1);
    expect(check).toBeLessThan(open);
  });

  it("a refusal throws rather than being logged and ignored", () => {
    expect(src).toMatch(/if \(refusal\) throw new ModelError\(refusal/);
  });

  it("a resume asks only for the REMAINING bytes", () => {
    // On an append the already-written bytes are on disk; demanding the full size
    // would refuse resumes that fit perfectly well.
    expect(src).toMatch(/rangeTotal - \(resumeFromBytes \|\| 0\)/);
  });

  it("a resume with NO Content-Range total still checks, via Content-Length", () => {
    // Round 2 of review: when a 206 carries no Content-Range total, `rangeTotal` is
    // null and the original arithmetic yielded 0 -- which SKIPPED the guard on exactly
    // the resume path it was written to protect. Content-Length on a 206 is the
    // remaining slice, so it is the right fallback.
    expect(src).toMatch(/remainingFromRange \?\? \(lengthHeaderPre > 0 \? lengthHeaderPre : 0\)/);
  });

  it("tells the check it is a resume, so the message does not lie about the partial", () => {
    expect(src).toMatch(/resuming: appendMode/);
  });
});

describe("#1477 round 2: the reserve scales, and the message tells the truth on a resume", () => {
  it("keeps a full 1 GiB on a large volume - the system-drive case", () => {
    expect(headroomFor(232 * GB)).toBe(VOLUME_HEADROOM_BYTES);
  });

  it("does not make a SMALL volume unusable", () => {
    // A flat 1 GiB reserve would refuse a 2 GB file on a 4 GB stick that fits.
    const small = 4 * GB;
    expect(headroomFor(small)).toBeLessThan(VOLUME_HEADROOM_BYTES);
    expect(headroomFor(small)).toBe(Math.floor(small * 0.05));
  });

  it("falls back to the full reserve for a nonsense total", () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(headroomFor(bad)).toBe(VOLUME_HEADROOM_BYTES);
    }
  });

  it("does NOT claim nothing was downloaded when interrupting a resume", () => {
    // The partial exists on disk. Telling the user otherwise invites them to delete
    // something they could have reused.
    const resumeMsg = insufficientCacheSpaceMessage({
      needBytes: 10 * GB,
      cacheDir: "C:/cache",
      cacheFree: 1 * GB,
      resuming: true,
    });
    expect(resumeMsg).not.toMatch(/Nothing was written/);
    expect(resumeMsg).toMatch(/existing partial download is untouched/);
    expect(resumeMsg).toMatch(/still resumable/);
  });

  it("still says nothing was written on a FRESH download", () => {
    const freshMsg = insufficientCacheSpaceMessage({
      needBytes: 10 * GB,
      cacheDir: "C:/cache",
      cacheFree: 1 * GB,
    });
    expect(freshMsg).toMatch(/Nothing was written/);
    expect(freshMsg).not.toMatch(/still resumable/);
  });

  it("refuses to measure a volume whose statfs fails for a NON-missing-path reason", async () => {
    // Climbing on any error could answer confidently about a different disk. Only
    // ENOENT/ENOTDIR justify walking up. A path under an existing FILE yields ENOTDIR
    // and is therefore allowed to climb; that is the deliberate exception.
    const underAFile = join(HERE, "download-volume.test.ts", "nested", "cache");
    const free = await freeBytesFor(underAFile);
    expect(typeof free).toBe("number");
  });
});
