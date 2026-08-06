// The property-level fix for "the suite keeps writing the developer's real
// ~/.comfyui-mcp" (#879, #866): a run-wide HOME redirect, plus write-guards
// that refuse any state write deliberately pointed back at the real home.
//
// The first group pins the REDIRECT itself: if the setup file is dropped from
// vitest.config.ts, every other isolation mechanism silently loses its
// foundation, so the suite must say so. The rest pin the guard's behaviour at
// the write, including the empty-redirect fold that made #866's NUL sentinel
// silently harmless.

import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import {
  assertNotWritingRealHomeInTests,
  realHomeRecordedForTestIsolation,
  recordRealHomeForTestIsolation,
} from "../../services/test-isolation-guard.js";
import {
  panelLockPath,
  panelPendingOpsPath,
  recordPanelPendingOp,
} from "../../services/panel-pin-guard.js";

const savedPending = process.env.COMFYUI_MCP_PANEL_PENDING;
const savedLock = process.env.COMFYUI_MCP_PANEL_LOCK;
const recordedRealHome = realHomeRecordedForTestIsolation();

afterEach(() => {
  if (savedPending === undefined) delete process.env.COMFYUI_MCP_PANEL_PENDING;
  else process.env.COMFYUI_MCP_PANEL_PENDING = savedPending;
  if (savedLock === undefined) delete process.env.COMFYUI_MCP_PANEL_LOCK;
  else process.env.COMFYUI_MCP_PANEL_LOCK = savedLock;
  // A test that swaps in a stand-in "real home" must hand the true one back,
  // or every later guard in this worker compares against the wrong directory.
  if (recordedRealHome) recordRealHomeForTestIsolation(recordedRealHome);
});

describe("suite-wide home redirect (#879)", () => {
  it("the run recorded the real home and is NOT living in it", () => {
    // This is the assertion that fails when the setup file is removed from
    // vitest.config.ts — without it, every other guard here keeps passing
    // while the suite writes real state again.
    expect(recordedRealHome).toBeDefined();
    expect(resolve(homedir())).not.toBe(resolve(recordedRealHome as string));
  });

  it("every default state path resolves OUTSIDE the real state directory", () => {
    delete process.env.COMFYUI_MCP_PANEL_PENDING;
    delete process.env.COMFYUI_MCP_PANEL_LOCK;
    // Compare against the real STATE ROOT, not the real home: on Windows the
    // OS temp directory (and so this run's isolated home) legitimately lives
    // inside the user's home directory.
    const realStateRoot = resolve(join(recordedRealHome as string, ".comfyui-mcp"));
    for (const p of [panelPendingOpsPath(), panelLockPath()]) {
      const resolved = resolve(p);
      expect(resolved === realStateRoot || resolved.startsWith(realStateRoot + sep)).toBe(false);
    }
  });
});

describe("real-home write guard (#866)", () => {
  it("refuses a pending-ops write pointed back at the real home, at the write", () => {
    // A temp dir stands in for the real home so the REFUSAL is what's tested —
    // never an actual write near the developer's state.
    const standInHome = mkdtempSync(join(tmpdir(), "cmcp-fake-real-home-"));
    try {
      recordRealHomeForTestIsolation(standInHome);
      const target = join(standInHome, ".comfyui-mcp", "panel-pending-ops.json");
      process.env.COMFYUI_MCP_PANEL_PENDING = target;
      expect(() =>
        recordPanelPendingOp("update-all", "guard probe", 60_000),
      ).toThrow(/Refusing to write the pending panel-operation record from a test run/);
      // Fence before report held: the refusal happened BEFORE any write.
      expect(existsSync(target)).toBe(false);
    } finally {
      rmSync(standInHome, { recursive: true, force: true });
    }
  });

  it("allows the same write once it targets the isolated home", () => {
    const dir = mkdtempSync(join(tmpdir(), "cmcp-guard-allow-"));
    try {
      process.env.COMFYUI_MCP_PANEL_PENDING = join(dir, "panel-pending-ops.json");
      expect(() => recordPanelPendingOp("update-all", "guard probe", 60_000)).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the guard itself: inside the real state directory refuses, outside allows", () => {
    const standInHome = mkdtempSync(join(tmpdir(), "cmcp-guard-boundary-"));
    try {
      recordRealHomeForTestIsolation(standInHome);
      expect(() =>
        assertNotWritingRealHomeInTests(
          join(standInHome, ".comfyui-mcp", "state.json"),
          "a state file",
        ),
      ).toThrow(/Refusing to write a state file from a test run/);
      // A directory whose name merely SHARES A PREFIX is not inside the state
      // root — a boundary check without the separator would refuse it.
      expect(() =>
        assertNotWritingRealHomeInTests(
          join(standInHome, ".comfyui-mcp-old", "state.json"),
          "a state file",
        ),
      ).not.toThrow();
      // Elsewhere in the home is not the state directory either — Windows
      // keeps the OS temp directory inside the user's home, so the guard must
      // not treat the whole home as off-limits.
      expect(() =>
        assertNotWritingRealHomeInTests(join(standInHome, "other.json"), "a state file"),
      ).not.toThrow();
      // The current (redirected) home is the throwaway one — a write under
      // its state directory must be allowed. `isolatedHome` is bound on its
      // own line because the static sweep in secret-store-test-isolation
      // rightly flags any test line combining homedir() with the state dir.
      const isolatedHome = homedir();
      expect(() =>
        assertNotWritingRealHomeInTests(
          join(isolatedHome, ".comfyui-mcp", "state.json"),
          "a state file",
        ),
      ).not.toThrow();
    } finally {
      rmSync(standInHome, { recursive: true, force: true });
    }
  });
});

describe("empty redirect is not 'use the default' (#866)", () => {
  it("panelPendingOpsPath fails loudly on an explicitly-empty override", () => {
    // Node truncates `process.env.X = "\0"` to "" — which is how a sentinel
    // that LOOKED like an impossible path silently resolved to the real home.
    process.env.COMFYUI_MCP_PANEL_PENDING = "";
    expect(() => panelPendingOpsPath()).toThrow(/COMFYUI_MCP_PANEL_PENDING is set but EMPTY/);
  });

  it("panelLockPath fails loudly on an explicitly-empty override", () => {
    process.env.COMFYUI_MCP_PANEL_LOCK = "";
    expect(() => panelLockPath()).toThrow(/COMFYUI_MCP_PANEL_LOCK is set but EMPTY/);
  });
});
