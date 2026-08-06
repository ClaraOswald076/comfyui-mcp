// User-editable overrides for EVERY agent prompt the orchestrator controls.
//
// Design: each prompt registers its built-in DEFAULT (id + label + default text).
// The user's override is stored SEPARATELY (~/.comfyui-mcp/panel-prompts.json), so
// a default is never destroyed — an empty override or an explicit Reset always falls
// back to the built-in. This makes "edit any prompt" safe: a bad edit that breaks
// tool use is one Reset away.
//
// resolvePrompt(id, fallback) is what call-sites use — it returns the override when
// present and non-empty, else the inline default (which is also what gets registered
// for the console listing). The store imports nothing from the backends, so wiring a
// call-site (backends import THIS) never risks a circular import; defaults are
// registered centrally at startup (see registerBuiltinPrompts in index.ts).

import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { logger } from "../utils/logger.js";
import { assertNotWritingRealHomeInTests } from "./test-isolation-guard.js";

export interface PromptDef {
  id: string;
  label: string;
  /** One-line note shown under the label in the editor (e.g. when it takes effect). */
  help?: string;
  default: string;
}

export interface PromptListItem {
  id: string;
  label: string;
  help?: string;
  default: string;
  /** The stored override text, or null when using the default. */
  override: string | null;
  overridden: boolean;
}

const REGISTRY = new Map<string, PromptDef>();
const emitter = new EventEmitter();

/** Overrides file path. Overridable for tests. */
export function panelPromptsPath(): string {
  return (
    process.env.COMFYUI_MCP_PANEL_PROMPTS ||
    join(homedir(), ".comfyui-mcp", "panel-prompts.json")
  );
}

function readOverrides(): Record<string, string> {
  const p = panelPromptsPath();
  if (!existsSync(p)) return {};
  try {
    const parsed = JSON.parse(readFileSync(p, "utf-8")) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  } catch (err) {
    logger.warn(`[prompt-overrides] could not parse ${p}: ${err instanceof Error ? err.message : String(err)}`);
    return {};
  }
}

function writeOverrides(o: Record<string, string>): void {
  const p = panelPromptsPath();
  // User-authored prompt text lives here — a test run writing the real file
  // rewrites what the user's prompts say. Refuse at the write.
  assertNotWritingRealHomeInTests(p, "the panel prompt overrides");
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(o, null, 2), "utf-8");
}

/** Register a prompt's built-in default so the editor can list + reset it. Idempotent. */
export function registerPrompt(id: string, label: string, def: string, help?: string): void {
  REGISTRY.set(id, { id, label, default: def, help });
}

/**
 * The effective prompt text for `id`: the stored override if present and non-empty,
 * otherwise `fallback` (the call-site's inline default, which also seeds the registry
 * default). A whitespace-only override counts as "use default".
 */
export function resolvePrompt(id: string, fallback: string): string {
  const ov = readOverrides()[id];
  if (typeof ov === "string" && ov.trim().length > 0) return ov;
  return fallback;
}

/** Persist an override. Empty/whitespace clears it (→ back to default). Emits change. */
export function setPromptOverride(id: string, value: string): void {
  const o = readOverrides();
  if (!value || !value.trim()) delete o[id];
  else o[id] = value;
  writeOverrides(o);
  emitter.emit("change", id);
}

/** Remove an override → back to the built-in default. Emits change. */
export function clearPromptOverride(id: string): void {
  const o = readOverrides();
  if (id in o) {
    delete o[id];
    writeOverrides(o);
  }
  emitter.emit("change", id);
}

/** All registered prompts with their default + current override, for the editor. */
export function listPrompts(): PromptListItem[] {
  const ov = readOverrides();
  return [...REGISTRY.values()].map((e) => {
    const o = ov[e.id];
    const overridden = typeof o === "string" && o.trim().length > 0;
    return { id: e.id, label: e.label, help: e.help, default: e.default, override: overridden ? o : null, overridden };
  });
}

/** Is `id` a prompt we know about? (Guards the write endpoint.) */
export function isKnownPrompt(id: string): boolean {
  return REGISTRY.has(id);
}

/** Subscribe to "a prompt override changed" (arg: the changed id). Returns unsubscribe. */
export function onPromptsChanged(cb: (id: string) => void): () => void {
  emitter.on("change", cb);
  return () => emitter.off("change", cb);
}
