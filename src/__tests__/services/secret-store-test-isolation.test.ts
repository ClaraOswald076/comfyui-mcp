// A test must never be able to damage the machine it runs on.
//
// `console-secrets.test.ts` drove the real /api/secrets endpoint without setting
// COMFYUI_MCP_ENV_FILE, so every `npm test` wrote to the developer's actual
// ~/.comfyui-mcp/.env: it overwrote their live CIVITAI_API_TOKEN with the dummy
// `civ_key_123456789` and its revoke case deleted whichever slot it cleared.
// That went unnoticed for weeks because nothing asserted the store's location.
//
// This file is that assertion. It fails if any test file that writes credentials
// forgets to redirect the store, which is the only reliable way to keep the
// hazard from coming back the next time a secrets test is added.

import { describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";

const testsRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Every .test.ts under src/__tests__. */
function testFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...testFiles(full));
    else if (entry.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

/** Calls that WRITE to the canonical credential store, directly or through the
 *  console endpoint. A file containing one of these must redirect the store. */
const WRITE_MARKERS = [
  "setPanelSecret(",
  "setComfyuiSecret(",
  "setAgentSecret(",
  "setEnvSecret(",
  "removeEnvSecret(",
  "removeComfyuiSecret(",
  "removeAgentSecret(",
  "clearPanelSecret(",
  "migrateSecretsToEnv(",
  "/api/secrets",
];

const SELF = fileURLToPath(import.meta.url);

describe("secret-store test isolation", () => {
  // This file lists the write markers verbatim, so it matches its own sweep.
  const files = testFiles(testsRoot).filter((f) => resolve(f) !== resolve(SELF));

  it("finds the test tree (guards against a silently empty sweep)", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it("every test that can WRITE credentials redirects COMFYUI_MCP_ENV_FILE", () => {
    // An ASSIGNMENT, not a mention: `delete process.env.COMFYUI_MCP_ENV_FILE` in
    // a teardown, or the name in a comment, satisfies a substring check while
    // the store stays pointed at the developer's home directory.
    const assigns = /process\.env\.COMFYUI_MCP_ENV_FILE\s*=[^=]|COMFYUI_MCP_ENV_FILE["']?\s*:/;
    const offenders: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, "utf-8");
      const writes = WRITE_MARKERS.some((m) => src.includes(m));
      if (!writes) continue;
      if (!assigns.test(src)) offenders.push(relative(testsRoot, file));
    }
    expect(
      offenders,
      `These tests can write to the canonical credential store but never redirect it, ` +
        `so they write to the developer's real ~/.comfyui-mcp/.env:\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });

  it("the RUNTIME refuses a store write from a test that forgot to redirect", async () => {
    // The sweep above is a substring heuristic: a test that imports the setter
    // under an alias, or reaches a write through a helper, matches no marker and
    // sails through it. The runtime cannot be walked around that way — it sees
    // the write itself however the caller spelled it — so a forgotten redirect
    // becomes a failing test at the moment of the write instead of a silent
    // overwrite of the developer's real store.
    const { setComfyuiSecret } = await import("../../services/panel-secrets.js");
    const saved = process.env.COMFYUI_MCP_ENV_FILE;
    delete process.env.COMFYUI_MCP_ENV_FILE;
    try {
      expect(() => setComfyuiSecret("CIVITAI_API_TOKEN", "would-clobber-the-real-store")).toThrow(
        /Refusing to write the credential store from a test run/,
      );
    } finally {
      if (saved === undefined) delete process.env.COMFYUI_MCP_ENV_FILE;
      else process.env.COMFYUI_MCP_ENV_FILE = saved;
    }
  });

  it("allows the write once the store IS redirected", async () => {
    const { setComfyuiSecret } = await import("../../services/panel-secrets.js");
    const saved = process.env.COMFYUI_MCP_ENV_FILE;
    const dir = mkdtempSync(join(tmpdir(), "cmcp-guard-"));
    process.env.COMFYUI_MCP_ENV_FILE = join(dir, ".env");
    try {
      expect(() => setComfyuiSecret("CIVITAI_API_TOKEN", "safely-isolated")).not.toThrow();
    } finally {
      if (saved === undefined) delete process.env.COMFYUI_MCP_ENV_FILE;
      else process.env.COMFYUI_MCP_ENV_FILE = saved;
      delete process.env.CIVITAI_API_TOKEN;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("no test hardcodes the real home credential path", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, "utf-8");
      // homedir()-based store paths in a test are the same hazard wearing a hat.
      if (/homedir\(\)[^\n]*\.comfyui-mcp/.test(src)) offenders.push(relative(testsRoot, file));
    }
    expect(offenders).toEqual([]);
  });
});
