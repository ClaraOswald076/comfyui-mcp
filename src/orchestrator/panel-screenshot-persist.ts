// #2439 — panel_screenshot must write a PNG to a caller-specified path on the
// MCP host. Capture itself already works; the missing half is the write, because
// handing a 200k-character base64 payload to a filesystem command blows the
// Windows command bound (error 206). Fail closed: a bad or occupied path is an
// error, never a silent image-only success.

import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, isAbsolute, resolve } from "node:path";

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;

export class ScreenshotPersistError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScreenshotPersistError";
  }
}

/**
 * Pick the destination the caller named. `save_path` and `output_path` are the
 * same argument; both omitted means "do not write". A blank string is a bad
 * path, not an omit — ignoring it is the original defect.
 */
export function screenshotPersistPathFromArgs(args: Record<string, unknown>): string | undefined {
  const save = optionalPathArg(args.save_path, "save_path");
  const output = optionalPathArg(args.output_path, "output_path");
  if (save !== undefined && output !== undefined && save !== output) {
    throw new ScreenshotPersistError(
      "save_path and output_path disagree — pass one destination, or the same path twice.",
    );
  }
  return save ?? output;
}

/** overwrite is opt-in. Missing / false refuses an existing file. */
export function screenshotOverwriteFromArgs(args: Record<string, unknown>): boolean {
  return args.overwrite === true;
}

/** Resolve and validate a caller-specified PNG path. Throws ScreenshotPersistError. */
export function resolveScreenshotPersistPath(raw: string): string {
  if (CONTROL_CHARS_RE.test(raw)) {
    throw new ScreenshotPersistError("save_path must not contain control characters or NUL bytes.");
  }
  if (!isFullyQualified(raw)) {
    throw new ScreenshotPersistError(
      `save_path must be an absolute path (got ${JSON.stringify(raw)}). ` +
        "A relative or drive-relative path is refused so the PNG cannot land in this process's launch directory.",
    );
  }
  const dest = resolve(raw);
  if (extname(dest).toLowerCase() !== ".png") {
    throw new ScreenshotPersistError(
      `save_path must end in .png (got ${JSON.stringify(dest)}).`,
    );
  }
  return dest;
}

/**
 * Refuse a destination we will not write: a directory, or an existing file when
 * overwrite is false. Call this BEFORE capturing so a blocked path does not
 * burn a screenshot.
 */
export function assertScreenshotPersistAllowed(dest: string, overwrite: boolean): void {
  if (!existsSync(dest)) return;
  let isDir = false;
  try {
    isDir = lstatSync(dest).isDirectory();
  } catch (err) {
    throw persistIoError(dest, err);
  }
  if (isDir) {
    throw new ScreenshotPersistError(
      `save_path ${JSON.stringify(dest)} is a directory — pass a .png file path.`,
    );
  }
  if (!overwrite) {
    throw new ScreenshotPersistError(
      `save_path ${JSON.stringify(dest)} already exists. Pass overwrite:true to replace it.`,
    );
  }
}

export function decodePngBase64(image: string): Buffer {
  const bytes = Buffer.from(image, "base64");
  if (bytes.length < PNG_MAGIC.length || !bytes.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) {
    throw new ScreenshotPersistError("screenshot image is not PNG data.");
  }
  return bytes;
}

/**
 * Write `pngBytes` to `dest` atomically. Returns the resolved path. Throws on
 * any failure; never reports a write that did not land.
 */
export function persistScreenshotPng(dest: string, pngBytes: Buffer, overwrite: boolean): string {
  assertScreenshotPersistAllowed(dest, overwrite);
  const parent = dirname(dest);
  try {
    mkdirSync(parent, { recursive: true });
  } catch (err) {
    throw persistIoError(parent, err);
  }
  const tmp = `${dest}.tmp-${randomUUID()}`;
  try {
    const fd = openSync(tmp, "wx");
    try {
      writeFileSync(fd, pngBytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (overwrite) {
      renameSync(tmp, dest);
    } else {
      // rename overwrites on Windows. COPYFILE_EXCL is the exclusive create.
      copyFileSync(tmp, dest, constants.COPYFILE_EXCL);
      rmSync(tmp, { force: true });
      fsyncFile(dest);
    }
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // Best-effort cleanup; the original failure is the one to report.
    }
    if (err instanceof ScreenshotPersistError) throw err;
    throw persistIoError(dest, err);
  }
  fsyncDirBestEffort(parent);
  return dest;
}

function optionalPathArg(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new ScreenshotPersistError(`${label} must be a string.`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new ScreenshotPersistError(
      `${label} is empty. Pass an absolute .png path, or omit ${label} to skip the write.`,
    );
  }
  return trimmed;
}

/**
 * Independent of this process's cwd AND its drive. `path.isAbsolute` is not that
 * test on Windows: `\Temp` and `C:out` pick up launch state. Those are refused.
 */
function isFullyQualified(p: string): boolean {
  if (process.platform !== "win32") return isAbsolute(p);
  return /^[a-zA-Z]:[\\/]/.test(p) || /^[\\/]{2}[^\\/]/.test(p);
}

function persistIoError(path: string, err: unknown): ScreenshotPersistError {
  const msg = err instanceof Error ? err.message : String(err);
  return new ScreenshotPersistError(`could not write PNG to ${JSON.stringify(path)}: ${msg}`);
}

function fsyncFile(path: string): void {
  const fd = openSync(path, "r+");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function fsyncDirBestEffort(dir: string): void {
  try {
    const dirFd = openSync(dir, "r");
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } catch (err) {
    const code = err instanceof Error && "code" in err ? String(err.code) : "";
    if (code !== "EPERM" && code !== "EINVAL" && code !== "ENOTSUP" && code !== "EISDIR") {
      throw persistIoError(dir, err);
    }
  }
}
