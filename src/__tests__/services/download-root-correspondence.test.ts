// #1371 — a model was written into a DIFFERENT local ComfyUI installation than the one
// serving the session.
//
// The reporter was connected to ComfyUI on :8190 (…\ComfyUI_H3), and download_model
// streamed into …\ComfyUI\models — a stale COMFYUI_PATH from another install — while
// visibility was checked against the connected server.
//
// The existing divergence guard has shipped since v0.49.4 and the reporter was on
// 0.50.107, so it was present and did not fire: it proves divergence from CONTENT
// (files on disk the server does not list), and an empty destination category proves
// nothing. This adds POSITIVE evidence instead — the server naming its own root.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  divergentInstallRefusal,
  isWithinRoot,
} from "../../services/download-root-correspondence.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = "G:/Start_AI/AI_Test/ComfyUI_H3";
const STALE_DEST = "G:/Start_AI/AI_Test/ComfyUI/models/vae";
const GOOD_DEST = "G:/Start_AI/AI_Test/ComfyUI_H3/models/vae";

describe("#1371 the reporter's case now refuses", () => {
  it("refuses a destination outside the root the server names for itself", () => {
    const msg = divergentInstallRefusal({
      targetDir: STALE_DEST,
      serverRoot: SERVER_ROOT,
      serverUrl: "http://127.0.0.1:8190",
    });
    expect(msg).toBeTruthy();
    expect(msg).toMatch(/NOT downloaded/);
    expect(msg).toContain(STALE_DEST);
    expect(msg).toContain(SERVER_ROOT);
    expect(msg).toMatch(/127\.0\.0\.1:8190/);
  });

  it("says nothing was written, and names COMFYUI_PATH as the usual cause", () => {
    const msg = divergentInstallRefusal({
      targetDir: STALE_DEST,
      serverRoot: SERVER_ROOT,
    })!;
    expect(msg).toMatch(/Nothing was written/);
    expect(msg).toMatch(/COMFYUI_PATH/);
    expect(msg).toMatch(/left over from a different installation/);
  });

  it("gives both ways forward without pretending either is automatic", () => {
    const msg = divergentInstallRefusal({
      targetDir: STALE_DEST,
      serverRoot: SERVER_ROOT,
    })!;
    expect(msg).toMatch(/Point COMFYUI_PATH at the ComfyUI that\s+is actually running/);
    expect(msg).toMatch(/--base-directory/);
    // And the case where the user genuinely meant another install.
    expect(msg).toMatch(/If you MEANT to place/);
  });
});

describe("#1371 it refuses ONLY on positive proof", () => {
  it("proceeds when the destination is inside the server's own root", () => {
    expect(
      divergentInstallRefusal({ targetDir: GOOD_DEST, serverRoot: SERVER_ROOT }),
    ).toBeNull();
  });

  it("proceeds when the server did not name a root", () => {
    // Absence of evidence. The content-based guard's own note records that every
    // tightening of that inference produced another FALSE REFUSAL.
    for (const serverRoot of [undefined, ""]) {
      expect(divergentInstallRefusal({ targetDir: STALE_DEST, serverRoot })).toBeNull();
    }
  });

  it("proceeds when the destination came from the LIVE server", () => {
    // Then the destination and the root have the same origin and cannot disagree;
    // firing here would refuse a destination the server itself supplied.
    expect(
      divergentInstallRefusal({
        targetDir: STALE_DEST,
        serverRoot: SERVER_ROOT,
        liveAuthoritative: true,
      }),
    ).toBeNull();
  });

  it("proceeds when there is no destination to judge", () => {
    expect(divergentInstallRefusal({ targetDir: "", serverRoot: SERVER_ROOT })).toBeNull();
  });
});

describe("#1371 isWithinRoot", () => {
  it("accepts the root itself and anything beneath it", () => {
    expect(isWithinRoot(SERVER_ROOT, SERVER_ROOT)).toBe(true);
    expect(isWithinRoot(`${SERVER_ROOT}/models/vae`, SERVER_ROOT)).toBe(true);
    expect(isWithinRoot(`${SERVER_ROOT}/`, SERVER_ROOT)).toBe(true);
  });

  it("is not fooled by a SIBLING whose name shares a prefix", () => {
    // The exact shape of this bug: ComfyUI vs ComfyUI_H3. A naive startsWith says the
    // stale tree is inside the live one, or vice versa, and the refusal never fires.
    expect(isWithinRoot("G:/Start_AI/AI_Test/ComfyUI_H3x/models", SERVER_ROOT)).toBe(false);
    expect(isWithinRoot("G:/Start_AI/AI_Test/ComfyUI/models", SERVER_ROOT)).toBe(false);
    expect(isWithinRoot(SERVER_ROOT, "G:/Start_AI/AI_Test/ComfyUI")).toBe(false);
  });

  it("treats Windows paths case-insensitively", () => {
    // The same install is routinely spelled with a different drive-letter case.
    if (process.platform === "win32") {
      expect(isWithinRoot("g:/start_ai/AI_Test/ComfyUI_H3/models", SERVER_ROOT)).toBe(true);
    }
  });

  it("never claims containment for empty input", () => {
    expect(isWithinRoot("", SERVER_ROOT)).toBe(false);
    expect(isWithinRoot(STALE_DEST, "")).toBe(false);
  });
});

describe("#1371 WIRING", () => {
  const src = readFileSync(join(HERE, "../../services/model-resolver.ts"), "utf8");

  it("resolveDownloadTarget consults it", () => {
    expect(src).toMatch(
      /import \{ divergentInstallRefusal \} from "\.\/download-root-correspondence\.js";/,
    );
    expect(src).toMatch(/divergentInstallRefusal\(\{/);
    expect(src).toMatch(/if \(refusal\) throw new ModelError\(refusal/);
  });

  it("only runs when the destination did NOT come from the live server", () => {
    // Otherwise it would second-guess a root the server itself supplied.
    const at = src.indexOf("if (!liveRootAtResolve) {");
    expect(at).toBeGreaterThan(-1);
    const block = src.slice(at, at + 500);
    expect(block).toMatch(/divergentInstallRefusal/);
  });

  it("derives the root from ARGV ONLY, never a live host probe", () => {
    // The shared root resolver falls back to probing the live process table, and the
    // repo gates against new code reaching it (#1290/#1263) because it makes a test
    // assert one thing where ComfyUI is running and another where it is not. That gate
    // caught this exact mistake — and then caught this TEST, because it scans test text
    // for the entry-point NAME and my comment mentioned it. Hence the periphrasis.
    expect(src).toMatch(/liveRootFromArgv\(argv, cwd\)/);
    const at = src.indexOf("async function serverInstallRootOrUndefined");
    const block = src.slice(at, at + 1400);
    expect(block).toMatch(/ARGV ONLY/);
  });

  it("a failure to read the server root never fails the download", () => {
    const at = src.indexOf("async function serverInstallRootOrUndefined");
    expect(at).toBeGreaterThan(-1);
    const block = src.slice(at, at + 2000);
    // Plain containment: a regex spanning a line break is how these keep getting
    // written wrong.
    expect(block.includes("catch")).toBe(true);
    expect(block.includes("return undefined;")).toBe(true);
  });
});
