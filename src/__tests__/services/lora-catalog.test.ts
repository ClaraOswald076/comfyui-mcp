// #796 — the LoRA catalog folded "could not parse" into "is empty", and the
// next write (an unattended training handoff, an explicit upsert) then
// DESTROYED the original file: the rescue path deleting the thing it rescues.
// A corrupt catalog is evidence, and writes must preserve it — or refuse.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Passthrough by default; some tests script readFileSync/existsSync to
// simulate another writer landing mid-persist. The real implementations are
// stashed in a hoisted object so tests never pay an importActual mid-test.
const realFs = vi.hoisted(() => ({
  readFileSync: undefined as unknown as typeof import("node:fs").readFileSync,
  existsSync: undefined as unknown as typeof import("node:fs").existsSync,
  writeFileSync: undefined as unknown as typeof import("node:fs").writeFileSync,
  renameSync: undefined as unknown as typeof import("node:fs").renameSync,
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  realFs.readFileSync = actual.readFileSync;
  realFs.existsSync = actual.existsSync;
  realFs.writeFileSync = actual.writeFileSync;
  realFs.renameSync = actual.renameSync;
  return {
    ...actual,
    readFileSync: vi.fn(actual.readFileSync),
    existsSync: vi.fn(actual.existsSync),
    // The durable write's final step, and the only hook that lands INSIDE the
    // read-to-write window: every check has passed and the bytes have not
    // reached the catalog path yet.
    renameSync: vi.fn(actual.renameSync),
  };
});
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";import { tmpdir } from "node:os";
import { join } from "node:path";

import { LoraCatalog } from "../../services/lora-catalog.js";

let dir: string;
let catalogPath: string;
let previewsDir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cmcp-loracat-"));
  catalogPath = join(dir, "lora-catalog.json");
  previewsDir = join(dir, "previews");
  process.env.COMFYUI_MCP_LORA_CATALOG = catalogPath;
  process.env.COMFYUI_MCP_LORA_PREVIEWS = previewsDir;
});

afterEach(() => {
  delete process.env.COMFYUI_MCP_LORA_CATALOG;
  delete process.env.COMFYUI_MCP_LORA_PREVIEWS;
  rmSync(dir, { recursive: true, force: true });
});

const backups = () =>
  readdirSync(dir).filter((f) => f.startsWith("lora-catalog.json.corrupt-"));

const TS = "2026-01-01T00:00:00Z";
/** A full, write-path-shaped catalog entry (the bar the reader validates). */
function validEntry(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    relPath: `loras/${id}.safetensors`,
    displayName: id,
    description: "",
    setupInstructions: "",
    keywords: [],
    baseModels: [],
    createdAt: TS,
    updatedAt: TS,
    ...extra,
  };
}

describe("a corrupt catalog is never silently overwritten", () => {
  it("a write over an unparseable file PRESERVES the original first", () => {
    const corrupt = `{"version": 1, "entries": {"half-written": `;
    writeFileSync(catalogPath, corrupt);

    const catalog = new LoraCatalog();
    // The corrupt content is not readable, so the in-memory view is empty…
    expect(catalog.list()).toEqual([]);
    // …but the write must not destroy the evidence of what was there.
    catalog.upsert({ relPath: "loras/new.safetensors", description: "fresh" });

    expect(backups()).toHaveLength(1);
    expect(readFileSync(join(dir, backups()[0]!), "utf-8")).toBe(corrupt);
    const now = JSON.parse(readFileSync(catalogPath, "utf-8"));
    expect(Object.keys(now.entries)).toHaveLength(1);
  });

  it("a wrong-shape file (valid JSON, not a catalog) is corrupt, not empty", () => {
    writeFileSync(catalogPath, JSON.stringify({ hello: "world" }));
    const catalog = new LoraCatalog();
    catalog.upsert({ relPath: "loras/new.safetensors" });
    expect(backups()).toHaveLength(1);
  });

  it("an entries ARRAY passes no shape check — it is corrupt, not a catalog", () => {
    // `typeof [] === "object"`, and a string-keyed upsert on an array does not
    // survive JSON.stringify: accepted-as-valid would mean a reported-success
    // write that persists nothing.
    const original = JSON.stringify({ version: 1, entries: [] });
    writeFileSync(catalogPath, original);
    const catalog = new LoraCatalog();
    catalog.upsert({ relPath: "loras/new.safetensors" });
    expect(backups()).toHaveLength(1);
    const now = JSON.parse(readFileSync(catalogPath, "utf-8"));
    expect(Object.keys(now.entries)).toHaveLength(1);
  });

  it("entries: null is corrupt too (typeof null === 'object')", () => {
    writeFileSync(catalogPath, JSON.stringify({ version: 1, entries: null }));
    const catalog = new LoraCatalog();
    // Accepted-as-valid would throw at Object.values(null) here instead.
    expect(catalog.list()).toEqual([]);
    catalog.upsert({ relPath: "loras/new.safetensors" });
    expect(backups()).toHaveLength(1);
  });

  it("malformed VALUES are set aside, and the write still preserves the original", () => {
    // A partial write / hand-edit can leave "some-lora": null inside an
    // otherwise valid catalog. The valid entries stay usable, the null one
    // does not crash list(), and the original is backed up before any write.
    const original = JSON.stringify({
      version: 1,
      entries: {
        good: validEntry("good"),
        bad: null,
      },
    });
    writeFileSync(catalogPath, original);
    const catalog = new LoraCatalog();
    expect(catalog.list().map((e) => e.id)).toEqual(["good"]);
    catalog.upsert({ relPath: "loras/new.safetensors" });
    expect(backups()).toHaveLength(1);
    expect(readFileSync(join(dir, backups()[0]!), "utf-8")).toBe(original);
  });

  it("an entry object missing displayName is malformed too (the sort would crash)", () => {
    const original = JSON.stringify({
      version: 1,
      entries: {
        good: validEntry("good"),
        bad: {},
      },
    });
    writeFileSync(catalogPath, original);
    const catalog = new LoraCatalog();
    expect(catalog.list().map((e) => e.id)).toEqual(["good"]);
    catalog.upsert({ relPath: "loras/new.safetensors" });
    expect(backups()).toHaveLength(1);
    expect(readFileSync(join(dir, backups()[0]!), "utf-8")).toBe(original);
  });

  it("a string where an array field belongs is malformed (list would crash on .some)", () => {
    const original = JSON.stringify({
      version: 1,
      entries: {
        good: validEntry("good", { baseModels: ["FLUX.1-dev"] }),
        bad: validEntry("bad", { baseModels: "FLUX" }),
      },
    });
    writeFileSync(catalogPath, original);
    const catalog = new LoraCatalog();
    // The malformed entry is set aside; filtering must not throw on it.
    expect(catalog.list({ baseModel: "flux" }).map((e) => e.id)).toEqual(["good"]);
    catalog.upsert({ relPath: "loras/new.safetensors" });
    expect(backups()).toHaveLength(1);
    expect(readFileSync(join(dir, backups()[0]!), "utf-8")).toBe(original);
  });

  it("a null INSIDE an array field (or a null timestamp) is malformed too", () => {
    const original = JSON.stringify({
      version: 1,
      entries: {
        good: validEntry("good", { tags: ["a"] }),
        bad: validEntry("bad", { tags: [null] }),
        worse: validEntry("worse", { createdAt: null }),
      },
    });
    writeFileSync(catalogPath, original);
    const catalog = new LoraCatalog();
    // tags:[null] would crash the tag filter on null.toLowerCase(); both
    // malformed entries are set aside (each by its own check).
    expect(catalog.list({ tag: "a" }).map((e) => e.id)).toEqual(["good"]);
    expect(catalog.get("bad")).toBeNull();
    expect(catalog.get("worse")).toBeNull();
    catalog.upsert({ relPath: "loras/new.safetensors" });
    expect(backups()).toHaveLength(1);
    expect(readFileSync(join(dir, backups()[0]!), "utf-8")).toBe(original);
  });

  it("two backups in the same millisecond never collide (pid+seq names)", () => {
    // The clock is frozen so the names can ONLY differ by design, never by a
    // lucky tick: a shared name would let the second backup overwrite the
    // first, erasing a preserved original after all.
    vi.setSystemTime(new Date("2026-08-04T12:00:00Z"));
    try {
      const corrupt1 = `{"version": 1, "entries": {"half-written": `;
      writeFileSync(catalogPath, corrupt1);
      const catalog = new LoraCatalog();
      catalog.upsert({ relPath: "loras/one.safetensors" }); // backup 1
      const corrupt2 = `{"version": 1, "entries": {"also-truncated": `;
      writeFileSync(catalogPath, corrupt2); // corrupt AGAIN (another writer crashed)
      catalog.upsert({ relPath: "loras/two.safetensors" }); // backup 2, re-observed
      const names = backups();
      expect(names).toHaveLength(2);
      const bodies = names.map((n) => readFileSync(join(dir, n), "utf-8"));
      expect(bodies).toContain(corrupt1);
      expect(bodies).toContain(corrupt2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a file REPAIRED since our read is refused, not overwritten — retry reconciles", () => {
    // Our in-memory state derives from the CORRUPT read; writing it over the
    // repair would silently destroy another writer's completed update.
    writeFileSync(catalogPath, `{"version": 1, "entries": {"half-written": `);
    const catalog = new LoraCatalog();
    const fresh = validEntry("fresh");
    writeFileSync(catalogPath, JSON.stringify({ version: 1, entries: { fresh } }));
    expect(() => catalog.upsert({ relPath: "loras/new.safetensors" })).toThrow(/changed on disk/);
    expect(backups()).toHaveLength(0);
    // The refusal re-synced us onto the repaired state, dropping our mutation…
    expect(catalog.get("fresh")?.id).toBe("fresh");
    expect(catalog.get("loras/new.safetensors")).toBeNull();
    // …so the retry applies cleanly, on top of the repair.
    catalog.upsert({ relPath: "loras/new.safetensors" });
    expect(catalog.get("fresh")?.id).toBe("fresh");
    expect(catalog.get("loras/new.safetensors")?.id).toBe("loras-new");
    expect(backups()).toHaveLength(0);
  });

  it("an entry without an id cannot be 'removed' — remove reports the truth", () => {
    // {"bad": {"displayName": "Bad"}} is not an entry. Accepted as one,
    // remove("bad") would delete entries[undefined], persist, and return true
    // — a removal that never happened, reported as done. Set aside at read,
    // the honest answer is false.
    writeFileSync(
      catalogPath,
      JSON.stringify({ version: 1, entries: { bad: { displayName: "Bad" } } }),
    );
    const catalog = new LoraCatalog();
    expect(catalog.remove("bad")).toBe(false);
    // And the malformed value is preserved when a write happens.
    catalog.upsert({ relPath: "loras/new.safetensors" });
    expect(backups()).toHaveLength(1);
  });

  it("an entry filed under a KEY that is not its id cannot fabricate a removal", () => {
    // remove("real") matches the value by relPath, then deletes
    // entries[entry.id] — "real" — which is not where the entry lives.
    // Deleting nothing and returning true is a fabricated removal, so a
    // key/id mismatch marks the file corrupt at read.
    writeFileSync(
      catalogPath,
      JSON.stringify({
        version: 1,
        entries: {
          "stale-key": validEntry("real"),
        },
      }),
    );
    const catalog = new LoraCatalog();
    expect(catalog.list()).toEqual([]);
    expect(catalog.remove("real")).toBe(false);
    catalog.upsert({ relPath: "loras/new.safetensors" });
    expect(backups()).toHaveLength(1);
  });

  it("a non-string previewFile is malformed (remove would throw AFTER deleting)", () => {
    // remove() deletes and persists the entry, then join(dir, previewFile)
    // throws on a number — a failure reported for a removal that already
    // happened. The entry is set aside at read instead.
    writeFileSync(
      catalogPath,
      JSON.stringify({ version: 1, entries: { x: validEntry("x", { previewFile: 1 }) } }),
    );
    const catalog = new LoraCatalog();
    expect(catalog.get("x")).toBeNull();
    expect(catalog.remove("x")).toBe(false);
    catalog.upsert({ relPath: "loras/new.safetensors" });
    expect(backups()).toHaveLength(1);
  });

  it('a string "missing" flag is malformed (a present LoRA would list as missing)', () => {
    // "false" is TRUTHY — list() filters on !!entry.missing, so this entry
    // would silently vanish from every default listing.
    writeFileSync(
      catalogPath,
      JSON.stringify({ version: 1, entries: { x: validEntry("x", { missing: "false" }) } }),
    );
    const catalog = new LoraCatalog();
    expect(catalog.get("x")).toBeNull();
    catalog.upsert({ relPath: "loras/new.safetensors" });
    expect(backups()).toHaveLength(1);
  });

  it(
    "a write that finds the file CHANGED mid-persist refuses instead of overwriting it",
    { timeout: 20000 },
    async () => {
    // Another process recovers/updates the catalog between our probe and our
    // write: overwriting would destroy their update with no recoverable copy.
    // The second read inside persist is scripted to simulate exactly that.
    const v1 = JSON.stringify({ version: 1, entries: {} });
    const v2 = JSON.stringify({
      version: 1,
      entries: { other: validEntry("other") },
    });
    writeFileSync(catalogPath, v1);
    const catalog = new LoraCatalog();
    let catalogReads = 0;
    vi.mocked(readFileSync).mockImplementation(((p: unknown, ...rest: unknown[]) => {
      if (p === catalogPath) {
        catalogReads++;
        if (catalogReads === 2) {
          // The other writer lands their recovery right here.
          realFs.writeFileSync(catalogPath, v2);
        }
      }
      return (realFs.readFileSync as (...a: unknown[]) => unknown)(p, ...rest);
    }) as never);
    try {
      expect(() => catalog.upsert({ relPath: "loras/new.safetensors" })).toThrow(
        /changed on disk/,
      );
      // Their update survived, and nothing was backed up (nothing was corrupt).
      expect(realFs.readFileSync(catalogPath, "utf-8")).toBe(v2);
      expect(backups()).toHaveLength(0);
      // The failed mutation did not linger either — we re-synced onto their state.
      expect(catalog.list().map((e) => e.id)).toEqual(["other"]);
    } finally {
      vi.mocked(readFileSync).mockImplementation(realFs.readFileSync as never);
    }
  });

  it("a file corrupted AFTER our read is still preserved at write time", () => {
    // The corruption check re-observes the file at write time: a healthy read
    // followed by another writer's crash-truncated file must not make our
    // upsert the thing that destroys the evidence.
    writeFileSync(catalogPath, JSON.stringify({ version: 1, entries: {} }));
    const catalog = new LoraCatalog(); // reads the healthy file
    const corrupt = `{"version": 1, "entries": {"half-written": `;
    writeFileSync(catalogPath, corrupt); // another writer crashes mid-write
    catalog.upsert({ relPath: "loras/new.safetensors" });
    expect(backups()).toHaveLength(1);
    expect(readFileSync(join(dir, backups()[0]!), "utf-8")).toBe(corrupt);
  });

  it("a failed persist leaves NO uncommitted mutation in memory", () => {
    // The write is refused (a directory at the catalog path can be neither
    // read nor backed up). The upsert that was just reported as FAILED must
    // not linger in memory to be committed by a later, successful write.
    mkdirSync(catalogPath);
    const catalog = new LoraCatalog();
    expect(() => catalog.upsert({ relPath: "loras/ghost.safetensors" })).toThrow(
      /Refusing to overwrite/,
    );
    expect(catalog.list()).toEqual([]); // the failed mutation is gone
  });

  it("a corrupt original that cannot even be COPIED refuses the write outright", () => {
    // A directory at the catalog path: the read fails, and so does the
    // preserving copy — the only honest outcome left is a loud refusal, and
    // the original must be exactly where it was.
    mkdirSync(catalogPath);
    const catalog = new LoraCatalog();
    expect(() => catalog.upsert({ relPath: "loras/new.safetensors" })).toThrow(
      /Refusing to overwrite/,
    );
    // The cause is a READ failure — nothing was ever parsed, and the message
    // must not claim otherwise.
    expect(() => catalog.upsert({ relPath: "loras/new.safetensors" })).toThrow(
      /could not be read/,
    );
    expect(statSync(catalogPath).isDirectory()).toBe(true);
  });

  it("a healthy catalog writes WITHOUT a backup (control)", () => {
    writeFileSync(
      catalogPath,
      JSON.stringify({ version: 1, entries: {} }),
    );
    const catalog = new LoraCatalog();
    catalog.upsert({ relPath: "loras/new.safetensors" });
    expect(backups()).toHaveLength(0);
    expect(Object.keys(catalog.list())).toHaveLength(1);
  });

  it("no catalog at all writes fresh WITHOUT a backup (control)", () => {
    const catalog = new LoraCatalog();
    catalog.upsert({ relPath: "loras/new.safetensors" });
    expect(backups()).toHaveLength(0);
    expect(JSON.parse(readFileSync(catalogPath, "utf-8")).entries).toBeTypeOf("object");
  });
});

describe("a failed persist never orphans a preview reference", () => {
  const ENTRY = validEntry("x", { previewFile: "old.png" });

  /** Script persist's identity re-read to carry another writer's update. */
  function anotherWriterLandsMidPersist(v2: string): () => void {
    let catalogReads = 0;
    vi.mocked(readFileSync).mockImplementation(((p: unknown, ...rest: unknown[]) => {
      if (p === catalogPath && ++catalogReads === 2) {
        realFs.writeFileSync(catalogPath, v2);
      }
      return (realFs.readFileSync as (...a: unknown[]) => unknown)(p, ...rest);
    }) as never);
    return () => vi.mocked(readFileSync).mockImplementation(realFs.readFileSync as never);
  }

  it(
    "remove() deletes the preview only AFTER the catalog write succeeds",
    { timeout: 20000 },
    async () => {
    writeFileSync(catalogPath, JSON.stringify({ version: 1, entries: { x: ENTRY } }));
    mkdirSync(previewsDir, { recursive: true });
    writeFileSync(join(previewsDir, "old.png"), "png");
    const catalog = new LoraCatalog();
    const restore = anotherWriterLandsMidPersist(
      JSON.stringify({
        version: 1,
        entries: {
          x: ENTRY,
          other: validEntry("other"),
        },
      }),
    );
    try {
      expect(() => catalog.remove("x")).toThrow(/changed on disk/);
      // The refusal restored the entry — and its preview must still exist.
      expect(catalog.get("x")?.id).toBe("x");
      expect(existsSync(join(previewsDir, "old.png"))).toBe(true);
    } finally {
      restore();
    }
  });

  it(
    "setPreview() deletes the replaced preview only AFTER the catalog write succeeds",
    { timeout: 20000 },
    async () => {
    writeFileSync(catalogPath, JSON.stringify({ version: 1, entries: { x: ENTRY } }));
    mkdirSync(previewsDir, { recursive: true });
    writeFileSync(join(previewsDir, "old.png"), "old");
    const src = join(dir, "new.png");
    writeFileSync(src, "new");
    const catalog = new LoraCatalog();
    const restore = anotherWriterLandsMidPersist(
      JSON.stringify({
        version: 1,
        entries: {
          x: ENTRY,
          other: validEntry("other"),
        },
      }),
    );
    try {
      // The catalog write is refused AND the already-written preview file is
      // disclosed — never a bare refusal that hides the applied half.
      const err = (() => {
        try {
          catalog.setPreview("x", src);
          return undefined;
        } catch (e) {
          return e as Error;
        }
      })();
      expect(err?.message).toMatch(/changed on disk/);
      expect(err?.message).toMatch(/already written to/);
      expect(existsSync(join(previewsDir, "old.png"))).toBe(true);
      expect(catalog.get("x")?.previewFile).toBe("old.png");
    } finally {
      restore();
    }
  });
});

describe("a preview file is deleted only when nothing references it", () => {
  it("remove() keeps a preview another entry still references", () => {
    writeFileSync(
      catalogPath,
      JSON.stringify({
        version: 1,
        entries: {
          x: validEntry("x", { previewFile: "shared.png" }),
          y: validEntry("y", { previewFile: "shared.png" }),
        },
      }),
    );
    mkdirSync(previewsDir, { recursive: true });
    writeFileSync(join(previewsDir, "shared.png"), "png");
    const catalog = new LoraCatalog();
    expect(catalog.remove("x")).toBe(true);
    expect(existsSync(join(previewsDir, "shared.png"))).toBe(true);
    expect(catalog.remove("y")).toBe(true);
    expect(existsSync(join(previewsDir, "shared.png"))).toBe(false);
  });
});

describe("cleanup never deletes on a corrupt read", () => {
  it(
    "a corrupt catalog at preview-cleanup time answers 'referenced'",
    { timeout: 20000 },
    () => {
    writeFileSync(
      catalogPath,
      JSON.stringify({ version: 1, entries: { x: validEntry("x", { previewFile: "shared.png" }) } }),
    );
    mkdirSync(previewsDir, { recursive: true });
    writeFileSync(join(previewsDir, "shared.png"), "png");
    const catalog = new LoraCatalog();
    let catalogReads = 0;
    vi.mocked(readFileSync).mockImplementation(((p: unknown, ...rest: unknown[]) => {
      if (p === catalogPath && ++catalogReads === 4) {
        // persist's two identity reads and its post-write read-back passed; the
        // preview-cleanup read finds the file crash-truncated — nothing is
        // known about what references the preview. (Index only; the assertion
        // below is about the cleanup, not about how many reads persist makes.)
        return `{"version": 1, "entries": {"truncated": `;
      }
      return (realFs.readFileSync as (...a: unknown[]) => unknown)(p, ...rest);
    }) as never);
    try {
      // The removal itself succeeds (the catalog write went through)…
      expect(catalog.remove("x")).toBe(true);
      // …but the preview is NOT deleted on a corrupt read.
      expect(existsSync(join(previewsDir, "shared.png"))).toBe(true);
    } finally {
      vi.mocked(readFileSync).mockImplementation(realFs.readFileSync as never);
    }
  });
});

describe("inaccessible is not absent", () => {
  it(
    "an unsearchable path is not 'absent': the write preserves what it could not see",
    { timeout: 20000 },
    () => {
    // existsSync answers false for an unsearchable ancestor exactly as for a
    // missing file. Reading "absent" from that and then writing would destroy
    // the catalog that was merely out of reach.
    const original = JSON.stringify({ version: 1, entries: { y: validEntry("y") } });
    writeFileSync(catalogPath, original);
    vi.mocked(existsSync).mockImplementation(((p: unknown) =>
      p === catalogPath
        ? false
        : (realFs.existsSync as (a: unknown) => boolean)(p)) as never);
    vi.mocked(readFileSync).mockImplementation(((p: unknown, ...rest: unknown[]) => {
      if (p === catalogPath) {
        throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      }
      return (realFs.readFileSync as (...a: unknown[]) => unknown)(p, ...rest);
    }) as never);
    try {
      const catalog = new LoraCatalog();
      expect(catalog.list()).toEqual([]); // unreachable — but that is NOT "empty"
      catalog.upsert({ relPath: "loras/new.safetensors" });
      expect(backups()).toHaveLength(1);
      expect(readFileSync(join(dir, backups()[0]!), "utf-8")).toBe(original);
    } finally {
      vi.mocked(existsSync).mockImplementation(realFs.existsSync as never);
      vi.mocked(readFileSync).mockImplementation(realFs.readFileSync as never);
    }
  });
});

// The gate on #839: persist() had no atomic exclusion between its last read and
// its write. Two processes both read healthy V1, both pass `unchanged`, A
// writes entry A, B writes entry B — and B's write silently erases A's. Because
// both probes were healthy neither takes the corrupt-file backup, so there is
// nothing to recover from either. Two agents on one rig is ordinary here.
describe("two writers racing the catalog: no write is silently erased", () => {
  const lockPath = () => `${catalogPath}.lock`;
  const V1 = JSON.stringify({ version: 1, entries: {} });
  /** A pid that cannot be running (the max Node will accept, never allocated). */
  const DEAD_PID = 2147483646;

  afterEach(() => {
    vi.mocked(renameSync).mockImplementation(realFs.renameSync as never);
  });

  it(
    "a second writer landing between the first's checks and its WRITE is refused, not lost",
    { timeout: 30000 },
    () => {
      // A genuine interleaving, not a simulation of one: catalogB's whole
      // read-modify-write runs from inside catalogA's window, at the last
      // moment before A's bytes reach the path. Both instances were built from
      // the same healthy V1, so both pass every staleness check — which is
      // exactly the state the loss needs.
      writeFileSync(catalogPath, V1);
      const catalogA = new LoraCatalog();
      const catalogB = new LoraCatalog();

      let bError: Error | undefined;
      let raced = false;
      vi.mocked(renameSync).mockImplementation(((from: string, to: string) => {
        if (to === catalogPath && !raced) {
          raced = true;
          try {
            catalogB.upsert({ relPath: "loras/from-b.safetensors" });
          } catch (e) {
            bError = e as Error;
          }
        }
        return (realFs.renameSync as (a: string, b: string) => void)(from, to);
      }) as never);

      catalogA.upsert({ relPath: "loras/from-a.safetensors" });
      expect(raced).toBe(true);

      // B was TOLD. Silence is the defect: a write that reports success and is
      // then overwritten is indistinguishable, to its caller, from one that
      // stuck.
      expect(bError?.message).toMatch(/held the LoRA catalog lock/);

      // A's write is intact and B's entry is not half-there.
      const onDisk = JSON.parse(realFs.readFileSync(catalogPath, "utf-8") as string) as {
        entries: Record<string, unknown>;
      };
      expect(Object.keys(onDisk.entries)).toEqual(["loras-from-a"]);

      // And B did not keep a mutation it was told did not land.
      expect(catalogB.get("from-b")).toBeNull();
    },
  );

  it("a write waits out, then refuses, while another writer holds the lock", { timeout: 30000 }, () => {
    writeFileSync(catalogPath, V1);
    const catalog = new LoraCatalog();
    // A live holder: this process's own pid, so no staleness rule can reclaim it.
    writeFileSync(
      lockPath(),
      JSON.stringify({ pid: process.pid, token: "another-writer", at: new Date().toISOString() }),
    );
    expect(() => catalog.upsert({ relPath: "loras/blocked.safetensors" })).toThrow(
      /held the LoRA catalog lock/,
    );
    // Nothing was written past the holder, and nothing lingered in memory.
    expect(realFs.readFileSync(catalogPath, "utf-8")).toBe(V1);
    expect(catalog.get("blocked")).toBeNull();
    // The lock is the OTHER writer's: refusing must not free it.
    expect(existsSync(lockPath())).toBe(true);
  });

  it("the refusal is not permanent — the next write goes through (no false refusal)", () => {
    writeFileSync(catalogPath, V1);
    const catalog = new LoraCatalog();
    rmSync(lockPath(), { force: true });
    catalog.upsert({ relPath: "loras/allowed.safetensors" });
    expect(catalog.get("allowed")?.id).toBe("loras-allowed");
    // The lock does not outlive the write it guarded.
    expect(existsSync(lockPath())).toBe(false);
  });

  it("an ABANDONED lock is reclaimed rather than wedging the catalog forever", () => {
    // A crashed writer leaves its lock behind. Treating that as a live holder
    // is the fold pointed the other way: every later write refused because a
    // file exists that nothing is using.
    writeFileSync(catalogPath, V1);
    const catalog = new LoraCatalog();
    writeFileSync(
      lockPath(),
      JSON.stringify({ pid: DEAD_PID, token: "crashed", at: new Date().toISOString() }),
    );
    const old = new Date(Date.now() - 120_000);
    utimesSync(lockPath(), old, old);
    catalog.upsert({ relPath: "loras/after-crash.safetensors" });
    expect(catalog.get("after-crash")?.id).toBe("loras-after-crash");
  });

  it("an OLD lock whose owner is still alive is never reclaimed", { timeout: 30000 }, () => {
    // Age alone does not license a reclaim: freeing a path a live writer is
    // still inside reintroduces exactly the loss the lock prevents.
    writeFileSync(catalogPath, V1);
    const catalog = new LoraCatalog();
    writeFileSync(
      lockPath(),
      JSON.stringify({ pid: process.pid, token: "slow-but-alive", at: new Date().toISOString() }),
    );
    const old = new Date(Date.now() - 120_000);
    utimesSync(lockPath(), old, old);
    expect(() => catalog.upsert({ relPath: "loras/nope.safetensors" })).toThrow(
      /held the LoRA catalog lock/,
    );
    expect(existsSync(lockPath())).toBe(true);
  });

  it("a write that does not read back as what was written is reported, not assumed", () => {
    // The write returned without throwing, which is not the same as the bytes
    // having arrived. Taking the INTENDED bytes as the new baseline is what
    // would let the next persist pass its unchanged check against a file
    // nobody ever wrote, and quietly overwrite whatever is really there.
    writeFileSync(catalogPath, V1);
    const catalog = new LoraCatalog();
    vi.mocked(renameSync).mockImplementation(((from: string, to: string) => {
      if (to === catalogPath) {
        // The rename "succeeds" but something else is at the path.
        realFs.writeFileSync(catalogPath, JSON.stringify({ version: 1, entries: {} }, null, 2));
        rmSync(from, { force: true });
        return;
      }
      return (realFs.renameSync as (a: string, b: string) => void)(from, to);
    }) as never);
    expect(() => catalog.upsert({ relPath: "loras/ghost.safetensors" })).toThrow(
      /does not read back as what was just written/,
    );
    // Refuse-vs-disclose: the message says NOT CONFIRMED, never that the file
    // was left alone — and memory is re-synced onto whatever is really there.
    expect(catalog.get("ghost")).toBeNull();
  });
});
