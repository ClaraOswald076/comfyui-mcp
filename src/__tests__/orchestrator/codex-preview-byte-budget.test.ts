// #1516 — the cumulative byte budget's POINT OF FACT in the Codex lane.
//
// PanelAgent gates the per-conversation preview budget when it COMPOSES a turn,
// but it cannot see the bytes of the batch already in flight — only the backend
// can, because the fetch happens there. So the codex backend enforces the same
// cumulative byte budget at the image loop: an automatic preview that would
// arrive past the budget is NOT attached, and the turn text corrects the claim
// with get_image coordinates (the same discipline as PanelAgent's drain trim,
// one layer down). A user's explicit attachment (no `automatic` flag) is never
// touched by this budget.

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../../utils/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

type BackendModule = typeof import("../../orchestrator/codex-backend.js");
type Backend = InstanceType<BackendModule["CodexBackend"]>;

let CodexBackend: BackendModule["CodexBackend"];
let MAX_SESSION_PREVIEW_BYTES: number;

beforeAll(async () => {
  vi.resetModules();
  ({ CodexBackend } = await import("../../orchestrator/codex-backend.js"));
  ({ MAX_SESSION_PREVIEW_BYTES } = await import("../../orchestrator/preview-budget.js"));
});

afterAll(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const IMAGE_BYTES = 100;

/** A /view fetch that serves a fixed-size PNG. */
function stubImageFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      const body = Buffer.alloc(IMAGE_BYTES, 7);
      return new Response(body, {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    }),
  );
}

interface Captured {
  turnInput?: Array<Record<string, unknown>>;
}

/** The smallest app-server client that carries one turn: thread/start, one
 *  turn/start (capturing its input), then a matching turn/completed. */
function fakeClient(captured: Captured) {
  const client: Record<string, unknown> = {
    notificationHandler: null,
    exitError: undefined,
    // Never settles: the app-server outlives every turn in these tests.
    exitPromise: new Promise(() => {}),
    close: async () => {},
  };
  client.request = vi.fn(async (method: string, params: Record<string, unknown>) => {
    if (method === "thread/start" || method === "thread/resume") {
      return { thread: { id: "thread-1" }, model: "gpt-5.6-sol" };
    }
    if (method === "turn/start") {
      captured.turnInput = params.input as Array<Record<string, unknown>>;
      // Complete the turn AFTER the response's .then has published the turn id
      // (the notification handler buffers until then) — a macrotask lands after.
      setTimeout(() => {
        (client.notificationHandler as ((m: unknown) => void) | null)?.({
          method: "turn/completed",
          params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } },
        });
      }, 0);
      return { turn: { id: "turn-1" } };
    }
    throw new Error(`unexpected request: ${method}`);
  });
  return client;
}

/** Drive one turn carrying `images` through a backend whose cumulative preview
 *  byte ledger starts at `priorBytes`, returning what turn/start received. */
async function runOneTurn(
  images: Array<{ filename: string; automatic?: boolean }>,
  priorBytes: number,
): Promise<{ captured: Captured; be: Backend }> {
  stubImageFetch();
  const be = new CodexBackend({ comfyuiUrl: "http://127.0.0.1:8188" }) as Backend;
  const captured: Captured = {};
  const priv = be as unknown as Record<string, unknown>;
  priv.client = fakeClient(captured);
  // The ledger is a property OF THE THREAD: pre-seed both halves so run()'s
  // fresh-thread reset does not wipe the delivered-so-far bytes.
  priv.previewBytes = priorBytes;
  priv.previewBytesThread = "thread-1";

  const channel = (async function* () {
    yield { text: "here are the outputs", images };
  })();
  const events: unknown[] = [];
  for await (const ev of be.run({ channel } as never)) events.push(ev);
  await be.close?.();
  return { captured, be };
}

function localImages(captured: Captured): Array<Record<string, unknown>> {
  return (captured.turnInput ?? []).filter((i) => i.type === "localImage");
}

function turnText(captured: Captured): string {
  return String((captured.turnInput ?? []).find((i) => i.type === "text")?.text ?? "");
}

describe("codex cumulative preview byte budget (#1516)", () => {
  it("charges delivered automatic previews against the conversation's byte ledger", async () => {
    const { captured, be } = await runOneTurn(
      [{ filename: "auto.png", automatic: true }, { filename: "user.png" }],
      0,
    );
    // Both images ride (budget untouched); only the AUTOMATIC one charges.
    expect(localImages(captured)).toHaveLength(2);
    expect(be.automaticPreviewBytes?.()).toBe(IMAGE_BYTES);
  });

  it("withholds automatic previews past the byte budget — and the turn says so with coordinates", async () => {
    const { captured, be } = await runOneTurn(
      [{ filename: "auto.png", automatic: true }, { filename: "user.png" }],
      MAX_SESSION_PREVIEW_BYTES,
    );

    // The automatic preview is NOT attached; the user's own attachment is not
    // this budget's business and still rides.
    expect(localImages(captured)).toHaveLength(1);
    const text = turnText(captured);
    expect(text).toContain("[panel note:");
    expect(text).toContain("cumulative automatic-preview byte budget");
    expect(text).toContain("auto.png");
    expect(text).toContain('get_image action:"get"');
    // Nothing was delivered, so nothing was charged.
    expect(be.automaticPreviewBytes?.()).toBe(MAX_SESSION_PREVIEW_BYTES);
  });

  it("resets the byte ledger when a DIFFERENT thread starts", async () => {
    stubImageFetch();
    const be = new CodexBackend({ comfyuiUrl: "http://127.0.0.1:8188" }) as Backend;
    const priv = be as unknown as Record<string, unknown>;
    // A prior thread's ledger…
    priv.previewBytes = MAX_SESSION_PREVIEW_BYTES;
    priv.previewBytesThread = "thread-OLD";
    // …must not follow a fresh thread, which provably holds no previews yet.
    const captured: Captured = {};
    priv.client = fakeClient(captured); // fake answers thread-1
    const channel = (async function* () {
      yield { text: "fresh conversation", images: [{ filename: "auto.png", automatic: true }] };
    })();
    for await (const _ of be.run({ channel } as never)) void _;
    await be.close?.();

    expect(localImages(captured)).toHaveLength(1);
    expect(be.automaticPreviewBytes?.()).toBe(IMAGE_BYTES);
  });
});
