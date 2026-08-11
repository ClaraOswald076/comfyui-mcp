/**
 * #873 — OPERATOR-LEVEL RESTRICTION OF THE TOOL SURFACE.
 *
 * Reported from a Docker Compose + Open WebUI deployment behind llama-swap, where the
 * operator is NOT the person prompting. That is a different trust model from the one the
 * rest of this codebase assumes: locally, operator and prompter are the same person and a
 * tool filter would be theatre. In a shared frontend the operator needs to guarantee the
 * model cannot reach install/delete/restart tools whatever a user types.
 *
 * WHAT THIS IS AND IS NOT. It is a boundary against the MODEL and the people prompting
 * it. It is not a boundary against whoever sets the environment — they can unset it — and
 * it is not a substitute for not handing an untrusted party the ComfyUI host. Saying that
 * plainly matters, because an operator who believes this is more than it is will deploy
 * something they should not.
 *
 * Compact mode narrows DISCOVERY and is explicitly not a boundary: `call_tool` dispatches
 * by name, so a filter applied only to the registered list leaves the facade as a bypass.
 * This is applied as a registrar decorator, in the same position as the blind-image gate,
 * which both `registerAllTools` and `collectToolCatalog` already run — and `call_tool`
 * dispatches through that catalog. So both routes are covered by construction rather than
 * by remembering to cover them.
 */

/**
 * Tools that change the machine, the model library, or the running server.
 *
 * A NAME NO LONGER TELLS YOU WHAT A TOOL CAN DO (codex, P1). The 0.50.0 consolidation
 * folded destructive actions into tools that read as inspection:
 *
 *   list_local_models   action:"remove" deletes a model file; add_path/remove_path
 *                       rewrite extra_model_paths.yaml
 *   search_custom_nodes action:"install" installs a node pack
 *   get_defaults        action:"set" writes persistent config
 *   queue               action:"clear"/"cancel" destroys work — someone else's, in the
 *                       shared deployment this feature exists for
 *
 * My first list was written from the names and missed every one of those. Since the
 * filter is per-TOOL and cannot see actions, the rule is: deny the whole tool when ANY of
 * its actions violates the preset. That costs `safe` some genuinely useful reads, and
 * that is the correct trade — an operator who thinks deletion is impossible and is wrong
 * is worse off than one who has to allow a tool back explicitly.
 *
 * Per-action policy is the real answer and is deliberately not attempted here; it needs a
 * vocabulary these tools do not yet expose uniformly.
 */
const MUTATING_TOOLS = [
  "install_comfyui",
  "install_custom_node",
  "download_model",
  "node_pack",
  "node_snapshot",
  "restart_comfyui",
  "clear_vram",
  "apply_manifest",
  "comfy_cli",
  "runpod",
  "runpod_watch",
  "train_start",
  "train_prepare_dataset",
  "train_doctor",
  "workspace",
  "save_workflow",
  "create_workflow",
  "upload_image",
  "bisect",
  // …the consolidated ones a name-based list misses:
  "list_local_models",
  "search_custom_nodes",
  "get_defaults",
  "queue",
];

/** …plus everything that queues work or spends money. */
const EXECUTION_TOOLS = [
  "generate_image",
  "enqueue_workflow",
  "batch",
  "apps",
  "list_api_nodes",
];

/**
 * Action names that mean a tool can change something. Used ONLY by the completeness test,
 * which scans the live catalog and fails when a tool advertising one of these is missing
 * from the `safe` deny list.
 *
 * The hand-written list above stays hand-written — it is auditable, and an operator can
 * read it. What this adds is that it cannot silently ROT: the next consolidation that
 * hides `action:"delete"` behind an inspection-sounding name fails a test instead of
 * quietly widening every deployment's surface.
 */
export const MUTATING_ACTION_NAMES =
  /^(remove|delete|clear|cancel|uninstall|install|reset|kill|stop|restart|purge|prune|apply|create|upload|train|add_path|remove_path|set|save|write|switch|update|fix|disable|enable)$/i;

/**
 * Verbs that mean "queue work / spend", which `safe` deliberately ALLOWS — rendering is
 * the point of the product — and only `readonly` withholds. Kept separate so the
 * completeness check does not flag `enqueue_workflow` as a hole in `safe`.
 */
export const EXECUTION_ACTION_NAMES = /^(enqueue|start|submit|run)$/i;

/**
 * Extract the actions a tool declares for ITSELF, from its description.
 *
 * Cross-references are excluded, and that is not a detail: `generate_image`'s description
 * mentions `get_defaults (action:"set")` while explaining where defaults come from. A
 * naive scan reads that as generate_image having a `set` action and reports a hole that
 * does not exist. A completeness check that cries wolf gets muted, and then it is not a
 * check.
 */
export function declaredActions(description: string): string[] {
  const withoutCrossRefs = description.replace(/\b[a-z_0-9]+\s*\(action:"[a-z_0-9]+"\)/gi, "");
  return [...new Set([...withoutCrossRefs.matchAll(/action:"([a-z_0-9]+)"/g)].map((m) => m[1]))];
}

/**
 * Named presets, so an operator is not hand-maintaining a list against a surface that
 * grows every release — the reason a hand-written denylist rots.
 *
 * `safe`     — everything except tools that change the machine or the model library.
 *              Rendering still works; installing, deleting and restarting do not.
 * `readonly` — inspection only. No renders queued, nothing written, nothing spent.
 */
/**
 * THE PANEL SURFACE IS DENIED WHOLESALE BY BOTH PRESETS (codex, P0).
 *
 * `registerPanelTools` registers 91 `panel_*` tools through a different method
 * (`registerTool`) on a separate server, so they bypassed the filter entirely: under
 * `readonly`, `panel_run` still queued renders. That is the "a filter with a hole is
 * worse than none" case — the operator is told the surface is restricted and it is not.
 *
 * Denied as a FAMILY rather than tool-by-tool, deliberately. I classified those 91 by
 * name first and got several wrong in both directions (`panel_set_property`,
 * `panel_move_node`, `panel_add_subgraph` and `panel_update_node` all mutate and none
 * match an obvious write-ish pattern). A hand list over a surface that grows every
 * release is the rot this feature already tripped over once. `panel_*` is also exactly
 * what a hosted operator would withhold: it drives a live canvas their users share.
 *
 * Opt back in explicitly — `COMFYUI_MCP_TOOL_ALLOW=panel_graph_outline,panel_query_graph`
 * — which is the direction that fails safe when someone forgets one.
 */
const PANEL_SURFACE = ["panel_*"];

export const TOOL_PRESETS: Record<string, string[]> = {
  safe: [...MUTATING_TOOLS, ...PANEL_SURFACE],
  readonly: [...MUTATING_TOOLS, ...EXECUTION_TOOLS, ...PANEL_SURFACE],
};

export interface ToolSurfacePolicy {
  /** Explicit allow list. When non-empty, ONLY these may register. */
  allow: string[];
  /** Deny list, including any preset expansion. */
  deny: string[];
  /** True when the operator configured anything at all. */
  active: boolean;
  /** The preset name, when one was named — for disclosure in logs. */
  preset?: string;
}

function splitList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Does `name` match `pattern`? Exact, or a trailing `*` glob (`train_*`).
 *
 * Deliberately not a full glob: an operator writing a denylist is naming tools, and a
 * richer syntax buys expressiveness at the cost of a rule that quietly matches more than
 * it reads like. Prefix globs cover the real grouping in this surface (`train_*`,
 * `runpod*`) and cannot surprise anyone.
 */
export function toolMatches(name: string, pattern: string): boolean {
  if (pattern === name) return true;
  if (pattern.endsWith("*")) return name.startsWith(pattern.slice(0, -1));
  return false;
}

/**
 * Read the policy from the environment.
 *
 * AN UNKNOWN PRESET THROWS (codex, P0). The first version resolved a typo — `saef` for
 * `safe` — to no rules at all, which made `active` false, which meant the decorator
 * returned the registrar unwrapped AND the "surface restricted" log never fired. The
 * server came up with its complete tool surface and said nothing, while the operator
 * believed they had locked it down. Worse, I had written a test asserting exactly that
 * and called it correct, on the reasoning that "the log will tell them" — the log is
 * gated on the same flag.
 *
 * For a control whose whole purpose is a guarantee, silence on a misconfiguration is the
 * one unacceptable outcome. Refusing to start is loud, immediate, and cannot be mistaken
 * for success.
 */
export function resolveToolSurfacePolicy(env: NodeJS.ProcessEnv = process.env): ToolSurfacePolicy {
  const allow = splitList(env.COMFYUI_MCP_TOOL_ALLOW);
  const denyRaw = splitList(env.COMFYUI_MCP_TOOL_DENY);
  const presetName = (env.COMFYUI_MCP_TOOL_PRESET ?? "").trim();
  if (presetName && !Object.prototype.hasOwnProperty.call(TOOL_PRESETS, presetName)) {
    throw new Error(
      `COMFYUI_MCP_TOOL_PRESET="${presetName}" is not a known preset. ` +
        `Valid presets: ${Object.keys(TOOL_PRESETS).join(", ")}. ` +
        `Refusing to start: continuing would expose the FULL tool surface while you believe ` +
        `it is restricted, which is worse than no filter at all. Fix the value, or drop the ` +
        `variable and use COMFYUI_MCP_TOOL_DENY / COMFYUI_MCP_TOOL_ALLOW directly.`,
    );
  }
  const preset = presetName ? TOOL_PRESETS[presetName] : undefined;
  const deny = [...(preset ?? []), ...denyRaw];
  return {
    allow,
    deny,
    active: allow.length > 0 || deny.length > 0,
    ...(preset ? { preset: presetName } : {}),
  };
}

/**
 * Is this tool permitted?
 *
 * ALLOW WINS, and is absolute when present: naming an allow list is a statement that the
 * surface is exactly those tools, so a name absent from it is denied even if no deny rule
 * mentions it. That is the safer reading of an operator's intent — the alternative (allow
 * as a mere exemption from deny) turns an incomplete list into a wide-open surface, which
 * is the failure mode nobody notices until it matters.
 */
export function toolAllowed(name: string, policy: ToolSurfacePolicy): boolean {
  if (policy.allow.length > 0) return policy.allow.some((p) => toolMatches(name, p));
  return !policy.deny.some((p) => toolMatches(name, p));
}

/**
 * The three facade tools are NEVER filtered.
 *
 * Removing `call_tool` from a compact-mode surface leaves a client with no way to reach
 * ANY tool — the filter would read as "restrict the surface" and behave as "break the
 * server". The facade is a router; what it can route to is already governed by the same
 * policy through the shared catalog, so exempting it grants nothing.
 */
const FACADE_TOOLS = new Set(["list_tools", "describe_tool", "call_tool"]);

/**
 * Wrap a registrar so denied tools are never registered.
 *
 * Denied names are ABSENT rather than erroring on call: a tool that refuses is still a
 * tool the model can see, reason about and keep retrying. Absent means it never learns
 * the capability exists, which is what the reporter asked for and also the cheaper
 * outcome in tokens.
 */
export function withToolSurfaceFilter<T extends object>(
  server: T,
  policy: ToolSurfacePolicy,
  onFiltered?: (name: string) => void,
): T {
  if (!policy.active) return server;
  const orig = (server as unknown as { tool: (...args: unknown[]) => unknown }).tool.bind(server);
  const tool = (...args: unknown[]): unknown => {
    const name = typeof args[0] === "string" ? args[0] : undefined;
    if (name && !FACADE_TOOLS.has(name) && !toolAllowed(name, policy)) {
      onFiltered?.(name);
      // Registration is skipped entirely. The SDK's `tool()` returns a handle some
      // callers chain on, so hand back something inert rather than undefined.
      return { name, disabled: true } as unknown;
    }
    return orig(...args);
  };
  return new Proxy(server, {
    get(target, prop, receiver) {
      if (prop === "tool") return tool;
      return Reflect.get(target, prop, receiver);
    },
  }) as T;
}
