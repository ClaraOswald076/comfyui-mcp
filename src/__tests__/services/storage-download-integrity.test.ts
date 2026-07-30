import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// #343 edge: S3/Azure downloads must enforce the same truncation guard as the
// HTTP path — a cloud stream that ends early can otherwise be reported as a
// complete download. These tests mock the cloud SDKs to a Body that yields
// fewer bytes than the authoritative Content-Length and assert we reject.

const s3Send = vi.fn();
vi.mock("@aws-sdk/client-s3", () => {
  class S3Client {
    send = s3Send;
    destroy() {}
  }
  class GetObjectCommand {
    constructor(public input: unknown) {}
  }
  return { S3Client, GetObjectCommand };
});

const azureDownload = vi.fn();
vi.mock("@azure/storage-blob", () => {
  class BlobServiceClient {
    static fromConnectionString() {
      return new BlobServiceClient();
    }
    getContainerClient() {
      return { getBlobClient: () => ({ download: azureDownload }) };
    }
  }
  return { BlobServiceClient };
});

import { downloadS3ToFile } from "../../services/storage/s3.js";

let tempDir: string;
let target: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "comfyui-mcp-cloud-integrity-"));
  target = join(tempDir, "out.safetensors");
  s3Send.mockReset();
  azureDownload.mockReset();
  process.env.AWS_ACCESS_KEY_ID = "test";
  process.env.AWS_SECRET_ACCESS_KEY = "test";
  process.env.AWS_REGION = "us-east-1";
});

afterEach(async () => {
  delete process.env.AWS_ACCESS_KEY_ID;
  delete process.env.AWS_SECRET_ACCESS_KEY;
  delete process.env.AWS_REGION;
  await rm(tempDir, { recursive: true, force: true });
});

describe("S3 download integrity (#343)", () => {
  it("rejects a truncated S3 object (bytes written < ContentLength)", async () => {
    // Body yields only 5 bytes but S3 declares the object is 1000.
    s3Send.mockResolvedValueOnce({
      Body: Readable.from(Buffer.from("short")),
      ContentLength: 1000,
    });

    await expect(downloadS3ToFile("s3://bucket/key.safetensors", target)).rejects.toThrow(
      /truncat/i,
    );
  });

  it("accepts a complete S3 object whose written bytes match ContentLength", async () => {
    const body = Buffer.from("exactly-right-bytes");
    s3Send.mockResolvedValueOnce({
      Body: Readable.from(body),
      ContentLength: body.length,
    });

    await downloadS3ToFile("s3://bucket/ok.safetensors", target);
    await expect(readFile(target, "utf-8")).resolves.toBe("exactly-right-bytes");
    expect((await stat(target)).size).toBe(body.length);
  });

  it("does not falsely reject when ContentLength is absent (size unknown)", async () => {
    const body = Buffer.from("no-length-header-body");
    s3Send.mockResolvedValueOnce({ Body: Readable.from(body) });

    await downloadS3ToFile("s3://bucket/nolen.safetensors", target);
    await expect(readFile(target, "utf-8")).resolves.toBe("no-length-header-body");
  });
});
