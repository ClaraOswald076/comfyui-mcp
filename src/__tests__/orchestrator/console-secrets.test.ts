import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";

// The write path can be made to LAND but be unverifiable, so the endpoint's
// three-valued handling is testable: `unknown` is not a success.
// The store is written ATOMICALLY (temp file, fsync, rename), so it changes at
// exactly one instant: the rename. Read 1 after a rename is the writer's own
// whole-file verification; read 2 is the caller's read-back. Breaking the 2nd
// leaves the write PROVEN on disk with no verdict about its content — the exact
// shape of "written, but could not be verified".
const fsState = vi.hoisted(() => ({ breakSecondReadAfterRename: false, readsSinceRename: 0 }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const isStore = (p: unknown) => String(p).endsWith(".env");
  const renameSync: typeof actual.renameSync = (from, to) => {
    const out = actual.renameSync(from, to);
    if (isStore(to)) fsState.readsSinceRename = 0;
    return out;
  };
  const readFileSync: typeof actual.readFileSync = ((
    ...args: Parameters<typeof actual.readFileSync>
  ) => {
    if (fsState.breakSecondReadAfterRename && isStore(args[0])) {
      fsState.readsSinceRename++;
      if (fsState.readsSinceRename === 2) {
        throw Object.assign(new Error("EIO: i/o error, read"), { code: "EIO" });
      }
    }
    return actual.readFileSync(...args);
  }) as typeof actual.readFileSync;
  return { ...actual, default: { ...actual, renameSync, readFileSync }, renameSync, readFileSync };
});

import { startPanelConsoleHttpServer, type PanelConsoleHttpServer } from "../../orchestrator/panel-console-http.js";

const TOKEN = "test-console-token";
let srv: PanelConsoleHttpServer;
let envPath: string;
const base = () => srv.url;

describe("console /api/secrets", () => {
  beforeEach(async () => {
    fsState.breakSecondReadAfterRename = false;
    fsState.readsSinceRename = 0;
    process.env.COMFYUI_MCP_PANEL_SECRETS = join(tmpdir(), `secrets-${randomUUID()}.json`);
    // ISOLATE THE CANONICAL CREDENTIAL STORE. Without this the suite writes to
    // the developer's REAL ~/.comfyui-mcp/.env: the "sets a key" case below
    // overwrote their live CIVITAI_API_TOKEN with a dummy on every `npm test`,
    // and the revoke case deleted whatever slot it cleared. A test must never
    // be able to damage the machine it runs on.
    envPath = join(tmpdir(), `env-${randomUUID()}.env`);
    process.env.COMFYUI_MCP_ENV_FILE = envPath;
    srv = await startPanelConsoleHttpServer({ port: 0, bridgePort: 9180, comfyuiUrl: "http://127.0.0.1:8188", token: TOKEN });
  });
  afterEach(async () => {
    await srv.stop();
    fsState.breakSecondReadAfterRename = false;
    fsState.readsSinceRename = 0;
    delete process.env.COMFYUI_MCP_ENV_FILE;
    delete process.env.COMFYUI_MCP_PANEL_SECRETS;
    rmSync(envPath, { force: true });
  });

  it("401s without the token", async () => {
    const r = await fetch(`${base()}/api/secrets`);
    expect(r.status).toBe(401);
  });

  it("lists masked slots with the token", async () => {
    const r = await fetch(`${base()}/api/secrets?token=${TOKEN}`);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.slots.find((s: any) => s.id === "openrouter")).toBeTruthy();
    expect(body.slots.every((s: any) => s.masked === null || typeof s.masked === "string")).toBe(true);
  });

  it("sets a key and reflects it masked; rejects unknown slot", async () => {
    const ok = await fetch(`${base()}/api/secrets?token=${TOKEN}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ slot: "civitai", value: "civ_key_123456789" }),
    });
    expect(ok.status).toBe(200);
    expect((await ok.json()).masked).toBe("civ_…789");

    const bad = await fetch(`${base()}/api/secrets?token=${TOKEN}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ slot: "nope", value: "x" }),
    });
    expect(bad.status).toBe(400);
  });

  it("clears a set slot with clear:true (issue #203) — removes all alias keys", async () => {
    // set → confirm set → clear → confirm gone
    await fetch(`${base()}/api/secrets?token=${TOKEN}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ slot: "glm", value: "glm_key_abcdef12345" }),
    });
    const afterSet = await (await fetch(`${base()}/api/secrets?token=${TOKEN}`)).json();
    expect(afterSet.slots.find((s: any) => s.id === "glm").set).toBe(true);

    const clr = await fetch(`${base()}/api/secrets?token=${TOKEN}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ slot: "glm", clear: true }),
    });
    expect(clr.status).toBe(200);
    const clrBody = await clr.json();
    expect(clrBody.ok).toBe(true);
    expect(clrBody.cleared).toBe(true);

    const afterClear = await (await fetch(`${base()}/api/secrets?token=${TOKEN}`)).json();
    const slot = afterClear.slots.find((s: any) => s.id === "glm");
    expect(slot.set).toBe(false);
    expect(slot.masked).toBeNull();

    // clearing an already-empty slot reports cleared:false but still 200
    const again = await (await fetch(`${base()}/api/secrets?token=${TOKEN}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ slot: "glm", clear: true }),
    })).json();
    expect(again.ok).toBe(true);
    expect(again.cleared).toBe(false);

    // unknown slot still 400s on the clear path
    const bad = await fetch(`${base()}/api/secrets?token=${TOKEN}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ slot: "nope", clear: true }),
    });
    expect(bad.status).toBe(400);
  });

  it("does NOT report ok:true for a save it could not verify", async () => {
    // `setEnvSecret` returns yes/no/unknown and this endpoint used to fold
    // `unknown` into success — a definite configured state asserted from a
    // failed read-back, which is the #826 defect reappearing in the vocabulary
    // introduced to prevent it.
    fsState.breakSecondReadAfterRename = true;
    fsState.readsSinceRename = 0;
    const r = await fetch(`${base()}/api/secrets?token=${TOKEN}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slot: "civitai", value: "civ_key_unverifiable" }),
    });
    const body = await r.json();
    fsState.breakSecondReadAfterRename = false;
    fsState.readsSinceRename = 0;
    expect(body.ok).toBe(false);
    expect(r.status).toBe(500);
    expect(String(body.error)).toContain("UNKNOWN");
    expect(String(body.error)).not.toMatch(/was NOT saved/); // not a proven failure either
    expect(body.unverified_keys).toContain("CIVITAI_API_TOKEN");
    // ...and it must never echo the value.
    expect(JSON.stringify(body)).not.toContain("civ_key_unverifiable");
  });

  it("rejects an oversized body instead of hanging", async () => {
    const oversized = JSON.stringify({ slot: "civitai", value: "x".repeat(1_100_000) });
    const r = await fetch(`${base()}/api/secrets?token=${TOKEN}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: oversized,
    });
    expect(r.status).toBe(400);
    await r.text().catch(() => {});
  }, 5000);
});
