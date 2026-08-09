// panel#851 — placeholder pinning the CURRENT wording; the fix follows.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const src = readFileSync("src/orchestrator/panel-tools.ts", "utf8");

describe("#851 restart confirmation timeout", () => {
  it("today: recommends restart_comfyui unconditionally, with no target check", () => {
    const branch = src.slice(
      src.indexOf('No confirmation received within'),
      src.indexOf('No confirmation received within') + 600,
    );
    expect(branch).toContain("use restart_comfyui to restart the server directly");
    // Nothing compares the panel's ComfyUI against the headless target here.
    expect(branch).not.toContain("captureRebootHealthBase");
  });
});
