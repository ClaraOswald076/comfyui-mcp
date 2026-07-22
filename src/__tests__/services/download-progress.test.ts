import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// download-progress.ts captures COMFYUI_MCP_PROGRESS_DIR at import — re-import
// per test with a fresh dir (same resetModules pattern as config tests).
const OLD_ENV = process.env;
let dir: string;
let mod: typeof import("../../services/download-progress.js");

beforeEach(async () => {
  vi.resetModules();
  process.env = { ...OLD_ENV };
  dir = mkdtempSync(join(tmpdir(), "dl-progress-test-"));
  process.env.COMFYUI_MCP_PROGRESS_DIR = dir;
  mod = await import("../../services/download-progress.js");
});

afterEach(() => {
  process.env = OLD_ENV;
  rmSync(dir, { recursive: true, force: true });
});

function pendingFiles(): string[] {
  return readdirSync(dir).filter((f) => f.startsWith(mod.CONTROL_PREFIX));
}

describe("download target stamping (#269)", () => {
  it("stamps the row with the writer's COMFYUI_URL at write time", () => {
    process.env.COMFYUI_URL = "https://podabc-3000.proxy.runpod.net";
    mod.reportDownloadProgress({ id: "a1", name: "m.safetensors", downloaded: 1, total: 2, bytes_per_sec: 1, status: "downloading" }, true);
    const row = JSON.parse(readFileSync(join(dir, readdirSync(dir).find((f) => f.startsWith("a1-"))!), "utf-8"));
    expect(row.target).toBe("https://podabc-3000.proxy.runpod.net");
    expect(row.status).toBe("downloading");
  });
});

describe("readDownloadProgress (target-scoped read, #290)", () => {
  it("reads back a row written under a remote COMFYUI_URL (target-scoped filename)", () => {
    // The writer scopes the filename by target; readDownloadProgress must find it
    // without knowing the target (the old single-file read returned null here).
    process.env.COMFYUI_URL = "https://podabc-3000.proxy.runpod.net";
    mod.reportDownloadProgress({ id: "d1", name: "m.safetensors", downloaded: 42, total: 100, bytes_per_sec: 7, status: "downloading" }, true);
    const p = mod.readDownloadProgress("d1");
    expect(p).not.toBeNull();
    expect(p?.id).toBe("d1");
    expect(p?.downloaded).toBe(42);
  });

  it("returns the most-recently-updated variant when the same id has several targets", () => {
    writeFileSync(join(dir, "d2-local.json"), JSON.stringify({ id: "d2", name: "m", downloaded: 10, total: 100, bytes_per_sec: 1, status: "downloading", updated: 1000 }));
    writeFileSync(join(dir, "d2-pod.json"), JSON.stringify({ id: "d2", name: "m", downloaded: 55, total: 100, bytes_per_sec: 1, status: "downloading", updated: 2000 }));
    expect(mod.readDownloadProgress("d2")?.downloaded).toBe(55);
  });

  it("returns null when nothing has been written for the id", () => {
    expect(mod.readDownloadProgress("nope")).toBeNull();
  });
});

describe("control channel (#269 MCP child → orchestrator)", () => {
  it("round-trips a target request as its own file (url + watchPodId)", () => {
    expect(mod.requestTargetChange({ url: "https://podabc-3000.proxy.runpod.net", watchPodId: "podabc" })).toBeTruthy();
    expect(pendingFiles()).toHaveLength(1);
    const list = mod.listTargetChangeRequests(dir);
    expect(list).toHaveLength(1);
    expect(list[0].req.url).toBe("https://podabc-3000.proxy.runpod.net");
    expect(list[0].req.watchPodId).toBe("podabc");
    expect(typeof list[0].req.updated).toBe("number");
  });

  it("supports watch-only, unwatch, local-resolve, and connectWhenReady requests", () => {
    expect(mod.requestTargetChange({ watchPodId: "podX" })).toBeTruthy();
    expect(mod.requestTargetChange({ local: true, unwatch: true })).toBeTruthy();
    expect(mod.requestTargetChange({ watchPodId: "podC", connectWhenReady: { url: "https://podc-3000.proxy.runpod.net", podId: "podC" } })).toBeTruthy();
    const reqs = mod.listTargetChangeRequests(dir).map((p) => p.req);
    expect(reqs.some((r) => r.watchPodId === "podX" && !r.url)).toBe(true);
    expect(reqs.some((r) => r.local === true && r.unwatch === true)).toBe(true);
    expect(reqs.some((r) => r.connectWhenReady?.podId === "podC")).toBe(true);
  });

  it("consumes exactly the file read — concurrent children can't clobber (codex)", () => {
    expect(mod.requestTargetChange({ url: "http://127.0.0.1:8188" })).toBeTruthy();
    expect(mod.requestTargetChange({ url: "https://podz-3000.proxy.runpod.net" })).toBeTruthy();
    const list = mod.listTargetChangeRequests(dir);
    expect(list).toHaveLength(2);
    mod.consumeTargetChange(list[0].file); // consume ONE
    const rest = mod.listTargetChangeRequests(dir);
    expect(rest).toHaveLength(1); // the other request survives untouched
  });

  it("ignores + reaps requests older than the TTL", () => {
    expect(mod.requestTargetChange({ url: "http://127.0.0.1:8188" })).toBeTruthy();
    const [file] = pendingFiles();
    writeFileSync(join(dir, file), JSON.stringify({ url: "http://127.0.0.1:8188", updated: Date.now() - 61_000 }));
    expect(mod.listTargetChangeRequests(dir)).toHaveLength(0);
    expect(pendingFiles()).toHaveLength(0); // reaped
  });

  it("redacts userinfo from stamped/requested target URLs", () => {
    process.env.COMFYUI_URL = "https://user:secret@podabc-3000.proxy.runpod.net";
    mod.reportDownloadProgress({ id: "r1", name: "m", downloaded: 1, total: 1, bytes_per_sec: 1, status: "downloading" }, true);
    const row = JSON.parse(readFileSync(join(dir, readdirSync(dir).find((f) => f.startsWith("r1-"))!), "utf-8"));
    expect(row.target).not.toContain("secret");
    expect(mod.requestTargetChange({ url: "https://user:secret@podabc-3000.proxy.runpod.net" })).toBeTruthy();
    expect(mod.listTargetChangeRequests(dir)[0].req.url).not.toContain("secret");
  });

  it("is inactive with no progress dir (non-panel mode)", async () => {
    vi.resetModules();
    delete process.env.COMFYUI_MCP_PROGRESS_DIR;
    const bare = await import("../../services/download-progress.js");
    expect(bare.requestTargetChange({ url: "http://127.0.0.1:8188" })).toBeNull();
    expect(bare.listTargetChangeRequests(dir)).toHaveLength(0);
  });
});
