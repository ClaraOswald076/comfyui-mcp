// #2012 — per-client decisions read ctx.tabId as if it were a destination.
//
// THE REPORTER'S CASE, restated as what the USER gets. panel_show_media's
// headless-inline branch asked `bridge.isHeadless(ctx.tabId)`. `ctx.tabId` may
// be a SCOPE ADDRESS (`orchestrator`, `orchestrator::<backend>` — #884). `conns`
// is keyed by tab id and `headlessSeen` never holds a scope address, so that
// lookup misses and returns false — while `resolveTarget`'s scope branch ends
// "…else the most recent headless one". A scope-bound session sitting on a
// phone was handed a ComfyUI /view URL the phone cannot fetch.
//
// PR #2002 hit the identical mistake twice, six rounds apart, at two different
// call sites. This is a defect CLASS: the next per-client decision cannot be
// allowed to re-derive `isHeadless(ctx.tabId)`.
//
// The correction is one helper — `resolveClientKind(ctx)` — that answers "what
// kind of client will this frame reach" via `liveTabIdFor` (scope / prefix /
// alias → the concrete tab). The remaining `isHeadless(ctx.tabId)` site, the
// show_media inline, is migrated onto it. Tests below drive the helper AND the
// handler: a helper-only suite survives deleting the one line that installs it.
//
// Every test names the mutation it exists to kill.

import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { PanelToolCtx, ToolResult } from "../../orchestrator/panel-tools.js";
import { SHARED_SESSION_SCOPE, sharedAgentKey } from "../../services/session-scope.js";

const fetchState = vi.hoisted(() => ({
  impl: null as
    | ((url: string, init?: { method?: string }) => Promise<{
        ok: boolean;
        status: number;
        headers: { get: (name: string) => string | null };
        arrayBuffer: () => Promise<ArrayBuffer>;
      }>)
    | null,
}));

vi.mock("../../comfyui/fetch.js", () => ({
  comfyuiFetch: (url: string, init?: { method?: string }) => {
    if (!fetchState.impl) {
      return Promise.reject(new Error("comfyuiFetch was not stubbed"));
    }
    return fetchState.impl(url, init);
  },
}));

const { buildPanelToolDefs, resolveClientKind } = await import(
  "../../orchestrator/panel-tools.js"
);

const SCOPE = sharedAgentKey("claude");
const PHONE = "phone-1";
const DESKTOP = "wf:workflows/a.json";
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

afterEach(() => {
  fetchState.impl = null;
});

function pngFetch(): typeof fetchState.impl {
  return async (_url, init) => {
    if (init?.method === "HEAD") {
      return {
        ok: true,
        status: 200,
        headers: { get: () => "image/png" },
        arrayBuffer: async () => new ArrayBuffer(0),
      };
    }
    const copy = Uint8Array.from(PNG_BYTES);
    return {
      ok: true,
      status: 200,
      headers: { get: () => "image/png" },
      arrayBuffer: async () => copy.buffer,
    };
  };
}

type Cmd = Record<string, unknown>;

function makeCtx(opts: {
  tabId: string;
  liveTabIdFor?: (id: string) => string | undefined;
  isHeadless?: (id: string) => boolean;
}): { ctx: PanelToolCtx; calls: Cmd[]; isHeadlessSeen: string[] } {
  const calls: Cmd[] = [];
  const isHeadlessSeen: string[] = [];
  const isHeadless = opts.isHeadless ?? (() => false);
  const ctx = {
    call: async (cmd: Cmd) => {
      calls.push(cmd);
      return { content: [{ type: "text", text: JSON.stringify(cmd) }] } as ToolResult;
    },
    confirm: async () => "yes" as const,
    tabId: opts.tabId,
    bridge: {
      ...(opts.liveTabIdFor ? { liveTabIdFor: opts.liveTabIdFor } : {}),
      isHeadless: (id: string) => {
        isHeadlessSeen.push(id);
        return isHeadless(id);
      },
    } as unknown as PanelToolCtx["bridge"],
  } as PanelToolCtx;
  return { ctx, calls, isHeadlessSeen };
}

async function showMedia(
  ctx: PanelToolCtx,
  items: Array<Record<string, unknown>> = [
    { source: { filename: "plate.png", type: "output" } },
  ],
): Promise<ToolResult> {
  const def = buildPanelToolDefs().find((d) => d.name === "panel_show_media");
  if (!def) throw new Error("panel_show_media not found");
  return (await def.handler({ items }, ctx)) as ToolResult;
}

function dispatchedItems(calls: Cmd[]): Array<Record<string, unknown>> {
  const sent = calls.find((c) => c.cmd === "show_media");
  if (!sent) throw new Error("show_media was not dispatched");
  return sent.items as Array<Record<string, unknown>>;
}

// -- the helper -------------------------------------------------------------

describe("#2012 resolveClientKind answers the DESTINATION, not the address", () => {
  it("a scope address that resolves to a phone is headless — the reported case", () => {
    // Kills: asking isHeadless(ctx.tabId). The address is not in conns.
    const seen: string[] = [];
    const kind = resolveClientKind({
      tabId: SCOPE,
      bridge: {
        liveTabIdFor: (id: string) => (id === SCOPE ? PHONE : undefined),
        isHeadless: (id: string) => {
          seen.push(id);
          return id === PHONE;
        },
      },
    } as unknown as PanelToolCtx);
    expect(kind).toEqual({ kind: "headless", tabId: PHONE });
    expect(seen).toEqual([PHONE]);
    expect(seen).not.toContain(SCOPE);
  });

  it("a scope address that resolves to a canvas tab is interactive", () => {
    const kind = resolveClientKind({
      tabId: SCOPE,
      bridge: {
        liveTabIdFor: (id: string) => (id === SCOPE ? DESKTOP : undefined),
        isHeadless: (id: string) => id === PHONE,
      },
    } as unknown as PanelToolCtx);
    expect(kind).toEqual({ kind: "interactive", tabId: DESKTOP });
  });

  it("the BARE scope (`orchestrator`) is a scope address too, not a tab id", () => {
    // Kills: only matching the qualified `orchestrator::<backend>` form.
    const kind = resolveClientKind({
      tabId: SHARED_SESSION_SCOPE,
      bridge: {
        liveTabIdFor: (id: string) => (id === SHARED_SESSION_SCOPE ? PHONE : undefined),
        isHeadless: (id: string) => id === PHONE,
      },
    } as unknown as PanelToolCtx);
    expect(kind).toEqual({ kind: "headless", tabId: PHONE });
  });

  it("an 8-char prefix is judged on the tab it expands to, not on the prefix", () => {
    // Kills: isHeadless("phone-01") against a conns key of the full id.
    const full = "phone-01-full-uuid";
    const kind = resolveClientKind({
      tabId: "phone-01",
      bridge: {
        liveTabIdFor: (id: string) => (id === "phone-01" ? full : undefined),
        isHeadless: (id: string) => id === full,
      },
    } as unknown as PanelToolCtx);
    expect(kind).toEqual({ kind: "headless", tabId: full });
  });

  it("a migration alias is judged on the live tab it compresses to", () => {
    const kind = resolveClientKind({
      tabId: "tmp:hop-a",
      bridge: {
        liveTabIdFor: (id: string) => (id === "tmp:hop-a" ? "wf:hop-c" : undefined),
        isHeadless: (id: string) => id === "wf:hop-c",
      },
    } as unknown as PanelToolCtx);
    expect(kind).toEqual({ kind: "headless", tabId: "wf:hop-c" });
  });

  it("an unroutable SCOPE address is its own kind — not 'not headless'", () => {
    // Kills: treating liveTabIdFor's undefined as false/interactive. show_media
    // is the one BUFFERED command (#2013); a scope names nobody, so the
    // recipient is unknowable.
    const kind = resolveClientKind({
      tabId: SCOPE,
      bridge: {
        liveTabIdFor: () => undefined,
        isHeadless: () => true,
      },
    } as unknown as PanelToolCtx);
    expect(kind).toEqual({ kind: "unroutable" });
  });

  it("an OFFLINE concrete phone is still headless — sticky isHeadless names the mailbox recipient", () => {
    // Kills: mapping every liveTabIdFor miss to unroutable. A concrete id that
    // is currently unreachable still names who the mailbox will flush to, and
    // sticky isHeadless exists so a render finishing during a disconnect is
    // byte-inlined for the phone that will pick it up.
    const kind = resolveClientKind({
      tabId: PHONE,
      bridge: {
        liveTabIdFor: () => undefined,
        isHeadless: (id: string) => id === PHONE,
      },
    } as unknown as PanelToolCtx);
    expect(kind).toEqual({ kind: "headless", tabId: PHONE });
  });

  it("reads ctx.tabId LIVE — a rebind is visible to the next call", () => {
    // Kills: capturing a boolean at the top of a handler. makePanelToolCtx
    // holds tabId live so ensureReachable can re-point the session in place.
    const ctx = {
      tabId: PHONE,
      bridge: {
        liveTabIdFor: (id: string) => id,
        isHeadless: (id: string) => id === PHONE,
      },
    } as unknown as PanelToolCtx;
    expect(resolveClientKind(ctx).kind).toBe("headless");
    ctx.tabId = DESKTOP;
    expect(resolveClientKind(ctx).kind).toBe("interactive");
  });

  it("a lightweight bridge with no liveTabIdFor still classifies a concrete tab", () => {
    // Existing handler tests omit liveTabIdFor. A concrete id is the destination
    // as-is; a scope address without a resolver is unroutable, never a tab.
    expect(
      resolveClientKind({
        tabId: PHONE,
        bridge: { isHeadless: (id: string) => id === PHONE },
      } as unknown as PanelToolCtx),
    ).toEqual({ kind: "headless", tabId: PHONE });
    expect(
      resolveClientKind({
        tabId: SCOPE,
        bridge: { isHeadless: () => true },
      } as unknown as PanelToolCtx),
    ).toEqual({ kind: "unroutable" });
  });

  it("missing isHeadless cannot prove headless — the destination is interactive", () => {
    // Positive requirement: only a proven headless destination is headless.
    expect(
      resolveClientKind({
        tabId: PHONE,
        bridge: { liveTabIdFor: (id: string) => id },
      } as unknown as PanelToolCtx),
    ).toEqual({ kind: "interactive", tabId: PHONE });
  });
});

// -- the CALL SITE, not just the helper -------------------------------------

describe("#2012 panel_show_media inlines for the tab the frame will actually reach", () => {
  it("a scope-bound session sitting on a phone GETS the bytes — the reported case", async () => {
    // Kills: reverting the inline predicate to isHeadless(ctx.tabId). That
    // lookup misses on the scope address, answers false, and the phone is
    // handed a /view URL it cannot fetch.
    fetchState.impl = pngFetch();
    const { ctx, calls, isHeadlessSeen } = makeCtx({
      tabId: SCOPE,
      liveTabIdFor: (id) => (id === SCOPE ? PHONE : undefined),
      isHeadless: (id) => id === PHONE,
    });
    await showMedia(ctx);
    const items = dispatchedItems(calls);
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe("image");
    expect(String(items[0].dataUrl)).toMatch(/^data:image\/png;base64,/);
    expect(items[0].viewRef).toBeUndefined();
    expect(isHeadlessSeen).toContain(PHONE);
    expect(isHeadlessSeen).not.toContain(SCOPE);
  });

  it("the same scope sitting on a canvas tab is NOT inlined — the panel fetches same-origin", async () => {
    fetchState.impl = pngFetch();
    const { ctx, calls } = makeCtx({
      tabId: SCOPE,
      liveTabIdFor: (id) => (id === SCOPE ? DESKTOP : undefined),
      isHeadless: (id) => id === PHONE,
    });
    await showMedia(ctx);
    const items = dispatchedItems(calls);
    expect(items[0].kind).toBe("viewRef");
    expect(items[0].dataUrl).toBeUndefined();
  });

  it("an unroutable SCOPE is not treated as headless — unknown is not a proven phone", async () => {
    // Kills: `kind !== "interactive"` (the negative form). Unroutable would
    // then look like a phone and we'd fetch+inline for nobody.
    fetchState.impl = pngFetch();
    const { ctx, calls } = makeCtx({
      tabId: SCOPE,
      liveTabIdFor: () => undefined,
      isHeadless: () => true,
    });
    await showMedia(ctx);
    expect(dispatchedItems(calls)[0].kind).toBe("viewRef");
  });

  it("an offline concrete phone is still inlined — the mailbox recipient is that phone", async () => {
    fetchState.impl = pngFetch();
    const { ctx, calls } = makeCtx({
      tabId: PHONE,
      liveTabIdFor: () => undefined,
      isHeadless: (id) => id === PHONE,
    });
    await showMedia(ctx);
    expect(dispatchedItems(calls)[0].kind).toBe("image");
    expect(String(dispatchedItems(calls)[0].dataUrl)).toMatch(/^data:image\/png;base64,/);
  });

  it("a prefix that expands to a phone is inlined", async () => {
    fetchState.impl = pngFetch();
    const full = "phone-01-full-uuid";
    const { ctx, calls } = makeCtx({
      tabId: "phone-01",
      liveTabIdFor: (id) => (id === "phone-01" ? full : undefined),
      isHeadless: (id) => id === full,
    });
    await showMedia(ctx);
    expect(dispatchedItems(calls)[0].kind).toBe("image");
  });

  it("the destination is re-read PER item — a capture at the top of the handler would freeze the first answer", async () => {
    // Kills: `const dest = resolveClientKind(ctx)` once before the loop. The
    // gate found a timing variant of the same bug: the check ran before an
    // await and was never revalidated. Two /view refs, destination moves
    // after the first: item 2 must see the new tab, not the captured one.
    fetchState.impl = pngFetch();
    let n = 0;
    const { ctx, calls } = makeCtx({
      tabId: SCOPE,
      liveTabIdFor: () => {
        n += 1;
        return n === 1 ? PHONE : DESKTOP;
      },
      isHeadless: (id) => id === PHONE,
    });
    await showMedia(ctx, [
      { source: { filename: "one.png", type: "output" } },
      { source: { filename: "two.png", type: "output" } },
    ]);
    const items = dispatchedItems(calls);
    expect(items).toHaveLength(2);
    expect(items[0].kind).toBe("image");
    expect(items[1].kind).toBe("viewRef");
  });
});

describe("#2012 the helper is what the call site uses — not a copy", () => {
  it("panel_show_media no longer reads isHeadless(ctx.tabId)", () => {
    // Kills: putting the old lookup back next to the helper, or inlining the
    // helper's body at the call site and then drifting.
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../../orchestrator/panel-tools.ts"),
      "utf8",
    );
    expect(src).not.toMatch(/isHeadless\(\s*ctx\.tabId\s*\)/);
    expect(src).toMatch(/resolveClientKind\(ctx\)\.kind === "headless"/);
  });
});
