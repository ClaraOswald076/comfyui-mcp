// Durable, atomic write for small records whose loss is LOAD-BEARING (#798).
//
// The defect shape: a marker/journal/settings file is written and then
// immediately ACTED on — a rename, a Manager handoff, a "you are protected"
// report — where the action is externally visible and the record is the only
// thing that makes the action recoverable or the report true. A buffered
// write can be lost while the action survives (ordering in the source is not
// ordering on disk), and a plain truncate-and-write can leave a TORN file
// behind after a crash — which every later read then correctly treats as
// "cannot prove anything", permanently, until someone deletes it by hand.
//
// So: write to a sibling temp file, fsync it, rename it over the target
// (atomic on the same volume — readers only ever see the old record or the
// new one, never a torn one), then fsync the containing directory so the
// entry itself survives. Platforms that CANNOT fsync a directory (notably
// Windows) get a pass on that last step — the file's own fsync still stands —
// but a directory fsync that fails for any OTHER reason (EIO, …) throws:
// the entry's durability is then unproven, and a load-bearing record must not
// be reported as durably written when it was not.

import { closeSync, fsyncSync, openSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";

/**
 * Write `contents` to `path` atomically and durably. THROWS on failure — the
 * caller's contract is that a returned write is on disk, so a failure must
 * refuse the action the write was to precede, never proceed unrecorded.
 */
export function writeFileDurable(path: string, contents: string): void {
  const tmp = `${path}.tmp-${randomUUID()}`;
  try {
    const fd = openSync(tmp, "w");
    try {
      writeFileSync(fd, contents, "utf-8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    // Atomic over the target: a reader never observes a half-written record.
    renameSync(tmp, path);
  } catch (err) {
    // Never leave a torn temp record behind for a later reader to trip over.
    try {
      rmSync(tmp, { force: true });
    } catch {
      // Best-effort cleanup; the original failure is the one to report.
    }
    throw err;
  }
  try {
    const dirFd = openSync(dirname(path), "r");
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } catch (err) {
    // Swallow ONLY "this platform cannot fsync a directory" (Windows: fsync on
    // a directory handle is EPERM; some platforms refuse the open itself).
    // Anything else (EIO, …) means the rename's directory entry is NOT proven
    // durable — for a load-bearing record the write must fail, not be
    // reported as a durable success (codex gate).
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== "EPERM" && code !== "EINVAL" && code !== "ENOTSUP" && code !== "EISDIR") {
      throw err;
    }
  }
}
