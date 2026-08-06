import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const homeState = vi.hoisted(() => ({ dir: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => homeState.dir || actual.homedir() };
});

// generation-tracker.ts pulls in config.ts (top-level await for port detect), so
// each test re-evaluates both with a fresh process.env via vi.resetModules().
const OLD_ENV = process.env;
const OLD_ARGV = process.argv;

describe("GenerationTracker default DB path", () => {
  const tmpDirs: string[] = [];
  const tmp = (prefix: string): string => {
    const d = mkdtempSync(join(tmpdir(), prefix));
    tmpDirs.push(d);
    return d;
  };

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...OLD_ENV };
    process.argv = [...OLD_ARGV];
    process.env.COMFYUI_API_KEY = "";
    process.env.COMFYUI_URL = "";
    process.env.COMFYUI_PATH = "";
    process.env.COMFYUI_HOST = "";
    process.env.COMFYUI_PORT = "8188"; // skip port auto-detect
    process.env.COMFYUI_MCP_FORCE_REMOTE = "";
    process.env.COMFYUI_MCP_DATA_DIR = "";
    homeState.dir = "";
  });

  afterEach(() => {
    process.env = OLD_ENV;
    process.argv = OLD_ARGV;
    vi.restoreAllMocks();
    while (tmpDirs.length) {
      try {
        rmSync(tmpDirs.pop()!, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
  });

  it("remote mode: writes the DB under the data dir scoped by instance, NOT cwd", async () => {
    const dataDir = tmp("gt-data-");
    process.env.COMFYUI_URL = "http://192.168.1.50:8188";
    process.env.COMFYUI_MCP_DATA_DIR = dataDir;
    const { GenerationTracker } = await import("../../services/generation-tracker.js");
    const t = new GenerationTracker();
    const expected = join(dataDir, "instances", "192.168.1.50_8188", "generations.db");
    expect(existsSync(expected)).toBe(true);
    t.close();
  });

  it("force-remote loopback: scoped under the data dir, not cwd", async () => {
    const dataDir = tmp("gt-data-");
    process.env.COMFYUI_URL = "http://127.0.0.1:8188";
    process.env.COMFYUI_MCP_FORCE_REMOTE = "1";
    process.env.COMFYUI_MCP_DATA_DIR = dataDir;
    const { GenerationTracker } = await import("../../services/generation-tracker.js");
    const t = new GenerationTracker();
    const expected = join(dataDir, "instances", "localhost_8188", "generations.db");
    expect(existsSync(expected)).toBe(true);
    t.close();
  });

  it("defaults the base dir to <home>/.comfyui-mcp when COMFYUI_MCP_DATA_DIR is unset", async () => {
    const fakeHome = tmp("gt-home-");
    homeState.dir = fakeHome;
    process.env.COMFYUI_URL = "http://192.168.1.50:8188";
    const { GenerationTracker } = await import("../../services/generation-tracker.js");
    const t = new GenerationTracker();
    const expected = join(fakeHome, ".comfyui-mcp", "instances", "192.168.1.50_8188", "generations.db");
    expect(existsSync(expected)).toBe(true);
    t.close();
  });

  it("explicit dbPath argument still wins over the default", async () => {
    const dataDir = tmp("gt-data-");
    const dbFile = join(dataDir, "custom", "explicit.db");
    const { GenerationTracker } = await import("../../services/generation-tracker.js");
    const t = new GenerationTracker(dbFile);
    expect(existsSync(dbFile)).toBe(true);
    t.close();
  });

  it("local install: the DB is NEVER written inside the ComfyUI install (#872)", async () => {
    // This asserted the opposite, and that placement was the bug: a live WAL
    // SQLite database — three open files — sitting inside ComfyUI's own git
    // working tree, in a directory its .gitignore does not cover. ComfyUI's
    // updater commits it with `git add -A`, then `git reset --hard` cannot delete
    // it because we hold the handle, so the user's update aborts AND its rollback
    // fails.
    const install = tmp("gt-install-");
    process.env.COMFYUI_PATH = install;
    const { GenerationTracker } = await import("../../services/generation-tracker.js");
    const t = new GenerationTracker();
    try {
      expect(existsSync(join(install, "comfyui-mcp", "generations.db"))).toBe(false);
      // …and nothing of ours is anywhere under the install at all.
      expect(existsSync(join(install, "comfyui-mcp"))).toBe(false);
    } finally {
      t.close();
    }
  });

  it("MOVES a legacy in-tree DB out, with its -wal and -shm", async () => {
    // Existing installs have real history at the old path. Changing where we look
    // without bringing it along would silently orphan it — the tracker comes up
    // empty and every past generation looks like it never happened. The -wal has
    // to travel too: a .db carried across without it loses every transaction that
    // had not been checkpointed.
    const install = tmp("gt-legacy-");
    // Own data dir: the instance slug (host+port) is the same for every test here,
    // so a sibling test's database would otherwise already occupy the target and
    // the migration would correctly refuse to clobber it.
    process.env.COMFYUI_MCP_DATA_DIR = tmp("gt-target-");
    process.env.COMFYUI_PATH = install;
    const legacyDir = join(install, "comfyui-mcp");
    mkdirSync(legacyDir, { recursive: true });

    const { GenerationTracker } = await import("../../services/generation-tracker.js");
    // A REAL database at the legacy path — a text fixture would be moved
    // correctly and then rejected by SQLite, which tests the fixture rather than
    // the migration.
    const legacy = new GenerationTracker(join(legacyDir, "generations.db"));
    legacy.close();
    expect(existsSync(join(legacyDir, "generations.db"))).toBe(true);
    // A clean close CHECKPOINTS the -wal away, so one has to be put back by hand
    // or this test cannot tell a migration that carries it from one that drops
    // it. Dropping it is the case that matters: a .db moved without its -wal
    // loses every transaction that had not been checkpointed — silent data loss
    // dressed as a successful migration.
    writeFileSync(join(legacyDir, "generations.db-wal"), "pending-wal");
    writeFileSync(join(legacyDir, "generations.db-shm"), "shm");

    const targetDb = join(
      process.env.COMFYUI_MCP_DATA_DIR as string,
      "instances",
      "localhost_8188",
      "generations.db",
    );

    const t = new GenerationTracker();
    try {
      // Gone from the install…
      expect(existsSync(join(legacyDir, "generations.db"))).toBe(false);
      expect(existsSync(join(legacyDir, "generations.db-wal"))).toBe(false);
      expect(existsSync(join(legacyDir, "generations.db-shm"))).toBe(false);
      // …and the -wal ARRIVED, not merely vanished.
      expect(existsSync(`${targetDb}-wal`)).toBe(true);
    } finally {
      t.close();
    }
  });

  it("does NOT clobber an existing new-location DB with a legacy one", async () => {
    // Both present. The new one is authoritative and may already have been
    // written to this session; overwriting either destroys history. Leave the
    // legacy file alone and say where it is.
    const install = tmp("gt-both-");
    // Own data dir: the instance slug (host+port) is the same for every test here,
    // so a sibling test's database would otherwise already occupy the target and
    // the migration would correctly refuse to clobber it.
    process.env.COMFYUI_MCP_DATA_DIR = tmp("gt-target-");
    process.env.COMFYUI_PATH = install;
    const legacyDir = join(install, "comfyui-mcp");
    mkdirSync(legacyDir, { recursive: true });

    const { GenerationTracker } = await import("../../services/generation-tracker.js");
    // ORDER MATTERS: the new-location DB must exist BEFORE the legacy one, or the
    // first construction simply migrates it and there is nothing to clobber. (My
    // first attempt had these reversed and the test proved nothing.)
    const first = new GenerationTracker();
    first.close();
    const legacy = new GenerationTracker(join(legacyDir, "generations.db"));
    legacy.close();

    const second = new GenerationTracker();
    try {
      // Both exist, so the legacy one is left exactly where it is — moving it
      // would overwrite history the new location may already hold.
      expect(existsSync(join(legacyDir, "generations.db"))).toBe(true);
    } finally {
      second.close();
    }
  });
});
