import { describe, it, expect, vi, afterEach } from "vitest";
import { normalizeRepo, buildIssueUrl, isOurRepo, submitAndPoll, registerReportIssueTools } from "./report-issue.js";

const noSleep = async () => {};

function res(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

// Capture the registered report_issue handler by faking the McpServer.tool API.
type ToolHandler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>;
function getReportIssueHandler(): ToolHandler {
  let handler: ToolHandler | undefined;
  const fakeServer = {
    tool: (_name: string, _desc: string, _schema: unknown, h: ToolHandler) => {
      handler = h;
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerReportIssueTools(fakeServer as any);
  if (!handler) throw new Error("report_issue handler not registered");
  return handler;
}
async function callTool(args: Record<string, unknown>) {
  const out = await getReportIssueHandler()(args);
  const text = out.content[0].text;
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text);
  } catch {
    // error paths return a plain-text message, not JSON
  }
  return { isError: out.isError, text, json };
}

describe("normalizeRepo / buildIssueUrl / isOurRepo", () => {
  it("normalizes assorted repo inputs", () => {
    expect(normalizeRepo(undefined)).toBe("artokun/comfyui-mcp");
    expect(normalizeRepo("https://github.com/foo/bar.git")).toBe("foo/bar");
    expect(normalizeRepo(" owner/name/ ")).toBe("owner/name");
    expect(() => normalizeRepo("nope")).toThrow();
  });

  it("recognizes our repos only, case-insensitively", () => {
    expect(isOurRepo("artokun/comfyui-mcp")).toBe(true);
    expect(isOurRepo("artokun/comfyui-mcp-panel")).toBe(true);
    // git config / this repo use a capital A — must still be ours.
    expect(isOurRepo("Artokun/comfyui-mcp")).toBe(true);
    expect(isOurRepo("ARTOKUN/ComfyUI-MCP-Panel")).toBe(true);
    expect(isOurRepo("artokun/other")).toBe(false);
    expect(isOurRepo("someone/comfyui-mcp")).toBe(false);
  });

  it("builds a prefilled new-issue URL with labels", () => {
    const u = new URL(buildIssueUrl("a/b", "T", "B", ["x", "y"]));
    expect(u.pathname).toBe("/a/b/issues/new");
    expect(u.searchParams.get("title")).toBe("T");
    expect(u.searchParams.get("labels")).toBe("x,y");
  });
});

describe("submitAndPoll", () => {
  it("returns the issue link inline when the fast path already filed", async () => {
    const fetchImpl = (async () => res({ ok: true, job_id: "j1", status: "done", url: "https://gh/10", number: 10 })) as unknown as typeof fetch;
    const r = await submitAndPoll({ workerUrl: "https://w", clientKey: "k", repoName: "comfyui-mcp", title: "t", body: "b", fetchImpl, sleep: noSleep });
    expect(r).toMatchObject({ status: "done", url: "https://gh/10", number: 10 });
  });

  it("OLD-SYNC fixture: { ok, url, number } with NO job_id/status returns immediately (no poll)", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return res({ ok: true, url: "https://gh/3", number: 3 });
    }) as unknown as typeof fetch;
    const r = await submitAndPoll({ workerUrl: "https://w", clientKey: "k", repoName: "comfyui-mcp", title: "t", body: "b", fetchImpl, sleep: noSleep });
    expect(r).toMatchObject({ status: "done", url: "https://gh/3", number: 3 });
    expect(calls).toBe(1); // submit only — never polled
  });

  it("polls /status until done when the submit is queued", async () => {
    const calls: string[] = [];
    let polls = 0;
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      if (url === "https://w") return res({ ok: true, job_id: "j2", status: "queued" });
      // /status/j2 — queued twice, then done
      polls++;
      if (polls < 3) return res({ status: "queued" });
      return res({ status: "done", url: "https://gh/22", number: 22, deduped: true });
    }) as unknown as typeof fetch;
    const r = await submitAndPoll({ workerUrl: "https://w", clientKey: "k", repoName: "comfyui-mcp", title: "t", body: "b", fetchImpl, sleep: noSleep, pollDelayMs: 0 });
    expect(r).toMatchObject({ status: "done", url: "https://gh/22", number: 22, deduped: true, job_id: "j2" });
    expect(calls.filter((c) => c.includes("/status/j2")).length).toBe(3);
  });

  it("throws on a non-OK submit so the caller can fall back", async () => {
    const fetchImpl = (async () => res({ error: "unauthorized" }, 401)) as unknown as typeof fetch;
    await expect(
      submitAndPoll({ workerUrl: "https://w", clientKey: "k", repoName: "comfyui-mcp", title: "t", body: "b", fetchImpl, sleep: noSleep }),
    ).rejects.toThrow(/401/);
  });

  it("THROWS on a server-side error status from polling (→ caller falls back)", async () => {
    const fetchImpl = (async (url: string) => {
      if (url === "https://w") return res({ ok: true, job_id: "j3", status: "queued" });
      return res({ status: "error", error: "GitHub API error" });
    }) as unknown as typeof fetch;
    await expect(
      submitAndPoll({ workerUrl: "https://w", clientKey: "k", repoName: "comfyui-mcp", title: "t", body: "b", fetchImpl, sleep: noSleep, pollDelayMs: 0 }),
    ).rejects.toThrow(/errored/);
  });

  it("THROWS when polling never resolves (exhausts retries) instead of claiming queued success", async () => {
    const fetchImpl = (async (url: string) => {
      if (url === "https://w") return res({ ok: true, job_id: "j4", status: "queued" });
      return res({ status: "queued" });
    }) as unknown as typeof fetch;
    await expect(
      submitAndPoll({ workerUrl: "https://w", clientKey: "k", repoName: "comfyui-mcp", title: "t", body: "b", fetchImpl, sleep: noSleep, pollDelayMs: 0, maxPolls: 3 }),
    ).rejects.toThrow(/did not complete/);
  });

  it("THROWS on a poll transport failure (HTTP error) → caller falls back", async () => {
    const fetchImpl = (async (url: string) => {
      if (url === "https://w") return res({ ok: true, job_id: "j5", status: "queued" });
      return res({ error: "boom" }, 503);
    }) as unknown as typeof fetch;
    await expect(
      submitAndPoll({ workerUrl: "https://w", clientKey: "k", repoName: "comfyui-mcp", title: "t", body: "b", fetchImpl, sleep: noSleep, pollDelayMs: 0 }),
    ).rejects.toThrow(/poll failed/);
  });

  it("timeout: a SUBMIT whose .json() stalls until the AbortController fires → throws", async () => {
    const fetchImpl = (async (_url: string, init: RequestInit) => ({
      ok: true,
      json: () =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    })) as unknown as typeof fetch;
    await expect(
      submitAndPoll({ workerUrl: "https://w", clientKey: "k", repoName: "comfyui-mcp", title: "t", body: "b", fetchImpl, sleep: noSleep, timeoutMs: 10 }),
    ).rejects.toThrow();
  });

  it("timeout: a POLL whose .json() stalls until the AbortController fires → throws", async () => {
    const fetchImpl = (async (url: string, init: RequestInit) => {
      if (url === "https://w") return res({ ok: true, job_id: "j6", status: "queued" });
      return {
        ok: true,
        json: () =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      };
    }) as unknown as typeof fetch;
    await expect(
      submitAndPoll({ workerUrl: "https://w", clientKey: "k", repoName: "comfyui-mcp", title: "t", body: "b", fetchImpl, sleep: noSleep, pollDelayMs: 0, timeoutMs: 10 }),
    ).rejects.toThrow();
  });
});

describe("report_issue tool (registered handler)", () => {
  const savedTimeout = process.env.COMFYUI_MCP_ISSUE_TIMEOUT_MS;
  afterEach(() => {
    vi.unstubAllGlobals();
    if (savedTimeout === undefined) delete process.env.COMFYUI_MCP_ISSUE_TIMEOUT_MS;
    else process.env.COMFYUI_MCP_ISSUE_TIMEOUT_MS = savedTimeout;
  });

  it("third-party repo → prefilled URL, filed:false, no network", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    const { json } = await callTool({ title: "t", body: "b", repo: "someone/their-node" });
    expect(json).toMatchObject({ filed: false, repo: "someone/their-node" });
    expect(json.url).toContain("https://github.com/someone/their-node/issues/new");
    expect(spy).not.toHaveBeenCalled();
  });

  it("no_file:true on our repo → prefilled URL, no network", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    const { json } = await callTool({ title: "t", body: "b", repo: "artokun/comfyui-mcp", no_file: true });
    expect(json).toMatchObject({ filed: false });
    expect(json.url).toContain("https://github.com/artokun/comfyui-mcp/issues/new");
    expect(spy).not.toHaveBeenCalled();
  });

  it("our repo, Worker files → returns the real issue link, filed:true", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => res({ ok: true, url: "https://github.com/artokun/comfyui-mcp/issues/50", number: 50, job_id: "jx" })),
    );
    const { json } = await callTool({ title: "t", body: "b" }); // default our repo
    expect(json).toMatchObject({ filed: true, number: 50 });
    expect(json.url).toBe("https://github.com/artokun/comfyui-mcp/issues/50");
  });

  it("mixed-case owner (Artokun/comfyui-mcp) is treated as OURS and files via the Worker", async () => {
    const spy = vi.fn(async () => res({ ok: true, url: "https://github.com/Artokun/comfyui-mcp/issues/60", number: 60, job_id: "jm" }));
    vi.stubGlobal("fetch", spy);
    const { json } = await callTool({ title: "t", body: "b", repo: "Artokun/comfyui-mcp" });
    expect(spy).toHaveBeenCalled(); // hit the Worker, not the prefilled path
    expect(json).toMatchObject({ filed: true, number: 60 });
  });

  it("timeout regression (SUBMIT .json() stalls) → prefilled fallback", async () => {
    process.env.COMFYUI_MCP_ISSUE_TIMEOUT_MS = "15";
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (_url: string, init: RequestInit) =>
          ({
            ok: true,
            json: () =>
              new Promise((_resolve, reject) => {
                init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
              }),
          }) as unknown as Response,
      ),
    );
    const { json } = await callTool({ title: "t", body: "b" });
    expect(json).toMatchObject({ filed: false });
    expect(json.url).toContain("/issues/new");
  });

  it("timeout regression (POLL .json() stalls) → prefilled fallback", async () => {
    process.env.COMFYUI_MCP_ISSUE_TIMEOUT_MS = "15";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        if (!String(url).includes("/status/")) return res({ ok: true, job_id: "jp2", status: "queued" });
        return {
          ok: true,
          json: () =>
            new Promise((_resolve, reject) => {
              init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
            }),
        } as unknown as Response;
      }),
    );
    const { json } = await callTool({ title: "t", body: "b" });
    expect(json).toMatchObject({ filed: false });
    expect(json.url).toContain("/issues/new");
  });

  it("our repo, Worker returns non-OK (500) → falls back to prefilled URL (generic, not just 401)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res({ error: "boom" }, 500)));
    const { json } = await callTool({ title: "t", body: "b" });
    expect(json).toMatchObject({ filed: false });
    expect(json.url).toContain("https://github.com/artokun/comfyui-mcp/issues/new");
  });

  it("our repo, Worker returns 401 → falls back to prefilled URL", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res({ error: "unauthorized" }, 401)));
    const { json } = await callTool({ title: "t", body: "b" });
    expect(json).toMatchObject({ filed: false });
    expect(json.url).toContain("/issues/new");
  });

  it("our repo, network failure (fetch rejects) → falls back to prefilled URL", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }));
    const { json } = await callTool({ title: "t", body: "b" });
    expect(json).toMatchObject({ filed: false });
    expect(json.url).toContain("/issues/new");
  });

  it("our repo, submit ok but polling errors → surfaces prefilled fallback (filed:false)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).endsWith("/status/" + "jp")) return res({ status: "error", error: "GitHub API error" });
        // submit: queued with a job_id but no url → forces a poll
        return res({ ok: true, job_id: "jp", status: "queued" });
      }),
    );
    const { json } = await callTool({ title: "t", body: "b" });
    expect(json).toMatchObject({ filed: false });
    expect(json.url).toContain("/issues/new");
  });

  it("invalid repo → isError", async () => {
    const { isError } = await callTool({ title: "t", body: "b", repo: "not-a-repo" });
    expect(isError).toBe(true);
  });
});
