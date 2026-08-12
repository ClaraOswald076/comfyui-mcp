// #1471 — "restart to pick it up" named a restart that does not pick it up.
//
// An npx-mode update check reported {mode:"npx", from:0.51.15, to:0.51.16,
// note:"npx fetches the latest on next run; restart to pick it up"}. The user did
// exactly that — the panel's /restart — confirmed it, and the status check still read
// 0.51.15 from the same _npx package dir.
//
// The note is right about npx and wrong about WHICH restart. The panel's restart
// controls do not restart the long-lived orchestrator process, which is the one
// running this code and keeps the build it started with — a fact panel_reload's own
// description already states. The note said "restart" and let the reader supply the
// wrong one.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { npxUpdateNote } from "../../services/npx-restart-scope.js";

const HERE = dirname(fileURLToPath(import.meta.url));

describe("#1471 the note names the restart that works", () => {
  const note = npxUpdateNote("0.51.16");

  it("still says what npx does, and when", () => {
    expect(note).toMatch(/0\.51\.16 available/);
    expect(note).toMatch(/NEXT LAUNCH/);
  });

  it("names the restarts that do NOT apply it", () => {
    // The reporter reached for /restart precisely because nothing said it was the
    // wrong lever. Naming only the correct one still leaves them to discover that
    // the obvious button did nothing.
    expect(note).toMatch(/\/restart/);
    expect(note).toMatch(/panel_reload/);
    expect(note).toMatch(/do NOT/);
  });

  it("says WHY, so it reads as a cause rather than a rule", () => {
    expect(note).toMatch(/long-lived orchestrator process/);
    expect(note).toMatch(/keeps the build it[\s\S]*started with/);
  });

  it("gives the action that does work", () => {
    expect(note).toMatch(/Stop that process and start it again/);
    expect(note).toMatch(/npx -y comfyui-mcp/);
  });

  it("names the check that CONFIRMS it, and what proves nothing", () => {
    // The reporter's own method: the reported currentVersion is the only evidence.
    expect(note).toMatch(/self_update_action:"status"/);
    expect(note).toMatch(/Until the reported currentVersion changes/);
    expect(note).toMatch(/whatever any restart appeared to do/);
  });

  it("no longer promises that a bare restart suffices", () => {
    expect(note).not.toMatch(/restart to pick it up/);
  });
});

describe("#1471 WIRING: both npx branches use it", () => {
  const src = readFileSync(join(HERE, "../../services/self-update.ts"), "utf8");

  it("the old sentence is gone from self-update", () => {
    expect(src).not.toMatch(/npx fetches the latest on next run; restart to pick it up/);
  });

  it("both npx-mode notes call the shared builder", () => {
    // There are two: the status path and the notify path the reporter hit. Fixing one
    // and leaving the other is how half a message survives a rename.
    expect(src).toMatch(/import \{ npxUpdateNote \} from "\.\/npx-restart-scope\.js";/);
    expect((src.match(/npxUpdateNote\(latest\)/g) ?? []).length).toBe(2);
  });
});
