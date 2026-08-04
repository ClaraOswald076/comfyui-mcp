// #826 — the structural half of the bug lives in config.ts.
//
// `config.civitaiApiToken` / `config.huggingfaceToken` were snapshotted from
// process.env at MODULE LOAD, and the canonical .env was read exactly once at
// boot. In the comfyui MCP child that makes every download credential
// permanently invisible unless the orchestrator's respawn fires: the token is
// written to ~/.comfyui-mcp/.env, 0600, correct key — and every download keeps
// returning 401 anyway.
//
// These tests load the REAL config module against a temp .env and prove the two
// getters resolve at ACCESS time, in both directions (a late save becomes
// visible; a revoke stops applying) without the module being reloaded.

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TOUCHED = [
  "CIVITAI_API_TOKEN",
  "HF_TOKEN",
  "HUGGINGFACE_TOKEN",
  "COMFYUI_MCP_ENV_FILE",
  "COMFYUI_HOST",
  "COMFYUI_PORT",
];

let dir: string;
let envPath: string;
let saved: Record<string, string | undefined>;

/** Load a FRESH config module bound to the temp .env (mirrors a child booting). */
async function bootConfig() {
  vi.resetModules();
  return (await import("../config.js")).config;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cmcp-config-lazy-"));
  envPath = join(dir, ".env");
  saved = {};
  for (const k of TOUCHED) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.COMFYUI_MCP_ENV_FILE = envPath;
  // Pin host/port so the module's boot-time port autodetect never hits the network.
  process.env.COMFYUI_HOST = "127.0.0.1";
  process.env.COMFYUI_PORT = "8188";
});

afterEach(() => {
  for (const k of TOUCHED) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.resetModules();
  rmSync(dir, { recursive: true, force: true });
});

describe("config download credentials resolve at ACCESS time (#826)", () => {
  it("sees a CivitAI token saved AFTER the module loaded — no respawn needed", async () => {
    writeFileSync(envPath, "", { mode: 0o600 });
    const config = await bootConfig();
    expect(config.civitaiApiToken).toBeUndefined();

    // panel_request_secret writes the canonical file. This process is NOT restarted.
    writeFileSync(envPath, "CIVITAI_API_TOKEN=civ-late\n", { mode: 0o600 });

    expect(config.civitaiApiToken).toBe("civ-late");
  });

  it("sees an HF token saved after load, honoring the HF_TOKEN alias order", async () => {
    writeFileSync(envPath, "", { mode: 0o600 });
    const config = await bootConfig();
    expect(config.huggingfaceToken).toBeUndefined();

    writeFileSync(envPath, "HUGGINGFACE_TOKEN=legacy\n", { mode: 0o600 });
    expect(config.huggingfaceToken).toBe("legacy");

    writeFileSync(envPath, "HUGGINGFACE_TOKEN=legacy\nHF_TOKEN=canonical\n", { mode: 0o600 });
    expect(config.huggingfaceToken).toBe("canonical");
  });

  it("picks up a ROTATED token rather than pinning the one loaded at boot", async () => {
    writeFileSync(envPath, "CIVITAI_API_TOKEN=old\n", { mode: 0o600 });
    const config = await bootConfig();
    expect(config.civitaiApiToken).toBe("old");

    writeFileSync(envPath, "CIVITAI_API_TOKEN=rotated\n", { mode: 0o600 });
    expect(config.civitaiApiToken).toBe("rotated");
  });

  it("stops applying a REVOKED token — the same access-time read works both ways", async () => {
    writeFileSync(envPath, "CIVITAI_API_TOKEN=doomed\n", { mode: 0o600 });
    const config = await bootConfig();
    expect(config.civitaiApiToken).toBe("doomed");

    writeFileSync(envPath, "# cleared\n", { mode: 0o600 });
    expect(config.civitaiApiToken).toBeUndefined();
  });

  it("keeps a real environment variable outranking the file", async () => {
    process.env.CIVITAI_API_TOKEN = "from-shell";
    writeFileSync(envPath, "CIVITAI_API_TOKEN=from-file\n", { mode: 0o600 });
    const config = await bootConfig();
    expect(config.civitaiApiToken).toBe("from-shell");
  });

  it("exposes the credential file path so a caller can name it without guessing", async () => {
    writeFileSync(envPath, "", { mode: 0o600 });
    vi.resetModules();
    const { credentialEnvFilePath } = await import("../config.js");
    expect(credentialEnvFilePath()).toBe(envPath);
  });
});
