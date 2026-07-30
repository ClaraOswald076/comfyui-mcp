// Coverage for the shared text-coercion helpers that keep structured payloads
// from surfacing as the literal "[object Object]" in chat / prompts
// (issues #176, #175).

import { describe, expect, it } from "vitest";
import { errorText, promptText } from "./error-text.js";

describe("errorText (#176)", () => {
  it("returns the message of an Error", () => {
    expect(errorText(new Error("boom"))).toBe("boom");
  });

  it("never returns [object Object] for a plain object error", () => {
    const out = errorText({ code: 429, foo: "bar" });
    expect(out).not.toBe("[object Object]");
    expect(out).toBe('{"code":429,"foo":"bar"}');
  });

  it("extracts a string message field from a structured error", () => {
    expect(errorText({ message: "Individual quota reached." })).toBe(
      "Individual quota reached.",
    );
  });

  it("coerces primitives with String()", () => {
    expect(errorText(42)).toBe("42");
    expect(errorText(null)).toBe("null");
  });

  it("degrades a cyclic object to 'unknown error', never [object Object]", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const out = errorText(cyclic);
    expect(out).not.toBe("[object Object]");
    expect(out).toBe("unknown error");
  });

  it("does not throw and never returns [object Object] for a throwing getter", () => {
    const hostile = {
      get message(): string {
        throw new Error("getter exploded");
      },
    };
    let out = "";
    expect(() => {
      out = errorText(hostile);
    }).not.toThrow();
    expect(out).not.toBe("[object Object]");
  });

  it("coerces an Error whose runtime message is a non-string object", () => {
    const err = new Error("placeholder");
    // Simulate a subclass / runtime that set a non-string message.
    (err as { message: unknown }).message = { code: 500 };
    const out = errorText(err);
    expect(out).not.toBe("[object Object]");
    expect(out).toBe('{"code":500}');
  });
});

describe("promptText (#175)", () => {
  it("passes strings through unchanged", () => {
    expect(promptText("hello")).toBe("hello");
  });

  it("never returns [object Object] for a structured user payload", () => {
    const out = promptText({ type: "image", ref: "input/a.png" });
    expect(out).not.toBe("[object Object]");
    expect(out).toBe('{"type":"image","ref":"input/a.png"}');
  });

  it("extracts a string text field from a multi-part payload", () => {
    expect(promptText({ text: "typed message", parts: [] })).toBe("typed message");
  });

  it("maps null/undefined to empty string", () => {
    expect(promptText(null)).toBe("");
    expect(promptText(undefined)).toBe("");
  });

  it("does NOT collapse an empty-text payload that still carries parts", () => {
    const out = promptText({ text: "", parts: [{ kind: "image", ref: "input/b.png" }] });
    expect(out).not.toBe("");
    expect(out).toContain("input/b.png");
  });

  it("gives a non-empty fallback when serialization fails (circular)", () => {
    const cyclic: Record<string, unknown> = { parts: [1] };
    cyclic.self = cyclic;
    const out = promptText(cyclic);
    expect(out).not.toBe("");
    expect(out).not.toBe("[object Object]");
  });

  it("does not throw on a throwing getter and never returns [object Object]", () => {
    const hostile = {
      get text(): string {
        throw new Error("boom");
      },
      other: "x",
    };
    let out = "";
    expect(() => {
      out = promptText(hostile);
    }).not.toThrow();
    expect(out).not.toBe("[object Object]");
  });

  it("never returns '' when text is empty but the parts read throws", () => {
    const hostile = {
      get text(): string {
        return "";
      },
      get parts(): unknown {
        throw new Error("parts exploded");
      },
    };
    let out = "";
    expect(() => {
      out = promptText(hostile);
    }).not.toThrow();
    expect(out).not.toBe("");
    expect(out).not.toBe("[object Object]");
  });
});
