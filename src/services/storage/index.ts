import { createHash } from "node:crypto";
import { ValidationError } from "../../utils/errors.js";
import { isAzureBlobUrl, downloadAzureBlobToFile, uploadAzureBlobFile } from "./azure-blob.js";
import { uploadHfFile } from "./hf.js";
import { isHttpUrl, uploadHttpFile } from "./http.js";
import { downloadS3ToFile, isS3Url, uploadS3File } from "./s3.js";
import type {
  CloudStorageAuth,
  StorageUploadResult,
  StorageUploadSource,
} from "./types.js";

export type UploadDestination =
  | { s3: { bucket: string; prefix?: string; async?: boolean } }
  | { azure: { container: string; blob_prefix?: string } }
  | { http: { url: string } }
  | { hf: { repo: string; repo_type?: "model" | "dataset" | "space"; path?: string } };

export function supportsCloudDownload(url: string): boolean {
  return isS3Url(url) || isAzureBlobUrl(url);
}

/**
 * A short, stable discriminator for the EFFECTIVE cloud principal/endpoint that
 * WOULD serve `url` right now — the explicit `auth` MERGED with the same
 * environment fallbacks the real downloaders use (s3.ts makeS3Client,
 * azure-blob.ts blobServiceClientFromEnv). Folded into the download cache identity
 * (#467 P1-B) so a cache entry populated under one principal/endpoint can NEVER be
 * served later under different or absent credentials (cross-principal leak): if the
 * effective principal changes, the cache identity changes → cache miss → re-fetch.
 *
 * Secrets are hashed here and never leave this module in the clear. Empty string
 * for a non-cloud URL (the caller omits it from the identity).
 */
export function cloudPrincipalKey(url: string, auth: CloudStorageAuth = {}): string {
  let raw: string | undefined;
  if (isS3Url(url)) {
    const s3 = auth.s3;
    const endpoint = s3?.endpoint ?? process.env.AWS_S3_ENDPOINT ?? "";
    const region = s3?.region ?? process.env.AWS_REGION ?? "";
    const accessKeyId = s3?.access_key_id ?? process.env.AWS_ACCESS_KEY_ID ?? "";
    const secretAccessKey = s3?.secret_access_key ?? process.env.AWS_SECRET_ACCESS_KEY ?? "";
    const sessionToken = s3?.session_token ?? process.env.AWS_SESSION_TOKEN ?? "";
    raw = `s3\n${endpoint}\n${region}\n${accessKeyId}\n${secretAccessKey}\n${sessionToken}`;
  } else if (isAzureBlobUrl(url)) {
    // Azure download uses env creds (connection string, else account+key), else
    // anonymous. The blob host already encodes the account (part of `url`), so the
    // principal here is purely the env credential material.
    const conn = process.env.AZURE_STORAGE_CONNECTION_STRING ?? "";
    const account = process.env.AZURE_STORAGE_ACCOUNT ?? "";
    const key = process.env.AZURE_STORAGE_KEY ?? "";
    raw = `azure\n${conn}\n${account}\n${key}`;
  }
  return raw ? createHash("sha256").update(raw).digest("hex").slice(0, 16) : "";
}

export async function downloadCloudUrlToFile(
  url: string,
  targetPath: string,
  auth: CloudStorageAuth = {},
): Promise<void> {
  if (isS3Url(url)) {
    await downloadS3ToFile(url, targetPath, auth.s3);
    return;
  }
  if (isAzureBlobUrl(url)) {
    await downloadAzureBlobToFile(url, targetPath);
    return;
  }
  throw new ValidationError(
    "Unsupported cloud storage download URL. Expected s3://bucket/key or an Azure Blob URL.",
  );
}

export async function uploadToStorage(
  source: StorageUploadSource,
  destination: UploadDestination,
  auth: CloudStorageAuth = {},
): Promise<StorageUploadResult> {
  const keys = Object.keys(destination);
  if (keys.length !== 1) {
    throw new ValidationError("Provide exactly one upload destination: s3, azure, http, or hf.");
  }

  if ("s3" in destination) {
    return uploadS3File(source, destination.s3, auth.s3);
  }
  if ("azure" in destination) {
    return uploadAzureBlobFile(source, destination.azure);
  }
  if ("http" in destination) {
    if (!isHttpUrl(destination.http.url)) {
      throw new ValidationError("http.url must start with http:// or https://.");
    }
    return uploadHttpFile(source, destination.http);
  }
  if ("hf" in destination) {
    return uploadHfFile(source, destination.hf);
  }

  throw new ValidationError("Unsupported upload destination. Expected s3, azure, http, or hf.");
}

export type {
  CloudStorageAuth,
  S3Auth,
  StorageUploadResult,
  StorageUploadSource,
} from "./types.js";

