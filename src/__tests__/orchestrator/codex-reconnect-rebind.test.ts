// panel#1557 — after a ComfyUI restart/reload, panel_graph_outline failed with
// "no connected tab … Connected: none", and the documented recovery
// panel_set_workflow_target({mode:"current"}) also failed: "no connected tab
// belongs to this conversation's backend (codex)" and "did NOT restore this
// session's graph binding". A retry of panel_graph_outline failed identically.
//
// Codex panel_* tools are SCOPE-bound (`orchestrator::codex` via the HTTP MCP
// urlFor(agentKey)). The #474 zero-tab DEFER path only fired when
// rebindToActiveTab THREW — a real-tab ctx. A scope ctx returns a refusal
// object instead, so the recovery neither deferred nor rebound, and the
// session stayed fenced to the previous (dead) workflow instance.
//
// Two remaining holes, both driven here on the shipped
// panel_set_workflow_target / panel_graph_outline path with the real
// TurnOriginTracker + makeScopeRepinHandler:
//   1. ZERO interactive tabs: the recovery must DEFER like the tab-bound path,
//      not fail as a backend-mismatch.
//   2. UNIQUE live canvas after reconnect, attributed to the default backend
//      (hello omitted `backend`): a dead/ambiguous Codex pin must ADOPT that
//      canvas rather than refuse. Idle (no pin) unique-foreign still refuses —
//      that is the P0 "never steal another conversation's tab".

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "node:net";
import WebSocket from "ws";

import { UiBridge } from "../../services/ui-bridge.js";
import { SHARED_SESSION_SCOPE } from "../../services/session-scope.js";
import {
  TurnOriginTracker,
  makeScopeRepinHandler,
  makeScopeTargetResolver,
} from "../../orchestrator/turn-origins.js";
import {
  buildPanelToolDefs,
  makePanelToolCtx,
  __panelToolsTestHooks,
  type ToolResult,
} from "../../orchestrator/panel-tools.js";
import { WorkflowTargetStore } from "../../services/workflow-target-store.js";
import { waitFor } from "../helpers/wait-for.js";

const SCOPE_KEY = `${SHARED_SESSION_SCOPE}::codex`;
const LIVE = "wf:tab-live:workflows/a.json";
const GONE = "wf:tab-gone:workflows/a.json";
const PATH = "workflows/a.json";
const UUID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

const textOf = (res: ToolResult): string =>
  res.content.map((c) => (c as { text?: string }).text ?? "").join("\n");

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

async function startBridge(): Promise<{ bridge: UiBridge; port: number }> {
  let lastErr = "no attempt made";
  for (let attempt = 0; attempt < 6; attempt++) {
    const p = await freePort();
    const b = new UiBridge(p);
    b.start();
    if (await b.whenReady()) return { bridge: b, port: p };
    lastErr = `bind to ${p} lost a close→rebind race`;
    await b.stop();
  }
  throw new Error(`could not bind a free bridge port after 6 attempts: ${lastErr}`);
}

function connectPanel(port: number, tabId: string, title: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(`ws://127.0.0.1:${port}`);
    sock.on("open", () => {
      sock.send(
        JSON.stringify({
          type: "hello",
          tab_id: tabId,
          title,
          enforces_workflow_stamp: true,
          enforces_workflow_stamp_at_write: true,
        }),
      );
      resolve(sock);
    });
    sock.on("error", reject);
  });
}

function autoReply(sock: WebSocket): void {
  sock.on("message", (buf) => {
    const msg = JSON.parse(buf.toString());
    if (!msg.rid || !msg.cmd) return;
    if (msg.cmd === "workflow_list") {
      sock.send(
        JSON.stringify({
          rid: msg.rid,
          ok: true,
          result: {
            active: {
              path: PATH,
              routing_key: `wf:${PATH}`,
              workflow_uuid: UUID,
              active: true,
            },
            workflows: [
              {
                path: PATH,
                routing_key: `wf:${PATH}`,
                workflow_uuid: UUID,
                active: true,
              },
            ],
            active_confirmed: true,
          },
        }),
      );
      return;
    }
    sock.send(JSON.stringify({ rid: msg.rid, ok: true, result: { from: "live", cmd: msg.cmd } }));
  });
}

describe("panel#1557 Codex reconnect: mode:current binds the live canvas", () => {
  let bridge: UiBridge;
  let port: number;
  let tracker: TurnOriginTracker;
  let tabBackends: Map<string, string>;

  beforeEach(async () => {
    ({ bridge, port } = await startBridge());
    bridge.setTabWorkflowUuidResolver(() => UUID);
    tabBackends = new Map();
    const backendOfKey = (key: string): string =>
      key.includes("::") ? key.slice(key.lastIndexOf("::") + 2) : "claude";
    const backendForTab = (tab: string): string => tabBackends.get(tab) ?? "claude";
    tracker = new TurnOriginTracker({
      backendForTab,
      backendOfKey,
      uuidOfTab: () => UUID,
      liveTabOf: (tab) => bridge.liveTabIdFor(tab),
      warn: () => {},
    });
    const scopeAgentKeyOf = (scopeId: string): string =>
      scopeId === SHARED_SESSION_SCOPE ? SCOPE_KEY : scopeId;
    bridge.setScopeTargetResolver(makeScopeTargetResolver({ tracker, scopeAgentKeyOf }));
    bridge.setScopeRepinHandler(
      makeScopeRepinHandler({
        bridge,
        tracker,
        scopeAgentKeyOf,
        backendForTab,
        backendOfKey,
        info: () => {},
        claimTab: (tab, backend) => {
          tabBackends.set(tab, backend);
        },
      }),
    );
    __panelToolsTestHooks.setReconnectWaitTiming({ budgetMs: 400, intervalMs: 20 });
  });

  afterEach(async () => {
    __panelToolsTestHooks.setReconnectWaitTiming(null);
    await bridge.stop();
  });

  function tools() {
    const defs = buildPanelToolDefs();
    const ctx = makePanelToolCtx(bridge, SCOPE_KEY, new WorkflowTargetStore());
    return {
      ctx,
      setTarget: defs.find((d) => d.name === "panel_set_workflow_target")!,
      outline: defs.find((d) => d.name === "panel_graph_outline")!,
    };
  }

  it("ZERO tabs: Codex mode:current DEFERS instead of failing as a backend-mismatch", async () => {
    // The reporter's recovery while the browser socket had not re-hello'd.
    tracker.repinTo(SCOPE_KEY, GONE);
    const { ctx, setTarget } = tools();
    const res = await setTarget.handler({ mode: "current" }, ctx);
    const text = textOf(res as ToolResult);

    expect(res.isError, text).toBeFalsy();
    expect(JSON.parse(text)).toMatchObject({ deferred: true, mode: "current" });
    expect(text).not.toMatch(/did NOT restore this session's graph binding/);
    expect(text).not.toMatch(/no connected tab belongs to this conversation's backend/);
    expect(text).toMatch(/reconnect/i);
  });

  it("UNIQUE live canvas attributed to the default backend is adopted for a DEAD Codex pin", async () => {
    // Restart/reload: the previous wf: tab is gone, the canvas re-hellos under a
    // new id without `backend`, so it joins the DEFAULT conversation (claude).
    // Codex's recovery used to refuse; the live canvas is the one the user is
    // looking at, and this conversation already had a pin to the previous instance.
    const sock = await connectPanel(port, LIVE, "a");
    autoReply(sock);
    await waitFor(() => expect(bridge.tabs()).toHaveLength(1));
    tabBackends.set(LIVE, "claude");
    tracker.repinTo(SCOPE_KEY, GONE);
    expect(bridge.canReach(SCOPE_KEY)).toBe(false);

    const { ctx, setTarget, outline } = tools();
    const bindRes = await setTarget.handler({ mode: "current" }, ctx);
    const bindText = textOf(bindRes as ToolResult);

    expect(bindRes.isError, bindText).toBeFalsy();
    expect(bindText).not.toMatch(/did NOT restore this session's graph binding/);
    expect(bindText).not.toMatch(/no connected tab belongs to this conversation's backend/);
    expect(tracker.resolvedPinOf(SCOPE_KEY)).toBe(LIVE);
    expect(tabBackends.get(LIVE)).toBe("codex");
    expect(bridge.canReach(SCOPE_KEY)).toBe(true);

    const outlineRes = await outline.handler({}, ctx);
    expect(outlineRes.isError, textOf(outlineRes as ToolResult)).toBeFalsy();
    sock.close();
  });

  it("after a DEFER, a later graph_outline binds onto the unique canvas that reconnects", async () => {
    tracker.repinTo(SCOPE_KEY, GONE);
    const { ctx, setTarget, outline } = tools();
    const bindRes = await setTarget.handler({ mode: "current" }, ctx);
    expect(bindRes.isError, textOf(bindRes as ToolResult)).toBeFalsy();
    expect(JSON.parse(textOf(bindRes as ToolResult))).toMatchObject({ deferred: true });

    const sock = await connectPanel(port, LIVE, "a");
    autoReply(sock);
    await waitFor(() => expect(bridge.tabs()).toHaveLength(1));
    tabBackends.set(LIVE, "claude");

    const outlineRes = await outline.handler({}, ctx);
    expect(outlineRes.isError, textOf(outlineRes as ToolResult)).toBeFalsy();
    expect(tracker.resolvedPinOf(SCOPE_KEY)).toBe(LIVE);
    sock.close();
  });

  it("does NOT steal a unique foreign tab when this conversation has no pin to recover", async () => {
    const sock = await connectPanel(port, LIVE, "a");
    autoReply(sock);
    await waitFor(() => expect(bridge.tabs()).toHaveLength(1));
    tabBackends.set(LIVE, "claude");
    expect(tracker.pinOf(SCOPE_KEY)).toBeUndefined();

    const { ctx, setTarget } = tools();
    await setTarget.handler({ mode: "current" }, ctx);

    // Idle (no turn pin) may still follow the active canvas for graph routing —
    // that is not a steal. What must not happen is claiming the tab into THIS
    // conversation's backend or writing a turn pin onto it.
    expect(tracker.pinOf(SCOPE_KEY)).toBeUndefined();
    expect(tabBackends.get(LIVE)).toBe("claude");
    sock.close();
  });
});
