import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getSystemInfo } from "../services/workflow-executor.js";
import { errorToToolResult } from "../utils/errors.js";
import { getLogsAction } from "./diagnostics.js";
import { healthCheckAction } from "./health-check.js";
import { clearVramAction } from "./memory-management.js";
import { reportIssueAction } from "./report-issue.js";
import { calculateAction } from "./calculate.js";

/**
 * The six stats/diagnostics tools collapsed into one action-parameterized
 * `get_system_stats` tool (0.50.0 surface consolidation, slice 13).
 *
 * SHAPE: a FLAT object with an `action` enum — deliberately NOT a
 * z.discriminatedUnion, which the MCP SDK renders as a schema with ZERO visible
 * parameters, hiding every input from the model.
 *
 * REQUIREDNESS: only `action` can be schema-required — `title`/`body` are
 * required by "report_issue" and meaningless elsewhere, `spec` by "calculate".
 * Every VALUE constraint the old tools had is unchanged at the zod layer
 * (`title`/`body` keep .min(1), `recent_errors` its .int().min(0).max(200),
 * `max_lines` its .int().min(1).max(2000)); the handler enforces per-action
 * PRESENCE and NAMES the missing field. The guards test ABSENCE, never
 * falsiness: `spec:""` reached the evaluator before this consolidation and got
 * its own "spec was empty after splitting" error, and still does.
 *
 * ONE ACTION LEAVES THE MACHINE. Five of these six are local reads or a local
 * VRAM free; action:"report_issue" is not — for our repos it hands the report to
 * the AI triage worker, which can CREATE OR COMMENT ON A PUBLIC GITHUB ISSUE.
 * The tool's name says "get system stats", so the description has to carry that
 * warning where a model will read it, and it does: on the tool line, on the
 * enum, and on the action's own bullet.
 *
 * `unload_models` / `free_memory` keep their `.default(true)`, so they resolve
 * to true on EVERY call regardless of action — harmless, because only
 * action:"clear_vram" reads them, and it is what makes an argument-less
 * clear_vram free both exactly as it did before.
 */
export function registerSystemStatsTools(server: McpServer): void {
  server.tool(
    "get_system_stats",
    "Inspect the connected ComfyUI server and this machine, and run the local diagnostics that go with it. NOTE: five of the six actions are local reads (or a local VRAM free) — action:\"report_issue\" is the exception and can FILE A PUBLIC GITHUB ISSUE. Driven by the `action` parameter:\n" +
      '- action:"stats" — Get system information from the connected ComfyUI server: GPU device(s), total/free VRAM, ComfyUI/Python/PyTorch versions, and OS details. Requires a running ComfyUI server (works against local or remote targets); read-only, takes no parameters. Returns the raw /system_stats JSON. Use to confirm connectivity and check available VRAM before enqueuing large workflows. Errors if the server is unreachable.\n' +
      '- action:"logs" — Get ComfyUI server runtime logs. Useful for debugging execution errors, model loading issues, missing nodes, and Python tracebacks. `max_lines` tails the end (default 100), `keyword` filters case-insensitively.\n' +
      '- action:"health" — Pre-flight diagnostic for the connected ComfyUI: one call that aggregates the signals an agent should check before dispatching a batch. Reports ComfyUI version/Python/PyTorch, GPU name + VRAM free/total, system RAM free, queue depth (running + pending), per-category /models populations (catches empty dropdowns from a misconfigured extra_model_paths.yaml), and recent errors from /internal/logs. Read-only — no mutation. Use this when a job fails for an unexpected reason, before a long batch run, or to confirm a remote ComfyUI is healthy. Originally contributed by github.com/joaolvivas.\n' +
      '- action:"clear_vram" — Free GPU VRAM by unloading cached models from ComfyUI. Use this between generation runs with different model families (e.g. switching from SDXL to Flux) or when running low on VRAM, and reach for it FIRST on an out-of-memory error. Optionally unload only models (`unload_models`) or only memory (`free_memory`); both default to true. Reports the VRAM figures read back afterwards.\n' +
      '- action:"report_issue" — PUBLISHES: this is the one action here that leaves your machine. File or triage a GitHub issue for a bug/problem you hit (ComfyUI, a workflow, a model, custom nodes, or comfyui-mcp/its panel). For OUR repos (artokun/comfyui-mcp, artokun/comfyui-mcp-panel) it sends the report to the AI triage worker, which searches existing OPEN and CLOSED issues, version-matches, and either files a new issue, adds context to an existing one, or — if the problem was already FIXED in a newer version than the user runs — answers with the fixing PR + fixed-in version and a recommendation to upgrade (no new issue). It returns that triage result plus an instant check of whether the user is on the latest versions. Scrub secrets from `title`/`body` first: what you send can become a public issue. TIMING: this call BLOCKS while the triage runs — typically a few minutes — and that wait is normal, not a hang. It always returns eventually (every request is time-capped and the poll budget is bounded); on a failing network the caps make that wait longer, but never indefinite. Do not abort a slow call just to retry it: once the worker has accepted the report it keeps triaging on its own — filing, deduping into an existing issue, advising an upgrade, or (rarely) reporting that it could not file — so a blind retry can double-file. If triage outlasts the polling budget the call still returns, with pending:true (and a job_id when the worker gave one — an accepted submit whose acknowledgement was unreadable returns pending without it). If the worker is unreachable it falls back to a prefilled GitHub \'new issue\' URL. For third-party repos it returns a prefilled URL to SHARE (it does not auto-file). ALWAYS pass mcp_version and panel_version from the known environment (the env line in your context, e.g. \'mcp=… panel=…\') so the worker can tell the user if simply upgrading fixes it — the single most common resolution. Surface the worker\'s agent_message / upgrade advice to the user. `title` and `body` are REQUIRED.\n' +
      '- action:"calculate" — Evaluate a batch of math expressions exactly — no ComfyUI connection needed, so it works even in cloud mode or when ComfyUI is down. A safe, zero-dependency expression evaluator (no eval): numbers only, no strings/arrays/property access. Handy for the arithmetic agents get wrong token-by-token. Each line of `spec` is one expression; `name = expr` assigns a variable that persists into later lines. Lines are separated by newlines or semicolons ONLY — commas are argument separators (e.g. min(a, b)), never expression separators. Operators: + - * / // (floor div) % (modulo) ** (power, right-assoc), comparisons < <= > >= == != (return 1/0), unary minus. Constants: pi, e, tau. Functions: abs round min max pow sqrt floor ceil sin cos tan asin acos atan atan2 sinh cosh tanh exp log log10 log2 hypot radians degrees sign trunc clamp(x,lo,hi), plus seeded RNG rand() random() uniform(a,b) randint(a,b) (inclusive). Pass `seed` for reproducible RNG; it is echoed back when omitted. Example — SDXL-legal resolution from an aspect ratio, snapped to /64: variables={ar: 1.5}, spec="w = floor(sqrt(1024*1024*ar)/64)*64\\nh = floor(sqrt(1024*1024/ar)/64)*64". `spec` is REQUIRED.',
    {
      action: z
        .enum(["stats", "logs", "health", "clear_vram", "report_issue", "calculate"])
        .describe(
          'Which operation to perform. "stats" takes no other parameters; "logs" takes `max_lines`/`keyword`; "health" takes `model_categories`/`recent_errors`; "clear_vram" takes `unload_models`/`free_memory`; "report_issue" requires `title` + `body` and PUBLISHES a GitHub issue for our repos; "calculate" requires `spec`.',
        ),
      max_lines: z
        .number()
        .int()
        .min(1)
        .max(2000)
        .optional()
        .describe(
          'action:"logs" — maximum number of log lines to return from the end (default: 100).',
        ),
      keyword: z
        .string()
        .optional()
        .describe(
          'action:"logs" — filter log lines containing this keyword (case-insensitive). Examples: \'error\', \'warning\', \'VRAM\', a node name.',
        ),
      model_categories: z
        .array(z.string())
        .optional()
        .describe(
          'action:"health" — override the model categories to poll (defaults to checkpoints, diffusion_models, loras, vae, text_encoders, controlnet).',
        ),
      recent_errors: z
        .number()
        .int()
        .min(0)
        .max(200)
        .optional()
        .describe(
          'action:"health" — how many recent error/traceback lines to include from /internal/logs (default 20, max 200).',
        ),
      unload_models: z
        .boolean()
        .optional()
        .default(true)
        .describe('action:"clear_vram" — unload all cached models (default: true).'),
      free_memory: z
        .boolean()
        .optional()
        .default(true)
        .describe('action:"clear_vram" — free cached memory/intermediates (default: true).'),
      title: z
        .string()
        .min(1)
        .optional()
        .describe('action:"report_issue" — REQUIRED. Short, specific issue title.'),
      body: z
        .string()
        .min(1)
        .optional()
        .describe(
          'action:"report_issue" — REQUIRED. Issue body: what happened, steps to reproduce, the exact error text, and environment (GPU/VRAM, ComfyUI version, OS) if known. Scrub secrets first — this can become a public issue.',
        ),
      repo: z
        .string()
        .optional()
        .describe(
          'action:"report_issue" — owner/repo (default \'artokun/comfyui-mcp\'; use \'artokun/comfyui-mcp-panel\' for the sidebar panel).',
        ),
      labels: z
        .array(z.string())
        .optional()
        .describe('action:"report_issue" — optional GitHub label names to prefill.'),
      mcp_version: z
        .string()
        .optional()
        .describe(
          'action:"report_issue" — the running comfyui-mcp version (from the env line in your context). Auto-detected if omitted.',
        ),
      panel_version: z
        .string()
        .optional()
        .describe(
          'action:"report_issue" — the running comfyui-mcp-panel (sidebar) version, from the env line in your context, if known.',
        ),
      no_file: z
        .boolean()
        .optional()
        .describe(
          'action:"report_issue" — force the prefilled-URL path even for our repos (skip the Worker, so NOTHING is filed). Rarely needed.',
        ),
      spec: z
        .union([z.string(), z.array(z.string())])
        .optional()
        .describe(
          'action:"calculate" — REQUIRED. Expressions to evaluate, separated by newlines/semicolons (string) or one per array item. `name = expr` assigns; assignments persist across subsequent lines. NOTE: comma is an argument separator (min(a,b)), NOT an expression separator.',
        ),
      variables: z
        .record(z.string(), z.number())
        .optional()
        .describe(
          'action:"calculate" — initial variable environment, e.g. {"w": 1024, "ar": 1.5}.',
        ),
      seed: z
        .number()
        .int()
        .optional()
        .describe(
          'action:"calculate" — seed for rand()/uniform(a,b)/randint(a,b). Same seed => identical sequence (mulberry32). Omit for a random seed (echoed in the result).',
        ),
    },
    async (args) => {
      try {
        switch (args.action) {
          case "stats":
            return {
              content: [
                { type: "text" as const, text: JSON.stringify(await getSystemInfo(), null, 2) },
              ],
            };
          case "logs":
            return await getLogsAction({
              max_lines: args.max_lines,
              keyword: args.keyword,
            });
          case "health":
            return await healthCheckAction({
              model_categories: args.model_categories,
              recent_errors: args.recent_errors,
            });
          case "clear_vram":
            return await clearVramAction({
              unload_models: args.unload_models,
              free_memory: args.free_memory,
            });
          case "report_issue": {
            // title/body cannot be schema-required in a flat shape, so the
            // handler enforces per-action presence and names the missing field —
            // the same information the old per-tool schema gave a caller.
            //
            // ABSENCE only, never falsiness: an empty `title`/`body` fails the
            // .min(1) value constraint exactly as it did before this
            // consolidation. A `!title` guard would swallow that and substitute
            // generic text.
            if (args.title === undefined) {
              throw new Error(
                'get_system_stats action:"report_issue" requires `title` — a short, specific issue title. This action FILES a public GitHub issue.',
              );
            }
            if (args.body === undefined) {
              throw new Error(
                'get_system_stats action:"report_issue" requires `body` — what happened, steps to reproduce, the exact error text. Scrub secrets first; this action FILES a public GitHub issue.',
              );
            }
            return await reportIssueAction({
              title: args.title,
              body: args.body,
              repo: args.repo,
              labels: args.labels,
              mcp_version: args.mcp_version,
              panel_version: args.panel_version,
              no_file: args.no_file,
            });
          }
          case "calculate":
            if (args.spec === undefined) {
              throw new Error(
                'get_system_stats action:"calculate" requires `spec` — the expressions to evaluate, one per line (or one per array item).',
              );
            }
            return await calculateAction({
              spec: args.spec,
              variables: args.variables,
              seed: args.seed,
            });
          default: {
            // Unreachable given the zod enum, but a clear runtime guard beats a
            // silent undefined if the schema and switch ever drift apart.
            const exhaustive: never = args.action;
            throw new Error(
              `Unknown get_system_stats action "${String(exhaustive)}". Expected one of: stats, logs, health, clear_vram, report_issue, calculate.`,
            );
          }
        }
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}
