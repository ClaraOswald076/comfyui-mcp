// #1519 — the write refusal promised that graph reads still work. For the state it
// was printed in, that was false.
//
// The reporter switched workflows and the very first live-canvas read came back
//
//   workflow instance mismatch: this command carries no workflow-instance stamp,
//   and the active canvas reports 2b3f4684-… Nothing was applied.
//
// The orchestrator strips the stamp when it has no trusted one, and the refusal it
// prints for a WRITE in that state ended with "Reads and view-only commands still
// work (graph_outline, graph_query, …)". A current panel refuses an UNSTAMPED
// command outright — reads included — because #718 closed that fail-open hole
// ("An UNSTAMPED command is refused too … an advertised fence must not fail open"),
// so the sentence named the exact command that was about to be refused.
//
// WHAT THIS FILE PINS, in both directions:
//
//   • fencing panel + NO trusted stamp   → the claim is withdrawn, and the one read
//     that genuinely still answers is named (workflow_list is fence-EXEMPT — it is
//     the panel's own recovery probe);
//   • no fence, or a fence WITH a stamp  → the original sentence is unchanged. The
//     predicate is the PAIR of facts, not "whichever branch wrote `why`", and an
//     over-broad edit that withdrew the claim from an old panel would be wrong in
//     the other direction: those panels really do execute reads.
//
// And the direction that matters most, asserted from the SOCKET rather than from the
// message: correcting a sentence must not turn into letting a write through. A
// mutating command with no stamp is still refused BEFORE anything is written, and a
// READ is still dispatched exactly as before — this change moves no fence.

import { createServer } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { UiBridge } from "../../services/ui-bridge.js";

let bridge: UiBridge;
const sockets: WebSocket[] = [];
let port = 0;

/** Same free-port strategy as ui-bridge.test.ts — a fixed range flakes on loaded
 *  Windows CI, and a lost bind race there surfaces as a misattributed failure. */
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

beforeEach(async () => {
  for (let attempt = 0; attempt < 6; attempt++) {
    port = await freePort();
    bridge = new UiBridge(port);
    bridge.start();
    if (await bridge.whenReady()) break;
    await bridge.stop();
  }
});

afterEach(async () => {
  for (const s of sockets.splice(0)) {
    try {
      s.close();
    } catch {
      /* already closed */
    }
  }
  await bridge?.stop();
});

/** A panel tab that advertises whatever `hello` says and answers NOTHING. Every
 *  frame the bridge writes to it is recorded, so "was this dispatched?" is answered
 *  by observation rather than inferred from the error text. */
async function connectPanel(
  tabId: string,
  hello: Record<string, unknown>,
): Promise<Array<Record<string, unknown>>> {
  const received: Array<Record<string, unknown>> = [];
  const sock = new WebSocket(`ws://127.0.0.1:${port}`);
  sockets.push(sock);
  await new Promise<void>((resolve, reject) => {
    sock.on("open", () => resolve());
    sock.on("error", reject);
  });
  sock.on("message", (raw) => {
    try {
      received.push(JSON.parse(String(raw)) as Record<string, unknown>);
    } catch {
      /* a non-JSON frame is not a command */
    }
  });
  sock.send(JSON.stringify({ type: "hello", tab_id: tabId, title: tabId, ...hello }));
  // Let the hello register before dispatching; the socket never replies after this.
  const deadline = Date.now() + 2000;
  while (!bridge.tabs().some((t) => t.tab_id === tabId)) {
    if (Date.now() > deadline) throw new Error(`tab ${tabId} never registered`);
    await new Promise((r) => setTimeout(r, 10));
  }
  return received;
}

/** The message `cmd` fails with. */
async function failureOf(cmd: string): Promise<string> {
  try {
    await bridge.send({ cmd }, { timeoutMs: 150 });
    return "<resolved — expected a refusal>";
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

const FENCING = { enforces_workflow_stamp: true, enforces_workflow_stamp_at_write: true };
const STAMP = "2b3f4684-b7e7-495b-a7a1-f40439e35e0a";
const OLD_CLAIM = /Reads and view-only commands still work/;
const WITHDRAWN = /GRAPH READS ARE REFUSED TOO/;

describe("a write refused for a missing stamp does not promise that reads still work (#1519)", () => {
  it("WITHDRAWS the claim when the panel fences and this side has no stamp", async () => {
    // #1519's exact state: a current panel, and a session whose fence was never
    // established (or was lost across the workflow switch).
    const received = await connectPanel("tmp:stampless", FENCING);
    const msg = await failureOf("graph_add_node");

    // Guard the guard — this must be the no-identity branch, not a capability one,
    // or every assertion below is true for the wrong reason.
    expect(msg).toMatch(/no trusted identity/);

    expect(msg).not.toMatch(OLD_CLAIM);
    expect(msg).toMatch(WITHDRAWN);
    // The reason, in the panel's own terms, so the refusal the caller is about to
    // read is recognisable as the same fact.
    expect(msg).toMatch(/carries no workflow-instance stamp/);
    // A reader that CAN answer: workflow_list is exempt from the panel's fence
    // precisely so a stale binding can be repaired.
    expect(msg).toMatch(/panel_list_workflows/);
    // It must NOT prescribe a remedy here. panel-tools' #1331 handler MEASURES which
    // no-identity state this is and can conclude that the rebind will NOT clear it;
    // a guess made here would contradict the answer that was checked.
    expect(msg).not.toMatch(/panel_set_workflow_target/);

    // …and nothing was written to the socket. The sentence changed; the gate did not.
    expect(received.filter((f) => f.cmd === "graph_add_node")).toEqual([]);
  });

  it("KEEPS the claim for an old panel with no fence at all", async () => {
    // The over-broad direction. A panel that does not advertise the fence executes
    // an unstamped read, so withdrawing the claim here would send a caller who still
    // has working reads looking for a problem they do not have.
    await connectPanel("tmp:oldpanel", {});
    const msg = await failureOf("graph_add_node");

    expect(msg).toMatch(/does not enforce per-command workflow targeting/);
    expect(msg).toMatch(OLD_CLAIM);
    expect(msg).not.toMatch(WITHDRAWN);
  });

  it("KEEPS the claim for a fencing panel that HAS a stamp — the predicate is the pair", async () => {
    // The case that proves this is decided from the two facts and not from which
    // branch happened to write `why`: the write is refused for a MISSING at-write
    // recheck, the dispatch-time fence is advertised, and the stamp is present — so
    // a read carries a stamp that matches the active canvas and runs.
    bridge.setTabWorkflowUuidResolver(() => STAMP);
    await connectPanel("tmp:atwrite", { enforces_workflow_stamp: true });
    const msg = await failureOf("graph_add_node");

    expect(msg).toMatch(/does not recheck workflow targeting at the graph write boundary/);
    expect(msg).toMatch(OLD_CLAIM);
    expect(msg).not.toMatch(WITHDRAWN);
  });
});

describe("the #1519 correction moves no fence", () => {
  it("still REFUSES a mutating command with no stamp, before anything is written", async () => {
    // The direction a message-only fix must never drift in. Asserted per command and
    // from the socket: a fence bypass would show up as a frame, not as wording.
    const received = await connectPanel("tmp:mutations", FENCING);

    for (const cmd of [
      "graph_add_node",
      "graph_remove_node",
      "graph_set_widget",
      "graph_connect",
      "workflow_save",
      "workflow_close",
    ]) {
      const msg = await failureOf(cmd);
      expect(msg, cmd).toMatch(/cannot be safely targeted to the active workflow/);
      expect(msg, cmd).toMatch(/no trusted identity/);
      expect(received.filter((f) => f.cmd === cmd), cmd).toEqual([]);
    }
  });

  it("still DISPATCHES an unstamped read, unstamped — the orchestrator did not start refusing reads", async () => {
    // The other half of "no behaviour change". Refusing reads locally was one of the
    // options #1519 records as open; this change does not take it. The read is still
    // written to the socket, still without a workflow_uuid (the stamp is BRIDGE-owned
    // and there is no trusted one), and it is the PANEL that decides its fate.
    const received = await connectPanel("tmp:reads", FENCING);
    const msg = await failureOf("graph_outline");

    // It reached the socket and was never answered — a reply timeout, not a refusal.
    expect(msg).toMatch(/did not reply to "graph_outline"/);
    const frames = received.filter((f) => f.cmd === "graph_outline");
    expect(frames.length).toBe(1);
    expect(frames[0]).not.toHaveProperty("workflow_uuid");
  });
});
