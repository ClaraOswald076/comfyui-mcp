import { describe, expect, it, vi } from "vitest";
import { PanelAgent } from "../../orchestrator/panel-agent.js";
import type {
  AgentBackend,
  AgentCapabilities,
  AgentEvent,
  BackendStartOptions,
  NeutralTurn,
} from "../../orchestrator/agent-backend.js";

// #790 — the CENTRAL audio gate.
//
// Most adapters have no audio content part at all (Claude, Codex, ChatGPT,
// antigravity, pi, grok-direct). Letting `turn.audio` reach them would drop the
// bytes with nothing in the transcript to show for it: the user asks about a
// sound, the model answers from the text, and neither party learns it never
// heard the file. So PanelAgent refuses once, for all of them, and says so in
// BOTH directions — the user in the panel, and the model in the turn text.

const BASE_CAPS: AgentCapabilities = {
  persistentChannel: true,
  streamingDeltas: true,
  interruptMidTurn: true,
  forkAtAnchor: false,
  inProcessMcp: false,
  modelEnumeration: false,
  slashCommands: false,
  hooks: false,
  vision: true,
  turnMarkers: true,
};

/** A backend that records the turns it is handed and then ends the run. */
function recordingBackend(caps: Partial<AgentCapabilities>, id = "claude") {
  const seen: NeutralTurn[] = [];
  const backend: AgentBackend = {
    id: id as AgentBackend["id"],
    capabilities: { ...BASE_CAPS, ...caps },
    async *run(opts: BackendStartOptions): AsyncIterable<AgentEvent> {
      yield { type: "session", sessionId: "s1" };
      for await (const turn of opts.channel) {
        seen.push(turn);
        yield { type: "assistant", text: "ok", turn: seen.length };
        yield { type: "result", ok: true, turn: seen.length };
        break; // one turn is enough for these assertions
      }
    },
    async interrupt() {},
    async listModels() {
      return [];
    },
  };
  return { backend, seen };
}

function makeAgent(backend: AgentBackend) {
  const said: Array<{ tabId: string; text: string }> = [];
  const agent = new PanelAgent(
    "tab1",
    {
      mcpServers: undefined,
      systemAppend: "",
      model: "m",
      onSay: (tabId, text) => said.push({ tabId, text }),
    },
    backend,
  );
  return { agent, said };
}

/** Drive one turn through the agent and resolve once the backend has seen it. */
async function runOneTurn(agent: PanelAgent, send: () => void): Promise<void> {
  const running = agent.start();
  send();
  await Promise.race([running, new Promise((r) => setTimeout(r, 500))]);
  await agent.stop().catch(() => {});
}

describe("a backend with NO audio content part", () => {
  it("refuses the attachment, names the provider, and never hands it to the backend", async () => {
    const { backend, seen } = recordingBackend({ audio: false }, "claude");
    const { agent, said } = makeAgent(backend);
    await runOneTurn(agent, () => agent.send("what key is this in?", { audio: [{ filename: "song.mp3" }] }));

    expect(seen).toHaveLength(1);
    // The bytes never reach an adapter that would discard them.
    expect(seen[0].audio).toBeUndefined();
    // The USER is told, by name, with a remedy.
    const userFacing = said.map((s) => s.text).join("\n");
    expect(userFacing).toContain("song.mp3");
    expect(userFacing).toContain("claude");
    expect(userFacing.toLowerCase()).toContain("ollama");
    // The MODEL is told, so it cannot answer as though it had listened.
    expect(seen[0].text).toContain("NO audio input");
    expect(seen[0].text).toContain("did NOT receive");
    expect(seen[0].text).toContain("song.mp3");
  });

  it("treats an UNDECLARED audio capability as false (the only safe reading)", async () => {
    // `audio` omitted entirely — an out-of-tree adapter, or one written before
    // #790. Guessing "true" here means a silently unheard attachment.
    const { backend, seen } = recordingBackend({}, "pi");
    const { agent, said } = makeAgent(backend);
    await runOneTurn(agent, () => agent.send("listen", { audio: [{ filename: "a.wav" }] }));
    expect(seen[0].audio).toBeUndefined();
    expect(said.map((s) => s.text).join("\n")).toContain("a.wav");
  });
});

describe("a backend that DOES carry audio", () => {
  it("passes the attachment through untouched and says nothing about it", async () => {
    const { backend, seen } = recordingBackend({ audio: true }, "ollama");
    const { agent, said } = makeAgent(backend);
    await runOneTurn(agent, () => agent.send("what do you hear?", { audio: [{ filename: "song.mp3" }] }));

    expect(seen[0].audio).toEqual([{ filename: "song.mp3" }]);
    expect(seen[0].text).not.toContain("did NOT receive");
    expect(said.map((s) => s.text).join("\n")).not.toContain("song.mp3");
  });

  it("leaves a turn with no audio completely alone", async () => {
    const { backend, seen } = recordingBackend({ audio: false }, "claude");
    const { agent, said } = makeAgent(backend);
    await runOneTurn(agent, () => agent.send("plain question"));
    expect(seen[0].text).toBe("plain question");
    expect(seen[0].audio).toBeUndefined();
    // Only the model's own reply is relayed — no attachment chatter at all.
    expect(said.map((s) => s.text)).toEqual(["ok"]);
  });
});

describe("audio and images are independent senses", () => {
  it("a vision-capable, audio-less backend keeps the image and refuses only the sound", async () => {
    const { backend, seen } = recordingBackend({ vision: true, audio: false }, "codex");
    const { agent, said } = makeAgent(backend);
    await runOneTurn(agent, () =>
      agent.send("compare these", { images: [{ filename: "shot.png" }], audio: [{ filename: "song.mp3" }] }),
    );
    expect(seen[0].images).toEqual([{ filename: "shot.png" }]);
    expect(seen[0].audio).toBeUndefined();
    const userFacing = said.map((s) => s.text).join("\n");
    expect(userFacing).toContain("song.mp3");
    expect(userFacing).not.toContain("text-only"); // the image gate did NOT fire
  });

  it("a text-only backend refuses both, each with its own reason", async () => {
    const { backend, seen } = recordingBackend({ vision: false, audio: false }, "antigravity");
    const { agent, said } = makeAgent(backend);
    await runOneTurn(agent, () =>
      agent.send("look and listen", { images: [{ filename: "shot.png" }], audio: [{ filename: "song.mp3" }] }),
    );
    expect(seen[0].images).toBeUndefined();
    expect(seen[0].audio).toBeUndefined();
    const userFacing = said.map((s) => s.text).join("\n");
    expect(userFacing).toContain("song.mp3"); // audio refusal
    expect(userFacing).toContain("text-only"); // image refusal
    expect(seen[0].text).toContain("did NOT receive"); // audio, model-facing
    expect(seen[0].text).toContain("CANNOT see them"); // images, model-facing
  });
});

describe("the vitest environment does not swallow the gate", () => {
  it("onSay is genuinely invoked (guards against a no-op test harness)", async () => {
    const onSay = vi.fn();
    const { backend } = recordingBackend({ audio: false }, "claude");
    const agent = new PanelAgent("tab1", { mcpServers: undefined, systemAppend: "", model: "m", onSay }, backend);
    await runOneTurn(agent, () => agent.send("hi", { audio: [{ filename: "x.wav" }] }));
    expect(onSay).toHaveBeenCalled();
  });
});

describe("two queued messages carrying the SAME file batch into one attachment", () => {
  it("does not spend a second audio slot on bytes already attached", async () => {
    // The batch merges the two messages into one turn. Without a dedupe the turn
    // carries song.wav twice, which both wastes one of the two per-turn slots
    // and — with a third, different file — refuses a real attachment out loud
    // for "not fitting" while the duplicate rides the request.
    const { backend, seen } = recordingBackend({ audio: true }, "ollama");
    const { agent } = makeAgent(backend);
    await runOneTurn(agent, () => {
      agent.send("what key is this in?", { audio: [{ filename: "song.wav", type: "input" }] });
      agent.send("and the tempo?", { audio: [{ filename: "song.wav", type: "input" }] });
    });
    expect(seen).toHaveLength(1); // they really did batch
    expect(seen[0].audio).toEqual([{ filename: "song.wav", type: "input" }]);
  });

  it("still carries two genuinely different files", async () => {
    const { backend, seen } = recordingBackend({ audio: true }, "ollama");
    const { agent } = makeAgent(backend);
    await runOneTurn(agent, () => {
      agent.send("first", { audio: [{ filename: "a.wav", type: "input" }] });
      agent.send("second", { audio: [{ filename: "b.wav", type: "input" }] });
    });
    expect(seen[0].audio).toHaveLength(2);
  });
});
