import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  getComfyCliVersion,
  resolveComfyCliExecutable,
  runComfyCli,
} from "../services/comfy-cli.js";
import { searchLiveObjectInfo } from "../services/object-info-search.js";
import {
  isLocalModelsListAction,
  listLocalModelsFallback,
} from "../services/local-models-fallback.js";
import { errorToToolResult } from "../utils/errors.js";

const whereSchema = z.enum(["local", "cloud"]).optional();
const workspaceSchema = z.string().optional().describe("Optional ComfyUI workspace override. Otherwise COMFYUI_PATH/auto-detection is used.");

function textEnvelope(envelope: unknown) {
  const failed = typeof envelope === "object" && envelope !== null && "ok" in envelope && envelope.ok === false;
  return {
    ...(failed ? { isError: true } : {}),
    content: [{ type: "text" as const, text: JSON.stringify(envelope, null, 2) }],
  };
}

async function call(args: string[], options: { workspace?: string; where?: "local" | "cloud"; timeoutMs?: number; idleTimeoutMs?: number; cwd?: string }) {
  return textEnvelope(await runComfyCli(args, options));
}

export function registerComfyCliTools(server: McpServer): void {
  server.tool(
    "comfy_cli_status",
    "Inspect the official comfy-cli integration and selected ComfyUI environment. Uses `comfy which` or `comfy env` with the envelope/1 JSON contract. Call this before local CLI operations when workspace or server routing is uncertain.",
    {
      detail: z.enum(["version", "which", "env", "discover"]).optional().default("env"),
      workspace: workspaceSchema,
    },
    async (args) => {
      try {
        if (args.detail === "version") {
          return textEnvelope({ executable: resolveComfyCliExecutable({ workspace: args.workspace }), version: getComfyCliVersion({ workspace: args.workspace }) });
        }
        return await call([args.detail], { workspace: args.workspace, timeoutMs: 30_000 });
      } catch (error) {
        return errorToToolResult(error);
      }
    },
  );

  server.tool(
    "comfy_cli_server",
    "Start, stop, or restart a local ComfyUI through official comfy-cli background process management. Restart performs `comfy stop` followed by `comfy launch --background`. Use comfy_cli_status(detail='env') to inspect the managed server.",
    {
      action: z.enum(["start", "stop", "restart"]),
      workspace: workspaceSchema,
      launchArgs: z.array(z.string()).optional().describe("Extra ComfyUI launch arguments, e.g. ['--listen','0.0.0.0','--port','8188'].")
    },
    async (args) => {
      try {
        const options = { workspace: args.workspace, timeoutMs: 120_000 };
        let stopped: Awaited<ReturnType<typeof runComfyCli>> | undefined;
        if (args.action !== "start") stopped = await runComfyCli(["stop"], options);
        if (args.action === "stop") return textEnvelope(stopped);
        if (stopped && !stopped.ok) return textEnvelope(stopped);
        const launch = ["launch", "--background"];
        if (args.launchArgs?.length) launch.push("--", ...args.launchArgs);
        const started = await runComfyCli(launch, options);
        return textEnvelope(args.action === "restart" ? { stopped, started } : started);
      } catch (error) {
        return errorToToolResult(error);
      }
    },
  );

  server.tool(
    "comfy_cli_jobs",
    "List, inspect, wait for, watch, or cancel local or Comfy Cloud jobs through official comfy-cli. Local jobs include CLI-tracked async submissions plus the ComfyUI queue/history.",
    {
      action: z.enum(["list", "status", "wait", "watch", "cancel"]),
      promptId: z.string().optional(),
      promptIds: z.array(z.string()).optional(),
      all: z.boolean().optional(),
      limit: z.number().int().min(1).max(100).optional(),
      timeoutSeconds: z.number().int().min(1).optional(),
      where: whereSchema,
      workspace: workspaceSchema,
    },
    async (args) => {
      try {
        const subcommand = args.action === "list" ? "ls" : args.action;
        const command = ["jobs", subcommand];
        if (["status", "watch", "cancel"].includes(args.action)) {
          if (!args.promptId) throw new Error(`promptId is required for jobs ${args.action}`);
          command.push(args.promptId);
        } else if (args.action === "wait") {
          if (args.all) command.push("--all");
          else if (args.promptIds?.length) command.push(...args.promptIds);
          else throw new Error("promptIds or all=true is required for jobs wait");
        }
        if (args.limit && args.action === "list") command.push("--limit", String(args.limit));
        if (args.timeoutSeconds && ["wait", "watch"].includes(args.action)) command.push("--timeout", String(args.timeoutSeconds));
        return await call(command, { workspace: args.workspace, where: args.where, timeoutMs: ((args.timeoutSeconds ?? 120) + 10) * 1000 });
      } catch (error) {
        return errorToToolResult(error);
      }
    },
  );

  server.tool(
    "comfy_cli_search_nodes",
    "Fuzzy-search actual ComfyUI node classes by name, display name, or description using official `comfy nodes search`. This complements search_custom_nodes, which searches installable node packs. Works locally, in Comfy Cloud, or offline with object_info JSON. When comfy-cli is not installed/on PATH and the target is the connected (local) server, it falls back to fuzzy-searching that server's live /object_info — so installed-node discovery works without the CLI.",
    {
      query: z.string().min(1),
      limit: z.number().int().min(1).max(100).optional(),
      objectInfoPath: z.string().optional(),
      where: whereSchema,
      workspace: workspaceSchema,
    },
    async (args) => {
      try {
        // Live /object_info fallback (#354): when comfy-cli is absent and we are
        // searching the connected local server (not Comfy Cloud, and not an
        // explicit offline object_info file), query the running ComfyUI's
        // /object_info directly instead of failing on the missing CLI.
        // Honor an explicit `workspace`: /object_info comes from the CONNECTED
        // server, which may be a DIFFERENT install than the one requested — so
        // when a workspace is pinned we do NOT substitute it silently. Instead we
        // fall through and let comfy-cli surface its clear not-found error for
        // that workspace (install comfy-cli there, or drop `workspace` to search
        // the connected server).
        if (
          args.where !== "cloud" &&
          !args.objectInfoPath &&
          !args.workspace &&
          !resolveComfyCliExecutable({ workspace: args.workspace })
        ) {
          const results = await searchLiveObjectInfo(args.query, args.limit ?? 20);
          return textEnvelope({
            schema: "envelope/1",
            type: "envelope",
            ok: true,
            command: `nodes search ${args.query}`,
            version: "object_info-fallback",
            where: "local",
            source: "live_object_info",
            note: "comfy-cli was not found; searched the connected ComfyUI's live /object_info instead.",
            data: { count: results.length, results },
            error: null,
          });
        }
        const command = ["nodes", "search", args.query];
        if (args.limit) command.push("--limit", String(args.limit));
        if (args.objectInfoPath) command.push("--input", args.objectInfoPath);
        return await call(command, { workspace: args.workspace, where: args.where, timeoutMs: 60_000 });
      } catch (error) {
        return errorToToolResult(error);
      }
    },
  );

  server.tool(
    "comfy_cli_workflow",
    "Validate or run an API/UI workflow file using official comfy-cli. Validation checks class types, inputs, enums, and edge wiring without submission. Run submits asynchronously by default; set wait=true to await outputs.",
    {
      action: z.enum(["validate", "run"]),
      workflowPath: z.string().min(1),
      wait: z.boolean().optional(),
      timeoutSeconds: z.number().int().min(1).optional(),
      where: whereSchema,
      workspace: workspaceSchema,
    },
    async (args) => {
      try {
        const command = [args.action, "--workflow", args.workflowPath];
        if (args.action === "run" && args.wait) command.push("--wait");
        if (args.action === "run" && args.timeoutSeconds) command.push("--timeout", String(args.timeoutSeconds));
        return await call(command, { workspace: args.workspace, where: args.where, timeoutMs: ((args.timeoutSeconds ?? 120) + 10) * 1000 });
      } catch (error) {
        return errorToToolResult(error);
      }
    },
  );

  server.tool(
    "comfy_cli_transfer",
    "Upload input files or download completed job outputs using official comfy-cli for local ComfyUI or Comfy Cloud.",
    {
      action: z.enum(["upload", "download"]),
      files: z.array(z.string()).optional(),
      promptId: z.string().optional(),
      outDir: z.string().optional(),
      overwrite: z.boolean().optional(),
      urlOnly: z.boolean().optional(),
      where: whereSchema,
      workspace: workspaceSchema,
    },
    async (args) => {
      try {
        const command: string[] = [args.action];
        if (args.action === "upload") {
          if (!args.files?.length) throw new Error("files is required for upload");
          command.push(...args.files);
          if (args.overwrite === false) command.push("--no-overwrite");
        } else {
          if (!args.promptId) throw new Error("promptId is required for download");
          command.push(args.promptId);
          if (args.outDir) command.push("--out-dir", args.outDir);
          if (args.urlOnly) command.push("--url-only");
        }
        return await call(command, { workspace: args.workspace, where: args.where, timeoutMs: 300_000 });
      } catch (error) {
        return errorToToolResult(error);
      }
    },
  );

  server.tool(
    "comfy_cli_models",
    "Discover model folders/files locally or in Comfy Cloud, download model URLs into a workspace, or remove workspace model files through official comfy-cli. When comfy-cli is not installed/on PATH and the target is the connected (local) server, the read-only listing actions (list-folders, list-folder, search, show) fall back to that server's own local models (via /models) — so model discovery works without the CLI.",
    {
      action: z.enum(["list-folders", "list-folder", "search", "show", "download", "remove"]),
      folder: z.string().optional(),
      text: z.string().optional(),
      type: z.string().optional(),
      name: z.string().optional(),
      url: z.string().url().optional(),
      relativePath: z.string().optional().describe("Workspace-relative model directory (default models/checkpoints)."),
      modelNames: z.array(z.string()).optional().describe("Model filenames to remove."),
      limit: z.number().int().min(1).max(100).optional(),
      where: whereSchema,
      workspace: workspaceSchema,
    },
    async (args) => {
      try {
        // Local models fallback (#460): the read-only listing actions don't
        // need comfy-cli — the connected local ComfyUI already reports its
        // installed models. When comfy-cli is absent and we're targeting the
        // connected server (not Comfy Cloud, no pinned workspace), serve the
        // listing from listLocalModels() instead of failing on the missing CLI.
        // A pinned `workspace` may be a DIFFERENT install than the connected
        // server, so we don't substitute silently — we fall through and let
        // comfy-cli surface its clear not-found error for that workspace.
        // Mirrors the live /object_info fallback for comfy_cli_search_nodes.
        const listAction = isLocalModelsListAction(args.action) ? args.action : undefined;
        if (
          listAction &&
          args.where !== "cloud" &&
          !args.workspace &&
          !resolveComfyCliExecutable({ workspace: args.workspace })
        ) {
          const { command, data } = await listLocalModelsFallback({ ...args, action: listAction });
          return textEnvelope({
            schema: "envelope/1",
            type: "envelope",
            ok: true,
            command,
            version: "local-models-fallback",
            where: "local",
            source: "local_models",
            note: "comfy-cli was not found; listed the connected ComfyUI's local models instead.",
            data,
            error: null,
          });
        }
        const command = [args.action === "download" || args.action === "remove" ? "model" : "models", args.action];
        if (args.action === "list-folder") {
          if (!args.folder) throw new Error("folder is required for list-folder");
          command.push(args.folder);
        }
        if (args.action === "show") {
          if (!args.name) throw new Error("name is required for show");
          command.push(args.name);
        }
        if (args.action === "search") {
          if (args.text) command.push("--text", args.text);
          if (args.type) command.push("--type", args.type);
        }
        if (args.action === "download") {
          if (!args.url) throw new Error("url is required for model download");
          command.push("--url", args.url);
          if (args.relativePath) command.push("--relative-path", args.relativePath);
        }
        if (args.action === "remove") {
          if (!args.modelNames?.length) throw new Error("modelNames is required for model remove");
          if (args.relativePath) command.push("--relative-path", args.relativePath);
          command.push("--model-names", args.modelNames.join(" "));
        }
        if (args.limit && args.action !== "show" && args.action !== "list-folders") command.push("--limit", String(args.limit));
        // A download can legitimately run for many minutes. Gate it on an IDLE
        // (liveness) timeout so a still-progressing download is not killed —
        // downloader progress output resets the clock — while a truly stalled
        // one is still terminated. Other actions keep the fast hard timeout.
        if (args.action === "download") {
          return await call(command, { workspace: args.workspace, where: args.where, idleTimeoutMs: 120_000 });
        }
        return await call(command, { workspace: args.workspace, where: args.where, timeoutMs: 60_000 });
      } catch (error) {
        return errorToToolResult(error);
      }
    },
  );

  server.tool(
    "comfy_cli_skills",
    "List, show, validate, install, inspect, or uninstall the official comfy-cli bundled agent skills (comfy, fragments, debug, relay, director). Install/uninstall defaults to dry-run for safety unless apply=true.",
    {
      action: z.enum(["list", "show", "validate", "install", "status", "uninstall"]),
      name: z.string().optional(),
      path: z.string().optional(),
      scope: z.enum(["user", "project"]).optional(),
      projectDir: z.string().optional().describe("Working directory for project-scoped skill operations. Required when scope='project'."),
      targets: z.array(z.string()).optional(),
      skills: z.array(z.string()).optional(),
      apply: z.boolean().optional().default(false),
      workspace: workspaceSchema,
    },
    async (args) => {
      try {
        const command = ["skills", args.action];
        if (args.scope === "project" && !args.projectDir) {
          throw new Error("projectDir is required when scope='project'");
        }
        if (args.action === "show" && args.name) command.push(args.name);
        if (args.action === "validate") {
          if (!args.path) throw new Error("path is required for skills validate");
          command.push(args.path);
        }
        if (["install", "uninstall", "status"].includes(args.action) && args.scope) command.push("--scope", args.scope);
        if (["install", "uninstall"].includes(args.action)) {
          for (const target of args.targets ?? []) command.push("--target", target);
          for (const skill of args.skills ?? []) command.push("--skill", skill);
          if (!args.apply) command.push("--dry-run");
        }
        return await call(command, { workspace: args.workspace, timeoutMs: 60_000, cwd: args.projectDir });
      } catch (error) {
        return errorToToolResult(error);
      }
    },
  );
}
