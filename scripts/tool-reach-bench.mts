#!/usr/bin/env -S npx tsx
/**
 * Tool-reach benchmark — the per-arm episode runner.
 *
 * Runs INSIDE a worktree checked out at the arm's git ref (see
 * scripts/tool-reach.mjs, which prepares the worktree and invokes this), so the
 * schemas the models see are the real ones that ref registers, not a
 * reconstruction.
 *
 *   npx tsx scripts/tool-reach-bench.mts --mode full --arm baseline \
 *     --models claude/sonnet,ollama/qwen3:4b --out results.json
 *
 * ══ THE ONE RULE ══════════════════════════════════════════════════════════
 * NOTHING THE MODEL PICKS IS EXECUTED.
 *
 * This is not an optimisation, it is what makes the benchmark possible. The
 * surface under test can delete multi-GB checkpoints, uninstall node packs,
 * rent cloud GPUs (real money), stop and restart the server, drop the GPU
 * cache, and file real GitHub issues — against a SHARED ComfyUI with unrelated
 * unsaved tabs open. A benchmark that runs what the model picks is a benchmark
 * that files garbage issues and deletes checkpoints.
 *
 * So `dispatch()` is the single choke point and it is an ALLOWLIST, not a
 * denylist: the only two calls that ever reach real code are the compact-mode
 * catalog reads `list_tools` and `describe_tool`, which are pure in-memory
 * lookups over an already-built catalog. Everything else is recorded and
 * answered with a neutral stub. There is no code path from a model's choice to
 * a service call — not "we filtered the dangerous ones out", but "there is no
 * wire".
 *
 * The surface itself IS real: `listRegisteredTools()` / `collectToolCatalog()`
 * are the same entry points src/index.ts uses, so the descriptions and JSON
 * Schemas are byte-identical to what a client is told. That is the thing being
 * measured, so it cannot be stubbed.
 */
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { execFileSync, spawn } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { REQUESTS } from "./tool-reach-requests.mjs";
import { REACH_WINDOW } from "./tool-reach-score.mjs";

// ───────────────────────────────────────────────────────── argv
const argv = process.argv.slice(2);
const opt = (name: string, dflt?: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return dflt;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith("--")) {
    console.error(`--${name} needs a value`);
    process.exit(2);
  }
  return v;
};
const MODE = (opt("mode", "full") as "full" | "compact")!;
const ARM = opt("arm", MODE)!;
const REF = opt("ref", "(working tree)")!;
const OUT = opt("out", join(process.cwd(), `tool-reach-${ARM}.json`))!;
const LIMIT = Number(opt("limit", "0"));
const ONLY = (opt("only", "") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const MODELS = (opt("models", "claude/sonnet") ?? "")
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);
const MAX_ROUNDS = Number(opt("max-rounds", "8"));
const EPISODE_TIMEOUT_MS = Number(opt("episode-timeout-ms", "180000"));

if (MODE !== "full" && MODE !== "compact") {
  console.error(`--mode must be full or compact, got ${MODE}`);
  process.exit(2);
}

// ───────────────────────────────────────────────────────── secrets
/**
 * ~/.comfyui-mcp/.env is this project's only dotenv. Read for hosted-provider
 * keys. Key VALUES are never logged, echoed, written to results, or passed
 * anywhere but the Authorization header of the provider they belong to; the run
 * log only ever says whether a name was present.
 */
function loadEnvFile(): Record<string, string> {
  const p = join(homedir(), ".comfyui-mcp", ".env");
  const out: Record<string, string> = {};
  if (!existsSync(p)) return out;
  for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (m && m[1] && m[2] !== undefined) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}
const FILE_ENV = loadEnvFile();
const secret = (name: string): string => process.env[name] ?? FILE_ENV[name] ?? "";

// ───────────────────────────────────────────────────────── the surface
interface Advertised {
  name: string;
  description: string;
  inputSchema: unknown;
}

/** Set once the surface is built: the CATALOG names a reach can legitimately
 *  name. On a flat arm that is the advertised surface; in compact mode it is
 *  the catalog behind `call_tool`, NOT the three meta-tools. */
let catalogNames: string[] = [];
let advertised: Advertised[] = [];
/** Only ever bound in compact mode, and only ever used to serve list_tools /
 *  describe_tool. Never reachable from an application-tool call. */
let compactClient: Client | null = null;

async function buildSurface(): Promise<void> {
  if (MODE === "full") {
    const { listRegisteredTools } = await import("../src/tools/introspect.js");
    const tools = await listRegisteredTools();
    advertised = tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
    catalogNames = advertised.map((t) => t.name);
    return;
  }
  // Compact: the same two calls src/index.ts makes for COMFYUI_MCP_TOOL_MODE=
  // compact, assembled in-process over an in-memory transport. Deliberately NOT
  // `dist/index.js` over stdio: that boot path also does self-update checks,
  // panel autoinstall and bridge listeners, none of which belong in a
  // benchmark, and one of which would fight the user's live orchestrator for a
  // port.
  const { collectToolCatalog } = await import("../src/tools/index.js");
  const { registerCompactTools } = await import("../src/tools/compact.js");
  const catalog = await collectToolCatalog();
  const server = new McpServer({ name: "tool-reach", version: "0.0.0" });
  registerCompactTools(server, catalog);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "tool-reach", version: "0.0.0" });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  const { tools } = await client.listTools();
  advertised = tools.map((t) => ({
    name: t.name,
    description: t.description ?? "",
    inputSchema: t.inputSchema,
  }));
  catalogNames = [...catalog.tools.keys()];
  compactClient = client;
}

// ───────────────────────────────────────────────────────── episodes
interface Reach {
  tool: string;
  action: string | null;
}
interface Episode {
  requestId: string;
  model: string;
  substantive: Reach[];
  navigation: number;
  navBeforeFirst: number;
  rounds: number;
  seconds: number;
  finalText: string;
  error: string | null;
  /** Claude-only: built-ins it tried to use despite CLAUDE_BUILTINS. */
  deniedBuiltins?: string[];
}

const STUB_CONTINUE =
  "[harness] Your tool selection has been recorded. This environment does not execute tools, " +
  "so there is no result to report back. If a different tool would serve the request better, " +
  "call it; otherwise give your final answer now.";
const STUB_STOP =
  "[harness] Your tool selection has been recorded. This environment does not execute tools. " +
  "Do not call any more tools — give your final answer now.";

/** Robustly read an `action` argument without inventing one. */
function actionOf(args: unknown): string | null {
  if (!args || typeof args !== "object" || Array.isArray(args)) return null;
  const a = (args as Record<string, unknown>).action;
  return typeof a === "string" ? a : null;
}

function parseMaybeJson(v: unknown): Record<string, unknown> {
  if (typeof v === "string") {
    if (!v.trim()) return {};
    try {
      const p: unknown = JSON.parse(v);
      return p && typeof p === "object" && !Array.isArray(p) ? (p as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  return {};
}

/**
 * THE choke point. Returns the text the model sees back.
 *
 * Allowlist: `list_tools` / `describe_tool` (compact only) are forwarded to the
 * in-memory catalog server, because navigating the catalog is the cost being
 * MEASURED on that arm and a stub would make the arm untestable. Every other
 * name — including anything routed through `call_tool` — is recorded and
 * answered with a stub. There is no branch that forwards an application tool.
 */
async function dispatch(ep: Episode, name: string, rawArgs: unknown): Promise<string> {
  const args = parseMaybeJson(rawArgs);

  const navigate = async (toolName: string, toolArgs: Record<string, unknown>): Promise<string> => {
    ep.navigation++;
    if (ep.substantive.length === 0) ep.navBeforeFirst++;
    if (!compactClient) return `Unknown tool: ${toolName}`;
    const res = await compactClient.callTool({ name: toolName, arguments: toolArgs });
    return ((res.content ?? []) as { type: string; text?: string }[])
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("\n");
  };

  const record = (tool: string, action: string | null): string => {
    ep.substantive.push({ tool, action });
    return ep.substantive.length >= REACH_WINDOW ? STUB_STOP : STUB_CONTINUE;
  };

  if (MODE === "compact") {
    if (name === "list_tools" || name === "describe_tool") return navigate(name, args);
    if (name === "call_tool") {
      const inner = args.name ?? args.tool_name;
      const innerName = typeof inner === "string" ? inner : "";
      const innerArgs = parseMaybeJson(args.args ?? args.arguments);
      // compact.ts routes list_tools/describe_tool through call_tool too (#693)
      // when the catalog has no tool of that name. Same control-plane call, same
      // navigation cost — counting it as a reach would fabricate misses.
      if (
        (innerName === "list_tools" || innerName === "describe_tool") &&
        !catalogNames.includes(innerName)
      ) {
        return navigate(innerName, innerArgs);
      }
      if (!innerName) {
        return 'Missing tool name. Call as: call_tool {"name": "<tool>", "args": {...}}';
      }
      return record(innerName, actionOf(innerArgs));
    }
    return `Unknown tool: ${name}. This server exposes list_tools, describe_tool and call_tool.`;
  }

  // Flat arm: there is no catalog to navigate, so every call is a reach. That
  // structural zero for navigation cost is a RESULT, not a gap.
  return record(name, actionOf(args));
}

// ───────────────────────────────────────────────────────── model adapters
type ChatTool = { type: "function"; function: { name: string; description: string; parameters: unknown } };
const chatTools = (): ChatTool[] =>
  advertised.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }));

const SYSTEM =
  "You are an assistant connected to a ComfyUI control server through the tools you have been given. " +
  "When the user asks for something, use the tools to do it. " +
  "If nothing fits, or the request is too vague to act on, answer in words instead of calling a tool.";

/** Context window for local models: the flat surface is ~58k tokens of schema,
 *  so a default 16k window would truncate the catalog and measure truncation
 *  rather than reach. Sized to the actual payload, and RECORDED in the results
 *  so a small-model result is never read without it. */
function ollamaNumCtx(): number {
  const bytes = JSON.stringify(chatTools()).length;
  const approxTokens = Math.ceil(bytes / 3.5) + 2048;
  const target = Math.max(16384, Math.min(65536, 1 << Math.ceil(Math.log2(approxTokens))));
  return Number(process.env.REACH_NUM_CTX ?? target);
}

async function chatOllama(model: string, messages: unknown[]): Promise<any> {
  const host = process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434";
  const res = await fetch(`${host}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      messages,
      tools: chatTools(),
      stream: false,
      options: { num_ctx: ollamaNumCtx(), temperature: 0 },
    }),
  });
  if (!res.ok) throw new Error(`ollama http ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()).message;
}

async function chatOpenAI(model: string, messages: unknown[], baseUrl: string, key: string): Promise<any> {
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify({ model, messages, tools: chatTools(), tool_choice: "auto", temperature: 0 }),
  });
  if (!res.ok) throw new Error(`openai-compatible http ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const msg = (await res.json()).choices?.[0]?.message;
  if (!msg) throw new Error("response had no choices[0].message");
  return msg;
}

/** One chat-completions episode (Ollama-native or OpenAI-compatible). */
async function runChatEpisode(
  spec: { model: string; kind: "ollama" | "openai"; baseUrl?: string; key?: string },
  request: (typeof REQUESTS)[number],
  label: string,
): Promise<Episode> {
  const ep: Episode = {
    requestId: request.id,
    model: label,
    substantive: [],
    navigation: 0,
    navBeforeFirst: 0,
    rounds: 0,
    seconds: 0,
    finalText: "",
    error: null,
  };
  const started = Date.now();
  const messages: any[] = [
    { role: "system", content: SYSTEM },
    { role: "user", content: request.task },
  ];

  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (Date.now() - started > EPISODE_TIMEOUT_MS) {
      ep.error = "episode timeout";
      break;
    }
    ep.rounds = round + 1;
    let msg: any;
    try {
      msg =
        spec.kind === "ollama"
          ? await chatOllama(spec.model, messages)
          : await chatOpenAI(spec.model, messages, spec.baseUrl!, spec.key!);
    } catch (err) {
      ep.error = err instanceof Error ? err.message : String(err);
      break;
    }
    messages.push(msg);

    // NO NUDGE. llm-arena.mjs prods a model that has not run a tool, because it
    // is measuring task completion. Here a nudge would destroy the measurement:
    // it manufactures reaches on rows whose correct answer is to reach for
    // nothing, and inflates first-reach on the rest.
    if (!msg.tool_calls?.length) {
      ep.finalText = String(msg.content ?? "").slice(0, 600);
      break;
    }

    for (const tc of msg.tool_calls) {
      const name = tc.function?.name ?? "";
      const text = await dispatch(ep, name, tc.function?.arguments);
      messages.push(
        spec.kind === "openai"
          ? { role: "tool", tool_call_id: tc.id ?? "call_0", content: text.slice(0, 12000) }
          : { role: "tool", tool_name: name, content: text.slice(0, 12000) },
      );
    }
    if (ep.substantive.length >= REACH_WINDOW) break;
  }
  ep.seconds = Math.round((Date.now() - started) / 1000);
  return ep;
}

// ───────────────────────────────────────────────────────── claude adapter
/**
 * Claude Code drives real MCP, not chat-completions, so it gets a real MCP
 * server — one that advertises this arm's schemas and cannot execute anything.
 * `scripts/tool-reach-stub-server.mjs` is a thin shell: it asks THIS process
 * (over loopback) both for the surface and for what to answer, so `dispatch()`
 * above stays the only interception policy in the codebase.
 */
let oracle: { url: string; close: () => void } | null = null;
const oracleEpisodes = new Map<string, Episode>();

/**
 * Absolute path to the `claude` executable, resolved once.
 *
 * Spawned WITHOUT `shell: true`. On Windows a shell spawn concatenates argv
 * rather than escaping it, and one of the arguments here is the request text —
 * which is benchmark data today, but is exactly the kind of string that grows a
 * quote later. Resolving the real binary removes the shell from the picture
 * entirely.
 */
/**
 * Claude Code built-ins to strip from the surface, so the only tools on offer
 * are the arm's.
 *
 * Deliberately over-broad and environment-specific — this host's Claude Code
 * carries scheduling, worktree and messaging tools a stock install does not, and
 * naming a tool that is not present is harmless while missing one is not. Each
 * episode also records `permission_denials`, so a built-in that survives this
 * list shows up in the results instead of quietly absorbing a request.
 */
const CLAUDE_BUILTINS = [
  "Bash", "BashOutput", "KillShell", "PowerShell",
  "Read", "Write", "Edit", "NotebookEdit", "Glob", "Grep",
  "WebFetch", "WebSearch",
  "Task", "Agent", "TodoWrite", "SlashCommand", "Skill", "ToolSearch",
  "ExitPlanMode", "Artifact", "Workflow", "Monitor", "ReportFindings",
  "ScheduleWakeup", "PushNotification", "RemoteTrigger", "SendMessage",
  "DesignSync", "EnterWorktree", "ExitWorktree",
  "CronCreate", "CronDelete", "CronList",
  "TaskCreate", "TaskGet", "TaskList", "TaskUpdate", "TaskStop",
];

let claudeBin: string | null = null;
function resolveClaude(): string {
  if (claudeBin) return claudeBin;
  const finder = process.platform === "win32" ? "where" : "which";
  const found = execFileSync(finder, ["claude"], { encoding: "utf8" })
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  const exe = found.find((p) => !/\.(cmd|bat|ps1)$/i.test(p)) ?? found[0];
  if (!exe) throw new Error("claude not found on PATH");
  claudeBin = exe;
  return exe;
}

async function startOracle(): Promise<{ url: string; close: () => void }> {
  if (oracle) return oracle;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      void (async () => {
        try {
          if (req.url === "/tools") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ tools: advertised }));
            return;
          }
          if (req.url === "/call") {
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
            const ep = oracleEpisodes.get(body.episodeId);
            if (!ep) {
              res.writeHead(404, { "content-type": "application/json" });
              res.end(JSON.stringify({ text: "unknown episode" }));
              return;
            }
            const text = await dispatch(ep, String(body.name ?? ""), body.args);
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ text, stop: ep.substantive.length >= REACH_WINDOW }));
            return;
          }
          res.writeHead(404).end();
        } catch (err) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ text: `oracle error: ${String(err)}` }));
        }
      })();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  oracle = { url: `http://127.0.0.1:${port}`, close: () => server.close() };
  return oracle;
}

async function runClaudeEpisode(
  model: string,
  request: (typeof REQUESTS)[number],
  label: string,
): Promise<Episode> {
  const ep: Episode = {
    requestId: request.id,
    model: label,
    substantive: [],
    navigation: 0,
    navBeforeFirst: 0,
    rounds: 0,
    seconds: 0,
    finalText: "",
    error: null,
  };
  const started = Date.now();
  const { url } = await startOracle();
  const episodeId = `${label}:${request.id}:${Math.random().toString(36).slice(2)}`;
  oracleEpisodes.set(episodeId, ep);

  const stubPath = join(dirname(fileURLToPath(import.meta.url)), "tool-reach-stub-server.mjs");
  const mcpConfig = JSON.stringify({
    mcpServers: {
      comfyui: {
        command: process.execPath,
        args: [stubPath],
        env: { REACH_ORACLE: url, REACH_EPISODE: episodeId },
      },
    },
  });

  const args = [
    "-p",
    request.task,
    "--model",
    model,
    "--strict-mcp-config",
    "--mcp-config",
    mcpConfig,
    // Built-ins off. Without this the benchmark measures Claude Code's toolbox
    // rather than this server's surface: "file a bug" gets answered with
    // `Bash(gh issue create)` and scores as a no-reach, and "what's 1024×0.68"
    // gets answered from the model's head with a Read/Bash sidecar. Note
    // `--tools ""` does NOT do this (verified: the built-ins stay), whereas
    // --disallowedTools removes them from the advertised surface entirely.
    "--disallowedTools",
    ...CLAUDE_BUILTINS,
    "--system-prompt",
    SYSTEM,
    "--permission-mode",
    "bypassPermissions",
    "--no-session-persistence",
    "--output-format",
    "json",
  ];
  try {
    const out = await new Promise<string>((resolve, reject) => {
      const child = spawn(resolveClaude(), args, {
        stdio: ["ignore", "pipe", "pipe"],
        cwd: tmpdir(),
      });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error("claude timeout"));
      }, EPISODE_TIMEOUT_MS);
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0 && !stdout.trim()) reject(new Error(`claude exit ${code}: ${stderr.slice(0, 300)}`));
        else resolve(stdout);
      });
    });
    try {
      const j = JSON.parse(out);
      ep.finalText = String(j.result ?? "").slice(0, 600);
      ep.rounds = Number(j.num_turns ?? 0);
      // A denial here means a built-in slipped past CLAUDE_BUILTINS and the
      // model tried to answer with it — visible in the results rather than
      // silently depressing the reach rate.
      if (Array.isArray(j.permission_denials) && j.permission_denials.length) {
        ep.deniedBuiltins = j.permission_denials.map((d: { tool_name?: string }) => d.tool_name ?? "?");
      }
    } catch {
      ep.finalText = out.slice(0, 600);
    }
  } catch (err) {
    ep.error = err instanceof Error ? err.message : String(err);
  } finally {
    oracleEpisodes.delete(episodeId);
  }
  ep.seconds = Math.round((Date.now() - started) / 1000);
  return ep;
}

// ───────────────────────────────────────────────────────── preflight
interface ModelSpec {
  label: string;
  kind: "ollama" | "openai" | "claude";
  model: string;
  baseUrl?: string;
  key?: string;
}

/**
 * Resolve the requested field, dropping anything that is not actually
 * reachable — and RECORDING why. A silently-skipped model turns a result table
 * into a misleading one, so every skip is reported next to the results.
 */
async function preflight(specs: string[]): Promise<{ ready: ModelSpec[]; skipped: { model: string; reason: string }[] }> {
  const ready: ModelSpec[] = [];
  const skipped: { model: string; reason: string }[] = [];
  let ollamaTags: string[] | null = null;

  for (const raw of specs) {
    const slash = raw.indexOf("/");
    const kind = slash < 0 ? "ollama" : raw.slice(0, slash);
    const model = slash < 0 ? raw : raw.slice(slash + 1);

    if (kind === "ollama") {
      if (ollamaTags === null) {
        try {
          const host = process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434";
          const res = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(5000) });
          ollamaTags = (await res.json()).models.map((m: { name: string }) => m.name);
        } catch (err) {
          ollamaTags = [];
          skipped.push({ model: raw, reason: `Ollama unreachable (${String(err).slice(0, 80)})` });
          continue;
        }
      }
      if (!ollamaTags.includes(model)) {
        skipped.push({ model: raw, reason: `not pulled — run \`ollama pull ${model}\`` });
        continue;
      }
      ready.push({ label: raw, kind: "ollama", model });
      continue;
    }

    if (kind === "claude") {
      const ok = await new Promise<boolean>((resolve) => {
        let c;
        try {
          c = spawn(resolveClaude(), ["--version"], { stdio: "ignore" });
        } catch {
          resolve(false);
          return;
        }
        c.on("error", () => resolve(false));
        c.on("close", (code) => resolve(code === 0));
      });
      if (!ok) skipped.push({ model: raw, reason: "`claude` CLI not on PATH" });
      else ready.push({ label: raw, kind: "claude", model });
      continue;
    }

    // Any OpenAI-compatible provider: openai/<model>, moonshot/<model>, …
    const providers: Record<string, { baseUrl: string; keyName: string }> = {
      openai: { baseUrl: "https://api.openai.com/v1", keyName: "OPENAI_API_KEY" },
      moonshot: { baseUrl: "https://api.moonshot.ai/v1", keyName: "MOONSHOT_API_KEY" },
      openrouter: { baseUrl: "https://openrouter.ai/api/v1", keyName: "OPENROUTER_API_KEY" },
    };
    const p = providers[kind];
    if (!p) {
      skipped.push({ model: raw, reason: `unknown provider prefix "${kind}"` });
      continue;
    }
    const baseUrl = process.env.REACH_BASE_URL ?? p.baseUrl;
    const key = secret(p.keyName);
    if (!key) {
      skipped.push({ model: raw, reason: `${p.keyName} not set (checked env and ~/.comfyui-mcp/.env)` });
      continue;
    }
    // Probe once: a dead key must skip the model, not fail 100 episodes.
    try {
      const res = await fetch(`${baseUrl.replace(/\/$/, "")}/models`, {
        headers: { authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) {
        skipped.push({ model: raw, reason: `${kind} rejected the stored key (HTTP ${res.status})` });
        continue;
      }
    } catch (err) {
      skipped.push({ model: raw, reason: `${kind} unreachable (${String(err).slice(0, 80)})` });
      continue;
    }
    ready.push({ label: raw, kind: "openai", model, baseUrl, key });
  }
  return { ready, skipped };
}

// ───────────────────────────────────────────────────────── main
await buildSurface();

let requests = REQUESTS.filter((r) => (ONLY.length ? ONLY.some((p) => r.id.startsWith(p)) : true));
if (LIMIT > 0) requests = requests.slice(0, LIMIT);

const { ready, skipped } = await preflight(MODELS);
console.error(
  `[reach] arm=${ARM} ref=${REF} mode=${MODE} advertised=${advertised.length} ` +
    `catalog=${catalogNames.length} requests=${requests.length}`,
);
for (const s of skipped) console.error(`[reach] SKIP ${s.model}: ${s.reason}`);
if (!ready.length) {
  console.error("[reach] no runnable models — nothing to do");
}

const episodes: Episode[] = [];
for (const spec of ready) {
  console.error(`[reach] ── ${spec.label}`);
  let i = 0;
  for (const request of requests) {
    i++;
    const ep =
      spec.kind === "claude"
        ? await runClaudeEpisode(spec.model, request, spec.label)
        : await runChatEpisode(spec as never, request, spec.label);
    episodes.push(ep);
    const reach = ep.substantive[0];
    console.error(
      `[reach]   ${String(i).padStart(3)}/${requests.length} ${request.id.padEnd(8)} ` +
        `→ ${reach ? `${reach.tool}${reach.action ? `(${reach.action})` : ""}` : "(no reach)"}` +
        `${ep.navBeforeFirst ? ` nav=${ep.navBeforeFirst}` : ""}${ep.error ? ` ERR ${ep.error.slice(0, 60)}` : ""}`,
    );
  }
}
oracle?.close();

mkdirSync(dirname(OUT), { recursive: true });

/**
 * Merge with a prior run of the SAME arm so the field can be run one model at a
 * time — the local models are GPU-serialised and Claude is network-bound, so
 * they want separate invocations, and plain overwriting would silently discard
 * whichever finished first.
 *
 * Merged only when arm/ref/mode all match: episodes recorded against a
 * different surface are not comparable, and quietly blending them would produce
 * a table whose rows were measured against different tool sets.
 */
let prior: { modelsRun?: string[]; modelsSkipped?: unknown[]; episodes?: Episode[] } = {};
if (existsSync(OUT)) {
  try {
    const p = JSON.parse(readFileSync(OUT, "utf8"));
    if (p.arm === ARM && p.ref === REF && p.mode === MODE) prior = p;
    else console.error(`[reach] ignoring ${OUT}: different arm/ref/mode, not comparable`);
  } catch {
    console.error(`[reach] ignoring unreadable ${OUT}`);
  }
}
const justRan = new Set(ready.map((r) => r.label));
const mergedEpisodes = [
  ...(prior.episodes ?? []).filter((e) => !justRan.has(e.model)),
  ...episodes,
];
const mergedModels = [...new Set([...(prior.modelsRun ?? []), ...ready.map((r) => r.label)])];
const priorSkips = (prior.modelsSkipped ?? []) as { model: string }[];
const mergedSkips = [
  ...priorSkips.filter((s) => !justRan.has(s.model) && !skipped.some((k) => k.model === s.model)),
  ...skipped,
].filter((s) => !mergedModels.includes((s as { model: string }).model));

writeFileSync(
  OUT,
  JSON.stringify(
    {
      arm: ARM,
      ref: REF,
      mode: MODE,
      generatedAt: new Date().toISOString(),
      advertisedCount: advertised.length,
      advertisedNames: advertised.map((t) => t.name),
      catalogNames,
      surfaceBytes: JSON.stringify(chatTools()).length,
      ollamaNumCtx: ready.some((r) => r.kind === "ollama") ? ollamaNumCtx() : null,
      reachWindow: REACH_WINDOW,
      systemPrompt: SYSTEM,
      requestIds: requests.map((r) => r.id),
      modelsRun: mergedModels,
      modelsSkipped: mergedSkips,
      episodes: mergedEpisodes,
    },
    null,
    2,
  ),
);
console.error(`[reach] wrote ${OUT} (${episodes.length} episodes)`);

// Close what we opened and let the loop drain, rather than calling
// process.exit(). Under tsx on Windows, exiting while the loader's async handle
// is mid-close trips a libuv assertion
// (`!(handle->flags & UV_HANDLE_CLOSING)`, src\win\async.c) and the process dies
// with exit 127 AFTER a completely successful run — which the orchestrator then
// reports as a failed arm even though the results are on disk. An exit code
// that lies about a good run is worse than a slow shutdown.
await compactClient?.close();
process.exitCode = 0;
