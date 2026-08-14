// #1568 — `list_packs` hands out an absolute manifest_path, and that path dies.
//
// The path is built from the RUNNING package root, which under npx is an ephemeral cache
// directory (…/npm-cache/_npx/<hash>/node_modules/comfyui-mcp). The next npx respawn gets a
// different <hash>, so a path captured earlier in the conversation — or written into notes,
// or repeated by an agent from memory — stats ENOENT:
//
//   ENOENT: no such file or directory, stat
//   '~/AppData/Local/npm-cache/_npx/28eae33d00f3f7f1/node_modules/comfyui-mcp/packs/krea2-combo/manifest.yaml'
//
// `packsDir()` already resolves from the current package root, so the LOOKUP is fine; what
// goes stale is the string handed out. Two things follow, and this file pins both:
//
//   1. `apply_manifest` should take the pack by NAME. A name cannot go stale, and it is what
//      `list_packs` already uses everywhere else (read_workflow, panel_load_workflow).
//   2. A path that IS one of our bundled packs, merely under a dead package root, should be
//      recognised rather than reported as a missing file — the pack is right there.
import { describe, expect, it } from "vitest";

import { resolvePackManifestFile, repairStalePackManifestPath } from "../../services/manifest.js";

describe("a pack manifest resolves by NAME, never by a captured path (#1568)", () => {
  it("resolves a real bundled pack", () => {
    // krea2-combo is the pack from the report. Any bundled pack proves the mechanism; this
    // one proves it against the case that was reported.
    const file = resolvePackManifestFile("krea2-combo");
    expect(file, "the reported pack must resolve from the running package root").toBeTruthy();
    expect(file).toMatch(/krea2-combo[\\/]manifest\.ya?ml$/);
  });

  it("refuses a name that is not a plain pack directory", () => {
    // The name reaches the filesystem, so traversal must not.
    for (const bad of ["../../etc/passwd", "a/b", "..", "", "  ", "pack;rm -rf /"]) {
      expect(resolvePackManifestFile(bad), bad).toBeNull();
    }
  });

  it("returns null for a pack that does not exist, rather than a path that does not", () => {
    expect(resolvePackManifestFile("no-such-pack-1568")).toBeNull();
  });
});

describe("a stale npx path is recognised as the pack it names (#1568)", () => {
  const STALE =
    "C:/Users/u/AppData/Local/npm-cache/_npx/28eae33d00f3f7f1/node_modules/comfyui-mcp/packs/krea2-combo/manifest.yaml";

  it("repairs the exact path from the report", () => {
    const repaired = repairStalePackManifestPath(STALE);
    expect(repaired, "a dead npx root naming a real pack must be recoverable").toBeTruthy();
    expect(repaired).toMatch(/krea2-combo[\\/]manifest\.ya?ml$/);
    expect(repaired).not.toContain("_npx");
  });

  it("repairs the POSIX form too", () => {
    const posix =
      "/home/u/.npm/_npx/9f2c1/node_modules/comfyui-mcp/packs/krea2-combo/manifest.yaml";
    expect(repairStalePackManifestPath(posix)).toMatch(/krea2-combo[\\/]manifest\.ya?ml$/);
  });

  it("does NOT repair a path that is not a bundled pack manifest", () => {
    // This substitutes a file the caller did not name, so it may only fire when the path is
    // unmistakably one of OUR packs. Everything else must fail as the missing file it is —
    // silently applying a different manifest is far worse than an ENOENT.
    for (const other of [
      "/home/u/my-project/packs/krea2-combo/manifest.yaml", // not under a comfyui-mcp root
      "/npx/x/node_modules/comfyui-mcp/packs/krea2-combo/other.yaml", // not the manifest
      "/npx/x/node_modules/comfyui-mcp/manifest.yaml", // no pack segment
      "/npx/x/node_modules/comfyui-mcp/packs/../../evil/manifest.yaml", // traversal
      "/npx/x/node_modules/other-pkg/packs/krea2-combo/manifest.yaml", // a different package
    ]) {
      expect(repairStalePackManifestPath(other), other).toBeNull();
    }
  });

  it("does NOT repair a path naming a pack this build does not ship", () => {
    // The name has to exist HERE. Otherwise this invents a file for a pack that was removed
    // between versions, which is exactly the confusion it is meant to remove.
    expect(
      repairStalePackManifestPath(
        "/x/_npx/abc/node_modules/comfyui-mcp/packs/no-such-pack-1568/manifest.yaml",
      ),
    ).toBeNull();
  });

  it("leaves a path that still EXISTS completely alone", () => {
    // Repair is for a dead path only. A live one is already correct, and re-deriving it
    // could retarget a legitimately different checkout.
    const live = resolvePackManifestFile("krea2-combo") as string;
    expect(live).toBeTruthy();
    expect(repairStalePackManifestPath(live)).toBeNull();
  });
});
