import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComfyUIError } from "../../utils/errors.js";

// #485: when ComfyUI rejects a workflow during prompt validation it answers
// POST /prompt with HTTP 400 whose JSON body carries the authoritative
// diagnosis (`error.message` + `node_errors[<id>].{class_type,errors}`).
// enqueuePrompt must surface those details instead of a generic HTTP status,
// falling back to the status only when the body is empty/unparseable.

vi.mock("../../config.js", async () => {
  const actual = await vi.importActual<typeof import("../../config.js")>("../../config.js");
  return {
    ...actual,
    isCloudMode: () => false,
    getComfyUIBaseUrl: () => "http://127.0.0.1:8188",
  };
});

const comfyuiFetch = vi.fn();
vi.mock("../../comfyui/fetch.js", () => ({
  comfyuiFetch: (...a: unknown[]) => comfyuiFetch(...a),
}));

const { enqueuePrompt } = await import("../../comfyui/client.js");

function res(status: number, body: unknown, statusText = "Bad Request"): Response {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    text: async () => text,
    json: async () => JSON.parse(text),
    headers: new Map(),
  } as unknown as Response;
}

const validationBody = {
  error: {
    type: "prompt_outputs_failed_validation",
    message: "Prompt outputs failed validation",
    details: "",
    extra_info: {},
  },
  node_errors: {
    "5": {
      class_type: "LoadImage",
      errors: [
        {
          type: "custom_validation_failed",
          message: "Custom validation failed for node: image",
          details: "Invalid image file: missing.png",
          extra_info: {},
        },
      ],
      dependent_outputs: ["11"],
    },
  },
};

describe("enqueuePrompt — surfaces ComfyUI 400 validation details (#485)", () => {
  beforeEach(() => comfyuiFetch.mockReset());
  afterEach(() => vi.clearAllMocks());

  it("surfaces node_errors (id, class_type, message, details) on a 400", async () => {
    comfyuiFetch.mockResolvedValueOnce(res(400, validationBody));

    const err = await enqueuePrompt({ "5": { class_type: "LoadImage", inputs: {} } }).catch(
      (e) => e,
    );

    expect(err).toBeInstanceOf(ComfyUIError);
    const message = (err as Error).message;
    // The authoritative details must appear — not just the bare HTTP status.
    expect(message).toContain("Prompt outputs failed validation");
    expect(message).toContain("LoadImage");
    expect(message).toContain("node 5");
    expect(message).toContain("Invalid image file: missing.png");
    // Raw payload preserved for programmatic consumers.
    expect((err as ComfyUIError).details).toMatchObject({
      status: 400,
      node_errors: { "5": { class_type: "LoadImage" } },
    });
  });

  it("falls back to the generic HTTP status when the 400 body is empty", async () => {
    comfyuiFetch.mockResolvedValueOnce(res(400, ""));
    const err = await enqueuePrompt({}).catch((e) => e);
    expect(err).toBeInstanceOf(ComfyUIError);
    expect((err as Error).message).toContain("400");
    expect((err as Error).message).toContain("Bad Request");
  });

  it("returns prompt_id + the authoritative /queue depth on success", async () => {
    comfyuiFetch
      .mockResolvedValueOnce(res(200, { prompt_id: "abc", number: 42 }, "OK")) // POST /prompt
      .mockResolvedValueOnce(
        res(200, { queue_running: [{}], queue_pending: [{}, {}] }, "OK"),
      ); // GET /queue
    const out = await enqueuePrompt({ "1": { class_type: "KSampler", inputs: {} } });
    // queue_remaining is running+pending (1+2=3), NOT ComfyUI's `number` (42).
    expect(out).toEqual({ prompt_id: "abc", queue_remaining: 3 });
  });

  it("never surfaces ComfyUI's monotonic `number` (negative for front jobs) as queue_remaining", async () => {
    comfyuiFetch
      .mockResolvedValueOnce(res(200, { prompt_id: "z", number: -17 }, "OK"))
      .mockResolvedValueOnce(res(200, { queue_running: [{}], queue_pending: [] }, "OK"));
    const out = await enqueuePrompt({}, undefined, { front: true });
    expect(out.queue_remaining).toBe(1); // real depth, not -17
  });

  it("falls back to undefined queue_remaining when /queue can't be read", async () => {
    comfyuiFetch
      .mockResolvedValueOnce(res(200, { prompt_id: "abc", number: 5 }, "OK"))
      .mockRejectedValueOnce(new Error("network"));
    const out = await enqueuePrompt({ "1": { class_type: "KSampler", inputs: {} } });
    expect(out).toEqual({ prompt_id: "abc", queue_remaining: undefined });
  });
});

// #1037 — the OTHER half of the same body, and the one that was discarded.
//
// ComfyUI validates each output branch independently. When SOME validate it
// queues those and answers **200** with a prompt_id, carrying `node_errors` for
// the branches it REJECTED (execution.py returns (True, None, good_outputs,
// node_errors); it only 400s when NO output is good). Those branches never run
// — ComfyUI logs "Output will be ignored" — and the prompt still completes.
//
// So the run reported `success`, `diagnose` said "validates clean", and no video
// existed. This function already goes direct to /prompt SO THAT node_errors can
// be read (#485 above) — but only the 400 path ever read them.
describe("#1037: a 200 can still carry rejected output branches", () => {
  const partial = {
    prompt_id: "abc-123",
    number: 1,
    node_errors: {
      "343": {
        class_type: "ResizeImageMaskNode",
        errors: [
          {
            type: "required_input_missing",
            message: "Required input is missing",
            details: "crop",
            extra_info: { input_name: "resize_type.crop" },
          },
        ],
      },
    },
  };

  beforeEach(() => {
    comfyuiFetch.mockReset();
    comfyuiFetch.mockImplementation(async (url: string) =>
      String(url).endsWith("/queue")
        ? res(200, { queue_running: [], queue_pending: [] }, "OK")
        : res(200, partial, "OK"),
    );
  });

  it("still reports the prompt as queued — it genuinely was", async () => {
    const out = await enqueuePrompt({} as never);
    expect(out.prompt_id).toBe("abc-123");
  });

  it("names the rejected branch instead of discarding it", async () => {
    const { rejectedOutputs } = await enqueuePrompt({} as never);
    expect(rejectedOutputs).toBeDefined();
    expect(rejectedOutputs).toContain("node 343");
    expect(rejectedOutputs).toContain("ResizeImageMaskNode");
    expect(rejectedOutputs).toContain("Required input is missing");
    expect(rejectedOutputs).toContain("resize_type.crop");
  });

  // The sentence that would have saved the reporter an investigation.
  it("warns that the run can report success while producing nothing", async () => {
    const { rejectedOutputs } = await enqueuePrompt({} as never);
    expect(rejectedOutputs).toMatch(/QUEUED, but ComfyUI REJECTED/);
    expect(rejectedOutputs).toMatch(/report success while producing nothing/);
  });

  it("says nothing when every output was accepted", async () => {
    comfyuiFetch.mockImplementation(async (url: string) =>
      String(url).endsWith("/queue")
        ? res(200, { queue_running: [], queue_pending: [] }, "OK")
        : res(200, { prompt_id: "ok-1", number: 1, node_errors: {} }, "OK"),
    );
    const out = await enqueuePrompt({} as never);
    expect(out.rejectedOutputs).toBeUndefined();
  });

  it("says nothing when node_errors is absent entirely", async () => {
    comfyuiFetch.mockImplementation(async (url: string) =>
      String(url).endsWith("/queue")
        ? res(200, { queue_running: [], queue_pending: [] }, "OK")
        : res(200, { prompt_id: "ok-2", number: 1 }, "OK"),
    );
    expect((await enqueuePrompt({} as never)).rejectedOutputs).toBeUndefined();
  });

  // A node we cannot parse a reason for must still be NAMED — "this branch will
  // not run" is the load-bearing fact and does not depend on our parsing.
  it("names a rejected node even when its error detail is unreadable", async () => {
    comfyuiFetch.mockImplementation(async (url: string) =>
      String(url).endsWith("/queue")
        ? res(200, { queue_running: [], queue_pending: [] }, "OK")
        : res(200, { prompt_id: "x", number: 1, node_errors: { "9": {} } }, "OK"),
    );
    const { rejectedOutputs } = await enqueuePrompt({} as never);
    expect(rejectedOutputs).toContain("node 9");
  });

  it("counts multiple rejected branches", async () => {
    comfyuiFetch.mockImplementation(async (url: string) =>
      String(url).endsWith("/queue")
        ? res(200, { queue_running: [], queue_pending: [] }, "OK")
        : res(200, {
            prompt_id: "x",
            number: 1,
            node_errors: { "1": { class_type: "A" }, "2": { class_type: "B" } },
          }, "OK"),
    );
    const { rejectedOutputs } = await enqueuePrompt({} as never);
    expect(rejectedOutputs).toContain("2 output branches");
    expect(rejectedOutputs).toContain("node 1");
    expect(rejectedOutputs).toContain("node 2");
  });
});
