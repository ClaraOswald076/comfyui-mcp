// #884 — THE INVARIANT (owner-stated, absolute): agents are SESSION-bound, with
// knowledge of all open workflows. One session spans every panel, every browser
// tab and every workflow; it is keyed and persisted by the orchestrator (on disk,
// in ~/.comfyui-mcp/sessions), never scoped to a workflow. These are the
// regression tests for the per-workflow keying that violated it: they FAIL on
// the pre-#884 code (agent key = `tabId::backend`, per-workflow teardown in the
// hello handler) and pass now.
//
// The hello handler lives inline in the orchestrator start function, so — as
// with the other index.ts boundary guards (see ask-answer-journal.test.ts) — the
// wiring is pinned at source level, while the behavior underneath (one key ⇒ one
// agent ⇒ one history; the shared key resolves resume from the store on the REAL
// spawn path) is driven through the real PanelAgentManager + SessionStore.

import { describe, expect, it, beforeAll, afterAll, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentBackend,
  AgentEvent,
  BackendStartOptions,
  ModelChoice,
} from "../../orchestrator/agent-backend.js";
import { CLAUDE_CAPABILITIES } from "../../orchestrator/agent-backend.js";
import { SessionStore } from "../../orchestrator/session-store.js";
import { sharedAgentKey } from "../../services/session-scope.js";

let PanelAgentManager: typeof import("../../orchestrator/panel-agent.js").PanelAgentManager;
beforeAll(async () => {
  ({ PanelAgentManager } = await import("../../orchestrator/panel-agent.js"));
});

const PORT = 59321;
const DIR = mkdtempSync(join(tmpdir(), "cmcp-sessions-"));
afterEach(() => {
  for (const f of [
    join(DIR, `panel-sessions-${PORT}.json`),
    join(tmpdir(), `comfyui-mcp-panel-sessions-${PORT}.json`),
  ]) {
    try {
      rmSync(f);
    } catch {
      /* already gone */
    }
  }
});
afterAll(() => {
  try {
    rmSync(DIR, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

class RecordingBackend implements AgentBackend {
  readonly id = "claude" as const;
  readonly capabilities = CLAUDE_CAPABILITIES;
  turnTexts: string[] = [];
  resumes: Array<string | undefined> = [];
  /** Each run() is one SDK session standing up — and with it every MCP child
   *  (comfyui + the user's inherited servers). close() is that session (and its
   *  children) being torn down. #902's "every MCP server disconnected" is one
   *  close+run cycle of this. */
  closes = 0;
  sessionId = "sess-shared";
  async *run(opts: BackendStartOptions): AsyncGenerator<AgentEvent> {
    this.resumes.push(opts.resume);
    for await (const turn of opts.channel) {
      yield { type: "session", sessionId: this.sessionId };
      this.turnTexts.push(turn.text);
      yield { type: "result", ok: true, subtype: "success" } as AgentEvent;
    }
  }
  async interrupt(): Promise<void> {}
  async close(): Promise<void> {
    this.closes += 1;
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

const indexSrc = (): string =>
  readFileSync(new URL("../../orchestrator/index.ts", import.meta.url), "utf8");

describe("sessions are orchestrator-scoped, never workflow-scoped (#884)", () => {
  it("SOURCE: the agent key is the shared scope + backend — the panel tab id is NOT part of it", () => {
    const src = indexSrc();
    // The exact composition the orchestrator uses. On the pre-#884 code this was
    // `panelTabId + AGENT_KEY_SEP + backendForTab(panelTabId)` — the regression.
    expect(src).toContain("SHARED_SESSION_SCOPE + AGENT_KEY_SEP + backendForTab(panelTabId)");
    expect(src).not.toContain("panelTabId + AGENT_KEY_SEP + backendForTab");
    // And no composite key is ever built from a live panel tab id anymore.
    expect(src).not.toMatch(/panelTab \+ AGENT_KEY_SEP/);
    expect(src).not.toMatch(/tab_id \+ AGENT_KEY_SEP/);
  });

  it("SOURCE: a same-socket re-hello (workflow switch / save / rename / Workflow→New) never touches the agent", () => {
    const src = indexSrc();
    const start = src.indexOf("if (migratedFrom && migratedFrom !== panelTab) {");
    expect(start, "migration block not found").toBeGreaterThan(-1);
    // The block ends at the stamp-recording comment that follows it.
    const end = src.indexOf("Record this tab's trusted per-workflow COMMAND STAMP", start);
    expect(end, "post-migration anchor not found").toBeGreaterThan(start);
    const block = src.slice(start, end);
    // No agent lifecycle calls: the conversation deliberately CONTINUES. This is
    // also the #902 fix: retiring the CALLING agent here tore down its SDK
    // session mid-panel_open_workflow — and with it every MCP child (comfyui +
    // the user's inherited servers), the reported "89 deferred tools are no
    // longer available" disconnect.
    expect(block).not.toContain("manager.retire(");
    expect(block).not.toContain("manager.reset(");
    expect(block).not.toContain("manager.rebindAgent(");
    // …and no bridge-route revocation: the in-flight open's verify probes must
    // keep routing (the other half of #902's failed rebind guard).
    expect(block).not.toContain("revokeTabMigration");
    // Pending deliveries FOLLOW the socket instead of being dropped.
    expect(block).toContain("RunCompletions.moveKey(migratedFrom, panelTab)");
    expect(block).toContain("AskAnswers.moveKey(migratedFrom, panelTab)");
  });

  it("SOURCE: a provider switch retires the shared agent only when NO other tab still uses it", () => {
    const src = indexSrc();
    const sites = [...src.matchAll(/manager\.retire\(/g)];
    // Exactly the two provider-switch sites (hello + set_backend) — nothing else
    // retires an agent, and both are guarded by the shared-usage check.
    expect(sites.length).toBe(2);
    for (const m of sites) {
      const before = src.slice(Math.max(0, m.index! - 600), m.index!);
      expect(before, "retire must be guarded by shouldRetireSharedAgent").toContain(
        "shouldRetireSharedAgent(",
      );
    }
  });

  it("SOURCE: scope mutations are stamped with the TURN's issue-time workflow, never re-resolved (codex r1 P0 / r2)", () => {
    const src = indexSrc();
    // The issue-time uuid AND origin tab RIDE the message (recorded per mid)…
    expect(src).toContain("recordTurnUuidForMid(userMid, issueUuid, event.tab_id);");
    // …a mid-less message may only stamp while NO turn is in flight (codex r3)…
    expect(src).toContain("} else if (!manager.isTurnActive(agentKeyFor(event.tab_id))) {");
    // …and the stamp lands when the turn DEQUEUES its batch (onSeen), with a
    // MIXED/unknown-origin batch failing closed instead of last-message-wins
    // re-aiming the whole turn's mutations (codex r2/r3).
    expect(src).toContain("batch.known.push(rec.uuid);");
    // Confirming gate 2 split this into its two honest halves, so BOTH are
    // pinned — the old single condition can't come back by satisfying one.
    // A mixed/unknown TAB batch fails closed on routing AND stamp (no single
    // target is honest for it)…
    expect(src).toContain("if (closed.unknown || closed.tabs.size > 1) {");
    // …while one tab whose workflow changed between messages keeps its routing
    // pin (same browser surface) and fails closed on the STAMP alone.
    expect(src).toContain(
      "const uuid = distinct.size === 1 ? distinct.values().next().value : undefined;",
    );
    // The TURN-TARGET PIN lands in the same batch close and is released at turn
    // end: an in-flight turn's tool calls route to the tab the turn was issued
    // from, never re-resolved mid-turn (confirming-gate P0).
    expect(src).toContain("turnTargetTabByKey.set(key, tab);");
    expect(src).toContain('if (state === "done") turnTargetTabByKey.delete(key);');
    // Confirming gate 2, P0 — EVERY turn has an origin, not just user-message
    // turns. A turn that contributes none (an injected run error whose queue
    // item carried no mid, a pure re-queue, a restart nudge) inherits the
    // conversation's LAST ESTABLISHED origin; with none it refuses. It must
    // never fall through to "whatever tab is active" — that is how a render
    // error on tab A silently edited tab B.
    expect(src).toContain("const last = lastOriginByKey.get(key);");
    expect(src).toContain("turnTargetTabByKey.set(key, last.tab);");
    expect(src).toContain("lastOriginByKey.set(key, { tab, uuid });");
    // …and the injection paths mint that origin rather than going in bare.
    expect(src).toContain("mid: mintInjectionOrigin(event.tab_id),");
    expect(src).toContain("bridge.setScopeTargetResolver((scopeId) => {");
    // …answered to scope-addressed callers by the stamp resolver…
    expect(src).toContain(
      "if (isScopeAddress(tabId)) return lastTurnUuidByKey.get(scopeAgentKeyOf(tabId));",
    );
    // …refreshed only by #716's validated explicit-open path…
    expect(src).toContain(
      "if (isScopeAddress(tabId)) lastTurnUuidByKey.set(scopeAgentKeyOf(tabId), identity.uuid);",
    );
    // …and cleared at every conversation boundary (new chat / resume / rewind).
    expect((src.match(/lastTurnUuidByKey\.delete\(/g) ?? []).length).toBeGreaterThanOrEqual(3);
    // The panel MCP servers bind the backend-QUALIFIED scope address so the
    // per-conversation stamp is recoverable from the caller id.
    expect(src).toContain("createPanelMcpServer(bridge, key, workflowTargets)");
    expect(src).toContain("makeHttpBackendMcpServers(key)");
  });

  it("SOURCE: download rows are stamped with the OWNING agent key, and resolved as such (codex r1/r2 P1)", () => {
    const src = indexSrc();
    // Both spawn lanes stamp the owning conversation (r2: the HTTP lane never did).
    expect(src).toContain("COMFYUI_MCP_TAB: agentKey");
    expect(src).toContain("COMFYUI_MCP_TAB: tabId");
    // A known owner is delivered-to or dropped — never re-routed to whichever
    // sole agent happens to be live (r2: cross-conversation misattribution).
    expect(src).toContain("if (tab.startsWith(SHARED_SESSION_SCOPE + AGENT_KEY_SEP)) {");
    expect(src).toContain("not waking another conversation (#884)");
  });

  it("SOURCE: journal tickets are keyed by the REAL routed tab, never the scope address (codex r3 P1)", () => {
    const tools = readFileSync(
      new URL("../../orchestrator/panel-tools.ts", import.meta.url),
      "utf8",
    );
    // A scope-keyed ticket can never correlate: the panel reports completions
    // and answers under the REAL tab id, so the agent's own render would come
    // back "foreign" and boundary sweeps could never close the ticket.
    expect(tools).toContain("function journalTabFor(ctx: PanelToolCtx): string {");
    // panel_run's #468 ticket — the tab is captured at DISPATCH time…
    expect(tools).toContain("const runTicketTab = journalTabFor(ctx);");
    expect(tools).toContain("tabId: runTicketTab,");
    // …and panel_ask's #486 ticket (opened before dispatch already).
    expect(tools).toContain("const tabId = journalTabFor(ctx);");
  });

  it("SOURCE: hello.resume is a last-resort hint — the orchestrator's disk store wins", () => {
    const src = indexSrc();
    const at = src.indexOf("manager.setResume(key, resumeHint)");
    expect(at, "resume-hint arming not found").toBeGreaterThan(-1);
    const guard = src.slice(Math.max(0, at - 400), at);
    expect(guard).toContain("sessionStore.get(key) === undefined");
    expect(guard).toContain("!manager.hasAnyState(key)");
  });

  it("ONE key ⇒ ONE agent ⇒ ONE history: messages from different workflows share the conversation", async () => {
    const backend = new RecordingBackend();
    const store = new SessionStore(PORT, { dir: DIR });
    const manager = new PanelAgentManager({
      mcpServers: {},
      systemAppend: "",
      model: "claude-test",
      onSay: () => {},
      onTurn: () => {},
      onSession: () => {},
      sessionStore: store,
      makeBackend: () => backend,
    } as never);

    // Two different workflows (previously two DIFFERENT keys → two agents with
    // zero shared memory) both resolve to the one shared key now.
    const key = sharedAgentKey("claude");
    manager.send(key, "from workflow A"); // e.g. tab wf:a.json
    await waitFor(() => backend.turnTexts.length === 1);
    manager.send(key, "from workflow B (after Workflow → New)"); // e.g. tab tmp:<new-uuid>
    await waitFor(() => backend.turnTexts.length === 2);

    // Same backend instance saw BOTH turns in order — one conversation.
    expect(backend.turnTexts).toEqual(["from workflow A", "from workflow B (after Workflow → New)"]);
    // Only one spawn ever happened (no fresh agent on the workflow change)…
    expect(backend.resumes).toHaveLength(1);
    // …and the session was NEVER torn down across the workflow change (#902):
    // one run(), zero close() — the SDK session and every MCP child connection
    // riding it (comfyui + the user's inherited servers) survive a workflow
    // switch intact, instead of the retire→respawn cycle that dropped and
    // reconnected all of them ("89 deferred tools are no longer available").
    expect(backend.closes).toBe(0);
    expect(manager.hasLiveAgent(key)).toBe(true);
    // …and the session persisted under the SHARED key on disk (the orchestrator
    // owns it; the browser holds at most a hint).
    expect(store.get(key)).toBe("sess-shared");
    expect(new SessionStore(PORT, { dir: DIR }).get(key)).toBe("sess-shared");

    await manager.stopAll();
  });

  it("TWO backends ⇒ TWO agents with SEPARATE histories — cross-backend never merges, neither churns", async () => {
    const backends = new Map<string, RecordingBackend>();
    const store = new SessionStore(PORT, { dir: DIR });
    const manager = new PanelAgentManager({
      mcpServers: {},
      systemAppend: "",
      model: "claude-test",
      onSay: () => {},
      onTurn: () => {},
      onSession: () => {},
      sessionStore: store,
      makeBackend: (key: string) => {
        const b = backends.get(key) ?? new RecordingBackend();
        backends.set(key, b);
        return b;
      },
    } as never);

    manager.send(sharedAgentKey("claude"), "claude turn");
    manager.send(sharedAgentKey("codex"), "codex turn");
    await waitFor(
      () =>
        (backends.get(sharedAgentKey("claude"))?.turnTexts.length ?? 0) === 1 &&
        (backends.get(sharedAgentKey("codex"))?.turnTexts.length ?? 0) === 1,
    );
    expect(backends.get(sharedAgentKey("claude"))!.turnTexts).toEqual(["claude turn"]);
    expect(backends.get(sharedAgentKey("codex"))!.turnTexts).toEqual(["codex turn"]);
    // Each conversation stood up exactly once; neither's session/MCP children
    // were churned by the other's activity.
    expect(backends.get(sharedAgentKey("claude"))!.closes).toBe(0);
    expect(backends.get(sharedAgentKey("codex"))!.closes).toBe(0);

    await manager.stopAll();
  });

  it("UPGRADE: the newest pre-#884 per-workflow session is adopted — the REAL spawn resumes it", async () => {
    // A store written by the per-workflow era: two workflows conversed on claude.
    const seed = new SessionStore(PORT, { dir: DIR });
    seed.set("wf:old.json::claude", "sess-old-workflow");
    await new Promise((r) => setTimeout(r, 5));
    seed.set("wf:current.json::claude", "sess-current-workflow");

    const backend = new RecordingBackend();
    const store = new SessionStore(PORT, { dir: DIR }); // a fresh (upgraded) orchestrator
    const manager = new PanelAgentManager({
      mcpServers: {},
      systemAppend: "",
      model: "claude-test",
      onSay: () => {},
      onTurn: () => {},
      onSession: () => {},
      sessionStore: store,
      makeBackend: () => backend,
    } as never);

    // The first message after the upgrade spawns the shared agent — through the
    // manager's REAL resume path — and it resumes the newest legacy conversation.
    manager.send(sharedAgentKey("claude"), "hello again");
    await waitFor(() => backend.turnTexts.length === 1);
    expect(backend.resumes).toEqual(["sess-current-workflow"]);

    await manager.stopAll();
  });
});
