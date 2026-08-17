// #1524, WIRING — the check has to run on the real init path, against the real
// configured server set.
//
// A helper-only suite would pass with the call site deleted: `degradedMcpServers`
// is pure, and a test that builds both sides itself proves only that it compares
// two arrays. What has to be pinned is that `route()`'s `system`/`init` branch
// feeds it (a) the servers this session was actually GIVEN — including the
// in-process `panel` server, which is added inside buildOptions and appears in no
// dep — and (b) the report the harness sent, and that a degraded session yields a
// visible event.
//
// Harness pattern follows claude-turn-markers.test.ts: the optional Agent SDK is
// mocked, the backend is driven through run(), and the canonical AgentEvents are
// collected.

import { describe, expect, it, beforeEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "../../orchestrator/agent-backend.js";
import { waitFor } from "../helpers/wait-for.js";

process.env.COMFYUI_MCP_TURN_REGISTRY_DIR = mkdtempSync(join(tmpdir(), "claude-init-mcp-registry-"));

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
  /** The mcpServers object the backend actually handed the SDK. */
  lastMcpServers: null as Record<string, unknown> | null,
  /** What `q.mcpServerStatus()` answers, and how many times it was asked. */
  statusPoll: null as null | Array<{ name: string; status: string }>,
  /** Sequential poll answers: each mcpServerStatus() call shifts one entry, and
   *  the static statusPoll answers once the queue is drained. Lets a test give
   *  the settle poll and the post-reconnect verify poll DIFFERENT outcomes. */
  statusPollQueue: [] as Array<Array<{ name: string; status: string }>>,
  statusPolls: 0,
  /** `q.reconnectMcpServer()` calls, in order, and whether it throws. */
  reconnectCalls: [] as string[],
  reconnectThrows: false,
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (arg: { prompt?: AsyncIterable<unknown>; options?: { mcpServers?: Record<string, unknown> } }) => {
    hoisted.lastMcpServers = arg.options?.mcpServers ?? null;
    void (async () => {
      for await (const _ of arg.prompt ?? []) void _;
    })();
    const iter = hoisted.queue.iterate();
    return Object.assign(iter, {
      supportedModels: async () => [],
      supportedCommands: async () => [],
      interrupt: async () => {},
      setModel: async () => {},
      reconnectMcpServer: async (name: string) => {
        hoisted.reconnectCalls.push(name);
        if (hoisted.reconnectThrows) throw new Error("reconnect refused");
      },
      mcpServerStatus: async () => {
        hoisted.statusPolls += 1;
        const poll = hoisted.statusPollQueue.shift() ?? hoisted.statusPoll;
        if (!poll) throw new Error("no status available");
        return poll;
      },
    });
  },
}));

beforeEach(() => {
  hoisted.queue.reset();
  hoisted.lastMcpServers = null;
  hoisted.statusPoll = null;
  hoisted.statusPollQueue = [];
  hoisted.statusPolls = 0;
  hoisted.reconnectCalls = [];
  hoisted.reconnectThrows = false;
});

const initWith = (mcp_servers?: Array<{ name: string; status: string }>) => ({
  type: "system",
  subtype: "init",
  session_id: "00000000-1111-2222-3333-444444444444",
  model: "claude-test-1",
  apiKeySource: "none",
  skills: [],
  ...(mcp_servers ? { mcp_servers } : {}),
});

/** A stand-in for the in-process panel server (createSdkMcpServer's shape). */
const PANEL_SERVER = { type: "sdk", name: "comfyui-panel", instance: {} } as never;
const COMFYUI_SERVER = { type: "stdio", command: "node", args: [] } as never;

async function drive(
  deps: { mcpServers?: Record<string, unknown>; panelServer?: unknown },
  init: unknown,
): Promise<AgentEvent[]> {
  const { ClaudeBackend } = await import("../../orchestrator/claude-backend.js");
  const backend = new ClaudeBackend({
    mcpServers: (deps.mcpServers ?? {}) as never,
    systemAppend: "",
    ...(deps.panelServer ? { panelServer: deps.panelServer as never } : {}),
  });
  const events: AgentEvent[] = [];
  async function* idle(): AsyncGenerator<{ text: string }> {
    await new Promise<void>(() => {}); // never submits a turn
  }
  const done = (async () => {
    for await (const ev of backend.run({ channel: idle() as never })) events.push(ev);
  })();
  hoisted.queue.push(init);
  await waitFor(() => expect(events.some((e) => e.type === "session")).toBe(true));
  hoisted.queue.end();
  await done;
  return events;
}

/** Same, but the session takes a turn and ends it — the point at which a server
 *  still connecting at init is re-read. `turns` result messages are pushed. */
async function driveTurns(
  deps: { mcpServers?: Record<string, unknown>; panelServer?: unknown },
  init: unknown,
  turns = 1,
): Promise<AgentEvent[]> {
  const { ClaudeBackend } = await import("../../orchestrator/claude-backend.js");
  const backend = new ClaudeBackend({
    mcpServers: (deps.mcpServers ?? {}) as never,
    systemAppend: "",
    ...(deps.panelServer ? { panelServer: deps.panelServer as never } : {}),
  });
  const events: AgentEvent[] = [];
  async function* oneTurn(): AsyncGenerator<{ text: string }> {
    yield { text: "hello" };
    await new Promise<void>(() => {});
  }
  const done = (async () => {
    for await (const ev of backend.run({ channel: oneTurn() as never })) events.push(ev);
  })();
  hoisted.queue.push(init);
  await waitFor(() => expect(events.some((e) => e.type === "session")).toBe(true));
  for (let i = 0; i < turns; i++) hoisted.queue.push({ type: "result", subtype: "success" });
  await waitFor(() => expect(events.filter((e) => e.type === "result")).toHaveLength(turns));
  hoisted.queue.end();
  await done;
  return events;
}

const noticesOf = (events: AgentEvent[]) =>
  events.filter(
    (e): e is Extract<AgentEvent, { type: "error" }> =>
      e.type === "error" && (e as { sessionNotice?: boolean }).sessionNotice === true,
  );

describe("a Claude session that started without an MCP server reports it (#1524)", () => {
  it("names the panel server when the session came up without it", async () => {
    // The reporter's exact split: comfyui back, the 92 panel_* tools gone.
    const events = await drive(
      { mcpServers: { comfyui: COMFYUI_SERVER }, panelServer: PANEL_SERVER },
      initWith([
        { name: "comfyui", status: "connected" },
        { name: "panel", status: "failed" },
      ]),
    );
    const notices = noticesOf(events);
    expect(notices).toHaveLength(1);
    expect(notices[0].message).toContain("panel");
    // …and does NOT accuse the server that DID come up. Over-reporting here is
    // the same defect pointing the other way.
    expect(notices[0].message).not.toContain("comfyui");
  });

  it("compares against the server set the session was GIVEN, panel included", async () => {
    // The `panel` entry is added inside the backend, not passed in deps. A check
    // that compared the report against `deps.mcpServers` alone would never see
    // the panel server go missing — which is the entire reported failure.
    const events = await drive(
      { mcpServers: { comfyui: COMFYUI_SERVER }, panelServer: PANEL_SERVER },
      initWith([{ name: "comfyui", status: "connected" }]),
    );
    expect(hoisted.lastMcpServers && Object.keys(hoisted.lastMcpServers).sort()).toEqual([
      "comfyui",
      "panel",
    ]);
    expect(noticesOf(events)[0]?.message).toContain("panel");
  });

  it("stays silent when every configured server connected", async () => {
    const events = await drive(
      { mcpServers: { comfyui: COMFYUI_SERVER }, panelServer: PANEL_SERVER },
      initWith([
        { name: "comfyui", status: "connected" },
        { name: "panel", status: "connected" },
      ]),
    );
    expect(noticesOf(events)).toHaveLength(0);
  });

  it("stays silent when the harness sends no report at all", async () => {
    // Older/other harnesses omit the field. Silence there is mandatory: this
    // path runs on every session start.
    const events = await drive(
      { mcpServers: { comfyui: COMFYUI_SERVER }, panelServer: PANEL_SERVER },
      initWith(undefined),
    );
    expect(noticesOf(events)).toHaveLength(0);
  });

  it("does not report `panel` for a backend that was never given one", async () => {
    // makePanelServer returns undefined for non-claude keys, so `panel` is not in
    // that session's set and its absence from the report is correct, not a fault.
    const events = await drive(
      { mcpServers: { comfyui: COMFYUI_SERVER } },
      initWith([{ name: "comfyui", status: "connected" }]),
    );
    expect(noticesOf(events)).toHaveLength(0);
  });

  it("stays silent for a server still CONNECTING at init", async () => {
    // Server startup does not block the session, so `pending` at init is a slow
    // connection, not a failed one. Reporting it would fire on healthy sessions.
    const events = await drive(
      { mcpServers: { comfyui: COMFYUI_SERVER }, panelServer: PANEL_SERVER },
      initWith([
        { name: "comfyui", status: "connected" },
        { name: "panel", status: "pending" },
      ]),
    );
    expect(noticesOf(events)).toHaveLength(0);
  });

  it("still emits the session event alongside the notice", async () => {
    // The notice must not displace init's real job — a swallowed session id
    // would break resume, which is a far worse bug than the one being fixed.
    const events = await drive(
      { mcpServers: { comfyui: COMFYUI_SERVER }, panelServer: PANEL_SERVER },
      initWith([{ name: "comfyui", status: "failed" }]),
    );
    expect(events.filter((e) => e.type === "session")).toHaveLength(1);
    expect(noticesOf(events)).toHaveLength(1);
  });
});

describe("a server that was still connecting at init gets settled (#1524)", () => {
  it("reports it when it settled as FAILED", async () => {
    // The hole an init-only check leaves: `init` is the only MCP report the
    // session pushes, so `pending` there followed by a failure is silent forever
    // — the same six-hour silence, moved a few hundred milliseconds later.
    hoisted.statusPoll = [
      { name: "comfyui", status: "connected" },
      { name: "panel", status: "failed" },
    ];
    const events = await driveTurns(
      { mcpServers: { comfyui: COMFYUI_SERVER }, panelServer: PANEL_SERVER },
      initWith([
        { name: "comfyui", status: "connected" },
        { name: "panel", status: "pending" },
      ]),
    );
    const notices = noticesOf(events);
    expect(notices).toHaveLength(1);
    expect(notices[0].message).toContain("panel");
    // #1228 — the failure was reconnect-attempted and verified still down before
    // the notice went out: one settle poll, one reconnect, one verify poll.
    expect(hoisted.reconnectCalls).toEqual(["panel"]);
    expect(hoisted.statusPolls).toBe(2);
    expect(notices[0].message).toMatch(/reconnect was already attempted/);
  });

  it("says nothing when it settled as connected", async () => {
    hoisted.statusPoll = [
      { name: "comfyui", status: "connected" },
      { name: "panel", status: "connected" },
    ];
    const events = await driveTurns(
      { mcpServers: { comfyui: COMFYUI_SERVER }, panelServer: PANEL_SERVER },
      initWith([
        { name: "comfyui", status: "connected" },
        { name: "panel", status: "pending" },
      ]),
    );
    expect(noticesOf(events)).toHaveLength(0);
    expect(hoisted.statusPolls).toBe(1);
  });

  it("re-reads ONCE, not on every turn", async () => {
    hoisted.statusPoll = [
      { name: "comfyui", status: "connected" },
      { name: "panel", status: "connected" },
    ];
    await driveTurns(
      { mcpServers: { comfyui: COMFYUI_SERVER }, panelServer: PANEL_SERVER },
      initWith([
        { name: "comfyui", status: "connected" },
        { name: "panel", status: "pending" },
      ]),
      3,
    );
    expect(hoisted.statusPolls).toBe(1);
  });

  it("does not poll at all when nothing was pending", async () => {
    // The re-read is a control round-trip. A healthy session must not pay for it
    // on every turn it completes.
    hoisted.statusPoll = [{ name: "comfyui", status: "connected" }];
    await driveTurns(
      { mcpServers: { comfyui: COMFYUI_SERVER }, panelServer: PANEL_SERVER },
      initWith([
        { name: "comfyui", status: "connected" },
        { name: "panel", status: "connected" },
      ]),
      2,
    );
    expect(hoisted.statusPolls).toBe(0);
  });

  it("stays silent when the poll is unavailable or throws", async () => {
    // `mcpServerStatus()` is an optional Query method. A harness without it
    // leaves the pending servers unmentioned rather than guessed at — and must
    // never take the turn stream down with it.
    hoisted.statusPoll = null; // the mock throws
    const events = await driveTurns(
      { mcpServers: { comfyui: COMFYUI_SERVER }, panelServer: PANEL_SERVER },
      initWith([
        { name: "comfyui", status: "connected" },
        { name: "panel", status: "pending" },
      ]),
    );
    expect(noticesOf(events)).toHaveLength(0);
    expect(events.filter((e) => e.type === "result")).toHaveLength(1);
  });
});

describe("a down server gets ONE reconnect attempt before any notice (#1228)", () => {
  // The reported failure: a tool-session respawn reconnected `comfyui` but never
  // re-registered the in-process `panel` server, and the reconnect notice read
  // as success. The respawn path now tries the one remedy short of a new session
  // — an explicit reconnectMcpServer — and only announces what is still down.

  it("recovers without a notice when the reconnect brings the panel server back", async () => {
    // The reporter's exact shape at init — panel failed — but the reconnect
    // fixes it. The tool surface is intact, so there is nothing to announce.
    hoisted.statusPoll = [
      { name: "comfyui", status: "connected" },
      { name: "panel", status: "connected" },
    ];
    const events = await drive(
      { mcpServers: { comfyui: COMFYUI_SERVER }, panelServer: PANEL_SERVER },
      initWith([
        { name: "comfyui", status: "connected" },
        { name: "panel", status: "failed" },
      ]),
    );
    expect(hoisted.reconnectCalls).toEqual(["panel"]);
    expect(noticesOf(events)).toHaveLength(0);
    // The recovery is only claimed after being READ BACK: one verify poll.
    expect(hoisted.statusPolls).toBe(1);
  });

  it("announces only what is STILL down after the attempt, and says the attempt happened", async () => {
    hoisted.statusPoll = [
      { name: "comfyui", status: "connected" },
      { name: "panel", status: "failed" },
    ];
    const events = await drive(
      { mcpServers: { comfyui: COMFYUI_SERVER }, panelServer: PANEL_SERVER },
      initWith([
        { name: "comfyui", status: "connected" },
        { name: "panel", status: "failed" },
      ]),
    );
    expect(hoisted.reconnectCalls).toEqual(["panel"]);
    const notices = noticesOf(events);
    expect(notices).toHaveLength(1);
    expect(notices[0].message).toContain("panel");
    expect(notices[0].message).not.toContain("comfyui");
    // Verified still down AFTER the attempt — the notice must say so, or the
    // agent would try the same reconnect itself and call that a remedy.
    expect(notices[0].message).toMatch(/reconnect was already attempted/);
  });

  it("still reports when the reconnect itself throws", async () => {
    hoisted.reconnectThrows = true;
    hoisted.statusPoll = [
      { name: "comfyui", status: "connected" },
      { name: "panel", status: "failed" },
    ];
    const events = await drive(
      { mcpServers: { comfyui: COMFYUI_SERVER }, panelServer: PANEL_SERVER },
      initWith([
        { name: "comfyui", status: "connected" },
        { name: "panel", status: "failed" },
      ]),
    );
    const notices = noticesOf(events);
    expect(notices).toHaveLength(1);
    expect(notices[0].message).toContain("panel");
  });

  it("does not claim the attempt failed when its outcome could not be verified", async () => {
    // The reconnect ran but the verify poll is unavailable. "Did not come back"
    // would be a claim nobody checked — the notice falls back to the plain
    // observation, still naming the server.
    hoisted.statusPoll = null; // the poll throws
    const events = await drive(
      { mcpServers: { comfyui: COMFYUI_SERVER }, panelServer: PANEL_SERVER },
      initWith([
        { name: "comfyui", status: "connected" },
        { name: "panel", status: "failed" },
      ]),
    );
    expect(hoisted.reconnectCalls).toEqual(["panel"]);
    const notices = noticesOf(events);
    expect(notices).toHaveLength(1);
    expect(notices[0].message).toContain("panel");
    expect(notices[0].message).not.toMatch(/reconnect was already attempted/);
  });

  it("attempts nothing when every configured server connected", async () => {
    // Recovery must not cost a healthy session a control round-trip.
    const events = await drive(
      { mcpServers: { comfyui: COMFYUI_SERVER }, panelServer: PANEL_SERVER },
      initWith([
        { name: "comfyui", status: "connected" },
        { name: "panel", status: "connected" },
      ]),
    );
    expect(hoisted.reconnectCalls).toEqual([]);
    expect(noticesOf(events)).toHaveLength(0);
  });

  it("recovers a server that was still connecting at init and failed by the first turn end", async () => {
    // Same remedy on the settle path: the settle poll sees the failure, the
    // reconnect fixes it, the verify poll confirms — nothing is announced.
    hoisted.statusPollQueue = [
      [
        { name: "comfyui", status: "connected" },
        { name: "panel", status: "failed" },
      ],
      [
        { name: "comfyui", status: "connected" },
        { name: "panel", status: "connected" },
      ],
    ];
    const events = await driveTurns(
      { mcpServers: { comfyui: COMFYUI_SERVER }, panelServer: PANEL_SERVER },
      initWith([
        { name: "comfyui", status: "connected" },
        { name: "panel", status: "pending" },
      ]),
    );
    expect(hoisted.reconnectCalls).toEqual(["panel"]);
    expect(noticesOf(events)).toHaveLength(0);
    expect(hoisted.statusPolls).toBe(2);
  });

  it("a server still CONNECTING after the reconnect is settled later, not announced", async () => {
    // The reconnect turned `failed` into `pending`: neither down nor verified
    // up. It is carried into the first-turn-end settle, which reads it once
    // more — connected here, so the session never hears about it.
    hoisted.statusPollQueue = [
      [
        { name: "comfyui", status: "connected" },
        { name: "panel", status: "pending" },
      ],
      [
        { name: "comfyui", status: "connected" },
        { name: "panel", status: "connected" },
      ],
    ];
    const events = await driveTurns(
      { mcpServers: { comfyui: COMFYUI_SERVER }, panelServer: PANEL_SERVER },
      initWith([
        { name: "comfyui", status: "connected" },
        { name: "panel", status: "failed" },
      ]),
    );
    expect(hoisted.reconnectCalls).toEqual(["panel"]);
    expect(noticesOf(events)).toHaveLength(0);
    expect(hoisted.statusPolls).toBe(2);
  });
});
