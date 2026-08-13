// #1129 (reopened) — legacy ComfyUI-Manager 3.x answers the install POST with
// `queued: true` and never enqueues the task. The reporter's follow-up read
// showed an idle queue with `total_count: 0` and no directory under
// custom_nodes, while panel_install_node had already reported success.
//
// #1143 fixed the OTHER half of this family — a pre-queue 403/404 refusal falls
// through to a direct clone. It keys on the rejection status, so it cannot fire
// here: the POST succeeded.
//
// WHY THIS ONLY WARNS, AND DOES NOT REPORT FAILURE. The first version checked the
// installed list too and, finding the pack absent, flipped the result to an
// error. Adversarial review killed that, correctly, on three counts:
//
//   - it substring-searched the RAW reply text instead of a validated shape, so
//     an error envelope or an unfamiliar dialect payload read as "absent" —
//     breaking this file's own rule that an unknown answer claims nothing;
//   - the fixture it was tested against (`{nodes:[{name}]}`) is not the panel's
//     production shape at all (`{installed: ...}`), so the check was only ever
//     passing because it searched text;
//   - a git URL's checkout directory need not match its URL basename, and the
//     panel documents those targets as rename-prone. Absence by derived name
//     therefore cannot PROVE failure.
//
// Since the second observation cannot be made decisive, the honest reply is a
// warning that says exactly what WAS observed — the queue has no such task — and
// tells the caller to confirm. A false "definitely failed" on a working install
// is the same class of harm as the false success this issue is about.
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

function bridge(opts: {
  install?: Record<string, unknown>;
  /** The `status` block nodes_queue_status wraps. */
  status?: Record<string, unknown> | null;
  queueErrors?: boolean;
}) {
  return {
    send: async (cmd: Record<string, unknown>) => {
      sent.push(String(cmd.cmd));
      if (cmd.cmd === "nodes_install") {
        // The reporter's exact reply.
        return opts.install ?? { queued: true, pending: true, dialect: "legacy" };
      }
      if (cmd.cmd === "nodes_queue_status") {
        if (opts.queueErrors) throw new Error("queue unreachable");
        // The panel wraps it: `{ status }` (plus recent_failures/note sometimes).
        return { status: opts.status ?? { total_count: 0, done_count: 0, in_progress_count: 0, is_processing: false } };
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
  opts: Parameters<typeof bridge>[0],
): Promise<{ text: string; isError: boolean }> {
  const ctx = makePanelToolCtx(bridge(opts), TAB, new WorkflowTargetStore());
  const def = buildPanelToolDefs().find((d) => d.name === "panel_install_node");
  if (!def) throw new Error("panel_install_node is not registered");
  const res: ToolResult = await def.handler({ repository: REPO } as never, ctx);
  return { text: textOf(res), isError: res.isError === true };
}

beforeEach(() => {
  sent = [];
});

describe("an install the Manager accepted and dropped says so (#1129)", () => {
  it("warns when the queue is IDLE and has seen no task at all", async () => {
    const out = await install({});

    // The read really happened — otherwise this asserts on a verdict reached
    // without looking, which is the defect itself.
    expect(sent).toContain("nodes_queue_status");

    expect(out.text).toMatch(/THE QUEUE DOES NOT HAVE THIS TASK/);
    // States what was observed and why zero is decisive, rather than asserting it.
    expect(out.text).toMatch(/includes finished ones/);
    expect(out.text).toMatch(/not a receipt/);
    // Names the confirmation and the tool that CAN clone.
    expect(out.text).toMatch(/panel_list_nodes/);
    expect(out.text).toMatch(/install_custom_node/);
    expect(out.text).toMatch(/Retrying HERE will be dropped/);

    // NOT an error. Absence could not be proven, so the result is not flipped —
    // a false definite failure on a working install is the mirror of this bug.
    expect(out.isError).toBe(false);
  });

  it("says nothing while the worker is PROCESSING, even at total_count 0 (codex P1)", async () => {
    // A snapshot taken mid-accept can read zero before the counters move. Treating
    // that as "never queued" would warn about an install that is starting
    // normally — the reporter's own signature requires an IDLE queue.
    const out = await install({
      status: { total_count: 0, done_count: 0, in_progress_count: 0, is_processing: true },
    });

    expect(sent).toContain("nodes_queue_status");
    expect(out.text).not.toMatch(/THE QUEUE DOES NOT HAVE THIS TASK/);
  });

  it("says nothing when idleness is UNKNOWN", async () => {
    // No `is_processing` at all: the shape cannot answer whether the worker is
    // running, so it is not made to.
    const out = await install({ status: { total_count: 0, done_count: 0 } });

    expect(out.text).not.toMatch(/THE QUEUE DOES NOT HAVE THIS TASK/);
  });

  it("says nothing when the queue DID see a task", async () => {
    const out = await install({
      status: { total_count: 1, done_count: 0, in_progress_count: 1, is_processing: true },
    });

    expect(out.text).not.toMatch(/THE QUEUE DOES NOT HAVE THIS TASK/);
  });

  it("says nothing on INCOHERENT counts", async () => {
    // total 0 with work recorded against it does not match the 3.x contract
    // (total = done + in_progress + queued), so this reasoning does not describe
    // that payload and must not be applied to it.
    const out = await install({
      status: { total_count: 0, done_count: 3, in_progress_count: 0, is_processing: false },
    });

    expect(out.text).not.toMatch(/THE QUEUE DOES NOT HAVE THIS TASK/);
  });

  it("says nothing on a v4-style shape with no total_count", async () => {
    // v4 reports `pending_count` directly. The dropped-enqueue defect is legacy
    // 3.x behaviour, so a shape that cannot answer is left alone.
    const out = await install({ status: { pending_count: 0, in_progress_count: 0, is_processing: false } });

    expect(out.text).not.toMatch(/THE QUEUE DOES NOT HAVE THIS TASK/);
  });

  it("claims nothing when the queue read itself fails", async () => {
    const out = await install({ queueErrors: true });

    expect(out.text).not.toMatch(/THE QUEUE DOES NOT HAVE THIS TASK/);
    expect(out.isError).toBe(false);
  });

  it("does not read the queue at all when nothing claimed it was queued", async () => {
    // Nothing to contradict, and probing would spend a round trip per install for
    // no reason (codex P2 — this is the only extra read, and it is conditional).
    const out = await install({ install: { installed: true, dialect: "v4" } });

    expect(sent).not.toContain("nodes_queue_status");
    expect(out.isError).toBe(false);
  });
});
