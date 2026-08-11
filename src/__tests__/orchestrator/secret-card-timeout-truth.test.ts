// #1352 — a secret card that times out was reported as a possibly-frozen tab.
//
// `panel_request_secret` blocks up to 300s on a MASKED INPUT, and its catch relayed the
// bridge's generic no-reply message:
//
//   Panel tab … did not reply to "request_secret" within 300000 ms — the ComfyUI tab
//   may be backgrounded or frozen
//
// For every other command that is the right sentence. Here it accuses the tab of a
// fault it almost certainly does not have: the likely cause is that a human is still
// typing, having gone to a password manager or a billing console for the token. Same
// defect as #1332 — a mechanical outcome narrated as somebody's decision or a fault.
//
// AND IT HAS TO SAY WHAT HAPPENS TO A LATE VALUE, because that is the question the
// caller will have. MEASURED, not assumed: this card is sent as a raw `request_secret`
// command with NO ask_id, and the late-reply buffer (takeLateAskReply) is keyed BY ask
// id — so a value typed after the timeout has no route back to this call. Saying "it
// may still arrive" would leave the user waiting for a save that cannot happen.
//
// THE 300s BUDGET IS NOT TOUCHED. PANEL_TOOL_MCP_TIMEOUT_MS (315s) is sized above this
// card so an internal MCP client does not kill the request first (#325); moving one
// means moving the other, which is the design decision #1352 is really asking for.

import { describe, expect, it } from "vitest";

import {
  buildPanelToolDefs,
  makePanelToolCtx,
  type PanelToolCtx,
  type ToolResult,
} from "../../orchestrator/panel-tools.js";
import { WorkflowTargetStore } from "../../services/workflow-target-store.js";

const TAB = "wf:workflows/a.json";

/** The bridge's real no-reply wording, which is what used to reach the caller. */
const REPLY_TIMEOUT = () =>
  new Error(
    `Panel tab ${TAB} did not reply to "request_secret" within 300000 ms — the ComfyUI tab ` +
      `may be backgrounded or frozen`,
  );

function bridge(fail: Error) {
  return {
    send: async () => {
      throw fail;
    },
    push: () => 1,
    canReach: () => true,
    isHeadless: () => false,
    tabs: () => [{ tab_id: TAB, title: "wf", connected_at: 0 }],
    resolveActiveTabId: () => TAB,
    tabCanMutateGraph: () => true,
    tabGraphMutationCapability: () => ({ known: true, canMutate: true }),
  } as unknown as PanelToolCtx["bridge"];
}

async function requestSecret(fail: Error): Promise<string> {
  const ctx = makePanelToolCtx(bridge(fail), TAB, new WorkflowTargetStore());
  const def = buildPanelToolDefs().find((d) => d.name === "panel_request_secret");
  if (!def) throw new Error("panel_request_secret is not registered");
  const res: ToolResult = await def.handler(
    { mcp_server: "comfyui", label: "CivitAI token", key: "CIVITAI_API_TOKEN" } as never,
    ctx,
  );
  return res.content.map((c) => (c as { text?: string }).text ?? "").join(" ");
}

describe("a timed-out secret card is described honestly (#1352)", () => {
  it("does not accuse the tab of being frozen, or the user of declining", async () => {
    const text = await requestSecret(REPLY_TIMEOUT());

    expect(text).not.toMatch(/backgrounded or frozen/);
    expect(text).toMatch(/does NOT mean the tab is frozen/);
    expect(text).toMatch(/does NOT mean the user declined/);
    // The likely truth, stated as likely.
    expect(text).toMatch(/very likely just time/);
  });

  it("states the outcome that matters: nothing was saved", async () => {
    const text = await requestSecret(REPLY_TIMEOUT());
    expect(text).toMatch(/NOTHING was saved/);
    expect(text).toMatch(/no credential was read/);
  });

  it("says a LATE value is discarded — measured, not hedged", async () => {
    // The claim rests on this card having no ask_id, so the id-keyed late buffer cannot
    // match it. Hedging here would leave the user waiting for a save that cannot happen.
    const text = await requestSecret(REPLY_TIMEOUT());

    expect(text).toMatch(/cannot reach this call/);
    expect(text).toMatch(/discarded rather than saved/);
    expect(text).toMatch(/call panel_request_secret again/);
  });

  it("keeps the masked-input rule — never route a secret through the conversation", async () => {
    // #952's finding: suggesting the conversational route defeats the entire purpose of
    // this tool. A recovery path is exactly where that would slip back in.
    const text = await requestSecret(REPLY_TIMEOUT());
    expect(text).toMatch(/never be typed into the conversation/);
  });

  it("a NON-timeout failure keeps its own words", async () => {
    // The scope of this rewrite is one cause. A transport drop or a refusal must not be
    // narrated as "someone is still typing".
    const text = await requestSecret(new Error("Panel tab is not open"));

    expect(text).toMatch(/Panel tab is not open/);
    expect(text).not.toMatch(/very likely just time/);
    expect(text).not.toMatch(/discarded rather than saved/);
  });
});
