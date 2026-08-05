// Tests for the arena model-facts probe (#792) — above all the fold-safety:
// a malformed or absent observation must stay ABSENT from the recorded facts,
// never collapse into a definitive empty/zero.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error plain-JS module under scripts/, no type declarations
import { probeModelFacts } from "../../scripts/arena-probe.mjs";

let showBody: unknown = {};
let psBody: unknown = { models: [] };

const fetchMock = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
  const url = String(input);
  if (url.endsWith("/api/show")) {
    return new Response(JSON.stringify(showBody), { status: 200 });
  }
  if (url.endsWith("/api/ps")) {
    return new Response(JSON.stringify(psBody), { status: 200 });
  }
  return new Response("not found", { status: 404 });
});

beforeEach(() => {
  showBody = {};
  psBody = { models: [] };
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("probeModelFacts (#792)", () => {
  it("records quant, params, capabilities, and resident VRAM when the probes answer", async () => {
    showBody = {
      details: { quantization_level: "Q4_K_M", parameter_size: "7.5B" },
      capabilities: ["completion", "vision", "tools"],
    };
    psBody = { models: [{ name: "gemma4:e4b", size_vram: 5905580032 }] };
    const facts = await probeModelFacts("http://x", "gemma4:e4b");
    expect(facts).toEqual({
      quant: "Q4_K_M",
      params: "7.5B",
      capabilities: ["completion", "vision", "tools"],
      vramResidentBytes: 5905580032,
    });
  });

  it("a malformed capabilities array is UNKNOWN — omitted, never an affirmative empty list", async () => {
    showBody = { capabilities: [null] };
    const facts = await probeModelFacts("http://x", "m:1b");
    expect("capabilities" in facts).toBe(false);
  });

  it("a failed probe leaves every field absent (never zero, never guessed)", async () => {
    fetchMock.mockRejectedValueOnce(new Error("connection refused"));
    fetchMock.mockRejectedValueOnce(new Error("connection refused"));
    const facts = await probeModelFacts("http://x", "m:1b");
    expect(facts).toEqual({});
  });

  it("a zero size_vram is not a resident measurement", async () => {
    psBody = { models: [{ name: "m:1b", size_vram: 0 }] };
    const facts = await probeModelFacts("http://x", "m:1b");
    expect("vramResidentBytes" in facts).toBe(false);
  });
});
