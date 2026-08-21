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

// #1572 rounds 3 AND 5 — an UNREACHABLE target, and the correction to the
// correction.
//
// Round 3 established that a sticky-headless tab which is merely OFFLINE must
// not be refused, because `ensureReachable()` is about to rebind it onto a
// canvas tab where audio plays. That much is right, and the first test below
// keeps it.
//
// But round 3's REASON was wrong, and round 5 caught it: I wrote that when the
// heal cannot fire "the call surfaces the bridge's own tab-listing error, which
// is a better message than this refusal". It does not. `isMailboxable()` is
// exactly `cmd.cmd === "show_media"` — this one command, alone among all of
// them, is BUFFERED when `resolveTarget` throws and replayed on the next hello,
// answering `{ok:true, mailboxed:true}`. So an unroutable audio frame was being
// queued for the phone and delivered later as `shown:true`.
//
// The distinction that actually matters is therefore not reachable-vs-not, it
// is HEALABLE-vs-not:
//   - healable  → the heal runs, the session lands on a canvas tab, audio flows;
//   - not       → the frame is mailboxed under ctx.tabId, so a concrete id names
//                 its own recipient (refuse if that is a phone) and a scope
//                 address names nobody at all (refuse).
describe("#1572 an unreachable target is judged by where the frame would actually GO", () => {
  it.each(AUDIO)("a %s PATH is allowed once the heal lands on a canvas tab", async (ext) => {
    // awaitReachable stands in for ctx.call's own ensureReachable(): it rebinds
    // the orphaned session onto the sole live desktop tab. After that the
    // address resolves, and it resolves to something with a player.
    const calls: Forwarded[] = [];
    const ctx = {
      call: async (cmd: Forwarded) => {
        calls.push(cmd);
        return { content: [{ type: "text", text: "ok" }] } as ToolResult;
      },
      confirm: async () => "yes" as const,
      awaitReachable: async () => {
        ctx.tabId = "desktop-1";
        return true;
      },
      bridge: {
        isHeadless: (id: string) => id === "phone-1",
        canReach: (id: string) => id === "desktop-1",
        liveTabIdFor: (id: string) => (id === "desktop-1" ? "desktop-1" : undefined),
      } as unknown as PanelToolCtx["bridge"],
      tabId: "phone-1",
    } as PanelToolCtx;
    const def = buildPanelToolDefs().find((d) => d.name === "panel_show_media")!;
    const res = (await def.handler(
      { items: [{ source: { path: filePath(`take${ext}`) } }] },
      ctx,
    )) as ToolResult;
    expect(res.isError).toBeFalsy();
    const items = calls.find((c) => c.cmd === "show_media")!.items as Array<{ kind?: string }>;
    expect(items[0].kind).toBe("audio");
  });

  it("an offline phone that CANNOT be healed is refused — the frame would be mailboxed to it", async () => {
    // 2+ interactive tabs, a pinned session, or nothing bindable: ensureReachable
    // leaves ctx.tabId alone, resolveTarget throws, and show_media is buffered
    // under this very tab id. flushMailbox then hands it to that phone.
    const { res, calls } = await showMedia(
      [{ source: { path: filePath("take.wav") } }],
      true,
      false,
    );
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/HEADLESS client/);
    expect(calls.find((c) => c.cmd === "show_media")).toBeFalsy();
  });

  it("…and its /view ref form too", async () => {
    const { res, calls } = await showMedia(
      [{ source: { filename: "take_00001.wav", type: "output" } }],
      true,
      false,
    );
    expect(res.isError).toBe(true);
    expect(calls.find((c) => c.cmd === "show_media")).toBeFalsy();
  });

  it("a CONNECTED phone is still refused — the case the gate exists for", async () => {
    const { res } = await showMedia([{ source: { path: filePath("take.wav") } }], true, true);
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/HEADLESS client/);
  });

  it("an unreachable NON-headless tab still gets its audio — the mailbox names a real player", async () => {
    // The false-refusal guard on the other side: a desktop tab that is briefly
    // unroutable owns its own mailbox, so the buffered frame reaches a client
    // that can play it. Refusing here would be over-broad.
    const { res, calls } = await showMedia(
      [{ source: { path: filePath("take.wav") } }],
      false,
      false,
    );
    expect(res.isError).toBeFalsy();
    expect(calls.find((c) => c.cmd === "show_media")).toBeTruthy();
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

// #1572 round 4 — the gate's third P1, and the one that mattered most.
//
// `ctx.tabId` is not always a tab. #884 introduced SCOPE ADDRESSES
// (`orchestrator`, `orchestrator::<backend>`): an agent session spans every tab,
// so the address resolves to a routing target at DISPATCH time. `isHeadless()`
// on the address itself is a plain lookup miss — `conns.get("orchestrator::codex")`
// is undefined and `headlessSeen` never holds a scope address — so it answers
// FALSE. And `resolveTarget`'s scope branch ends, in its own words, "…else the
// most recent headless one".
//
// So a codex-backend session whose scope resolved onto a connected phone walked
// straight through a gate built entirely to stop it, and the phone acknowledged
// the audio as shown. The gate was asking about the ADDRESS instead of the
// DESTINATION.
//
// `liveTabIdFor` is `resolveTarget` with the throw swallowed, so it answers for
// scope addresses, prefixes and migration aliases alike — and returns undefined
// exactly when nothing resolves, which is the case that must NOT be refused.
describe("#1572 a SCOPE address is judged by what it RESOLVES to", () => {
  const scopeCtx = (opts: {
    resolvesTo: string | undefined;
    headlessTabs: string[];
  }): { ctx: PanelToolCtx; calls: Forwarded[] } => {
    const calls: Forwarded[] = [];
    const ctx = {
      call: async (cmd: Forwarded) => {
        calls.push(cmd);
        return { content: [{ type: "text", text: "ok" }] } as ToolResult;
      },
      confirm: async () => "yes" as const,
      bridge: {
        // The real bridge's isHeadless: a scope ADDRESS is never a key here.
        isHeadless: (id: string) => opts.headlessTabs.includes(id),
        canReach: () => true,
        liveTabIdFor: (id: string) => (id === "orchestrator::codex" ? opts.resolvesTo : id),
      } as unknown as PanelToolCtx["bridge"],
      tabId: "orchestrator::codex",
    } as PanelToolCtx;
    return { ctx, calls };
  };

  const run = async (ctx: PanelToolCtx, item: Record<string, unknown>) => {
    const def = buildPanelToolDefs().find((d) => d.name === "panel_show_media")!;
    return (await def.handler({ items: [item] }, ctx)) as ToolResult;
  };

  it("a scope resolving onto a CONNECTED PHONE is refused — the gate's exact case", async () => {
    const { ctx, calls } = scopeCtx({ resolvesTo: "phone-1", headlessTabs: ["phone-1"] });
    const res = await run(ctx, { source: { path: filePath("take.wav") } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/HEADLESS client/);
    expect(calls.find((c) => c.cmd === "show_media")).toBeFalsy();
  });

  it("…and its /view ref form too", async () => {
    const { ctx, calls } = scopeCtx({ resolvesTo: "phone-1", headlessTabs: ["phone-1"] });
    const res = await run(ctx, { source: { filename: "take_00001.wav", type: "output" } });
    expect(res.isError).toBe(true);
    expect(calls.find((c) => c.cmd === "show_media")).toBeFalsy();
  });

  it("a scope resolving onto a DESKTOP tab still gets its audio", async () => {
    const { ctx, calls } = scopeCtx({ resolvesTo: "desktop-1", headlessTabs: ["phone-1"] });
    const res = await run(ctx, { source: { path: filePath("take.wav") } });
    expect(res.isError).toBeFalsy();
    const items = calls.find((c) => c.cmd === "show_media")!.items as Array<{ kind?: string }>;
    expect(items[0].kind).toBe("audio");
  });

  // Round 5. This asserted the opposite until review showed the premise was
  // false: an unroutable scope address does not surface an error, it MAILBOXES —
  // and `flushMailbox` hands a scope-keyed box to "the first tab that hellos",
  // which may be the phone. Queuing a sound for a recipient nobody has
  // identified is the same unearned claim as sending it to one, only deferred.
  it("a scope that resolves to NOTHING is refused — the frame would be queued for an unknown client", async () => {
    const { ctx, calls } = scopeCtx({ resolvesTo: undefined, headlessTabs: ["phone-1"] });
    const res = await run(ctx, { source: { path: filePath("take.wav") } });
    expect(res.isError).toBe(true);
    expect(calls.find((c) => c.cmd === "show_media")).toBeFalsy();
    const text = textOf(res);
    // A DIFFERENT message from the phone refusal — saying "you are on a phone"
    // here would assert something nobody knows.
    expect(text).toMatch(/must not be QUEUED/);
    expect(text).toMatch(/whichever client connects next/);
    expect(text).not.toMatch(/this conversation is on a HEADLESS client/);
  });

  it("an unroutable scope still lets IMAGES through — only audio is held back", async () => {
    const { ctx, calls } = scopeCtx({ resolvesTo: undefined, headlessTabs: ["phone-1"] });
    const res = await run(ctx, { source: { path: filePath("plate.png") } });
    expect(res.isError).toBeFalsy();
    expect(calls.find((c) => c.cmd === "show_media")).toBeTruthy();
  });

  it("the ADDRESS itself is never what gets asked about", async () => {
    // The regression test for the finding: a bridge that would answer `true` for
    // the scope address and `false` for the resolved tab must still allow the
    // audio. If the gate ever goes back to reading ctx.tabId directly, this
    // fails.
    const calls: Forwarded[] = [];
    const ctx = {
      call: async (cmd: Forwarded) => {
        calls.push(cmd);
        return { content: [{ type: "text", text: "ok" }] } as ToolResult;
      },
      confirm: async () => "yes" as const,
      bridge: {
        isHeadless: (id: string) => id === "orchestrator::codex",
        canReach: () => true,
        liveTabIdFor: () => "desktop-1",
      } as unknown as PanelToolCtx["bridge"],
      tabId: "orchestrator::codex",
    } as PanelToolCtx;
    const def = buildPanelToolDefs().find((d) => d.name === "panel_show_media")!;
    const res = (await def.handler(
      { items: [{ source: { path: filePath("take.wav") } }] },
      ctx,
    )) as ToolResult;
    expect(res.isError).toBeFalsy();
    expect(calls.find((c) => c.cmd === "show_media")).toBeTruthy();
  });

  it("a concrete tab id is still resolved through the same path (prefix / migration alias)", async () => {
    // liveTabIdFor is resolveTarget: an 8-char prefix or a migration alias
    // resolves to the full live id. Judging the SHORT id directly would miss a
    // headless tab addressed by prefix.
    const calls: Forwarded[] = [];
    const ctx = {
      call: async (cmd: Forwarded) => {
        calls.push(cmd);
        return { content: [{ type: "text", text: "ok" }] } as ToolResult;
      },
      confirm: async () => "yes" as const,
      bridge: {
        isHeadless: (id: string) => id === "phone-1-full-id",
        canReach: () => true,
        liveTabIdFor: (id: string) => (id === "phone-1" ? "phone-1-full-id" : id),
      } as unknown as PanelToolCtx["bridge"],
      tabId: "phone-1",
    } as PanelToolCtx;
    const def = buildPanelToolDefs().find((d) => d.name === "panel_show_media")!;
    const res = (await def.handler(
      { items: [{ source: { path: filePath("take.wav") } }] },
      ctx,
    )) as ToolResult;
    expect(res.isError).toBe(true);
    expect(calls.find((c) => c.cmd === "show_media")).toBeFalsy();
  });
});
