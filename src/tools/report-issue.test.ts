import { describe, it, expect } from "vitest";
import { normalizeRepo, buildIssueUrl, isOurRepo, submitAndPoll } from "./report-issue.js";

const noSleep = async () => {};

function res(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("normalizeRepo / buildIssueUrl / isOurRepo", () => {
  it("normalizes assorted repo inputs", () => {
    expect(normalizeRepo(undefined)).toBe("artokun/comfyui-mcp");
    expect(normalizeRepo("https://github.com/foo/bar.git")).toBe("foo/bar");
    expect(normalizeRepo(" owner/name/ ")).toBe("owner/name");
    expect(() => normalizeRepo("nope")).toThrow();
  });

  it("recognizes our repos only", () => {
    expect(isOurRepo("artokun/comfyui-mcp")).toBe(true);
    expect(isOurRepo("artokun/comfyui-mcp-panel")).toBe(true);
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

  it("surfaces a server-side error status from polling", async () => {
    const fetchImpl = (async (url: string) => {
      if (url === "https://w") return res({ ok: true, job_id: "j3", status: "queued" });
      return res({ status: "error", error: "GitHub API error" });
    }) as unknown as typeof fetch;
    const r = await submitAndPoll({ workerUrl: "https://w", clientKey: "k", repoName: "comfyui-mcp", title: "t", body: "b", fetchImpl, sleep: noSleep, pollDelayMs: 0 });
    expect(r).toMatchObject({ status: "error", error: "GitHub API error", job_id: "j3" });
  });

  it("gives up as queued if polling never resolves", async () => {
    const fetchImpl = (async (url: string) => {
      if (url === "https://w") return res({ ok: true, job_id: "j4", status: "queued" });
      return res({ status: "queued" });
    }) as unknown as typeof fetch;
    const r = await submitAndPoll({ workerUrl: "https://w", clientKey: "k", repoName: "comfyui-mcp", title: "t", body: "b", fetchImpl, sleep: noSleep, pollDelayMs: 0, maxPolls: 3 });
    expect(r.status).toBe("queued");
    expect(r.job_id).toBe("j4");
  });
});
