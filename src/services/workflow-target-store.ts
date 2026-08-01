// Per-panel-tab workflow target: which open ComfyUI workflow tab the agent
// should edit. Without pinning, graph_* commands hit whatever workflow the user
// is currently viewing — browsing another tab mid-conversation redirects edits.
//
// Pinning injects `workflow_path` on workflow-scoped bridge commands. The panel can
// only read/edit the workflow currently IN VIEW (its graph executors run against the
// active canvas and fail closed on a workflow_path mismatch — panel #349/#186), so a
// pin must target the active canvas at pin time (enforced in panel_set_workflow_target)
// and the injected `workflow_path` acts as a GUARD: if the user later switches away, the
// next graph command fails loudly instead of silently editing the wrong graph. It does
// NOT enable background editing of a non-active tab.

export type WorkflowTargetMode = "current" | "pinned";

export interface WorkflowTarget {
  mode: WorkflowTargetMode;
  /** Workflow path/key when mode is "pinned" (from workflow_list). */
  path?: string;
  /** Human label for UI / agent context. */
  filename?: string;
}

const DEFAULT_TARGET: WorkflowTarget = { mode: "current" };

/** In-memory per-tab workflow pin. Process-scoped; cleared on orchestrator restart. */
export class WorkflowTargetStore {
  private targets = new Map<string, WorkflowTarget>();

  get(tabId: string): WorkflowTarget {
    return this.targets.get(tabId) ?? DEFAULT_TARGET;
  }

  set(tabId: string, target: WorkflowTarget): WorkflowTarget {
    const normalized = normalizeTarget(target);
    if (normalized.mode === "current") {
      this.targets.delete(tabId);
      return DEFAULT_TARGET;
    }
    this.targets.set(tabId, normalized);
    return normalized;
  }

  clear(tabId: string): void {
    this.targets.delete(tabId);
  }
}

function normalizeTarget(raw: WorkflowTarget): WorkflowTarget {
  if (raw.mode !== "pinned") return { mode: "current" };
  const path = (raw.path ?? "").trim();
  if (!path) return { mode: "current" };
  const filename = (raw.filename ?? "").trim() || undefined;
  return { mode: "pinned", path, filename };
}

/** Bridge commands that target a specific workflow canvas (not tab navigation). */
export function shouldInjectWorkflowPath(cmd: string, args: Record<string, unknown>): boolean {
  if (cmd === "workflow_list" || cmd === "workflow_new" || cmd === "workflow_open") return false;
  if (cmd.startsWith("graph_")) return true;
  // workflow_* that default to "active" when path omitted
  if (
    (cmd === "workflow_save" ||
      cmd === "workflow_save_as" ||
      cmd === "workflow_rename" ||
      cmd === "workflow_close") &&
    args.path === undefined
  ) {
    return true;
  }
  return false;
}

/** Attach workflow_path when the tab has a pinned target. */
export function withWorkflowTarget(
  cmd: Record<string, unknown>,
  target: WorkflowTarget,
): Record<string, unknown> {
  if (target.mode !== "pinned" || !target.path) return cmd;
  const name = typeof cmd.cmd === "string" ? cmd.cmd : "";
  if (!name || cmd.workflow_path !== undefined) return cmd;
  if (!shouldInjectWorkflowPath(name, cmd)) return cmd;
  return { ...cmd, workflow_path: target.path };
}