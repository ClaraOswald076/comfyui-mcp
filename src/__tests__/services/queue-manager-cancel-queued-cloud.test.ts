import { describe, expect, it, vi } from "vitest";

/**
 * The verify-both-sides fix for #1632 must not fire in Comfy Cloud mode.
 *
 * `cloudClient.getQueue()` returns a HARDCODED empty queue and makes no
 * request — there is no /queue endpoint to read. That empty result is
 * byte-identical to the local "this prompt_id is not pending" case, so a
 * verification built on it would call every cloud job `absent`, skip the
 * delete, and answer with "it already finished, its outputs already exist"
 * about a job that is genuinely queued — the same false report #1632 is
 * about, re-aimed at cloud users, and it would also lose the CLOUD_UNSUPPORTED
 * error that names the action that DOES work there.
 *
 * Deliberately mocks ONLY `isCloudMode`: the real queue-manager, real
 * client.ts and real cloud-client.ts run, because the defect lives in exactly
 * the seam a stubbed client would hide. (Neither cloud function called here
 * touches the network.)
 */

vi.mock("../../config.js", async () => {
  const actual = await vi.importActual<typeof import("../../config.js")>("../../config.js");
  return { ...actual, isCloudMode: () => true };
});

const { cancelQueuedJob } = await import("../../services/queue-manager.js");

describe("cancelQueuedJob in Comfy Cloud mode", () => {
  it("surfaces CLOUD_UNSUPPORTED instead of verifying against the empty-queue stub", async () => {
    await expect(cancelQueuedJob("cloud-job-1")).rejects.toMatchObject({
      code: "CLOUD_UNSUPPORTED",
    });
  });

  it("keeps pointing at the action that actually works in cloud mode", async () => {
    await expect(cancelQueuedJob("cloud-job-1")).rejects.toThrow(/action:"cancel"/);
  });
});
