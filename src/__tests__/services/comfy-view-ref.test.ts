// #648 — an oversized local file is not a dead end when ComfyUI already serves
// the directory it lives in.
//
// The load-bearing distinction here is between "this file is in the wrong place"
// and "we could not find out where the right places are". Collapsing the second
// into the first tells a caller to move a file that may already be exactly where
// it needs to be, so the tests below assert the REASON, not just the outcome.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const state = vi.hoisted(() => ({
  outputDir: "" as string,
  inputDir: "" as string,
  outputError: null as string | null,
  inputError: null as string | null,
  remote: false,
  cloud: false,
  outputCalls: 0,
  inputCalls: 0,
}));

vi.mock("../../services/output-dir.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../services/output-dir.js")>();
  return {
    ...actual,
    resolveOutputDir: async () => {
      state.outputCalls += 1;
      if (state.outputError) throw new Error(state.outputError);
      return state.outputDir;
    },
    resolveInputDir: async () => {
      state.inputCalls += 1;
      if (state.inputError) throw new Error(state.inputError);
      return state.inputDir;
    },
  };
});

vi.mock("../../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config.js")>();
  return {
    ...actual,
    isRemoteMode: () => state.remote,
    isCloudMode: () => state.cloud,
  };
});

const {
  resolveServableViewRef,
  oversizedInlineRefusal,
  forwardedByReferenceNote,
} = await import("../../services/comfy-view-ref.js");

let root: string;
let outDir: string;
let inDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cmcp-viewref-"));
  outDir = join(root, "ComfyUI", "output");
  inDir = join(root, "ComfyUI", "input");
  mkdirSync(outDir, { recursive: true });
  mkdirSync(inDir, { recursive: true });
  state.outputDir = outDir;
  state.inputDir = inDir;
  state.outputError = null;
  state.inputError = null;
  state.remote = false;
  state.cloud = false;
  state.outputCalls = 0;
  state.inputCalls = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

function touch(path: string): string {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "x");
  return path;
}

describe("resolveServableViewRef — servable", () => {
  it("derives a top-level ref with NO subfolder key", async () => {
    const file = touch(join(outDir, "clip.mp4"));
    const res = await resolveServableViewRef(file);
    expect(res.status).toBe("servable");
    if (res.status !== "servable") return;
    expect(res.ref).toEqual({ filename: "clip.mp4", type: "output" });
    // An empty subfolder must be ABSENT, not "" — the panel forwards this object
    // straight into a /view query string.
    expect("subfolder" in res.ref).toBe(false);
    expect(res.root.kind).toBe("output");
  });

  it("derives a nested subfolder with forward slashes", async () => {
    const file = touch(join(outDir, "video", "takes", "clip.mp4"));
    const res = await resolveServableViewRef(file);
    expect(res.status).toBe("servable");
    if (res.status !== "servable") return;
    expect(res.ref).toEqual({
      filename: "clip.mp4",
      subfolder: "video/takes",
      type: "output",
    });
    // Never a backslash, whatever the host separator is.
    expect(res.ref.subfolder).not.toContain("\\");
  });

  it("recognises the INPUT directory and types the ref accordingly", async () => {
    const file = touch(join(inDir, "refs", "plate.mp4"));
    const res = await resolveServableViewRef(file);
    expect(res.status).toBe("servable");
    if (res.status !== "servable") return;
    expect(res.ref.type).toBe("input");
    expect(res.ref.subfolder).toBe("refs");
  });

  it("stays servable when the OTHER directory cannot be resolved", async () => {
    // Independence: the input dir failing must not discard a proven output hit.
    state.inputError = "COMFYUI_PATH is not configured";
    const file = touch(join(outDir, "clip.mp4"));
    const res = await resolveServableViewRef(file);
    expect(res.status).toBe("servable");
  });
});

describe("resolveServableViewRef — outside", () => {
  it("refuses a file in a sibling directory and names both roots checked", async () => {
    const file = touch(join(root, "elsewhere", "clip.mp4"));
    const res = await resolveServableViewRef(file);
    expect(res.status).toBe("outside");
    if (res.status !== "outside") return;
    expect(res.checked.map((c) => c.kind).sort()).toEqual(["input", "output"]);
    expect(res.checked.find((c) => c.kind === "output")?.dir).toBe(resolve(outDir));
  });

  it("does not treat a PREFIX-sharing sibling as inside the root", async () => {
    // "<...>/output-old/clip.mp4" starts with the output dir's string but is a
    // different directory. A prefix test without the separator would mint a ref
    // whose subfolder ("-old") resolves to nothing.
    const file = touch(join(root, "ComfyUI", "output-old", "clip.mp4"));
    const res = await resolveServableViewRef(file);
    expect(res.status).toBe("outside");
  });
});

describe("resolveServableViewRef — unknown is not 'outside'", () => {
  it("reports UNKNOWN when neither directory resolves", async () => {
    state.outputError = "COMFYUI_PATH is not configured";
    state.inputError = "COMFYUI_PATH is not configured";
    const res = await resolveServableViewRef(join(root, "elsewhere", "clip.mp4"));
    expect(res.status).toBe("unknown");
    if (res.status !== "unknown") return;
    expect(res.reason).toContain("COMFYUI_PATH is not configured");
  });

  it("reports UNKNOWN — never 'outside' — when one directory is unresolved and the other did not match", async () => {
    // The whole point of the three-way answer: the file could be sitting in the
    // directory that failed to resolve. Calling this "outside" would send the
    // caller to move a file that may already be in the right place.
    state.inputError = "the server did not answer /system_stats";
    const res = await resolveServableViewRef(join(root, "elsewhere", "clip.mp4"));
    expect(res.status).toBe("unknown");
    if (res.status !== "unknown") return;
    expect(res.reason).toContain("undetermined");
    expect(res.reason).toContain("the server did not answer /system_stats");
  });

  it("treats an empty resolved directory as unresolved, not as a root", async () => {
    // "" would make every absolute path look contained.
    state.outputDir = "";
    state.inputDir = "";
    const res = await resolveServableViewRef(join(root, "elsewhere", "clip.mp4"));
    expect(res.status).toBe("unknown");
  });
});

describe("resolveServableViewRef — remote", () => {
  it("answers REMOTE without resolving any directory", async () => {
    state.remote = true;
    const file = touch(join(outDir, "clip.mp4"));
    const res = await resolveServableViewRef(file);
    expect(res.status).toBe("remote");
    // Load-bearing: a remote session can still have COMFYUI_PATH set, so the
    // roots would resolve to LOCAL-looking paths and this very file would be
    // called servable — against a server that cannot open it. The check has to
    // happen before any root is consulted.
    expect(state.outputCalls).toBe(0);
    expect(state.inputCalls).toBe(0);
  });

  it("answers REMOTE for cloud mode too", async () => {
    state.cloud = true;
    const res = await resolveServableViewRef(touch(join(outDir, "clip.mp4")));
    expect(res.status).toBe("remote");
    if (res.status !== "remote") return;
    expect(res.reason).toContain("Cloud");
  });
});

describe("oversizedInlineRefusal — every branch ends in something the caller can do", () => {
  const base = {
    path: "/refs/clip.mp4",
    sizeBytes: 72 * 1024 * 1024,
    capBytes: 20 * 1024 * 1024,
    kind: "video" as const,
  };

  it("states the size, the cap, and why the cap exists", () => {
    const msg = oversizedInlineRefusal({
      ...base,
      resolution: { status: "outside", checked: [{ kind: "output", dir: "/c/output" }] },
    });
    expect(msg).toContain("72.0 MB");
    expect(msg).toContain("20.0 MB");
    expect(msg).toContain("base64");
  });

  it("names the ACTUAL directories to move the file into", () => {
    const msg = oversizedInlineRefusal({
      ...base,
      resolution: {
        status: "outside",
        checked: [
          { kind: "output", dir: "/c/output" },
          { kind: "input", dir: "/c/input" },
        ],
      },
    });
    // A remedy the caller can act on names the destination, not just the rule.
    expect(msg).toContain("/c/output");
    expect(msg).toContain("/c/input");
    expect(msg).toMatch(/Copy or move it/);
    expect(msg).toContain("panel_show_media");
  });

  it("tells a VIDEO caller it still will not be sent the video", () => {
    const msg = oversizedInlineRefusal({
      ...base,
      resolution: { status: "outside", checked: [{ kind: "output", dir: "/c/output" }] },
    });
    expect(msg).toContain("SAMPLED");
    expect(msg).not.toContain("get_image with its filename");
  });

  it("points an IMAGE caller at get_image, which a storyboard cannot serve", () => {
    const msg = oversizedInlineRefusal({
      ...base,
      kind: "image",
      resolution: { status: "outside", checked: [{ kind: "output", dir: "/c/output" }] },
    });
    expect(msg).toContain("get_image");
    expect(msg).not.toContain("SAMPLED");
  });

  it("does NOT blame the file's location when the answer was unknown", () => {
    const msg = oversizedInlineRefusal({
      ...base,
      resolution: { status: "unknown", reason: "the output directory could not be resolved (no COMFYUI_PATH)" },
    });
    expect(msg).toContain("could NOT be determined");
    expect(msg).toContain("not the same as knowing the file is in the wrong place");
    // The false claim this branch exists to avoid.
    expect(msg).not.toContain("This file is not under any directory");
    // Still actionable: the remedy addresses the thing that is actually broken.
    expect(msg).toContain("COMFYUI_PATH");
  });

  it("gives a remote caller a remedy that works from a different host", () => {
    const msg = oversizedInlineRefusal({
      ...base,
      resolution: { status: "remote", reason: "this session targets a REMOTE ComfyUI on a different host" },
    });
    // Moving the file locally is NOT a remedy here, so it must not be offered.
    expect(msg).not.toMatch(/Copy or move it/);
    expect(msg).toContain("input directory");
    expect(msg).toContain('type: "input"');
  });
});

describe("forwardedByReferenceNote", () => {
  it("says the bytes were not sent and never claims anything was displayed", () => {
    const note = forwardedByReferenceNote(
      [
        {
          path: "/c/output/clip.mp4",
          sizeBytes: 72 * 1024 * 1024,
          kind: "video",
          ref: { filename: "clip.mp4", subfolder: "takes", type: "output" },
        },
      ],
      20 * 1024 * 1024,
    );
    expect(note).toContain("NOT sent the bytes");
    expect(note).toContain('subfolder "takes"');
    // The panel's reply is the only thing that knows what was painted.
    expect(note).toContain("in its reply above");
    expect(note).not.toMatch(/was displayed to the user/i);
  });

  it("offers get_image for an image and warns it is never inline for a video", () => {
    const img = forwardedByReferenceNote(
      [{ path: "/c/output/a.png", sizeBytes: 3e7, kind: "image", ref: { filename: "a.png", type: "output" } }],
      20 * 1024 * 1024,
    );
    expect(img).toContain("get_image");
    expect(img).toContain("comes back inline");

    const vid = forwardedByReferenceNote(
      [{ path: "/c/output/a.mp4", sizeBytes: 3e7, kind: "video", ref: { filename: "a.mp4", type: "output" } }],
      20 * 1024 * 1024,
    );
    expect(vid).toContain("never sent to you inline");
  });
});
