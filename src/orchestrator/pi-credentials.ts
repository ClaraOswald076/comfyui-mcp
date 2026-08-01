// pi.dev (#491) credential DETECTION — "does a usable provider credential exist
// on this machine?", answered from disk + env only.
//
// Why this is its own module: `pi --list-models` is NOT an auth probe (it prints
// the built-in catalog with no key at all), so unlike every other CLI backend the
// connect-time model probe cannot tell us whether pi can actually authenticate.
// Readiness therefore has to reproduce pi's own credential resolution. The rules
// below are transcribed from pi's source (earendil-works/pi @ main) rather than
// guessed; each is cited at its use site so a future reader can re-verify:
//
//   packages/ai/src/env-api-keys.ts          — `envMap` + the anthropic/copilot specials
//   packages/ai/src/auth/types.ts            — ApiKeyCredential / OAuthCredential shapes
//   packages/coding-agent/src/core/auth-storage.ts — auth.json is plain JSON.parse
//   packages/coding-agent/src/core/model-config.ts — models.json is JSONC + `{providers:{…}}`
//   packages/coding-agent/src/utils/json.ts  — the exact stripJsonComments behaviour
//   packages/ai/src/providers/google-vertex.ts — Vertex ADC (creds path + project + location)
//
// PRECISION BAR (deliberate): "ready" means a plausible, WELL-FORMED, PRESENT
// credential source — not a proven-working one. A revoked key, an exhausted quota
// or a typo'd secret is invisible from disk and still fails on the first turn;
// that residual is accepted and the panel/banner wording must not over-promise.
// What we do NOT accept is greening on a source that CANNOT authenticate no
// matter what: a record with no key at all, a credentials path pointing at a file
// that isn't there, or an empty provider stanza.
//
// Scope note: this is accidental-wrongness only. There is no adversarial model
// here — a user who hand-edits their own auth.json to lie is out of scope (this
// is a local single-trust-domain project).

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { TOOL_ONLY_SECRET_ENV_KEYS } from "../services/panel-secrets.js";

/**
 * Every env var pi reads as a provider credential.
 *
 * Transcribed from `envMap` in packages/ai/src/env-api-keys.ts, plus the three
 * exported anthropic constants (ANTHROPIC_AUTH_TOKEN / ANTHROPIC_OAUTH_TOKEN /
 * ANTHROPIC_API_KEY) and the github-copilot special case, which live outside the
 * map. Ordered by provider id to keep it diff-able against pi's file.
 *
 * NOT every entry here necessarily reaches pi's subprocess — see
 * `piEnvKeysReachingPi()`, which subtracts the ComfyUI tool-only secrets that
 * buildAgentSpawnEnv() strips. Keep this list a faithful copy of pi's map; do the
 * subtraction there, not by editing this array.
 */
export const PI_ENV_API_KEYS: readonly string[] = [
  // anthropic (special-cased in pi: three accepted vars, any one suffices)
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_OAUTH_TOKEN",
  // envMap, in pi's own order
  "ANT_LING_API_KEY", // ant-ling
  "QWEN_TOKEN_PLAN_API_KEY", // qwen-token-plan
  "QWEN_TOKEN_PLAN_CN_API_KEY", // qwen-token-plan-cn
  "OPENAI_API_KEY", // openai
  "AZURE_OPENAI_API_KEY", // azure-openai-responses
  "NVIDIA_API_KEY", // nvidia
  "DEEPSEEK_API_KEY", // deepseek
  "GEMINI_API_KEY", // google  (stripped before it reaches pi — see below)
  "GOOGLE_CLOUD_API_KEY", // google-vertex (api-key mode)
  "GROQ_API_KEY", // groq
  "CEREBRAS_API_KEY", // cerebras
  "XAI_API_KEY", // xai
  "RADIUS_API_KEY", // radius
  "OPENROUTER_API_KEY", // openrouter
  "AI_GATEWAY_API_KEY", // vercel-ai-gateway
  "ZAI_API_KEY", // zai
  "ZAI_CODING_CN_API_KEY", // zai-coding-cn
  "MISTRAL_API_KEY", // mistral
  "MINIMAX_API_KEY", // minimax
  "MINIMAX_CN_API_KEY", // minimax-cn
  "MOONSHOT_API_KEY", // moonshotai / moonshotai-cn
  "HF_TOKEN", // huggingface (stripped before it reaches pi — see below)
  "FIREWORKS_API_KEY", // fireworks
  "TOGETHER_API_KEY", // together
  "OPENCODE_API_KEY", // opencode / opencode-go
  "KIMI_API_KEY", // kimi-coding
  "CLOUDFLARE_API_KEY", // cloudflare-workers-ai / cloudflare-ai-gateway
  "XIAOMI_API_KEY", // xiaomi
  "XIAOMI_TOKEN_PLAN_CN_API_KEY", // xiaomi-token-plan-cn
  "XIAOMI_TOKEN_PLAN_AMS_API_KEY", // xiaomi-token-plan-ams
  "XIAOMI_TOKEN_PLAN_SGP_API_KEY", // xiaomi-token-plan-sgp
  "COPILOT_GITHUB_TOKEN", // github-copilot (special-cased in pi)
  // Documented in packages/coding-agent/docs/providers.md (bedrock) but absent
  // from `envMap`, which only covers api-key providers.
  "AWS_BEARER_TOKEN_BEDROCK",
];

/**
 * The subset of `PI_ENV_API_KEYS` that actually SURVIVES into pi's spawn env.
 *
 * pi is spawned with `buildAgentSpawnEnv()` (no keep-list), which deletes the
 * ComfyUI tool-only secrets. A key that gets stripped must never green pi:
 * `GEMINI_API_KEY` and `HF_TOKEN` are ComfyUI tool secrets, so a user whose ONLY
 * credential is one of those has a pi that cannot authenticate — its first turn
 * would fail. Those users must put the key in ~/.pi/agent/auth.json instead.
 *
 * Derived (not hand-maintained) so that changing the secret allowlists in
 * panel-secrets.ts automatically keeps pi's readiness honest.
 */
export function piEnvKeysReachingPi(): string[] {
  const stripped = new Set<string>(TOOL_ONLY_SECRET_ENV_KEYS);
  return PI_ENV_API_KEYS.filter((k) => !stripped.has(k));
}

/**
 * pi's JSONC pre-pass, byte-for-byte the same behaviour as `stripJsonComments`
 * in packages/coding-agent/src/utils/json.ts: strips `//` line comments and
 * trailing commas before `}`/`]`, while leaving anything inside a string literal
 * alone. Block comments are deliberately NOT handled — pi doesn't handle them
 * either, and a models.json using slash-star comments fails to load for pi too,
 * so accepting it here would green a file pi itself rejects.
 */
export function stripJsonComments(input: string): string {
  return input
    .replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (m) => (m[0] === '"' ? m : ""))
    .replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (m, tail) => tail ?? (m[0] === '"' ? m : ""));
}

/** Matches pi's `$VAR` / `${VAR}` interpolation tokens in a credential value. */
const ENV_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;

/**
 * Is a stored credential VALUE (auth.json `key`, models.json `apiKey`) plausibly
 * resolvable? pi accepts three forms (docs/providers.md + resolveConfigValue):
 *
 *   `!some command`  → executed, output cached. We cannot verify it without
 *                      running it, and running a user command during a readiness
 *                      probe is not acceptable — so we accept it unverified.
 *   `$VAR` / `${VAR}` → interpolated from the entry's own `env` block first, then
 *                      the process env. If a referenced var is missing there is
 *                      nothing to resolve to, so this is NOT a credential.
 *   literal          → accepted as-is.
 *
 * Empty / non-string / whitespace-only is never a credential.
 */
export function credentialValueUsable(
  raw: unknown,
  entryEnv?: Record<string, unknown>,
  procEnv: NodeJS.ProcessEnv = process.env,
): boolean {
  if (typeof raw !== "string") return false;
  const value = raw.trim();
  if (!value) return false;
  // `!command` — unverifiable without executing it; err toward ready.
  if (value.startsWith("!")) return true;
  if (!value.includes("$")) return true;
  // Every referenced var must resolve to something non-empty IN THE ENV PI WILL
  // ACTUALLY SEE. Order matches pi: the entry's own `env` block first (pi injects
  // it for the provider), then the inherited process env — but a var our spawn
  // env STRIPS is never inherited, so `"key": "$GEMINI_API_KEY"` resolves for us
  // and to nothing for pi. Treating it as present would be exactly the false
  // green this whole module exists to prevent.
  const stripped = new Set<string>(TOOL_ONLY_SECRET_ENV_KEYS);
  let resolvable = true;
  value.replace(ENV_REF, (_m, braced: string | undefined, bare: string | undefined) => {
    const name = braced ?? bare ?? "";
    const fromEntry = entryEnv?.[name];
    if (typeof fromEntry === "string" && fromEntry.trim() !== "") return "";
    if (stripped.has(name) || !procEnv[name]?.trim()) resolvable = false;
    return "";
  });
  return resolvable;
}

/** Field names that carry credential material on an auth.json record whose
 *  `type` we don't recognise (forward-compat with a pi that adds a new
 *  credential kind). A record with none of these is not a credential. */
const CREDENTIAL_FIELDS = ["key", "access", "refresh", "token", "apiKey"] as const;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function nonEmptyString(v: unknown): boolean {
  return typeof v === "string" && v.trim() !== "";
}

/**
 * Does one ~/.pi/agent/auth.json record carry a usable credential?
 *
 * Shapes from packages/ai/src/auth/types.ts:
 *   ApiKeyCredential { type: "api_key"; key?: string; env?: ProviderEnv }
 *   OAuthCredential  { type: "oauth"; refresh: string; access: string; expires: number }
 *
 * Note `key` is OPTIONAL in pi's TYPE but mandatory in FACT — a `{"type":"api_key"}`
 * record resolves to no key and pi's first request goes out unauthenticated. That
 * record used to green this provider; it no longer does. Same for an oauth record
 * with neither token.
 *
 * `expires` is deliberately NOT enforced: pi auto-refreshes expired OAuth tokens
 * from `refresh` (docs/providers.md), so an expired-but-refreshable record is
 * genuinely ready and rejecting it would be a false "not signed in".
 */
export function authRecordUsable(record: unknown, procEnv: NodeJS.ProcessEnv = process.env): boolean {
  if (!isPlainObject(record)) return false;
  const type = record.type;
  if (type === "api_key") {
    return credentialValueUsable(record.key, isPlainObject(record.env) ? record.env : undefined, procEnv);
  }
  if (type === "oauth") {
    // pi's OAuthCredential declares refresh + access + expires as ALL required,
    // and that is what `/login` writes. We don't demand all three (that would
    // false-red a partially-migrated record), but we do require something that
    // can actually produce a live token:
    //   - a `refresh` token: pi can always re-mint access, so ready regardless
    //     of `expires` (an expired-but-refreshable record IS ready — refusing it
    //     would be a false "not signed in").
    //   - otherwise an `access` token is only credible alongside the numeric
    //     `expires` that tells pi whether it is still live; access-only with no
    //     expiry and no refresh cannot be renewed and is a malformed record.
    if (nonEmptyString(record.refresh)) return true;
    return nonEmptyString(record.access) && typeof record.expires === "number";
  }
  // Unknown/absent `type`: accept only if some recognised credential field
  // carries material, so `{}` and `{"type":"api_key"}` stay not-ready while a
  // future credential kind still reads as ready.
  return CREDENTIAL_FIELDS.some((f) => nonEmptyString(record[f]));
}

function readFileOrNull(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/**
 * Parse ~/.pi/agent/auth.json and report whether ANY provider record is usable.
 * Plain `JSON.parse` — pi reads this file with JSON.parse (auth-storage.ts), NOT
 * the JSONC path it uses for models.json, so a commented auth.json is broken for
 * pi and must not green here. Never throws.
 */
export function piAuthJsonUsable(file: string, procEnv: NodeJS.ProcessEnv = process.env): boolean {
  const raw = readFileOrNull(file);
  if (raw === null) return false;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isPlainObject(parsed)) return false;
    return Object.values(parsed).some((rec) => authRecordUsable(rec, procEnv));
  } catch {
    return false;
  }
}

/**
 * Parse ~/.pi/agent/models.json and report whether a CUSTOM provider carries its
 * own credential.
 *
 * Two corrections over "the file is a non-empty object":
 *  - JSONC: pi runs stripJsonComments() before JSON.parse (model-config.ts), so a
 *    models.json with `//` comments or trailing commas is perfectly valid FOR PI.
 *    Rejecting it read as "not signed in" for a working install.
 *  - Shape + emptiness: the schema is `{ providers: { <id>: {…} } }`. The old
 *    check counted top-level keys, so `{"providers":{}}` (one key) and even
 *    `{"note":"todo"}` greened pi. A provider entry only supplies auth when it
 *    has a resolvable `apiKey` or an `oauth` mode; per docs/models.md an entry
 *    without one is loaded but its models stay UNAVAILABLE, so it is not a
 *    credential.
 *
 * Never throws.
 */
export function piModelsJsonUsable(file: string, procEnv: NodeJS.ProcessEnv = process.env): boolean {
  const raw = readFileOrNull(file);
  if (raw === null) return false;
  try {
    const parsed: unknown = JSON.parse(stripJsonComments(raw));
    if (!isPlainObject(parsed)) return false;
    const providers = parsed.providers;
    if (!isPlainObject(providers)) return false;
    const entries = Object.values(providers);
    // pi validates the WHOLE file against ModelsConfigSchema and DISCARDS it on
    // any violation — so one malformed sibling provider means none of the file's
    // credentials reach pi. Reproduce that all-or-nothing behaviour rather than
    // greening off a single good-looking entry.
    if (!entries.every((p) => providerEntryValid(p))) return false;
    return entries.some(
      (p) =>
        isPlainObject(p) &&
        (credentialValueUsable(p.apiKey, undefined, procEnv) || p.oauth === "radius"),
    );
  } catch {
    return false;
  }
}

/** The subset of pi's ProviderConfigSchema we can check cheaply: `apiKey` and
 *  `baseUrl` are non-empty strings when present, `oauth` is the literal
 *  "radius", `models` is an array. This is NOT full TypeBox validation — it
 *  only has to catch the violations that would make pi throw the file away
 *  while our detector called it a credential. Anything we can't check is left
 *  permissive so we never false-red a file pi accepts. */
function providerEntryValid(entry: unknown): boolean {
  if (!isPlainObject(entry)) return false;
  if (entry.apiKey !== undefined && !nonEmptyString(entry.apiKey)) return false;
  if (entry.oauth !== undefined && entry.oauth !== "radius") return false;
  if (entry.baseUrl !== undefined && !nonEmptyString(entry.baseUrl)) return false;
  if (entry.models !== undefined && !Array.isArray(entry.models)) return false;
  return true;
}

function fileExistsSafe(file: string): boolean {
  try {
    return existsSync(file);
  } catch {
    return false;
  }
}

/**
 * Google Vertex via Application Default Credentials.
 *
 * pi's google-vertex provider (packages/ai/src/providers/google-vertex.ts) needs
 * ALL THREE of a credentials FILE, a project and a location for the ADC/service-
 * account path — GOOGLE_APPLICATION_CREDENTIALS alone cannot authenticate. It
 * also falls back to gcloud's well-known ADC file when the var is unset, which we
 * now honour (that user IS ready and used to read as not).
 *
 * The two real corrections here: the referenced file must EXIST (a stale
 * GOOGLE_APPLICATION_CREDENTIALS pointing at a deleted key file used to green
 * pi), and project/location must be set.
 */
export function piVertexAdcUsable(home: string, procEnv: NodeJS.ProcessEnv = process.env): boolean {
  const project = procEnv.GOOGLE_CLOUD_PROJECT?.trim() || procEnv.GCLOUD_PROJECT?.trim();
  const location = procEnv.GOOGLE_CLOUD_LOCATION?.trim();
  if (!project || !location) return false;
  const explicit = procEnv.GOOGLE_APPLICATION_CREDENTIALS?.trim();
  if (explicit) {
    // Must point at a file that is actually there. A RELATIVE path resolves
    // against pi's cwd, which readiness cannot know — so it is unverifiable, and
    // "unverifiable" has to mean not-ready here or a dangling `missing.json`
    // greens pi. gcloud always writes an absolute path, so this costs nothing
    // real.
    return isAbsolute(explicit) && fileExistsSafe(explicit);
  }
  // gcloud's well-known ADC file — pi's fallback is this literal POSIX path, so
  // we probe exactly that and no other location (a %APPDATA%\gcloud file would
  // green a credential pi does not look for).
  return fileExistsSafe(join(home, ".config", "gcloud", "application_default_credentials.json"));
}

/**
 * True when a pi provider credential is detectable from ANY source pi documents.
 * This — not the CLI's presence — is the honest "ready" signal for pi, and the
 * connect handler uses it too so a credential-less pi is degraded up front
 * instead of greeted green (#491).
 */
export function piCredentialPresent(
  home: string = homedir(),
  procEnv: NodeJS.ProcessEnv = process.env,
): boolean {
  if (piAuthJsonUsable(join(home, ".pi", "agent", "auth.json"), procEnv)) return true;
  if (piEnvKeysReachingPi().some((k) => !!procEnv[k]?.trim())) return true;
  if (piVertexAdcUsable(home, procEnv)) return true;
  if (piModelsJsonUsable(join(home, ".pi", "agent", "models.json"), procEnv)) return true;
  return false;
}
