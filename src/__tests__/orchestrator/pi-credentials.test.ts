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
      "CLOUDFLARE_API_KEY",
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
    expect(authRecordUsable({ type: "oauth", access: "at", refresh: "rt", expires: 1 })).toBe(true);
    // refresh alone: pi can always re-mint an access token.
    expect(authRecordUsable({ type: "oauth", refresh: "rt" })).toBe(true);
    expect(authRecordUsable({ type: "oauth", expires: 123 })).toBe(false);
    // access alone with no expiry and no refresh cannot be renewed → malformed.
    expect(authRecordUsable({ type: "oauth", access: "at" })).toBe(false);
    expect(authRecordUsable({ type: "oauth", access: "at", expires: 999 })).toBe(true);
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

  it("an `oauth` provider entry is a credential — but only pi's literal \"radius\"", () => {
    writePiFile(tmp, "models.json", '{"providers":{"radius":{"oauth":"radius"}}}');
    expect(piModelsJsonUsable(modelsPath(), bareEnv())).toBe(true);
    // pi's schema is a literal; any other value makes pi reject the whole file.
    writePiFile(tmp, "models.json", '{"providers":{"x":{"oauth":"nope"}}}');
    expect(piModelsJsonUsable(modelsPath(), bareEnv())).toBe(false);
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
