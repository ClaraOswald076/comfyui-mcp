// Tests for the shared arena report builder (#792) — the VRAM/quant axes, the
// version-stamp comparability note, and the wrong-tool suspect analysis that
// separates "model chose wrong" from "our description made wrong look right".

import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
// @ts-expect-error plain-JS module under scripts/, no type declarations
import { buildArenaReport, suspectScenarioLines, vramLabel } from "../../scripts/arena-report.mjs";

function entry(over: Record<string, unknown>) {
  return {
    model: "gemma4:e4b",
    tier: "local",
    total: 0,
    max: 4,
    mcpVersion: "0.49.6",
    results: [],
    ...over,
  };
}

function result(over: Record<string, unknown>) {
  return {
    scenario: "health",
    score: 0,
    verdict: "FAIL",
    rounds: 3,
    nudges: 0,
    seconds: 10,
    okTools: [],
    attemptedTools: [],
    ...over,
  };
}

const SCEN = [
  { id: "health", title: "Server health", primary: ["health_check", "get_system_stats"], partial: [] },
  { id: "models", title: "Checkpoint discovery", primary: ["list_local_models"], partial: [] },
];

describe("arena-report (#792)", () => {
  it("vramLabel renders GiB with one decimal and refuses unknowns", () => {
    expect(vramLabel(8 * 1024 * 1024 * 1024)).toBe("8.0");
    expect(vramLabel(Math.round(3.46 * 1024 * 1024 * 1024))).toBe("3.5");
    expect(vramLabel(undefined)).toBeNull();
    expect(vramLabel(0)).toBeNull();
    expect(vramLabel(-5)).toBeNull();
  });

  it("renders the Params/Quant/VRAM columns when probed, an em-dash when not", () => {
    const withFacts = entry({
      model: "a:e4b",
      params: "7.5B",
      quant: "Q4_K_M",
      vramResidentBytes: 4 * 1024 * 1024 * 1024,
      results: [result({ score: 2, verdict: "PASS" })],
    });
    const without = entry({ model: "b:7b", results: [result({ score: 1, verdict: "PARTIAL" })] });
    const md = buildArenaReport({ gpu: "RTX 3070", mcpVersion: "0.49.6", scenarios: SCEN, leaderboard: [withFacts, without] });
    expect(md).toContain("| Params | Quant | VRAM |");
    expect(md).toContain("7.5B");
    expect(md).toContain("Q4_K_M");
    expect(md).toContain("4.0 GiB");
    // unknown axes are an honest dash, never a zero or a guess
    expect(md).toMatch(/\| `b:7b` \| local \| — \| — \| — \|/);
  });

  it("stamps a single-version leaderboard as same-version-comparable only", () => {
    const md = buildArenaReport({
      gpu: "g",
      mcpVersion: "0.49.6",
      scenarios: SCEN,
      leaderboard: [entry({ results: [result({})] })],
    });
    expect(md).toContain("comfyui-mcp v0.49.6");
    expect(md).toContain("only directly comparable within the same comfyui-mcp version");
    expect(md).not.toContain("do NOT compare");
  });

  it("warns against direct comparison when entries mix versions or predate stamping", () => {
    const md = buildArenaReport({
      gpu: "g",
      mcpVersion: "0.50.0",
      scenarios: SCEN,
      leaderboard: [
        entry({ model: "a", mcpVersion: "0.49.6", results: [result({})] }),
        entry({ model: "b", mcpVersion: "0.50.0", results: [result({})] }),
        entry({ model: "c", mcpVersion: undefined, results: [result({})] }),
      ],
    });
    expect(md).toContain("do NOT compare");
    expect(md).toContain("v0.49.6");
    expect(md).toContain("v0.50.0");
    expect(md).toContain("could not be read");
  });

  it("flags a scenario where 2+ failing models reached for the same non-primary tool — and only then", () => {
    const mkFail = (tool) => result({ score: 0, attemptedTools: [tool] });
    const data = {
      gpu: "g",
      scenarios: SCEN,
      leaderboard: [
        entry({ model: "a", results: [mkFail("panel_screenshot")] }),
        entry({ model: "b", results: [mkFail("panel_screenshot")] }),
        entry({ model: "c", results: [result({ score: 2, attemptedTools: ["health_check"] })] }),
      ],
    };
    const lines = suspectScenarioLines(data);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("health");
    expect(lines[0]).toContain("panel_screenshot");
    expect(lines[0]).toContain("description suspect");

    // the same tool used by a PASSING run is not "wrong" for the scenario
    const withPasser = {
      ...data,
      leaderboard: [
        ...data.leaderboard.slice(0, 2),
        entry({ model: "c", results: [result({ score: 2, attemptedTools: ["health_check", "panel_screenshot"] })] }),
      ],
    };
    expect(suspectScenarioLines(withPasser)).toHaveLength(0);

    // "?" (an unparseable call_tool from an older run) is not a real selection
    const questionMarks = {
      ...data,
      leaderboard: [
        entry({ model: "a", results: [result({ score: 0, attemptedTools: ["?"] })] }),
        entry({ model: "b", results: [result({ score: 0, attemptedTools: ["?"] })] }),
      ],
    };
    expect(suspectScenarioLines(questionMarks)).toHaveLength(0);

    // a failure that DID reach the right tool lost on execution/verification,
    // not on selection — its other calls are not a description signal
    const reachedPrimary = {
      ...data,
      leaderboard: [
        entry({ model: "a", results: [result({ score: 0, attemptedTools: ["health_check", "panel_screenshot"] })] }),
        entry({ model: "b", results: [result({ score: 0, attemptedTools: ["health_check", "panel_screenshot"] })] }),
      ],
    };
    expect(suspectScenarioLines(reachedPrimary)).toHaveLength(0);

    // ...but a PARTIAL run using it vindicates nothing — the flag stands
    const withPartial = {
      ...data,
      leaderboard: [
        ...data.leaderboard.slice(0, 2),
        entry({ model: "c", results: [result({ score: 1, attemptedTools: ["health_check", "panel_screenshot"] })] }),
      ],
    };
    expect(suspectScenarioLines(withPartial)).toHaveLength(1);

    // a single failing model is not a field-wide signal
    expect(
      suspectScenarioLines({ ...data, leaderboard: data.leaderboard.slice(0, 1) }),
    ).toHaveLength(0);

    // failing models reaching for DIFFERENT tools is model behaviour, not a description bug
    const divergent = {
      ...data,
      leaderboard: [
        entry({ model: "a", results: [mkFail("panel_screenshot")] }),
        entry({ model: "b", results: [mkFail("view_image")] }),
      ],
    };
    expect(suspectScenarioLines(divergent)).toHaveLength(0);
  });

  it("a legacy results file without primary/partial lists is UNKNOWN — never a false suspect", () => {
    const mkFail = (tool) => result({ score: 0, attemptedTools: [tool] });
    const legacy = {
      gpu: "g",
      // pre-#792 shape: id/title/task only, no primary — even the CORRECT tool
      // shared by two failing runs must not read as a wrong-tool suspect.
      scenarios: SCEN.map(({ id, title }) => ({ id, title })),
      leaderboard: [
        entry({ model: "a", results: [mkFail("health_check")] }),
        entry({ model: "b", results: [mkFail("health_check")] }),
      ],
    };
    expect(suspectScenarioLines(legacy)).toHaveLength(0);
  });

  it("the suspect section lands in the rendered report", () => {
    const mkFail = (tool) => result({ score: 0, attemptedTools: [tool] });
    const md = buildArenaReport({
      gpu: "g",
      scenarios: SCEN,
      leaderboard: [
        entry({ model: "a", results: [mkFail("panel_screenshot")] }),
        entry({ model: "b", results: [mkFail("panel_screenshot")] }),
      ],
    });
    expect(md).toContain("Suspect scenarios");
    expect(md).toContain("panel_screenshot");
  });
});

describe("arena-bestof cross-version merge guard (#792)", () => {
  const BESTOF = join(__dirname, "..", "..", "scripts", "arena-bestof.mjs");

  function fixture(baseEntry: Record<string, unknown>, extraEntry: Record<string, unknown>) {
    const root = mkdtempSync(join(tmpdir(), "arena-bestof-"));
    const base = join(root, "base");
    const extra = join(root, "extra");
    mkdirSync(base, { recursive: true });
    mkdirSync(extra, { recursive: true });
    const scen = [{ id: "health", title: "Server health", task: "t", primary: ["health_check"], partial: [] }];
    writeFileSync(join(base, "arena-results.json"), JSON.stringify({ gpu: "g", scenarios: scen, leaderboard: [baseEntry] }));
    writeFileSync(join(extra, "arena-results.json"), JSON.stringify({ gpu: "g", scenarios: scen, leaderboard: [extraEntry] }));
    return { base, extra };
  }

  function run(base: string, extra: string) {
    const r = spawnSync(process.execPath, [BESTOF, base, extra], { encoding: "utf8" });
    return {
      out: `${r.stdout ?? ""}\n${r.stderr ?? ""}`,
      merged: JSON.parse(readFileSync(join(base, "arena-results.json"), "utf8")),
    };
  }

  const mkEntry = (version: string | undefined, total: number) => ({
    model: "m:e4b",
    tier: "local",
    total,
    max: 20,
    ...(version ? { mcpVersion: version } : {}),
    results: [result({ score: total > 10 ? 2 : 0 })],
  });

  it("refuses to best-of-merge runs from different comfyui-mcp versions — loudly", () => {
    const { base, extra } = fixture(mkEntry("0.49.6", 20), mkEntry("0.50.0", 19));
    const { out, merged } = run(base, extra);
    expect(out).toContain("not directly comparable");
    expect(merged.leaderboard[0].runs).toBeUndefined(); // NOT merged
    expect(merged.leaderboard[0].total).toBe(20);
  });

  it("merges same-version runs and keeps the version", () => {
    const { base, extra } = fixture(mkEntry("0.49.6", 20), mkEntry("0.49.6", 19));
    const { merged } = run(base, extra);
    expect(merged.leaderboard[0].runs.totals).toEqual([20, 19]);
    expect(merged.leaderboard[0].mcpVersion).toBe("0.49.6");
  });

  it("a merge with an unversioned run drops the version claim — the range mixes a stamped and an unstamped run", () => {
    const { base, extra } = fixture(mkEntry("0.49.6", 20), mkEntry(undefined, 19));
    const { merged } = run(base, extra);
    expect(merged.leaderboard[0].runs.totals).toEqual([20, 19]);
    expect("mcpVersion" in merged.leaderboard[0]).toBe(false);
  });

  it("a candidate that is itself an unversioned merged range is checked by its mcpVersions, both directions", () => {
    // base is v0.50.0; the candidate carries no mcpVersion but remembers v0.49.6
    const candidate = { ...mkEntry(undefined, 19), mcpVersions: ["0.49.6"] };
    const { base, extra } = fixture(mkEntry("0.50.0", 20), candidate);
    const { out, merged } = run(base, extra);
    expect(out).toContain("not directly comparable");
    expect(merged.leaderboard[0].runs).toBeUndefined();
  });

  it("an unversioned intermediate merge does not launder a later cross-version run into the range", () => {
    const { base, extra } = fixture(mkEntry("0.49.6", 20), mkEntry(undefined, 19));
    run(base, extra); // merges; entry is now unversioned but remembers v0.49.6
    const root = dirname(base);
    const extra2 = join(root, "extra2");
    mkdirSync(extra2, { recursive: true });
    writeFileSync(
      join(extra2, "arena-results.json"),
      JSON.stringify({
        gpu: "g",
        scenarios: [{ id: "health", title: "Server health", task: "t", primary: ["health_check"], partial: [] }],
        leaderboard: [mkEntry("0.50.0", 18)],
      }),
    );
    const { out, merged } = run(base, extra2);
    expect(out).toContain("not directly comparable"); // refused — v0.50.0 vs the v0.49.6 already in the range
    expect(merged.leaderboard[0].runs.totals).toEqual([20, 19]); // unchanged
  });
});
