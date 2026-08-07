// #918 — "No local models found." was printed for three different situations, one
// of which was "we never got an answer".
//
// Against a remote ComfyUI that was still warming up, every `/models/<dir>` read
// failed silently, `httpReturnedAny` stayed false, the filesystem fallback returned
// [] because a remote setup has no comfyuiPath, and the tool printed the empty
// install sentence. A reporter read it as a misconfigured URL and told the user so.
// The same call returned the full list minutes later.
//
// The listing therefore has to carry HOW it knows, and the renderer has to decline
// to claim "none" when nothing answered.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mode = vi.hoisted(() => ({ remote: false }));
vi.mock("../../config.js", () => ({
  config: { comfyuiPath: "/comfy" as string | undefined },
  isRemoteMode: () => mode.remote,
}));

const fetchApi = vi.fn();
const getClient = vi.fn();
vi.mock("../../comfyui/client.js", () => ({
  getClient: (...args: unknown[]) => getClient(...args),
}));

const readdir = vi.fn();
const stat = vi.fn();
const readFile = vi.fn();
vi.mock("node:fs/promises", () => ({
  readdir: (...a: unknown[]) => readdir(...a),
  stat: (...a: unknown[]) => stat(...a),
  readFile: (...a: unknown[]) => readFile(...a),
  copyFile: vi.fn(),
  link: vi.fn(),
  mkdir: vi.fn(),
  rename: vi.fn(),
  rm: vi.fn(),
  utimes: vi.fn(),
}));

const { config } = await import("../../config.js");
const { listLocalModelsWithCoverage } = await import("../../services/model-resolver.js");
const { describeEmptyModelListing } = await import("../../tools/model-management.js");

beforeEach(() => {
  getClient.mockReset();
  fetchApi.mockReset();
  readdir.mockReset();
  stat.mockReset();
  readFile.mockReset();
  readFile.mockRejectedValue(new Error("ENOENT"));
  config.comfyuiPath = "/comfy";
  mode.remote = false;
});

afterEach(() => vi.clearAllMocks());

describe("#918: the listing records whether ComfyUI actually answered", () => {
  it("an OK empty array is an ANSWER — emptiness here is a verified fact", async () => {
    getClient.mockReturnValue({ fetchApi });
    fetchApi.mockResolvedValue(new Response("[]", { status: 200 }));
    readdir.mockRejectedValue(new Error("ENOENT"));
    const { models, coverage } = await listLocalModelsWithCoverage("checkpoints");
    expect(models).toEqual([]);
    expect(coverage.answered).toEqual(["checkpoints"]);
    expect(coverage.unanswered).toEqual([]);
  });

  it("a non-OK status is NOT an answer, and the status is kept", async () => {
    getClient.mockReturnValue({ fetchApi });
    fetchApi.mockResolvedValue(new Response("nope", { status: 503 }));
    readdir.mockRejectedValue(new Error("ENOENT"));
    const { coverage } = await listLocalModelsWithCoverage("checkpoints");
    expect(coverage.answered).toEqual([]);
    expect(coverage.unanswered).toEqual([{ dir: "checkpoints", reason: "HTTP 503" }]);
  });

  // The reported shape: a proxy or a still-starting server answers 200 with an
  // HTML login/placeholder page. The old code `continue`d and the category
  // vanished without trace; res.json() would have raised the bare
  // `Unexpected token '<', "<!doctype "...` the reporter flagged on the sibling
  // tool. Name the condition instead of leaking the parser's message.
  it("a 200 carrying HTML is reported as HTML, not as a JSON parser error", async () => {
    getClient.mockReturnValue({ fetchApi });
    fetchApi.mockResolvedValue(new Response("<!doctype html><html>…", { status: 200 }));
    readdir.mockRejectedValue(new Error("ENOENT"));
    const { coverage } = await listLocalModelsWithCoverage("checkpoints");
    expect(coverage.answered).toEqual([]);
    expect(coverage.unanswered[0].reason).toMatch(/returned HTML instead of JSON/);
    expect(coverage.unanswered[0].reason).toMatch(/still starting/);
    expect(coverage.unanswered[0].reason).not.toMatch(/Unexpected token/);
  });

  it("valid JSON of the wrong shape is distinguished from HTML", async () => {
    getClient.mockReturnValue({ fetchApi });
    fetchApi.mockResolvedValue(new Response('{"error":"unauthorized"}', { status: 200 }));
    readdir.mockRejectedValue(new Error("ENOENT"));
    const { coverage } = await listLocalModelsWithCoverage("checkpoints");
    expect(coverage.unanswered[0].reason).toMatch(/JSON but not an array/);
  });

  it("a thrown fetch is recorded with its message, not swallowed", async () => {
    getClient.mockReturnValue({ fetchApi });
    fetchApi.mockRejectedValue(new Error("connect ECONNREFUSED 10.0.0.4:8188"));
    readdir.mockRejectedValue(new Error("ENOENT"));
    const { coverage } = await listLocalModelsWithCoverage("checkpoints");
    expect(coverage.unanswered[0].reason).toMatch(/ECONNREFUSED/);
  });

  // The exact #918 shape: remote (no comfyuiPath), so there is no second source
  // to consult, and the empty array carries no information whatsoever.
  it("remote + no answer sets noSourceAvailable — nothing was learned at all", async () => {
    config.comfyuiPath = undefined;
    mode.remote = true;
    getClient.mockReturnValue({ fetchApi });
    fetchApi.mockRejectedValue(new Error("fetch failed"));
    const { models, coverage } = await listLocalModelsWithCoverage("checkpoints");
    expect(models).toEqual([]);
    expect(coverage.noSourceAvailable).toBe(true);
    expect(coverage.unanswered).toHaveLength(1);
  });

  it("a local install with an unreachable server still reports the categories it could not read", async () => {
    getClient.mockReturnValue({ fetchApi });
    fetchApi.mockRejectedValue(new Error("fetch failed"));
    readdir.mockResolvedValue(["sd_xl.safetensors"]);
    stat.mockResolvedValue({ isFile: () => true, size: 1024, mtime: new Date(0) });
    const { models, coverage } = await listLocalModelsWithCoverage("checkpoints");
    expect(models).toHaveLength(1); // the FS scan saved it
    expect(coverage.usedFilesystem).toBe(true);
    expect(coverage.noSourceAvailable).toBeUndefined();
    expect(coverage.unanswered).toHaveLength(1);
  });

  // getClient throws in cloud mode, before any per-category read runs. Every
  // requested category is then unanswered — not answered-and-empty.
  it("an outright unavailable client marks EVERY requested category unanswered", async () => {
    config.comfyuiPath = undefined;
    mode.remote = true;
    getClient.mockImplementation(() => {
      throw new Error("CLOUD_UNSUPPORTED");
    });
    const { coverage } = await listLocalModelsWithCoverage();
    expect(coverage.httpUnavailable).toMatch(/CLOUD_UNSUPPORTED/);
    expect(coverage.answered).toEqual([]);
    expect(coverage.unanswered.length).toBeGreaterThan(10); // all of MODEL_SUBDIRS
    expect(coverage.noSourceAvailable).toBe(true);
  });
});

describe("#918: what an empty listing is allowed to say", () => {
  const empty = { answered: [] as string[], unanswered: [], usedFilesystem: false };

  it("says 'no models' ONLY when every category answered", () => {
    expect(describeEmptyModelListing(undefined, { ...empty, answered: ["checkpoints"] })).toBe(
      "No local models found.",
    );
    expect(describeEmptyModelListing("loras", { ...empty, answered: ["loras"] })).toBe(
      "No loras models found.",
    );
  });

  // THE fix. The old text asserted an empty install from zero information.
  it("refuses to claim 'none' when nothing answered", () => {
    const text = describeEmptyModelListing("checkpoints", {
      ...empty,
      unanswered: [{ dir: "checkpoints", reason: "fetch failed" }],
      noSourceAvailable: true,
    });
    expect(text).toMatch(/Could not determine/);
    expect(text).toMatch(/NOT the same as having none/);
    expect(text).not.toMatch(/^No checkpoints models found\.$/);
    // and it names the reason, so the reader can act instead of guessing
    expect(text).toMatch(/fetch failed/);
    expect(text).toMatch(/get_system_stats/);
  });

  it("names the missing fallback so remote isn't mistaken for a bad path", () => {
    const text = describeEmptyModelListing(undefined, {
      ...empty,
      unanswered: [{ dir: "checkpoints", reason: "HTTP 502" }],
      noSourceAvailable: true,
    });
    expect(text).toMatch(/no local ComfyUI path to scan/);
  });

  it("calls a mixed result PARTIAL rather than empty", () => {
    const text = describeEmptyModelListing(undefined, {
      answered: ["checkpoints", "loras"],
      unanswered: [{ dir: "vae", reason: "HTTP 500" }],
      usedFilesystem: false,
    });
    expect(text).toMatch(/PARTIAL/);
    expect(text).toMatch(/checkpoints, loras/);
    expect(text).toMatch(/vae: HTTP 500/);
    expect(text).toMatch(/before concluding they are absent/);
  });

  it("does not dump an unbounded list of failed categories", () => {
    const text = describeEmptyModelListing(undefined, {
      ...empty,
      unanswered: Array.from({ length: 15 }, (_, i) => ({ dir: `d${i}`, reason: "fetch failed" })),
    });
    expect(text).toMatch(/…and 7 more/);
  });
});
