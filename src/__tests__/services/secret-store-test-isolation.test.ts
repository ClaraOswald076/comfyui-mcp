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
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
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

  it("keys off the RUNNER, not off environment variables a real user can have set", async () => {
    // The first version of this guard asked `NODE_ENV === "test" || VITEST ||
    // VITEST_WORKER_ID`. Those are ORDINARY ENVIRONMENT VARIABLES: a user with a
    // leftover `VITEST` export, or NODE_ENV=test inherited from an adjacent
    // project, was REFUSED when saving their own API key (codex gate). Refusing
    // a real user their credential is worse than the accidental store overwrite
    // this guard replaced, so it must key off something only the runner makes.
    //
    // Asked directly, because it cannot be asked any other way: vitest's own
    // `__vitest_index__` global is non-configurable, so a test running under
    // vitest cannot remove it to see what the answer falls back to. Handing the
    // predicate an EMPTY scope is that same question without the fight.
    const { runningUnderTestRunner } = await import("../../services/panel-secrets.js");
    const saved = {
      VITEST: process.env.VITEST,
      VITEST_WORKER_ID: process.env.VITEST_WORKER_ID,
      NODE_ENV: process.env.NODE_ENV,
    };
    try {
      // A plausible real user's shell:
      process.env.VITEST = "true";
      process.env.VITEST_WORKER_ID = "1";
      process.env.NODE_ENV = "test";
      // No runner in this scope, so the answer must be NO — whatever the shell
      // says. If the predicate consults any of those variables, this fails.
      expect(runningUnderTestRunner({})).toBe(false);
      // And a real runner is still detected, from its own marker alone.
      expect(runningUnderTestRunner({ __vitest_worker__: {} })).toBe(true);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
    // ...and the guard really is wired to that predicate: under THIS runner
    // (where the marker genuinely is present) an unredirected write is refused.
    // That case is covered by the test above.
    expect(runningUnderTestRunner()).toBe(true);
  });

  it("refuses a REMOVAL too — including when the .env does not exist yet", async () => {
    // The guard was asserted inside the rewrite, but the "no file, so nothing to
    // do" shortcut returned in front of it — and the caller then went on to
    // purge and REWRITE the legacy panel-secrets.json, so a test reaching a
    // removal through a helper could still delete the developer's real legacy
    // credential (codex gate). A guard with a path around it is not a guard.
    const { removeComfyuiSecret } = await import("../../services/panel-secrets.js");
    const saved = process.env.COMFYUI_MCP_ENV_FILE;
    const savedJson = process.env.COMFYUI_MCP_PANEL_SECRETS;
    const savedHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    const dir = mkdtempSync(join(tmpdir(), "cmcp-guard-rm-"));
    try {
      // Redirected: allowed, whether or not the file exists.
      process.env.COMFYUI_MCP_ENV_FILE = join(dir, "definitely-absent", ".env");
      expect(() => removeComfyuiSecret("CIVITAI_API_TOKEN")).not.toThrow();

      // NOT redirected, and the un-redirected store genuinely does NOT exist —
      // which is the whole point: the shortcut for "no file" is the path that
      // ran in front of the guard. Home is pointed at an empty temp dir so this
      // does not depend on whether the developer happens to have a real store,
      // and so a regression writes there rather than to their home directory.
      delete process.env.COMFYUI_MCP_ENV_FILE;
      process.env.HOME = dir;
      process.env.USERPROFILE = dir;
      const { comfyuiEnvFilePath } = await import("../../env-file.js");
      expect(resolve(comfyuiEnvFilePath()).startsWith(resolve(dir))).toBe(true);
      expect(existsSync(comfyuiEnvFilePath())).toBe(false); // the shortcut's path
      expect(() => removeComfyuiSecret("CIVITAI_API_TOKEN")).toThrow(
        /Refusing to write the credential store from a test run/,
      );
    } finally {
      if (saved === undefined) delete process.env.COMFYUI_MCP_ENV_FILE;
      else process.env.COMFYUI_MCP_ENV_FILE = saved;
      if (savedJson === undefined) delete process.env.COMFYUI_MCP_PANEL_SECRETS;
      else process.env.COMFYUI_MCP_PANEL_SECRETS = savedJson;
      if (savedHome.HOME === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome.HOME;
      if (savedHome.USERPROFILE === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = savedHome.USERPROFILE;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses to write the LEGACY store from a test that forgot to redirect it", async () => {
    // panel-secrets.json holds legacy tokens and the OAuth status mirror, and it
    // has its OWN redirect — which the runtime guard never covered.
    const { setOAuthStatus } = await import("../../services/panel-secrets.js");
    const saved = process.env.COMFYUI_MCP_PANEL_SECRETS;
    const savedHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    const dir = mkdtempSync(join(tmpdir(), "cmcp-guard-json-"));
    try {
      // HOME is redirected as well as the store, so that if the guard ever
      // REGRESSES this test writes to a temp directory instead of the
      // developer's real panel-secrets.json. A test for a guard must not depend
      // on the guard it is testing — this one did, and a mutation run that
      // removed the guard duly overwrote the real file's OAuth status mirror.
      process.env.HOME = dir;
      process.env.USERPROFILE = dir;
      delete process.env.COMFYUI_MCP_PANEL_SECRETS;
      const { panelSecretsPath } = await import("../../services/panel-secrets.js");
      expect(resolve(panelSecretsPath()).startsWith(resolve(dir))).toBe(true);
      expect(() => setOAuthStatus({ provider: "codex", account_label: "x", obtained_at: 1 })).toThrow(
        /Refusing to write the legacy credential store from a test run/,
      );
    } finally {
      if (saved === undefined) delete process.env.COMFYUI_MCP_PANEL_SECRETS;
      else process.env.COMFYUI_MCP_PANEL_SECRETS = saved;
      if (savedHome.HOME === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome.HOME;
      if (savedHome.USERPROFILE === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = savedHome.USERPROFILE;
      rmSync(dir, { recursive: true, force: true });
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
