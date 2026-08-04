import { describe, expect, it, vi } from "vitest";
import type { z } from "zod";

// The train tools pull config.js (env/port probes) — stub it the same way the
// runpod tool tests do so registration is side-effect free. `config` is part of
// that surface: train_doctor reports `hfTokenSet` from config.huggingfaceToken
// (access-time, both aliases — #826), so a mock without it would make that
// handler throw rather than report.
const mockConfig = vi.hoisted(() => ({ huggingfaceToken: undefined as string | undefined }));
vi.mock("../../config.js", () => ({
  isRemoteMode: () => false,
  config: mockConfig,
}));

import { registerTrainTools } from "../../tools/train.js";

/** Capture the zod SHAPE a tool registered with (server.tool(name, desc, shape, handler)). */
function getShape(name: string): Record<string, z.ZodType> {
  let shape: Record<string, z.ZodType> | undefined;
  const server = { tool: (n: string, _d: string, s: unknown, _h: unknown) => { if (n === name) shape = s as Record<string, z.ZodType>; } };
  registerTrainTools(server as never);
  if (!shape) throw new Error(`tool ${name} not registered`);
  return shape;
}

describe("train_start params bounds (#104 — a Custom-preset typo must not start a doomed billed run)", () => {
  const params = () => getShape("train_start").params;

  it("accepts sane custom params (and every preset value)", () => {
    for (const p of [
      { steps: 2000, lr: 1e-4, rank: 16, resolution: [512, 768, 1024] },
      { steps: 1, lr: 0.5, rank: 1024, resolution: [64] },
      { steps: 100_000, lr: 1, rank: 1, resolution: [4096] },
      {}, // all-optional
    ]) {
      expect(params().safeParse(p).success, JSON.stringify(p)).toBe(true);
    }
  });

  it("rejects absurd values that would doom/OOM a run", () => {
    for (const p of [
      { steps: 1_000_000_000 },
      { steps: 100_001 },
      { steps: 0 },
      { lr: 10 },
      { rank: 100_000 },
      { rank: 1025 },
      { rank: 0 },
      { resolution: [100_000] },
      { resolution: [8192] },
      { resolution: [32] },
      { resolution: [0] },
      { resolution: [] },
    ]) {
      expect(params().safeParse(p).success, JSON.stringify(p)).toBe(false);
    }
  });

  it("rejects non-integer steps/rank/resolution", () => {
    expect(params().safeParse({ steps: 200.5 }).success).toBe(false);
    expect(params().safeParse({ rank: 15.5 }).success).toBe(false);
    expect(params().safeParse({ resolution: [511.5] }).success).toBe(false);
  });
});

// #826 — train_doctor's `hfTokenSet` used to read process.env.HF_TOKEN directly,
// so it reported "no token" for a token saved after this process started and
// ignored the HUGGINGFACE_TOKEN alias entirely. It now reports what the readers
// actually resolve (config.huggingfaceToken). Presence only — never the value.
describe("train_doctor reports HF token PRESENCE from the resolved credential", () => {
  function getHandler(name: string) {
    let handler: ((args: Record<string, unknown>) => Promise<unknown>) | undefined;
    const server = {
      tool: (
        n: string,
        _d: string,
        _s: unknown,
        h: (a: Record<string, unknown>) => Promise<unknown>,
      ) => {
        if (n === name) handler = h;
      },
    };
    registerTrainTools(server as never);
    if (!handler) throw new Error(`tool ${name} not registered`);
    return handler;
  }

  async function doctorText(): Promise<string> {
    const out = (await getHandler("train_doctor")({})) as { content: Array<{ text: string }> };
    return out.content[0].text;
  }

  it("reports false when nothing resolves", async () => {
    mockConfig.huggingfaceToken = undefined;
    expect(JSON.parse(await doctorText()).data.hfTokenSet).toBe(false);
  });

  it("reports true for a resolved token, and never echoes it", async () => {
    mockConfig.huggingfaceToken = "hf-resolved-value";
    try {
      const text = await doctorText();
      expect(JSON.parse(text).data.hfTokenSet).toBe(true);
      expect(text).not.toContain("hf-resolved-value");
    } finally {
      mockConfig.huggingfaceToken = undefined;
    }
  });

  it("treats a whitespace-only value as NOT set", async () => {
    mockConfig.huggingfaceToken = "   ";
    try {
      expect(JSON.parse(await doctorText()).data.hfTokenSet).toBe(false);
    } finally {
      mockConfig.huggingfaceToken = undefined;
    }
  });
});
