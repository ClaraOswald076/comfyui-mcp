// #1018 — an agent's FIRST panel_set_todo was rejected over a spelling.
//
// It submitted `in_progress` and `completed`; the schema accepted only
// `pending` | `active` | `done`, so the call died at the protocol layer with
//
//     MCP error -32602: Input validation error; expected one of `pending`|`active`|`done`
//
// Those are not typos. They are the near-universal todo vocabulary in agent
// tooling, so an agent that has not read this tool's enum reaches for them by
// default — and pays a full round trip at plan setup, the first thing the user
// sees. Nothing about the request was ambiguous: the intent of `in_progress` is
// not in question.
//
// The schema now admits the synonyms and the handler canonicalizes them, so
// everything downstream — the panel, recordTodo's snapshot (#977), the
// completion-directive logic that reads it — still sees only the canonical
// three. The tool description deliberately still teaches one vocabulary.

import { beforeEach, describe, expect, it } from "vitest";

import {
  TODO_STATUSES,
  TODO_STATUS_INPUTS,
  normalizeTodoItems,
  normalizeTodoStatus,
  planInFlight,
  todoFor,
  __resetTodoState,
} from "../../orchestrator/todo-state.js";
import {
  buildPanelToolDefs,
  makePanelToolCtx,
  type PanelToolCtx,
} from "../../orchestrator/panel-tools.js";

describe("#1018: the status vocabulary a caller actually brings", () => {
  it("maps the two spellings from the report", () => {
    expect(normalizeTodoStatus("in_progress")).toBe("active");
    expect(normalizeTodoStatus("completed")).toBe("done");
  });

  it("maps the other spellings agents produce", () => {
    for (const [given, want] of [
      ["in-progress", "active"],
      ["inprogress", "active"],
      ["running", "active"],
      ["current", "active"],
      ["complete", "done"],
      ["finished", "done"],
      ["todo", "pending"],
      ["not_started", "pending"],
      ["not-started", "pending"],
      ["queued", "pending"],
    ] as const) {
      expect(normalizeTodoStatus(given), given).toBe(want);
    }
  });

  it("leaves the canonical values exactly as they are", () => {
    for (const s of TODO_STATUSES) expect(normalizeTodoStatus(s)).toBe(s);
  });

  it("is case- and whitespace-tolerant on an alias", () => {
    expect(normalizeTodoStatus(" In_Progress ")).toBe("active");
  });

  // Guessing at an unrecognised status would put a wrong state in front of the
  // user. Unknown input passes through and is rejected by validation instead.
  it("does NOT invent a mapping for an unknown status", () => {
    expect(normalizeTodoStatus("blocked")).toBe("blocked");
    expect(TODO_STATUS_INPUTS).not.toContain("blocked");
  });

  it("normalizes a list without disturbing items that carry no status", () => {
    const out = normalizeTodoItems([
      { text: "a", status: "in_progress" },
      { text: "b" },
      { text: "c", status: "done" },
    ]);
    expect(out).toEqual([
      { text: "a", status: "active" },
      { text: "b" },
      { text: "c", status: "done" },
    ]);
  });

  it("does not mutate the caller's array", () => {
    const input = [{ text: "a", status: "completed" }];
    normalizeTodoItems(input);
    expect(input[0].status).toBe("completed");
  });

  it("every admitted spelling normalizes INTO the canonical set", () => {
    for (const s of TODO_STATUS_INPUTS) {
      expect(TODO_STATUSES as readonly string[], s).toContain(normalizeTodoStatus(s));
    }
  });
});

// The helper being right proves nothing about the tool using it. These drive the
// REAL panel_set_todo handler and assert on what reached the wire.
describe("#1018: the tool accepts the aliases and sends only canonical values", () => {
  let sent: Array<Record<string, unknown>>;
  let ctx: PanelToolCtx;

  beforeEach(() => {
    __resetTodoState();
    sent = [];
    const bridge = {
      send: async (cmd: Record<string, unknown>) => {
        sent.push(cmd);
        return { ok: true };
      },
      push: () => 1,
      canReach: () => true,
      isHeadless: () => false,
      tabs: () => [{ tab_id: "tab-1", title: "wf", connected_at: 0 }],
      resolveActiveTabId: () => "tab-1",
    } as unknown as PanelToolCtx["bridge"];
    ctx = makePanelToolCtx(bridge, "tab-1");
  });

  const setTodo = () => buildPanelToolDefs().find((d) => d.name === "panel_set_todo")!;

  it("accepts the exact payload from the report instead of failing validation", async () => {
    const res = await setTodo().handler(
      {
        items: [
          { text: "read the code", status: "completed" },
          { text: "write the fix", status: "in_progress" },
          { text: "run the tests", status: "pending" },
        ],
      },
      ctx,
    );
    expect(res.isError).toBeFalsy();
    expect(sent).toHaveLength(1);
    expect(sent[0].items).toEqual([
      { text: "read the code", status: "done" },
      { text: "write the fix", status: "active" },
      { text: "run the tests", status: "pending" },
    ]);
  });

  // The panel renders these; a raw `in_progress` would either not match its
  // styling or be shown verbatim. Canonical-only on the wire is the contract.
  it("never puts an alias on the wire", async () => {
    await setTodo().handler({ items: [{ text: "a", status: "in-progress" }] }, ctx);
    expect(JSON.stringify(sent[0].items)).not.toContain("in-progress");
  });

  // #977's snapshot feeds the completion-directive logic, which compares against
  // the canonical names. An alias stored here would silently break that — and
  // `planInFlight` alone cannot catch it, since an unrecognised status counts as
  // not-done either way. Assert the stored values themselves.
  it("records the canonical form in the orchestrator's own snapshot", async () => {
    await setTodo().handler(
      {
        items: [
          { text: "a", status: "completed" },
          { text: "b", status: "in_progress" },
        ],
      },
      ctx,
    );
    expect(todoFor("tab-1")?.items).toEqual([
      { text: "a", status: "done" },
      { text: "b", status: "active" },
    ]);
    // …and the derived signal still reads correctly: one step is still active.
    expect(planInFlight("tab-1")).toBe(true);
  });

  // The inverse: an all-done list must NOT read as a plan in flight. If an alias
  // reached the snapshot, "completed" would not match "done" and this would
  // wrongly say a sweep is still running.
  it("an all-done list written with aliases is not reported as in flight", async () => {
    await setTodo().handler(
      {
        items: [
          { text: "a", status: "completed" },
          { text: "b", status: "finished" },
        ],
      },
      ctx,
    );
    expect(planInFlight("tab-1")).toBe(false);
  });

  it("still works for a caller that used the canonical values all along", async () => {
    await setTodo().handler({ items: [{ text: "a", status: "active" }] }, ctx);
    expect(sent[0].items).toEqual([{ text: "a", status: "active" }]);
  });

  it("still clears the tray on an empty array", async () => {
    await setTodo().handler({ items: [] }, ctx);
    expect(sent[0].items).toEqual([]);
  });
});
