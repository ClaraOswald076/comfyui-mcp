// #1524, RECOVERY — a mid-session MCP drop is detected at the next turn end and
// the one bounded reconnect is attempted, with the outcome narrated from the
// re-read status, never from the attempt.
//
// The reported failure: a healthy session lost all 92 panel_* tools hours in.
// The harness's own reconnect brought `comfyui` back and never retried the
// in-process panel server, and since `init` is the only MCP report a session
// PUSHES, nothing host-side ever learned of it. There is no mid-session push
// to listen for, so the watch ASKS — one mcpServerStatus() poll per turn end —
// and recovery is the SDK's own verb, reconnectMcpServer(), tried once per
// down-episode.
//
// Harness pattern follows claude-init-mcp-degraded.test.ts: the optional Agent
// SDK is mocked, the backend is driven through run(), and the canonical
// AgentEvents are collected. The mock's status answers are SCRIPTED per poll
// so a scenario can say exactly what the harness reports before and after the
// reconnect.

import { describe, expect, it, beforeEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "../../orchestrator/agent-backend.js";
import { waitFor } from "../helpers/wait-for.js";

process.env.COMFYUI_MCP_TURN_REGISTRY_DIR = mkdtempSync(join(tmpdir(), "claude-mcp-reconnect-registry-"));

const hoisted = vi.hoisted(() => ({
  queue: new (class {
    private buf: unknown[] = [];
    private waiters: Array<() => void> = [];
    private closed = false;
    reset(): void {
      this.buf = [];
      this.closed = false;
    }
    push(m: unknown): void {
      this.buf.push(m);
      for (const w of this.waiters.splice(0)) w();
    }
    end(): void {
      this.closed = true;
      for (const w of this.waiters.splice(0)) w();
    }
    async *iterate(): AsyncGenerator<unknown> {
      for (;;) {
        while (this.buf.length) yield this.buf.shift();
        if (this.closed) return;
        await new Promise<void>((resolve) => this.waiters.push(resolve));
      }
    }
  })(),
  /** Poll answers, in order; the LAST one repeats when the script runs out. */
  statusScript: [] as Array<Array<{ name: string; status: string }>>,
  polls: 0,
  /** Servers the harness was asked to reconnect, in order. */
  reconnectCalls: [] as string[],
  /** When true the mock query has no reconnectMcpServer at all. */
  omitReconnect: false,
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (arg: { prompt?: AsyncIterable<unknown> }) => {
    void (async () => {
      for await (const _ of arg.prompt ?? []) void _;
    })();
    const iter = hoisted.queue.iterate();
    return Object.assign(iter, {
      supportedModels: async () => [],
      supportedCommands: async () => [],
      interrupt: async () => {},
      setModel: async () => {},
      mcpServerStatus: async () => {
        hoisted.polls += 1;
        const script = hoisted.statusScript;
        if (script.length === 0) throw new Error("no status available");
        return script.length > 1 ? script.shift() : script[0];
      },
      ...(hoisted.omitReconnect
        ? {}
        : {
            reconnectMcpServer: async (name: string) => {
              hoisted.reconnectCalls.push(name);
            },
          }),
    });
  },
}));

beforeEach(() => {
  hoisted.queue.reset();
  hoisted.statusScript = [];
  hoisted.polls = 0;
  hoisted.reconnectCalls = [];
  hoisted.omitReconnect = false;
});

const CONNECTED = [
  { name: "comfyui", status: "connected" },
  { name: "panel", status: "connected" },
];
const PANEL_DOWN = [
  { name: "comfyui", status: "connected" },
  { name: "panel", status: "failed" },
];

const INIT_HEALTHY = {
  type: "system",
  subtype: "init",
  session_id: "00000000-1111-2222-3333-444444444444",
  model: "claude-test-1",
  apiKeySource: "none",
  skills: [],
  mcp_servers: CONNECTED,
};

/** A stand-in for the in-process panel server (createSdkMcpServer's shape). */
const PANEL_SERVER = { type: "sdk", name: "comfyui-panel", instance: {} } as never;
const COMFYUI_SERVER = { type: "stdio", command: "node", args: [] } as never;
const DEPS = { mcpServers: { comfyui: COMFYUI_SERVER }, panelServer: PANEL_SERVER };

const noticesOf = (events: AgentEvent[]) =>
  events.filter(
    (e): e is Extract<AgentEvent, { type: "error" }> =>
      e.type === "error" && (e as { sessionNotice?: boolean }).sessionNotice === true,
  );

interface Drive {
  events: AgentEvent[];
  /** Push one result message and wait for the run loop to finish with it. */
  endTurn(): Promise<void>;
  finish(): Promise<void>;
}

/** Drives a session turn by turn, so a scenario controls what each poll — one
 *  per turn end — answers. The run loop is a single consumer, so polls are
 *  taken from the script in turn order. */
async function startDrive(init: unknown): Promise<Drive> {
  const { ClaudeBackend } = await import("../../orchestrator/claude-backend.js");
  const backend = new ClaudeBackend({
    mcpServers: DEPS.mcpServers as never,
    systemAppend: "",
    panelServer: DEPS.panelServer as never,
  });
  const events: AgentEvent[] = [];
  async function* turns(): AsyncGenerator<{ text: string }> {
    yield { text: "hello" };
    await new Promise<void>(() => {}); // never submits again
  }
  const done = (async () => {
    for await (const ev of backend.run({ channel: turns() as never })) events.push(ev);
  })();
  hoisted.queue.push(init);
  await waitFor(() => expect(events.some((e) => e.type === "session")).toBe(true));
  let ended = 0;
  return {
    events,
    async endTurn() {
      ended += 1;
      hoisted.queue.push({ type: "result", subtype: "success" });
      await waitFor(() =>
        expect(events.filter((e) => e.type === "result").length).toBeGreaterThanOrEqual(ended),
      );
    },
    async finish() {
      hoisted.queue.end();
      await done;
    },
  };
}

describe("a mid-session MCP drop is met with one bounded reconnect (#1524)", () => {
  it("a drop the reconnect fixes is narrated once, as fixed", async () => {
    // The reporter's six-hour outcome, inverted: the poll sees the drop, the
    // reconnect is tried, the verdict re-read says connected — and the ONLY
    // line the user gets is the accurate one.
    hoisted.statusScript = [PANEL_DOWN, CONNECTED];
    const drive = await startDrive(INIT_HEALTHY);
    await drive.endTurn();
    await drive.finish();

    expect(hoisted.reconnectCalls).toEqual(["panel"]);
    const notices = noticesOf(drive.events);
    expect(notices).toHaveLength(1);
    expect(notices[0].message).toContain("panel");
    expect(notices[0].message).toMatch(/reconnect brought it back/);
  });

  it("a drop the reconnect does NOT fix is reported once — not fought every turn", async () => {
    hoisted.statusScript = [PANEL_DOWN]; // every poll answers "failed"
    const drive = await startDrive(INIT_HEALTHY);
    await drive.endTurn();
    await drive.endTurn();
    await drive.endTurn();
    await drive.finish();

    // One attempt per episode: three turn ends, one reconnect.
    expect(hoisted.reconnectCalls).toEqual(["panel"]);
    // One line per episode: the user is told, not spammed.
    const notices = noticesOf(drive.events);
    expect(notices).toHaveLength(1);
    expect(notices[0].message).toContain("panel");
    expect(notices[0].message).toMatch(/reconnect did not bring it back/);
  });

  it("a server the harness heals itself is credited to the harness, not to us", async () => {
    // The reporter watched exactly this asymmetry: comfyui came back on the
    // harness's own reconnect. When OUR poll sees a down server read connected
    // again without our attempt, the notice says so.
    hoisted.statusScript = [PANEL_DOWN, PANEL_DOWN, CONNECTED];
    hoisted.omitReconnect = true; // nothing we could have done — it healed anyway
    const drive = await startDrive(INIT_HEALTHY);
    await drive.endTurn(); // sees the drop, reports it (no reconnect to ask for)
    await drive.endTurn(); // still down, already reported — silent
    await drive.endTurn(); // reads connected: self-heal
    await drive.finish();

    const notices = noticesOf(drive.events);
    expect(notices).toHaveLength(2);
    expect(notices[0].message).toMatch(/no reconnect to ask for/);
    expect(notices[1].message).toMatch(/connected again/);
    expect(notices[1].message).not.toMatch(/reconnect brought/);
  });

  it("a needs-auth server is reported but never retried", async () => {
    // Auth waits on the user; an automatic retry claims effort that cannot
    // land. Reported once, attempted never.
    hoisted.statusScript = [
      [
        { name: "comfyui", status: "connected" },
        { name: "panel", status: "needs-auth" },
      ],
    ];
    const drive = await startDrive(INIT_HEALTHY);
    await drive.endTurn();
    await drive.endTurn();
    await drive.finish();

    expect(hoisted.reconnectCalls).toEqual([]);
    const notices = noticesOf(drive.events);
    expect(notices).toHaveLength(1);
    expect(notices[0].message).toMatch(/cannot clear this status/);
  });

  it("a second drop after a recovery is a NEW episode, with its own attempt", async () => {
    hoisted.statusScript = [PANEL_DOWN, CONNECTED, CONNECTED, PANEL_DOWN];
    const drive = await startDrive(INIT_HEALTHY);
    await drive.endTurn(); // poll: drop → reconnect → verdict re-read: back
    await drive.endTurn(); // poll: healthy — silent
    await drive.endTurn(); // poll: drop again → reconnect → verdict: still down
    await drive.finish();

    expect(hoisted.reconnectCalls).toEqual(["panel", "panel"]);
    const notices = noticesOf(drive.events);
    expect(notices).toHaveLength(2);
    expect(notices[0].message).toMatch(/reconnect brought it back/);
    expect(notices[1].message).toMatch(/reconnect did not bring it back/);
  });

  it("a session that STARTED without the server gets its owed attempt at the first turn end", async () => {
    // Init reported the drop (its own notice, immediately); the notice promised
    // the reconnect outcome, and the first turn end delivers it.
    hoisted.statusScript = [PANEL_DOWN];
    const drive = await startDrive({
      ...INIT_HEALTHY,
      mcp_servers: PANEL_DOWN,
    });
    await drive.endTurn();
    await drive.finish();

    expect(hoisted.reconnectCalls).toEqual(["panel"]);
    const notices = noticesOf(drive.events);
    expect(notices).toHaveLength(2);
    expect(notices[0].message).toMatch(/started without/);
    expect(notices[1].message).toMatch(/reconnect did not bring it back/);
  });

  it("an init-degraded server the harness heals before the first turn is reported as back", async () => {
    hoisted.statusScript = [CONNECTED];
    const drive = await startDrive({
      ...INIT_HEALTHY,
      mcp_servers: PANEL_DOWN,
    });
    await drive.endTurn();
    await drive.finish();

    // It came back on its own — no attempt of ours to credit.
    expect(hoisted.reconnectCalls).toEqual([]);
    const notices = noticesOf(drive.events);
    expect(notices).toHaveLength(2);
    expect(notices[0].message).toMatch(/started without/);
    expect(notices[1].message).toMatch(/connected again/);
  });
});
