// #1701 — the tray announced "Model download transfer completed" for
// t5xxl_flux1_int8_convrot.safetensors while download_model action:"status"
// still said downloading and dest did not exist.
//
// The orchestrator raises that event from the first progress row with
// status "done" (#547). streamUrlToFile used to emit that row when the
// CACHE write finished — then Windows spent minutes COPYing the file
// into models/text_encoders/. Status still said downloading because
// the job only commits done at the dest rename (onLanded).
//
// Drive the real downloadModel (the local writer download_model uses).
// Hold the copy-materialize mid-flight. A "done" row during that hold
// is the reported false completion.

import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { waitFor } from "../helpers/wait-for.js";

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

const progressRows = vi.hoisted(
  () => [] as Array<{ status: string; downloaded?: number }>,
);
const destAtDone = vi.hoisted(() => ({
  path: "",
  existed: [] as boolean[],
  check: (_p: string): boolean => false,
}));

vi.mock("../../services/download-progress.js", async () => {
  const actual = await vi.importActual<typeof import("../../services/download-progress.js")>(
    "../../services/download-progress.js",
  );
  return {
    ...actual,
    reportDownloadProgress: (p: { status: string; downloaded?: number }) => {
      progressRows.push({ status: p.status, downloaded: p.downloaded });
      if (p.status === "done") destAtDone.existed.push(destAtDone.check(destAtDone.path));
    },
  };
});

import { config } from "../../config.js";
import { downloadCacheFs } from "../../services/download-cache.js";
import { downloadModel } from "../../services/model-resolver.js";
import { setDownloadRetryPolicyForTests } from "../../services/download-retry.js";

const fetchMock = vi.fn();
let tempDir: string;

function okResponse(body: string): Response {
  return new Response(body, { status: 200, statusText: "OK" });
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "comfyui-mcp-1701-"));
  process.env.COMFYUI_DOWNLOAD_CACHE_DIR = join(tempDir, "cache");
  delete process.env.COMFYUI_LRU_CACHE_SIZE_GB;
  config.comfyuiPath = join(tempDir, "comfy");
  config.huggingfaceToken = undefined;
  config.civitaiApiToken = undefined;
  destAtDone.path = "";
  destAtDone.existed = [];
  destAtDone.check = (p) => p !== "" && existsSync(p);
  progressRows.length = 0;
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  setDownloadRetryPolicyForTests({ maxAttempts: 1, stallTimeoutMs: 0 });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.COMFYUI_DOWNLOAD_CACHE_DIR;
  delete process.env.COMFYUI_LRU_CACHE_SIZE_GB;
  await rm(tempDir, { recursive: true, force: true });
});

describe("a done progress row means dest exists (#1701)", () => {
  it("does not emit done while the dest copy is still in flight", async () => {
    const filename = "t5xxl_flux1_int8_convrot.safetensors";
    const dest = join(tempDir, "comfy", "models", "text_encoders", filename);
    destAtDone.path = dest;

    let releaseCopy!: () => void;
    const copyHeld = new Promise<void>((r) => {
      releaseCopy = r;
    });
    let copyEntered = false;
    const realCopy = downloadCacheFs.copyFile.bind(downloadCacheFs);
    vi.spyOn(downloadCacheFs, "link").mockRejectedValue(
      Object.assign(new Error("cross-device link"), { code: "EXDEV" }),
    );
    vi.spyOn(downloadCacheFs, "copyFile").mockImplementation(async (src, destPath, mode) => {
      copyEntered = true;
      await copyHeld;
      return realCopy(src, destPath, mode);
    });

    fetchMock.mockResolvedValueOnce(okResponse("T5XXL-PAYLOAD-BYTES"));

    const pending = downloadModel(
      "https://huggingface.co/org/repo/resolve/main/t5xxl_flux1_int8_convrot.safetensors",
      "text_encoders",
      filename,
    );

    await waitFor(() => copyEntered);
    expect(existsSync(dest)).toBe(false);
    expect(progressRows.some((r) => r.status === "done")).toBe(false);

    releaseCopy();
    const landed = await pending;
    expect(landed).toBe(dest);
    await expect(readFile(dest, "utf-8")).resolves.toBe("T5XXL-PAYLOAD-BYTES");

    expect(progressRows.some((r) => r.status === "done")).toBe(true);
    expect(destAtDone.existed.length).toBeGreaterThan(0);
    expect(destAtDone.existed.every(Boolean)).toBe(true);
  });
});
