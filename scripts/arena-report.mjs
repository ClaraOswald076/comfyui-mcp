// Shared LLM Arena report builder (#792) — used by BOTH scripts/llm-arena.mjs
// (fresh runs) and scripts/arena-bestof.mjs (best-of-N merge + regeneration),
// so the markdown shape can never drift between the two writers again.
//
// The report carries the three #792 axes:
//   1. VRAM — resident size of the model during its run (Ollama /api/ps), so a
//      reader on an 8 GB card can see which entries they can even load.
//   2. Quantization — the tag's quantization_level (/api/show), so the same
//      model at q4/q8/fp16 can be compared against the same ladder.
//   3. Version stamping — every run records the comfyui-mcp version, and the
//      report refuses to let pre/post-consolidation numbers be compared
//      directly (absolute scores move when the tool surface changes).
// Plus the methodology guard: a scenario where EVERY model failed after
// reaching for the same wrong tool reads as OUR description bug, not a
// field-wide capability gap (#557/#654 precedent) — flagged, never asserted.

/** Resident VRAM as "GiB" with one decimal, or null when unknown. */
export function vramLabel(bytes) {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes <= 0) return null;
  return (bytes / (1024 * 1024 * 1024)).toFixed(1);
}

const nudgesOf = (m) => m.results.reduce((s, r) => s + (r.nudges ?? 0), 0);
const roundsOf = (m) => m.results.reduce((s, r) => s + (r.rounds ?? 0), 0);
const secondsOf = (m) => m.results.reduce((s, r) => s + (r.seconds ?? 0), 0);

/**
 * The wrong-tool-dispatch signal (#792 methodology caveat): for each scenario,
 * look at the models that FAILED it and which non-primary tool they reached
 * for. One tool attempted by 2+ failing models (and by no passing one) is a
 * systematic wrong selection — that pattern is a tool-DESCRIPTION suspect, not
 * evidence about the field. Returns one line per suspect scenario.
 */
export function suspectScenarioLines(data) {
  const lines = [];
  const scen = data.scenarios ?? [];
  const board = data.leaderboard ?? [];
  // Tool descriptions move with the version, so the field-wide signal is only
  // meaningful WITHIN one known version: pool the majority cohort, exclude
  // unversioned entries (their version is unknown, not "the same") and any
  // minority-version ones. An all-legacy board yields no suspects at all.
  // Only a direct mcpVersion stamp counts: a best-of range that MIXED a
  // stamped and an unstamped run keeps mcpVersions but drops mcpVersion, and
  // that range is not safely one version.
  const versionOf = (m) => m.mcpVersion;
  const cohorts = new Map();
  for (const m of board) {
    const v = versionOf(m);
    if (v) cohorts.set(v, (cohorts.get(v) ?? 0) + 1);
  }
  const majority = [...cohorts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (majority === undefined) return lines;
  for (const s of scen) {
    // A legacy (pre-#792) results file carries no primary/partial lists — with
    // no notion of the RIGHT tool, any shared selection could be flagged
    // falsely. Unknown → no claim; skip the scenario entirely.
    if (!Array.isArray(s.primary)) continue;
    const rightTools = new Set([...(s.primary ?? []), ...(s.partial ?? [])]);
    const failed = [];
    const passed = [];
    for (const m of board) {
      if (versionOf(m) !== majority) continue;
      const r = (m.results ?? []).find((x) => x.scenario === s.id);
      if (!r) continue;
      // Only a SELECTION failure counts: a run that reached a primary/partial
      // tool and still failed lost on execution or verification, not on tool
      // choice — its other tool calls prove nothing about descriptions. And
      // only runs that RECORD attempts qualify: legacy results carry okTools
      // (successes only), so a legacy fail that tried the right tool and
      // watched it error looks identical to one that never selected it —
      // reading okTools as attempts would flag that as a wrong selection.
      if (
        r.score === 0 &&
        Array.isArray(r.attemptedTools) &&
        !r.attemptedTools.some((t) => rightTools.has(t))
      ) {
        failed.push({ model: m.model, r });
      }
      // Only a full PASS vindicates a tool: a PARTIAL is right-family but
      // incomplete — its tool use proves nothing about the selection being
      // right, so it must not suppress a suspect flag. (okTools suffices here:
      // a tool in a passing run's successes genuinely ran.)
      if (r.score === 2) passed.push(r);
    }
    // The signal is FIELD-WIDE: it needs 2+ DISTINCT failing models. Duplicate
    // entries for one model (a repeated ARENA_MODELS entry, an un-merged extra
    // run) are one model, not a field.
    const failedModels = new Set(failed.map((f) => f.model));
    if (failedModels.size < 2) continue;
    // Count, per non-primary tool, how many DISTINCT failing models reached it.
    const byTool = new Map();
    for (const f of failed) {
      for (const t of new Set(f.r.attemptedTools)) {
        // "?" is how older runs recorded an unparseable call_tool — not a real
        // selection, never a suspect.
        if (t === "?" || rightTools.has(t)) continue;
        if (!byTool.has(t)) byTool.set(t, new Set());
        byTool.get(t).add(f.model);
      }
    }
    for (const [tool, models] of byTool) {
      if (models.size < 2) continue;
      // A tool a PASSING run also used is not "wrong" for this scenario.
      const usedByPasser = passed.some((r) =>
        (r.attemptedTools ?? r.okTools ?? []).includes(tool),
      );
      if (usedByPasser) continue;
      lines.push(
        `- **${s.id}**: ${models.size} of ${failedModels.size} failing models reached for \`${tool}\` (none of the passing runs did). A field-wide wrong selection reads as a tool-description suspect, not a capability gap — check that tool's description before trusting this scenario's scores.`,
      );
    }
  }
  return lines;
}

/** Render the share-ready arena markdown report from a results JSON object. */
export function buildArenaReport(data) {
  const icon = { 2: "✅", 1: "🟡", 0: "❌" };
  const scen = data.scenarios ?? [];
  const board = data.leaderboard ?? [];
  const md = [];
  md.push("# ComfyUI LLM Arena", "");
  md.push(
    `Models driving a real ComfyUI (${data.gpu ?? "unknown GPU"}) through [comfyui-mcp](https://github.com/artokun/comfyui-mcp)'s ` +
      `compact tool mode — 3 meta-tools instead of ~200 schemas, so every model class can play. ` +
      `Each model gets the identical task set; results are verified against the ComfyUI server, not the model's claims.`,
    "",
  );
  const header = ["Model", "Tier", "Params", "Quant", "VRAM", ...scen.map((s) => s.id), "Score", "Nudges", "Rounds", "Time"];
  md.push(`| ${header.join(" | ")} |`, `|${header.map(() => "---").join("|")}|`);
  for (const m of board) {
    const cells = m.results.map((r) => icon[r.score]);
    const totals = m.runs?.totals;
    const score =
      totals && totals.length > 1
        ? `**${m.total}/${m.max}** (best of ${totals.length}: ${Math.min(...totals)}–${Math.max(...totals)})`
        : `**${m.total}/${m.max}**`;
    const vram = vramLabel(m.vramResidentBytes);
    md.push(
      `| \`${m.model}\` | ${m.tier ?? "local"} | ${m.params ?? "—"} | ${m.quant ?? "—"} | ${vram ? `${vram} GiB` : "—"} | ${cells.join(" | ")} | ${score} | ${nudgesOf(m)} | ${roundsOf(m)} | ${secondsOf(m)}s |`,
    );
  }
  md.push("", `Scenarios: ${scen.map((s) => `**${s.id}** (${s.title.toLowerCase()})`).join(" · ")}`, "");
  md.push(`✅ completed & server-verified · 🟡 right tool family, incomplete outcome · ❌ failed`, "");

  // Version comparability (#792 sequencing note): absolute scores move when the
  // tool surface changes, so the report must never invite a cross-version read.
  const versions = [...new Set(board.map((m) => m.mcpVersion).filter(Boolean))];
  const unversioned = board.some((m) => !m.mcpVersion);
  if (versions.length === 1 && !unversioned) {
    md.push(`Recorded with comfyui-mcp v${versions[0]} — scores are only directly comparable within the same comfyui-mcp version.`, "");
  } else if (versions.length || unversioned) {
    md.push(
      `⚠️ This leaderboard mixes recordings (${versions.length ? `versions ${versions.map((v) => `v${v}`).join(", ")}` : ""}${versions.length && unversioned ? " and " : ""}${unversioned ? "unversioned runs — recorded before version stamping, or whose own version could not be read" : ""}) — do NOT compare scores across them directly.`,
      "",
    );
  }

  const suspects = suspectScenarioLines(data);
  if (suspects.length) {
    md.push("### Suspect scenarios (systematic wrong-tool selection)", "");
    md.push(...suspects, "");
  }

  md.push("Reproduce: `npm run arena` — bring your own models via `ARENA_MODELS=...` (see docs/arena)");
  return `${md.join("\n")}\n`;
}
