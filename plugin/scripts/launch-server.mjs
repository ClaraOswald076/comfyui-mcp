#!/usr/bin/env node
/**
 * #1447 — plugin MCP server launcher.
 *
 * The plugin's .mcp.json used to be `npx -y comfyui-mcp --full` directly. On a
 * cold npx cache that downloads the whole ~818 MB dependency tree INSIDE the
 * client's MCP handshake timeout; the client kills the attempt, nothing is
 * persisted, and every retry pays the full cost again (the measured `_npx`
 * cache timestamped to a manual run, never to a client attempt).
 *
 * This wrapper has two halves.
 *
 * 1. THE WARM PATH. When `comfyui-mcp` is installed globally
 *    (`npm install -g comfyui-mcp`), it resolves `<npm root -g>/comfyui-mcp/
 *    dist/index.js` and runs it with this same node — sub-second start, no
 *    registry round-trip, stdio inherited verbatim. Nothing below touches it.
 *
 * 2. THE COLD PATH (the npx fallback), which is what a FIRST-RUN user gets:
 *    they have no global install, so the fallback is the very cold-npx path
 *    this issue was filed about. Measured on this machine, 2026-08-25, against
 *    a genuinely empty npm cache and an empty global prefix:
 *
 *      cold `npx -y comfyui-mcp --full` → `initialize` response  21.6 s
 *      warm `_npx` cache                → `initialize` response   7.0 s
 *      npm install alone (818 MB, 170 packages)                  15.2 s
 *
 *    …and `claude mcp list` on that cold cache reported
 *    `✘ Failed to connect — MCP server connection timed out`, while the same
 *    launcher with a warm cache reported `✔ Connected`. The install is the
 *    whole difference.
 *
 *    So on the fallback the wrapper stops being a pipe and becomes a
 *    transparent MCP proxy that can WIN THE HANDSHAKE RACE. It forwards
 *    everything verbatim; if the real server has not answered the client's
 *    `initialize` by a deadline derived from the client's own budget, the
 *    wrapper answers it itself, keeps the connection alive with an empty tool
 *    list while npm works, and hands over to the real server the moment it is
 *    up — announcing the real tools with `notifications/tools/list_changed`.
 *    A cold cache then costs LATENCY instead of a failed connection.
 *
 *    Measured against the real client (Claude Code 2.1.246): it re-issues
 *    `tools/list` after that notification and calls a tool that existed only
 *    in the second listing. The handover is not theoretical.
 *
 * STDIO IS THE MCP TRANSPORT. Everything on stdout is the protocol. The warm
 * path inherits stdio and writes nothing; the proxy writes ONLY complete
 * newline-delimited JSON-RPC messages. Diagnostics go to stderr.
 *
 * Import-safe: nothing here runs on import. The resolution and protocol
 * decisions are pure exports so the tests can call the real thing instead of
 * reimplementing it (the #1385 lesson — a test of a copy is a test of nothing).
 */

import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { pathToFileURL } from "node:url";

/** `npm root -g` is normally ~100 ms; 5 s bounds a wedged npm without hanging the handshake. */
const NPM_ROOT_TIMEOUT_MS = 5000;

/**
 * `npm root -g` stdout → the global install's entry point, or null when the
 * output is unusable or the install is absent/incomplete (no dist/index.js).
 * null is not an error here — it means "take the npx path".
 */
export function globalEntry(npmRootStdout, { exists = existsSync } = {}) {
  const root = typeof npmRootStdout === "string" ? npmRootStdout.trim() : "";
  if (!root) return null;
  const entry = join(root, "comfyui-mcp", "dist", "index.js");
  return exists(entry) ? entry : null;
}

/**
 * Tokens the shell form may contain. The fallback's args come from the
 * plugin's own .mcp.json (today: `--full`), never from user input — but a
 * shell command is string concatenation, so anything outside this alphabet
 * (whitespace, quotes, metacharacters) is REFUSED rather than passed through
 * to be silently misparsed.
 */
const SHELL_SAFE_TOKEN = /^[A-Za-z0-9@._~:/=-]+$/;

/**
 * The spawn spec for the resolved server. `extraArgs` are the plugin's own
 * args from .mcp.json (`--full`), forwarded to whichever server runs so the
 * manifest stays the declarative source of how the server is started.
 *
 * With an entry point we spawn node directly — no shell, no shim resolution.
 *
 * The npx fallback differs by platform:
 *  - POSIX: spawn npx with an args array, no shell.
 *  - Windows: npx is npx.cmd, which Node refuses to spawn without a shell
 *    since the 18.20.2/20.12.2 bat-file fix — but `shell` + an args array
 *    triggers DEP0190 (args are concatenated UNESCAPED, and Node warns every
 *    launch). So the Windows spec is one pre-validated command string instead:
 *    same concatenation, but every token is checked against SHELL_SAFE_TOKEN
 *    first, so what the shell parses is exactly what was written.
 */
export function serverSpec(entry, extraArgs, { platform = process.platform, node = process.execPath } = {}) {
  if (entry) return { command: node, args: [entry, ...extraArgs], shell: false };
  const npxArgs = ["-y", "comfyui-mcp", ...extraArgs];
  if (platform !== "win32") return { command: "npx", args: npxArgs, shell: false };
  for (const token of ["npx", ...npxArgs]) {
    if (!SHELL_SAFE_TOKEN.test(token)) {
      throw new Error(`[comfyui-mcp launcher] refusing to pass unsafe shell token to npx: ${JSON.stringify(token)}`);
    }
  }
  return { command: ["npx", ...npxArgs].join(" "), args: [], shell: true };
}

// ---------------------------------------------------------------------------
// #1447 cold-start rescue
// ---------------------------------------------------------------------------

/**
 * What we assume the client will wait for the handshake when it tells us
 * nothing. Claude Code's documented default; measured here as "> 21.6 s", so
 * an unknown-but-real budget is very unlikely to be smaller.
 */
export const DEFAULT_CLIENT_BUDGET_MS = 30000;

/**
 * How much of the client's budget the real server gets before the wrapper
 * answers for it. Deliberately well under half: the point is to rescue with
 * margin to spare, not to shave the deadline.
 */
export const RESCUE_BUDGET_FRACTION = 0.4;
export const RESCUE_MIN_MS = 1500;
export const RESCUE_MAX_MS = 12000;

/**
 * The rescue deadline, in ms after the client's `initialize` arrives.
 *
 * MCP_TIMEOUT is the client's own handshake budget and it is VISIBLE to us —
 * verified by measurement: a server launched by `MCP_TIMEOUT=17000 claude …`
 * reads `process.env.MCP_TIMEOUT === "17000"`. So the deadline tracks the
 * client instead of guessing: a user who tightened the budget gets rescued
 * sooner, not later.
 *
 * The floor keeps a pathological budget from making the wrapper answer before
 * the server has had any chance at all; the ceiling keeps a huge budget from
 * parking the user on "connecting" for a minute when we could have answered.
 */
export function rescueDeadlineMs(env = process.env) {
  const raw = Number(env.MCP_TIMEOUT);
  const budget = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_CLIENT_BUDGET_MS;
  return Math.min(RESCUE_MAX_MS, Math.max(RESCUE_MIN_MS, Math.round(budget * RESCUE_BUDGET_FRACTION)));
}

/**
 * The version the wrapper reports when it answers `initialize` on the server's
 * behalf. It is NOT a plausible version on purpose — #1503 replaced a
 * hardcoded "0.1.0" precisely because a real-looking number made every bug
 * report ambiguous about which build produced it. The wrapper genuinely does
 * not know the version yet (npm is still fetching it), and says so.
 *
 * This is paid only on a launch that would otherwise have FAILED. Every later
 * launch finds a warm cache, the real server answers inside the deadline, and
 * the client gets the real `serverInfo` untouched.
 */
export const INSTALLING_VERSION = "0.0.0-installing";

/**
 * `instructions` for the rescued handshake. The real server's instructions are
 * not knowable before it exists, and instructions cannot be refreshed later —
 * so this says what is true and, importantly, heads off the exact failure the
 * reopened report describes: with the server dead the model "improvised —
 * shelled out, poked at files, invented API calls", and the user read that as
 * a bad agent rather than a server that never started.
 */
export const INSTALLING_INSTRUCTIONS = [
  "comfyui-mcp is still installing. This is the first launch on this machine, so npm is",
  "fetching the server's dependency tree; the plugin launcher answered this handshake to keep",
  "the connection alive. This server has NO tools yet — they arrive by",
  "notifications/tools/list_changed as soon as the install finishes, usually within a minute.",
  "Until then: do not start comfyui-mcp by hand, do not call ComfyUI's HTTP API directly, and do",
  "not tell the user their setup is broken. Wait, re-list the tools, and use them normally.",
  "The server's own usage instructions were not available at handshake time; restarting this MCP",
  "server once the install has finished will pick them up.",
].join(" ");

/**
 * The `initialize` result the wrapper sends in the server's place.
 *
 * `protocolVersion` echoes the client's request: the wrapper is not a protocol
 * implementation with opinions, it is a stand-in, and echoing is what keeps a
 * client from failing the handshake over a version it did not ask for.
 *
 * The capabilities mirror what the real server advertises (measured:
 * `{tools:{listChanged:true},resources:{},prompts:{}}`) so the client's picture
 * of the server does not change under it at handover. `listChanged` is the
 * load-bearing one — it is how the real tools arrive.
 */
export function rescueInitializeResult(clientParams) {
  const requested = clientParams && typeof clientParams.protocolVersion === "string"
    ? clientParams.protocolVersion
    : "2025-06-18";
  return {
    protocolVersion: requested,
    capabilities: { tools: { listChanged: true }, resources: {}, prompts: {} },
    serverInfo: { name: "comfyui-mcp", version: INSTALLING_VERSION },
    instructions: INSTALLING_INSTRUCTIONS,
  };
}

/** JSON-RPC error code for "the server exists but cannot serve this yet". */
const NOT_READY_CODE = -32002;

/**
 * What to do with a client message that arrives while the real server is still
 * installing.
 *
 * The rule that matters: a request must never be FORWARDED and also answered
 * here, and it must never be left unanswered. Forwarding `tools/list` would
 * park the client on a request until npm finishes — which is the timeout this
 * fix exists to remove, moved one method along. So the list methods are
 * answered empty right now and corrected by `notifications/tools/list_changed`
 * at handover.
 *
 * `notifications/initialized` is the exception that MUST be forwarded: the
 * server's SDK will not serve anything until it sees it, and the pipe preserves
 * order, so it lands behind the `initialize` the client already sent.
 *
 * A frame with an id and no method is a RESPONSE, not a request — it belongs to
 * whoever asked, so it is forwarded rather than swallowed. Other notifications
 * are dropped: they can only refer to requests this wrapper answered itself.
 *
 * @returns {{action: "forward"} | {action: "drop"} | {action: "reply", message: object}}
 */
export function installingDecision(msg) {
  if (!msg || typeof msg !== "object") return { action: "drop" };
  if (msg.method === "initialized" || msg.method === "notifications/initialized") {
    return { action: "forward" };
  }
  if (typeof msg.method !== "string") return { action: "forward" };
  const isRequest = msg.id !== undefined && msg.id !== null;
  if (!isRequest) return { action: "drop" };

  const reply = (result) => ({ action: "reply", message: { jsonrpc: "2.0", id: msg.id, result } });
  switch (msg.method) {
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: [] });
    case "resources/list":
      return reply({ resources: [] });
    case "resources/templates/list":
      return reply({ resourceTemplates: [] });
    case "prompts/list":
      return reply({ prompts: [] });
    default:
      return {
        action: "reply",
        message: {
          jsonrpc: "2.0",
          id: msg.id,
          error: {
            code: NOT_READY_CODE,
            message:
              "comfyui-mcp is still installing (first launch fetches the dependency tree). " +
              "Its tools appear via notifications/tools/list_changed when the install finishes.",
          },
        },
      };
  }
}

/**
 * Read a stream as newline-delimited JSON-RPC frames.
 *
 * StringDecoder, not `chunk.toString()`: a multi-byte character split across
 * two chunks would otherwise be corrupted, and this transport carries every
 * localised string the panel and the tools emit.
 */
function readFrames(stream, onLine) {
  const decoder = new StringDecoder("utf8");
  let buffered = "";
  stream.on("data", (chunk) => {
    buffered += decoder.write(chunk);
    let nl;
    while ((nl = buffered.indexOf("\n")) !== -1) {
      const line = buffered.slice(0, nl);
      buffered = buffered.slice(nl + 1);
      onLine(line);
    }
  });
}

/** Write one frame, honouring backpressure by pausing the source that fed it. */
function writeFrame(dest, source, line) {
  if (!dest || dest.destroyed || dest.writableEnded) return;
  if (!dest.write(line + "\n") && source) {
    source.pause();
    dest.once("drain", () => source.resume());
  }
}

/**
 * The transparent proxy with a rescue.
 *
 * Phases:
 *   opening      — forwarding both ways verbatim, waiting for the real server's
 *                  `initialize` response, deadline armed.
 *   transparent  — the server answered in time. Pure passthrough forever; the
 *                  client got the REAL serverInfo, capabilities and
 *                  instructions, and nothing below ever ran.
 *   installing   — the deadline won. The wrapper answered `initialize` and is
 *                  holding the connection open with empty lists.
 *   live         — the server's (now redundant) `initialize` response has been
 *                  swallowed and `tools/list_changed` sent. Pure passthrough.
 *
 * Exported and stream-injectable so the tests can drive the REAL state machine
 * rather than a description of it.
 */
export function attachColdStartProxy({ clientIn, clientOut, childIn, childOut, deadlineMs, onRescue }) {
  let phase = "opening";
  let initializeId;
  let initializeParams;
  let timer = null;

  // No backpressure source: these are the wrapper's own short control frames,
  // and pausing an unrelated stream to emit one would be a bug, not a courtesy.
  const toClient = (message) => writeFrame(clientOut, null, JSON.stringify(message));

  const disarm = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const rescue = () => {
    if (phase !== "opening" || initializeId === undefined) return;
    phase = "installing";
    disarm();
    toClient({ jsonrpc: "2.0", id: initializeId, result: rescueInitializeResult(initializeParams) });
    if (onRescue) onRescue();
  };

  readFrames(clientIn, (line) => {
    if (phase !== "installing") {
      // opening/transparent/live all forward verbatim. In `opening` we still
      // peek, but only to learn the id we may have to answer for — the line
      // itself goes to the server untouched either way.
      if (phase === "opening" && initializeId === undefined && line.includes('"initialize"')) {
        const msg = parseFrame(line);
        if (msg && msg.method === "initialize" && msg.id !== undefined && msg.id !== null) {
          initializeId = msg.id;
          initializeParams = msg.params;
          disarm();
          timer = setTimeout(rescue, deadlineMs);
          if (typeof timer.unref === "function") timer.unref();
        }
      }
      writeFrame(childIn, clientIn, line);
      return;
    }
    const decision = installingDecision(parseFrame(line));
    if (decision.action === "forward") writeFrame(childIn, clientIn, line);
    else if (decision.action === "reply") toClient(decision.message);
  });

  // The client closing stdin is how an MCP stdio session ends. With inherited
  // stdio that reached the server for free; through the proxy it has to be
  // relayed, or the server would sit on a dead transport forever.
  clientIn.on("end", () => {
    if (childIn && !childIn.writableEnded) childIn.end();
  });

  readFrames(childOut, (line) => {
    if (phase === "transparent" || phase === "live") {
      writeFrame(clientOut, childOut, line);
      return;
    }
    // Only the server's answer to the client's `initialize` changes anything,
    // and a response carries no `method` — so this is the one cheap test that
    // has to run per frame while we are still waiting.
    const msg = line.includes('"id"') ? parseFrame(line) : null;
    const isInitializeResponse =
      msg && msg.method === undefined && initializeId !== undefined && sameId(msg.id, initializeId);
    if (!isInitializeResponse) {
      writeFrame(clientOut, childOut, line);
      return;
    }
    if (phase === "opening") {
      // The server won the race. Hand the client its real handshake and never
      // look at another frame.
      phase = "transparent";
      disarm();
      writeFrame(clientOut, childOut, line);
      return;
    }
    // phase === "installing": the client already has an `initialize` result for
    // this id. A second response for the same id is a protocol violation, so
    // this one is swallowed — and the client is told to re-list instead.
    phase = "live";
    toClient({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
  });

  return {
    phase: () => phase,
    // Test seam: fire the deadline without waiting for wall-clock time.
    forceRescue: rescue,
  };
}

function parseFrame(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

/** JSON-RPC ids are strings or numbers; compare without coercing across types. */
function sameId(a, b) {
  return typeof a === typeof b && a === b;
}

/** Ask npm where global packages live. String-command form on Windows for the
 *  same DEP0190 reason as serverSpec; the command is a fixed literal, so there
 *  is nothing to inject. Resolves null on any failure — the npx fallback is
 *  the original behaviour, so a failed probe degrades to exactly what the
 *  plugin did before this wrapper existed. */
function probeGlobalRoot() {
  const isWin = process.platform === "win32";
  return new Promise((resolve) => {
    execFile(
      isWin ? "npm root -g" : "npm",
      isWin ? [] : ["root", "-g"],
      { shell: isWin, timeout: NPM_ROOT_TIMEOUT_MS },
      (error, stdout) => resolve(error ? null : stdout),
    );
  });
}

/** Shared child lifecycle: signal forwarding, exit code, spawn failure. */
function superviseChild(child, spec) {
  // The client kills the WRAPPER when it shuts the server down; without
  // forwarding, the real server would be orphaned holding stdio. Killing the
  // child on signal makes its `exit` fire, which is what exits the wrapper.
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(sig, () => child.kill(sig));
  }

  child.on("exit", (code, signal) => {
    // A signal death has no code; 1 keeps the client from reading it as clean.
    process.exit(code ?? (signal ? 1 : 0));
  });
  child.on("error", (err) => {
    // Honest failure, loudly: a server that never started must not look like
    // one that exited cleanly. stderr, never stdout — see the header.
    console.error(`[comfyui-mcp launcher] failed to start ${spec.command}: ${err.message}`);
    process.exit(1);
  });
}

/** Warm path: stdio inherited verbatim, wrapper is a bystander. */
function run(spec) {
  superviseChild(spawn(spec.command, spec.args, { stdio: "inherit", shell: spec.shell }), spec);
}

/**
 * Cold path: the wrapper sits in the stdio stream so it can answer the
 * handshake if npm is still working. stderr stays inherited — npm's progress
 * and the server's own logs belong in the client's server log untouched.
 */
function runProxied(spec, deadlineMs = rescueDeadlineMs()) {
  const child = spawn(spec.command, spec.args, { stdio: ["pipe", "pipe", "inherit"], shell: spec.shell });
  if (child.stdin && child.stdout) {
    // EPIPE when the install dies mid-frame is not worth a crash: the child's
    // `exit` handler is what reports the failure.
    child.stdin.on("error", () => {});
    attachColdStartProxy({
      clientIn: process.stdin,
      clientOut: process.stdout,
      childIn: child.stdin,
      childOut: child.stdout,
      deadlineMs,
      onRescue: () =>
        console.error(
          "[comfyui-mcp launcher] the server did not finish starting within " +
            `${deadlineMs}ms (first launch installs ~818MB); answered the MCP handshake on its ` +
            "behalf and will announce its tools when the install completes.",
        ),
    });
  }
  superviseChild(child, spec);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const extraArgs = process.argv.slice(2);
  const entry = globalEntry(await probeGlobalRoot());
  const spec = serverSpec(entry, extraArgs);
  // The rescue exists for the npx fallback, which is the only path that can
  // have an install in front of the handshake. A resolved global entry starts
  // a server that is already on disk, so it keeps inherited stdio and this
  // wrapper stays out of its protocol entirely.
  if (entry) run(spec);
  else runProxied(spec);
}
