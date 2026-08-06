// #826 end to end — drive the REAL panel_request_secret handler and assert it
// can no longer report a configured secret the tools cannot see.
//
// The reported failure: the tool answered "Token saved … the comfyui tools
// respawn with it as soon as this turn ends, then I'll retry" while the child
// that runs download_model action:"download_civitai" was never respawned. Retrying in a later turn
// returned the identical 401, and nothing in the tool's own answer let the agent
// tell "no token configured" from "valid token on disk but not injected" — so it
// looped.
//
// What must hold now, for every path through the handler:
//   * a save a read-back proves did NOT land is a REFUSAL that says do not retry;
//   * a save whose persistence is UNKNOWN is never described as verified;
//   * no answer promises a respawn that nothing reported;
//   * the raw secret never appears in the tool result.

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { SecretSaveReceipt } from "../../services/panel-secrets.js";

const setComfyuiSecretMock = vi.fn();
const setAgentSecretMock = vi.fn();
vi.mock("../../services/panel-secrets.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/panel-secrets.js")>();
  return {
    ...actual,
    setComfyuiSecret: (...a: unknown[]) => setComfyuiSecretMock(...a),
    setAgentSecret: (...a: unknown[]) => setAgentSecretMock(...a),
  };
});

import {
  buildPanelToolDefs,
  makePanelToolCtx,
  type PanelToolCtx,
  type ToolResult,
} from "../../orchestrator/panel-tools.js";

const SECRET = "civ-super-secret-value-9f3a";
const textOf = (res: ToolResult): string => (res.content[0] as { text: string }).text;

/** A bridge whose request_secret card returns the pasted value. */
function secretBridge(value: string = SECRET) {
  return {
    send: async () => value,
    push: () => 1,
    canReach: () => true,
    isHeadless: () => false,
    tabs: () => [{ tab_id: "tab-1", title: "tab-1", connected_at: 0 }],
    resolveActiveTabId: () => "tab-1",
  } as unknown as PanelToolCtx["bridge"];
}

async function callRequestSecret(
  args: Record<string, unknown> = {},
  value = SECRET,
): Promise<ToolResult> {
  const def = buildPanelToolDefs().find((d) => d.name === "panel_request_secret")!;
  const ctx = makePanelToolCtx(secretBridge(value), "tab-1");
  return def.handler(
    {
      label: "Paste your CivitAI API token",
      target_kind: "env",
      mcp_server: "comfyui",
      key: "CIVITAI_API_TOKEN",
      ...args,
    },
    ctx,
  );
}

const receipt = (over: Partial<SecretSaveReceipt> = {}): SecretSaveReceipt => ({
  key: "CIVITAI_API_TOKEN",
  path: "/home/u/.comfyui-mcp/.env",
  persisted: "yes",
  livePickup: true,
  respawn: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  // The setters are mocked here, so nothing should reach the store — but point
  // it at a temp path regardless. A secret test that can write to the real
  // ~/.comfyui-mcp/.env is one refactor away from destroying it.
  process.env.COMFYUI_MCP_ENV_FILE = join(tmpdir(), `env-${randomUUID()}.env`);
  process.env.COMFYUI_MCP_PANEL_SECRETS = join(tmpdir(), `secrets-${randomUUID()}.json`);
});

afterEach(() => {
  delete process.env.COMFYUI_MCP_ENV_FILE;
  delete process.env.COMFYUI_MCP_PANEL_SECRETS;
});

describe("panel_request_secret cannot report a secret the tools cannot see (#826)", () => {
  it("REFUSES when the read-back proves the save did not land", async () => {
    setComfyuiSecretMock.mockReturnValue(receipt({ persisted: "no" }));
    const res = await callRequestSecret();
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("was NOT saved");
    expect(textOf(res)).toContain("do not retry the action that needed it");
    // And it must not simultaneously claim success.
    expect(textOf(res)).not.toMatch(/Token saved|Saved env/);
  });

  it("does not describe an UNVERIFIABLE save as verified", async () => {
    setComfyuiSecretMock.mockReturnValue(receipt({ persisted: "unknown" }));
    const res = await callRequestSecret();
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toContain("UNKNOWN");
    expect(textOf(res)).not.toContain("verified by reading the file back");
  });

  it("does not call an UNVERIFIABLE provider-key save saved-and-enabled", async () => {
    // The three-valued verdict must be handled at EVERY consumer. Handling only
    // "no" left "unknown" rendering as the key was saved and the provider is
    // enabled — a definite configured state asserted from a failed read-back.
    setAgentSecretMock.mockReturnValue(
      receipt({ key: "OPENROUTER_API_KEY", persisted: "unknown" }),
    );
    const res = await callRequestSecret({
      mcp_server: "orchestrator",
      key: "OPENROUTER_API_KEY",
    });
    const text = textOf(res);
    expect(text).toContain("UNKNOWN");
    expect(text).not.toMatch(/is enabled now/);
    expect(text).not.toMatch(/pick it in the provider list/);
    expect(text).toContain("Do not treat the provider as configured");
  });

  it("says a save is SHADOWED when a real env var of the same name outranks the store", async () => {
    // Storing it is not the same as it being in use. Saying "saved" without this
    // reports a configured state the tools do not use — and the remedy (unset
    // the environment variable) is actionable from where the caller is.
    setComfyuiSecretMock.mockReturnValue(receipt({ shadowedByEnv: true }));
    const res = await callRequestSecret();
    const text = textOf(res);
    expect(text).toContain("NOT the value in use");
    expect(text).toContain("takes precedence over the store");
    expect(text).toContain("unset CIVITAI_API_TOKEN");
    // ...and it must not simultaneously claim the tools picked it up.
    expect(text).not.toContain("Retry the action that needed this credential now");
    expect(text).not.toContain("re-read that file each time");
  });

  it("says a provider-key save is SHADOWED too, instead of 'enabled now'", async () => {
    setAgentSecretMock.mockReturnValue(
      receipt({ key: "OPENROUTER_API_KEY", shadowedByEnv: true }),
    );
    const res = await callRequestSecret({
      mcp_server: "orchestrator",
      key: "OPENROUTER_API_KEY",
    });
    const text = textOf(res);
    expect(text).toContain("NOT the value in use");
    expect(text).not.toMatch(/is enabled now/);
  });

  it("never promises the old unconditional respawn", async () => {
    setComfyuiSecretMock.mockReturnValue(receipt());
    const res = await callRequestSecret();
    expect(textOf(res)).not.toContain("respawn with it as soon as this turn ends");
    expect(textOf(res)).toContain("NO tool-session respawn was scheduled");
  });

  it("reports a respawn only in the disposition the orchestrator actually reported", async () => {
    setComfyuiSecretMock.mockReturnValue(
      receipt({ respawn: { live: 2, applied: 1, scheduled: 1 } }),
    );
    const res = await callRequestSecret();
    expect(textOf(res)).toContain("1 replaced now");
    expect(textOf(res)).toContain("1 queued for the end of this turn");
  });

  it("marks the save as answering a request, so the retry nudge stays scoped to this tab (#164)", async () => {
    setComfyuiSecretMock.mockReturnValue(receipt());
    await callRequestSecret();
    expect(setComfyuiSecretMock).toHaveBeenCalledWith("CIVITAI_API_TOKEN", SECRET, {
      requested: true,
      tabId: "tab-1",
    });
  });

  it("applies value_prefix to the stored value but keeps it out of the answer", async () => {
    setComfyuiSecretMock.mockReturnValue(receipt());
    const res = await callRequestSecret({ value_prefix: "Bearer " });
    expect(setComfyuiSecretMock).toHaveBeenCalledWith(
      "CIVITAI_API_TOKEN",
      `Bearer ${SECRET}`,
      expect.anything(),
    );
    expect(textOf(res)).not.toContain(SECRET);
  });

  it("never echoes the secret in ANY branch", async () => {
    for (const p of ["yes", "no", "unknown"] as const) {
      setComfyuiSecretMock.mockReturnValue(receipt({ persisted: p }));
      const res = await callRequestSecret();
      expect(textOf(res)).not.toContain(SECRET);
    }
  });

  it("saves nothing when the user entered no token", async () => {
    const res = await callRequestSecret({}, "");
    expect(setComfyuiSecretMock).not.toHaveBeenCalled();
    expect(textOf(res)).toContain("nothing was saved");
  });

  it("treats a WHITESPACE-ONLY paste as nothing entered", async () => {
    // A blank persists and reads back perfectly, so it would be reported as a
    // VERIFIED save while every reader treats it as absent — a confirmed save
    // nothing downstream can use.
    for (const blank of ["   ", "\t", "\n "]) {
      setComfyuiSecretMock.mockClear();
      const res = await callRequestSecret({}, blank);
      expect(setComfyuiSecretMock).not.toHaveBeenCalled();
      expect(textOf(res)).toContain("nothing was saved");
      expect(res.isError).toBeFalsy();
    }
  });

  it("refuses an orchestrator provider key whose save did not land, instead of claiming a provider is enabled", async () => {
    setAgentSecretMock.mockReturnValue(
      receipt({ key: "OPENROUTER_API_KEY", persisted: "no", livePickup: true }),
    );
    const res = await callRequestSecret({
      mcp_server: "orchestrator",
      key: "OPENROUTER_API_KEY",
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("was NOT saved");
    expect(textOf(res)).not.toMatch(/is now enabled|pick it in the provider list/);
  });

  it("does not name OpenRouter for a provider key that is not OpenRouter", async () => {
    setAgentSecretMock.mockReturnValue(receipt({ key: "GLM_API_KEY" }));
    const res = await callRequestSecret({ mcp_server: "orchestrator", key: "GLM_API_KEY" });
    expect(textOf(res)).toContain("GLM_API_KEY");
    expect(textOf(res)).not.toContain("OpenRouter");
  });
});
