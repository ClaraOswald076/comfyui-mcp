// #1129 (reopened) — legacy ComfyUI-Manager 3.x answers the install POST with
// `queued: true` and then never enqueues the task. The reporter's follow-up read
// showed an idle queue with `total_count: 0` and no directory under
// custom_nodes, while panel_install_node had already reported success.
//
// #1143 fixed the OTHER half of this family — a pre-queue 403/404 refusal now
// falls through to a direct clone. That fix keys on the rejection status, so it
// cannot fire here: the POST succeeded.
//
// WHY THIS IS NOT THE SAME FIX AS install_custom_node's. That tool already
// verifies and clones, and it may: it owns the filesystem it installs into.
// panel_install_node drives whatever ComfyUI the PANEL is bound to, which need
// not be this machine — so it may report the truth but must not clone somewhere
// else on the caller's behalf.
//
// THE BAR FOR CONTRADICTING THE PANEL is two NEGATIVE observations, because
// either alone is too weak: a queue shape without `total_count` proves nothing,
// and a pack missing from the installed list moments after enqueuing is entirely
// normal — it has not been cloned yet.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../comfyui/client.js", () => ({
  getObjectInfo: vi.fn(),
  backfillObjectInfo: vi.fn(),
  resetClient: vi.fn(),
  resetObjectInfoCache: vi.fn(),
}));

const { buildPanelToolDefs, makePanelToolCtx } = await import("../../orchestrator/panel-tools.js");
import { WorkflowTargetStore } from "../../services/workflow-target-store.js";
import type { PanelToolCtx, ToolResult } from "../../orchestrator/panel-tools.js";

const TAB = "11111111-2222-3333-4444-555555555555";
const REPO = "https://github.com/NikoDemon80/ComfyUI-H3-Motion-Context";

const textOf = (r: ToolResult): string =>
  r.content.map((c) => (c as { text?: string }).text ?? "").join(" ");

let sent: string[] = [];

/**
 * `install` is what the panel says to the install POST; `total` is the queue's
 * `total_count` afterwards; `installedNames` is what the node list reports.
 */
function bridge(opts: {
  install?: Record<string, unknown>;
  total?: number | null;
  installedNames?: string[];
  queueErrors?: boolean;
  listErrors?: boolean;
}) {
  return {
    send: async (cmd: Record<string, unknown>) => {
      sent.push(String(cmd.cmd));
      if (cmd.cmd === "nodes_install") {
        // The reporter's exact reply shape.
        return opts.install ?? { queued: true, pending: true, dialect: "legacy" };
      }
      if (cmd.cmd === "nodes_queue_status") {
        if (opts.queueErrors) throw new Error("queue unreachable");
        return opts.total === null
          ? { status: { done_count: 0 } } // a v4-ish shape with no total_count
          : { status: { total_count: opts.total ?? 0, done_count: 0 } };
      }
      if (cmd.cmd === "nodes_list") {
        if (opts.listErrors) throw new Error("list unreachable");
        return { nodes: (opts.installedNames ?? []).map((n) => ({ name: n })) };
      }
      return { ok: true };
    },
    push: () => 1,
    canReach: (id: string) => id === TAB,
    isHeadless: () => false,
    tabs: () => [{ tab_id: TAB, title: "wf", connected_at: 0 }],
    resolveActiveTabId: () => TAB,
    refreshWorkflowUuid: () => true,
    workflowUuidFor: () => ({ known: false }),
    tabCanMutateGraph: () => true,
    tabGraphMutationCapability: () => ({ known: true, canMutate: true }),
  } as unknown as PanelToolCtx["bridge"];
}

async function install(
  args: Record<string, unknown>,
  opts: Parameters<typeof bridge>[0],
): Promise<{ text: string; isError: boolean }> {
  const ctx = makePanelToolCtx(bridge(opts), TAB, new WorkflowTargetStore());
  const def = buildPanelToolDefs().find((d) => d.name === "panel_install_node");
  if (!def) throw new Error("panel_install_node is not registered");
  const res: ToolResult = await def.handler(args as never, ctx);
  return { text: textOf(res), isError: res.isError === true };
}

beforeEach(() => {
  sent = [];
});

describe("an install the Manager accepted and dropped is reported as such (#1129)", () => {
  it("contradicts the queued reply when the queue saw NOTHING and the pack is absent", async () => {
    const out = await install({ repository: REPO }, { total: 0, installedNames: [] });

    // Both observations really happened — otherwise this asserts on a verdict
    // reached without looking, which is the defect itself.
    expect(sent).toContain("nodes_queue_status");
    expect(sent).toContain("nodes_list");

    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/CHECKED, AND IT WAS NOT/);
    expect(out.text).toMatch(/ComfyUI-H3-Motion-Context/);
    // The reason total_count 0 is decisive gets stated, not assumed.
    expect(out.text).toMatch(/includes finished ones/);
    // ...and it points at the tool that CAN clone, rather than cloning here.
    expect(out.text).toMatch(/install_custom_node/);
    expect(out.text).toMatch(/Do NOT simply retry/);
  });

  it("says nothing when the queue DID see a task", async () => {
    // The normal case: enqueued, not yet cloned. Absent from the installed list
    // is expected here and must not be read as a failure.
    const out = await install({ repository: REPO }, { total: 1, installedNames: [] });

    expect(sent).toContain("nodes_queue_status");
    // The second read is not even reached — one positive observation settles it.
    expect(sent).not.toContain("nodes_list");
    expect(out.isError).toBe(false);
    expect(out.text).not.toMatch(/CHECKED, AND IT WAS NOT/);
  });

  it("says nothing when the pack IS installed despite an empty queue", async () => {
    // A fast install whose task already cleared. One negative observation is not
    // enough, and this is precisely the case that makes it not enough.
    const out = await install(
      { repository: REPO },
      { total: 0, installedNames: ["ComfyUI-H3-Motion-Context"] },
    );

    expect(sent).toContain("nodes_list");
    expect(out.isError).toBe(false);
    expect(out.text).not.toMatch(/CHECKED, AND IT WAS NOT/);
  });

  it("claims nothing when the queue shape cannot answer", async () => {
    // A v4-style status with no `total_count` proves neither way, so the panel's
    // own reply stands (#1473's rule).
    const out = await install({ repository: REPO }, { total: null, installedNames: [] });

    expect(out.isError).toBe(false);
    expect(sent).not.toContain("nodes_list");
  });

  it("claims nothing when either read fails", async () => {
    const q = await install({ repository: REPO }, { queueErrors: true });
    expect(q.isError).toBe(false);

    sent = [];
    const l = await install({ repository: REPO }, { total: 0, listErrors: true });
    expect(l.isError).toBe(false);
  });

  it("does not probe at all when the panel never claimed it was queued", async () => {
    // A reply that makes no such claim has nothing to contradict, and probing it
    // would spend two round trips per install for nothing.
    const out = await install(
      { repository: REPO },
      { install: { installed: true, dialect: "v4" }, total: 0 },
    );

    expect(sent).not.toContain("nodes_queue_status");
    expect(out.isError).toBe(false);
  });
});
