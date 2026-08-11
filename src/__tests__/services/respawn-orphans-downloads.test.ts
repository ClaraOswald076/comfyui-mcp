// #1378 — saving a credential mid-flight respawns the comfyui tool session, and the new
// auth header changes each in-flight download's CACHE IDENTITY. A `.partial` at 96% becomes
// unreachable and the re-issued download starts from zero. A reporter lost ~29 GB across
// two files: the bytes were never deleted, nothing could find them again, and nothing
// warned them until it was already too late to wait.
//
// RESCUING THE TRANSFER IS DELIBERATELY NOT ATTEMPTED. Reusing the old cache entry under
// the new identity would serve bytes fetched under one auth identity to a request made
// under another — exactly what folding headers into the key exists to prevent, and a worse
// failure than a re-download. The reporter reached the same conclusion and filed a
// diagnosis rather than guess at a patch.
//
// So what ships is the CHOICE, delivered while it is still a choice: before the respawn.
//
// The job list is INJECTED, not mocked. `downloadsAtRiskOfRespawn` calls
// `listDownloadJobs` from inside its own module, and vi.mock replaces a module's EXPORT,
// not its internal binding — my first version of this file mocked it and got an empty list
// back from working code.

import { describe, expect, it, vi, beforeEach } from "vitest";

const hoisted = vi.hoisted(() => ({
  progress: {} as Record<string, { downloaded: number }>,
}));

vi.mock("../../services/download-progress.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  readDownloadProgress: (id: string) => hoisted.progress[id],
}));

const { downloadsAtRiskOfRespawn } = await import("../../services/download-jobs.js");

type Job = Parameters<typeof downloadsAtRiskOfRespawn>[0];
const jobs = (...list: Record<string, unknown>[]): Job => list as unknown as Job;

beforeEach(() => {
  hoisted.progress = {};
});

describe("downloadsAtRiskOfRespawn (#1378)", () => {
  it("reports the in-flight downloads and how much has been fetched", () => {
    hoisted.progress = { a: { downloaded: 16_291_583_966 }, b: { downloaded: 15_207_387_077 } };
    const at = downloadsAtRiskOfRespawn(
      jobs(
        { filename: "flux2_dev.safetensors", status: "downloading", trayId: "a" },
        { filename: "text_encoder.safetensors", status: "downloading", trayId: "b" },
      ),
    );
    expect(at).toHaveLength(2);
    // The reporter's actual numbers: 77% of 19.53 GB and 96% of 14.61 GB.
    expect(at[0]).toEqual({ filename: "flux2_dev.safetensors", bytes: 16_291_583_966 });
    expect(at[1]).toEqual({ filename: "text_encoder.safetensors", bytes: 15_207_387_077 });
  });

  it("ignores downloads that are NOT in flight — a finished one loses nothing", () => {
    expect(
      downloadsAtRiskOfRespawn(
        jobs(
          { filename: "done.safetensors", status: "done", trayId: "a" },
          { filename: "failed.safetensors", status: "error", trayId: "b" },
          { filename: "cancelled.safetensors", status: "cancelled", trayId: "c" },
        ),
      ),
    ).toEqual([]);
  });

  it("NEVER reports the URL — a download URL can carry query-string auth", () => {
    // This string lands in a chat transcript. The filename and the byte count are what the
    // decision needs; the URL is the one field that can carry a credential.
    hoisted.progress = { a: { downloaded: 1 } };
    const serialized = JSON.stringify(
      downloadsAtRiskOfRespawn(
        jobs({
          filename: "gated.safetensors",
          status: "downloading",
          trayId: "a",
          url: "https://example.invalid/m.safetensors?token=SHOULD_NOT_APPEAR",
        }),
      ),
    );
    expect(serialized).not.toMatch(/SHOULD_NOT_APPEAR/);
    expect(serialized).not.toMatch(/https?:/);
  });

  it("reports a job with no progress row at zero rather than dropping it", () => {
    // A download whose progress channel is off is still at risk, and still worth naming —
    // dropping it would under-report exactly when the user has least information.
    expect(
      downloadsAtRiskOfRespawn(
        jobs({ filename: "unknown-progress.safetensors", status: "downloading", trayId: "z" }),
      ),
    ).toEqual([{ filename: "unknown-progress.safetensors", bytes: 0 }]);
  });

  it("WIRING: the credential receipt warns only when a respawn is actually happening", async () => {
    // The warning is worth nothing after the fact — by then the transfers are already
    // orphaned. It has to ride the receipt that announces the respawn.
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../../orchestrator/panel-tools.ts", import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*/g, "");
    expect(src).toMatch(/downloadsAtRiskOfRespawn\(\)/);
    expect(src).toMatch(/receipt\.respawn && \(receipt\.respawn\.applied \|\| receipt\.respawn\.scheduled\)/);
  });
});
