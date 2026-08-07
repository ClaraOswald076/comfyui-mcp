import { getTracker } from "../services/generation-tracker.js";

/**
 * `get_history (action:"suggest")` — the handler the standalone settings-advice
 * tool used to carry (0.50.0 slice 16), unchanged apart from losing its own
 * registration.
 *
 * Same tracker queries in the same precedence order (lora_hash, then search,
 * then model_family, else overall top settings), the same "no history" message,
 * and the same rendered markdown. The try/catch moved OUT to the dispatcher in
 * diagnostics.ts, which applies the identical `errorToToolResult`.
 */
export async function suggestSettingsAction(args: {
  model_family?: string;
  lora_hash?: string;
  search?: string;
  limit?: number;
}): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const tracker = getTracker();
  const limit = args.limit ?? 10;

  let results;
  let heading: string;

  if (args.lora_hash) {
    results = tracker.suggestSettingsForLora(args.lora_hash, limit);
    heading = `Top settings for LoRA ${args.lora_hash}`;
  } else if (args.search) {
    results = tracker.searchByName(args.search, limit);
    heading = `Settings matching "${args.search}"`;
  } else if (args.model_family) {
    results = tracker.suggestSettings(args.model_family, limit);
    heading = `Top settings for ${args.model_family}`;
  } else {
    // No filter — show overall top settings
    const stats = tracker.getStats();
    results = stats.topSettings;
    heading = "Top settings across all models";
  }

  if (results.length === 0) {
    return {
      content: [
        {
          type: "text",
          text: "No generation history found. Run some workflows first to build up settings data.",
        },
      ],
    };
  }

  const lines = [`## ${heading}\n`];
  for (const [i, s] of results.entries()) {
    const lora = s.loraName
      ? `LoRA: ${s.loraName} (${s.loraStrength})`
      : "no LoRA";
    lines.push(
      `${i + 1}. **${s.sampler}/${s.scheduler}** — ${s.steps} steps, CFG ${s.cfg}` +
        (s.shift != null ? `, shift ${s.shift}` : "") +
        `, denoise ${s.denoise}` +
        `\n   Model: ${s.modelName ?? s.modelHash} (${s.modelFamily})` +
        `\n   ${lora}` +
        `\n   Used ${s.reuseCount}x` +
        (s.presetName ? ` | Preset: ${s.presetName}` : ""),
    );
  }

  return { content: [{ type: "text", text: lines.join("\n") }] };
}

/**
 * `get_history (action:"stats")` — the handler the standalone generation-stats
 * tool used to carry (0.50.0 slice 16), unchanged apart from losing its own
 * registration.
 *
 * Same tracker.getStats() call (optionally scoped by model_family) and the same
 * rendered markdown, empty sections included. The try/catch moved OUT to the
 * dispatcher in diagnostics.ts.
 */
export async function generationStatsAction(args: {
  model_family?: string;
}): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const tracker = getTracker();
  const stats = tracker.getStats(args.model_family);

  const lines: string[] = [];

  if (args.model_family) {
    lines.push(`## Generation Stats: ${args.model_family}\n`);
  } else {
    lines.push("## Generation Stats\n");
  }

  lines.push(`- **Total generations**: ${stats.totalGenerations}`);
  lines.push(`- **Unique setting combos**: ${stats.uniqueCombos}`);

  if (stats.modelBreakdown.length > 0) {
    lines.push("\n### By model family\n");
    for (const b of stats.modelBreakdown) {
      lines.push(`- ${b.modelFamily}: ${b.count} generations`);
    }
  }

  if (stats.topSettings.length > 0) {
    lines.push("\n### Most-used settings\n");
    for (const [i, s] of stats.topSettings.entries()) {
      const lora = s.loraName ? ` + ${s.loraName}` : "";
      lines.push(
        `${i + 1}. ${s.modelFamily} / ${s.sampler}/${s.scheduler} / ` +
          `${s.steps} steps / CFG ${s.cfg}${lora} — ${s.reuseCount}x`,
      );
    }
  }

  return { content: [{ type: "text", text: lines.join("\n") }] };
}
