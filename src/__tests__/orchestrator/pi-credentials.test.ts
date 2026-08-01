// pi.dev (#491) credential-detection precision.
//
// The bug class these guard: pi reporting "ready" when nothing on this machine
// can authenticate (→ green chip, then the first turn fails), or "not ready"
// when a perfectly good credential IS present (→ the user is told to sign in
// while already signed in). Every rule asserted here is transcribed from pi's
// own source; see pi-credentials.ts for the file-by-file citations.
//
// All probes take an injected `home` + `env`, so nothing here reads the
// developer's real ~/.pi or their real environment.

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PI_ENV_API_KEYS,
  authRecordUsable,
  credentialValueUsable,
  piAuthJsonUsable,
  piCredentialPresent,
  piEnvKeysReachingPi,
  piModelsJsonUsable,
  piVertexAdcUsable,
  stripJsonComments,
} from "../../orchestrator/pi-credentials.js";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "pi-cred-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** An env with NO pi-relevant keys, so a case under test is the only signal. */
function bareEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...extra };
}

/** Write <home>/.pi/agent/<name> with `body`. */
function writePiFile(home: string, name: string, body: string): string {
  const dir = join(home, ".pi", "agent");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, body);
  return file;
}

// ---------------------------------------------------------------------------
// (a) provider env vars
// ---------------------------------------------------------------------------

describe("pi provider env keys", () => {
  // These four were missing and are the reported false "not ready" cases.
  it.each(["CEREBRAS_API_KEY", "FIREWORKS_API_KEY", "TOGETHER_API_KEY", "ANTHROPIC_OAUTH_TOKEN"])(
    "%s alone is a credential",
    (key) => {
      expect(piCredentialPresent(tmp, bareEnv({ [key]: "sk-test" }))).toBe(true);
    },
  );

  it("covers pi's whole envMap (spot-check of the long tail)", () => {
    for (const key of [
      "ANTHROPIC_AUTH_TOKEN",
      "ANT_LING_API_KEY",
      "AZURE_OPENAI_API_KEY",
      "NVIDIA_API_KEY",
      "GOOGLE_CLOUD_API_KEY",
      "RADIUS_API_KEY",
      "AI_GATEWAY_API_KEY",
      "ZAI_CODING_CN_API_KEY",
      "MINIMAX_CN_API_KEY",
      "MOONSHOT_API_KEY",
      "OPENCODE_API_KEY",
      "XIAOMI_API_KEY",
      "QWEN_TOKEN_PLAN_API_KEY",
      "COPILOT_GITHUB_TOKEN",
    ]) {
      expect(PI_ENV_API_KEYS, `${key} missing from pi's env map`).toContain(key);
      expect(piCredentialPresent(tmp, bareEnv({ [key]: "sk-test" })), key).toBe(true);
    }
  });

  it("an empty / whitespace-only key is NOT a credential", () => {
    expect(piCredentialPresent(tmp, bareEnv({ OPENAI_API_KEY: "" }))).toBe(false);
    expect(piCredentialPresent(tmp, bareEnv({ OPENAI_API_KEY: "   " }))).toBe(false);
  });

  it("no credential source at all → not ready", () => {
    expect(piCredentialPresent(tmp, bareEnv())).toBe(false);
  });

  it("keys our spawn env STRIPS never green pi (they never reach it)", () => {
    // GEMINI_API_KEY / HF_TOKEN are ComfyUI tool-only secrets: buildAgentSpawnEnv()
    // deletes them, so pi cannot see them even though pi's own envMap lists them.
    const reaching = piEnvKeysReachingPi();
    expect(PI_ENV_API_KEYS).toContain("GEMINI_API_KEY");
    expect(PI_ENV_API_KEYS).toContain("HF_TOKEN");
    expect(reaching).not.toContain("GEMINI_API_KEY");
    expect(reaching).not.toContain("HF_TOKEN");
    expect(piCredentialPresent(tmp, bareEnv({ GEMINI_API_KEY: "k", HF_TOKEN: "k" }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (b) auth.json records
// ---------------------------------------------------------------------------

describe("auth.json records", () => {
  it("a well-formed api_key record is a credential", () => {
    expect(authRecordUsable({ type: "api_key", key: "sk-ant-abc" })).toBe(true);
  });

  it("MALFORMED: api_key record with no `key` is NOT a credential", () => {
    expect(authRecordUsable({ type: "api_key" })).toBe(false);
    expect(authRecordUsable({ type: "api_key", key: "" })).toBe(false);
    expect(authRecordUsable({ type: "api_key", key: "   " })).toBe(false);
    expect(authRecordUsable({ type: "api_key", key: 42 })).toBe(false);
  });

  it("MALFORMED: an empty record `{}` is NOT a credential", () => {
    expect(authRecordUsable({})).toBe(false);
  });

  it("oauth record needs something that can produce a live token", () => {
    const now = 1_800_000_000_000;
    const futureSec = Math.floor(now / 1000) + 3600;
    expect(authRecordUsable({ type: "oauth", access: "at", refresh: "rt", expires: 1 }, bareEnv(), now)).toBe(true);
    // refresh alone: pi can always re-mint an access token, even when expired.
    expect(authRecordUsable({ type: "oauth", refresh: "rt" }, bareEnv(), now)).toBe(true);
    expect(authRecordUsable({ type: "oauth", expires: futureSec }, bareEnv(), now)).toBe(false);
    // access with no refresh and a PAST/absent expiry cannot be renewed: pi sees
    // it as expired and tries to refresh with no refresh token.
    expect(authRecordUsable({ type: "oauth", access: "at" }, bareEnv(), now)).toBe(false);
    expect(authRecordUsable({ type: "oauth", access: "at", expires: 999 }, bareEnv(), now)).toBe(false);
    // …a still-live access token is ready. Accepted in seconds OR milliseconds,
    // since pi doesn't document the unit.
    expect(authRecordUsable({ type: "oauth", access: "at", expires: futureSec }, bareEnv(), now)).toBe(true);
    expect(authRecordUsable({ type: "oauth", access: "at", expires: now + 3600_000 }, bareEnv(), now)).toBe(true);
  });

  it("an UNRECOGNISED credential type is not a credential (and blocks env fallback)", () => {
    // pi's resolveProviderAuth dispatches only "oauth"/"api_key" and returns
    // undefined otherwise — and a stored credential owns the provider, so it
    // does not fall back to the env either.
    expect(authRecordUsable({ type: "future", key: "x" })).toBe(false);
    expect(authRecordUsable({ key: "x" })).toBe(false);
  });

  it("a stored-but-unusable record suppresses that provider's env key", () => {
    const home = tmp;
    writePiFile(home, "auth.json", JSON.stringify({ openai: { type: "api_key" } }));
    // pi will not consult OPENAI_API_KEY: the stored record owns `openai`.
    expect(piCredentialPresent(home, bareEnv({ OPENAI_API_KEY: "sk" }))).toBe(false);
    // …but an unrelated provider's env key still counts.
    expect(piCredentialPresent(home, bareEnv({ XAI_API_KEY: "sk" }))).toBe(true);
  });

  it("a FALSY stored entry does not own the provider (pi gates on `if (stored)`)", () => {
    // pi falls back to the ambient key when the stored value is null, so
    // suppressing on mere key-presence would false-red a working install.
    writePiFile(tmp, "auth.json", '{"openai":null}');
    expect(piCredentialPresent(tmp, bareEnv({ OPENAI_API_KEY: "sk" }))).toBe(true);
  });

  it("stored-record ownership follows JS truthiness", () => {
    // `{}` and `[]` are TRUTHY in JS, so they DO own the provider (pi suppresses
    // ambient auth); null/false/0 do not. The panel's Python mirror has to match
    // this explicitly, since Python's own truthiness differs for `{}`/`[]`.
    for (const [body, ready] of [
      ['{"openai":{}}', false],
      ['{"openai":[]}', false],
      ['{"openai":null}', true],
      ['{"openai":false}', true],
      ['{"openai":0}', true],
    ] as const) {
      writePiFile(tmp, "auth.json", body);
      expect(piCredentialPresent(tmp, bareEnv({ OPENAI_API_KEY: "sk" })), body).toBe(ready);
    }
  });

  it("a stored google-vertex record suppresses ambient ADC too", () => {
    const keyFile = join(tmp, "sa.json");
    writeFileSync(keyFile, "{}");
    const adcEnv = {
      GOOGLE_CLOUD_PROJECT: "p",
      GOOGLE_CLOUD_LOCATION: "l",
      GOOGLE_APPLICATION_CREDENTIALS: keyFile,
    };
    expect(piCredentialPresent(tmp, bareEnv(adcEnv))).toBe(true);
    // A stored (but unusable) google-vertex record owns the provider, so pi
    // never consults ADC for it.
    writePiFile(tmp, "auth.json", '{"google-vertex":{"type":"api_key","key":""}}');
    expect(piCredentialPresent(tmp, bareEnv(adcEnv))).toBe(false);
  });

  it("CLOUDFLARE_API_KEY alone is not a credential — the account id is required", () => {
    expect(piCredentialPresent(tmp, bareEnv({ CLOUDFLARE_API_KEY: "k" }))).toBe(false);
    expect(
      piCredentialPresent(tmp, bareEnv({ CLOUDFLARE_API_KEY: "k", CLOUDFLARE_ACCOUNT_ID: "a" })),
    ).toBe(true);
  });

  it("honours PI_CODING_AGENT_DIR (with ~ expansion)", () => {
    const alt = join(tmp, "alt-config");
    mkdirSync(alt, { recursive: true });
    writeFileSync(join(alt, "auth.json"), JSON.stringify({ openai: { type: "api_key", key: "sk" } }));
    expect(piCredentialPresent(tmp, bareEnv())).toBe(false);
    expect(piCredentialPresent(tmp, bareEnv({ PI_CODING_AGENT_DIR: alt }))).toBe(true);
    expect(piCredentialPresent(tmp, bareEnv({ PI_CODING_AGENT_DIR: "~/alt-config" }))).toBe(true);
    // A RELATIVE override resolves against PI's cwd, which we cannot know — so
    // the file-backed sources are unreadable rather than probed against OUR cwd.
    expect(piCredentialPresent(tmp, bareEnv({ PI_CODING_AGENT_DIR: "alt-config" }))).toBe(false);
    // …env credentials are unaffected by an unresolvable config dir.
    expect(
      piCredentialPresent(tmp, bareEnv({ PI_CODING_AGENT_DIR: "alt-config", XAI_API_KEY: "sk" })),
    ).toBe(true);
  });

  it("a stored cloudflare record still needs its account id", () => {
    writePiFile(tmp, "auth.json", '{"cloudflare-workers-ai":{"type":"api_key","key":"k"}}');
    expect(piCredentialPresent(tmp, bareEnv())).toBe(false);
    // …supplied either by the record's own env block…
    writePiFile(
      tmp,
      "auth.json",
      '{"cloudflare-workers-ai":{"type":"api_key","key":"k","env":{"CLOUDFLARE_ACCOUNT_ID":"a"}}}',
    );
    expect(piCredentialPresent(tmp, bareEnv())).toBe(true);
    // …or by the environment.
    writePiFile(tmp, "auth.json", '{"cloudflare-workers-ai":{"type":"api_key","key":"k"}}');
    expect(piCredentialPresent(tmp, bareEnv({ CLOUDFLARE_ACCOUNT_ID: "a" }))).toBe(true);
  });

  it("an env-interpolated key naming a STRIPPED var is NOT a credential", () => {
    // GEMINI_API_KEY is a ComfyUI tool secret: buildAgentSpawnEnv() deletes it,
    // so it resolves for US and to nothing for pi.
    expect(credentialValueUsable("$GEMINI_API_KEY", undefined, bareEnv({ GEMINI_API_KEY: "k" }))).toBe(false);
    expect(credentialValueUsable("$OPENAI_API_KEY", undefined, bareEnv({ OPENAI_API_KEY: "k" }))).toBe(true);
    // …unless the record supplies it itself, which pi injects into pi's env.
    expect(credentialValueUsable("$GEMINI_API_KEY", { GEMINI_API_KEY: "k" }, bareEnv())).toBe(true);
  });

  it("an EXPIRED oauth record with a refresh token is still ready (pi auto-refreshes)", () => {
    expect(authRecordUsable({ type: "oauth", access: "a", refresh: "r", expires: 1 })).toBe(true);
  });

  it("`key` env-interpolation resolves from the entry env, then the process env", () => {
    expect(credentialValueUsable("$MY_KEY", undefined, bareEnv({ MY_KEY: "sk" }))).toBe(true);
    expect(credentialValueUsable("${MY_KEY}", undefined, bareEnv({ MY_KEY: "sk" }))).toBe(true);
    expect(credentialValueUsable("$MY_KEY", { MY_KEY: "sk" }, bareEnv())).toBe(true);
    // Nothing to resolve to → not a credential (pi would send an empty key).
    expect(credentialValueUsable("$MY_KEY", undefined, bareEnv())).toBe(false);
    expect(credentialValueUsable("${A}_${B}", undefined, bareEnv({ A: "x" }))).toBe(false);
    expect(credentialValueUsable("${A}_${B}", undefined, bareEnv({ A: "x", B: "y" }))).toBe(true);
  });

  it("a `!command` key is accepted unverified (we never execute it to probe)", () => {
    expect(credentialValueUsable("!security find-generic-password -ws anthropic")).toBe(true);
  });

  it("pi's `$$` / `$!` escapes are literals, not references", () => {
    // pi reads "$$MY_KEY" as the literal string "$MY_KEY"; treating it as a
    // reference to an unset MY_KEY would false-red a working key.
    expect(credentialValueUsable("$$MY_KEY", undefined, bareEnv())).toBe(true);
    expect(credentialValueUsable("sk-$!literal", undefined, bareEnv())).toBe(true);
    // …a real reference alongside an escape is still resolved.
    expect(credentialValueUsable("$$literal-$REAL", undefined, bareEnv())).toBe(false);
    expect(credentialValueUsable("$$literal-$REAL", undefined, bareEnv({ REAL: "x" }))).toBe(true);
  });

  it("a file with only malformed records does NOT green pi", () => {
    const home = tmp;
    writePiFile(home, "auth.json", JSON.stringify({ anthropic: {}, openai: { type: "api_key" } }));
    expect(piAuthJsonUsable(join(home, ".pi", "agent", "auth.json"), bareEnv())).toBe(false);
    expect(piCredentialPresent(home, bareEnv())).toBe(false);
  });

  it("one good record among malformed ones IS enough", () => {
    const home = tmp;
    writePiFile(
      home,
      "auth.json",
      JSON.stringify({ anthropic: {}, openai: { type: "api_key", key: "sk-real" } }),
    );
    expect(piCredentialPresent(home, bareEnv())).toBe(true);
  });

  it("missing / empty / corrupt / non-object auth.json → not a credential", () => {
    const home = tmp;
    expect(piAuthJsonUsable(join(home, ".pi", "agent", "auth.json"), bareEnv())).toBe(false);
    writePiFile(home, "auth.json", "");
    expect(piAuthJsonUsable(join(home, ".pi", "agent", "auth.json"), bareEnv())).toBe(false);
    writePiFile(home, "auth.json", "{ not json");
    expect(piAuthJsonUsable(join(home, ".pi", "agent", "auth.json"), bareEnv())).toBe(false);
    writePiFile(home, "auth.json", "{}");
    expect(piAuthJsonUsable(join(home, ".pi", "agent", "auth.json"), bareEnv())).toBe(false);
    writePiFile(home, "auth.json", "[]");
    expect(piAuthJsonUsable(join(home, ".pi", "agent", "auth.json"), bareEnv())).toBe(false);
  });

  it("auth.json is plain JSON for pi — a commented one is broken and must not green", () => {
    const home = tmp;
    writePiFile(home, "auth.json", '{\n  // mine\n  "openai": { "type": "api_key", "key": "sk" }\n}');
    expect(piAuthJsonUsable(join(home, ".pi", "agent", "auth.json"), bareEnv())).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (c) Google Vertex ADC
// ---------------------------------------------------------------------------

describe("Google Vertex ADC", () => {
  const project = { GOOGLE_CLOUD_PROJECT: "proj", GOOGLE_CLOUD_LOCATION: "us-central1" };

  it("credentials file that EXISTS + project + location → ready", () => {
    const keyFile = join(tmp, "sa.json");
    writeFileSync(keyFile, "{}");
    const env = bareEnv({ ...project, GOOGLE_APPLICATION_CREDENTIALS: keyFile });
    expect(piVertexAdcUsable(tmp, env)).toBe(true);
    expect(piCredentialPresent(tmp, env)).toBe(true);
  });

  it("NONEXISTENT credentials path → NOT ready (the old false green)", () => {
    const env = bareEnv({ ...project, GOOGLE_APPLICATION_CREDENTIALS: join(tmp, "gone.json") });
    expect(piVertexAdcUsable(tmp, env)).toBe(false);
    expect(piCredentialPresent(tmp, env)).toBe(false);
  });

  it("credentials file without project/location → NOT ready (pi's ADC path needs all three)", () => {
    const keyFile = join(tmp, "sa.json");
    writeFileSync(keyFile, "{}");
    expect(piVertexAdcUsable(tmp, bareEnv({ GOOGLE_APPLICATION_CREDENTIALS: keyFile }))).toBe(false);
    expect(
      piVertexAdcUsable(tmp, bareEnv({ GOOGLE_APPLICATION_CREDENTIALS: keyFile, GOOGLE_CLOUD_PROJECT: "p" })),
    ).toBe(false);
  });

  it("a RELATIVE credentials path is NOT ready (unverifiable — pi's cwd is unknown here)", () => {
    const env = bareEnv({ ...project, GOOGLE_APPLICATION_CREDENTIALS: "missing.json" });
    expect(piVertexAdcUsable(tmp, env)).toBe(false);
  });

  it("a %APPDATA%\\gcloud ADC file does NOT count — pi only probes ~/.config/gcloud", () => {
    const appData = join(tmp, "AppData", "Roaming");
    mkdirSync(join(appData, "gcloud"), { recursive: true });
    writeFileSync(join(appData, "gcloud", "application_default_credentials.json"), "{}");
    expect(piVertexAdcUsable(tmp, bareEnv({ ...project, APPDATA: appData }))).toBe(false);
  });

  it("a DIRECTORY at the credentials path is not a credential", () => {
    const dir = join(tmp, "not-a-file");
    mkdirSync(dir, { recursive: true });
    expect(piVertexAdcUsable(tmp, bareEnv({ ...project, GOOGLE_APPLICATION_CREDENTIALS: dir }))).toBe(false);
  });

  it("GCLOUD_PROJECT is accepted as the project fallback", () => {
    const keyFile = join(tmp, "sa.json");
    writeFileSync(keyFile, "{}");
    const env = bareEnv({
      GCLOUD_PROJECT: "proj",
      GOOGLE_CLOUD_LOCATION: "us-central1",
      GOOGLE_APPLICATION_CREDENTIALS: keyFile,
    });
    expect(piVertexAdcUsable(tmp, env)).toBe(true);
  });

  it("gcloud's well-known ADC file counts when the env var is unset", () => {
    const dir = join(tmp, ".config", "gcloud");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "application_default_credentials.json"), "{}");
    expect(piVertexAdcUsable(tmp, bareEnv(project))).toBe(true);
    // …but only with project + location.
    expect(piVertexAdcUsable(tmp, bareEnv())).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (d) models.json — JSONC accepted, empty entries rejected
// ---------------------------------------------------------------------------

describe("models.json", () => {
  const modelsPath = () => join(tmp, ".pi", "agent", "models.json");

  it("JSONC (line comments + trailing commas) is VALID — pi strips them too", () => {
    writePiFile(
      tmp,
      "models.json",
      `{
  // my local gateway
  "providers": {
    "mygw": {
      "baseUrl": "http://localhost:1234",
      "apiKey": "sk-local", // inline note
    },
  },
}`,
    );
    expect(piModelsJsonUsable(modelsPath(), bareEnv())).toBe(true);
    expect(piCredentialPresent(tmp, bareEnv())).toBe(true);
  });

  it("a `//` sequence inside a STRING is not treated as a comment", () => {
    writePiFile(
      tmp,
      "models.json",
      '{"providers":{"gw":{"baseUrl":"http://x/v1","apiKey":"sk-a"}}}',
    );
    expect(piModelsJsonUsable(modelsPath(), bareEnv())).toBe(true);
  });

  it("EMPTY provider entry does NOT green pi", () => {
    writePiFile(tmp, "models.json", '{"providers":{"mygw":{}}}');
    expect(piModelsJsonUsable(modelsPath(), bareEnv())).toBe(false);
    expect(piCredentialPresent(tmp, bareEnv())).toBe(false);
  });

  it("empty `providers` map, or a file with no `providers` key, does NOT green pi", () => {
    writePiFile(tmp, "models.json", '{"providers":{}}');
    expect(piModelsJsonUsable(modelsPath(), bareEnv())).toBe(false);
    // The old check counted TOP-LEVEL keys, so this one-key file greened pi.
    writePiFile(tmp, "models.json", '{"note":"todo"}');
    expect(piModelsJsonUsable(modelsPath(), bareEnv())).toBe(false);
  });

  it("a provider with only baseUrl/models (no credential) does NOT green pi", () => {
    writePiFile(
      tmp,
      "models.json",
      '{"providers":{"mygw":{"baseUrl":"http://localhost:1234","models":[{"id":"m"}]}}}',
    );
    expect(piModelsJsonUsable(modelsPath(), bareEnv())).toBe(false);
  });

  it("a provider apiKey referencing an UNSET env var does NOT green pi", () => {
    writePiFile(tmp, "models.json", '{"providers":{"mygw":{"apiKey":"$MY_GW_KEY"}}}');
    expect(piModelsJsonUsable(modelsPath(), bareEnv())).toBe(false);
    expect(piModelsJsonUsable(modelsPath(), bareEnv({ MY_GW_KEY: "sk" }))).toBe(true);
  });

  it("an `oauth` provider entry is a credential — but only pi's literal \"radius\" WITH a baseUrl", () => {
    writePiFile(tmp, "models.json", '{"providers":{"radius":{"oauth":"radius","baseUrl":"https://r/v1"}}}');
    expect(piModelsJsonUsable(modelsPath(), bareEnv())).toBe(true);
    // provider-composer throws `"baseUrl" is required when "oauth" is set`.
    writePiFile(tmp, "models.json", '{"providers":{"radius":{"oauth":"radius"}}}');
    expect(piModelsJsonUsable(modelsPath(), bareEnv())).toBe(false);
    // pi's schema is a literal; any other value makes pi reject the whole file.
    writePiFile(tmp, "models.json", '{"providers":{"x":{"oauth":"nope"}}}');
    expect(piModelsJsonUsable(modelsPath(), bareEnv())).toBe(false);
  });

  it("an EMPTY string on any provider field invalidates the file (pi's minLength 1)", () => {
    writePiFile(tmp, "models.json", '{"providers":{"good":{"apiKey":"sk"},"bad":{"name":""}}}');
    expect(piModelsJsonUsable(modelsPath(), bareEnv())).toBe(false);
    writePiFile(tmp, "models.json", '{"providers":{"good":{"apiKey":"sk"},"ok":{"name":"Fine"}}}');
    expect(piModelsJsonUsable(modelsPath(), bareEnv())).toBe(true);
    // minLength 1 accepts a SPACE — trimming here would false-red a config pi loads.
    writePiFile(tmp, "models.json", '{"providers":{"good":{"apiKey":"sk"},"ok":{"name":" "}}}');
    expect(piModelsJsonUsable(modelsPath(), bareEnv())).toBe(true);
  });

  it("a space-padded credentials path is NOT resolved (pi uses the literal value)", () => {
    const keyFile = join(tmp, "sa.json");
    writeFileSync(keyFile, "{}");
    const env = {
      GOOGLE_CLOUD_PROJECT: "p",
      GOOGLE_CLOUD_LOCATION: "l",
      GOOGLE_APPLICATION_CREDENTIALS: `  ${keyFile}  `,
    };
    expect(piVertexAdcUsable(tmp, bareEnv(env))).toBe(false);
  });

  it("a WRONG-TYPED or bad-headers provider field invalidates the file", () => {
    // pi's schema types these; a violation discards the file, so the sibling's
    // good key never reaches pi either.
    writePiFile(tmp, "models.json", '{"providers":{"good":{"apiKey":"x"},"bad":{"apiKey":1}}}');
    expect(piModelsJsonUsable(modelsPath(), bareEnv())).toBe(false);
    writePiFile(tmp, "models.json", '{"providers":{"p":{"apiKey":"x","headers":{"X-T":1}}}}');
    expect(piModelsJsonUsable(modelsPath(), bareEnv())).toBe(false);
    writePiFile(tmp, "models.json", '{"providers":{"p":{"apiKey":"x","headers":{"X-T":"1"}}}}');
    expect(piModelsJsonUsable(modelsPath(), bareEnv())).toBe(true);
  });

  it("a model definition violating pi's schema invalidates the file", () => {
    const good = '"good":{"apiKey":"sk"}';
    for (const bad of [
      '{"id":"m","reasoning":"yes"}', // Type.Boolean
      '{"id":"m","contextWindow":0}', // provider-composer rejects <= 0
      '{"id":"m","maxTokens":-1}',
      '{"id":"m","name":""}', // minLength 1
      '{"id":"m","headers":{"X":1}}', // Record<string,string>
      '{"id":"m","input":["video"]}', // "text" | "image"
      '{"id":"m","cost":{}}', // ModelCost requires all four rates
      '{"id":"m","cost":{"input":"free","output":1,"cacheRead":1,"cacheWrite":1}}',
      '{"id":"m","thinkingLevelMap":{"low":3}}', // string | null
      '{"id":"m","compat":"yes"}',
      '{"id":"m","cost":{"input":1,"output":1,"cacheRead":1,"cacheWrite":1,"tiers":[{}]}}',
      '{"id":"m","name":null}', // Type.Optional rejects a PRESENT null
    ]) {
      writePiFile(tmp, "models.json", `{"providers":{${good},"p":{"apiKey":"x","models":[${bad}]}}}`);
      expect(piModelsJsonUsable(modelsPath(), bareEnv()), bad).toBe(false);
    }
    // A fully-valid definition loads.
    writePiFile(
      tmp,
      "models.json",
      '{"providers":{"p":{"apiKey":"x","models":[{"id":"m","reasoning":true,"contextWindow":8192,"input":["text","image"],"headers":{"X":"1"}}]}}}',
    );
    expect(piModelsJsonUsable(modelsPath(), bareEnv())).toBe(true);
  });

  it("a fully-specified cost/override block is accepted", () => {
    writePiFile(
      tmp,
      "models.json",
      '{"providers":{"p":{"apiKey":"x","models":[{"id":"m","cost":{"input":1,"output":2,"cacheRead":0,"cacheWrite":0}}],' +
        '"modelOverrides":{"m":{"reasoning":true,"thinkingLevelMap":{"low":"1k","off":null}}}}}}',
    );
    expect(piModelsJsonUsable(modelsPath(), bareEnv())).toBe(true);
    // …and a malformed override invalidates the file, like any other violation.
    writePiFile(
      tmp,
      "models.json",
      '{"providers":{"p":{"apiKey":"x","modelOverrides":{"m":{"reasoning":"yes"}}}}}',
    );
    expect(piModelsJsonUsable(modelsPath(), bareEnv())).toBe(false);
    // An OVERRIDE's contextWindow/maxTokens carry no positivity constraint (that
    // is a ModelDefinition-only runtime check), so 0 is a config pi accepts.
    writePiFile(
      tmp,
      "models.json",
      '{"providers":{"p":{"apiKey":"x","modelOverrides":{"m":{"contextWindow":0}}}}}',
    );
    expect(piModelsJsonUsable(modelsPath(), bareEnv())).toBe(true);
    // An UNDECLARED thinkingLevelMap key is fine (no additionalProperties rule).
    writePiFile(
      tmp,
      "models.json",
      '{"providers":{"p":{"apiKey":"x","models":[{"id":"m","thinkingLevelMap":{"future":false}}]}}}',
    );
    expect(piModelsJsonUsable(modelsPath(), bareEnv())).toBe(true);
  });

  it("bedrock is keyed by pi's provider id (amazon-bedrock) for stored ownership", () => {
    // Getting the id wrong would mean a stored record never suppresses the
    // ambient token it owns.
    expect(piCredentialPresent(tmp, bareEnv({ AWS_BEARER_TOKEN_BEDROCK: "t" }))).toBe(true);
    writePiFile(tmp, "auth.json", '{"amazon-bedrock":{"type":"api_key"}}');
    expect(piCredentialPresent(tmp, bareEnv({ AWS_BEARER_TOKEN_BEDROCK: "t" }))).toBe(false);
  });

  it("UNDECLARED extra fields are left alone (pi declares no additionalProperties)", () => {
    // Being stricter than pi here would false-red a file it loads fine.
    writePiFile(tmp, "models.json", '{"providers":{"p":{"apiKey":"x","note":"","future":{"a":1}}}}');
    expect(piModelsJsonUsable(modelsPath(), bareEnv())).toBe(true);
  });

  it("a model definition without a usable `id` invalidates the file", () => {
    writePiFile(tmp, "models.json", '{"providers":{"p":{"apiKey":"sk","models":[{}]}}}');
    expect(piModelsJsonUsable(modelsPath(), bareEnv())).toBe(false);
    writePiFile(tmp, "models.json", '{"providers":{"p":{"apiKey":"sk","models":[{"id":""}]}}}');
    expect(piModelsJsonUsable(modelsPath(), bareEnv())).toBe(false);
    writePiFile(tmp, "models.json", '{"providers":{"p":{"apiKey":"sk","models":[{"id":"m"}]}}}');
    expect(piModelsJsonUsable(modelsPath(), bareEnv())).toBe(true);
  });

  it("a MALFORMED sibling provider discards the whole file, as it does for pi", () => {
    // pi validates models.json as a unit and throws it away on any violation, so
    // the good provider's key never reaches pi either.
    writePiFile(
      tmp,
      "models.json",
      '{"providers":{"good":{"apiKey":"sk-a"},"bad":{"models":"not-an-array"}}}',
    );
    expect(piModelsJsonUsable(modelsPath(), bareEnv())).toBe(false);
    writePiFile(tmp, "models.json", '{"providers":{"good":{"apiKey":"sk-a"},"bad":{"apiKey":""}}}');
    expect(piModelsJsonUsable(modelsPath(), bareEnv())).toBe(false);
    // …and the same file with the sibling fixed IS a credential.
    writePiFile(
      tmp,
      "models.json",
      '{"providers":{"good":{"apiKey":"sk-a"},"ok":{"baseUrl":"http://x/v1","models":[]}}}',
    );
    expect(piModelsJsonUsable(modelsPath(), bareEnv())).toBe(true);
  });

  it("an apiKey naming a STRIPPED var does not green pi", () => {
    writePiFile(tmp, "models.json", '{"providers":{"gw":{"apiKey":"$HF_TOKEN"}}}');
    expect(piModelsJsonUsable(modelsPath(), bareEnv({ HF_TOKEN: "k" }))).toBe(false);
  });

  it("missing / corrupt models.json → not a credential", () => {
    expect(piModelsJsonUsable(modelsPath(), bareEnv())).toBe(false);
    writePiFile(tmp, "models.json", "{ not json");
    expect(piModelsJsonUsable(modelsPath(), bareEnv())).toBe(false);
  });
});

describe("stripJsonComments", () => {
  it("removes line comments and trailing commas but preserves strings", () => {
    expect(stripJsonComments('{"a":1} // tail')).toBe('{"a":1} ');
    expect(stripJsonComments('{"a":[1,2,],}')).toBe('{"a":[1,2]}');
    expect(stripJsonComments('{"url":"http://x//y"}')).toBe('{"url":"http://x//y"}');
  });

  it("does NOT handle block comments — pi doesn't either, so such a file is broken for pi too", () => {
    const body = '{\n/* note */\n"providers":{"g":{"apiKey":"sk"}}\n}';
    writePiFile(tmp, "models.json", body);
    expect(piModelsJsonUsable(join(tmp, ".pi", "agent", "models.json"), bareEnv())).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// End-to-end readiness wiring
// ---------------------------------------------------------------------------

describe("piCredentialPresent source precedence", () => {
  it("any ONE credible source is enough", () => {
    // env only
    expect(piCredentialPresent(tmp, bareEnv({ XAI_API_KEY: "k" }))).toBe(true);
    // auth.json only
    writePiFile(tmp, "auth.json", JSON.stringify({ xai: { type: "api_key", key: "k" } }));
    expect(piCredentialPresent(tmp, bareEnv())).toBe(true);
  });

  it("a home with an empty .pi tree and a bare env is NOT ready", () => {
    mkdirSync(join(tmp, ".pi", "agent"), { recursive: true });
    expect(piCredentialPresent(tmp, bareEnv())).toBe(false);
  });
});
