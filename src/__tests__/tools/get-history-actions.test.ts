import { describe, expect, it, beforeEach, vi } from "vitest";

/**
 * `get_history` — the four-action observability surface (0.50.0 slice 16).
 *
 * The dispatcher's own contract: schema shape, per-action dispatch, unknown
 * action, and the property that makes this tool unusual — NO action has a
 * required field, so every one of the four must work from `{action}` alone.
 * That is asserted rather than assumed, because a guard added later that
 * demanded `prompt_id` would be a false refusal nothing else would catch.
 *
 * Two of the four read ComfyUI's execution history and two read this server's
 * OWN local settings database. They must not be able to answer for each other,
 * so there is a table pinning which store each action touches.
 *
 * The behavioural coverage of the folded tools lives on in diagnose-run.test.ts,
 * get-history-select.test.ts and get-history-media-type.test.ts, which drive
 * this tool through its actions.
 */

const getHistoryMock = vi.fn(async () => ({}));
const getLogsMock = vi.fn(async () => "");
vi.mock("../../comfyui/client.js", () => ({
  getHistory: (...a: unknown[]) => getHistoryMock(...a),
  getLogs: (...a: unknown[]) => getLogsMock(...a),
}));
vi.mock("../../services/workflow-validator.js", () => ({
  validateWorkflow: async () => ({ issues: [], summary: "ok" }),
}));

const statsMock = vi.fn(async () => ({
  content: [{ type: "text" as const, text: "stats-result" }],
}));
const suggestMock = vi.fn(async () => ({
  content: [{ type: "text" as const, text: "suggest-result" }],
}));
vi.mock("../../tools/generation-tracker.js", () => ({
  generationStatsAction: (...a: unknown[]) => statsMock(...a),
  suggestSettingsAction: (...a: unknown[]) => suggestMock(...a),
}));

import { z } from "zod";
import { registerDiagnosticsTools } from "../../tools/diagnostics.js";

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
}>;

function capture(): { handler: ToolHandler; schema: Record<string, z.ZodTypeAny> } {
  let handler: ToolHandler | undefined;
  let schema: Record<string, z.ZodTypeAny> | undefined;
  const server = {
    tool: (n: string, _d: string, s: Record<string, z.ZodTypeAny>, h: ToolHandler) => {
      if (n === "get_history") {
        handler = h;
        schema = s;
      }
    },
  };
  registerDiagnosticsTools(server as never);
  if (!handler || !schema) throw new Error("get_history not registered");
  return { handler, schema };
}

const GRAPH = { "1": { class_type: "KSampler", inputs: { seed: 1 } } };
const HISTORY = {
  "abc-123": {
    prompt: [1, "abc-123", GRAPH, {}, []],
    outputs: {},
    status: { status_str: "success", completed: true, messages: [] },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  getHistoryMock.mockResolvedValue(HISTORY as never);
});

describe("get_history — schema shape", () => {
  it("makes `action` the ONLY required field", () => {
    const { schema } = capture();
    const required = Object.entries(schema)
      .filter(([name]) => name !== "action")
      .filter(([, s]) => !s.safeParse(undefined).success)
      .map(([name]) => name);
    expect(required).toEqual([]);
    expect(schema.action.safeParse(undefined).success).toBe(false);
  });

  it("exposes its parameters (a discriminated union would render zero)", () => {
    const { schema } = capture();
    const json = z.toJSONSchema(z.object(schema), { io: "input", unrepresentable: "any" }) as {
      properties?: Record<string, unknown>;
    };
    expect(Object.keys(json.properties ?? {})).toEqual(
      expect.arrayContaining(["action", "prompt_id", "model_family", "lora_hash", "search", "limit"]),
    );
  });

  it("accepts exactly the four actions", () => {
    const { schema } = capture();
    for (const a of ["list", "diagnose", "stats", "suggest"]) {
      expect(schema.action.safeParse(a).success, a).toBe(true);
    }
    expect(schema.action.safeParse("history").success).toBe(false);
  });

  it("keeps suggest's limit bounds", () => {
    const { schema } = capture();
    expect(schema.limit.safeParse(0).success).toBe(false);
    expect(schema.limit.safeParse(51).success).toBe(false);
    expect(schema.limit.safeParse(10).success).toBe(true);
  });
});

describe("get_history — every action works from `{action}` alone", () => {
  it.each(["list", "diagnose", "stats", "suggest"])(
    'action:"%s" needs no other field',
    async (action) => {
      const { handler } = capture();
      const res = await handler({ action });
      expect(res.isError, `${action} refused a call with only \`action\``).toBeUndefined();
    },
  );
});

describe("get_history — per-action dispatch", () => {
  it('action:"list" reads ComfyUI history and formats the entry', async () => {
    const { handler } = capture();
    const res = await handler({ action: "list", prompt_id: "abc-123" });
    expect(getHistoryMock).toHaveBeenCalledWith("abc-123");
    expect(res.content[0].text).toContain("abc-123");
    expect(res.content[0].text).not.toContain("## Diagnosis");
  });

  it('action:"diagnose" reads the same history but renders the diagnosis', async () => {
    const { handler } = capture();
    const res = await handler({ action: "diagnose", prompt_id: "abc-123" });
    expect(getHistoryMock).toHaveBeenCalledWith("abc-123");
    expect(res.content[0].text).toContain("## Diagnosis: abc-123");
  });

  it('action:"stats" reaches the tracker with only model_family', async () => {
    const { handler } = capture();
    const res = await handler({ action: "stats", model_family: "sdxl", limit: 5 });
    expect(statsMock).toHaveBeenCalledWith({ model_family: "sdxl" });
    expect(res.content[0].text).toBe("stats-result");
  });

  it('action:"suggest" forwards all four of its filters', async () => {
    const { handler } = capture();
    const res = await handler({
      action: "suggest",
      model_family: "flux",
      lora_hash: "abcd123456",
      search: "copax",
      limit: 3,
    });
    expect(suggestMock).toHaveBeenCalledWith({
      model_family: "flux",
      lora_hash: "abcd123456",
      search: "copax",
      limit: 3,
    });
    expect(res.content[0].text).toBe("suggest-result");
  });

  it("keeps the two STORES apart — no action can answer for the other", async () => {
    const { handler } = capture();
    const table: Array<[string, "comfy" | "local"]> = [
      ["list", "comfy"],
      ["diagnose", "comfy"],
      ["stats", "local"],
      ["suggest", "local"],
    ];
    for (const [action, store] of table) {
      vi.clearAllMocks();
      await handler({ action });
      // ComfyUI's execution history…
      expect(getHistoryMock.mock.calls.length, `${action} → getHistory`).toBe(
        store === "comfy" ? 1 : 0,
      );
      // …versus this server's own generation-settings database.
      const localCalls = statsMock.mock.calls.length + suggestMock.mock.calls.length;
      expect(localCalls, `${action} → local settings db`).toBe(store === "local" ? 1 : 0);
    }
  });
});

describe("get_history — no-history answers are messages, not errors", () => {
  it.each(["list", "diagnose"])(
    'action:"%s" reports an empty history plainly',
    async (action) => {
      const { handler } = capture();
      getHistoryMock.mockResolvedValue({} as never);
      const res = await handler({ action });
      expect(res.isError).toBeUndefined();
      expect(res.content[0].text).toContain("No execution history available");
    },
  );

  it("names the prompt when one was asked for and not found", async () => {
    const { handler } = capture();
    getHistoryMock.mockResolvedValue({} as never);
    const res = await handler({ action: "diagnose", prompt_id: "nope-1" });
    expect(res.content[0].text).toContain("No history found for prompt nope-1.");
  });
});

describe("get_history — absence, not falsiness", () => {
  it("an EMPTY prompt_id is forwarded to the history read, not swallowed", async () => {
    const { handler } = capture();
    await handler({ action: "list", prompt_id: "" });
    expect(getHistoryMock).toHaveBeenCalledWith("");
  });

  it("an EMPTY search string still reaches the tracker as a filter", async () => {
    const { handler } = capture();
    await handler({ action: "suggest", search: "" });
    expect(suggestMock).toHaveBeenCalledWith(
      expect.objectContaining({ search: "" }),
    );
  });
});

describe("get_history — unknown action", () => {
  it("rejects an unknown action, listing the valid ones", async () => {
    const { handler } = capture();
    const res = await handler({ action: "diagnose_the_run" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("Unknown get_history action");
    expect(res.content[0].text).toContain("list, diagnose, stats, suggest");
    expect(getHistoryMock).not.toHaveBeenCalled();
    expect(statsMock).not.toHaveBeenCalled();
    expect(suggestMock).not.toHaveBeenCalled();
  });
});
