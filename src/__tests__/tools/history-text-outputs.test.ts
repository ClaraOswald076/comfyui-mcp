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
