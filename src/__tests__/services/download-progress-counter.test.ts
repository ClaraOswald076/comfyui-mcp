// #1697 — the progress-counting Transform in streamUrlToFile must never
// MISREPORT the transfer: the bytes it tallies are exactly the bytes that
// reached disk, and no row it publishes claims more than the transfer carried.
//
// This is a counting-arithmetic guard, and it is deliberately independent of the
// counter's buffer depth — it passes at Node's default and at any explicit
// highWaterMark, because the counting is per chunk either way. That
// independence is the point: re-chunking is the thing that could silently break
// the tally, so the test pushes 128 chunks of 48 KiB (not a multiple of any
// stage's buffer) through the REAL exported downloadUrlToFile and compares disk
// bytes against the counter's terminal progress row.
//
// It does NOT pin a buffer depth. #1738 briefly added a 4 MiB highWaterMark here
// on the theory that the default paced the pipeline; a later alternating A/B
// against a same-round straight pipe measured the opposite (the default is the
// fastest depth tried, and 4 MiB ran 0.77x unthrottled), so the override was
// removed. See the comment beside the Transform in download-cache.ts.

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

import { downloadUrlToFile } from "../../services/download-cache.js";

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

describe("progress counter honesty (#1697)", () => {
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
