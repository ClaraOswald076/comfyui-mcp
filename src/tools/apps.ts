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

/** Registry URLs action:"import" may fetch from. This is a SERVER-side fetch, so
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

/**
 * The five apps_* tools collapsed into one action-parameterized `apps` tool
 * (0.49.0 surface consolidation, slice 2).
 *
 * SHAPE: a FLAT object with an `action` enum — deliberately NOT a
 * z.discriminatedUnion, which the MCP SDK renders as a schema with ZERO visible
 * parameters, hiding every input from the model.
 *
 * REQUIREDNESS: only `action` can be schema-required, since each action needs a
 * different subset (list needs nothing, run_status needs app_id + prompt_id,
 * import needs registry_url + app_id). Every VALUE constraint the old tools had —
 * the uuid format on app_id, the URL format on registry_url, and the prompt_id
 * character class that also blocks route traversal — is UNCHANGED at the zod
 * layer; only presence moved into the handler, which reports the same missing
 * field the schema used to. Each branch performs exactly what the old tool did.
 */
export function registerAppsTools(server: McpServer): void {
  server.tool(
    "apps",
    "Micro-apps on this ComfyUI (panel Apps feature): named workflows packaged for one-click runs. Driven by the `action` parameter:\n" +
      '- action:"list" — List every registered app. Each entry is the app\'s manifest: id, name, description, appMode {inputs, outputs}, deps, hideWorkflow, published. No other parameters. Read-only.\n' +
      '- action:"get" — One app\'s manifest + bundle facts (has_workflow/has_prompt/has_thumbnail) by `app_id`. The manifest\'s appMode.inputs is the app\'s run form: each input has nodeId, widget, label, kind (text|number|combo|toggle|image|model), optional choices and default. Read-only.\n' +
      '- action:"run" — Run one app: patches `values` (keys \'<nodeId>.<widget>\', e.g. {"6.text": "a cat"}) into the app\'s stored prompt snapshot and queues it on ComfyUI. Returns the prompt_id — poll action:"run_status". Only pass values for inputs listed in appMode.inputs; omitted inputs keep their conversion-time defaults.\n' +
      '- action:"run_status" — Check one run by `app_id` + `prompt_id`: status (pending|running|done|unknown) plus the run\'s outputs (image/video file refs under each output node, text outputs). Read-only.\n' +
      '- action:"import" — Install an app from the public registry: fetches the registry bundle (manifest + prompt snapshot [+ workflow unless hidden]) and creates it locally. The registry id becomes the local id, so re-importing reports an id conflict (already installed). Deps (models/custom nodes) are NOT installed — report the manifest\'s deps to the user so they can install them before running.',
    {
      action: z
        .enum(["list", "get", "run", "run_status", "import"])
        .describe(
          'Which apps operation to perform. "list" takes no other parameters; "get"/"run" require `app_id`; "run_status" requires `app_id` + `prompt_id`; "import" requires `registry_url` + `app_id`.',
        ),
      app_id: z
        .string()
        .uuid()
        .optional()
        .describe(
          'The app\'s uuid. REQUIRED for actions "get", "run", "run_status" (from action:"list") and "import" (the REGISTRY app\'s uuid, from the explore list).',
        ),
      values: z
        .record(z.string(), z.any())
        .optional()
        .describe(
          "action:\"run\" — input overrides keyed '<nodeId>.<widget>' (e.g. {\"6.text\": \"a cat\", \"3.seed\": 42}). " +
            "Unknown keys fail loudly (the manifest drifted from the snapshot).",
        ),
      // ComfyUI prompt ids are uuids; constraining the shape also blocks
      // route traversal (a "prompt_id" like ../../system_stats would escape
      // the apps route when interpolated into the URL — codex finding).
      prompt_id: z
        .string()
        .regex(/^[0-9a-zA-Z-]{1,64}$/, "must be a ComfyUI prompt id (alphanumeric/dashes)")
        .optional()
        .describe('action:"run_status" — the prompt_id returned by action:"run". Required for that action.'),
      registry_url: z
        .string()
        .url()
        .optional()
        .describe(
          'action:"import" — registry worker base URL (required for that action). Must be the default public registry or an origin the operator ' +
            "allowlisted via COMFYUI_MCP_REGISTRY_URLS (the fetch is server-side — open URLs would be SSRF).",
        ),
      slug: z.string().optional().describe('action:"import" — the app\'s registry slug (recorded in local metadata).'),
      version: z.number().int().optional().describe('action:"import" — the registry version (recorded in local metadata).'),
    },
    async (args) => {
      try {
        // app_id is required by four of the five actions but cannot be marked
        // required in a flat schema, so presence is enforced here with the same
        // "which field is missing" report the schema used to give.
        const requireAppId = (action: string): string => {
          if (!args.app_id) {
            throw new ComfyUIError(
              `apps action:"${action}" requires \`app_id\` (the app's uuid).`,
              "APPS_MISSING_ARG",
            );
          }
          return args.app_id;
        };

        switch (args.action) {
          case "list":
            return jsonText(await appsFetch(""));

          case "get":
            return jsonText(await appsFetch(`/${requireAppId("get")}`));

          case "run": {
            const appId = requireAppId("run");
            return jsonText(
              await appsFetch(`/${appId}/run`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ values: args.values || {} }),
              }),
            );
          }

          case "run_status": {
            const appId = requireAppId("run_status");
            // In-handler too (not just the zod boundary): any direct caller with a
            // traversal-shaped id must never reach the URL builder.
            if (!args.prompt_id || !/^[0-9a-zA-Z-]{1,64}$/.test(args.prompt_id)) {
              throw new ComfyUIError("invalid prompt_id", "APPS_BAD_PROMPT_ID");
            }
            return jsonText(
              await appsFetch(`/${appId}/runs/${encodeURIComponent(args.prompt_id)}`),
            );
          }

          case "import": {
            const appId = requireAppId("import");
            if (!args.registry_url) {
              throw new ComfyUIError(
                'apps action:"import" requires `registry_url` (the registry worker base URL).',
                "APPS_MISSING_ARG",
              );
            }
            const base = args.registry_url.replace(/\/+$/, "");
            if (!allowedRegistryBases().includes(base)) {
              throw new ComfyUIError(
                `registry_url must be the default registry or an operator-allowlisted origin ` +
                  `(COMFYUI_MCP_REGISTRY_URLS); got ${base}`,
                "APPS_IMPORT_BAD_URL",
              );
            }
            const bundle = (await boundedJson(`${base}/v1/apps/${appId}/bundle`)) as {
              manifest?: Record<string, unknown>;
              prompt?: unknown;
              workflow?: unknown;
            };
            if (!bundle.manifest || !bundle.prompt) {
              throw new ComfyUIError("registry bundle is missing manifest/prompt", "APPS_IMPORT_BAD_BUNDLE");
            }
            const manifest = {
              ...bundle.manifest,
              id: appId,
              source: { type: "registry", workflowUuid: null, registryId: appId },
              published: {
                registryId: appId,
                slug: args.slug || null,
                publishedVersion: args.version || null,
              },
            };
            // Thumbnails live at a separate registry endpoint, not inside the JSON
            // bundle — fetch and forward so the installed app keeps its card art.
            let thumbnail_b64: string | undefined;
            try {
              const thumbRes = await fetch(`${base}/v1/apps/${appId}/thumbnail`, {
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
          }

          default: {
            // Unreachable given the zod enum, but a clear runtime guard beats a
            // silent undefined if the schema and switch ever drift apart.
            const exhaustive: never = args.action;
            throw new Error(
              `Unknown apps action "${String(exhaustive)}". Expected one of: list, get, run, run_status, import.`,
            );
          }
        }
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}
