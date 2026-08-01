import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// getLiveExtraModelRoots is the FAIL-CLOSED authorization primitive for #633: only a
// reachable, server-authoritative config may authorize an escaping-symlink download.
// It takes the SINGLE live /system_stats snapshot the caller already used (one
// consistent server state) and trusts ONLY: ABSOLUTE --extra-model-paths-config flag
// files + the live install's own extra_model_paths.yaml (its main.py dir). A relative
// flag value, a stale local workspace config, or an unreachable server authorize
// nothing (codex P0d).

vi.mock("../../config.js", () => ({
  config: { comfyuiPath: undefined as string | undefined },
  isRemoteMode: () => false,
}));

import { getLiveExtraModelRoots } from "../../services/extra-paths.js";
import type { LiveServerSnapshot } from "../../services/output-dir.js";

let dirs: string[] = [];
async function trackTmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "comfyui-live-roots-"));
  dirs.push(dir);
  return dir;
}
const reachable = (argv: string[], cwd?: string): LiveServerSnapshot => ({
  reachable: true,
  argv,
  cwd,
});

beforeEach(() => {
  dirs = [];
});
afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

describe("getLiveExtraModelRoots — fail-closed authorization", () => {
  it("returns { authoritative: false, roots: [] } when the server is unreachable", async () => {
    const res = await getLiveExtraModelRoots({ reachable: false });
    expect(res.authoritative).toBe(false);
    expect(res.roots).toEqual([]);
  });

  it("reads an ABSOLUTE --extra-model-paths-config file the server was launched with", async () => {
    const cfgDir = await trackTmp();
    const cfgPath = join(cfgDir, "shared_model_paths.yaml");
    const external = resolve("/Volumes/Render/00_AI/models/unet");
    await writeFile(cfgPath, ["comfyui:", `  unet: ${external}`].join("\n"), "utf-8");

    const res = await getLiveExtraModelRoots(
      reachable(["python", "main.py", "--extra-model-paths-config", cfgPath]),
    );
    expect(res.authoritative).toBe(true);
    expect(res.roots).toContainEqual({ category: "unet", dir: external, group: "comfyui" });
  });

  it("SKIPS a RELATIVE --extra-model-paths-config value (can't anchor to the live server → fail closed)", async () => {
    // A relative flag value must not be resolved against the MCP process / stale
    // COMFYUI_PATH and read — that is exactly the stale-config authorization bypass.
    const res = await getLiveExtraModelRoots(
      reachable(["python", "main.py", "--extra-model-paths-config", "paths.yaml"]),
    );
    expect(res.authoritative).toBe(true);
    expect(res.roots).toEqual([]);
  });

  it("reads <live main.py root>/extra_model_paths.yaml (the auto-loaded default)", async () => {
    const liveRoot = await trackTmp();
    const external = resolve("/mnt/models/loras");
    await writeFile(
      join(liveRoot, "extra_model_paths.yaml"),
      ["grp:", `  loras: ${external}`].join("\n"),
      "utf-8",
    );
    const res = await getLiveExtraModelRoots(reachable(["python", join(liveRoot, "main.py")]));
    expect(res.authoritative).toBe(true);
    expect(res.roots).toContainEqual({ category: "loras", dir: external, group: "grp" });
  });

  it("resolves a RELATIVE base_path against the config file's OWN dir (like ComfyUI), not the MCP cwd", async () => {
    const liveRoot = await trackTmp();
    await writeFile(
      join(liveRoot, "extra_model_paths.yaml"),
      ["grp:", "  base_path: sub", "  unet: nested"].join("\n"),
      "utf-8",
    );
    const res = await getLiveExtraModelRoots(reachable(["python", join(liveRoot, "main.py")]));
    expect(res.roots).toContainEqual({
      category: "unet",
      dir: resolve(liveRoot, "sub", "nested"),
      group: "grp",
    });
  });

  it("does NOT read a stale config that is neither a launched flag file nor the live root default", async () => {
    const staleDir = await trackTmp();
    await writeFile(
      join(staleDir, "extra_model_paths.yaml"),
      ["grp:", "  unet: /escape/here"].join("\n"),
      "utf-8",
    );
    const liveRoot = await trackTmp(); // live root has NO extra config
    const res = await getLiveExtraModelRoots(reachable(["python", join(liveRoot, "main.py")]));
    expect(res.authoritative).toBe(true);
    expect(res.roots).toEqual([]);
  });

  it("is authoritative-but-empty when the server is reachable with no extra config", async () => {
    const res = await getLiveExtraModelRoots(reachable(["python", "main.py"]));
    expect(res.authoritative).toBe(true);
    expect(res.roots).toEqual([]);
  });
});
