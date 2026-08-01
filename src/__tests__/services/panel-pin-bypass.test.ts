// END-TO-END regression for the pin BYPASS.
//
// The pin was originally enforced only inside `runPanelAction`, which the PR
// described as "the mutation choke point". It was not: the sidebar panel is an
// ordinary custom node pack, so the GENERIC node mutations reach the very same
// ComfyUI-Manager operation without touching install_panel at all. A pinned user
// was one `update_custom_node(id="all")` away from being moved.
//
// These tests call the REAL exported service functions (no fs mocking, a real
// temp settings file) and assert they REFUSE while a pin is in force — and,
// critically, that they refuse BEFORE any Manager request is issued.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../../config.js", () => {
  const config = {
    comfyuiPath: undefined as string | undefined,
    resolvedPort: 8188,
    comfyuiHost: "127.0.0.1",
    comfyuiSsl: false,
    githubToken: undefined as string | undefined,
  };
  return {
    config,
    isLocalMode: () => true,
    getComfyUIBaseUrl: () => "http://127.0.0.1:8188",
    getComfyUIAuthHeaders: () => ({}),
  };
});

// Any Manager traffic at all means the guard let the mutation through.
const managerCalls: string[] = [];
vi.mock("../../comfyui/fetch.js", () => ({
  comfyuiFetch: vi.fn(async (path: string) => {
    managerCalls.push(path);
    return new Response("{}", { status: 200 });
  }),
}));

import {
  fixCustomNode,
  installCustomNode,
  reinstallCustomNode,
  updateCustomNode,
} from "../../services/node-management.js";
import { updateAllCustomNodes } from "../../services/update-comfyui.js";
import { PanelPinnedError } from "../../services/panel-pin-guard.js";
import { PANEL_PIN_ENV_VAR, setPanelVersionPin } from "../../services/panel-settings.js";

let dir: string;

beforeEach(() => {
  managerCalls.length = 0;
  dir = mkdtempSync(join(tmpdir(), "cmcp-bypass-"));
  process.env.COMFYUI_MCP_PANEL_SETTINGS = join(dir, "panel-settings.json");
  process.env.COMFYUI_MCP_PANEL_LOCK = join(dir, "panel-op.lock");
});

afterEach(() => {
  delete process.env.COMFYUI_MCP_PANEL_SETTINGS;
  delete process.env.COMFYUI_MCP_PANEL_LOCK;
  delete process.env[PANEL_PIN_ENV_VAR];
  rmSync(dir, { recursive: true, force: true });
});

describe("generic node mutations cannot walk past the panel pin", () => {
  it('update_custom_node(id="comfyui-agent-panel") REFUSES while pinned', async () => {
    setPanelVersionPin("0.11.3");
    await expect(updateCustomNode({ id: "comfyui-agent-panel" })).rejects.toThrow(
      PanelPinnedError,
    );
    expect(managerCalls).toEqual([]); // refused before any Manager request
  });

  it('update_custom_node(id="all") REFUSES while pinned — the bulk door', async () => {
    // Nothing about "all" names the panel, yet it moves it. This is the exact
    // scenario that made the original guard placement wrong.
    setPanelVersionPin("0.11.3");
    await expect(updateCustomNode({ id: "all" })).rejects.toThrow(PanelPinnedError);
    expect(managerCalls).toEqual([]);
  });

  it("update_all REFUSES while pinned — the third door, not a node tool at all", async () => {
    setPanelVersionPin("0.11.3");
    await expect(updateAllCustomNodes()).rejects.toThrow(PanelPinnedError);
    expect(managerCalls).toEqual([]);
  });

  it("reinstall/install/fix of the panel REFUSE while pinned, by any spelling", async () => {
    setPanelVersionPin("0.11.3");
    await expect(reinstallCustomNode({ id: "comfyui-mcp-panel" })).rejects.toThrow(
      PanelPinnedError,
    );
    await expect(
      installCustomNode({ id: "https://github.com/artokun/comfyui-mcp-panel.git" }),
    ).rejects.toThrow(PanelPinnedError);
    await expect(fixCustomNode({ id: "all" })).rejects.toThrow(PanelPinnedError);
    expect(managerCalls).toEqual([]);
  });

  it("REJECTS rather than throwing synchronously (callers use .then/.catch)", async () => {
    // apply_manifest does `installCustomNode(...).then().catch()` and documents
    // that it never rejects — a synchronous throw would walk straight past that
    // .catch and escape as an unhandled exception.
    setPanelVersionPin("0.11.3");
    let sync: unknown;
    let promise: Promise<unknown> | undefined;
    try {
      promise = updateCustomNode({ id: "all" });
    } catch (err) {
      sync = err;
    }
    expect(sync).toBeUndefined();
    expect(promise).toBeInstanceOf(Promise);
    await expect(promise).rejects.toThrow(PanelPinnedError);
  });

  it.each([
    "https://github.com/artokun/comfyui-mcp-panel.git@v0.11.28",
    "https://github.com/artokun/comfyui-mcp-panel/tree/main",
    "https://gitlab.com/artokun/comfyui-mcp-panel/-/commit/abc1234",
    "comfyui-agent-panel@nightly",
  ])("REFUSES the ref-carrying git form %j while pinned", async (id) => {
    // These are forms parseGitUrl accepts, so they really do reach the pack —
    // but the first matcher compared the raw last path segment and let them all
    // through, moving a pinned panel.
    setPanelVersionPin("0.11.3");
    await expect(installCustomNode({ id })).rejects.toThrow(PanelPinnedError);
    expect(managerCalls).toEqual([]);
  });

  it("an UNRELATED pack is untouched by the pin", async () => {
    setPanelVersionPin("0.11.3");
    // Reaches the Manager path (and fails there on the stubbed response, not on
    // the pin) — proving the guard is targeted, not a blanket freeze.
    await expect(updateCustomNode({ id: "was-node-suite" })).rejects.not.toThrow(
      PanelPinnedError,
    );
    expect(managerCalls.length).toBeGreaterThan(0);
  });

  it("everything proceeds again once the pin is cleared", async () => {
    setPanelVersionPin("0.11.3");
    await expect(updateCustomNode({ id: "all" })).rejects.toThrow(PanelPinnedError);
    process.env[PANEL_PIN_ENV_VAR] = "off";
    // No longer refused by the pin; it now reaches the Manager path.
    await updateCustomNode({ id: "all" }).catch(() => undefined);
    expect(managerCalls.length).toBeGreaterThan(0);
  });
});
