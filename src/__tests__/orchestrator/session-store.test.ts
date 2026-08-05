// The P0 guard: the agent's SDK session id must survive the orchestrator PROCESS
// being killed and respawned (a wedge auto-restart), so the agent resumes the SAME
// conversation instead of silently forgetting everything. SessionStore is the
// durable, disk-backed copy that makes that possible — independent of whether the
// panel re-sends `hello.resume`. A fresh SessionStore on the same port simulates a
// brand-new orchestrator process reading what the previous one persisted.
//
// #884 (orchestrator-scoped sessions) reshaped the store:
//  - it lives in ~/.comfyui-mcp/sessions (owner-stated: "persisted via DB on the
//    disk … inside of .comfyui-mcp sessions"), not the OS temp dir — with a
//    one-shot LOCATION migration from the old tmpdir file;
//  - the keys of record are the shared `orchestrator::<backend>` composite keys —
//    with a one-shot KEYING adoption of the newest legacy per-workflow entry per
//    backend, so upgrading users keep their most recent conversation's memory;
//  - the per-workflow `stable` index (and its poison machinery) is gone: the
//    shared key never churns, so there is nothing for it to rescue. A pre-#884
//    v2 file's stable entries are dropped on load.

import { describe, expect, it, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore, workflowIdentityParts } from "../../orchestrator/session-store.js";
import { SHARED_SESSION_SCOPE, sharedAgentKey } from "../../services/session-scope.js";

const PORT = 59187;
const UUID_A = "11111111-1111-4111-8111-111111111111";

// Every test gets its own scratch dir so nothing touches the real home and no
// state leaks between tests. The pre-#884 tmpdir file for this port is removed
// too — a stale one would be silently migrated into the next store.
const dirs: string[] = [];
function scratchDir(): string {
  const d = mkdtempSync(join(tmpdir(), "cmcp-sessions-"));
  dirs.push(d);
  return d;
}
const LEGACY_FILE = join(tmpdir(), `comfyui-mcp-panel-sessions-${PORT}.json`);
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
  try {
    rmSync(LEGACY_FILE);
  } catch {
    /* already gone */
  }
});

const fileFor = (dir: string, port = PORT) => join(dir, `panel-sessions-${port}.json`);

describe("SessionStore", () => {
  it("starts empty when no file exists", () => {
    const dir = scratchDir();
    const store = new SessionStore(PORT, { dir });
    expect(store.get(sharedAgentKey("claude"))).toBeUndefined();
  });

  it("persists a session id across a process restart (the P0 fix)", () => {
    const dir = scratchDir();
    const key = sharedAgentKey("claude");
    new SessionStore(PORT, { dir }).set(key, "sess-1");
    // A brand-new instance (a respawned orchestrator) reads it back from disk.
    expect(new SessionStore(PORT, { dir }).get(key)).toBe("sess-1");
  });

  it("overwrites a session id (e.g. a fork/rewind makes a new one)", () => {
    const dir = scratchDir();
    const key = sharedAgentKey("claude");
    const store = new SessionStore(PORT, { dir });
    store.set(key, "sess-1");
    store.set(key, "sess-2");
    expect(new SessionStore(PORT, { dir }).get(key)).toBe("sess-2");
  });

  it("clear() forgets a key so a NEW chat starts fresh (no resurrected resume)", () => {
    const dir = scratchDir();
    const key = sharedAgentKey("claude");
    const store = new SessionStore(PORT, { dir });
    store.set(key, "sess-1");
    store.clear(key);
    expect(store.get(key)).toBeUndefined();
    expect(new SessionStore(PORT, { dir }).get(key)).toBeUndefined();
  });

  it("survives a corrupt/garbage file by starting empty", () => {
    const dir = scratchDir();
    writeFileSync(fileFor(dir), "{not json");
    const store = new SessionStore(PORT, { dir });
    expect(store.get(sharedAgentKey("claude"))).toBeUndefined();
  });

  it("isolates ids by port (two ComfyUI instances never cross-resume)", () => {
    const dir = scratchDir();
    const key = sharedAgentKey("claude");
    new SessionStore(PORT, { dir }).set(key, "sess-a");
    expect(new SessionStore(PORT + 1, { dir }).get(key)).toBeUndefined();
  });

  it("reads an ANCIENT flat file (Record<string,string>) and keeps resuming", () => {
    const dir = scratchDir();
    writeFileSync(fileFor(dir), JSON.stringify({ "tmp:a::claude": "sess-old" }));
    const store = new SessionStore(PORT, { dir });
    expect(store.get("tmp:a::claude")).toBe("sess-old");
    // …and the format upgrade re-flushed as v2.
    const onDisk = JSON.parse(readFileSync(fileFor(dir), "utf8"));
    expect(onDisk.v).toBe(2);
    expect(onDisk.sessions["tmp:a::claude"].s).toBe("sess-old");
  });

  it("clamps a corrupt FUTURE timestamp AND persists the clamp so it can't be immortal", () => {
    const dir = scratchDir();
    writeFileSync(
      fileFor(dir),
      JSON.stringify({ v: 2, sessions: { "orchestrator::claude": { s: "sess-f", t: 1e15 } } }),
    );
    const store = new SessionStore(PORT, { dir });
    expect(store.get("orchestrator::claude")).toBe("sess-f");
    const onDisk = JSON.parse(readFileSync(fileFor(dir), "utf8"));
    expect(onDisk.sessions["orchestrator::claude"].t).toBeLessThanOrEqual(Date.now());
  });

  it("garbage-collects entries older than the TTL on load (unbounded-growth guard)", () => {
    const dir = scratchDir();
    const stale = Date.now() - SessionStore.GC_TTL_MS - 1000;
    writeFileSync(
      fileFor(dir),
      JSON.stringify({
        v: 2,
        sessions: {
          "tmp:dead::claude": { s: "sess-dead", t: stale },
          "orchestrator::claude": { s: "sess-live", t: Date.now() },
        },
      }),
    );
    const store = new SessionStore(PORT, { dir });
    expect(store.get("tmp:dead::claude")).toBeUndefined();
    expect(store.get("orchestrator::claude")).toBe("sess-live");
    const onDisk = JSON.parse(readFileSync(fileFor(dir), "utf8"));
    expect(onDisk.sessions["tmp:dead::claude"]).toBeUndefined();
  });

  describe("#884 LOCATION migration — tmpdir → ~/.comfyui-mcp/sessions", () => {
    it("imports the pre-#884 tmpdir file when the new location is empty", () => {
      const dir = scratchDir();
      writeFileSync(
        LEGACY_FILE,
        JSON.stringify({ v: 2, sessions: { "wf:a.json::claude": { s: "sess-tmpdir", t: Date.now() } } }),
      );
      const store = new SessionStore(PORT, { dir });
      expect(store.get("wf:a.json::claude")).toBe("sess-tmpdir");
      // …and persisted at the NEW location immediately (reboot-safe even if the
      // OS reclaims the temp file next boot).
      expect(existsSync(fileFor(dir))).toBe(true);
      const onDisk = JSON.parse(readFileSync(fileFor(dir), "utf8"));
      expect(onDisk.sessions["wf:a.json::claude"].s).toBe("sess-tmpdir");
    });

    it("the new location, once present, WINS over the tmpdir file", () => {
      const dir = scratchDir();
      writeFileSync(
        LEGACY_FILE,
        JSON.stringify({ v: 2, sessions: { "orchestrator::claude": { s: "sess-old", t: Date.now() } } }),
      );
      writeFileSync(
        fileFor(dir),
        JSON.stringify({ v: 2, sessions: { "orchestrator::claude": { s: "sess-new", t: Date.now() } } }),
      );
      expect(new SessionStore(PORT, { dir }).get("orchestrator::claude")).toBe("sess-new");
    });

    it("a pre-#884 v2 file's `stable` index is dropped on load (obsolete under the shared key)", () => {
      const dir = scratchDir();
      writeFileSync(
        fileFor(dir),
        JSON.stringify({
          v: 2,
          sessions: { "wf:a.json::claude": { s: "sess-a", t: Date.now() } },
          stable: { "wfid::http://x::u::claude": { s: "sess-stable", t: Date.now() } },
        }),
      );
      const store = new SessionStore(PORT, { dir });
      expect(store.get("wf:a.json::claude")).toBe("sess-a");
      const onDisk = JSON.parse(readFileSync(fileFor(dir), "utf8"));
      expect(onDisk.stable).toBeUndefined();
    });
  });

  describe("#884 KEYING adoption — newest legacy per-workflow entry seeds the shared conversation", () => {
    it("adopts the MOST RECENTLY USED legacy entry for the backend and persists it", () => {
      const dir = scratchDir();
      const now = Date.now();
      writeFileSync(
        fileFor(dir),
        JSON.stringify({
          v: 2,
          sessions: {
            "wf:old.json::claude": { s: "sess-older", t: now - 60_000 },
            "wf:new.json::claude": { s: "sess-newest", t: now - 1_000 },
            "wf:new.json::codex": { s: "sess-codex", t: now - 500 },
          },
        }),
      );
      const store = new SessionStore(PORT, { dir });
      expect(store.get(sharedAgentKey("claude"))).toBe("sess-newest"); // newest claude entry wins
      expect(store.get(sharedAgentKey("codex"))).toBe("sess-codex"); // per-backend adoption
      // Adoption persisted: a respawn resumes the SAME shared conversation.
      expect(new SessionStore(PORT, { dir }).get(sharedAgentKey("claude"))).toBe("sess-newest");
    });

    it("an existing shared entry always wins (adoption is a one-shot fallback)", () => {
      const dir = scratchDir();
      const store = new SessionStore(PORT, { dir });
      store.set("wf:a.json::claude", "sess-legacy");
      store.set(sharedAgentKey("claude"), "sess-shared");
      expect(store.get(sharedAgentKey("claude"))).toBe("sess-shared");
    });

    it("never adopts test/spike keys, other backends, or the shared scope itself", () => {
      const dir = scratchDir();
      const store = new SessionStore(PORT, { dir });
      store.set("e2e-run::claude", "sess-e2e");
      store.set("spike-x::claude", "sess-spike");
      store.set("wf:a.json::codex", "sess-other-backend");
      expect(store.get(sharedAgentKey("claude"))).toBeUndefined();
    });

    it("a NON-shared key never adopts (legacy keys stay reachable only as themselves)", () => {
      const dir = scratchDir();
      const store = new SessionStore(PORT, { dir });
      store.set("wf:a.json::claude", "sess-a");
      expect(store.get("wf:b.json::claude")).toBeUndefined();
    });

    it("adoption CONSUMES the legacy entries, so a NEW chat can never resurrect them", () => {
      // clear() is the deliberate New-chat boundary. If get() re-adopted a legacy
      // entry right back, "New chat" would silently resurrect the conversation
      // the user just reset — adoption must therefore consume its sources.
      const dir = scratchDir();
      const store = new SessionStore(PORT, { dir });
      store.set("wf:a.json::claude", "sess-first");
      store.set("wf:b.json::claude", "sess-second");
      const adopted = store.get(sharedAgentKey("claude"));
      expect(["sess-first", "sess-second"]).toContain(adopted); // adopted one of them…
      store.clear(sharedAgentKey("claude")); // …then the user starts a NEW chat
      // BOTH legacy entries were consumed by the adoption, so nothing resurrects —
      // not even the one that lost the newest-wins pick.
      expect(store.get(sharedAgentKey("claude"))).toBeUndefined(); // stays new
      // …durably: a respawned orchestrator can't re-adopt either.
      expect(new SessionStore(PORT, { dir }).get(sharedAgentKey("claude"))).toBeUndefined();
    });
  });

  describe("workflowIdentityParts (kept: the per-command workflow STAMP, a routing fence)", () => {
    it("validates the uuid shape and requires a trusted origin", () => {
      expect(
        workflowIdentityParts({ workflowUuid: UUID_A, origin: "http://127.0.0.1:8188" }),
      ).toEqual({ origin: "http://127.0.0.1:8188", uuid: UUID_A });
      expect(workflowIdentityParts({ workflowUuid: "not-a-uuid", origin: "http://x" })).toBeUndefined();
      expect(workflowIdentityParts({ workflowUuid: UUID_A, origin: "" })).toBeUndefined();
      expect(workflowIdentityParts({ workflowUuid: undefined, origin: "http://x" })).toBeUndefined();
    });

    it("canonicalizes origin case + trailing slashes and lowercases the uuid", () => {
      expect(
        workflowIdentityParts({
          workflowUuid: UUID_A.toUpperCase(),
          origin: "HTTP://Host:8188//",
        }),
      ).toEqual({ origin: "http://host:8188", uuid: UUID_A });
    });
  });
});
