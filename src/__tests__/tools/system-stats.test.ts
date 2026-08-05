import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { DEAD_NAMES, TOOL_NAMES } from "../../tools/vocabulary.js";

/**
 * The consolidated `get_system_stats` tool (0.50.0 slice 13): the six
 * stats/diagnostics tools folded into one action-parameterized tool. Proves the
 * consolidation did not change behaviour — every action calls the identical
 * service the old tool called, with the same arguments and the same content
 * block — and that the flat-enum shape actually EXPOSES its parameters (the
 * discriminated-union trap renders zero params).
 *
 * The property worth the most here: action:"report_issue" is the ONE action on a
 * tool named "get system stats" that leaves the machine — it can create or
 * comment on a public GitHub issue. Nothing else on this tool may reach it, and
 * it may not run on a call that omitted the fields it publishes.
 */

const mocks = vi.hoisted(() => ({
  getSystemInfo: vi.fn(),
  getLogs: vi.fn(),
  runHealthCheck: vi.fn(),
  fetchApi: vi.fn(),
  getSystemStats: vi.fn(),
  submitAndPoll: vi.fn(),
  evaluateBatch: vi.fn(),
}));

vi.mock("../../services/workflow-executor.js", () => ({
  getSystemInfo: (...a: unknown[]) => mocks.getSystemInfo(...a),
  enqueueWorkflow: vi.fn(),
}));
vi.mock("../../comfyui/client.js", () => ({
  getLogs: (...a: unknown[]) => mocks.getLogs(...a),
  getHistory: vi.fn(),
  getSystemStats: (...a: unknown[]) => mocks.getSystemStats(...a),
  getClient: () => ({ fetchApi: (...a: unknown[]) => mocks.fetchApi(...a) }),
}));
vi.mock("../../services/health-check.js", () => ({
  runHealthCheck: (...a: unknown[]) => mocks.runHealthCheck(...a),
}));
vi.mock("../../services/calc-evaluator.js", () => ({
  evaluateBatch: (...a: unknown[]) => mocks.evaluateBatch(...a),
}));

import { registerSystemStatsTools } from "../../tools/system-stats.js";

type Handler = (args: Record<string, any>) => Promise<{
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
}>;

interface Registered {
  name: string;
  shape: z.ZodRawShape;
  handler: Handler;
}

function registered(): Registered[] {
  const tools: Registered[] = [];
  const server = {
    tool: (name: string, _desc: string, shape: z.ZodRawShape, handler: Handler) => {
      tools.push({ name, shape, handler });
    },
  };
  registerSystemStatsTools(server as never);
  return tools;
}

/** The whole stats/diagnostics surface is now ONE tool (0.50.0 slice 13). */
function handler(): Handler {
  const tools = registered();
  expect(tools).toHaveLength(1);
  expect(tools[0].name).toBe("get_system_stats");
  return tools[0].handler;
}

/**
 * Parse through the real shape first: `unload_models` / `free_memory` carry
 * `.default(true)`, and a raw handler call would pass undefined where a real
 * client's call passes true.
 */
function call(args: Record<string, unknown>) {
  const [{ shape }] = registered();
  const parsed = z.object(shape).parse(args) as Record<string, unknown>;
  return handler()(parsed);
}

const text = (res: Awaited<ReturnType<Handler>>) => res.content.map((c) => c.text).join(" ");

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
});

describe("get_system_stats registration", () => {
  it("registers exactly one tool named `get_system_stats` (6→1)", () => {
    const tools = registered();
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("get_system_stats");
  });

  // The whole reason for the flat-enum shape rule: a z.discriminatedUnion renders
  // as ZERO parameters, hiding every input from the model.
  it("exposes a visible flat `action` enum with every per-action parameter", () => {
    const [{ shape }] = registered();
    // io: "input" — the conversion options the MCP SDK itself uses
    // (sdk/server/zod-json-schema-compat.js, asserted by docs-schema-parity.test.ts),
    // so this is the schema a client is actually given.
    const json = z.toJSONSchema(z.object(shape), { reused: "inline", io: "input" }) as {
      properties?: Record<string, { enum?: string[] }>;
      required?: string[];
    };
    expect(Object.keys(json.properties ?? {}).sort()).toEqual([
      "action",
      "body",
      "free_memory",
      "keyword",
      "labels",
      "max_lines",
      "mcp_version",
      "model_categories",
      "no_file",
      "panel_version",
      "recent_errors",
      "repo",
      "seed",
      "spec",
      "title",
      "unload_models",
      "variables",
    ]);
    expect(json.properties?.action.enum?.slice().sort()).toEqual([
      "calculate",
      "clear_vram",
      "health",
      "logs",
      "report_issue",
      "stats",
    ]);
    // Only `action` can be required — the rest are per-action, enforced in the handler.
    expect(json.required).toEqual(["action"]);
  });

  // The outward-facing action must be UNMISSABLE in the text a model reads
  // before choosing this tool: the name says "get system stats", and one of
  // these six publishes.
  it("the description warns, on the tool line, that one action publishes", () => {
    const tools: Array<{ desc: string }> = [];
    const server = {
      tool: (_n: string, desc: string) => {
        tools.push({ desc });
      },
    };
    registerSystemStatsTools(server as never);
    expect(tools[0].desc).toMatch(/PUBLIC GITHUB ISSUE/);
    expect(tools[0].desc).toMatch(/action:"report_issue"/);
  });

  it("an unknown action returns a clear error result", async () => {
    const res = await handler()({ action: "bogus" });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/unknown get_system_stats action/i);
    expect(text(res)).toMatch(/clear_vram/);
  });
});

describe("get_system_stats actions call the same services with the same arguments", () => {
  it('action:"stats" returns the raw /system_stats JSON', async () => {
    mocks.getSystemInfo.mockResolvedValueOnce({ devices: [{ name: "RTX 4090" }] });
    const res = await call({ action: "stats" });
    expect(mocks.getSystemInfo).toHaveBeenCalledTimes(1);
    expect(JSON.parse(text(res))).toEqual({ devices: [{ name: "RTX 4090" }] });
    expect(mocks.fetchApi).not.toHaveBeenCalled();
  });

  // The non-matching lines sit LAST on purpose: a tail that ignored `keyword`
  // would return them, and this assertion catches it. With the noise first, a
  // broken filter still produced the right two lines and the test passed.
  it('action:"logs" filters by keyword, tails to max_lines and strips ANSI', async () => {
    mocks.getLogs.mockResolvedValueOnce([
      "\x1b[31mERROR one\x1b[0m",
      "error two",
      "error three",
      "boot ok",
      "shutdown ok",
    ]);
    const res = await call({ action: "logs", keyword: "error", max_lines: 2 });
    expect(text(res)).toBe("error two\nerror three");

    mocks.getLogs.mockResolvedValueOnce(["\x1b[31mERROR one\x1b[0m"]);
    const all = await call({ action: "logs" });
    expect(text(all)).toBe("ERROR one");
  });

  it('action:"logs" reports the keyword back when nothing matched', async () => {
    mocks.getLogs.mockResolvedValueOnce(["boot ok"]);
    const res = await call({ action: "logs", keyword: "traceback" });
    expect(text(res)).toBe('No log lines found matching "traceback".');
  });

  it('action:"health" forwards the two health options under their service names', async () => {
    mocks.runHealthCheck.mockResolvedValueOnce("all good");
    const res = await call({
      action: "health",
      model_categories: ["checkpoints"],
      recent_errors: 5,
    });
    expect(mocks.runHealthCheck).toHaveBeenCalledWith({
      modelCategories: ["checkpoints"],
      recentErrors: 5,
    });
    expect(text(res)).toBe("all good");
  });

  it('action:"clear_vram" POSTs /free with both flags defaulted to true', async () => {
    mocks.fetchApi.mockResolvedValueOnce({ ok: true });
    mocks.getSystemStats.mockRejectedValueOnce(new Error("no stats"));
    const res = await call({ action: "clear_vram" });
    expect(mocks.fetchApi).toHaveBeenCalledWith("/free", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ unload_models: true, free_memory: true }),
    });
    expect(text(res)).toBe("VRAM cleared successfully (models unloaded, memory freed).");
  });

  it('action:"clear_vram" honours an explicit false for either flag', async () => {
    mocks.fetchApi.mockResolvedValueOnce({ ok: true });
    mocks.getSystemStats.mockRejectedValueOnce(new Error("no stats"));
    const res = await call({ action: "clear_vram", free_memory: false });
    expect(mocks.fetchApi).toHaveBeenCalledWith(
      "/free",
      expect.objectContaining({
        body: JSON.stringify({ unload_models: true, free_memory: false }),
      }),
    );
    expect(text(res)).toBe("VRAM cleared successfully (models unloaded).");
  });

  it('action:"clear_vram" reports a non-OK /free WITHOUT isError, exactly as before', async () => {
    mocks.fetchApi.mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: "Server Error",
      text: async () => "boom",
    });
    const res = await call({ action: "clear_vram" });
    expect(res.isError).toBeUndefined();
    expect(text(res)).toBe("Failed to free VRAM: 500 Server Error\nboom");
  });

  it('action:"calculate" evaluates the spec and returns both content blocks', async () => {
    mocks.evaluateBatch.mockReturnValueOnce({
      results: [2],
      variables: {},
      errors: [],
      seed: 7,
    });
    const res = await call({ action: "calculate", spec: "1 + 1", seed: 7 });
    expect(mocks.evaluateBatch).toHaveBeenCalledWith(["1 + 1"], undefined, 7);
    expect(res.content).toHaveLength(2);
    expect(res.content[0].text).toContain("[1] 1 + 1  =>  2");
    expect(JSON.parse(res.content[1].text)).toEqual({
      results: [2],
      variables: {},
      errors: [],
      seed: 7,
    });
  });

  it('action:"report_issue" forwards title/body/repo and is the ONLY publishing path', async () => {
    // no_file keeps this entirely local: the prefilled-URL branch never contacts
    // the worker, so the test asserts the routing without filing anything.
    const res = await call({
      action: "report_issue",
      title: "t",
      body: "b",
      repo: "artokun/comfyui-mcp",
      no_file: true,
    });
    const json = JSON.parse(text(res));
    expect(json.filed).toBe(false);
    expect(json.url).toContain("github.com/artokun/comfyui-mcp/issues/new");
    // Every other action left the network alone.
    expect(mocks.getSystemInfo).not.toHaveBeenCalled();
    expect(mocks.fetchApi).not.toHaveBeenCalled();
    expect(mocks.runHealthCheck).not.toHaveBeenCalled();
  });
});

describe("per-action presence guards (the flat shape cannot schema-require these)", () => {
  it('action:"report_issue" without a title names the field AND says it publishes', async () => {
    const res = await call({ action: "report_issue", body: "b" });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("`title`");
    expect(text(res)).toMatch(/FILES a public GitHub issue/i);
  });

  it('action:"report_issue" without a body names the field', async () => {
    const res = await call({ action: "report_issue", title: "t" });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("`body`");
  });

  it('action:"calculate" without a spec names the field and evaluates nothing', async () => {
    const res = await call({ action: "calculate" });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("`spec`");
    expect(mocks.evaluateBatch).not.toHaveBeenCalled();
  });

  // ABSENCE, not falsiness. `title`/`body` keep their .min(1), so an empty string
  // fails the VALUE constraint at the zod layer exactly as it did before — not by
  // being swallowed by the handler guard.
  it("an empty title/body is rejected by the value constraint, not by the guard", () => {
    const [{ shape }] = registered();
    expect(z.object(shape).safeParse({ action: "report_issue", title: "", body: "b" }).success).toBe(
      false,
    );
    expect(z.object(shape).safeParse({ action: "report_issue", title: "t", body: "" }).success).toBe(
      false,
    );
  });

  // `spec` has no .min(1) — an empty string was always legal at the schema layer
  // and reached the evaluator, which answers with its own "empty after splitting"
  // error. A `!spec` guard would swallow that and substitute generic text.
  it("an explicitly empty spec still reaches the evaluator's own error", async () => {
    const res = await call({ action: "calculate", spec: "" });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/empty after splitting/);
    expect(mocks.evaluateBatch).not.toHaveBeenCalled();
  });

  // Same rule for a numeric zero: `seed: 0` is a real, reproducible seed and must
  // reach the evaluator rather than be read as "no seed".
  it("seed:0 reaches the evaluator as 0, not as undefined", async () => {
    mocks.evaluateBatch.mockReturnValueOnce({ results: [1], variables: {}, errors: [], seed: 0 });
    await call({ action: "calculate", spec: "1", seed: 0 });
    expect(mocks.evaluateBatch).toHaveBeenCalledWith(["1"], undefined, 0);
  });

  // ...and an explicit max_lines of the schema minimum must not be mistaken for
  // "unset" and replaced by the 100 default.
  it("max_lines:1 tails to one line rather than falling back to the default", async () => {
    mocks.getLogs.mockResolvedValueOnce(["a", "b", "c"]);
    const res = await call({ action: "logs", max_lines: 1 });
    expect(text(res)).toBe("c");
  });
});

describe("the six stats/diagnostics names are retired", () => {
  const old = ["get_logs", "health_check", "clear_vram", "report_issue", "calculate"];

  it("each old name is in DEAD_NAMES with a `get_system_stats` replacement", () => {
    for (const name of old) {
      const entry = DEAD_NAMES.find((d) => d.name === name);
      expect(entry, `${name} must be declared dead`).toBeDefined();
      expect(entry!.since).toBe("0.50.0");
      expect(entry!.replacement).toContain("get_system_stats");
    }
  });

  it("no old name is still in the live ledger, and `get_system_stats` is", () => {
    for (const name of old) expect(TOOL_NAMES as readonly string[]).not.toContain(name);
    expect(TOOL_NAMES as readonly string[]).toContain("get_system_stats");
  });
});
