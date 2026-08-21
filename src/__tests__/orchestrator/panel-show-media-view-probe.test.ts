// #2011 — panel_show_media's /view probe asked "is the body media at all".
//
// The probe exists to predict a card that will render BROKEN, and the panel
// picks its painter from the ref's FILENAME, never from the body. So the test
// that matters is whether the served family MATCHES the family the name
// promises.
//
// Two live consequences on main, both through the {filename, type} source form
// (never extension-gated — the orchestrator forwards it unclassified):
//
//   take.wav serving audio/wav  — flagged as non-media (false alarm; the panel
//                                 paints an <audio> card fine)
//   take.wav serving image/png  — accepted (the panel paints an <audio> at
//                                 image bytes — a broken card — and the probe
//                                 says the reference looks fine)
//
// Widening the old image-or-video test to accept audio/* fixes the false alarm
// and creates a false CLEARANCE for plate.png serving audio/wav. That
// regression was caught by review on #2002; these tests pin it.
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

describe("#2011 an audio /view reference is not reported as a broken one", () => {
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

describe("#2011 the probe still catches a genuinely non-media body", () => {
  // The whole point of #941: a proxied ComfyUI answering HTML breaks the card
  // with no error anywhere. Changing the classification must not cost that, or
  // this note becomes decorative.
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

describe("#2011 the probe compares FAMILIES, because the panel paints by filename", () => {
  const cases: Array<[string, string, string]> = [
    // [filename, served content-type, why it is broken]
    ["plate.png", "audio/wav", "the #2002 review case — image name, audio body"],
    ["plate.png", "video/mp4", "image name, video body"],
    ["take_00001.wav", "image/png", "audio name, image body — the ORIGINAL code accepted this"],
    ["take_00001.wav", "video/mp4", "audio name, video body"],
    ["clip.mp4", "audio/wav", "video name, audio body"],
    ["clip.mp4", "image/png", "video name, image body"],
  ];

  it.each(cases)("%s served as %s is reported (%s)", async (filename, ct) => {
    state.contentType = ct;
    const { res } = await showMedia([{ source: { filename, type: "output" } }]);
    const text = textOf(res);
    expect(state.asked.length).toBe(1);
    expect(text).toContain("did NOT return media");
    expect(text).toContain(ct);
    // The note must say WHY, or the agent cannot act on it.
    expect(text).toMatch(/the panel picks its painter from the NAME/);
  });

  it.each([
    ["take_00001.wav", "audio/wav"],
    ["take_00001.flac", "audio/flac"],
    ["plate.png", "image/png"],
    ["clip.mp4", "video/mp4"],
  ])("%s served as %s still counts as media", async (filename, ct) => {
    state.contentType = ct;
    const { res } = await showMedia([{ source: { filename, type: "output" } }]);
    const text = textOf(res);
    expect(text).toContain("all 1 probed returned media");
    expect(text).not.toContain("did NOT return media");
  });

  it("a filename with no known extension accepts any media body — deliberately", async () => {
    // The panel gives an unclassifiable name a LINK card, which is not a broken
    // card. Flagging it would be a false alarm, and a diagnostic that cries wolf
    // gets ignored. Pinned so the fallback is a decision, not an oversight.
    state.contentType = "audio/wav";
    const { res } = await showMedia([{ source: { filename: "mystery", type: "output" } }]);
    expect(textOf(res)).toContain("all 1 probed returned media");
  });

  it("an exotic-but-real image extension is not accused", async () => {
    // .bmp is in the PANEL's image set but not the orchestrator's, so it takes
    // the accept-anything fallback rather than being wrongly flagged.
    state.contentType = "image/bmp";
    const { res } = await showMedia([{ source: { filename: "plate.bmp", type: "output" } }]);
    expect(textOf(res)).not.toContain("did NOT return media");
  });
});

// Closing a gap a mutation run on the spike exposed: turning the
// "is this a media body at all" check off SURVIVED, because every mismatch
// case also fails the family comparison. The one case that does not is a
// non-media body under a filename with no known extension — there is no
// family to compare, so the media check is the only thing standing between
// the agent and a silently-blessed HTML error page.
describe("#2011 the non-media check is load-bearing on its own", () => {
  it.each(["text/html", "application/json", ""])(
    "an unclassifiable filename serving %s is still reported",
    async (ct) => {
      state.contentType = ct;
      const { res } = await showMedia([{ source: { filename: "mystery", type: "output" } }]);
      const text = textOf(res);
      expect(text).toContain("did NOT return media");
      expect(text).toContain(ct || "unset");
    },
  );
});
