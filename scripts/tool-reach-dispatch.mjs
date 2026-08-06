// The interception policy — the single choke point between a model's tool
// choice and anything that could happen as a result.
//
// ══ THE ONE RULE ═══════════════════════════════════════════════════════════
// NOTHING THE MODEL PICKS IS EXECUTED.
//
// Not an optimisation — it is what makes the benchmark possible. The surface
// under test can delete multi-GB checkpoints, uninstall node packs, rent cloud
// GPUs (real money), stop and restart the server, drop the GPU cache, and file
// real GitHub issues, against a SHARED ComfyUI with unrelated unsaved tabs open.
// A benchmark that runs what the model picks is a benchmark that files garbage
// issues and deletes checkpoints.
//
// The guarantee is structural, not a filter. `navigate` is INJECTED and is the
// only way out of this module; the two names allowed to use it are hard-coded
// here, and every other name — including anything routed through `call_tool` —
// is recorded and answered with a stub. There is no branch that forwards an
// application tool, so "we remembered to block the dangerous ones" is not a
// thing that can be got wrong. `tool-reach-dispatch.test.ts` asserts it by
// firing every destructive name on the surface through this and asserting the
// injected escape hatch is never touched.
//
// It lives apart from the runner so it can be tested without booting a tool
// registration, and so BOTH transports (the chat-completions loop and the MCP
// stub server that Claude Code talks to) share one policy. Two transports with
// two policies would eventually score two different things.

/** The only names permitted to reach real code, and only in compact mode.
 *  Both are pure reads over an already-built in-memory catalog. */
export const NAVIGATION_TOOLS = Object.freeze(["list_tools", "describe_tool"]);

/**
 * What the model is told after a recorded call.
 *
 * Deliberately transparent rather than a fabricated success or a fabricated
 * error. A fake success ends the episode immediately and makes reach-within-N
 * unmeasurable; a fake error pushes the model to hunt for alternatives and
 * biases the same metric the other way. Saying plainly that nothing ran, and
 * inviting either another tool or a final answer, is the least directive option
 * — and it is IDENTICAL across all three arms, so whatever bias it carries is
 * carried equally.
 */
export const STUB_CONTINUE =
  "[harness] Your tool selection has been recorded. This environment does not execute tools, " +
  "so there is no result to report back. If a different tool would serve the request better, " +
  "call it; otherwise give your final answer now.";
export const STUB_STOP =
  "[harness] Your tool selection has been recorded. This environment does not execute tools. " +
  "Do not call any more tools — give your final answer now.";

/** An `action` argument, read without inventing one. */
export function actionOf(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return null;
  return typeof args.action === "string" ? args.action : null;
}

/**
 * Coerce a tool-call argument blob to an object.
 *
 * Small models routinely send arguments as a JSON-encoded STRING, and the real
 * `call_tool` accepts that (src/tools/compact.ts), so the benchmark must too —
 * otherwise a model that reached correctly but stringified its arguments is
 * recorded as reaching for nothing, and the arms with more arguments to get
 * wrong are penalised for a harness artefact.
 */
export function parseMaybeJson(v) {
  if (typeof v === "string") {
    if (!v.trim()) return {};
    try {
      const p = JSON.parse(v);
      return p && typeof p === "object" && !Array.isArray(p) ? p : {};
    } catch {
      return {};
    }
  }
  if (v && typeof v === "object" && !Array.isArray(v)) return v;
  return {};
}

/**
 * Build the dispatcher for one arm.
 *
 * @param {object} o
 * @param {"full"|"compact"} o.mode
 * @param {string[]} o.catalogNames names behind `call_tool` in compact mode
 * @param {number} o.reachWindow substantive calls after which the stub says stop
 * @param {(tool: string, args: object) => Promise<string>} [o.navigate]
 *   THE only escape hatch, and only ever called with a NAVIGATION_TOOLS name.
 *   Absent in flat mode, where there is no catalog to navigate.
 * @returns {(ep: object, name: string, rawArgs: unknown) => Promise<string>}
 */
export function createDispatcher({ mode, catalogNames, reachWindow, navigate }) {
  const catalog = new Set(catalogNames ?? []);

  return async function dispatch(ep, name, rawArgs) {
    const args = parseMaybeJson(rawArgs);

    const doNavigate = async (toolName, toolArgs) => {
      ep.navigation++;
      // Navigation only costs the model something if it happens BEFORE it has
      // reached — looking a tool up after picking it is not a search.
      if (ep.substantive.length === 0) ep.navBeforeFirst++;
      if (!navigate) return `Unknown tool: ${toolName}`;
      return navigate(toolName, toolArgs);
    };

    const record = (tool, action) => {
      ep.substantive.push({ tool, action });
      return ep.substantive.length >= reachWindow ? STUB_STOP : STUB_CONTINUE;
    };

    if (mode === "compact") {
      if (NAVIGATION_TOOLS.includes(name)) return doNavigate(name, args);
      if (name === "call_tool") {
        const inner = args.name ?? args.tool_name;
        const innerName = typeof inner === "string" ? inner : "";
        const innerArgs = parseMaybeJson(args.args ?? args.arguments);
        // compact.ts routes list_tools/describe_tool through call_tool as well
        // (#693) when the catalog holds no tool of that name. Same
        // control-plane operation, same navigation cost — scoring it as a reach
        // would fabricate misses on the arm whose whole cost model is
        // navigation. The catalog check mirrors the real guard: in full mode a
        // user workflow may legitimately own the name and win the registry.
        if (NAVIGATION_TOOLS.includes(innerName) && !catalog.has(innerName)) {
          return doNavigate(innerName, innerArgs);
        }
        if (!innerName) {
          return 'Missing tool name. Call as: call_tool {"name": "<tool>", "args": {...}}';
        }
        return record(innerName, actionOf(innerArgs));
      }
      return `Unknown tool: ${name}. This server exposes list_tools, describe_tool and call_tool.`;
    }

    // Flat arm: there is no catalog to navigate, so every call is a reach. That
    // structural zero for navigation cost is a RESULT, not a gap — it is
    // precisely what the compact arm pays and the flat arms do not.
    return record(name, actionOf(args));
  };
}
