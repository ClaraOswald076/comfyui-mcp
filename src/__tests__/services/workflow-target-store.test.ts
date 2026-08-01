import { describe, expect, it } from "vitest";
import {
  WorkflowTargetStore,
  shouldInjectWorkflowPath,
  withWorkflowTarget,
} from "../../services/workflow-target-store.js";

describe("workflow-target-store", () => {
  it("defaults to current mode", () => {
    const store = new WorkflowTargetStore();
    expect(store.get("tab-a")).toEqual({ mode: "current" });
  });

  it("pins and clears per tab", () => {
    const store = new WorkflowTargetStore();
    const pinned = store.set("tab-a", {
      mode: "pinned",
      path: "workflows/foo.json",
      filename: "foo.json",
    });
    expect(pinned).toEqual({
      mode: "pinned",
      path: "workflows/foo.json",
      filename: "foo.json",
    });
    expect(store.get("tab-a")).toEqual(pinned);
    expect(store.get("tab-b")).toEqual({ mode: "current" });

    store.set("tab-a", { mode: "current" });
    expect(store.get("tab-a")).toEqual({ mode: "current" });
  });

  it("rejects pinned without path", () => {
    const store = new WorkflowTargetStore();
    expect(store.set("tab-a", { mode: "pinned", path: "  " })).toEqual({ mode: "current" });
  });
});

describe("withWorkflowTarget", () => {
  const pinned = { mode: "pinned" as const, path: "workflows/a.json" };

  it("injects workflow_path on graph commands", () => {
    const out = withWorkflowTarget({ cmd: "graph_get_state" }, pinned);
    expect(out).toEqual({ cmd: "graph_get_state", workflow_path: "workflows/a.json" });
  });

  it("does not inject on workflow_list or workflow_open", () => {
    expect(withWorkflowTarget({ cmd: "workflow_list" }, pinned)).toEqual({ cmd: "workflow_list" });
    expect(withWorkflowTarget({ cmd: "workflow_open", path: "x" }, pinned)).toEqual({
      cmd: "workflow_open",
      path: "x",
    });
  });

  it("does not override explicit workflow_path", () => {
    const out = withWorkflowTarget(
      { cmd: "graph_add_node", workflow_path: "workflows/explicit.json" },
      pinned,
    );
    expect(out.workflow_path).toBe("workflows/explicit.json");
  });

  it("leaves commands alone in current mode", () => {
    const out = withWorkflowTarget({ cmd: "graph_run" }, { mode: "current" });
    expect(out).toEqual({ cmd: "graph_run" });
  });

  it("does NOT inject workflow_path on refresh_nodes even when pinned (#608 global refresh)", () => {
    // panel_refresh_nodes forces a GLOBAL /object_info re-register that is not tied
    // to any one graph; it is deliberately named `refresh_nodes` (not `graph_*`) so
    // shouldInjectWorkflowPath excludes it — no workflow_path is added, so the
    // frontend's pinned-target guard is skipped and the refresh runs regardless of
    // which workflow the pinned session points at. This LOCKS that design: renaming
    // it to a graph_* command (which WOULD inject a pin and trip the guard) must
    // fail this test.
    expect(shouldInjectWorkflowPath("refresh_nodes", {})).toBe(false);
    expect(withWorkflowTarget({ cmd: "refresh_nodes" }, pinned)).toEqual({ cmd: "refresh_nodes" });
  });
});

describe("shouldInjectWorkflowPath", () => {
  it("classifies workflow-scoped commands", () => {
    expect(shouldInjectWorkflowPath("graph_get_state", {})).toBe(true);
    expect(shouldInjectWorkflowPath("workflow_save", {})).toBe(true);
    expect(shouldInjectWorkflowPath("workflow_close", { path: "x.json" })).toBe(false);
    expect(shouldInjectWorkflowPath("workflow_list", {})).toBe(false);
  });
});