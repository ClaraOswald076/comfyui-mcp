// The credential store is the user's ONLY copy of their tokens, and it was
// rewritten in place: read, truncate, write. Two accidental failure modes, both
// live on a real machine, and both invisible because the read-back only checked
// the key being set (coordinator finding):
//
//   1. a crash or a full disk between truncate and flush left the WHOLE store
//      truncated — every token, not just the one being written;
//   2. two writers each read the old file and the later write silently dropped
//      the other's newly saved key.
//
// In both cases the per-key read-back still said "yes", so we confirmed a save
// while other credentials were destroyed — a fabricated success on top of data
// loss, which is the worst outcome in this codebase's ranking.
//
// These tests pin the atomic write (temp + fsync + rename), the compare-and-swap
// that stops a concurrent writer being clobbered, and the whole-file
// verification that REPORTS a loss instead of confirming a save over it.

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fsState = vi.hoisted(() => ({
  /** Make the rename fail, as a crash/full-disk would, AFTER the temp file was
   *  written — the moment the old in-place write had already truncated. */
  failRename: false,
  /** Fail only the Nth store rename (1-based) — so one alias of a slot fan-out
   *  can be made to throw while an earlier one has already landed. */
  failRenameAt: 0,
  /** Simulate another process writing the store between our first read and the
   *  compare-and-swap re-read, which is the window the CAS exists to close.
   *  Fires immediately BEFORE the given store-read index. */
  concurrentWriteBeforeRead: null as null | { at: number; run: () => void },
  /** Simulate another process writing the store AFTER a given store read — in
   *  particular after read #2, the compare-and-swap re-check. That is the window
   *  the CAS cannot close, and injecting only BEFORE read #2 is why a save that
   *  clobbered such a writer went on reporting itself clean (codex gate). */
  concurrentWriteAfterRead: null as null | { at: number; run: () => void },
  storeReads: 0,
  /** Replace what the rename installs, to force the whole-file verification to
   *  see keys go missing. Fires on the NEXT store rename. */
  tamperOnRename: null as null | (() => string),
  /** Per-rename tamper, indexed by store-rename number (1-based) — so a specific
   *  write in a multi-write sequence (a slot fan-out, then its rollback) can be
   *  singled out. */
  tamperAtRename: {} as Record<number, () => string>,
  renames: 0,
  /** Every path ever passed to writeFileSync — proves the target is not written
   *  in place. */
  directWrites: [] as string[],
  /** Directories whose handle was fsynced. A rename is not durable without this,
   *  and it was missing entirely. */
  dirFsyncs: [] as string[],
  /** Break the FIRST store read that happens after a rename — the writer's own
   *  whole-file verification. The rename has already landed by then, so this is
   *  the case that must DISCLOSE rather than throw. */
  failFirstReadAfterRename: false,
  /** -1 until a rename has happened, so a read taken BEFORE the store was ever
   *  swapped is never mistaken for the post-rename verification. */
  readsSinceRename: -1,
  /** Make the FILE fsync fail, the way a full/failing device would. */
  failFileFsync: false,
  /** Make the DIRECTORY fsync fail. */
  failDirFsync: false,
  /** Make OPENING the store's directory fail with this errno. */
  dirOpenError: null as string | null,
  /** Make removal of the pre-write snapshot fail, the way EPERM/EBUSY does. */
  failSentinelRemoval: false,
  /** Simulate another process CREATING the store right after the given
   *  existsSync answered "no". When the store is absent there is no read to
   *  hang this off — the absent path never calls readFileSync — so the
   *  check-then-act pair that has to be tested is the existsSync one. */
  concurrentCreateAfterExists: null as null | { at: number; run: () => void },
  storeExists: 0,
  /** Source paths the pre-write snapshot was linked FROM. */
  links: [] as string[],
  /** Make writing the LEGACY json store fail — it happens after the .env
   *  removal has already landed. */
  failJsonStoreWrite: false,
  /** Make hard links unavailable, as exFAT and some network mounts do, so the
   *  COPY fallback for the pre-write snapshot is exercised. */
  failLink: false,
  /** Make writeSync accept only this many bytes per call (0 = unlimited), so a
   *  SHORT write is testable: an unchecked one installs a truncated store. */
  maxWriteBytes: 0,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const isStore = (p: unknown) => String(p).endsWith(".env");
  const renameSync: typeof actual.renameSync = (from, to) => {
    if (isStore(to)) {
      fsState.renames++;
      if (fsState.failRename || fsState.renames === fsState.failRenameAt) {
        throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
      }
      const tamper = fsState.tamperOnRename ?? fsState.tamperAtRename[fsState.renames];
      if (tamper) {
        fsState.tamperOnRename = null;
        delete fsState.tamperAtRename[fsState.renames];
        actual.writeFileSync(from, tamper());
      }
    }
    const out = actual.renameSync(from, to);
    if (isStore(to)) fsState.readsSinceRename = 0;
    return out;
  };
  const writeFileSyncSpy: typeof actual.writeFileSync = (path, ...rest) => {
    fsState.directWrites.push(String(path));
    return (actual.writeFileSync as (...a: unknown[]) => void)(path, ...rest);
  };
  const readFileSync: typeof actual.readFileSync = ((
    ...args: Parameters<typeof actual.readFileSync>
  ) => {
    let after: null | { at: number; run: () => void } = null;
    if (isStore(args[0])) {
      fsState.storeReads++;
      if (fsState.readsSinceRename >= 0) fsState.readsSinceRename++;
      if (fsState.failFirstReadAfterRename && fsState.readsSinceRename === 1) {
        throw Object.assign(new Error("EIO: i/o error, read"), { code: "EIO" });
      }
      const c = fsState.concurrentWriteBeforeRead;
      if (c && fsState.storeReads === c.at) {
        fsState.concurrentWriteBeforeRead = null; // once, so the retry can settle
        c.run();
      }
      const a = fsState.concurrentWriteAfterRead;
      if (a && fsState.storeReads === a.at) {
        fsState.concurrentWriteAfterRead = null;
        after = a;
      }
    }
    const out = actual.readFileSync(...args);
    // The other process lands AFTER this read returned — so the value we just
    // read is already stale by the time the caller acts on it.
    if (after) after.run();
    return out;
  }) as typeof actual.readFileSync;
  // Track which fd belongs to which path so an fsync can be attributed to the
  // FILE or to its DIRECTORY — they are different durability guarantees.
  const fdPaths = new Map<number, string>();
  const openSync: typeof actual.openSync = ((...args: Parameters<typeof actual.openSync>) => {
    if (fsState.dirOpenError) {
      let isDir = false;
      try {
        isDir = actual.statSync(String(args[0])).isDirectory();
      } catch {
        /* not a directory */
      }
      if (isDir) {
        throw Object.assign(new Error(`${fsState.dirOpenError}: cannot open directory`), {
          code: fsState.dirOpenError,
        });
      }
    }
    const fd = actual.openSync(...args);
    fdPaths.set(fd, String(args[0]));
    return fd;
  }) as typeof actual.openSync;
  const fsyncSync: typeof actual.fsyncSync = (fd) => {
    const path = fdPaths.get(fd) ?? "";
    let isDir = false;
    try {
      isDir = !!path && actual.statSync(path).isDirectory();
    } catch {
      /* gone already; treat as a file */
    }
    if (isDir) {
      if (fsState.failDirFsync) {
        throw Object.assign(new Error("EIO: i/o error, fsync"), { code: "EIO" });
      }
      fsState.dirFsyncs.push(path);
      return; // Windows answers EPERM here; the real call is what we're standing in for
    }
    if (fsState.failFileFsync) {
      throw Object.assign(new Error("EIO: i/o error, fsync"), { code: "EIO" });
    }
    return actual.fsyncSync(fd);
  };
  const writeSync = ((fd: number, ...rest: unknown[]) => {
    const path = fdPaths.get(fd) ?? "";
    if (fsState.failJsonStoreWrite && path.includes("panel-secrets.json")) {
      throw Object.assign(new Error("EACCES: permission denied, write"), { code: "EACCES" });
    }
    // Short write: accept only part of what was offered, exactly as a real
    // filesystem is allowed to. An unchecked caller then fsyncs and renames a
    // TRUNCATED file over the store.
    if (fsState.maxWriteBytes > 0 && Buffer.isBuffer(rest[0])) {
      const [buf, offset, length] = rest as [Buffer, number, number];
      const take = Math.min(length, fsState.maxWriteBytes);
      return (actual.writeSync as (...a: unknown[]) => number)(fd, buf, offset, take);
    }
    return (actual.writeSync as (...a: unknown[]) => number)(fd, ...rest);
  }) as typeof actual.writeSync;
  const linkSync: typeof actual.linkSync = (from, to) => {
    if (isStore(from)) fsState.links.push(String(from));
    if (fsState.failLink && isStore(from)) {
      throw Object.assign(new Error("EPERM: operation not permitted, link"), { code: "EPERM" });
    }
    return actual.linkSync(from, to);
  };
  const existsSync: typeof actual.existsSync = (path) => {
    const out = actual.existsSync(path);
    if (isStore(path)) {
      fsState.storeExists++;
      const c = fsState.concurrentCreateAfterExists;
      if (c && fsState.storeExists === c.at) {
        fsState.concurrentCreateAfterExists = null;
        c.run(); // lands AFTER this answer, so the answer is already stale
      }
    }
    return out;
  };
  const rmSync: typeof actual.rmSync = (path, options) => {
    if (fsState.failSentinelRemoval && String(path).includes(".pre-")) {
      throw Object.assign(new Error("EPERM: operation not permitted, unlink"), { code: "EPERM" });
    }
    return actual.rmSync(path, options);
  };
  return {
    ...actual,
    default: {
      ...actual,
      renameSync,
      writeFileSync: writeFileSyncSpy,
      readFileSync,
      openSync,
      fsyncSync,
      rmSync,
      existsSync,
      linkSync,
      writeSync,
    },
    renameSync,
    writeFileSync: writeFileSyncSpy,
    readFileSync,
    openSync,
    fsyncSync,
    rmSync,
    existsSync,
    linkSync,
    writeSync,
  };
});

import {
  migrateSecretsToEnv,
  removeComfyuiSecret,
  setComfyuiSecret,
  setPanelSecret,
  type SecretRemoveOutcome,
} from "../../services/panel-secrets.js";
import { parseEnvFile, resetEnvFileProvenanceForTests } from "../../env-file.js";

const KEYS = ["CIVITAI_API_TOKEN", "HF_TOKEN", "HUGGINGFACE_TOKEN", "RUNPOD_API_KEY"];

let dir: string;
let envPath: string;
let saved: Record<string, string | undefined>;

/** A store with several tokens and a comment — i.e. something to lose. */
const POPULATED = "# my credentials\nRUNPOD_API_KEY=rp-keep-me\nHF_TOKEN=hf-keep-me\n";

beforeEach(() => {
  fsState.failRename = false;
  fsState.failRenameAt = 0;
  fsState.concurrentWriteBeforeRead = null;
  fsState.concurrentWriteAfterRead = null;
  fsState.tamperOnRename = null;
  fsState.tamperAtRename = {};
  fsState.renames = 0;
  fsState.storeReads = 0;
  fsState.directWrites = [];
  fsState.dirFsyncs = [];
  fsState.failFileFsync = false;
  fsState.failDirFsync = false;
  fsState.dirOpenError = null;
  fsState.failFirstReadAfterRename = false;
  fsState.failSentinelRemoval = false;
  fsState.concurrentCreateAfterExists = null;
  fsState.storeExists = 0;
  fsState.links = [];
  fsState.failJsonStoreWrite = false;
  fsState.failLink = false;
  fsState.maxWriteBytes = 0;
  fsState.readsSinceRename = -1;
  dir = mkdtempSync(join(tmpdir(), "cmcp-atomic-"));
  envPath = join(dir, ".env");
  process.env.COMFYUI_MCP_ENV_FILE = envPath;
  process.env.COMFYUI_MCP_PANEL_SECRETS = join(dir, "panel-secrets.json");
  saved = {};
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  resetEnvFileProvenanceForTests();
});

afterEach(() => {
  delete process.env.COMFYUI_MCP_ENV_FILE;
  delete process.env.COMFYUI_MCP_PANEL_SECRETS;
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetEnvFileProvenanceForTests();
  rmSync(dir, { recursive: true, force: true });
});

describe("the credential store is written ATOMICALLY", () => {
  it("never writes the target in place — it renames a temp file over it", () => {
    writeFileSync(envPath, POPULATED, { mode: 0o600 });
    fsState.directWrites = []; // ignore this test's own setup write
    setComfyuiSecret("CIVITAI_API_TOKEN", "civ-new");
    expect(fsState.renames).toBeGreaterThan(0);
    // The store itself is never handed to writeFileSync; only temp files are.
    expect(fsState.directWrites.filter((p) => p === envPath)).toEqual([]);
  });

  it("leaves the store INTACT when the write fails partway", () => {
    // The old in-place write had already truncated by this point, so a failure
    // here destroyed every token in the file.
    writeFileSync(envPath, POPULATED, { mode: 0o600 });
    fsState.failRename = true;
    expect(() => setComfyuiSecret("CIVITAI_API_TOKEN", "civ-new")).toThrow(/ENOSPC/);
    fsState.failRename = false;
    expect(readFileSync(envPath, "utf-8")).toBe(POPULATED);
    const after = parseEnvFile()!;
    expect(after.RUNPOD_API_KEY).toBe("rp-keep-me");
    expect(after.HF_TOKEN).toBe("hf-keep-me");
  });

  it("writes EVERY byte — a short write never becomes the installed store", () => {
    // `writeSync` is allowed to write fewer bytes than it was given, and its
    // return value was ignored. A short write followed by an fsync makes a
    // TRUNCATED temp file durable, and the rename then installs it over the
    // store — the whole-file truncation this atomic write exists to prevent,
    // arriving by the one route nobody was checking (codex gate).
    writeFileSync(envPath, POPULATED, { mode: 0o600 });
    fsState.maxWriteBytes = 7; // every write is chopped to 7 bytes
    const r = setComfyuiSecret("CIVITAI_API_TOKEN", "civ-new-and-fairly-long-value");
    fsState.maxWriteBytes = 0;
    expect(r.persisted).toBe("yes");
    const after = parseEnvFile()!;
    expect(after.CIVITAI_API_TOKEN).toBe("civ-new-and-fairly-long-value");
    // Nothing was silently dropped off the end.
    expect(after.RUNPOD_API_KEY).toBe("rp-keep-me");
    expect(after.HF_TOKEN).toBe("hf-keep-me");
    expect(readFileSync(envPath, "utf-8")).toContain("# my credentials");
  });

  it("leaves no temp files behind when the write fails", () => {
    writeFileSync(envPath, POPULATED, { mode: 0o600 });
    fsState.failRename = true;
    try {
      setComfyuiSecret("CIVITAI_API_TOKEN", "civ-new");
    } catch {
      /* expected */
    }
    fsState.failRename = false;
    const strays = readdirSyncSafe(dir).filter((f) => f.includes(".tmp-"));
    expect(strays).toEqual([]);
  });

  it("does not drop a CONCURRENT writer's key (compare-and-swap + retry)", () => {
    // Another process saves RUNPOD_API_KEY between our read and our write. The
    // old read/modify/write computed its new content from the stale file and
    // clobbered them.
    writeFileSync(envPath, "# base\n", { mode: 0o600 });
    // Read 1 is our raw read; read 2 is the compare-and-swap re-read. The other
    // process lands in between — exactly the window the CAS exists to close.
    fsState.concurrentWriteBeforeRead = {
      at: 2,
      run: () => {
        writeFileSync(envPath, "# base\nRUNPOD_API_KEY=rp-from-other-process\n", { mode: 0o600 });
      },
    };
    const r = setComfyuiSecret("CIVITAI_API_TOKEN", "civ-new");
    const after = parseEnvFile()!;
    expect(after.CIVITAI_API_TOKEN).toBe("civ-new"); // ours landed
    expect(after.RUNPOD_API_KEY).toBe("rp-from-other-process"); // and theirs survived
    expect(r.lostKeys ?? []).toEqual([]);
    // And the receipt does NOT call it a confirmed save. The retry preserved the
    // other writer's key, but a writer we collided with once can equally land in
    // the check→rename window of the attempt that succeeded — where nothing can
    // see it. `lostKeys: []` from an account taken under contention is not a
    // statement that nothing was lost, and the verdict has to say so.
    expect(r.persisted).toBe("unknown");
    expect(r.uncertainty).toMatch(/another process was writing/);
    expect(r.uncertainty).toMatch(/two adjacent operations/);
  });

  it("REPORTS the key of a writer that lands AFTER the compare-and-swap re-read", () => {
    // THE window the compare-and-swap cannot close, and the case the receipt used
    // to narrate as a clean save: writer B lands between our `current !== raw`
    // check (read 2) and our rename, so our rename replaces B's file. Computing
    // the loss account from the read we did EARLIER made B's key appear in
    // neither snapshot — destroyed, and reported as "nothing lost". The old test
    // only ever injected BEFORE read 2, which is why it survived (codex gate).
    //
    // The account is now taken from the file we ACTUALLY replaced, so B's key is
    // reported rather than vanishing.
    writeFileSync(envPath, "# base\n", { mode: 0o600 });
    fsState.concurrentWriteAfterRead = {
      at: 2,
      run: () => {
        writeFileSync(envPath, "# base\nRUNPOD_API_KEY=rp-from-other-process\n", { mode: 0o600 });
      },
    };
    const r = setComfyuiSecret("CIVITAI_API_TOKEN", "civ-new");
    // Our key landed, and B's really is gone — that is the damage.
    expect(parseEnvFile()!.CIVITAI_API_TOKEN).toBe("civ-new");
    expect(parseEnvFile()!.RUNPOD_API_KEY).toBeUndefined();
    // ...and it is REPORTED, not narrated away.
    expect(r.lostKeys).toContain("RUNPOD_API_KEY");
    // The verdict itself is what stops any caller rendering this as a save:
    // every success test in the codebase is `persisted === "yes"`.
    expect(r.persisted).toBe("damaged");
  });

  it("preserves comments and unrelated keys through a normal save", () => {
    writeFileSync(envPath, POPULATED, { mode: 0o600 });
    const r = setComfyuiSecret("CIVITAI_API_TOKEN", "civ-new");
    expect(r.lostKeys ?? []).toEqual([]);
    const raw = readFileSync(envPath, "utf-8");
    expect(raw).toContain("# my credentials");
    expect(raw).toContain("rp-keep-me");
    expect(raw).toContain("hf-keep-me");
  });
});

describe("a save is never CONFIRMED over lost credentials", () => {
  it("REPORTS other keys the store no longer carries", () => {
    // Force the installed content to be missing an unrelated token, the way a
    // partial write or a hostile interleaving would.
    writeFileSync(envPath, POPULATED, { mode: 0o600 });
    fsState.tamperOnRename = () => "CIVITAI_API_TOKEN=civ-new\n"; // RUNPOD + HF gone
    const r = setComfyuiSecret("CIVITAI_API_TOKEN", "civ-new");
    expect(r.lostKeys).toContain("RUNPOD_API_KEY");
    expect(r.lostKeys).toContain("HF_TOKEN");
    // The key we set IS present, so a per-key check says "saved" — and that is
    // exactly why the verdict itself has to carry the damage. `persisted` is the
    // single field every consumer tests for success, so a damaged store can no
    // longer read as a save at ANY of them by being overlooked at one.
    expect(r.persisted).toBe("damaged");
    expect(r.persisted).not.toBe("yes");
  });

  it("reports NO loss on a healthy save", () => {
    writeFileSync(envPath, POPULATED, { mode: 0o600 });
    const r = setComfyuiSecret("CIVITAI_API_TOKEN", "civ-new");
    expect(r.lostKeys).toBeUndefined();
    expect(r.persisted).toBe("yes");
  });

  it("a REVOKE that loses other keys DISCLOSES it instead of throwing", () => {
    // It used to throw. But the removal had ALREADY HAPPENED by then, so the
    // throw turned a completed destructive operation into a generic failure —
    // which the console rendered as `ok:false` and the caller retried, running a
    // second removal against a store that had already lost credentials (codex
    // gate). After the rename there are only disclosures.
    writeFileSync(envPath, `${POPULATED}CIVITAI_API_TOKEN=civ-old\n`, { mode: 0o600 });
    fsState.tamperOnRename = () => "# everything else gone\n";
    let out: ReturnType<typeof removeComfyuiSecret> | undefined;
    expect(() => {
      out = removeComfyuiSecret("CIVITAI_API_TOKEN");
    }).not.toThrow();
    expect(out!.changed).toBe(true); // it happened
    expect(out!.lostKeys).toContain("RUNPOD_API_KEY");
    expect(out!.lostKeys).toContain("HF_TOKEN");
  });

  it("ATTEMPTS the pre-write snapshot even when the store looks absent", () => {
    // When the store did not exist, the snapshot used to be skipped on the
    // strength of a SEPARATE `existsSync` — a second check-then-act pair sitting
    // in front of the one the sentinel exists to narrow (codex gate). The link
    // is attempted unconditionally now, and its ENOENT is itself the
    // observation, taken at the swap rather than earlier.
    //
    // HONEST LIMIT: this makes the absent case symmetric with the present one
    // and removes a whole extra window, but it does NOT close the residual
    // link→rename window — nothing in-process can, and that is stated in
    // `rewriteEnvFile`. What is asserted here is the attempt, which is the part
    // that actually changed.
    rmSync(envPath, { force: true });
    fsState.links = [];
    setComfyuiSecret("CIVITAI_API_TOKEN", "civ-first");
    expect(fsState.links).toContain(envPath);
  });

  it("REPORTS a writer that CREATES the store before the snapshot is taken", () => {
    rmSync(envPath, { force: true }); // start with NO store at all
    // existsSync #1 is the writer's own "does it exist?"; #2 is the
    // compare-and-swap's. The other process creates the file right after #2 —
    // i.e. inside the window the old code walked straight through.
    fsState.concurrentCreateAfterExists = {
      at: 2,
      run: () => {
        writeFileSync(envPath, "RUNPOD_API_KEY=rp-from-other-process\n", { mode: 0o600 });
      },
    };
    const r = setComfyuiSecret("CIVITAI_API_TOKEN", "civ-new");
    expect(parseEnvFile()!.CIVITAI_API_TOKEN).toBe("civ-new");
    expect(parseEnvFile()!.RUNPOD_API_KEY).toBeUndefined(); // theirs really is gone
    expect(r.lostKeys).toContain("RUNPOD_API_KEY"); // ...and it is REPORTED
    expect(r.persisted).toBe("damaged");
  });

  it("still reports a clean save on a genuinely FIRST write (no prior store)", () => {
    // The counterpart: when nothing was there and nothing appeared, the account
    // is complete and the save is confirmed. Without this the fix above could
    // "pass" by calling every first write damaged.
    rmSync(envPath, { force: true });
    const r = setComfyuiSecret("CIVITAI_API_TOKEN", "civ-new");
    expect(r.persisted).toBe("yes");
    expect(r.lostKeys).toBeUndefined();
  });

  it("does not claim a CLEAN account when the snapshot had to be COPIED", () => {
    // On a filesystem without hard links the snapshot falls back to a copy. A
    // copy is not atomic and takes measurable time, so a writer landing during
    // it — or between it and the rename — is invisible to it. Treating that as
    // the same observation as the link claimed a completeness it does not have
    // (codex gate). The key still saves; the ACCOUNT is what is downgraded.
    writeFileSync(envPath, POPULATED, { mode: 0o600 });
    fsState.failLink = true;
    const r = setComfyuiSecret("CIVITAI_API_TOKEN", "civ-new");
    fsState.failLink = false;
    expect(parseEnvFile()!.CIVITAI_API_TOKEN).toBe("civ-new"); // it did save
    expect(r.persisted).not.toBe("yes");
    expect(r.persisted).toBe("unknown");
    expect(r.uncertainty).toMatch(/does not support hard links/);
    expect(r.uncertainty).toMatch(/not atomic/);
  });

  it("REPORTS a pre-write snapshot it could not delete — the sweep will not catch it", async () => {
    // The snapshot this operation just took is FRESH, and the stale sweep
    // deliberately leaves fresh files alone (it cannot tell a live writer's from
    // ours). So a failure to delete it was log-only and a revoke came back clean
    // with a readable copy of the revoked credential beside the store (codex
    // gate).
    const { revokeIsClean } = await import("../../services/panel-secrets.js");
    writeFileSync(envPath, "CIVITAI_API_TOKEN=civ-old\n", { mode: 0o600 });
    fsState.failSentinelRemoval = true;
    const out = removeComfyuiSecret("CIVITAI_API_TOKEN");
    fsState.failSentinelRemoval = false;
    expect(out.changed).toBe(true); // the revoke happened
    expect(out.resurrectionRisk).toMatch(/pre-write snapshot this removal took could not be deleted/);
    expect(out.resurrectionRisk).toMatch(/still contains the old credential/);
    expect(revokeIsClean(out)).toBe(false);
    expect(JSON.stringify(out)).not.toContain("civ-old"); // names only
  });

  it("does not throw when the pre-write snapshot cannot be removed", () => {
    // The cleanup runs AFTER the rename. An unguarded `rmSync` that throws there
    // discards the whole disclosure about a store that has already changed —
    // the exact failure this section exists to prevent (codex gate).
    writeFileSync(envPath, POPULATED, { mode: 0o600 });
    fsState.failSentinelRemoval = true;
    let r: ReturnType<typeof setComfyuiSecret> | undefined;
    expect(() => {
      r = setComfyuiSecret("CIVITAI_API_TOKEN", "civ-new");
    }).not.toThrow();
    fsState.failSentinelRemoval = false;
    expect(r!.persisted).toBe("yes");
    expect(parseEnvFile()!.RUNPOD_API_KEY).toBe("rp-keep-me");
  });

  it("DISCLOSES rather than throws when the post-rename verification read fails", () => {
    // The rename has ALREADY happened when this read is attempted. Letting the
    // failure propagate turned a completed write into a generic error — which
    // the console rendered as `ok:false` and the caller retried, against a store
    // that had already changed (codex gate). After the rename there are only
    // disclosures: the outcome must come back, saying what is not established.
    writeFileSync(envPath, POPULATED, { mode: 0o600 });
    fsState.failFirstReadAfterRename = true;
    let r: ReturnType<typeof setComfyuiSecret> | undefined;
    expect(() => {
      r = setComfyuiSecret("CIVITAI_API_TOKEN", "civ-new");
    }).not.toThrow();
    fsState.failFirstReadAfterRename = false;
    // The write really did land...
    expect(parseEnvFile()!.CIVITAI_API_TOKEN).toBe("civ-new");
    // ...but the loss account was never taken, so it is not a confirmed save,
    // and the empty lostKeys must not be read as "nothing was lost".
    expect(r!.persisted).toBe("unknown");
    expect(r!.lostKeys).toBeUndefined();
    expect(r!.uncertainty).toMatch(/could not be read back afterwards/);
    expect(r!.uncertainty).toMatch(/not established/);
  });

  it("a healthy REVOKE reports no loss", () => {
    writeFileSync(envPath, `${POPULATED}CIVITAI_API_TOKEN=civ-old\n`, { mode: 0o600 });
    const out = removeComfyuiSecret("CIVITAI_API_TOKEN");
    expect(out.changed).toBe(true);
    expect(out.lostKeys).toEqual([]);
    expect(parseEnvFile()!.RUNPOD_API_KEY).toBe("rp-keep-me");
  });
});

describe("a ROLLBACK is a store write too, and reports what it cost", () => {
  it("carries credentials the ROLLBACK lost into the slot outcome", () => {
    // A slot fan-out that fails part-way restores the alias it already wrote.
    // That restore is a full store rewrite and can lose credentials exactly like
    // the save it is undoing — and its damage was simply dropped, because only
    // the SAVE receipts were aggregated. Same property, same place: the loss
    // travels the one path every consumer already reads.
    writeFileSync(envPath, "RUNPOD_API_KEY=rp-keep-me\n", { mode: 0o600 });
    // Rename 1 = HF_TOKEN lands. Rename 2 = HUGGINGFACE_TOKEN is installed
    // WITHOUT itself, so that alias reads back as not saved and the slot rolls
    // back — while nothing else is lost yet.
    fsState.tamperAtRename[2] = () => "RUNPOD_API_KEY=rp-keep-me\nHF_TOKEN=hf-new\n";
    // Rename 3 IS the rollback (removing HF_TOKEN again) — and it drops RunPod.
    fsState.tamperAtRename[3] = () => "# rollback ate it\n";
    const outcome = setPanelSecret("huggingface", "hf-new");
    expect(outcome.confirmed).toBe(false);
    expect(outcome.lostKeys).toContain("RUNPOD_API_KEY");
    expect(parseEnvFile()!.RUNPOD_API_KEY).toBeUndefined(); // it really is gone
  });

  it("does not roll back an alias this call never wrote", () => {
    // The rollback walked the WHOLE alias list from a snapshot taken before the
    // fan-out started. An alias the fan-out never reached — which another
    // ordinary writer may legitimately have updated meanwhile — was therefore
    // overwritten with the stale snapshot, and because that key is the restore's
    // own intentional key the clobber was excluded from `lostKeys` and reported
    // as a successful restore (codex gate).
    writeFileSync(envPath, "HF_TOKEN=hf-old\nHUGGINGFACE_TOKEN=hfl-old\n", { mode: 0o600 });
    // Rename 1 = HF_TOKEN write, tampered so it reads back as NOT saved: the
    // fan-out stops there and never touches HUGGINGFACE_TOKEN at all.
    fsState.tamperAtRename[1] = () =>
      "HF_TOKEN=hf-old\nHUGGINGFACE_TOKEN=hfl-updated-by-someone-else\n";
    const outcome = setPanelSecret("huggingface", "hf-new");
    expect(outcome.confirmed).toBe(false);
    // The alias we never wrote keeps the OTHER writer's value — it is not ours
    // to put back.
    expect(parseEnvFile()!.HUGGINGFACE_TOKEN).toBe("hfl-updated-by-someone-else");
  });

  it("does not let the RETHROW swallow what the rollback destroyed", () => {
    // When a per-key write THROWS, the slot rolls back and rethrows the original
    // reason — correct, the caller's value is not in place. But the rollback is
    // itself a store write, and its damage was collected and then discarded at
    // exactly that rethrow, so a destroyed credential vanished behind an
    // unrelated ENOSPC (codex gate).
    writeFileSync(envPath, "RUNPOD_API_KEY=rp-keep-me\n", { mode: 0o600 });
    fsState.failRenameAt = 2; // HF_TOKEN lands; HUGGINGFACE_TOKEN cannot
    fsState.tamperAtRename[3] = () => "# the rollback ate it\n"; // ...and the rollback loses RunPod
    let message = "";
    try {
      setPanelSecret("huggingface", "hf-new");
      throw new Error("expected setPanelSecret to rethrow");
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    fsState.failRenameAt = 0;
    expect(message).toMatch(/ENOSPC/); // the original reason survives...
    expect(message).toMatch(/also lost RUNPOD_API_KEY/); // ...and so does the damage
    expect(parseEnvFile()!.RUNPOD_API_KEY).toBeUndefined();
    expect(message).not.toContain("hf-new"); // never a value
  });
});

describe("the boot MIGRATION does not swallow what its write cost", () => {
  it("LOGS the credentials a migration write destroyed, by name", async () => {
    // The migration runs at boot, where there is no receipt to hand anything
    // back on — so it simply discarded the write outcome, then reported the key
    // as migrated and hydrated it into process.env. A migration that destroyed
    // another credential therefore looked like a clean start (codex gate).
    const { logger } = await import("../../utils/logger.js");
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      writeFileSync(envPath, "RUNPOD_API_KEY=rp-keep-me\n", { mode: 0o600 });
      writeFileSync(
        join(dir, "panel-secrets.json"),
        JSON.stringify({ comfyuiEnv: { CIVITAI_API_TOKEN: "civ-legacy" } }),
      );
      fsState.tamperOnRename = () => "CIVITAI_API_TOKEN=civ-legacy\n"; // RunPod gone
      const migrated = migrateSecretsToEnv();
      expect(migrated).toContain("CIVITAI_API_TOKEN");
      const lines = warn.mock.calls.map((c) => String(c[0])).join("\n");
      expect(lines).toMatch(/lost RUNPOD_API_KEY/);
      // Key NAMES only — never a value.
      expect(lines).not.toContain("civ-legacy");
      expect(lines).not.toContain("rp-keep-me");
    } finally {
      warn.mockRestore();
      delete process.env.CIVITAI_API_TOKEN;
    }
  });
});

describe("a completed REVOKE is never turned back into a refusal", () => {
  it("DISCLOSES a legacy-store purge that failed instead of throwing over the revoke", () => {
    // The legacy JSON purge runs AFTER the .env removal has landed. A throw
    // there made the console answer a generic failure with no `cleared` and no
    // "do not retry" — a completed destructive operation presented as a refusal
    // (codex gate). And the specific consequence matters: an unpurged legacy
    // entry means the boot migration puts the credential BACK.
    writeFileSync(envPath, "CIVITAI_API_TOKEN=civ-old\n", { mode: 0o600 });
    writeFileSync(
      join(dir, "panel-secrets.json"),
      JSON.stringify({ comfyuiEnv: { CIVITAI_API_TOKEN: "civ-legacy" } }),
    );
    fsState.failJsonStoreWrite = true;
    let out: ReturnType<typeof removeComfyuiSecret> | undefined;
    expect(() => {
      out = removeComfyuiSecret("CIVITAI_API_TOKEN");
    }).not.toThrow();
    fsState.failJsonStoreWrite = false;
    expect(out!.changed).toBe(true); // the revoke HAPPENED
    expect(parseEnvFile()!.CIVITAI_API_TOKEN).toBeUndefined();
    // ...and the thing the user actually needs to know is stated.
    expect(out!.resurrectionRisk).toMatch(/COMES BACK on the next start/);
    expect(out!.resurrectionRisk).not.toContain("civ-legacy"); // never a value
  });

  it("does not call the legacy store EMPTY when it merely could not be read", async () => {
    // `read()` folds "unreadable" into "{}", and for a revoke that is the
    // difference between "there is nothing to purge" and "we cannot see whether
    // there is". The revoke reported a clean result on the first while the file
    // may still hold the key — and once it is readable again the boot migration
    // puts the credential back (codex gate).
    const { revokeIsClean } = await import("../../services/panel-secrets.js");
    writeFileSync(envPath, "CIVITAI_API_TOKEN=civ-old\n", { mode: 0o600 });
    writeFileSync(join(dir, "panel-secrets.json"), "{ this is not json");
    const out = removeComfyuiSecret("CIVITAI_API_TOKEN");
    expect(out.changed).toBe(true); // the .env removal happened
    expect(out.resurrectionRisk).toMatch(/could not be READ/);
    expect(out.resurrectionRisk).toMatch(/not established/);
    expect(revokeIsClean(out)).toBe(false);
  });

  it("sweeps a pre-write snapshot a CRASHED writer left, and does not report one it cannot", async () => {
    // The snapshot is a link/copy of the store, so a process killed before its
    // cleanup leaves a readable file holding the credentials as they were —
    // including one the user has since revoked. A later revoke was reporting the
    // credential gone while a copy of it sat beside the store (codex gate).
    const { revokeIsClean } = await import("../../services/panel-secrets.js");
    writeFileSync(envPath, "CIVITAI_API_TOKEN=civ-old\n", { mode: 0o600 });
    const stale = `${envPath}.pre-99999-deadbeefcafe`;
    writeFileSync(stale, "CIVITAI_API_TOKEN=civ-old\n", { mode: 0o600 });
    // Backdate it past the age threshold: a LIVE writer's snapshot lives for
    // microseconds, and must never be swept out from under it.
    utimesSync(stale, new Date(Date.now() - 600_000), new Date(Date.now() - 600_000));
    const out = removeComfyuiSecret("CIVITAI_API_TOKEN");
    expect(out.changed).toBe(true);
    expect(existsSync(stale)).toBe(false); // the stale copy is gone
    expect(revokeIsClean(out)).toBe(true); // ...so this really is a clean revoke
  });

  it("sweeps a stale snapshot on an ordinary SAVE too, not only on a revoke", () => {
    // The sweep belongs to every write: a crashed writer's copy should not
    // survive until someone happens to revoke something.
    writeFileSync(envPath, "CIVITAI_API_TOKEN=civ-old\n", { mode: 0o600 });
    const stale = `${envPath}.pre-99998-feedfacefeed`;
    writeFileSync(stale, "CIVITAI_API_TOKEN=civ-old\n", { mode: 0o600 });
    utimesSync(stale, new Date(Date.now() - 600_000), new Date(Date.now() - 600_000));
    setComfyuiSecret("CIVITAI_API_TOKEN", "civ-new");
    expect(existsSync(stale)).toBe(false);
  });

  it("leaves a FRESH snapshot alone — it may belong to a live writer", () => {
    writeFileSync(envPath, "CIVITAI_API_TOKEN=civ-old\n", { mode: 0o600 });
    const fresh = `${envPath}.pre-12345-abcdefabcdef`;
    writeFileSync(fresh, "CIVITAI_API_TOKEN=civ-old\n", { mode: 0o600 });
    setComfyuiSecret("CIVITAI_API_TOKEN", "civ-new");
    expect(existsSync(fresh)).toBe(true);
  });

  it("reports a legacy purge that LANDED but was not made crash-durable", async () => {
    // The legacy store's durability gap was logged and then discarded, so it
    // never reached the receipt — and `revokeIsClean` could therefore answer
    // ok:true over a purge that a power loss undoes, after which the boot
    // migration resurrects the credential just revoked (codex gate).
    const { revokeIsClean } = await import("../../services/panel-secrets.js");
    writeFileSync(envPath, "CIVITAI_API_TOKEN=civ-old\n", { mode: 0o600 });
    writeFileSync(
      join(dir, "panel-secrets.json"),
      JSON.stringify({ comfyuiEnv: { CIVITAI_API_TOKEN: "civ-legacy" } }),
    );
    fsState.failFileFsync = true; // the fsync of the legacy store's temp file
    const out = removeComfyuiSecret("CIVITAI_API_TOKEN");
    fsState.failFileFsync = false;
    expect(out.changed).toBe(true); // it happened
    expect(out.resurrectionRisk).toMatch(/not made crash-durable/);
    expect(out.resurrectionRisk).toMatch(/boot migration re-adds this credential/);
    // ...and that is enough to stop any caller calling it a clean revoke.
    expect(revokeIsClean(out)).toBe(false);
    expect(JSON.stringify(out)).not.toContain("civ-legacy");
  });
});

describe("a PARTLY completed slot revoke reports itself instead of throwing", () => {
  it("returns what WAS removed when a later alias cannot be removed", async () => {
    // The alias fan-out is serial, so an earlier alias can already be gone when
    // a later one fails. Throwing discarded that completed removal entirely: the
    // console saw a generic failure with no `cleared` and no "do not retry"
    // (codex gate).
    const { clearPanelSecret } = await import("../../services/panel-secrets.js");
    writeFileSync(envPath, "HF_TOKEN=hf-old\nHUGGINGFACE_TOKEN=hfl-old\n", { mode: 0o600 });
    fsState.failRenameAt = 2; // HF_TOKEN goes; HUGGINGFACE_TOKEN cannot
    let out: SecretRemoveOutcome | undefined;
    expect(() => {
      out = clearPanelSecret("huggingface");
    }).not.toThrow();
    fsState.failRenameAt = 0;
    expect(out!.changed).toBe(true); // part of it HAPPENED
    expect(out!.incomplete).toMatch(/HUGGINGFACE_TOKEN/);
    expect(out!.incomplete).toMatch(/do not simply repeat the revoke/);
    expect(parseEnvFile()!.HF_TOKEN).toBeUndefined(); // the completed half
    expect(parseEnvFile()!.HUGGINGFACE_TOKEN).toBe("hfl-old"); // the failed half
  });

  it("REFUSES when nothing was removed at all", async () => {
    // Nothing happened, so refusing is correct and "it is still there" is true.
    const { clearPanelSecret } = await import("../../services/panel-secrets.js");
    writeFileSync(envPath, "HF_TOKEN=hf-old\nHUGGINGFACE_TOKEN=hfl-old\n", { mode: 0o600 });
    fsState.failRename = true;
    expect(() => clearPanelSecret("huggingface")).toThrow(/ENOSPC/);
    fsState.failRename = false;
    expect(parseEnvFile()!.HF_TOKEN).toBe("hf-old");
  });
});

describe("notifying is not part of the write's transaction", () => {
  it("a listener that THROWS after the rename does not destroy the receipt", async () => {
    // `emit` is synchronous and these listeners do real work — rebuilding an MCP
    // server's env, scheduling a respawn — AFTER the store has been rewritten.
    // A throw from one propagated out past the receipt and reached the caller as
    // a generic failure for a save that had in fact landed (codex gate).
    const { onComfyuiSecretsChanged } = await import("../../services/panel-secrets.js");
    const off = onComfyuiSecretsChanged(() => {
      throw new Error("respawn scheduling blew up");
    });
    try {
      writeFileSync(envPath, POPULATED, { mode: 0o600 });
      let r: ReturnType<typeof setComfyuiSecret> | undefined;
      expect(() => {
        r = setComfyuiSecret("CIVITAI_API_TOKEN", "civ-new");
      }).not.toThrow();
      // The credential really is saved, and the receipt says so.
      expect(r!.persisted).toBe("yes");
      expect(parseEnvFile()!.CIVITAI_API_TOKEN).toBe("civ-new");
      // ...and the respawn it drives is reported as NOT having happened, rather
      // than as a number nobody observed.
      expect(r!.respawn).toBeNull();
    } finally {
      off();
    }
  });
});

describe("the boot MIGRATION verifies its own key, not just that it wrote", () => {
  it("does NOT report a key migrated when the store does not read it back", async () => {
    // It wrote, then reported the key migrated and hydrated it into process.env
    // from the value it happened to hold. A competitor replacing the file after
    // the rename therefore produced a "migrated" credential the resolver — which
    // reads the FILE — treats as absent (codex gate).
    const { logger } = await import("../../utils/logger.js");
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      writeFileSync(envPath, "", { mode: 0o600 });
      writeFileSync(
        join(dir, "panel-secrets.json"),
        JSON.stringify({ comfyuiEnv: { CIVITAI_API_TOKEN: "civ-legacy" } }),
      );
      // The rename installs a file WITHOUT the key it was supposed to add.
      fsState.tamperOnRename = () => "# somebody else won\n";
      const migrated = migrateSecretsToEnv();
      expect(migrated).not.toContain("CIVITAI_API_TOKEN");
      expect(process.env.CIVITAI_API_TOKEN).toBeUndefined(); // not hydrated either
      const lines = warn.mock.calls.map((c) => String(c[0])).join("\n");
      expect(lines).toMatch(/NOT reporting it as migrated/);
      expect(lines).not.toContain("civ-legacy"); // names only
    } finally {
      warn.mockRestore();
      delete process.env.CIVITAI_API_TOKEN;
    }
  });
});

describe("the write is made DURABLE, and says so when it could not be", () => {
  it("fsyncs the DIRECTORY after the rename, so the rename itself survives a power loss", () => {
    // A rename is not durable until the directory entry is flushed: the new name
    // can be lost while the temp name is gone too, leaving NO file where the
    // store used to be. This was simply missing (codex gate).
    withPlatform("linux", () => {
      writeFileSync(envPath, POPULATED, { mode: 0o600 });
      fsState.dirFsyncs = [];
      setComfyuiSecret("CIVITAI_API_TOKEN", "civ-new");
      expect(fsState.dirFsyncs).toContain(dir);
    });
  });

  it("does not silently swallow a failed fsync — the receipt carries the gap", () => {
    writeFileSync(envPath, POPULATED, { mode: 0o600 });
    fsState.failFileFsync = true;
    const r = setComfyuiSecret("CIVITAI_API_TOKEN", "civ-new");
    fsState.failFileFsync = false;
    // The save still LANDED — a rename is atomic either way — so this is a
    // disclosure, not a failure.
    expect(r.persisted).toBe("yes");
    expect(parseEnvFile()!.CIVITAI_API_TOKEN).toBe("civ-new");
    expect(r.durabilityGap).toMatch(/could not be flushed to the device/);
    expect(r.durabilityGap).toMatch(/EIO/);
  });

  it("does not call an EACCES on the directory 'no gap' — it is not a platform answer", () => {
    // A directory can be writable and searchable but not READABLE, so the
    // rewrite succeeds while `openSync(dir, "r")` is refused. EACCES was being
    // swallowed alongside the genuine "this filesystem does not implement
    // directory syncing" codes, so no sync happened and the receipt still
    // claimed no gap — an unobserved durability claim (codex gate).
    withPlatform("linux", () => {
      writeFileSync(envPath, POPULATED, { mode: 0o600 });
      fsState.dirOpenError = "EACCES";
      const r = setComfyuiSecret("CIVITAI_API_TOKEN", "civ-new");
      fsState.dirOpenError = null;
      expect(r.persisted).toBe("yes"); // the save landed
      expect(r.durabilityGap).toMatch(/rename was not made durable/);
      expect(r.durabilityGap).toMatch(/EACCES/);
    });
  });

  it("still treats a filesystem that does not IMPLEMENT directory sync as no gap", () => {
    // The counterpart: ENOTSUP really is the platform's answer, not a failure of
    // this write. Without this the fix above would just alarm on everything.
    withPlatform("linux", () => {
      writeFileSync(envPath, POPULATED, { mode: 0o600 });
      fsState.dirOpenError = "ENOTSUP";
      const r = setComfyuiSecret("CIVITAI_API_TOKEN", "civ-new");
      fsState.dirOpenError = null;
      expect(r.durabilityGap).toBeUndefined();
    });
  });

  it("reports a failed DIRECTORY fsync too", () => {
    withPlatform("linux", () => {
      writeFileSync(envPath, POPULATED, { mode: 0o600 });
      fsState.failDirFsync = true;
      const r = setComfyuiSecret("CIVITAI_API_TOKEN", "civ-new");
      fsState.failDirFsync = false;
      expect(r.persisted).toBe("yes");
      expect(r.durabilityGap).toMatch(/rename was not made durable/);
    });
  });

  it("claims NO durability gap on a healthy write", () => {
    writeFileSync(envPath, POPULATED, { mode: 0o600 });
    expect(setComfyuiSecret("CIVITAI_API_TOKEN", "civ-new").durabilityGap).toBeUndefined();
  });
});

describe("comment loss reaches the receipt", () => {
  it("REPORTS comment lines the rewrite did not preserve", () => {
    // The store's contract is that it keeps them. Losing them is the user's data
    // going missing — and the count was computed and then dropped on the floor
    // before it ever reached a receipt (codex gate).
    writeFileSync(envPath, POPULATED, { mode: 0o600 });
    fsState.tamperOnRename = () => "RUNPOD_API_KEY=rp-keep-me\nHF_TOKEN=hf-keep-me\nCIVITAI_API_TOKEN=civ-new\n";
    const r = setComfyuiSecret("CIVITAI_API_TOKEN", "civ-new");
    expect(r.lostKeys).toBeUndefined(); // no CREDENTIAL was lost...
    expect(r.lostCommentLines).toBe(1); // ...but "# my credentials" is gone
  });

  it("reports no comment loss on a normal save", () => {
    writeFileSync(envPath, POPULATED, { mode: 0o600 });
    expect(setComfyuiSecret("CIVITAI_API_TOKEN", "civ-new").lostCommentLines).toBeUndefined();
  });
});

/** Run `fn` with process.platform stubbed, so the POSIX-only directory sync is
 *  testable on the Windows box this is developed on. */
function withPlatform(platform: string, fn: () => void): void {
  const original = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...original, value: platform });
  try {
    fn();
  } finally {
    Object.defineProperty(process, "platform", original);
  }
}

function readdirSyncSafe(d: string): string[] {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return (require("node:fs") as typeof import("node:fs")).readdirSync(d);
  } catch {
    return [];
  }
}
