import { describe, expect, it, beforeEach, vi } from "vitest";

// Mock the ComfyUI client + config so reconcile runs against canned /history
// payloads. getClient/ensureConnected are imported by job-watcher (same module
// graph), so the mock must provide them even though reconcile never calls them.
const getHistoryMock = vi.fn();
vi.mock("../../comfyui/client.js", () => ({
  getHistory: (...a: unknown[]) => getHistoryMock(...a),
  getClient: vi.fn(),
  ensureConnected: vi.fn(),
}));
vi.mock("../../config.js", () => ({
  isCloudMode: () => false,
  getCloudUrl: () => "",
  getComfyUIBaseUrl: () => "http://127.0.0.1:8188",
}));

import { reconcileAssetsFromHistory } from "../../services/asset-reconcile.js";
import { AssetRegistry } from "../../services/asset-registry.js";
import type { WorkflowJSON } from "../../comfyui/types.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function sampleGraph(): WorkflowJSON {
  return {
    "3": {
      class_type: "KSampler",
      inputs: { seed: 42, steps: 20, cfg: 7, sampler_name: "euler" },
    },
    "9": {
      class_type: "SaveImage",
      inputs: { filename_prefix: "ComfyUI", images: ["8", 0] },
    },
  };
}

interface EntryOpts {
  queue: number;
  promptId: string;
  filename?: string;
  /** ms epoch for execution_start/execution_success (start = end - 5s). */
  successTs?: number;
  completed?: boolean;
  withError?: boolean;
  graph?: unknown;
  outputs?: Record<string, unknown>;
}

function historyEntry(opts: EntryOpts) {
  const {
    queue,
    promptId,
    filename = `${promptId}_00001_.png`,
    successTs,
    completed = true,
    withError = false,
    graph = sampleGraph(),
    outputs,
  } = opts;
  const messages: Array<[string, Record<string, unknown>]> = [];
  if (successTs !== undefined) {
    messages.push(["execution_start", { prompt_id: promptId, timestamp: successTs - 5000 }]);
    messages.push([
      withError ? "execution_error" : "execution_success",
      withError
        ? { prompt_id: promptId, timestamp: successTs, exception_message: "boom" }
        : { prompt_id: promptId, timestamp: successTs },
    ]);
  }
  return {
    prompt: [queue, promptId, graph, {}, []],
    outputs: outputs ?? {
      "9": { images: [{ filename, subfolder: "", type: "output" }] },
    },
    status: {
      status_str: withError ? "error" : "success",
      completed,
      messages,
    },
  };
}

beforeEach(() => {
  getHistoryMock.mockReset();
  AssetRegistry.configure({ ttlMs: DAY_MS, now: Date.now });
  AssetRegistry.clear();
});

describe("reconcileAssetsFromHistory", () => {
  it("registers outputs from a completed run this session never watched (#751)", async () => {
    const successTs = Date.now() - 10_000;
    getHistoryMock.mockResolvedValue({
      "panel-prompt": historyEntry({ queue: 5, promptId: "panel-prompt", successTs }),
    });

    const result = await reconcileAssetsFromHistory();

    expect(result).toEqual({ scanned: 1, registered: 1, skippedExisting: 0 });
    const [record] = AssetRegistry.list();
    expect(record).toMatchObject({
      promptId: "panel-prompt",
      nodeId: "9",
      filename: "panel-prompt_00001_.png",
      subfolder: "",
      type: "output",
      source: "history-reconcile",
      createdAt: successTs,
    });
    expect(record.assetId).toMatch(/^a_[0-9a-f]{8}$/);
    expect(record.url).toContain("filename=panel-prompt_00001_.png");
    // The recorded graph is the regenerate / get_asset_metadata provenance.
    expect(AssetRegistry.get(record.assetId)?.workflow["3"].class_type).toBe("KSampler");
  });

  it("does not overwrite or duplicate an existing watched registration", async () => {
    const watchedTs = Date.now() - 60_000;
    AssetRegistry.configure({ now: () => watchedTs });
    const [watched] = AssetRegistry.register({
      promptId: "p1",
      workflow: sampleGraph(),
      outputs: [
        {
          node_id: "9",
          images: [
            {
              filename: "p1_00001_.png",
              subfolder: "",
              type: "output",
              url: "http://127.0.0.1:8188/view?filename=p1_00001_.png&subfolder=&type=output",
            },
          ],
        },
      ],
    });
    AssetRegistry.configure({ now: Date.now });

    getHistoryMock.mockResolvedValue({
      p1: historyEntry({
        queue: 9,
        promptId: "p1",
        filename: "p1_00001_.png",
        successTs: Date.now() - 1000,
      }),
    });

    const result = await reconcileAssetsFromHistory();

    expect(result).toEqual({ scanned: 1, registered: 0, skippedExisting: 1 });
    const all = AssetRegistry.list();
    expect(all).toHaveLength(1);
    expect(all[0].assetId).toBe(watched.assetId);
    expect(all[0].source).toBe("watched");
    expect(all[0].createdAt).toBe(watchedTs);
  });

  it("fabricates nothing: skips errored, incomplete, graph-less, and output-less entries", async () => {
    const ts = Date.now() - 1000;
    getHistoryMock.mockResolvedValue({
      errored: historyEntry({ queue: 4, promptId: "errored", successTs: ts, withError: true }),
      running: historyEntry({ queue: 3, promptId: "running", successTs: ts, completed: false }),
      nograph: historyEntry({ queue: 2, promptId: "nograph", successTs: ts, graph: {} }),
      nooutput: historyEntry({ queue: 1, promptId: "nooutput", successTs: ts, outputs: {} }),
    });

    const result = await reconcileAssetsFromHistory();

    expect(result.registered).toBe(0);
    expect(AssetRegistry.list()).toHaveLength(0);
  });

  it("reconciles only the newest maxPrompts completed prompts, ordered by queue number", async () => {
    const ts = Date.now() - 1000;
    getHistoryMock.mockResolvedValue({
      oldest: historyEntry({ queue: 1, promptId: "oldest", successTs: ts }),
      newest: historyEntry({ queue: 3, promptId: "newest", successTs: ts }),
      middle: historyEntry({ queue: 2, promptId: "middle", successTs: ts }),
    });

    const result = await reconcileAssetsFromHistory({ maxPrompts: 2 });

    expect(result).toEqual({ scanned: 2, registered: 2, skippedExisting: 0 });
    const filenames = AssetRegistry.list().map((r) => r.promptId).sort();
    expect(filenames).toEqual(["middle", "newest"]);
  });

  it("normalizes epoch-seconds history timestamps to ms", async () => {
    const successMs = Date.now() - 30_000;
    const successS = Math.floor(successMs / 1000);
    getHistoryMock.mockResolvedValue({
      "seconds-prompt": historyEntry({
        queue: 1,
        promptId: "seconds-prompt",
        successTs: successS,
      }),
    });

    await reconcileAssetsFromHistory();

    const [record] = AssetRegistry.list();
    expect(record.createdAt).toBe(successS * 1000);
  });

  it("falls back to now when history carries no usable timestamp", async () => {
    getHistoryMock.mockResolvedValue({
      "timeless-prompt": historyEntry({ queue: 1, promptId: "timeless-prompt" }),
    });

    const before = Date.now();
    await reconcileAssetsFromHistory();
    const after = Date.now();

    const [record] = AssetRegistry.list();
    expect(record.createdAt).toBeGreaterThanOrEqual(before);
    expect(record.createdAt).toBeLessThanOrEqual(after);
  });

  it("registers entries older than the TTL but they read as expired (TTL stays authoritative)", async () => {
    AssetRegistry.configure({ ttlMs: 60_000 });
    getHistoryMock.mockResolvedValue({
      "old-prompt": historyEntry({
        queue: 1,
        promptId: "old-prompt",
        successTs: Date.now() - 120_000,
      }),
    });

    const result = await reconcileAssetsFromHistory();

    expect(result.registered).toBe(1);
    expect(AssetRegistry.list()).toHaveLength(0);
  });
});
