// #1572, second half — the /view REFERENCE path.
//
// Opening the extension gate (panel-show-media-audio-ext.test.ts) fixes the
// reported refusal, which is the `{path}` source form. The other source form is
// a ComfyUI ref `{filename, subfolder?, type?}`, and that one was never refused
// at all: the orchestrator forwards it unclassified and the PANEL decides by
// filename, so `SaveAudio` output already reached paintAudio (#710).
//
// What was wrong on that path was the #941 diagnostic probe. It HEADs /view and
// reports anything whose content-type is not image/* or video/* as "did NOT
// return media" — so an `audio/wav` body was named in a note as evidence of a
// broken reference, about a file the user could already hear. The count was
// right and the verdict was invented.
//
// This is deliberately tested through the TOOL and not through
// unverifiedViewRefNote: the note is handed a ViewRefProbe that is already
// decided, so a note-level test cannot see the classification at all. The
// decision lives in panel_show_media's probe loop, and only the call site
// proves it.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  /** content-type the mocked /view HEAD answers with. */
  contentType: "audio/wav",
  ok: true,
  status: 200,
  /** every URL the probe asked for. */
  asked: [] as string[],
}));

vi.mock("../../comfyui/fetch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../comfyui/fetch.js")>();
  return {
    ...actual,
    comfyuiFetch: async (url: string) => {
      state.asked.push(String(url));
      return {
        ok: state.ok,
        status: state.status,
        headers: { get: (h: string) => (h.toLowerCase() === "content-type" ? state.contentType : null) },
      } as unknown as Response;
    },
  };
});

const { buildPanelToolDefs } = await import("../../orchestrator/panel-tools.js");
type PanelToolCtx = import("../../orchestrator/panel-tools.js").PanelToolCtx;
type ToolResult = import("../../orchestrator/panel-tools.js").ToolResult;

type Forwarded = Record<string, unknown>;

function makeCtx(): { ctx: PanelToolCtx; calls: Forwarded[] } {
  const calls: Forwarded[] = [];
  const ctx = {
    call: async (cmd: Forwarded) => {
      calls.push(cmd);
      return { content: [{ type: "text", text: JSON.stringify(cmd) }] } as ToolResult;
    },
    confirm: async () => "yes" as const,
    // NOT headless — a browser panel is the path that forwards refs unresolved
    // and therefore the path the probe runs on.
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

beforeEach(() => {
  state.contentType = "audio/wav";
  state.ok = true;
  state.status = 200;
  state.asked = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("#1572 an audio /view reference is not reported as a broken one", () => {
  it.each(["audio/wav", "audio/mpeg", "audio/flac", "audio/ogg", "audio/mp4", "audio/aac"])(
    "%s counts as media",
    async (ct) => {
      state.contentType = ct;
      const { res } = await showMedia([{ source: { filename: "take_00001.wav", type: "output" } }]);
      const text = textOf(res);
      // The probe ran (so this is not passing because nothing was checked)…
      expect(state.asked.length).toBe(1);
      expect(text).toContain("all 1 probed returned media");
      // …and did not accuse the reference of being non-media.
      expect(text).not.toContain("did NOT return media");
      expect(text).not.toContain(ct);
    },
  );

  it("the item is still forwarded to the panel as a viewRef for it to classify", async () => {
    const { calls } = await showMedia([{ source: { filename: "take_00001.wav", type: "output" } }]);
    const items = calls.find((c) => c.cmd === "show_media")!.items as Array<Record<string, unknown>>;
    expect(items[0].kind).toBe("viewRef");
    expect((items[0].viewRef as { filename: string }).filename).toBe("take_00001.wav");
  });
});

describe("#1572 the probe still catches a genuinely non-media body", () => {
  // The whole point of #941: a proxied ComfyUI answering HTML breaks the card
  // with no error anywhere. Widening the classification to audio must not cost
  // that, or this note becomes decorative.
  it.each(["text/html", "application/json", "text/plain"])("%s is still reported", async (ct) => {
    state.contentType = ct;
    const { res } = await showMedia([{ source: { filename: "take_00001.wav", type: "output" } }]);
    const text = textOf(res);
    expect(text).toContain("did NOT return media");
    expect(text).toContain(ct);
  });

  it("an HTTP error is still reported regardless of content-type", async () => {
    state.ok = false;
    state.status = 404;
    state.contentType = "audio/wav";
    const { res } = await showMedia([{ source: { filename: "gone.wav", type: "output" } }]);
    expect(textOf(res)).toContain("HTTP 404");
  });
});
