// The pin guard at the point the PANEL PACK IS IDENTIFIED AS THE TARGET.
//
// The bug these tests exist for: the pin was originally enforced only inside
// `runPanelAction`, which was described as "the mutation choke point". It wasn't
// — the panel is an ordinary custom node pack, so `update_custom_node(id=...)`
// and `id="all"` reached the SAME ComfyUI-Manager mutation without ever passing
// the guard. A pinned user was one generic call away from being moved.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, existsSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  assertPanelPinAllows,
  PanelPinnedError,
  panelLockPath,
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
});

afterEach(() => {
  delete process.env.COMFYUI_MCP_PANEL_SETTINGS;
  delete process.env.COMFYUI_MCP_PANEL_LOCK;
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

  it.each(["comfyui-manager", "was-node-suite", "", "   ", "comfyui-panel-other"])(
    "does not match unrelated id %j",
    (id) => {
      expect(targetsPanelPack(id)).toBe(false);
    },
  );

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

  it("times out rather than proceeding when another process holds the lock", async () => {
    // Simulate a live lock owned by someone else: a fresh lock file we never release.
    writeFileSync(panelLockPath(), JSON.stringify({ pid: 999999 }));
    await expect(
      withPanelMutationLock(async () => "should not run", { timeoutMs: 300 }),
    ).rejects.toThrow(/Timed out .* waiting for the panel operation lock/);
  });

  it("reclaims a STALE lock so a crashed process cannot wedge pinning forever", async () => {
    const path = panelLockPath();
    writeFileSync(path, JSON.stringify({ pid: 999999 }));
    // Backdate well past the stale window.
    const old = new Date(Date.now() - 60 * 60_000);
    const { utimesSync } = await import("node:fs");
    utimesSync(path, old, old);
    await expect(
      withPanelMutationLock(async () => "recovered", { timeoutMs: 1000 }),
    ).resolves.toBe("recovered");
  });
});
