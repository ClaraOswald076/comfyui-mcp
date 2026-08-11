// #1370 — `download_model action:"cancel"` told users "the partial was left on disk and
// can be resumed by re-issuing the download (it picks up where it left off)". Nothing ever
// stat'd the file. The reporter paused a 33 GB download BECAUSE of that sentence, found no
// partial anywhere in the install tree, and restarted from zero.
//
// The sentence was not stale — it was never checked. It was selected from
// `status === "cancelled"` plus two flags. And the neighbouring branches were already
// careful: a ComfyUI-Manager dispatch says there is NO local partial, and a reclaimed-dead
// writer says one MAY exist. Only the ordinary cancel asserted a filesystem fact without
// consulting the filesystem.

import { describe, expect, it, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { findResumablePartial } from "../../services/download-cache.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  delete process.env.COMFYUI_DOWNLOAD_CACHE_DIR;
});

async function cacheWith(files: Record<string, number>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "dl-partial-"));
  dirs.push(dir);
  await mkdir(dir, { recursive: true });
  for (const [name, size] of Object.entries(files)) {
    await writeFile(join(dir, name), Buffer.alloc(size, 1));
  }
  process.env.COMFYUI_DOWNLOAD_CACHE_DIR = dir;
  return dir;
}

describe("findResumablePartial reports what is ACTUALLY there (#1370)", () => {
  it("finds the staged partial by the destination filename", async () => {
    await cacheWith({ ".flux2_dev_fp8mixed.safetensors.partial": 4096 });
    const found = await findResumablePartial(["flux2_dev_fp8mixed.safetensors"]);
    expect(found?.bytes).toBe(4096);
    expect(found?.path).toMatch(/\.flux2_dev_fp8mixed\.safetensors\.partial$/);
  });

  it("returns NULL when nothing is staged — the reporter's case", async () => {
    // Their scan found no partial of any kind. With no file present the tool must say so
    // rather than repeat a sentence about resuming.
    await cacheWith({});
    expect(await findResumablePartial(["flux2_dev_fp8mixed.safetensors"])).toBeNull();
  });

  it("tries SEVERAL candidate names, because one wrong guess inverts the same bug", async () => {
    // A cancelled job knows its destination by routes of differing reliability (filename,
    // destination key, landed path, the URL's last segment). Reporting "nothing to resume"
    // over a 30 GB partial that is sitting there would be the identical false claim in the
    // other direction.
    await cacheWith({ ".model.safetensors.partial": 2048 });
    expect(await findResumablePartial([undefined, "", "model.safetensors"])).not.toBeNull();
    // A full path contributes its basename, which is how the staged file is named.
    expect(await findResumablePartial(["/models/checkpoints/model.safetensors"])).not.toBeNull();
    // …and an unrelated name still finds nothing, so the search is not indiscriminate.
    expect(await findResumablePartial(["something_else.safetensors"])).toBeNull();
  });

  it("a ZERO-BYTE partial is not resumable and is reported as absent", async () => {
    // Resuming from it saves nothing, and calling it resumable would restate the bug in
    // miniature: a claim of retained bytes where there are none.
    await cacheWith({ ".empty.safetensors.partial": 0 });
    expect(await findResumablePartial(["empty.safetensors"])).toBeNull();
  });

  it("ignores the FINAL file — only the staged .partial counts as resumable", async () => {
    await cacheWith({ "model.safetensors": 8192 });
    expect(await findResumablePartial(["model.safetensors"])).toBeNull();
  });
});
