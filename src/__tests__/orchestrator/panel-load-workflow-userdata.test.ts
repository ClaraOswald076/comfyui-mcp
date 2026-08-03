// panel_load_workflow — relative names are resolved by the CONNECTED ComfyUI,
// which is the only authority on its own `--user-directory` (panel #202).
//
// Root cause: comfyWorkflowsDirs() RECONSTRUCTS COMFYUI_PATH/user/default/workflows
// (and user/workflows), so a ComfyUI launched with a CUSTOM --user-directory keeps
// its workflows somewhere the orchestrator cannot guess. A relative name either
// failed outright — even though list_workflows/panel_open_workflow could see it —
// or, worse, matched a same-named file under the reconstructed path and loaded a
// DIFFERENT graph for the agent to edit.
//
// The resolver now asks the server first and, when the server answers, defers to
// that answer completely: it refuses instead of falling back to a reconstructed
// path, and refuses instead of picking between several candidates. Only a server
// that gives NO answer at all (a statusless transport error) re-enables the
// best-effort local read that keeps the default layout working.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Stub ONLY getClient so no real ComfyUI connection is attempted; every other
// client export keeps its real implementation (panel-tools' module graph uses
// several of them at import time).
const fetchApi = vi.fn();
vi.mock("../../comfyui/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../comfyui/client.js")>();
  return {
    ...actual,
    getClient: () => ({ fetchApi: (...a: unknown[]) => fetchApi(...a) }),
  };
});

const { buildPanelToolDefs } = await import("../../orchestrator/panel-tools.js");
import type { PanelToolCtx } from "../../orchestrator/panel-tools.js";

type Forwarded = Record<string, unknown>;
function makeCtx(): { ctx: PanelToolCtx; calls: Forwarded[] } {
  const calls: Forwarded[] = [];
  const ctx = {
    call: async (cmd: Forwarded) => {
      calls.push(cmd);
      return { content: [{ type: "text", text: "ok" }] };
    },
    confirm: async () => "yes" as const,
    bridge: { send: async (cmd: Forwarded) => { calls.push(cmd); return {}; } },
    tabId: "test-tab",
  } as unknown as PanelToolCtx;
  return { ctx, calls };
}

function loadWorkflow() {
  const def = buildPanelToolDefs().find((d) => d.name === "panel_load_workflow");
  if (!def) throw new Error("panel_load_workflow not found");
  return def;
}

let savedComfyPath: string | undefined;
beforeEach(() => {
  fetchApi.mockReset();
  savedComfyPath = process.env.COMFYUI_PATH;
  // No local COMFYUI_PATH → the guessed workflows dirs are empty, so a relative
  // name misses on disk and MUST fall through to the userdata API.
  delete process.env.COMFYUI_PATH;
});
afterEach(() => {
  if (savedComfyPath === undefined) delete process.env.COMFYUI_PATH;
  else process.env.COMFYUI_PATH = savedComfyPath;
});

describe("panel_load_workflow: userdata fallback for a custom --user-directory (#202)", () => {
  it("resolves a relative name via the userdata API and loads it onto the canvas", async () => {
    const graph = { nodes: [{ id: 1, type: "KSampler" }], links: [] };
    fetchApi.mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify(graph) });

    const { ctx, calls } = makeCtx();
    const res = await loadWorkflow().handler(
      { path: "722-gordo-10Eros_10SNodes_I2V_DMD_v1.json" },
      ctx,
    );

    expect(res.isError).toBeUndefined();
    // Fetched from the userdata library under the runtime user-directory.
    expect(fetchApi).toHaveBeenCalledWith(
      `/api/userdata/${encodeURIComponent("workflows/722-gordo-10Eros_10SNodes_I2V_DMD_v1.json")}`,
    );
    // And the fetched graph was dropped on the canvas.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ cmd: "graph_load" });
    expect(calls[0].graph).toMatchObject(graph);
  });

  it("fails LOUDLY (no graph_load) when the userdata library 404s the name", async () => {
    fetchApi.mockResolvedValue({ ok: false, status: 404, json: async () => ({}) });

    const { ctx, calls } = makeCtx();
    const res = await loadWorkflow().handler({ path: "nope-not-here.json" }, ctx);

    expect(res.isError).toBe(true);
    expect(calls).toHaveLength(0);
    const text = JSON.stringify(res);
    expect(text).toMatch(/workflow library/i);
    expect(text).toMatch(/list_workflows/);
  });

  it("surfaces an honest error (no graph_load) when the userdata file is not a UI workflow", async () => {
    // API/prompt format (numeric keys) — not a litegraph UI workflow.
    fetchApi.mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify({ "1": { class_type: "KSampler" } }) });

    const { ctx, calls } = makeCtx();
    const res = await loadWorkflow().handler({ path: "api-format.json" }, ctx);

    expect(res.isError).toBe(true);
    expect(calls).toHaveLength(0);
    expect(JSON.stringify(res)).toMatch(/not a UI workflow/i);
  });

  it("the RUNTIME userdata file wins over a stale same-named file in the guessed default dir", async () => {
    // Collision: COMFYUI_PATH's default workflows dir has a foo.json (graph A),
    // but the connected ComfyUI runs a CUSTOM --user-directory whose foo.json is
    // graph B. The authoritative userdata API must win — never the stale disk
    // file (#202).
    const root = mkdtempSync(join(tmpdir(), "cmcp-userdir-"));
    try {
      const defaultDir = join(root, "user", "default", "workflows");
      mkdirSync(defaultDir, { recursive: true });
      const stale = { nodes: [{ id: 99, type: "StaleDefaultDirNode" }], links: [] };
      writeFileSync(join(defaultDir, "foo.json"), JSON.stringify(stale), "utf8");
      process.env.COMFYUI_PATH = root;

      const runtime = { nodes: [{ id: 1, type: "RuntimeUserDirNode" }], links: [] };
      fetchApi.mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify(runtime) });

      const { ctx, calls } = makeCtx();
      const res = await loadWorkflow().handler({ path: "foo.json" }, ctx);

      expect(res.isError).toBeUndefined();
      expect(fetchApi).toHaveBeenCalled(); // authoritative source was consulted first
      expect(calls).toHaveLength(1);
      expect(calls[0].graph).toMatchObject(runtime); // NOT the stale default-dir file
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does NOT fall back to a colliding local file when the server REFUSES (non-404)", async () => {
    // A reachable server that returns 403/500 must surface honestly — NOT silently
    // load a possibly-stale same-named local file (#202).
    const root = mkdtempSync(join(tmpdir(), "cmcp-userdir-"));
    try {
      const defaultDir = join(root, "user", "default", "workflows");
      mkdirSync(defaultDir, { recursive: true });
      writeFileSync(
        join(defaultDir, "foo.json"),
        JSON.stringify({ nodes: [{ id: 1, type: "StaleNode" }] }),
        "utf8",
      );
      process.env.COMFYUI_PATH = root;

      fetchApi.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });

      const { ctx, calls } = makeCtx();
      const res = await loadWorkflow().handler({ path: "foo.json" }, ctx);

      expect(res.isError).toBe(true);
      expect(calls).toHaveLength(0); // never loaded the stale local file
      expect(JSON.stringify(res)).toMatch(/HTTP 500/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("surfaces malformed userdata JSON as its own error (not mislabeled unreachable)", async () => {
    // A colliding local file exists, but a malformed 2xx must NOT fall back to it.
    const root = mkdtempSync(join(tmpdir(), "cmcp-userdir-"));
    try {
      const defaultDir = join(root, "user", "default", "workflows");
      mkdirSync(defaultDir, { recursive: true });
      writeFileSync(
        join(defaultDir, "foo.json"),
        JSON.stringify({ nodes: [{ id: 1, type: "StaleNode" }] }),
        "utf8",
      );
      process.env.COMFYUI_PATH = root;

      // Non-empty body that isn't JSON → malformed (NOT an empty-body absence).
      fetchApi.mockResolvedValue({ ok: true, status: 200, text: async () => "<html>not json</html>" });

      const { ctx, calls } = makeCtx();
      const res = await loadWorkflow().handler({ path: "foo.json" }, ctx);

      expect(res.isError).toBe(true);
      expect(calls).toHaveLength(0); // did not load the stale local file
      expect(JSON.stringify(res)).toMatch(/not valid JSON/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("treats an EMPTY 200 body as an AUTHORITATIVE absence and refuses (never the local file)", async () => {
    // ComfyUI's "200 + empty body = file does not exist" convention (some builds)
    // is an ABSENCE, not a malformed error — and an absence reported by the server
    // is AUTHORITATIVE: it resolved the name under its own --user-directory. Any
    // file still findable under the orchestrator's RECONSTRUCTED default-layout
    // path is therefore a DIFFERENT file, so loading it is the wrong-graph hazard
    // (#202). Refuse instead.
    const root = mkdtempSync(join(tmpdir(), "cmcp-userdir-"));
    try {
      const defaultDir = join(root, "user", "default", "workflows");
      mkdirSync(defaultDir, { recursive: true });
      const other = { nodes: [{ id: 5, type: "DifferentFileNode" }], links: [] };
      writeFileSync(join(defaultDir, "foo.json"), JSON.stringify(other), "utf8");
      process.env.COMFYUI_PATH = root;

      fetchApi.mockImplementation(async (route: string) =>
        route.startsWith("/api/userdata?")
          ? { ok: true, status: 200, json: async () => [] }
          : { ok: true, status: 200, text: async () => "   " },
      );

      const { ctx, calls } = makeCtx();
      const res = await loadWorkflow().handler({ path: "foo.json" }, ctx);

      expect(res.isError).toBe(true);
      expect(calls).toHaveLength(0); // the DIFFERENT local foo.json was never loaded
      expect(JSON.stringify(res)).toMatch(/user directory|--user-directory/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("REFUSES rather than loading a same-named local file when the server 404s the name (#202)", async () => {
    // The core hazard: ComfyUI runs a custom --user-directory, so the guessed
    // COMFYUI_PATH/user/default/workflows is the WRONG directory. A same-named
    // file there is a different graph; loading it would hand the agent the wrong
    // workflow to edit. The refusal must name what was tried.
    const root = mkdtempSync(join(tmpdir(), "cmcp-userdir-"));
    try {
      const defaultDir = join(root, "user", "default", "workflows");
      mkdirSync(defaultDir, { recursive: true });
      const wrong = { nodes: [{ id: 7, type: "WrongDirNode" }], links: [] };
      writeFileSync(join(defaultDir, "staged.json"), JSON.stringify(wrong), "utf8");
      process.env.COMFYUI_PATH = root;

      fetchApi.mockImplementation(async (route: string) =>
        route.startsWith("/api/userdata?")
          ? { ok: true, status: 200, json: async () => ["other.json"] }
          : { ok: false, status: 404, json: async () => ({}) },
      );

      const { ctx, calls } = makeCtx();
      const res = await loadWorkflow().handler({ path: "staged.json" }, ctx);

      expect(res.isError).toBe(true);
      expect(calls).toHaveLength(0);
      const text = JSON.stringify(res);
      expect(text).toMatch(/staged\.json/); // names what it tried
      expect(text).toMatch(/list_workflows/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// #202 — the connected ComfyUI's real fetch client (@stable-canvas/comfyui-client)
// THROWS an HttpError {status} for every non-2xx; it never returns a non-ok
// Response. Classifying only `res.status` therefore turned every 401/403/5xx into
// "unreachable", which re-enabled the guessed-local-directory fallback for a
// server that had REFUSED — the wrong-file path this resolver exists to close.
describe("readWorkflowFromPath: HTTP status is recovered from a THROWN client error (#202)", () => {
  class HttpError extends Error {
    constructor(message: string, readonly status: number) {
      super(message);
    }
  }

  it("a THROWN 403 is a refusal — never a fallback to a colliding local file", async () => {
    const root = mkdtempSync(join(tmpdir(), "cmcp-userdir-"));
    try {
      const defaultDir = join(root, "user", "default", "workflows");
      mkdirSync(defaultDir, { recursive: true });
      writeFileSync(
        join(defaultDir, "foo.json"),
        JSON.stringify({ nodes: [{ id: 1, type: "CollidingLocalNode" }], links: [] }),
        "utf8",
      );
      process.env.COMFYUI_PATH = root;

      fetchApi.mockRejectedValue(new HttpError("Endpoint Bad Request (403 Forbidden)", 403));

      const { ctx, calls } = makeCtx();
      const res = await loadWorkflow().handler({ path: "foo.json" }, ctx);

      expect(res.isError).toBe(true);
      expect(calls).toHaveLength(0); // the colliding local file was NOT loaded
      expect(JSON.stringify(res)).toMatch(/HTTP 403/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a THROWN 404 is an authoritative absence — refused, not silently substituted", async () => {
    const root = mkdtempSync(join(tmpdir(), "cmcp-userdir-"));
    try {
      const defaultDir = join(root, "user", "default", "workflows");
      mkdirSync(defaultDir, { recursive: true });
      writeFileSync(
        join(defaultDir, "foo.json"),
        JSON.stringify({ nodes: [{ id: 1, type: "CollidingLocalNode" }], links: [] }),
        "utf8",
      );
      process.env.COMFYUI_PATH = root;

      fetchApi.mockRejectedValue(new HttpError("Endpoint Bad Request (404 Not Found)", 404));

      const { ctx, calls } = makeCtx();
      const res = await loadWorkflow().handler({ path: "foo.json" }, ctx);

      expect(res.isError).toBe(true);
      expect(calls).toHaveLength(0);
      expect(JSON.stringify(res)).toMatch(/404/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a statusless transport error still allows the reconstructed local dir (default layout)", async () => {
    // No HTTP status at all → no authority to defer to → the pre-existing
    // best-effort local read is preserved so the DEFAULT layout keeps working.
    const root = mkdtempSync(join(tmpdir(), "cmcp-userdir-"));
    try {
      const defaultDir = join(root, "user", "default", "workflows");
      mkdirSync(defaultDir, { recursive: true });
      const staged = { nodes: [{ id: 7, type: "StagedNode" }], links: [] };
      writeFileSync(join(defaultDir, "staged.json"), JSON.stringify(staged), "utf8");
      process.env.COMFYUI_PATH = root;

      fetchApi.mockRejectedValue(new Error("ECONNREFUSED"));

      const { ctx, calls } = makeCtx();
      const res = await loadWorkflow().handler({ path: "staged.json" }, ctx);

      expect(res.isError).toBeUndefined();
      expect(calls).toHaveLength(1);
      expect(calls[0].graph).toMatchObject(staged);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses when an unreachable server leaves TWO different local candidates", async () => {
    // Both reconstructed layouts (user/default/workflows and user/workflows) hold a
    // DIFFERENT file of the same name. With no server to arbitrate, picking the
    // first is a coin flip over which graph the agent edits — refuse instead.
    const root = mkdtempSync(join(tmpdir(), "cmcp-userdir-"));
    try {
      const a = join(root, "user", "default", "workflows");
      const b = join(root, "user", "workflows");
      mkdirSync(a, { recursive: true });
      mkdirSync(b, { recursive: true });
      writeFileSync(join(a, "dup.json"), JSON.stringify({ nodes: [{ id: 1, type: "A" }] }), "utf8");
      writeFileSync(join(b, "dup.json"), JSON.stringify({ nodes: [{ id: 2, type: "B" }] }), "utf8");
      process.env.COMFYUI_PATH = root;

      fetchApi.mockRejectedValue(new Error("ECONNREFUSED"));

      const { ctx, calls } = makeCtx();
      const res = await loadWorkflow().handler({ path: "dup.json" }, ctx);

      expect(res.isError).toBe(true);
      expect(calls).toHaveLength(0);
      expect(JSON.stringify(res)).toMatch(/ambiguous/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// #202 — a name that IS in the connected ComfyUI's library but whose bytes differ
// by Unicode normalization used to 404 and die, even though panel_list_workflows
// plainly showed it. The resolver asks the SERVER for its own listing and retries
// the SERVER's exact key — it never reconstructs a path — and refuses outright
// when more than one listed key normalizes to the requested name.
//
// Normalization is the ONLY accepted equivalence: NFC/NFD are two spellings of the
// same character sequence. Letter case is NOT — on a case-sensitive filesystem
// "Foo.json" and "foo.json" are different files, so a case-only near miss is named
// in the refusal and never substituted.
describe("readWorkflowFromPath: near-miss names resolve via the server's OWN listing (#202)", () => {
  const routeMock = (listing: unknown[], files: Record<string, unknown>) =>
    fetchApi.mockImplementation(async (route: string) => {
      if (route.startsWith("/api/userdata?")) {
        return { ok: true, status: 200, json: async () => listing };
      }
      const key = decodeURIComponent(route.replace("/api/userdata/", ""));
      const hit = files[key];
      if (hit === undefined) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, status: 200, text: async () => JSON.stringify(hit) };
    });

  it("resolves an NFD-typed name to the library's NFC key and loads THAT file", async () => {
    // "cafe.json" with an acute accent: the library key is COMPOSED (NFC, U+00E9),
    // the caller typed the DECOMPOSED form (NFD, "e" + U+0301). Byte-different,
    // same file name. Written as escapes so no editor/formatter can re-normalize
    // the literals and quietly void the test.
    const nfc = "caf\u00e9.json";
    const nfd = "cafe\u0301.json";
    const graph = { nodes: [{ id: 1, type: "KSampler" }], links: [] };
    routeMock([nfc], { [`workflows/${nfc}`]: graph });

    const { ctx, calls } = makeCtx();
    const res = await loadWorkflow().handler({ path: nfd }, ctx);

    expect(res.isError).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0].graph).toMatchObject(graph);
    // It fetched the SERVER's key, not a locally reconstructed path.
    expect(fetchApi).toHaveBeenCalledWith(`/api/userdata/${encodeURIComponent(`workflows/${nfc}`)}`);
  });

  it("resolves the REVERSE direction too — an NFC name against a DECOMPOSED library key", async () => {
    // The mirror of the test above, and the one that catches a retry which
    // re-derives the key instead of echoing the server's bytes (codex MAJOR): if
    // the retry NFC-normalized the listed key it would re-send the caller's own
    // spelling — the key that just 404'd — and refuse a uniquely listed workflow.
    const nfc = "caf\u00e9.json";
    const nfd = "cafe\u0301.json";
    const graph = { nodes: [{ id: 9, type: "DecomposedLibraryNode" }], links: [] };
    routeMock([nfd], { [`workflows/${nfd}`]: graph });

    const { ctx, calls } = makeCtx();
    const res = await loadWorkflow().handler({ path: nfc }, ctx);

    expect(res.isError).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0].graph).toMatchObject(graph);
    expect(fetchApi).toHaveBeenCalledWith(`/api/userdata/${encodeURIComponent(`workflows/${nfd}`)}`);
  });

  it("uses the server's key verbatim when the listing already carries the workflows/ prefix", async () => {
    // Some listings report the full store key. It must not be double-prefixed, and
    // it must not be rewritten.
    const graph = { nodes: [{ id: 11, type: "PrefixedListingNode" }], links: [] };
    routeMock(["workflows/Prefixed Name.json"], { "workflows/Prefixed Name.json": graph });

    const { ctx, calls } = makeCtx();
    const res = await loadWorkflow().handler({ path: "Prefixed Name.json" }, ctx);

    expect(res.isError).toBeUndefined();
    expect(calls[0].graph).toMatchObject(graph);
    expect(fetchApi).not.toHaveBeenCalledWith(
      `/api/userdata/${encodeURIComponent("workflows/workflows/Prefixed Name.json")}`,
    );
  });

  it("never echoes a traversal entry from a hostile listing back as a request key", async () => {
    routeMock(["../../secret.json", "..\\secret.json"], {});

    const { ctx, calls } = makeCtx();
    const res = await loadWorkflow().handler({ path: "secret.json" }, ctx);

    expect(res.isError).toBe(true);
    expect(calls).toHaveLength(0);
    for (const call of fetchApi.mock.calls) {
      expect(String(call[0])).not.toMatch(/%2E%2E|\.\./i);
    }
  });

  it("REFUSES when two listed keys NORMALIZE to the requested name (ambiguous, no guess)", async () => {
    // Two library keys, one NFC and one NFD, both spelling the same name. A
    // case-sensitive store can hold both; picking either would be a coin flip over
    // which graph the agent edits.
    const nfc = "caf\u00e9.json";
    const nfd = "cafe\u0301.json";
    routeMock([nfc, nfd], {});

    const { ctx, calls } = makeCtx();
    const res = await loadWorkflow().handler({ path: nfd }, ctx);

    expect(res.isError).toBe(true);
    expect(calls).toHaveLength(0);
    expect(JSON.stringify(res)).toMatch(/ambiguous/i);
  });

  it("NEVER substitutes a case-only near miss — it names it and refuses", async () => {
    // "FOO.json" is not in the library; "Foo.json" is a DIFFERENT file on a
    // case-sensitive filesystem. Loading it would be the wrong graph.
    routeMock(["Foo.json"], { "workflows/Foo.json": { nodes: [{ id: 1, type: "WrongCaseNode" }] } });

    const { ctx, calls } = makeCtx();
    const res = await loadWorkflow().handler({ path: "FOO.json" }, ctx);

    expect(res.isError).toBe(true);
    expect(calls).toHaveLength(0);
    const text = JSON.stringify(res);
    expect(text).toMatch(/letter case/i);
    expect(text).toMatch(/Foo\.json/);
    // The differently-cased key was never fetched.
    expect(fetchApi).not.toHaveBeenCalledWith(
      `/api/userdata/${encodeURIComponent("workflows/Foo.json")}`,
    );
  });

  it("an NFC-exact match still wins when a case-variant sibling exists", async () => {
    // The caller's name matches "café.json" character-for-character once
    // normalized; "CAFÉ.json" differs in case and is a different name. The exact
    // match is not a guess, so it resolves — and the case sibling is not fetched.
    const nfc = "caf\u00e9.json";
    const nfd = "cafe\u0301.json";
    const upper = "CAF\u00c9.json";
    const graph = { nodes: [{ id: 4, type: "ExactMatchNode" }], links: [] };
    routeMock([upper, nfc], { [`workflows/${nfc}`]: graph });

    const { ctx, calls } = makeCtx();
    const res = await loadWorkflow().handler({ path: nfd }, ctx);

    expect(res.isError).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0].graph).toMatchObject(graph);
    expect(fetchApi).not.toHaveBeenCalledWith(
      `/api/userdata/${encodeURIComponent(`workflows/${upper}`)}`,
    );
  });

  it("says so when the library LISTS the name but will not serve it", async () => {
    routeMock(["ghost.json"], {}); // listed, but every GET 404s

    const { ctx, calls } = makeCtx();
    const res = await loadWorkflow().handler({ path: "ghost.json" }, ctx);

    expect(res.isError).toBe(true);
    expect(calls).toHaveLength(0);
    expect(JSON.stringify(res)).toMatch(/DOES list/i);
  });

  it("an unreadable listing does not invent a match — it still refuses honestly", async () => {
    fetchApi.mockImplementation(async (route: string) =>
      route.startsWith("/api/userdata?")
        ? { ok: false, status: 500, json: async () => ({}) }
        : { ok: false, status: 404, json: async () => ({}) },
    );

    const { ctx, calls } = makeCtx();
    const res = await loadWorkflow().handler({ path: "whatever.json" }, ctx);

    expect(res.isError).toBe(true);
    expect(calls).toHaveLength(0);
    // The listing WAS consulted (and its 500 swallowed) — otherwise this test would
    // pass even if the near-miss lookup had been dropped entirely.
    expect(fetchApi).toHaveBeenCalledWith("/api/userdata?dir=workflows");
    expect(JSON.stringify(res)).toMatch(/list_workflows/);
  });
});

// #202 (codex MAJOR) — a 2xx whose BODY read aborts is still an answer from the
// server. Letting that fall out as a statusless error classified it "unreachable"
// and re-opened the reconstructed-local-dir fallback, so a mid-body network drop
// could load a colliding local file.
describe("readWorkflowFromPath: a 2xx with an unreadable body is a refusal, not a fallback (#202)", () => {
  it("does not load a colliding local file when the response body fails mid-read", async () => {
    const root = mkdtempSync(join(tmpdir(), "cmcp-userdir-"));
    try {
      const defaultDir = join(root, "user", "default", "workflows");
      mkdirSync(defaultDir, { recursive: true });
      writeFileSync(
        join(defaultDir, "foo.json"),
        JSON.stringify({ nodes: [{ id: 1, type: "CollidingLocalNode" }], links: [] }),
        "utf8",
      );
      process.env.COMFYUI_PATH = root;

      fetchApi.mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => {
          throw new Error("terminated");
        },
      });

      const { ctx, calls } = makeCtx();
      const res = await loadWorkflow().handler({ path: "foo.json" }, ctx);

      expect(res.isError).toBe(true);
      expect(calls).toHaveLength(0); // the colliding local file was NOT loaded
      expect(JSON.stringify(res)).toMatch(/body could not be read/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// #414 — panel_list_workflows reports each workflow's userdata STORE KEY, which
// already carries the "workflows/" prefix (e.g. "workflows/Daily Anime.json").
// Feeding that exact value back to a path-taking tool (panel_strip_workflow /
// panel_load_workflow share readWorkflowFromPath) double-prefixed the userdata
// key → 404 → local miss → "No workflow file at …". The resolver must normalize
// a leading "workflows/" so the list key resolves to the SAME single-prefixed key.
describe("readWorkflowFromPath: a list-style 'workflows/…' path is not double-prefixed (#414)", () => {
  it("resolves the userdata key WITHOUT nesting a second workflows/ segment", async () => {
    const graph = { nodes: [{ id: 1, type: "KSampler" }], links: [] };
    fetchApi.mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify(graph) });

    const { ctx, calls } = makeCtx();
    const res = await loadWorkflow().handler(
      { path: "workflows/Daily Anime Portrait - Fast Preview.json" },
      ctx,
    );

    expect(res.isError).toBeUndefined();
    expect(fetchApi).toHaveBeenCalledWith(
      `/api/userdata/${encodeURIComponent("workflows/Daily Anime Portrait - Fast Preview.json")}`,
    );
    // The pre-fix DOUBLED key must NEVER be requested.
    expect(fetchApi).not.toHaveBeenCalledWith(
      `/api/userdata/${encodeURIComponent("workflows/workflows/Daily Anime Portrait - Fast Preview.json")}`,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].graph).toMatchObject(graph);
  });

  it("a bare name (no prefix) still resolves to the same single-prefixed key", async () => {
    const graph = { nodes: [{ id: 2, type: "VAEDecode" }], links: [] };
    fetchApi.mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify(graph) });

    const { ctx } = makeCtx();
    await loadWorkflow().handler({ path: "Daily Anime Portrait - Fast Preview.json" }, ctx);
    expect(fetchApi).toHaveBeenCalledWith(
      `/api/userdata/${encodeURIComponent("workflows/Daily Anime Portrait - Fast Preview.json")}`,
    );
  });

  it("a 'workflows/'-prefixed path falls back to local disk WITHOUT nesting workflows/", async () => {
    const root = mkdtempSync(join(tmpdir(), "cmcp-userdir-"));
    try {
      const defaultDir = join(root, "user", "default", "workflows");
      mkdirSync(defaultDir, { recursive: true });
      const staged = { nodes: [{ id: 7, type: "PrefixedLocalNode" }], links: [] };
      writeFileSync(join(defaultDir, "Foo.json"), JSON.stringify(staged), "utf8");
      process.env.COMFYUI_PATH = root;

      // Server unreachable (statusless transport error) → the local fallback is
      // the only branch that still reads disk. rel ("Foo.json") must join the
      // workflows dir directly, not as workflows/workflows/Foo.json.
      fetchApi.mockRejectedValue(new Error("ECONNREFUSED"));

      const { ctx, calls } = makeCtx();
      const res = await loadWorkflow().handler({ path: "workflows/Foo.json" }, ctx);

      expect(res.isError).toBeUndefined();
      expect(calls).toHaveLength(1);
      expect(calls[0].graph).toMatchObject(staged);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// #414 hardening (codex) — normalizing the "workflows/" prefix must not let a
// ".." segment escape the workflows root (e.g. "workflows/../secret.json" would
// otherwise strip to "../secret.json"). Such a path is refused outright.
describe("readWorkflowFromPath: refuses a '..' traversal segment (#414 hardening)", () => {
  it("rejects a workflows/.. path without fetching or loading anything", async () => {
    const { ctx, calls } = makeCtx();
    const res = await loadWorkflow().handler({ path: "workflows/../secret.json" }, ctx);
    expect(res.isError).toBe(true);
    expect(fetchApi).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
    expect(JSON.stringify(res)).toMatch(/not a valid workflow name|\.\.|traversal/i);
  });

  it("still accepts a colon in a workflow NAME (legal POSIX filename, not a drive letter)", async () => {
    // Regression guard: the drive-relative check must not reject a normal colon in
    // a listed name like "workflows/style:anime.json".
    const graph = { nodes: [{ id: 3, type: "SaveImage" }], links: [] };
    fetchApi.mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify(graph) });
    const { ctx } = makeCtx();
    const res = await loadWorkflow().handler({ path: "workflows/style:anime.json" }, ctx);
    expect(res.isError).toBeUndefined();
    expect(fetchApi).toHaveBeenCalledWith(
      `/api/userdata/${encodeURIComponent("workflows/style:anime.json")}`,
    );
  });

  it("rejects a Windows drive-relative traversal after the prefix is stripped", async () => {
    // "workflows/C:../secret.json" strips to "C:../secret.json" — no exact ".."
    // segment, but resolve() would canonicalize the embedded ".." and escape. The
    // ":" (drive-letter) guard blocks it before any fetch/local read.
    const { ctx, calls } = makeCtx();
    const res = await loadWorkflow().handler({ path: "workflows/C:../secret.json" }, ctx);
    expect(res.isError).toBe(true);
    expect(fetchApi).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
    expect(JSON.stringify(res)).toMatch(/not a valid workflow name/i);
  });

  it("does NOT read a file via a symlink under the workflows dir that escapes the root", async (t) => {
    // A lexically-clean name ("linked/secret.json") where `linked` is a symlink to
    // an EXTERNAL dir would, without realpath containment, be read on the local
    // fallback. The realpath check rejects it. (Skipped where the OS denies
    // unprivileged symlink creation, e.g. stock Windows.)
    const { symlinkSync } = await import("node:fs");
    const root = mkdtempSync(join(tmpdir(), "cmcp-userdir-"));
    const external = mkdtempSync(join(tmpdir(), "cmcp-external-"));
    try {
      const defaultDir = join(root, "user", "default", "workflows");
      mkdirSync(defaultDir, { recursive: true });
      writeFileSync(
        join(external, "secret.json"),
        JSON.stringify({ nodes: [{ id: 1, type: "SecretNode" }], links: [] }),
        "utf8",
      );
      try {
        symlinkSync(external, join(defaultDir, "linked"), "junction");
      } catch {
        // Unprivileged symlink creation (stock Windows). Mark the test SKIPPED
        // rather than returning — a bare return reports a green test that never
        // ran its assertion (codex).
        t.skip();
        return;
      }
      process.env.COMFYUI_PATH = root;
      // Unreachable server → the local fallback is reached, so the realpath
      // containment check is the thing actually under test here.
      fetchApi.mockRejectedValue(new Error("ECONNREFUSED"));

      const { ctx, calls } = makeCtx();
      const res = await loadWorkflow().handler({ path: "linked/secret.json" }, ctx);

      // The escaping file must NOT be loaded — surfaces the honest not-found error.
      expect(calls).toHaveLength(0);
      expect(res.isError).toBe(true);
      expect(JSON.stringify(res)).toMatch(/No workflow file at/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(external, { recursive: true, force: true });
    }
  });
});
