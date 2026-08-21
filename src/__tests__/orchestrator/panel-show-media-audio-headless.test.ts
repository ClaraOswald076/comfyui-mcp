// #1572, round 2 — raised as a P1 by review on PR #2002.
//
// THE FINDING, restated as what the USER gets. Opening the audio allowlist is
// only half an answer, because `panel_show_media` has two kinds of client and
// only one of them can play a sound:
//
//   - the BROWSER panel has had a real `<audio controls>` card since #710;
//   - the HEADLESS client (paired phone / remote viewer) has none.
//
// Read from the mobile client's own source (comfyui-mcp-mobile @ c7b0dbc,
// which is checked out on this machine — Dart/Flutter are NOT installed here,
// so this is READ, not executed, and is stated that way in the PR):
//
//   bridge_frames.dart  MediaItem.isVideo — mime first (`video/` true,
//                       `image/` false), else extension from
//                       {mp4,mov,webm,m4v,avi,mkv}. `audio/wav` matches no mime
//                       prefix and `.wav` is not in that set → false.
//   media_card.dart     MediaCard.build is `if (item.isVideo) _video else
//                       _still` — TWO branches. `_still` builds a MemoryImage
//                       from inline bytes (or a NetworkImage on the /view URL)
//                       and `Image(errorBuilder:)` degrades to a caption row
//                       with an IMAGE icon when the decode fails.
//   bridge_client.dart  replies `{'shown': true}` to ANY show_media, without
//                       looking at the items at all.
//
// So audio sent to that client is `shown:true` over something nobody can play,
// and the agent goes on to discuss a take that was never heard. That is the
// unearned claim this tool exists to remove.
//
// WHY NOT JUST INLINE IT, which is the obvious fix and the one review proposed:
// because there is no audio path on that client to route to. Inline audio bytes
// reach the same `MemoryImage`, fail the same decode, and land in the same
// caption fallback as a bytes-less ref — after shipping up to 20 MB of base64
// to a phone to arrive at the identical non-result. Widening the orchestrator
// cannot invent a player in a client that has none.
//
// So audio aimed at a headless target is REFUSED, naming the limitation. Both
// item source forms are gated, because both end at the same client: a `{path}`
// item is inlined regardless of headless (so it would have reached the phone as
// a data URL), and a `{filename}` ref is forwarded for the client to fetch.

import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildPanelToolDefs, type PanelToolCtx, type ToolResult } from "../../orchestrator/panel-tools.js";

type Forwarded = Record<string, unknown>;

function makeCtx(headless: boolean, reachable = true): { ctx: PanelToolCtx; calls: Forwarded[] } {
  const calls: Forwarded[] = [];
  const ctx = {
    call: async (cmd: Forwarded) => {
      calls.push(cmd);
      return { content: [{ type: "text", text: JSON.stringify(cmd) }] } as ToolResult;
    },
    confirm: async () => "yes" as const,
    bridge: { isHeadless: () => headless, canReach: () => reachable } as unknown as PanelToolCtx["bridge"],
    tabId: "test-tab",
  } as PanelToolCtx;
  return { ctx, calls };
}

async function showMedia(
  items: Array<Record<string, unknown>>,
  headless: boolean,
  reachable = true,
): Promise<{ res: ToolResult; calls: Forwarded[] }> {
  const def = buildPanelToolDefs().find((d) => d.name === "panel_show_media");
  if (!def) throw new Error("panel_show_media not found");
  const { ctx, calls } = makeCtx(headless, reachable);
  const res = (await def.handler({ items }, ctx)) as ToolResult;
  return { res, calls };
}

const textOf = (res: ToolResult): string => res.content.map((c) => ("text" in c ? c.text : "")).join("\n");

const root = mkdtempSync(join(tmpdir(), "cmcp-showmedia-headless-"));
mkdirSync(root, { recursive: true });
const filePath = (name: string): string => {
  const p = join(root, name);
  writeFileSync(p, Buffer.alloc(64));
  return p;
};

const AUDIO = [".wav", ".mp3", ".flac", ".ogg", ".oga", ".opus", ".m4a", ".aac"];

describe("#1572 audio aimed at a HEADLESS client is refused, not silently un-played", () => {
  it.each(AUDIO)("a %s PATH is refused", async (ext) => {
    const { res, calls } = await showMedia([{ source: { path: filePath(`take${ext}`) } }], true);
    expect(res.isError).toBe(true);
    const text = textOf(res);
    expect(text).toMatch(/HEADLESS client/);
    expect(text).toMatch(/no audio player/i);
    // Nothing was dispatched — the point is that the client never gets a card
    // it will acknowledge as shown.
    expect(calls.find((c) => c.cmd === "show_media")).toBeFalsy();
  });

  it.each(AUDIO)("a %s /view REF is refused", async (ext) => {
    const { res, calls } = await showMedia(
      [{ source: { filename: `take_00001${ext}`, type: "output" } }],
      true,
    );
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/HEADLESS client/);
    expect(calls.find((c) => c.cmd === "show_media")).toBeFalsy();
  });

  it("the refusal does not blame the file, and gives the caller a real move", async () => {
    const p = filePath("voice.wav");
    const { res } = await showMedia([{ source: { path: p } }], true);
    const text = textOf(res);
    // The file is fine and its location is named.
    expect(text).toMatch(/Nothing is wrong with the audio/);
    expect(text).toContain(p);
    // A remedy that works from where the caller is.
    expect(text).toMatch(/desktop ComfyUI panel/);
    // And the honesty rule that outlives the refusal.
    expect(text).toMatch(/do not describe how it sounds/i);
    // The refusal must not read as "unsupported format" — that would send the
    // caller off to re-encode a file that is already perfectly good.
    expect(text).not.toMatch(/unsupported file type/);
  });

  it("says why inlining is not the answer, so the next reader does not 'fix' it", async () => {
    const { res } = await showMedia([{ source: { path: filePath("voice.wav") } }], true);
    expect(textOf(res)).toMatch(/Inlining the bytes does not help/);
  });
});

describe("#1572 the headless gate is narrow — it costs nothing else", () => {
  it("a BROWSER panel still gets audio, dispatched as kind:\"audio\"", async () => {
    const { res, calls } = await showMedia([{ source: { path: filePath("take.wav") } }], false);
    expect(res.isError).toBeFalsy();
    const items = calls.find((c) => c.cmd === "show_media")!.items as Array<{ kind?: string }>;
    expect(items[0].kind).toBe("audio");
  });

  it("a BROWSER panel still gets an audio /view ref forwarded to classify", async () => {
    const { res, calls } = await showMedia(
      [{ source: { filename: "take_00001.wav", type: "output" } }],
      false,
    );
    expect(res.isError).toBeFalsy();
    const items = calls.find((c) => c.cmd === "show_media")!.items as Array<{ kind?: string }>;
    expect(items[0].kind).toBe("viewRef");
  });

  it.each([".png", ".jpg", ".webp"])("a headless client still gets %s", async (ext) => {
    const { res, calls } = await showMedia([{ source: { path: filePath(`plate${ext}`) } }], true);
    expect(res.isError).toBeFalsy();
    const items = calls.find((c) => c.cmd === "show_media")!.items as Array<{ kind?: string }>;
    expect(items[0].kind).toBe("image");
  });

  it.each([".mp4", ".webm", ".mov"])("a headless client still gets %s", async (ext) => {
    const { res, calls } = await showMedia([{ source: { path: filePath(`clip${ext}`) } }], true);
    expect(res.isError).toBeFalsy();
    const items = calls.find((c) => c.cmd === "show_media")!.items as Array<{ kind?: string }>;
    expect(items[0].kind).toBe("video");
  });

  it("a headless client still gets a non-audio /view ref forwarded", async () => {
    const { res, calls } = await showMedia([{ source: { filename: "a.png", type: "output" } }], true);
    expect(res.isError).toBeFalsy();
    expect(calls.find((c) => c.cmd === "show_media")).toBeTruthy();
  });

  it("a bridge with no isHeadless at all does not throw, and audio still flows", async () => {
    // Every other isHeadless call site in this file typeof-guards, because a
    // lightweight bridge need not implement it. An unguarded read here would
    // turn an optional capability into a crash on the audio path.
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
      { items: [{ source: { path: filePath("take.wav") } }] },
      ctx,
    )) as ToolResult;
    expect(res.isError).toBeFalsy();
    const items = calls.find((c) => c.cmd === "show_media")!.items as Array<{ kind?: string }>;
    expect(items[0].kind).toBe("audio");
  });
});

// #1572 round 3 — the gate's SECOND P1, and the sharper edge of the same idea.
//
// The verdict used to be read at the TOP of the handler. `ctx.tabId` is held
// LIVE on the ctx (makePanelToolCtx says so in as many words) precisely so
// `ctx.call`'s `ensureReachable()` can rebind an orphaned session in place — and
// `interactiveTabIds()` filters headless OUT, so a heal can only ever land on a
// CANVAS tab. So the old read answered a question about a tab the frame was
// about to stop going to: a phone asleep in a pocket, desktop panel open,
// `.wav` refused for nothing.
//
// Two corrections, and both are load-bearing:
//   1. the verdict is taken ONCE, immediately before dispatch, after every
//      await this handler performs;
//   2. it requires the headless tab to be REACHABLE — connected right now. An
//      unreachable sticky-headless tab is exactly the session about to be healed
//      onto a canvas tab (where audio plays), or else one whose call surfaces
//      the bridge's own tab-listing error, which is a better message than this
//      refusal.
describe("#1572 an UNREACHABLE headless tab is not refused — it is about to be rebound", () => {
  it.each(AUDIO)("a %s PATH is allowed through when the phone is offline", async (ext) => {
    const { res, calls } = await showMedia(
      [{ source: { path: filePath(`take${ext}`) } }],
      true, // sticky isHeadless — this tab once helloed headless
      false, // …but canReach is false: ensureReachable will heal onto a canvas tab
    );
    expect(res.isError).toBeFalsy();
    const items = calls.find((c) => c.cmd === "show_media")!.items as Array<{ kind?: string }>;
    expect(items[0].kind).toBe("audio");
  });

  it("an offline headless tab's /view REF is allowed through too", async () => {
    const { res, calls } = await showMedia(
      [{ source: { filename: "take_00001.wav", type: "output" } }],
      true,
      false,
    );
    expect(res.isError).toBeFalsy();
    expect(calls.find((c) => c.cmd === "show_media")).toBeTruthy();
  });

  it("a CONNECTED phone is still refused — the case the gate exists for", async () => {
    const { res } = await showMedia([{ source: { path: filePath("take.wav") } }], true, true);
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/HEADLESS client/);
  });

  it("a bridge that cannot answer canReach is treated as reachable, not as absent", async () => {
    // isHeadless already said "phone". Inventing liveness we cannot observe is
    // how an unearned claim gets made in the other direction.
    const def = buildPanelToolDefs().find((d) => d.name === "panel_show_media")!;
    const calls: Forwarded[] = [];
    const ctx = {
      call: async (cmd: Forwarded) => {
        calls.push(cmd);
        return { content: [{ type: "text", text: "ok" }] } as ToolResult;
      },
      confirm: async () => "yes" as const,
      bridge: { isHeadless: () => true } as unknown as PanelToolCtx["bridge"], // no canReach
      tabId: "t",
    } as PanelToolCtx;
    const res = (await def.handler(
      { items: [{ source: { path: filePath("take.wav") } }] },
      ctx,
    )) as ToolResult;
    expect(res.isError).toBe(true);
    expect(calls.find((c) => c.cmd === "show_media")).toBeFalsy();
  });
});

// The "verdict is read LIVE, after the awaits" half of the round-3 fix is
// exercised in panel-show-media-oversized.test.ts, which is the only route with
// a real await (resolveServableViewRef / staging) BEFORE the verdict. On the
// small-file route the handler is synchronous all the way to ctx.call, so a
// mid-flight rebind cannot be staged here — and ensureReachable itself runs
// INSIDE ctx.call, i.e. strictly after any check this handler can make. That is
// exactly why the reachability condition above, not the late placement, is what
// actually answers the reported false refusal.
