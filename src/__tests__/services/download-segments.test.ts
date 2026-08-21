// #1697 — multi-connection (segmented) downloads.
//
// These drive a REAL loopback HTTP server through the REAL production entry
// point (`downloadWithCache`), not a fetch mock, because the three things that
// matter here are all properties of an actual transfer:
//
//   - the bytes are byte-identical to a single-connection fetch of the same file
//     (a segmented download that reassembles wrongly is silent corruption, which
//     is worse than the slowness it fixes);
//   - a server that refuses ranges — or LIES about supporting them — still
//     completes, on the unchanged single-connection path;
//   - the segments really do run concurrently, so a green test cannot be one
//     that quietly fell back and proved nothing.

import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../config.js", () => {
  const config = {
    comfyuiPath: undefined as string | undefined,
    huggingfaceToken: undefined as string | undefined,
    civitaiApiToken: undefined as string | undefined,
  };
  return { config, isRemoteMode: () => !config.comfyuiPath };
});

import { config } from "../../config.js";
import { downloadWithCache } from "../../services/download-cache.js";
import {
  contiguousPrefix,
  parseContentRange,
  planSegments,
  probeSegmentedRanges,
  runSegmentedDownload,
  SegmentedRangeUnsupportedError,
  segmentScratchPath,
  type SegmentedPolicy,
} from "../../services/download-segments.js";

const POLICY: SegmentedPolicy = { connections: 4, minBytes: 1024, maxAttemptsPerSegment: 3 };

/** Deterministic pseudo-random payload — must not sniff as HTML/JSON (#473). */
function payload(bytes: number): Buffer {
  const buf = Buffer.alloc(bytes);
  let x = 0x12345678;
  for (let i = 0; i < bytes; i += 1) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    buf[i] = (x >>> 16) & 0xff;
  }
  // Guarantee a binary-looking head whatever the PRNG produced.
  buf.writeUInt32LE(0x00ff00ff, 0);
  return buf;
}

const sha = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

type ServerMode =
  /** Correct: advertises ranges and serves them. */
  | "ranges"
  /** No `Accept-Ranges` at all; answers a Range request with the whole file. */
  | "no-ranges"
  /** LIES: advertises `Accept-Ranges: bytes`, then ignores Range and 200s. */
  | "lying"
  /** Advertises ranges, 206s, but reports a Content-Range that is not what we asked for. */
  | "bad-content-range"
  /** 206 with a correct Content-Range, then a body that stops short of it. */
  | "short-segment";

interface Rig {
  server: Server;
  url: string;
  requests: Array<{ range: string | undefined }>;
  maxConcurrent: number;
}

async function startServer(body: Buffer, mode: ServerMode): Promise<Rig> {
  const rig: Partial<Rig> & { requests: Rig["requests"]; maxConcurrent: number } = {
    requests: [],
    maxConcurrent: 0,
  };
  let inFlight = 0;

  const server = createServer((req, res) => {
    const range = req.headers.range;
    rig.requests.push({ range: Array.isArray(range) ? range[0] : range });
    inFlight += 1;
    rig.maxConcurrent = Math.max(rig.maxConcurrent, inFlight);
    res.on("close", () => {
      inFlight -= 1;
    });

    const full = (extra: Record<string, string> = {}) => {
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": String(body.length),
        ...extra,
      });
      res.end(body);
    };

    if (mode === "no-ranges") return full();
    if (mode === "lying") return full({ "accept-ranges": "bytes" });
    if (!range) return full({ "accept-ranges": "bytes" });

    const m = /^bytes=(\d+)-(\d+)?$/.exec(String(range));
    if (!m) return full({ "accept-ranges": "bytes" });
    const start = Number(m[1]);
    const end = m[2] === undefined ? body.length - 1 : Number(m[2]);
    const slice = body.subarray(start, end + 1);
    const contentRange =
      mode === "bad-content-range"
        ? `bytes ${start}-${end}/${body.length + 1}`
        : `bytes ${start}-${end}/${body.length}`;
    // A MIDDLE segment short, with the FIRST and LAST segments complete. That
    // shape is the whole reason the byte counts exist: the finished file reaches
    // its full declared SIZE (the last segment writes the final byte) with a
    // zero-filled hole in the middle, so the size check the caller already runs
    // cannot see it. Only counting what each segment actually wrote can.
    if (mode === "short-segment" && start > 0 && end < body.length - 1) {
      const half = Math.max(1, Math.floor(slice.length / 2));
      res.writeHead(206, {
        "content-type": "application/octet-stream",
        "content-length": String(half),
        "content-range": contentRange,
        "accept-ranges": "bytes",
      });
      return void res.end(slice.subarray(0, half));
    }
    res.writeHead(206, {
      "content-type": "application/octet-stream",
      "content-length": String(slice.length),
      "content-range": contentRange,
      "accept-ranges": "bytes",
    });
    // Deliberately dribble the body so the segments genuinely overlap in time —
    // an instant end() could complete each request before the next one starts and
    // the concurrency assertion would pass without any parallelism.
    const step = Math.max(1, Math.floor(slice.length / 4));
    let off = 0;
    const push = (): void => {
      if (off >= slice.length) return void res.end();
      res.write(slice.subarray(off, Math.min(off + step, slice.length)));
      off += step;
      setTimeout(push, 5);
    };
    push();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    server,
    url: `http://127.0.0.1:${port}/model.safetensors`,
    requests: rig.requests,
    get maxConcurrent() {
      return rig.maxConcurrent;
    },
  } as Rig;
}

let tempDir: string;
let cacheDir: string;
let comfyDir: string;
const rigs: Server[] = [];

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "comfyui-mcp-seg-"));
  cacheDir = join(tempDir, "cache");
  comfyDir = join(tempDir, "comfy");
  process.env.COMFYUI_DOWNLOAD_CACHE_DIR = cacheDir;
  // 4 connections over a small fixture; the shipped 64 MiB floor would decline
  // every file this suite can afford to move.
  process.env.COMFYUI_DOWNLOAD_CONNECTIONS = "4";
  process.env.COMFYUI_DOWNLOAD_SEGMENT_MIN_MB = "1";
  delete process.env.COMFYUI_LRU_CACHE_SIZE_GB;
  config.comfyuiPath = comfyDir;
});

afterEach(async () => {
  delete process.env.COMFYUI_DOWNLOAD_CACHE_DIR;
  delete process.env.COMFYUI_DOWNLOAD_CONNECTIONS;
  delete process.env.COMFYUI_DOWNLOAD_SEGMENT_MIN_MB;
  delete process.env.COMFYUI_DOWNLOAD_MAX_ATTEMPTS;
  await Promise.all(rigs.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
  await rm(tempDir, { recursive: true, force: true });
});

async function rigFor(body: Buffer, mode: ServerMode): Promise<Rig> {
  const rig = await startServer(body, mode);
  rigs.push(rig.server);
  return rig;
}

/** Destination inside the fake ComfyUI tree, with its directory created — the
 *  download path reserves an O_EXCL temp beside dest and will not mkdir for us. */
async function destFor(...parts: string[]): Promise<string> {
  const p = join(comfyDir, "models", ...parts);
  await mkdir(dirname(p), { recursive: true });
  return p;
}

describe("planSegments — eligibility (#1697)", () => {
  const base = {
    status: 200,
    appendMode: false,
    acceptRanges: "bytes",
    contentEncoding: null,
    contentLength: 8 * 1024 * 1024,
    expectedTotal: 8 * 1024 * 1024,
    requestHadRange: false,
    policy: POLICY,
  };

  it("cuts contiguous, non-overlapping segments covering exactly [0, total)", () => {
    const segs = planSegments(base);
    expect(segs).not.toBeNull();
    expect(segs).toHaveLength(4);
    expect(segs![0].start).toBe(0);
    expect(segs![segs!.length - 1].end).toBe(base.contentLength - 1);
    for (let i = 1; i < segs!.length; i += 1) {
      expect(segs![i].start).toBe(segs![i - 1].end + 1);
    }
    const covered = segs!.reduce((a, s) => a + (s.end - s.start + 1), 0);
    expect(covered).toBe(base.contentLength);
  });

  it("declines when the server does not advertise byte ranges", () => {
    expect(planSegments({ ...base, acceptRanges: null })).toBeNull();
    expect(planSegments({ ...base, acceptRanges: "none" })).toBeNull();
  });

  it("declines a resume (206 / append / a Range already on the request)", () => {
    expect(planSegments({ ...base, status: 206 })).toBeNull();
    expect(planSegments({ ...base, appendMode: true })).toBeNull();
    expect(planSegments({ ...base, requestHadRange: true })).toBeNull();
  });

  it("declines a content-coded body, whose offsets index the ENCODED octets", () => {
    expect(planSegments({ ...base, contentEncoding: "gzip" })).toBeNull();
    expect(planSegments({ ...base, contentEncoding: "identity" })).not.toBeNull();
  });

  it("declines when Content-Length and the verified total disagree (#467 short-CDN case)", () => {
    expect(planSegments({ ...base, expectedTotal: base.contentLength + 1 })).toBeNull();
  });

  it("declines below the size floor, and when connections is 1", () => {
    expect(planSegments({ ...base, contentLength: 1023, expectedTotal: 1023 })).toBeNull();
    expect(planSegments({ ...base, policy: { ...POLICY, connections: 1 } })).toBeNull();
  });
});

describe("parseContentRange / contiguousPrefix (#1697)", () => {
  it("accepts only a fully-specified bytes range", () => {
    expect(parseContentRange("bytes 10-19/100")).toEqual({ start: 10, end: 19, total: 100 });
    expect(parseContentRange("bytes 10-19/*")).toBeNull();
    expect(parseContentRange("items 10-19/100")).toBeNull();
    expect(parseContentRange("bytes 19-10/100")).toBeNull();
    expect(parseContentRange(null)).toBeNull();
  });

  it("stops at the FIRST unfinished segment, so the prefix can never span a hole", () => {
    const segs = [
      { start: 0, end: 9 },
      { start: 10, end: 19 },
      { start: 20, end: 29 },
    ];
    // Segment 0 done, 1 half done, 2 fully done → the prefix must be 15, NOT 30.
    expect(contiguousPrefix(segs, [{ written: 10 }, { written: 5 }, { written: 10 }])).toBe(15);
    expect(contiguousPrefix(segs, [{ written: 0 }, { written: 10 }, { written: 10 }])).toBe(0);
    expect(contiguousPrefix(segs, [{ written: 10 }, { written: 10 }, { written: 10 }])).toBe(30);
  });
});

describe("segmented download through downloadWithCache (#1697)", () => {
  it("downloads over multiple concurrent connections and lands byte-identical output", async () => {
    const body = payload(8 * 1024 * 1024);
    const rig = await rigFor(body, "ranges");
    const dest = await destFor("checkpoints", "seg.safetensors");

    await downloadWithCache({ url: rig.url, headers: {}, targetPath: dest });

    const landed = await readFile(dest);
    // Integrity: the reassembled file must be the source, byte for byte.
    expect(landed.length).toBe(body.length);
    expect(sha(landed)).toBe(sha(body));

    // It really segmented: one plain GET plus one ranged GET per segment, and at
    // least two of them were in flight at once.
    const ranged = rig.requests.filter((r) => r.range);
    expect(ranged.length).toBeGreaterThanOrEqual(4);
    expect(rig.maxConcurrent).toBeGreaterThan(1);

    // The scratch file is gone — it only ever reaches the target by rename.
    await expect(stat(segmentScratchPath(dest))).rejects.toThrow();
  });

  it("is byte-identical to the same file fetched over ONE connection", async () => {
    const body = payload(6 * 1024 * 1024);

    const rigA = await rigFor(body, "ranges");
    const segDest = await destFor("a", "seg.safetensors");
    await downloadWithCache({ url: rigA.url, headers: {}, targetPath: segDest });

    // Same rig, same file, segmentation disabled — the control.
    process.env.COMFYUI_DOWNLOAD_CONNECTIONS = "1";
    const rigB = await rigFor(body, "ranges");
    const singleDest = await destFor("b", "single.safetensors");
    await downloadWithCache({ url: rigB.url, headers: {}, targetPath: singleDest });

    expect(rigB.requests.filter((r) => r.range)).toHaveLength(0);
    const segBytes = await readFile(segDest);
    const singleBytes = await readFile(singleDest);
    expect(sha(segBytes)).toBe(sha(singleBytes));
    expect(sha(segBytes)).toBe(sha(body));
  });

  it("falls back and still completes when the server does not support ranges", async () => {
    const body = payload(8 * 1024 * 1024);
    const rig = await rigFor(body, "no-ranges");
    const dest = await destFor("norange.safetensors");

    await downloadWithCache({ url: rig.url, headers: {}, targetPath: dest });

    expect(sha(await readFile(dest))).toBe(sha(body));
    // No Accept-Ranges ⇒ declined before any probe, so exactly one request.
    expect(rig.requests).toHaveLength(1);
    expect(rig.requests[0].range).toBeUndefined();
  });

  it("falls back and still completes when the server LIES about supporting ranges", async () => {
    const body = payload(8 * 1024 * 1024);
    const rig = await rigFor(body, "lying");
    const dest = await destFor("liar.safetensors");

    await downloadWithCache({ url: rig.url, headers: {}, targetPath: dest });

    expect(sha(await readFile(dest))).toBe(sha(body));
    // It advertised ranges, so a probe WAS issued; the 200 answer sent us back to
    // the single-connection path rather than failing the download.
    expect(rig.requests.some((r) => r.range)).toBe(true);
    await expect(stat(segmentScratchPath(dest))).rejects.toThrow();
  });

  it("falls back when the 206's Content-Range does not describe what was asked for", async () => {
    const body = payload(8 * 1024 * 1024);
    const rig = await rigFor(body, "bad-content-range");
    const dest = await destFor("badrange.safetensors");

    await downloadWithCache({ url: rig.url, headers: {}, targetPath: dest });

    expect(sha(await readFile(dest))).toBe(sha(body));
    expect(rig.requests.some((r) => r.range)).toBe(true);
  });

  it("COMFYUI_DOWNLOAD_CONNECTIONS=1 disables segmentation entirely", async () => {
    process.env.COMFYUI_DOWNLOAD_CONNECTIONS = "1";
    const body = payload(8 * 1024 * 1024);
    const rig = await rigFor(body, "ranges");
    const dest = await destFor("off.safetensors");

    await downloadWithCache({ url: rig.url, headers: {}, targetPath: dest });

    expect(sha(await readFile(dest))).toBe(sha(body));
    expect(rig.requests).toHaveLength(1);
  });
});

describe("probeSegmentedRanges — a non-206 is never trusted (#1697)", () => {
  it("declines a 200 even when it carries a Content-Range that matches the request", async () => {
    // A proxy that echoes Content-Range onto a full 200 is the one shape where the
    // Content-Range check alone would wave a whole-file body through as a segment.
    // The status check is what refuses it.
    const segments = [
      { start: 0, end: 511 },
      { start: 512, end: 1023 },
    ];
    const fetchImpl = (async () =>
      new Response(new Uint8Array(1024), {
        status: 200,
        headers: { "content-range": "bytes 512-1023/1024", "accept-ranges": "bytes" },
      })) as unknown as typeof fetch;

    await expect(
      probeSegmentedRanges({
        url: "http://127.0.0.1:1/x",
        headers: {},
        targetPath: join(tempDir, "never-written.partial"),
        totalBytes: 1024,
        segments,
        logUrl: "http://127.0.0.1:1/x",
        fetchImpl,
      }),
    ).rejects.toThrow(SegmentedRangeUnsupportedError);
    // And nothing was written: a declined probe must touch no file.
    await expect(stat(join(tempDir, "never-written.partial"))).rejects.toThrow();
    await expect(
      stat(segmentScratchPath(join(tempDir, "never-written.partial"))),
    ).rejects.toThrow();
  });
});

describe("segmented download refuses to finalize a short segment (#1697)", () => {
  it("errors rather than landing a file whose middle is missing", async () => {
    process.env.COMFYUI_DOWNLOAD_MAX_ATTEMPTS = "1";
    const body = payload(8 * 1024 * 1024);
    const rig = await rigFor(body, "short-segment");
    const dest = await destFor("short.safetensors");

    await expect(
      downloadWithCache({ url: rig.url, headers: {}, targetPath: dest }),
    ).rejects.toThrow(/truncated|incomplete|Not finalizing/i);
    // Nothing was landed at the destination under a false success.
    await expect(stat(dest)).rejects.toThrow();
  });
});

describe("runSegmentedDownload — the hole invariant and the byte sink (#1697)", () => {
  it("feeds EVERY segment's bytes to the caller's sink (the panel tray / #470 watchdog)", async () => {
    const body = payload(4 * 1024 * 1024);
    const rig = await rigFor(body, "ranges");
    const target = join(tempDir, "sink.partial");
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
    let reported = 0;
    const opts = {
      url: rig.url,
      headers: {},
      targetPath: target,
      totalBytes: body.length,
      segments,
      logUrl: rig.url,
      onBytes: (n: number) => {
        reported += n;
      },
    };
    const probe = await probeSegmentedRanges(opts);
    const result = await runSegmentedDownload(opts, probe);

    // Every byte written was reported exactly once — a sink that only saw the
    // probe segment, or saw bytes twice, would fail this.
    expect(reported).toBe(body.length);
    expect(result.bytesWritten).toBe(body.length);
    expect(result.connections).toBe(segments.length);
    expect(sha(await readFile(target))).toBe(sha(body));
  });

  it("leaves a CONTIGUOUS prefix (never a hole) when a segment fails mid-transfer", async () => {
    const body = payload(4 * 1024 * 1024);
    // Segment 0 always dies part-way; the others would serve fine. Without the
    // prefix truncation the file would end up full-size with a zero-filled gap
    // where segment 0 should be — a correct SIZE over corrupt bytes.
    const quarter = Math.floor(body.length / 4);
    const server = createServer((req, res) => {
      const m = /^bytes=(\d+)-(\d+)$/.exec(String(req.headers.range || ""));
      if (!m) {
        res.writeHead(200, {
          "content-length": String(body.length),
          "accept-ranges": "bytes",
        });
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
      if (start < quarter) {
        // Inside segment 0: hand over a little, then kill the connection.
        res.write(slice.subarray(0, 4096));
        return void setTimeout(() => res.destroy(), 5);
      }
      res.end(slice);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    rigs.push(server);
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/m.safetensors`;

    const target = join(tempDir, "holey.partial");
    const segments = planSegments({
      status: 200,
      appendMode: false,
      acceptRanges: "bytes",
      contentEncoding: null,
      contentLength: body.length,
      expectedTotal: body.length,
      requestHadRange: false,
      policy: { ...POLICY, maxAttemptsPerSegment: 2 },
    })!;
    const opts = {
      url,
      headers: {},
      targetPath: target,
      totalBytes: body.length,
      segments,
      logUrl: url,
      maxAttemptsPerSegment: 2,
    };
    const probe = await probeSegmentedRanges(opts);
    await expect(runSegmentedDownload(opts, probe)).rejects.toThrow();

    // The scratch file must not survive under its own name...
    await expect(stat(segmentScratchPath(target))).rejects.toThrow();
    // ...and what landed at the target is a strict, hole-free PREFIX of the file:
    // shorter than the whole, and identical to the source over its whole length.
    const landed = await readFile(target);
    expect(landed.length).toBeGreaterThan(0);
    expect(landed.length).toBeLessThan(body.length);
    expect(sha(landed)).toBe(sha(body.subarray(0, landed.length)));
  });
});
