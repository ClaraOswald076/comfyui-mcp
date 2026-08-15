// #1524 — read the harness's OWN report of which MCP servers a session came up
// with, instead of discarding it.
//
// The reported failure: mid-session both MCP servers dropped; the `comfyui` half
// came back and all 92 `panel_*` tools did not. The orchestrator kept running and
// kept its ports, the panel looked healthy, and the agent spent the rest of a
// six-hour session unable to touch the user's canvas. Nothing anywhere said so —
// the reporter established it by hand, by noticing a tool-list diff and then
// probing with `ToolSearch`.
//
// It did not have to be established by hand. Every Claude session opens with a
// `system`/`init` message carrying `mcp_servers: {name, status}[]`, which is the
// CLI's authoritative per-session statement of what actually connected. Verified
// against the installed harness (agent SDK 0.3.197) with one server of each kind
// configured:
//
//   [{"name":"deadstdio","status":"failed"},{"name":"panel","status":"connected"}]
//
// — so it covers BOTH transports the panel uses: the in-process `createSdkMcpServer`
// panel server (Claude lane) and the stdio `comfyui` child. `route()` already reads
// that message for the session id and throws the rest away.
//
// This module is only the comparison. It says what was observed and nothing more:
// it does not diagnose WHY a server is missing (still unknown for #1524, and the
// two candidate causes need different fixes), and it does not promise a restart
// would help.

/** One entry of the `system`/`init` `mcp_servers` report. */
export interface ReportedMcpServer {
  name: string;
  status: string;
}

/** A configured server the session did not come up with. */
export interface DegradedMcpServer {
  name: string;
  /** The reported status, or `null` when the server was absent from the report. */
  status: string | null;
}

/** What a report says about the servers we configured. */
export interface McpSessionHealth {
  /** Configured servers the session does not have. */
  degraded: DegradedMcpServer[];
  /**
   * Configured servers still CONNECTING when this report was taken.
   *
   * `pending` is a settled-later status, not a failure: the SDK's server startup
   * does not block the session, so a slow server is legitimately pending in the
   * `init` report and connects a moment afterwards. Calling that degraded would
   * fire on healthy sessions, which is the one outcome worse than the silence
   * this replaces.
   *
   * But it must not be read as "fine" either — a server pending at init can go
   * on to FAIL, and since `init` is the only report the session pushes, nothing
   * would ever say so. The caller re-reads these names later (the SDK's
   * `mcpServerStatus()` poll) and reports whatever they settled as.
   */
  pending: string[];
}

/**
 * Compare the MCP servers we handed the session against the ones it reports.
 *
 * `configured` is the set of names passed as `Options.mcpServers`. Because the
 * panel always sets `strictMcpConfig: true`, the session's server set is exactly
 * ours — no user/project config can appear in the report and no name of ours can
 * be legitimately replaced.
 *
 * Splits the configured servers into the ones the session does not have
 * (`degraded`) and the ones still connecting (`pending`), in the order they were
 * configured. Both empty means every server we asked for is up — which is the
 * case this has to get right first, since a false "your tools are gone" is worse
 * than the silence it replaces.
 *
 * Two deliberate silences:
 *
 *  - An ABSENT or empty report yields nothing. A harness that does not populate
 *    the field at all (or has not yet) tells us nothing about our servers, and
 *    reading its silence as failure would fire on every healthy session.
 *  - Any status that is not recognizably a failure is treated as fine. The set of
 *    statuses is the CLI's to grow; a new one must not become an alarm here.
 *
 * Absence from a NON-EMPTY report does count: the report is populated, the config
 * is strict, so a name of ours missing from it is a server the session does not
 * have. That case matters — a server whose connection fails before it is
 * advertised is missing rather than failed.
 */
export function inspectMcpServers(
  configured: readonly string[],
  reported: readonly ReportedMcpServer[] | undefined,
): McpSessionHealth {
  if (!Array.isArray(reported) || reported.length === 0) return { degraded: [], pending: [] };
  const byName = new Map<string, string>();
  for (const entry of reported) {
    if (entry && typeof entry.name === "string") byName.set(entry.name, String(entry.status ?? ""));
  }
  const degraded: DegradedMcpServer[] = [];
  const pending: string[] = [];
  for (const name of configured) {
    if (!byName.has(name)) {
      degraded.push({ name, status: null });
      continue;
    }
    const status = (byName.get(name) ?? "").trim().toLowerCase();
    if (status === "pending") pending.push(name);
    else if (FAILED_STATUSES.has(status)) degraded.push({ name, status: byName.get(name) ?? "" });
  }
  return { degraded, pending };
}

/**
 * Statuses that mean the server is not usable. Taken from the SDK's own
 * `McpServerStatus` union (`connected | failed | needs-auth | pending |
 * disabled`), plus `error` for a host that words it that way.
 *
 * A closed list, deliberately: anything the CLI adds later reads as connected
 * rather than as an alarm, so a vocabulary change cannot start telling healthy
 * sessions their tools are gone.
 */
const FAILED_STATUSES = new Set(["failed", "needs-auth", "disabled", "error"]);

/**
 * The line the user sees when a session starts without a server it was given.
 *
 * Scoped the way `NO_PANEL_TOOLS_OVERRIDE` is scoped: it states the observation
 * and its one consequence, and then stops. It does not say why (unknown), does
 * not say a restart fixes it (a cause that persists survives a restart), and does
 * not vouch for the servers that DID come up — the reader can see those in the
 * same sentence.
 */
export function degradedMcpNotice(degraded: readonly DegradedMcpServer[]): string {
  if (degraded.length === 0) return "";
  const named = degraded
    .map((d) => (d.status === null ? `\`${d.name}\` (not reported)` : `\`${d.name}\` (${d.status})`))
    .join(", ");
  const plural = degraded.length > 1 ? "servers" : "server";
  const theirTools = degraded.length > 1 ? "Their tools are" : "Its tools are";
  return (
    `This session started without ${degraded.length} of its MCP ${plural}: ${named}. ` +
    `${theirTools} not available to the agent for the rest of this session, ` +
    `so anything that needs them will fail or be worked around silently. ` +
    `Starting a new session (Disconnect → Connect) is what re-runs the connection; ` +
    `whether it succeeds depends on why this one did not, which this message does not know.`
  );
}
