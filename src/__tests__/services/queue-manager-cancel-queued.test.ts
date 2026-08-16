import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #1632: `cancel_queued` reported "removed successfully" UNCONDITIONALLY.
 *
 * ComfyUI's /queue delete silently no-ops for a prompt it has already started,
 * so a job that won the race kept rendering and still delivered its outputs
 * while the agent was told it had been cancelled. The service fired the delete
 * and returned void — the caller had nothing to branch on, so the false report
 * was not even avoidable one level up.
 *
 * These tests pin the OBSERVED state: /queue is read on both sides of the
 * delete, and the result says what the job is actually doing.
 */

vi.mock("../../config.js", async () => {
  const actual = await vi.importActual<typeof import("../../config.js")>("../../config.js");
  return { ...actual, isCloudMode: () => false };
});

const getQueueVerifiedMock = vi.fn();
const deleteQueueItemMock = vi.fn();

vi.mock("../../comfyui/client.js", () => ({
  getClient: vi.fn(),
  getHistory: vi.fn(),
  getQueue: vi.fn(),
  getQueueVerified: (...args: unknown[]) => getQueueVerifiedMock(...args),
  interrupt: vi.fn(),
  deleteQueueItem: (...args: unknown[]) => deleteQueueItemMock(...args),
  clearQueue: vi.fn(),
  enqueuePrompt: vi.fn(),
  freeMemory: vi.fn(),
}));

import { cancelQueuedJob } from "../../services/queue-manager.js";
import type { QueueStatus } from "../../comfyui/types.js";

const TARGET = "35ba95d3-8f1b-4312-b0e7-567fc81af8f5";
const OTHER = "3d3e4162-0000-4000-8000-000000000000";

const workflow = { "1": { class_type: "SaveImage", inputs: {} } };

function queue(running: string[], pending: string[]): QueueStatus {
  return {
    queue_running: running.map((id, i) => [i, id, workflow, {}, []]),
    queue_pending: pending.map((id, i) => [100 + i, id, workflow, {}, []]),
  } as QueueStatus;
}

beforeEach(() => {
  getQueueVerifiedMock.mockReset();
  deleteQueueItemMock.mockReset();
  deleteQueueItemMock.mockResolvedValue(undefined);
});

describe("cancelQueuedJob reports the state it observed", () => {
  it("removes a pending job and confirms it is gone", async () => {
    getQueueVerifiedMock
      .mockResolvedValueOnce(queue([OTHER], [TARGET]))
      .mockResolvedValueOnce(queue([OTHER], []));

    await expect(cancelQueuedJob(TARGET)).resolves.toEqual({
      removed: true,
      state: "removed",
      verified: true,
    });
    expect(deleteQueueItemMock).toHaveBeenCalledWith(TARGET);
  });

  /**
   * The exact #1632 timeline: the job is pending when we look, ComfyUI starts
   * it, and the delete lands too late. Before the fix this returned void and
   * the tool said "removed successfully."
   */
  it("does NOT claim a removal for a job that started between the check and the delete", async () => {
    getQueueVerifiedMock
      .mockResolvedValueOnce(queue([OTHER], [TARGET]))
      .mockResolvedValueOnce(queue([TARGET], []));

    await expect(cancelQueuedJob(TARGET)).resolves.toEqual({
      removed: false,
      state: "running",
      verified: true,
    });
    // The delete WAS issued — it just did not do anything, which is the point.
    expect(deleteQueueItemMock).toHaveBeenCalledWith(TARGET);
  });

  it("does not even issue the delete for a job already running", async () => {
    getQueueVerifiedMock.mockResolvedValue(queue([TARGET], [OTHER]));

    await expect(cancelQueuedJob(TARGET)).resolves.toEqual({
      removed: false,
      state: "running",
      verified: true,
    });
    expect(deleteQueueItemMock).not.toHaveBeenCalled();
  });

  it("reports a prompt_id that is not in the queue as absent, not removed", async () => {
    getQueueVerifiedMock.mockResolvedValue(queue([OTHER], ["someone-else"]));

    await expect(cancelQueuedJob(TARGET)).resolves.toEqual({
      removed: false,
      state: "absent",
      verified: true,
    });
    expect(deleteQueueItemMock).not.toHaveBeenCalled();
  });

  it("reports a delete that did not take effect as still pending", async () => {
    getQueueVerifiedMock
      .mockResolvedValueOnce(queue([OTHER], [TARGET]))
      .mockResolvedValueOnce(queue([OTHER], [TARGET]));

    await expect(cancelQueuedJob(TARGET)).resolves.toEqual({
      removed: false,
      state: "pending",
      verified: true,
    });
  });

  /**
   * An unreadable /queue must not block a removal the caller can still make —
   * but it costs `verified`, so the caller discloses that "removed" is the
   * delete returning rather than something we saw.
   */
  it("still removes when /queue cannot be read, but marks the result unverified", async () => {
    getQueueVerifiedMock.mockRejectedValue(new Error("ECONNREFUSED"));

    await expect(cancelQueuedJob(TARGET)).resolves.toEqual({
      removed: true,
      state: "removed",
      verified: false,
    });
    expect(deleteQueueItemMock).toHaveBeenCalledWith(TARGET);
  });

  it("marks the result unverified when only the after-read fails", async () => {
    getQueueVerifiedMock
      .mockResolvedValueOnce(queue([OTHER], [TARGET]))
      .mockRejectedValueOnce(new Error("ECONNREFUSED"));

    await expect(cancelQueuedJob(TARGET)).resolves.toMatchObject({
      removed: true,
      verified: false,
    });
  });

  /**
   * With no before-read there is nothing to distinguish "we removed it" from
   * "it was never queued", so an absent job after the delete is not a verified
   * removal — that would be the same false report in a narrower window.
   */
  it("marks the result unverified when only the before-read fails", async () => {
    getQueueVerifiedMock
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockResolvedValueOnce(queue([OTHER], []));

    await expect(cancelQueuedJob(TARGET)).resolves.toMatchObject({
      removed: true,
      verified: false,
    });
  });

  it("propagates a failed delete instead of reporting a removal", async () => {
    getQueueVerifiedMock.mockResolvedValue(queue([OTHER], [TARGET]));
    deleteQueueItemMock.mockRejectedValueOnce(new Error("HTTP 500"));

    await expect(cancelQueuedJob(TARGET)).rejects.toThrow("HTTP 500");
  });
});
