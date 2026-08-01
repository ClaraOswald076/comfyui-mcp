// Persisted panel settings for the orchestrator's background agent. Survives
// soft reloads and full restarts (it's a small JSON file on disk), so a setting
// like the adult-content consent gate stays put and is queryable across the
// session — the agent reads it before deciding whether to surface NSFW work.
//
// The NSFW gate is a SAFETY control: it defaults OFF (keep everything SFW), and
// only flips ON after an explicit, verified-adult opt-in (18+ and adult content
// legal in the user's region). It governs what the system SURFACES and records
// the user's consent. It never overrides hard limits (no minors, no real-person
// sexual deepfakes, no depictions of actual non-consensual acts).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { logger } from "../utils/logger.js";

export interface NsfwConsent {
  /** True only after a verified-adult opt-in through the consent gate. */
  allowed: boolean;
  /** ISO timestamp of the most recent consent decision. */
  decidedAt?: string;
}

/** Non-secret connection config for the Ollama/OpenAI-compatible backend.
 *  API keys never live here — they stay in env (OPENROUTER_API_KEY etc.). */
export interface OllamaAgentConfig {
  /** Default model tag/id (e.g. "gemma4:12b", "xiaomi/mimo-v2.5"). */
  model?: string;
  /** "ollama" (local /api/chat) or "openai" (any OpenAI-compatible endpoint). */
  api?: "ollama" | "openai";
  /** Endpoint base URL (e.g. https://openrouter.ai/api/v1, incl. /v1). */
  baseUrl?: string;
}

export interface AgentSettings {
  /** User-curated model ids pinned to the top of the panel's model picker. */
  preferredModels?: string[];
  ollama?: OllamaAgentConfig;
  /** LM Studio provider (issue #160) — same shape; api/baseUrl unused today
   *  (fixed openai dialect + COMFYUI_MCP_LMSTUDIO_HOST) but kept for #162. */
  lmstudio?: OllamaAgentConfig;
  /** llama.cpp provider (issue #161) — same shape as lmstudio. */
  llamacpp?: OllamaAgentConfig;
  /** Custom OpenAI-compatible endpoint (issue #162): baseUrl + model, both
   *  user-supplied. The API key stays in the 0600 secrets store
   *  (COMFYUI_MCP_CUSTOM_API_KEY), never here. */
  custom?: OllamaAgentConfig;
}

/**
 * An EXPLICIT user pin holding the sidebar panel node-pack at one version.
 *
 * A pin is a promise: while it is set, nothing in this codebase may move the
 * panel — not the auto-sync skill, not `install_panel(action='update')`, not the
 * on-load auto-installer. The user cleared it or nothing happens. See
 * `panel-sync.ts` for the decision logic that honours it.
 */
export interface PanelVersionPin {
  /** The exact panel version the user pinned to, e.g. "0.11.20". */
  version: string;
  /** ISO timestamp of when the pin was set (absent for an env-var pin). */
  pinnedAt?: string;
  /** Optional free-text reason the user gave for pinning. */
  reason?: string;
}

/**
 * The resolved pin, including WHERE it came from — the caller must be able to
 * tell the user how to clear it, and an env pin cannot be cleared by writing the
 * settings file.
 */
export interface PanelPinState {
  /** True when a pin is in force. Nothing may move the panel while true. */
  pinned: boolean;
  /** The pinned version (only when `pinned`). */
  version?: string;
  /** Where the active pin came from; "none" when unpinned. */
  source: "env" | "settings" | "none";
  pinnedAt?: string;
  reason?: string;
  /**
   * The settings file EXISTS but could not be read/parsed, so we cannot PROVE
   * the absence of a pin. Callers must treat this like a pin (refuse to move the
   * panel) rather than as "unpinned" — silently moving a user off a pin we
   * merely failed to read is exactly the failure this feature exists to prevent.
   */
  indeterminate?: boolean;
}

/** Env override for the pin (wins over the settings file, per env > .env > json). */
export const PANEL_PIN_ENV_VAR = "COMFYUI_MCP_PANEL_PIN";

/** Env values that explicitly assert "no pin", overriding a persisted one. */
const PIN_ENV_OFF = new Set(["off", "none", "no", "0", "false", "unpinned"]);

export interface PanelSettings {
  nsfwConsent?: NsfwConsent;
  agent?: AgentSettings;
  /** Persisted explicit panel-version pin (see PanelVersionPin). */
  panelPin?: PanelVersionPin;
}

/** Settings file path. Overridable for tests. */
export function panelSettingsPath(): string {
  return (
    process.env.COMFYUI_MCP_PANEL_SETTINGS ||
    join(homedir(), ".comfyui-mcp", "panel-settings.json")
  );
}

/**
 * Read the settings file, reporting whether the read was CONCLUSIVE.
 *
 * `unreadable` is true only when the file exists but could not be read/parsed —
 * i.e. `{}` here is NOT proof that a key is unset. Most callers don't care (a
 * missing NSFW consent and an unreadable one both mean "not consented"), but the
 * panel pin does: an unreadable file must not be reported as "no pin".
 */
function readRaw(): { settings: PanelSettings; unreadable: boolean } {
  const p = panelSettingsPath();
  if (!existsSync(p)) return { settings: {}, unreadable: false };
  try {
    const parsed = JSON.parse(readFileSync(p, "utf-8")) as unknown;
    return parsed && typeof parsed === "object"
      ? { settings: parsed as PanelSettings, unreadable: false }
      : // Valid JSON but not an object (e.g. `null`, `[]`, `"x"`): the file is
        // present and structurally wrong, so a key's absence is not proven.
        { settings: {}, unreadable: true };
  } catch (err) {
    logger.warn(`[panel-settings] could not parse ${p}: ${err instanceof Error ? err.message : String(err)}`);
    return { settings: {}, unreadable: true };
  }
}

function read(): PanelSettings {
  return readRaw().settings;
}

function write(settings: PanelSettings): void {
  const p = panelSettingsPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(settings, null, 2));
}

/** Current NSFW consent state. Defaults to OFF when never set.
 *
 *  FAIL-CLOSED: `read()` casts arbitrary on-disk JSON, so a tampered or
 *  legacy/corrupt settings file could carry a non-boolean `allowed` (e.g. the
 *  truthy STRING "false", 1, "true"). Adult content must be enabled ONLY on a
 *  strict boolean `true`; every other value is treated as NOT consented. We also
 *  normalize `decidedAt` to a string-or-undefined so callers never see junk. */
export function getNsfwConsent(): NsfwConsent {
  const raw = read().nsfwConsent as Partial<NsfwConsent> | undefined;
  const allowed = raw?.allowed === true;
  const decidedAt = typeof raw?.decidedAt === "string" ? raw.decidedAt : undefined;
  return decidedAt === undefined ? { allowed } : { allowed, decidedAt };
}

/**
 * Persist an NSFW consent decision. `allowed` true ONLY after a verified-adult
 * opt-in; false revokes. Stamps the decision time.
 */
export function setNsfwConsent(allowed: boolean): NsfwConsent {
  const decidedAt = new Date().toISOString();
  const settings = read();
  settings.nsfwConsent = { allowed, decidedAt };
  write(settings);
  return settings.nsfwConsent;
}

// ---------------------------------------------------------------------------
// Panel version pin
// ---------------------------------------------------------------------------

/** Normalize a pin version string; returns undefined for junk/blank. */
function normalizePinVersion(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const v = raw.trim();
  return v.length > 0 && v.length <= 64 ? v : undefined;
}

/**
 * Resolve the ACTIVE panel-version pin.
 *
 * Precedence mirrors the rest of the project's config (env > `~/.comfyui-mcp/.env`
 * > the JSON settings store): `~/.comfyui-mcp/.env` is loaded into `process.env`
 * at boot, so a single `process.env` check covers both env layers.
 * `COMFYUI_MCP_PANEL_PIN=off` (or none/no/0/false/unpinned) is an explicit
 * "no pin" that overrides a persisted one — the env escape hatch when the
 * settings file can't be edited.
 *
 * Never throws: a pin we cannot read is reported `indeterminate`, which callers
 * MUST treat as pinned.
 */
export function getPanelPinState(env: NodeJS.ProcessEnv = process.env): PanelPinState {
  const rawEnv = env[PANEL_PIN_ENV_VAR];
  if (typeof rawEnv === "string" && rawEnv.trim().length > 0) {
    const trimmed = rawEnv.trim();
    if (PIN_ENV_OFF.has(trimmed.toLowerCase())) {
      return { pinned: false, source: "none" };
    }
    const version = normalizePinVersion(trimmed);
    if (version) return { pinned: true, version, source: "env" };
    // Present but unusable — we cannot tell what the user meant, so we do NOT
    // fall through to "unpinned".
    return { pinned: true, source: "env", indeterminate: true };
  }

  const { settings, unreadable } = readRaw();
  if (unreadable) return { pinned: true, source: "settings", indeterminate: true };

  const raw = settings.panelPin as Partial<PanelVersionPin> | undefined;
  if (!raw || typeof raw !== "object") return { pinned: false, source: "none" };
  const version = normalizePinVersion(raw.version);
  if (!version) {
    // A `panelPin` key exists but its version is junk: something pinned this
    // install, so refuse to move it rather than guessing it away.
    return { pinned: true, source: "settings", indeterminate: true };
  }
  const state: PanelPinState = { pinned: true, version, source: "settings" };
  if (typeof raw.pinnedAt === "string") state.pinnedAt = raw.pinnedAt;
  if (typeof raw.reason === "string") state.reason = raw.reason;
  return state;
}

/** Human-readable one-liner for a pin state, for messages the user reads. */
export function describePanelPin(pin: PanelPinState): string {
  if (!pin.pinned) return "not pinned";
  if (pin.indeterminate) {
    return pin.source === "env"
      ? `pinned via ${PANEL_PIN_ENV_VAR}, but its value is unusable`
      : `possibly pinned — ${panelSettingsPath()} could not be read`;
  }
  const where =
    pin.source === "env" ? `${PANEL_PIN_ENV_VAR} env var` : panelSettingsPath();
  return `pinned to ${pin.version} (via ${where})${pin.reason ? ` — ${pin.reason}` : ""}`;
}

function assertSettingsWritable(): PanelSettings {
  const { settings, unreadable } = readRaw();
  if (unreadable) {
    throw new Error(
      `Refusing to rewrite ${panelSettingsPath()}: it exists but could not be ` +
        `parsed, so writing would silently discard whatever else is in it. Fix or ` +
        `delete that file and retry (or set ${PANEL_PIN_ENV_VAR} in the environment, ` +
        `which takes precedence).`,
    );
  }
  return settings;
}

/**
 * Persist an explicit pin. Throws on a blank version or an unparseable settings
 * file (see assertSettingsWritable) — never silently drops the request.
 */
export function setPanelVersionPin(version: string, reason?: string): PanelVersionPin {
  const normalized = normalizePinVersion(version);
  if (!normalized) {
    throw new Error(
      "A panel version pin needs a non-empty version string (e.g. \"0.11.20\").",
    );
  }
  const settings = assertSettingsWritable();
  const pin: PanelVersionPin = { version: normalized, pinnedAt: new Date().toISOString() };
  const trimmedReason = typeof reason === "string" ? reason.trim() : "";
  if (trimmedReason) pin.reason = trimmedReason;
  settings.panelPin = pin;
  write(settings);
  return pin;
}

/**
 * Remove the persisted pin. Returns the pin that was removed, or undefined when
 * there wasn't one. Does NOT (and cannot) clear an env-var pin — callers must
 * report that separately so the user isn't told they're unpinned when they
 * aren't.
 */
export function clearPanelVersionPin(): PanelVersionPin | undefined {
  const settings = assertSettingsWritable();
  const previous = settings.panelPin;
  if (!previous) return undefined;
  delete settings.panelPin;
  write(settings);
  return previous;
}

/** Persisted agent backend/model preferences ({} when never set). */
export function getAgentSettings(): AgentSettings {
  return read().agent ?? {};
}

/**
 * Merge a partial update into the persisted agent settings. `preferredModels`
 * replaces the whole list (the panel sends the full edited list); `ollama`
 * fields merge per-key so e.g. a model change doesn't clobber the base URL.
 */
/**
 * Canonical form of a preferred-models list: trim, drop blanks, dedup, cap at 50.
 * Exported so the set_config handler can compare an INCOMING list against the
 * persisted one on the SAME footing — comparing a raw payload against this
 * normalized list would report "changed" on every heartbeat and revive the
 * config-repush loop (#393 follow-up).
 */
export function normalizePreferredModels(list: string[]): string[] {
  return [...new Set(list.map((m) => m.trim()).filter(Boolean))].slice(0, 50);
}

export function setAgentSettings(patch: AgentSettings): AgentSettings {
  const settings = read();
  const prev = settings.agent ?? {};
  const next: AgentSettings = { ...prev };
  if (patch.preferredModels !== undefined) {
    next.preferredModels = normalizePreferredModels(patch.preferredModels);
  }
  if (patch.ollama !== undefined) {
    next.ollama = { ...prev.ollama, ...patch.ollama };
  }
  if (patch.lmstudio !== undefined) {
    next.lmstudio = { ...prev.lmstudio, ...patch.lmstudio };
  }
  if (patch.llamacpp !== undefined) {
    next.llamacpp = { ...prev.llamacpp, ...patch.llamacpp };
  }
  if (patch.custom !== undefined) {
    next.custom = { ...prev.custom, ...patch.custom };
  }
  settings.agent = next;
  write(settings);
  return next;
}
