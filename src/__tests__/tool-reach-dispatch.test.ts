/**
 * THE ONE RULE, under test: nothing the model picks is executed.
 *
 * The benchmark advertises the real tool surface — which can delete multi-GB
 * checkpoints, uninstall node packs, rent paid cloud GPUs, stop the ComfyUI
 * server, drop the GPU cache and file real GitHub issues — against a SHARED
 * ComfyUI with unrelated unsaved tabs open. The guarantee that none of that
 * happens rests entirely on `createDispatcher`, so it is asserted here rather
 * than trusted.
 *
 * The escape hatch is injected, which is what makes this provable: the spy below
 * FAILS THE TEST if it is ever reached with anything but a catalog read. A
 * denylist ("we blocked the dangerous ones") could not be tested this way,
 * because the interesting case is always the name nobody thought of.
 */
import { describe, expect, it, vi } from "vitest";
// @ts-expect-error — plain-JS benchmark module, deliberately untyped
import {
  NAVIGATION_TOOLS,
  STUB_CONTINUE,
  STUB_STOP,
  actionOf,
  createDispatcher,
  parseMaybeJson,
} from "../../scripts/tool-reach-dispatch.mjs";
// @ts-expect-error — plain-JS benchmark module, deliberately untyped
import { FOLD_MAP } from "../../scripts/tool-reach-foldmap.mjs";

const REACH_WINDOW = 3;
const CATALOG = Object.keys(FOLD_MAP as Record<string, unknown>);

const newEpisode = () => ({ substantive: [], navigation: 0, navBeforeFirst: 0 });

/** A `navigate` that fails the test the moment it is asked to run anything that
 *  is not one of the two permitted catalog reads. */
function guardedNavigate() {
  return vi.fn(async (tool: string) => {
    if (!NAVIGATION_TOOLS.includes(tool)) {
      throw new Error(`EXECUTION ESCAPED THE STUB: navigate("${tool}")`);
    }
    return `catalog text for ${tool}`;
  });
}

/** Everything on the surface that costs money, deletes data, or has real-world
 *  side effects — the names that make "do not execute" load-bearing. */
const DESTRUCTIVE = [
  "remove_model",
  "uninstall_custom_node",
  "train_delete_job",
  "train_dataset_delete",
  "runpod_pod_create",
  "runpod_pod_start",
  "runpod_pod_stop",
  "stop_comfyui",
  "restart_comfyui",
  "clear_vram",
  "report_issue",
  "publish_custom_node",
  "write_node_file",
  "apply_node_patch",
  "node_pack_git",
  "save_workflow",
  "install_comfyui",
  "self_update",
  "generate_image",
  "enqueue_workflow",
];

describe("flat arm — no wire to anything", () => {
  it("records every destructive call and executes none of them", async () => {
    const navigate = guardedNavigate();
    const dispatch = createDispatcher({ mode: "full", catalogNames: CATALOG, reachWindow: 999, navigate });
    const ep = newEpisode();
    for (const name of DESTRUCTIVE) {
      const text = await dispatch(ep, name, { model_name: "x", confirm: true, force: true });
      expect(text).toBe(STUB_CONTINUE);
    }
    expect(navigate).not.toHaveBeenCalled();
    expect(ep.substantive.map((r: { tool: string }) => r.tool)).toEqual(DESTRUCTIVE);
    expect(ep.navigation).toBe(0);
  });

  it("passes NO navigate at all in flat mode, so the module has no route out", async () => {
    // The runner binds `navigate` only in compact mode. Without it, even the
    // catalog names have nowhere to go.
    const dispatch = createDispatcher({ mode: "full", catalogNames: CATALOG, reachWindow: 3 });
    const ep = newEpisode();
    await dispatch(ep, "list_tools", {});
    expect(ep.substantive).toEqual([{ tool: "list_tools", action: null }]);
    expect(ep.navigation).toBe(0);
  });
});

describe("compact arm — the allowlist is exactly two names", () => {
  const make = (navigate = guardedNavigate()) => ({
    navigate,
    dispatch: createDispatcher({ mode: "compact", catalogNames: CATALOG, reachWindow: REACH_WINDOW, navigate }),
  });

  it("executes list_tools and describe_tool, and counts them as navigation not reach", async () => {
    const { dispatch, navigate } = make();
    const ep = newEpisode();
    expect(await dispatch(ep, "list_tools", {})).toBe("catalog text for list_tools");
    expect(await dispatch(ep, "describe_tool", { name: "remove_model" })).toBe(
      "catalog text for describe_tool",
    );
    expect(navigate).toHaveBeenCalledTimes(2);
    expect(ep.substantive).toEqual([]);
    expect(ep.navigation).toBe(2);
    expect(ep.navBeforeFirst).toBe(2);
  });

  it("does NOT execute anything routed through call_tool, however it is spelled", async () => {
    // Window deliberately wide: this is about execution, not about when the
    // stub starts saying "stop".
    const navigate = guardedNavigate();
    const dispatch = createDispatcher({
      mode: "compact",
      catalogNames: CATALOG,
      reachWindow: 999,
      navigate,
    });
    const ep = newEpisode();
    const spellings = [
      { name: "remove_model", args: { model_name: "sdxl.safetensors" } },
      { tool_name: "uninstall_custom_node", arguments: { pack: "x" } },
      { name: "runpod_pod_create", args: '{"gpu":"4090"}' }, // JSON-string args
      { name: "report_issue", args: { title: "t", body: "b" } },
    ];
    for (const s of spellings) expect(await dispatch(ep, "call_tool", s)).toBe(STUB_CONTINUE);
    expect(navigate).not.toHaveBeenCalled();
    expect(ep.substantive.map((r: { tool: string }) => r.tool)).toEqual([
      "remove_model",
      "uninstall_custom_node",
      "runpod_pod_create",
      "report_issue",
    ]);
  });

  it("treats the call_tool→list_tools facade route (#693) as navigation, not a reach", async () => {
    // src/tools/compact.ts routes these two through call_tool when the catalog
    // has no tool of that name. Scoring them as reaches would fabricate misses
    // on the one arm whose entire cost model is navigation.
    const { dispatch, navigate } = make();
    const ep = newEpisode();
    await dispatch(ep, "call_tool", { name: "list_tools", args: { search: "video" } });
    await dispatch(ep, "call_tool", { name: "describe_tool", args: { name: "generate_video" } });
    expect(navigate).toHaveBeenCalledTimes(2);
    expect(ep.substantive).toEqual([]);
  });

  it("…but NOT when the catalog genuinely owns that name", async () => {
    // Mirrors the real guard: in full mode a user's autoloaded workflow can
    // legitimately claim the name and win the registry, and then it IS a tool.
    const navigate = guardedNavigate();
    const dispatch = createDispatcher({
      mode: "compact",
      catalogNames: [...CATALOG, "list_tools"],
      reachWindow: REACH_WINDOW,
      navigate,
    });
    const ep = newEpisode();
    await dispatch(ep, "call_tool", { name: "list_tools", args: {} });
    expect(navigate).not.toHaveBeenCalled();
    expect(ep.substantive).toEqual([{ tool: "list_tools", action: null }]);
  });

  it("rejects an unknown meta-tool without executing it", async () => {
    const { dispatch, navigate } = make();
    const ep = newEpisode();
    const text = await dispatch(ep, "remove_model", { model_name: "x" });
    expect(text).toMatch(/Unknown tool: remove_model/);
    expect(navigate).not.toHaveBeenCalled();
    expect(ep.substantive).toEqual([]);
  });
});

describe("recording fidelity", () => {
  it("records the action so the consolidated arm can be scored on it", async () => {
    const dispatch = createDispatcher({ mode: "full", catalogNames: CATALOG, reachWindow: 999 });
    const ep = newEpisode();
    await dispatch(ep, "generate_image", { action: "video", prompt: "a boat" });
    await dispatch(ep, "generate_image", { prompt: "a boat" });
    expect(ep.substantive).toEqual([
      { tool: "generate_image", action: "video" },
      { tool: "generate_image", action: null },
    ]);
  });

  it("accepts JSON-STRING arguments, as the real call_tool does", async () => {
    // Small models routinely stringify their arguments. Dropping those would
    // record a correct reach as no reach, and would do it unevenly across arms.
    expect(parseMaybeJson('{"action":"video"}')).toEqual({ action: "video" });
    expect(actionOf(parseMaybeJson('{"action":"video"}'))).toBe("video");
    expect(parseMaybeJson("not json")).toEqual({});
    expect(parseMaybeJson(["a"])).toEqual({});
    expect(actionOf({ action: 7 })).toBe(null);
  });

  it("switches the stub to STOP once the reach window is full", async () => {
    const dispatch = createDispatcher({ mode: "full", catalogNames: CATALOG, reachWindow: REACH_WINDOW });
    const ep = newEpisode();
    expect(await dispatch(ep, "get_history", {})).toBe(STUB_CONTINUE);
    expect(await dispatch(ep, "get_logs", {})).toBe(STUB_CONTINUE);
    expect(await dispatch(ep, "health_check", {})).toBe(STUB_STOP);
  });

  it("counts navigation AFTER a reach separately from navigation before it", async () => {
    // Looking a tool up after choosing it is not a search, and charging it to
    // the compact arm's navigation cost would overstate the very thing the
    // consolidation is being compared against.
    const navigate = guardedNavigate();
    const dispatch = createDispatcher({ mode: "compact", catalogNames: CATALOG, reachWindow: 999, navigate });
    const ep = newEpisode();
    await dispatch(ep, "list_tools", {});
    await dispatch(ep, "call_tool", { name: "get_history", args: {} });
    await dispatch(ep, "describe_tool", { name: "get_logs" });
    expect(ep.navBeforeFirst).toBe(1);
    expect(ep.navigation).toBe(2);
  });

  it("does not invent a reach when call_tool omits the tool name", async () => {
    const dispatch = createDispatcher({ mode: "compact", catalogNames: CATALOG, reachWindow: 3, navigate: guardedNavigate() });
    const ep = newEpisode();
    const text = await dispatch(ep, "call_tool", { args: { prompt: "x" } });
    expect(text).toMatch(/Missing tool name/);
    expect(ep.substantive).toEqual([]);
  });
});
