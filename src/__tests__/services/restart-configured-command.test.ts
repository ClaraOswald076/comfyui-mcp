// panel#1262: a wedged EXTERNALLY-MANAGED ComfyUI (a local container, a systemd
// unit, a launcher) had no recovery: its argv[0] is a bare `main.py` that
// anchors only inside the instance's own namespace, so the refuse-safe
// preflight (correctly) refused the kill+relaunch, and the wedged server
// answered no Manager reboot. COMFYUI_RESTART_COMMAND is the user's explicit
// statement of what cycles the instance; restart_comfyui now runs it.
//
// The honesty rules pinned here are the Manager reboot path's own (#367,
// #1642): a confirmed restart requires the loopback witness to have OBSERVED
// the down→up; a healthy answer with no observed cycle is "unconfirmed"; an
// expired readiness budget is NOT a failure; a failed command is reported as a
// failed command, with the probe outcome stated as an observation.
//
// Boundaries only are mocked: config, child_process (the configured command is
// the exec mock), the instance witness, the ComfyUI client, and comfyuiFetch
// (the readiness probe). No real process/port/network is touched.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockConfig = vi.hoisted(() => ({
  resolvedPort: 8188,
  comfyuiPath: undefined as string | undefined,
  comfyuiRestartCommand: undefined as string | undefined,
}));

const mockExec = vi.hoisted(() => vi.fn());
const mockComfyuiFetch = vi.hoisted(() => vi.fn());
// The instance witness (services/instance-witness.ts): `closedAt` is driven
// per-test — a close stamped AFTER the command ran is the observed down.
const mockWitness = vi.hoisted(() => ({
  closedAt: vi.fn<[], number | undefined>(() => undefined),
  alive: vi.fn(() => true),
  close: vi.fn(),
}));
const mockAcquireWitness = vi.hoisted(() => vi.fn());

vi.mock("../../config.js", () => ({
  config: mockConfig,
  getComfyUIBaseUrl: () => "http://127.0.0.1:8188",
  getComfyUIAuthHeaders: () => ({}),
  getComfyuiTargetGeneration: () => 0,
  isRemoteMode: () => false,
}));

vi.mock("node:child_process", () => ({
  exec: mockExec,
  execSync: vi.fn(),
  execFile: vi.fn(),
  execFileSync: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock("../../comfyui/client.js", () => ({
  getSystemStats: vi.fn(),
  resetClient: vi.fn(),
  resetObjectInfoCache: vi.fn(),
}));

vi.mock("../../comfyui/fetch.js", () => ({
  comfyuiFetch: mockComfyuiFetch,
  describeTargetDrift: vi.fn(),
}));

vi.mock("../../services/instance-witness.js", () => ({
  acquireInstanceWitness: mockAcquireWitness,
}));

vi.mock("../../utils/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  __processControlTestHooks,
  restartComfyUI,
} from "../../services/process-control.js";

/** exec following node's (cmd, opts, cb) convention so promisify resolves. */
function commandSucceeds(): void {
  mockExec.mockImplementation(
    (_cmd: string, _opts: unknown, cb: (err: unknown, stdout: string, stderr: string) => void) =>
      cb(null, "", ""),
  );
}

function commandFails(): void {
  mockExec.mockImplementation(
    (_cmd: string, _opts: unknown, cb: (err: unknown) => void) =>
      cb(Object.assign(new Error("Command failed: docker restart comfy\n"), { code: 1 })),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockConfig.comfyuiRestartCommand = "docker restart comfyui";
  mockAcquireWitness.mockResolvedValue(mockWitness);
  mockWitness.closedAt.mockReturnValue(undefined);
  __processControlTestHooks.reset();
  // The configured-command path reuses the remote-reboot readiness timing —
  // pin it fast so the not-ready case doesn't wait the real ~120s budget.
  __processControlTestHooks.setRemoteRebootTimingForTests({
    settleMs: 0,
    budgetMs: 30,
    intervalMs: 1,
  });
});

afterEach(() => {
  __processControlTestHooks.reset();
});

describe("restart_comfyui with COMFYUI_RESTART_COMMAND set (panel#1262)", () => {
  it("runs the configured command and CONFIRMS the restart when the loopback witness saw the cycle", async () => {
    commandSucceeds();
    mockComfyuiFetch.mockResolvedValue({ ok: true });
    // A close stamped AFTER the dispatch: the instance that accepted the witness
    // went away after the command ran — the observed down of the down→up (#1642).
    mockWitness.closedAt.mockReturnValue(Date.now() + 60_000);

    const result = await restartComfyUI();

    expect(mockExec).toHaveBeenCalledTimes(1);
    expect(mockExec.mock.calls[0][0]).toBe("docker restart comfyui");
    expect(result.stopped).toBe(true);
    expect(result.started).toBe(true);
    expect(result.startup).toBe("confirmed");
    expect(result.ready).toBe(true);
    // We launched nothing — the command cycled the process — so the listener is
    // never ours to claim, confirmed or not.
    expect(result.listener_ownership).toBe("unconfirmed");
    expect(result.message).toMatch(/CONFIRMED/);
  });

  it("a healthy answer with NO observed cycle is UNCONFIRMED, never claimed as restarted", async () => {
    commandSucceeds();
    mockComfyuiFetch.mockResolvedValue({ ok: true });
    mockWitness.closedAt.mockReturnValue(undefined); // witness still open: no cycle observed

    const result = await restartComfyUI();

    expect(result.stopped).toBe(true);
    expect(result.started).toBe(false);
    expect(result.startup).toBe("unconfirmed");
    expect(result.ready).toBe(true);
    expect(result.message).toMatch(/not directly observed/);
  });

  it("an expired readiness budget is NOT CONFIRMED YET — never reported as a failure (#367)", async () => {
    commandSucceeds();
    mockComfyuiFetch.mockResolvedValue({ ok: false }); // nothing healthy answers

    const result = await restartComfyUI();

    expect(result.stopped).toBe(true);
    expect(result.started).toBe(false);
    expect(result.startup).toBe("unconfirmed");
    expect(result.ready).toBe(false);
    expect(result.message).toMatch(/NOT CONFIRMED YET/);
    expect(result.message).not.toMatch(/failed to start/i);
  });

  it("a FAILING command is reported as a failed command — the old instance still answering is stated as an observation", async () => {
    commandFails();
    mockComfyuiFetch.mockResolvedValue({ ok: true }); // the old instance never went down

    const result = await restartComfyUI();

    expect(result.stopped).toBe(false);
    expect(result.started).toBe(false);
    expect(result.startup).toBe("failed");
    expect(result.ready).toBe(true);
    expect(result.message).toMatch(/restart command \(COMFYUI_RESTART_COMMAND\) failed/);
    expect(result.message).toMatch(/still serving/);
  });

  it("a failing command with nothing answering says so — never asserts what the command did before it failed", async () => {
    commandFails();
    mockComfyuiFetch.mockRejectedValue(new Error("fetch failed"));

    const result = await restartComfyUI();

    expect(result.stopped).toBe(false);
    expect(result.startup).toBe("failed");
    expect(result.ready).toBe(false);
    expect(result.message).toMatch(/nothing is answering/);
    expect(result.message).toMatch(/not knowable from here/);
  });

  it("WITHOUT the command there is no path change: no local process → the usual honest negative", async () => {
    mockConfig.comfyuiRestartCommand = undefined;

    const result = await restartComfyUI();

    expect(mockExec).not.toHaveBeenCalled();
    expect(result.stopped).toBe(false);
    expect(result.started).toBe(false);
    expect(result.startup).toBe("not-attempted");
    expect(result.message).toMatch(/No ComfyUI process found/);
  });
});
