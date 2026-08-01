import type { ToolMode } from "../transport/cli.js";

/**
 * The comfyui tool-server TOOL MODE to spawn for the NON-Claude HTTP backends
 * (Codex / Gemini / Grok / Copilot / …), which reach panel_* over the loopback
 * HTTP MCP.
 *
 * #291: the headless comfyui MCP exposes ~250 tools. A Codex session adds those
 * on top of its OWN large built-in + user-configured tool surface, and once the
 * total tool budget is saturated codex SILENTLY DROPS the panel HTTP-MCP server's
 * tools — so the live-canvas `panel_*` graph tools became invisible to a Codex
 * session even though the HTTP MCP was wired correctly. (Verified live: with the
 * comfyui surface trimmed, `panel_*` reappears and is callable; with it full,
 * `panel_*` is dropped.)
 *
 * So default these backends' comfyui server to COMPACT mode — the 3 meta-tools
 * (list_tools / describe_tool / call_tool, issue #97) — instead of the full
 * ~250-schema surface. That leaves ample tool budget for `panel_*` while keeping
 * every comfyui tool reachable via `call_tool`. Claude is unaffected: it hosts
 * panel_* via an in-process SDK server, not this HTTP path.
 *
 * An explicit `COMFYUI_MCP_TOOL_MODE=full` in the orchestrator env opts back into
 * the full surface (accepting the panel_* crowd-out) for a user who wants it.
 */
export function resolveHttpLaneComfyToolMode(
  env: NodeJS.ProcessEnv = process.env,
): ToolMode {
  return env.COMFYUI_MCP_TOOL_MODE === "full" ? "full" : "compact";
}
