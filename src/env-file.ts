// THE canonical dotenv store (`~/.comfyui-mcp/.env`) and the only place that
// decides where it lives — shared by config.ts (which loads it at boot) and
// services/panel-secrets.ts (which WRITES it when the panel collects a token).
//
// Why this module exists (issue #826): the orchestrator writes a panel-collected
// credential here and then relies on RESPAWNING the comfyui MCP child so the new
// value reaches it through the child's spawn env. That made every credential
// structurally dependent on a respawn always firing — and when it didn't, the
// token sat on disk, valid and 0600, while every download kept failing 401 with
// nothing distinguishing "no token configured" from "token present but never
// injected". `freshSecretValue()` removes that dependency: a credential is
// resolved from the canonical file at ACCESS time, so a long-lived child sees a
// token saved after it started.
//
// SECURITY: nothing here ever logs a value. Callers get the value or `undefined`;
// `secretKeyPresent()` exists so status can be reported without handling one.

import dotenv from "dotenv";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Keys whose process.env value came FROM the env file at boot rather than from a
 * real environment variable. Those are stale as soon as the file changes, so
 * `freshSecretValue()` must NOT let them outrank a re-read — that inversion is
 * precisely what kept a just-saved token invisible. Keys absent from this set
 * are genuine environment variables (set by the shell or by the parent at spawn)
 * and keep winning, so the shell stays the escape hatch.
 */
const fileDerivedKeys = new Set<string>();

/**
 * Env var (KEY NAMES ONLY — never values) by which a parent process tells a child
 * "these keys are in your spawn env, but the canonical .env is their AUTHORITY".
 *
 * The orchestrator injects current credential values into the comfyui child's
 * spawn env (buildComfyuiMcpEnv) so the credential arrives even if the child
 * cannot read the file. Without this marker the child would see those as REAL
 * environment variables and pin them forever — so a rotate or a revoke would be
 * ignored for the life of the child while the save reported that the running
 * tools re-read the file (codex gate, round 1, finding 1: the remaining #826
 * false-success path). Marking them file-derived makes a later re-read
 * supersede the inherited copy, while `freshSecretValue`'s last fallback still
 * uses that copy when the file is unreadable.
 */
export const MANAGED_SECRET_KEYS_ENV = "COMFYUI_MCP_MANAGED_SECRET_KEYS";

/** Path to the canonical dotenv. `COMFYUI_MCP_ENV_FILE` overrides it (tests, and
 *  unusual installs) — resolved here ONCE so the writer and every reader, in the
 *  orchestrator and in the spawned child alike, can never disagree about which
 *  file "the token was saved" refers to. */
export function comfyuiEnvFilePath(): string {
  return process.env.COMFYUI_MCP_ENV_FILE || join(homedir(), ".comfyui-mcp", ".env");
}

/**
 * Parse the canonical env file. Returns `null` when the file does not exist or
 * cannot be read/parsed — DELIBERATELY distinct from `{}` (an existing but empty
 * file). A caller must be able to tell "the file says this key is gone" (a
 * revoke) from "I could not read the file at all" (unknown), because collapsing
 * those two makes a revoked credential look live, or a live one look revoked.
 */
export function parseEnvFile(): Record<string, string> | null {
  try {
    const p = comfyuiEnvFilePath();
    if (!existsSync(p)) return null;
    return dotenv.parse(readFileSync(p, "utf-8"));
  } catch {
    return null;
  }
}

/**
 * Boot load: copy file values into process.env for keys it does not already
 * define (identical precedence to `dotenv.config()` — a real env var always
 * wins) and REMEMBER which keys came from the file. Returns the keys applied.
 * config.ts calls this instead of dotenv.config() so the provenance is recorded.
 */
export function loadEnvFileIntoProcess(): string[] {
  // A parent that injected credential values into our spawn env tells us here
  // which of them the canonical file OWNS, so a later rotate/revoke supersedes
  // the inherited copy instead of being pinned for this process's whole life.
  for (const k of (process.env[MANAGED_SECRET_KEYS_ENV] ?? "").split(",")) {
    const key = k.trim();
    if (key) fileDerivedKeys.add(key);
  }
  const parsed = parseEnvFile();
  if (!parsed) return [];
  const applied: string[] = [];
  for (const [k, v] of Object.entries(parsed)) {
    if (process.env[k] === undefined) {
      process.env[k] = v;
      fileDerivedKeys.add(k);
      applied.push(k);
    }
  }
  return applied;
}

/** True when this key's process.env value was seeded from the env file at boot
 *  (so a file re-read supersedes it) rather than from a real env var. */
export function isFileDerived(key: string): boolean {
  return fileDerivedKeys.has(key);
}

/** Record that the canonical file is now this key's AUTHORITY, even though its
 *  current process.env value was assigned in-process. Called by the secret
 *  writer: after a save, the file is where the value lives, so a later re-read
 *  (a rotate by another process, a revoke) must supersede the in-memory copy. */
export function markFileDerived(key: string): void {
  fileDerivedKeys.add(key);
}

/** Test-only: forget the boot provenance so a suite can re-simulate startup. */
export function resetEnvFileProvenanceForTests(): void {
  fileDerivedKeys.clear();
}

/**
 * Resolve a credential NOW, in precedence order:
 *   1. a REAL environment variable (shell / spawn env) — the escape hatch wins;
 *   2. the canonical .env, RE-READ on every call — this is what lets a token
 *      saved after the process started become visible without a respawn (#826);
 *   3. a boot-seeded process.env value, but ONLY when the file is unreadable —
 *      if the file IS readable and no longer carries the key, the key is GONE
 *      (a revoke) and this returns undefined rather than resurrecting it.
 *
 * `keys` are aliases for the same credential, most-canonical first (e.g.
 * HF_TOKEN then HUGGINGFACE_TOKEN). Never logs.
 */
export function freshSecretValue(...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = process.env[k];
    if (typeof v === "string" && v.trim() && !fileDerivedKeys.has(k)) return v;
  }
  const parsed = parseEnvFile();
  if (parsed) {
    for (const k of keys) {
      const v = parsed[k];
      if (typeof v === "string" && v.trim()) return v;
    }
    // The file is readable and does not carry any alias — the credential is
    // genuinely unset. Do NOT fall through to a stale boot-seeded value.
    for (const k of keys) {
      if (fileDerivedKeys.has(k)) return undefined;
    }
  }
  for (const k of keys) {
    const v = process.env[k];
    if (typeof v === "string" && v.trim()) return v;
  }
  return undefined;
}

/** Whether a credential resolves to SOMETHING right now — presence only, so
 *  status can be reported without a caller ever holding the value. */
export function secretKeyPresent(...keys: string[]): boolean {
  return freshSecretValue(...keys) !== undefined;
}
