import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getComfyUIBaseUrl } from "../config.js";
import { comfyuiFetch } from "../comfyui/fetch.js";
import { errorToToolResult, ComfyUIError } from "../utils/errors.js";

/**
 * Micro-Apps ("Apps") tools — the mobile/direct-call surface for the panel's
 * app bundles. Each tool is a thin proxy over the panel pack's
 * /comfyui_mcp_panel/apps/* HTTP routes (py/apps_routes.py), so there is ONE
 * storage and run implementation (the panel's) for both the desktop panel and
 * canvas-less clients. The orchestrator's call_tool whitelist decides who may
 * reach these; the tools themselves just forward and report.
 *
 * An "app" = a named workflow packaged for one-click runs: a manifest (name,
 * description, appMode {inputs, outputs}, deps, hideWorkflow) + an API-format
 * prompt snapshot that values are patched into per run.
 */

function appsUrl(path: string): string {
  return `${getComfyUIBaseUrl()}/comfyui_mcp_panel/apps${path}`;
}

/** Fetch a panel apps route; translate transport + HTTP failures into a
 *  readable ComfyUIError (a 404 on the COLLECTION route means the panel pack
 *  predates the Apps feature — say so plainly). */
async function appsFetch(path: string, init: RequestInit = {}): Promise<unknown> {
  let res: Response;
  try {
    res = await comfyuiFetch(appsUrl(path), init);
  } catch (err) {
    throw new ComfyUIError(
      `Cannot reach the panel's Apps API at ${appsUrl(path)}: ${err instanceof Error ? err.message : err}. ` +
        "Is ComfyUI running with the comfyui-mcp-panel pack installed?",
      "APPS_API_UNREACHABLE",
    );
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON error page */
  }
  if (!res.ok) {
    const msg =
      body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string"
        ? (body as { error: string }).error
        : `HTTP ${res.status}`;
    const hint =
      res.status === 404 && path === ""
        ? " — the panel pack on this ComfyUI predates the Apps feature; update comfyui-mcp-panel and restart ComfyUI"
        : "";
    throw new ComfyUIError(`Apps API error: ${msg}${hint}`, "APPS_API_ERROR");
  }
  return body;
}

function jsonText(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

export function registerAppsTools(server: McpServer): void {
  server.tool(
    "apps_list",
    "List the micro-apps registered on this ComfyUI (panel Apps feature). Each entry is the app's " +
      "manifest: id, name, description, appMode {inputs, outputs}, deps, hideWorkflow, published. " +
      "Use apps_get for one app's full detail and apps_run to execute one. Read-only.",
    {},
    async () => {
      try {
        return jsonText(await appsFetch(""));
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "apps_get",
    "Get one micro-app's manifest + bundle facts (has_workflow/has_prompt/has_thumbnail) by id. " +
      "The manifest's appMode.inputs is the app's run form: each input has nodeId, widget, label, " +
      "kind (text|number|combo|toggle|image|model), optional choices and default. Read-only.",
    {
      app_id: z.string().uuid().describe("The app's uuid (from apps_list)."),
    },
    async (args) => {
      try {
        return jsonText(await appsFetch(`/${args.app_id}`));
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "apps_run",
    "Run a micro-app once: patches `values` (keys '<nodeId>.<widget>', e.g. {\"6.text\": \"a cat\"}) " +
      "into the app's stored prompt snapshot and queues it on ComfyUI. Returns the prompt_id — poll " +
      "apps_run_status for completion and outputs. Only pass values for inputs listed in the app's " +
      "appMode.inputs; omitted inputs keep their conversion-time defaults.",
    {
      app_id: z.string().uuid().describe("The app's uuid (from apps_list)."),
      values: z
        .record(z.string(), z.any())
        .optional()
        .describe(
          "Input overrides keyed '<nodeId>.<widget>' (e.g. {\"6.text\": \"a cat\", \"3.seed\": 42}). " +
            "Unknown keys fail loudly (the manifest drifted from the snapshot).",
        ),
    },
    async (args) => {
      try {
        return jsonText(
          await appsFetch(`/${args.app_id}/run`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ values: args.values || {} }),
          }),
        );
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "apps_run_status",
    "Check one app run by prompt_id (from apps_run): status (pending|running|done|unknown) plus the " +
      "run's outputs (image/video file refs under each output node, text outputs). Read-only.",
    {
      app_id: z.string().uuid().describe("The app's uuid."),
      prompt_id: z.string().describe("The prompt_id returned by apps_run."),
    },
    async (args) => {
      try {
        return jsonText(await appsFetch(`/${args.app_id}/runs/${args.prompt_id}`));
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "apps_import",
    "Install an app from the public registry onto this ComfyUI: fetches the registry bundle " +
      "(manifest + prompt snapshot [+ workflow unless hidden]) and creates it as a local app via the " +
      "panel's Apps API. The registry id becomes the local id, so re-importing the same app reports " +
      "an id conflict (already installed). Deps (models/custom nodes) are NOT installed — report the " +
      "manifest's deps to the user so they can install them before running.",
    {
      registry_url: z
        .string()
        .url()
        .describe("Registry worker base URL, e.g. https://cmcp-apps-registry.example.workers.dev"),
      app_id: z.string().uuid().describe("The registry app's uuid (from the explore list)."),
      slug: z.string().optional().describe("The app's registry slug (recorded in local metadata)."),
      version: z.number().int().optional().describe("The registry version (recorded in local metadata)."),
    },
    async (args) => {
      try {
        const base = args.registry_url.replace(/\/+$/, "");
        // Only allow http(s) registry URLs — this is a server-side fetch, so no
        // arbitrary-scheme redirects to file:/gopher: etc.
        if (!/^https?:\/\//i.test(base)) {
          throw new ComfyUIError("registry_url must be http(s)", "APPS_IMPORT_BAD_URL");
        }
        const res = await fetch(`${base}/v1/apps/${args.app_id}/bundle`);
        if (!res.ok) {
          throw new ComfyUIError(`registry bundle fetch failed: HTTP ${res.status}`, "APPS_IMPORT_REGISTRY");
        }
        const bundle = (await res.json()) as {
          manifest?: Record<string, unknown>;
          prompt?: unknown;
          workflow?: unknown;
        };
        if (!bundle.manifest || !bundle.prompt) {
          throw new ComfyUIError("registry bundle is missing manifest/prompt", "APPS_IMPORT_BAD_BUNDLE");
        }
        const manifest = {
          ...bundle.manifest,
          id: args.app_id,
          source: { type: "registry", workflowUuid: null, registryId: args.app_id },
          published: {
            registryId: args.app_id,
            slug: args.slug || null,
            publishedVersion: args.version || null,
          },
        };
        const created = await appsFetch("", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            manifest,
            prompt: bundle.prompt,
            ...(bundle.workflow ? { workflow: bundle.workflow } : {}),
          }),
        });
        return jsonText({ ok: true, installed: created, deps: (bundle.manifest as { deps?: unknown }).deps || {} });
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}
