import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// Issue reporting. For OUR repos (comfyui-mcp / comfyui-mcp-panel) this now
// *files* the issue through the async intake Worker — submit → get a job_id →
// poll /status/<job_id> for the created issue link. For third-party repos, or
// when the Worker is unreachable, it falls back to a PREFILLED GitHub "new
// issue" URL the user can review and submit in one click (no auth, no network).

const DEFAULT_REPO = "artokun/comfyui-mcp";

// Repos the intake Worker is allowed to file into (owner is fixed server-side).
const OUR_OWNER = "artokun";
const OUR_REPO_NAMES = new Set(["comfyui-mcp", "comfyui-mcp-panel"]);

// Defaults mirror the report-bug SKILL. Both are overridable via env; the client
// key is a soft anti-spam gate (not a real secret — the GitHub token is
// server-side in the Worker).
const DEFAULT_WORKER_URL = "https://comfyui-mcp-issue-worker.artokun.workers.dev";
const DEFAULT_CLIENT_KEY = "9b6f2abf09b64006dc6e033f59d2dc8112e34d8347a923c2";

export function normalizeRepo(input: string | undefined): string {
  const repo = (input || DEFAULT_REPO)
    .trim()
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/\.git$/i, "")
    .replace(/^\/+|\/+$/g, "");
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    throw new Error(`invalid repo "${repo}" — expected owner/name`);
  }
  return repo;
}

export function buildIssueUrl(repo: string, title: string, body: string, labels?: string[]): string {
  const params = new URLSearchParams({ title, body });
  if (labels?.length) params.set("labels", labels.join(","));
  return `https://github.com/${repo}/issues/new?${params.toString()}`;
}

export function isOurRepo(repo: string): boolean {
  const [owner, name] = repo.split("/");
  return owner === OUR_OWNER && OUR_REPO_NAMES.has(name);
}

export interface WorkerFileResult {
  status: "done" | "queued" | "error";
  url?: string;
  number?: number;
  deduped?: boolean;
  job_id?: string;
  error?: string;
}

// Submit to the async intake Worker and poll /status/<job_id> a few times for
// the created issue link. Injectable fetch/sleep for testing. Throws on network
// failure or non-OK submit so the caller can fall back to a prefilled URL.
export async function submitAndPoll(opts: {
  workerUrl: string;
  clientKey: string;
  repoName: string;
  title: string;
  body: string;
  labels?: string[];
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxPolls?: number;
  pollDelayMs?: number;
  timeoutMs?: number;
}): Promise<WorkerFileResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const maxPolls = opts.maxPolls ?? 5;
  const pollDelayMs = opts.pollDelayMs ?? 1000;
  const timeoutMs = opts.timeoutMs ?? 8000;

  // Keep the abort active through BOTH the fetch AND the body parse — otherwise
  // a hung `.json()` after headers arrive would never time out. The whole
  // request+parse runs under one AbortController + a hard timeout.
  const withTimeout = async <T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      return await fn(ac.signal);
    } finally {
      clearTimeout(t);
    }
  };

  const submit = await withTimeout(async (signal): Promise<WorkerFileResult> => {
    const r = await doFetch(opts.workerUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Client-Key": opts.clientKey },
      body: JSON.stringify({ repo: opts.repoName, title: opts.title, body: opts.body, labels: opts.labels }),
      signal,
    });
    if (!r.ok) throw new Error(`worker submit failed: HTTP ${r.status}`);
    return (await r.json()) as WorkerFileResult;
  });

  // Common path: the Worker files synchronously and returns the link inline.
  if (submit.url) return { ...submit, status: submit.status ?? "done" };
  const jobId = submit.job_id;
  if (!jobId) {
    // No job to poll and no url — accepted but no link available.
    return { ...submit, status: submit.status ?? "queued" };
  }

  // Fallback poll (only if the submit somehow lacked a url): /status/<job_id>
  // until done or we run out of tries.
  const base = opts.workerUrl.replace(/\/+$/, "");
  let last: WorkerFileResult = { status: "queued", job_id: jobId };
  for (let i = 0; i < maxPolls; i++) {
    await sleep(pollDelayMs);
    try {
      const parsed = await withTimeout(async (signal): Promise<WorkerFileResult | null> => {
        const r = await doFetch(`${base}/status/${jobId}`, { signal });
        if (!r.ok) return null; // e.g. 404 unknown while KV catches up — keep trying
        return (await r.json()) as WorkerFileResult;
      });
      if (!parsed) continue;
      last = { ...parsed, job_id: jobId };
      if (last.status === "done" || last.status === "error") break;
    } catch {
      continue; // transient — keep trying
    }
  }
  return last;
}

export function registerReportIssueTools(server: McpServer): void {
  server.tool(
    "report_issue",
    "File or link a GitHub issue for a bug/problem you hit (ComfyUI, a workflow, a model, custom nodes, or comfyui-mcp itself). For OUR repos (artokun/comfyui-mcp, artokun/comfyui-mcp-panel) it FILES the issue via the intake Worker and returns the created issue link (no end-user GitHub auth needed); if the Worker is unreachable it falls back to a prefilled GitHub 'new issue' URL. For third-party repos it returns a prefilled URL to SHARE with the user (it does not auto-file). Pass repo='owner/name' for third-party projects. The filing is autonomous — surface the resulting link to the user only if they want it.",
    {
      title: z.string().min(1).describe("Short, specific issue title."),
      body: z
        .string()
        .min(1)
        .describe(
          "Issue body: what happened, steps to reproduce, the exact error text, and environment (GPU/VRAM, ComfyUI version, OS) if known. Scrub secrets first.",
        ),
      repo: z
        .string()
        .optional()
        .describe("owner/repo (default 'artokun/comfyui-mcp'; use 'artokun/comfyui-mcp-panel' for the sidebar panel)."),
      labels: z.array(z.string()).optional().describe("Optional GitHub label names to prefill."),
      no_file: z
        .boolean()
        .optional()
        .describe("Force the prefilled-URL path even for our repos (skip the Worker). Rarely needed."),
    },
    async (args) => {
      try {
        const repo = normalizeRepo(args.repo);
        const prefilledUrl = buildIssueUrl(repo, args.title, args.body, args.labels);

        // Third-party (or explicitly disabled): prefilled link only, as before.
        if (!isOurRepo(repo) || args.no_file) {
          return jsonResult({
            url: prefilledUrl,
            repo,
            filed: false,
            note: "Prefilled issue link (not auto-filed). Share it with the user to review and submit.",
          });
        }

        // Our repo: file via the async intake Worker, poll for the link.
        const workerUrl = process.env.COMFYUI_MCP_ISSUE_WORKER_URL || DEFAULT_WORKER_URL;
        const clientKey = process.env.COMFYUI_MCP_ISSUE_CLIENT_KEY || DEFAULT_CLIENT_KEY;
        const repoName = repo.split("/")[1];
        try {
          const result = await submitAndPoll({
            workerUrl,
            clientKey,
            repoName,
            title: args.title,
            body: args.body,
            labels: args.labels,
          });
          if (result.status === "done" && result.url) {
            return jsonResult({
              url: result.url,
              number: result.number,
              deduped: result.deduped,
              repo,
              filed: true,
              job_id: result.job_id,
              note: result.deduped
                ? "Filed via intake Worker (matched an existing open issue). Share the link only if the user wants it."
                : "Filed via intake Worker. Share the link only if the user wants it.",
            });
          }
          if (result.status === "error") {
            // Server-side filing failed — hand back the prefilled link.
            return jsonResult({
              url: prefilledUrl,
              repo,
              filed: false,
              job_id: result.job_id,
              note: `Intake Worker reported an error (${result.error || "unknown"}). Fallback: prefilled issue link for the user to submit.`,
            });
          }
          // Still queued after polling — accepted, link not yet available.
          return jsonResult({
            url: prefilledUrl,
            repo,
            filed: true,
            pending: true,
            job_id: result.job_id,
            note: "Report accepted by the intake Worker; filing is still in progress (poll /status/<job_id> later for the link). Prefilled link included as a fallback.",
          });
        } catch (workerErr) {
          // Worker unreachable / rejected — fall back to the prefilled URL.
          return jsonResult({
            url: prefilledUrl,
            repo,
            filed: false,
            note: `Intake Worker unreachable (${workerErr instanceof Error ? workerErr.message : String(workerErr)}). Fallback: prefilled issue link for the user to submit in one click.`,
          });
        }
      } catch (err) {
        return {
          content: [
            { type: "text" as const, text: `Error building issue link: ${err instanceof Error ? err.message : String(err)}` },
          ],
          isError: true,
        };
      }
    },
  );
}

function jsonResult(obj: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }],
  };
}
