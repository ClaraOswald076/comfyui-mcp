// panel#890 — a POPULATED ComfyUI-Manager catalogue proves nothing about its age.
//
// Measured on a network that genuinely blocks the registry: Manager raises
// InvalidChannel, logs "Cannot connect to comfyregistry", and then answers with
// HTTP 200, 1,570,773 bytes, 5583 packs — out of the extension-node-map.json
// bundled in its own package. A full list of unknown age, indistinguishable from
// a current one.
//
// #1136's two caveats both key on an OBSERVED failure (empty list, caught
// exception), so neither fires on a bundled fallback and `unresolved` went out
// bare — reading as "these packs do not exist" in the very case Manager works
// hardest to produce.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MANAGER_CATALOGUE_CURRENCY_CAVEAT,
  managerCatalogueCurrencyUnverified,
} from "../../services/manager-catalogue-currency.js";

const HERE = dirname(fileURLToPath(import.meta.url));

describe("#890 when the caveat attaches", () => {
  it("attaches when packs are unresolved and nothing stronger applies", () => {
    // The reported case: a healthy-LOOKING catalogue answered, and some class_types
    // did not resolve. Nothing observed a failure, which is exactly the problem.
    expect(managerCatalogueCurrencyUnverified({ unresolvedCount: 3 })).toBe(true);
  });

  it("does NOT attach when nothing is unresolved", () => {
    // Gated on there being something to mislead about — the same rule the
    // catalogue_unavailable gate follows, and the contract its docblock states.
    expect(managerCatalogueCurrencyUnverified({ unresolvedCount: 0 })).toBe(false);
  });

  it("yields to the STRONGER caveats rather than doubling up", () => {
    // catalogue_unavailable and mappings_unavailable report an OBSERVED failure;
    // this reports the absence of evidence either way. Emitting both buries the
    // observed fact under the generic one and reads as two separate problems.
    expect(
      managerCatalogueCurrencyUnverified({ unresolvedCount: 3, catalogueUnavailable: "empty" }),
    ).toBe(false);
    expect(
      managerCatalogueCurrencyUnverified({ unresolvedCount: 3, mappingsUnavailable: "threw" }),
    ).toBe(false);
  });
});

describe("#890 what the caveat says", () => {
  it("does NOT claim the catalogue is stale", () => {
    // The reporter named this trap explicitly: a staleness claim inferred from
    // something the panel cannot observe would repeat the fault the issue is about.
    // Manager does not report which source answered, so this may only say that the
    // age is unknown — never that it is old.
    expect(MANAGER_CATALOGUE_CURRENCY_CAVEAT).not.toMatch(/\bis (stale|out of date|old)\b/i);
    expect(MANAGER_CATALOGUE_CURRENCY_CAVEAT).not.toMatch(/months out of date/i);
    expect(MANAGER_CATALOGUE_CURRENCY_CAVEAT).toMatch(/nothing here can date it/i);
  });

  it("refuses the 'does not exist' reading outright", () => {
    expect(MANAGER_CATALOGUE_CURRENCY_CAVEAT).toMatch(/NOT proof these do not exist/);
  });

  it("names WHY a populated list is not evidence of currency", () => {
    // The mechanism is the whole point — without it this reads as generic hedging,
    // and a reader has no reason to believe a 5583-entry answer could be wrong.
    expect(MANAGER_CATALOGUE_CURRENCY_CAVEAT).toMatch(/bundled in its own package/);
    expect(MANAGER_CATALOGUE_CURRENCY_CAVEAT).toMatch(/does not report which source/);
  });

  it("names an INDEPENDENT reader that can settle it, and both outcomes", () => {
    // A caveat with no next step is just doubt. search_custom_nodes queries
    // api.comfy.org directly rather than through Manager, so it is real evidence.
    // The ACTION too: search_custom_nodes is action-parameterised and refuses without
    // one, so naming the tool alone would cost a round trip to an error.
    expect(MANAGER_CATALOGUE_CURRENCY_CAVEAT).toMatch(/search_custom_nodes action:"search"/);
    expect(MANAGER_CATALOGUE_CURRENCY_CAVEAT).toMatch(/api\.comfy\.org directly/);
    expect(MANAGER_CATALOGUE_CURRENCY_CAVEAT).toMatch(/found there means this[\s\S]*behind/i);
    expect(MANAGER_CATALOGUE_CURRENCY_CAVEAT).toMatch(/absent from both/i);
    // And what to DO about the one outcome that is actionable.
    expect(MANAGER_CATALOGUE_CURRENCY_CAVEAT).toMatch(/update ComfyUI-Manager/);
  });

  it("stays short enough to be read", () => {
    // It attaches to every miss, including the many that are ordinary. A paragraph
    // here becomes noise that gets skipped, and then it protects nobody.
    expect(MANAGER_CATALOGUE_CURRENCY_CAVEAT.length).toBeLessThan(700);
  });
});

describe("#890 WIRING: it reaches both results and both renderers", () => {
  const deps = readFileSync(join(HERE, "../../services/workflow-deps.ts"), "utf8");
  const skills = readFileSync(join(HERE, "../../tools/skills-access.ts"), "utf8");

  it("both result shapes can carry it", () => {
    // WorkflowDepsAnalysis (the mappings path) and InstallDepsResult (the getlist
    // path) are separate shapes and both render `unresolved`.
    expect((deps.match(/catalogue_currency_unverified\?: string;/g) ?? []).length).toBe(2);
  });

  it("both results actually SET it", () => {
    // A field nothing populates is the defect this repo keeps paying for: a
    // mechanism that is complete, tested, and never reached.
    expect((deps.match(/catalogue_currency_unverified: MANAGER_CATALOGUE_CURRENCY_CAVEAT/g) ?? []).length).toBe(2);
  });

  it("every site that renders the stronger caveats renders this one too", () => {
    // If one renderer forgot it, `unresolved` still reads as "does not exist"
    // wherever that path is taken — and the behavioural tests above cannot see it.
    const stronger =
      (skills.match(/result\.mappings_unavailable\)/g) ?? []).length +
      (skills.match(/result\.catalogue_unavailable\)/g) ?? []).length;
    const mine = (skills.match(/result\.catalogue_currency_unverified\)/g) ?? []).length;
    expect(stronger).toBeGreaterThan(0);
    expect(mine).toBe(stronger);
  });
});
