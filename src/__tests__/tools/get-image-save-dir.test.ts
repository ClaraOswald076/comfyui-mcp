import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeFile, mkdir } from "node:fs/promises";
import { join, resolve, isAbsolute } from "node:path";
import { tmpdir, homedir } from "node:os";

// #768 — get_image resolved its destination against process.cwd() when save_dir was
// omitted. That is not a directory this process chose: it is wherever the MCP client
// happened to launch us from, which on Windows is routinely C:\Windows\System32, and the
// write died with EPERM *after* the image had already been fetched. The schema had always
// documented "/tmp/comfyui-images/" — a string that existed nowhere in the code, and not
// a real path on the platform this tool primarily runs on.
//
// Two separate properties are locked here:
//   1. the destination is the documented, process-writable default, and every reported
//      path is absolute;
//   2. a save failure does not destroy a successfully fetched image, and the disclosure
//      names the resolved destination plus a remedy reachable from where the caller is.

const getOutputImageMock = vi.fn();
vi.mock("../../services/image-management.js", () => ({
  extractWorkflowFromImage: vi.fn(),
  listOutputImages: vi.fn(),
  listOutputMedia: vi.fn(async () => ({
    images: [],
    source: { directory: "C:\Comfy\output", basis: "local-scan" },
  })),
  getOutputImage: (...a: unknown[]) => getOutputImageMock(...a),
  uploadImageAuto: vi.fn(),
  uploadVideoAuto: vi.fn(),
  uploadAudioAuto: vi.fn(),
  stageOutputAsInput: vi.fn(),
}));

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return { ...actual, mkdir: vi.fn(async () => undefined), writeFile: vi.fn(async () => undefined) };
});

import {
  registerImageManagementTools,
  defaultImageSaveDir,
  resolveImageSaveDir,
} from "../../tools/image-management.js";

type ToolResult = {
  isError?: boolean;
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
};
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

function getHandler(name: string): ToolHandler {
  let handler: ToolHandler | undefined;
  const server = {
    tool: (n: string, _d: string, _s: unknown, h: ToolHandler) => {
      if (n === name) handler = h;
    },
  };
  registerImageManagementTools(server as never);
  if (!handler) throw new Error(`tool ${name} not registered`);
  return handler;
}

function schemaFor(name: string): Record<string, { description?: string }> {
  let schema: Record<string, { description?: string }> | undefined;
  const server = {
    tool: (n: string, _d: string, s: Record<string, { description?: string }>) => {
      if (n === name) schema = s;
    },
  };
  registerImageManagementTools(server as never);
  if (!schema) throw new Error(`tool ${name} not registered`);
  return schema;
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64");

describe("get_image save_dir resolution (#768)", () => {
  let cwdSpy: ReturnType<typeof vi.spyOn> | undefined;

  beforeEach(() => {
    getOutputImageMock.mockResolvedValue({ base64: PNG, mimeType: "image/png" });
  });
  afterEach(() => {
    cwdSpy?.mockRestore();
    cwdSpy = undefined;
    vi.clearAllMocks();
  });

  /** Stand in for the reporter's "orchestrator CWD is C:\Windows\System32". */
  function pretendUnwritableCwd(): string {
    const hostile = process.platform === "win32" ? "C:\\Windows\\System32" : "/proc/1/root";
    cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(hostile);
    return hostile;
  }

  it("writes to the platform temp dir, NOT the process cwd, when save_dir is omitted", async () => {
    const hostile = pretendUnwritableCwd();

    const out = await getHandler("get_image")({ action: "get", filename: "Krea2-220227_00001_.png" });

    expect(out.isError).toBeUndefined();
    const expected = join(tmpdir(), "comfyui-images");
    expect(vi.mocked(mkdir)).toHaveBeenCalledWith(expected, { recursive: true });
    expect(vi.mocked(writeFile)).toHaveBeenCalledWith(
      join(expected, "Krea2-220227_00001_.png"),
      Buffer.from(PNG, "base64"),
    );
    // The exact regression: nothing may be addressed relative to the launch directory.
    const [target] = vi.mocked(writeFile).mock.calls[0] as [string, Buffer];
    expect(target.startsWith(hostile)).toBe(false);
    expect(out.content.map((c) => c.text ?? "").join("")).toContain(expected);
  });

  it("creates the default directory recursively before writing into it", async () => {
    await getHandler("get_image")({ action: "get", filename: "a.png" });
    const mkdirOrder = vi.mocked(mkdir).mock.invocationCallOrder[0];
    const writeOrder = vi.mocked(writeFile).mock.invocationCallOrder[0];
    expect(mkdirOrder).toBeLessThan(writeOrder);
  });

  it("honours an explicit absolute save_dir unchanged", async () => {
    pretendUnwritableCwd();
    const dir = process.platform === "win32" ? "D:\\out\\imgs" : "/var/out/imgs";

    await getHandler("get_image")({ action: "get", filename: "b.png", save_dir: dir });

    expect(vi.mocked(writeFile)).toHaveBeenCalledWith(
      join(dir, "b.png"),
      Buffer.from(PNG, "base64"),
    );
  });

  it("reports an ABSOLUTE path even for a relative save_dir", async () => {
    // A bare relative path echoed to an agent names a different file depending on who
    // reads it — it is unusable as evidence of where the image went.
    cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(
      process.platform === "win32" ? "C:\\work\\proj" : "/work/proj",
    );

    const out = await getHandler("get_image")({ action: "get", filename: "c.png", save_dir: "out" });

    const text = out.content.map((c) => c.text ?? "").join("");
    const reported = text.replace(/^Saved to:\s*/, "").trim();
    expect(isAbsolute(reported)).toBe(true);
    expect(reported).toBe(join(resolve(process.cwd(), "out"), "c.png"));
  });

  it("keeps the fetched image when the SAVE fails, and says what failed and how to fix it", async () => {
    // The bytes are already in hand: the fetch succeeded. Failing the whole call there
    // threw away a real image and invited a retry of the render, which could never fix a
    // permissions problem. Disclose instead of refusing after the fact.
    vi.mocked(mkdir).mockRejectedValueOnce(
      Object.assign(new Error("EPERM: operation not permitted, mkdir"), { code: "EPERM" }),
    );

    const out = await getHandler("get_image")({ action: "get", filename: "Krea2-220227_00001_.png" });

    // The image survives.
    const image = out.content.find((c) => c.type === "image");
    expect(image?.data).toBe(PNG);
    const text = out.content.map((c) => c.text ?? "").join("");
    // …and the caption is not a success claim.
    expect(text).not.toMatch(/^Saved to:/);
    expect(text).toContain("NOT SAVED");
    // Assert the REASON, not just that some text came back: it must name the resolved
    // destination, the underlying error, and a remedy reachable from here.
    expect(text).toContain(join(tmpdir(), "comfyui-images", "Krea2-220227_00001_.png"));
    expect(text).toContain("EPERM");
    expect(text).toMatch(/absolute save_dir/i);
    expect(text).toMatch(/Do NOT re-run the render/i);
  });

  it("reports a save failure as an error for media, which cannot be returned inline", async () => {
    getOutputImageMock.mockResolvedValue({ base64: PNG, mimeType: "video/mp4" });
    vi.mocked(writeFile).mockRejectedValueOnce(
      Object.assign(new Error("EACCES: permission denied, open"), { code: "EACCES" }),
    );

    const out = await getHandler("get_image")({
      action: "get",
      filename: "clip.mp4",
      save_dir: process.platform === "win32" ? "D:\\ro" : "/ro",
    });

    expect(out.isError).toBe(true);
    const text = out.content.map((c) => c.text ?? "").join("");
    expect(text).toContain("NOT SAVED");
    expect(text).toContain("EACCES");
    expect(text).toMatch(/save_dir argument you passed/i);
  });

  it("documents the default it actually uses", async () => {
    // The doc/code divergence is what made this survive since the tool's first commit:
    // the schema promised /tmp/comfyui-images/ and the code used cwd, and no test read
    // either. Pin the description against the real default.
    const description = schemaFor("get_image").save_dir?.description ?? "";
    expect(description).not.toContain("/tmp/comfyui-images");
    expect(description).toMatch(/os\.tmpdir\(\)/);
    expect(description).toMatch(/comfyui-images/);
    expect(defaultImageSaveDir()).toBe(join(tmpdir(), "comfyui-images"));
  });

  it("stays absolute even when TEMP/TMPDIR is itself relative", async () => {
    // os.tmpdir() returns %TEMP%/%TMP%/$TMPDIR verbatim, and nothing guarantees those are
    // absolute. A relative one would be resolved by writeFile against the process cwd —
    // which is the exact bug this default exists to escape.
    const hostile = pretendUnwritableCwd();
    const key = process.platform === "win32" ? "TEMP" : "TMPDIR";
    const saved = process.env[key];
    const savedTmp = process.env.TMP;
    process.env[key] = "relative-temp";
    if (process.platform === "win32") process.env.TMP = "relative-temp";
    try {
      // Absolute AND still not anchored to the launch directory: resolving a relative
      // TEMP against cwd would have produced System32\relative-temp\comfyui-images,
      // which is the same bug with an extra path segment.
      expect(isAbsolute(defaultImageSaveDir())).toBe(true);
      expect(defaultImageSaveDir()).toBe(join(homedir(), "comfyui-images"));
      await getHandler("get_image")({ action: "get", filename: "d.png" });
      const [target] = vi.mocked(writeFile).mock.calls[0] as [string, Buffer];
      expect(isAbsolute(target)).toBe(true);
      expect(target.startsWith(hostile)).toBe(false);
      expect(target).not.toContain("relative-temp");
    } finally {
      if (saved === undefined) delete process.env[key];
      else process.env[key] = saved;
      if (savedTmp === undefined) delete process.env.TMP;
      else process.env.TMP = savedTmp;
    }
  });

  it("does not use a DRIVE-RELATIVE Windows TEMP as the default", () => {
    // `path.isAbsolute("\\Temp")` is true on Windows, but the path is drive-relative:
    // resolve() picks up whatever drive the cwd is on. TEMP=\Windows\System32 on a
    // C:-launched process therefore reproduces the original failure exactly.
    if (process.platform !== "win32") return; // the hazard is Windows-only
    const saved = { TEMP: process.env.TEMP, TMP: process.env.TMP };
    process.env.TEMP = "\\Windows\\System32";
    process.env.TMP = "\\Windows\\System32";
    try {
      expect(defaultImageSaveDir()).toBe(join(homedir(), "comfyui-images"));
      expect(defaultImageSaveDir().toLowerCase()).not.toContain("system32");
    } finally {
      if (saved.TEMP === undefined) delete process.env.TEMP;
      else process.env.TEMP = saved.TEMP;
      if (saved.TMP === undefined) delete process.env.TMP;
      else process.env.TMP = saved.TMP;
    }
  });

  it("keeps the image when the DESTINATION ITSELF cannot be resolved", async () => {
    // `resolveImageSaveDir` calls process.cwd() for a relative save_dir, and cwd throws
    // ENOENT when the launch directory has been deleted underneath us. With resolution
    // outside the guarded region that throw reached the outer catch and discarded a
    // fetched image — the same loss, one line earlier.
    cwdSpy = vi.spyOn(process, "cwd").mockImplementation(() => {
      throw Object.assign(new Error("ENOENT: no such file or directory, uv_cwd"), {
        code: "ENOENT",
      });
    });

    const out = await getHandler("get_image")({ action: "get", filename: "e.png", save_dir: "out" });

    expect(out.content.find((c) => c.type === "image")?.data).toBe(PNG);
    const text = out.content.map((c) => c.text ?? "").join("");
    expect(text).toContain("NOT SAVED");
    expect(text).toMatch(/could not even work out where to put it/);
    expect(text).toContain("ENOENT");
    // The remedy must still be reachable: name a default the caller can switch to.
    expect(text).toContain("comfyui-images");
  });

  it("does not blame a whitespace-only save_dir the caller effectively did not give", async () => {
    // resolveImageSaveDir treats "   " as omitted, so a message that says "the
    // destination came from the save_dir argument you passed (a RELATIVE save_dir …)"
    // describes a resolution that never happened, and sends the caller to fix an
    // argument that is not the problem.
    vi.mocked(mkdir).mockRejectedValueOnce(
      Object.assign(new Error("EPERM: operation not permitted, mkdir"), { code: "EPERM" }),
    );

    const out = await getHandler("get_image")({ action: "get", filename: "f.png", save_dir: "   " });

    const text = out.content.map((c) => c.text ?? "").join("");
    expect(text).toContain("NOT SAVED");
    expect(text).toMatch(/That is the default destination/);
    expect(text).not.toMatch(/came from the save_dir argument/);
    expect(text).not.toMatch(/RELATIVE save_dir/);
  });

  it("says WHOSE drive it used when an explicit save_dir is drive-relative on Windows", async () => {
    // `\out` passes isAbsolute() on Windows but picks up the process's CURRENT drive.
    // It is a legal spelling the caller typed, so it is honoured rather than refused —
    // refusing a real request would be its own bug. The hazard is silence about which
    // drive was chosen, so the failure message names the source of the drive.
    if (process.platform !== "win32") return;
    cwdSpy = vi.spyOn(process, "cwd").mockReturnValue("C:\\work\\proj");
    vi.mocked(mkdir).mockRejectedValueOnce(
      Object.assign(new Error("EPERM: operation not permitted, mkdir"), { code: "EPERM" }),
    );

    const out = await getHandler("get_image")({ action: "get", filename: "g.png", save_dir: "\\out" });

    const text = out.content.map((c) => c.text ?? "").join("");
    expect(text).toMatch(/DRIVE-RELATIVE save_dir/);
    expect(text).toMatch(/came from this process's state, not from your argument/);
    // …and NOT described as an ordinary relative path, which would send the caller to
    // the wrong fix.
    expect(text).not.toMatch(/a RELATIVE save_dir/);
    // The resolved path it reports is drive-qualified, so nothing is hidden.
    expect(text).toContain("C:\\out\\g.png");
  });

  it("also treats a drive-qualified but ROOTLESS save_dir (C:out) as drive-relative", async () => {
    // `path.isAbsolute("C:out")` is FALSE, so this fell into the generic relative branch
    // and was described as resolving against this process's working directory. Windows
    // keeps a working directory PER DRIVE and resolve() uses the NAMED drive's, which
    // need not be ours — the message named the wrong base.
    if (process.platform !== "win32") return;
    cwdSpy = vi.spyOn(process, "cwd").mockReturnValue("C:\\work\\proj");
    vi.mocked(mkdir).mockRejectedValueOnce(
      Object.assign(new Error("EPERM: operation not permitted, mkdir"), { code: "EPERM" }),
    );

    const out = await getHandler("get_image")({ action: "get", filename: "h.png", save_dir: "C:out" });

    const text = out.content.map((c) => c.text ?? "").join("");
    expect(text).toMatch(/DRIVE-RELATIVE save_dir/);
    expect(text).not.toMatch(/a RELATIVE save_dir, resolved against this process's working directory/);
  });

  it("resolveImageSaveDir treats blank/whitespace save_dir as omitted", () => {
    expect(resolveImageSaveDir(undefined)).toBe(defaultImageSaveDir());
    expect(resolveImageSaveDir("   ")).toBe(defaultImageSaveDir());
    expect(isAbsolute(resolveImageSaveDir("rel/dir"))).toBe(true);
  });
});
