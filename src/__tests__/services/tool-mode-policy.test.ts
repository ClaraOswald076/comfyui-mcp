import { describe, expect, it } from "vitest";
import {
  DEFAULT_FULL_SURFACE_MIN_PARAMS_B,
  explicitToolMode,
  fullSurfaceMinParamsB,
  parseModelParamsB,
  resolveToolModeForModel,
} from "../../services/tool-mode-policy.js";

// #788 — auto-select the tool mode per MODEL, with a manual override in BOTH
// directions.
//
// Every assertion here checks `source` as well as `mode`, on purpose: "compact
// was applied" and "compact was applied BECAUSE of the model" are different
// results, and an override test that only checked `mode` would pass just as
// happily if the override were ignored and the default happened to agree.

describe("parseModelParamsB", () => {
  it("reads the parameter count out of the id shapes that actually ship", () => {
    expect(parseModelParamsB("qwen3:4b")).toBe(4);
    expect(parseModelParamsB("llama3.3:70b")).toBe(70);
    expect(parseModelParamsB("gpt-oss:120b")).toBe(120);
    expect(parseModelParamsB("deepseek-r1:1.5b")).toBe(1.5);
    expect(parseModelParamsB("deepseek-v3.1:671b-cloud")).toBe(671);
    expect(parseModelParamsB("gemma-3-27b-it-qat-q4_0")).toBe(27);
    expect(parseModelParamsB("Meta-Llama-3.1-405B-Instruct")).toBe(405);
  });

  it("multiplies out a mixture-of-experts tag (resident weights, not per-expert)", () => {
    expect(parseModelParamsB("mixtral:8x7b")).toBe(56);
    expect(parseModelParamsB("mixtral:8x22b")).toBe(176);
  });

  it("reads Gemma's effective-parameter tags", () => {
    expect(parseModelParamsB("gemma4:e2b")).toBe(2);
    expect(parseModelParamsB("gemma4:e4b")).toBe(4);
    expect(parseModelParamsB("artokun/gemma4-comfyui-mcp:e4b")).toBe(4);
  });

  it("returns null — never a small number — when the id carries no count", () => {
    // This distinction is load-bearing: "unknown" gets the documented fallback,
    // whereas guessing "small" would silently cripple a large hosted model.
    expect(parseModelParamsB("moonshotai/kimi-k2.5")).toBeNull();
    expect(parseModelParamsB("claude-opus-5")).toBeNull();
    expect(parseModelParamsB("z-ai/glm-5.1")).toBeNull();
    expect(parseModelParamsB("gpt-5.6-terra")).toBeNull();
  });

  it("is not fooled by quantisation suffixes", () => {
    expect(parseModelParamsB("qwen2.5-coder:32b-instruct-q4_K_M")).toBe(32);
    expect(parseModelParamsB("some-model:q8_0")).toBeNull();
    expect(parseModelParamsB("some-model:f16")).toBeNull();
  });
});

describe("explicitToolMode", () => {
  it("accepts exactly the two canonical tokens", () => {
    expect(explicitToolMode({ COMFYUI_MCP_TOOL_MODE: "full" })).toBe("full");
    expect(explicitToolMode({ COMFYUI_MCP_TOOL_MODE: "compact" })).toBe("compact");
  });

  it("treats anything else as NO choice rather than guessing at intent", () => {
    expect(explicitToolMode({ COMFYUI_MCP_TOOL_MODE: "FULL" })).toBeNull();
    expect(explicitToolMode({ COMFYUI_MCP_TOOL_MODE: "verbose" })).toBeNull();
    expect(explicitToolMode({ COMFYUI_MCP_TOOL_MODE: "" })).toBeNull();
    expect(explicitToolMode({})).toBeNull();
  });
});

describe("the user override wins in BOTH directions", () => {
  it("forcing FULL on a small model is honoured — and attributed to the user", () => {
    const d = resolveToolModeForModel({ model: "qwen3:4b", env: { COMFYUI_MCP_TOOL_MODE: "full" } });
    expect(d.mode).toBe("full");
    // Without this, the test would still pass if the override were dropped and
    // some future model rule happened to choose full.
    expect(d.source).toBe("user-explicit");
    expect(d.explain).toContain("you set it");
  });

  it("forcing COMPACT on a large model is honoured — and attributed to the user", () => {
    const d = resolveToolModeForModel({ model: "llama3.3:70b", env: { COMFYUI_MCP_TOOL_MODE: "compact" } });
    expect(d.mode).toBe("compact");
    expect(d.source).toBe("user-explicit");
    // The distinguishing check: the model rule would ALSO have produced a mode
    // here, and it would have been the opposite one.
    expect(resolveToolModeForModel({ model: "llama3.3:70b", env: {} }).mode).toBe("full");
  });

  it("a caller-pinned mode outranks the user env", () => {
    const d = resolveToolModeForModel({
      model: "qwen3:4b",
      env: { COMFYUI_MCP_TOOL_MODE: "compact" },
      callerEnv: { COMFYUI_MCP_TOOL_MODE: "full" },
    });
    expect(d.mode).toBe("full");
    expect(d.source).toBe("caller-explicit");
  });
});

describe("auto-selection keys on the MODEL, not the provider", () => {
  it("a large LOCAL model gets the full surface", () => {
    const d = resolveToolModeForModel({ model: "llama3.3:70b", env: {} });
    expect(d.mode).toBe("full");
    expect(d.source).toBe("model-parameters");
    expect(d.paramsB).toBe(70);
    expect(d.explain).toContain("llama3.3:70b");
  });

  it("a small model keeps compact, and the reason names the model", () => {
    const d = resolveToolModeForModel({ model: "qwen3:4b", env: {} });
    expect(d.mode).toBe("compact");
    expect(d.source).toBe("model-parameters");
    expect(d.paramsB).toBe(4);
    expect(d.explain).toContain("qwen3:4b");
  });

  it("an unreadable model id falls back to compact — as UNKNOWN, not as small", () => {
    const d = resolveToolModeForModel({ model: "moonshotai/kimi-k2.5", env: {} });
    expect(d.mode).toBe("compact");
    expect(d.source).toBe("unknown-model-fallback");
    expect(d.paramsB).toBeUndefined();
    expect(d.explain).toContain("COMFYUI_MCP_TOOL_MODE=full");
  });

  it("no model at all falls back to compact with its own distinct reason", () => {
    const d = resolveToolModeForModel({ env: {} });
    expect(d.mode).toBe("compact");
    expect(d.source).toBe("no-model-fallback");
  });

  it("exactly at the threshold is FULL (>=, not >)", () => {
    const d = resolveToolModeForModel({ model: `x:${DEFAULT_FULL_SURFACE_MIN_PARAMS_B}b`, env: {} });
    expect(d.mode).toBe("full");
    expect(d.source).toBe("model-parameters");
  });
});

describe("the threshold is overridable, and hostile values cannot reshape the surface", () => {
  it("lowering it promotes a mid-size model", () => {
    const env = { COMFYUI_MCP_FULL_SURFACE_MIN_PARAMS_B: "30" };
    expect(fullSurfaceMinParamsB(env as NodeJS.ProcessEnv)).toBe(30);
    const d = resolveToolModeForModel({ model: "qwen2.5:32b", env: env as NodeJS.ProcessEnv });
    expect(d.mode).toBe("full");
    expect(d.source).toBe("model-parameters");
    // …and the same model without the override stays compact.
    expect(resolveToolModeForModel({ model: "qwen2.5:32b", env: {} }).mode).toBe("compact");
  });

  it("garbage or non-positive values fall back to the documented default", () => {
    for (const raw of ["", "abc", "0", "-5", "NaN"]) {
      expect(fullSurfaceMinParamsB({ COMFYUI_MCP_FULL_SURFACE_MIN_PARAMS_B: raw } as NodeJS.ProcessEnv)).toBe(
        DEFAULT_FULL_SURFACE_MIN_PARAMS_B,
      );
    }
  });
});

describe("the explanation is user-facing and #726-proof", () => {
  it("always says which mode is active and how to change it", () => {
    for (const model of ["qwen3:4b", "llama3.3:70b", "moonshotai/kimi-k2.5"]) {
      const d = resolveToolModeForModel({ model, env: {} });
      expect(d.explain).toContain(`Tool mode: ${d.mode}`);
      expect(d.explain).toContain("COMFYUI_MCP_TOOL_MODE");
    }
  });

  it("never quotes a tool COUNT — the ~30-tool consolidation (#726) rewrites that number", () => {
    const texts = [
      resolveToolModeForModel({ model: "qwen3:4b", env: {} }).explain,
      resolveToolModeForModel({ model: "llama3.3:70b", env: {} }).explain,
      resolveToolModeForModel({ env: {} }).explain,
      resolveToolModeForModel({ model: "x", env: { COMFYUI_MCP_TOOL_MODE: "full" } }).explain,
    ];
    for (const t of texts) {
      // Every shape a count can take: "3 tools", "~200 schemas", "3-tool router".
      expect(t).not.toMatch(/~?\d+[\s-]*(tool|schema)/i);
      expect(t).not.toContain("list_tools");
      expect(t).not.toContain("describe_tool");
      expect(t).not.toContain("call_tool");
    }
  });
});
