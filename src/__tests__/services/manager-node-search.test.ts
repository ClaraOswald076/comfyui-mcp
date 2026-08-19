// #1669 — panel_search_nodes failed the whole search when Manager's
// `customnode/getmappings?mode=cache` answered HTTP 500. A 500 is a Manager
// outage on one source, not a missing pack. searchNodesViaMappings must keep
// searching (remote/local) or name the outage.

import { afterEach, describe, expect, it } from "vitest";
import {
  isManagerMappingsServerError,
  managerMappingsOutageResult,
  parseNodeMappings,
  searchNodesViaMappings,
  searchPanelNodes,
  setFetchMappingsForTests,
  type FetchMappings,
} from "../../services/manager-node-search.js";

afterEach(() => setFetchMappingsForTests(undefined));

const CACHE_500 = new Error("Manager customnode/getmappings?mode=cache: HTTP 500");

const CATALOGUE = {
  "https://github.com/someone/ComfyUI-SolAttn": [
    ["SolAttnPatch"],
    { title: "SolAttn", description: "Sage-attention patch node" },
  ],
  "https://github.com/ltdrdata/ComfyUI-Impact-Pack": [
    ["ImpactSomething"],
    { title: "ComfyUI-Impact-Pack", description: "impact pack" },
  ],
};

function fetchByMode(table: Partial<Record<string, unknown | Error>>): FetchMappings {
  return async (mode) => {
    const row = table[mode];
    if (row instanceof Error) throw row;
    if (row !== undefined) return row;
    throw new Error(`Manager customnode/getmappings?mode=${mode}: HTTP 500`);
  };
}

describe("isManagerMappingsServerError", () => {
  it("matches the reported panel error text", () => {
    expect(isManagerMappingsServerError(CACHE_500)).toBe(true);
    expect(
      isManagerMappingsServerError({
        isError: true,
        content: [{ type: "text", text: `Error: ${CACHE_500.message}` }],
      }),
    ).toBe(true);
  });

  it("does not treat 403, 404, or a no-match as a mappings 500", () => {
    expect(isManagerMappingsServerError(new Error("Manager customnode/getmappings: HTTP 403"))).toBe(false);
    expect(isManagerMappingsServerError(new Error("Manager customnode/getmappings: HTTP 404"))).toBe(false);
    expect(isManagerMappingsServerError({ count: 0, results: [] })).toBe(false);
  });
});

describe("searchNodesViaMappings (#1669)", () => {
  it("keeps searching when cache mappings return HTTP 500", async () => {
    const res = await searchNodesViaMappings({
      query: "SolAttnPatch",
      fetchMappings: fetchByMode({
        cache: CACHE_500,
        remote: CATALOGUE,
      }),
    });
    expect(res.count).toBe(1);
    expect(res.results[0]?.id).toContain("SolAttn");
    expect(res.requested_mode).toBe("remote");
    expect(res.degraded_from).toBe("cache");
    expect(res.message).toMatch(/Manager outage/i);
    expect(res.message).not.toMatch(/does not exist|not found|missing pack/i);
  });

  it("names an all-modes 500 as a Manager outage, not a missing pack", async () => {
    const res = await searchNodesViaMappings({
      query: "SolAttnPatch",
      fetchMappings: fetchByMode({
        cache: CACHE_500,
        remote: new Error("Manager customnode/getmappings?mode=remote: HTTP 500"),
        local: new Error("Manager customnode/getmappings?mode=local: HTTP 502"),
      }),
    });
    expect(res.manager_outage).toBe(true);
    expect(res.supported).toBe(false);
    expect(res.count).toBe(0);
    expect(res.results).toEqual([]);
    expect(res.message).toMatch(/Manager outage/i);
    expect(res.message).not.toMatch(/does not exist|not found|missing pack/i);
    expect(res.reason).toMatch(/HTTP 50/);
  });

  it("does not retry when cache succeeds", async () => {
    const seen: string[] = [];
    const res = await searchNodesViaMappings({
      query: "impact",
      fetchMappings: async (mode) => {
        seen.push(mode);
        if (mode !== "cache") throw new Error("should not be asked");
        return CATALOGUE;
      },
    });
    expect(seen).toEqual(["cache"]);
    expect(res.count).toBe(1);
    expect(res.degraded_from).toBeUndefined();
    expect(res.manager_outage).toBeUndefined();
  });

  it("propagates a non-5xx mappings error from the first mode", async () => {
    await expect(
      searchNodesViaMappings({
        query: "x",
        fetchMappings: fetchByMode({
          cache: new Error("Manager customnode/getmappings?mode=cache: HTTP 403"),
        }),
      }),
    ).rejects.toThrow(/HTTP 403/);
  });
});

describe("searchPanelNodes (#1669)", () => {
  it("degrades to mappings search when the panel fail()s a cache 500", async () => {
    const out = await searchPanelNodes({
      query: "SolAttnPatch",
      panelSearch: async () => ({
        isError: true,
        content: [{ type: "text", text: `Error: ${CACHE_500.message}` }],
      }),
      fetchMappings: fetchByMode({ cache: CACHE_500, remote: CATALOGUE }),
    });
    expect(out.via).toBe("fallback");
    if (out.via !== "fallback") throw new Error("expected fallback");
    expect(out.value.count).toBe(1);
    expect(out.value.results[0]?.title).toBe("SolAttn");
  });

  it("degrades when the panel throws the same 500", async () => {
    const out = await searchPanelNodes({
      query: "SolAttnPatch",
      panelSearch: async () => {
        throw CACHE_500;
      },
      fetchMappings: fetchByMode({ cache: CACHE_500, local: CATALOGUE }),
    });
    expect(out.via).toBe("fallback");
    if (out.via !== "fallback") throw new Error("expected fallback");
    expect(out.value.requested_mode).toBe("local");
    expect(out.value.count).toBe(1);
  });

  it("passes a successful panel result through", async () => {
    const panel = { count: 1, results: [{ id: "a", title: "A", description: "" }] };
    const out = await searchPanelNodes({
      query: "A",
      panelSearch: async () => panel,
      fetchMappings: async () => {
        throw new Error("fallback must not run");
      },
    });
    expect(out).toEqual({ via: "panel", value: panel });
  });
});

describe("parseNodeMappings / outage copy", () => {
  it("uses the repo-URL key as id, never the display title", () => {
    const res = parseNodeMappings(CATALOGUE, "SolAttn", 15);
    expect(res.results[0]?.id).toBe("https://github.com/someone/ComfyUI-SolAttn");
    expect(res.results[0]?.title).toBe("SolAttn");
  });

  it("matches a node CLASS name in the mappings first array", () => {
    // The reporter searched SolAttnPatch — a class_type, not a pack title.
    const res = parseNodeMappings(CATALOGUE, "SolAttnPatch", 15);
    expect(res.count).toBe(1);
    expect(res.results[0]?.id).toContain("SolAttn");
  });

  it("outage copy names Manager, not a missing pack", () => {
    const res = managerMappingsOutageResult("SolAttnPatch", CACHE_500);
    expect(res.manager_outage).toBe(true);
    expect(res.message).toMatch(/Manager outage/);
    expect(res.message).not.toMatch(/does not exist/);
  });
});
