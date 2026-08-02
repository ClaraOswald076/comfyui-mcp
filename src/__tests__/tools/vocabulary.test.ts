import { describe, expect, it } from "vitest";
import {
  BASELINE_SHA256,
  DEAD_NAMES,
  MAX_TOOLS,
  retirementBaseline,
  TOOL_NAMES,
  baselineIntegrity,
  deadNameRe,
  findDeadName,
  retiredToolMessage,
} from "../../tools/vocabulary.js";

/**
 * The dead-name matching contract.
 *
 * scripts/check-tool-vocabulary.mts fails the build on references to removed
 * tools, and during the 0.49.0 consolidation ~250 names die — so this regex
 * decides, hundreds of times, whether a real problem is reported or correct code
 * is falsely flagged. Both failure directions are expensive:
 *
 *  - a MISS leaves a hint string telling a model to call a tool that 404s, which
 *    the model cannot diagnose and the user sees as a broken feature;
 *  - a FALSE POSITIVE trains everyone to widen the allowlist, which disarms the
 *    gate permanently.
 *
 * It gets its own test because `\b` looks obviously right here and is wrong.
 */
describe("deadNameRe", () => {
  const matches = (name: string, text: string) => deadNameRe(name).test(text);

  it("matches a bare reference", () => {
    expect(matches("get_image", "call get_image now")).toBe(true);
  });

  // The case that rules out \b: `_` is a word character, so \bget_image\b does
  // NOT match here — and this is the form tool names take in agent transcripts,
  // skill files, and anything quoting a Claude Code tool id.
  it("matches through an mcp__<server>__ prefix", () => {
    expect(matches("get_image", "mcp__comfyui__get_image")).toBe(true);
    expect(matches("panel_get_graph", "use mcp__comfyui_panel__panel_get_graph")).toBe(true);
  });

  // Plan constraint 7, with real data behind it: packs/artokun-flow/workflow.json
  // contains `retarget_image`, which a substring search for `get_image` hits.
  it("rejects a name embedded in a longer identifier", () => {
    expect(matches("get_image", "retarget_image")).toBe(false);
    expect(matches("get_image", '"retarget_image": 5130')).toBe(false);
    expect(matches("get_image", "my_get_image")).toBe(false);
  });

  it("rejects a name that is a prefix of a different name", () => {
    expect(matches("get_image", "get_images")).toBe(false);
    expect(matches("train_start", "train_started_at")).toBe(false);
    // The dangerous one: a dead name whose live REPLACEMENT contains it.
    expect(matches("panel_get_graph", "panel_get_graph_outline")).toBe(false);
  });

  it("survives regex metacharacters in a name", () => {
    expect(() => deadNameRe("weird.name+v2")).not.toThrow();
    expect(matches("weird.name+v2", "weird.name+v2")).toBe(true);
    expect(matches("weird.name+v2", "weirdXnameXv2")).toBe(false);
  });
});

describe("DEAD_NAMES ledger", () => {
  // Enforced in the checker too, but as a test it fails fast and locally: a
  // revert that re-registers a tool while the ledger still calls it dead would
  // otherwise only surface in CI.
  it("lists no name that is currently registered", () => {
    const alive = new Set<string>(TOOL_NAMES);
    expect(DEAD_NAMES.filter((d) => alive.has(d.name)).map((d) => d.name)).toEqual([]);
  });

  // THE RATCHET. Without this, the guardrails only ever compare the new registry
  // against the newly-edited ledger — both changed in the same commit — so a removal
  // that forgets its DEAD_NAMES entry passes every gate, and the dead-name scan is
  // silently disarmed for that name because it only hunts names already listed.
  //
  // Against the frozen baseline the obligation cannot be forgotten: anything that
  // existed at 0.48.6 and no longer exists must be declared dead, with a
  // replacement, or the build fails.
  it("declares every retired name dead (baseline \\ ledger ⊆ DEAD_NAMES)", () => {
    const alive = new Set<string>(TOOL_NAMES);
    const declaredDead = new Set(DEAD_NAMES.map((d) => d.name));
    const retiredButNotDeclared = retirementBaseline().filter(
      (n) => !alive.has(n) && !declaredDead.has(n),
    );
    expect(
      retiredButNotDeclared,
      "These tools existed at 0.48.6 and are no longer registered, but are absent from " +
        "DEAD_NAMES — so nothing will flag the prose, hint strings and docs that still " +
        "tell a model to call them. Add each to DEAD_NAMES with a replacement.",
    ).toEqual([]);
  });

  // The ratchet is only as strong as the baseline it measures against, and the
  // baseline is an ordinary tracked file. Deleting a line from it in the same commit
  // as a removal made the whole invariant vacuous.
  it("has an unmodified retirement baseline", () => {
    const { ok, actual } = baselineIntegrity();
    expect(
      ok,
      `docs/design/tool-surface.txt changed (sha256 ${actual}, expected ${BASELINE_SHA256}). ` +
        "Deleting a line disables the retirement ratchet for that name. If you appended " +
        "newly shipped tools, update BASELINE_SHA256 deliberately.",
    ).toBe(true);
  });

  it("keeps MAX_TOOLS equal to the ledger size", () => {
    expect(MAX_TOOLS).toBe(TOOL_NAMES.length);
  });

  // The other half. Treating a live-but-unbaselined name as "simply new, which is fine"
  // was the hole: a name created after 0.48.6 never entered the baseline, so retiring it
  // later triggered nothing. That is exactly the Phase 5 shape — introduce comfy_queue,
  // retire it two slices on, and the ratchet never sees either event.
  it("has every live tool in the baseline (live ⊆ baseline)", () => {
    const baseline = new Set(retirementBaseline());
    expect(
      TOOL_NAMES.filter((n) => !baseline.has(n)),
      "A new tool must join docs/design/tool-surface.txt when it ships, or retiring it " +
        "later is unenforced. Append it, then update BASELINE_SHA256.",
    ).toEqual([]);
  });

  it("gives every dead name an actionable replacement", () => {
    expect(DEAD_NAMES.filter((d) => !d.replacement.trim()).map((d) => d.name)).toEqual([]);
  });

  // An exception without a reason is indistinguishable from someone silencing
  // the gate, which is the failure mode this whole ledger exists to prevent.
  it("gives every allowedIn exception a reason", () => {
    const unjustified = DEAD_NAMES.flatMap((d) =>
      (d.allowedIn ?? []).filter((a) => !a.why.trim()).map((a) => `${d.name} → ${a.path}`),
    );
    expect(unjustified).toEqual([]);
  });
});

/**
 * The call_tool side of the ledger (#659): an EXACT retired name — bare or
 * behind an mcp__<server>__ prefix — resolves to its entry so the caller can be
 * told what replaced it, and nothing else does. The anchoring cases mirror
 * deadNameRe's: the same names that must not match in prose must not resolve
 * here either, or the fuzzy unknown-tool path would be shadowed for them.
 */
describe("findDeadName", () => {
  it("resolves a bare retired name", () => {
    expect(findDeadName("apps_list")?.replacement).toBe('apps (action:"list")');
  });

  it("resolves through an mcp__<server>__ prefix", () => {
    expect(findDeadName("mcp__comfyui__apps_run")?.name).toBe("apps_run");
  });

  it("rejects a name embedded in a longer identifier", () => {
    expect(findDeadName("my_apps_list")).toBeUndefined();
    expect(findDeadName("retarget_image")).toBeUndefined();
  });

  it("rejects a retired name that is only a prefix of the called name", () => {
    expect(findDeadName("apps_list_v2")).toBeUndefined();
    expect(findDeadName("panel_get_graph_outline")).toBeUndefined();
  });

  it("rejects live and unknown names", () => {
    expect(findDeadName("apps")).toBeUndefined();
    expect(findDeadName("definitely_not_a_tool")).toBeUndefined();
  });
});

describe("retiredToolMessage", () => {
  it("quotes the removing version and the replacement", () => {
    expect(retiredToolMessage("apps_run")).toBe(
      `Unknown tool 'apps_run' — removed in 0.49.0. Call apps (action:"run") instead.`,
    );
  });

  it("resolves the prefixed form to the same message", () => {
    expect(retiredToolMessage("mcp__comfyui__apps_import")).toContain('Call apps (action:"import") instead.');
  });

  it("stays grammatical for a clause-shaped since (pre-baseline entries)", () => {
    const message = retiredToolMessage("panel_get_graph");
    expect(message).toContain("removed upstream before 0.48.0");
    expect(message).not.toContain("removed in removed");
  });

  it("returns undefined for a genuinely unknown name", () => {
    expect(retiredToolMessage("definitely_not_a_tool")).toBeUndefined();
  });
});
