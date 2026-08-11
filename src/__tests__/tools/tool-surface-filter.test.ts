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

  it("an UNKNOWN preset name does not silently become 'no policy'", () => {
    // Failing open on a typo is the dangerous direction: the operator believes the
    // surface is restricted and it is not. A bare unknown preset yields no deny rules,
    // so `active` must stay false and the LOG must be the thing that tells them —
    // rather than a half-applied policy that looks like it worked.
    const p = resolveToolSurfacePolicy({ COMFYUI_MCP_TOOL_PRESET: "saef" });
    expect(p.deny).toEqual([]);
    expect(p.active).toBe(false);
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
    expect(toolAllowed("get_history", p)).toBe(true);
    expect(toolAllowed("list_local_models", p)).toBe(true);
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
    const unknown = [...new Set(Object.values(TOOL_PRESETS).flat())].filter((n) => !live.has(n));
    expect(unknown, `preset entries that match no live tool: ${unknown.join(", ")}`).toEqual([]);
  });
});

describe("WIRING: the filter covers the call_tool route, not just registration (#873)", () => {
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
