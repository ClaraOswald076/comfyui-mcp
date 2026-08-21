// #1572 — panel_show_media refused audio outright:
//   unsupported file type ".wav" (allowed: .png, .jpg, … .avi)
// so in a TTS/voice-clone session the agent could not play the generated take
// back to the user at all, and worked around it by wrapping each .wav in an
// mp4 with an ffmpeg showwaves filter.
//
// WHAT WAS ACTUALLY MISSING WAS ONLY THIS GATE. The panel has shipped a real
// `<audio controls>` card since #710 — paintAudio, its own AUDIO_EXTENSIONS
// allowlist, an "audible" disclosure in the reply, and media persistence under
// mkind:"audio" — and composeShowMediaReply already routes kind:"audio" to that
// painter and skips the video storyboard for it. Nothing was built here; a door
// was opened.
//
// THE EXTENSION SET is the panel renderer's own AUDIO_EXTENSIONS verbatim
// (web/js/lib/media-preview.js), because the gate's job is to refuse what the
// card cannot present. It is a superset of what this codebase already calls
// audio (upload_image action:"audio" and services/image-management's
// AUDIO_MIME) and of what ComfyUI's own save nodes write (AudioSaveHelper's
// _FORMATS is {flac, mp3, opus}).
//
// THE MIME MAP IS MEASURED, NOT DERIVED. A `data:` URL's declared type is the
// only type the browser gets, and a wrong one is refused before any decoder
// runs — the same class of bug #811 fixed for video. Verified in Chromium
// against real ffmpeg-encoded files: `.opus` as `audio/opus` (the natural
// guess, and what this repo's own audio-attachment.ts AUDIO_MIME_BY_EXT uses)
// FAILS with "MEDIA_ELEMENT_ERROR: Unable to load URL due to content type",
// while `audio/ogg` decodes; `.flac` as `audio/x-flac` fails where `audio/flac`
// decodes. That matters because .opus is a core ComfyUI SaveAudio output.
//
// The resolved item (with its dataUrl/mime) is never echoed back in the tool's
// OWN reply — it is dispatched onward via `ctx.call({cmd:"show_media", items})`
// to the panel. So verification captures the OUTBOUND call, mirroring
// panel-show-media-video-ext.test.ts's makeCtx/calls convention exactly.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildPanelToolDefs, type PanelToolCtx, type ToolResult } from "../../orchestrator/panel-tools.js";

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

/** Exactly the panel renderer's AUDIO_EXTENSIONS (web/js/lib/media-preview.js). */
const AUDIO_CASES: Array<[string, string]> = [
  [".wav", "audio/wav"],
  [".mp3", "audio/mpeg"],
  [".flac", "audio/flac"],
  [".ogg", "audio/ogg"],
  [".oga", "audio/ogg"],
  [".opus", "audio/ogg"],
  [".m4a", "audio/mp4"],
  [".aac", "audio/aac"],
];

/** Types that must STILL be refused — the gate is an allowlist, not a denylist,
 *  and widening it by eight extensions must not turn it into "anything goes".
 *  `.wma` and `.aiff` are deliberately here: they are unmistakably AUDIO (this
 *  repo's audio-attachment.ts lists both in AUDIO_EXT_NOT_ENCODABLE), so if the
 *  gate had been loosened to "looks like audio" rather than to a named set,
 *  they would sail through and reach an `<audio>` element that cannot play
 *  them. `.webm` is NOT tested as a refusal — it is already a VIDEO extension
 *  here and must stay one. */
const REFUSED = [".txt", ".exe", ".wma", ".aiff", ".mid", ".pdf", ".json"];

let root: string;
const paths: Record<string, string> = {};

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "cmcp-showmedia-audioext-"));
  mkdirSync(root, { recursive: true });
  for (const ext of [...AUDIO_CASES.map(([e]) => e), ...REFUSED]) {
    const p = join(root, `take${ext}`);
    writeFileSync(p, Buffer.alloc(64)); // well under the inline cap
    paths[ext] = p;
  }
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("#1572 audio is accepted by panel_show_media", () => {
  it.each(AUDIO_CASES.map(([ext]) => ext))("%s is no longer refused", async (ext) => {
    const { res } = await showMedia([{ source: { path: paths[ext] }, caption: "take 1" }]);
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).not.toMatch(/unsupported file type/);
  });

  it.each(AUDIO_CASES)("%s is dispatched as kind:\"audio\" with mime %s", async (ext, mime) => {
    const { res, calls } = await showMedia([{ source: { path: paths[ext] } }]);
    expect(res.isError).toBeFalsy();

    const dispatched = calls.find((c) => c.cmd === "show_media");
    expect(dispatched, "no show_media command was dispatched to the panel").toBeTruthy();
    const items = dispatched!.items as Array<{ kind?: string; dataUrl?: string }>;
    expect(items).toHaveLength(1);
    // The panel's classifyShowMediaItem trusts the orchestrator's own `kind`
    // FIRST, and painterFor.audio is paintAudio — so this string is what routes
    // the file to an <audio> element instead of a broken <img> (#710).
    expect(items[0].kind).toBe("audio");
    expect(items[0].dataUrl).toBeTruthy();
    expect(items[0].dataUrl!.startsWith(`data:${mime};base64,`)).toBe(true);
  });

  // The two entries a table-copy would have got wrong, pinned individually so a
  // future "tidy this up against AUDIO_MIME_BY_EXT" cannot silently re-break the
  // one audio format ComfyUI's own SaveAudioOpus writes.
  it("does NOT label .opus as audio/opus — Chromium refuses that content type", async () => {
    const { calls } = await showMedia([{ source: { path: paths[".opus"] } }]);
    const items = (calls.find((c) => c.cmd === "show_media")!.items) as Array<{ dataUrl?: string }>;
    expect(items[0].dataUrl!.startsWith("data:audio/opus;")).toBe(false);
  });

  it("does NOT label .flac as audio/x-flac — Chromium refuses that content type", async () => {
    const { calls } = await showMedia([{ source: { path: paths[".flac"] } }]);
    const items = (calls.find((c) => c.cmd === "show_media")!.items) as Array<{ dataUrl?: string }>;
    expect(items[0].dataUrl!.startsWith("data:audio/x-flac;")).toBe(false);
  });
});

describe("#1572 the gate is still an allowlist — both directions", () => {
  it.each(REFUSED)("%s is still refused", async (ext) => {
    const { res, calls } = await showMedia([{ source: { path: paths[ext] } }]);
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(
      new RegExp(`unsupported file type "\\${ext}"`),
    );
    // Refused BEFORE anything is dispatched — a refusal that still painted
    // would be no gate at all.
    expect(calls.find((c) => c.cmd === "show_media")).toBeFalsy();
  });

  it("the refusal names the audio extensions too, so the caller can act on it", async () => {
    const { res } = await showMedia([{ source: { path: paths[".txt"] } }]);
    const text = textOf(res);
    for (const [ext] of AUDIO_CASES) expect(text).toContain(ext);
    // …without losing what it already allowed.
    expect(text).toContain(".png");
    expect(text).toContain(".mov");
  });
});

describe("#1572 .webm stays a VIDEO", () => {
  // audio-attachment.ts's AUDIO_MIME_BY_EXT maps webm/weba to audio/webm.
  // Copying that table wholesale would have re-classified an extension this
  // tool has treated as video since #811, turning an existing video card into
  // an audio player. The audio set is deliberately the panel renderer's, not
  // that one.
  it("is dispatched as video/webm, not audio/webm", async () => {
    const p = join(root, "clip.webm");
    writeFileSync(p, Buffer.alloc(64));
    const { res, calls } = await showMedia([{ source: { path: p } }]);
    expect(res.isError).toBeFalsy();
    const items = (calls.find((c) => c.cmd === "show_media")!.items) as Array<{
      kind?: string;
      dataUrl?: string;
    }>;
    expect(items[0].kind).toBe("video");
    expect(items[0].dataUrl!.startsWith("data:video/webm;base64,")).toBe(true);
  });
});
