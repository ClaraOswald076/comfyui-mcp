import { describe, expect, it } from "vitest";
import type { HistoryEntry } from "../../comfyui/client.js";
import {
  analyzeHistoryEntry,
  extractExecutionError,
  extractExecutionStats,
  extractTextOutputs,
} from "../../services/job-history.js";

function historyEntry(messages: unknown): HistoryEntry {
  return {
    prompt: {},
    outputs: {},
    status: {
      status_str: "error",
      completed: true,
      messages,
    },
  } as HistoryEntry;
}

describe("job-history malformed message parsing", () => {
  it("ignores non-array status messages", () => {
    const entry = historyEntry({ type: "execution_error" });

    expect(extractExecutionError(entry)).toBeUndefined();
    expect(extractExecutionStats(entry)).toBeUndefined();
    expect(analyzeHistoryEntry(entry)).toEqual({});
  });

  it("ignores malformed message tuples and missing data objects", () => {
    const entry = historyEntry([
      "execution_start",
      ["execution_start"],
      ["execution_error", null],
      ["executed", "not-an-object"],
      [123, { timestamp: 1 }],
      ["execution_success", ["not-an-object"]],
    ]);

    expect(extractExecutionError(entry)).toBeUndefined();
    expect(extractExecutionStats(entry)).toBeUndefined();
    expect(analyzeHistoryEntry(entry)).toEqual({});
  });
});

// ── Text-preview outputs ────────────────────────────────────────────────
// Text-preview nodes (Preview as Text / ShowText / pack equivalents) write no
// file — they publish into the node's `ui` dict, which /history stores under
// outputs[nodeId]. We only harvested images/videos, so text workflows finished
// with nothing for the agent to report (help-thread report from seanmcmagic).

function outputsEntry(outputs: Record<string, unknown>): HistoryEntry {
  return {
    prompt: {},
    outputs,
    status: { status_str: "success", completed: true, messages: [] },
  } as unknown as HistoryEntry;
}

describe("extractTextOutputs", () => {
  it("extracts the common { text: [string] } shape", () => {
    const entry = outputsEntry({ "7": { text: ["a caption"] } });
    expect(extractTextOutputs(entry)).toEqual([{ node_id: "7", text: ["a caption"] }]);
  });

  it("accepts a bare string and the `string` key variant", () => {
    expect(extractTextOutputs(outputsEntry({ "1": { text: "hello" } }))).toEqual([
      { node_id: "1", text: ["hello"] },
    ]);
    expect(extractTextOutputs(outputsEntry({ "2": { string: ["packy"] } }))).toEqual([
      { node_id: "2", text: ["packy"] },
    ]);
  });

  it("stringifies non-string scalars and drops empty strings", () => {
    const entry = outputsEntry({ "3": { text: ["", 42, true, "keep"] } });
    expect(extractTextOutputs(entry)).toEqual([{ node_id: "3", text: ["42", "true", "keep"] }]);
  });

  it("collects text from multiple nodes and ignores image-only nodes", () => {
    const entry = outputsEntry({
      "5": { images: [{ filename: "a.png", subfolder: "", type: "output" }] },
      "6": { text: ["from six"] },
      "8": { text: ["from eight"] },
    });
    expect(extractTextOutputs(entry)).toEqual([
      { node_id: "6", text: ["from six"] },
      { node_id: "8", text: ["from eight"] },
    ]);
  });

  it("returns nothing for image-only, empty, or malformed outputs", () => {
    expect(extractTextOutputs(outputsEntry({ "5": { images: [] } }))).toEqual([]);
    expect(extractTextOutputs(outputsEntry({ "5": { text: [] } }))).toEqual([]);
    expect(extractTextOutputs(outputsEntry({ "5": { text: [""] } }))).toEqual([]);
    expect(extractTextOutputs(outputsEntry({ "5": null as unknown as object }))).toEqual([]);
    expect(extractTextOutputs({ prompt: {}, status: {} } as unknown as HistoryEntry)).toEqual([]);
  });
});

describe("analyzeHistoryEntry text_outputs", () => {
  it("surfaces text_outputs when the run produced text", () => {
    const entry = outputsEntry({ "7": { text: ["reported back"] } });
    expect(analyzeHistoryEntry(entry).text_outputs).toEqual([
      { node_id: "7", text: ["reported back"] },
    ]);
  });

  it("omits text_outputs entirely for an image-only run", () => {
    const entry = outputsEntry({
      "9": { images: [{ filename: "a.png", subfolder: "", type: "output" }] },
    });
    expect(analyzeHistoryEntry(entry).text_outputs).toBeUndefined();
    expect("text_outputs" in analyzeHistoryEntry(entry)).toBe(false);
  });
});

describe("extractTextOutputs — real ComfyUI payload", () => {
  // Captured verbatim from a live ComfyUI run (StringConstant -> PreviewAny) on
  // 2026-07-20. Locks the on-the-wire shape so a future refactor can't silently
  // stop reading text-preview results.
  it("reads the exact /history payload PreviewAny produces", () => {
    const entry = outputsEntry({ "2": { text: ["TEXT-PREVIEW-PROOF-42"] } });
    expect(extractTextOutputs(entry)).toEqual([
      { node_id: "2", text: ["TEXT-PREVIEW-PROOF-42"] },
    ]);
    expect(analyzeHistoryEntry(entry).text_outputs).toEqual([
      { node_id: "2", text: ["TEXT-PREVIEW-PROOF-42"] },
    ]);
  });
});
