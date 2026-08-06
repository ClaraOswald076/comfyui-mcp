import { describe, expect, it } from "vitest";
import {
  backendSharesRenderGpu,
  isLocalLlamacpp,
  isLoopbackServerUrl,
  pauseLocalOnGenEnabled,
} from "../../services/local-vram.js";
import { isLocalLmstudio } from "../../services/lmstudio-lifecycle.js";

// Issue #874 — the VRAM handoff (hold chats + free VRAM while ComfyUI renders)
// skipped the llama.cpp backend entirely, so on a single-GPU box the agent's
// LLM kept contending with the render. The gate must cover llama.cpp ONLY when
// the server is local: a remote COMFYUI_MCP_LLAMACPP_HOST is someone else's
// VRAM and holding those chats would stall work for a contention that doesn't
// exist. Locality is the same loopback-URL rule the LM Studio path uses.

describe("isLoopbackServerUrl", () => {
  it("accepts the loopback family, with or without port/path", () => {
    expect(isLoopbackServerUrl("http://127.0.0.1:8080/v1")).toBe(true);
    expect(isLoopbackServerUrl("http://127.0.0.1:8080")).toBe(true);
    expect(isLoopbackServerUrl("http://127.0.0.1")).toBe(true);
    expect(isLoopbackServerUrl("http://localhost:1234/v1")).toBe(true);
    expect(isLoopbackServerUrl("https://localhost")).toBe(true);
    expect(isLoopbackServerUrl("http://[::1]:8080/v1")).toBe(true);
  });

  it("rejects remote hosts — LAN IPs, hostnames, cloud URLs", () => {
    expect(isLoopbackServerUrl("http://192.168.1.50:8080/v1")).toBe(false);
    expect(isLoopbackServerUrl("http://10.0.0.2:8080/v1")).toBe(false);
    expect(isLoopbackServerUrl("https://gpu-box.example.com/v1")).toBe(false);
    expect(isLoopbackServerUrl("http://localhost.evil.example.com/v1")).toBe(false);
  });
});

describe("isLocalLlamacpp", () => {
  it("treats the default llama.cpp host as local", () => {
    expect(isLocalLlamacpp("http://127.0.0.1:8080/v1")).toBe(true);
  });

  it("treats a remote COMFYUI_MCP_LLAMACPP_HOST as NOT local (never gated)", () => {
    expect(isLocalLlamacpp("http://192.168.1.20:8080/v1")).toBe(false);
  });
});

describe("isLocalLmstudio (delegates to the shared rule)", () => {
  it("keeps its established answers after the shared-regex refactor", () => {
    expect(isLocalLmstudio("http://127.0.0.1:1234/v1")).toBe(true);
    expect(isLocalLmstudio("http://localhost:1234/v1")).toBe(true);
    expect(isLocalLmstudio("http://[::1]:1234/v1")).toBe(true);
    expect(isLocalLmstudio("http://192.168.1.20:1234/v1")).toBe(false);
  });
});

describe("backendSharesRenderGpu — the per-tab handoff gate", () => {
  const ALL_LOCAL = { ollama: true, lmstudio: true, llamacpp: true };

  it("gates a local llama.cpp tab (#874 — the missing case)", () => {
    expect(backendSharesRenderGpu("llamacpp", ALL_LOCAL)).toBe(true);
  });

  it("does NOT gate a llama.cpp tab whose server is remote", () => {
    expect(
      backendSharesRenderGpu("llamacpp", { ollama: true, lmstudio: true, llamacpp: false }),
    ).toBe(false);
  });

  it("keeps the ollama rule: native dialect only, never the openai dialect", () => {
    expect(backendSharesRenderGpu("ollama", ALL_LOCAL)).toBe(true);
    expect(
      backendSharesRenderGpu("ollama", { ollama: false, lmstudio: true, llamacpp: true }),
    ).toBe(false);
  });

  it("keeps the lmstudio rule: local server only", () => {
    expect(backendSharesRenderGpu("lmstudio", ALL_LOCAL)).toBe(true);
    expect(
      backendSharesRenderGpu("lmstudio", { ollama: true, lmstudio: false, llamacpp: true }),
    ).toBe(false);
  });

  it("never gates hosted/custom backends, even when local servers exist", () => {
    for (const backend of ["claude", "codex", "gemini", "grok", "openrouter", "custom", "copilot"]) {
      expect(backendSharesRenderGpu(backend, ALL_LOCAL)).toBe(false);
    }
  });
});

describe("pauseLocalOnGenEnabled — neutral env alias with legacy fallback", () => {
  it("defaults ON when neither name is set", () => {
    expect(pauseLocalOnGenEnabled({})).toBe(true);
  });

  it("honors the legacy COMFYUI_MCP_OLLAMA_PAUSE_ON_GEN=0 opt-out", () => {
    expect(pauseLocalOnGenEnabled({ COMFYUI_MCP_OLLAMA_PAUSE_ON_GEN: "0" })).toBe(false);
  });

  it("honors the neutral COMFYUI_MCP_PAUSE_LOCAL_ON_GEN=0 opt-out", () => {
    expect(pauseLocalOnGenEnabled({ COMFYUI_MCP_PAUSE_LOCAL_ON_GEN: "0" })).toBe(false);
  });

  it("lets the neutral name win when both are set", () => {
    expect(
      pauseLocalOnGenEnabled({
        COMFYUI_MCP_PAUSE_LOCAL_ON_GEN: "1",
        COMFYUI_MCP_OLLAMA_PAUSE_ON_GEN: "0",
      }),
    ).toBe(true);
    expect(
      pauseLocalOnGenEnabled({
        COMFYUI_MCP_PAUSE_LOCAL_ON_GEN: "0",
        COMFYUI_MCP_OLLAMA_PAUSE_ON_GEN: "1",
      }),
    ).toBe(false);
  });
});
