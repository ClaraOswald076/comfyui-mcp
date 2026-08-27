// #2439 — panel_screenshot must persist a PNG to the caller-specified path.
// The capture already returned an image block; the defect was that save_path
// did not exist, so a deferred-tool client had to forward a 200k-character
// base64 payload into a filesystem command and died on Windows error 206.
//
// These tests fail if the path is ignored: a named dest must receive the PNG
// bytes, a blocked dest must error (not return image-only success), and a
// relative/blank dest must be refused before the capture is even sent.

import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";

import {
  buildPanelToolDefs,
  makePanelToolCtx,
  type PanelToolCtx,
  type ToolResult,
} from "../../orchestrator/panel-tools.js";
import {
  decodePngBase64,
  persistScreenshotPng,
  resolveScreenshotPersistPath,
  screenshotOverwriteFromArgs,
  screenshotPersistPathFromArgs,
  ScreenshotPersistError,
} from "../../orchestrator/panel-screenshot-persist.js";

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xaa, 0xbb]);
const PNG_B64 = PNG_BYTES.toString("base64");

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "panel-ss-persist-"));
  temps.push(dir);
  return dir;
}

function screenshotTool() {
  const def = buildPanelToolDefs().find((d) => d.name === "panel_screenshot");
  if (!def) throw new Error("panel_screenshot is not registered");
  return def;
}

function screenshotCtx(): { ctx: PanelToolCtx; sent: Array<{ cmd: string }> } {
  const sent: Array<{ cmd: string }> = [];
  const bridge = {
    send: async (cmd: { cmd: string }) => {
      sent.push(cmd);
      if (cmd.cmd === "graph_screenshot") return { image: PNG_B64, mimeType: "image/png" };
      if (cmd.cmd === "graph_serialize") return { nodes: [] };
      return {};
    },
    push: () => 1,
    canReach: () => true,
  } as PanelToolCtx["bridge"];
  return { ctx: makePanelToolCtx(bridge, "test-tab"), sent };
}

function allText(res: ToolResult): string {
  const parts: string[] = [];
  for (const c of res.content) {
    if (c.type === "text") parts.push(c.text);
  }
  return parts.join("\n");
}

function imageData(res: ToolResult): string | undefined {
  for (const c of res.content) {
    if (c.type === "image") return c.data;
  }
  return undefined;
}

describe("panel_screenshot persist path (#2439)", () => {
  it("schema accepts save_path, output_path, and overwrite", () => {
    const parsed = z.object(screenshotTool().schema);
    expect(parsed.safeParse({}).success).toBe(true);
    expect(parsed.safeParse({ save_path: "C:\\audit\\placed.png" }).success).toBe(true);
    expect(parsed.safeParse({ output_path: "C:\\audit\\placed.png" }).success).toBe(true);
    expect(parsed.safeParse({ overwrite: false }).success).toBe(true);
    expect(Object.keys(screenshotTool().schema)).toEqual(
      expect.arrayContaining(["padding", "save_path", "output_path", "overwrite"]),
    );
  });

  it("writes the PNG bytes to save_path and reports the resolved dest", async () => {
    const dest = join(scratchDir(), "placed.png");
    const { ctx, sent } = screenshotCtx();

    const res = await screenshotTool().handler({ save_path: dest }, ctx);

    expect(res.isError).not.toBe(true);
    expect(sent.some((c) => c.cmd === "graph_screenshot")).toBe(true);
    expect(imageData(res)).toBe(PNG_B64);
    expect(existsSync(dest)).toBe(true);
    expect(readFileSync(dest).equals(PNG_BYTES)).toBe(true);
    expect(allText(res)).toContain(`Saved to: ${dest}`);
  });

  it("output_path is the same write as save_path", async () => {
    const dest = join(scratchDir(), "via-output.png");
    const { ctx } = screenshotCtx();

    const res = await screenshotTool().handler({ output_path: dest }, ctx);

    expect(res.isError).not.toBe(true);
    expect(existsSync(dest)).toBe(true);
    expect(readFileSync(dest).equals(PNG_BYTES)).toBe(true);
    expect(allText(res)).toContain(dest);
  });

  it("refuses an existing file unless overwrite is true, and leaves the original bytes", async () => {
    const dest = join(scratchDir(), "placed.png");
    writeFileSync(dest, "original-not-png");
    const { ctx, sent } = screenshotCtx();

    const res = await screenshotTool().handler({ save_path: dest }, ctx);

    expect(res.isError).toBe(true);
    expect(sent).toEqual([]);
    expect(readFileSync(dest, "utf8")).toBe("original-not-png");
    expect(allText(res)).toMatch(/already exists/i);
    expect(allText(res)).toMatch(/overwrite:true/);
  });

  it("overwrite:true replaces the existing file with the PNG", async () => {
    const dest = join(scratchDir(), "placed.png");
    writeFileSync(dest, "stale");
    const { ctx } = screenshotCtx();

    const res = await screenshotTool().handler({ save_path: dest, overwrite: true }, ctx);

    expect(res.isError).not.toBe(true);
    expect(readFileSync(dest).equals(PNG_BYTES)).toBe(true);
  });

  it("a relative save_path fails the call instead of being ignored", async () => {
    const { ctx, sent } = screenshotCtx();
    const relative = `placed-${Date.now()}.png`;

    const res = await screenshotTool().handler({ save_path: relative }, ctx);

    expect(res.isError).toBe(true);
    expect(sent).toEqual([]);
    expect(existsSync(relative)).toBe(false);
    expect(existsSync(resolve(relative))).toBe(false);
    expect(allText(res)).toMatch(/absolute path/i);
  });

  it("a whitespace save_path is refused, not treated as omitted", async () => {
    const { ctx, sent } = screenshotCtx();

    const res = await screenshotTool().handler({ save_path: "   " }, ctx);

    expect(res.isError).toBe(true);
    expect(sent).toEqual([]);
    expect(imageData(res)).toBeUndefined();
    expect(allText(res)).toMatch(/empty/i);
  });

  it("a directory save_path is refused", async () => {
    const dir = join(scratchDir(), "placed.png");
    mkdirSync(dir);
    const { ctx, sent } = screenshotCtx();

    const res = await screenshotTool().handler({ save_path: dir }, ctx);

    expect(res.isError).toBe(true);
    expect(sent).toEqual([]);
    expect(allText(res)).toMatch(/directory/i);
  });

  it("a non-.png save_path is refused", async () => {
    const dest = join(scratchDir(), "placed.jpg");
    const { ctx, sent } = screenshotCtx();

    const res = await screenshotTool().handler({ save_path: dest }, ctx);

    expect(res.isError).toBe(true);
    expect(sent).toEqual([]);
    expect(existsSync(dest)).toBe(false);
    expect(allText(res)).toMatch(/\.png/i);
  });

  it("disagreeing save_path and output_path fail closed", async () => {
    const dir = scratchDir();
    const { ctx, sent } = screenshotCtx();

    const res = await screenshotTool().handler(
      { save_path: join(dir, "a.png"), output_path: join(dir, "b.png") },
      ctx,
    );

    expect(res.isError).toBe(true);
    expect(sent).toEqual([]);
    expect(existsSync(join(dir, "a.png"))).toBe(false);
    expect(existsSync(join(dir, "b.png"))).toBe(false);
    expect(allText(res)).toMatch(/disagree/i);
  });

  it("omitting the path still returns the image and does not invent a dest", async () => {
    const { ctx } = screenshotCtx();
    const res = await screenshotTool().handler({}, ctx);
    expect(res.isError).not.toBe(true);
    expect(imageData(res)).toBe(PNG_B64);
    expect(allText(res)).not.toMatch(/Saved to:/);
    expect(res.content).toHaveLength(1);
  });
});

describe("screenshot persist helpers (#2439)", () => {
  it("screenshotPersistPathFromArgs reads either alias and rejects a blank", () => {
    expect(screenshotPersistPathFromArgs({})).toBeUndefined();
    expect(screenshotPersistPathFromArgs({ save_path: "/tmp/a.png" })).toBe("/tmp/a.png");
    expect(screenshotPersistPathFromArgs({ output_path: "/tmp/b.png" })).toBe("/tmp/b.png");
    expect(() => screenshotPersistPathFromArgs({ save_path: "  " })).toThrow(ScreenshotPersistError);
    expect(screenshotOverwriteFromArgs({})).toBe(false);
    expect(screenshotOverwriteFromArgs({ overwrite: true })).toBe(true);
  });

  it("resolveScreenshotPersistPath requires a fully-qualified .png path", () => {
    expect(() => resolveScreenshotPersistPath("placed.png")).toThrow(/absolute path/i);
    expect(() => resolveScreenshotPersistPath(join(scratchDir(), "x.jpg"))).toThrow(/\.png/i);
    const dest = join(scratchDir(), "ok.png");
    expect(resolveScreenshotPersistPath(dest)).toBe(resolve(dest));
  });

  it("persistScreenshotPng writes atomically and refuses an existing file", () => {
    const dest = join(scratchDir(), "atom.png");
    persistScreenshotPng(dest, PNG_BYTES, false);
    expect(readFileSync(dest).equals(PNG_BYTES)).toBe(true);
    expect(() => persistScreenshotPng(dest, PNG_BYTES, false)).toThrow(/already exists/i);
    persistScreenshotPng(dest, PNG_BYTES, true);
    expect(readFileSync(dest).equals(PNG_BYTES)).toBe(true);
  });

  it("decodePngBase64 refuses non-PNG bytes", () => {
    expect(decodePngBase64(PNG_B64).equals(PNG_BYTES)).toBe(true);
    expect(() => decodePngBase64(Buffer.from("not-a-png").toString("base64"))).toThrow(/not PNG/i);
  });
});
