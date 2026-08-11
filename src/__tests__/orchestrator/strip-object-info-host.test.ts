// #1359 — the graph and its node definitions come from different authorities, and the
// failure never said so.
//
// `panel_strip_workflow` captures the live canvas through the connected panel, then
// fetches /object_info through the GLOBAL headless client, which resolves COMFYUI_URL.
// One machine for a local session; two for a connected REMOTE panel. When they differ
// the reporter got:
//
//   fetch failed: connect ECONNREFUSED 127.0.0.1:8188 — while requesting
//   http://127.0.0.1:8188/object_info
//
// Nothing there mentions that the workflow itself came from a ComfyUI on a different
// host. They had to read dist/orchestrator/panel-tools.js to work it out.
//
// THE SPLIT IS NOW FIXED, so most of this file changed meaning. The live canvas takes its
// definitions from the panel that supplied the graph (`graph_get_object_info`, panel
// 0.13.0 / #1006), so the message these tests were written for — "THE GRAPH AND ITS NODE
// DEFINITIONS CAME FROM DIFFERENT PLACES", with a WORKAROUND to repoint COMFYUI_URL — is
// unreachable and has been deleted rather than left as a confident explanation of a
// situation the code can no longer produce.
//
// What remains here is the pack/path/inline case, where COMFYUI_URL genuinely IS the right
// authority, plus a test that the live canvas no longer touches it at all.

import { describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({ objectInfoFails: { value: true } }));
vi.mock("../../comfyui/client.js", () => ({
  getObjectInfo: async () => {
    if (hoisted.objectInfoFails.value) {
      throw new Error(
        "fetch failed: connect ECONNREFUSED 127.0.0.1:8188 — while requesting http://127.0.0.1:8188/object_info",
      );
    }
    return {};
  },
  backfillObjectInfo: async (bulk: unknown) => bulk,
  resetClient: () => {},
  resetObjectInfoCache: () => {},
}));

const { buildPanelToolDefs, makePanelToolCtx } = await import("../../orchestrator/panel-tools.js");
import type { PanelToolCtx, ToolResult } from "../../orchestrator/panel-tools.js";
import { WorkflowTargetStore } from "../../services/workflow-target-store.js";

const TAB = "wf:workflows/a.json";
const REMOTE = "https://abc123-8188.proxy.runpod.net:443";

/** What the panel answers `graph_get_object_info` with, per test. */
let objectInfoReply: unknown = { ok: true, served_by: REMOTE, object_info: {} };

async function stripWithPanelObjectInfo(reply: unknown): Promise<string> {
  const prev = objectInfoReply;
  objectInfoReply = reply;
  try {
    return await strip({});
  } finally {
    objectInfoReply = prev;
  }
}

/** A panel that serves the live graph and reports a REMOTE ComfyUI origin. */
function bridge(serverOrigin: string | null) {
  return {
    send: async (cmd: Record<string, unknown>) => {
      if (cmd.cmd === "graph_serialize" || cmd.cmd === "graph_get_state") {
        return { workflow: { nodes: [], links: [] }, nodes: [], links: [] };
      }
      if (cmd.cmd === "graph_get_object_info") return objectInfoReply;
      return { ok: true, workflow: { nodes: [], links: [] } };
    },
    push: () => 1,
    canReach: () => true,
    isHeadless: () => false,
    tabs: () => [{ tab_id: TAB, title: "wf", connected_at: 0 }],
    resolveActiveTabId: () => TAB,
    tabServerOrigin: () => serverOrigin,
    tabCanMutateGraph: () => true,
    tabGraphMutationCapability: () => ({ known: true, canMutate: true }),
  } as unknown as PanelToolCtx["bridge"];
}

async function strip(args: object, serverOrigin: string | null = REMOTE): Promise<string> {
  const ctx = makePanelToolCtx(bridge(serverOrigin), TAB, new WorkflowTargetStore());
  const def = buildPanelToolDefs().find((d) => d.name === "panel_strip_workflow");
  if (!def) throw new Error("panel_strip_workflow is not registered");
  const res: ToolResult = await def.handler(args as never, ctx);
  return res.content.map((c) => (c as { text?: string }).text ?? "").join(" ");
}

describe("an /object_info failure names which host it asked (#1359)", () => {
  it("LIVE CANVAS: never asks COMFYUI_URL at all, so its failure cannot reach the user", async () => {
    // The mocked global client throws ECONNREFUSED for every call. If the live-canvas path
    // still consulted it, that string would appear here — which is exactly what the
    // reporter saw. It must not, because the definitions now come from the panel.
    const text = await strip({});
    expect(text).not.toMatch(/ECONNREFUSED 127\.0\.0\.1:8188/);
    // …and the superseded explanation must be gone, not merely unused.
    expect(text).not.toMatch(/DIFFERENT PLACES/);
    expect(text).not.toMatch(/WORKAROUND: point COMFYUI_URL/);
  });

  it("LIVE CANVAS: a panel that cannot serve definitions is REFUSED, never retried on COMFYUI_URL", async () => {
    // The direction that matters. A fallback would convert this canvas against a different
    // ComfyUI's schema and return a confidently wrong workflow.
    const text = await stripWithPanelObjectInfo({ ok: false, served_by: REMOTE, detail: "no /object_info here." });
    expect(text).toMatch(/could not obtain node definitions/i);
    expect(text).toContain(REMOTE);
    expect(text).toMatch(/refused rather than retried against COMFYUI_URL/i);
    expect(text).not.toMatch(/ECONNREFUSED/);
  });

  it("LIVE CANVAS: a payload-free success is refused, not read as an empty schema", async () => {
    const text = await stripWithPanelObjectInfo({ ok: true, served_by: REMOTE });
    expect(text).toMatch(/replied without node definitions/i);
    expect(text).not.toMatch(/ECONNREFUSED/);
  });


  it("a PACK/PATH/INLINE source is not told about the panel at all", async () => {
    // Those sources are deliberately tied to COMFYUI_URL, so the bare failure is
    // already about the host the caller asked for. Blaming a host mismatch there
    // would send them to change a setting that is correct.
    const text = await strip({ graph: { nodes: [], links: [] } });

    expect(text).toMatch(/Node definitions are read from COMFYUI_URL/);
    expect(text).not.toMatch(/DIFFERENT PLACES/);
    expect(text).not.toContain(REMOTE);
  });
});
