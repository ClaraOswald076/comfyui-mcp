// #1512 — COMFYUI_PATH was consumed exactly as given, so ONE trailing space made
// every install-root check miss and the connected ComfyUI was reported as
// undeterminable — 40 minutes after the bad value took effect, at the first write,
// with a message that echoed the path back but never pointed at the space.
//
// The value is trivially easy to produce. cmd.exe assigns everything up to the
// `&&`, INCLUDING the space before it:
//
//     cmd /k "set COMFYUI_PATH=E:\...\ComfyUI && comfyui-mcp connect ..."
//
// so the launcher line people actually paste bakes one in. The panel pack already
// stripped it (`__init__.py`); the orchestrator did not — the two halves of one
// product disagreeing is the defect.
//
// THE TRAP THIS FILE GUARDS. `COMFYUI_PATH` has TWO ingestion points, and the
// patch proposed on the issue covers only the first:
//
//   1. `resolveComfyUIPath` in config.ts (boot + retarget)
//   2. a DIRECT `process.env.COMFYUI_PATH` read in orchestrator/index.ts, whose
//      result is handed to the spawn env builders and resolveComfyuiPathForTarget
//
// Fixing only (1) leaves a trailing space reaching every agent the orchestrator
// starts. (2) sits inside a large startup function that a unit test cannot reach,
// so it is asserted against the SOURCE — the rule being that no raw read of that
// variable may survive un-normalized.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  normalizeInstallPathEnv,
  warnIfInstallPathWasMalformed,
  __resetMalformedPathWarnings,
} from "../config.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..");

beforeEach(() => {
  __resetMalformedPathWarnings();
});

describe("normalizeInstallPathEnv (#1512)", () => {
  it("strips the trailing space cmd.exe bakes into `set VAR=v && cmd`", () => {
    const out = normalizeInstallPathEnv("E:\\Ai_server\\ComfyUI_windows_portable\\ComfyUI ");
    expect(out.path).toBe("E:\\Ai_server\\ComfyUI_windows_portable\\ComfyUI");
    expect(out.changed).toBe(true);
  });

  it("strips a MATCHED surrounding quote pair, the other paste artifact", () => {
    expect(normalizeInstallPathEnv('"C:\\ComfyUI"').path).toBe("C:\\ComfyUI");
    expect(normalizeInstallPathEnv("'C:\\ComfyUI'").path).toBe("C:\\ComfyUI");
    // Quote OUTSIDE the space and space INSIDE the quote both normalize.
    expect(normalizeInstallPathEnv('  "C:\\ComfyUI "  ').path).toBe("C:\\ComfyUI");
  });

  it("leaves a LONE trailing quote alone", () => {
    // `"` is illegal in a Windows filename but LEGAL on POSIX. Stripping one
    // unconditionally would corrupt a real path in order to fix a typo — the
    // repair must not be able to do more damage than the bug.
    expect(normalizeInstallPathEnv('/srv/weird"').path).toBe('/srv/weird"');
    expect(normalizeInstallPathEnv('/srv/weird"').changed).toBe(false);
    expect(normalizeInstallPathEnv("'/srv/half").path).toBe("'/srv/half");
  });

  it("treats a whitespace-only value as UNSET so detection still runs", () => {
    // Adopting "   " as a path would be worse than the bug: it defeats
    // auto-detection AND cannot work. Both call sites truthy-check the result.
    expect(normalizeInstallPathEnv("   ").path).toBeUndefined();
    expect(normalizeInstallPathEnv('" "').path).toBeUndefined();
    expect(normalizeInstallPathEnv("").path).toBeUndefined();
    expect(normalizeInstallPathEnv(undefined).path).toBeUndefined();
  });

  it("reports changed:false for an already-clean value", () => {
    const out = normalizeInstallPathEnv("/opt/ComfyUI");
    expect(out.path).toBe("/opt/ComfyUI");
    expect(out.changed).toBe(false);
  });
});

describe("the malformed value is REPORTED, not silently repaired (#1512)", () => {
  let errs: string[];
  let spy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errs = [];
    spy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      errs.push(a.join(" "));
    });
  });
  afterEach(() => spy.mockRestore());

  it("names the variable, both values, and the launcher line that produced it", () => {
    warnIfInstallPathWasMalformed("C:\\ComfyUI ", "C:\\ComfyUI");
    const msg = errs.join("\n");

    expect(msg).toMatch(/COMFYUI_PATH/);
    // JSON-quoted so the offending space is VISIBLE — the original error echoed
    // the path bare, which is precisely why the space went unnoticed.
    expect(msg).toMatch(/"C:\\\\ComfyUI "/);
    expect(msg).toMatch(/&&/);
    expect(msg).toMatch(/fix the launcher line/i);
  });

  it("warns ONCE per distinct value — retarget re-resolves on every switch", () => {
    warnIfInstallPathWasMalformed("C:\\ComfyUI ", "C:\\ComfyUI");
    warnIfInstallPathWasMalformed("C:\\ComfyUI ", "C:\\ComfyUI");
    warnIfInstallPathWasMalformed("D:\\Other ", "D:\\Other");
    expect(errs.length).toBe(2);
  });

  it("says nothing when the value was already clean", () => {
    warnIfInstallPathWasMalformed("/opt/ComfyUI", "/opt/ComfyUI");
    expect(errs).toHaveLength(0);
  });
});

/** Rebuild the config module against a specific COMFYUI_PATH. `config` is a
 *  module-level const evaluated at import time, so the env must be set BEFORE
 *  the import — which is exactly how the real process sees it. */
async function comfyuiPathFor(raw: string | undefined): Promise<string | undefined> {
  const prev = process.env.COMFYUI_PATH;
  const prevUrl = process.env.COMFYUI_URL;
  vi.resetModules();
  if (raw === undefined) delete process.env.COMFYUI_PATH;
  else process.env.COMFYUI_PATH = raw;
  // Keep detection out of it: an unset URL is fine, but a stray remote URL from
  // another test would send resolveComfyUIPath down its remote branch.
  delete process.env.COMFYUI_URL;
  try {
    const mod = (await import("../config.js")) as { config: { comfyuiPath?: string } };
    return mod.config.comfyuiPath;
  } finally {
    if (prev === undefined) delete process.env.COMFYUI_PATH;
    else process.env.COMFYUI_PATH = prev;
    if (prevUrl === undefined) delete process.env.COMFYUI_URL;
    else process.env.COMFYUI_URL = prevUrl;
    vi.resetModules();
  }
}

describe("the WIRING — a real config build normalizes the env (#1512)", () => {
  it("the reporter's exact value no longer reaches config.comfyuiPath", async () => {
    // Not the helper in isolation: this is the module-level `config` the whole
    // server reads, built from process.env the way the real process builds it.
    const dirty = "E:\\Ai_server\\ComfyUI_windows_portable\\ComfyUI ";
    expect(await comfyuiPathFor(dirty)).toBe("E:\\Ai_server\\ComfyUI_windows_portable\\ComfyUI");
  });

  it("a quoted value is unwrapped", async () => {
    expect(await comfyuiPathFor('"C:\\ComfyUI"')).toBe("C:\\ComfyUI");
  });
});

describe("the SECOND ingestion point stays normalized (#1512)", () => {
  // orchestrator/index.ts reads process.env.COMFYUI_PATH directly, inside a
  // startup function no unit test can reach. What it produces is handed to the
  // spawn env builders, so an un-normalized read there propagates the bad value
  // to every agent the orchestrator starts. Asserted against the source, because
  // the alternative is asserting nothing.
  it("every raw read of COMFYUI_PATH in orchestrator/index.ts is normalized", () => {
    const src = readFileSync(join(SRC, "orchestrator", "index.ts"), "utf8");
    const lines = src.split(/\r?\n/);

    const rawReads: number[] = [];
    lines.forEach((line, i) => {
      // Skip comments and the tool-description prose, which mention the variable
      // by name without reading it.
      const code = line.replace(/\/\/.*$/, "");
      if (/process\.env\.COMFYUI_PATH/.test(code)) rawReads.push(i);
    });

    // The premise: if this hits zero the rule is vacuous and the test is a
    // rubber stamp, so fail loudly instead.
    expect(rawReads.length).toBeGreaterThan(0);

    for (const i of rawReads) {
      const window = lines.slice(i, i + 3).join("\n");
      expect(
        /normalizeInstallPathEnv\(/.test(window),
        `orchestrator/index.ts:${i + 1} reads process.env.COMFYUI_PATH without ` +
          `normalizeInstallPathEnv() within 3 lines. A trailing space there is passed ` +
          `on to every spawned agent (#1512).`,
      ).toBe(true);
    }
  });
});
