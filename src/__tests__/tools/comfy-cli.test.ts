import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

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

function handlers(): Map<string, Handler> {
  const result = new Map<string, Handler>();
  const server = {
    tool: (...args: unknown[]) => {
      result.set(args[0] as string, args.at(-1) as Handler);
    },
  };
  registerComfyCliTools(server as never);
  return result;
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

describe("comfy-cli MCP command construction", () => {
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
    await handlers().get("comfy_cli_status")!({ detail: "version", workspace: "/ws" });
    expect(mocks.resolve).toHaveBeenCalledWith({ workspace: "/ws" });
    expect(mocks.version).toHaveBeenCalledWith({ workspace: "/ws" });
  });

  it("restarts by stopping then launching in the background with extras", async () => {
    await handlers().get("comfy_cli_server")!({
      action: "restart",
      workspace: "/ws",
      launchArgs: ["--port", "9000"],
    });
    expect(mocks.run.mock.calls.map((call) => call[0])).toEqual([
      ["stop"],
      ["launch", "--background", "--", "--port", "9000"],
    ]);
  });

  it("constructs job wait arguments and routing", async () => {
    await handlers().get("comfy_cli_jobs")!({
      action: "wait",
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
    await handlers().get("comfy_cli_jobs")!({
      action: "wait",
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
    const result = await handlers().get("comfy_cli_jobs")!({ action: "wait", where: "local" });
    expect(result.isError).toBe(true);
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
    const result = await handlers().get("comfy_cli_models")!({
      action: "list-folder",
      folder: "loras",
      where: "local",
    });
    expect(mocks.run).not.toHaveBeenCalled();
    expect(fallbackMocks.fallback).toHaveBeenCalledWith(expect.objectContaining({ action: "list-folder" }));
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed).toMatchObject({ ok: true, source: "local_models" });
  });

  it("constructs workflow validation and execution flags", async () => {
    const handler = handlers().get("comfy_cli_workflow")!;
    await handler({ action: "validate", workflowPath: "wf.json" });
    await handler({ action: "run", workflowPath: "wf.json", wait: true, timeoutSeconds: 45 });
    expect(mocks.run.mock.calls.map((call) => call[0])).toEqual([
      ["validate", "--workflow", "wf.json"],
      ["run", "--workflow", "wf.json", "--wait", "--timeout", "45"],
    ]);
  });

  it("constructs upload and download commands", async () => {
    const handler = handlers().get("comfy_cli_transfer")!;
    await handler({ action: "upload", files: ["a.png", "b.png"], overwrite: false });
    await handler({ action: "download", promptId: "p1", outDir: "out", urlOnly: true });
    expect(mocks.run.mock.calls.map((call) => call[0])).toEqual([
      ["upload", "a.png", "b.png", "--no-overwrite"],
      ["download", "p1", "--out-dir", "out", "--url-only"],
    ]);
  });

  it("uses plural discovery and singular model mutation commands", async () => {
    const handler = handlers().get("comfy_cli_models")!;
    await handler({ action: "search", text: "flux", type: "checkpoint", limit: 4 });
    await handler({ action: "download", url: "https://example.com/m.safetensors", relativePath: "models/loras" });
    await handler({ action: "remove", modelNames: ["a.safetensors", "b.safetensors"], relativePath: "models/loras" });
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
    const result = await handlers().get("comfy_cli_models")!({ action: "list-folders", where: "local" });
    expect(mocks.run).not.toHaveBeenCalled();
    expect(fallbackMocks.fallback).toHaveBeenCalledWith(expect.objectContaining({ action: "list-folders" }));
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed).toMatchObject({ ok: true, source: "local_models", data: { folders: ["checkpoints", "loras"] } });
  });

  it("does NOT fall back when a workspace is pinned — comfy-cli surfaces its own error", async () => {
    mocks.resolve.mockReturnValue(undefined);
    await handlers().get("comfy_cli_models")!({ action: "list-folders", where: "local", workspace: "/ws" });
    expect(fallbackMocks.fallback).not.toHaveBeenCalled();
    expect(mocks.run).toHaveBeenCalled();
  });

  it("does NOT fall back for mutation actions like download", async () => {
    mocks.resolve.mockReturnValue(undefined);
    await handlers().get("comfy_cli_models")!({ action: "download", url: "https://example.com/m.safetensors" });
    expect(fallbackMocks.fallback).not.toHaveBeenCalled();
    expect(mocks.run).toHaveBeenCalled();
  });

  it("keeps skill installation dry-run unless apply is explicit", async () => {
    const handler = handlers().get("comfy_cli_skills")!;
    await handler({ action: "install", scope: "project", projectDir: "/project", targets: ["agents"], skills: ["comfy"], apply: false });
    await handler({ action: "install", scope: "project", projectDir: "/project", apply: true });
    expect(mocks.run.mock.calls.map((call) => call[0])).toEqual([
      ["skills", "install", "--scope", "project", "--target", "agents", "--skill", "comfy", "--dry-run"],
      ["skills", "install", "--scope", "project"],
    ]);
    expect(mocks.run.mock.calls[0][1]).toEqual(expect.objectContaining({ cwd: "/project" }));
  });

  it("rejects project-scoped skill operations without a project directory", async () => {
    const result = await handlers().get("comfy_cli_skills")!({ action: "install", scope: "project", apply: false });
    expect(result.isError).toBe(true);
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("constructs loaded-node search with offline object info", async () => {
    await handlers().get("comfy_cli_search_nodes")!({ query: "sampler", limit: 5, objectInfoPath: "object_info.json" });
    expect(mocks.run).toHaveBeenCalledWith(
      ["nodes", "search", "sampler", "--limit", "5", "--input", "object_info.json"],
      expect.objectContaining({ timeoutMs: 60_000 }),
    );
  });

  it("returns failed CLI envelopes intact and marks the MCP result as an error", async () => {
    const failed = { ...envelope("validate"), ok: false, data: null, error: { code: "workflow_invalid_json", message: "bad JSON" } };
    mocks.run.mockResolvedValueOnce(failed);
    const result = await handlers().get("comfy_cli_workflow")!({ action: "validate", workflowPath: "bad.json" });
    expect(result.isError).toBe(true);
    expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual(failed);
  });
});
