import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  freeBytesFor,
  checkCacheVolumeSpace,
  insufficientCacheSpaceMessage,
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
    expect(src).toMatch(/appendMode\s*\?\s*Math\.max\(\(rangeTotal \?\? 0\) - \(resumeFromBytes \|\| 0\), 0\)/);
  });
});
