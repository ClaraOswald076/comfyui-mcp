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

/** Tools that change the machine, the model library, or the running server. */
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
];

/** …plus everything that queues work or spends money. */
const EXECUTION_TOOLS = [
  "generate_image",
  "enqueue_workflow",
  "batch",
  "queue",
  "apps",
  "list_api_nodes",
];

/**
 * Named presets, so an operator is not hand-maintaining a list against a surface that
 * grows every release — the reason a hand-written denylist rots.
 *
 * `safe`     — everything except tools that change the machine or the model library.
 *              Rendering still works; installing, deleting and restarting do not.
 * `readonly` — inspection only. No renders queued, nothing written, nothing spent.
 */
export const TOOL_PRESETS: Record<string, string[]> = {
  safe: MUTATING_TOOLS,
  readonly: [...MUTATING_TOOLS, ...EXECUTION_TOOLS],
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

/** Read the policy from the environment. */
export function resolveToolSurfacePolicy(env: NodeJS.ProcessEnv = process.env): ToolSurfacePolicy {
  const allow = splitList(env.COMFYUI_MCP_TOOL_ALLOW);
  const denyRaw = splitList(env.COMFYUI_MCP_TOOL_DENY);
  const presetName = (env.COMFYUI_MCP_TOOL_PRESET ?? "").trim();
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
