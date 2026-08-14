// #1567 — a QUEUED tool-session respawn kills in-flight downloads, and the at-risk check
// that exists for exactly that (#1378) cannot see them.
//
// The save-time snapshot is taken before the emit, which is right for an APPLIED respawn:
// the emit IS the damage. For a SCHEDULED one the damage is `applyPendingRestarts`,
// arbitrarily many turns later. A reporter saved a token with nothing in flight (so the
// check correctly warned about nothing), started nine downloads (~48GB) over the next two
// turns, and lost all of them when the queued respawn landed — no warning at any point,
// then nine manual cancels and nine manual re-issues to recover.
//
// So the snapshot is re-taken AT THE RESPAWN. These pin both halves: the note itself, and
// that a genuinely deferred respawn actually reaches it — a helper nothing calls would
// leave the defect exactly where it was.
import { beforeAll, describe, expect, it, vi } from "vitest";

import type {
  AgentBackend,
  AgentEvent,
  BackendStartOptions,
  ModelChoice,
} from "../../orchestrator/agent-backend.js";
import { CLAUDE_CAPABILITIES } from "../../orchestrator/agent-backend.js";

/** The downloads the respawn is about to orphan. Mocked at the MODULE boundary
 *  panel-agent imports across — `listDownloadJobs` is called from inside
 *  download-jobs.js, so mocking that would replace an export nobody reads. */
const atRisk = vi.hoisted(() => ({ jobs: [] as { id: string; filename: string; bytes: number }[] }));
vi.mock("../../services/download-jobs.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/download-jobs.js")>();
  return { ...actual, downloadsAtRiskOfRespawn: () => atRisk.jobs };
});

let PanelAgentManager: typeof import("../../orchestrator/panel-agent.js").PanelAgentManager;
let orphanedByDeferredRespawnNote: typeof import("../../services/panel-secrets.js").orphanedByDeferredRespawnNote;

beforeAll(async () => {
  ({ PanelAgentManager } = await import("../../orchestrator/panel-agent.js"));
  ({ orphanedByDeferredRespawnNote } = await import("../../services/panel-secrets.js"));
});

class RecordingBackend implements AgentBackend {
  readonly id = "claude" as const;
  readonly capabilities = CLAUDE_CAPABILITIES;
  runCount = 0;
  turnTexts: string[] = [];
  autoComplete = true;
  private releaseTurn: (() => void) | null = null;

  async *run(opts: BackendStartOptions): AsyncGenerator<AgentEvent> {
    this.runCount += 1;
    yield { type: "session", sessionId: "sess-x" };
    for await (const turn of opts.channel) {
      this.turnTexts.push(turn.text);
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

/** Same construction as restart-coalesce.test.ts — the backend arrives via
 *  `makeBackend`, not as a `backend` field. */
const makeManager = (backend: AgentBackend) =>
  new PanelAgentManager({
    mcpServers: {},
    systemAppend: "",
    model: "claude-test",
    onSay: () => {},
    onTurn: () => {},
    makeBackend: () => backend,
  } as never);

const waitFor = async (cond: () => boolean, ms = 3000): Promise<void> => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe("orphanedByDeferredRespawnNote (#1567)", () => {
  it("says nothing when nothing is in flight", () => {
    expect(orphanedByDeferredRespawnNote([])).toBeNull();
  });

  it("names the transfers and points at the partials", () => {
    const note = orphanedByDeferredRespawnNote([
      { id: "a", filename: "flux-dev.safetensors", bytes: 4_000_000_000 },
    ]);
    expect(note).toContain("flux-dev.safetensors");
    expect(note).toMatch(/partial/i);
    expect(note).toMatch(/re-issu/i);
  });

  it("does NOT repeat the from-zero prediction as a certainty", () => {
    // The reporter disproved it for this case: their downloads started AFTER the save, so
    // cache identity never moved and re-issuing resumed at 4%/1%/2%. ~11GB was recoverable.
    // `atRiskNote`'s "will NOT resume … starts from 0%" is right only when the credential
    // changes MID-transfer, which is not knowable from here — so neither outcome is claimed.
    const note = orphanedByDeferredRespawnNote([
      { id: "a", filename: "m.safetensors", bytes: 1 },
    ]) as string;
    expect(note).toMatch(/resume/i);
    expect(note).not.toMatch(/will NOT resume/i);
    // It must still admit the other case rather than promising a resume.
    expect(note).toMatch(/0%|restarts from/i);
  });
});

describe("a DEFERRED respawn reaches the note (#1567)", () => {
  it("tells the resumed session what it just killed", async () => {
    atRisk.jobs = [
      { id: "j1", filename: "flux-dev.safetensors", bytes: 4_000_000_000 },
      { id: "j2", filename: "wan22.safetensors", bytes: 13_550_000_000 },
    ];
    const backend = new RecordingBackend();
    backend.autoComplete = false; // hold the first turn open → the tab is BUSY
    const manager = makeManager(backend);
    const tab = "tab-1567";

    manager.send(tab, "hello");
    await waitFor(() => backend.runCount >= 1 && backend.turnTexts.length >= 1);

    // BUSY, so this respawn is genuinely DEFERRED — the path whose damage the save-time
    // snapshot cannot see. It reports "scheduled", not "applied".
    const tally = manager.restartAllForMcpEnv();
    expect(tally.scheduled, "the respawn must be queued, not applied").toBe(1);
    expect(tally.applied).toBe(0);

    backend.autoComplete = true;
    backend.release(); // turn done → the queued respawn fires HERE

    await waitFor(() => backend.runCount >= 2);
    await waitFor(() => backend.turnTexts.some((t) => t.includes("flux-dev.safetensors")));

    const note = backend.turnTexts.find((t) => t.includes("flux-dev.safetensors")) as string;
    expect(note, "both orphaned transfers must be named").toContain("wan22.safetensors");
    expect(note).toMatch(/partial/i);
  });

  it("stays silent when the respawn orphans nothing", async () => {
    // The direction that fails quietly: a note pushed unconditionally would still pass the
    // test above, while costing a real agent turn on every env respawn. A nudge is a turn,
    // not a log line.
    atRisk.jobs = [];
    const backend = new RecordingBackend();
    backend.autoComplete = false;
    const manager = makeManager(backend);
    const tab = "tab-1567-quiet";

    manager.send(tab, "hello");
    await waitFor(() => backend.runCount >= 1 && backend.turnTexts.length >= 1);
    expect(manager.restartAllForMcpEnv().scheduled).toBe(1);

    backend.autoComplete = true;
    backend.release();
    await waitFor(() => backend.runCount >= 2);
    await new Promise((r) => setTimeout(r, 120)); // give a spurious nudge time to arrive

    expect(backend.turnTexts.filter((t) => /rebuild is happening NOW/i.test(t))).toHaveLength(0);
  });

  it("does not swallow an existing retry nudge", async () => {
    // The #164 payload still has to arrive; the orphan note is appended, not substituted.
    atRisk.jobs = [{ id: "j1", filename: "flux-dev.safetensors", bytes: 1 }];
    const backend = new RecordingBackend();
    backend.autoComplete = false;
    const manager = makeManager(backend);
    const tab = "tab-1567-both";

    manager.send(tab, "hello");
    await waitFor(() => backend.runCount >= 1 && backend.turnTexts.length >= 1);
    manager.restartAllForMcpEnv("RETRY the download");

    backend.autoComplete = true;
    backend.release();
    await waitFor(() => backend.runCount >= 2);
    await waitFor(() => backend.turnTexts.some((t) => t.includes("flux-dev.safetensors")));

    const delivered = backend.turnTexts.find((t) => t.includes("flux-dev.safetensors")) as string;
    expect(delivered).toContain("RETRY the download");
  });
});
