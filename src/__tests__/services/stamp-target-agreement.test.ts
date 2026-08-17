// #1656 — after a workflow tab switch, panel graph reads/mutations silently ran on
// the PREVIOUS canvas: the panel's re-hello moved the routed connection onto the new
// workflow at once, but the session's workflow stamp is resolved from the caller's
// address (for the shared scope, the conversation's issue-time workflow — #570/#884
// deliberately never re-resolve it at dispatch), so it still named the previous one.
// The panel-side fence was expected to refuse that pairing; it compares against the
// frontend's LIVE identity, which can lag the switch the hello already reported, and
// in that window outline/save executed on the prior workflow and returned its
// uuid/path with no error.
//
// The fix is the dispatch-time agreement gate in send(): when the caller's stamp and
// the routed connection's last-advertised identity are BOTH known and DISAGREE, the
// command is refused BEFORE the socket write ("workflow instance mismatch", typed
// dispatched:false), naming the documented rebind. These tests drive the REAL
// UiBridge over a real socket through exactly that sequence.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "node:net";
import WebSocket from "ws";
import {
  UiBridge,
  dispatchOutcomeOf,
  requiresStampTargetAgreement,
} from "../../services/ui-bridge.js";
import { isScopeAddress } from "../../services/session-scope.js";
import { waitFor } from "../helpers/wait-for.js";

const UUID_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const UUID_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TAB_A = "wf:route1:workflows/a-long-filename.json";
const TAB_B = "wf:route1:workflows/krea2_lora_ab_compare.json";
const SCOPE = "orchestrator::claude";

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const p = addr && typeof addr === "object" ? addr.port : 0;
      srv.close((err) => (err ? reject(err) : resolve(p)));
    });
  });
}

describe("requiresStampTargetAgreement (#1656)", () => {
  it("gates active-canvas reads AND the active-workflow mutators", () => {
    expect(requiresStampTargetAgreement({ cmd: "graph_outline" })).toBe(true);
    expect(requiresStampTargetAgreement({ cmd: "graph_query" })).toBe(true);
    expect(requiresStampTargetAgreement({ cmd: "graph_add_node" })).toBe(true);
    // An UNLISTED graph_* command fails closed, like GRAPH_CMD_EFFECT's fallback.
    expect(requiresStampTargetAgreement({ cmd: "graph_some_future_op" })).toBe(true);
    expect(requiresStampTargetAgreement({ cmd: "workflow_save" })).toBe(true);
    expect(requiresStampTargetAgreement({ cmd: "workflow_save_as" })).toBe(true);
    // A path-less rename/close targets the active workflow — gated.
    expect(requiresStampTargetAgreement({ cmd: "workflow_rename" })).toBe(true);
    expect(requiresStampTargetAgreement({ cmd: "workflow_close" })).toBe(true);
  });

  it("exempts the recovery probe, navigation, canvas-independent ops, and selectored rename/close", () => {
    // workflow_list is the fence-exempt probe the rebind recovery depends on (#932).
    expect(requiresStampTargetAgreement({ cmd: "workflow_list" })).toBe(false);
    expect(requiresStampTargetAgreement({ cmd: "workflow_open", path: "x" })).toBe(false);
    expect(requiresStampTargetAgreement({ cmd: "workflow_new" })).toBe(false);
    // #602's canvas-independent set (mirrored from the panel).
    for (const cmd of [
      "nodes_search",
      "nodes_list",
      "nodes_install",
      "nodes_queue_status",
      "graph_update_node",
      "comfy_reboot",
      "free_vram",
    ]) {
      expect(requiresStampTargetAgreement({ cmd })).toBe(false);
    }
    // A selectored rename/close may name a genuinely NON-active workflow; the panel
    // resolves that precisely, so the server-side gate leaves it to the panel.
    expect(
      requiresStampTargetAgreement({ cmd: "workflow_rename", path: "workflows/other.json" } as never),
    ).toBe(false);
    expect(
      requiresStampTargetAgreement({ cmd: "workflow_close", path: "workflows/other.json" } as never),
    ).toBe(false);
    expect(requiresStampTargetAgreement({ cmd: "show_media" })).toBe(false);
    expect(requiresStampTargetAgreement({})).toBe(false);
  });
});

describe("dispatch-time stamp/target agreement gate (#1656)", () => {
  let bridge: UiBridge;
  let port: number;

  /** The orchestrator's two answers, modelled separately BECAUSE they diverge in
   *  the bug: the per-tab advertised identity (tabCommandWorkflowUuid, refreshed by
   *  every hello) and the conversation's issue-time stamp (turnOrigins.stampOf). */
  const advertised = new Map<string, string>();
  let sessionStamp: string | undefined;

  /** Every command frame the fake panel receives. */
  let received: Array<Record<string, unknown>>;

  const hello = (sock: WebSocket, tabId: string) =>
    sock.send(
      JSON.stringify({
        type: "hello",
        tab_id: tabId,
        title: tabId,
        enforces_workflow_stamp: true,
        enforces_workflow_stamp_at_write: true,
      }),
    );

  beforeEach(async () => {
    advertised.clear();
    sessionStamp = undefined;
    received = [];
    for (let attempt = 0; attempt < 6; attempt++) {
      port = await freePort();
      bridge = new UiBridge(port);
      bridge.start();
      if (await bridge.whenReady()) break;
      await bridge.stop();
      if (attempt === 5) throw new Error("could not bind a free bridge port");
    }
    bridge.setTabWorkflowUuidResolver((id) =>
      isScopeAddress(id) ? sessionStamp : advertised.get(id),
    );
  });

  afterEach(async () => {
    await bridge.stop();
  });

  function connectPanel(tabId: string): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const sock = new WebSocket(`ws://127.0.0.1:${port}`);
      sock.on("open", () => {
        hello(sock, tabId);
        resolve(sock);
      });
      sock.on("error", reject);
      sock.on("message", (buf) => {
        const msg = JSON.parse(buf.toString());
        if (msg.rid && msg.cmd) {
          received.push(msg);
          sock.send(JSON.stringify({ rid: msg.rid, ok: true, result: { cmd: msg.cmd } }));
        }
      });
    });
  }

  it("dispatches while the session stamp and the tab's advertised identity AGREE", async () => {
    advertised.set(TAB_A, UUID_A);
    sessionStamp = UUID_A;
    const sock = await connectPanel(TAB_A);
    await waitFor(() => expect(bridge.tabs().map((t) => t.tab_id)).toContain(TAB_A));

    // bridge.send resolves with the reply's RESULT, not the reply envelope.
    const res = await bridge.send({ cmd: "graph_outline" }, { tabId: SCOPE });
    expect(res).toEqual({ cmd: "graph_outline" });
    expect(received.map((f) => f.cmd)).toEqual(["graph_outline"]);
    expect(received[0].workflow_uuid).toBe(UUID_A);
    sock.close();
  });

  it("refuses a read AND a mutation after the tab switch the session has not caught up to", async () => {
    advertised.set(TAB_A, UUID_A);
    sessionStamp = UUID_A;
    const sock = await connectPanel(TAB_A);
    await waitFor(() => expect(bridge.tabs().map((t) => t.tab_id)).toContain(TAB_A));

    // The user switches the canvas A → B. The panel re-hellos on the SAME socket:
    // the bridge migrates the connection (and last-active) to the new route, and
    // the orchestrator records the new advertised identity. The conversation's
    // issue-time stamp stays A — that is #570's rule, not an oversight.
    hello(sock, TAB_B);
    await waitFor(() => expect(bridge.tabs().map((t) => t.tab_id)).toContain(TAB_B));
    advertised.delete(TAB_A);
    advertised.set(TAB_B, UUID_B);
    received.length = 0;

    // The read the issue reported succeeding on the previous canvas…
    const readErr = await bridge.send({ cmd: "graph_outline" }, { tabId: SCOPE }).then(
      () => null,
      (err) => err as Error,
    );
    expect(readErr).not.toBeNull();
    expect(readErr!.message).toMatch(/^workflow instance mismatch:/);
    // …and the save that returned the previous workflow's uuid/path.
    const saveErr = await bridge.send({ cmd: "workflow_save" }, { tabId: SCOPE }).then(
      () => null,
      (err) => err as Error,
    );
    expect(saveErr).not.toBeNull();
    expect(saveErr!.message).toMatch(/^workflow instance mismatch:/);

    // NOTHING reached the panel: the refusal is pre-dispatch, typed so the tool
    // layer's "nothing was applied" handling keys on the flag, not the text.
    expect(received).toEqual([]);
    expect(dispatchOutcomeOf(readErr)).toBe(false);
    expect(dispatchOutcomeOf(saveErr)).toBe(false);
    // The remedy is the documented one, and the message carries the stamp in the
    // shape panel-tools' auto-rebind reads back (issued for workflow instance <uuid>).
    expect(readErr!.message).toContain(`issued for workflow instance ${UUID_A}`);
    expect(readErr!.message).toContain('panel_set_workflow_target({mode:"current"})');

    // The recovery probe is EXEMPT — gating it would wedge the rebind that clears
    // this (panel #932's circularity).
    const probe = await bridge.send({ cmd: "workflow_list" }, { tabId: SCOPE });
    expect(probe).toEqual({ cmd: "workflow_list" });
    expect(received.map((f) => f.cmd)).toEqual(["workflow_list"]);

    // After the documented rebind adopts the live identity, the same calls dispatch.
    sessionStamp = UUID_B;
    const after = await bridge.send({ cmd: "graph_outline" }, { tabId: SCOPE });
    expect(after).toEqual({ cmd: "graph_outline" });
    expect(received.map((f) => f.cmd)).toEqual(["workflow_list", "graph_outline"]);
    expect(received[1].workflow_uuid).toBe(UUID_B);
    sock.close();
  });

  it("does NOT fire when either side is unreadable — an unknown is not divergence", async () => {
    advertised.set(TAB_A, UUID_A);
    // No session stamp at all: the frame ships unstamped and the PANEL's fence is
    // the judge (#718), exactly as before this gate existed.
    sessionStamp = undefined;
    const sock = await connectPanel(TAB_A);
    await waitFor(() => expect(bridge.tabs().map((t) => t.tab_id)).toContain(TAB_A));
    const res = await bridge.send({ cmd: "graph_outline" }, { tabId: SCOPE });
    expect(res).toEqual({ cmd: "graph_outline" });
    expect(received[0].workflow_uuid).toBeUndefined();
    sock.close();
  });
});
