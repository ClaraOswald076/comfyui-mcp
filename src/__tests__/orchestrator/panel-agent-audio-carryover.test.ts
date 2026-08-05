import { describe, expect, it } from "vitest";
import { PanelAgentManager } from "../../orchestrator/panel-agent.js";
import type {
  AgentBackend,
  AgentCapabilities,
  AgentEvent,
  BackendStartOptions,
  NeutralTurn,
} from "../../orchestrator/agent-backend.js";

// #790 — an audio attachment must survive every path that RE-DELIVERS a queued
// message. These carry-overs copy fields one by one, so a new field is silently
// omitted by default: the message is retried as text-only, with no refusal and
// no notice anywhere that the sound went missing. That is the exact failure
// shape this feature exists to remove, arriving through the back door.

const CAPS: AgentCapabilities = {
  persistentChannel: true,
  streamingDeltas: true,
  interruptMidTurn: true,
  forkAtAnchor: false,
  inProcessMcp: false,
  modelEnumeration: false,
  slashCommands: false,
  hooks: false,
  vision: true,
  audio: true,
  turnMarkers: true,
};

/** A backend whose FIRST start fails (so the queued message lands in held mail)
 *  and whose second start records the turns it receives. */
function flakyBackend() {
  const seen: NeutralTurn[] = [];
  let starts = 0;
  const backend: AgentBackend = {
    id: "ollama",
    capabilities: CAPS,
    async prepare() {
      starts += 1;
      if (starts === 1) throw new Error("first start fails");
    },
    async *run(opts: BackendStartOptions): AsyncIterable<AgentEvent> {
      yield { type: "session", sessionId: "s1" };
      for await (const turn of opts.channel) {
        seen.push(turn);
        yield { type: "assistant", text: "ok", turn: seen.length };
        yield { type: "result", ok: true, turn: seen.length };
        break;
      }
    },
    async interrupt() {},
    async listModels() {
      return [];
    },
  };
  return { backend, seen, startCount: () => starts };
}

function makeManager(makeBackend: () => AgentBackend) {
  return new PanelAgentManager({
    mcpServers: {},
    systemAppend: "",
    model: "gemma4:e2b",
    onSay: () => {},
    onTurn: () => {},
    onSession: () => {},
    makeBackend,
  } as never);
}

async function settle(ms = 400): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

describe("audio survives held-mail re-delivery after a failed agent start (#256 path)", () => {
  it("re-delivers the audio, not just the text", async () => {
    const { backend, seen } = flakyBackend();
    const manager = makeManager(() => backend);

    manager.send("tab1", "what key is this in?", { audio: [{ filename: "song.mp3", type: "input" }] });
    await settle(); // first start rejects; the message is captured as held mail
    expect(seen).toHaveLength(0);

    manager.send("tab1", "still there?"); // second start succeeds and drains held mail
    await settle();

    expect(seen.length).toBeGreaterThan(0);
    const withAudio = seen.filter((t) => t.audio?.length);
    expect(withAudio).toHaveLength(1);
    expect(withAudio[0].audio).toEqual([{ filename: "song.mp3", type: "input" }]);
    // …and the original text rode along with it.
    expect(withAudio[0].text).toContain("what key is this in?");

    await manager.stopAll?.().catch(() => {});
  });
});
