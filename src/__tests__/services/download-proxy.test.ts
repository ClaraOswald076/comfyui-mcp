import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __downloadProxyTestHooks,
  downloadFetch,
  parseProxyServer,
} from "../../services/download-proxy.js";
import { downloadWithCache, probeRemoteModelPayload } from "../../services/download-cache.js";

// Keep DNS deterministic and offline. The proxy policy must inspect every
// address returned for a hostname before it is allowed to use a dispatcher.
const lookupMock = vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]);
vi.mock("node:dns/promises", () => ({
  lookup: (...args: unknown[]) => lookupMock(...args),
}));

function dispatcherOf(call: unknown[]): unknown {
  return (call[1] as { dispatcher?: unknown } | undefined)?.dispatcher;
}

function binaryPayload(bytes: number): Buffer {
  const out = Buffer.alloc(bytes);
  for (let i = 0; i < out.length; i += 1) out[i] = (i * 31 + 17) & 0xff;
  out.writeUInt32LE(0x00ff00ff, 0);
  return out;
}

describe("download-only proxy routing (#2136)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.unstubAllEnvs();
    __downloadProxyTestHooks.reset();
    lookupMock.mockReset();
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    fetchMock = vi.fn(async () => new Response(new Uint8Array([1, 2, 3])));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    __downloadProxyTestHooks.reset();
    lookupMock.mockReset();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("routes a public model request through COMFYUI_DOWNLOAD_PROXY", async () => {
    vi.stubEnv("COMFYUI_DOWNLOAD_PROXY", "http://proxy.example.test:8080");

    await downloadFetch("https://cdn.example.test/model.safetensors");

    expect(dispatcherOf(fetchMock.mock.calls[0])).toBeDefined();
  });

  it("keeps localhost and loopback download URLs direct even when a proxy is configured", async () => {
    vi.stubEnv("COMFYUI_DOWNLOAD_PROXY", "http://proxy.example.test:8080");

    await downloadFetch("http://localhost:8188/system_stats");
    await downloadFetch("http://127.0.0.1:8188/model.safetensors");
    await downloadFetch("http://[::1]:8188/model.safetensors");
    await downloadFetch("http://0.0.0.0:8188/model.safetensors");
    await downloadFetch("http://[::]:8188/model.safetensors");
    await downloadFetch("http://[::ffff:7f00:1]:8188/model.safetensors");
    await downloadFetch("http://10.0.0.5:8188/model.safetensors");
    await downloadFetch("http://172.16.0.1:8188/model.safetensors");
    await downloadFetch("http://192.168.1.10:8188/model.safetensors");
    await downloadFetch("http://169.254.169.254/latest/meta-data/");
    await downloadFetch("http://[fd00::1]:8188/model.safetensors");
    await downloadFetch("http://[fe80::1]:8188/model.safetensors");

    expect(fetchMock.mock.calls).toHaveLength(12);
    for (const call of fetchMock.mock.calls) expect(dispatcherOf(call)).toBeUndefined();
  });

  it("keeps a hostname that resolves to any private address off the proxy", async () => {
    vi.stubEnv("COMFYUI_DOWNLOAD_PROXY", "http://proxy.example.test:8080");
    lookupMock.mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "192.168.1.10", family: 4 },
    ]);

    await downloadFetch("https://public-looking.example.test/model.safetensors");

    expect(dispatcherOf(fetchMock.mock.calls[0])).toBeUndefined();
  });

  it("keeps an unresolved hostname off the proxy instead of delegating DNS to it", async () => {
    vi.stubEnv("COMFYUI_DOWNLOAD_PROXY", "http://proxy.example.test:8080");
    lookupMock.mockRejectedValue(new Error("EAI_AGAIN"));

    await downloadFetch("https://temporarily-unknown.example.test/model.safetensors");

    expect(dispatcherOf(fetchMock.mock.calls[0])).toBeUndefined();
  });

  it("honors NO_PROXY while keeping non-local model hosts proxied", async () => {
    vi.stubEnv("HTTPS_PROXY", "http://proxy.example.test:8080");
    vi.stubEnv("NO_PROXY", "localhost,origin.test");

    await downloadFetch("https://origin.test/model.safetensors");
    await downloadFetch("https://cdn.example.test/model.safetensors");

    expect(dispatcherOf(fetchMock.mock.calls[0])).toBeUndefined();
    expect(dispatcherOf(fetchMock.mock.calls[1])).toBeDefined();
  });

  it("parses the static proxy forms exposed by Windows Internet Settings", () => {
    expect(parseProxyServer("proxy.example.test:8080")).toEqual({
      http: "http://proxy.example.test:8080/",
      https: "http://proxy.example.test:8080/",
    });
    expect(parseProxyServer("http=http-proxy:80;https=https-proxy:443")).toEqual({
      http: "http://http-proxy/",
      https: "http://https-proxy:443/",
    });
  });

  it("uses the proxy route for redirect/payload probes", async () => {
    vi.stubEnv("COMFYUI_DOWNLOAD_PROXY", "http://proxy.example.test:8080");
    fetchMock
      .mockResolvedValueOnce(
        new Response("<html>login</html>", {
          status: 401,
          headers: { "content-type": "text/html" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(new Uint8Array([0, 255, 0, 255]), {
          status: 200,
          headers: { "content-type": "application/octet-stream" },
        }),
      );

    const result = await probeRemoteModelPayload(
      "https://origin.example.test/model.safetensors",
      ".safetensors",
      undefined,
      { authHeaders: { Authorization: "Bearer test" } },
    );

    expect(result.verdict).toBe("non-model");
    expect(fetchMock.mock.calls).toHaveLength(2);
    for (const call of fetchMock.mock.calls) expect(dispatcherOf(call)).toBeDefined();
  });

  it("re-checks each redirect hop and removes the proxy for a private resolution", async () => {
    vi.stubEnv("COMFYUI_DOWNLOAD_PROXY", "http://proxy.example.test:8080");
    lookupMock
      .mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }])
      .mockResolvedValueOnce([{ address: "169.254.169.254", family: 4 }]);
    fetchMock
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: "https://redirect.example.test/model.safetensors" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(new Uint8Array([0, 255, 0, 255]), {
          status: 200,
          headers: { "content-type": "application/octet-stream" },
        }),
      );

    const result = await probeRemoteModelPayload(
      "https://origin.example.test/model.safetensors",
      ".safetensors",
    );

    expect(result.verdict).toBe("model");
    expect(fetchMock.mock.calls).toHaveLength(2);
    expect(dispatcherOf(fetchMock.mock.calls[0])).toBeDefined();
    expect(dispatcherOf(fetchMock.mock.calls[1])).toBeUndefined();
  });

  it("uses the same proxy route for segmented range requests", async () => {
    vi.stubEnv("COMFYUI_DOWNLOAD_PROXY", "http://proxy.example.test:8080");
    vi.stubEnv("COMFYUI_DOWNLOAD_CONNECTIONS", "2");
    vi.stubEnv("COMFYUI_DOWNLOAD_SEGMENT_MIN_MB", "1");
    const root = await mkdtemp(join(tmpdir(), "comfyui-mcp-2136-"));
    const cacheDir = join(root, "cache");
    const targetDir = join(root, "models");
    await mkdir(targetDir, { recursive: true });
    vi.stubEnv("COMFYUI_DOWNLOAD_CACHE_DIR", cacheDir);

    const body = binaryPayload(2 * 1024 * 1024);
    fetchMock.mockImplementation(async (_input, init) => {
      const headers = new Headers(init?.headers);
      const range = headers.get("range");
      if (!range) {
        return new Response(body, {
          status: 200,
          headers: {
            "content-type": "application/octet-stream",
            "content-length": String(body.length),
            "accept-ranges": "bytes",
          },
        });
      }
      const match = /^bytes=(\d+)-(\d+)$/.exec(range);
      if (!match) throw new Error(`unexpected range ${range}`);
      const start = Number(match[1]);
      const end = Number(match[2]);
      return new Response(body.subarray(start, end + 1), {
        status: 206,
        headers: {
          "content-type": "application/octet-stream",
          "content-length": String(end - start + 1),
          "content-range": `bytes ${start}-${end}/${body.length}`,
          "accept-ranges": "bytes",
        },
      });
    });

    try {
      const target = join(targetDir, "model.safetensors");
      const routes: string[] = [];
      await downloadWithCache({
        url: "https://cdn.example.test/model.safetensors",
        headers: {},
        targetPath: target,
        onRoute: (route) => routes.push(route),
      });

      expect(await readFile(target)).toEqual(body);
      // Initial full response + one range probe + the other segment. The probed
      // segment's response is reused by the writer, so two segments need three
      // fetches, not four.
      expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(3);
      expect(fetchMock.mock.calls.every((call) => dispatcherOf(call) !== undefined)).toBe(true);
      expect(routes).toContain("proxied");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
