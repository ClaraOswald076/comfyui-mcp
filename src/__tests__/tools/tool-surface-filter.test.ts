// #873 — an operator needs to guarantee the model cannot reach install/delete/restart
// tools, whatever a user types.
//
// Reported from a Docker Compose + Open WebUI deployment behind llama-swap, where the
// operator is NOT the person prompting. That is a different trust model from the local
// one this codebase otherwise assumes, and it is why the request is worth building: with
// one machine and one person a tool filter is theatre; with a shared frontend it is the
// difference between shipping and not.
//
// THE BYPASS IS THE POINT. Compact mode narrows discovery but is explicitly not a
// boundary — `call_tool` dispatches by name. A filter applied only to the registered list
// would leave the facade wide open, and the report says so directly. Both paths run the
// same registrar decorator, and the tests below check BOTH, because "I filtered the
// registration" is exactly the fix that looks complete and is not.

import { describe, expect, it } from "vitest";

import {
  resolveToolSurfacePolicy,
  toolAllowed,
  toolMatches,
  TOOL_PRESETS,
  MUTATING_ACTION_NAMES,
  declaredActions,
  withToolSurfaceFilter,
} from "../../tools/tool-surface-filter.js";

/** A minimal stand-in for the SDK registrar: records what actually got registered. */
function recordingRegistrar() {
  const registered: string[] = [];
  return {
    registrar: { tool: (name: string) => registered.push(name) },
    registered,
  };
}

describe("the operator's policy is read from the environment (#873)", () => {
  it("is INACTIVE by default — a local install is unchanged", () => {
    const p = resolveToolSurfacePolicy({});
    expect(p.active).toBe(false);
    // And an inactive policy must not wrap: every tool registers.
    const { registrar, registered } = recordingRegistrar();
    const wrapped = withToolSurfaceFilter(registrar, p);
    wrapped.tool("restart_comfyui");
    expect(registered).toEqual(["restart_comfyui"]);
  });

  it("reads deny, allow and a preset", () => {
    expect(resolveToolSurfacePolicy({ COMFYUI_MCP_TOOL_DENY: "a, b ,c" }).deny).toEqual(["a", "b", "c"]);
    expect(resolveToolSurfacePolicy({ COMFYUI_MCP_TOOL_ALLOW: "x" }).allow).toEqual(["x"]);
    const preset = resolveToolSurfacePolicy({ COMFYUI_MCP_TOOL_PRESET: "safe" });
    expect(preset.preset).toBe("safe");
    expect(preset.deny).toContain("restart_comfyui");
  });

  it("an UNKNOWN preset REFUSES TO START rather than failing open (codex P0)", () => {
    // I got this wrong first time and wrote a test asserting the broken behaviour.
    // `saef` resolved to no rules → `active` false → the decorator returned the
    // registrar unwrapped AND the "surface restricted" log, gated on the same flag,
    // never fired. The server came up with its FULL surface, silently, while the
    // operator believed it was locked down. My justification at the time — "the log
    // tells them" — was false about my own code.
    //
    // For a control whose entire purpose is a guarantee, silence on misconfiguration is
    // the one unacceptable outcome.
    expect(() => resolveToolSurfacePolicy({ COMFYUI_MCP_TOOL_PRESET: "saef" })).toThrow(
      /is not a known preset/,
    );
    expect(() => resolveToolSurfacePolicy({ COMFYUI_MCP_TOOL_PRESET: "saef" })).toThrow(
      /Refusing to start/,
    );
  });
});

describe("allow wins, and is absolute (#873)", () => {
  it("an allow list makes the surface EXACTLY those tools", () => {
    // The alternative reading — allow as a mere exemption from deny — turns an
    // incomplete list into a wide-open surface, which nobody notices until it matters.
    const p = resolveToolSurfacePolicy({ COMFYUI_MCP_TOOL_ALLOW: "generate_image,queue" });
    expect(toolAllowed("generate_image", p)).toBe(true);
    expect(toolAllowed("queue", p)).toBe(true);
    // Never mentioned by any rule — still denied.
    expect(toolAllowed("restart_comfyui", p)).toBe(false);
    expect(toolAllowed("download_model", p)).toBe(false);
  });

  it("deny works on its own", () => {
    const p = resolveToolSurfacePolicy({ COMFYUI_MCP_TOOL_DENY: "restart_comfyui" });
    expect(toolAllowed("restart_comfyui", p)).toBe(false);
    expect(toolAllowed("generate_image", p)).toBe(true);
  });

  it("a prefix glob groups a family, and does not match more than it reads like", () => {
    expect(toolMatches("train_start", "train_*")).toBe(true);
    expect(toolMatches("train_doctor", "train_*")).toBe(true);
    expect(toolMatches("generate_image", "train_*")).toBe(false);
    // Not a full glob — a mid-string wildcard is NOT silently honoured, because a rule
    // that matches more than it reads like is worse than one that matches nothing.
    expect(toolMatches("generate_image", "gen*image")).toBe(false);
  });
});

describe("a denied tool is ABSENT, not refusing (#873)", () => {
  it("never registers, so the model never learns it exists", () => {
    const p = resolveToolSurfacePolicy({ COMFYUI_MCP_TOOL_PRESET: "safe" });
    const { registrar, registered } = recordingRegistrar();
    const wrapped = withToolSurfaceFilter(registrar, p);

    wrapped.tool("generate_image");
    wrapped.tool("restart_comfyui");
    wrapped.tool("download_model");

    expect(registered).toEqual(["generate_image"]);
  });

  it("the FACADE is never filtered — restricting must not mean breaking", () => {
    // Removing call_tool from a compact surface leaves a client unable to reach ANY
    // tool. The facade only routes; what it can route to is governed by the same policy
    // through the shared catalog, so exempting it grants nothing.
    const p = resolveToolSurfacePolicy({ COMFYUI_MCP_TOOL_ALLOW: "nothing_matches" });
    const { registrar, registered } = recordingRegistrar();
    const wrapped = withToolSurfaceFilter(registrar, p);

    for (const n of ["list_tools", "describe_tool", "call_tool", "generate_image"]) wrapped.tool(n);

    expect(registered).toEqual(["list_tools", "describe_tool", "call_tool"]);
  });

  it("readonly withholds execution as well as mutation", () => {
    const p = resolveToolSurfacePolicy({ COMFYUI_MCP_TOOL_PRESET: "readonly" });
    expect(toolAllowed("generate_image", p)).toBe(false);
    expect(toolAllowed("enqueue_workflow", p)).toBe(false);
    expect(toolAllowed("restart_comfyui", p)).toBe(false);
    // …but inspection still works, or the preset would be useless.
    //
    // This used to assert `list_local_models` was allowed — a tool whose action:"remove"
    // DELETES a model file. The assertion was wrong before the preset was, and it read
    // as reassurance. Use tools that genuinely only read.
    expect(toolAllowed("get_history", p)).toBe(true);
    expect(toolAllowed("get_system_stats", p)).toBe(true);
  });

  it("safe keeps rendering while withholding machine changes", () => {
    const p = resolveToolSurfacePolicy({ COMFYUI_MCP_TOOL_PRESET: "safe" });
    expect(toolAllowed("generate_image", p)).toBe(true);
    expect(toolAllowed("restart_comfyui", p)).toBe(false);
    expect(toolAllowed("install_custom_node", p)).toBe(false);
  });

  it("the presets name only tools that exist", async () => {
    // A preset naming a renamed tool protects nothing while reading as though it does —
    // the 0.50.0 consolidation renamed a great many, and this is the check that keeps a
    // hardcoded list honest against the live surface.
    const { collectToolCatalog } = await import("../../tools/index.js");
    const catalog = await collectToolCatalog();
    const live = new Set([...catalog.tools.keys()]);
    // Globs are patterns, not names — `panel_*` deliberately matches a surface that is
    // registered on a different server and is not in this catalog at all.
    const unknown = [...new Set(Object.values(TOOL_PRESETS).flat())]
      .filter((n) => !n.endsWith("*"))
      .filter((n) => !live.has(n));
    expect(unknown, `preset entries that match no live tool: ${unknown.join(", ")}`).toEqual([]);
  });
});

describe("the presets cover what a NAME no longer reveals (codex P1)", () => {
  it("withholds tools whose destructive action hides behind an inspection-sounding name", () => {
    // The 0.50.0 consolidation folded deletion into `list_local_models` (action:"remove"
    // deletes a model file), installation into `search_custom_nodes`, config writes into
    // `get_defaults`, and queue destruction into `queue`. My first preset list was
    // written from the names and missed every one.
    const p = resolveToolSurfacePolicy({ COMFYUI_MCP_TOOL_PRESET: "safe" });
    for (const name of ["list_local_models", "search_custom_nodes", "get_defaults", "queue"]) {
      expect(toolAllowed(name, p), `${name} can mutate and must be withheld by "safe"`).toBe(false);
    }
  });

  it("STAYS complete: every live tool advertising a mutating action is denied by safe", async () => {
    // The hand list is auditable, which is why it stays hand-written — but it must not
    // silently ROT. This scans the REAL catalog and fails when a tool advertising a
    // destructive action is missing, so the next consolidation that hides
    // action:"delete" behind a read-sounding name breaks a test instead of quietly
    // widening every deployment's surface.
    const { collectToolCatalog } = await import("../../tools/index.js");
    const catalog = await collectToolCatalog();
    const p = resolveToolSurfacePolicy({ COMFYUI_MCP_TOOL_PRESET: "safe" });

    const leaked: string[] = [];
    for (const [name, tool] of catalog.tools) {
      const actions = declaredActions(tool.description ?? "");
      const mutating = actions.filter((a) => MUTATING_ACTION_NAMES.test(a));
      if (mutating.length && toolAllowed(name, p)) leaked.push(`${name} (${mutating.join(",")})`);
    }
    expect(leaked, `tools with a mutating action that "safe" still allows: ${leaked.join("; ")}`).toEqual([]);
  });

  it("the PANEL surface is withheld wholesale by both presets (codex P0)", () => {
    // 91 panel_* tools register through a different method on a separate server and
    // bypassed the filter entirely — `panel_run` still queued renders under `readonly`.
    // Denied as a family because classifying 91 by name got several wrong in both
    // directions, and the list grows every release.
    for (const preset of ["safe", "readonly"]) {
      const p = resolveToolSurfacePolicy({ COMFYUI_MCP_TOOL_PRESET: preset });
      for (const name of ["panel_run", "panel_add_node", "panel_graph_outline", "panel_set_property"]) {
        expect(toolAllowed(name, p), `${name} under ${preset}`).toBe(false);
      }
    }
  });

  it("…and can be opted back in explicitly", () => {
    const p = resolveToolSurfacePolicy({ COMFYUI_MCP_TOOL_ALLOW: "panel_graph_outline,panel_query_graph" });
    expect(toolAllowed("panel_graph_outline", p)).toBe(true);
    expect(toolAllowed("panel_run", p)).toBe(false);
  });
});

describe("WIRING: the filter covers the call_tool route, not just registration (#873)", () => {
  it("is applied to the PANEL registration path too (codex P0)", async () => {
    // That path uses `registerTool` on a separate server, so the headless decorator —
    // which proxies `.tool` — could never have caught it.
    const { readFile } = await import("node:fs/promises");
    const src = await readFile(new URL("../../orchestrator/panel-tools.ts", import.meta.url), "utf-8");
    const at = src.indexOf("export function registerPanelTools");
    expect(at).toBeGreaterThan(-1);
    const body = src.slice(at, at + 1400);
    expect(body).toContain("resolveToolSurfacePolicy()");
    expect(body).toContain("toolAllowed(d.name, policy)");
  });

  it("is applied inside collectToolCatalog, which call_tool dispatches through", async () => {
    // The bypass this feature exists to close. Asserted on the source because the
    // catalog is built once per process and the policy is read from the environment at
    // that moment; a runtime assertion here would test my mock, not the wiring.
    const { readFile } = await import("node:fs/promises");
    const src = await readFile(new URL("../../tools/index.ts", import.meta.url), "utf-8");

    const at = src.indexOf("export async function collectToolCatalog");
    expect(at).toBeGreaterThan(-1);
    const body = src.slice(at, at + 1200);
    expect(body).toContain("withToolSurfaceFilter(");
    expect(body).toContain("resolveToolSurfacePolicy()");

    // …and on the direct registration path too.
    const reg = src.slice(src.indexOf("export async function registerAllTools"), at);
    expect(reg).toContain("withToolSurfaceFilter(");
  });
});
