// The suite must not be able to write the developer's real state, and that has
// to be checkable rather than hoped for.
//
// Four separate times a test wrote to the real `~/.comfyui-mcp`: the credential
// `.env` (#837), the OAuth mirror (#859), `panel-pending-ops.json` (#866), and
// then the `.env` again on a full parallel run (#879). Every one was fixed where
// it was found; the class returned because each fix was per-test and the next
// test to reach for a store did not know it had to opt in.
//
// A clean run proves nothing on its own — #879 was INTERMITTENT, touching the
// real file on one full run and not on two others. So this asserts the mechanism
// instead of the outcome: the redirect is in effect, in this worker, pointing
// somewhere disposable.

import { describe, expect, it } from "vitest";
import { homedir } from "node:os";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

/** Every env var that steers a persistent store away from the user's home. */
const REDIRECTS = [
  "COMFYUI_MCP_ENV_FILE",
  "COMFYUI_MCP_PANEL_SECRETS",
  "COMFYUI_MCP_PANEL_PENDING",
  "COMFYUI_MCP_PANEL_LOCK",
  "COMFYUI_MCP_DATA_DIR",
] as const;

describe("suite state isolation (#866 / #879)", () => {
  it("every persistent store is redirected, in this worker", () => {
    // Worker scope is the part that matters: `globalSetup` runs in the MAIN
    // process, and this passing is what shows the values were inherited across
    // the fork rather than set somewhere the tests cannot see.
    for (const key of REDIRECTS) {
      expect(process.env[key], `${key} is not redirected`).toBeTruthy();
    }
  });

  // NOTE on the two below: both SKIP a var that is unset, so on their own they
  // pass vacuously when nothing is redirected at all. They are meaningful only
  // together with the test above, which is what establishes that the values
  // exist. Said out loud because "3 passing tests" would otherwise read as three
  // independent guarantees.
  it("no redirect points inside the real ~/.comfyui-mcp", () => {
    // Being SET is not enough — a redirect aimed at the real directory would
    // satisfy the check above while doing exactly the damage it exists to stop.
    const realStore = resolve(homedir(), ".comfyui-mcp");
    for (const key of REDIRECTS) {
      const value = process.env[key];
      if (!value) continue;
      expect(
        resolve(value).toLowerCase().startsWith(realStore.toLowerCase()),
        `${key} points inside the real store at ${realStore}`,
      ).toBe(false);
    }
  });

  it("the redirects land in a temp directory, not somewhere durable", () => {
    // The other way this could be satisfied while still being wrong: pointed at
    // the repo, or the CWD, or anywhere a stray file outlives the run. The old
    // in-tree generations.db (#872) is what that looks like in practice.
    const temp = resolve(tmpdir()).toLowerCase();
    for (const key of REDIRECTS) {
      const value = process.env[key];
      if (!value) continue;
      expect(
        resolve(value).toLowerCase().startsWith(temp),
        `${key} is not under the OS temp dir: ${value}`,
      ).toBe(true);
    }
  });
});
