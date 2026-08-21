/**
 * #1963 — the pair-time toggle "Don't update while my phone is paired".
 *
 * Default ON. Persisted next to the pair token so a desk machine that paired
 * a phone this morning still knows not to apply (and rotate the tunnel) after
 * the socket has been suspended. Turning it off, or sending apply_updates_now,
 * is the explicit "I am back at the desk" signal.
 *
 * Fail closed: a missing, unreadable, or malformed file means the toggle is
 * ON — applying while unsure would disconnect the phone, which is the
 * failure this record exists to prevent.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { writeFileDurable } from "../utils/durable-write.js";
import { logger } from "../utils/logger.js";
import { assertNotWritingRealHomeInTests } from "../services/test-isolation-guard.js";

export interface PairUpdatePrefs {
  /** Default true. When true, a sticky quick-tunnel pairing blocks APPLY. */
  deferWhilePaired: boolean;
}

const DEFAULTS: PairUpdatePrefs = { deferWhilePaired: true };

export function pairUpdatePrefsPath(): string {
  return (
    process.env.COMFYUI_MCP_PAIR_UPDATE_PREFS ||
    join(homedir(), ".comfyui-mcp", "pair-update-prefs.json")
  );
}

function asPrefs(raw: unknown): PairUpdatePrefs | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const v = (raw as { deferWhilePaired?: unknown }).deferWhilePaired;
  // Absent key → default ON. Explicit boolean only otherwise — a string
  // "false" must not open the gate.
  if (v === undefined) return { ...DEFAULTS };
  if (typeof v !== "boolean") return null;
  return { deferWhilePaired: v };
}

export function loadPairUpdatePrefs(): PairUpdatePrefs {
  const path = pairUpdatePrefsPath();
  if (!existsSync(path)) return { ...DEFAULTS };
  try {
    const raw = readFileSync(path, "utf-8");
    if (raw.length === 0) return { ...DEFAULTS };
    const parsed = asPrefs(JSON.parse(raw) as unknown);
    return parsed ?? { ...DEFAULTS };
  } catch (err) {
    logger.warn(
      `[pair-update-prefs] could not read ${path}: ${
        err instanceof Error ? err.message : String(err)
      } — defaulting to defer-while-paired ON`,
    );
    return { ...DEFAULTS };
  }
}

export function savePairUpdatePrefs(patch: Partial<PairUpdatePrefs>): PairUpdatePrefs {
  const next: PairUpdatePrefs = {
    ...loadPairUpdatePrefs(),
    ...patch,
  };
  const path = pairUpdatePrefsPath();
  assertNotWritingRealHomeInTests(path, "the pair-update prefs");
  mkdirSync(dirname(path), { recursive: true });
  writeFileDurable(path, JSON.stringify(next, null, 2));
  return next;
}
