import { describe, it, expect, vi, afterEach } from "vitest";
import { normalizeRepo, buildIssueUrl, isOurRepo, submitAndPoll, reportIssueAction } from "./report-issue.js";

const noSleep = async () => {};

function res(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

// 0.50.0 slice 13 folded this tool into get_system_stats (action:"report_issue"),
// so the unit under test is the exported action handler rather than a captured
// server.tool registration. Same function body, same arguments, same result.
async function callTool(args: Record<string, unknown>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out = await reportIssueAction(args as any);
  const text = (out.content[0] as { text: string }).text;
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

describe("submitAndPoll — async triage contract", () => {
  it("sends X-Triage-Async + reporter_versions on submit", async () => {
    let sentHeaders: Record<string, string> = {};
    let sentBody: Record<string, unknown> = {};
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      sentHeaders = init.headers as Record<string, string>;
      sentBody = JSON.parse(init.body as string);
      return res({ state: "CLOSED", payload: { issue: { number: 1, url: "https://gh/1" }, agent_message: "done" }, url: "https://gh/1", number: 1 });
    }) as unknown as typeof fetch;
    await submitAndPoll({
      workerUrl: "https://w",
      clientKey: "k",
      repoName: "comfyui-mcp",
      title: "t",
      body: "b",
      reporterVersions: { mcp: "0.48.10", panel: "0.11.0" },
      fetchImpl,
      sleep: noSleep,
    });
    expect(sentHeaders["X-Triage-Async"]).toBe("1");
    expect(sentHeaders["X-Client-Key"]).toBe("k");
    expect(sentBody.reporter_versions).toEqual({ mcp: "0.48.10", panel: "0.11.0" });
  });

  it("CLOSED payload → kind:closed with the flattened rich result", async () => {
    const fetchImpl = (async () =>
      res({
        state: "CLOSED",
        payload: {
          classification: "duplicate_closed",
          action_taken: "advised_upgrade",
          issue: { number: 505, url: "https://gh/505", state: "closed" },
          fixed_in_version: "0.48.19",
          fix_pr_url: "https://gh/pull/507",
          recommend_upgrade: true,
          agent_message: "upgrade to 0.48.21",
          possible_duplicate: false,
        },
      })) as unknown as typeof fetch;
    const out = await submitAndPoll({ workerUrl: "https://w", clientKey: "k", repoName: "comfyui-mcp", title: "t", body: "b", fetchImpl, sleep: noSleep });
    expect(out.kind).toBe("closed");
    if (out.kind !== "closed") throw new Error("expected closed");
    expect(out.result).toMatchObject({
      url: "https://gh/505",
      number: 505,
      classification: "duplicate_closed",
      action_taken: "advised_upgrade",
      fixed_in_version: "0.48.19",
      fix_pr_url: "https://gh/pull/507",
      recommend_upgrade: true,
      agent_message: "upgrade to 0.48.21",
    });
  });

  it("returns the version-ack from submit on every outcome", async () => {
    const fetchImpl = (async () =>
      res({
        job_id: "ja",
        state: "PENDING",
        status: "PENDING",
        versions: { mcp: { reporter: "0.48.10", latest: "0.48.21", up_to_date: false } },
        up_to_date: false,
        upgrade_hint: "comfyui-mcp is behind (0.48.10 → 0.48.21)",
      })) as unknown as typeof fetch;
    const out = await submitAndPoll({ workerUrl: "https://w", clientKey: "k", repoName: "comfyui-mcp", title: "t", body: "b", fetchImpl, sleep: noSleep, maxPolls: 1, pollDelayMs: 0 });
    expect(out.kind).toBe("pending"); // still PENDING at budget
    expect(out.ack.up_to_date).toBe(false);
    expect(out.ack.upgrade_hint).toContain("behind");
  });

  it("legacy SYNC fixture: { ok, url, number } (no lifecycle field) → closed inline, no poll", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return res({ ok: true, url: "https://gh/3", number: 3 });
    }) as unknown as typeof fetch;
    const out = await submitAndPoll({ workerUrl: "https://w", clientKey: "k", repoName: "comfyui-mcp", title: "t", body: "b", fetchImpl, sleep: noSleep });
    expect(out.kind).toBe("closed");
    if (out.kind !== "closed") throw new Error("expected closed");
    expect(out.result).toMatchObject({ url: "https://gh/3", number: 3 });
    expect(calls).toBe(1); // submit only — never polled
  });

  it("polls /status until CLOSED when the submit is PENDING", async () => {
    const calls: string[] = [];
    let polls = 0;
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      if (url === "https://w") return res({ job_id: "j2", state: "PENDING", status: "PENDING" });
      polls++;
      if (polls < 3) return res({ state: "INVESTIGATING", status: "queued" });
      return res({ state: "CLOSED", payload: { issue: { number: 22, url: "https://gh/22" }, deduped: true, agent_message: "filed" }, url: "https://gh/22", number: 22 });
    }) as unknown as typeof fetch;
    const out = await submitAndPoll({ workerUrl: "https://w", clientKey: "k", repoName: "comfyui-mcp", title: "t", body: "b", fetchImpl, sleep: noSleep, pollDelayMs: 0 });
    expect(out.kind).toBe("closed");
    if (out.kind !== "closed") throw new Error("expected closed");
    expect(out.result).toMatchObject({ url: "https://gh/22", number: 22, deduped: true });
    expect(calls.filter((c) => c.includes("/status/j2")).length).toBe(3);
  });

  it("throws on a non-OK submit so the caller can fall back", async () => {
    const fetchImpl = (async () => res({ error: "unauthorized" }, 401)) as unknown as typeof fetch;
    await expect(
      submitAndPoll({ workerUrl: "https://w", clientKey: "k", repoName: "comfyui-mcp", title: "t", body: "b", fetchImpl, sleep: noSleep }),
    ).rejects.toThrow(/401/);
  });

  it("a 2xx submit whose body STALLS → pending (worker took it) — does NOT throw/prefill", async () => {
    const fetchImpl = (async (_url: string, init: RequestInit) => ({
      ok: true, // 2xx = accepted
      json: () =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    })) as unknown as typeof fetch;
    const out = await submitAndPoll({ workerUrl: "https://w", clientKey: "k", repoName: "comfyui-mcp", title: "t", body: "b", fetchImpl, sleep: noSleep, timeoutMs: 10 });
    expect(out.kind).toBe("pending"); // NOT a throw → the tool won't prefill
  });

  it("a 2xx submit with no job_id and no inline result → pending (accepted, cannot poll, no prefill)", async () => {
    const fetchImpl = (async () => res({ ok: true, versions: {}, up_to_date: true })) as unknown as typeof fetch;
    const out = await submitAndPoll({ workerUrl: "https://w", clientKey: "k", repoName: "comfyui-mcp", title: "t", body: "b", fetchImpl, sleep: noSleep });
    expect(out.kind).toBe("pending");
  });

  it("CLOSED unfiled_needs_manual (agent_message but NO issue) → unfiled (not a false success)", async () => {
    const fetchImpl = (async () =>
      res({ state: "CLOSED", payload: { action_taken: "unfiled_needs_manual", issue: null, agent_message: "filing failed" } })) as unknown as typeof fetch;
    const out = await submitAndPoll({ workerUrl: "https://w", clientKey: "k", repoName: "comfyui-mcp", title: "t", body: "b", fetchImpl, sleep: noSleep });
    expect(out.kind).toBe("unfiled"); // agent_message alone must NOT count as filed
  });

  it("a terminal job ERROR without an issue → kind:unfiled (worker gave up, caller prefills)", async () => {
    const fetchImpl = (async (url: string) => {
      if (url === "https://w") return res({ job_id: "j3", state: "PENDING", status: "PENDING" });
      return res({ status: "error", error: "GitHub API error" });
    }) as unknown as typeof fetch;
    const out = await submitAndPoll({ workerUrl: "https://w", clientKey: "k", repoName: "comfyui-mcp", title: "t", body: "b", fetchImpl, sleep: noSleep, pollDelayMs: 0 });
    expect(out.kind).toBe("unfiled");
  });

  it("still running at the budget → kind:pending (NOT prefill — worker finishes async)", async () => {
    const fetchImpl = (async (url: string) => {
      if (url === "https://w") return res({ job_id: "j4", state: "PENDING", status: "PENDING" });
      return res({ state: "INVESTIGATING", status: "queued" });
    }) as unknown as typeof fetch;
    const out = await submitAndPoll({ workerUrl: "https://w", clientKey: "k", repoName: "comfyui-mcp", title: "t", body: "b", fetchImpl, sleep: noSleep, pollDelayMs: 0, maxPolls: 3 });
    expect(out.kind).toBe("pending");
    if (out.kind !== "pending") throw new Error("expected pending");
    expect(out.job_id).toBe("j4");
  });

  it("a transient POLL transport error does NOT end the job — keeps polling, then pending", async () => {
    let polls = 0;
    const fetchImpl = (async (url: string) => {
      if (url === "https://w") return res({ job_id: "j5", state: "PENDING", status: "PENDING" });
      polls++;
      return res({ error: "boom" }, 503); // every poll a transport error
    }) as unknown as typeof fetch;
    const out = await submitAndPoll({ workerUrl: "https://w", clientKey: "k", repoName: "comfyui-mcp", title: "t", body: "b", fetchImpl, sleep: noSleep, pollDelayMs: 0, maxPolls: 3 });
    expect(out.kind).toBe("pending"); // transient errors did not throw
    expect(polls).toBe(3); // it kept trying
  });

  it("a network failure BEFORE any 2xx (fetch rejects) → throws so the caller prefills", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    await expect(
      submitAndPoll({ workerUrl: "https://w", clientKey: "k", repoName: "comfyui-mcp", title: "t", body: "b", fetchImpl, sleep: noSleep }),
    ).rejects.toThrow(/ECONNREFUSED/);
  });

  it("timeout: a POLL whose .json() stalls is transient → keeps polling → pending", async () => {
    const fetchImpl = (async (url: string, init: RequestInit) => {
      if (url === "https://w") return res({ job_id: "j6", state: "PENDING", status: "PENDING" });
      return {
        ok: true,
        json: () =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      };
    }) as unknown as typeof fetch;
    const out = await submitAndPoll({ workerUrl: "https://w", clientKey: "k", repoName: "comfyui-mcp", title: "t", body: "b", fetchImpl, sleep: noSleep, pollDelayMs: 0, timeoutMs: 10, maxPolls: 2 });
    expect(out.kind).toBe("pending");
  });
});

describe('get_system_stats (action:"report_issue") tool (registered handler)', () => {
  const savedTimeout = process.env.COMFYUI_MCP_ISSUE_TIMEOUT_MS;
  afterEach(() => {
    vi.unstubAllGlobals();
    if (savedTimeout === undefined) delete process.env.COMFYUI_MCP_ISSUE_TIMEOUT_MS;
    else process.env.COMFYUI_MCP_ISSUE_TIMEOUT_MS = savedTimeout;
    delete process.env.COMFYUI_MCP_ISSUE_MAX_POLLS;
    delete process.env.COMFYUI_MCP_ISSUE_POLL_MS;
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

  it("our repo, worker CLOSED (created) → filed:true with the real issue link + agent_message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        res({
          state: "CLOSED",
          payload: { classification: "new", action_taken: "created", issue: { number: 50, url: "https://github.com/artokun/comfyui-mcp/issues/50" }, agent_message: "Filed as #50" },
          url: "https://github.com/artokun/comfyui-mcp/issues/50",
          number: 50,
        }),
      ),
    );
    const { json } = await callTool({ title: "t", body: "b" });
    expect(json).toMatchObject({ filed: true, number: 50, action_taken: "created", agent_message: "Filed as #50" });
    expect(json.url).toBe("https://github.com/artokun/comfyui-mcp/issues/50");
  });

  it("our repo, worker CLOSED (advised_upgrade) → filed:false, surfaces fix PR + version + upgrade advice", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        res({
          state: "CLOSED",
          payload: {
            classification: "duplicate_closed",
            action_taken: "advised_upgrade",
            issue: { number: 505, url: "https://github.com/artokun/comfyui-mcp/issues/505", state: "closed" },
            fixed_in_version: "0.48.19",
            fix_pr_url: "https://github.com/artokun/comfyui-mcp/pull/507",
            recommend_upgrade: true,
            agent_message: "Duplicate of closed #505 — upgrade to 0.48.21 (fixed in 0.48.19 via PR #507).",
          },
        }),
      ),
    );
    const { json } = await callTool({ title: "t", body: "b", mcp_version: "0.48.10" });
    expect(json).toMatchObject({
      filed: false, // advised_upgrade files nothing
      action_taken: "advised_upgrade",
      fixed_in_version: "0.48.19",
      fix_pr_url: "https://github.com/artokun/comfyui-mcp/pull/507",
      recommend_upgrade: true,
    });
    expect(json.agent_message).toContain("upgrade");
  });

  it("passes mcp_version/panel_version through as reporter_versions", async () => {
    let sentBody: Record<string, unknown> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        sentBody = JSON.parse(init.body as string);
        return res({ state: "CLOSED", payload: { action_taken: "created", issue: { number: 9, url: "https://github.com/artokun/comfyui-mcp/issues/9" }, agent_message: "ok" }, url: "https://github.com/artokun/comfyui-mcp/issues/9", number: 9 });
      }),
    );
    await callTool({ title: "t", body: "b", mcp_version: "0.48.10", panel_version: "0.11.3" });
    expect(sentBody.reporter_versions).toEqual({ mcp: "0.48.10", panel: "0.11.3" });
  });

  it("our repo, still triaging at budget → filed:false, pending:true, NO prefill", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (!String(url).includes("/status/")) return res({ job_id: "jq", state: "PENDING", status: "PENDING", up_to_date: false, upgrade_hint: "behind" });
        return res({ state: "INVESTIGATING", status: "queued" });
      }),
    );
    process.env.COMFYUI_MCP_ISSUE_TIMEOUT_MS = "50";
    process.env.COMFYUI_MCP_ISSUE_MAX_POLLS = "2";
    process.env.COMFYUI_MCP_ISSUE_POLL_MS = "0";
    const { json } = await callTool({ title: "t", body: "b" });
    expect(json).toMatchObject({ filed: false, pending: true, job_id: "jq" });
    expect(String(json.url ?? "")).not.toContain("/issues/new"); // did NOT prefill
  });

  it("our repo, worker terminally couldn't file (unfiled) → prefilled fallback", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (!String(url).includes("/status/")) return res({ job_id: "ju", state: "PENDING", status: "PENDING" });
        return res({ status: "error", error: "GitHub API error" });
      }),
    );
    const { json } = await callTool({ title: "t", body: "b" });
    expect(json).toMatchObject({ filed: false });
    expect(json.url).toContain("/issues/new");
  });

  it("our repo, CLOSED unfiled_needs_manual (no issue) → prefilled fallback, not a lost report", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => res({ state: "CLOSED", payload: { action_taken: "unfiled_needs_manual", issue: null, agent_message: "filing failed" } })),
    );
    const { json } = await callTool({ title: "t", body: "b" });
    expect(json).toMatchObject({ filed: false });
    expect(json.url).toContain("/issues/new");
  });

  it("a huge MAX_POLLS env is clamped so a running job still returns pending promptly", async () => {
    let polls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (!String(url).includes("/status/")) return res({ job_id: "jc", state: "PENDING", status: "PENDING" });
        polls++;
        return res({ state: "INVESTIGATING", status: "queued" });
      }),
    );
    process.env.COMFYUI_MCP_ISSUE_MAX_POLLS = "1000000000"; // absurd
    process.env.COMFYUI_MCP_ISSUE_POLL_MS = "0";
    const { json } = await callTool({ title: "t", body: "b" });
    expect(json).toMatchObject({ filed: false, pending: true });
    expect(polls).toBeLessThanOrEqual(200); // clamped, not a billion
  });

  it("mixed-case owner (Artokun/comfyui-mcp) is treated as OURS and hits the worker", async () => {
    const spy = vi.fn(async () =>
      res({ state: "CLOSED", payload: { action_taken: "created", issue: { number: 60, url: "https://github.com/Artokun/comfyui-mcp/issues/60" }, agent_message: "ok" }, url: "https://github.com/Artokun/comfyui-mcp/issues/60", number: 60 }),
    );
    vi.stubGlobal("fetch", spy);
    const { json } = await callTool({ title: "t", body: "b", repo: "Artokun/comfyui-mcp" });
    expect(spy).toHaveBeenCalled();
    expect(json).toMatchObject({ filed: true, number: 60 });
  });

  it("SUBMIT 2xx then body stalls → pending (worker took it), NOT a prefill/double-file", async () => {
    process.env.COMFYUI_MCP_ISSUE_TIMEOUT_MS = "15";
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (_url: string, init: RequestInit) =>
          ({
            ok: true, // 2xx = accepted
            json: () =>
              new Promise((_resolve, reject) => {
                init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
              }),
          }) as unknown as Response,
      ),
    );
    const { json } = await callTool({ title: "t", body: "b" });
    expect(json).toMatchObject({ filed: false, pending: true });
    expect(String(json.url ?? "")).not.toContain("/issues/new"); // did NOT prefill
  });

  it("our repo, worker returns non-OK (500) → falls back to prefilled URL", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res({ error: "boom" }, 500)));
    const { json } = await callTool({ title: "t", body: "b" });
    expect(json).toMatchObject({ filed: false });
    expect(json.url).toContain("https://github.com/artokun/comfyui-mcp/issues/new");
  });

  it("our repo, network failure (fetch rejects) → falls back to prefilled URL", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }));
    const { json } = await callTool({ title: "t", body: "b" });
    expect(json).toMatchObject({ filed: false });
    expect(json.url).toContain("/issues/new");
  });

  it("invalid repo → isError", async () => {
    const { isError } = await callTool({ title: "t", body: "b", repo: "not-a-repo" });
    expect(isError).toBe(true);
  });
});
