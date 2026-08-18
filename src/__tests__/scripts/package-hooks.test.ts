// #1597 — the package shipped `model-settings.json` +
// `model-settings.user.jsonc.example` and a `postinstall` hook that copied the
// template into the install directory on every install, while no code ever read
// either file. The README advertised the preset library as a working feature;
// the only consumer reference in src was a comment saying it might happen "in
// the future". The dead hook was also the package's only lifecycle script, so
// on npm 12 (which blocks install scripts by default) it earned comfyui-mcp a
// place in the `--allow-scripts` list for nothing.
//
// The files and the hook are gone. What stays pinned here is the class, not
// the names: a lifecycle script must point at a file that exists (the 0.17.0
// packaging crash was the same shape from the other side), and the `files`
// allowlist must not name files that are not there — an entry for a deleted
// file is exactly how a dead artifact keeps getting shipped.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
  scripts?: Record<string, string>;
  files?: string[];
};

const LIFECYCLE = [
  "preinstall",
  "install",
  "postinstall",
  "prepublish",
  "prepack",
  "postpack",
  "prepare",
];

describe("package lifecycle scripts (#1597)", () => {
  it("every local file a lifecycle script invokes exists", () => {
    const missing: string[] = [];
    for (const name of LIFECYCLE) {
      const cmd = pkg.scripts?.[name];
      if (!cmd) continue;
      // `node scripts/foo.mjs`, `tsx scripts/foo.ts`, `./scripts/foo.mjs` —
      // any token that names a repo-relative path.
      for (const token of cmd.split(/\s+/)) {
        const rel = token.replace(/^\.\//, "");
        if (!/^(scripts|src|dist)\/.+\.(mjs|cjs|js|mts|ts)$/.test(rel)) continue;
        if (!existsSync(join(ROOT, rel))) {
          missing.push(`${name}: ${cmd} -> ${rel} is missing`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});

describe("published files allowlist (#1597)", () => {
  it("every entry in `files` exists on disk", () => {
    const missing = (pkg.files ?? []).filter((entry) => !existsSync(join(ROOT, entry)));
    expect(missing).toEqual([]);
  });

  it("ships no model-settings preset files nothing reads", () => {
    const shipped = (pkg.files ?? []).filter((entry) => entry.includes("model-settings"));
    expect(shipped).toEqual([]);
  });
});
