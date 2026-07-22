import { describe, expect, it, vi } from "vitest";
import type { z } from "zod";

// The train tools pull config.js (env/port probes) — stub it the same way the
// runpod tool tests do so registration is side-effect free.
vi.mock("../../config.js", () => ({
  isRemoteMode: () => false,
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
