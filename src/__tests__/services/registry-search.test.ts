import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  searchNodes,
  getNodePackDetails,
  extractVersionString,
  registryIdCandidatesFromQuery,
} from "../../services/registry-client.js";

const NODES = [
  {
    id: "ComfyUI-WanVideoWrapper",
    name: "WanVideoWrapper",
    description: "Wan Video diffusion nodes",
    author: "kijai",
    repository: "https://github.com/kijai/ComfyUI-WanVideoWrapper",
    latest_version: "1.0.0",
    total_install: 50_000,
  },
  {
    id: "PuLID-ComfyUI",
    name: "PuLID",
    description: "Identity-preserving generation",
    author: "cubiq",
    repository: "https://github.com/cubiq/PuLID_ComfyUI",
    latest_version: "1.0.0",
    total_install: 100_000,
  },
  {
    id: "some-other-pack",
    name: "Other",
    description: "Mentions wan in the description only",
    author: "nobody",
    repository: "https://github.com/nobody/other",
    latest_version: "0.1.0",
    total_install: 3,
  },
  {
    id: "unrelated-pack",
    name: "Unrelated",
    description: "Nothing matches",
    author: "x",
    repository: "https://github.com/x/unrelated",
    latest_version: "0.1.0",
    total_install: 1,
  },
];

describe("searchNodes (upstream-bug client-side filter)", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ nodes: NODES }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ) as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("filters and ranks client-side when upstream returns the full list", async () => {
    const results = await searchNodes("wan");
    // 'wan' appears in WanVideoWrapper id/name (high score) and in the
    // description of some-other-pack (low score). Unrelated and PuLID drop out.
    expect(results.map((r) => r.id)).toEqual([
      "ComfyUI-WanVideoWrapper",
      "some-other-pack",
    ]);
  });

  it("ranks id-exact above id-substring", async () => {
    const results = await searchNodes("pulid-comfyui");
    expect(results[0]?.id).toBe("PuLID-ComfyUI");
  });

  it("applies pagination after filtering", async () => {
    const results = await searchNodes("comfyui", { page: 2, limit: 1 });
    expect(results).toHaveLength(1);
  });

  it("requests a large fetch window so the client-side filter has data to rank", async () => {
    await searchNodes("anything");
    const call = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    expect(call).toMatch(/limit=100/);
    expect(call).toMatch(/page=1/);
  });

  it("returns the raw page when query is empty", async () => {
    const results = await searchNodes("");
    expect(results.length).toBeGreaterThan(0);
    // No filter applied — order matches input
    expect(results[0]?.id).toBe(NODES[0]!.id);
  });
});

describe("searchNodes exact-id fallback (#773)", () => {
  // The client-side filter only ranks a 100-pack window; a query naming a real
  // pack OUTSIDE that window (including its exact id) false-emptied. When the
  // filter matches nothing, the query is normalized to a registry-id slug and
  // tried against the direct pack-details endpoint before reporting no matches.
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("falls back to the direct pack-details endpoint when the window matched nothing", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/nodes/comfyui-kjnodes")) {
        return new Response(
          JSON.stringify({
            id: "comfyui-kjnodes",
            name: "KJNodes",
            description: "Utility nodes",
            author: "kijai",
            repository: "https://github.com/kijai/ComfyUI-KJNodes",
            latest_version: { version: "1.4.8" },
            total_install: 12345,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ nodes: NODES }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const results = await searchNodes("comfyui kjnodes");
    expect(results.map((r) => r.id)).toEqual(["comfyui-kjnodes"]);
    // The object-shaped latest_version is normalized for the fallback too.
    expect(results[0]?.latest_version).toBe("1.4.8");
    // Two calls: the window search, then the exact-id fallback.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("/nodes/comfyui-kjnodes");
  });

  it("still reports no matches when the fallback id does not exist (404)", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (/\/nodes\/[^?]+$/.test(url)) {
        return new Response("not found", { status: 404 });
      }
      return new Response(JSON.stringify({ nodes: NODES }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const results = await searchNodes("definitely not a pack");
    expect(results).toEqual([]);
  });

  it("a non-404 fallback failure is REFUSED — 'no matches' was never established", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (/\/nodes\/[^?]+$/.test(url)) {
        return new Response("boom", { status: 500 });
      }
      return new Response(JSON.stringify({ nodes: NODES }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(searchNodes("definitely not a pack")).rejects.toThrow(
      /could not be resolved/,
    );
  });

  it("does NOT call the fallback when the search itself matched", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ nodes: NODES }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const results = await searchNodes("wan");
    expect(results.length).toBeGreaterThan(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("the fallback only answers for page 1 (it has no pagination of its own)", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ nodes: NODES }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const results = await searchNodes("comfyui kjnodes", { page: 2 });
    expect(results).toEqual([]);
    // Only the window fetch — no /nodes/<id> call for a later page.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // #773 recurrence on 0.52.1: "WanVideoWrapper" slugs to "wanvideowrapper",
  // but the real pack id is "comfyui-wanvideowrapper" — registry ids are
  // derived from GitHub repo names, and most packs carry the "ComfyUI-" prefix.
  it("tries the comfyui-prefixed candidate when the bare slug 404s", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/nodes/comfyui-wanvideowrapper")) {
        return new Response(
          JSON.stringify({
            id: "ComfyUI-WanVideoWrapper",
            name: "WanVideoWrapper",
            description: "Wan Video diffusion nodes",
            author: "kijai",
            repository: "https://github.com/kijai/ComfyUI-WanVideoWrapper",
            latest_version: { version: "1.0.0" },
            total_install: 50000,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (/\/nodes\/[^?]+$/.test(url)) {
        return new Response("not found", { status: 404 });
      }
      // The window never contains the pack — that is why the fallback runs.
      return new Response(JSON.stringify({ nodes: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const results = await searchNodes("WanVideoWrapper");
    expect(results.map((r) => r.id)).toEqual(["ComfyUI-WanVideoWrapper"]);
    const detailCalls = fetchMock.mock.calls.map((c) => String(c[0])).filter((u) =>
      /\/nodes\/[^?]+$/.test(u),
    );
    expect(detailCalls).toEqual([
      expect.stringContaining("/nodes/wanvideowrapper"),
      expect.stringContaining("/nodes/comfyui-wanvideowrapper"),
    ]);
  });

  it("a query already carrying the comfyui- prefix is tried once, not doubled", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (/\/nodes\/[^?]+$/.test(url)) {
        return new Response("not found", { status: 404 });
      }
      return new Response(JSON.stringify({ nodes: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const results = await searchNodes("comfyui kjnodes");
    expect(results).toEqual([]);
    const detailCalls = fetchMock.mock.calls.map((c) => String(c[0])).filter((u) =>
      /\/nodes\/[^?]+$/.test(u),
    );
    expect(detailCalls).toEqual([expect.stringContaining("/nodes/comfyui-kjnodes")]);
  });

  it("a later candidate still resolves after an earlier candidate fails non-404", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/nodes/sam3")) {
        return new Response("boom", { status: 500 });
      }
      if (url.includes("/nodes/comfyui-sam3")) {
        return new Response(
          JSON.stringify({
            id: "ComfyUI-SAM3",
            name: "SAM3",
            description: "Segment anything",
            author: "someone",
            repository: "https://github.com/someone/ComfyUI-SAM3",
            latest_version: "1.0.0",
            total_install: 100,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ nodes: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const results = await searchNodes("SAM3");
    expect(results.map((r) => r.id)).toEqual(["ComfyUI-SAM3"]);
  });
});

describe("registryIdCandidatesFromQuery", () => {
  it("offers the bare slug first, then the comfyui-prefixed form", () => {
    expect(registryIdCandidatesFromQuery("WanVideoWrapper")).toEqual([
      "wanvideowrapper",
      "comfyui-wanvideowrapper",
    ]);
    expect(registryIdCandidatesFromQuery("impact pack")).toEqual([
      "impact-pack",
      "comfyui-impact-pack",
    ]);
  });

  it("does not double a prefix the query already carries", () => {
    expect(registryIdCandidatesFromQuery("comfyui kjnodes")).toEqual(["comfyui-kjnodes"]);
  });

  it("offers nothing when no usable slug remains", () => {
    expect(registryIdCandidatesFromQuery("   ")).toEqual([]);
    expect(registryIdCandidatesFromQuery("!!!")).toEqual([]);
  });
});

describe("extractVersionString (registry version is an object, not a string)", () => {
  it("returns a bare string as-is", () => {
    expect(extractVersionString("1.2.3")).toBe("1.2.3");
  });

  it("pulls .version out of the registry's object shape", () => {
    expect(
      extractVersionString({ version: "8.28.3", changelog: "", createdAt: "x" }),
    ).toBe("8.28.3");
  });

  it("returns undefined for shapes with no usable version", () => {
    expect(extractVersionString(undefined)).toBeUndefined();
    expect(extractVersionString(null)).toBeUndefined();
    expect(extractVersionString({})).toBeUndefined();
    expect(extractVersionString({ version: 5 })).toBeUndefined();
  });
});

describe("getNodePackDetails version rendering (no more [object Object])", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("normalizes the object-shaped latest_version to a version string", async () => {
    global.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          id: "comfyui-impact-pack",
          name: "Impact Pack",
          description: "d",
          author: "a",
          repository: "https://github.com/ltdrdata/ComfyUI-Impact-Pack",
          // The real registry returns an OBJECT here, which used to stringify
          // to "[object Object]".
          latest_version: {
            version: "8.28.3",
            changelog: "",
            createdAt: "2026-04-19T17:08:04Z",
          },
          versions: [
            { version: "8.28.3", changelog: "latest" },
            { version: "8.0.0" },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    ) as unknown as typeof fetch;

    const details = await getNodePackDetails("comfyui-impact-pack");
    expect(details.latest_version).toBe("8.28.3");
    expect(typeof details.latest_version).toBe("string");
    expect(details.versions).toEqual([
      { version: "8.28.3", changelog: "latest" },
      { version: "8.0.0", changelog: undefined },
    ]);
  });
});
