// #1697 — the progress-counting Transform in streamUrlToFile must OBSERVE the
// transfer, never pace it, and never misreport it.
//
// It was constructed with Node's default 16 KiB highWaterMark — the narrowest
// buffer in a chain whose write stream alone buffers 64 KiB — so every chunk
// cost a full backpressure circuit. Measured in the issue: 0.35–0.48 MB/s where
// curl held 12 MB/s on the same link (~25x), a steady ~16 KiB per ~40 ms.
//
// Two things are pinned here:
//   1. the counter's buffer depth is deep enough that it can never be the
//      narrowest stage again, and bounded so a stalled sink can't grow memory
//      without limit;
//   2. counting honesty: through the deep buffer, the bytes the counter tallies
//      are exactly the bytes that reached disk.

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../config.js", () => {
  const config = {
    comfyuiPath: undefined as string | undefined,
    huggingfaceToken: undefined as string | undefined,
    civitaiApiToken: undefined as string | undefined,
  };
  return {
    config,
    isRemoteMode: () => !config.comfyuiPath,
    getComfyUIBaseUrl: () => `http://127.0.0.1:8188`,
  };
});

/** Every progress row the counter publishes. Recorded through a module mock
 *  because the real reporter writes to COMFYUI_MCP_PROGRESS_DIR, which is read
 *  from the environment at import time (same seam download-retry.test.ts uses). */
const progressRows = vi.hoisted(
  () => [] as Array<{ status: string; downloaded: number; total?: number }>,
);
vi.mock("../../services/download-progress.js", async () => {
  const actual = await vi.importActual<typeof import("../../services/download-progress.js")>(
    "../../services/download-progress.js",
  );
  return {
    ...actual,
    reportDownloadProgress: (p: { status: string; downloaded: number; total?: number }) => {
      progressRows.push({ status: p.status, downloaded: p.downloaded, total: p.total });
    },
  };
});

import { __downloadCacheTestHooks, downloadUrlToFile } from "../../services/download-cache.js";

const fetchMock = vi.fn();
let tempDir: string;

/** A 200 response whose body arrives as MANY chunks (the counter's per-chunk
 *  path), with an honest Content-Length so the completion check has something
 *  authoritative to verify against. */
function chunkedResponse(chunks: Buffer[]): Response {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(new Uint8Array(c));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-length": String(total), "content-type": "application/octet-stream" },
  });
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "comfyui-mcp-counter-test-"));
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  progressRows.length = 0;
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await rm(tempDir, { recursive: true, force: true });
});

describe("progress counter buffer depth (#1697)", () => {
  it("the counter's highWaterMark is deep enough to never pace the pipeline, and bounded", () => {
    const hwm = __downloadCacheTestHooks.progressCounterHighWaterMark;
    // Below 1 MiB the counter risks being the narrowest buffer in the chain
    // again (the regression: 16 KiB vs the write stream's 64 KiB).
    expect(hwm).toBeGreaterThanOrEqual(1024 * 1024);
    // Deep, not unbounded: a stalled sink must not be able to buffer the whole
    // model in memory.
    expect(hwm).toBeLessThanOrEqual(64 * 1024 * 1024);
  });

  it("counts exactly the bytes that reach disk, across many chunks", async () => {
    // 128 chunks of 48 KiB = 6 MiB — chunk sizes deliberately NOT a multiple of
    // any stage's buffer, so the count survives arbitrary re-chunking.
    const chunks = Array.from({ length: 128 }, (_, i) => Buffer.alloc(48 * 1024, i % 251));
    const total = chunks.reduce((n, c) => n + c.length, 0);
    fetchMock.mockResolvedValueOnce(chunkedResponse(chunks));

    const target = join(tempDir, "model.bin");
    await downloadUrlToFile(
      "https://example.com/models/counter.bin",
      target,
      {},
      undefined,
      {},
      { id: "counter-test", name: "counter.bin", attempt: 1 },
      "", // no payload validation — this is about byte counting, not classification
    );

    const onDisk = await readFile(target);
    expect(onDisk.length).toBe(total);
    expect(onDisk.equals(Buffer.concat(chunks))).toBe(true);

    // The counter's terminal row tallies exactly what landed — no drift between
    // observed and written bytes.
    const done = progressRows.find((r) => r.status === "done");
    expect(done).toBeDefined();
    expect(done!.downloaded).toBe(total);
    // No row ever claims MORE than the transfer carried.
    for (const row of progressRows) expect(row.downloaded).toBeLessThanOrEqual(total);
    expect(progressRows.some((r) => r.status === "error")).toBe(false);
  });
});
