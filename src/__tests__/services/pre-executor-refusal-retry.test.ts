// #1529 — the orchestrator half: wait out a reconnect refusal instead of handing it back.
//
// `panel_set_widget` is refused while ComfyUI's backend reconnects. The refusal is
// correct — a mutation dispatched then lands on a canvas the reconnect is about to
// rebuild — and it is SAFE TO RETRY, because the panel's gate runs before its
// executor so nothing was applied.
//
// THE FIRST ATTEMPT AT THIS READ THAT FROM THE WORDING AND WAS REVERTED AS A P0.
// Acknowledged panel errors travel as arbitrary `msg.error` text, so any sentence the
// gate writes is one a genuine MID-WRITE failure can also contain — and being wrong
// here does not print a bad message, it RE-ISSUES A MUTATION that already landed.
//
// The panel states it structurally now (panel 0.14.35 / comfyui-mcp-panel#1216), and
// this reads that field and nothing else.
import { describe, expect, it } from "vitest";

import {
  PANEL_REFUSAL_PROP,
  attachPanelRefusal,
  isPreExecutorRefusal,
  readPanelRefusal,
} from "../../services/panel-refusal.js";

const GOOD = {
  code: "backend-reconnecting",
  applied: false,
  stage: "pre-executor",
  retryable: true,
};

describe("readPanelRefusal — every claim is required (#1529)", () => {
  it("accepts a complete pre-executor refusal, for both codes", () => {
    for (const code of ["backend-reconnecting", "post-reconnect-settling"]) {
      expect(readPanelRefusal({ ...GOOD, code })).toEqual({
        code,
        applied: false,
        stage: "pre-executor",
        retryable: true,
      });
    }
  });

  it("REJECTS a refusal missing or contradicting any single claim", () => {
    // This authorises re-issuing a MUTATION. A partial claim is not a claim.
    const mutations: Array<Record<string, unknown>> = [
      { ...GOOD, applied: true },
      { ...GOOD, applied: undefined },
      { ...GOOD, stage: "post-executor" },
      { ...GOOD, stage: undefined },
      { ...GOOD, retryable: false },
      { ...GOOD, retryable: undefined },
      { ...GOOD, code: "something-else" },
      { ...GOOD, code: undefined },
    ];
    for (const m of mutations) {
      expect(readPanelRefusal(m), JSON.stringify(m)).toBeNull();
    }
  });

  it("REJECTS junk instead of coercing it", () => {
    for (const junk of [null, undefined, 0, "", "backend-reconnecting", [], true]) {
      expect(readPanelRefusal(junk), String(junk)).toBeNull();
    }
  });

  it("returns a FRESH object — nothing else on the wire value travels", () => {
    const wire = { ...GOOD, smuggled: { token: "sensitive" }, applied: false };
    const out = readPanelRefusal(wire);
    expect(Object.keys(out ?? {}).sort()).toEqual(["applied", "code", "retryable", "stage"]);
    expect(out).not.toBe(wire);
  });
});

describe("isPreExecutorRefusal — only the panel's own claim (#1529)", () => {
  it("reads a refusal the bridge attached", () => {
    const err = attachPanelRefusal(new Error("[backend-reconnecting] …"), {
      code: "backend-reconnecting",
      applied: false,
      stage: "pre-executor",
      retryable: true,
    });
    expect(isPreExecutorRefusal(err)?.code).toBe("backend-reconnecting");
  });

  it("an ordinary error authorises nothing", () => {
    expect(isPreExecutorRefusal(new Error("node exploded mid-write"))).toBeNull();
    for (const junk of [null, undefined, "x", 42, {}]) {
      expect(isPreExecutorRefusal(junk), String(junk)).toBeNull();
    }
  });

  it("an INHERITED property is refused — own property only", () => {
    // A polluted Error.prototype, or a library that decorates Error, would
    // otherwise let an unrelated mid-write failure authorise a mutation retry.
    Object.defineProperty(Error.prototype, PANEL_REFUSAL_PROP, {
      value: { ...GOOD },
      configurable: true,
      writable: true,
      enumerable: false,
    });
    try {
      const midWrite = new Error("the node was added, then the socket died");
      expect((midWrite as unknown as Record<string, unknown>)[PANEL_REFUSAL_PROP]).toBeTruthy();
      expect(isPreExecutorRefusal(midWrite), "inherited must not authorise a retry").toBeNull();
    } finally {
      delete (Error.prototype as unknown as Record<string, unknown>)[PANEL_REFUSAL_PROP];
    }
    expect(PANEL_REFUSAL_PROP in Error.prototype).toBe(false);
  });

  it("a TAMPERED attachment is refused — validated on read, not only on attach", () => {
    const err = attachPanelRefusal(new Error("x"), { ...GOOD } as never);
    (err as unknown as Record<string, Record<string, unknown>>)[PANEL_REFUSAL_PROP].applied = true;
    expect(isPreExecutorRefusal(err)).toBeNull();
  });

  it("attaching never collides with Error's own fields", () => {
    const err = attachPanelRefusal(new Error("x"), { ...GOOD } as never);
    expect((err as unknown as { code?: unknown }).code).toBeUndefined();
    expect(err.message).toBe("x");
  });

  it("attaching survives a non-writable prototype property", () => {
    // Assignment would THROW in strict mode here, turning a clear refusal into an
    // unrelated TypeError — the trap the panel side hit (comfyui-mcp-panel#1216).
    Object.defineProperty(Error.prototype, PANEL_REFUSAL_PROP, {
      value: { ...GOOD },
      configurable: true,
      writable: false,
      enumerable: false,
    });
    try {
      const err = attachPanelRefusal(new Error("x"), { ...GOOD } as never);
      expect(isPreExecutorRefusal(err)?.code).toBe("backend-reconnecting");
    } finally {
      delete (Error.prototype as unknown as Record<string, unknown>)[PANEL_REFUSAL_PROP];
    }
  });
});

// ── WIRING. The lib is useless if the bridge never attaches it or the retry gate
//    never reads it, and both are single lines in large files.

describe("the channel is actually connected (#1529)", () => {
  it("the bridge attaches a validated refusal to the rejected error", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../../services/ui-bridge.ts", import.meta.url), "utf-8");
    const at = src.indexOf('new Error(String(msg.error ?? "panel reported an error"))');
    expect(at, "the reply-to-error conversion must still be recognisable").toBeGreaterThan(-1);
    const block = src.slice(at, at + 400);
    expect(block).toMatch(/readPanelRefusal\(\(msg as \{ refusal\?: unknown \}\)\.refusal\)/);
    expect(block).toMatch(/refusal \? attachPanelRefusal\(err, refusal\) : err/);
  });

  it("the retry gate keys on the FIELD, and lets a MUTATION through on it", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../../orchestrator/panel-tools.ts", import.meta.url), "utf-8");
    // The gate must consult the refusal INDEPENDENTLY of isRetrySafeCmd — that is
    // the entire change. `isRetrySafeCmd && …` alone would leave mutations, which
    // are exactly what #1529 is about, still un-retried.
    expect(src).toMatch(/const preExecutorRefusal = isPreExecutorRefusal\(err\);/);
    expect(src).toMatch(
      /preExecutorRefusal \|\|\s*\n\s*\(isRetrySafeCmd\(cmd\) &&/,
      "the refusal must be an OR beside the retry-safe gate, not an AND inside it",
    );
  });

  it("nothing in the orchestrator decides this from the message TEXT", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../../orchestrator/panel-tools.ts", import.meta.url), "utf-8");
    const codeOnly = src
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join("\n");
    // The reverted P0 MATCHED these sentences. What must not exist is a matching
    // construct over the refusal's wording — the orchestrator composing that phrase
    // in a message of its own is fine and does happen (the #1027 switch refusal
    // says "was NOT applied — nothing changed" itself), which is why this asserts
    // on regex/includes/test rather than on the words appearing at all. The first
    // version of this test forbade the words outright and failed against correct
    // code.
    const matchers = codeOnly.match(/\/[^/\n]*(backend-reconnecting|post-reconnect-settling)[^/\n]*\//g);
    expect(matchers, "no REGEX may key on the refusal wording").toBeNull();
    for (const phrase of ["backend-reconnecting", "post-reconnect-settling", "NOT applied"]) {
      const tested = new RegExp(
        `(includes|startsWith|indexOf|test)\\([^)\\n]*${phrase.replace(/[-—]/g, "[-—]")}`,
      );
      expect(codeOnly, `no string test may key on "${phrase}"`).not.toMatch(tested);
    }
  });
});
