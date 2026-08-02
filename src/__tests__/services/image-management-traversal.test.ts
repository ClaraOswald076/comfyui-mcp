import { describe, it, expect, beforeEach, vi } from "vitest";

const mockConfig = vi.hoisted(() => ({
  comfyuiPath: "/comfy" as string | undefined,
  remote: false,
}));

vi.mock("../../config.js", () => ({
  config: mockConfig,
  isRemoteMode: () => mockConfig.remote,
}));

const readdirMock = vi.fn();
vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  copyFile: vi.fn(),
  readdir: (...a: unknown[]) => readdirMock(...a),
  stat: vi.fn(),
}));

const fetchImageMock = vi.fn();
const uploadImageHttpMock = vi.fn();
const getHistoryMock = vi.fn();
vi.mock("../../comfyui/client.js", () => ({
  fetchImage: (...a: unknown[]) => fetchImageMock(...a),
  uploadImageHttp: (...a: unknown[]) => uploadImageHttpMock(...a),
  getHistory: (...a: unknown[]) => getHistoryMock(...a),
}));

import { getOutputImage, listOutputImages } from "../../services/image-management.js";
import { ValidationError, ComfyUIError } from "../../utils/errors.js";

beforeEach(() => {
  mockConfig.comfyuiPath = "/comfy";
  mockConfig.remote = false;
  readdirMock.mockReset();
  getHistoryMock.mockReset().mockResolvedValue({});
});

beforeEach(() => {
  vi.clearAllMocks();
  fetchImageMock.mockResolvedValue({
    base64: "aGVsbG8=",
    mimeType: "image/png",
  });
});

describe("getOutputImage — happy path (legitimate ComfyUI references)", () => {
  it("accepts a plain filename in the output root", async () => {
    await expect(
      getOutputImage("hero_00001_.png", "output", ""),
    ).resolves.toBeDefined();
    expect(fetchImageMock).toHaveBeenCalledWith("hero_00001_.png", "output", "");
  });

  it("accepts a nested subfolder ComfyUI legitimately writes to (e.g. video/clip)", async () => {
    await expect(
      getOutputImage("clip_00001_.mp4", "output", "video/clip"),
    ).resolves.toBeDefined();
    expect(fetchImageMock).toHaveBeenCalledWith(
      "clip_00001_.mp4",
      "output",
      "video/clip",
    );
  });

  it("accepts an empty subfolder (top-level output)", async () => {
    await expect(
      getOutputImage("a.png", "temp", ""),
    ).resolves.toBeDefined();
  });
});

describe("getOutputImage — path-traversal sanitisation (CWE-22)", () => {
  // ComfyUI's /view endpoint historically allows path traversal via the
  // subfolder parameter. Untrusted MCP tool inputs must be rejected BEFORE
  // they are forwarded to the server.

  it("rejects a subfolder containing '..' traversal", async () => {
    await expect(
      getOutputImage("hero.png", "output", "../../etc"),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(fetchImageMock).not.toHaveBeenCalled();
  });

  it("rejects a subfolder that is a pure '..'", async () => {
    await expect(
      getOutputImage("hero.png", "output", ".."),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(fetchImageMock).not.toHaveBeenCalled();
  });

  it("rejects an absolute POSIX subfolder", async () => {
    await expect(
      getOutputImage("hero.png", "output", "/etc"),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(fetchImageMock).not.toHaveBeenCalled();
  });

  it("rejects an absolute Windows-style subfolder", async () => {
    await expect(
      getOutputImage("hero.png", "output", "C:\\Windows"),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(fetchImageMock).not.toHaveBeenCalled();
  });

  it("rejects a subfolder containing NUL bytes", async () => {
    await expect(
      getOutputImage("hero.png", "output", "ok\u0000../etc"),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(fetchImageMock).not.toHaveBeenCalled();
  });

  it("rejects a filename containing path separators", async () => {
    await expect(
      getOutputImage("../../etc/passwd", "output", ""),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(fetchImageMock).not.toHaveBeenCalled();
  });

  it("rejects a filename with a backslash separator", async () => {
    await expect(
      getOutputImage("..\\..\\windows\\win.ini", "output", ""),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(fetchImageMock).not.toHaveBeenCalled();
  });

  it("rejects a filename that is '..'", async () => {
    await expect(
      getOutputImage("..", "output", ""),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(fetchImageMock).not.toHaveBeenCalled();
  });

  it("rejects an empty filename", async () => {
    await expect(
      getOutputImage("", "output", ""),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(fetchImageMock).not.toHaveBeenCalled();
  });

  it("rejects a subfolder containing a NUL byte even if it looks safe", async () => {
    await expect(
      getOutputImage("hero.png", "output", "video\u0000/../.."),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(fetchImageMock).not.toHaveBeenCalled();
  });

  it("rejects a subfolder with an embedded '..' segment between safe parts", async () => {
    await expect(
      getOutputImage("hero.png", "output", "video/../.."),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(fetchImageMock).not.toHaveBeenCalled();
  });
});

describe("getOutputImage — non-image /view payloads (issue #385)", () => {
  // ComfyUI (or a proxy) can answer /view with a 200 whose body is a JSON/HTML
  // error page or is empty — most often for a `type=input` ref that doesn't
  // resolve to a real input file. The old code saved those bytes as a `.png`
  // and returned a corrupt inline image, so the MCP client choked decoding it
  // ("Unexpected end of JSON input"). It must now throw a structured not-found.

  it("throws IMAGE_NOT_FOUND when /view returns a JSON error body for an input ref", async () => {
    fetchImageMock.mockResolvedValue({
      base64: Buffer.from('{"error":"not found"}').toString("base64"),
      mimeType: "application/json",
    });
    const err = await getOutputImage("06.png", "input", "qwen").catch((e) => e);
    expect(err).toBeInstanceOf(ComfyUIError);
    expect(err.code).toBe("IMAGE_NOT_FOUND");
  });

  it("throws IMAGE_NOT_FOUND when /view returns an empty body", async () => {
    fetchImageMock.mockResolvedValue({ base64: "", mimeType: "image/png" });
    await expect(
      getOutputImage("06.png", "input", "qwen"),
    ).rejects.toMatchObject({ code: "IMAGE_NOT_FOUND" });
  });

  it("still resolves for a genuine image payload", async () => {
    // (mock default is image/png with real bytes)
    await expect(getOutputImage("06.png", "input", "qwen")).resolves.toMatchObject({
      mimeType: "image/png",
      filename: "06.png",
    });
  });
});

describe("getOutputImage — video/audio media (issue #663)", () => {
  // /view returns raw bytes for any media type, and video nodes like
  // VHS_VideoCombine legitimately produce .mp4 outputs that get_image must be
  // able to save to disk. allowMedia opts the caller into video/*/audio/*
  // payloads; the junk-body guards (empty / JSON / HTML) still apply.

  it("rejects a video/mp4 payload by default (inline callers stay image-only)", async () => {
    fetchImageMock.mockResolvedValue({
      base64: Buffer.from("fake-mp4").toString("base64"),
      mimeType: "video/mp4",
    });
    await expect(
      getOutputImage("clip_00001_.mp4", "output", "video"),
    ).rejects.toMatchObject({ code: "IMAGE_NOT_FOUND" });
  });

  it("resolves a video/mp4 payload when allowMedia is set", async () => {
    const base64 = Buffer.from("fake-mp4").toString("base64");
    fetchImageMock.mockResolvedValue({ base64, mimeType: "video/mp4" });
    await expect(
      getOutputImage("clip_00001_.mp4", "output", "video", { allowMedia: true }),
    ).resolves.toMatchObject({
      base64,
      mimeType: "video/mp4",
      filename: "clip_00001_.mp4",
    });
  });

  it("still rejects a JSON error body even when allowMedia is set", async () => {
    fetchImageMock.mockResolvedValue({
      base64: Buffer.from('{"error":"not found"}').toString("base64"),
      mimeType: "application/json",
    });
    await expect(
      getOutputImage("clip_00001_.mp4", "output", "video", { allowMedia: true }),
    ).rejects.toMatchObject({ code: "IMAGE_NOT_FOUND" });
  });

  it("still rejects an empty body even when allowMedia is set", async () => {
    fetchImageMock.mockResolvedValue({ base64: "", mimeType: "video/mp4" });
    await expect(
      getOutputImage("clip_00001_.mp4", "output", "video", { allowMedia: true }),
    ).rejects.toMatchObject({ code: "IMAGE_NOT_FOUND" });
  });
});

describe("listOutputImages — remote mode keyed off isRemoteMode (issue #2 regression)", () => {
  it("uses /history (not a local-FS scan) when remote even though COMFYUI_PATH is set", async () => {
    // A remote target coexists with an unrelated local COMFYUI_PATH. Scanning the
    // local output dir would report the WRONG machine's outputs, so the remote
    // branch must key off isRemoteMode(), not mere comfyuiPath presence.
    mockConfig.comfyuiPath = "/comfy";
    mockConfig.remote = true;
    getHistoryMock.mockResolvedValue({
      a: {
        outputs: {
          "1": { images: [{ filename: "remote.png", subfolder: "", type: "output" }] },
        },
      },
    });

    const results = await listOutputImages();
    expect(getHistoryMock).toHaveBeenCalledTimes(1);
    expect(readdirMock).not.toHaveBeenCalled(); // no local-disk scan
    expect(results.map((r) => r.filename)).toEqual(["remote.png"]);
  });
});
