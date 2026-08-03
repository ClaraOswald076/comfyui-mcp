// The pin guard at the point the PANEL PACK IS IDENTIFIED AS THE TARGET.
//
// The bug these tests exist for: the pin was originally enforced only inside
// `runPanelAction`, which was described as "the mutation choke point". It wasn't
// — the panel is an ordinary custom node pack, so `update_custom_node(id=...)`
// and `id="all"` reached the SAME ComfyUI-Manager mutation without ever passing
// the guard. A pinned user was one generic call away from being moved.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { spawnSync } from "node:child_process";
import { mkdtempSync, existsSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const panelLockTestHooks = vi.hoisted(() => ({
  beforeClaimWrite: undefined as undefined | (() => void),
  afterCleanupWrite: undefined as undefined | (() => void),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    writeSync: (...args: Parameters<typeof actual.writeSync>) => {
      const hook = panelLockTestHooks.beforeClaimWrite;
      panelLockTestHooks.beforeClaimWrite = undefined;
      hook?.();
      const result = actual.writeSync(...args);
      const afterCleanupWrite = panelLockTestHooks.afterCleanupWrite;
      panelLockTestHooks.afterCleanupWrite = undefined;
      afterCleanupWrite?.();
      return result;
    },
  };
});

import {
  activePanelPendingOps,
  assertPanelPinAllows,
  clearPanelPendingOp,
  PanelPinnedError,
  panelLockPath,
  panelPendingOpsPath,
  recordPanelPendingOp,
  targetsPanelPack,
  targetsPanelPackExactly,
  withPanelMutationLock,
} from "../../services/panel-pin-guard.js";
import { setPanelVersionPin, PANEL_PIN_ENV_VAR } from "../../services/panel-settings.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cmcp-pinguard-"));
  process.env.COMFYUI_MCP_PANEL_SETTINGS = join(dir, "panel-settings.json");
  process.env.COMFYUI_MCP_PANEL_LOCK = join(dir, "panel-op.lock");
  process.env.COMFYUI_MCP_PANEL_PENDING = join(dir, "panel-pending-ops.json");
});

afterEach(() => {
  vi.restoreAllMocks();
  panelLockTestHooks.beforeClaimWrite = undefined;
  panelLockTestHooks.afterCleanupWrite = undefined;
  delete process.env.COMFYUI_MCP_PANEL_SETTINGS;
  delete process.env.COMFYUI_MCP_PANEL_LOCK;
  delete process.env.COMFYUI_MCP_PANEL_PENDING;
  delete process.env[PANEL_PIN_ENV_VAR];
  rmSync(dir, { recursive: true, force: true });
});

describe("targetsPanelPack — every spelling of the panel is the panel", () => {
  it.each([
    "comfyui-agent-panel", // registry id / pyproject name
    "comfyui-mcp-panel", // repo + custom_nodes dir name
    "ComfyUI-MCP-Panel", // case variant
    "  comfyui-agent-panel  ", // padded
    "https://github.com/artokun/comfyui-mcp-panel", // git URL
    "https://github.com/artokun/comfyui-mcp-panel.git", // git URL with .git
    "all", // bulk: moves the panel along with everything else
    "ALL",
  ])("matches %j", (id) => {
    expect(targetsPanelPack(id)).toBe(true);
  });

  it.each([
    // Every REF-CARRYING form parseGitUrl accepts. Naively taking the last path
    // segment turned "...panel.git@v0.11.28" into itself and ".../tree/main"
    // into "main", so both slipped past the matcher and moved a pinned panel.
    "https://github.com/artokun/comfyui-mcp-panel.git@v0.11.28",
    "https://github.com/artokun/comfyui-mcp-panel@nightly",
    "comfyui-mcp-panel@0.11.20",
    "https://github.com/artokun/comfyui-mcp-panel/tree/main",
    "https://github.com/artokun/comfyui-mcp-panel/commit/abc1234",
    "https://github.com/artokun/comfyui-mcp-panel/commits/main",
    "https://github.com/artokun/comfyui-mcp-panel/releases/tag/v0.11.28",
    "https://gitlab.com/artokun/comfyui-mcp-panel/-/tree/main",
    "https://gitlab.com/artokun/comfyui-mcp-panel/-/commit/abc1234",
    "https://bitbucket.org/artokun/comfyui-mcp-panel/src/main",
    "git@github.com:artokun/comfyui-mcp-panel.git",
    "https://github.com/artokun/comfyui-mcp-panel/",
    "https://github.com/artokun/comfyui-mcp-panel.git?foo=1",
    "artokun/comfyui-agent-panel", // "author/repo" form the panel tools accept
  ])("matches the ref-carrying / URL form %j", (id) => {
    expect(targetsPanelPack(id)).toBe(true);
  });

  it.each([
    "comfyui-manager",
    "was-node-suite",
    "",
    "   ",
    "comfyui-panel-other",
    "https://github.com/someone/comfyui-mcp-panel-fork",
    "https://github.com/someone/other-pack/tree/comfyui-mcp-panel",
  ])("does not match unrelated id %j", (id) => {
    expect(targetsPanelPack(id)).toBe(false);
  });

  it("separates an exact panel target from a bulk one (only the former can be redirected)", () => {
    expect(targetsPanelPackExactly("comfyui-agent-panel")).toBe(true);
    // "all" targets the panel but cannot be routed through the panel-only path.
    expect(targetsPanelPackExactly("all")).toBe(false);
    expect(targetsPanelPack("all")).toBe(true);
  });
});

describe("assertPanelPinAllows — the generic-tool door", () => {
  it("permits everything when nothing is pinned", () => {
    expect(() => assertPanelPinAllows("update", "comfyui-agent-panel")).not.toThrow();
    expect(() => assertPanelPinAllows("update", "all")).not.toThrow();
  });

  it("permits an unrelated pack even while the panel is pinned", () => {
    setPanelVersionPin("0.11.3");
    expect(() => assertPanelPinAllows("update", "was-node-suite")).not.toThrow();
  });

  it.each(["install", "update", "reinstall", "fix"])(
    "REFUSES %s of the panel by registry id while pinned",
    (action) => {
      setPanelVersionPin("0.11.3");
      expect(() => assertPanelPinAllows(action, "comfyui-agent-panel")).toThrow(
        PanelPinnedError,
      );
      expect(() => assertPanelPinAllows(action, "comfyui-agent-panel")).toThrow(
        /pinned to 0\.11\.3/i,
      );
    },
  );

  it("REFUSES the panel by repo name and by git URL while pinned", () => {
    setPanelVersionPin("0.11.3");
    expect(() => assertPanelPinAllows("update", "comfyui-mcp-panel")).toThrow(
      PanelPinnedError,
    );
    expect(() =>
      assertPanelPinAllows("update", "https://github.com/artokun/comfyui-mcp-panel.git"),
    ).toThrow(PanelPinnedError);
  });

  it('REFUSES a bulk id="all" while pinned, and says why "all" cannot be partial', () => {
    // The scenario that made this Critical: nothing about "all" names the panel,
    // yet it moves it.
    setPanelVersionPin("0.11.3");
    expect(() => assertPanelPinAllows("update", "all")).toThrow(PanelPinnedError);
    expect(() => assertPanelPinAllows("update", "all")).toThrow(
      /cannot update everything-except-one-pack|individually by id/i,
    );
  });

  it("REFUSES under an ENV pin and says unpin alone will not clear it", () => {
    process.env[PANEL_PIN_ENV_VAR] = "0.11.3";
    expect(() => assertPanelPinAllows("update", "all")).toThrow(
      new RegExp(PANEL_PIN_ENV_VAR),
    );
  });

  it("REFUSES when the pin is present but unreadable (can't tell → pinned)", () => {
    mkdirSync(dirname(process.env.COMFYUI_MCP_PANEL_SETTINGS as string), {
      recursive: true,
    });
    writeFileSync(process.env.COMFYUI_MCP_PANEL_SETTINGS as string, "{ not json");
    expect(() => assertPanelPinAllows("update", "comfyui-agent-panel")).toThrow(
      PanelPinnedError,
    );
  });

  it("permits again once the pin is cleared via the env escape hatch", () => {
    setPanelVersionPin("0.11.3");
    expect(() => assertPanelPinAllows("update", "all")).toThrow();
    process.env[PANEL_PIN_ENV_VAR] = "off";
    expect(() => assertPanelPinAllows("update", "all")).not.toThrow();
  });
});

describe("withPanelMutationLock — a FILE lock, so it holds across processes", () => {
  it("serializes overlapping operations", async () => {
    let inFlight = 0;
    let maxConcurrent = 0;
    const op = async () => {
      inFlight++;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight--;
    };
    await Promise.all([
      withPanelMutationLock(op),
      withPanelMutationLock(op),
      withPanelMutationLock(op),
    ]);
    expect(maxConcurrent).toBe(1);
  });

  it("releases the lock file afterwards, including on rejection", async () => {
    await withPanelMutationLock(async () => undefined);
    expect(existsSync(panelLockPath())).toBe(false);

    await expect(
      withPanelMutationLock(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(existsSync(panelLockPath())).toBe(false);

    // A rejection must not wedge the queue for everyone after it.
    await expect(withPanelMutationLock(async () => "ok")).resolves.toBe("ok");
  });

  it("is RE-ENTRANT so a guarded service can be called from inside a held lock", async () => {
    // runPanelAction holds the lock and then calls updateCustomNode, which takes
    // it again — a non-re-entrant lock would deadlock here.
    const result = await withPanelMutationLock(async () =>
      withPanelMutationLock(async () => "inner ran"),
    );
    expect(result).toBe("inner ran");
  });

  it("re-entrancy is ASYNC-CONTEXT-scoped, not process-global", async () => {
    // The bug: a process-global "held" flag let an UNRELATED concurrent caller
    // (a pin write) sail straight through while an update held the lock —
    // landing in the exact window between the update's final pin check and its
    // Manager call. Only work nested INSIDE the holder may skip the lock.
    const order: string[] = [];
    let releaseHolder: (() => void) | undefined;
    const holderDone = new Promise<void>((r) => {
      releaseHolder = r;
    });

    const holder = withPanelMutationLock(async () => {
      order.push("holder:start");
      // Nested-inside-the-holder: exempt, runs immediately.
      await withPanelMutationLock(async () => order.push("nested"));
      await holderDone;
      order.push("holder:end");
    });

    // Started from OUTSIDE the holder's async context while it is held.
    await new Promise((r) => setTimeout(r, 20));
    const outsider = withPanelMutationLock(async () => order.push("outsider"));

    await new Promise((r) => setTimeout(r, 20));
    // The outsider must NOT have run yet — it is queued behind the holder.
    expect(order).toEqual(["holder:start", "nested"]);

    releaseHolder?.();
    await Promise.all([holder, outsider]);
    expect(order).toEqual(["holder:start", "nested", "holder:end", "outsider"]);
  });

  it("does NOT reclaim a fresh lock even when its recorded pid is dead", async () => {
    // Age is a mandatory part of the proof. A just-created lock can still be
    // in the small window before its writer has committed its pid record.
    writeFileSync(panelLockPath(), JSON.stringify({ pid: 999999 }));
    await expect(
      withPanelMutationLock(async () => "should not run", { timeoutMs: 300 }),
    ).rejects.toThrow(/Timed out .* waiting for the panel operation lock/);
    expect(existsSync(panelLockPath())).toBe(true);
  });

  it("reclaims a stale lock whose owner is demonstrably dead", async () => {
    const path = panelLockPath();
    // The age and dead-pid gates are both required before reclaim.
    writeFileSync(path, JSON.stringify({ pid: 0x7fffffff }));
    const old = new Date(Date.now() - 60 * 60_000);
    const { utimesSync } = await import("node:fs");
    utimesSync(path, old, old);
    await expect(withPanelMutationLock(async () => "recovered", { timeoutMs: 300 })).resolves.toBe(
      "recovered",
    );
    expect(existsSync(path)).toBe(false);
  });

  it("does not delete a fresh cross-process replacement after observing a stale lock", async () => {
    const path = panelLockPath();
    const freshRecord = JSON.stringify({ pid: 12345, fresh: true });
    writeFileSync(path, JSON.stringify({ pid: 0x7fffffff }));
    const old = new Date(Date.now() - 60 * 60_000);
    const { utimesSync } = await import("node:fs");
    utimesSync(path, old, old);

    // Run the replacement in a separate Node process after this process has
    // observed the abandoned lock but before it records its reclaim claim. It
    // models an already-running older orchestrator winning the old reclaim.
    let replaced = false;
    panelLockTestHooks.beforeClaimWrite = () => {
      replaced = true;
      const child = spawnSync(
        process.execPath,
        [
          "-e",
          `const fs=require('node:fs');fs.rmSync(${JSON.stringify(path)});fs.writeFileSync(${JSON.stringify(path)},${JSON.stringify(freshRecord)});`,
        ],
        { encoding: "utf-8" },
      );
      expect(child.status).toBe(0);
    };

    await expect(
      withPanelMutationLock(async () => "must not run", { timeoutMs: 300 }),
    ).rejects.toThrow(/Timed out/);
    expect(replaced).toBe(true);
    expect(fs.readFileSync(path, "utf-8")).toBe(freshRecord);
  });

  it("recovers after a dead claimant leaves an old partial reclaim record", async () => {
    const path = panelLockPath();
    const claim = `${path}.reclaim`;
    writeFileSync(path, JSON.stringify({ pid: 0x7fffffff }));
    writeFileSync(claim, "partial");
    const old = new Date(Date.now() - 60 * 60_000);
    const { utimesSync } = await import("node:fs");
    utimesSync(path, old, old);
    utimesSync(claim, old, old);

    await expect(withPanelMutationLock(async () => "recovered", { timeoutMs: 500 })).resolves.toBe(
      "recovered",
    );
    expect(existsSync(path)).toBe(false);
    expect(existsSync(claim)).toBe(false);
  });

  it("does not delete a fresh claim that replaces an abandoned claim during cleanup", async () => {
    const path = panelLockPath();
    const claim = `${path}.reclaim`;
    const freshClaim = JSON.stringify({ pid: process.pid, token: "fresh-claim" });
    writeFileSync(path, JSON.stringify({ pid: 0x7fffffff }));
    writeFileSync(claim, JSON.stringify({ pid: 0x7fffffff, token: "dead-claim" }));
    const old = new Date(Date.now() - 60 * 60_000);
    const { utimesSync } = await import("node:fs");
    utimesSync(path, old, old);
    utimesSync(claim, old, old);

    // A separate process replaces the fixed claim after cleanup has taken its
    // exclusive token. Snapshot equality must make cleanup leave this fresh
    // token intact, so no later claimant can steal its base lock.
    let replaced = false;
    panelLockTestHooks.afterCleanupWrite = () => {
      replaced = true;
      const child = spawnSync(
        process.execPath,
        [
          "-e",
          `const fs=require('node:fs');fs.rmSync(${JSON.stringify(claim)});fs.writeFileSync(${JSON.stringify(claim)},${JSON.stringify(freshClaim)});`,
        ],
        { encoding: "utf-8" },
      );
      expect(child.status).toBe(0);
    };

    await expect(
      withPanelMutationLock(async () => "must not run", { timeoutMs: 300 }),
    ).rejects.toThrow(/Timed out/);
    expect(replaced).toBe(true);
    expect(fs.readFileSync(claim, "utf-8")).toBe(freshClaim);
  });

  it("does NOT reclaim an old lock whose owner is still ALIVE", async () => {
    // Age alone let two waiters both judge a lock stale, and the slower one
    // could then delete the FRESH lock the faster one had just taken — two
    // mutations in flight, the exact thing the lock prevents. A live owner's
    // lock must never read as stale, however old it looks.
    const path = panelLockPath();
    writeFileSync(path, JSON.stringify({ pid: process.pid })); // definitely alive
    const old = new Date(Date.now() - 60 * 60_000);
    const { utimesSync } = await import("node:fs");
    utimesSync(path, old, old);
    await expect(
      withPanelMutationLock(async () => "should not run", { timeoutMs: 300 }),
    ).rejects.toThrow(/Timed out/);
    expect(existsSync(path)).toBe(true);
  });

  it("fails closed on an old unreadable lock", async () => {
    const path = panelLockPath();
    writeFileSync(path, "not json");
    const old = new Date(Date.now() - 60 * 60_000);
    const { utimesSync } = await import("node:fs");
    utimesSync(path, old, old);
    await expect(
      withPanelMutationLock(async () => "recovered", { timeoutMs: 300 }),
    ).rejects.toThrow(/Timed out/);
    expect(existsSync(path)).toBe(true);
  });

  it("fails closed on an old lock without a valid pid", async () => {
    const path = panelLockPath();
    writeFileSync(path, JSON.stringify({ pid: "not-a-pid" }));
    const old = new Date(Date.now() - 60 * 60_000);
    const { utimesSync } = await import("node:fs");
    utimesSync(path, old, old);
    await expect(
      withPanelMutationLock(async () => "should not run", { timeoutMs: 300 }),
    ).rejects.toThrow(/Timed out/);
    expect(existsSync(path)).toBe(true);
  });

  it("keeps a concurrent contender behind the action that reclaimed the stale lock", async () => {
    // The successor must acquire through the same exclusive-create loop, not
    // run alongside the action that just reclaimed the abandoned holder.
    const path = panelLockPath();
    writeFileSync(path, JSON.stringify({ pid: 0x7fffffff }));
    const old = new Date(Date.now() - 60 * 60_000);
    const { utimesSync } = await import("node:fs");
    utimesSync(path, old, old);

    const order: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstMayFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = withPanelMutationLock(async () => {
      order.push("reclaimed holder started");
      await firstMayFinish;
      order.push("reclaimed holder finished");
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = withPanelMutationLock(async () => order.push("contender ran"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(order).toEqual(["reclaimed holder started"]);

    releaseFirst?.();
    await Promise.all([first, second]);
    expect(order).toEqual([
      "reclaimed holder started",
      "reclaimed holder finished",
      "contender ran",
    ]);
  });

  it("resolves with the action's OWN result, and only after its side effects finished", async () => {
    // Regression coverage for the review claim that the chaining let callers
    // resolve early (receiving undefined, racing the post-state). The caller
    // must get the guarded action's completion value — and any code running
    // after the returned promise resolves must observe the FINISHED
    // post-state, including a following lock acquisition.
    const order: string[] = [];
    const result = await withPanelMutationLock(async () => {
      await new Promise((r) => setTimeout(r, 30));
      order.push("side effect committed");
      return "the action result";
    });
    expect(result).toBe("the action result");
    expect(order).toEqual(["side effect committed"]);

    const observedByNextAcquisition = await withPanelMutationLock(async () =>
      order.slice(),
    );
    expect(observedByNextAcquisition).toEqual(["side effect committed"]);
  });
});

describe("assertPanelNotTargetedUnverifiable — paths that cannot verify", () => {
  it("refuses a panel target even when NOTHING is pinned", async () => {
    // panel_install_node / panel_update_node / fix_custom_node report success
    // straight off the Manager queue, which a stale Manager drains without doing
    // any work. There is no verified redirect for them, so they refuse and name
    // install_panel rather than move the panel unverifiably.
    const { assertPanelNotTargetedUnverifiable } = await import(
      "../../services/panel-pin-guard.js"
    );
    expect(() =>
      assertPanelNotTargetedUnverifiable("panel_update_node", "comfyui-agent-panel"),
    ).toThrow(/install_panel/);
    expect(() =>
      assertPanelNotTargetedUnverifiable(
        "panel_install_node",
        "https://github.com/artokun/comfyui-mcp-panel.git@v1",
      ),
    ).toThrow(/install_panel/);
  });

  it("reports the PIN first when one is set (the more specific reason)", async () => {
    const { assertPanelNotTargetedUnverifiable } = await import(
      "../../services/panel-pin-guard.js"
    );
    setPanelVersionPin("0.11.3");
    expect(() =>
      assertPanelNotTargetedUnverifiable("panel_update_node", "comfyui-agent-panel"),
    ).toThrow(/pinned to 0\.11\.3/i);
  });

  it("leaves unrelated packs and absent ids alone", async () => {
    const { assertPanelNotTargetedUnverifiable } = await import(
      "../../services/panel-pin-guard.js"
    );
    expect(() =>
      assertPanelNotTargetedUnverifiable("panel_update_node", "ComfyUI-WanVideoWrapper"),
    ).not.toThrow();
    expect(() =>
      assertPanelNotTargetedUnverifiable("panel_install_node", undefined),
    ).not.toThrow();
  });
});

describe("pending-op markers — record, read, and clear (#689)", () => {
  it("round-trips the optional base/uiId capture fields", () => {
    const op = recordPanelPendingOp("update-all", "test marker", 60_000, {
      base: "http://orig:8188",
      uiId: "ui-123",
    });
    const active = activePanelPendingOps();
    expect(active).toHaveLength(1);
    expect(active[0].base).toBe("http://orig:8188");
    expect(active[0].uiId).toBe("ui-123");
    expect(active[0].queuedAt).toBe(op.queuedAt);
  });

  it("markers without the optional fields still read fine (older shape)", () => {
    recordPanelPendingOp("update-all", "bare marker", 60_000);
    const active = activePanelPendingOps();
    expect(active).toHaveLength(1);
    expect(active[0].base).toBeUndefined();
    expect(active[0].uiId).toBeUndefined();
  });

  it("clearPanelPendingOp removes ONLY the exact record handed in", () => {
    const first = recordPanelPendingOp("update-all", "first", 60_000);
    // A newer marker of the same kind REPLACES the old one on record...
    const second = recordPanelPendingOp("update-all", "second", 60_000);
    expect(activePanelPendingOps().map((o) => o.detail)).toEqual(["second"]);

    // ...so clearing the STALE one is a no-op that must not touch the new one.
    expect(clearPanelPendingOp(first)).toBe(true);
    expect(activePanelPendingOps().map((o) => o.detail)).toEqual(["second"]);

    // Clearing the live one removes exactly it.
    expect(clearPanelPendingOp(second)).toBe(true);
    expect(activePanelPendingOps()).toEqual([]);
  });

  it("clearPanelPendingOp leaves other kinds alone", () => {
    const update = recordPanelPendingOp("update-all", "u", 60_000);
    recordPanelPendingOp("snapshot-restore", "s", 60_000);
    expect(clearPanelPendingOp(update)).toBe(true);
    expect(activePanelPendingOps().map((o) => o.kind)).toEqual(["snapshot-restore"]);
  });

  it("clearPanelPendingOp fails CLOSED on an unreadable marker file", () => {
    const op = recordPanelPendingOp("update-all", "u", 60_000);
    writeFileSync(panelPendingOpsPath(), "{ not json"); // corrupt it afterwards
    expect(clearPanelPendingOp(op)).toBe(false);
    // ...and the unreadable record still reads as a (synthetic) pending op.
    expect(activePanelPendingOps()).toHaveLength(1);
    expect(activePanelPendingOps()[0].kind).toBe("unknown");
  });
});
