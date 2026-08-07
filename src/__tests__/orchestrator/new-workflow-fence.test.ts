// #932 recurrence, reported against 0.50.6 — AFTER the #833 fix.
//
// `panel_new_workflow` created and activated an unsaved workflow, and then every
// `panel_add_node` failed with `workflow instance mismatch`. The recovery could
// not help either: `panel_set_workflow_target({mode:"current"})` changed the mode
// but could not read the live canvas identity, leaving the prior-instance fence
// in place. The session was wedged on a workflow it had just created.
//
// Cause: `workflow_new` authoritatively re-points the active workflow, exactly as
// `workflow_open` does — but only the OPEN path re-derived the command fence
// afterwards (openWorkflowWithVerify). So the session kept the PREVIOUS
// workflow's instance stamp while the user was looking at a brand-new canvas.
//
// #833 is not implicated: it made mode:"current" re-derive the fence and report
// honestly, and it did. The gap is that nothing established a fence for the new
// canvas in the first place.
//
// The panel mints the new canvas's identity eagerly at creation ("so the key
// exists BEFORE the first edit"), so it IS readable — it is simply not carried on
// the workflow_new reply, which returns key/routing_key and no workflow_uuid.

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
/** The stamp the session carried BEFORE the new workflow — the previous canvas. */
const PRIOR_UUID = "99999999-8888-4777-a666-555555555555";

let fence: string | undefined;

let sent: Array<Record<string, unknown>>;
let stamps: string[];

/**
 * A bridge whose `workflow_list` describes the freshly created blank canvas the
 * way the real panel does: no `path` (it is unsaved), `key` === `routing_key` ===
 * the per-instance `tmp:` id, and the eagerly minted `workflow_uuid`.
 */
function bridgeFor(list: Record<string, unknown>) {
  return {
    send: async (cmd: Record<string, unknown>) => {
      sent.push(cmd);
      if (cmd.cmd === "workflow_new") {
        // The real reply: no workflow_uuid on it.
        return { created: true, active: "Unsaved Workflow", key: "tmp:abc", routing_key: "tmp:abc", open_seq: 1 };
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

const newWorkflow = () => buildPanelToolDefs().find((d) => d.name === "panel_new_workflow")!;

describe("#932: a new canvas gets a new fence", () => {
  it("re-derives the fence after creating the workflow", async () => {
    const res = await newWorkflow().handler({}, ctxWith(HEALTHY_LIST));
    expect(res.isError).toBeFalsy();
    // It asked the panel for the live active record — the step that was missing.
    expect(sent.map((c) => c.cmd)).toEqual(["workflow_new", "workflow_list"]);
  });

  // THE fix, stated directly: the session must end up fenced to the NEW canvas,
  // not the one it just left.
  it("adopts the new canvas's identity, replacing the previous workflow's stamp", async () => {
    await newWorkflow().handler({}, ctxWith(HEALTHY_LIST));
    expect(stamps).toEqual([NEW_UUID]);
    expect(fence).toBe(NEW_UUID);
    expect(fence).not.toBe(PRIOR_UUID);
  });

  it("does not nag when the binding came back healthy", async () => {
    const res = await newWorkflow().handler({}, ctxWith(HEALTHY_LIST));
    // A successful creation with a working fence should read as a plain success.
    expect(textOf(res)).not.toContain("WAS created");
    expect(textOf(res)).not.toContain("STILL fenced");
  });
});

describe("#932: when the fence CANNOT be established, say so and keep the creation", () => {
  // The exact shape from the report: the panel omits workflow_uuid when no
  // identity is established for the canvas.
  const NO_UUID = {
    active: { path: null, filename: null, title: "Unsaved Workflow", key: "tmp:abc", routing_key: "tmp:abc" },
    active_confirmed: true,
    workflows: [{ path: null, key: "tmp:abc", routing_key: "tmp:abc", active: true }],
  };

  it("still reports the workflow as created — never retracts a real side effect", async () => {
    const res = await newWorkflow().handler({}, ctxWith(NO_UUID));
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toContain("WAS created");
  });

  it("warns that graph tools are not usable yet, instead of leaving it to be discovered", async () => {
    const text = textOf(await newWorkflow().handler({}, ctxWith(NO_UUID)));
    expect(text.toLowerCase()).toMatch(/fence|graph/);
  });

  it("handles a panel that reports its active record as unconfirmed", async () => {
    const res = await newWorkflow().handler(
      {},
      ctxWith({ ...HEALTHY_LIST, active_confirmed: false }),
    );
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toContain("WAS created");
  });

  it("handles a workflow_list that cannot be read at all", async () => {
    const res = await newWorkflow().handler({}, ctxWith({ nonsense: true }));
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toContain("WAS created");
  });
});

describe("#932: a failed creation is left alone", () => {
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

    const res = await newWorkflow().handler({}, makePanelToolCtx(bridge, "tab-1"));
    expect(res.isError).toBe(true);
    // No fence probe on a failure: there is no new canvas to bind to, and a
    // second round trip would only add noise to a clear error.
    expect(sent.map((c) => c.cmd)).toEqual(["workflow_new"]);
    expect(textOf(res)).not.toContain("WAS created");
  });
});
