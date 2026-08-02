// Port → owning PID lookup.
//
// Extracted from process-control so the live-interpreter resolver can use it
// WITHOUT importing process-control (which imports workspace-env, which consumes
// the resolver — that would be an import cycle). This module is a LEAF: node
// builtins only. process-control re-exports parseListenerPidFromNetstat so its
// existing tests keep importing it from there.

import { execSync } from "node:child_process";
import { platform } from "node:os";

const IS_WIN = platform() === "win32";

/**
 * Extract the PID that is LISTENING on `port` from `netstat -ano` output.
 *
 * We anchor on the local-address `:PORT` suffix rather than grepping the state
 * word ("LISTENING"), which is TRANSLATED on non-English Windows (German
 * "ABHÖREN", French "À L'ÉCOUTE", …). The old `findstr LISTENING` filter dropped
 * every line on those systems, so a perfectly reachable ComfyUI looked like "no
 * process on port". Anchoring on the local column also correctly IGNORES an
 * outbound/established connection whose REMOTE peer happens to use `:PORT`.
 *
 * Exported for tests: this pure function is where the bug lived.
 */
/** Loopback spellings that all denote "this machine". */
const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
/** Bind addresses that accept connections for EVERY local address. */
const WILDCARD = new Set(["0.0.0.0", "::", "*", ""]);

/** Split "127.0.0.1:8188" / "[::1]:8188" / "*:8188" into address + port. */
function splitEndpoint(endpoint: string): { address: string; port: string } {
  const idx = endpoint.lastIndexOf(":");
  if (idx < 0) return { address: endpoint, port: "" };
  const address = endpoint.slice(0, idx).replace(/^\[|\]$/g, "");
  return { address, port: endpoint.slice(idx + 1) };
}

/**
 * Does a listener bound to `address` serve the host we are actually talking to?
 *
 * A wildcard bind serves every local address, so it always matches. Otherwise the
 * addresses must agree, with the loopback spellings treated as equivalent. Binding
 * the lookup to the HOST — not just the port number — keeps two instances on
 * different loopback addresses from being confused for one another (#401 round 4).
 */
export function addressServesHost(address: string, wantHost?: string): boolean {
  const a = address.toLowerCase();
  if (WILDCARD.has(a)) return true;
  if (!wantHost) return true;
  const w = wantHost.toLowerCase().replace(/^\[|\]$/g, "");
  if (a === w) return true;
  return LOOPBACK.has(a) && LOOPBACK.has(w);
}

export function parseListenerPidFromNetstat(
  output: string,
  port: number,
  host?: string,
): number | null {
  const suffix = `:${port}`;
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    // Expected columns: PROTO LOCAL FOREIGN STATE PID
    if (parts.length < 5) continue;
    if (parts[0].toUpperCase() !== "TCP") continue;
    const local = parts[1];
    const foreign = parts[2];
    // The leading colon anchors the match: "…:8188" matches but "…:81880" and
    // "…:18188" do not (their last chars aren't ":8188").
    if (!local.endsWith(suffix)) continue;
    // Require a LISTENING row without depending on the localized state word: a
    // listener's foreign endpoint is always the wildcard port 0 (0.0.0.0:0 /
    // [::]:0). This rejects an ESTABLISHED connection that merely bound its
    // local side to :PORT — killing that would take down the wrong process
    // (or none) when ComfyUI is actually down.
    if (!foreign.endsWith(":0")) continue;
    if (!addressServesHost(splitEndpoint(local).address, host)) continue;
    const pid = parseInt(parts[parts.length - 1], 10);
    if (!Number.isNaN(pid) && pid > 0) return pid;
  }
  return null;
}

/**
 * Parse `lsof -nP -iTCP:PORT -sTCP:LISTEN -Fpn` field output. Records look like
 *   p1234
 *   n127.0.0.1:8188
 * so we can bind the match to the ADDRESS as well as the port, which the plain
 * `-t` (terse) output cannot express.
 */
export function parseListenerPidFromLsof(
  output: string,
  port: number,
  host?: string,
): number | null {
  let pid: number | null = null;
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("p")) {
      const parsed = parseInt(line.slice(1), 10);
      pid = !Number.isNaN(parsed) && parsed > 0 ? parsed : null;
      continue;
    }
    if (line.startsWith("n") && pid !== null) {
      const endpoint = line.slice(1);
      // Ignore a peer-qualified name ("a->b"); listeners have no peer.
      if (endpoint.includes("->")) continue;
      const { address, port: p } = splitEndpoint(endpoint);
      if (p !== String(port)) continue;
      if (!addressServesHost(address, host)) continue;
      return pid;
    }
  }
  return null;
}

export function findPidByPort(port: number, host?: string): number | null {
  if (IS_WIN) {
    // Parse `netstat -ano` ourselves instead of piping through
    // `findstr LISTENING` — that state word is localized and made detection fail
    // on non-English Windows even when ComfyUI was reachable (issue #449).
    try {
      const out = execSync(`netstat -ano -p TCP`, {
        encoding: "utf-8",
        timeout: 5000,
      });
      const pid = parseListenerPidFromNetstat(out, port, host);
      if (pid) return pid;
    } catch {
      // netstat unavailable / failed — fall through to the PowerShell probe.
    }
    // Fallback: Get-NetTCPConnection maps port→owning PID structurally, with no
    // dependence on console locale or column layout. Belt-and-suspenders for the
    // portable/embedded-Python launch shape reported in #449. LocalAddress is
    // selected too so the host filter still applies.
    try {
      const out = execSync(
        `powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | ForEach-Object { \\"$($_.LocalAddress) $($_.OwningProcess)\\" }"`,
        { encoding: "utf-8", timeout: 8000 },
      );
      for (const raw of out.split(/\r?\n/)) {
        const [addr, pidText] = raw.trim().split(/\s+/);
        if (!addr || !pidText) continue;
        if (!addressServesHost(addr.replace(/^\[|\]$/g, ""), host)) continue;
        const pid = parseInt(pidText, 10);
        if (!Number.isNaN(pid) && pid > 0) return pid;
      }
    } catch {
      // PowerShell unavailable / nothing listening.
    }
    return null;
  }

  try {
    // LISTENER-ONLY, TCP only, and bound to the ADDRESS we actually talk to. A bare
    // `lsof -ti :PORT` also matches processes merely CONNECTED to that port (and
    // UDP), so it can return a client — a browser, or our own fetch — instead of the
    // ComfyUI server. That PID is used to kill the server AND (since #401) to read
    // the interpreter it runs, so a client must never be mistaken for it. `-Fpn`
    // field output carries the bind address, which terse `-t` cannot express.
    const out = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -Fpn`, {
      encoding: "utf-8",
      timeout: 5000,
    });
    const pid = parseListenerPidFromLsof(out, port, host);
    if (pid) return pid;
  } catch {
    // Command failed — no process listening on that port
  }
  return null;
}
