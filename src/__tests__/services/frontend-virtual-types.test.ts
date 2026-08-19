// #1400 — the frontend-virtual-types channel: orchestrator → spawned MCP child.
//
// `check_runtime` runs in the spawned stdio child, which has no bridge; the
// frontend's virtual-node registry (what the panel proved via
// `graph_get_virtual_types`) reaches it through this file channel in the shared
// progress dir. The transport discipline (change-only writes, heartbeat,
// pid-liveness + freshness, bounded read, atomic rename) is the sibling
// panel-origin-channel's, deliberately — half of it is reused as code, and the
// tests below pin the half that is this channel's own: the payload shape, the
// origin matching, and the fail-closed reads.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FRONTEND_VIRTUAL_TYPES_FILE,
  FRONTEND_VIRTUAL_TYPES_HEARTBEAT_MS,
  FRONTEND_VIRTUAL_TYPES_MAX_AGE_MS,
  frontendVirtualTypesFor,
  publishFrontendVirtualTypes,
  resetPublishedFrontendVirtualTypes,
} from "../../services/frontend-virtual-types.js";
import { CONTROL_PREFIX, listTargetChangeRequests } from "../../services/download-progress.js";

const ORIGIN = "http://127.0.0.1:8188";
const VIRTUALS = ["Label (rgthree)", "Fast Groups Bypasser (rgthree)", "Fast Groups Muter (rgthree)"];

let dir = "";
const savedEnv = process.env.COMFYUI_MCP_PROGRESS_DIR;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "comfyui-mcp-virtuals-"));
  // The CHILD's view of the channel: the orchestrator hands it this dir in the
  // spawn env (COMFYUI_MCP_PROGRESS_DIR).
  process.env.COMFYUI_MCP_PROGRESS_DIR = dir;
  resetPublishedFrontendVirtualTypes();
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env.COMFYUI_MCP_PROGRESS_DIR;
  else process.env.COMFYUI_MCP_PROGRESS_DIR = savedEnv;
  rmSync(dir, { recursive: true, force: true });
  resetPublishedFrontendVirtualTypes();
});

describe("frontend-virtual-types channel", () => {
  it("carries the types the orchestrator published for the asked origin", () => {
    publishFrontendVirtualTypes(dir, [{ origin: ORIGIN, types: VIRTUALS }]);
    expect([...frontendVirtualTypesFor(ORIGIN)].sort()).toEqual([...VIRTUALS].sort());
  });

  it("matches loopback SPELLINGS of the same server (#1175)", () => {
    // The panel's handshake Origin says 127.0.0.1; the child's COMFYUI_URL says
    // localhost. One server — a spelling comparison would silently disable the
    // whole feature in the most common install.
    publishFrontendVirtualTypes(dir, [{ origin: ORIGIN, types: VIRTUALS }]);
    expect(frontendVirtualTypesFor("http://localhost:8188").size).toBe(VIRTUALS.length);
  });

  it("answers NOTHING for an origin nobody proved — a different server is not this one", () => {
    publishFrontendVirtualTypes(dir, [{ origin: ORIGIN, types: VIRTUALS }]);
    expect(frontendVirtualTypesFor("http://192.0.2.10:8188").size).toBe(0);
    expect(frontendVirtualTypesFor("http://127.0.0.1:8288").size).toBe(0);
  });

  it("reads nothing when there is no channel — a plain MCP server", () => {
    delete process.env.COMFYUI_MCP_PROGRESS_DIR;
    expect(frontendVirtualTypesFor(ORIGIN).size).toBe(0);
  });

  it("reads nothing when nothing has been published yet", () => {
    expect(frontendVirtualTypesFor(ORIGIN).size).toBe(0);
  });

  it("reads nothing from a mid-write or corrupt file", () => {
    writeFileSync(join(dir, FRONTEND_VIRTUAL_TYPES_FILE), '{"entries": [{"origin": "http://127.');
    expect(frontendVirtualTypesFor(ORIGIN).size).toBe(0);
  });

  it("drops a disconnected origin's entry — level-triggered, like the sibling channel", () => {
    publishFrontendVirtualTypes(dir, [{ origin: ORIGIN, types: VIRTUALS }]);
    publishFrontendVirtualTypes(dir, []);
    expect(frontendVirtualTypesFor(ORIGIN).size).toBe(0);
  });

  it("filters a junk payload down to plausible type names", () => {
    // The answer ultimately comes from page JS. Non-strings, empties and
    // absurdly long names are not types a healthy panel sent.
    publishFrontendVirtualTypes(dir, [
      { origin: ORIGIN, types: ["GetNode", 42, null, "", "x".repeat(301)] as never },
    ]);
    expect([...frontendVirtualTypesFor(ORIGIN)]).toEqual(["GetNode"]);
  });

  it("ignores entries with a non-string origin", () => {
    writeFileSync(
      join(dir, FRONTEND_VIRTUAL_TYPES_FILE),
      JSON.stringify({
        entries: [{ origin: 42, types: VIRTUALS }, { origin: ORIGIN, types: ["GetNode"] }],
        updated: Date.now(),
        pid: process.pid,
      }),
    );
    expect([...frontendVirtualTypesFor(ORIGIN)]).toEqual(["GetNode"]);
  });

  it("survives an unwritable directory instead of throwing into the poll tick", () => {
    expect(() =>
      publishFrontendVirtualTypes(join(dir, "nope", "\0bad"), [{ origin: ORIGIN, types: VIRTUALS }]),
    ).not.toThrow();
  });
});

// The progress dir is shared with the download tray and the target-change
// control channel. This file must be invisible to both, and the only thing
// making that true is its name.
describe("the channel file cannot be mistaken for a download row or a request", () => {
  it("carries the control prefix pollDownloads filters on", () => {
    expect(FRONTEND_VIRTUAL_TYPES_FILE.startsWith(CONTROL_PREFIX)).toBe(true);
  });

  it("is not read as a pending target-change request", () => {
    publishFrontendVirtualTypes(dir, [{ origin: ORIGIN, types: VIRTUALS }]);
    expect(listTargetChangeRequests(dir)).toEqual([]);
  });
});

// ── Staleness across the publisher's death ───────────────────────────────────
//
// A record that outlives its orchestrator would keep exempting types nobody is
// still observing. The read therefore gates on the publisher being alive AND the
// record being fresh — the sibling channel's discipline, pinned here because
// this channel's failure mode is a classification, not a sentence.

/** A pid that is definitely NOT running (see panel-origin-channel.test.ts). */
function deadPid(): number {
  const done = spawnSync(process.execPath, ["-e", "0"]);
  if (typeof done.pid !== "number") throw new Error("could not obtain a dead pid");
  return done.pid;
}

function writeRecord(record: unknown): void {
  writeFileSync(join(dir, FRONTEND_VIRTUAL_TYPES_FILE), JSON.stringify(record));
}

describe("frontend-virtual-types channel — staleness", () => {
  const entries = [{ origin: ORIGIN, types: VIRTUALS }];

  it("ignores a record whose publisher is gone", () => {
    writeRecord({ entries, updated: Date.now(), pid: deadPid() });
    expect(frontendVirtualTypesFor(ORIGIN).size).toBe(0);
  });

  it("ignores a record with NO pid", () => {
    writeRecord({ entries, updated: Date.now() });
    expect(frontendVirtualTypesFor(ORIGIN).size).toBe(0);
  });

  it("ignores a stale record even when the pid is alive (pid reuse)", () => {
    writeRecord({ entries, updated: Date.now() - FRONTEND_VIRTUAL_TYPES_MAX_AGE_MS - 1, pid: process.pid });
    expect(frontendVirtualTypesFor(ORIGIN).size).toBe(0);
  });

  it("ignores a record stamped in the FUTURE", () => {
    writeRecord({ entries, updated: Date.now() + 60_000, pid: process.pid });
    expect(frontendVirtualTypesFor(ORIGIN).size).toBe(0);
  });

  it("accepts a live, fresh record", () => {
    // The direction that must keep working: a suite that only asserted rejection
    // could pass with the reader hard-wired to empty.
    writeRecord({ entries, updated: Date.now(), pid: process.pid });
    expect(frontendVirtualTypesFor(ORIGIN).size).toBe(VIRTUALS.length);
  });

  it("the heartbeat stays comfortably inside the age limit", () => {
    expect(FRONTEND_VIRTUAL_TYPES_HEARTBEAT_MS * 2).toBeLessThanOrEqual(
      FRONTEND_VIRTUAL_TYPES_MAX_AGE_MS,
    );
  });
});

describe("frontend-virtual-types channel — heartbeat", () => {
  const entries = [{ origin: ORIGIN, types: VIRTUALS }];

  it("does NOT rewrite an unchanged map on every tick", () => {
    const now = Date.now();
    publishFrontendVirtualTypes(dir, entries, now);
    const first = readFileSync(join(dir, FRONTEND_VIRTUAL_TYPES_FILE), "utf-8");
    publishFrontendVirtualTypes(dir, entries, now + 700);
    publishFrontendVirtualTypes(dir, entries, now + 1_400);
    expect(readFileSync(join(dir, FRONTEND_VIRTUAL_TYPES_FILE), "utf-8")).toBe(first);
  });

  it("DOES refresh an unchanged map once the heartbeat is due", () => {
    const now = Date.now();
    publishFrontendVirtualTypes(dir, entries, now);
    const first = JSON.parse(readFileSync(join(dir, FRONTEND_VIRTUAL_TYPES_FILE), "utf-8"));
    publishFrontendVirtualTypes(dir, entries, now + FRONTEND_VIRTUAL_TYPES_HEARTBEAT_MS);
    const second = JSON.parse(readFileSync(join(dir, FRONTEND_VIRTUAL_TYPES_FILE), "utf-8"));
    expect(second.updated).toBeGreaterThan(first.updated);
    expect(second.entries).toEqual(first.entries);
  });

  it("does not rewrite when only the ORDER or duplication changed", () => {
    const now = Date.now();
    publishFrontendVirtualTypes(dir, entries, now);
    const first = readFileSync(join(dir, FRONTEND_VIRTUAL_TYPES_FILE), "utf-8");
    publishFrontendVirtualTypes(
      dir,
      [{ origin: ORIGIN, types: [...VIRTUALS].reverse().concat(VIRTUALS[0]) }],
      now + 700,
    );
    expect(readFileSync(join(dir, FRONTEND_VIRTUAL_TYPES_FILE), "utf-8")).toBe(first);
  });
});

// The pull and the publish run inside the orchestrator's own startup closures,
// which no test can construct. What CAN be pinned is that both sit where the
// panel lifecycle drives them — the hello handler and the 700ms tick — the
// property a future edit is most likely to break (mirrors the #1415 wiring
// assertions in child-panel-origin-drift.test.ts).
describe("#1400 WIRING: the orchestrator pulls on hello and publishes on the poll tick", () => {
  const HERE = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(HERE, "../../orchestrator/index.ts"), "utf8");

  it("pulls the tab's virtual registry on hello, keyed by the handshake origin", () => {
    const hello = src.indexOf('bridge.onPanelMessage = (event) => {');
    expect(hello).toBeGreaterThan(-1);
    const body = src.slice(hello, hello + 20_000);
    expect(body).toMatch(/pullFrontendVirtualTypes\(/);
    // tabServerOrigin is the SERVER-OBSERVED handshake origin; tabOrigin is the
    // spoofable hello claim. The pull must key on the former (the #756 trust
    // model) — a tab annotates only the server it provably fronts.
    expect(src).toMatch(/bridge\.tabServerOrigin\(tabId\)/);
  });

  it("publishes inside pollDownloads, scoped to origins a tab still fronts", () => {
    const open = src.indexOf("const pollDownloads = () => {");
    const close = src.indexOf("const downloadTimer = setInterval(pollDownloads, 700);");
    expect(open).toBeGreaterThan(-1);
    expect(close).toBeGreaterThan(open);
    const body = src.slice(open, close);
    expect(body).toMatch(/publishFrontendVirtualTypes\(\s*progressDir,/);
    expect(body).toMatch(/connectedServerOrigins\(\)/);
    // …and nowhere else, so this test is asking about the only call site.
    expect(src.split("publishFrontendVirtualTypes(").length - 1).toBe(1);
  });
});
