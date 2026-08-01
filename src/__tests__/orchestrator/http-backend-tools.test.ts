// #291: the non-Claude HTTP backends (Codex/Gemini/Grok/…) reach panel_* over a
// loopback HTTP MCP. The full ~250-tool comfyui surface saturates codex's tool
// budget and makes it SILENTLY DROP the panel_* tools, so the live-canvas graph
// tools vanished for a Codex session. resolveHttpLaneComfyToolMode defaults these
// backends' comfyui server to COMPACT (3 meta-tools) so panel_* survives, while
// an explicit COMFYUI_MCP_TOOL_MODE=full opts back into the full surface.

import { describe, expect, it } from "vitest";
import { resolveHttpLaneComfyToolMode } from "../../orchestrator/http-backend-tools.js";

describe("resolveHttpLaneComfyToolMode (#291)", () => {
  it("defaults to compact so comfyui never crowds panel_* out of codex", () => {
    expect(resolveHttpLaneComfyToolMode({})).toBe("compact");
  });

  it("stays compact when the env var is unset/unrelated", () => {
    expect(resolveHttpLaneComfyToolMode({ SOMETHING: "else" })).toBe("compact");
    expect(resolveHttpLaneComfyToolMode({ COMFYUI_MCP_TOOL_MODE: "" })).toBe("compact");
    expect(resolveHttpLaneComfyToolMode({ COMFYUI_MCP_TOOL_MODE: "compact" })).toBe("compact");
  });

  it("honors an explicit COMFYUI_MCP_TOOL_MODE=full override", () => {
    expect(resolveHttpLaneComfyToolMode({ COMFYUI_MCP_TOOL_MODE: "full" })).toBe("full");
  });

  it("treats any non-'full' value as compact (fail safe toward exposing panel_*)", () => {
    expect(resolveHttpLaneComfyToolMode({ COMFYUI_MCP_TOOL_MODE: "FULL" })).toBe("compact");
    expect(resolveHttpLaneComfyToolMode({ COMFYUI_MCP_TOOL_MODE: "verbose" })).toBe("compact");
  });
});
