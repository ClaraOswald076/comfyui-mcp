import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listLocalModels: vi.fn(),
  getSystemStats: vi.fn(),
  comfyuiPath: undefined as string | undefined,
}));

vi.mock("../../services/model-resolver.js", async () => {
  const actual = await vi.importActual<typeof import("../../services/model-resolver.js")>(
    "../../services/model-resolver.js",
  );
  return { ...actual, listLocalModels: mocks.listLocalModels };
});

vi.mock("../../comfyui/client.js", () => ({
  getSystemStats: mocks.getSystemStats,
}));

vi.mock("../../config.js", () => ({
  get config() {
    return { comfyuiPath: mocks.comfyuiPath };
  },
}));

import {
  isLocalModelsListAction,
  listLocalModelsFallback,
} from "../../services/local-models-fallback.js";

const model = (name: string, type: string) => ({ name, path: `${type}/${name}`, size: 0, modified: "", type });

describe("comfy_cli_models local fallback (#460)", () => {
  beforeEach(() => {
    mocks.listLocalModels.mockReset();
    mocks.getSystemStats.mockReset();
    mocks.comfyuiPath = undefined;
  });

  it("recognizes the read-only listing actions", () => {
    for (const a of ["list-folders", "list-folder", "search", "show"]) {
      expect(isLocalModelsListAction(a)).toBe(true);
    }
    for (const a of ["download", "remove"]) {
      expect(isLocalModelsListAction(a)).toBe(false);
    }
  });

  it("lists local model folders via the connected server when comfy-cli is absent", async () => {
    mocks.listLocalModels.mockResolvedValue([
      model("sd_xl.safetensors", "checkpoints"),
      model("lcm.safetensors", "loras"),
    ]);
    const { command, data } = await listLocalModelsFallback({ action: "list-folders" });
    expect(command).toBe("models list-folders");
    expect(data).toEqual({ folders: ["checkpoints", "loras"] });
    expect(mocks.getSystemStats).not.toHaveBeenCalled();
  });

  it("lists files in a folder", async () => {
    mocks.listLocalModels.mockResolvedValue([model("a.safetensors", "loras"), model("b.safetensors", "loras")]);
    const { data } = await listLocalModelsFallback({ action: "list-folder", folder: "loras" });
    expect(data).toEqual({ folder: "loras", count: 2, files: ["a.safetensors", "b.safetensors"] });
  });

  it("caps list-folder output at the limit (mirrors --limit)", async () => {
    mocks.listLocalModels.mockResolvedValue([
      model("a.safetensors", "loras"),
      model("b.safetensors", "loras"),
      model("c.safetensors", "loras"),
    ]);
    const { data } = await listLocalModelsFallback({ action: "list-folder", folder: "loras", limit: 2 });
    expect(data).toEqual({ folder: "loras", count: 2, files: ["a.safetensors", "b.safetensors"] });
  });

  it("maps singular --type aliases to real folders for list-folder and search", async () => {
    mocks.listLocalModels.mockResolvedValue([]);
    mocks.getSystemStats.mockResolvedValue({});
    await listLocalModelsFallback({ action: "search", type: "checkpoint" });
    await listLocalModelsFallback({ action: "search", type: "lora" });
    await listLocalModelsFallback({ action: "search", type: "unet" });
    await listLocalModelsFallback({ action: "list-folder", folder: "checkpoint" });
    expect(mocks.listLocalModels.mock.calls.map((c) => c[0])).toEqual([
      "checkpoints",
      "loras",
      "diffusion_models",
      "checkpoints",
    ]);
  });

  it("searches by text and honors the limit", async () => {
    mocks.listLocalModels.mockResolvedValue([
      model("flux_dev.safetensors", "checkpoints"),
      model("flux_schnell.safetensors", "checkpoints"),
      model("sd15.safetensors", "checkpoints"),
    ]);
    const { data } = await listLocalModelsFallback({ action: "search", text: "flux", limit: 1 });
    expect(data).toMatchObject({ count: 1, results: [{ name: "flux_dev.safetensors", type: "checkpoints" }] });
  });

  it("show returns the exact (case-insensitive) name match", async () => {
    mocks.listLocalModels.mockResolvedValue([
      model("flux_dev.safetensors", "checkpoints"),
      model("flux_schnell.safetensors", "checkpoints"),
    ]);
    const { data } = await listLocalModelsFallback({ action: "show", name: "FLUX_DEV.safetensors" });
    expect(data).toMatchObject({ name: "flux_dev.safetensors", type: "checkpoints" });
  });

  it("show does NOT substring-guess — a partial name with multiple matches is not-found", async () => {
    mocks.listLocalModels.mockResolvedValue([
      model("flux_dev.safetensors", "checkpoints"),
      model("flux_schnell.safetensors", "checkpoints"),
    ]);
    await expect(listLocalModelsFallback({ action: "show", name: "flux" })).rejects.toThrow(/was not found/i);
  });

  it("throws a clear error when neither comfy-cli nor a reachable server is available", async () => {
    mocks.listLocalModels.mockResolvedValue([]);
    mocks.getSystemStats.mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(listLocalModelsFallback({ action: "list-folders" })).rejects.toThrow(
      /no local model source is available/i,
    );
  });

  it("returns an empty list (not an error) when the server is reachable but empty", async () => {
    mocks.listLocalModels.mockResolvedValue([]);
    mocks.getSystemStats.mockResolvedValue({});
    const { data } = await listLocalModelsFallback({ action: "list-folders" });
    expect(data).toEqual({ folders: [] });
  });
});
