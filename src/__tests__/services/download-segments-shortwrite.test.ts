// #1697 review finding: `filehandle.writev`/`write` resolve with the number of
// bytes the OS ACTUALLY took and do not retry a short write. Advancing the
// segment's byte counter by the REQUESTED count instead of the written count
// lets the counter run ahead of the file — and every guard in the segmented
// writer reads that counter, so the resulting gap is invisible to all of them:
// the next write starts past it, a retry's Range skips it, `written === length`
// and the total both pass, and `assertComplete`'s stat() cannot see a hole.
//
// This suite forces short writes and requires the landed bytes to be exact.
// It lives in its own file because the fs mock has to be in place before
// download-segments.js is imported.

import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Every writev takes at most this many bytes, so a 1 MiB batch is always short. */
const SHORT_WRITE_BYTES = 40_961; // deliberately not a chunk or batch multiple

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    default: actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const fh = await actual.open(...args);
      const realWritev = fh.writev.bind(fh);
      // @ts-expect-error deliberate partial-write injection
      fh.writev = async (buffers: Buffer[], position?: number) => {
        let budget = SHORT_WRITE_BYTES;
        const capped: Buffer[] = [];
        for (const b of buffers) {
          if (budget <= 0) break;
          capped.push(b.length <= budget ? b : b.subarray(0, budget));
          budget -= Math.min(b.length, budget);
        }
        return realWritev(capped, position);
      };
      return fh;
    },
  };
});

import {
  planSegments,
  probeSegmentedRanges,
  runSegmentedDownload,
  dropWritten,
  type SegmentedPolicy,
} from "../../services/download-segments.js";

const POLICY: SegmentedPolicy = { connections: 4, minBytes: 1024, maxAttemptsPerSegment: 3 };
const sha = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

function payload(bytes: number): Buffer {
  const buf = Buffer.alloc(bytes);
  let x = 0x2f6e2b1;
  for (let i = 0; i < bytes; i += 1) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    buf[i] = (x >>> 16) & 0xff;
  }
  return buf;
}

let tempDir: string;
let server: Server;
let url: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "seg-short-"));
});

afterEach(async () => {
  server?.closeAllConnections();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  await rm(tempDir, { recursive: true, force: true });
});

describe("segmented writer under short writes (#1697)", () => {
  it("advances by the bytes the filesystem actually took, so no gap opens inside a segment", async () => {
    const body = payload(6 * 1024 * 1024);
    server = createServer((req, res) => {
      const m = /^bytes=(\d+)-(\d+)$/.exec(String(req.headers.range || ""));
      if (!m) {
        res.writeHead(200, { "content-length": String(body.length), "accept-ranges": "bytes" });
        return void res.end(body);
      }
      const start = Number(m[1]);
      const end = Number(m[2]);
      const slice = body.subarray(start, end + 1);
      res.writeHead(206, {
        "content-length": String(slice.length),
        "content-range": `bytes ${start}-${end}/${body.length}`,
        "accept-ranges": "bytes",
      });
      res.end(slice);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/m.safetensors`;

    const target = join(tempDir, "short.partial");
    const segments = planSegments({
      status: 200,
      appendMode: false,
      acceptRanges: "bytes",
      contentEncoding: null,
      contentLength: body.length,
      expectedTotal: body.length,
      requestHadRange: false,
      policy: POLICY,
    })!;
    const opts = {
      url,
      headers: {},
      targetPath: target,
      totalBytes: body.length,
      segments,
      logUrl: url,
    };
    const probe = await probeSegmentedRanges(opts);
    const result = await runSegmentedDownload(opts, probe);

    // The load-bearing assertion: byte-identical. A counter that advanced by the
    // REQUESTED length would skip ~96% of every batch, leaving zero-filled gaps
    // that the size checks cannot see.
    const landed = await readFile(target);
    expect(landed.length).toBe(body.length);
    expect(sha(landed)).toBe(sha(body));
    expect(result.bytesWritten).toBe(body.length);
  });

  it("dropWritten resumes a partially-written buffer list at the exact byte", () => {
    const a = Buffer.from([1, 2, 3]);
    const b = Buffer.from([4, 5]);
    const c = Buffer.from([6, 7, 8, 9]);
    expect(Buffer.concat(dropWritten([a, b, c], 0))).toEqual(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9]));
    expect(Buffer.concat(dropWritten([a, b, c], 1))).toEqual(Buffer.from([2, 3, 4, 5, 6, 7, 8, 9]));
    expect(Buffer.concat(dropWritten([a, b, c], 3))).toEqual(Buffer.from([4, 5, 6, 7, 8, 9]));
    expect(Buffer.concat(dropWritten([a, b, c], 6))).toEqual(Buffer.from([7, 8, 9]));
    expect(dropWritten([a, b, c], 9)).toEqual([]);
  });
});
