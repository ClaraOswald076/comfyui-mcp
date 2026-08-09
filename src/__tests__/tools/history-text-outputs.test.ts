// #1229 — get_history reported a text output's KEY and dropped its VALUE.
//
// `PreviewAny` is a DIAGNOSTIC node: its whole purpose is to surface a value for
// a human to read. Rendering `{ text: ["diagnostic details"] }` as
// "Node 102: text" turns the one node whose output IS the answer into a node
// that says only that an answer exists — and it fails silently, so a caller has
// no way to know a value was there.
//
// Same class as #1175 (a refusal asserting "could not be identified" while
// holding the identifying evidence): we had it and did not show it.

import { describe, expect, it } from "vitest";

import { formatHistoryEntry } from "../../tools/diagnostics.js";

/** The reporter's shape: an output node whose payload is a bare string array. */
function entryWith(outputs: Record<string, unknown>) {
  return {
    status: { status_str: "success", completed: true, messages: [] },
    outputs,
  } as never;
}

describe("get_history surfaces non-media output values (#1229)", () => {
  it("prints the VALUE of a text output, not just the key", () => {
    const out = formatHistoryEntry("p1", entryWith({ "102": { text: ["diagnostic details"] } }));
    expect(out).toContain("diagnostic details");
  });

  it("does not regress to naming the key alone", () => {
    // The exact rendering the reporter saw.
    const out = formatHistoryEntry("p1", entryWith({ "102": { text: ["diagnostic details"] } }));
    expect(out).not.toMatch(/Node 102: text$/m);
  });

  it("handles OTHER non-media keys too — this is a class, not a `text` special case", () => {
    // Fixing only `text` would leave the identical defect for every custom node
    // that names its output anything else.
    const out = formatHistoryEntry("p1", entryWith({ "7": { tags: ["alpha", "beta"] } }));
    expect(out).toContain("alpha");
    expect(out).toContain("beta");
  });

  it("still renders media outputs the existing way", () => {
    // The media path is the branch that already worked; widening the fallback
    // must not disturb it.
    const out = formatHistoryEntry(
      "p1",
      entryWith({ "9": { images: [{ filename: "a.png", subfolder: "", type: "output" }] } }),
    );
    expect(out).toContain("a.png");
    expect(out).toContain("type=output");
  });

  it("KEEPS the value alongside media - the same bug survived one branch over", () => {
    // Review HIGH 1, found on STOCK ComfyUI: SaveAnimatedWEBP emits
    // {images, animated}; a captioner emits {images, text}. `expanded.length > 0`
    // short-circuited, so a node carrying media AND a payload lost the payload
    // exactly as #1229 described. Fixing only the no-media branch fixed only the
    // case I happened to test.
    const out = formatHistoryEntry(
      "p1",
      entryWith({
        "2": {
          images: [{ filename: "a.webp", subfolder: "", type: "output" }],
          animated: [true],
          text: ["caption here"],
        },
      }),
    );
    expect(out).toContain("a.webp");
    expect(out).toContain("animated");
    expect(out).toContain("caption here");
  });

  it("does not re-print a media key as a leftover", () => {
    const out = formatHistoryEntry(
      "p1",
      entryWith({ "2": { images: [{ filename: "a.png", subfolder: "", type: "output" }] } }),
    );
    expect(out.split("a.png").length - 1).toBe(1);
  });

  it("RETAINS the leading content when it truncates", () => {
    // Review HIGH 2: slice(0, 0) survived every test. The only truncation test
    // asserted a length bound and the word "truncated", so the fix could keep
    // ZERO characters, staple on a note, and stay green - #1229's exact failure
    // mode with a label. The real PreviewAny payload measured in review was
    // 7,695 chars for a blank 64x64 image, so the clip is the COMMON path for
    // the very node this issue is about.
    const body = "HEAD_MARKER" + "x".repeat(5000);
    const out = formatHistoryEntry("p1", entryWith({ "3": { text: [body] } }));
    expect(out).toContain("HEAD_MARKER");
    expect(out).toContain("x".repeat(700));
  });

  it("pins the cap so it cannot be silently retuned", () => {
    // 800 was unpinned across ~18..3900; a "tune" to 3800 was invisible.
    const under = formatHistoryEntry("p1", entryWith({ "4": { text: ["y".repeat(800)] } }));
    expect(under).not.toMatch(/truncated/i);
    const over = formatHistoryEntry("p1", entryWith({ "4": { text: ["y".repeat(801)] } }));
    expect(over).toContain("truncated, 801 chars total");
  });

  it("keeps array separators visible so entries cannot merge", () => {
    const out = formatHistoryEntry("p1", entryWith({ "7": { tags: ["alpha", "beta"] } }));
    expect(out).toContain("alpha, beta");
  });

  it("labels an empty value instead of rendering a bare key", () => {
    // A bare key is character-identical to the #1229 symptom.
    const out = formatHistoryEntry("p1", entryWith({ "8": { text: [], other: "" } }));
    expect(out).toContain("(empty)");
  });

  it("does not split a surrogate pair at the cap", () => {
    const emoji = String.fromCodePoint(0x1f600);
    const out = formatHistoryEntry(
      "p1",
      entryWith({ "9": { text: ["z".repeat(799) + emoji + "tail"] } }),
    );
    expect((out as unknown as { isWellFormed?: () => boolean }).isWellFormed?.() ?? true).toBe(true);
  });

  it("serialises an OBJECT value, never [object Object]", () => {
    // Surviving mutation from review: String(v) in place of JSON.stringify.
    // This repo has a documented recurring [object Object] family, so a
    // rendering path that can produce it must be pinned, not left to style.
    const out = formatHistoryEntry("p1", entryWith({ "5": { meta: [{ seed: 42 }] } }));
    expect(out).not.toContain("[object Object]");
    expect(out).toContain("42");
  });

  it("keeps a multi-line value from shattering the bullet list", () => {
    // The motivating use case is reading validation errors through a scratch
    // PreviewAny, which are multi-line by nature; unindented spill put ~40 bare
    // lines between two node bullets.
    const out = formatHistoryEntry("p1", entryWith({ "6": { text: ["line1\nline2"] } }));
    expect(out).toContain("    line1");
    expect(out).toContain("    line2");
  });

  it("SAYS when it truncated, rather than silently eliding", () => {
    // History can carry large values and this is read by an agent with a token
    // budget. Silently cutting a long value recreates #1229 at a different
    // threshold — the caller still cannot tell that something was dropped.
    const long = "x".repeat(5000);
    const out = formatHistoryEntry("p1", entryWith({ "3": { text: [long] } }));
    expect(out.length).toBeLessThan(4000);
    expect(out).toMatch(/truncated/i);
  });
});
