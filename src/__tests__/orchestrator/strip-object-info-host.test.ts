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
// THIS DOES NOT FIX THE SPLIT AUTHORITY. Stripping the live canvas correctly needs the
// definitions to come from the panel's own ComfyUI, which is a panel protocol change
// and is tracked separately. What it fixes is that the failure was undiagnosable —
// the same class of defect as #1300 (a status where a reason belonged).

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

/** A panel that serves the live graph and reports a REMOTE ComfyUI origin. */
function bridge(serverOrigin: string | null) {
  return {
    send: async (cmd: Record<string, unknown>) => {
      if (cmd.cmd === "graph_serialize" || cmd.cmd === "graph_get_state") {
        return { workflow: { nodes: [], links: [] }, nodes: [], links: [] };
      }
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
  it("LIVE CANVAS: says the graph and the definitions came from different places", async () => {
    const text = await strip({});

    // The raw cause is preserved — it is still the evidence.
    expect(text).toMatch(/ECONNREFUSED 127\.0\.0\.1:8188/);
    // …and now it says what the reporter had to read dist/ to learn.
    expect(text).toMatch(/DIFFERENT PLACES/);
    expect(text).toContain(REMOTE); // where the graph came from
    expect(text).toMatch(/node definitions are fetched over COMFYUI_URL/i);
    // The workaround that works today, and honesty that this is a known split.
    expect(text).toMatch(/WORKAROUND: point COMFYUI_URL at the same ComfyUI/);
    expect(text).toMatch(/#1359/);
  });

  it("names the two hosts as DIFFERENT only when they are", async () => {
    // The over-claiming direction. If the panel is on the same host, "two different
    // hosts, which is why this could not work" would be a false explanation for a
    // failure with some other cause — a plain unreachable ComfyUI, say.
    const text = await strip({}, "http://127.0.0.1:8188");

    expect(text).toMatch(/DIFFERENT PLACES/); // the authorities are still split…
    expect(text).not.toMatch(/two different hosts/); // …but they resolve to one machine
  });

  it("an unreadable panel origin costs a detail, not a wrong claim", async () => {
    const text = await strip({}, null);

    expect(text).toMatch(/ECONNREFUSED/);
    expect(text).not.toMatch(/two different hosts/);
    // Still names the workaround it can support.
    expect(text).toMatch(/WORKAROUND/);
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
