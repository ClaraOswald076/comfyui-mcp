// #952 (panel) — an interactive question card was told to go and check the
// render queue.
//
// `panel_ask` was interrupted by a tab disconnect and the OUTCOME UNKNOWN error
// ended with the only remedy this path had: check `queue action:"list"` /
// `get_image (action:"list_outputs")`. Neither can observe whether a question is
// on a human's screen. The reporter said so plainly, and they were right.
//
// The panel-side trace on that issue supplies the fact that makes this more than
// wording: for THIS trigger a blind retry really does duplicate the card. The
// dedupe ledger is keyed by the socket's bridge epoch; a reconnect mints a new
// one; the retry lands in a different scope, `lookupRetry` misses, and it fails
// open and re-executes. Failing open is correct for a read or an idempotent
// write. For a question it means a second card in front of a person, and there
// is no way to withdraw the first.

import { describe, expect, it } from "vitest";

import {
  isInteractiveCommand,
  midCommandDisconnectMessage,
  midCommandVerifyClause,
} from "../../services/mid-command-remedy.js";

const ASK = { short: "wf:728f6", cmd: "ask_user" };
const RUN = { short: "wf:728f6", cmd: "graph_run" };

describe("the disconnect remedy fits what was interrupted (#952)", () => {
  it("an ask card is NOT sent to the render queue — the reporter's complaint", () => {
    const msg = midCommandDisconnectMessage(ASK);
    expect(msg).not.toMatch(/queue action:"list"/);
    expect(msg).not.toMatch(/list_outputs/);
  });

  it("…and says the thing that is actually true of it", () => {
    const msg = midCommandDisconnectMessage(ASK);
    expect(msg).toMatch(/card may already be on screen/);
    // The fact from the panel trace: a retry is not merely unverifiable, it is
    // known to duplicate after a reconnect.
    expect(msg).toMatch(/paints a SECOND card/);
    expect(msg).toMatch(/cannot be withdrawn/);
  });

  it("names what the caller CAN do, since it forbids the obvious move", () => {
    // A refusal with no alternative is how an agent ends up retrying anyway.
    const msg = midCommandDisconnectMessage(ASK);
    expect(msg).toMatch(/Prefer to wait/);
    expect(msg).toMatch(/ask the question directly in conversation/);
  });

  it("does NOT invent a recovery that does not exist", () => {
    // There is no pending-card query, and `retry_of` does not survive the
    // reconnect this message is about. Both are open design questions on the
    // issue; promising either would send the caller to something that fails.
    const msg = midCommandDisconnectMessage(ASK);
    expect(msg).toMatch(/there is no pending-card query/);
    expect(msg).not.toMatch(/retry_of/);
  });

  it("request_secret is interactive too — same human, same duplicate", () => {
    expect(isInteractiveCommand("request_secret")).toBe(true);
    expect(midCommandDisconnectMessage({ short: "wf:1", cmd: "request_secret" })).toMatch(
      /card may already be on screen/,
    );
  });

  it("every OTHER command keeps the queue/output check — it is real evidence there", () => {
    const msg = midCommandDisconnectMessage(RUN);
    expect(msg).toMatch(/queue action:"list"/);
    expect(msg).toMatch(/list_outputs/);
    expect(msg).toMatch(/ComfyUI may already be rendering/);
    expect(msg).not.toMatch(/card may already be on screen/);
  });

  it("still reports OUTCOME UNKNOWN and the tab, whichever branch it takes", () => {
    // The parts callers and the existing detectors key on must not move: several
    // call sites match /disconnected mid-command|OUTCOME UNKNOWN/.
    for (const ctx of [ASK, RUN]) {
      const msg = midCommandDisconnectMessage(ctx);
      expect(msg, ctx.cmd).toMatch(/disconnected mid-command \("/);
      expect(msg).toMatch(/OUTCOME UNKNOWN/);
      expect(msg).toContain(ctx.short);
      expect(msg).toContain(ctx.cmd);
    }
  });

  it("an unknown or malformed command is treated as NON-interactive", () => {
    // Fail toward the existing behaviour: the queue/output advice is merely
    // unhelpful for something else, while claiming "a card may be on screen"
    // about a write would be false.
    for (const cmd of ["", "   ", "graph_add_node", "ask_user_extra"]) {
      expect(isInteractiveCommand(cmd), cmd).toBe(false);
    }
    expect(midCommandVerifyClause("graph_add_node")).toMatch(/queue action:"list"/);
  });
});

describe("WIRING: the bridge uses it (#952)", () => {
  it("the mid-command disconnect path builds its message here", async () => {
    // The helper is worthless if the bridge keeps its own hardcoded string, and
    // the branch is inside a long method that no unit test constructs.
    const { readFile } = await import("node:fs/promises");
    const src = await readFile(new URL("../../services/ui-bridge.ts", import.meta.url), "utf-8");
    expect(src).toContain('import { midCommandDisconnectMessage } from "./mid-command-remedy.js"');
    expect(src).toContain("midCommandDisconnectMessage({ short, cmd })");
    // …and the old hardcoded remedy is gone from the mutating branch.
    expect(src).not.toMatch(
      /OUTCOME UNKNOWN: the command was already sent, so the panel may have applied it/,
    );
  });
});
