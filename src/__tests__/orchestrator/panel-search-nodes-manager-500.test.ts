// #1669 — panel_search_nodes must not fail the whole search on a Manager
// cache-mappings HTTP 500.

import { afterEach, describe, expect, it } from "vitest";
import { buildPanelToolDefs, type PanelToolCtx } from "../../orchestrator/panel-tools.js";
import { setFetchMappingsForTests } from "../../services/manager-node-search.js";

afterEach(() => setFetchMappingsForTests(undefined));

function defByName(name: string) {
  const def = buildPanelToolDefs().find((d) => d.name === name);
  if (!def) throw new Error(`tool ${name} not found`);
  return def;
}

describe("panel_search_nodes (#1669 mappings 500)", () => {
  it("still returns packs when the panel fail()s cache mappings HTTP 500", async () => {
    setFetchMappingsForTests(async (mode) => {
      if (mode === "cache") {
        throw new Error("Manager customnode/getmappings?mode=cache: HTTP 500");
      }
      return {
        "https://github.com/someone/ComfyUI-SolAttn": [
          ["SolAttnPatch"],
          { title: "SolAttn", description: "patch" },
        ],
      };
    });
    const ctx = {
      call: async () => ({
        isError: true,
        content: [{ type: "text", text: "Error: Manager customnode/getmappings?mode=cache: HTTP 500" }],
      }),
    } as unknown as PanelToolCtx;

    const res = await defByName("panel_search_nodes").handler({ query: "SolAttnPatch" }, ctx);
    expect(res.isError).toBeUndefined();
    const text = res.content.map((c) => ("text" in c ? c.text : "")).join("");
    expect(text).toMatch(/SolAttn/);
    expect(text).toMatch(/Manager outage/i);
    expect(text).not.toMatch(/does not exist/i);
    const body = JSON.parse(text) as { count: number; requested_mode: string };
    expect(body.count).toBe(1);
    expect(body.requested_mode).toBe("remote");
  });

  it("forwards a healthy panel search unchanged", async () => {
    const ctx = {
      call: async (cmd: Record<string, unknown>) => ({
        content: [{ type: "text", text: JSON.stringify(cmd) }],
      }),
    } as unknown as PanelToolCtx;

    const res = await defByName("panel_search_nodes").handler({ query: "kjnodes", limit: 5 }, ctx);
    const body = JSON.parse(res.content.map((c) => ("text" in c ? c.text : "")).join("")) as {
      cmd: string;
      query: string;
      limit: number;
    };
    expect(body).toMatchObject({ cmd: "nodes_search", query: "kjnodes", limit: 5 });
  });
});
