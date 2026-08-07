// #935 — a supplied-but-unapplied filter answered with a plausible result set.
//
// #374 fixed this for ONE parameter. `creator` used to be dropped silently: the
// tool echoed creator:null with zero results, so "filter never applied" and
// "this creator has no content" were indistinguishable. The guard added there
// warns on divergence — and covers `creator` and nothing else.
//
// So modelSort / baseModels / period could be supplied, ignored, and answered
// with a full, ordinary-looking list. A reporter saw download counts in no order
// at all (48, 53, 53, 64, 1468) for a "Most Downloaded" sort. An agent asked for
// "most-downloaded Flux LoRAs" presents that confidently; nothing in the reply
// says the sort never happened.

import { describe, expect, it } from "vitest";
import { describeUnappliedFilters } from "../../orchestrator/civitai-filter-guard.js";

const FILTERS = { modelSort: "Most Downloaded", baseModels: ["Flux.1 D"] };

describe("#935: nothing to warn about", () => {
  it("says nothing when no filters were supplied", () => {
    expect(describeUnappliedFilters(undefined, { applied_filters: {} })).toBe("");
    expect(describeUnappliedFilters({}, { applied_filters: {} })).toBe("");
  });

  // An empty array is "no constraint", not a filter that got dropped.
  it("ignores empty and null values rather than reporting them as dropped", () => {
    const r = { applied_filters: {} };
    expect(describeUnappliedFilters({ baseModels: [], period: null }, r)).toBe("");
  });

  it("says nothing when the panel applied exactly what was asked", () => {
    expect(describeUnappliedFilters(FILTERS, { applied_filters: FILTERS })).toBe("");
  });

  // A false alarm on every search trains the reader to skip the warning, which
  // is how a guard stops working. Case, whitespace and array order are not
  // divergence.
  it("does not cry wolf over formatting differences", () => {
    const echoed = { modelSort: "most downloaded ", baseModels: ["flux.1 d"] };
    expect(describeUnappliedFilters(FILTERS, { applied_filters: echoed })).toBe("");
    // A scalar echoed where a single-element array was sent is the same request.
    expect(
      describeUnappliedFilters({ baseModels: ["Flux.1 D"] }, { applied_filters: { baseModels: "Flux.1 D" } }),
    ).toBe("");
  });

  it("reads the echo from either field name the panel may use", () => {
    expect(describeUnappliedFilters(FILTERS, { filters: FILTERS })).toBe("");
  });
});

describe("#935: a real divergence is named precisely", () => {
  it("reports asked-vs-applied per filter, not a vague 'filters may not apply'", () => {
    const w = describeUnappliedFilters(FILTERS, {
      applied_filters: { modelSort: "Newest", baseModels: ["SDXL 1.0"] },
    });
    expect(w).toMatch(/2 of the 2 filter\(s\)/);
    expect(w).toContain("modelSort: asked \"Most Downloaded\", applied \"Newest\"");
    expect(w).toContain("baseModels: asked [\"Flux.1 D\"], applied [\"SDXL 1.0\"]");
  });

  it("calls a missing echo 'not applied' rather than printing undefined", () => {
    const w = describeUnappliedFilters(FILTERS, { applied_filters: { modelSort: "Most Downloaded" } });
    expect(w).toMatch(/1 of the 2 filter\(s\)/);
    expect(w).toContain("baseModels: asked [\"Flux.1 D\"], applied not applied");
    // The one that DID apply is not listed.
    expect(w).not.toMatch(/modelSort: asked/);
  });

  // The actionable half: the results are real, they are just not what was asked
  // for, and the agent must not describe them as sorted.
  it("tells the caller not to describe the results as sorted or narrowed", () => {
    const w = describeUnappliedFilters(FILTERS, { applied_filters: {} });
    expect(w).toMatch(/produced WITHOUT them/);
    expect(w).toMatch(/do not describe them as sorted or narrowed/);
    expect(w).toMatch(/silently returns nothing/);
  });
});

describe("#935: an absent echo is UNVERIFIED, not failed", () => {
  // An older panel echoes nothing. Absence is not evidence the filters were
  // dropped — and a reader told "failed" goes and fixes something that may not
  // be broken, while a reader told "unverified" re-checks.
  it("declines to claim the filters were ignored", () => {
    const w = describeUnappliedFilters(FILTERS, { results: [] });
    expect(w).toMatch(/UNVERIFIED/);
    expect(w).toMatch(/not the same as knowing they were ignored/);
    expect(w).not.toMatch(/were NOT applied/);
  });

  it("names the filters at stake and how to judge the result by eye", () => {
    const w = describeUnappliedFilters(FILTERS, { results: [] });
    expect(w).toContain("`modelSort`");
    expect(w).toContain("`baseModels`");
    expect(w).toMatch(/check that the list is actually in that order/);
  });

  // The ambiguity #374 existed to remove, restated for this parameter: the
  // panel's own client documents that a bad baseModels value returns nothing.
  it("says an empty result is not evidence the model does not exist", () => {
    expect(describeUnappliedFilters(FILTERS, { results: [] })).toMatch(
      /not evidence that no such model exists/,
    );
  });

  it("says nothing at all when the reply is not an object to inspect", () => {
    expect(describeUnappliedFilters(FILTERS, null)).toBe("");
    expect(describeUnappliedFilters(FILTERS, "oops")).toBe("");
  });
});
