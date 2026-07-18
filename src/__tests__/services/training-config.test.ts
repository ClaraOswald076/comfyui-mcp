import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  buildTrainingConfig,
  DEFAULT_PARAMS,
  type TrainingConfigInput,
} from "../../services/training-config.js";

const base: TrainingConfigInput = {
  name: "Ciri LoRA",
  flow: "character",
  model: "flux1-dev",
  datasetPath: "/dataset",
  outputDir: "/output",
  trigger: "ohwx",
};

/** Reach into the single sd_trainer process block. */
function proc(input: TrainingConfigInput) {
  const { config } = buildTrainingConfig(input);
  const cfg = config.config as { name: string; process: Record<string, unknown>[] };
  return { name: cfg.name, p: cfg.process[0] };
}

describe("buildTrainingConfig (character / flux1-dev)", () => {
  it("emits the ai-toolkit job/config/process skeleton", () => {
    const { config } = buildTrainingConfig(base);
    expect(config.job).toBe("extension");
    const cfg = config.config as { name: string; process: unknown[] };
    expect(cfg.name).toBe("Ciri_LoRA"); // sanitized (space → _)
    expect(cfg.process).toHaveLength(1);
    expect((cfg.process[0] as { type: string }).type).toBe("sd_trainer");
  });

  it("maps flux1-dev to the right model + scheduler + optimizer", () => {
    const { p } = proc(base);
    const model = p.model as Record<string, unknown>;
    expect(model.name_or_path).toBe("black-forest-labs/FLUX.1-dev");
    expect(model.is_flux).toBe(true);
    expect(model.quantize).toBe(true);
    const train = p.train as Record<string, unknown>;
    expect(train.noise_scheduler).toBe("flowmatch");
    expect(train.optimizer).toBe("adamw8bit");
    expect(train.dtype).toBe("bf16");
    expect(train.train_text_encoder).toBe(false);
    expect((p.sample as Record<string, unknown>).sampler).toBe("flowmatch"); // must match scheduler
  });

  it("applies default params + wires the LoRA rank into network", () => {
    const { p } = proc(base);
    const net = p.network as Record<string, unknown>;
    expect(net.type).toBe("lora");
    expect(net.linear).toBe(DEFAULT_PARAMS.rank);
    expect(net.linear_alpha).toBe(DEFAULT_PARAMS.rank);
    const train = p.train as Record<string, unknown>;
    expect(train.steps).toBe(DEFAULT_PARAMS.steps);
    expect(train.batch_size).toBe(1);
    expect((p.datasets as Record<string, unknown>[])[0].resolution).toEqual([512, 768, 1024]);
  });

  it("honors param overrides", () => {
    const { p } = proc({ ...base, params: { steps: 200, rank: 32, resolution: [512], quantize: false } });
    expect((p.train as Record<string, unknown>).steps).toBe(200);
    expect((p.network as Record<string, unknown>).linear).toBe(32);
    expect((p.datasets as Record<string, unknown>[])[0].resolution).toEqual([512]);
    expect((p.model as Record<string, unknown>).quantize).toBe(false);
  });

  it("sets trigger_word and substitutes [trigger] in sample prompts", () => {
    const { p } = proc(base);
    expect(p.trigger_word).toBe("ohwx");
    const prompts = (p.sample as { prompts: string[] }).prompts;
    expect(prompts.every((pr) => pr.startsWith("ohwx "))).toBe(true);
    expect(prompts.some((pr) => pr.includes("[trigger]"))).toBe(false);
  });

  it("strips [trigger] cleanly when no trigger is given", () => {
    const { trigger, ...noTrigger } = base;
    void trigger;
    const { p } = proc(noTrigger);
    expect(p.trigger_word).toBeUndefined();
    const prompts = (p.sample as { prompts: string[] }).prompts;
    expect(prompts.some((pr) => pr.includes("[trigger]"))).toBe(false);
    expect(prompts[0].startsWith("a photo")).toBe(true);
  });

  it("points datasets + training_folder at the given paths", () => {
    const { p } = proc(base);
    expect(p.training_folder).toBe("/output");
    expect((p.datasets as Record<string, unknown>[])[0].folder_path).toBe("/dataset");
  });

  it("produces valid YAML that round-trips", () => {
    const { yaml, config } = buildTrainingConfig(base);
    expect(yaml).toContain("job: extension");
    expect(parse(yaml)).toEqual(config);
  });

  it("rejects unsupported flow/model", () => {
    // @ts-expect-error - exercising the runtime guard with a bad flow
    expect(() => buildTrainingConfig({ ...base, flow: "style" })).toThrow(/unsupported training flow/);
    // @ts-expect-error - exercising the runtime guard with a bad model
    expect(() => buildTrainingConfig({ ...base, model: "sdxl" })).toThrow(/unsupported base model/);
  });
});
