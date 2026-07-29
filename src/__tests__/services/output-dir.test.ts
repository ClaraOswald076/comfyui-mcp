import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isAbsolute, join, resolve } from "node:path";

vi.mock("../../config.js", () => ({
  config: { comfyuiPath: "/comfy" as string | undefined },
}));

const getSystemStats = vi.fn();
vi.mock("../../comfyui/client.js", () => ({
  getSystemStats: (...a: unknown[]) => getSystemStats(...a),
}));

import {
  parseOutputDirFromArgv,
  localOutputDirFallback,
  resolveOutputDir,
  parseInputDirFromArgv,
  localInputDirFallback,
  resolveInputDir,
  parseBaseDirFromArgv,
  parseModelsDirFromArgv,
  parseExtraModelPathsConfigsFromArgv,
  resolveModelsDir,
  resolveServerExtraModelConfig,
} from "../../services/output-dir.js";
import { config } from "../../config.js";

beforeEach(() => {
  getSystemStats.mockReset();
  (config as { comfyuiPath?: string }).comfyuiPath = "/comfy";
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("parseOutputDirFromArgv", () => {
  it("returns undefined when no relevant flags are present", () => {
    expect(parseOutputDirFromArgv(["python", "main.py", "--listen"])).toBeUndefined();
    expect(parseOutputDirFromArgv([])).toBeUndefined();
    expect(parseOutputDirFromArgv(undefined)).toBeUndefined();
  });

  it("parses --output-directory <value>", () => {
    const abs = resolve("/shared/ComfyUI-Shared/output");
    const got = parseOutputDirFromArgv(["main.py", "--output-directory", abs]);
    expect(got).toBe(abs);
  });

  it("parses --output-directory=<value>", () => {
    const abs = resolve("/shared/out");
    expect(parseOutputDirFromArgv(["main.py", `--output-directory=${abs}`])).toBe(abs);
  });

  it("derives <base>/output from --base-directory", () => {
    const base = resolve("/srv/comfy-base");
    expect(parseOutputDirFromArgv(["main.py", "--base-directory", base])).toBe(
      join(base, "output"),
    );
  });

  it("lets --output-directory win over --base-directory", () => {
    const base = resolve("/srv/base");
    const out = resolve("/srv/explicit-out");
    const got = parseOutputDirFromArgv([
      "main.py",
      "--base-directory",
      base,
      "--output-directory",
      out,
    ]);
    expect(got).toBe(out);
  });
});

describe("localOutputDirFallback", () => {
  it("returns <COMFYUI_PATH>/output", () => {
    expect(localOutputDirFallback()).toBe(resolve("/comfy", "output"));
  });

  it("throws when COMFYUI_PATH is unset", () => {
    (config as { comfyuiPath?: string }).comfyuiPath = undefined;
    expect(() => localOutputDirFallback()).toThrow(/COMFYUI_PATH/);
  });
});

describe("resolveOutputDir", () => {
  it("uses the redirected dir reported by /system_stats argv", async () => {
    const redirected = resolve("/shared/ComfyUI-Shared/output");
    getSystemStats.mockResolvedValue({
      system: { argv: ["python", "main.py", "--output-directory", redirected] },
    });
    const got = await resolveOutputDir();
    expect(got).toBe(redirected);
    expect(got).not.toBe(resolve("/comfy", "output"));
    expect(isAbsolute(got)).toBe(true);
  });

  it("falls back to <COMFYUI_PATH>/output when argv has no override", async () => {
    getSystemStats.mockResolvedValue({ system: { argv: ["python", "main.py"] } });
    expect(await resolveOutputDir()).toBe(resolve("/comfy", "output"));
  });

  it("falls back to <COMFYUI_PATH>/output when /system_stats is unreachable", async () => {
    getSystemStats.mockRejectedValue(new Error("ECONNREFUSED"));
    expect(await resolveOutputDir()).toBe(resolve("/comfy", "output"));
  });
});

describe("parseInputDirFromArgv", () => {
  it("returns undefined when no relevant flags are present", () => {
    expect(parseInputDirFromArgv(["python", "main.py", "--listen"])).toBeUndefined();
    expect(parseInputDirFromArgv([])).toBeUndefined();
    expect(parseInputDirFromArgv(undefined)).toBeUndefined();
  });

  it("parses --input-directory <value>", () => {
    const abs = resolve("/shared/ComfyUI-Shared/input");
    const got = parseInputDirFromArgv(["main.py", "--input-directory", abs]);
    expect(got).toBe(abs);
  });

  it("parses --input-directory=<value>", () => {
    const abs = resolve("/shared/in");
    expect(parseInputDirFromArgv(["main.py", `--input-directory=${abs}`])).toBe(abs);
  });

  it("derives <base>/input from --base-directory", () => {
    const base = resolve("/srv/comfy-base");
    expect(parseInputDirFromArgv(["main.py", "--base-directory", base])).toBe(
      join(base, "input"),
    );
  });

  it("lets --input-directory win over --base-directory", () => {
    const base = resolve("/srv/base");
    const inp = resolve("/srv/explicit-in");
    const got = parseInputDirFromArgv([
      "main.py",
      "--base-directory",
      base,
      "--input-directory",
      inp,
    ]);
    expect(got).toBe(inp);
  });
});

describe("localInputDirFallback", () => {
  it("returns <COMFYUI_PATH>/input", () => {
    expect(localInputDirFallback()).toBe(resolve("/comfy", "input"));
  });

  it("throws when COMFYUI_PATH is unset", () => {
    (config as { comfyuiPath?: string }).comfyuiPath = undefined;
    expect(() => localInputDirFallback()).toThrow(/COMFYUI_PATH/);
  });
});

describe("models dir + extra-config argv parsing (#345/#346/#369)", () => {
  it("parseBaseDirFromArgv reads --base-directory", () => {
    const base = resolve("/C/COMFY");
    expect(parseBaseDirFromArgv(["main.py", "--base-directory", base])).toBe(base);
    expect(parseBaseDirFromArgv(["main.py", "--listen"])).toBeUndefined();
  });

  it("parseModelsDirFromArgv derives <base>/models", () => {
    const base = resolve("/C/COMFY");
    expect(parseModelsDirFromArgv(["main.py", "--base-directory", base])).toBe(
      join(base, "models"),
    );
    expect(parseModelsDirFromArgv(["main.py"])).toBeUndefined();
  });

  it("parseModelsDirFromArgv lets --models-directory override <base>/models", () => {
    const base = resolve("/C/COMFY");
    const models = resolve("/D/models");
    expect(
      parseModelsDirFromArgv([
        "main.py",
        "--base-directory",
        base,
        "--models-directory",
        models,
      ]),
    ).toBe(models);
  });

  it("parseExtraModelPathsConfigsFromArgv collects repeated AND multi-value flags (nargs='+', append)", () => {
    const a = resolve("/cfg/shared_model_paths.yaml");
    const b = resolve("/cfg/other.yaml");
    const c = resolve("/cfg/third.yaml");
    // repeated flag + `=value` form
    expect(
      parseExtraModelPathsConfigsFromArgv([
        "main.py",
        "--extra-model-paths-config",
        a,
        `--extra-model-paths-config=${b}`,
      ]),
    ).toEqual([a, b]);
    // multiple values after a single flag, then another option
    expect(
      parseExtraModelPathsConfigsFromArgv([
        "main.py",
        "--extra-model-paths-config",
        a,
        b,
        c,
        "--port",
        "8188",
      ]),
    ).toEqual([a, b, c]);
    expect(parseExtraModelPathsConfigsFromArgv(["main.py"])).toEqual([]);
  });

  it("resolveModelsDir prefers the live server's --base-directory/models over COMFYUI_PATH", async () => {
    const base = resolve("/C/COMFY");
    getSystemStats.mockResolvedValue({
      system: { argv: ["python", "main.py", "--base-directory", base] },
    });
    const got = await resolveModelsDir();
    expect(got).toBe(join(base, "models"));
    expect(got).not.toBe(resolve("/comfy", "models"));
  });

  it("resolveModelsDir falls back to <COMFYUI_PATH>/models when unreachable", async () => {
    getSystemStats.mockRejectedValue(new Error("ECONNREFUSED"));
    expect(await resolveModelsDir()).toBe(resolve("/comfy", "models"));
  });

  it("resolveServerExtraModelConfig returns the server's config file, undefined when absent", async () => {
    const cfg = resolve("/cfg/shared_model_paths.yaml");
    getSystemStats.mockResolvedValue({
      system: { argv: ["python", "main.py", "--extra-model-paths-config", cfg] },
    });
    expect(await resolveServerExtraModelConfig()).toBe(cfg);

    getSystemStats.mockResolvedValue({ system: { argv: ["python", "main.py"] } });
    expect(await resolveServerExtraModelConfig()).toBeUndefined();

    getSystemStats.mockRejectedValue(new Error("down"));
    expect(await resolveServerExtraModelConfig()).toBeUndefined();
  });
});

describe("resolveInputDir", () => {
  it("uses the redirected dir reported by /system_stats argv", async () => {
    const redirected = resolve("/shared/ComfyUI-Shared/input");
    getSystemStats.mockResolvedValue({
      system: { argv: ["python", "main.py", "--input-directory", redirected] },
    });
    const got = await resolveInputDir();
    expect(got).toBe(redirected);
    expect(got).not.toBe(resolve("/comfy", "input"));
    expect(isAbsolute(got)).toBe(true);
  });

  it("falls back to <COMFYUI_PATH>/input when argv has no override", async () => {
    getSystemStats.mockResolvedValue({ system: { argv: ["python", "main.py"] } });
    expect(await resolveInputDir()).toBe(resolve("/comfy", "input"));
  });

  it("falls back to <COMFYUI_PATH>/input when /system_stats is unreachable", async () => {
    getSystemStats.mockRejectedValue(new Error("ECONNREFUSED"));
    expect(await resolveInputDir()).toBe(resolve("/comfy", "input"));
  });
});
