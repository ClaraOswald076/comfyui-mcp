// #1568 — apply_manifest takes a pack by NAME, and a dead npx path is recognised.
//
// The resolution helpers are unit-tested next door (pack-manifest-resolution.test.ts). This
// file is about the SEAM: that applyManifest actually consults them, enforces exactly-one-of
// across three inputs now rather than two, and REPORTS a substitution instead of quietly
// running a different file than the caller named.
//
// applyManifestSections is stubbed — installing custom nodes and downloading model weights
// is not what is under test, and letting it run would make this a network test.
import { beforeEach, describe, expect, it, vi } from "vitest";

const applied = vi.hoisted(() => ({ manifests: [] as unknown[] }));

vi.mock("../../services/node-management.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/node-management.js")>();
  return {
    ...actual,
    listInstalledNodes: async () => [],
    installCustomNode: async () => ({ status: "applied" }),
    installModelViaManager: async () => ({ status: "applied" }),
  };
});

let applyManifest: typeof import("../../services/manifest.js").applyManifest;
let resolvePackManifestFile: typeof import("../../services/manifest.js").resolvePackManifestFile;

beforeEach(async () => {
  vi.resetModules();
  applied.manifests = [];
  ({ applyManifest, resolvePackManifestFile } = await import("../../services/manifest.js"));
});

/** Run apply against an input, tolerating whatever the (unmocked) section applier does with
 *  a real pack manifest — what matters here is WHICH manifest it resolved, and the error
 *  when it resolved none. */
const applyAndCatch = async (opts: Record<string, unknown>) => {
  try {
    return { ok: true as const, result: await applyManifest(opts as never) };
  } catch (err) {
    return { ok: false as const, message: err instanceof Error ? err.message : String(err) };
  }
};

describe("apply_manifest input selection (#1568)", () => {
  it("REFUSES more than one of manifest / path / pack", async () => {
    for (const opts of [
      { manifest: { models: [] }, pack: "krea2-combo" },
      { path: "/x/manifest.yaml", pack: "krea2-combo" },
      { manifest: { models: [] }, path: "/x/manifest.yaml" },
      { manifest: { models: [] }, path: "/x/manifest.yaml", pack: "krea2-combo" },
    ]) {
      const r = await applyAndCatch(opts);
      expect(r.ok, JSON.stringify(opts)).toBe(false);
      expect(r.ok === false && r.message).toMatch(/exactly one of/i);
    }
  });

  it("REFUSES none of them", async () => {
    const r = await applyAndCatch({});
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.message).toMatch(/exactly one of/i);
    // The message must name the new input too, or an agent reading it cannot discover the
    // durable form that exists precisely to stop this bug recurring.
    expect(r.ok === false && r.message).toMatch(/pack/);
  });

  it("an unknown pack name says so, and points at how to find a real one", async () => {
    const r = await applyAndCatch({ pack: "no-such-pack-1568" });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.message).toMatch(/no-such-pack-1568/);
    expect(r.ok === false && r.message).toMatch(/list_packs/);
    // NOT an ENOENT with a path in it — that is the confusing failure this replaces.
    expect(r.ok === false && r.message).not.toMatch(/ENOENT/);
  });

  it("a traversal attempt in `pack` is refused as an unknown pack, never opened", async () => {
    for (const bad of ["../../etc/passwd", "a/b", ".."]) {
      const r = await applyAndCatch({ pack: bad });
      expect(r.ok, bad).toBe(false);
      expect(r.ok === false && r.message).toMatch(/No bundled pack named/);
    }
  });
});

describe("a stale npx path is repaired AND reported (#1568)", () => {
  const STALE =
    "C:/Users/u/AppData/Local/npm-cache/_npx/28eae33d00f3f7f1/node_modules/comfyui-mcp/packs/krea2-combo/manifest.yaml";

  it("resolves the pack and says which file actually ran", async () => {
    const r = await applyAndCatch({ path: STALE });
    // Whatever the section applier concluded, resolution must have succeeded — the failure
    // being fixed is "this file does not exist", and that must be gone.
    expect(r.ok, r.ok === false ? r.message : "").toBe(true);
    const repair = r.ok ? r.result.resolved_from_stale_path : undefined;
    expect(repair, "a substitution must be reported, not silent").toBeTruthy();
    expect(repair?.requested).toBe(STALE);
    expect(repair?.pack).toBe("krea2-combo");
    expect(repair?.applied).toBe(resolvePackManifestFile("krea2-combo"));
  });

  it("a genuinely missing file that is NOT a bundled pack still fails as missing", async () => {
    const r = await applyAndCatch({ path: "/home/u/my-project/packs/krea2-combo/manifest.yaml" });
    expect(r.ok).toBe(false);
    // It must NOT have been silently replaced by the bundled pack of the same name.
    expect(r.ok === false && r.message).not.toMatch(/applied the bundled pack/i);
  });

  it("a normal apply reports NO substitution", async () => {
    const live = resolvePackManifestFile("krea2-combo") as string;
    expect(live).toBeTruthy();
    const r = await applyAndCatch({ path: live });
    expect(r.ok).toBe(true);
    expect(
      r.ok && r.result.resolved_from_stale_path,
      "nothing was substituted, so nothing may be claimed",
    ).toBeUndefined();
  });

  it("`pack` reports no substitution either — it was never a path", async () => {
    const r = await applyAndCatch({ pack: "krea2-combo" });
    expect(r.ok).toBe(true);
    expect(r.ok && r.result.resolved_from_stale_path).toBeUndefined();
  });
});
