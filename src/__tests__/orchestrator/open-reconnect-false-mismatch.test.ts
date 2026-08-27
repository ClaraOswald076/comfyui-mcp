// panel#1555 — immediately after a ComfyUI restart, panel_open_workflow reported
// a content-mismatch / fence warning for the v3 workflow that was already the
// active canvas. A subsequent panel_query_graph showed that graph and the newly
// loaded custom-node schema. The open-path content comparison ran before
// workflow_list.active_confirmed and the live serialize finished one
// synchronized handshake.
//
// Tests drive panel_open_workflow. Dest file comes through the same userdata
// read that handler uses; live canvas comes from graph_serialize.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PanelToolCtx, ToolResult } from "../../orchestrator/panel-tools.js";
import { QueueMonitor } from "../../services/queue-monitor.js";
import { WorkflowTargetStore } from "../../services/workflow-target-store.js";

const destByKey = new Map<string, Record<string, unknown>>();

vi.mock("../../services/userdata-library.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/userdata-library.js")>();
  return {
    ...actual,
    userdataFetch: async (route: string) => {
      for (const [key, graph] of destByKey) {
        if (route.includes(encodeURIComponent(key)) || route.includes(key)) {
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify(graph),
          } as Response;
        }
      }
      throw new Error(`no dest fixture for ${route}`);
    },
  };
});

const { buildPanelToolDefs, makePanelToolCtx, __openWorkflowTestHooks } = await import(
  "../../orchestrator/panel-tools.js"
);

const TAB = "wf:workflows/v3.json";
const PATH = "workflows/v3.json";
const LIVE = "77777777-7777-4777-8777-777777777777";
const PRIOR = "11111111-1111-4111-8111-111111111111";

const IDENTITY_PROVEN =
  `workflow_open RAN and the canvas IS bound to ${PATH} — that much was proven — but the graph ` +
  `on it does not match the state that was loaded, and the panel cannot tell whether the ComfyUI ` +
  `frontend merely normalized it (node sizes, widget values) or the load only partly applied. ` +
  `Treat the canvas as UNKNOWN and re-read it (panel_graph_outline) before editing. You are NOT ` +
  `on the wrong workflow: ${PATH} IS the active one. This reply carries NO fence refresh.`;

function destGraph() {
  return {
    nodes: [
      {
        id: 1,
        type: "CustomPackNode",
        widgets_values: ["ckpt.safetensors"],
        widgets_values_named: { ckpt_name: "ckpt.safetensors" },
      },
      {
        id: 2,
        type: "SaveImage",
        widgets_values: ["out"],
        widgets_values_named: { filename_prefix: "out" },
      },
    ],
    links: [[1, 1, 0, 2, 0, "IMAGE"]],
    extra: { comfyui_mcp: { workflow_path: PATH, workflow_uuid: LIVE } },
  };
}

function liveGraph() {
  return {
    nodes: [
      {
        id: 1,
        type: "CustomPackNode",
        size: [280, 140],
        properties: { "Node name for S&R": "CustomPackNode" },
        widgets_values: ["ckpt.safetensors"],
        widgets_values_named: { ckpt_name: "ckpt.safetensors" },
        inputs: [],
        outputs: [{ name: "IMAGE", type: "IMAGE", links: [1] }],
      },
      {
        id: 2,
        type: "SaveImage",
        widgets_values: ["out"],
        widgets_values_named: { filename_prefix: "out" },
      },
    ],
    links: [[1, 1, 0, 2, 0, "IMAGE"]],
    extra: { comfyui_mcp: { workflow_path: PATH, workflow_uuid: LIVE } },
  };
}

function emptyGraph() {
  return { nodes: [] as unknown[], links: [] as unknown[] };
}

function listReply(opts: {
  confirmed: boolean;
  uuid: string;
  path?: string;
  omitActiveConfirmed?: boolean;
}) {
  const path = opts.path ?? PATH;
  const active = { path, routing_key: `wf:${path}`, workflow_uuid: opts.uuid };
  return {
    active,
    workflows: [{ ...active, active: true }],
    ...(opts.omitActiveConfirmed ? {} : { active_confirmed: opts.confirmed }),
  };
}

type GraphQuery = "answers" | "mismatch";

function bridge(opts: {
  stamp: string;
  graphQuery: GraphQuery;
  openResult?: "error" | "success";
  /** First N workflow_list replies are unconfirmed; then confirmed. */
  unconfirmedLists?: number;
  /** First N graph_serialize replies are the empty settling snapshot. */
  emptySerializes?: number;
  listPath?: string;
  listUuid?: string;
  omitOpenedPath?: boolean;
  omitActiveConfirmed?: boolean;
}) {
  const calls: string[] = [];
  let stamp: string | undefined = opts.stamp;
  let listCalls = 0;
  let serializeCalls = 0;
  const unconfirmedLists = opts.unconfirmedLists ?? 0;
  const emptySerializes = opts.emptySerializes ?? 0;
  const listPath = opts.listPath ?? PATH;
  const listUuid = opts.listUuid ?? LIVE;
  const b = {
    send: async (cmd: Record<string, unknown>) => {
      calls.push(String(cmd.cmd));
      if (cmd.cmd === "workflow_list") {
        listCalls += 1;
        return listReply({
          confirmed: listCalls > unconfirmedLists,
          uuid: listUuid,
          path: listPath,
          omitActiveConfirmed: opts.omitActiveConfirmed,
        });
      }
      if (cmd.cmd === "workflow_open") {
        if (opts.openResult === "success") {
          return {
            opened: opts.omitOpenedPath
              ? { filename: "v3.json" }
              : { path: PATH, filename: "v3.json" },
            routing_key: TAB,
            workflow_uuid: LIVE,
          };
        }
        throw new Error(IDENTITY_PROVEN);
      }
      if (cmd.cmd === "graph_query") {
        if (opts.graphQuery === "mismatch") {
          throw new Error(
            `workflow instance mismatch: issued for workflow instance ${PRIOR} but canvas is ${LIVE}`,
          );
        }
        return { ids: [1, 2], node_count: 2 };
      }
      if (cmd.cmd === "graph_serialize") {
        serializeCalls += 1;
        const graph = serializeCalls > emptySerializes ? liveGraph() : emptyGraph();
        return { workflow: graph, node_count: Array.isArray(graph.nodes) ? graph.nodes.length : 0 };
      }
      return { ok: true };
    },
    push: () => 1,
    canReach: () => true,
    isHeadless: () => false,
    tabs: () => [{ tab_id: TAB, title: "v3", connected_at: 0 }],
    resolveActiveTabId: () => TAB,
    refreshWorkflowUuid: (_t: string, uuid: string) => {
      calls.push(`adopt:${uuid}`);
      stamp = uuid;
      return true;
    },
    workflowUuidFor: () => ({ known: Boolean(stamp), uuid: stamp }),
    tabCanMutateGraph: () => true,
    tabGraphMutationCapability: () => ({ known: true, canMutate: true }),
  } as unknown as PanelToolCtx["bridge"];
  return { b, calls, stampOf: () => stamp };
}

beforeEach(() => {
  destByKey.clear();
  destByKey.set(PATH, destGraph());
  __openWorkflowTestHooks.setOpenContentHandshakeStepsMs([0]);
  const qm = QueueMonitor as unknown as { state: { runningPromptId: string | null } };
  qm.state.runningPromptId = null;
});

afterEach(() => {
  destByKey.clear();
  __openWorkflowTestHooks.setOpenContentHandshakeStepsMs(null);
  const qm = QueueMonitor as unknown as { state: { runningPromptId: string | null } };
  qm.state.runningPromptId = null;
});

async function openWorkflow(opts: Parameters<typeof bridge>[0], requestedPath = PATH) {
  const { b, calls, stampOf } = bridge(opts);
  const ctx = makePanelToolCtx(b, TAB, new WorkflowTargetStore());
  const def = buildPanelToolDefs().find((d) => d.name === "panel_open_workflow");
  if (!def) throw new Error("panel_open_workflow is not registered");
  const res: ToolResult = await def.handler({ path: requestedPath } as never, ctx);
  return {
    text: res.content.map((c) => (c as { text?: string }).text ?? "").join(" "),
    isError: res.isError === true,
    calls,
    stamp: stampOf(),
  };
}

describe("panel_open_workflow does not false-mismatch the already-active canvas after restart (panel#1555)", () => {
  it("the reporter's case: unconfirmed list + settling serialize, then dest is on the canvas", async () => {
    const { text, isError, calls, stamp } = await openWorkflow({
      // Post-reconnect hello already stamped the live instance.
      stamp: LIVE,
      graphQuery: "answers",
      unconfirmedLists: 2,
      emptySerializes: 2,
    });

    expect(isError).toBe(false);
    expect(calls).toContain("workflow_list");
    expect(calls).toContain("graph_serialize");
    expect(stamp).toBe(LIVE);
    expect(text).toMatch(/content_normalized/);
    expect(text).toMatch(/Opened/);
    expect(text).not.toMatch(/CONTENT MISMATCH/);
    expect(text).not.toMatch(/PREVIOUS workflow/);
    expect(text).not.toMatch(/Treat the canvas as UNKNOWN/);
  });

  it("the reminted-uuid restart: fence mismatch, then dest matches after handshake", async () => {
    const { text, isError, stamp } = await openWorkflow({
      stamp: PRIOR,
      graphQuery: "mismatch",
      unconfirmedLists: 0,
      emptySerializes: 1,
    });

    expect(isError).toBe(false);
    expect(stamp).toBe(LIVE);
    expect(text).toMatch(/content_normalized/);
    expect(text).not.toMatch(/CONTENT MISMATCH/);
    expect(text).not.toMatch(/PREVIOUS workflow/);
  });

  it("does not emit a hard mismatch while active_confirmed is still unknown", async () => {
    const { text, isError } = await openWorkflow({
      stamp: LIVE,
      graphQuery: "answers",
      // Never confirms, serialize never settles.
      unconfirmedLists: 99,
      emptySerializes: 99,
    });

    expect(isError).toBe(true);
    expect(text).toMatch(/UNCONFIRMED/);
    expect(text).toMatch(/expected routing wf:workflows\/v3\.json/);
    expect(text).toMatch(/observed routing wf:workflows\/v3\.json/);
    expect(text).not.toMatch(/CONTENT MISMATCH/);
    expect(text).not.toMatch(/PREVIOUS workflow/);
  });

  it("a confirmed DIFFERENT instance still answering is still the previous workflow (#1639)", async () => {
    const { text, isError, stamp } = await openWorkflow({
      stamp: PRIOR,
      graphQuery: "answers",
      unconfirmedLists: 0,
      emptySerializes: 99,
      listUuid: LIVE,
    });

    expect(isError).toBe(true);
    expect(stamp).toBe(PRIOR);
    expect(text).toMatch(/CONTENT MISMATCH/);
    expect(text).toMatch(/PREVIOUS workflow/);
    expect(text).toMatch(/expected routing wf:workflows\/v3\.json/);
    expect(text).toMatch(/observed routing wf:workflows\/v3\.json/);
  });

  it("a bare filename never reports active/bound success without a live active re-read (#1639)", async () => {
    const { text, isError, calls, stamp } = await openWorkflow(
      {
        stamp: PRIOR,
        graphQuery: "answers",
        openResult: "success",
        listPath: "workflows/previous.json",
        listUuid: PRIOR,
      },
      "v3.json",
    );

    expect(isError).toBe(true);
    expect(calls).toContain("workflow_list");
    expect(stamp).toBe(PRIOR);
    expect(text).toMatch(/ACTIVE workflow now/i);
    expect(text).toMatch(/previous\.json/);
    expect(text).not.toMatch(/Opened/);
  });

  it("a bare filename succeeds only after the resolved path is confirmed active (#1639)", async () => {
    const { text, isError, calls, stamp } = await openWorkflow(
      {
        stamp: PRIOR,
        graphQuery: "answers",
        openResult: "success",
        listPath: PATH,
        listUuid: LIVE,
      },
      "v3.json",
    );

    expect(isError).toBe(false);
    expect(calls).toContain("workflow_list");
    expect(stamp).toBe(PRIOR);
    expect(text).toMatch(/workflows\/v3\.json/);
  });

  it("a bare filename fails closed when the resolved active identity is unconfirmed (#1639)", async () => {
    const { text, isError, calls, stamp } = await openWorkflow(
      {
        stamp: PRIOR,
        graphQuery: "answers",
        openResult: "success",
        unconfirmedLists: 1,
        listPath: PATH,
        listUuid: LIVE,
      },
      "v3.json",
    );

    expect(isError).toBe(true);
    expect(calls).toContain("workflow_list");
    expect(stamp).toBe(PRIOR);
    expect(text).toMatch(/active canvas is UNKNOWN/i);
    expect(text).not.toMatch(/Opened/);
  });

  it("a bare filename fails closed when the open reply omits its resolved path (#1639)", async () => {
    const { text, isError, calls, stamp } = await openWorkflow(
      {
        stamp: PRIOR,
        graphQuery: "answers",
        openResult: "success",
        omitOpenedPath: true,
      },
      "v3.json",
    );

    expect(isError).toBe(true);
    expect(calls).not.toContain("workflow_list");
    expect(stamp).toBe(PRIOR);
    expect(text).toMatch(/active canvas is UNKNOWN/i);
    expect(text).toMatch(/resolved path/i);
    expect(text).not.toMatch(/Opened/);
  });

  it("a bare filename fails closed when active_confirmed is omitted (#1639)", async () => {
    const { text, isError, calls, stamp } = await openWorkflow(
      {
        stamp: PRIOR,
        graphQuery: "answers",
        openResult: "success",
        omitActiveConfirmed: true,
        listPath: PATH,
        listUuid: LIVE,
      },
      "v3.json",
    );

    expect(isError).toBe(true);
    expect(calls).toContain("workflow_list");
    expect(stamp).toBe(PRIOR);
    expect(text).toMatch(/active canvas is UNKNOWN/i);
    expect(text).not.toMatch(/Opened/);
  });
});
