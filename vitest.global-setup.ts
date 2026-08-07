import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Point every store this app persists to at a throwaway directory, for the WHOLE
 * run, before a single test file is collected.
 *
 * ## Why this exists
 *
 * Four separate times, a test wrote to the developer's REAL `~/.comfyui-mcp`:
 * the credential `.env` (#837), the OAuth mirror (#859), `panel-pending-ops.json`
 * (#866), and then the `.env` again, intermittently, on a full run (#879). Each
 * was fixed where it was found. The class kept coming back because each fix was
 * per-test, and the next test to reach for a store did not know it had to opt in.
 *
 * ## Why the runtime guards do not close it
 *
 * `assertStoreIsRedirectedInTests` / `assertPanelSecretsRedirectedInTests` refuse
 * a write unless the redirect is set — but they key off globals Vitest injects
 * into WORKER scope, and they deliberately ALLOW the write when they cannot prove
 * they are under the runner. That trade-off is correct and is not being changed:
 * refusing a real user their own credential is a worse failure than a stray test
 * write. The consequence is that anything writing from OUTSIDE a worker — the
 * main process, a global setup, a module-level side effect evaluated during
 * collection — sails straight through. That matches what #879 measured: no single
 * test file reproduced it, only the full parallel run.
 *
 * A guard at the write cannot see what it cannot see. Redirecting the whole run
 * removes the question instead of asking it more loudly.
 *
 * ## Why here and not in `setupFiles`
 *
 * `setupFiles` run per test FILE, inside a worker — already too late for anything
 * evaluated at collection, and too late for the main process. `globalSetup` runs
 * once in the main process before workers are forked, so the workers inherit
 * these values rather than each having to set them.
 *
 * Tests that need their own store still override these per-test, as they do now;
 * this is the floor, not a replacement. And a test that deliberately unsets one
 * to exercise a default is unaffected — it is choosing, which is the point.
 */
let dir: string | undefined;

export function setup(): void {
  dir = mkdtempSync(join(tmpdir(), "cmcp-suite-state-"));

  // The canonical credential store, and the legacy JSON one beside it.
  process.env.COMFYUI_MCP_ENV_FILE = join(dir, ".env");
  process.env.COMFYUI_MCP_PANEL_SECRETS = join(dir, "panel-secrets.json");
  // The crash-recovery marker a pin write reads and warns on.
  process.env.COMFYUI_MCP_PANEL_PENDING = join(dir, "panel-pending-ops.json");
  // The panel mutation lock. Also gives parallel workers their own file instead
  // of serializing on one shared path.
  process.env.COMFYUI_MCP_PANEL_LOCK = join(dir, "panel-op.lock");
  // The per-user data dir: generation tracker, lora catalog, batch manager,
  // training jobs, trainer bootstrap and ai-toolkit all derive from this one.
  process.env.COMFYUI_MCP_DATA_DIR = dir;
}

export function teardown(): void {
  if (!dir) return;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // A leftover temp directory is not worth failing a green run over, and it is
    // in the OS temp dir where it harms nothing.
  }
}
