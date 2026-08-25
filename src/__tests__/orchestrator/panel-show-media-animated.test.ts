// #2248 — animated media must leave this repository with its original bytes.
// The mobile/remote renderer is not part of comfyui-mcp, so this suite pins the
// producer-side guarantee: GIF/APNG/WebP are accepted as images, their MIME is
// correct, and no thumbnail/bitmap conversion drops animation frames.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildPanelToolDefs, type PanelToolCtx, type ToolResult } from "../../orchestrator/panel-tools.js";
import { paintedShowMediaKind } from "../../services/ui-bridge.js";

type Forwarded = Record<string, unknown>;

function makeCtx(): { ctx: PanelToolCtx; calls: Forwarded[] } {
  const calls: Forwarded[] = [];
  const ctx = {
    call: async (cmd: Forwarded) => {
      calls.push(cmd);
      return { content: [{ type: "text", text: JSON.stringify(cmd) }] } as ToolResult;
    },
    confirm: async () => "yes" as const,
    bridge: { isHeadless: () => false } as unknown as PanelToolCtx["bridge"],
    tabId: "test-tab",
  } as PanelToolCtx;
  return { ctx, calls };
}

async function showMedia(items: Array<Record<string, unknown>>): Promise<{ res: ToolResult; calls: Forwarded[] }> {
  const def = buildPanelToolDefs().find((d) => d.name === "panel_show_media");
  if (!def) throw new Error("panel_show_media not found");
  const { ctx, calls } = makeCtx();
  const res = (await def.handler({ items }, ctx)) as ToolResult;
  return { res, calls };
}

const textOf = (res: ToolResult): string => res.content.map((c) => ("text" in c ? c.text : "")).join("\n");

const cases = [
  [".gif", "image/gif", Buffer.from("GIF89a\x00animated-frame-data", "binary")],
  [".apng", "image/apng", Buffer.from("\x89PNG\r\n\x1a\n\x00APNG\x00animated-frame-data", "binary")],
  [".webp", "image/webp", Buffer.from("RIFF\x00\x00\x00\x00WEBPanimated-frame-data", "binary")],
] as const;

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "cmcp-showmedia-animated-"));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("#2248 animated image delivery", () => {
  it.each(cases)("preserves the original %s bytes and MIME", async (ext, mime, bytes) => {
    const path = join(root, `animated${ext}`);
    writeFileSync(path, bytes);

    const { res, calls } = await showMedia([{ source: { path } }]);
    expect(res.isError).toBeFalsy();

    const command = calls.find((call) => call.cmd === "show_media");
    expect(command).toBeTruthy();
    const item = (command!.items as Array<Record<string, unknown>>)[0];
    expect(item.kind).toBe("image");
    expect(item.dataUrl).toBe(`data:${mime};base64,${bytes.toString("base64")}`);
  });

  it("reports frame uncertainty for inline bytes, not a filename-only viewRef", async () => {
    const inlinePath = join(root, "inline.gif");
    writeFileSync(inlinePath, Buffer.from("GIF89a\x00animated-frame-data", "binary"));
    const inline = await showMedia([{ source: { path: inlinePath } }]);
    expect(textOf(inline.res)).toContain("Animated GIF/APNG/WebP bytes were dispatched");

    const reference = await showMedia([{ source: { filename: "remote.gif", type: "output" } }]);
    const command = reference.calls.find((call) => call.cmd === "show_media");
    const item = (command!.items as Array<Record<string, unknown>>)[0];
    expect(item.kind).toBe("viewRef");
    expect(item.dataUrl).toBeUndefined();
    expect(textOf(reference.res)).not.toContain("Animated GIF/APNG/WebP bytes were dispatched");
  });

  it.each([".gif", ".apng", ".webp"])("classifies %s view references as images", (ext) => {
    expect(
      paintedShowMediaKind({
        kind: "viewRef",
        viewRef: { filename: `animated${ext}`, type: "output" },
      }),
    ).toBe("image");
  });
});
