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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fsState = vi.hoisted(() => ({
  /** Make the rename fail, as a crash/full-disk would, AFTER the temp file was
   *  written — the moment the old in-place write had already truncated. */
  failRename: false,
  /** Simulate another process writing the store between our first read and the
   *  compare-and-swap re-read, which is the window the CAS exists to close.
   *  Fires immediately BEFORE the given store-read index. */
  concurrentWriteBeforeRead: null as null | { at: number; run: () => void },
  storeReads: 0,
  /** Replace what the rename installs, to force the whole-file verification to
   *  see keys go missing. */
  tamperOnRename: null as null | (() => string),
  renames: 0,
  /** Every path ever passed to writeFileSync — proves the target is not written
   *  in place. */
  directWrites: [] as string[],
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const isStore = (p: unknown) => String(p).endsWith(".env");
  const renameSync: typeof actual.renameSync = (from, to) => {
    if (isStore(to)) {
      fsState.renames++;
      if (fsState.failRename) {
        throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
      }
      const tamper = fsState.tamperOnRename;
      if (tamper) {
        fsState.tamperOnRename = null;
        actual.writeFileSync(from, tamper());
      }
    }
    return actual.renameSync(from, to);
  };
  const writeFileSyncSpy: typeof actual.writeFileSync = (path, ...rest) => {
    fsState.directWrites.push(String(path));
    return (actual.writeFileSync as (...a: unknown[]) => void)(path, ...rest);
  };
  const readFileSync: typeof actual.readFileSync = ((
    ...args: Parameters<typeof actual.readFileSync>
  ) => {
    if (isStore(args[0])) {
      fsState.storeReads++;
      const c = fsState.concurrentWriteBeforeRead;
      if (c && fsState.storeReads === c.at) {
        fsState.concurrentWriteBeforeRead = null; // once, so the retry can settle
        c.run();
      }
    }
    return actual.readFileSync(...args);
  }) as typeof actual.readFileSync;
  return {
    ...actual,
    default: { ...actual, renameSync, writeFileSync: writeFileSyncSpy, readFileSync },
    renameSync,
    writeFileSync: writeFileSyncSpy,
    readFileSync,
  };
});

import { setComfyuiSecret, removeComfyuiSecret } from "../../services/panel-secrets.js";
import { parseEnvFile, resetEnvFileProvenanceForTests } from "../../env-file.js";

const KEYS = ["CIVITAI_API_TOKEN", "HF_TOKEN", "HUGGINGFACE_TOKEN", "RUNPOD_API_KEY"];

let dir: string;
let envPath: string;
let saved: Record<string, string | undefined>;

/** A store with several tokens and a comment — i.e. something to lose. */
const POPULATED = "# my credentials\nRUNPOD_API_KEY=rp-keep-me\nHF_TOKEN=hf-keep-me\n";

beforeEach(() => {
  fsState.failRename = false;
  fsState.concurrentWriteBeforeRead = null;
  fsState.tamperOnRename = null;
  fsState.renames = 0;
  fsState.storeReads = 0;
  fsState.directWrites = [];
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
    expect(r.persisted).toBe("yes");
    const after = parseEnvFile()!;
    expect(after.CIVITAI_API_TOKEN).toBe("civ-new"); // ours landed
    expect(after.RUNPOD_API_KEY).toBe("rp-from-other-process"); // and theirs survived
    expect(r.lostKeys ?? []).toEqual([]);
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
    // The key we set is present, so a per-key check would have said "yes" — the
    // point is that "yes" must not be the whole story.
    expect(r.persisted).toBe("yes");
  });

  it("reports NO loss on a healthy save", () => {
    writeFileSync(envPath, POPULATED, { mode: 0o600 });
    expect(setComfyuiSecret("CIVITAI_API_TOKEN", "civ-new").lostKeys).toBeUndefined();
  });

  it("a REVOKE that loses other keys refuses rather than reporting success", () => {
    writeFileSync(envPath, `${POPULATED}CIVITAI_API_TOKEN=civ-old\n`, { mode: 0o600 });
    fsState.tamperOnRename = () => "# everything else gone\n";
    expect(() => removeComfyuiSecret("CIVITAI_API_TOKEN")).toThrow(/also lost/);
  });
});

function readdirSyncSafe(d: string): string[] {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return (require("node:fs") as typeof import("node:fs")).readdirSync(d);
  } catch {
    return [];
  }
}
