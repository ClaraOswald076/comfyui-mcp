import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { DEAD_NAMES, TOOL_NAMES } from "../../tools/vocabulary.js";

/**
 * The consolidated `comfy_cli` tool (0.49.0 slice 3): the eight comfy_cli_*
 * tools folded into one action-parameterized tool. Proves the consolidation did
 * not change behaviour — every action builds the identical CLI command the old
 * tool built, with the same arguments — and that the flat-enum shape actually
 * EXPOSES its parameters (the discriminated-union trap renders zero params).
 */

const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  resolve: vi.fn(() => "/bin/comfy"),
  version: vi.fn(() => "1.11.1"),
  usable: vi.fn(() => true),
}));

vi.mock("../../services/comfy-cli.js", () => ({
  runComfyCli: mocks.run,
  resolveComfyCliExecutable: mocks.resolve,
  getComfyCliVersion: mocks.version,
  isComfyCliUsable: mocks.usable,
  assertComfyCliOk: (envelope: { ok: boolean }) => {
    if (!envelope.ok) throw new Error("failed");
    return envelope;
  },
}));

const fallbackMocks = vi.hoisted(() => ({ fallback: vi.fn() }));
vi.mock("../../services/local-models-fallback.js", async () => {
  const actual = await vi.importActual<typeof import("../../services/local-models-fallback.js")>(
    "../../services/local-models-fallback.js",
  );
  return { ...actual, listLocalModelsFallback: fallbackMocks.fallback };
});

import { registerComfyCliTools } from "../../tools/comfy-cli.js";

type Handler = (args: Record<string, any>) => Promise<CallToolResult>;

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
  registerComfyCliTools(server as never);
  return tools;
}

/** The whole comfy-cli surface is now ONE tool (0.49.0 slice 3). */
function handler(): Handler {
  const tools = registered();
  expect(tools).toHaveLength(1);
  expect(tools[0].name).toBe("comfy_cli");
  return tools[0].handler;
}

const envelope = (command = "test") => ({
  schema: "envelope/1",
  type: "envelope",
  ok: true,
  command,
  version: "1.11.1",
  where: "local",
  data: {},
  error: null,
});

describe("comfy_cli registration", () => {
  it("registers exactly one tool named `comfy_cli` (8→1)", () => {
    const tools = registered();
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("comfy_cli");
  });

  // The whole reason for the flat-enum shape rule: a z.discriminatedUnion renders
  // as ZERO parameters, hiding every input from the model.
  it("exposes a visible flat `action` enum with every per-action parameter", () => {
    const [{ shape }] = registered();
    // io: "input" — the conversion options the MCP SDK itself uses
    // (sdk/server/zod-json-schema-compat.js, asserted by docs-schema-parity.test.ts),
    // so this is the schema a client is actually given. Under it, fields with a
    // .default() (detail, apply) are optional, as they were on the old tools.
    const json = z.toJSONSchema(z.object(shape), { reused: "inline", io: "input" }) as {
      properties?: Record<string, { enum?: string[] }>;
      required?: string[];
    };
    expect(Object.keys(json.properties ?? {}).sort()).toEqual([
      "action", "all", "apply", "detail", "files", "folder", "launchArgs", "limit",
      "modelNames", "name", "objectInfoPath", "outDir", "overwrite", "path", "projectDir",
      "promptId", "promptIds", "query", "relativePath", "scope", "skills", "targets",
      "text", "timeoutSeconds", "type", "url", "urlOnly", "wait", "where", "workflowPath",
      "workspace",
    ]);
    expect(json.properties?.action.enum?.sort()).toEqual([
      "jobs_cancel", "jobs_list", "jobs_status", "jobs_wait", "jobs_watch",
      "models_download", "models_list_folder", "models_list_folders", "models_remove",
      "models_search", "models_show", "search_nodes", "server_restart", "server_start",
      "server_stop", "skills_install", "skills_list", "skills_show", "skills_status",
      "skills_uninstall", "skills_validate", "status", "transfer_download",
      "transfer_upload", "workflow_run", "workflow_validate",
    ]);
    // Only `action` can be required — the rest are per-action, enforced in the handler.
    expect(json.required).toEqual(["action"]);
  });

  it("an unknown action returns a clear error result", async () => {
    const res = await handler()({ action: "bogus" });
    expect(res.isError).toBe(true);
    const text = res.content.map((c) => (c as { text: string }).text).join(" ");
    expect(text).toMatch(/unknown comfy_cli action/i);
    expect(text).toMatch(/jobs_wait/);
  });
});

describe("comfy_cli MCP command construction", () => {
  beforeEach(() => {
    mocks.run.mockReset();
    mocks.run.mockResolvedValue(envelope());
    mocks.resolve.mockReset();
    mocks.resolve.mockReturnValue("/bin/comfy");
    mocks.version.mockClear();
    mocks.usable.mockReset();
    mocks.usable.mockReturnValue(true);
    fallbackMocks.fallback.mockReset();
  });

  it("uses the same workspace for status path and version", async () => {
    await handler()({ action: "status", detail: "version", workspace: "/ws" });
    expect(mocks.resolve).toHaveBeenCalledWith({ workspace: "/ws" });
    expect(mocks.version).toHaveBeenCalledWith({ workspace: "/ws" });
  });

  it("restarts by stopping then launching in the background with extras", async () => {
    await handler()({
      action: "server_restart",
      workspace: "/ws",
      launchArgs: ["--port", "9000"],
    });
    expect(mocks.run.mock.calls.map((call) => call[0])).toEqual([
      ["stop"],
      ["launch", "--background", "--", "--port", "9000"],
    ]);
  });

  it("constructs job wait arguments and routing", async () => {
    await handler()({
      action: "jobs_wait",
      promptIds: ["a", "b"],
      timeoutSeconds: 30,
      where: "cloud",
    });
    expect(mocks.run).toHaveBeenCalledWith(
      ["jobs", "wait", "a", "b", "--timeout", "30"],
      expect.objectContaining({ where: "cloud", timeoutMs: 40_000 }),
    );
  });

  it("accepts the documented singular promptId for jobs wait (#360)", async () => {
    await handler()({
      action: "jobs_wait",
      promptId: "p1",
      timeoutSeconds: 20,
      where: "local",
    });
    expect(mocks.run).toHaveBeenCalledWith(
      ["jobs", "wait", "p1", "--timeout", "20"],
      expect.objectContaining({ where: "local" }),
    );
  });

  it("still rejects jobs wait with neither promptId, promptIds, nor all (#360)", async () => {
    const result = await handler()({ action: "jobs_wait", where: "local" });
    expect(result.isError).toBe(true);
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("requires promptId for jobs status/watch/cancel, as before", async () => {
    for (const action of ["jobs_status", "jobs_watch", "jobs_cancel"]) {
      const result = await handler()({ action });
      expect(result.isError).toBe(true);
    }
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("falls back to the live server for models listing when comfy-cli is present but an unsupported version (#487)", async () => {
    // comfy-cli resolves to an executable, but its version is unrecognized/too
    // old — read-only listing must fall back rather than surface unsupported_version.
    mocks.resolve.mockReturnValue("/bin/comfy");
    mocks.usable.mockReturnValue(false);
    fallbackMocks.fallback.mockResolvedValue({
      command: "models list-folder loras",
      data: { folder: "loras", count: 1, files: ["x.safetensors"] },
    });
    const result = await handler()({
      action: "models_list_folder",
      folder: "loras",
      where: "local",
    });
    expect(mocks.run).not.toHaveBeenCalled();
    expect(fallbackMocks.fallback).toHaveBeenCalledWith(expect.objectContaining({ action: "list-folder" }));
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed).toMatchObject({ ok: true, source: "local_models" });
  });

  it("constructs workflow validation and execution flags", async () => {
    const comfyCli = handler();
    await comfyCli({ action: "workflow_validate", workflowPath: "wf.json" });
    await comfyCli({ action: "workflow_run", workflowPath: "wf.json", wait: true, timeoutSeconds: 45 });
    expect(mocks.run.mock.calls.map((call) => call[0])).toEqual([
      ["validate", "--workflow", "wf.json"],
      ["run", "--workflow", "wf.json", "--wait", "--timeout", "45"],
    ]);
  });

  it("constructs upload and download commands", async () => {
    const comfyCli = handler();
    await comfyCli({ action: "transfer_upload", files: ["a.png", "b.png"], overwrite: false });
    await comfyCli({ action: "transfer_download", promptId: "p1", outDir: "out", urlOnly: true });
    expect(mocks.run.mock.calls.map((call) => call[0])).toEqual([
      ["upload", "a.png", "b.png", "--no-overwrite"],
      ["download", "p1", "--out-dir", "out", "--url-only"],
    ]);
  });

  it("uses plural discovery and singular model mutation commands", async () => {
    const comfyCli = handler();
    await comfyCli({ action: "models_search", text: "flux", type: "checkpoint", limit: 4 });
    await comfyCli({ action: "models_download", url: "https://example.com/m.safetensors", relativePath: "models/loras" });
    await comfyCli({ action: "models_remove", modelNames: ["a.safetensors", "b.safetensors"], relativePath: "models/loras" });
    expect(mocks.run.mock.calls.map((call) => call[0])).toEqual([
      ["models", "search", "--text", "flux", "--type", "checkpoint", "--limit", "4"],
      ["model", "download", "--url", "https://example.com/m.safetensors", "--relative-path", "models/loras"],
      ["model", "remove", "--relative-path", "models/loras", "--model-names", "a.safetensors b.safetensors"],
    ]);
  });

  it("falls back to the live server for local listing when comfy-cli is absent (#460)", async () => {
    mocks.resolve.mockReturnValue(undefined); // comfy-cli not on PATH
    mocks.usable.mockReturnValue(false);
    fallbackMocks.fallback.mockResolvedValue({
      command: "models list-folders",
      data: { folders: ["checkpoints", "loras"] },
    });
    const result = await handler()({ action: "models_list_folders", where: "local" });
    expect(mocks.run).not.toHaveBeenCalled();
    expect(fallbackMocks.fallback).toHaveBeenCalledWith(expect.objectContaining({ action: "list-folders" }));
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed).toMatchObject({ ok: true, source: "local_models", data: { folders: ["checkpoints", "loras"] } });
  });

  it("does NOT fall back when a workspace is pinned — comfy-cli surfaces its own error", async () => {
    mocks.resolve.mockReturnValue(undefined);
    await handler()({ action: "models_list_folders", where: "local", workspace: "/ws" });
    expect(fallbackMocks.fallback).not.toHaveBeenCalled();
    expect(mocks.run).toHaveBeenCalled();
  });

  it("does NOT fall back for mutation actions like download", async () => {
    mocks.resolve.mockReturnValue(undefined);
    await handler()({ action: "models_download", url: "https://example.com/m.safetensors" });
    expect(fallbackMocks.fallback).not.toHaveBeenCalled();
    expect(mocks.run).toHaveBeenCalled();
  });

  it("keeps skill installation dry-run unless apply is explicit", async () => {
    const comfyCli = handler();
    await comfyCli({ action: "skills_install", scope: "project", projectDir: "/project", targets: ["agents"], skills: ["comfy"], apply: false });
    await comfyCli({ action: "skills_install", scope: "project", projectDir: "/project", apply: true });
    expect(mocks.run.mock.calls.map((call) => call[0])).toEqual([
      ["skills", "install", "--scope", "project", "--target", "agents", "--skill", "comfy", "--dry-run"],
      ["skills", "install", "--scope", "project"],
    ]);
    expect(mocks.run.mock.calls[0][1]).toEqual(expect.objectContaining({ cwd: "/project" }));
  });

  it("rejects project-scoped skill operations without a project directory", async () => {
    const result = await handler()({ action: "skills_install", scope: "project", apply: false });
    expect(result.isError).toBe(true);
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("constructs loaded-node search with offline object info", async () => {
    await handler()({ action: "search_nodes", query: "sampler", limit: 5, objectInfoPath: "object_info.json" });
    expect(mocks.run).toHaveBeenCalledWith(
      ["nodes", "search", "sampler", "--limit", "5", "--input", "object_info.json"],
      expect.objectContaining({ timeoutMs: 60_000 }),
    );
  });

  it("returns failed CLI envelopes intact and marks the MCP result as an error", async () => {
    const failed = { ...envelope("validate"), ok: false, data: null, error: { code: "workflow_invalid_json", message: "bad JSON" } };
    mocks.run.mockResolvedValueOnce(failed);
    const result = await handler()({ action: "workflow_validate", workflowPath: "bad.json" });
    expect(result.isError).toBe(true);
    expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual(failed);
  });

  // query and workflowPath were schema-required before this consolidation, so
  // the flat shape moves their PRESENCE check into the handler — which must name
  // the missing field, and must call nothing.
  it('action:"search_nodes" without a query is a clear error, and calls nothing', async () => {
    const result = await handler()({ action: "search_nodes" });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(/requires `query`/);
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it('action:"workflow_validate" without a workflowPath is a clear error, and calls nothing', async () => {
    const result = await handler()({ action: "workflow_validate" });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(/requires `workflowPath`/);
    expect(mocks.run).not.toHaveBeenCalled();
  });
});

describe("the eight comfy_cli_* names are retired", () => {
  const old = [
    "comfy_cli_status",
    "comfy_cli_server",
    "comfy_cli_jobs",
    "comfy_cli_search_nodes",
    "comfy_cli_workflow",
    "comfy_cli_transfer",
    "comfy_cli_models",
    "comfy_cli_skills",
  ];

  it("each old name is in DEAD_NAMES with replacement `comfy_cli`", () => {
    for (const name of old) {
      const entry = DEAD_NAMES.find((d) => d.name === name);
      expect(entry, `${name} must be declared dead`).toBeDefined();
      expect(entry!.since).toBe("0.49.0");
      expect(entry!.replacement).toContain("comfy_cli");
    }
  });

  it("no old name is still in the live ledger, and `comfy_cli` is", () => {
    for (const name of old) expect(TOOL_NAMES as readonly string[]).not.toContain(name);
    expect(TOOL_NAMES as readonly string[]).toContain("comfy_cli");
  });
});
