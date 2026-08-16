// artokun/comfyui-mcp#1560 (review, P1) — "the panel is not answering" must be a
// MEASUREMENT, not a synonym for `isError`.
//
// The fix for #1560 makes `panel_open_workflow`'s post-open probe report a
// fence-exempt `workflow_list` that never came back, and prescribe a hard refresh of
// the ComfyUI tab. Review found it deciding that from `isError` alone — and an
// ACKNOWLEDGED panel error is `isError` too: the tab received the command, ran it,
// and replied refusing it. A panel that is demonstrably talking would be announced as
// silent and its user sent to hard-refresh a healthy tab, which is exactly the
// unmeasured claim #1560 is about, pointed the other way.
//
// WHY NOT THE MESSAGE. Acknowledged panel errors travel as arbitrary `msg.error`
// text, so any sentence one class writes the other can contain — the same reasoning
// that reverted the #1529 prose predicate as a P0. And the panel is TRANSLATED: a
// rule matching English words answers wrongly for eleven of twelve locales, silently.
//
// So the bridge states it structurally at the one branch that RECEIVES a reply, and
// this pins both halves — that the mark is minted where it is claimed to be (through
// a real socket, not a source scan), and that it cannot be manufactured by a polluted
// prototype.

import { createServer } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";

import {
  PANEL_ANSWERED_PROP,
  attachPanelAnswered,
  inheritPanelAnswered,
  isPanelAnsweredError,
} from "../../services/panel-answered.js";
import { UiBridge } from "../../services/ui-bridge.js";

describe("the mark is OWN-property only (#1560)", () => {
  it("reads back what the bridge attached", () => {
    expect(isPanelAnsweredError(attachPanelAnswered(new Error("node not found")))).toBe(true);
  });

  it("an unmarked error claims nothing", () => {
    expect(isPanelAnsweredError(new Error("did not reply within 6000 ms"))).toBe(false);
    for (const junk of [null, undefined, "x", 42, {}, []]) {
      expect(isPanelAnsweredError(junk), String(junk)).toBe(false);
    }
  });

  it("an INHERITED mark cannot silence a genuine no-answer report", () => {
    // The direction that matters: a polluted prototype (or a library that decorates
    // Error) marking every failure as answered would restore the reporter's dead end
    // — the silence swallowed again, with nothing said about the channel.
    Object.defineProperty(Error.prototype, PANEL_ANSWERED_PROP, {
      value: true,
      configurable: true,
      writable: true,
      enumerable: false,
    });
    try {
      const timedOut = new Error('Panel tab wf:a did not reply to "workflow_list" within 6000 ms');
      expect((timedOut as unknown as Record<string, unknown>)[PANEL_ANSWERED_PROP]).toBe(true);
      expect(isPanelAnsweredError(timedOut), "inherited must not read as answered").toBe(false);
    } finally {
      delete (Error.prototype as unknown as Record<string, unknown>)[PANEL_ANSWERED_PROP];
    }
    expect(PANEL_ANSWERED_PROP in Error.prototype).toBe(false);
  });

  it("a swapped hasOwnProperty cannot answer for the check", () => {
    // #1529's P0 shape. The module binds the intrinsic at load, so the object under
    // test never gets to answer the question asked about it.
    const realHasOwn = Object.prototype.hasOwnProperty;
    let inherited: boolean | undefined;
    let genuine: boolean | undefined;
    let swapWasLive = false;
    Object.defineProperty(Error.prototype, PANEL_ANSWERED_PROP, {
      value: true,
      configurable: true,
      writable: true,
      enumerable: false,
    });
    Object.defineProperty(Object.prototype, "hasOwnProperty", {
      value: () => true,
      configurable: true,
      writable: true,
      enumerable: false,
    });
    try {
      swapWasLive = realHasOwn.call({}, "nope") === false && {}.hasOwnProperty("nope") === true;
      inherited = isPanelAnsweredError(new Error("the socket died mid-command"));
      genuine = isPanelAnsweredError(attachPanelAnswered(new Error("x")));
    } finally {
      Object.defineProperty(Object.prototype, "hasOwnProperty", {
        value: realHasOwn,
        configurable: true,
        writable: true,
        enumerable: false,
      });
      delete (Error.prototype as unknown as Record<string, unknown>)[PANEL_ANSWERED_PROP];
    }
    expect(swapWasLive, "the swap was in place").toBe(true);
    expect(inherited, "an inherited mark must not read as answered").toBe(false);
    expect(genuine, "a real mark must still read under the swap").toBe(true);
  });

  it("a NON-true own value is not a mark", () => {
    const err = new Error("x");
    Object.defineProperty(err, PANEL_ANSWERED_PROP, { value: "yes", configurable: true });
    expect(isPanelAnsweredError(err)).toBe(false);
  });

  it("attaching never collides with Error's own fields, and survives a frozen prototype slot", () => {
    // Assignment would THROW in strict mode against a non-writable prototype
    // property, turning a clear panel error into an unrelated TypeError.
    Object.defineProperty(Error.prototype, PANEL_ANSWERED_PROP, {
      value: false,
      configurable: true,
      writable: false,
      enumerable: false,
    });
    try {
      const err = attachPanelAnswered(new Error("boom"));
      expect(err.message).toBe("boom");
      expect(isPanelAnsweredError(err)).toBe(true);
    } finally {
      delete (Error.prototype as unknown as Record<string, unknown>)[PANEL_ANSWERED_PROP];
    }
  });

  it("inheritPanelAnswered carries the mark across a SUBSTITUTED error, and only then", () => {
    // The bridge rewrites an old panel's "Unknown command" reply into an actionable
    // update-your-panel error. That rewrite is still a reply.
    const answered = attachPanelAnswered(new Error('Unknown command "workflow_list"'));
    expect(isPanelAnsweredError(inheritPanelAnswered(answered, new Error("update your panel")))).toBe(
      true,
    );
    expect(isPanelAnsweredError(inheritPanelAnswered(new Error("no reply"), new Error("x")))).toBe(
      false,
    );
  });
});

// ── REACHABILITY. The library is worthless if the branch that receives a reply does
//    not mint the mark, and that branch lives inside the socket message loop. Driven
//    through a real WebSocket rather than asserted against the source, so this fails
//    if the attachment is deleted OR if the reply never reaches it.

let bridge: UiBridge;
let sock: WebSocket;
const TAB = "tab-answers";

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
  let port = 0;
  for (let attempt = 0; attempt < 6; attempt++) {
    port = await freePort();
    bridge = new UiBridge(port);
    bridge.start();
    if (await bridge.whenReady()) break;
    await bridge.stop();
  }
  sock = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((resolve, reject) => {
    sock.on("open", () => resolve());
    sock.on("error", reject);
  });
  sock.send(
    JSON.stringify({
      type: "hello",
      tab_id: TAB,
      title: "answers",
      enforces_workflow_stamp: true,
      enforces_workflow_stamp_at_write: true,
    }),
  );
  await new Promise((r) => setTimeout(r, 60));
});

afterEach(async () => {
  try {
    sock?.close();
  } catch {
    /* already closed */
  }
  await bridge?.stop();
});

describe("the bridge marks a RECEIVED reply, and nothing else (#1560)", () => {
  it("an ok:false reply rejects with an error that says the panel answered", async () => {
    // The panel served the command and refused it. Everything a caller can see about
    // this failure is the same as a timeout's — except this.
    sock.on("message", (raw) => {
      const msg = JSON.parse(String(raw)) as { rid?: string; cmd?: string };
      if (!msg.rid || !msg.cmd) return;
      sock.send(
        JSON.stringify({
          rid: msg.rid,
          ok: false,
          // Deliberately worded like a silence, to prove nothing reads the text.
          error: "the panel did not answer the workflow store in time",
        }),
      );
    });

    const err = await bridge
      .send({ cmd: "workflow_list" }, { tabId: TAB, timeoutMs: 3000 })
      .then(() => null)
      .catch((e: unknown) => e);

    expect(err, "the refusal must still reject").toBeInstanceOf(Error);
    expect((err as Error).message).toContain("the panel did not answer the workflow store in time");
    expect(isPanelAnsweredError(err), "a served reply is an ANSWER").toBe(true);
  });

  it("a reply that never comes carries no mark — a silence stays a silence", async () => {
    // The reporter's own state. The socket is live and the tab says nothing.
    const err = await bridge
      .send({ cmd: "workflow_list" }, { tabId: TAB, timeoutMs: 250 })
      .then(() => null)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/did not reply to "workflow_list"/);
    expect(isPanelAnsweredError(err), "nothing answered, so nothing may claim it did").toBe(false);
  });

  it("a REWRITTEN Unknown-command reply still says the panel answered", async () => {
    // The bridge substitutes its own actionable "update your panel" error for an old
    // panel's raw `Unknown command` reply. That rewrite is still a REPLY — the tab
    // answered, it just answered that it does not know the command — so the mark has
    // to survive the substitution. Without this the call site is untested and only
    // the helper is: deleting the propagation kills nothing.
    sock.on("message", (raw) => {
      const msg = JSON.parse(String(raw)) as { rid?: string; cmd?: string };
      if (!msg.rid || !msg.cmd) return;
      sock.send(
        JSON.stringify({ rid: msg.rid, ok: false, error: `Unknown command "${msg.cmd}"` }),
      );
    });

    const err = await bridge
      .send({ cmd: "workflow_list" }, { tabId: TAB, timeoutMs: 3000 })
      .then(() => null)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    // The substitution REALLY happened — otherwise this test would pass on the
    // pass-through path and prove nothing about the propagation.
    expect((err as Error).message).toMatch(/does not implement "workflow_list"|too old for/);
    expect((err as Error).message).not.toContain("Unknown command");
    expect(isPanelAnsweredError(err), "a rewritten reply is still a reply").toBe(true);
  });

  it("an ok:true reply is not an error at all", async () => {
    sock.on("message", (raw) => {
      const msg = JSON.parse(String(raw)) as { rid?: string; cmd?: string };
      if (!msg.rid || !msg.cmd) return;
      sock.send(JSON.stringify({ rid: msg.rid, ok: true, result: { workflows: [] } }));
    });
    await expect(bridge.send({ cmd: "workflow_list" }, { tabId: TAB, timeoutMs: 3000 })).resolves.toEqual({
      workflows: [],
    });
  });
});
