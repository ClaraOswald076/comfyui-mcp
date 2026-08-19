// #1698 — apply_manifest({pack: "z-image-turbo-controlnet"}) used to clone
// vrgamegirl19/comfyui-vrgamedevgirl for two cosmetic post-proc nodes
// (FastFilmGrain / FastLaplacianSharpen). That pack's requirements.txt lists
// llama-cpp-python, which has no Windows wheel for Desktop's Python, so
// ComfyUI-Manager compiled it from source BEFORE binding :8188 and Desktop's
// supervisor timed out at 300s.
//
// The shipped pack must not pull that dep on ANY install path: apply_manifest
// (manifest.yaml), the generated one-click scripts, or loading workflow.json
// (extract_deps / missing-node recovery). Tests the files apply_manifest and
// packs:gen actually consume — not a parallel fixture.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { loadManifestFile, resolvePackManifestFile } from "../../services/manifest.js";

const PACK = "z-image-turbo-controlnet";
const PACK_DIR = join(process.cwd(), "packs", PACK);
const VRGAME_RE = /vrgamedevgirl|llama-cpp-python|llama_cpp_python|FastFilmGrain|FastLaplacianSharpen/i;

describe("z-image-turbo-controlnet does not trigger a llama-cpp-python source build (#1698)", () => {
  it("apply_manifest pack: name resolves to the shipped manifest", () => {
    const file = resolvePackManifestFile(PACK);
    expect(file, "the reported pack must resolve from the running package root").toBeTruthy();
    expect(file).toMatch(/z-image-turbo-controlnet[\\/]manifest\.ya?ml$/);
  });

  it("the shipped manifest has no vrgamedevgirl node and no llama-cpp-python pip pin", async () => {
    const file = resolvePackManifestFile(PACK);
    expect(file).toBeTruthy();
    const manifest = await loadManifestFile(file!);
    expect(manifest.custom_nodes.join("\n")).not.toMatch(/vrgamedevgirl/i);
    expect(manifest.pip.join("\n")).not.toMatch(/llama-cpp-python|llama_cpp_python/i);
    // Also pin the on-disk YAML (comments + unparsed extras) so a commented-back
    // clone or a stray requirements URL cannot sneak past the schema parse.
    const raw = parse(readFileSync(file!, "utf8")) as {
      custom_nodes?: unknown;
      pip?: unknown;
    };
    const nodes = Array.isArray(raw.custom_nodes) ? raw.custom_nodes : [];
    const pip = Array.isArray(raw.pip) ? raw.pip : [];
    for (const entry of [...nodes, ...pip]) {
      expect(String(entry), String(entry)).not.toMatch(VRGAME_RE);
    }
  });

  it("workflow.json does not reference the cosmetic vrgamedevgirl nodes", () => {
    const file = join(PACK_DIR, "workflow.json");
    expect(existsSync(file)).toBe(true);
    const text = readFileSync(file, "utf8");
    expect(text).not.toMatch(VRGAME_RE);
    const parsed = JSON.parse(text) as {
      nodes?: { id: number; type?: string; inputs?: { name?: string; link?: number | null }[] }[];
      links?: [number, number, number, number, number, string][];
    };
    expect(Array.isArray(parsed.nodes), "UI/litegraph shape").toBe(true);
    const save = parsed.nodes!.find((n) => n.type === "SaveImage");
    expect(save, "ControlNet graph still ends at SaveImage").toBeTruthy();
    const imageIn = save!.inputs?.find((i) => i.name === "images");
    expect(imageIn?.link, "SaveImage must stay wired after dropping grain/sharpen").toEqual(
      expect.any(Number),
    );
    const link = parsed.links?.find((l) => l[0] === imageIn!.link);
    expect(link, "SaveImage's inbound link exists").toBeTruthy();
    expect(link![3]).toBe(save!.id);
  });

  it("generated installers do not clone vrgamedevgirl or pip-install llama-cpp-python", () => {
    for (const name of ["install-windows.bat", "install-runpod.sh"]) {
      const file = join(PACK_DIR, name);
      expect(existsSync(file), name).toBe(true);
      expect(readFileSync(file, "utf8"), name).not.toMatch(VRGAME_RE);
    }
  });
});
