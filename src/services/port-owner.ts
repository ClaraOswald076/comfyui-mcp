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
export function parseListenerPidFromNetstat(
  output: string,
  port: number,
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
    const pid = parseInt(parts[parts.length - 1], 10);
    if (!Number.isNaN(pid) && pid > 0) return pid;
  }
  return null;
}

export function findPidByPort(port: number): number | null {
  if (IS_WIN) {
    // Parse `netstat -ano` ourselves instead of piping through
    // `findstr LISTENING` — that state word is localized and made detection fail
    // on non-English Windows even when ComfyUI was reachable (issue #449).
    try {
      const out = execSync(`netstat -ano -p TCP`, {
        encoding: "utf-8",
        timeout: 5000,
      });
      const pid = parseListenerPidFromNetstat(out, port);
      if (pid) return pid;
    } catch {
      // netstat unavailable / failed — fall through to the PowerShell probe.
    }
    // Fallback: Get-NetTCPConnection maps port→owning PID structurally, with no
    // dependence on console locale or column layout. Belt-and-suspenders for the
    // portable/embedded-Python launch shape reported in #449.
    try {
      const out = execSync(
        `powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess"`,
        { encoding: "utf-8", timeout: 8000 },
      ).trim();
      const pid = parseInt(out, 10);
      if (!Number.isNaN(pid) && pid > 0) return pid;
    } catch {
      // PowerShell unavailable / nothing listening.
    }
    return null;
  }

  try {
    // LISTENER-ONLY, and TCP only. A bare `lsof -ti :PORT` also matches processes
    // merely CONNECTED to that port (and UDP), so it can return a client — e.g. a
    // browser or our own fetch — instead of the ComfyUI server. That PID is used to
    // kill the server AND (since #401) to read the interpreter the server runs, so a
    // client's argv[0] must never be mistaken for it. Mirrors the Windows branch,
    // which already required a listening row (foreign endpoint :0).
    const out = execSync(`lsof -tiTCP:${port} -sTCP:LISTEN`, {
      encoding: "utf-8",
      timeout: 5000,
    }).trim();
    const pid = parseInt(out.split("\n")[0], 10);
    if (!isNaN(pid) && pid > 0) return pid;
  } catch {
    // Command failed — no process listening on that port
  }
  return null;
}
