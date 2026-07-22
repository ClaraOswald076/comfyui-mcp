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

/** Registry URLs apps_import may fetch from. This is a SERVER-side fetch, so
 *  an open URL is an SSRF primitive (loopback/LAN, or a public URL redirecting
 *  into one) — the tool only talks to the default registry or origins the
 *  operator explicitly allowlists (comma-separated, for dev/staging). */
function allowedRegistryBases(): string[] {
  const extra = (process.env.COMFYUI_MCP_REGISTRY_URLS || "")
    .split(",")
    .map((s) => s.trim().replace(/\/+$/, ""))
    .filter(Boolean);
  return ["https://cmcp-apps-registry.artokun.workers.dev", ...extra];
}

const MAX_BUNDLE_BYTES = 16 * 1024 * 1024;

/** Bounded GET: 30s timeout, 16MB cap on the buffered body (checked on the
 *  declared length AND the actual bytes). */
async function boundedJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    redirect: "error", // no redirect-follow into a second origin
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new ComfyUIError(`registry fetch failed: HTTP ${res.status}`, "APPS_IMPORT_REGISTRY");
  }
  const declared = Number(res.headers.get("content-length") || 0);
  if (declared > MAX_BUNDLE_BYTES) {
    throw new ComfyUIError("registry bundle too large", "APPS_IMPORT_TOO_LARGE");
  }
  const buf = await res.arrayBuffer();
  if (buf.byteLength > MAX_BUNDLE_BYTES) {
    throw new ComfyUIError("registry bundle too large", "APPS_IMPORT_TOO_LARGE");
  }
  return JSON.parse(new TextDecoder().decode(buf));
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
      // ComfyUI prompt ids are uuids; constraining the shape also blocks
      // route traversal (a "prompt_id" like ../../system_stats would escape
      // the apps route when interpolated into the URL — codex finding).
      prompt_id: z
        .string()
        .regex(/^[0-9a-zA-Z-]{1,64}$/, "must be a ComfyUI prompt id (alphanumeric/dashes)")
        .describe("The prompt_id returned by apps_run."),
    },
    async (args) => {
      try {
        // In-handler too (not just the zod boundary): any direct caller with a
        // traversal-shaped id must never reach the URL builder.
        if (!/^[0-9a-zA-Z-]{1,64}$/.test(args.prompt_id)) {
          throw new ComfyUIError("invalid prompt_id", "APPS_BAD_PROMPT_ID");
        }
        return jsonText(await appsFetch(`/${args.app_id}/runs/${encodeURIComponent(args.prompt_id)}`));
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
        .describe(
          "Registry worker base URL. Must be the default public registry or an origin the operator " +
            "allowlisted via COMFYUI_MCP_REGISTRY_URLS (the fetch is server-side — open URLs would be SSRF).",
        ),
      app_id: z.string().uuid().describe("The registry app's uuid (from the explore list)."),
      slug: z.string().optional().describe("The app's registry slug (recorded in local metadata)."),
      version: z.number().int().optional().describe("The registry version (recorded in local metadata)."),
    },
    async (args) => {
      try {
        const base = args.registry_url.replace(/\/+$/, "");
        if (!allowedRegistryBases().includes(base)) {
          throw new ComfyUIError(
            `registry_url must be the default registry or an operator-allowlisted origin ` +
              `(COMFYUI_MCP_REGISTRY_URLS); got ${base}`,
            "APPS_IMPORT_BAD_URL",
          );
        }
        const bundle = (await boundedJson(`${base}/v1/apps/${args.app_id}/bundle`)) as {
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
        // Thumbnails live at a separate registry endpoint, not inside the JSON
        // bundle — fetch and forward so the installed app keeps its card art.
        let thumbnail_b64: string | undefined;
        try {
          const thumbRes = await fetch(`${base}/v1/apps/${args.app_id}/thumbnail`, {
            redirect: "error",
            signal: AbortSignal.timeout(15_000),
          });
          if (thumbRes.ok) {
            const buf = await thumbRes.arrayBuffer();
            if (buf.byteLength <= 5 * 1024 * 1024) {
              thumbnail_b64 = Buffer.from(buf).toString("base64");
            }
          }
        } catch {
          /* no thumbnail — cosmetic only */
        }
        const created = await appsFetch("", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            manifest,
            prompt: bundle.prompt,
            ...(bundle.workflow ? { workflow: bundle.workflow } : {}),
            ...(thumbnail_b64 ? { thumbnail_b64 } : {}),
          }),
        });
        return jsonText({ ok: true, installed: created, deps: (bundle.manifest as { deps?: unknown }).deps || {} });
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}
