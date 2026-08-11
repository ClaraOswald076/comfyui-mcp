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

  it("REDACTS shapes SHORTER than the generic run — an AWS key ID is 20 chars (codex)", () => {
    // The generic rule is a 32-character floor, and 20 characters is an ordinary model
    // filename, so the floor cannot be lowered to catch this. `AKIA…` printed in full.
    hoisted.progress = { a: { downloaded: 1 }, b: { downloaded: 2 } };
    const at = downloadsAtRiskOfRespawn(
      jobs(
        { filename: "AKIAABCDEFGHIJKLMNOP.safetensors", status: "downloading", trayId: "a" },
        { filename: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.safetensors", status: "downloading", trayId: "b" },
      ),
    );
    expect(at[0].filename).toBe("(redacted).safetensors");
    expect(at[1].filename).toBe("(redacted).safetensors");
  });

  it("KEEPS a hash-named model — over-redaction costs the warning its point (codex P3)", () => {
    // A receipt that says two downloads are at risk without saying WHICH has given up most
    // of its value. A sha1/md5/sha256 in a filename is ordinary; it is hex-only AND an
    // exact hash length, which a credential is not (they are base64-ish and any length).
    hoisted.progress = { a: { downloaded: 1 }, b: { downloaded: 2 }, c: { downloaded: 3 } };
    const at = downloadsAtRiskOfRespawn(
      jobs(
        { filename: `flux1-dev-${"a1b2c3d4".repeat(5)}.safetensors`, status: "downloading", trayId: "a" },
        { filename: `sd35-${"0f".repeat(32)}.safetensors`, status: "downloading", trayId: "b" },
        // One unbroken 40-character mixed run: no part explains itself, still a blob.
        { filename: `blob-${"Zx9Qw7Er".repeat(5)}.safetensors`, status: "downloading", trayId: "c" },
      ),
    );
    expect(at[0].filename).toBe(`flux1-dev-${"a1b2c3d4".repeat(5)}.safetensors`);
    expect(at[1].filename).toBe(`sd35-${"0f".repeat(32)}.safetensors`);
    expect(at[2].filename).toBe("(redacted).safetensors");
  });

  it("a long name of ORDINARY parts is kept, but several blob parts are not", () => {
    // The line between the two directions, asserted where it actually sits: real model
    // filenames are long and full of `Q8_0`/`a14b`/`e4m3fn`, and a rule that redacts those
    // redacts nearly everything. Parts that are long AND interleaved are budgeted, so one
    // is a name and several is a blob.
    hoisted.progress = { a: { downloaded: 1 }, b: { downloaded: 2 } };
    const ordinary = "flux1-kontext-dev-Q8_0-GGUF-v2-fp8-e4m3fn.safetensors";
    const blobby = "AbcD3fGhIjK-LmNo9pQrStU-VwXy7zAbCdE.safetensors";
    const at = downloadsAtRiskOfRespawn(
      jobs(
        { filename: ordinary, status: "downloading", trayId: "a" },
        { filename: blobby, status: "downloading", trayId: "b" },
      ),
    );
    expect(at[0].filename).toBe(ordinary);
    expect(at[1].filename).toBe("(redacted).safetensors");
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

  it("the revoke disclosure NAMES the transfers, and stays silent when there are none", async () => {
    // The behaviour behind the wiring test above: a field nobody renders is not a warning,
    // and a warning that fires on an empty list is noise on every ordinary revoke.
    const { removeDisclosures } = await import("../../services/panel-secrets.js");
    const base = { changed: true, lostKeys: [], lostCommentLines: 0 };

    const loud = removeDisclosures(
      {
        ...base,
        atRiskDownloads: [
          { filename: "flux1-dev.safetensors", bytes: 12 * 1024 ** 3 },
          { filename: "wan22.safetensors", bytes: 4 * 1024 ** 3 },
        ],
      },
      "/store/.env",
    );
    const text = loud.join(" ");
    expect(text).toMatch(/flux1-dev\.safetensors/);
    expect(text).toMatch(/16\.00 GB/);
    // It must NOT claim which side of the respawn we are on — this path collects no
    // respawn reports, so "already lost" and "will be lost" are both unchecked claims.
    expect(text).toMatch(/not reported on this path/);

    expect(removeDisclosures({ ...base, atRiskDownloads: [] }, "/store/.env")).toEqual([]);
  });

  it("WIRING: REVOKE snapshots before its emit too, and discloses it (#1409)", async () => {
    // The fix landed on the save path only. Revoke reaches the same synchronous emit two
    // functions later, and removing the credential a gated transfer authenticates with is
    // at least as likely to cost one as replacing it — codex scored the hole against this
    // PR rather than accepting the follow-up issue, correctly.
    const { readFileSync } = await import("node:fs");
    const code = (rel: string): string =>
      readFileSync(new URL(rel, import.meta.url), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*/g, "");
    const src = code("../../services/panel-secrets.ts");

    // Scoped to the REMOVER, or the setter's own (correct) ordering satisfies this.
    const remover = src.slice(src.indexOf("export function removeEnvSecret"));
    const snapshotAt = remover.indexOf("snapshotAtRiskDownloads()");
    const emitAt = remover.indexOf("emitComfyuiChange({})");
    expect(snapshotAt, "the remover must snapshot in-flight downloads").toBeGreaterThan(-1);
    expect(emitAt, "the remover must still emit").toBeGreaterThan(-1);
    expect(snapshotAt, "the snapshot must precede the respawn emit").toBeLessThan(emitAt);

    // …and it must reach the user. A field nobody renders is not a warning.
    expect(src).toMatch(/outcome\.atRiskDownloads\.length/);
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
