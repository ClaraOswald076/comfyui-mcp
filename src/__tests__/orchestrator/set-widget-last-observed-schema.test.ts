// #2075 — panel_set_widget succeeded and verified the widget, but both live
// schema routes timed out inside the 2000 ms snapshot budget and the panel
// appended schema_source:last-observed plus schema_note #1223. That makes a
// routine canvas edit (the write right after adding a node) look degraded
// while ComfyUI and the panel bridge are healthy.
//
// The panel's schema probe lives in the other repo. This process can still
// drop the degradation note from a write the panel already verified against
// an unchanged backend. These tests drive the shipped panel_set_widget
// handler on the real dispatch path (ctx.call → graph_set_widget).

import { describe, expect, it } from "vitest";

import {
  buildPanelToolDefs,
  makePanelToolCtx,
  type PanelToolCtx,
  type ToolResult,
} from "../../orchestrator/panel-tools.js";
import { WorkflowTargetStore } from "../../services/workflow-target-store.js";

const TAB = "wf:workflows/a.json";

/** The panel's snapshotAuthorizationNote with the reporter's 2000 ms probe wording. */
const REPORTER_SCHEMA_NOTE =
  `The write SUCCEEDED and was verified against the last whole /object_info observed on ` +
  `this ComfyUI connection: the live schema probe went silent, so it was authorized from ` +
  `that snapshot instead (#1223). Tried 2 routes: api.getNodeDefs() did not answer within ` +
  `its 1000ms share of the 2000ms budget; GET /object_info did not answer within its 500ms ` +
  `share of the 2000ms budget. The backend has not reconnected since that schema was read, ` +
  `so it still describes the process answering now — but if the node type matters to what ` +
  `happens next, re-read it once ComfyUI is responding again.`;

const STARVATION =
  `Cannot set widget on node 42 ("CustomNode"): cannot verify the node type against the ` +
  `ComfyUI backend — no usable /object_info schema was obtained. Tried 2 routes: ` +
  `api.getNodeDefs() did not answer within its 1000ms share of the 2000ms budget; ` +
  `GET /object_info did not answer within its 500ms share of the 2000ms budget. ` +
  `Refusing to write rather than trust a possibly-stale node cache (#458). ` +
  `Reconnect ComfyUI and retry.`;

function textOf(res: ToolResult): string {
  return res.content.map((c) => (c as { text?: string }).text ?? "").join(" ");
}

function parseJson(res: ToolResult): Record<string, unknown> {
  return JSON.parse(textOf(res)) as Record<string, unknown>;
}

function bridge(send: (cmd: Record<string, unknown>) => Promise<unknown>) {
  const calls: Array<Record<string, unknown>> = [];
  const b = {
    send: async (cmd: Record<string, unknown>) => {
      calls.push({ ...cmd });
      return send(cmd);
    },
    push: () => 1,
    canReach: () => true,
    isHeadless: () => false,
    tabs: () => [{ tab_id: TAB, title: "wf", connected_at: 0 }],
    resolveActiveTabId: () => TAB,
    tabCanMutateGraph: () => true,
    tabGraphMutationCapability: () => ({ known: true, canMutate: true }),
  } as unknown as PanelToolCtx["bridge"];
  return { b, calls };
}

async function setWidget(
  args: { node_id: number; widget: string; value: string },
  send: (cmd: Record<string, unknown>) => Promise<unknown>,
): Promise<{ res: ToolResult; calls: Array<Record<string, unknown>>; text: string }> {
  const { b, calls } = bridge(send);
  const ctx = makePanelToolCtx(b, TAB, new WorkflowTargetStore());
  const def = buildPanelToolDefs().find((d) => d.name === "panel_set_widget");
  if (!def) throw new Error("panel_set_widget is not registered");
  const res = await def.handler(args as never, ctx);
  return { res, calls, text: textOf(res) };
}

describe("panel_set_widget last-observed schema note after add_node (#2075)", () => {
  it("THE REPORTED CASE: a verified write after adding a node is not painted as a degraded schema probe", async () => {
    const { res, calls, text } = await setWidget(
      { node_id: 42, widget: "text", value: "hello" },
      async (cmd) => {
        if (cmd.cmd !== "graph_set_widget") return { ok: true };
        return {
          set: {
            node_id: cmd.node_id,
            widget: cmd.widget,
            previous: "",
            value: cmd.value,
          },
          schema_source: "last-observed",
          schema_note: REPORTER_SCHEMA_NOTE,
        };
      },
    );

    expect(res.isError).toBeFalsy();
    expect(calls.filter((c) => c.cmd === "graph_set_widget")).toHaveLength(1);
    const payload = parseJson(res);
    const set = payload.set as Record<string, unknown>;
    expect(set).toMatchObject({ node_id: 42, widget: "text", value: "hello" });
    expect(payload).not.toHaveProperty("schema_note");
    expect(payload).not.toHaveProperty("schema_source");
    expect(text).not.toMatch(/live schema probe went silent/i);
    expect(text).not.toMatch(/re-read it once ComfyUI is responding again/i);
  });

  it("a live verified write is left alone", async () => {
    const { res, text } = await setWidget(
      { node_id: 42, widget: "text", value: "hello" },
      async (cmd) => {
        if (cmd.cmd !== "graph_set_widget") return { ok: true };
        return {
          set: {
            node_id: cmd.node_id,
            widget: cmd.widget,
            previous: "",
            value: cmd.value,
          },
        };
      },
    );

    expect(res.isError).toBeFalsy();
    expect(parseJson(res).set).toMatchObject({ value: "hello" });
    expect(text).not.toMatch(/schema_note/);
  });

  it("a starvation refusal is still a refusal — the note is not stripped off an error", async () => {
    const { res, calls, text } = await setWidget(
      { node_id: 42, widget: "text", value: "hello" },
      async (cmd) => {
        if (cmd.cmd === "graph_set_widget") throw new Error(STARVATION);
        return { ok: true };
      },
    );

    expect(res.isError).toBe(true);
    expect(text).toContain(STARVATION);
    expect(calls.filter((c) => c.cmd === "graph_set_widget")).toHaveLength(1);
  });

  it("last-observed without a verified set is not rewritten", async () => {
    const { res, text } = await setWidget(
      { node_id: 42, widget: "text", value: "hello" },
      async (cmd) => {
        if (cmd.cmd !== "graph_set_widget") return { ok: true };
        return {
          ok: true,
          schema_source: "last-observed",
          schema_note: REPORTER_SCHEMA_NOTE,
        };
      },
    );

    expect(res.isError).toBeFalsy();
    expect(text).toMatch(/schema_note/);
    expect(parseJson(res).schema_source).toBe("last-observed");
  });
});
