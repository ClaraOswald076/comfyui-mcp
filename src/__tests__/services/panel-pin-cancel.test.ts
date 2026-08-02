// #689 — a pin written during a pending update_all / snapshot-restore window
// must CANCEL the queued panel-affecting work, not just warn about it.
//
// These tests drive the REAL install_panel(action='pin') tool handler with a
// stubbed ComfyUI-Manager and a real temp-dir marker/lock/settings file, and
// assert the four honesty cases:
//   1. proven cancel      → resetQueue called ON THE MARKER'S SERVER, pending
//                           counts named before/after, marker cleared;
//   2. reset failure /    → marker KEPT and today's warning preserved;
//      unverifiable state
//   3. in-flight work     → "cannot cancel", never "saved";
//   4. no markers         → no Manager calls at all.
// Snapshot restores cancel by deleting Manager's deferred-restore file (local
// only); remote reports "cannot cancel — remote host" truthfully.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// The marker records the server the op was queued on; the cancel must target
// THAT server even after the orchestrator is retargeted (#689).
const ORIG = "http://orig:8188";
let currentBase = ORIG;

vi.mock("../../config.js", () => {
  const config = {
    comfyuiPath: undefined as string | undefined,
    resolvedPort: 8188,
    comfyuiHost: "127.0.0.1",
    comfyuiSsl: false,
    githubToken: undefined as string | undefined,
  };
  return {
    config,
    isLocalMode: () => true,
    isRemoteMode: () => false,
    getComfyUIBaseUrl: () => currentBase,
    getComfyUIAuthHeaders: () => ({}),
  };
});

// Any Manager traffic is recorded and answered by the per-test persona.
const managerCalls: Array<{ url: string; method: string }> = [];
let managerHandler: (url: string, init?: RequestInit) => Response = () =>
  new Response("not found", { status: 404 });

vi.mock("../../comfyui/fetch.js", () => ({
  comfyuiFetch: vi.fn(async (url: string, init?: RequestInit) => {
    managerCalls.push({ url, method: init?.method ?? "GET" });
    return managerHandler(url, init);
  }),
}));

import { config } from "../../config.js";
import {
  activePanelPendingOps,
  recordPanelPendingOp,
  SNAPSHOT_RESTORE_PENDING_MS,
  UPDATE_ALL_PENDING_MS,
} from "../../services/panel-pin-guard.js";
import { getPanelPinState, PANEL_PIN_ENV_VAR } from "../../services/panel-settings.js";
import {
  fetchManagerQueueCounts,
  resetManagerApiCacheForTests,
} from "../../services/node-management.js";
import { updateAllCustomNodes } from "../../services/update-comfyui.js";
import { registerInstallPanelTools } from "../../tools/install-panel.js";

let dir: string;

beforeEach(() => {
  managerCalls.length = 0;
  managerHandler = () => new Response("not found", { status: 404 });
  currentBase = ORIG;
  resetManagerApiCacheForTests();
  dir = mkdtempSync(join(tmpdir(), "cmcp-pincancel-"));
  process.env.COMFYUI_MCP_PANEL_SETTINGS = join(dir, "panel-settings.json");
  process.env.COMFYUI_MCP_PANEL_LOCK = join(dir, "panel-op.lock");
  process.env.COMFYUI_MCP_PANEL_PENDING = join(dir, "panel-pending-ops.json");
  config.comfyuiPath = undefined;
});

afterEach(() => {
  delete process.env.COMFYUI_MCP_PANEL_SETTINGS;
  delete process.env.COMFYUI_MCP_PANEL_LOCK;
  delete process.env.COMFYUI_MCP_PANEL_PENDING;
  delete process.env[PANEL_PIN_ENV_VAR];
  config.comfyuiPath = undefined;
  resetManagerApiCacheForTests();
  rmSync(dir, { recursive: true, force: true });
});

// ── Tool-handler capture (mirrors __tests__/tools/batches.test.ts) ──────────

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}>;

function pinHandler(): ToolHandler {
  const tools: Array<{ name: string; handler: ToolHandler }> = [];
  const server = {
    tool: (_name: string, _desc: string, _shape: unknown, handler: ToolHandler) => {
      tools.push({ name: _name, handler });
    },
  } as unknown as McpServer;
  registerInstallPanelTools(server);
  const tool = tools.find((t) => t.name === "install_panel");
  if (!tool) throw new Error("install_panel was not registered");
  return tool.handler;
}

async function writePin(): Promise<Record<string, unknown>> {
  const result = await pinHandler()({ action: "pin", version: "0.11.3" });
  expect(result.isError ?? false).toBe(false);
  return JSON.parse(result.content[0].text ?? "{}") as Record<string, unknown>;
}

// ── Stub Manager personas ────────────────────────────────────────────────────

function jsonRes(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

interface QueueState {
  pending: number;
  inProgress: number;
  done: number;
}

/** A Manager v4 host whose queue state the test controls; POST reset wipes pending. */
function v4Persona(state: QueueState, opts: { resetFails?: boolean } = {}) {
  managerHandler = (url, init) => {
    const path = new URL(url).pathname;
    const method = init?.method ?? "GET";
    if (path === "/v2/manager/queue/status" && method === "GET") {
      return jsonRes({
        total_count: state.done + state.inProgress + state.pending,
        done_count: state.done,
        in_progress_count: state.inProgress,
        pending_count: state.pending,
        is_processing: state.inProgress > 0,
      });
    }
    if (path === "/v2/manager/queue/reset" && method === "POST") {
      if (opts.resetFails) return new Response("boom", { status: 500 });
      state.pending = 0; // wipe_queue() clears PENDING only — running survives
      return new Response("", { status: 200 });
    }
    return new Response("not found", { status: 404 });
  };
}

/** A legacy 3.x host: no /v2 surface, no pending_count — the arithmetic path. */
function legacyPersona(state: QueueState) {
  managerHandler = (url, init) => {
    const path = new URL(url).pathname;
    const method = init?.method ?? "GET";
    if (path === "/manager/queue/status" && method === "GET") {
      return jsonRes({
        total_count: state.done + state.inProgress + state.pending,
        done_count: state.done,
        in_progress_count: state.inProgress,
        is_processing: state.inProgress > 0,
      });
    }
    if (path === "/manager/version" && method === "GET") {
      return new Response("V3.41", { status: 200 });
    }
    if (path === "/manager/queue/reset" && method === "POST") {
      state.pending = 0;
      return new Response("", { status: 200 });
    }
    return new Response("not found", { status: 404 });
  };
}

function recordUpdateAllMarker(extra: { base?: string } = { base: ORIG }) {
  return recordPanelPendingOp(
    "update-all",
    "an update_all request may have been handed to ComfyUI-Manager",
    UPDATE_ALL_PENDING_MS,
    extra,
  );
}

interface CancellationReport {
  kind: string;
  outcome: string;
  markerCleared: boolean;
  pendingBefore?: number;
  pendingAfter?: number;
  inProgress?: number;
  detail: string;
}

function cancelReports(report: Record<string, unknown>): CancellationReport[] {
  return (report.pendingOpCancellations ?? []) as CancellationReport[];
}

const resetPosts = () =>
  managerCalls.filter((c) => c.method === "POST" && c.url.includes("/manager/queue/reset"));

describe("pin write cancels a pending update_all (#689)", () => {
  it("proven cancel: resets the queue ON THE MARKER'S SERVER, names the dropped counts, clears the marker", async () => {
    recordUpdateAllMarker({ base: ORIG });
    v4Persona({ pending: 2, inProgress: 0, done: 3 });
    // Retarget AFTER the marker was recorded: the reset must still hit ORIG.
    currentBase = "http://new:8188";

    const report = await writePin();

    // The pin itself always lands.
    expect(report.outcome).toBe("active");
    expect(getPanelPinState().pinned).toBe(true);

    // Every Manager call went to the marker's server — none to the new target.
    expect(managerCalls.length).toBeGreaterThan(0);
    expect(managerCalls.every((c) => c.url.startsWith(ORIG))).toBe(true);
    expect(resetPosts().map((c) => c.url)).toEqual([`${ORIG}/v2/manager/queue/reset`]);

    // The report names the before/after pending counts — never "saved".
    const [cancel] = cancelReports(report);
    expect(cancel.outcome).toBe("cancelled");
    expect(cancel.markerCleared).toBe(true);
    expect(cancel.pendingBefore).toBe(2);
    expect(cancel.pendingAfter).toBe(0);
    expect(cancel.inProgress).toBe(0);
    expect(cancel.detail).toMatch(/dropped 2 pending task/);

    // Marker provably cleared; no residue warning in the note.
    expect(activePanelPendingOps()).toEqual([]);
    expect(report.pendingPanelOps).toBeUndefined();
    expect(report.note as string).not.toMatch(/WARNING — a panel-affecting operation/);
    expect(report.note as string).toMatch(/Pending-op handling:/);
  });

  it("base-less marker: best-effort reset on the current target, but UNVERIFIED — marker KEPT, never 'cancelled'", async () => {
    recordUpdateAllMarker({}); // no base captured (older marker shape)
    v4Persona({ pending: 1, inProgress: 0, done: 0 });

    const report = await writePin();

    // The reset IS attempted on the current target (the likely server)...
    expect(resetPosts().map((c) => c.url)).toEqual([`${ORIG}/v2/manager/queue/reset`]);
    // ...but it proves nothing about the real server, so no proven outcome is
    // reported and the marker + warning stay.
    const [cancel] = cancelReports(report);
    expect(cancel.outcome).toBe("could-not-verify");
    expect(cancel.markerCleared).toBe(false);
    expect(cancel.detail).toMatch(/recorded NO server/);
    expect(cancel.detail).toMatch(/UNVERIFIED/);
    expect(cancel.detail).toMatch(/best-effort/);
    expect(cancel.detail).not.toMatch(/cancelled the queued update_all/);
    expect(activePanelPendingOps()).toHaveLength(1);
    expect(report.pendingPanelOps).toHaveLength(1);
    expect(report.note as string).toMatch(/WARNING — a panel-affecting operation is still pending/);
  });

  it("base-less marker with an idle current target: NO reset sent, still unverified, marker kept", async () => {
    recordUpdateAllMarker({});
    v4Persona({ pending: 0, inProgress: 0, done: 3 });

    const report = await writePin();

    expect(resetPosts()).toHaveLength(0);
    const [cancel] = cancelReports(report);
    expect(cancel.outcome).toBe("could-not-verify");
    expect(cancel.markerCleared).toBe(false);
    expect(cancel.detail).toMatch(/recorded NO server/);
    expect(cancel.detail).toMatch(/proves NOTHING/);
    expect(activePanelPendingOps()).toHaveLength(1);
  });

  it("reset failure: marker KEPT, warning preserved, nothing claimed", async () => {
    recordUpdateAllMarker();
    v4Persona({ pending: 2, inProgress: 0, done: 3 }, { resetFails: true });

    const report = await writePin();

    expect(resetPosts()).toHaveLength(1); // the reset WAS attempted
    const [cancel] = cancelReports(report);
    expect(cancel.outcome).toBe("could-not-verify");
    expect(cancel.markerCleared).toBe(false);
    expect(cancel.detail).toMatch(/reset FAILED/);
    // The marker and today's warning survive.
    expect(activePanelPendingOps()).toHaveLength(1);
    expect(report.pendingPanelOps).toHaveLength(1);
    expect(report.note as string).toMatch(/WARNING — a panel-affecting operation is still pending/);
    expect(report.note as string).not.toMatch(/cancelled the queued update_all/);
  });

  it("unverifiable pre-reset state: NOTHING is sent, marker KEPT", async () => {
    recordUpdateAllMarker();
    managerHandler = () => new Response("not found", { status: 404 }); // Manager gone

    const report = await writePin();

    expect(resetPosts()).toHaveLength(0); // fail closed — no blind reset
    const [cancel] = cancelReports(report);
    expect(cancel.outcome).toBe("could-not-verify");
    expect(cancel.detail).toMatch(/NOTHING was sent/);
    expect(activePanelPendingOps()).toHaveLength(1);
    expect(report.note as string).toMatch(/WARNING/);
  });

  it("in-flight (already dequeued): cannot cancel, NO reset sent, never 'saved'", async () => {
    recordUpdateAllMarker();
    v4Persona({ pending: 0, inProgress: 1, done: 3 });

    const report = await writePin();

    expect(resetPosts()).toHaveLength(0); // pointless — reset only drops pending
    const [cancel] = cancelReports(report);
    expect(cancel.outcome).toBe("already-running");
    expect(cancel.markerCleared).toBe(false);
    expect(cancel.inProgress).toBe(1);
    expect(cancel.detail).toMatch(/cannot cancel/i);
    expect(cancel.detail).toMatch(/RUNNING/);
    expect(cancel.detail).not.toMatch(/dropped|cancelled the queued/);
    expect(activePanelPendingOps()).toHaveLength(1);
    expect(report.note as string).toMatch(/WARNING — a panel-affecting operation is still pending/);
  });

  it("partial: pending dropped but a task is running — marker KEPT, both halves reported", async () => {
    recordUpdateAllMarker();
    v4Persona({ pending: 2, inProgress: 1, done: 3 });

    const report = await writePin();

    expect(resetPosts()).toHaveLength(1);
    const [cancel] = cancelReports(report);
    expect(cancel.outcome).toBe("partially-cancelled");
    expect(cancel.markerCleared).toBe(false);
    expect(cancel.pendingBefore).toBe(2);
    expect(cancel.pendingAfter).toBe(0);
    expect(cancel.inProgress).toBe(1);
    expect(cancel.detail).toMatch(/dropped 2 pending task/);
    expect(cancel.detail).toMatch(/already RUNNING and in-flight work cannot be cancelled/);
    expect(activePanelPendingOps()).toHaveLength(1);
    expect(report.note as string).toMatch(/WARNING/);
  });

  it("already drained: nothing left to cancel — marker cleared, panel may ALREADY have moved", async () => {
    recordUpdateAllMarker();
    v4Persona({ pending: 0, inProgress: 0, done: 3 });

    const report = await writePin();

    expect(resetPosts()).toHaveLength(0);
    const [cancel] = cancelReports(report);
    expect(cancel.outcome).toBe("already-drained");
    expect(cancel.markerCleared).toBe(true);
    expect(cancel.detail).toMatch(/NOTHING left to cancel/);
    expect(cancel.detail).toMatch(/may ALREADY have been moved/);
    expect(cancel.detail).not.toMatch(/cancelled|dropped/);
    expect(activePanelPendingOps()).toEqual([]);
  });

  it("legacy 3.x: pending derived by total−done−in_progress, reset on the unprefixed route", async () => {
    recordUpdateAllMarker();
    legacyPersona({ pending: 2, inProgress: 0, done: 2 });

    const report = await writePin();

    expect(resetPosts().map((c) => c.url)).toEqual([`${ORIG}/manager/queue/reset`]);
    const [cancel] = cancelReports(report);
    expect(cancel.outcome).toBe("cancelled");
    expect(cancel.pendingBefore).toBe(2);
    expect(cancel.pendingAfter).toBe(0);
    expect(activePanelPendingOps()).toEqual([]);
  });

  it("incoherent 3.x counts (the #639 stale signature) read as could-not-verify", async () => {
    recordUpdateAllMarker();
    // total < done + in_progress: the stale-3.x no-op shape. Nothing may be
    // concluded from it — and a blind reset must NOT be sent on it either.
    managerHandler = (url, init) => {
      const path = new URL(url).pathname;
      const method = init?.method ?? "GET";
      if (path === "/manager/queue/status" && method === "GET") {
        return jsonRes({ total_count: 0, done_count: 2, in_progress_count: 0, is_processing: false });
      }
      if (path === "/manager/version" && method === "GET") return new Response("V3.41", { status: 200 });
      return new Response("not found", { status: 404 });
    };

    const report = await writePin();

    expect(resetPosts()).toHaveLength(0);
    const [cancel] = cancelReports(report);
    expect(cancel.outcome).toBe("could-not-verify");
    expect(activePanelPendingOps()).toHaveLength(1);
  });
});

describe("pin write cancels a deferred snapshot restore (#689)", () => {
  function recordSnapshotMarker() {
    return recordPanelPendingOp(
      "snapshot-restore",
      'a snapshot restore ("prod") may have been requested',
      SNAPSHOT_RESTORE_PENDING_MS,
      { base: ORIG },
    );
  }

  it("local: deletes restore-snapshot.json from the live Manager files dir, clears the marker, no Manager calls", async () => {
    const comfyRoot = join(dir, "ComfyUI");
    config.comfyuiPath = comfyRoot;
    const restoreFile = join(
      comfyRoot,
      "user",
      "__manager",
      "startup-scripts",
      "restore-snapshot.json",
    );
    mkdirSync(dirname(restoreFile), { recursive: true });
    writeFileSync(restoreFile, "{}");
    recordSnapshotMarker();

    const report = await writePin();

    expect(existsSync(restoreFile)).toBe(false);
    const [cancel] = cancelReports(report);
    expect(cancel.outcome).toBe("cancelled");
    expect(cancel.markerCleared).toBe(true);
    expect(cancel.detail).toMatch(/deleted the deferred restore file/);
    expect(cancel.detail).toContain(restoreFile);
    expect(activePanelPendingOps()).toEqual([]);
    // The cancel is filesystem-local — the Manager was never contacted.
    expect(managerCalls).toEqual([]);
  });

  it("local, no restore file: already applied or never scheduled — marker cleared, truthfully not a cancel", async () => {
    config.comfyuiPath = join(dir, "ComfyUI"); // nothing scheduled
    recordSnapshotMarker();

    const report = await writePin();

    const [cancel] = cancelReports(report);
    expect(cancel.outcome).toBe("already-drained");
    expect(cancel.markerCleared).toBe(true);
    expect(cancel.detail).toMatch(/NOTHING left to cancel/);
    expect(cancel.detail).toMatch(/may ALREADY have been reverted/);
    expect(activePanelPendingOps()).toEqual([]);
    expect(managerCalls).toEqual([]);
  });

  it("remote: truthful 'cannot cancel — remote host', marker KEPT, no Manager calls", async () => {
    config.comfyuiPath = undefined; // remote mode — the file lives on the host
    recordSnapshotMarker();

    const report = await writePin();

    const [cancel] = cancelReports(report);
    expect(cancel.outcome).toBe("cannot-cancel-remote");
    expect(cancel.markerCleared).toBe(false);
    expect(cancel.detail).toMatch(/cannot cancel — remote host/);
    expect(cancel.detail).toMatch(/BEFORE the next ComfyUI restart/);
    expect(activePanelPendingOps()).toHaveLength(1);
    expect(report.pendingPanelOps).toHaveLength(1);
    expect(report.note as string).toMatch(/WARNING — a panel-affecting operation is still pending/);
    expect(managerCalls).toEqual([]);
  });

  it("marker recorded for a DIFFERENT server (remote→local retarget): cannot cancel from here, local file UNTOUCHED, marker kept", async () => {
    const comfyRoot = join(dir, "ComfyUI");
    config.comfyuiPath = comfyRoot;
    const restoreFile = join(
      comfyRoot,
      "user",
      "__manager",
      "startup-scripts",
      "restore-snapshot.json",
    );
    mkdirSync(dirname(restoreFile), { recursive: true });
    writeFileSync(restoreFile, "{}");
    // The restore was requested against a remote host; the orchestrator was
    // then retargeted to this local install. Local evidence must never clear
    // the remote marker.
    recordPanelPendingOp(
      "snapshot-restore",
      'a snapshot restore ("prod") may have been requested',
      SNAPSHOT_RESTORE_PENDING_MS,
      { base: "http://other:8188" },
    );

    const report = await writePin();

    const [cancel] = cancelReports(report);
    expect(cancel.outcome).toBe("cannot-cancel");
    expect(cancel.markerCleared).toBe(false);
    expect(cancel.detail).toMatch(/cannot cancel from here/);
    expect(cancel.detail).toContain("http://other:8188");
    // The local file is NOT touched — deleting it would prove nothing about
    // the remote host (and could cancel an unrelated LOCAL restore).
    expect(existsSync(restoreFile)).toBe(true);
    expect(activePanelPendingOps()).toHaveLength(1);
    expect(report.pendingPanelOps).toHaveLength(1);
    expect(report.note as string).toMatch(/WARNING/);
    expect(managerCalls).toEqual([]);
  });

  it("base-less restore marker with a local restore file: best-effort delete, but UNVERIFIED — marker kept", async () => {
    const comfyRoot = join(dir, "ComfyUI");
    config.comfyuiPath = comfyRoot;
    const restoreFile = join(
      comfyRoot,
      "user",
      "__manager",
      "startup-scripts",
      "restore-snapshot.json",
    );
    mkdirSync(dirname(restoreFile), { recursive: true });
    writeFileSync(restoreFile, "{}");
    recordPanelPendingOp(
      "snapshot-restore",
      'a snapshot restore ("prod") may have been requested',
      SNAPSHOT_RESTORE_PENDING_MS,
    ); // no base — older marker shape

    const report = await writePin();

    // The local file WILL run at the next local restart, so deleting it is
    // protective — but it proves nothing about which host the marker is for.
    expect(existsSync(restoreFile)).toBe(false);
    const [cancel] = cancelReports(report);
    expect(cancel.outcome).toBe("could-not-verify");
    expect(cancel.markerCleared).toBe(false);
    expect(cancel.detail).toMatch(/UNVERIFIED/);
    expect(cancel.detail).toMatch(/recorded no server/);
    expect(activePanelPendingOps()).toHaveLength(1);
    expect(managerCalls).toEqual([]);
  });

  it("base-less restore marker with NO local restore file: not provably drained — marker kept", async () => {
    config.comfyuiPath = join(dir, "ComfyUI"); // nothing scheduled locally
    recordPanelPendingOp(
      "snapshot-restore",
      'a snapshot restore ("prod") may have been requested',
      SNAPSHOT_RESTORE_PENDING_MS,
    ); // no base

    const report = await writePin();

    const [cancel] = cancelReports(report);
    expect(cancel.outcome).toBe("could-not-verify");
    expect(cancel.markerCleared).toBe(false);
    expect(cancel.detail).toMatch(/recorded no server/);
    expect(activePanelPendingOps()).toHaveLength(1);
    expect(managerCalls).toEqual([]);
  });
});

describe("pin write with no pending markers", () => {
  it("makes NO Manager calls at all", async () => {
    const report = await writePin();

    expect(report.outcome).toBe("active");
    expect(report.pendingPanelOps).toBeUndefined();
    expect(report.pendingOpCancellations).toBeUndefined();
    expect(managerCalls).toEqual([]);
  });
});

describe("the update_all marker captures base + ui_id at enqueue (#689)", () => {
  it("records the server it queued on and the ui_id of the attempt that landed", async () => {
    let enqueuedUiId: string | undefined;
    managerHandler = (url, init) => {
      const u = new URL(url);
      const method = init?.method ?? "GET";
      if (u.pathname === "/v2/manager/queue/status" && method === "GET") {
        return jsonRes({
          total_count: 0,
          done_count: 0,
          in_progress_count: 0,
          pending_count: 0,
          is_processing: false,
        });
      }
      if (u.pathname === "/v2/manager/queue/update_all" && method === "POST") {
        enqueuedUiId = u.searchParams.get("ui_id") ?? undefined;
        return jsonRes({});
      }
      if (u.pathname === "/v2/manager/queue/start" && method === "POST") {
        return new Response("", { status: 200 });
      }
      return new Response("not found", { status: 404 });
    };

    await updateAllCustomNodes();

    expect(enqueuedUiId).toBeTruthy();
    const ops = activePanelPendingOps();
    expect(ops).toHaveLength(1);
    expect(ops[0].kind).toBe("update-all");
    expect(ops[0].base).toBe(ORIG);
    expect(ops[0].uiId).toBe(enqueuedUiId);
  });
});

describe("fetchManagerQueueCounts", () => {
  it("returns undefined (could-not-verify) when the Manager is unreachable", async () => {
    managerHandler = () => new Response("not found", { status: 404 });
    await expect(fetchManagerQueueCounts(ORIG)).resolves.toBeUndefined();
  });
});
