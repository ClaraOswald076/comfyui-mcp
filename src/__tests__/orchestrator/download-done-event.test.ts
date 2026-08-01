// #547: a finished download must wake the agent, mirroring the render-finished
// path (manager.injectEvent kind:"executed"). This locks the manager+agent side
// of the wiring: injectEvent(kind:"download_done") enqueues a NON-urgent turn
// whose text names the settled downloads and points at download_status, and a
// coalesced batch of several files produces ONE turn (not N). liveKeys() exposes
// the single-live-agent fallback the orchestrator uses for un-stamped rows.

import { beforeAll, describe, expect, it } from "vitest";
import type {
  AgentBackend,
  AgentEvent,
  BackendStartOptions,
  ModelChoice,
} from "../../orchestrator/agent-backend.js";
import { CLAUDE_CAPABILITIES } from "../../orchestrator/agent-backend.js";

let PanelAgentManager: typeof import("../../orchestrator/panel-agent.js").PanelAgentManager;

beforeAll(async () => {
  ({ PanelAgentManager } = await import("../../orchestrator/panel-agent.js"));
});

/** Records the text of every turn the agent runs, and auto-completes each. */
class TurnRecordingBackend implements AgentBackend {
  readonly id = "claude" as const;
  readonly capabilities = CLAUDE_CAPABILITIES;
  turns: string[] = [];

  async *run(opts: BackendStartOptions): AsyncGenerator<AgentEvent> {
    yield { type: "session", sessionId: "sess-dl" };
    for await (const turn of opts.channel) {
      this.turns.push((turn as { text?: string }).text ?? "");
      yield { type: "result", ok: true, subtype: "success" };
    }
  }

  async interrupt(): Promise<void> {}
  async listModels(): Promise<ModelChoice[]> {
    return [];
  }
}

function makeManager(backend: AgentBackend) {
  return new PanelAgentManager({
    mcpServers: {},
    systemAppend: "",
    model: "claude-test",
    onSay: () => {},
    onTurn: () => {},
    makeBackend: () => backend,
  } as never);
}

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("download-completion agent event (#547)", () => {
  it("injectEvent(download_done) wakes the agent with a turn naming the download and download_status", async () => {
    const backend = new TurnRecordingBackend();
    const manager = makeManager(backend);
    const tab = "tab-dl";

    manager.send(tab, "hi");
    await waitFor(() => backend.turns.length >= 1);

    const delivered = manager.injectEvent(tab, {
      kind: "download_done",
      downloads: [{ name: "z_image_turbo_bf16.safetensors", status: "done" }],
    });
    expect(delivered).toBe(true);

    await waitFor(() => backend.turns.length >= 2);
    const evText = backend.turns[1];
    expect(evText).toContain("z_image_turbo_bf16.safetensors");
    expect(evText).toContain("finished");
    expect(evText).toContain("download_status");
  });

  it("a coalesced batch (many files) produces ONE turn listing all of them", async () => {
    const backend = new TurnRecordingBackend();
    const manager = makeManager(backend);
    const tab = "tab-batch";

    manager.send(tab, "hi");
    await waitFor(() => backend.turns.length >= 1);

    manager.injectEvent(tab, {
      kind: "download_done",
      downloads: [
        { name: "a.safetensors", status: "done" },
        { name: "b.safetensors", status: "done" },
        { name: "c.safetensors", status: "error" },
      ],
    });

    await waitFor(() => backend.turns.length >= 2);
    // Only ONE new turn for the whole batch.
    await new Promise((r) => setTimeout(r, 60));
    expect(backend.turns.length).toBe(2);
    const evText = backend.turns[1];
    expect(evText).toContain("a.safetensors");
    expect(evText).toContain("b.safetensors");
    expect(evText).toContain("c.safetensors");
    expect(evText).toContain("FAILED");
  });

  it("liveKeys() reports the single live agent (the un-stamped-row fallback)", async () => {
    const backend = new TurnRecordingBackend();
    const manager = makeManager(backend);
    expect(manager.liveKeys()).toEqual([]);
    manager.send("only-tab", "hi");
    await waitFor(() => backend.turns.length >= 1);
    expect(manager.liveKeys()).toEqual(["only-tab"]);
  });

  it("injectEvent into a nonexistent agent is a no-op returning false", () => {
    const backend = new TurnRecordingBackend();
    const manager = makeManager(backend);
    const delivered = manager.injectEvent("ghost", {
      kind: "download_done",
      downloads: [{ name: "x", status: "done" }],
    });
    expect(delivered).toBe(false);
  });
});
