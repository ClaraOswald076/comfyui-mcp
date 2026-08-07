// #946 — a `filename` carrying a path was neither uploaded nor refused.
//
// `upload_image` accepts a `filename` override on both its image and
// action:"video" forms (the report predates the 0.50.0 fold, which is why it
// names the video upload as a separate tool). A caller who
// wants the file in a subfolder of ComfyUI's input/ writes it the obvious way:
// "assets/clip.mp4". That whole string went into the multipart filename, and the
// call came back as a bare
//
//     Unexpected non-whitespace character after JSON at position 4
//
// — no upload, and a parser message in place of a diagnosis. The same call with
// the slash removed succeeded, which is what makes it a real report rather than
// a general "slashes break things": `source_path` is full of slashes and is fine.
//
// ComfyUI's /upload/image has a `subfolder` FORM FIELD for exactly this. Two
// separate defects, so two sets of tests: the split (send the field the API has)
// and the parse (never let a parser message stand in for a diagnosis).

import { describe, expect, it } from "vitest";
import { splitUploadTarget } from "../../comfyui/client.js";
import { ValidationError } from "../../utils/errors.js";

describe("#946: a path in `filename` is a subfolder request", () => {
  it("leaves a bare filename alone", () => {
    expect(splitUploadTarget("clip.mp4")).toEqual({ subfolder: "", name: "clip.mp4" });
  });

  it("splits the reported case into the two fields ComfyUI actually takes", () => {
    expect(splitUploadTarget("assets/clip.mp4")).toEqual({
      subfolder: "assets",
      name: "clip.mp4",
    });
  });

  it("handles a nested subfolder", () => {
    expect(splitUploadTarget("a/b/c/clip.mp4")).toEqual({ subfolder: "a/b/c", name: "clip.mp4" });
  });

  // A caller on Windows writes it with backslashes; the reporter was on Windows 11.
  it("treats backslashes as separators too", () => {
    expect(splitUploadTarget("assets\\clip.mp4")).toEqual({
      subfolder: "assets",
      name: "clip.mp4",
    });
    expect(splitUploadTarget("a\\b/c.png")).toEqual({ subfolder: "a/b", name: "c.png" });
  });

  it("collapses redundant separators and '.' segments", () => {
    expect(splitUploadTarget("assets//./clip.mp4")).toEqual({
      subfolder: "assets",
      name: "clip.mp4",
    });
  });
});

describe("#946: traversal is refused, never sanitised", () => {
  // Rewriting "../../x.png" into something safe would upload to a place the
  // caller did not name and then report the name they asked for — a wrong answer
  // dressed as a right one. Refuse and say why.
  it("refuses a subfolder that walks upwards", () => {
    expect(() => splitUploadTarget("../escape.png")).toThrow(ValidationError);
    expect(() => splitUploadTarget("a/../../escape.png")).toThrow(/walks outside/);
  });

  it("refuses a value that names no file", () => {
    expect(() => splitUploadTarget("assets/")).toThrow(/does not name a file/);
    expect(() => splitUploadTarget("")).toThrow(/does not name a file/);
    expect(() => splitUploadTarget("..")).toThrow(/does not name a file/);
  });

  it("names the accepted shape in the refusal, so the caller can act", () => {
    let msg = "";
    try {
      splitUploadTarget("../x.png");
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    expect(msg).toContain("assets/clip.mp4");
    expect(msg).toContain("..");
  });

  // A leading separator is an absolute-looking path; it must not silently become
  // a relative one that lands somewhere plausible.
  it("does not turn a rooted path into a quietly different destination", () => {
    // "/assets/clip.mp4" has no upward segment, so it is accepted — but as the
    // subfolder "assets", which is the only reading ComfyUI's field supports.
    // Pinned so the behaviour is a decision rather than an accident.
    expect(splitUploadTarget("/assets/clip.mp4")).toEqual({
      subfolder: "assets",
      name: "clip.mp4",
    });
  });
});
