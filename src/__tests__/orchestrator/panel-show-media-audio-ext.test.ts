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

// The REGRESSION this change would otherwise introduce, and the narrow guard
// that prevents it (#2010 tracks the real fix).
//
// Opening the allowlist changes what a HEADLESS client receives. Measured on
// both sides, same call, same fixture:
//
//   origin/main   isError: true   — "unsupported file type \".wav\"", nothing dispatched
//   without guard isError: false  — dispatched as kind:"audio" with a data: URL
//
// The mobile client has no audio branch at all (`MediaCard.build` is
// `if (item.isVideo) _video else _still`) and `BridgeClient` replies
// `{'shown': true}` to any show_media without reading the items — so that second
// row is an honest refusal turned into a false success, which is strictly worse
// than the refusal it replaced.
//
// The predicate is imprecise on purpose. Sticky `isHeadless` misses a scope
// address and over-refuses an offline phone that is about to be rebound. Neither
// can make things worse than main, which refuses ALL audio on this branch: the
// guard can only ever refuse what main also refused, and can never invent a
// success main did not have. Precision needs the routing resolver and the
// mailbox rule, which are #2012/#2013.
describe("#1572 audio is not newly promised to a client that cannot play it", () => {
  const headlessCtx = (): { ctx: PanelToolCtx; calls: Forwarded[] } => {
    const calls: Forwarded[] = [];
    const ctx = {
      call: async (cmd: Forwarded) => {
        calls.push(cmd);
        return { content: [{ type: "text", text: JSON.stringify(cmd) }] } as ToolResult;
      },
      confirm: async () => "yes" as const,
      bridge: { isHeadless: () => true } as unknown as PanelToolCtx["bridge"],
      tabId: "phone-tab",
    } as PanelToolCtx;
    return { ctx, calls };
  };

  const run = async (ctx: PanelToolCtx, path: string) => {
    const def = buildPanelToolDefs().find((d) => d.name === "panel_show_media")!;
    return (await def.handler({ items: [{ source: { path } }] }, ctx)) as ToolResult;
  };

  it.each(AUDIO_CASES.map(([ext]) => ext))("%s is refused for a headless target", async (ext) => {
    const { ctx, calls } = headlessCtx();
    const res = await run(ctx, paths[ext]);
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/headless client/i);
    // Refused BEFORE dispatch — a refusal that still sent the frame would leave
    // the false `{shown:true}` in place, which is the whole point.
    expect(calls.find((c) => c.cmd === "show_media")).toBeFalsy();
  });

  it("the refusal does not blame the file, and gives the caller a real move", async () => {
    const { ctx } = headlessCtx();
    const text = textOf(await run(ctx, paths[".wav"]));
    expect(text).toMatch(/Nothing is wrong with the file/);
    expect(text).toContain(paths[".wav"]);
    expect(text).toMatch(/desktop ComfyUI panel/);
    expect(text).toMatch(/do not describe how it sounds/i);
    // It must NOT read as a format problem — that sends the caller off to
    // re-encode a file that is already perfectly good.
    expect(text).not.toMatch(/unsupported file type/);
  });

  it("the guard is narrow — a headless client still gets images and video", async () => {
    for (const ext of [".png", ".jpg", ".mp4", ".webm"]) {
      const p = join(root, `other${ext}`);
      writeFileSync(p, Buffer.alloc(64));
      const { ctx, calls } = headlessCtx();
      const res = await run(ctx, p);
      expect(res.isError, `${ext} should still be sent`).toBeFalsy();
      expect(calls.find((c) => c.cmd === "show_media")).toBeTruthy();
    }
  });

  it("a BROWSER panel is unaffected — the reported case still works", async () => {
    const { res, calls } = await showMedia([{ source: { path: paths[".wav"] } }]);
    expect(res.isError).toBeFalsy();
    const items = calls.find((c) => c.cmd === "show_media")!.items as Array<{ kind?: string }>;
    expect(items[0].kind).toBe("audio");
  });

  it("a bridge with no isHeadless does not throw, and audio still flows", async () => {
    const def = buildPanelToolDefs().find((d) => d.name === "panel_show_media")!;
    const calls: Forwarded[] = [];
    const ctx = {
      call: async (cmd: Forwarded) => {
        calls.push(cmd);
        return { content: [{ type: "text", text: "ok" }] } as ToolResult;
      },
      confirm: async () => "yes" as const,
      bridge: {} as unknown as PanelToolCtx["bridge"],
      tabId: "t",
    } as PanelToolCtx;
    const res = (await def.handler(
      { items: [{ source: { path: paths[".wav"] } }] },
      ctx,
    )) as ToolResult;
    expect(res.isError).toBeFalsy();
    const items = calls.find((c) => c.cmd === "show_media")!.items as Array<{ kind?: string }>;
    expect(items[0].kind).toBe("audio");
  });
});

// The correction the gate forced on the guard above.
//
// Asking `isHeadless(ctx.tabId)` is asking about an ADDRESS. `ctx.tabId` may be
// a SCOPE ADDRESS (#884: `orchestrator`, `orchestrator::<backend>`), which is
// not a tab at all — `conns` is keyed by tab id and `headlessSeen` never holds a
// scope address — so the lookup misses and answers `false`, while
// `resolveTarget`'s scope branch ends "…else the most recent headless one". A
// codex- or claude-backend session resting on a phone therefore walked straight
// past a guard written to stop exactly that.
//
// Restated as a positive requirement — allow only a PROVEN non-headless
// destination — the monotonicity argument actually holds: every refusal here is
// a case main refused too, because main refuses all audio on this branch.
describe("#1572 the guard requires a proven destination, not an unexamined address", () => {
  const ctxFor = (opts: {
    tabId: string;
    resolves?: (id: string) => string | undefined;
    headless: (id: string) => boolean;
  }): { ctx: PanelToolCtx; calls: Forwarded[] } => {
    const calls: Forwarded[] = [];
    const bridge: Record<string, unknown> = { isHeadless: opts.headless };
    if (opts.resolves) bridge.liveTabIdFor = opts.resolves;
    const ctx = {
      call: async (cmd: Forwarded) => {
        calls.push(cmd);
        return { content: [{ type: "text", text: "ok" }] } as ToolResult;
      },
      confirm: async () => "yes" as const,
      bridge: bridge as unknown as PanelToolCtx["bridge"],
      tabId: opts.tabId,
    } as PanelToolCtx;
    return { ctx, calls };
  };

  const run = async (ctx: PanelToolCtx) => {
    const def = buildPanelToolDefs().find((d) => d.name === "panel_show_media")!;
    return (await def.handler({ items: [{ source: { path: paths[".wav"] } }] }, ctx)) as ToolResult;
  };

  it("a SCOPE address resolving onto a phone is refused — the gate's exact case", async () => {
    const { ctx, calls } = ctxFor({
      tabId: "orchestrator::claude",
      // The real isHeadless: a scope address is never a key, so it answers false.
      headless: (id) => id === "phone-1",
      resolves: (id) => (id === "orchestrator::claude" ? "phone-1" : id),
    });
    const res = await run(ctx);
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/headless client/i);
    expect(calls.find((c) => c.cmd === "show_media")).toBeFalsy();
  });

  it("a SCOPE address resolving onto a desktop tab still gets its audio", async () => {
    const { ctx, calls } = ctxFor({
      tabId: "orchestrator::claude",
      headless: (id) => id === "phone-1",
      resolves: () => "desktop-1",
    });
    const res = await run(ctx);
    expect(res.isError).toBeFalsy();
    const items = calls.find((c) => c.cmd === "show_media")!.items as Array<{ kind?: string }>;
    expect(items[0].kind).toBe("audio");
  });

  it("an address that resolves to NOTHING is refused, and says so in its own words", async () => {
    // Not "you are on a phone" — nobody knows what it is on. main refused this
    // too, so refusing keeps the guard monotone; claiming a phone would not.
    const { ctx, calls } = ctxFor({
      tabId: "orchestrator::claude",
      headless: () => false,
      resolves: () => undefined,
    });
    const res = await run(ctx);
    expect(res.isError).toBe(true);
    const text = textOf(res);
    expect(text).toMatch(/no tab can currently be identified/);
    expect(text).not.toMatch(/this conversation is on a headless client/);
    expect(calls.find((c) => c.cmd === "show_media")).toBeFalsy();
  });

  it("the ADDRESS itself is never what gets asked about", async () => {
    // A bridge answering true for the address and false for the resolved tab
    // must still let the audio through. If the guard regresses to reading
    // ctx.tabId directly, this fails.
    const { ctx, calls } = ctxFor({
      tabId: "orchestrator::claude",
      headless: (id) => id === "orchestrator::claude",
      resolves: () => "desktop-1",
    });
    const res = await run(ctx);
    expect(res.isError).toBeFalsy();
    expect(calls.find((c) => c.cmd === "show_media")).toBeTruthy();
  });

  it("a concrete id is resolved too, so a prefix cannot dodge the guard", async () => {
    const { ctx, calls } = ctxFor({
      tabId: "phone-1",
      headless: (id) => id === "phone-1-full-id",
      resolves: (id) => (id === "phone-1" ? "phone-1-full-id" : id),
    });
    const res = await run(ctx);
    expect(res.isError).toBe(true);
    expect(calls.find((c) => c.cmd === "show_media")).toBeFalsy();
  });

  it("a bridge without liveTabIdFor falls back to the id it was given", async () => {
    const { ctx, calls } = ctxFor({ tabId: "desktop-1", headless: () => false });
    const res = await run(ctx);
    expect(res.isError).toBeFalsy();
    expect(calls.find((c) => c.cmd === "show_media")).toBeTruthy();
  });
});
