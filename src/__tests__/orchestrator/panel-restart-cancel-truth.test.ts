// #742: panel_restart_comfyui must NEVER report "Cancelled — ComfyUI was not
// restarted" while the server is actually DOWN (a stop already happened — e.g. a
// reboot accepted moments earlier in the same turn stopped ComfyUI, the panel tab
// died with it, and the confirm card then failed into a catch-all "no"). And on a
// Pinokio-style install (externally supervised; no main.py/interpreter resolvable
// from here, so NO provable relaunch) the restart must be REFUSED before anything
// is stopped — a plain Manager restart kills the process and the supervisor does
// not re-launch it, which is exactly the #742 lost-server.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const resetClient = vi.fn();
const resetObjectInfoCache = vi.fn();
vi.mock("../../comfyui/client.js", () => ({
  getObjectInfo: vi.fn(),
  backfillObjectInfo: vi.fn(),
  resetClient: () => resetClient(),
  resetObjectInfoCache: () => resetObjectInfoCache(),
}));

// r9/r10/r11: a MUTABLE runtime-config base AND target generation, so tests
// can retarget getComfyUIBaseUrl() mid-flight (config-only retarget) while the
// tab fronting stays put. null → the real configured base; the generation is
// bumped by tests the way every real retarget bumps it.
const hoistedConfig = vi.hoisted(() => ({
  configBase: { value: null as string | null },
  generation: { value: 0 },
}));
vi.mock("../../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config.js")>();
  return {
    ...actual,
    getComfyUIBaseUrl: () => hoistedConfig.configBase.value ?? actual.getComfyUIBaseUrl(),
    getComfyuiTargetGeneration: () => hoistedConfig.generation.value,
  };
});

const { buildPanelToolDefs, __panelToolsTestHooks } = await import(
  "../../orchestrator/panel-tools.js"
);
import { getBootLocalComfyUIBaseUrl } from "../../config.js";
import {
  __processControlTestHooks,
  getRestartDispatchRecord,
  PROCESS_WIDE_RESTART_DISPATCH_TOKEN,
} from "../../services/process-control.js";
import type { PanelToolCtx, ToolResult } from "../../orchestrator/panel-tools.js";

// The orchestrator's immutable boot endpoint — what the decline-probe and the
// refuse-safe preflight bind to when the tab provably fronts our boot instance.
const BOOT_BASE = (getBootLocalComfyUIBaseUrl() ?? "http://127.0.0.1:8188").replace(/\/+$/, "");

const text = (res: ToolResult): string =>
  res.content.find((c) => c.type === "text")!.text as string;
const parse = (res: ToolResult): Record<string, unknown> => JSON.parse(text(res));

function makeCtx(opts: {
  confirm: "yes" | "no";
  /** Whether the bound tab provably fronts our local boot instance (the gate
   *  for both the boot-endpoint probe and the #742 preflight). */
  frontsBoot?: boolean;
  /** MUTABLE fronting — models a session that REBINDS mid-test: the bridge
   *  getters read `fronts.current` at call time. Overrides frontsBoot. */
  fronts?: { current: boolean };
  /** The comfy_reboot reply (default: an accepted `{rebooting: true}`). */
  rebootReply?: Record<string, unknown>;
}): { ctx: PanelToolCtx; sends: Array<Record<string, unknown>> } {
  const sends: Array<Record<string, unknown>> = [];
  const frontsBoot = opts.frontsBoot ?? true;
  const rebootReply = opts.rebootReply ?? { rebooting: true };
  const fronted = () => opts.fronts?.current ?? frontsBoot;
  const bridge = {
    send: async (cmd: Record<string, unknown>) => {
      sends.push(cmd);
      if (cmd.cmd === "comfy_reboot") return rebootReply;
      return {};
    },
    tabOrigin: () => (fronted() ? BOOT_BASE : undefined),
    // The gate reads the SERVER-OBSERVED handshake origin, not the spoofable hello URL.
    tabServerOrigin: () => (fronted() ? BOOT_BASE : undefined),
    tabIsLocal: () => fronted(),
    canReach: () => true,
  } as unknown as PanelToolCtx["bridge"];
  const ctx = {
    call: async () => {
      throw new Error("ctx.call must not be used by the restart handler");
    },
    confirm: async () => opts.confirm,
    ensureReachable: () => {},
    bridge,
    tabId: "bound-tab",
    panelConnectionIdentity: () => ({ generation: 1, tabSessionId: "browser-tab-a" }),
    awaitPostRestartReachable: async () => true,
    tabCanMutateGraph: () => true,
  } as unknown as PanelToolCtx;
  return { ctx, sends };
}

function restartTool() {
  const def = buildPanelToolDefs().find((d) => d.name === "panel_restart_comfyui");
  if (!def) throw new Error("panel_restart_comfyui not found");
  return def;
}

beforeEach(() => {
  resetClient.mockClear();
  resetObjectInfoCache.mockClear();
  __panelToolsTestHooks.setPanelRebootTiming({
    settleMs: 0,
    budgetMs: 60,
    intervalMs: 5,
    probeTimeoutMs: 10,
  });
  // Fast decline-probe recheck window (the real one is ~6s). Wide enough that
  // real-timer slop can't eat it before a scripted mid-window sample lands.
  __panelToolsTestHooks.setDeclineProbeTiming({
    windowMs: 100,
    intervalMs: 5,
    probeTimeoutMs: 5,
  });
  // Default: the local relaunch preflight PASSES (the live preflightLocalRestart
  // would probe real processes/ports). The refusal tests override it.
  __panelToolsTestHooks.setLocalRestartPreflight(async () => ({ ok: true }));
  // r4/r5: no restart dispatch on record unless a test seeds one (also clears
  // any record a prior test left behind).
  __processControlTestHooks.reset();
  // r9: real configured base unless a test retargets it mid-flight.
  hoistedConfig.configBase.value = null;
  hoistedConfig.generation.value = 0;
});

afterEach(() => {
  __panelToolsTestHooks.setPanelRebootTiming(null);
  __panelToolsTestHooks.setHealthProbe(null);
  __panelToolsTestHooks.setLocalRestartPreflight(null);
  __panelToolsTestHooks.setDeclineProbeTiming(null);
  __processControlTestHooks.reset();
  hoistedConfig.configBase.value = null;
  hoistedConfig.generation.value = 0;
});

describe("panel_restart_comfyui — decline truthfulness (#742)", () => {
  it("a decline while the server is PERSISTENTLY down reports the lost server — never 'Cancelled'", async () => {
    // The confirm resolved "no" (a decline, OR the card failed into the catch-all
    // "no" because the tab died with the server). The endpoint stays refused for
    // the WHOLE recheck window — only then may the report call it lost (a single
    // ECONNREFUSED is just a normal restart down-window, codex gate). A restart
    // dispatch IS on record (r4), so the report names the causation.
    let probes = 0;
    __panelToolsTestHooks.setHealthProbe(async () => {
      probes++;
      return "down";
    });
    const { ctx, sends } = makeCtx({ confirm: "no" });
    // r4/r5: a restart dispatch IS on record HELD BY THIS SESSION, so the
    // report names the causation.
    __panelToolsTestHooks.seedSessionRestartDispatch(ctx, { at: Date.now(), base: BOOT_BASE });

    const res = await restartTool().handler({}, ctx);
    const t = text(res);

    expect(res.isError).toBeFalsy();
    expect(t).not.toMatch(/^Cancelled/);
    expect(t).not.toMatch(/was not restarted/i);
    expect(t).toMatch(/ComfyUI is DOWN/i);
    expect(t).toMatch(/STOPPED and did not come back/i);
    expect(t).toMatch(/recheck window/i);
    expect(t).toMatch(/start ComfyUI manually/i);
    expect(t).toMatch(/Pinokio/i);
    // NOT a single-probe verdict: the window rechecked before declaring loss.
    expect(probes).toBeGreaterThan(1);
    // Nothing was dispatched after the decline — the report is about PRIOR state.
    expect(sends.some((c) => c.cmd === "comfy_reboot")).toBe(false);
  });

  it("bound full-window DOWN with NO recorded dispatch makes NO causation claim (r4)", async () => {
    // An unrelated crash / manual stop: nothing is on record, so the DOWN
    // report must be causation-free — never blame a restart that isn't
    // provably on record.
    __panelToolsTestHooks.setHealthProbe(async () => "down");
    const { ctx, sends } = makeCtx({ confirm: "no" });

    const res = await restartTool().handler({}, ctx);
    const t = text(res);

    expect(res.isError).toBeFalsy();
    expect(t).toMatch(/ComfyUI is DOWN/i);
    expect(t).toMatch(/still unreachable after/i);
    expect(t).toMatch(/no restart was dispatched/i);
    expect(t).not.toMatch(/restart initiated earlier/i);
    expect(t).not.toMatch(/was NOT what stopped it/i);
    expect(t).not.toMatch(/STOPPED and did not come back/i);
    expect(sends.some((c) => c.cmd === "comfy_reboot")).toBe(false);
  });

  it("bound full-window DOWN with a STALE recorded dispatch makes NO causation claim (r4)", async () => {
    // A dispatch older than the causation window can't explain the current
    // down state — the report stays causation-free.
    __panelToolsTestHooks.setHealthProbe(async () => "down");
    const { ctx, sends } = makeCtx({ confirm: "no" });
    __panelToolsTestHooks.seedSessionRestartDispatch(ctx, {
      at: Date.now() - 11 * 60_000, // beyond the 10-minute causation window
      base: BOOT_BASE,
    });

    const res = await restartTool().handler({}, ctx);
    const t = text(res);

    expect(res.isError).toBeFalsy();
    expect(t).toMatch(/ComfyUI is DOWN/i);
    expect(t).toMatch(/no restart was dispatched/i);
    expect(t).not.toMatch(/restart initiated earlier/i);
    expect(t).not.toMatch(/STOPPED and did not come back/i);
    expect(sends.some((c) => c.cmd === "comfy_reboot")).toBe(false);
  });

  it("bound full-window DOWN with a dispatch recorded for a DIFFERENT instance makes NO causation claim (r4)", async () => {
    // The record must target the SAME instance the decline probed — a restart
    // of some other ComfyUI explains nothing here.
    __panelToolsTestHooks.setHealthProbe(async () => "down");
    const { ctx, sends } = makeCtx({ confirm: "no" });
    __panelToolsTestHooks.seedSessionRestartDispatch(ctx, {
      at: Date.now(),
      base: "http://127.0.0.1:9999",
    });

    const res = await restartTool().handler({}, ctx);
    const t = text(res);

    expect(res.isError).toBeFalsy();
    expect(t).toMatch(/ComfyUI is DOWN/i);
    expect(t).toMatch(/no restart was dispatched/i);
    expect(t).not.toMatch(/restart initiated earlier/i);
    expect(t).not.toMatch(/STOPPED and did not come back/i);
    expect(sends.some((c) => c.cmd === "comfy_reboot")).toBe(false);
  });

  it("a dispatch recorded by ANOTHER SESSION never grounds causation here (r5)", async () => {
    // Two sessions (two ctx objects): session A dispatched the failed restart.
    // Session B's decline over the SAME base must report causation-FREE…
    __panelToolsTestHooks.setHealthProbe(async () => "down");
    const { ctx: ctxA } = makeCtx({ confirm: "no" });
    const { ctx: ctxB, sends: sendsB } = makeCtx({ confirm: "no" });
    __panelToolsTestHooks.seedSessionRestartDispatch(ctxA, { at: Date.now(), base: BOOT_BASE });

    const resB = await restartTool().handler({}, ctxB);
    const tB = text(resB);

    expect(tB).toMatch(/ComfyUI is DOWN/i);
    expect(tB).toMatch(/no restart was dispatched/i);
    expect(tB).not.toMatch(/restart initiated earlier/i);
    expect(tB).not.toMatch(/STOPPED and did not come back/i);
    expect(sendsB.some((c) => c.cmd === "comfy_reboot")).toBe(false);

    // …while session A's OWN decline over the same base MAY name it.
    const resA = await restartTool().handler({}, ctxA);
    const tA = text(resA);

    expect(tA).toMatch(/ComfyUI is DOWN/i);
    expect(tA).toMatch(/STOPPED and did not come back/i);
    expect(tA).toMatch(/restart initiated earlier/i);
  });

  it("a decline with the server down-then-HEALTHY inside the window does NOT declare a loss", async () => {
    // A genuinely restarting server is refused during its normal down window
    // (codex gate High #1): a recovery inside the recheck window must NOT be
    // reported as a lost server — the truthful outcome is "it came back".
    const seq: Array<"down" | "healthy"> = ["down", "down", "healthy"];
    let probes = 0;
    __panelToolsTestHooks.setHealthProbe(async () => {
      const s = seq[Math.min(probes, seq.length - 1)];
      probes++;
      return s;
    });
    const { ctx, sends } = makeCtx({ confirm: "no" });

    const res = await restartTool().handler({}, ctx);
    const t = text(res);

    expect(res.isError).toBeFalsy();
    expect(t).not.toMatch(/ComfyUI is DOWN/i);
    expect(t).not.toMatch(/did not come back/i);
    expect(t).not.toMatch(/start ComfyUI manually/i);
    expect(t).toMatch(/^Cancelled — no new restart was dispatched/);
    expect(t).toMatch(/healthy again/i);
    // It kept polling past the first refused sample instead of declaring loss.
    expect(probes).toBe(3);
    expect(sends.some((c) => c.cmd === "comfy_reboot")).toBe(false);
  });

  it("a decline with a HEALTHY server keeps the plain cancel line (one probe, no stall)", async () => {
    let probes = 0;
    __panelToolsTestHooks.setHealthProbe(async () => {
      probes++;
      return "healthy";
    });
    const { ctx, sends } = makeCtx({ confirm: "no" });

    const res = await restartTool().handler({}, ctx);

    expect(text(res)).toBe("Cancelled — ComfyUI was not restarted.");
    expect(probes).toBe(1); // healthy on the first sample → no recheck window
    expect(sends.some((c) => c.cmd === "comfy_reboot")).toBe(false);
  });

  it("a decline with an UNVERIFIABLE server keeps the plain cancel line (never alarmist)", async () => {
    // "unknown" (a transient 5xx / timeout / ambiguous error) is NOT a proven
    // down — only ECONNREFUSED at the END of the window flips the report.
    __panelToolsTestHooks.setHealthProbe(async () => "unknown");
    const { ctx, sends } = makeCtx({ confirm: "no" });

    const res = await restartTool().handler({}, ctx);

    expect(text(res)).toBe("Cancelled — ComfyUI was not restarted.");
    expect(sends.some((c) => c.cmd === "comfy_reboot")).toBe(false);
  });

  it("an UNBOUND probe target gets a generic unreachable report — never a causation claim (codex gate)", async () => {
    // The bound tab does NOT provably front our boot instance, so the only probe
    // is the configured endpoint — no proven relationship to the restart. The
    // report may say the server is unreachable, but must NEVER claim a restart
    // (ours or an earlier one) stopped it.
    let probes = 0;
    __panelToolsTestHooks.setHealthProbe(async () => {
      probes++;
      return "down";
    });
    const { ctx, sends } = makeCtx({ confirm: "no", frontsBoot: false });

    const res = await restartTool().handler({}, ctx);
    const t = text(res);

    expect(res.isError).toBeFalsy();
    expect(t).not.toMatch(/^Cancelled/);
    expect(t).toMatch(/appears to be DOWN|unreachable/i);
    // NO causation: not "stopped by a restart", not "did not come back".
    expect(t).not.toMatch(/restart initiated earlier/i);
    expect(t).not.toMatch(/STOPPED and did not come back/i);
    expect(t).not.toMatch(/was NOT what stopped it/i);
    expect(t).toMatch(/can't tell|can't confirm|isn't provably/i);
    expect(probes).toBeGreaterThan(1);
    expect(sends.some((c) => c.cmd === "comfy_reboot")).toBe(false);
  });

  it("an UNBOUND probe target that recovers keeps the plain cancel line", async () => {
    const seq: Array<"down" | "healthy"> = ["down", "healthy"];
    let probes = 0;
    __panelToolsTestHooks.setHealthProbe(async () => {
      const s = seq[Math.min(probes, seq.length - 1)];
      probes++;
      return s;
    });
    const { ctx, sends } = makeCtx({ confirm: "no", frontsBoot: false });

    const res = await restartTool().handler({}, ctx);

    expect(text(res)).toBe("Cancelled — ComfyUI was not restarted.");
    expect(sends.some((c) => c.cmd === "comfy_reboot")).toBe(false);
  });

  it("recheck loop NEVER starts an awaited probe after the hard deadline (codex gate r2)", async () => {
    // A long configured window but a deadline expiring mid-loop: the loop must
    // STOP at the deadline — the old code clamped the expired remainder to a
    // 1ms timeout and still awaited one more probe past it. Fake timers make
    // the exact probe-start instants deterministic.
    vi.useFakeTimers();
    try {
      const starts: number[] = [];
      __panelToolsTestHooks.setHealthProbe(async () => {
        starts.push(Date.now());
        return "down";
      });
      const t0 = Date.now();
      const pending = __panelToolsTestHooks.probeDeclineRecovery(
        null,
        5000, // windowMs — far beyond the deadline
        5, // intervalMs
        5, // probeTimeoutMs
        t0 + 20, // hard deadline at +20ms
      );
      await vi.advanceTimersByTimeAsync(10000);
      const out = await pending;

      // Samples at 0/5/10/15ms; at +20 the deadline is exhausted, so NO probe
      // may start there — the old code started (and awaited) one with a
      // clamped 1ms timeout.
      expect(starts.map((s) => s - t0)).toEqual([0, 5, 10, 15]);
      expect(out.attempts).toBe(4);
      // The elapsed time respects the deadline (nowhere near the 5000ms window).
      expect(out.waited_ms).toBeLessThanOrEqual(25);
      // r3: the deadline TRUNCATED the window — a truncated observation can't
      // prove permanence, so even an all-refused run is "ambiguous", NEVER
      // "down" (a lost-server report requires the FULL window).
      expect(out.status).toBe("ambiguous");
    } finally {
      vi.useRealTimers();
    }
  });

  it("recheck loop returns DOWN only when the FULL window ran with final refusal (r3)", async () => {
    // The window completes well before the deadline: every sample refused, so
    // the full-window observation DOES prove the server stayed down.
    vi.useFakeTimers();
    try {
      const starts: number[] = [];
      __panelToolsTestHooks.setHealthProbe(async () => {
        starts.push(Date.now());
        return "down";
      });
      const t0 = Date.now();
      const pending = __panelToolsTestHooks.probeDeclineRecovery(
        null,
        20, // windowMs — completes at +20ms…
        5,
        5,
        t0 + 10000, // …with the deadline far beyond it (no truncation)
      );
      await vi.advanceTimersByTimeAsync(1000);
      const out = await pending;

      // Samples at 0/5/10/15ms; the window's own end stops the loop (no probe
      // starts at +20 with an exhausted remainder).
      expect(starts.map((s) => s - t0)).toEqual([0, 5, 10, 15]);
      expect(out.attempts).toBe(4);
      expect(out.status).toBe("down"); // full-window refusal → provable loss
      expect(out.waited_ms).toBeLessThanOrEqual(25);
    } finally {
      vi.useRealTimers();
    }
  });

  it("recheck loop with an ALREADY-EXPIRED deadline probes nothing and reports ambiguous", async () => {
    // No remaining budget at entry: not even the first probe may start — the
    // verdict is ambiguous, so the report keeps the plain/generic line.
    let probes = 0;
    __panelToolsTestHooks.setHealthProbe(async () => {
      probes++;
      return "down";
    });
    const t0 = Date.now();

    const out = await __panelToolsTestHooks.probeDeclineRecovery(null, 5000, 5, 5, t0 - 1);

    expect(probes).toBe(0);
    expect(out.attempts).toBe(0);
    expect(out.status).toBe("ambiguous");
  });
});

describe("panel_restart_comfyui — Pinokio-style refuse-safe preflight (#742)", () => {
  it("REFUSES before any stop when the relaunch is not provable (Pinokio-shaped install)", async () => {
    // The running local ComfyUI is externally supervised and its main.py /
    // interpreter cannot be resolved from here — a Manager restart would kill it
    // and NOTHING would bring it back (the #742 report).
    __panelToolsTestHooks.setLocalRestartPreflight(async () => ({
      ok: false,
      reason:
        "Resolved ComfyUI script does not exist on disk: main.py — could not " +
        "locate the ComfyUI install.",
    }));
    const { ctx, sends } = makeCtx({ confirm: "yes" });

    const res = await restartTool().handler({}, ctx);
    const out = parse(res);

    expect(res.isError).toBeFalsy();
    expect(out.rebooting).toBe(false);
    expect(out.refused).toBe(true);
    expect(String(out.note)).toMatch(/refusing to restart/i);
    expect(String(out.note)).toMatch(/still running/i);
    expect(String(out.note)).toMatch(/Pinokio/i);
    // CRITICAL: the reboot was NEVER dispatched — no stop can have happened.
    expect(sends.some((c) => c.cmd === "comfy_reboot")).toBe(false);
    // And the reboot caches were not dropped (no restart is in flight).
    expect(resetClient).not.toHaveBeenCalled();
    expect(resetObjectInfoCache).not.toHaveBeenCalled();
  });

  it("a failing preflight with a mid-await REBIND issues NO stale-target refusal (r8)", async () => {
    // Bound at the preflight decision; the session rebinds to an unconfirmable
    // target DURING the await and the preflight FAILS. The refusal must NOT be
    // composed against the stale pre-await target ("ComfyUI is still running"
    // would describe a target never validated) — nothing was stopped, so the
    // flow falls through to the honest unbound dispatch instead.
    const fronts = { current: true }; // bound when the preflight is decided…
    __panelToolsTestHooks.setLocalRestartPreflight(async () => {
      fronts.current = false; // …but a rebind lands DURING the preflight await
      return {
        ok: false,
        reason:
          "Resolved ComfyUI script does not exist on disk: main.py — could not " +
          "locate the ComfyUI install.",
      };
    });
    __panelToolsTestHooks.setHealthProbe(async () => "down");
    const { ctx, sends } = makeCtx({ confirm: "yes", fronts });

    const out = parse(await restartTool().handler({}, ctx));
    const note = String(out.note ?? "");

    // NO stale-target refusal, no unvalidated "still running" claim…
    expect(note).not.toMatch(/Refusing to restart/i);
    expect(note).not.toMatch(/still running/i);
    expect(out.refused).not.toBe(true);
    // …the restart proceeds against the CURRENT (unbound) target and is
    // reported honestly as dispatched-but-unconfirmable.
    expect(sends.some((c) => c.cmd === "comfy_reboot")).toBe(true);
    expect(out.rebooting).toBe(true);
    expect(note).toMatch(/can't confirm/i);
    expect(__panelToolsTestHooks.getSessionRestartDispatch(ctx)).toBeNull();
  });

  it("a CONFIG-ONLY retarget mid-await still REFUSES the proven-dangerous boot instance (r9)", async () => {
    // The tab fronts the boot instance THROUGHOUT; only the MUTABLE runtime
    // config moves during the preflight await. The failed preflight already
    // PROVED that instance unrelaunchable — the proof follows the instance the
    // tab fronts, not the mutable config — so the reboot must be REFUSED and
    // never dispatched (an instance proven unrelaunchable is NEVER sent a
    // stop/reboot, regardless of config shuffling mid-flight).
    __panelToolsTestHooks.setLocalRestartPreflight(async () => {
      hoistedConfig.configBase.value = "http://127.0.0.1:9999"; // config-only retarget mid-await
      hoistedConfig.generation.value += 1; // every real retarget bumps the generation
      return {
        ok: false,
        reason:
          "Resolved ComfyUI script does not exist on disk: main.py — could not " +
          "locate the ComfyUI install.",
      };
    });
    __panelToolsTestHooks.setHealthProbe(async () => "down");
    const { ctx, sends } = makeCtx({ confirm: "yes", frontsBoot: true });

    const out = parse(await restartTool().handler({}, ctx));
    const note = String(out.note ?? "");

    expect(out.refused).toBe(true);
    expect(note).toMatch(/Refusing to restart/i);
    expect(note).toMatch(/still running/i);
    // CRITICAL: the reboot was NEVER dispatched — the proven-dangerous
    // instance was not stopped.
    expect(sends.some((c) => c.cmd === "comfy_reboot")).toBe(false);
  });

  it("a PASSING preflight retargeted mid-await to a SAFE install still does NOT dispatch (r10)", async () => {
    // The preflight returns ok — but the runtime config retargeted DURING its
    // await, so the pass may have validated a DIFFERENT (safe) install while
    // the tab still fronts the original instance. A pass for a different
    // install must never bless a stop of the tab-fronted one: its relaunch is
    // UNPROVEN → refuse, never dispatch.
    __panelToolsTestHooks.setLocalRestartPreflight(async () => {
      hoistedConfig.configBase.value = "http://127.0.0.1:9999"; // retarget mid-await
      hoistedConfig.generation.value += 1; // every real retarget bumps the generation
      return { ok: true }; // a pass — possibly for the WRONG install
    });
    __panelToolsTestHooks.setHealthProbe(async () => "down");
    const { ctx, sends } = makeCtx({ confirm: "yes", frontsBoot: true });

    const out = parse(await restartTool().handler({}, ctx));
    const note = String(out.note ?? "");

    expect(out.refused).toBe(true);
    expect(note).toMatch(/Refusing to restart/i);
    expect(note).toMatch(/still running/i);
    expect(note).toMatch(/settle/i);
    // CRITICAL: no stop/reboot is sent to the unproven tab-fronted instance.
    expect(sends.some((c) => c.cmd === "comfy_reboot")).toBe(false);
  });

  it("an A→B→A retarget during the preflight await is detected by the generation, not the final base (r11)", async () => {
    // The config base RETURNS to its original value by the end of the await —
    // a final-state comparison sees "unchanged" and would accept the safe pass
    // for install B, then dispatch to the still-tab-fronted dangerous A. The
    // generation was bumped TWICE, so the mutation is caught and the restart
    // is refused.
    __panelToolsTestHooks.setLocalRestartPreflight(async () => {
      hoistedConfig.configBase.value = "http://127.0.0.1:9999"; // A → B
      hoistedConfig.generation.value += 1;
      hoistedConfig.configBase.value = null; // B → A (back to the original base)
      hoistedConfig.generation.value += 1;
      return { ok: true }; // a pass — for install B, not the tab-fronted A
    });
    __panelToolsTestHooks.setHealthProbe(async () => "down");
    const { ctx, sends } = makeCtx({ confirm: "yes", frontsBoot: true });

    const out = parse(await restartTool().handler({}, ctx));
    const note = String(out.note ?? "");

    expect(out.refused).toBe(true);
    expect(note).toMatch(/Refusing to restart/i);
    expect(note).toMatch(/still running/i);
    expect(note).toMatch(/settle/i);
    // CRITICAL: no stop/reboot is sent to the unproven tab-fronted instance.
    expect(sends.some((c) => c.cmd === "comfy_reboot")).toBe(false);
  });

  it("does NOT consult the preflight when the tab doesn't provably front our boot instance", async () => {
    // The preflight guards OUR local boot instance only. A reboot bound for a
    // different/remote instance proceeds exactly as before (dispatched +
    // accepted, honestly unconfirmable from here).
    const preflight = vi.fn(async () => ({ ok: false, reason: "would refuse" }));
    __panelToolsTestHooks.setLocalRestartPreflight(preflight);
    const { ctx, sends } = makeCtx({ confirm: "yes", frontsBoot: false });

    const out = parse(await restartTool().handler({}, ctx));

    expect(out.rebooting).toBe(true);
    expect(preflight).not.toHaveBeenCalled();
    expect(sends.some((c) => c.cmd === "comfy_reboot")).toBe(true);
  });

  it("a normal local restart still proceeds when the preflight passes", async () => {
    const seq: Array<"down" | "healthy"> = ["down", "healthy"];
    let i = 0;
    __panelToolsTestHooks.setHealthProbe(async () => seq[Math.min(i++, seq.length - 1)]);
    const { ctx, sends } = makeCtx({ confirm: "yes" });

    const out = parse(await restartTool().handler({}, ctx));

    expect(out.rebooting).toBe(true);
    expect(out.ready).toBe(true);
    expect(out.confirmed_cycle).toBe(true);
    expect(sends.some((c) => c.cmd === "comfy_reboot")).toBe(true);
    // r4/r5: the dispatch was recorded on acceptance AND cleared when the
    // restart was observed back — a completed restart explains no later down.
    expect(__panelToolsTestHooks.getSessionRestartDispatch(ctx)).toBeNull();
  });
});

describe("panel_restart_comfyui — restart dispatch record (r4/r5)", () => {
  it("an ACCEPTED reboot stamps the dispatch record HELD BY its session (target base + time)", async () => {
    // The reboot is accepted but never observed back — the record must stay
    // stamped so a later decline can name the causation.
    __panelToolsTestHooks.setHealthProbe(async () => "down");
    const { ctx, sends } = makeCtx({ confirm: "yes" });

    const before = Date.now();
    await restartTool().handler({}, ctx);

    expect(sends.some((c) => c.cmd === "comfy_reboot")).toBe(true);
    const rec = __panelToolsTestHooks.getSessionRestartDispatch(ctx);
    expect(rec).not.toBeNull();
    expect(rec!.at).toBeGreaterThanOrEqual(before);
    expect(__panelToolsTestHooks.sameHttpBase(rec!.base, BOOT_BASE)).toBe(true);
  });

  it("a REFUSED reboot (busy guard) does NOT stamp the record", async () => {
    // A refusal restarts nothing — recording it would fabricate causation.
    __panelToolsTestHooks.setHealthProbe(async () => "healthy");
    const { ctx, sends } = makeCtx({
      confirm: "yes",
      rebootReply: { rebooting: false, blocked_busy: true },
    });

    const out = parse(await restartTool().handler({}, ctx));

    expect(out.rebooting).toBe(false);
    expect(sends.some((c) => c.cmd === "comfy_reboot")).toBe(true);
    expect(__panelToolsTestHooks.getSessionRestartDispatch(ctx)).toBeNull();
  });

  it("session A's recovery clears ONLY its own record — session B's survives (r5)", async () => {
    // B has a failed restart on record. A runs its own accepted reboot that
    // recovers: A's record is stamped then cleared on recovery; B's record
    // must be untouched.
    __panelToolsTestHooks.setHealthProbe(async () => "down");
    const { ctx: ctxB } = makeCtx({ confirm: "no" });
    __panelToolsTestHooks.seedSessionRestartDispatch(ctxB, { at: Date.now(), base: BOOT_BASE });

    const seq: Array<"down" | "healthy"> = ["down", "healthy"];
    let i = 0;
    __panelToolsTestHooks.setHealthProbe(async () => seq[Math.min(i++, seq.length - 1)]);
    const { ctx: ctxA } = makeCtx({ confirm: "yes" });

    const out = parse(await restartTool().handler({}, ctxA));

    expect(out.ready).toBe(true); // A's restart recovered
    expect(__panelToolsTestHooks.getSessionRestartDispatch(ctxA)).toBeNull(); // A's cleared
    // B's record survives A's recovery.
    const recB = __panelToolsTestHooks.getSessionRestartDispatch(ctxB);
    expect(recB).not.toBeNull();
    expect(__panelToolsTestHooks.sameHttpBase(recB!.base, BOOT_BASE)).toBe(true);
  });

  it("an UNBOUND accepted reboot stamps NO causation-capable record (r6)", async () => {
    // The reboot is accepted, but the target is unconfirmable (the tab does
    // not provably front our boot instance) — it must NOT stamp a session-held
    // record: the dispatch can't be proven to have hit the instance a later
    // decline would probe. It lands only in the process-wide non-causation
    // slot (documenting that a dispatch happened).
    __panelToolsTestHooks.setHealthProbe(async () => "down");
    const { ctx, sends } = makeCtx({ confirm: "yes", frontsBoot: false });

    const out = parse(await restartTool().handler({}, ctx));

    expect(out.rebooting).toBe(true); // accepted, honestly unconfirmable
    expect(sends.some((c) => c.cmd === "comfy_reboot")).toBe(true);
    // No causation-capable stamp on the session…
    expect(__panelToolsTestHooks.getSessionRestartDispatch(ctx)).toBeNull();
    // …only the shared process-wide (never-causation) slot knows of it.
    expect(
      getRestartDispatchRecord(PROCESS_WIDE_RESTART_DISPATCH_TOKEN),
    ).not.toBeNull();
  });

  it("a session that REBINDS to the boot tab after an unbound reboot gets a causation-FREE decline (r6)", async () => {
    // The accepted reboot happened while the session fronted an UNCONFIRMABLE
    // target. The session then rebinds to the boot tab: even with a full-window
    // down on the bound endpoint, the earlier reboot of (possibly) a DIFFERENT
    // instance must not be blamed.
    const fronts = { current: false }; // unbound at reboot time
    const seq: Array<"down" | "healthy"> = ["down", "healthy"];
    let i = 0;
    __panelToolsTestHooks.setHealthProbe(async () => seq[Math.min(i++, seq.length - 1)]);
    const { ctx, sends } = makeCtx({ confirm: "yes", fronts });

    // 1. Accepted reboot while UNBOUND — dispatched, honestly unconfirmable.
    const out1 = parse(await restartTool().handler({}, ctx));
    expect(out1.rebooting).toBe(true);

    // 2. The session REBINDS to the boot tab and a second card is declined.
    fronts.current = true;
    ctx.confirm = async () => "no" as const;
    __panelToolsTestHooks.setHealthProbe(async () => "down"); // full-window refusal

    const res2 = await restartTool().handler({}, ctx);
    const t2 = text(res2);

    expect(t2).toMatch(/ComfyUI is DOWN/i);
    expect(t2).toMatch(/no restart was dispatched/i);
    expect(t2).not.toMatch(/restart initiated earlier/i);
    expect(t2).not.toMatch(/STOPPED and did not come back/i);
    expect(sends.filter((c) => c.cmd === "comfy_reboot")).toHaveLength(1); // only the first
  });

  it("a rebind DURING the preflight await withholds the causation-capable stamp (r7)", async () => {
    // Bound at the preflight DECISION, but the session rebinds to an
    // unconfirmable target MID-AWAIT: the dispatch proceeds to the new target,
    // yet the stamp must use the DISPATCH-POINT binding (unbound → process-wide
    // non-causation slot only) — never the stale pre-await bound base.
    const fronts = { current: true }; // bound when the preflight is decided…
    __panelToolsTestHooks.setLocalRestartPreflight(async () => {
      fronts.current = false; // …but a rebind lands DURING the preflight await
      return { ok: true };
    });
    __panelToolsTestHooks.setHealthProbe(async () => "down");
    const { ctx, sends } = makeCtx({ confirm: "yes", fronts });

    const out = parse(await restartTool().handler({}, ctx));

    // The dispatch still proceeded (to the new, unconfirmable target) and was
    // accepted — honestly reported unconfirmable.
    expect(sends.some((c) => c.cmd === "comfy_reboot")).toBe(true);
    expect(out.rebooting).toBe(true);
    // The causation-capable stamp is WITHHELD: no session-held record…
    expect(__panelToolsTestHooks.getSessionRestartDispatch(ctx)).toBeNull();
    // …only the shared process-wide (never-causation) slot knows of it.
    expect(getRestartDispatchRecord(PROCESS_WIDE_RESTART_DISPATCH_TOKEN)).not.toBeNull();
  });
});
