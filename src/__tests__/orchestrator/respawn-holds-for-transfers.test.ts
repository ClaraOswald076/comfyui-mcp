// #1567 item 2 — a QUEUED credential respawn WAITS for in-flight transfers instead of
// killing them.
//
// The first half of #1567 shipped in 0.51.49: the at-risk snapshot is re-taken when the
// respawn fires, so the nine downloads it destroys are at least NAMED. That is a better
// obituary, not a fix — the reporter still loses ~48 GB and still has to issue nine cancels
// and nine re-issues. The reporter's own argument is the fix: a respawn that has already
// waited turns is by definition not urgent, and for a comfyui credential the running tools
// re-read the value from disk at use time, so the rebuild is a tidy-up. The transfers cost
// hours. So the respawn yields to them.
//
// What these pin, in order of what would silently un-ship the fix:
//   * the hold actually happens on the reporter's timeline (save with nothing in flight,
//     downloads started later, respawn comes due);
//   * something WAKES it — `applyPendingRestarts` runs at turn-done, and a user watching a
//     download is idle, so without the poll the respawn would simply never fire;
//   * it waits on PROGRESS, not on a clock, so a healthy 48 GB transfer is never killed for
//     being long and a dead one cannot pin the respawn for the rest of the session;
//   * only a CREDENTIAL respawn may wait — a retarget must not.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type {
  AgentBackend,
  AgentEvent,
  BackendStartOptions,
  ModelChoice,
} from "../../orchestrator/agent-backend.js";
import { CLAUDE_CAPABILITIES } from "../../orchestrator/agent-backend.js";

/** The transfers a respawn would orphan. Mocked at the MODULE boundary panel-agent imports
 *  across — `listDownloadJobs` is called from inside download-jobs.js, so mocking that would
 *  replace an export nobody reads. */
const atRisk = vi.hoisted(() => ({ jobs: [] as { id: string; filename: string; bytes: number }[] }));
vi.mock("../../services/download-jobs.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/download-jobs.js")>();
  return { ...actual, downloadsAtRiskOfRespawn: () => atRisk.jobs };
});

let PanelAgentManager: typeof import("../../orchestrator/panel-agent.js").PanelAgentManager;

beforeAll(async () => {
  ({ PanelAgentManager } = await import("../../orchestrator/panel-agent.js"));
});

/**
 * Both windows are set PER TEST rather than shared, because the two directions need
 * opposite settings and racing them against one shared window is how this file would go
 * flaky. A test asserting the respawn is HELD sets a stall window it cannot reach, so "no
 * respawn within 200ms" means held rather than "not stalled yet"; a test asserting the hold
 * is GIVEN UP sets a tiny one. Read live by the manager (like COMFYUI_MCP_TURN_IDLE_MS), so
 * assigning here is enough.
 */
const setWindows = (opts: { pollMs: number; stallMs: number }): void => {
  process.env.COMFYUI_MCP_RESPAWN_HOLD_POLL_MS = String(opts.pollMs);
  process.env.COMFYUI_MCP_RESPAWN_HOLD_STALL_MS = String(opts.stallMs);
};

afterEach(() => {
  delete process.env.COMFYUI_MCP_RESPAWN_HOLD_POLL_MS;
  delete process.env.COMFYUI_MCP_RESPAWN_HOLD_STALL_MS;
  atRisk.jobs = [];
});

class RecordingBackend implements AgentBackend {
  readonly id = "claude" as const;
  readonly capabilities = CLAUDE_CAPABILITIES;
  runCount = 0;
  turnTexts: string[] = [];
  autoComplete = true;
  private held: (() => void)[] = [];

  async *run(opts: BackendStartOptions): AsyncGenerator<AgentEvent> {
    this.runCount += 1;
    yield { type: "session", sessionId: "sess-x" };
    for await (const turn of opts.channel) {
      this.turnTexts.push(turn.text);
      if (!this.autoComplete) {
        await new Promise<void>((resolve) => {
          this.held.push(resolve);
        });
      }
      yield { type: "result", ok: true, subtype: "success" };
    }
  }

  release(): void {
    const all = this.held;
    this.held = [];
    for (const r of all) r();
  }

  async interrupt(): Promise<void> {
    this.release();
  }

  async listModels(): Promise<ModelChoice[]> {
    return [];
  }
}

/** `spawns` records WHICH TAB each agent construction was for. `runCount` cannot answer
 *  that — the backend's `run()` starts asynchronously, so a respawn of tab A can land after
 *  a later assertion and read as tab B having been replaced. The multi-tab test turns on
 *  exactly that distinction. */
const makeManager = (backend: AgentBackend, spawns: string[] = []) =>
  new PanelAgentManager({
    mcpServers: {},
    systemAppend: "",
    model: "claude-test",
    onSay: () => {},
    onTurn: () => {},
    makeBackend: (tabId: string) => {
      spawns.push(tabId);
      return backend;
    },
  } as never);

const waitFor = async (cond: () => boolean, ms = 3000): Promise<void> => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 5));
  }
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const job = (bytes: number) => ({ id: "j1", filename: "flux-dev.safetensors", bytes });

/** A tab with a live agent, mid-turn (so a save's respawn is genuinely DEFERRED). */
const busyTab = async (manager: InstanceType<typeof PanelAgentManager>, backend: RecordingBackend, tab: string) => {
  backend.autoComplete = false;
  manager.send(tab, "hello");
  await waitFor(() => backend.runCount >= 1 && backend.turnTexts.length >= 1);
};

describe("a queued credential respawn waits for in-flight transfers (#1567 item 2)", () => {
  it("does NOT fire while downloads started after the save are running", async () => {
    // The reporter's timeline exactly. The save-time check saw nothing because nothing was
    // in flight; the downloads came afterwards; the respawn came due later still. Before
    // this, that moment killed all nine.
    setWindows({ pollMs: 10, stallMs: 60_000 });
    atRisk.jobs = []; // nothing in flight AT SAVE TIME — as reported
    const backend = new RecordingBackend();
    const manager = makeManager(backend);
    const tab = "tab-hold";
    await busyTab(manager, backend, tab);

    expect(manager.restartAllForMcpEnvAfterCredentialChange(tab).scheduled).toBe(1);

    // …and only THEN the downloads start, in the window the save could not see.
    atRisk.jobs = [job(4_000_000_000), { id: "j2", filename: "wan22.safetensors", bytes: 9_000_000_000 }];

    backend.autoComplete = true;
    backend.release(); // turn done → this is where the respawn used to happen
    await sleep(200); // many poll ticks

    expect(backend.runCount, "the tool session must NOT have been replaced").toBe(1);
    expect(backend.turnTexts.filter((t) => t.includes("flux-dev.safetensors"))).toHaveLength(0);
  });

  it("fires by ITSELF once the transfers finish, with no further turn", async () => {
    // The half that makes the hold safe rather than a wedge. Nothing calls
    // `applyPendingRestarts` while a tab sits idle, so a hold with no poll behind it is a
    // respawn that never happens — and the credential would then only reach a rebuilt child
    // on the next unrelated restart.
    setWindows({ pollMs: 10, stallMs: 60_000 });
    atRisk.jobs = [job(4_000_000_000)];
    const backend = new RecordingBackend();
    const manager = makeManager(backend);
    const tab = "tab-drain";
    await busyTab(manager, backend, tab);

    manager.restartAllForMcpEnvAfterCredentialChange(tab);
    backend.autoComplete = true;
    backend.release();
    await sleep(120);
    expect(backend.runCount, "held while it was still transferring").toBe(1);

    atRisk.jobs = []; // the download finishes. No turn, no message, no user action.
    await waitFor(() => backend.runCount >= 2);

    // The good ending: the respawn happened and killed nothing, so there is nothing to say.
    expect(backend.turnTexts.filter((t) => /rebuild is happening NOW/i.test(t))).toHaveLength(0);
  });

  it("gives up on transfers that stop making progress, and says it waited", async () => {
    // A hold with no exit is a respawn a dead download can pin for the rest of the session.
    // The exit is stall, NOT a wall-clock cap — a cap would kill exactly the healthy 48 GB
    // transfer this exists to protect. When it does give up, the #1567 note fires (that is
    // the 0.51.49 half) and has to say the wait happened, or it reads as the original
    // "killed the moment it came due".
    setWindows({ pollMs: 10, stallMs: 60 });
    atRisk.jobs = [job(4_000_000_000)]; // frozen: same byte count every read
    const backend = new RecordingBackend();
    const manager = makeManager(backend);
    const tab = "tab-stalled";
    await busyTab(manager, backend, tab);

    manager.restartAllForMcpEnvAfterCredentialChange(tab);
    backend.autoComplete = true;
    backend.release();

    await waitFor(() => backend.runCount >= 2);
    await waitFor(() => backend.turnTexts.some((t) => t.includes("flux-dev.safetensors")));
    const note = backend.turnTexts.find((t) => t.includes("flux-dev.safetensors")) as string;
    expect(note, "the note must not describe an instant kill any more").toMatch(/WAITED/);
    expect(note).toMatch(/stopped making progress/i);
  });

  it("waits on PROGRESS, not on a clock — a moving transfer is never given up on", async () => {
    // The distinction the stall window exists for, and the one a wall-clock cap loses. This
    // runs well past the stall window while bytes keep arriving; a timer-based hold fires
    // partway through and kills a perfectly healthy download.
    setWindows({ pollMs: 10, stallMs: 50 });
    atRisk.jobs = [job(1_000_000)];
    const backend = new RecordingBackend();
    const manager = makeManager(backend);
    const tab = "tab-moving";
    await busyTab(manager, backend, tab);

    manager.restartAllForMcpEnvAfterCredentialChange(tab);
    backend.autoComplete = true;
    backend.release();

    const ticker = setInterval(() => {
      atRisk.jobs = [job((atRisk.jobs[0]?.bytes ?? 0) + 5_000_000)];
    }, 10);
    await sleep(300); // 6× the stall window
    clearInterval(ticker);
    expect(backend.runCount, "still transferring, so still held").toBe(1);

    // Now it really does stop, and the hold ends on its own.
    await waitFor(() => backend.runCount >= 2);
  });

  it("a transfer FINISHING does not read as a stall", async () => {
    // The total can DROP: one of two downloads completing shrinks the set and the byte
    // total. Treating only an increase as activity would start the stall clock during the
    // very thing being waited for, and the survivor gets killed for its neighbour finishing.
    setWindows({ pollMs: 10, stallMs: 80 });
    atRisk.jobs = [job(9_000_000_000), { id: "j2", filename: "wan22.safetensors", bytes: 1_000_000 }];
    const backend = new RecordingBackend();
    const manager = makeManager(backend);
    const tab = "tab-shrink";
    await busyTab(manager, backend, tab);

    manager.restartAllForMcpEnvAfterCredentialChange(tab);
    backend.autoComplete = true;
    backend.release();
    await sleep(40);
    // The BIG one finishes; the small one is left, so the total falls sharply.
    atRisk.jobs = [{ id: "j2", filename: "wan22.safetensors", bytes: 1_000_000 }];
    await sleep(60); // past the stall window measured from the save, not from this change
    expect(backend.runCount, "the survivor is still transferring").toBe(1);
  });

  it("a RETARGET that lands on a credential respawn is NOT held", async () => {
    // #1429. A retarget's child is addressing the machine the user just left, so every call
    // it serves lands on the wrong ComfyUI — silently, when that machine is still up. Waiting
    // there prolongs the exact failure retargeting exists to end.
    //
    // The tab has to be MARKED for this to test anything: the two restarts coalesce onto one
    // queued respawn, so the question is what that single respawn does once it is BOTH a
    // credential save's and a retarget's. A first version of this test retargeted a tab no
    // credential had ever been saved on — it passed with the exclusion deleted, because
    // nothing had marked the tab in the first place.
    setWindows({ pollMs: 10, stallMs: 60_000 });
    atRisk.jobs = [job(4_000_000_000)];
    const backend = new RecordingBackend();
    const spawns: string[] = [];
    const manager = makeManager(backend, spawns);
    const tab = "tab-retarget";
    await busyTab(manager, backend, tab);

    manager.restartAllForMcpEnvAfterCredentialChange(tab); // marks the tab, queues a respawn
    manager.retargetAllForMcpEnv("http://old:8188", "http://new:8188"); // …now it is a retarget too
    backend.autoComplete = true;
    backend.release();

    // A stall window of a minute means this can only pass if it never held at all.
    await waitFor(() => spawns.filter((t) => t === tab).length >= 2);
    // …and the transfers it did kill are still reported, by the watch the save armed.
    await waitFor(() => backend.turnTexts.some((t) => t.includes("flux-dev.safetensors")));
  });

  it("an ordinary env respawn never waits either", async () => {
    // The base_path recovery respawn and every other plain `restartAllForMcpEnv`. This has
    // no license to delay them — only a credential save's own respawn may wait.
    setWindows({ pollMs: 10, stallMs: 60_000 });
    atRisk.jobs = [job(4_000_000_000)];
    const backend = new RecordingBackend();
    const manager = makeManager(backend);
    const tab = "tab-plain";
    await busyTab(manager, backend, tab);

    manager.restartAllForMcpEnv();
    backend.autoComplete = true;
    backend.release();

    await waitFor(() => backend.runCount >= 2);
  });

  it("holds a SECOND tab even after the first has already been served", async () => {
    // The design decision this file exists to pin. "Who gets told, once" (the #1567 orphan
    // watch) and "may this child be torn down yet" are different questions: the watch is
    // consumed by the first delivery, so a hold keyed off it silently stops protecting every
    // other tab of the same save. That is not hypothetical — the first tab is served with
    // NOTHING in flight (so it correctly fires and consumes the watch), and the downloads
    // start afterwards, in the window the busy tab is still waiting through.
    setWindows({ pollMs: 10, stallMs: 60_000 });
    atRisk.jobs = [];
    const backend = new RecordingBackend();
    const spawns: string[] = [];
    const manager = makeManager(backend, spawns);

    // tab-idle is idle at save time; tab-busy is mid-turn.
    backend.autoComplete = true;
    manager.send("tab-idle", "hi");
    await waitFor(() => backend.runCount >= 1);
    await busyTab(manager, backend, "tab-busy");
    await waitFor(() => backend.turnTexts.length >= 2);

    const tally = manager.restartAllForMcpEnvAfterCredentialChange("tab-idle");
    expect(tally.applied, "the idle tab respawns inside the save, consuming the watch").toBe(1);
    expect(tally.scheduled, "the busy tab still owes one").toBe(1);
    expect(spawns.filter((t) => t === "tab-idle"), "…and it really did respawn").toHaveLength(2);

    // The downloads start now — after the first tab was served, before the second fires.
    atRisk.jobs = [job(4_000_000_000)];
    backend.autoComplete = true;
    backend.release();
    await sleep(200);

    expect(
      spawns.filter((t) => t === "tab-busy"),
      "the busy tab's respawn must wait too",
    ).toHaveLength(1);
  });

  it("does not delay an unrelated restart after the credential respawn has resolved", async () => {
    // The mark is per-restart, not per-tab-forever. If it outlived the save, every later
    // env respawn on that tab would start waiting for downloads it has no relationship to.
    setWindows({ pollMs: 10, stallMs: 60_000 });
    atRisk.jobs = [];
    const backend = new RecordingBackend();
    const manager = makeManager(backend);
    const tab = "tab-spent";
    await busyTab(manager, backend, tab);

    manager.restartAllForMcpEnvAfterCredentialChange(tab);
    backend.autoComplete = true;
    backend.release();
    await waitFor(() => backend.runCount >= 2); // nothing in flight → fires, mark spent

    // Later: downloads ARE running, and an ordinary respawn is queued.
    atRisk.jobs = [job(4_000_000_000)];
    backend.autoComplete = false;
    manager.send(tab, "again");
    await waitFor(() => backend.turnTexts.includes("again"));
    manager.restartAllForMcpEnv();
    backend.autoComplete = true;
    backend.release();

    await waitFor(() => backend.runCount >= 3);
  });
});
