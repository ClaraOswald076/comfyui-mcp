// #2069 — panel_get_errors timed out at 30 000 ms while concurrent read-only
// panel operations against the SAME live tab (panel_query_graph, panel_graph_outline,
// panel_screenshot) completed. The tab was neither backgrounded nor frozen: the
// siblings returned current live state. graph_get_errors is the long graph read,
// and concurrent graph frames on one tab can leave it unanswered.
//
// The property under test is the SHIPPED tool: these run the real panel_get_errors
// def (and the reporter's sibling tools) against a real UiBridge + a mock panel
// that drops graph_get_errors when it arrives in the same burst as other graph
// reads — the collision the live frontend exhibits. Serialization in send() is
// what makes that mock answer. The timeout diagnosis is the message dispatch()
// actually mints, not a reimplementation of it.

import { createServer } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { UiBridge, isReplyTimeoutTagged } from "../../services/ui-bridge.js";
import { buildPanelToolDefs, makePanelToolCtx, type ToolResult } from "../../orchestrator/panel-tools.js";
import { WorkflowTargetStore } from "../../services/workflow-target-store.js";
import { waitFor } from "../helpers/wait-for.js";

const TAB = "wf:workflows/video_minimax_h3_i2v.json";
const WORKFLOW_UUID = "11111111-1111-4111-8111-111111111111";
const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

let bridge: UiBridge;
let port: number;

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

async function startBridge(): Promise<void> {
  let lastErr = "no attempt made";
  for (let attempt = 0; attempt < 6; attempt++) {
    port = await freePort();
    bridge = new UiBridge(port);
    bridge.start();
    if (await bridge.whenReady()) {
      bridge.setTabWorkflowUuidResolver(() => WORKFLOW_UUID);
      return;
    }
    lastErr = `bind to ${port} lost a close→rebind race`;
    await bridge.stop();
  }
  throw new Error(`could not bind a free bridge port after 6 attempts: ${lastErr}`);
}

function connectPanel(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(`ws://127.0.0.1:${port}`);
    sock.on("open", () => {
      sock.send(
        JSON.stringify({
          type: "hello",
          tab_id: TAB,
          title: "video_minimax_h3_i2v",
          enforces_workflow_stamp: true,
          enforces_workflow_stamp_at_write: true,
        }),
      );
      resolve(sock);
    });
    sock.on("error", reject);
  });
}

function viewing() {
  return { kind: "root", workflow: "video_minimax_h3_i2v.json", workflow_uuid: WORKFLOW_UUID };
}

function replyBody(cmd: string): Record<string, unknown> {
  if (cmd === "graph_screenshot") return { image: PNG_1X1, mimeType: "image/png" };
  if (cmd === "graph_get_errors") {
    return {
      viewing: viewing(),
      node_count: 3,
      errored_count: 0,
      nodes: [],
      last_execution_error: null,
      node_errors: null,
    };
  }
  if (cmd === "graph_outline") {
    return { viewing: viewing(), outline: "1 KSampler", node_count: 1 };
  }
  if (cmd === "graph_query") {
    return { viewing: viewing(), nodes: [{ id: 1, type: "KSampler" }], node_count: 1 };
  }
  if (cmd === "graph_serialize") return { nodes: [] };
  if (cmd === "get_todo") return { items: [] };
  return { cmd, ok: true };
}

/** Drop graph_get_errors when it shares a burst with other graph_* frames —
 *  the collision the live panel exhibits under concurrent reads. */
function attachCollisionPanel(sock: WebSocket): { dropped: string[]; received: string[] } {
  const dropped: string[] = [];
  const received: string[] = [];
  let batch: Array<Record<string, unknown>> = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    timer = null;
    const msgs = batch;
    batch = [];
    const siblingGraph = msgs.some(
      (m) => typeof m.cmd === "string" && m.cmd.startsWith("graph_") && m.cmd !== "graph_get_errors",
    );
    for (const msg of msgs) {
      if (typeof msg.rid !== "string" || typeof msg.cmd !== "string") continue;
      if (msg.cmd === "graph_get_errors" && siblingGraph) {
        dropped.push(msg.cmd);
        continue;
      }
      sock.send(JSON.stringify({ rid: msg.rid, ok: true, result: replyBody(msg.cmd) }));
    }
  };
  sock.on("message", (buf) => {
    const msg = JSON.parse(buf.toString()) as Record<string, unknown>;
    if (typeof msg.rid !== "string" || typeof msg.cmd !== "string") return;
    received.push(msg.cmd);
    batch.push(msg);
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, 15);
  });
  return { dropped, received };
}

function defByName(name: string) {
  const def = buildPanelToolDefs().find((d) => d.name === name);
  if (!def) throw new Error(`tool ${name} is not registered`);
  return def;
}

const textOf = (res: ToolResult): string =>
  res.content.map((c) => (c as { text?: string }).text ?? "").join(" ");

beforeEach(async () => {
  await startBridge();
});

afterEach(async () => {
  await bridge.stop();
});

describe("panel_get_errors during concurrent panel reads (#2069)", () => {
  it("returns on a live tab while query/outline/screenshot run in the same burst", async () => {
    const sock = await connectPanel();
    const { dropped } = attachCollisionPanel(sock);
    await waitFor(() => expect(bridge.canReach(TAB)).toBe(true));

    const ctx = makePanelToolCtx(bridge, TAB, new WorkflowTargetStore());
    const [query, outline, errors, screenshot] = await Promise.all([
      defByName("panel_query_graph").handler({ ids: [1], fields: "ids" } as never, ctx),
      defByName("panel_graph_outline").handler({} as never, ctx),
      defByName("panel_get_errors").handler({} as never, ctx),
      defByName("panel_screenshot").handler({} as never, ctx),
    ]);

    expect(dropped).toEqual([]);
    expect(query.isError).not.toBe(true);
    expect(outline.isError).not.toBe(true);
    expect(screenshot.isError).not.toBe(true);
    expect(errors.isError).not.toBe(true);
    expect(textOf(errors)).not.toMatch(/did not reply/);
    expect(textOf(errors)).not.toMatch(/backgrounded or frozen/);
    const payload = JSON.parse(textOf(errors)) as Record<string, unknown>;
    expect(typeof payload.errored_count).toBe("number");
    sock.close();
  });

  it("does not write graph_get_errors until a sibling graph read on the tab has been answered", async () => {
    const sock = await connectPanel();
    const order: string[] = [];
    sock.on("message", (buf) => {
      const msg = JSON.parse(buf.toString()) as Record<string, unknown>;
      if (typeof msg.rid !== "string" || typeof msg.cmd !== "string") return;
      order.push(`recv:${msg.cmd}`);
      setTimeout(() => {
        order.push(`ack:${msg.cmd}`);
        sock.send(JSON.stringify({ rid: msg.rid, ok: true, result: replyBody(msg.cmd) }));
      }, 20);
    });
    await waitFor(() => expect(bridge.canReach(TAB)).toBe(true));

    const ctx = makePanelToolCtx(bridge, TAB, new WorkflowTargetStore());
    await Promise.all([
      defByName("panel_query_graph").handler({ ids: [1], fields: "ids" } as never, ctx),
      defByName("panel_get_errors").handler({} as never, ctx),
    ]);

    expect(order.filter((e) => e === "recv:graph_get_errors").length).toBeGreaterThan(0);
    let inflight = 0;
    for (const e of order) {
      if (e.startsWith("recv:graph_")) {
        expect(inflight, `overlapping graph recv: ${order.join(" ")}`).toBe(0);
        inflight += 1;
      } else if (e.startsWith("ack:graph_")) {
        inflight = Math.max(0, inflight - 1);
      }
    }
    sock.close();
  });

  it("a no-reply timeout does not claim the tab is frozen when a sibling on the same tab just answered", async () => {
    const sock = await connectPanel();
    sock.on("message", (buf) => {
      const msg = JSON.parse(buf.toString()) as Record<string, unknown>;
      if (typeof msg.rid !== "string" || typeof msg.cmd !== "string") return;
      if (msg.cmd === "graph_get_errors") return;
      sock.send(JSON.stringify({ rid: msg.rid, ok: true, result: replyBody(msg.cmd) }));
    });
    await waitFor(() => expect(bridge.canReach(TAB)).toBe(true));

    const todo = bridge.send({ cmd: "get_todo" }, { tabId: TAB, timeoutMs: 1000 });
    const errors = bridge.send({ cmd: "graph_get_errors" }, { tabId: TAB, timeoutMs: 180 });
    await expect(todo).resolves.toMatchObject({ items: [] });
    await expect(errors).rejects.toSatisfy((err: unknown) => {
      expect(isReplyTimeoutTagged(err)).toBe(true);
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).toMatch(/did not reply to "graph_get_errors"/);
      expect(msg).toMatch(/the tab is not frozen/);
      expect(msg).toMatch(/answered "get_todo"/);
      expect(msg).not.toMatch(/backgrounded or frozen/);
      return true;
    });
    sock.close();
  });

  it("a no-reply timeout still names a frozen tab when nothing else answered", async () => {
    const sock = await connectPanel();
    await waitFor(() => expect(bridge.canReach(TAB)).toBe(true));
    await expect(
      bridge.send({ cmd: "graph_get_errors" }, { tabId: TAB, timeoutMs: 80 }),
    ).rejects.toSatisfy((err: unknown) => {
      expect(isReplyTimeoutTagged(err)).toBe(true);
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).toMatch(/did not reply to "graph_get_errors"/);
      expect(msg).toMatch(/the ComfyUI tab may be backgrounded or frozen/);
      expect(msg).not.toMatch(/the tab is not frozen/);
      return true;
    });
    sock.close();
  });
});
