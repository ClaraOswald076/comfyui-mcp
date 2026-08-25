// #1045 — a SAVE-AS wedges the session exactly like #932's panel_new_workflow did.
//
// A reporter built ~40 nodes, ran them, then called
// panel_save_workflow({name:"godot_titlescreen_video"}). The save SUCCEEDED
// ({saved:true, saved_as:true, copied_from:..., original_on_disk:true}) — and the
// very next panel_run failed with `workflow instance mismatch`, with the fence
// still naming the pre-save instance. The session was unusable immediately after
// a successful save of all that work.
//
// Cause is #932's, at a path I closed for workflow_new and missed here: a Save-As
// re-points the ACTIVE workflow (the canvas is now the new file, with its own
// identity) while the session's command fence still names the old one. Both
// commands re-point the active workflow, so both have to re-anchor.
//
// A plain in-place save is covered too. Its identity normally follows the
// workflow across the save, so the refresh re-derives the same value — but
// "normally" is precisely what failed here.

import { beforeEach, describe, expect, it } from "vitest";

import {
  buildPanelToolDefs,
  makePanelToolCtx,
  type PanelToolCtx,
  type ToolResult,
} from "../../orchestrator/panel-tools.js";

const textOf = (res: ToolResult): string => (res.content[0] as { text: string }).text;

// RFC-shaped: the fence regex requires a [1-5] version and an [89ab] variant
// nibble. An arbitrary-looking placeholder is silently rejected — which is how
// the first draft of this file "proved" the fix did not work.
const NEW_UUID = "11111111-2222-4333-8444-555555555555";
/** The stamp the session carried BEFORE the save — the pre-save instance. */
const PRIOR_UUID = "99999999-8888-4777-a666-555555555555";

let fence: string | undefined;

let sent: Array<Record<string, unknown>>;
let stamps: string[];

/**
 * A bridge whose `workflow_save_as` replies exactly as the panel does — note it
 * carries NO workflow_uuid, which is why the fence has to be re-derived from
 * `workflow_list` rather than read straight off the save receipt.
 */
function bridgeFor(list: Record<string, unknown>) {
  return {
    send: async (cmd: Record<string, unknown>) => {
      sent.push(cmd);
      if (cmd.cmd === "workflow_save_as") {
        // The real reply: no workflow_uuid on it.
        return { saved: true, workflow: "new-name", saved_as: true, copied_from: "old-name", original_on_disk: true };
      }
      if (cmd.cmd === "workflow_list") return list;
      return { ok: true };
    },
    push: () => 1,
    canReach: () => true,
    isHeadless: () => false,
    tabs: () => [{ tab_id: "tab-1", title: "Unsaved Workflow", connected_at: 0 }],
    resolveActiveTabId: () => "tab-1",
    // The command fence lives on the BRIDGE. Before the fix this session is
    // still stamped with the PREVIOUS workflow — which is the whole bug.
    workflowUuidFor: () => ({ known: true, uuid: fence }),
    refreshWorkflowUuid: (_tabId: string, uuid: string) => {
      fence = uuid;
      stamps.push(uuid);
      return true;
    },
    tabGraphMutationCapability: () => ({ known: true, canMutate: true }),
  } as unknown as PanelToolCtx["bridge"];
}

const HEALTHY_LIST = {
  active: { path: null, filename: null, title: "Unsaved Workflow", key: "tmp:abc", routing_key: "tmp:abc", workflow_uuid: NEW_UUID },
  active_confirmed: true,
  workflows: [
    { path: null, filename: null, title: "Unsaved Workflow", key: "tmp:abc", routing_key: "tmp:abc", active: true, persisted: false },
  ],
};

function ctxWith(list: Record<string, unknown>): PanelToolCtx {
  return makePanelToolCtx(bridgeFor(list), "tab-1");
}

beforeEach(() => {
  sent = [];
  stamps = [];
  fence = PRIOR_UUID; // the wedge: still stamped with the workflow we just left
});

const saveWorkflow = () => buildPanelToolDefs().find((d) => d.name === "panel_save_workflow")!;

describe("#1045: a save-as re-anchors the fence", () => {
  it("re-derives the fence after saving the workflow", async () => {
    const res = await saveWorkflow().handler({ name: "new-name" }, ctxWith(HEALTHY_LIST));
    expect(res.isError).toBeFalsy();
    // It asked the panel for the live active record — the step that was missing.
    expect(sent.map((c) => c.cmd)).toEqual(["workflow_save_as", "workflow_list"]);
  });

  // THE fix, stated directly: the session must end up fenced to the NEW canvas,
  // not the one it just left.
  it("adopts the new canvas's identity, replacing the previous workflow's stamp", async () => {
    await saveWorkflow().handler({ name: "new-name" }, ctxWith(HEALTHY_LIST));
    expect(stamps).toEqual([NEW_UUID]);
    expect(fence).toBe(NEW_UUID);
    expect(fence).not.toBe(PRIOR_UUID);
  });

  it("does not nag when the binding came back healthy", async () => {
    const res = await saveWorkflow().handler({ name: "new-name" }, ctxWith(HEALTHY_LIST));
    // A successful save with a working fence should read as a plain success.
    expect(textOf(res)).not.toContain("WAS saved");
    expect(textOf(res)).not.toContain("STILL fenced");
  });

  it("forwards a nested Save-As subfolder verbatim before re-anchoring identity", async () => {
    const res = await saveWorkflow().handler(
      { name: "new-name", subfolder: "nested/safe" },
      ctxWith(HEALTHY_LIST),
    );
    expect(res.isError).toBeFalsy();
    expect(sent[0]).toEqual({
      cmd: "workflow_save_as",
      name: "new-name",
      subfolder: "nested/safe",
    });
    expect(sent.map((c) => c.cmd)).toEqual(["workflow_save_as", "workflow_list"]);
    expect(stamps).toEqual([NEW_UUID]);
  });
  // An IN-PLACE save (no name) re-anchors too. Its identity normally follows the
  // workflow across the save, so this usually re-derives the same value and
  // changes nothing — but "normally" is exactly what failed in #1045, and one
  // round trip is cheap against a session that would otherwise be unusable.
  it("re-anchors after an in-place save as well", async () => {
    const { bridge, sent } = (() => {
      const s2: string[] = [];
      const b = bridgeFor(HEALTHY_LIST);
      const orig = (b as unknown as { send: (c: Record<string, unknown>) => Promise<unknown> }).send;
      (b as unknown as { send: (c: Record<string, unknown>) => Promise<unknown> }).send = async (c) => {
        s2.push(String(c.cmd));
        return orig(c);
      };
      return { bridge: b, sent: s2 };
    })();
    const ctx = makePanelToolCtx(bridge, "tab-1");
    await saveWorkflow().handler({}, ctx);
    expect(sent).toContain("workflow_save");
    expect(sent).toContain("workflow_list");
  });

});

describe("#1045: when the fence CANNOT be established, say so and keep the save", () => {
  // The exact shape from the report: the panel omits workflow_uuid when no
  // identity is established for the canvas.
  const NO_UUID = {
    active: { path: null, filename: null, title: "Unsaved Workflow", key: "tmp:abc", routing_key: "tmp:abc" },
    active_confirmed: true,
    workflows: [{ path: null, key: "tmp:abc", routing_key: "tmp:abc", active: true }],
  };

  it("still reports the workflow as SAVED — never retracts a real side effect", async () => {
    const res = await saveWorkflow().handler({ name: "new-name" }, ctxWith(NO_UUID));
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toContain("WAS saved");
  });

  it("warns that graph tools are not usable yet, instead of leaving it to be discovered", async () => {
    const text = textOf(await saveWorkflow().handler({ name: "new-name" }, ctxWith(NO_UUID)));
    expect(text.toLowerCase()).toMatch(/fence|graph/);
  });

  it("handles a panel that reports its active record as unconfirmed", async () => {
    const res = await saveWorkflow().handler(
      { name: "new-name" },
      ctxWith({ ...HEALTHY_LIST, active_confirmed: false }),
    );
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toContain("WAS saved");
  });

  it("handles a workflow_list that cannot be read at all", async () => {
    const res = await saveWorkflow().handler({ name: "new-name" }, ctxWith({ nonsense: true }));
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toContain("WAS saved");
  });
});

describe("#1045: a failed save is left alone", () => {
  it("does not probe or annotate when workflow_new itself failed", async () => {
    const bridge = {
      send: async (cmd: Record<string, unknown>) => {
        sent.push(cmd);
        throw new Error("workflow_new: the frontend did not expose it as the active workflow");
      },
      push: () => 1,
      canReach: () => true,
      isHeadless: () => false,
      tabs: () => [{ tab_id: "tab-1", title: "wf", connected_at: 0 }],
      resolveActiveTabId: () => "tab-1",
    } as unknown as PanelToolCtx["bridge"];

    const res = await saveWorkflow().handler({ name: "new-name" }, makePanelToolCtx(bridge, "tab-1"));
    expect(res.isError).toBe(true);
    // No fence probe on a failure: there is no new canvas to bind to, and a
    // second round trip would only add noise to a clear error.
    expect(sent.map((c) => c.cmd)).toEqual(["workflow_save_as"]);
    expect(textOf(res)).not.toContain("WAS saved");
  });
});
