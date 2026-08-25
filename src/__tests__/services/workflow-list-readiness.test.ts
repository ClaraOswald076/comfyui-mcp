// #1785 — the Panel's workflow_list reconnect-readiness refusal is an explicit
// pre-probe answer. A concurrent re-hello may change the bridge's fence, but
// that change is not a successful workflow_list proof and must not make
// panel_set_workflow_target report bound.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "node:net";
import WebSocket from "ws";

import { UiBridge } from "../../services/ui-bridge.js";
import {
  buildPanelToolDefs,
  makePanelToolCtx,
  type ToolResult,
} from "../../orchestrator/panel-tools.js";
import { WorkflowTargetStore } from "../../services/workflow-target-store.js";
import {
  workflowListReadinessOf,
  type WorkflowListReadinessRefusal,
} from "../../services/panel-workflow-readiness.js";
import { isPreExecutorRefusal } from "../../services/panel-refusal.js";
import { waitFor } from "../helpers/wait-for.js";

const BEFORE = "4808c797-417c-4c33-8ab0-99cf2f6ba648";
const READY = "caf45251-53ad-431b-afdd-02239fdb7119";
const TAB = "wf:route1:workflows/a.json";

const READINESS_REFUSAL: WorkflowListReadinessRefusal = {
  code: "reconnect-not-ready",
  ready: false,
  applied: false,
  stage: "pre-probe",
  retryable: true,
};

const PRE_EXECUTOR_REFUSAL = {
  code: "backend-reconnecting",
  applied: false,
  stage: "pre-executor",
  retryable: true,
};

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function settled(uuid: string): Record<string, unknown> {
  const active = { path: "workflows/a.json", routing_key: TAB, workflow_uuid: uuid };
  return { active, workflows: [{ ...active, active: true }], active_confirmed: true };
}

describe("Panel workflow_list readiness reaches the rebind consumer (#1785)", () => {
  let bridge: UiBridge;
  let port: number;
  let socket: WebSocket;
  let fence: string;
  let replyMode: "readiness" | "both" | "success";
  let received: Array<Record<string, unknown>>;

  beforeEach(async () => {
    fence = BEFORE;
    replyMode = "readiness";
    received = [];
    for (let attempt = 0; attempt < 6; attempt++) {
      port = await freePort();
      bridge = new UiBridge(port);
      bridge.start();
      if (await bridge.whenReady()) break;
      await bridge.stop();
      if (attempt === 5) throw new Error("could not bind a free bridge port");
    }
    bridge.setTabWorkflowUuidResolver(
      () => fence,
      (_tabId, uuid) => {
        fence = uuid;
        return true;
      },
    );
    socket = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    sendHello();
    await waitFor(() => expect(bridge.tabs().map((tab) => tab.tab_id)).toContain(TAB));
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (typeof message.rid !== "string" || typeof message.cmd !== "string") return;
      received.push(message);
      if (message.cmd !== "workflow_list") {
        socket.send(JSON.stringify({ rid: message.rid, ok: true, result: { cmd: message.cmd } }));
        return;
      }
      if (replyMode === "readiness" || replyMode === "both") {
        // Model a real re-hello/fence change racing the refusal. The changed
        // fence is deliberately not accompanied by a successful list proof.
        fence = READY;
        sendHello();
        socket.send(JSON.stringify({
          rid: message.rid,
          ok: false,
          error: "workflow_list readiness is still settling",
          workflow_list_readiness: READINESS_REFUSAL,
          ...(replyMode === "both" ? { refusal: PRE_EXECUTOR_REFUSAL } : {}),
        }));
      } else {
        socket.send(
          JSON.stringify({ rid: message.rid, ok: true, result: settled(READY) }),
        );
      }
    });
  });

  afterEach(async () => {
    try {
      socket?.close();
    } catch {
      // already closed
    }
    await bridge?.stop();
  });

  function sendHello(): void {
    socket.send(
      JSON.stringify({
        type: "hello",
        tab_id: TAB,
        title: TAB,
        enforces_workflow_stamp: true,
        enforces_workflow_stamp_at_write: true,
      }),
    );
  }

  async function setCurrentTarget(): Promise<ToolResult> {
    const ctx = makePanelToolCtx(bridge, TAB, new WorkflowTargetStore());
    const definition = buildPanelToolDefs().find((def) => def.name === "panel_set_workflow_target");
    if (!definition) throw new Error("panel_set_workflow_target is not registered");
    return definition.handler({ mode: "current" } as never, ctx);
  }

  it("preserves the typed refusal on the bridge Error", async () => {
    const error = await bridge
      .send({ cmd: "workflow_list" }, { tabId: TAB, timeoutMs: 3000 })
      .then(() => null, (err: unknown) => err);

    expect(error).toBeInstanceOf(Error);
    expect(workflowListReadinessOf(error)).toEqual(READINESS_REFUSAL);
  });

  it("preserves the existing refusal attachment alongside readiness", async () => {
    replyMode = "both";
    const error = await bridge
      .send({ cmd: "workflow_list" }, { tabId: TAB, timeoutMs: 3000 })
      .then(() => null, (err: unknown) => err);

    expect(isPreExecutorRefusal(error)?.code).toBe("backend-reconnecting");
    expect(workflowListReadinessOf(error)).toEqual(READINESS_REFUSAL);
  });

  it("does not turn readiness refusal plus concurrent re-hello into bound", async () => {
    const result = await setCurrentTarget();
    const text = result.content.map((block) => ("text" in block ? block.text : "")).join(" ");

    expect(result.isError).toBe(true);
    expect(text).toContain("reconnect-not-ready");
    expect(text).toContain("did NOT restore this session's graph binding");
    expect(text).not.toContain('"graph_binding": "bound"');
    expect(text).not.toContain("Graph tools should work now");
    expect(fence).toBe(READY);
    expect(received.map((message) => message.cmd)).toEqual(["workflow_list"]);
  });

  it("keeps successful healing after an actual ready, corroborated workflow_list", async () => {
    replyMode = "success";
    const result = await setCurrentTarget();
    const text = result.content.map((block) => ("text" in block ? block.text : "")).join(" ");
    const document = JSON.parse(text) as Record<string, unknown>;

    expect(result.isError).toBeFalsy();
    expect(document.graph_binding).toBe("bound");
    expect(document.graph_binding_status).toBe("refreshed");
    expect(fence).toBe(READY);
    expect(received.map((message) => message.cmd)).toEqual(["workflow_list"]);
  });
});
