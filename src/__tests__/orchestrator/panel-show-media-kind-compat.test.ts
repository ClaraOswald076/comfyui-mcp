// #2017 — panel_show_media sends a kind a stale panel cannot paint.
//
// A pre-#710 panel has no audio branch: everything that is not video is painted
// with `<img>`. The orchestrator and the panel ship separately, so an updated
// comfyui-mcp talking to a stale comfyui-mcp-panel is the normal state right
// after an npm update. Sending `kind:"audio"` (or a /view ref the panel will
// classify as audio) becomes a broken-image card, and the panel reports it as
// painted.
//
// The current origin/main path that already reaches the panel is the /view-ref
// branch — `{ filename: "voice.wav" }` is never extension-gated, so this needs
// none of PR #2002. A pre-#710 panel paints that ref as `<img>` too.
//
// The gate is a PROVEN-unable check, not a destination guess:
//   - hello `show_media_kinds` is the authority when present
//   - otherwise a parseable advertised version below the #710 floor (0.11.43)
//   - missing / inherited / unparseable version FAIL-OPEN (same tri-state as
//     the #392 command gate) so a current panel that omitted the field is
//     never told to update
// Image and video skip the check. Nothing is refused on a current panel.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { buildPanelToolDefs, type PanelToolCtx, type ToolResult } from "../../orchestrator/panel-tools.js";
import {
  SHOW_MEDIA_KIND_MIN_PANEL_VERSION,
  paintedShowMediaKind,
  panelSupportsShowMediaKind,
  readHelloShowMediaKinds,
  showMediaItemsPanelCannotPaint,
  type PanelVersionReading,
} from "../../services/ui-bridge.js";

type Forwarded = Record<string, unknown>;

function makeCtx(opts: {
  version?: PanelVersionReading;
  kinds?: readonly string[];
} = {}): { ctx: PanelToolCtx; calls: Forwarded[] } {
  const calls: Forwarded[] = [];
  const ctx = {
    call: async (cmd: Forwarded) => {
      calls.push(cmd);
      return { content: [{ type: "text", text: JSON.stringify(cmd) }] } as ToolResult;
    },
    confirm: async () => "yes" as const,
    bridge: {
      isHeadless: () => false,
      advertisedPanelVersion: () => opts.version ?? {},
      tabShowMediaKinds: () => opts.kinds,
    } as unknown as PanelToolCtx["bridge"],
    tabId: "test-tab",
  } as PanelToolCtx;
  return { ctx, calls };
}

async function showMedia(
  items: Array<Record<string, unknown>>,
  opts: { version?: PanelVersionReading; kinds?: readonly string[] } = {},
): Promise<{ res: ToolResult; calls: Forwarded[] }> {
  const def = buildPanelToolDefs().find((d) => d.name === "panel_show_media");
  if (!def) throw new Error("panel_show_media not found");
  const { ctx, calls } = makeCtx(opts);
  const res = (await def.handler({ items }, ctx)) as ToolResult;
  return { res, calls };
}

const textOf = (res: ToolResult): string => res.content.map((c) => ("text" in c ? c.text : "")).join("\n");

const OLD = { raw: "0.11.41", version: "0.11.41" } satisfies PanelVersionReading;
const FLOOR = { raw: "0.11.43", version: "0.11.43" } satisfies PanelVersionReading;
const CURRENT = { raw: "0.15.11", version: "0.15.11" } satisfies PanelVersionReading;
const WAV = [{ source: { filename: "voice.wav", type: "output" } }];
const PNG = [{ source: { filename: "plate.png", type: "output" } }];
const MP4 = [{ source: { filename: "clip.mp4", type: "output" } }];

describe("#2017 the floor is the first release that actually paints audio", () => {
  it("audio shipped in panel 0.11.43 — after the 0.11.42 release, with #710", () => {
    // Verified against the panel repo: #710 merged after the 0.11.42 release
    // commit (b81b10dd) and first shipped in 0.11.43 (a1ac583f). A 0.11.42
    // floor would allow the published 0.11.42 build, which has no audio painter.
    expect(SHOW_MEDIA_KIND_MIN_PANEL_VERSION.audio).toBe("0.11.43");
    expect(SHOW_MEDIA_KIND_MIN_PANEL_VERSION.image).toBeUndefined();
    expect(SHOW_MEDIA_KIND_MIN_PANEL_VERSION.video).toBeUndefined();
  });
});

describe("#2017 panel_show_media refuses audio on a proven-old panel", () => {
  it("the reporter case — a .wav /view ref is NOT dispatched to panel 0.11.41", async () => {
    // Kills: deleting the showMediaItemsPanelCannotPaint(...) call site.
    const { res, calls } = await showMedia(WAV, { version: OLD });
    expect(res.isError).toBe(true);
    expect(calls.find((c) => c.cmd === "show_media")).toBeUndefined();
    const text = textOf(res);
    expect(text).toMatch(/cannot paint "audio"/);
    expect(text).toContain("0.11.41");
    expect(text).toContain("0.11.43");
    expect(text).toContain("voice.wav");
    expect(text).toMatch(/HARD-REFRESH/);
    expect(text).toMatch(/broken-image/);
  });

  it("names the upgrade, not just the age", async () => {
    const text = textOf((await showMedia(WAV, { version: OLD })).res);
    expect(text).toMatch(/install_comfyui\(action:'panel', panel_action:'update'\)|update the ComfyUI-MCP panel via ComfyUI Manager/);
    expect(text).toMatch(/≥0\.11\.43/);
  });

  it("at the #710 floor the same .wav IS dispatched", async () => {
    const { res, calls } = await showMedia(WAV, { version: FLOOR });
    expect(res.isError).toBeFalsy();
    expect(calls.find((c) => c.cmd === "show_media")).toBeTruthy();
    expect(textOf(res)).not.toMatch(/cannot paint/);
  });

  it("a current panel is not gated", async () => {
    const { res, calls } = await showMedia(WAV, { version: CURRENT });
    expect(res.isError).toBeFalsy();
    expect(calls.find((c) => c.cmd === "show_media")).toBeTruthy();
  });
});

describe("#2017 image and video stay on the hot path — even on an old panel", () => {
  it("an image /view ref is dispatched to 0.11.41", async () => {
    const { res, calls } = await showMedia(PNG, { version: OLD });
    expect(res.isError).toBeFalsy();
    expect(calls.find((c) => c.cmd === "show_media")).toBeTruthy();
  });

  it("a video /view ref is dispatched to 0.11.41", async () => {
    const { res, calls } = await showMedia(MP4, { version: OLD });
    expect(res.isError).toBeFalsy();
    expect(calls.find((c) => c.cmd === "show_media")).toBeTruthy();
  });
});

describe("#2017 unproven age is not a refusal — fail open", () => {
  it("no advertised version still dispatches the .wav (the #2010 path)", async () => {
    // Kills: treating a missing version as too old. #2010's handler tests mock
    // no advertisedPanelVersion at all; this gate must not start refusing them.
    const { res, calls } = await showMedia(WAV, { version: {} });
    expect(res.isError).toBeFalsy();
    expect(calls.find((c) => c.cmd === "show_media")).toBeTruthy();
  });

  it("an INHERITED version is not treated as this tab's age", async () => {
    const { res, calls } = await showMedia(WAV, {
      version: { inherited: "0.11.41" },
    });
    expect(res.isError).toBeFalsy();
    expect(calls.find((c) => c.cmd === "show_media")).toBeTruthy();
  });

  it("an unparseable advertised version (nightly) is not called too old", async () => {
    const { res, calls } = await showMedia(WAV, { version: { raw: "nightly" } });
    expect(res.isError).toBeFalsy();
    expect(calls.find((c) => c.cmd === "show_media")).toBeTruthy();
  });
});

describe("#2017 a hello capability list is the authority", () => {
  it("a current panel that did NOT list audio still refuses the .wav", async () => {
    // Kills: ignoring show_media_kinds and trusting version alone. A capability
    // list does not need a version table — that is the point of advertising one.
    const { res, calls } = await showMedia(WAV, {
      version: CURRENT,
      kinds: ["image", "video"],
    });
    expect(res.isError).toBe(true);
    expect(calls.find((c) => c.cmd === "show_media")).toBeUndefined();
    expect(textOf(res)).toMatch(/advertised the kinds it can paint/);
    expect(textOf(res)).toContain("voice.wav");
  });

  it("an old panel that DID list audio is allowed — the hello outranks the floor", async () => {
    const { res, calls } = await showMedia(WAV, {
      version: OLD,
      kinds: ["image", "video", "audio"],
    });
    expect(res.isError).toBeFalsy();
    expect(calls.find((c) => c.cmd === "show_media")).toBeTruthy();
  });
});

describe("#2017 a mixed batch is refused as a whole — nothing is dispatched", () => {
  it("png + wav on 0.11.41 sends neither", async () => {
    const { res, calls } = await showMedia(
      [
        { source: { filename: "plate.png", type: "output" } },
        { source: { filename: "voice.wav", type: "output" } },
      ],
      { version: OLD },
    );
    expect(res.isError).toBe(true);
    expect(calls.find((c) => c.cmd === "show_media")).toBeUndefined();
    expect(textOf(res)).toContain("voice.wav");
    expect(textOf(res)).not.toMatch(/plate\.png \(audio\)/);
  });
});

// -- decision function: cases the handler cannot yet produce on origin/main --
// Explicit `kind:"audio"` is PR #2002's allowlist. The gate has to be ready for
// it without stealing that issue; these drive the same function the handler
// calls, with the item shape the allowlist will dispatch.
describe("#2017 explicit kind:\"audio\" is refused on a proven-old panel", () => {
  const AUDIO_ITEM = {
    kind: "audio",
    dataUrl: "data:audio/wav;base64,AA==",
    filename: "voice.wav",
  };

  it("paintedShowMediaKind trusts the orchestrator's own kind first", () => {
    expect(paintedShowMediaKind(AUDIO_ITEM)).toBe("audio");
    expect(paintedShowMediaKind({ kind: "viewRef", viewRef: { filename: "voice.wav" } })).toBe(
      "audio",
    );
    expect(paintedShowMediaKind({ kind: "image", filename: "x.wav" })).toBe("image");
  });

  it("panelSupportsShowMediaKind refuses audio below 0.11.43 and allows at/above", () => {
    expect(panelSupportsShowMediaKind("audio", { reading: OLD }).supported).toBe(false);
    expect(panelSupportsShowMediaKind("audio", { reading: FLOOR }).supported).toBe(true);
    expect(panelSupportsShowMediaKind("image", { reading: OLD }).supported).toBe(true);
    expect(panelSupportsShowMediaKind("video", { reading: OLD }).supported).toBe(true);
  });

  it("showMediaItemsPanelCannotPaint names the audio item and no other", () => {
    const blocked = showMediaItemsPanelCannotPaint(
      [AUDIO_ITEM, { kind: "image", filename: "plate.png" }],
      { reading: OLD },
    );
    expect(blocked).toEqual([
      expect.objectContaining({ filename: "voice.wav", kind: "audio", reason: "too_old", needed: "0.11.43" }),
    ]);
  });
});

describe("#2017 readHelloShowMediaKinds screens garbage as omitted", () => {
  it("a well-formed list is kept, order-preserving and de-duplicated", () => {
    expect(readHelloShowMediaKinds(["image", "video", "audio", "image"])).toEqual([
      "image",
      "video",
      "audio",
    ]);
  });

  it.each([
    ["absent", undefined],
    ["not an array", "audio"],
    ["empty", []],
    ["a blank entry", ["image", "  "]],
    ["a non-string entry", ["image", 1]],
  ])("%s is undefined — fall back to the version floor", (_label, raw) => {
    expect(readHelloShowMediaKinds(raw)).toBeUndefined();
  });
});

describe("#2017 the hello handler INSTALLS the capability list", () => {
  it("wires showMediaKinds from readHelloShowMediaKinds, never inherits", () => {
    // Kills: deleting the Conn field assignment. A helper-level suite survives
    // that one-line wiring mutation; this does not.
    const src = readFileSync(new URL("../../services/ui-bridge.ts", import.meta.url), "utf8");
    expect(src).toMatch(/showMediaKinds:\s*readHelloShowMediaKinds\s*\(/);
    expect(src).toMatch(/show_media_kinds/);
    expect(src).toMatch(/tabShowMediaKinds\s*\(/);
  });
});
