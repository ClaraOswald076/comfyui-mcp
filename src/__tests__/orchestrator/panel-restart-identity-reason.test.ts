// panel#1546 — WHEN panel_restart_comfyui REFUSES, IT MUST SAY WHY.
//
// The reporter's panel was attached, server-trusted-local and graph-tool ready,
// and the restart refused with "I could not confirm that this panel's ComfyUI is
// the local instance I can account for". Every precondition in the binding
// capture fails into that ONE sentence, so the reader cannot tell which proof was
// missing. Measured before the fix: a `localhost` browser origin, an absent
// handshake Origin, and a tab that never arrived on the loopback listener
// produced a BYTE-IDENTICAL note — yet the first is cured in one step (open the
// panel at the literal), the second by updating the panel, and the third not from
// this machine at all.
//
// These tests pin the DISCLOSURE. The gate is unchanged and is asserted
// unchanged: every refusal still refuses, still dispatches nothing, and still
// leaves the tab bound.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const resetClient = vi.fn();
const resetObjectInfoCache = vi.fn();
vi.mock("../../comfyui/client.js", () => ({
  getObjectInfo: vi.fn(),
  backfillObjectInfo: vi.fn(),
  resetClient: () => resetClient(),
  resetObjectInfoCache: () => resetObjectInfoCache(),
}));

const {
  buildPanelToolDefs,
  restartIdentityBlockerNote,
  classifyOriginBlocker,
  __panelToolsTestHooks,
} = await import("../../orchestrator/panel-tools.js");
import { getBootLocalComfyUIBaseUrl } from "../../config.js";
import { __processControlTestHooks } from "../../services/process-control.js";
import type { PanelToolCtx, ToolResult } from "../../orchestrator/panel-tools.js";

const BOOT_BASE = (getBootLocalComfyUIBaseUrl() ?? "http://127.0.0.1:8188").replace(/\/+$/, "");

const text = (res: ToolResult): string =>
  res.content.find((c) => c.type === "text")!.text as string;
const parse = (res: ToolResult): Record<string, unknown> => JSON.parse(text(res));

function makeCtx(opts: {
  /** SERVER-TRUSTED locality — the tab arrived on the token-less loopback listener. */
  isLocal?: boolean;
  /** The SERVER-OBSERVED handshake Origin (undefined = the handshake carried none). */
  serverOrigin?: string;
  /** The origin the tab reports AFTER the confirmation card is answered — a binding
   *  lost during the confirm wait. This is the ONLY way to reach the SECOND refusal
   *  site: the first gate runs before the card and would refuse there otherwise. */
  originAfterConfirm?: string;
}): {
  ctx: PanelToolCtx;
  sends: Array<Record<string, unknown>>;
  /** How many times the confirmation card was put to the user. Non-zero proves the
   *  FIRST identity gate (which runs before the card) let the call through. */
  confirms: { count: number };
} {
  const sends: Array<Record<string, unknown>> = [];
  const confirms = { count: 0 };
  const origin = { current: opts.serverOrigin };
  const bridge = {
    send: async (cmd: Record<string, unknown>) => {
      sends.push(cmd);
      if (cmd.cmd === "comfy_reboot") return { rebooting: true };
      return {};
    },
    tabOrigin: () => origin.current,
    tabServerOrigin: () => origin.current,
    tabIsLocal: () => opts.isLocal !== false,
    canReach: () => true,
  } as unknown as PanelToolCtx["bridge"];
  const ctx = {
    call: async () => {
      throw new Error("ctx.call must not be used by the restart handler");
    },
    confirm: async () => {
      confirms.count++;
      if (opts.originAfterConfirm !== undefined) origin.current = opts.originAfterConfirm;
      return "yes";
    },
    ensureReachable: () => {},
    bridge,
    tabId: "bound-tab",
    panelConnectionIdentity: () => ({ generation: 1, tabSessionId: "browser-tab-a" }),
    awaitPostRestartReachable: async () => true,
    tabCanMutateGraph: () => true,
  } as unknown as PanelToolCtx;
  return { ctx, sends, confirms };
}

function restartTool() {
  const def = buildPanelToolDefs().find((d) => d.name === "panel_restart_comfyui");
  if (!def) throw new Error("panel_restart_comfyui not found");
  return def;
}

/** Run the handler and return the refusal note, asserting the gate still held. */
async function refusalNote(opts: Parameters<typeof makeCtx>[0]): Promise<string> {
  const { ctx, sends } = makeCtx(opts);
  const res = await restartTool().handler({}, ctx);
  const body = parse(res);
  // THE GATE IS NOT WEAKENED — asserted on every scenario, not once.
  expect(body.refused).toBe(true);
  expect(body.rebooting).toBe(false);
  expect(sends.some((c) => c.cmd === "comfy_reboot")).toBe(false);
  return body.note as string;
}

beforeEach(() => {
  __panelToolsTestHooks.setPanelRebootTiming({
    settleMs: 0,
    budgetMs: 60,
    intervalMs: 5,
    probeTimeoutMs: 10,
  });
  __panelToolsTestHooks.setDeclineProbeTiming({ windowMs: 20, intervalMs: 5, probeTimeoutMs: 5 });
  __panelToolsTestHooks.setLocalRestartPreflight(async () => ({ ok: true }));
  __processControlTestHooks.reset();
});

afterEach(() => {
  __panelToolsTestHooks.setPanelRebootTiming(null);
  __panelToolsTestHooks.setHealthProbe(null);
  __panelToolsTestHooks.setLocalRestartPreflight(null);
  __panelToolsTestHooks.setDeclineProbeTiming(null);
  __processControlTestHooks.reset();
});

describe("panel#1546 — the identity refusal names the missing proof", () => {
  it("REPRO: the reported state — attached, local, ready, and refused", async () => {
    // The exact shape the issue was filed from: a browser at localhost:8188
    // against a 127.0.0.1:8188 boot base. Graph tools stay ready and the tab
    // stays bound, which is why the report reads as "refuses on an attached,
    // ready local panel".
    const { ctx, sends } = makeCtx({ serverOrigin: "http://localhost:8188" });
    const body = parse(await restartTool().handler({}, ctx));

    expect(body.refused).toBe(true);
    expect(body.rebooting).toBe(false);
    expect(body.graph_tools_ready).toBe(true);
    expect(body.panel_tab_reconnected).toBe(true);
    expect(sends.some((c) => c.cmd === "comfy_reboot")).toBe(false);
    expect(body.note).toMatch(/could not confirm that this panel's ComfyUI is/);
  });

  it("a `localhost` origin names the ambiguity AND the one-step fix", async () => {
    const note = await refusalNote({ serverOrigin: "http://localhost:8188" });

    expect(note).toMatch(/WHY I could not confirm it:/);
    expect(note).toMatch(/this panel is open at http:\/\/localhost:8188/);
    // It must say WHY localhost is not proof — not merely that it differs.
    expect(note).toMatch(/127\.0\.0\.1 or ::1/);
    // And the remedy must name the concrete literal to open the panel at.
    expect(note).toMatch(/FIX: open the panel at http:\/\/127\.0\.0\.1:8188/);
    // NOT the reverse remedy: this user's browser is the ambiguous side, so
    // telling them to repoint COMFYUI_URL at `localhost` would re-create it.
    expect(note).not.toMatch(/set COMFYUI_URL to http:\/\/localhost/);
  });

  it("an ABSENT handshake Origin gets its own reason and its own remedy", async () => {
    const note = await refusalNote({ serverOrigin: undefined });

    expect(note).toMatch(/carried no Origin/);
    expect(note).toMatch(/updating the panel/);
    // Must NOT borrow the localhost story — this tab never named an address.
    expect(note).not.toMatch(/127\.0\.0\.1 or ::1/);
    expect(note).not.toMatch(/FIX: open the panel at/);
  });

  it("a tab that is not loopback-local is told it cannot be fixed from here", async () => {
    const note = await refusalNote({ isLocal: false, serverOrigin: BOOT_BASE });

    expect(note).toMatch(/did not arrive on the local loopback listener/);
    expect(note).toMatch(/relay, tunnel, LAN address or pairing link/);
    expect(note).toMatch(/Restart it from the machine it actually runs on/);
    expect(note).not.toMatch(/FIX: open the panel at/);
  });

  it("a DIFFERENT host:port is named as a different server", async () => {
    const note = await refusalNote({ serverOrigin: "http://127.0.0.1:8189" });

    expect(note).toMatch(/http:\/\/127\.0\.0\.1:8189/);
    expect(note).toMatch(/a different server/);
    expect(note).not.toMatch(/127\.0\.0\.1 or ::1/);
  });

  // THE REGRESSION THIS ISSUE IS: three different failures, one message.
  it("the three ordinary local failures no longer read the same", async () => {
    const notes = [
      await refusalNote({ serverOrigin: "http://localhost:8188" }),
      await refusalNote({ serverOrigin: undefined }),
      await refusalNote({ isLocal: false, serverOrigin: BOOT_BASE }),
    ];
    expect(new Set(notes).size).toBe(3);
  });

  // THE SECOND REFUSAL SITE. #1593 shipped a fix that only reached the first one
  // and needed a follow-up commit to cover this branch; a mutation run confirmed
  // the same gap here — dropping the blocker at THIS call site left every test
  // green. Wiring is asserted at both sites, not at the helper.
  it("a binding lost during the confirm wait explains itself too", async () => {
    const { ctx, sends, confirms } = makeCtx({
      serverOrigin: BOOT_BASE, // proven before the card...
      originAfterConfirm: "http://localhost:8188", // ...gone by the preflight
    });
    const body = parse(await restartTool().handler({}, ctx));

    // The card WAS put to the user, so the pre-card identity gate passed and this
    // refusal is the LATER one. Without this the test would silently re-cover the
    // first site and the second would stay unpinned (the surviving mutation).
    expect(confirms.count).toBe(1);
    expect(body.refused).toBe(true);
    expect(sends.some((c) => c.cmd === "comfy_reboot")).toBe(false);
    expect(String(body.note)).toMatch(/WHY I could not confirm it:/);
    expect(String(body.note)).toMatch(/127\.0\.0\.1 or ::1/);
    expect(String(body.note)).toMatch(/FIX: open the panel at http:\/\/127\.0\.0\.1:8188/);
  });

  it("the second refusal distinguishes its causes as well as the first", async () => {
    const lost = async (after: string) => {
      const { ctx, confirms } = makeCtx({ serverOrigin: BOOT_BASE, originAfterConfirm: after });
      const note = String(parse(await restartTool().handler({}, ctx)).note);
      expect(confirms.count).toBe(1); // again: the SECOND site, not the first
      return note;
    };
    const ambiguous = await lost("http://localhost:8188");
    const different = await lost("http://127.0.0.1:8189");
    expect(ambiguous).not.toBe(different);
    expect(different).toMatch(/http:\/\/127\.0\.0\.1:8189/);
    expect(different).not.toMatch(/127\.0\.0\.1 or ::1/);
  });

  it("a PROVEN binding still dispatches — the refactor did not move the gate", async () => {
    const { ctx, sends } = makeCtx({ serverOrigin: BOOT_BASE });
    const body = parse(await restartTool().handler({}, ctx));

    expect(body.refused).toBeUndefined();
    expect(body.rebooting).toBe(true);
    expect(sends.some((c) => c.cmd === "comfy_reboot")).toBe(true);
    expect(String(body.note)).not.toMatch(/WHY I could not confirm it:/);
  });
});

// The two branches a handler-driven fixture cannot reach: they need a boot base
// this process was not started with. Pinned at the helper so the switch stays
// TOTAL — a new blocker kind that falls through would return "" and silently
// restore the undiagnosable refusal this issue is about.
// The DNS ambiguity must only be blamed for what it actually causes. These are
// pure-function tests because the boot base is fixed at process start, so the
// boot-side-ambiguous direction has no handler fixture at all.
describe("panel#1546 — `localhost` is blamed only when resolving it would settle it", () => {
  it("same port, no mount, panel side ambiguous → the DNS verdict, panel remedy", () => {
    const b = classifyOriginBlocker("http://localhost:8188", "http://127.0.0.1:8188");
    expect(b.kind).toBe("origin-dns-ambiguous");
    expect(b).toMatchObject({ ambiguousSide: "panel", concrete: "http://127.0.0.1:8188" });
    expect(restartIdentityBlockerNote(b)).toMatch(/FIX: open the panel at http:\/\/127\.0\.0\.1:8188/);
  });

  it("BOOT side ambiguous → the remedy is COMFYUI_URL, not 'open the panel at localhost'", () => {
    const b = classifyOriginBlocker("http://127.0.0.1:8188", "http://localhost:8188");
    expect(b.kind).toBe("origin-dns-ambiguous");
    expect(b).toMatchObject({ ambiguousSide: "boot", concrete: "http://127.0.0.1:8188" });
    const note = restartIdentityBlockerNote(b);
    expect(note).toMatch(/this server booted against http:\/\/localhost:8188/);
    expect(note).toMatch(/FIX: set COMFYUI_URL to http:\/\/127\.0\.0\.1:8188/);
    expect(note).not.toMatch(/FIX: open the panel at/);
  });

  it("a DIFFERENT PORT is a different server even when one side says localhost", () => {
    // Resolving the hostname never reconciles :8188 with :8189, so calling this
    // a DNS ambiguity would send the reader to fix the wrong thing.
    expect(classifyOriginBlocker("http://localhost:8189", "http://127.0.0.1:8188").kind).toBe(
      "origin-different",
    );
  });

  it("a basePath mount stays the PATH verdict — the pathless Origin cannot prove it", () => {
    expect(classifyOriginBlocker("http://localhost:8188", "http://127.0.0.1:8188/comfy").kind).toBe(
      "origin-different",
    );
    expect(classifyOriginBlocker("http://127.0.0.1:8188", "http://127.0.0.1:8188/comfy").kind).toBe(
      "origin-path-ambiguous",
    );
  });

  it("a DEFAULT port on one side only is still the same spot", () => {
    // normalizeHandshakeOrigin fills 80/443 in explicitly, so the Origin says
    // ":80" while a default-port boot base has port "". Comparing raw ports read
    // that as a port mismatch and misfiled it as a different server.
    const b = classifyOriginBlocker("http://localhost:80", "http://127.0.0.1");
    expect(b.kind).toBe("origin-dns-ambiguous");
    expect(b).toMatchObject({ ambiguousSide: "panel" });
  });

  it("localhost on BOTH sides is not this branch — those canonicalize equal", () => {
    expect(classifyOriginBlocker("http://localhost:8189", "http://localhost:8188").kind).toBe(
      "origin-different",
    );
  });
});

describe("panel#1546 — blocker branches with no handler-reachable fixture", () => {
  it("a basePath mount says the Origin cannot prove the mount", () => {
    const note = restartIdentityBlockerNote(
      classifyOriginBlocker("http://127.0.0.1:8188", "http://127.0.0.1:8188/comfy"),
    );
    expect(note).toMatch(/mounted under a path/);
    expect(note).toMatch(/http:\/\/127\.0\.0\.1:8188\/comfy/);
    expect(note).toMatch(/same host and port/);
  });

  it("an off-box configured ComfyUI says it is not a process on this machine", () => {
    const note = restartIdentityBlockerNote({
      kind: "boot-base-not-loopback",
      bootBase: "http://192.168.1.50:8188",
    });
    expect(note).toMatch(/not a loopback address/);
    expect(note).toMatch(/http:\/\/192\.168\.1\.50:8188/);
  });

  it("remote/cloud and no-boot-base each say something, and nothing says nothing", () => {
    for (const kind of ["not-local-mode", "no-boot-base"] as const) {
      expect(restartIdentityBlockerNote({ kind })).toMatch(/WHY I could not confirm it:/);
    }
    // Only a PROVEN binding contributes no reason — the note stays as it was.
    expect(restartIdentityBlockerNote(null)).toBe("");
  });
});
