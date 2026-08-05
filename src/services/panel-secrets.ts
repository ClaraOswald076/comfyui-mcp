// Persisted TOOL secrets for the orchestrator's BUILT-IN comfyui MCP server.
//
// The orchestrator spawns the comfyui MCP server (this build, in normal/stdio
// mode) as a subprocess with a FIXED env it controls (COMFYUI_URL, progress dir,
// COMFYUI_PATH…). Tool secrets the user supplies at runtime through the panel —
// e.g. a CivitAI API token for download_civitai_model, a HuggingFace token for
// download_model — must reach THAT subprocess's env. They can't go into the
// user's ~/.claude.json mcpServers map (user-mcp-config.ts), because that map is
// for the user's OWN, inherited MCP servers; the built-in comfyui server doesn't
// read it. So we persist them here, the orchestrator merges them into the comfyui
// server's spawn env (buildComfyuiMcpEnv), and respawns the server so a live one
// picks up the new value WITHOUT the user fighting reloads.
//
// SECURITY: the file holds raw secrets, so it is written 0600 (owner-only). The
// raw value NEVER enters a log or the agent's chat context — callers pass it
// straight from the panel's secure input, and only the env-var KEYS are ever
// logged (see comfyuiSecretKeys()).

import dotenv from "dotenv";
import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  comfyuiEnvFilePath,
  freshSecretValue,
  freshSecretValues,
  isShellProvided,
  markFileDerived,
  parseEnvFile,
  unmarkFileDerived,
  MANAGED_SECRET_KEYS_ENV,
} from "../env-file.js";
import { logger } from "../utils/logger.js";
import { OPENAI_KEY_PROVIDERS, providerModelHint } from "./openai-provider-registry.js";

interface PanelSecrets {
  /** Env vars injected into the built-in comfyui MCP server's spawn env. */
  comfyuiEnv?: Record<string, string>;
  /** Env vars the ORCHESTRATOR reads in-process (not the comfyui child) — e.g.
   *  the OpenRouter API key for the OpenRouter provider backend. Kept SEPARATE
   *  from comfyuiEnv (different allowlist) so a provider key is never injected
   *  into the tool subprocess and a tool token never reaches the LLM backend. */
  agentEnv?: Record<string, string>;
  /** STATUS-ONLY mirror of in-panel OAuth sign-ins (Codex/Grok/Copilot), keyed by
   *  provider id. Holds NO secrets — the native token files (~/.codex/auth.json,
   *  ~/.grok/auth.json, ~/.comfyui-mcp/copilot-auth.json) are the source of truth
   *  for token material. This is deliberately NOT under either allowlist above:
   *  it is read by the panel UI to show "signed in as …" without ever touching a
   *  credential. `setOAuthStatus` sanitizes on write so a hand-edited/corrupt file
   *  can never smuggle anything beyond the five known status fields. */
  oauthStatus?: Record<string, OAuthStatusRecord>;
}

/** Status-only record for an in-panel OAuth sign-in. NEVER put token material here. */
export interface OAuthStatusRecord {
  provider: string;
  account_label: string;
  obtained_at: number;
  expires_at?: number;
  experimental?: boolean;
}

// STRICT ALLOWLIST of env keys a panel-collected secret may set on the comfyui
// MCP child process. The child is a Node subprocess (process.execPath), so an
// arbitrary key (NODE_OPTIONS, PATH, COMFYUI_PATH, LD_PRELOAD, …) could hijack or
// clobber it. We therefore permit ONLY known credential vars the comfyui tools
// read — both on SAVE (reject otherwise) and on LOAD (filter), so even a hand-
// edited or corrupt panel-secrets.json can never inject anything else.
//   CIVITAI_API_TOKEN  → download_civitai_model (config.civitaiApiToken)
//   HUGGINGFACE_TOKEN  → HuggingFace downloads   (config.huggingfaceToken)
//   HF_TOKEN           → HuggingFace alias some tooling/hub libs honor
export const COMFYUI_SECRET_ENV_ALLOWLIST = [
  "CIVITAI_API_TOKEN",
  "HUGGINGFACE_TOKEN",
  "HF_TOKEN",
  "GEMINI_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "GOOGLE_API_KEY",
  "RUNCOMFY_API_KEY",
  "RUNPOD_API_KEY",
  "REGISTRY_ACCESS_TOKEN",
] as const;

const ALLOWLIST_SET = new Set<string>(COMFYUI_SECRET_ENV_ALLOWLIST);

/** Is `key` a permitted comfyui tool-secret env var? */
export function isAllowedComfyuiSecretKey(key: string): boolean {
  return ALLOWLIST_SET.has(key);
}

// STRICT ALLOWLIST of env keys the ORCHESTRATOR itself may read from the store.
// These configure the agent provider backends in-process (never a subprocess),
// so the injection surface is different from the comfyui child's — but we keep
// the same allowlist discipline so a corrupt file can't set arbitrary env.
//   OPENROUTER_API_KEY → the OpenRouter provider backend (OllamaBackend openai)
//   COMFYUI_MCP_CUSTOM_API_KEY → the user-defined Custom endpoint provider
// The registry providers' keys (GLM_API_KEY/ZHIPU*/ZAI_API_KEY, KIMI_API_KEY,
// MOONSHOT_API_KEY) are DERIVED from openai-provider-registry so a new api-key
// provider is allowlisted by adding one registry entry, not editing this array.
export const AGENT_SECRET_ENV_ALLOWLIST: readonly string[] = [
  "OPENROUTER_API_KEY",
  "COMFYUI_MCP_CUSTOM_API_KEY",
  ...OPENAI_KEY_PROVIDERS.flatMap((p) => p.envKeys),
];
const AGENT_ALLOWLIST_SET = new Set<string>(AGENT_SECRET_ENV_ALLOWLIST);

/** Is `key` a permitted orchestrator agent-secret env var? */
export function isAllowedAgentSecretKey(key: string): boolean {
  return AGENT_ALLOWLIST_SET.has(key);
}

/** Secrets file path. Overridable for tests. */
export function panelSecretsPath(): string {
  return (
    process.env.COMFYUI_MCP_PANEL_SECRETS ||
    join(homedir(), ".comfyui-mcp", "panel-secrets.json")
  );
}

// In-process change channel: the tool handler that saves a secret runs in the
// SAME process as the orchestrator (both the in-process Claude panel server and
// the Codex loopback HTTP MCP are hosted by the orchestrator), so a module-level
// emitter is enough to tell the orchestrator to re-inject + respawn.
const emitter = new EventEmitter();

// ── Emission suspension ─────────────────────────────────────────────────────
// A multi-key operation (a Settings SLOT save fans out to a slot's alias keys)
// must not fire a change per key: each successful alias emits BEFORE the later
// alias's failure is known, so a save that ultimately fails — and is rolled back
// — would still have respawned every idle agent against a half-written state,
// and the rollback would respawn them all again (codex gate, round 5, finding
// 7). Suspend for the duration, then emit ONCE for the state actually left.
let emitSuspendDepth = 0;
let suspendedComfyuiChange = false;
let suspendedAgentChange = false;

function emitComfyuiChange(payload: Partial<ComfyuiSecretChange>): void {
  if (emitSuspendDepth > 0) {
    suspendedComfyuiChange = true;
    return;
  }
  emitter.emit("change", payload);
}

function emitAgentChange(): void {
  if (emitSuspendDepth > 0) {
    suspendedAgentChange = true;
    return;
  }
  emitter.emit("agentChange");
}

/**
 * Run `fn` with change events suspended, then emit at most one of each for the
 * FINAL state. `decide` sees whether anything was suppressed and returns what to
 * emit — a caller whose operation failed AND was fully rolled back can emit
 * nothing, because nothing changed.
 */
function withSuspendedEmissions<T>(
  fn: () => T,
  decide: (result: T | undefined, suppressed: { comfyui: boolean; agent: boolean }) => {
    comfyui?: Partial<ComfyuiSecretChange> | false;
    agent?: boolean;
  },
): T {
  const outerComfyui = suspendedComfyuiChange;
  const outerAgent = suspendedAgentChange;
  suspendedComfyuiChange = false;
  suspendedAgentChange = false;
  emitSuspendDepth++;
  let result: T | undefined;
  try {
    result = fn();
    return result;
  } finally {
    emitSuspendDepth--;
    const suppressed = { comfyui: suspendedComfyuiChange, agent: suspendedAgentChange };
    suspendedComfyuiChange = outerComfyui;
    suspendedAgentChange = outerAgent;
    const plan = decide(result, suppressed);
    if (plan.comfyui) emitComfyuiChange(plan.comfyui);
    if (plan.agent) emitAgentChange();
  }
}

/** Payload for a comfyui tool-secret change. `requested` is true ONLY when the
 *  change ANSWERS an outstanding panel_request_secret (the agent asked the user
 *  for a token to unblock an action) — a Settings-panel slot save, a background
 *  (re)load/migration, or a revoke is `false`. The orchestrator gates the
 *  "token active — retry the action" nudge on this so it is never injected when
 *  no request was outstanding (#164). */
export interface ComfyuiSecretChange {
  requested: boolean;
  /** The panel tab whose panel_request_secret this change answers, when
   *  `requested` — so the orchestrator can nudge ONLY that tab's agent to retry
   *  (never a broadcast to unrelated tabs). Undefined for non-request changes. */
  tabId?: string;
  /** Report back what the subscriber ACTUALLY did about the tool-child respawn.
   *  The emit is synchronous, so whatever a listener reports here is available to
   *  `setEnvSecret`'s caller before it composes its answer. A listener that does
   *  not call this contributes nothing — silence is never read as success (#826). */
  report?: (r: SecretRespawnReport) => void;
}

/** What a subscriber did about respawning the comfyui tool child. Counts only —
 *  never a promise about a future state we have not observed. */
export interface SecretRespawnReport {
  /** Live agent sessions at the moment of the change. */
  live: number;
  /** Sessions replaced RIGHT NOW (they were idle) — an observed respawn. */
  applied: number;
  /** Sessions that were mid-turn, so their replacement is queued for the next
   *  idle. Scheduled, NOT done — describe it that way. */
  scheduled: number;
}

/** Subscribe to "a comfyui tool secret changed". The callback receives whether
 *  the change answered an outstanding secret REQUEST and, if so, the requesting
 *  tab (see ComfyuiSecretChange). Returns an unsubscribe fn. */
export function onComfyuiSecretsChanged(cb: (change: ComfyuiSecretChange) => void): () => void {
  const handler = (payload?: Partial<ComfyuiSecretChange>) =>
    cb({
      requested: payload?.requested === true,
      tabId: payload?.requested === true ? payload?.tabId : undefined,
      report: payload?.report,
    });
  emitter.on("change", handler);
  return () => {
    emitter.off("change", handler);
  };
}

/**
 * The OBSERVED outcome of persisting a secret. Every field is something we
 * checked, not something we intend — `panel_request_secret` composes its answer
 * from this instead of asserting a respawn that may never fire (#826).
 */
export interface SecretSaveReceipt {
  /** The env var written. Never the value. */
  key: string;
  /** The canonical file it was written to (contains no secret). */
  path: string;
  /**
   * THE single field that decides whether a caller may narrate success. It is a
   * verdict about the SAVE, not merely about the key.
   *
   *  "yes"      — a read-back proved the key carries this value AND the
   *               whole-file check accounted for every other key the store held.
   *               Nothing less than that is "yes".
   *  "no"       — the read-back proved it does NOT: the save did not take effect.
   *  "unknown"  — neither verdict is established. `uncertainty` says exactly
   *               what could not be established; a renderer must print THAT
   *               rather than assume a cause.
   *  "damaged"  — the key IS in the store, and OTHER credentials it held are
   *               proven gone. `lostKeys` names them. Never a success.
   *
   * "damaged" exists so that data loss cannot be narrated as a save by ANY
   * caller rather than by the callers that remembered to check `lostKeys`. Every
   * success test in this codebase is `persisted === "yes"`, so a damaged receipt
   * fails all of them at once — that is the point, and it is why the answer is a
   * new variant here rather than another check at each call site (codex gate:
   * `storeDamageNote` guarded the ack while `slotSaveConfirmed` and the console's
   * `/api/secrets` both still reported a clean save over destroyed tokens).
   *
   * Deliberately never collapsed: "could not determine" must not harden into a
   * definite answer in either direction, and proven loss must not soften into
   * "could not determine".
   */
  persisted: "yes" | "no" | "unknown" | "damaged";
  /** Why `persisted` is not "yes", when the reason is not self-evident from the
   *  verdict alone. One sentence, no values. */
  uncertainty?: string;
  /** True when every consumer of this key resolves it from the canonical file at
   *  ACCESS time, so an already-running tool process sees it with no respawn. */
  livePickup: boolean;
  /** What the orchestrator's listener reported. `null` when NO listener answered
   *  — then nothing is known to be driving a respawn and we must not claim one. */
  respawn: SecretRespawnReport | null;
  /** Only set when `persisted === "no"`: whether SOME credential for this key is
   *  still in effect after the rollback (a previous working value). Lets the
   *  refusal avoid the false "nothing is configured". Presence only. */
  stillConfigured?: boolean;
  /** The value WAS stored, but a real environment variable of the same name
   *  outranks the store, so readers use that instead. Saying "saved" without
   *  saying this would report a configured state the tools do not use. */
  shadowedByEnv?: boolean;
  /** OTHER credential keys the store held before this write and no longer
   *  holds. Never empty on a healthy write. A save must NEVER be reported as
   *  clean over this: "your token is saved" while the user's other tokens were
   *  destroyed is a fabricated success on top of data loss. Names only.
   *  Present only alongside `persisted: "damaged"` — the two are set together. */
  lostKeys?: string[];
  /** Comment / non-assignment lines the rewrite did not preserve. The store's
   *  own contract is that it keeps them, so losing them is the user's data going
   *  missing — a disclosure every renderer owes, not a detail to compute and
   *  discard (codex gate). A count, never the lines themselves: a comment in a
   *  credential file can contain a credential. */
  lostCommentLines?: number;
  /** Set when the write LANDED but was not established to survive a power loss
   *  (an fsync of the file or of its directory failed). A disclosure, not a
   *  failure: the value is in the store now. */
  durabilityGap?: string;
}

// ── What a receipt OBLIGES its renderer to say ───────────────────────────────
//
// These live next to the receipt, not next to any one renderer, on purpose. Each
// of the three consumers (the panel_request_secret ack, the agent-secret ack,
// and the console's /api/secrets) grew its own idea of which fields mattered,
// and `lostKeys` reached exactly one of them — so a save that destroyed the
// user's other tokens was narrated as a success by the other two (codex gate).
// A new obligation added to the receipt belongs in `receiptDisclosures` once,
// and every consumer picks it up at the same moment.

/** The store lost OTHER credentials while saving this one. This outranks every
 *  other clause: "your token is saved" while the user's other tokens were
 *  destroyed is a fabricated success on top of data loss. Names only, no values. */
export function storeDamageNote(receipt: SecretSaveReceipt): string | null {
  const lost = receipt.lostKeys ?? [];
  if (!lost.length) return null;
  return (
    `🛑 "${receipt.key}" was written to ${receipt.path}, but the store NO LONGER carries ${lost.join(", ")} — ` +
    `${lost.length > 1 ? "those credentials were" : "that credential was"} lost during the write. Do not treat this as a successful save. ` +
    `Inspect ${receipt.path} and restore the missing ${lost.length > 1 ? "entries" : "entry"} before relying on anything in it.`
  );
}

/** The rewrite did not preserve the user's comment lines, which this store
 *  promises to keep. Not a failed save — the credential is there — but it is the
 *  user's data going missing, and it was computed and then discarded before it
 *  ever reached a receipt (codex gate). A count only: a comment in a credential
 *  file can itself contain a credential. */
export function commentLossNote(receipt: SecretSaveReceipt): string | null {
  const n = receipt.lostCommentLines ?? 0;
  if (n <= 0) return null;
  return (
    `⚠️ ${n} comment line${n > 1 ? "s" : ""} in ${receipt.path} did not survive this write. ` +
    `The credential itself is unaffected, but this store is meant to preserve them — check the file if those notes mattered.`
  );
}

/** The write landed but was not established to survive a power loss. */
export function durabilityNote(receipt: SecretSaveReceipt): string | null {
  if (!receipt.durabilityGap) return null;
  return (
    `⚠️ The value IS in ${receipt.path} now, but this write was not made crash-durable: ${receipt.durabilityGap}. ` +
    `If the machine loses power before the filesystem flushes on its own, set the credential again.`
  );
}

/** The store holds the value, but a real environment variable of the same name
 *  outranks it, so the readers use THAT. Reporting "saved" without this is a
 *  configured state the tools do not use. */
export function shadowedNote(receipt: SecretSaveReceipt): string | null {
  if (!receipt.shadowedByEnv) return null;
  return (
    `⚠️ "${receipt.key}" was stored in ${receipt.path}, but it is NOT the value in use: a real environment variable named ${receipt.key} is set outside this app and takes precedence over the store. ` +
    `Nothing changed for the tools. To make the value you just supplied take effect, unset ${receipt.key} in the environment this app was started from and restart it — or leave the environment variable as the source of truth. ` +
    `(The value itself is never shown or logged.)`
  );
}

/**
 * EVERY clause this receipt obliges its renderer to state, most severe first.
 *
 * THE choke point: a consumer renders these and is done, instead of knowing
 * which receipt fields exist. Empty means the receipt carries no obligation —
 * which is not the same as "the save succeeded"; that question is `persisted`.
 */
export function receiptDisclosures(receipt: SecretSaveReceipt): string[] {
  return [
    storeDamageNote(receipt),
    commentLossNote(receipt),
    durabilityNote(receipt),
    shadowedNote(receipt),
  ].filter((n): n is string => n !== null);
}

/**
 * Keys whose EVERY reader resolves them at ACCESS time from the canonical .env
 * (via env-file.ts freshSecretValue), so a value saved after a process started
 * is visible to it with no respawn:
 *   CIVITAI_API_TOKEN / HF_TOKEN / HUGGINGFACE_TOKEN → config.ts lazy getters
 *   RUNPOD_API_KEY                                    → services/runpod-client.ts
 *   REGISTRY_ACCESS_TOKEN                             → services/node-authoring.ts
 *
 * DELIBERATELY EXCLUDED, though they are allowlisted and do take effect in the
 * orchestrator's own process.env immediately:
 *   GEMINI_API_KEY / GOOGLE_* — forwarded into the Gemini CLI SUBPROCESS's spawn
 *     env (gemini-backend buildAgentSpawnEnv keep-list), so a live CLI keeps the
 *     old key until it is respawned (codex gate, round 1, answer A).
 *   OPENROUTER/GLM/KIMI/… — keyed backends capture the credential at
 *     construction (#278), so a live one keeps the old key until rebuilt.
 *   RUNCOMFY_API_KEY — no reader resolves it lazily.
 * For those the receipt says a respawn is needed and reports its actual
 * disposition, rather than claiming a pickup that a running subprocess will not
 * make. Over-claiming here is exactly the #826 defect in miniature.
 */
const LIVE_RELOAD_KEYS = new Set([
  "CIVITAI_API_TOKEN",
  "HF_TOKEN",
  "HUGGINGFACE_TOKEN",
  "RUNPOD_API_KEY",
  "REGISTRY_ACCESS_TOKEN",
]);

/** True when a saved value for `key` is picked up by EVERY one of its readers
 *  without any process being respawned. Presence-only; never touches a value. */
export function hasLivePickup(key: string): boolean {
  return LIVE_RELOAD_KEYS.has(key);
}

function read(): PanelSecrets {
  const p = panelSecretsPath();
  if (!existsSync(p)) return {};
  try {
    const parsed = JSON.parse(readFileSync(p, "utf-8")) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as PanelSecrets) : {};
  } catch (err) {
    // Never echo file contents (they're secret) — just the parse failure.
    logger.warn(`[panel-secrets] could not parse ${p}: ${err instanceof Error ? err.message : String(err)}`);
    return {};
  }
}

function write(secrets: PanelSecrets): void {
  const p = panelSecretsPath();
  mkdirSync(dirname(p), { recursive: true });
  // Atomic for the same reason as the .env: an in-place truncate+write that is
  // interrupted leaves the OAuth status mirror and any legacy tokens destroyed.
  // (0600 is applied to the temp file before the rename, so the credential is
  // never briefly world-readable.)
  const durabilityGap = writeFileAtomic(p, JSON.stringify(secrets, null, 2));
  // This store has no receipt to carry the gap out on — its callers return void
  // — so it is LOGGED rather than swallowed. Never the contents: the message is
  // built from a path and an errno only.
  if (durabilityGap) logger.warn(`[panel-secrets] ${durabilityGap}`);
}

// ── Canonical env-secret store: ~/.comfyui-mcp/.env ─────────────────────────
// The SINGLE source of truth for flat API-token secrets (RUNPOD/CIVITAI/HF/…).
// config.ts loads this file into process.env at boot for BOTH the orchestrator
// and every spawned comfyui-mcp agent, so a token here reaches everywhere with
// no separate injection. (Structured OAuth login state stays in the JSON store —
// it isn't a flat KEY=value env var.) Writes are a surgical single-line upsert:
// the rest of the user's .env — comments, other keys — is preserved byte-for-byte.

/** Path to the canonical dotenv. Delegates to env-file.ts, which is the SINGLE
 *  resolver config.ts (the reader, in this process AND in the spawned comfyui
 *  child) also uses — so the file we write can never be a different file from the
 *  one the tools read (#826). */
export function envFilePath(): string {
  return comfyuiEnvFilePath();
}

/**
 * Encode a value for a .env line.
 *
 * The previous encoder used JSON.stringify, which is NOT what dotenv decodes: a
 * double-quoted dotenv value only expands \n and \r, so a credential containing
 * a quote or a backslash was written JSON-escaped and read back with the escapes
 * still in it (codex gate, round 1, finding 3). That silently stored the WRONG
 * value. Encode in a form dotenv actually reverses:
 *   - bare when the value needs no quoting at all;
 *   - single-quoted (dotenv treats these literally — no escape expansion) when
 *     the value contains no single quote and no newline;
 *   - double-quoted with \n / \r escaped otherwise, which needs the value to
 *     carry no double quote and no backslash (dotenv would not undo those).
 * `encodeEnvValue` returns null when the value cannot be represented faithfully;
 * the caller REFUSES rather than writing something that reads back different.
 */
function envValueCandidates(value: string): string[] {
  return [
    value, // bare — only survives when the value needs no quoting at all
    `'${value}'`, // single-quoted: dotenv takes these literally
    `"${value}"`, // double-quoted
    `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`, // double-quoted, escaped
  ];
}

/**
 * Build the `KEY=value` line and PROVE dotenv reads it back as the same value.
 *
 * Candidates are TRIED, not guessed: a hand-picked encoding plus a "does this
 * round-trip?" check only validates the encoding it happened to choose, so a
 * value another encoding could store faithfully would be refused for no reason
 * (codex gate, round 2, finding 5). The first candidate dotenv reverses exactly
 * wins; only if none does is the value refused — before the file is touched, and
 * without ever including the value in the error.
 */
function encodeEnvLine(key: string, value: string): string {
  // Refuse CONTROL characters outright, before any encoding is considered.
  //   - a line break: this store's upsert/remove are LINE-based, so the next
  //     save of any OTHER key would match only the value's first physical line
  //     and leave its continuation behind as garbage;
  //   - a NUL: dotenv will round-trip it happily, so the read-back would CONFIRM
  //     the save — but process.env truncates at NUL, so the value the readers and
  //     the spawned child actually get is a different, shorter string (codex
  //     gate, round 3, finding 4). A confirmed save that delivers something else
  //     is the worst outcome of all;
  //   - any other C0 control: same class of hazard, no credential contains one.
  // eslint-disable-next-line no-control-regex
  // Written with \u escapes on purpose: a literal control byte in this
  // source would make the file read as a binary blob to git, unreviewable
  // in a diff.
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(
      `The value supplied for "${key}" cannot be stored faithfully in ${envFilePath()} — it contains a control character ` +
        `(a line break, a NUL, or similar), which neither this line-based store nor a process environment can carry unchanged. Nothing was written. ` +
        `Set ${key} as a real environment variable instead (it takes precedence over the file), or re-issue it without control characters.`,
    );
  }
  for (const candidate of envValueCandidates(value)) {
    const line = `${key}=${candidate}`;
    try {
      if (dotenv.parse(line)[key] === value) return line;
    } catch {
      // Unrepresentable in this form — try the next.
    }
  }
  throw new Error(
    `The value supplied for "${key}" cannot be stored faithfully in ${envFilePath()} — ` +
      `no dotenv encoding of it reads back as the value given (this happens with combinations of quote, backslash and newline characters). ` +
      `Nothing was written. Set ${key} as a real environment variable instead (it takes precedence over the file), ` +
      `or re-issue a token without those characters.`,
  );
}

/**
 * Every line dotenv would read as an assignment to `key` — including the
 * `export KEY=…` form it accepts. Matching only `KEY=` left an `export` line
 * behind: an upsert would append a second assignment and a revoke would remove
 * the wrong one, leaving the OLD credential effective while the tool reported
 * the key cleared (codex gate, round 3, finding 2). Upsert and revoke share this
 * so they can never disagree about what "a line for this key" means.
 */
function envKeyLinePattern(key: string): RegExp {
  // Mirrors dotenv's own assignment forms: optional leading whitespace, an
  // optional `export `, then either `KEY=` (with optional space around the `=`)
  // or `KEY: ` — the colon form dotenv also accepts (codex gate, round 4,
  // finding 3). Missing the colon form meant an upsert APPENDED a second
  // assignment and a revoke left the colon line supplying the old credential.
  // The key is escaped even though every caller passes an allowlisted shell
  // identifier, so this can never become a pattern-injection surface.
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^\\s*(?:export\\s+)?${escaped}(?:\\s*=|:\\s)`);
}

/**
 * REFUSE to write the real credential store from a test run.
 *
 * `console-secrets.test.ts` drove the live /api/secrets endpoint without
 * redirecting COMFYUI_MCP_ENV_FILE, so every `npm test` overwrote the
 * developer's actual ~/.comfyui-mcp/.env — their CivitAI token became a dummy
 * and a revoke case deleted whichever slot it cleared. That ran unnoticed for
 * weeks.
 *
 * A static sweep over test sources cannot close this: a test that imports the
 * setter under an alias, or reaches a write through a helper, matches no marker
 * and passes the sweep. The RUNTIME can, because it sees the write itself
 * however the caller spelled it — so a forgotten redirect becomes a failing test
 * at the moment of the write instead of a silent overwrite (coordinator finding).
 */
function assertStoreIsRedirectedInTests(): void {
  if (!runningUnderTestRunner()) return; // detection is uncertain → ALLOW the write
  if (process.env.COMFYUI_MCP_ENV_FILE) return;
  throw new Error(
    "Refusing to write the credential store from a test run: COMFYUI_MCP_ENV_FILE is not set, " +
      `so this would write the developer's real ${comfyuiEnvFilePath()} and can destroy live tokens. ` +
      "Point COMFYUI_MCP_ENV_FILE at a temp file in the test's setup (see secret-store-test-isolation.test.ts).",
  );
}

/**
 * Are we running INSIDE the test runner?
 *
 * The first version of this guard asked `NODE_ENV === "test" || VITEST ||
 * VITEST_WORKER_ID` — ordinary environment variables that any user can have set,
 * for reasons of their own, in the shell this app was launched from. A user with
 * a leftover `VITEST` export, or `NODE_ENV=test` from an adjacent project, was
 * then REFUSED when saving their own API key (codex gate). Refusing a real user
 * their credential is a worse outcome than the accidental store overwrite this
 * guard replaced, so the guard must key off something only the runner itself
 * produces.
 *
 * Vitest injects these into the global scope of every worker it runs. They are
 * not environment variables and there is no plausible way for a user's shell to
 * put them there. When none is present we do NOT know we are under a runner —
 * and in that uncertainty the write is ALLOWED, deliberately: the failure mode
 * we accept is "a rogue test slips past the runtime guard and is caught by the
 * static sweep instead", never "a real user cannot save a token".
 *
 * `scope` is a parameter so this can be tested for what it must NOT do. Some of
 * the runner's own globals are non-configurable, so a test cannot remove them to
 * check that the answer does not fall back to `VITEST` / `NODE_ENV`; passing a
 * bare object asks the question directly.
 */
export function runningUnderTestRunner(
  scope: Record<string, unknown> = globalThis as unknown as Record<string, unknown>,
): boolean {
  return (
    "__vitest_worker__" in scope ||
    "__vitest_index__" in scope ||
    "__vitest_environment__" in scope
  );
}

/** Keys this write is ALLOWED to change. Anything else that the store carried
 *  before and does not carry after is DATA LOSS, and the caller must not report
 *  a clean save over it. */
export interface EnvWriteOutcome {
  /** The file changed on disk. */
  changed: boolean;
  /** Keys the store held BEFORE and no longer holds, other than the one this
   *  write was for. Never contains a value — names only. */
  lostKeys: string[];
  /** Non-assignment lines (comments, blanks) that did not survive the rewrite. */
  lostCommentLines: number;
  /**
   * Whether `lostKeys` is a COMPLETE account of what this write cost.
   *   "clean"   — the whole file was read back afterwards and every key it held
   *               before is accounted for.
   *   "unknown" — it is not established. Either the read-back could not be
   *               performed, or the store changed under us in a way that makes
   *               the account incomplete. NOT proof of loss — and not proof of
   *               safety either, which is the only reason it exists: an empty
   *               `lostKeys` from an account that was never taken must never be
   *               narrated as "nothing was lost".
   */
  lossCheck: "clean" | "unknown";
  /** Why `lossCheck` is "unknown" — one sentence, no values. Absent when clean. */
  lossCheckNote?: string;
  /** Null when the bytes reached the device and the rename was made durable as
   *  far as this platform allows. Otherwise a sentence naming exactly what could
   *  NOT be flushed. The write still LANDED (a rename is atomic either way); what
   *  is not established is that it survives a power loss — and an ignored fsync
   *  failure made a receipt claim exactly that (codex gate). */
  durabilityGap: string | null;
}

/** An errno for a message, without ever quoting file contents. */
function errCode(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code ?? (err instanceof Error ? err.name : "unknown error");
}

/**
 * Flush the DIRECTORY so a rename that happened is still there after a power
 * loss. `fsync` on the file makes its CONTENT durable; it says nothing about the
 * directory entry that now points at it, and a rename whose directory was never
 * synced can be lost while the temp file is gone too — leaving no file at all
 * where the store used to be. Omitting this is why "the write is durable" was a
 * claim rather than an observation (codex gate).
 *
 * Windows has no syncable directory handle: the open succeeds and `fsync`
 * answers EPERM, on every version. There is therefore nothing to attempt and
 * nothing that failed — NTFS journals the rename's own metadata. This function
 * says so by returning null there rather than reporting a durability gap on
 * every single save on that platform; what it never does is claim, anywhere,
 * that a directory sync happened when it did not.
 *
 * Returns null when there is no gap, or a sentence naming the gap.
 */
function syncDirectory(dir: string): string | null {
  if (process.platform === "win32") return null;
  let fd: number | undefined;
  try {
    fd = openSync(dir, "r");
    fsyncSync(fd);
    return null;
  } catch (err) {
    const code = errCode(err);
    // Some filesystems simply do not implement it. That is the platform's
    // answer, not a failure of this write.
    if (code === "EINVAL" || code === "ENOTSUP" || code === "EISDIR" || code === "EACCES") {
      return null;
    }
    return (
      `the rename was not made durable — syncing the directory ${dir} failed (${code}), ` +
      `so a power loss immediately after this save may leave the store without it`
    );
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* nothing to do; the sync verdict above already stands */
      }
    }
  }
}

/**
 * Rewrite the canonical .env ATOMICALLY, and prove nothing else was lost.
 *
 * The old in-place read/modify/write had two accidental failure modes on a real
 * machine, and BOTH were invisible because the read-back only checked our own
 * key (coordinator finding):
 *   - a crash or a full disk between truncate and flush left the user's whole
 *     credential store truncated — every token, not just the one being set;
 *   - two writers each read the old file and the later write silently dropped
 *     the other's newly saved key.
 * And in both cases the per-key read-back still said "yes", so we confirmed a
 * save over data loss — a fabricated success on top of destroyed credentials.
 *
 * So: write a temp file in the SAME directory, fsync it, then rename over the
 * target (rename is atomic on both POSIX and Windows, so a reader sees either
 * the whole old file or the whole new one — never a truncated one), then fsync
 * the directory so the rename itself is durable. Before the rename, re-read the
 * target and abort if it changed since we read it, which is the compare-and-swap
 * that stops a concurrent writer's key from being dropped; the caller retries
 * against the newer content. After the rename, compare the parsed keys and the
 * comment lines against what we started with, so a loss can be REPORTED rather
 * than confirmed as success.
 *
 * THE LOSS ACCOUNT IS TAKEN FROM THE FILE WE ACTUALLY REPLACED. This is the
 * part that was wrong. The compare-and-swap is a CHECK followed by a RENAME, and
 * those are two operations: a writer that lands between them is replaced by our
 * rename, and if the account is computed from the read we did EARLIER it appears
 * in neither snapshot — so its key was silently destroyed and the receipt still
 * said "saved, nothing lost" (codex gate). So immediately before the rename we
 * `link` the target to a sentinel — atomic, and it leaves the target in place —
 * and the account is computed against the SENTINEL: the content that was really
 * there at the swap. A writer that landed after the compare-and-swap check is
 * then reported as lost instead of vanishing.
 *
 * What remains unobservable is a writer landing between the `link` and the
 * `rename` — two adjacent syscalls with nothing in between. Closing even that
 * needs an OS-level lock this store does not take. So on top of the account we
 * refuse to claim it is COMPLETE whenever there is evidence of a live competitor
 * (a compare-and-swap conflict on an earlier attempt, a post-rename read that is
 * not what we wrote, or a sentinel we could not capture), which is what
 * `lossCheck` reports.
 *
 * Everything after the rename is a DISCLOSURE, never a refusal. The store has
 * already changed by then, so a failure to verify, chmod or sync must ride out
 * on the outcome. Throwing there turned a completed destructive operation into a
 * generic error the caller retried against a store that had already lost keys
 * (codex gate).
 */
function rewriteEnvFile(
  mutate: (lines: string[]) => string[] | null,
  opts: { intentionalKey?: string; removing?: boolean } = {},
): EnvWriteOutcome {
  assertStoreIsRedirectedInTests();
  const p = envFilePath();
  mkdirSync(dirname(p), { recursive: true });

  const ATTEMPTS = 5;
  // OBSERVED evidence that another process is writing this store right now. It
  // survives a successful retry on purpose: the writer we collided with a moment
  // ago can equally have landed inside this attempt's check→rename window, where
  // nothing can see it.
  let sawConcurrentWriter = false;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const existed = existsSync(p);
    const raw = existed ? readFileSync(p, "utf-8") : "";

    const next = mutate(raw.length ? raw.split(/\r?\n/) : []);
    if (next === null) {
      // Nothing to change: no rename, so nothing to account for.
      return {
        changed: false,
        lostKeys: [],
        lostCommentLines: 0,
        lossCheck: "clean",
        durabilityGap: null,
      };
    }
    const body = next.join("\n");

    const nonce = randomBytes(6).toString("hex");
    const tmp = `${p}.tmp-${process.pid}-${nonce}`;
    // The snapshot of what we REPLACE, captured at the swap itself.
    const sentinel = `${p}.pre-${process.pid}-${nonce}`;
    let sentinelTaken = false;
    /** Was there a file to replace at the moment of the swap? When there was
     *  not, "nothing was there" IS the snapshot — there is nothing to lose. */
    let targetExistedAtSwap = false;
    let fd: number | undefined;
    let durabilityGap: string | null = null;
    try {
      fd = openSync(tmp, "wx", 0o600);
      writeSync(fd, body);
      // Flush to the device before the rename: a rename that lands while the
      // bytes are still in the page cache can leave an empty file after a power
      // loss, which is the truncation this whole change exists to prevent.
      try {
        fsyncSync(fd);
      } catch (err) {
        // NOT swallowed. Proceeding is right — the rename is still atomic, so
        // the store is never left half-written — but a receipt that then says
        // "saved" over an unflushed write claims a durability nobody
        // established (codex gate). The gap rides out on the outcome instead.
        durabilityGap =
          `the new content could not be flushed to the device before the rename (fsync: ${errCode(err)}), ` +
          `so a power loss immediately after this save may leave ${p} without it`;
      }
      closeSync(fd);
      fd = undefined;

      // COMPARE-AND-SWAP: if the target changed since we read it, someone else
      // wrote in the meantime and our `next` was computed from stale content.
      // Retry against the newer file rather than clobbering their save.
      const current = existsSync(p) ? readFileSync(p, "utf-8") : "";
      if (current !== raw) {
        rmSync(tmp, { force: true });
        sawConcurrentWriter = true;
        continue;
      }
      // Capture the file we are about to replace, as late as it can be captured.
      // `link` is atomic and does NOT disturb the target, so unlike a
      // rename-aside it never leaves a moment where the store does not exist for
      // readers. Filesystems without hard links (exFAT, some network mounts) fall
      // back to a copy; if neither works the account falls back to `raw` and the
      // outcome says the swap could not be snapshotted.
      targetExistedAtSwap = existsSync(p);
      if (targetExistedAtSwap) {
        try {
          linkSync(p, sentinel);
          sentinelTaken = true;
        } catch {
          try {
            copyFileSync(p, sentinel);
            sentinelTaken = true;
          } catch {
            /* no snapshot; reported below as an incomplete account */
          }
        }
      }
      renameSync(tmp, p);
    } catch (err) {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          /* ignore */
        }
      }
      rmSync(tmp, { force: true });
      rmSync(sentinel, { force: true });
      // Still BEFORE the rename: the store is untouched, so refusing is correct
      // and the caller's "nothing was written" is true.
      throw err;
    }

    // ─── AFTER THE RENAME. The store has changed. Nothing below may throw. ───
    // The BASIS for the loss account: what was really under the rename, not what
    // we read before deciding. When the two differ, a writer landed after the
    // compare-and-swap check — the exact case that used to disappear without
    // trace, and the reason `basisRaw` exists at all.
    let basisRaw = targetExistedAtSwap ? raw : "";
    let basisIsSnapshot = !targetExistedAtSwap || sentinelTaken;
    if (sentinelTaken) {
      try {
        basisRaw = readFileSync(sentinel, "utf-8");
      } catch {
        basisIsSnapshot = false;
        basisRaw = raw;
      }
    }
    rmSync(sentinel, { force: true });
    const before = dotenvParseSafe(basisRaw);
    const beforeComments = commentLines(basisRaw);

    const dirGap = syncDirectory(dirname(p));
    if (dirGap && !durabilityGap) durabilityGap = dirGap;
    try {
      chmodSync(p, 0o600);
    } catch {
      /* chmod is a no-op on Windows; ignore */
    }

    // WHOLE-FILE verification. "Our key is present" is not enough — that is
    // exactly the check that confirmed a save while other tokens were lost.
    let afterRaw: string | null;
    try {
      afterRaw = existsSync(p) ? readFileSync(p, "utf-8") : "";
    } catch (err) {
      // The rename already happened. We cannot say what is in the store, and we
      // must not say "nothing was lost" from an account we could not take.
      return {
        changed: body !== raw,
        lostKeys: [],
        lostCommentLines: 0,
        lossCheck: "unknown",
        lossCheckNote:
          `${p} was rewritten but could not be read back afterwards (${errCode(err)}), ` +
          `so whether it still carries the other credentials it held is not established`,
        durabilityGap,
      };
    }
    const after = dotenvParseSafe(afterRaw);
    const lostKeys: string[] = [];
    for (const k of Object.keys(before)) {
      if (opts.intentionalKey && k === opts.intentionalKey) continue;
      if (!(k in after)) lostKeys.push(k);
    }
    // Verify against what we ACTUALLY WROTE, not merely against what we expected
    // to find. A file that is no longer our content means a writer landed after
    // our rename — observable, unlike the link→rename window, and it makes the
    // key account incomplete in exactly the same way.
    const raced = afterRaw !== body;
    // `lostKeys` is a COMPLETE account only when we snapshotted what we replaced
    // and nothing rewrote the file afterwards. Anything else and the empty list
    // means "we did not see any", not "there were none".
    const lossCheckNote = raced
      ? `${p} does not read back as the content this save wrote, so something else rewrote it in the meantime; ` +
        `what that write kept or dropped is not established here`
      : !basisIsSnapshot
        ? `the state this save replaced in ${p} could not be snapshotted, so the loss account rests on a read taken before the swap ` +
          `and cannot cover a write that landed after it`
        : sawConcurrentWriter
          ? `another process was writing ${p} during this save (a compare-and-swap conflict was hit and retried). ` +
            `The snapshot of the replaced state and the rename are two adjacent operations, so a write landing exactly between them ` +
            `is replaced by this one without appearing in any read — this save cannot rule that out`
          : null;
    return {
      changed: afterRaw !== raw,
      lostKeys,
      lostCommentLines: Math.max(0, beforeComments - commentLines(afterRaw)),
      lossCheck: lossCheckNote ? "unknown" : "clean",
      ...(lossCheckNote ? { lossCheckNote } : {}),
      durabilityGap,
    };
  }
  throw new Error(
    `Could not update ${p}: another process changed it during each of ${ATTEMPTS} attempts. ` +
      `Nothing was written — retry, or close whatever else is writing the credential store.`,
  );
}

/** dotenv.parse that never throws — an unreadable/garbage store yields {}. */
function dotenvParseSafe(raw: string): Record<string, string> {
  try {
    return dotenv.parse(raw);
  } catch {
    return {};
  }
}

/** How many non-empty, non-assignment lines (i.e. comments) the text carries.
 *  Used only to DETECT loss; the lines themselves are never reported. */
function commentLines(raw: string): number {
  return raw.split(/\r?\n/).filter((l) => l.trim().startsWith("#")).length;
}

/** Upsert `KEY=value` into the canonical .env, 0600, preserving every other line
 *  (comments included). Replaces the FIRST uncommented `KEY=` line and DROPS any
 *  later duplicates, else appends. Dropping the duplicates matters: dotenv lets a
 *  later assignment win, so replacing only the first would leave a stale line
 *  authoritative — the save would report a value the readers never resolve
 *  (codex gate, round 2, finding 3). The read-back would catch it, but leaving
 *  one line for the key means there is nothing to catch. */
function upsertEnvFile(key: string, value: string): EnvWriteOutcome {
  // Encode + verify BEFORE touching the file, so an unrepresentable value never
  // half-lands (it would read back different and look like tampering).
  const line = encodeEnvLine(key, value);
  const re = envKeyLinePattern(key);
  return rewriteEnvFile(
    (original) => {
      const lines: string[] = [];
      let replaced = false;
      for (const existing of original) {
        if (re.test(existing)) {
          if (!replaced) {
            lines.push(line);
            replaced = true;
          }
          continue; // a later duplicate would outrank the line we just wrote
        }
        lines.push(existing);
      }
      if (!replaced) {
        // Drop a single trailing empty line so we don't accumulate blanks, then add.
        if (lines.length && lines[lines.length - 1] === "") lines.pop();
        lines.push(line);
        lines.push("");
      }
      return lines;
    },
    { intentionalKey: key },
  );
}

/**
 * Remove EVERY uncommented assignment to `key` from the canonical .env
 * (including the `export KEY=` form dotenv honors). A revoke that leaves one
 * form behind reports the credential cleared while it is still in effect.
 *
 * This used to THROW when the rewrite also lost other keys. That inverted the
 * repo's own rule: the removal had already happened, so the throw turned a
 * COMPLETED destructive operation into a generic failure, which the console then
 * rendered as `ok:false` and the caller retried — a second removal against a
 * store that had already lost credentials (codex gate). Everything after the
 * rename is a DISCLOSURE. The loss now rides out on the outcome.
 */
function removeEnvFileKey(key: string): EnvWriteOutcome {
  const p = envFilePath();
  if (!existsSync(p)) {
    return { changed: false, lostKeys: [], lostCommentLines: 0, lossCheck: "clean", durabilityGap: null };
  }
  const re = envKeyLinePattern(key);
  return rewriteEnvFile(
    (lines) => {
      const kept = lines.filter((l) => !re.test(l));
      return kept.length === lines.length ? null : kept; // nothing to remove
    },
    { intentionalKey: key, removing: true },
  );
}

/** Legacy JSON store writer — kept atomic, and durable, for the same reasons.
 *  Returns a durability gap sentence, or null. Like the .env writer it never
 *  throws for anything that happens AFTER the rename. */
function writeFileAtomic(target: string, body: string): string | null {
  const tmp = `${target}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  let fd: number | undefined;
  let durabilityGap: string | null = null;
  try {
    fd = openSync(tmp, "wx", 0o600);
    writeSync(fd, body);
    try {
      fsyncSync(fd);
    } catch (err) {
      // Same rule as the .env writer: an ignored fsync failure is a durability
      // claim nobody checked (codex gate). Proceed, but report it.
      durabilityGap =
        `the new content could not be flushed to the device before the rename (fsync: ${errCode(err)}), ` +
        `so a power loss immediately after this write may leave ${target} without it`;
    }
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, target);
  } catch (err) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
    rmSync(tmp, { force: true });
    // Still BEFORE the rename — the target is untouched, so refusing is correct.
    throw err;
  }
  // ─── AFTER THE RENAME. Nothing below may throw. ───
  // A rename is not durable until the DIRECTORY it happened in is synced: the
  // new name can be lost while the temp name is gone too, leaving no file where
  // the store used to be. This was missing here as well as in the .env writer.
  const dirGap = syncDirectory(dirname(target));
  if (dirGap && !durabilityGap) durabilityGap = dirGap;
  try {
    chmodSync(target, 0o600);
  } catch {
    /* ignore */
  }
  return durabilityGap;
}

/** True when `key` may be persisted (union of the comfyui-tool + agent-provider
 *  allowlists — both now land in the same canonical .env). */
export function isAllowedSecretKey(key: string): boolean {
  return isAllowedComfyuiSecretKey(key) || isAllowedAgentSecretKey(key);
}

/**
 * THE canonical secret setter: persist a flat token to ~/.comfyui-mcp/.env,
 * apply it to process.env immediately (so in-process readers see it now), and
 * emit so the orchestrator re-probes provider readiness AND respawns the agent
 * on idle (the respawn reloads .env → the child gets the new key). Rejects a
 * non-allowlisted key so a stray key can never be written.
 */
export function setEnvSecret(
  key: string,
  value: string,
  opts: { requested?: boolean; tabId?: string } = {},
): SecretSaveReceipt {
  const trimmed = key.trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) {
    throw new Error(`Invalid env var name "${key}" — use a valid shell identifier.`);
  }
  if (!isAllowedSecretKey(trimmed)) {
    throw new Error(
      `Env var "${trimmed}" is not an accepted secret. Allowed: ${[...new Set([...COMFYUI_SECRET_ENV_ALLOWLIST, ...AGENT_SECRET_ENV_ALLOWLIST])].join(", ")}.`,
    );
  }
  if (value.trim() === "") {
    // A blank/whitespace-only value WRITES and READS BACK fine, so the save
    // would be confirmed — while every reader (freshSecretValue) treats a blank
    // as absent and every request stays unauthenticated. That is precisely the
    // #826 shape: a confirmed save nothing downstream can use (codex gate,
    // round 2, finding 1). Refuse it up front; nothing is written.
    throw new Error(
      `No value was supplied for "${trimmed}" (it was empty or whitespace only). Nothing was saved — the credential is still unset.`,
    );
  }
  const previous = process.env[trimmed];
  const previouslyShellProvided = isShellProvided(trimmed);
  const writeOutcome = upsertEnvFile(trimmed, value);
  // A REAL environment variable outranks the store — that is this codebase's own
  // rule, and the panel does not get to break it. Overwriting process.env here
  // (and calling markFileDerived on it) replaced the live shell value AND
  // relabelled its provenance, so behaviour changed again after a full restart
  // when the shell value came back (coordinator finding). The value IS written
  // to the store, so it takes effect the moment the env var is unset; until then
  // the receipt says plainly that it is not the value in use.
  if (!previouslyShellProvided) {
    process.env[trimmed] = value; // live in-process effect
    // The canonical file is now this key's AUTHORITY even though we just assigned
    // process.env, so a later re-read (a rotate by another process, a revoke) wins
    // over this in-memory copy instead of being pinned by it.
    markFileDerived(trimmed);
  }
  // VERIFY the write by reading the canonical file back. Reporting "saved" from
  // the mere absence of a throw is how a caller ends up believing it is
  // configured while nothing downstream can see the value (#826). The comparison
  // is against the value we already hold; neither the stored nor the supplied
  // value is logged, and only the verdict leaves this function.
  //
  // ORDER MATTERS. "yes" is the verdict for a save that is BOTH proven and
  // clean, so every weaker outcome has to be able to displace it:
  //   - the store unreadable            → unknown (nothing established)
  //   - the key not carrying the value  → no
  //   - other credentials proven gone   → damaged (worse than unknown; say so)
  //   - the loss account not completed  → unknown (an empty lostKeys from an
  //                                       account never taken is not "nothing
  //                                       was lost")
  const readBack = parseEnvFile();
  let persisted: SecretSaveReceipt["persisted"];
  let uncertainty: string | undefined;
  if (readBack === null) {
    persisted = "unknown";
    uncertainty = `${envFilePath()} could not be read back, so whether the value reached the store is not established`;
  } else if (readBack[trimmed] !== value) {
    persisted = "no";
  } else if (writeOutcome.lostKeys.length) {
    persisted = "damaged";
  } else if (writeOutcome.lossCheck === "unknown") {
    persisted = "unknown";
    uncertainty =
      `${trimmed} does read back from ${envFilePath()} with the value supplied, but this save cannot account for the rest of the store: ` +
      `${writeOutcome.lossCheckNote ?? "the whole-file check could not be completed"}`;
  } else {
    persisted = "yes";
  }
  if (persisted === "no") {
    // The durable store demonstrably does not carry this value. ROLL BACK the
    // in-process assignment and emit NOTHING, so the system is left exactly as it
    // was and the caller's "nothing is configured" is TRUE (codex gate, round 1,
    // finding 2: without this, the value was live in the orchestrator's env — and
    // would be injected into the next child — while the tool reported failure,
    // the opposite false verdict).
    if (previous === undefined) delete process.env[trimmed];
    else process.env[trimmed] = previous;
    // Restore the key's PRECEDENCE too — leaving it marked file-derived would
    // change how the restored value resolves from here on (codex gate, round 2,
    // finding 3).
    if (previouslyShellProvided) unmarkFileDerived(trimmed);
    return {
      key: trimmed,
      path: envFilePath(),
      persisted,
      ...(uncertainty ? { uncertainty } : {}),
      livePickup: hasLivePickup(trimmed),
      respawn: null,
      // The store may ALSO have lost other keys on the way to not saving this
      // one. That is the same disclosure as on any other verdict, and dropping
      // it here because the headline is already a refusal would hide the worse
      // half of what happened.
      ...(writeOutcome.lostKeys.length ? { lostKeys: writeOutcome.lostKeys } : {}),
      ...(writeOutcome.lostCommentLines ? { lostCommentLines: writeOutcome.lostCommentLines } : {}),
      ...(writeOutcome.durabilityGap ? { durabilityGap: writeOutcome.durabilityGap } : {}),
      // Whether a credential for this key is STILL in effect after the rollback.
      // "Nothing is configured" is false when a previous working value survived,
      // and telling the user that would send them hunting the wrong problem.
      // Presence only — the value is neither returned nor logged.
      stillConfigured: freshSecretValue(trimmed) !== undefined,
    };
  }
  // Only a COMFYUI tool secret should restart the comfyui MCP child + inject the
  // "retry the download that needed this token" nudge (#269): saving an
  // agent-ONLY provider key (OPENROUTER/GLM/KIMI…) previously restarted every
  // agent with that nonsensical download-retry message. Agent-only keys fire
  // just "agentChange" (readiness/model refresh) below.
  // `requested` rides the change so the orchestrator only injects the retry
  // nudge when this save ANSWERS an outstanding panel_request_secret — a
  // Settings slot save / background reload / revoke leaves it false (#164).
  // Collect what listeners actually did. `emit` is SYNCHRONOUS, so every report
  // has landed by the time this returns — the receipt describes observed work,
  // not an intention. No listener → `respawn: null`, never a fabricated zero.
  const reports: SecretRespawnReport[] = [];
  if (isAllowedComfyuiSecretKey(trimmed))
    emitComfyuiChange({
      requested: opts.requested === true,
      tabId: opts.tabId,
      report: (r: SecretRespawnReport) => reports.push(r),
    });
  if (isAllowedAgentSecretKey(trimmed)) emitAgentChange(); // flip provider readiness live
  return {
    key: trimmed,
    path: envFilePath(),
    persisted,
    ...(uncertainty ? { uncertainty } : {}),
    livePickup: hasLivePickup(trimmed),
    ...(previouslyShellProvided ? { shadowedByEnv: true } : {}),
    ...(writeOutcome.lostKeys.length ? { lostKeys: writeOutcome.lostKeys } : {}),
    // Computed by the writer and, until now, dropped on the floor right here —
    // so a rewrite that lost the user's comments was acknowledged as a healthy
    // save on every consumer path while the code claimed it preserved them
    // (codex gate).
    ...(writeOutcome.lostCommentLines ? { lostCommentLines: writeOutcome.lostCommentLines } : {}),
    ...(writeOutcome.durabilityGap ? { durabilityGap: writeOutcome.durabilityGap } : {}),
    respawn: reports.length
      ? reports.reduce(
          (a, b) => ({
            live: a.live + b.live,
            applied: a.applied + b.applied,
            scheduled: a.scheduled + b.scheduled,
          }),
          { live: 0, applied: 0, scheduled: 0 },
        )
      : null,
  };
}

/**
 * What a removal actually did. A revoke is DESTRUCTIVE, so it returns the same
 * account a save does: a boolean cannot carry "and it also lost your other
 * tokens", and the version that threw that fact instead turned a completed
 * removal into a retryable-looking failure (codex gate).
 */
export interface SecretRemoveOutcome {
  /** Something changed: a store line removed, the in-process copy dropped, or a
   *  legacy JSON entry purged. */
  changed: boolean;
  /** OTHER credential keys the store held before and no longer holds. Names
   *  only. Non-empty means the revoke happened AND cost something else. */
  lostKeys: string[];
  /** Comment lines the rewrite did not preserve. */
  lostCommentLines: number;
  /** Present when the removal's whole-file account could not be completed —
   *  `lostKeys` is then not a statement that nothing else was lost. */
  uncertainty?: string;
  /** Present when the removal LANDED but was not established to survive a power
   *  loss. */
  durabilityGap?: string;
}

/** Canonical remover: drop a token from .env + process.env + emit. Also PURGES
 *  the legacy panel-secrets.json maps (#269): without this a key revoked from
 *  .env would RESURRECT on the next boot, because migrateSecretsToEnv() re-adds
 *  any key still present in the JSON store that .env no longer provides. */
export function removeEnvSecret(key: string): SecretRemoveOutcome {
  const outcome = removeEnvFileKey(key);
  const removed = outcome.changed;
  // Dropping the IN-PROCESS value is a change in its own right. A SHELL-provided
  // key has no line in the store, so `removed` is false — and gating the emit on
  // `removed` alone meant no child was ever respawned for it, leaving a live
  // tool session using a credential the user had just revoked while the console
  // answered that it no longer resolves (codex gate, round 6, finding 1). The
  // respawn is what actually takes it out of the child's env.
  const envDeleted = process.env[key] !== undefined;
  if (envDeleted) delete process.env[key];
  // Purge the legacy JSON maps so a revoked key can't resurrect via migration.
  const s = read();
  let purgedJson = false;
  for (const map of [s.comfyuiEnv, s.agentEnv]) {
    if (map && Object.prototype.hasOwnProperty.call(map, key)) {
      delete map[key];
      purgedJson = true;
    }
  }
  if (purgedJson) write(s);
  const changed = removed || purgedJson || envDeleted;
  if (changed) {
    if (isAllowedComfyuiSecretKey(key)) emitComfyuiChange({}); // comfyui-only restart (#269)
    if (isAllowedAgentSecretKey(key)) emitAgentChange();
  }
  return {
    changed,
    lostKeys: outcome.lostKeys,
    lostCommentLines: outcome.lostCommentLines,
    ...(outcome.lossCheck === "unknown"
      ? {
          uncertainty:
            outcome.lossCheckNote ??
            `the whole-file check could not be completed, so whether removing "${key}" cost anything else is not established`,
        }
      : {}),
    ...(outcome.durabilityGap ? { durabilityGap: outcome.durabilityGap } : {}),
  };
}

/**
 * One-time migration to the canonical .env: any flat token still living in the
 * legacy panel-secrets.json (comfyuiEnv / agentEnv) is upserted into .env unless
 * .env / a real env var already provides it. NON-DESTRUCTIVE — it only ADDS
 * missing keys; it never rewrites unrelated .env lines and never deletes from the
 * JSON store (left inert). Idempotent. Returns the keys migrated.
 */
export function migrateSecretsToEnv(): string[] {
  const s = read();
  const migrated: string[] = [];
  for (const map of [s.comfyuiEnv, s.agentEnv]) {
    if (!map || typeof map !== "object") continue;
    for (const [k, v] of Object.entries(map)) {
      if (typeof v !== "string" || !v) continue;
      if (!isAllowedSecretKey(k)) continue;
      if (process.env[k]) continue; // .env / real env already wins
      upsertEnvFile(k, v);
      process.env[k] = v;
      // The canonical file is this value's AUTHORITY now — it lives there. Without
      // the mark it would read as SHELL-provided, so buildComfyuiMcpEnv would
      // inject it to the child unmarked and the child would pin it: a later
      // rotate or revoke invisible to that child while the save reports live
      // pickup (codex gate, round 3, finding 1).
      markFileDerived(k);
      migrated.push(k);
    }
  }
  return migrated;
}

// SANITIZE on every write: copy only the five known status fields and coerce
// their types. Even a hand-edited or corrupt panel-secrets.json therefore can
// never inject anything beyond this shape into the mirror — critically, it
// can never smuggle in token material via an unexpected key.
function sanitizeOAuthStatus(rec: OAuthStatusRecord): OAuthStatusRecord {
  const out: OAuthStatusRecord = {
    provider: String(rec?.provider ?? "").trim(),
    account_label: String(rec?.account_label ?? "").trim(),
    obtained_at:
      typeof rec?.obtained_at === "number" && Number.isFinite(rec.obtained_at)
        ? rec.obtained_at
        : Date.now(),
  };
  if (typeof rec?.expires_at === "number" && Number.isFinite(rec.expires_at)) {
    out.expires_at = rec.expires_at;
  }
  if (typeof rec?.experimental === "boolean") {
    out.experimental = rec.experimental;
  }
  return out;
}

/** Upsert the status-only OAuth mirror entry for `rec.provider`. Sanitizes the
 *  record first (see `sanitizeOAuthStatus`) — callers pass status fields only,
 *  never token material. */
export function setOAuthStatus(rec: OAuthStatusRecord): void {
  const sanitized = sanitizeOAuthStatus(rec);
  if (!sanitized.provider) throw new Error("setOAuthStatus: record is missing a provider id.");
  const secrets = read();
  const status =
    secrets.oauthStatus && typeof secrets.oauthStatus === "object" ? secrets.oauthStatus : {};
  status[sanitized.provider] = sanitized;
  secrets.oauthStatus = status;
  write(secrets);
}

/** All stored OAuth status records (re-sanitized on read, defense in depth). */
export function listOAuthStatus(): OAuthStatusRecord[] {
  const status = read().oauthStatus;
  if (!status || typeof status !== "object") return [];
  return Object.values(status).map(sanitizeOAuthStatus);
}

/** Remove a provider's status mirror entry. No-op if absent. */
export function clearOAuthStatus(provider: string): void {
  const secrets = read();
  const status = secrets.oauthStatus;
  if (!status || typeof status !== "object" || !(provider in status)) return;
  delete status[provider];
  secrets.oauthStatus = status;
  write(secrets);
}

/** The persisted env vars to inject into the comfyui MCP server. Never logged.
 *  FILTERED through the allowlist (defense in depth): even a hand-edited/corrupt
 *  panel-secrets.json can only ever contribute allowlisted credential keys. */
export function loadComfyuiSecretEnv(): Record<string, string> {
  // Resolved through the env-file snapshot, allowlist-filtered: a real env var
  // still wins, otherwise the canonical .env is re-read NOW. Reading raw
  // process.env here would inject a value that went stale when another writer
  // rotated the file, and the child would then pin that stale copy (codex gate,
  // round 2, finding 2). ONE snapshot for all keys, so a rotation landing
  // mid-build cannot produce a half-old/half-new env (round 4, finding 6).
  return freshSecretValues(COMFYUI_SECRET_ENV_ALLOWLIST);
}

/** The env-var KEYS currently stored (e.g. for a redacted log line). No values. */
export function comfyuiSecretKeys(): string[] {
  return Object.keys(loadComfyuiSecretEnv());
}

/**
 * Persist a secret as an env var for the built-in comfyui MCP server, then emit
 * a change so the orchestrator re-injects it and respawns the server. `value` is
 * the raw secret (the caller already applied any prefix); it is never logged.
 */
export function setComfyuiSecret(
  key: string,
  value: string,
  opts: { requested?: boolean; tabId?: string } = {},
): SecretSaveReceipt {
  const trimmed = key.trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) {
    throw new Error(`Invalid env var name "${key}" — use a valid shell identifier (letters, digits, underscore).`);
  }
  if (!isAllowedComfyuiSecretKey(trimmed)) {
    // SECURITY: never let an arbitrary key reach the comfyui Node child's env.
    throw new Error(
      `Env var "${trimmed}" is not an accepted comfyui tool secret. Allowed: ${COMFYUI_SECRET_ENV_ALLOWLIST.join(", ")}.`,
    );
  }
  // `opts.requested` is set ONLY by panel_request_secret (an agent-driven token
  // ask) so the orchestrator can nudge "retry the action"; the Settings slot
  // save path (setPanelSecret) omits it → no spurious nudge (#164).
  return setEnvSecret(trimmed, value, opts); // canonical store = ~/.comfyui-mcp/.env
}

/** Remove a stored comfyui secret. Returns false if absent. Emits on removal. */
export function removeComfyuiSecret(key: string): SecretRemoveOutcome {
  return removeEnvSecret(key);
}

/** The persisted agent-provider secrets (e.g. OPENROUTER_API_KEY), filtered
 *  through the agent allowlist. Never logged. */
export function loadAgentSecretEnv(): Record<string, string> {
  // Same access-time resolution as loadComfyuiSecretEnv, from one snapshot: env
  // wins, else the canonical .env re-read now, so the readiness/masked-slot
  // views never report a value the file no longer carries.
  return freshSecretValues(AGENT_SECRET_ENV_ALLOWLIST);
}

/**
 * Copy stored agent secrets into process.env so every in-process reader
 * (openrouterDeps, backendReadiness, the ollama key fallback) sees one source
 * of truth. An EXPLICIT env value WINS — the shell/.env stays the escape hatch;
 * the store only fills what env didn't provide. Called at orchestrator startup
 * and whenever an agent secret changes. Returns the keys it hydrated.
 */
export function hydrateAgentSecretsIntoEnv(): string[] {
  // Canonical secrets already come from ~/.comfyui-mcp/.env (dotenv at boot). This
  // now performs the one-time, non-destructive migration of any legacy tokens
  // still in panel-secrets.json into .env, so everything converges to one place.
  // Idempotent — a no-op once migrated. (Kept this name so the boot/agent-change
  // callers are unchanged.)
  return migrateSecretsToEnv();
}

/** Subscribe to "an agent provider secret changed". Returns an unsubscribe fn. */
export function onAgentSecretsChanged(cb: () => void): () => void {
  emitter.on("agentChange", cb);
  return () => {
    emitter.off("agentChange", cb);
  };
}

/**
 * Persist an agent-provider secret (e.g. OPENROUTER_API_KEY) to the 0600 store
 * and hydrate it into process.env immediately, then emit so the orchestrator
 * re-probes readiness / re-pushes the model list. Rejects non-allowlisted keys.
 */
export function setAgentSecret(key: string, value: string): SecretSaveReceipt {
  const trimmed = key.trim();
  if (!isAllowedAgentSecretKey(trimmed)) {
    throw new Error(
      `Env var "${trimmed}" is not an accepted agent secret. Allowed: ${AGENT_SECRET_ENV_ALLOWLIST.join(", ")}.`,
    );
  }
  return setEnvSecret(trimmed, value); // canonical store = ~/.comfyui-mcp/.env
}

/** Remove a stored agent secret. Returns false if absent. Also drops it from
 *  process.env (setAgentSecret put it there — a revoked key must stop applying
 *  NOW, not on the next restart). Emits on removal. */
export function removeAgentSecret(key: string): SecretRemoveOutcome {
  return removeEnvSecret(key);
}

/**
 * Build the comfyui MCP server's spawn env: the orchestrator's `base` env
 * (COMFYUI_URL, progress dir, COMFYUI_PATH…) MERGED with the persisted tool
 * secrets. Secrets win over base on a key clash (a user-supplied token overrides
 * any inherited default). This is THE single env-builder both provider paths
 * (Claude in-process + Codex stdio) use, so a saved secret reaches either.
 */
export function buildComfyuiMcpEnv(base: Record<string, string>): Record<string, string> {
  const secrets = loadComfyuiSecretEnv();
  // Which of the injected credentials does the canonical FILE own? Those must be
  // marked so the child treats its inherited copy as file-derived and a later
  // rotate/revoke supersedes it (codex gate, round 1, finding 1). Only a
  // SHELL-provided key — a real environment variable, the escape hatch — is left
  // unmarked, so the child keeps pinning it. Provenance, not a value comparison:
  // a value that merely went stale because another writer rotated the file is
  // still file-owned (codex gate, round 2, finding 2).
  const managed = Object.keys(secrets).filter((k) => !isShellProvided(k));
  const out: Record<string, string> = {
    ...base,
    // PIN the canonical dotenv path into the child (#826). The child resolves
    // credentials from that file at access time, so if the orchestrator writes
    // to a non-default path (COMFYUI_MCP_ENV_FILE) while the child resolves the
    // default one, a saved token is written to a file nothing reads — a "saved
    // successfully" that the tools can never see. Forwarding the override makes
    // writer and reader the same file by construction. Not a secret: a path.
    ...(process.env.COMFYUI_MCP_ENV_FILE
      ? { COMFYUI_MCP_ENV_FILE: process.env.COMFYUI_MCP_ENV_FILE }
      : {}),
    // KEY NAMES only — never values.
    ...(managed.length ? { [MANAGED_SECRET_KEYS_ENV]: managed.join(",") } : {}),
    ...secrets,
  };
  // The RESOLVER is authoritative for the WHOLE allowlist, not just for the keys
  // it happens to supply. Object spreading can only add and overwrite — it can
  // never REMOVE — so a credential the caller copied into `base` from raw
  // process.env survived an external revoke that `loadComfyuiSecretEnv` had
  // correctly dropped, and the next child inherited the stale token unmarked and
  // treated it as a real env override (coordinator finding). Deleting what the
  // resolver did not provide makes a revoke actually revoke, by construction.
  for (const key of COMFYUI_SECRET_ENV_ALLOWLIST) {
    if (!(key in secrets)) delete out[key];
  }
  return out;
}

// ── Agent-provider spawn env (tool-secret scoping) ───────────────────────────
// Tool secrets (RunPod/HF/CivitAI/RunComfy/Registry tokens…) live in process.env
// because config.ts loads ~/.comfyui-mcp/.env at boot and setEnvSecret applies
// live. That is CORRECT for the comfyui tool child (buildComfyuiMcpEnv), but the
// agent-provider subprocesses (Codex app-server, Gemini/Grok CLI…) must NEVER
// inherit them — a tool credential has no business in an LLM vendor's process.
// buildAgentSpawnEnv is the single spawn-env builder those backends use: a copy
// of process.env with every TOOL-ONLY secret key stripped.

/** Secret env keys that are TOOL-only (comfyui allowlist minus agent allowlist)
 *  — these must never reach an agent-provider subprocess's env. */
export const TOOL_ONLY_SECRET_ENV_KEYS: readonly string[] =
  COMFYUI_SECRET_ENV_ALLOWLIST.filter((k) => !AGENT_ALLOWLIST_SET.has(k));

/**
 * Build the env an AGENT-PROVIDER subprocess (Codex/Gemini/Grok CLI…) spawns
 * with: `base` (default process.env) with all tool-only secret keys removed.
 * `keep` re-admits specific keys when they double as the provider's OWN
 * credential (e.g. GEMINI_API_KEY for the Gemini CLI — same vendor, not a leak).
 */
export function buildAgentSpawnEnv(
  base: NodeJS.ProcessEnv = process.env,
  opts: { keep?: readonly string[] } = {},
): NodeJS.ProcessEnv {
  const keep = new Set(opts.keep ?? []);
  const out: NodeJS.ProcessEnv = { ...base };
  for (const k of TOOL_ONLY_SECRET_ENV_KEYS) {
    if (!keep.has(k)) delete out[k];
  }
  return out;
}

export interface CredentialSlot {
  id: string;
  label: string;
  envKeys: string[];
  store: "comfyui" | "agent";
  help?: string;
}

/** UI credential slots. Each slot writes ALL its envKeys (alias fan-out) into its
 *  store. `store` decides which allowlist/setter applies. */
export const CREDENTIAL_SLOTS: CredentialSlot[] = [
  { id: "openrouter", label: "OpenRouter", envKeys: ["OPENROUTER_API_KEY"], store: "agent", help: "Hosted models (MiMo, MiniMax, GPT, Claude…)" },
  // The simple api-key providers (glm/kimi/moonshot) are DERIVED from the
  // openai-provider-registry — one entry there feeds its slot here automatically.
  ...OPENAI_KEY_PROVIDERS.map(
    (p): CredentialSlot => ({
      id: p.id,
      label: p.slotLabel,
      envKeys: p.envKeys,
      store: "agent",
      // Append the generated model hint so the card says which model the
      // provider is actually on and how to change it — the override env var
      // existed but was invisible outside the source.
      help: `${p.slotHelp} · ${providerModelHint(p)}`,
    }),
  ),
  { id: "civitai", label: "Civitai", envKeys: ["CIVITAI_API_TOKEN"], store: "comfyui", help: "Model downloads" },
  { id: "huggingface", label: "HuggingFace", envKeys: ["HF_TOKEN", "HUGGINGFACE_TOKEN"], store: "comfyui", help: "Model downloads" },
  { id: "google", label: "Google / Gemini", envKeys: ["GEMINI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "GOOGLE_API_KEY"], store: "comfyui", help: "Nano Banana concept images" },
  { id: "runcomfy", label: "RunComfy", envKeys: ["RUNCOMFY_API_KEY"], store: "comfyui", help: "Cloud pods / training" },
  { id: "runpod", label: "RunPod", envKeys: ["RUNPOD_API_KEY"], store: "comfyui", help: "Manage GPU pods (status/start/stop/connect)" },
  { id: "registry", label: "Comfy Registry", envKeys: ["REGISTRY_ACCESS_TOKEN"], store: "comfyui", help: "Publishing custom nodes" },
];

const SLOT_BY_ID = new Map(CREDENTIAL_SLOTS.map((s) => [s.id, s]));

/** Mask a secret for display: first 4 + ellipsis + last 3. Short values fully masked. */
export function maskSecret(v: string): string {
  if (v.length <= 8) return "•".repeat(v.length);
  return `${v.slice(0, 4)}…${v.slice(-3)}`;
}

/** The OBSERVED outcome of a slot save across all of the slot's alias keys. */
export interface SlotSaveOutcome {
  slot: string;
  receipts: SecretSaveReceipt[];
  /** Every alias landed, proven by read-back. */
  confirmed: boolean;
  /** The slot was left exactly as it was before this call (no alias carries the
   *  new value). Only meaningful when `confirmed` is false. */
  rolledBack: boolean;
  /** Aliases PROVEN to still carry the NEW value despite the overall failure,
   *  because restoring them did not take effect. Non-empty means the slot is in a
   *  MIXED state and the caller must say so — claiming "nothing was
   *  half-applied" over this is the round-4 defect. */
  strandedKeys: string[];
  /** Aliases whose restore could NOT be verified either way (the store went
   *  unreadable). Neither proven restored nor proven stranded — the caller must
   *  say so rather than pick one (codex gate, round 5, finding 2). */
  unverifiedKeys: string[];
  /** OTHER credential keys the store lost while this slot was being written.
   *  Aggregated from the receipts so no consumer has to know that receipts carry
   *  it. Non-empty ⇒ `confirmed` is false, by construction: a receipt that
   *  carries lost keys has `persisted: "damaged"`, and `confirmed` is derived
   *  from `persisted === "yes"`. */
  lostKeys: string[];
}

/**
 * Set every env key of a slot (alias fan-out) into its store.
 *
 * ALL-OR-NOTHING across the aliases. The fan-out is serial, so a slot like
 * HuggingFace could land HF_TOKEN and then fail on HUGGINGFACE_TOKEN — leaving
 * the first alias live and effective while the caller reported failure and said
 * nothing was half-applied (codex gate, round 4, finding 1). On any failure the
 * aliases this call changed are restored to their previous values, and any that
 * could NOT be restored are reported as stranded rather than glossed over.
 *
 * Throws on unknown slot, and re-throws a per-key validation failure (a control
 * character, an unrepresentable value) AFTER restoring — so the caller still
 * gets the specific reason.
 */
export function setPanelSecret(slotId: string, value: string): SlotSaveOutcome {
  const slot = SLOT_BY_ID.get(slotId);
  if (!slot) throw new Error(`unknown credential slot "${slotId}"`);
  const before = slot.envKeys.map((key) => ({
    key,
    previous: freshSecretValue(key),
    // Provenance matters for the restore: writing a SHELL-provided value back
    // through the setter would persist it into the store and mark it
    // file-derived — restoring the text while silently changing where the value
    // lives and how it resolves (codex gate, round 5, finding 2).
    wasShellProvided: isShellProvided(key),
  }));

  const receipts: SecretSaveReceipt[] = [];
  let thrown: unknown = null;
  let failed = false;
  let damaged = false;
  let strandedKeys: string[] = [];
  let unverifiedKeys: string[] = [];
  /** Aggregated once, here, so no consumer of a slot save has to reach into the
   *  receipts to learn that the store lost credentials. */
  const lostKeysOf = (rs: SecretSaveReceipt[]) => [
    ...new Set(rs.flatMap((r) => r.lostKeys ?? [])),
  ];

  const outcome = withSuspendedEmissions(
    (): SlotSaveOutcome => {
      for (const key of slot.envKeys) {
        try {
          const receipt = setEnvSecret(key, value);
          receipts.push(receipt);
          if (receipt.persisted === "damaged") {
            // The store lost OTHER credentials. Stop the fan-out — but do NOT
            // roll back: a rollback cannot bring the lost keys back, and it is
            // one more destructive rewrite of a store already known to be
            // damaged. What the user needs is the truth about the state we are
            // in, not another write on top of it.
            damaged = true;
            break;
          }
          if (receipt.persisted !== "yes") {
            // "unknown" is not a proven failure, but it is not a proven success
            // either — stop rather than layering more unverified writes on it.
            failed = true;
            break;
          }
        } catch (err) {
          thrown = err;
          failed = true;
          break;
        }
      }
      if (damaged) {
        return {
          slot: slotId,
          receipts,
          // Derived from the receipts, so a damaged one can never read as
          // confirmed anywhere: `slotSaveConfirmed` is this field.
          confirmed: false,
          rolledBack: false,
          strandedKeys: [],
          unverifiedKeys: [],
          lostKeys: lostKeysOf(receipts),
        };
      }
      if (!failed) {
        return {
          slot: slotId,
          receipts,
          confirmed: true,
          rolledBack: false,
          strandedKeys: [],
          unverifiedKeys: [],
          lostKeys: [],
        };
      }
      // Restore every alias this call actually changed, and PROVE each restore
      // from the store rather than from freshSecretValue — which falls back to
      // the in-process copy when the store is unreadable and would therefore
      // "confirm" a restore that never reached disk.
      for (const { key, previous, wasShellProvided } of before) {
        const state = restoreEnvKey(key, previous, wasShellProvided);
        if (state === "stranded") strandedKeys.push(key);
        else if (state === "unverified") unverifiedKeys.push(key);
      }
      return {
        slot: slotId,
        receipts,
        confirmed: false,
        rolledBack: strandedKeys.length === 0 && unverifiedKeys.length === 0,
        strandedKeys,
        unverifiedKeys,
        lostKeys: lostKeysOf(receipts),
      };
    },
    (result) => {
      // Emit ONCE, for the state actually left. A save that failed and was fully
      // rolled back changed nothing, so it must not respawn anything.
      const changed = !!result && (result.confirmed || !result.rolledBack);
      if (!changed) return {};
      // Keyed off the SLOT, not off whether a per-key emit happened to be
      // suppressed during the fan-out: a proven-failed write returns before
      // emitting, so a slot left partially STRANDED would suppress nothing and
      // therefore emit nothing — leaving a child that needs a respawn to see the
      // change running on its old spawn env until something unrelated restarted
      // it (codex gate, final round).
      return {
        comfyui: slot.store === "comfyui" ? {} : false,
        agent: slot.store === "agent",
      };
    },
  );
  if (thrown) {
    if (strandedKeys.length || unverifiedKeys.length) {
      const mixed = [...strandedKeys, ...unverifiedKeys];
      throw new Error(
        `${thrown instanceof Error ? thrown.message : String(thrown)} ` +
          `Restoring the slot could not be confirmed for ${mixed.join(", ")}, so it may be in a MIXED state. ` +
          `Set "${slotId}" again, or clear it, before relying on it.`,
      );
    }
    throw thrown;
  }
  return outcome;
}

/**
 * Put one alias key back to its pre-save state, and say whether that is PROVEN.
 *   "restored"   — the store agrees the key is back to `previous`.
 *   "stranded"   — the store proves it still carries the new value.
 *   "unverified" — the store could not be read, so neither is established.
 * Never collapses "unverified" into either verdict.
 */
function restoreEnvKey(
  key: string,
  previous: string | undefined,
  wasShellProvided: boolean,
): "restored" | "stranded" | "unverified" {
  // Already as it was? Then this call never changed it — rewriting would be a
  // pointless write that can itself fail and manufacture a "stranded" verdict
  // for a key that was never touched.
  const current = parseEnvFile();
  if (current !== null) {
    const wanted = wasShellProvided || previous === undefined ? undefined : previous;
    if (current[key] === wanted) {
      // Keep the in-process copy AND the provenance in step with the store.
      // Both directions matter: a shell value must stop being file-owned, and a
      // value the FILE supplies must be marked file-owned — otherwise a key the
      // file gained after boot would be treated as a real env override from here
      // on, and a later legitimate rotation of that file entry would be masked
      // (codex gate, round 10).
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
      if (wasShellProvided) unmarkFileDerived(key);
      else if (previous !== undefined) markFileDerived(key);
      return "restored";
    }
  }
  try {
    if (wasShellProvided) {
      // The value belongs to the ENVIRONMENT, not to the store: drop whatever we
      // wrote and hand precedence back, rather than persisting a shell secret.
      removeEnvFileKey(key);
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
      unmarkFileDerived(key);
    } else if (previous === undefined) {
      removeEnvSecret(key);
    } else {
      setEnvSecret(key, previous);
    }
  } catch {
    return "stranded";
  }
  const parsed = parseEnvFile();
  if (parsed === null) return "unverified";
  const inStore = parsed[key];
  if (wasShellProvided) return inStore === undefined ? "restored" : "stranded";
  if (previous === undefined) return inStore === undefined ? "restored" : "stranded";
  return inStore === previous ? "restored" : "stranded";
}

/** True when EVERY key of a slot save is proven to have landed. A single alias
 *  that did not persist means the slot is not reliably configured — the reader
 *  that happens to consult that alias would find nothing. */
export function slotSaveConfirmed(outcome: SlotSaveOutcome): boolean {
  return outcome.confirmed;
}

/** The keys of a slot save whose persistence could NOT be confirmed, with their
 *  verdict — for an honest answer that names what is uncertain. No values. */
export function unconfirmedSlotKeys(
  receipts: SecretSaveReceipt[],
): { key: string; persisted: SecretSaveReceipt["persisted"] }[] {
  return receipts
    .filter((r) => r.persisted !== "yes")
    .map((r) => ({ key: r.key, persisted: r.persisted }));
}

/** Clear a slot: remove EVERY env key (alias fan-out, mirroring setPanelSecret)
 *  from its store. Throws on unknown slot — that is a refusal BEFORE anything is
 *  removed, which is the only place a refusal belongs on this path. Everything
 *  the removals cost is DISCLOSED in the returned outcome instead.
 *  This is the revoke path (issue #203) — without it a saved key could only be
 *  overwritten, never removed, short of hand-editing panel-secrets.json. */
export function clearPanelSecret(slotId: string): SecretRemoveOutcome {
  const slot = SLOT_BY_ID.get(slotId);
  if (!slot) throw new Error(`unknown credential slot "${slotId}"`);
  const remove = slot.store === "agent" ? removeAgentSecret : removeComfyuiSecret;
  let changed = false;
  const lostKeys = new Set<string>();
  let lostCommentLines = 0;
  const uncertainties: string[] = [];
  let durabilityGap: string | undefined;
  for (const key of slot.envKeys) {
    const out = remove(key);
    changed = out.changed || changed;
    // A key this fan-out itself removes is not collateral — the aliases of one
    // slot are all being cleared on purpose.
    for (const k of out.lostKeys) if (!slot.envKeys.includes(k)) lostKeys.add(k);
    lostCommentLines += out.lostCommentLines;
    if (out.uncertainty) uncertainties.push(out.uncertainty);
    if (out.durabilityGap && !durabilityGap) durabilityGap = out.durabilityGap;
  }
  return {
    changed,
    lostKeys: [...lostKeys],
    lostCommentLines,
    ...(uncertainties.length ? { uncertainty: uncertainties.join(" ") } : {}),
    ...(durabilityGap ? { durabilityGap } : {}),
  };
}

/** Whether a slot still resolves to a credential — read AFTER a revoke to prove
 *  the clear actually took effect rather than reporting the removal of one line
 *  while another form of the assignment still supplies the value. */
export function slotStillResolves(slotId: string): boolean {
  const slot = SLOT_BY_ID.get(slotId);
  if (!slot) throw new Error(`unknown credential slot "${slotId}"`);
  return slot.envKeys.some((k) => freshSecretValue(k) !== undefined);
}

/**
 * The revoke's VERIFIED end state:
 *   "gone"           — the store is readable and carries no alias of this slot.
 *   "still-resolves" — an alias still supplies a credential.
 *   "unknown"        — the store could not be read, so neither is established.
 *
 * `slotStillResolves` alone is not enough here: after a revoke deletes this
 * process's copy, an unreadable store makes every alias resolve to undefined —
 * which reads as "gone" while a child that CAN read the file still finds the old
 * credential there. Reporting a revoke on that basis is a false acknowledgement
 * (codex gate, round 5, finding 3).
 */
export function slotRevokeState(slotId: string): "gone" | "still-resolves" | "unknown" {
  const slot = SLOT_BY_ID.get(slotId);
  if (!slot) throw new Error(`unknown credential slot "${slotId}"`);
  const parsed = parseEnvFile();
  if (parsed === null) return "unknown"; // the store may still carry it; we cannot tell
  if (slot.envKeys.some((k) => typeof parsed[k] === "string" && parsed[k].trim())) {
    return "still-resolves";
  }
  return slotStillResolves(slotId) ? "still-resolves" : "gone";
}

/** The slot's keys currently supplied by a REAL environment variable. Read
 *  BEFORE a revoke: this store can delete them from THIS process, but not from
 *  the environment the process was started with, so they come back on the next
 *  start. Calling that a completed revoke would be a state we did not reach. */
export function slotShellProvidedKeys(slotId: string): string[] {
  const slot = SLOT_BY_ID.get(slotId);
  if (!slot) throw new Error(`unknown credential slot "${slotId}"`);
  return slot.envKeys.filter((k) => isShellProvided(k));
}

/** Masked per-slot state: set = ANY of the slot's alias env keys resolves.
 *  Checking only the PRIMARY alias reported a slot as unset when only its legacy
 *  alias was configured (e.g. HUGGINGFACE_TOKEN without HF_TOKEN) — a "not
 *  configured" verdict for a credential that is in effect (codex gate, round 4,
 *  answer B). The mask shows the alias that actually resolves. */
export function listPanelSecretsMasked(): { id: string; label: string; set: boolean; masked: string | null }[] {
  return CREDENTIAL_SLOTS.map((slot) => {
    // Resolved with the SAME alias precedence a reader uses (freshSecretValue
    // over the whole alias list), not by resolving each alias independently and
    // taking the first: those differ — a shell-set legacy alias outranks a
    // file-set canonical one for a reader, so picking per-alias would display a
    // token consumers are not using (codex gate, round 5, finding 6).
    const val = freshSecretValue(...slot.envKeys);
    return { id: slot.id, label: slot.label, set: !!val, masked: val ? maskSecret(val) : null };
  });
}
