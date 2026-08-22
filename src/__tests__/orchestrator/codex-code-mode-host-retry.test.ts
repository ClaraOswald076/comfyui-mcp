// #1929 — Windows can refuse the bundled `codex-code-mode-host.exe` spawn with
// ERROR_SHARING_VIOLATION (os error 32). The first code-mode call failed before
// JS ran; repeating the identical call succeeded. Codex does not retry that
// spawn; CodexBackend.runTurn() must, once, with a short backoff.
//
// These tests drive the live notificationHandler (the same seam as the
// interrupt-recovery suite) so the retry is proven on the shipped turn path.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../../utils/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

type BackendModule = typeof import("../../orchestrator/codex-backend.js");
type Backend = InstanceType<BackendModule["CodexBackend"]>;

let CodexBackend: BackendModule["CodexBackend"];
let isWindowsCodeModeHostSharingViolation: BackendModule["isWindowsCodeModeHostSharingViolation"];
let isWindowsCodeModeHostPathNotFound: BackendModule["isWindowsCodeModeHostPathNotFound"];
let isWindowsCodeModeHostSpawnRetryable: BackendModule["isWindowsCodeModeHostSpawnRetryable"];

beforeAll(async () => {
  vi.stubEnv("COMFYUI_MCP_CODEX_HOST_SPAWN_RETRY_MS", "15");
  vi.resetModules();
  ({
    CodexBackend,
    isWindowsCodeModeHostSharingViolation,
    isWindowsCodeModeHostPathNotFound,
    isWindowsCodeModeHostSpawnRetryable,
  } = await import("../../orchestrator/codex-backend.js"));
});

afterAll(() => vi.unstubAllEnvs());

/** The reporter's exact (scrubbed) Windows error — French FormatMessage + os error 32. */
const REPORTER_ERROR =
  "failed to spawn code-mode host ~/AppData/Roaming/nvm/v22.22.3/node_modules/comfyui-mcp/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex-code-mode-host.exe: Le processus ne peut pas acceder au fichier car ce fichier est utilise par un autre processus. (os error 32)";

const MISSING_HOST_ERROR =
  "failed to spawn code-mode host /opt/homebrew/bin/codex-code-mode-host: No such file or directory (os error 2)";

/** #2045 — reporter's exact (scrubbed) stale WinGet Node path, os error 3. */
const REPORTER_PATH_ERROR =
  "failed to spawn code-mode host C:\\Users\\x\\AppData\\Local\\Microsoft\\WinGet\\Packages\\OpenJS.NodeJS.LTS_8wekyb3d8bbwe\\node-v24.19.0-win-x64\\node_modules\\comfyui-mcp\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex-code-mode-host.exe: The system cannot find the path specified. (os error 3)";

type Handler = ((message: unknown) => void) | null;

async function waitUntil(pred: () => boolean, timeoutMs = 500): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

function turnStartsOf(request: ReturnType<typeof vi.fn>): number {
  return request.mock.calls.filter((c) => c[0] === "turn/start").length;
}

/** Open a live turn on a fake app-server client and return the notify seam. */
async function liveTurn() {
  let starts = 0;
  let resolveExit: (() => void) | undefined;
  const client = {
    notificationHandler: null as Handler,
    exitError: null as Error | null,
    exitPromise: new Promise<void>((resolve) => {
      resolveExit = resolve;
    }),
    request: vi.fn(async (method: string) => {
      if (method === "thread/start") return { thread: { id: "thread-1" }, model: "gpt-5.6-sol" };
      if (method === "turn/start") {
        starts += 1;
        return { turn: { id: `turn-${starts}` } };
      }
      throw new Error(`unexpected request: ${method}`);
    }),
    close: vi.fn(async () => {
      resolveExit?.();
    }),
  };
  const backend: Backend = new CodexBackend({ model: "gpt-5.6-sol" });
  Object.assign(backend, { client });

  async function* channel() {
    yield { text: "read ALL_TOOLS" };
  }

  const iterator = backend.run({ channel: channel() });
  await iterator.next(); // session
  const pending = iterator.next();
  await waitUntil(() => (backend as Backend & { turnId?: string }).turnId === "turn-1");

  const notify = (msg: Record<string, unknown>) => client.notificationHandler?.(msg);
  return { backend, client, iterator, pending, notify };
}

describe("isWindowsCodeModeHostSharingViolation (#1929)", () => {
  it("matches the reporter's French os-error-32 host spawn", () => {
    expect(isWindowsCodeModeHostSharingViolation(REPORTER_ERROR)).toBe(true);
  });

  it("matches the English sharing-violation wording", () => {
    expect(
      isWindowsCodeModeHostSharingViolation(
        "failed to spawn code-mode host C:\\codex-code-mode-host.exe: The process cannot access the file because it is being used by another process. (os error 32)",
      ),
    ).toBe(true);
  });

  it("does not match a missing host (os error 2) — that is not transient", () => {
    expect(isWindowsCodeModeHostSharingViolation(MISSING_HOST_ERROR)).toBe(false);
  });

  it("does not match an unrelated os-error-32", () => {
    expect(
      isWindowsCodeModeHostSharingViolation(
        "The process cannot access the file because it is being used by another process. (os error 32)",
      ),
    ).toBe(false);
  });
});

describe("isWindowsCodeModeHostPathNotFound (#2045)", () => {
  it("matches the reporter's stale WinGet path (os error 3)", () => {
    expect(isWindowsCodeModeHostPathNotFound(REPORTER_PATH_ERROR)).toBe(true);
    expect(isWindowsCodeModeHostSpawnRetryable(REPORTER_PATH_ERROR)).toBe(true);
  });

  it("does not match a missing host (os error 2) — that is not a stale directory", () => {
    expect(isWindowsCodeModeHostPathNotFound(MISSING_HOST_ERROR)).toBe(false);
    expect(isWindowsCodeModeHostSpawnRetryable(MISSING_HOST_ERROR)).toBe(false);
  });

  it("does not match a sharing-violation (that's #1929)", () => {
    expect(isWindowsCodeModeHostPathNotFound(REPORTER_ERROR)).toBe(false);
  });
});

describe("CodexBackend code-mode host spawn retry (#1929)", () => {
  it("retries the turn once after the reporter's sharing-violation, then succeeds", async () => {
    const { backend, client, iterator, pending, notify } = await liveTurn();
    expect(turnStartsOf(client.request)).toBe(1);

    notify({
      method: "error",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        willRetry: false,
        error: { message: REPORTER_ERROR },
      },
    });

    await waitUntil(() => turnStartsOf(client.request) >= 2);
    await waitUntil(() => (backend as Backend & { turnId?: string }).turnId === "turn-2");

    notify({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-2", status: "completed" } },
    });

    await expect(pending).resolves.toMatchObject({
      value: { type: "result", ok: true, subtype: "completed" },
    });
    expect(turnStartsOf(client.request)).toBe(2);
    await expect(iterator.next()).resolves.toMatchObject({ done: true });
  });

  it("a racing turn/completed for the failed turn does not prevent the retry", async () => {
    const { backend, client, iterator, pending, notify } = await liveTurn();

    notify({
      method: "error",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        willRetry: false,
        error: { message: REPORTER_ERROR },
      },
    });
    notify({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-1", status: "failed" } },
    });

    await waitUntil(() => turnStartsOf(client.request) >= 2);
    await waitUntil(() => (backend as Backend & { turnId?: string }).turnId === "turn-2");

    notify({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-2", status: "completed" } },
    });

    await expect(pending).resolves.toMatchObject({
      value: { type: "result", ok: true, subtype: "completed" },
    });
    expect(turnStartsOf(client.request)).toBe(2);
    await expect(iterator.next()).resolves.toMatchObject({ done: true });
  });

  it("a third sharing-violation after two retries is terminal", async () => {
    const { backend, client, iterator, pending, notify } = await liveTurn();

    notify({
      method: "error",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        willRetry: false,
        error: { message: REPORTER_ERROR },
      },
    });
    await waitUntil(() => turnStartsOf(client.request) >= 2);
    await waitUntil(() => (backend as Backend & { turnId?: string }).turnId === "turn-2");

    notify({
      method: "error",
      params: {
        threadId: "thread-1",
        turnId: "turn-2",
        willRetry: false,
        error: { message: REPORTER_ERROR },
      },
    });
    await waitUntil(() => turnStartsOf(client.request) >= 3);
    await waitUntil(() => (backend as Backend & { turnId?: string }).turnId === "turn-3");

    notify({
      method: "error",
      params: {
        threadId: "thread-1",
        turnId: "turn-3",
        willRetry: false,
        error: { message: REPORTER_ERROR },
      },
    });

    await expect(pending).resolves.toMatchObject({
      value: { type: "error", message: REPORTER_ERROR },
    });
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: "result", ok: false, subtype: "error" },
    });
    expect(turnStartsOf(client.request)).toBe(3);
    await expect(iterator.next()).resolves.toMatchObject({ done: true });
  });

  it("does not retry a missing-host spawn (os error 2)", async () => {
    const { client, iterator, pending, notify } = await liveTurn();

    notify({
      method: "error",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        willRetry: false,
        error: { message: MISSING_HOST_ERROR },
      },
    });

    await expect(pending).resolves.toMatchObject({
      value: { type: "error", message: MISSING_HOST_ERROR },
    });
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: "result", ok: false, subtype: "error" },
    });
    expect(turnStartsOf(client.request)).toBe(1);
    await expect(iterator.next()).resolves.toMatchObject({ done: true });
  });

  it("retries the turn once after the reporter's stale WinGet path (os error 3)", async () => {
    const { backend, client, iterator, pending, notify } = await liveTurn();
    expect(turnStartsOf(client.request)).toBe(1);

    notify({
      method: "error",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        willRetry: false,
        error: { message: REPORTER_PATH_ERROR },
      },
    });

    await waitUntil(() => turnStartsOf(client.request) >= 2);
    await waitUntil(() => (backend as Backend & { turnId?: string }).turnId === "turn-2");

    notify({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-2", status: "completed" } },
    });

    await expect(pending).resolves.toMatchObject({
      value: { type: "result", ok: true, subtype: "completed" },
    });
    expect(turnStartsOf(client.request)).toBe(2);
    await expect(iterator.next()).resolves.toMatchObject({ done: true });
  });

  it("survives the reporter's path-not-found then sharing-violation sequence", async () => {
    const { backend, client, iterator, pending, notify } = await liveTurn();

    notify({
      method: "error",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        willRetry: false,
        error: { message: REPORTER_PATH_ERROR },
      },
    });
    await waitUntil(() => turnStartsOf(client.request) >= 2);
    await waitUntil(() => (backend as Backend & { turnId?: string }).turnId === "turn-2");

    notify({
      method: "error",
      params: {
        threadId: "thread-1",
        turnId: "turn-2",
        willRetry: false,
        error: { message: REPORTER_ERROR },
      },
    });
    await waitUntil(() => turnStartsOf(client.request) >= 3);
    await waitUntil(() => (backend as Backend & { turnId?: string }).turnId === "turn-3");

    notify({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-3", status: "completed" } },
    });

    await expect(pending).resolves.toMatchObject({
      value: { type: "result", ok: true, subtype: "completed" },
    });
    expect(turnStartsOf(client.request)).toBe(3);
    await expect(iterator.next()).resolves.toMatchObject({ done: true });
  });

  it("recycles the app-server when the resolved bin is a stale WinGet path", async () => {
    const { backend, client, iterator, pending, notify } = await liveTurn();
    let replacementStarts = 0;
    const replacement = {
      notificationHandler: null as Handler,
      exitError: null,
      exitPromise: new Promise(() => {}),
      request: vi.fn(async (method: string) => {
        if (method === "thread/resume") return { thread: { id: "thread-1" }, model: "gpt-5.6-sol" };
        if (method === "turn/start") {
          replacementStarts += 1;
          return { turn: { id: `turn-r${replacementStarts}` } };
        }
        throw new Error(`unexpected request: ${method}`);
      }),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const staleBin =
      "C:\\Users\\x\\AppData\\Local\\Microsoft\\WinGet\\Packages\\OpenJS.NodeJS.LTS_8wekyb3d8bbwe\\node-v24.19.0-win-x64\\node_modules\\comfyui-mcp\\node_modules\\@openai\\codex\\bin\\codex.js";
    Object.assign(backend, { bin: staleBin });
    vi.spyOn(backend, "prepare").mockImplementation(async function (this: Backend) {
      Object.assign(this, { client: replacement, bin: "C:\\stable\\codex.exe" });
    });

    notify({
      method: "error",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        willRetry: false,
        error: { message: REPORTER_PATH_ERROR },
      },
    });

    await waitUntil(() => replacementStarts >= 1);
    expect(client.close).toHaveBeenCalled();
    expect(replacement.request).toHaveBeenCalledWith(
      "thread/resume",
      expect.objectContaining({ threadId: "thread-1" }),
    );

    await waitUntil(() => (backend as Backend & { turnId?: string }).turnId === "turn-r1");
    replacement.notificationHandler?.({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-r1", status: "completed" } },
    });

    await expect(pending).resolves.toMatchObject({
      value: { type: "result", ok: true, subtype: "completed" },
    });
    expect(replacementStarts).toBe(1);
    await expect(iterator.next()).resolves.toMatchObject({ done: true });
  });

  it("retries when turn/start itself rejects with the sharing-violation", async () => {
    let startCalls = 0;
    const client = {
      notificationHandler: null as Handler,
      exitError: null,
      exitPromise: new Promise(() => {}),
      request: vi.fn(async (method: string) => {
        if (method === "thread/start") return { thread: { id: "thread-1" }, model: "gpt-5.6-sol" };
        if (method === "turn/start") {
          startCalls += 1;
          if (startCalls === 1) throw new Error(REPORTER_ERROR);
          return { turn: { id: "turn-2" } };
        }
        throw new Error(`unexpected request: ${method}`);
      }),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const backend: Backend = new CodexBackend({ model: "gpt-5.6-sol" });
    Object.assign(backend, { client });

    async function* channel() {
      yield { text: "read ALL_TOOLS" };
    }
    const iterator = backend.run({ channel: channel() });
    await iterator.next();
    const pending = iterator.next();

    await waitUntil(() => startCalls >= 2);
    await waitUntil(() => (backend as Backend & { turnId?: string }).turnId === "turn-2");

    client.notificationHandler?.({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-2", status: "completed" } },
    });

    await expect(pending).resolves.toMatchObject({
      value: { type: "result", ok: true, subtype: "completed" },
    });
    expect(startCalls).toBe(2);
    await expect(iterator.next()).resolves.toMatchObject({ done: true });
  });
});
