// The panel's API Keys card never told anyone that these providers ship a pinned
// default model with an env override — so a user on a newer model (e.g. GLM 5.2)
// had no way to discover they could point at it without reading the source.
// `providerModelHint` generates that line FROM the registry so it can't drift
// from the real default, and the credential slot appends it to its help text.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  OPENAI_KEY_PROVIDERS,
  openAiKeyProvider,
  providerModelHint,
} from "../../services/openai-provider-registry.js";

const GLM = openAiKeyProvider("glm")!;
const saved = new Map<string, string | undefined>();

beforeEach(() => {
  for (const p of OPENAI_KEY_PROVIDERS) {
    saved.set(p.modelEnv, process.env[p.modelEnv]);
    delete process.env[p.modelEnv];
  }
});
afterEach(() => {
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("providerModelHint", () => {
  it("names the default model AND the env var that overrides it", () => {
    const hint = providerModelHint(GLM);
    expect(hint).toContain(GLM.defaultModel); // e.g. glm-4.7
    expect(hint).toContain(GLM.modelEnv); // COMFYUI_MCP_GLM_MODEL
    expect(hint).toMatch(/default/i);
  });

  it("reports the ACTIVE model when the env override is set", () => {
    process.env[GLM.modelEnv] = "glm-5.2";
    const hint = providerModelHint(GLM);
    // Answers "why am I not on the model I set?" — shows active + where it came
    // from + what the default would be.
    expect(hint).toContain("glm-5.2");
    expect(hint).toContain(GLM.modelEnv);
    expect(hint).toContain(GLM.defaultModel);
  });

  it("is generated for every registry provider (no hand-written drift)", () => {
    for (const p of OPENAI_KEY_PROVIDERS) {
      const hint = providerModelHint(p);
      expect(hint).toContain(p.defaultModel);
      expect(hint).toContain(p.modelEnv);
    }
  });
});

describe("credential slot help", () => {
  it("appends the model hint to the GLM slot, and names the Z.AI Coding Plan", async () => {
    // Imported lazily so the beforeEach env reset applies to the module's
    // slot construction (CREDENTIAL_SLOTS is built at module load).
    const { CREDENTIAL_SLOTS } = await import("../../services/panel-secrets.js");
    const slot = CREDENTIAL_SLOTS.find((s) => s.id === "glm");
    expect(slot).toBeTruthy();
    expect(slot!.help).toMatch(/Z\.AI Coding Plan/i);
    expect(slot!.help).toContain(GLM.modelEnv);
  });
});
