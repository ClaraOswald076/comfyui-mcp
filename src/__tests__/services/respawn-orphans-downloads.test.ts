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

  it("REDACTS a credential-shaped filename, not just the URL (codex)", () => {
    // The URL is never reported and a url-DERIVED filename takes only the pathname — but an
    // explicitly supplied `filename` is copied through unchanged, and its validation
    // rejects separators and dot-names, not secret-looking content. A caller can legally
    // pass `model-sk-live-abc123.safetensors`, and this string lands in a transcript.
    hoisted.progress = { a: { downloaded: 1 }, b: { downloaded: 2 }, c: { downloaded: 3 } };
    const at = downloadsAtRiskOfRespawn(
      jobs(
        { filename: "model-sk-live-abcdefghijkl.safetensors", status: "downloading", trayId: "a" },
        { filename: "my_api_key_dump.safetensors", status: "downloading", trayId: "b" },
        { filename: "flux2_dev.safetensors", status: "downloading", trayId: "c" },
      ),
    );
    expect(at[0].filename).toBe("(redacted).safetensors");
    expect(at[1].filename).toBe("(redacted).safetensors");
    // …and an ordinary name is kept, or the warning stops being useful.
    expect(at[2].filename).toBe("flux2_dev.safetensors");
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

  it("WIRING: the snapshot is taken in the SETTER, before the synchronous respawn", async () => {
    // The whole premise. `emitComfyuiChange` is synchronous and a listener may replace its
    // tool session inside it, so enumerating downloads afterwards describes a world where
    // they are already orphaned — my first version did exactly that and then told the user
    // to "let them finish". The snapshot has to be taken before the emit and ride the
    // receipt.
    const { readFileSync } = await import("node:fs");
    const code = (rel: string): string =>
      readFileSync(new URL(rel, import.meta.url), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*/g, "");

    const setter = code("../../services/panel-secrets.ts");
    // The CALL SITE, not the helper's definition. Measuring `snapshotAtRiskDownloads()`
    // alone found the function declaration — which sits near the top of the file and is
    // therefore always "before the emit", so the assertion passed no matter where the call
    // actually was. Mutation testing caught it: moving the call after the emit left this
    // green.
    const snapshotAt = setter.indexOf("? snapshotAtRiskDownloads()");
    const emitAt = setter.indexOf("emitComfyuiChange({");
    expect(snapshotAt, "the setter must snapshot in-flight downloads").toBeGreaterThan(-1);
    expect(emitAt).toBeGreaterThan(-1);
    expect(snapshotAt, "the snapshot must precede the respawn emit").toBeLessThan(emitAt);

    // …and the receipt renderer must read that snapshot rather than re-enumerating.
    const receipt = code("../../orchestrator/panel-tools.ts");
    expect(receipt).toMatch(/receipt\.atRiskDownloads/);
    expect(receipt).not.toMatch(/downloadsAtRiskOfRespawn\(\)/);
  });
});
