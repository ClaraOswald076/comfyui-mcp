// #1700 — panel_remove_mcp + panel_reload left the removed server in the
// resumed session's MCP set, and the panel kept reporting it as failed.
//
// Two stacked facts:
//   1. panel_reload's frontend soft_reload only drops the websocket (this pack's
//      /reload is a 503). The live agent is not replaced, so it keeps the MCP
//      set it was spawned with.
//   2. Even a replacement that RESUMES the session restores the MCP set recorded
//      WITH that session, ignoring the freshly-read ~/.claude.json.
//
// The shipped fix: panel_reload({scope:"orchestrator"}) calls
// restartForMcpConfig, which respawns via makeMcpServers() (re-read) AND forks
// so the SDK cannot restore the old set.
//
// These tests drive the REAL remove + the REAL manager restart. A fake expected
// server list would pass with the spawn still handing the old set.

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentBackend,
  AgentEvent,
  BackendStartOptions,
  ModelChoice,
} from "../../orchestrator/agent-backend.js";
import { CLAUDE_CAPABILITIES } from "../../orchestrator/agent-backend.js";
import { readFileSync } from "node:fs";

let PanelAgentManager: typeof import("../../orchestrator/panel-agent.js").PanelAgentManager;
let readUserMcpServers: typeof import("../../services/user-mcp-config.js").readUserMcpServers;
let removeUserMcpServer: typeof import("../../services/user-mcp-config.js").removeUserMcpServer;

beforeAll(async () => {
  ({ PanelAgentManager } = await import("../../orchestrator/panel-agent.js"));
  ({ readUserMcpServers, removeUserMcpServer } = await import("../../services/user-mcp-config.js"));
});

const CLAUDE_JSON = {
  mcpServers: {
    magic: { type: "stdio", command: "npx", args: ["-y", "@21st-dev/magic"] },
    codegraph: { type: "http", url: "http://127.0.0.1:9999" },
  },
};

class RecordingBackend implements AgentBackend {
  readonly id = "claude" as const;
  readonly capabilities = CLAUDE_CAPABILITIES;
  runs: BackendStartOptions[] = [];
  autoComplete = true;
  private releaseTurn: (() => void) | null = null;

  async *run(opts: BackendStartOptions): AsyncGenerator<AgentEvent> {
    this.runs.push(opts);
    yield { type: "session", sessionId: "sess-with-magic" };
    for await (const turn of opts.channel) {
      void turn;
      if (!this.autoComplete) {
        await new Promise<void>((resolve) => {
          this.releaseTurn = resolve;
        });
        this.releaseTurn = null;
      }
      yield { type: "result", ok: true, subtype: "success" };
    }
  }

  release(): void {
    const r = this.releaseTurn;
    this.releaseTurn = null;
    r?.();
  }

  async interrupt(): Promise<void> {
    this.release();
  }

  async listModels(): Promise<ModelChoice[]> {
    return [];
  }
}

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}

const prevClaudeJson = process.env.COMFYUI_MCP_CLAUDE_JSON;

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "remove-mcp-1700-"));
  const path = join(dir, ".claude.json");
  writeFileSync(path, JSON.stringify(CLAUDE_JSON, null, 2));
  process.env.COMFYUI_MCP_CLAUDE_JSON = path;
});

afterEach(() => {
  if (prevClaudeJson === undefined) delete process.env.COMFYUI_MCP_CLAUDE_JSON;
  else process.env.COMFYUI_MCP_CLAUDE_JSON = prevClaudeJson;
});

describe("panel_remove_mcp + forked respawn drops the removed server (#1700)", () => {
  it("restartForMcpConfig re-reads the config and forks so magic is gone", async () => {
    const mcpNames: string[][] = [];
    const backend = new RecordingBackend();
    const manager = new PanelAgentManager({
      mcpServers: {},
      systemAppend: "",
      model: "claude-test",
      onSay: () => {},
      onTurn: () => {},
      makeBackend: () => backend,
      makeMcpServers: () => {
        const inherited = readUserMcpServers();
        mcpNames.push(Object.keys(inherited));
        return { comfyui: { type: "stdio", command: "node" }, ...inherited } as never;
      },
    } as never);

    manager.send("orchestrator::claude", "hello");
    await waitFor(() => backend.runs.length >= 1);

    expect(readUserMcpServers().magic).toBeDefined();
    expect(removeUserMcpServer("magic")).toBe(true);
    expect(readUserMcpServers().magic).toBeUndefined();
    expect(Object.keys(readUserMcpServers()).sort()).toEqual(["codegraph"]);

    await waitFor(() => manager.restartForMcpConfig("orchestrator::claude") === "applied");
    await waitFor(() => backend.runs.length >= 2);

    const replacement = backend.runs[1];
    expect(replacement.resume, "conversation continues").toBe("sess-with-magic");
    expect(replacement.forkSession, "must fork so the SDK does not restore magic").toBe(true);
    const lastRead = mcpNames.at(-1) ?? [];
    expect(lastRead).not.toContain("magic");
    expect(lastRead).toContain("codegraph");
  });

  it("a credential-style restartForMcpEnv does NOT fork — env change keeps the session", async () => {
    const backend = new RecordingBackend();
    const manager = new PanelAgentManager({
      mcpServers: {},
      systemAppend: "",
      model: "claude-test",
      onSay: () => {},
      onTurn: () => {},
      makeBackend: () => backend,
    } as never);

    manager.send("tab-env", "hello");
    await waitFor(() => backend.runs.length >= 1);
    await waitFor(() => manager.restartForMcpEnv("tab-env") === "applied");
    await waitFor(() => backend.runs.length >= 2);
    expect(backend.runs[1].resume).toBe("sess-with-magic");
    expect(backend.runs[1].forkSession).toBeUndefined();
  });

  it("mid-turn panel_reload path stays scheduled until idle, then forks", async () => {
    const backend = new RecordingBackend();
    backend.autoComplete = false;
    const manager = new PanelAgentManager({
      mcpServers: {},
      systemAppend: "",
      model: "claude-test",
      onSay: () => {},
      onTurn: () => {},
      makeBackend: () => backend,
    } as never);

    manager.send("tab-busy", "hello");
    await waitFor(() => backend.runs.length >= 1);
    expect(manager.restartForMcpConfig("tab-busy")).toBe("scheduled");
    expect(backend.runs).toHaveLength(1);

    backend.autoComplete = true;
    backend.release();
    await waitFor(() => backend.runs.length >= 2);
    expect(backend.runs[1].forkSession).toBe(true);
  });
});

describe("panel_reload is wired to the forked MCP respawn (#1700)", () => {
  it("index.ts binds setApplyMcpReload to manager.restartForMcpConfig", () => {
    const src = readFileSync(new URL("../../orchestrator/index.ts", import.meta.url), "utf-8");
    expect(src).toMatch(/setApplyMcpReload\(\(key\) => \{\s*manager\.restartForMcpConfig\(key\);/s);
  });
});
