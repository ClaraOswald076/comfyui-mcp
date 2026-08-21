// #1963 — the pair-time "Don't update while my phone is paired" toggle.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadPairUpdatePrefs,
  pairUpdatePrefsPath,
  savePairUpdatePrefs,
} from "../../orchestrator/pair-update-prefs.js";

let dir: string;
let file: string;
const OLD = process.env.COMFYUI_MCP_PAIR_UPDATE_PREFS;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cmcp-pairupd-"));
  file = join(dir, "pair-update-prefs.json");
  process.env.COMFYUI_MCP_PAIR_UPDATE_PREFS = file;
});

afterEach(() => {
  if (OLD === undefined) delete process.env.COMFYUI_MCP_PAIR_UPDATE_PREFS;
  else process.env.COMFYUI_MCP_PAIR_UPDATE_PREFS = OLD;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe("pair-update prefs default ON (#1963)", () => {
  it("a missing file is defer-while-paired ON — applying would disconnect the phone", () => {
    expect(existsSync(file)).toBe(false);
    expect(loadPairUpdatePrefs()).toEqual({ deferWhilePaired: true });
    expect(pairUpdatePrefsPath()).toBe(file);
  });

  it("persists an explicit OFF and reads it back", () => {
    const saved = savePairUpdatePrefs({ deferWhilePaired: false });
    expect(saved.deferWhilePaired).toBe(false);
    expect(loadPairUpdatePrefs().deferWhilePaired).toBe(false);
    expect(JSON.parse(readFileSync(file, "utf-8")).deferWhilePaired).toBe(false);
  });

  it("an unreadable file fails CLOSED to ON, never opens the gate", () => {
    writeFileSync(file, "not-json");
    expect(loadPairUpdatePrefs().deferWhilePaired).toBe(true);
  });

  it("a non-boolean value fails CLOSED to ON — the string \"false\" must not apply", () => {
    writeFileSync(file, JSON.stringify({ deferWhilePaired: "false" }));
    expect(loadPairUpdatePrefs().deferWhilePaired).toBe(true);
  });
});
