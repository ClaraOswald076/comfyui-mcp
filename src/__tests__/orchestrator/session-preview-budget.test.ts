// #1516 — the CUMULATIVE, per-conversation budget on automatic run-completion
// previews.
//
// The per-turn ceiling (MAX_RUN_COMPLETION_IMAGE_ATTACHMENTS, locked in
// run-completion-continuation.test.ts) bounds ONE turn, but Codex persists every
// delivered preview as an inline input_image data URL and its compaction path
// recopies them without a media-aware bound (openai/codex#33493) — so N turns
// accumulating 8N images is the compounding shape the per-turn cap cannot see.
// Measured on the reporter's session: 265 persisted input_images, an 18.2 GiB
// rollout, ~487 MB recopied per later compaction.
//
// These tests lock what the session budget promises:
//   1. the budget is CUMULATIVE ACROSS TURNS — 8 + 2, then none, with the
//      notice naming the bound that actually fired;
//   2. the BYTE half binds even when the count half has room (a count-only cap
//      lies about cost — the reporter rejected exactly that);
//   3. a user's explicit attachment NEVER spends the automatic-preview budget;
//   4. the ledger persists across an orchestrator restart and is adopted ONLY
//      by the exact conversation it was recorded against.

import { beforeAll, beforeEach, afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentBackend,
  AgentEvent,
  BackendStartOptions,
  ModelChoice,
} from "../../orchestrator/agent-backend.js";
import { CLAUDE_CAPABILITIES } from "../../orchestrator/agent-backend.js";

let PanelAgentManager: typeof import("../../orchestrator/panel-agent.js").PanelAgentManager;
let SessionStore: typeof import("../../orchestrator/session-store.js").SessionStore;
let MAX_SESSION_PREVIEW_ATTACHMENTS: number;
let MAX_SESSION_PREVIEW_BYTES: number;

beforeAll(async () => {
  // Small budgets so the cumulative bound is reachable in a handful of turns,
  // and a short freeze window — both read at module load, hence the dynamic
  // imports below (same pattern as run-completion-continuation.test.ts).
  process.env.COMFYUI_MCP_TURN_IDLE_MS = "150";
  process.env.COMFYUI_MCP_SESSION_PREVIEW_ATTACHMENTS = "10";
  process.env.COMFYUI_MCP_SESSION_PREVIEW_BYTES = "1000";
  ({ PanelAgentManager } = await import("../../orchestrator/panel-agent.js"));
  ({ SessionStore } = await import("../../orchestrator/session-store.js"));
  ({ MAX_SESSION_PREVIEW_ATTACHMENTS, MAX_SESSION_PREVIEW_BYTES } = await import(
    "../../orchestrator/preview-budget.js"
  ));
});

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** A backend that holds each turn open until the test releases it (so arrivals
 *  queue deterministically), records what each turn carried, and reports a
 *  controllable automatic-preview byte count — the #1516 ledger input only a
 *  backend can know (it is where the fetch happens). */
class BudgetBackend implements AgentBackend {
  readonly id = "claude" as const;
  readonly capabilities = CLAUDE_CAPABILITIES;
  turns: string[] = [];
  turnImages: string[][] = [];
  /** Bytes this backend pretends to have delivered as automatic previews. */
  previewBytes = 0;
  private release: (() => void) | null = null;

  constructor(private readonly sessionId = "sess-budget") {}

  automaticPreviewBytes(): number {
    return this.previewBytes;
  }

  async *run(opts: BackendStartOptions): AsyncGenerator<AgentEvent> {
    yield { type: "session", sessionId: this.sessionId };
    let turnSeq = 0;
    for await (const turn of opts.channel) {
      this.turns.push((turn as { text?: string }).text ?? "");
      this.turnImages.push((turn.images ?? []).map((image) => image.filename));
      turnSeq += 1;
      await new Promise<void>((resolve) => {
        this.release = resolve;
      });
      yield { type: "result", ok: true, subtype: "success", turn: turnSeq };
    }
  }

  finishTurn(): void {
    const r = this.release;
    this.release = null;
    r?.();
  }

  async interrupt(): Promise<void> {
    this.finishTurn();
  }
  async listModels(): Promise<ModelChoice[]> {
    return [];
  }
}

function makeManager(backend: AgentBackend, sessionStore?: InstanceType<typeof SessionStore>) {
  const manager = new PanelAgentManager({
    mcpServers: {},
    systemAppend: "",
    model: "claude-test",
    onSay: () => {},
    onTurn: () => {},
    makeBackend: () => backend,
    sessionStore,
  } as never);
  return manager;
}

/** A matched run completion with `n` named outputs. */
function completion(promptId: string, n: number, tag: string) {
  return {
    kind: "executed" as const,
    prompt_id: promptId,
    run_correlation: "matched" as const,
    images: Array.from({ length: n }, (_, i) => ({ filename: `${tag}_${i}.png` })),
  };
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "preview-budget-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("cumulative session preview budget (#1516)", () => {
  it("is shared ACROSS turns: 8 ride, then 2, then none — and the notices name the conversation bound", async () => {
    const backend = new BudgetBackend();
    const manager = makeManager(backend);
    const tab = "tab-cumulative";

    manager.send(tab, "start");
    await waitFor(() => backend.turns.length >= 1);
    backend.finishTurn();

    // Turn 2: the per-turn 8 all ride (session budget 10 has room).
    manager.injectEvent(tab, completion("p-a", 8, "a"));
    await waitFor(() => backend.turns.length >= 2);
    expect(backend.turnImages[1]).toHaveLength(8);
    expect(backend.turns[1]).toContain("attached below");
    backend.finishTurn();

    // Turn 3: only 2 of the conversation's 10 remain — the SESSION bound, not
    // the turn's 8, is what fires, and the text must say which bound spoke.
    manager.injectEvent(tab, completion("p-b", 8, "b"));
    await waitFor(() => backend.turns.length >= 3);
    expect(backend.turnImages[2]).toHaveLength(2);
    expect(backend.turns[2]).toContain("cumulative automatic-preview budget");
    expect(backend.turns[2]).toContain("nearly spent");
    // …with get_image coordinates for what was withheld, never a silent drop.
    expect(backend.turns[2]).toContain("get_image");
    backend.finishTurn();

    // Turn 4: the conversation budget is spent. The completion still arrives,
    // all outputs stay visible in the panel, but ZERO pixels ride the turn.
    manager.injectEvent(tab, completion("p-c", 4, "c"));
    await waitFor(() => backend.turns.length >= 4);
    expect(backend.turnImages[3]).toHaveLength(0);
    expect(backend.turns[3]).toContain("NONE of these outputs are attached");
    expect(backend.turns[3]).toContain("cumulative automatic-preview budget");
    expect(backend.turns[3]).toContain("is spent");
    backend.finishTurn();

    // Diagnostics: 10 delivered, 10 withheld (6 + 4) — accounted where decided.
    const agent = (manager as unknown as { agents: Map<string, { previewBudgetStatus(): unknown }> })
      .agents.get(tab);
    expect(agent?.previewBudgetStatus()).toMatchObject({
      images: 10,
      withheld: 10,
      budgetImages: MAX_SESSION_PREVIEW_ATTACHMENTS,
      budgetBytes: MAX_SESSION_PREVIEW_BYTES,
    });
  });

  it("the BYTE budget binds even when the count budget has room", async () => {
    const backend = new BudgetBackend();
    const manager = makeManager(backend);
    const tab = "tab-bytes";

    manager.send(tab, "start");
    await waitFor(() => backend.turns.length >= 1);
    backend.finishTurn();

    // The backend reports a conversation already carrying a full byte budget of
    // automatic previews (e.g. adopted from the durable store after a restart):
    // not one more pixel rides, however much count budget remains.
    backend.previewBytes = MAX_SESSION_PREVIEW_BYTES;
    manager.injectEvent(tab, completion("p-fat", 3, "fat"));
    await waitFor(() => backend.turns.length >= 2);
    expect(backend.turnImages[1]).toHaveLength(0);
    expect(backend.turns[1]).toContain("NONE of these outputs are attached");
    expect(backend.turns[1]).toContain("is spent");
    backend.finishTurn();
  });

  it("a user's explicit attachment NEVER spends the automatic-preview budget", async () => {
    const backend = new BudgetBackend();
    const manager = makeManager(backend);
    const tab = "tab-user-image";

    manager.send(tab, "start");
    await waitFor(() => backend.turns.length >= 1);
    backend.finishTurn();

    // Spend the whole conversation budget on automatic previews (8 + 2).
    manager.injectEvent(tab, completion("p-a", 8, "a"));
    await waitFor(() => backend.turns.length >= 2);
    backend.finishTurn();
    manager.injectEvent(tab, completion("p-b", 8, "b"));
    await waitFor(() => backend.turns.length >= 3);
    backend.finishTurn();

    // The conversation's automatic budget is spent — but the user's OWN image
    // is a separate, reviewed policy and must still reach the model.
    manager.send(tab, "what do you see?", { images: [{ filename: "user.png" }] });
    await waitFor(() => backend.turns.length >= 4);
    expect(backend.turnImages[3]).toEqual(["user.png"]);
    backend.finishTurn();
  });

  it("the ledger persists to the session store as previews are delivered", async () => {
    const store = new SessionStore(9871, { dir });
    const backend = new BudgetBackend();
    const manager = makeManager(backend, store);
    const tab = "tab-persist";

    manager.send(tab, "start");
    await waitFor(() => backend.turns.length >= 1);
    backend.finishTurn();

    manager.injectEvent(tab, completion("p-a", 8, "a"));
    await waitFor(() => backend.turns.length >= 2);
    backend.finishTurn();

    // The store's entry is keyed to the LIVE session id (written by the
    // manager's onSession) and carries what the conversation actually received.
    expect(store.previewLedger(tab)).toEqual({ sid: "sess-budget", images: 8, bytes: 0 });
  });

  it("a durable ledger is adopted ONLY by the exact conversation it was recorded against", async () => {
    const store = new SessionStore(9872, { dir });

    // Matching conversation: the store says sess-budget already received a full
    // budget of previews before the restart, so the resumed conversation does
    // not get one more automatic pixel.
    const tabMatch = "tab-adopt";
    store.set(tabMatch, "sess-budget");
    expect(
      store.setPreviewLedger(tabMatch, "sess-budget", {
        images: MAX_SESSION_PREVIEW_ATTACHMENTS,
        bytes: 0,
      }),
    ).toBe(true);
    const backendMatch = new BudgetBackend("sess-budget");
    const managerMatch = makeManager(backendMatch, store);
    managerMatch.send(tabMatch, "resume me");
    await waitFor(() => backendMatch.turns.length >= 1);
    backendMatch.finishTurn();
    managerMatch.injectEvent(tabMatch, completion("p-r", 4, "r"));
    await waitFor(() => backendMatch.turns.length >= 2);
    expect(backendMatch.turnImages[1]).toHaveLength(0);
    expect(backendMatch.turns[1]).toContain("is spent");
    backendMatch.finishTurn();

    // Mismatched conversation: the stored ledger belongs to sess-old, the live
    // session is sess-new — a fresh conversation must start at ZERO, not inherit
    // media cost it never incurred.
    const tabFresh = "tab-no-adopt";
    store.set(tabFresh, "sess-old");
    store.setPreviewLedger(tabFresh, "sess-old", {
      images: MAX_SESSION_PREVIEW_ATTACHMENTS,
      bytes: 0,
    });
    const backendFresh = new BudgetBackend("sess-new");
    const managerFresh = makeManager(backendFresh, store);
    managerFresh.send(tabFresh, "fresh");
    await waitFor(() => backendFresh.turns.length >= 1);
    backendFresh.finishTurn();
    managerFresh.injectEvent(tabFresh, completion("p-f", 8, "f"));
    await waitFor(() => backendFresh.turns.length >= 2);
    expect(backendFresh.turnImages[1]).toHaveLength(8);
    backendFresh.finishTurn();
  });
});

describe("session store preview ledger (#1516)", () => {
  it("refuses a ledger for any session but the one it describes", () => {
    const store = new SessionStore(9873, { dir });
    const key = "tab-store";

    // No entry at all → refused, not invented.
    expect(store.setPreviewLedger(key, "sess-1", { images: 1, bytes: 2 })).toBe(false);

    store.set(key, "sess-1");
    expect(store.setPreviewLedger(key, "sess-2", { images: 1, bytes: 2 })).toBe(false);
    expect(store.previewLedger(key)).toBeUndefined();

    expect(store.setPreviewLedger(key, "sess-1", { images: 7, bytes: 123 })).toBe(true);
    expect(store.previewLedger(key)).toEqual({ sid: "sess-1", images: 7, bytes: 123 });

    // set() on the SAME session preserves the ledger (it is a property of the
    // conversation)…
    store.set(key, "sess-1");
    expect(store.previewLedger(key)).toEqual({ sid: "sess-1", images: 7, bytes: 123 });

    // …and a NEW session id drops it: a fresh conversation provably holds no
    // previews yet, so carrying the old ledger would starve it.
    store.set(key, "sess-2");
    expect(store.previewLedger(key)).toBeUndefined();

    // The ledger survives a reload (the whole point: an orchestrator restart
    // must not reset a budget the living conversation keeps accumulating).
    store.set(key, "sess-2");
    store.setPreviewLedger(key, "sess-2", { images: 3, bytes: 45 });
    const reloaded = new SessionStore(9873, { dir });
    expect(reloaded.previewLedger(key)).toEqual({ sid: "sess-2", images: 3, bytes: 45 });
  });
});
