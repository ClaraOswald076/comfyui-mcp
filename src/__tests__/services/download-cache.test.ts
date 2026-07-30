import { mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as fsPromises from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../config.js", () => {
  const config = {
    comfyuiPath: undefined as string | undefined,
    huggingfaceToken: undefined as string | undefined,
    civitaiApiToken: undefined as string | undefined,
  };
  return {
    config,
    // downloadModel branches on this; these tests always run with comfyuiPath
    // set (local mode), so it returns false.
    isRemoteMode: () => !config.comfyuiPath,
  };
});

import { config } from "../../config.js";
import {
  downloadCacheFs,
  getResumeDiagnostic,
  resetResumeDiagnostics,
} from "../../services/download-cache.js";
import { downloadModel } from "../../services/model-resolver.js";

/** Tray id for a URL — mirrors download-jobs' downloadIdFor / the cache's
 *  trayIdForUrl, so a test can look up the resume diagnostic (#467). */
async function trayIdFor(url: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(url).digest("hex").slice(0, 16);
}

const fetchMock = vi.fn();
let tempDir: string;
let cacheDir: string;
let comfyDir: string;

function okResponse(body: string): Response {
  return new Response(body, { status: 200, statusText: "OK" });
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "comfyui-mcp-cache-test-"));
  cacheDir = join(tempDir, "cache");
  comfyDir = join(tempDir, "comfy");
  process.env.COMFYUI_DOWNLOAD_CACHE_DIR = cacheDir;
  delete process.env.COMFYUI_LRU_CACHE_SIZE_GB;
  config.comfyuiPath = comfyDir;
  config.huggingfaceToken = undefined;
  config.civitaiApiToken = undefined;
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  resetResumeDiagnostics();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.COMFYUI_DOWNLOAD_CACHE_DIR;
  delete process.env.COMFYUI_LRU_CACHE_SIZE_GB;
  await rm(tempDir, { recursive: true, force: true });
});

describe("downloadModel cache", () => {
  it("downloads on cache miss and reuses the cached file on hit", async () => {
    fetchMock.mockResolvedValueOnce(okResponse("cached model"));

    const first = await downloadModel(
      "https://example.com/models/a.safetensors",
      "checkpoints",
      "first.safetensors",
    );
    const second = await downloadModel(
      "https://example.com/models/a.safetensors",
      "checkpoints",
      "second.safetensors",
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(readFile(first, "utf-8")).resolves.toBe("cached model");
    await expect(readFile(second, "utf-8")).resolves.toBe("cached model");
  });

  it("coalesces concurrent downloads for the same source URL", async () => {
    let resolveFetch!: (value: Response) => void;
    fetchMock.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      }),
    );

    const one = downloadModel(
      "https://example.com/models/concurrent.safetensors",
      "checkpoints",
      "one.safetensors",
    );
    const two = downloadModel(
      "https://example.com/models/concurrent.safetensors",
      "loras",
      "two.safetensors",
    );

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    resolveFetch(okResponse("one network body"));

    const [onePath, twoPath] = await Promise.all([one, two]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(readFile(onePath, "utf-8")).resolves.toBe("one network body");
    await expect(readFile(twoPath, "utf-8")).resolves.toBe("one network body");
  });

  it("falls back to copying when hardlink materialization fails", async () => {
    const linkSpy = vi
      .spyOn(downloadCacheFs, "link")
      .mockRejectedValue(Object.assign(new Error("cross-device link"), { code: "EXDEV" }));
    const copySpy = vi.spyOn(downloadCacheFs, "copyFile");
    fetchMock.mockResolvedValueOnce(okResponse("copy fallback"));

    const target = await downloadModel(
      "https://example.com/models/copy.safetensors",
      "checkpoints",
      "copy.safetensors",
    );

    expect(linkSpy).toHaveBeenCalled();
    expect(copySpy).toHaveBeenCalled();
    await expect(readFile(target, "utf-8")).resolves.toBe("copy fallback");
  });

  it("resumes from a leftover partial file using HTTP Range and appends a 206 response", async () => {
    await fsPromises.mkdir(cacheDir, { recursive: true });
    // Pre-seed the .partial that the cache deterministic-names.
    // The cache key derives from sha256(url).slice(0,32) + the URL's pathname extension.
    const url = "https://example.com/models/resume.safetensors";
    const { createHash } = await import("node:crypto");
    const hash = createHash("sha256").update(url).digest("hex").slice(0, 32);
    const partialPath = join(cacheDir, `.${hash}.safetensors.partial`);
    await writeFile(partialPath, "AAAA"); // 4 bytes of prior progress
    // A resume is only attempted when we hold the validator captured on the
    // first attempt (replayed as If-Range); seed it so the resume proceeds.
    await writeFile(`${partialPath}.etag`, '"resume-etag"');

    // Server returns 206 with the remaining bytes.
    fetchMock.mockResolvedValueOnce(
      new Response("BBBB", {
        status: 206,
        statusText: "Partial Content",
        headers: { "content-range": "bytes 4-7/8" },
      }),
    );

    const target = await downloadModel(url, "checkpoints", "resumed.safetensors");

    // We sent the Range header reflecting the existing 4 bytes.
    const [, init] = fetchMock.mock.calls[0] as [
      string,
      { headers: Record<string, string> },
    ];
    expect(init.headers.Range).toBe("bytes=4-");

    // The materialized file is the full 8 bytes (existing partial + appended).
    await expect(readFile(target, "utf-8")).resolves.toBe("AAAABBBB");
  });

  it("overwrites the partial when the server replies 200 (Range unsupported)", async () => {
    await fsPromises.mkdir(cacheDir, { recursive: true });
    const url = "https://example.com/models/norange.safetensors";
    const { createHash } = await import("node:crypto");
    const hash = createHash("sha256").update(url).digest("hex").slice(0, 32);
    const partialPath = join(cacheDir, `.${hash}.safetensors.partial`);
    await writeFile(partialPath, "STALE_PARTIAL_CONTENT");
    // With a validator present we send Range+If-Range; the server ignoring the
    // range (or the file having changed) replies 200 and we overwrite cleanly.
    await writeFile(`${partialPath}.etag`, '"stale-etag"');

    fetchMock.mockResolvedValueOnce(okResponse("full body from server"));

    const target = await downloadModel(url, "checkpoints", "fresh.safetensors");

    const [, init] = fetchMock.mock.calls[0] as [
      string,
      { headers: Record<string, string> },
    ];
    expect(init.headers.Range).toBe("bytes=21-"); // requested, but server ignored
    await expect(readFile(target, "utf-8")).resolves.toBe("full body from server");
  });

  it("rejects a truncated download (Content-Length exceeds bytes received) instead of reporting success (#343)", async () => {
    // Stream body yields only "short" (5 bytes) but the server claims 1000 —
    // pipeline() resolves on the early end, so without the size check this would
    // be saved + reported as a complete download.
    const stream = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(new TextEncoder().encode("short")); c.close(); },
    });
    fetchMock.mockResolvedValueOnce(
      new Response(stream, { status: 200, statusText: "OK", headers: { "content-length": "1000" } }),
    );
    await expect(
      downloadModel("https://example.com/models/trunc.safetensors", "checkpoints", "trunc.safetensors"),
    ).rejects.toThrow(/truncat/i);
  });

  it("rejects and removes a 0-byte download (source sent no data) (#343)", async () => {
    fetchMock.mockResolvedValueOnce(new Response("", { status: 200, statusText: "OK" }));
    await expect(
      downloadModel("https://example.com/models/empty.safetensors", "checkpoints", "empty.safetensors"),
    ).rejects.toThrow(/0-byte/i);
    // The empty file must not linger in the cache to masquerade as a real download.
    const cached = await readdir(cacheDir).catch(() => [] as string[]);
    expect(cached.some((f) => f.endsWith(".safetensors"))).toBe(false);
  });

  it("follows a Hugging Face Xet/CAS cross-origin redirect and drops auth on the hop (#411)", async () => {
    config.huggingfaceToken = "hf_secrettoken";
    const hfUrl =
      "https://huggingface.co/Aitrepreneur/FLX/resolve/main/krea2_turbo_mxfp8.safetensors";
    // 1st hop: HF resolve URL 302s to the pre-signed Xet/CAS CDN (cross-origin).
    fetchMock.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: "https://cas-bridge.xethub.hf.co/xet-bridge-us/abc123?sig=xyz" },
      }),
    );
    // 2nd hop: the CDN serves the bytes.
    fetchMock.mockResolvedValueOnce(okResponse("xet model bytes"));

    const target = await downloadModel(hfUrl, "diffusion_models", "krea.safetensors");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Hop 1 carried the HF bearer token...
    const [, firstInit] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(firstInit.headers.Authorization).toBe("Bearer hf_secrettoken");
    // ...but the cross-origin CAS hop must NOT (no token leak to the third-party CDN).
    const [casUrl, secondInit] = fetchMock.mock.calls[1] as [
      string,
      { headers: Record<string, string> },
    ];
    expect(casUrl).toContain("cas-bridge.xethub.hf.co");
    expect(secondInit.headers.Authorization).toBeUndefined();
    await expect(readFile(target, "utf-8")).resolves.toBe("xet model bytes");
  });

  it("surfaces the underlying cause when fetch fails at the network layer instead of a bare 'fetch failed' (#411)", async () => {
    // undici shape: TypeError("fetch failed") whose real reason is on .cause.
    const netErr = new TypeError("fetch failed");
    (netErr as { cause?: unknown }).cause = Object.assign(
      new Error("getaddrinfo ENOTFOUND cas-bridge.xethub.hf.co"),
      { code: "ENOTFOUND" },
    );
    fetchMock.mockRejectedValueOnce(netErr);

    const p = downloadModel(
      "https://huggingface.co/Aitrepreneur/FLX/resolve/main/krea2_turbo_mxfp8.safetensors",
      "diffusion_models",
      "krea.safetensors",
    );
    // Clear + actionable: names the real cause (ENOTFOUND) and the Xet/CAS host,
    // not the generic "fetch failed".
    await expect(p).rejects.toThrow(/network layer/i);
    await expect(p).rejects.toThrow(/ENOTFOUND/);
    await expect(p).rejects.toThrow(/Xet\/CAS/i);
  });

  it("gives a clear error for an unfollowable redirect (3xx with no Location) (#411)", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 302 }));
    const p = downloadModel(
      "https://huggingface.co/some/repo/resolve/main/model.safetensors",
      "diffusion_models",
      "m.safetensors",
    );
    await expect(p).rejects.toThrow(/no.*Location header/i);
  });

  // Deterministic cache paths for a URL (mirrors cachePathForUrl in the impl).
  async function cachePaths(url: string) {
    const { createHash } = await import("node:crypto");
    const hash = createHash("sha256").update(url).digest("hex").slice(0, 32);
    const target = join(cacheDir, `${hash}.safetensors`);
    const partial = join(cacheDir, `.${hash}.safetensors.partial`);
    return { hash, target, partial, sidecar: `${partial}.etag` };
  }

  it("sends If-Range from the persisted validator and RESTARTS (not appends) when the upstream file changed (#343 edge)", async () => {
    await fsPromises.mkdir(cacheDir, { recursive: true });
    const url = "https://example.com/models/changed.safetensors";
    const { partial, sidecar } = await cachePaths(url);
    // A leftover partial from a prior attempt, plus the validator we captured then.
    await writeFile(partial, "AAAA");
    await writeFile(sidecar, '"etag-v1"');

    // The file changed upstream → server ignores the Range and returns 200 with
    // the full (new) body. Appending would corrupt; we must overwrite.
    fetchMock.mockResolvedValueOnce(okResponse("FULLNEWBODY"));

    const target = await downloadModel(url, "checkpoints", "changed-out.safetensors");

    const [, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(init.headers.Range).toBe("bytes=4-");
    expect(init.headers["If-Range"]).toBe('"etag-v1"');
    // Overwritten with the fresh body — NOT "AAAAFULLNEWBODY".
    await expect(readFile(target, "utf-8")).resolves.toBe("FULLNEWBODY");
  });

  it("sends If-Range and appends a matching 206 whose Content-Range starts at the resume offset (#343 edge)", async () => {
    await fsPromises.mkdir(cacheDir, { recursive: true });
    const url = "https://example.com/models/match.safetensors";
    const { partial, sidecar } = await cachePaths(url);
    await writeFile(partial, "AAAA");
    await writeFile(sidecar, '"etag-stable"');

    fetchMock.mockResolvedValueOnce(
      new Response("BBBB", {
        status: 206,
        statusText: "Partial Content",
        headers: { "content-range": "bytes 4-7/8" },
      }),
    );

    const target = await downloadModel(url, "checkpoints", "match-out.safetensors");

    const [, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(init.headers["If-Range"]).toBe('"etag-stable"');
    await expect(readFile(target, "utf-8")).resolves.toBe("AAAABBBB");
  });

  it("refuses to append a 206 whose Content-Range starts at the WRONG offset (would corrupt) (#343 edge)", async () => {
    await fsPromises.mkdir(cacheDir, { recursive: true });
    const url = "https://example.com/models/badrange.safetensors";
    const { partial, sidecar } = await cachePaths(url);
    await writeFile(partial, "AAAA"); // resume offset = 4
    await writeFile(sidecar, '"br-etag"');

    // Misbehaving server/proxy: says it's resuming from byte 0, not 4.
    fetchMock.mockResolvedValueOnce(
      new Response("ZZZZZZZZ", {
        status: 206,
        statusText: "Partial Content",
        headers: { "content-range": "bytes 0-7/8" },
      }),
    );

    await expect(
      downloadModel(url, "checkpoints", "badrange-out.safetensors"),
    ).rejects.toThrow(/resume rejected/i);
    // The corrupt partial (and its sidecar) are removed so a retry starts clean.
    await expect(stat(partial)).rejects.toThrow();
    await expect(stat(sidecar)).rejects.toThrow();
  });

  it("refuses a 206 that omits Content-Range entirely (can't prove the offset) (#343 edge)", async () => {
    await fsPromises.mkdir(cacheDir, { recursive: true });
    const url = "https://example.com/models/nocr.safetensors";
    const { partial, sidecar } = await cachePaths(url);
    await writeFile(partial, "AAAA");
    await writeFile(sidecar, '"nocr-etag"');

    // 206 but NO Content-Range — we cannot verify where it resumes from.
    fetchMock.mockResolvedValueOnce(
      new Response("ZZZZ", { status: 206, statusText: "Partial Content" }),
    );

    await expect(
      downloadModel(url, "checkpoints", "nocr-out.safetensors"),
    ).rejects.toThrow(/resume rejected/i);
  });

  it("accepts a 206 whose Content-Range uses a mixed-case range unit (RFC 9110 §14.1) (#343 edge)", async () => {
    await fsPromises.mkdir(cacheDir, { recursive: true });
    const url = "https://example.com/models/mixedcase.safetensors";
    const { partial, sidecar } = await cachePaths(url);
    await writeFile(partial, "AAAA");
    await writeFile(sidecar, '"mc-etag"');

    // "Bytes" (capital B) is a legitimate, case-insensitive range unit.
    fetchMock.mockResolvedValueOnce(
      new Response("BBBB", {
        status: 206,
        statusText: "Partial Content",
        headers: { "content-range": "Bytes 4-7/8" },
      }),
    );

    const target = await downloadModel(url, "checkpoints", "mixedcase-out.safetensors");
    await expect(readFile(target, "utf-8")).resolves.toBe("AAAABBBB");
  });

  it("refuses a SHORT 206 that does not run to the end of the file (RFC 9110 partial range) (#343 edge)", async () => {
    await fsPromises.mkdir(cacheDir, { recursive: true });
    const url = "https://example.com/models/short206.safetensors";
    const { partial, sidecar } = await cachePaths(url);
    await writeFile(partial, "AAAA"); // resume offset = 4
    await writeFile(sidecar, '"s2-etag"');

    // 206 whose Content-Range says the file is 1000 bytes but only serves
    // bytes 4-7 — appending 4 bytes and using content-length (4) as the target
    // would finalize an 8-byte file as "complete" for a 1000-byte model.
    fetchMock.mockResolvedValueOnce(
      new Response("BBBB", {
        status: 206,
        statusText: "Partial Content",
        headers: { "content-range": "bytes 4-7/1000" },
      }),
    );

    await expect(
      downloadModel(url, "checkpoints", "short206-out.safetensors"),
    ).rejects.toThrow(/resume rejected/i);
    await expect(stat(partial)).rejects.toThrow();
  });

  it("does NOT resume a validator-less partial — restarts cleanly instead of appending (#343 edge)", async () => {
    await fsPromises.mkdir(cacheDir, { recursive: true });
    const url = "https://example.com/models/novalidator.safetensors";
    const { partial } = await cachePaths(url);
    // A stale partial with NO sidecar (e.g. left by a pre-fix build). We cannot
    // prove the upstream file is unchanged, so a Range resume is unsafe.
    await writeFile(partial, "AAAA");

    fetchMock.mockResolvedValueOnce(okResponse("FRESHFULLBODY"));

    const target = await downloadModel(url, "checkpoints", "novalidator-out.safetensors");

    const [, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    // No Range / If-Range without a trustworthy validator.
    expect(init.headers.Range).toBeUndefined();
    expect(init.headers["If-Range"]).toBeUndefined();
    // The stale prefix is discarded — final file is the fresh body, not "AAAA...".
    await expect(readFile(target, "utf-8")).resolves.toBe("FRESHFULLBODY");
  });

  it("SURFACES a validator-less declined resume instead of silently discarding the partial (#467)", async () => {
    await fsPromises.mkdir(cacheDir, { recursive: true });
    const url = "https://example.com/models/silentdiscard.safetensors";
    const { partial } = await cachePaths(url);
    // A 21-byte partial with NO sidecar (the HF Xet case: the CAS CDN sent no
    // ETag/Last-Modified on the original body, so none was ever written).
    await writeFile(partial, "STALE_PARTIAL_CONTENT"); // 21 bytes

    fetchMock.mockResolvedValueOnce(okResponse("FRESHFULLBODY"));

    const target = await downloadModel(url, "checkpoints", "silentdiscard-out.safetensors");
    await expect(readFile(target, "utf-8")).resolves.toBe("FRESHFULLBODY");

    // The discard is no longer silent: a diagnostic records WHY and HOW MUCH.
    const diag = getResumeDiagnostic(await trayIdFor(url));
    expect(diag?.outcome).toBe("declined:no-validator");
    expect(diag?.discardedBytes).toBe(21);
  });

  it("persists a validator from the HF resolve REDIRECT (X-Linked-Etag) so a Xet partial becomes resumable (#467)", async () => {
    await fsPromises.mkdir(cacheDir, { recursive: true });
    const url = "https://huggingface.co/org/repo/resolve/main/big.safetensors";
    const { partial, sidecar } = await cachePaths(url);

    // Hop 1: resolve URL 302s cross-origin to the CAS CDN, carrying the
    // content-addressed X-Linked-Etag (but no plain ETag).
    fetchMock.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: {
          location: "https://cas-bridge.xethub.hf.co/xet-bridge-us/obj?sig=abc",
          "x-linked-etag": '"xet-content-hash-v1"',
        },
      }),
    );
    // Hop 2: the CAS CDN serves the body with NEITHER ETag NOR Last-Modified,
    // and the stream ends early (truncated) so the partial + sidecar survive.
    const stream = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(new TextEncoder().encode("half")); c.close(); },
    });
    fetchMock.mockResolvedValueOnce(
      new Response(stream, {
        status: 200,
        statusText: "OK",
        headers: { "content-length": "1000" },
      }),
    );

    await expect(
      downloadModel(url, "diffusion_models", "big-out.safetensors"),
    ).rejects.toThrow(/truncat/i);

    // Previously NO sidecar was written (final CAS 200 has no validator) so the
    // partial could never resume. Now the redirect's X-Linked-Etag is captured.
    await expect(stat(partial)).resolves.toBeTruthy();
    await expect(readFile(sidecar, "utf-8")).resolves.toBe('"xet-content-hash-v1"');
  });

  it("forwards Range across a cross-origin CAS redirect and APPENDS a 206 (HF Xet resume) (#467)", async () => {
    await fsPromises.mkdir(cacheDir, { recursive: true });
    const url = "https://huggingface.co/org/repo/resolve/main/resume-xet.safetensors";
    const { partial, sidecar } = await cachePaths(url);
    await writeFile(partial, "AAAA"); // 4 bytes already downloaded
    await writeFile(sidecar, '"xet-content-hash-v1"');

    // Hop 1: resolve URL 302s cross-origin (If-Range unchanged → range honored).
    fetchMock.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: "https://cas-bridge.xethub.hf.co/xet-bridge-us/obj?sig=abc" },
      }),
    );
    // Hop 2: the CAS CDN honors the byte range and returns a 206.
    fetchMock.mockResolvedValueOnce(
      new Response("BBBB", {
        status: 206,
        statusText: "Partial Content",
        headers: { "content-range": "bytes 4-7/8" },
      }),
    );

    const target = await downloadModel(url, "diffusion_models", "resume-xet-out.safetensors");

    // Hop 1 (resolve) carried Range + If-Range...
    const [, firstInit] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(firstInit.headers.Range).toBe("bytes=4-");
    expect(firstInit.headers["If-Range"]).toBe('"xet-content-hash-v1"');
    // ...and CRUCIALLY the cross-origin CAS hop STILL carried Range (previously
    // dropped with all headers → resume was impossible on Xet).
    const [casUrl, secondInit] = fetchMock.mock.calls[1] as [string, { headers: Record<string, string> }];
    expect(casUrl).toContain("cas-bridge.xethub.hf.co");
    expect(secondInit.headers.Range).toBe("bytes=4-");
    // The bytes were appended, not re-downloaded from 0.
    await expect(readFile(target, "utf-8")).resolves.toBe("AAAABBBB");
    expect(getResumeDiagnostic(await trayIdFor(url))?.outcome).toBe("resumed");
  });

  it("REFUSES to append a CAS 206 when the redirect's content-addressed X-Linked-Etag changed, even if the CDN honors the Range (#467/#343)", async () => {
    await fsPromises.mkdir(cacheDir, { recursive: true });
    const url = "https://huggingface.co/org/repo/resolve/main/xet-changed.safetensors";
    const { partial, sidecar } = await cachePaths(url);
    await writeFile(partial, "AAAA");
    await writeFile(sidecar, '"xet-hash-OLD"'); // partial written against OLD content

    // Hop 1: resolve 302 now advertises a DIFFERENT content hash (file changed).
    fetchMock.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: {
          location: "https://cas-bridge.xethub.hf.co/xet-bridge-us/obj?sig=new",
          "x-linked-etag": '"xet-hash-NEW"',
        },
      }),
    );
    // Hop 2: a misbehaving CAS that honors the stale Range and 206s the NEW object.
    fetchMock.mockResolvedValueOnce(
      new Response("BBBB", {
        status: 206,
        statusText: "Partial Content",
        headers: { "content-range": "bytes 4-7/8" },
      }),
    );

    // We must NOT splice new-object bytes onto the stale prefix — reject instead.
    await expect(
      downloadModel(url, "diffusion_models", "xet-changed-out.safetensors"),
    ).rejects.toThrow(/resume rejected/i);
    // Stale partial + sidecar removed so a retry restarts clean.
    await expect(stat(partial)).rejects.toThrow();
    await expect(stat(sidecar)).rejects.toThrow();
    expect(getResumeDiagnostic(await trayIdFor(url))?.outcome).toBe("declined:etag-changed");
  });

  it("declines + SURFACES a changed-upstream resume (If-Range miss, 200) — safety preserved (#467/#343)", async () => {
    await fsPromises.mkdir(cacheDir, { recursive: true });
    const url = "https://example.com/models/changed-surfaced.safetensors";
    const { partial, sidecar } = await cachePaths(url);
    await writeFile(partial, "AAAA"); // 4 bytes
    await writeFile(sidecar, '"etag-old"');

    // Upstream changed → If-Range miss → server sends full 200, not a 206.
    fetchMock.mockResolvedValueOnce(okResponse("BRANDNEWBODY"));

    const target = await downloadModel(url, "checkpoints", "changed-surfaced-out.safetensors");
    // Overwritten with the fresh body — safety preserved, no corrupt append.
    await expect(readFile(target, "utf-8")).resolves.toBe("BRANDNEWBODY");

    const diag = getResumeDiagnostic(await trayIdFor(url));
    expect(diag?.outcome).toBe("declined:etag-changed");
    expect(diag?.discardedBytes).toBe(4);
  });

  it("persists the validator sidecar on a fresh write so a later resume can guard with If-Range (#343 edge)", async () => {
    await fsPromises.mkdir(cacheDir, { recursive: true });
    const url = "https://example.com/models/sidecar.safetensors";
    const { partial, sidecar } = await cachePaths(url);

    // Fresh download (no partial) whose stream ends early → truncated, so the
    // partial + its newly-written validator are left on disk for a resume.
    const stream = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(new TextEncoder().encode("half")); c.close(); },
    });
    fetchMock.mockResolvedValueOnce(
      new Response(stream, {
        status: 200,
        statusText: "OK",
        headers: { "content-length": "1000", etag: '"captured-v9"' },
      }),
    );

    await expect(
      downloadModel(url, "checkpoints", "sidecar-out.safetensors"),
    ).rejects.toThrow(/truncat/i);

    // The validator was captured and PAIRS with the truncated partial bytes.
    await expect(stat(partial)).resolves.toBeTruthy();
    await expect(readFile(sidecar, "utf-8")).resolves.toBe('"captured-v9"');
  });

  it("never serves a 0-byte cache entry as a hit — re-downloads instead (#343 edge)", async () => {
    await fsPromises.mkdir(cacheDir, { recursive: true });
    const url = "https://example.com/models/zerohit.safetensors";
    const { target } = await cachePaths(url);
    // A pre-existing empty cache file (interrupted rename / older build / tamper).
    await writeFile(target, "");

    fetchMock.mockResolvedValueOnce(okResponse("real bytes this time"));

    const out = await downloadModel(url, "checkpoints", "zerohit-out.safetensors");

    // The empty hit must NOT have short-circuited the download.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(readFile(out, "utf-8")).resolves.toBe("real bytes this time");
  });

  it("evicts least-recently-used cache files when the optional limit is exceeded", async () => {
    process.env.COMFYUI_LRU_CACHE_SIZE_GB = String(12 / 1024 / 1024 / 1024);
    await fsPromises.mkdir(cacheDir, { recursive: true });
    const oldFile = join(cacheDir, "old.safetensors");
    await writeFile(oldFile, "0123456789");
    const oldDate = new Date("2000-01-01T00:00:00.000Z");
    await utimes(oldFile, oldDate, oldDate);
    fetchMock.mockResolvedValueOnce(okResponse("new!"));

    await downloadModel(
      "https://example.com/models/new.safetensors",
      "checkpoints",
      "new.safetensors",
    );

    const cacheFiles = await readdir(cacheDir);
    expect(cacheFiles).not.toContain("old.safetensors");
    expect(cacheFiles).toHaveLength(1);
    const remaining = join(cacheDir, cacheFiles[0]);
    expect((await stat(remaining)).size).toBe(4);
  });
});
