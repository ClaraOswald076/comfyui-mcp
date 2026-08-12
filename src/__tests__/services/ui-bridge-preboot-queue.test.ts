// #1411 — A MESSAGE SENT BEFORE THE ORCHESTRATOR FINISHES STARTING IS NOT GONE.
//
// The bridge binds its port and accepts frames several seconds before the
// orchestrator installs `onPanelMessage` (measured: listening at T+0.0s, ready at
// T+3.7s). Every frame in that window used to be accepted, stamped, echoed into
// the panel transcript, and then dropped by an optional-call on a null handler —
// no queue, no ack, no error. The user watches their own message appear and
// nothing happen, which reads as the agent ignoring them.
//
// A real panel reaches this window whenever the orchestrator restarts with the
// sidebar open: a self-restart on rebuild, a crash restart, a machine waking.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createServer } from "node:net";
import { UiBridge } from "../../services/ui-bridge.js";
import type { PanelEvent } from "../../services/ui-bridge.js";

let bridge: UiBridge;

beforeEach(() => {
  bridge = new UiBridge(0); // no listen() — this is about the handler, not the port
});

afterEach(() => {
  bridge.onPanelMessage = null;
});

/** The private dispatch the socket handlers call. Reached directly so the test is
 *  about the queue rather than about WebSocket timing. */
function deliver(ev: PanelEvent): void {
  (bridge as unknown as { deliverPanelEvent: (e: PanelEvent) => void }).deliverPanelEvent(ev);
}

const msg = (text: string): PanelEvent =>
  ({ type: "user_message", tab_id: "wf:a.json", text }) as unknown as PanelEvent;

describe("#1411 frames that arrive before the handler exists", () => {
  it("are DELIVERED once the handler is installed, not dropped", async () => {
    deliver(msg("the message the user typed during boot"));
    expect(bridge.preHandlerBacklog().held).toBe(1);

    const seen: string[] = [];
    bridge.onPanelMessage = (e) => void seen.push((e as unknown as { text: string }).text);

    expect(seen).toEqual(["the message the user typed during boot"]);
    expect(bridge.preHandlerBacklog().held).toBe(0);
  });

  it("arrive in the order the panel SENT them — hello before message", async () => {
    // Reordering would hand the orchestrator a message for a tab it has not been
    // told about, which is a different bug than the one being fixed.
    deliver({ type: "hello", tab_id: "wf:a.json" } as unknown as PanelEvent);
    deliver(msg("first"));
    deliver(msg("second"));

    const seen: string[] = [];
    bridge.onPanelMessage = (e) => {
      const ev = e as unknown as { type: string; text?: string };
      seen.push(ev.type === "hello" ? "hello" : (ev.text ?? "?"));
    };

    expect(seen).toEqual(["hello", "first", "second"]);
  });

  it("are delivered ONCE — a second handler assignment does not replay them", async () => {
    deliver(msg("only once"));
    const first: string[] = [];
    bridge.onPanelMessage = (e) => void first.push((e as unknown as { text: string }).text);
    const second: string[] = [];
    bridge.onPanelMessage = (e) => void second.push((e as unknown as { text: string }).text);

    expect(first).toEqual(["only once"]);
    expect(second).toEqual([]); // the queue was emptied by the first assignment
  });

  it("do not queue at all once a handler exists — delivery stays synchronous", async () => {
    const seen: string[] = [];
    bridge.onPanelMessage = (e) => void seen.push((e as unknown as { text: string }).text);

    deliver(msg("live"));

    expect(seen).toEqual(["live"]);
    expect(bridge.preHandlerBacklog().held).toBe(0);
  });

  it("setting the handler to null does not drop what is already held", async () => {
    deliver(msg("held"));
    bridge.onPanelMessage = null; // the cleanup pattern used across the suite
    expect(bridge.preHandlerBacklog().held).toBe(1);

    const seen: string[] = [];
    bridge.onPanelMessage = (e) => void seen.push((e as unknown as { text: string }).text);
    expect(seen).toEqual(["held"]);
  });

  it("one frame that THROWS does not strand the frames behind it", async () => {
    // The user's message must not be lost because an earlier hello blew up.
    deliver({ type: "hello", tab_id: "wf:a.json" } as unknown as PanelEvent);
    deliver(msg("must still arrive"));

    const seen: string[] = [];
    bridge.onPanelMessage = (e) => {
      const ev = e as unknown as { type: string; text?: string };
      if (ev.type === "hello") throw new Error("hello handler blew up");
      seen.push(ev.text ?? "?");
    };

    expect(seen).toEqual(["must still arrive"]);
  });
});

describe("#1411 the queue is BOUNDED, and says so", () => {
  it("refuses past the cap rather than growing without limit", async () => {
    // Nothing guarantees a handler is ever installed; an unbounded buffer would be
    // its own bug, quieter than the one being fixed.
    for (let i = 0; i < 250; i++) deliver(msg(`m${i}`));

    const { held, dropped } = bridge.preHandlerBacklog();
    expect(held).toBe(200);
    expect(dropped).toBe(50);
  });

  it("keeps the EARLIEST frames — the hello that identifies the tab is in them", async () => {
    deliver({ type: "hello", tab_id: "wf:a.json" } as unknown as PanelEvent);
    for (let i = 0; i < 250; i++) deliver(msg(`m${i}`));

    const seen: string[] = [];
    bridge.onPanelMessage = (e) => {
      const ev = e as unknown as { type: string; text?: string };
      seen.push(ev.type === "hello" ? "hello" : (ev.text ?? "?"));
    };

    expect(seen[0]).toBe("hello");
    expect(seen).toHaveLength(200);
    expect(seen).not.toContain("m199"); // refused, because the cap was already reached
  });

  it("clears the refusal count once it has been reported", async () => {
    for (let i = 0; i < 210; i++) deliver(msg(`m${i}`));
    expect(bridge.preHandlerBacklog().dropped).toBe(10);

    bridge.onPanelMessage = () => {};
    expect(bridge.preHandlerBacklog().dropped).toBe(0);
  });
});

/** A free port, the way the sibling suite finds one. */
async function freePort(): Promise<number> {
  return await new Promise((resolve) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

describe("#1411 over a REAL socket — the wiring, not just the queue", () => {
  // The tests above reach deliverPanelEvent directly, so they would all still pass
  // if the socket handlers went back to `this.onPanelMessage?.(…)` and dropped
  // everything. This is the one that fails if they do.
  it("a user_message sent BEFORE the handler is installed still arrives", async () => {
    const port = await freePort();
    const live = new UiBridge(port);
    live.start();
    expect(await live.whenReady()).toBe(true);
    try {
      const sock = new WebSocket(`ws://127.0.0.1:${port}`);
      await new Promise<void>((r) => sock.on("open", () => r()));

      // Exactly the reported sequence: the panel connects and talks while the
      // orchestrator is still starting, so NO handler exists yet.
      sock.send(JSON.stringify({ type: "hello", tab_id: "wf:a.json", title: "a" }));
      sock.send(JSON.stringify({ type: "user_message", tab_id: "wf:a.json", text: "hello?" }));
      await new Promise((r) => setTimeout(r, 150));

      expect(live.preHandlerBacklog().held).toBeGreaterThan(0);

      // Boot finishes.
      const seen: Array<{ type: string; text?: string }> = [];
      live.onPanelMessage = (e) => void seen.push(e as unknown as { type: string; text?: string });

      const user = seen.find((e) => e.type === "user_message");
      expect(user, "the message the user typed during boot").toBeTruthy();
      expect(user!.text).toBe("hello?");
      // The hello matters as much: it is what tells the orchestrator this tab
      // exists, and a message delivered for a tab it was never told about is a
      // different bug. Its dispatch site is separate, so it needs its own
      // assertion — without this, reverting only that site passes everything.
      const hello = seen.find((e) => e.type === "hello");
      expect(hello, "the hello that identifies the tab").toBeTruthy();
      expect(seen.indexOf(hello!)).toBeLessThan(seen.indexOf(user!));
      sock.close();
    } finally {
      live.onPanelMessage = null;
      await live.stop?.();
    }
  });
});
